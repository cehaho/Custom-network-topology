//! Discovery enrichment: reverse DNS (PTR) names and MAC vendors (OUI).
//!
//! `network_enrich` runs after the scan, so the sweep itself is not slowed.
//! Reverse lookups go through the system resolver (`getnameinfo`), at most
//! `MAX_CONCURRENT` at a time, each bounded by `LOOKUP_TIMEOUT`. Every input
//! address passes `hosts::normalize_host` and must be an IP literal.
//!
//! The vendor table (`data/oui.txt`, IEEE MA-L assignments) is built into
//! the binary and parsed on first use. A locally administered MAC (bit 0x02
//! of the first octet, as set by randomised Wi-Fi addresses) has no vendor:
//! it is reported as `Private/random`.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, SocketAddrV6};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::{Map, Value, json};
use tauri::{AppHandle, Emitter};
use tokio::sync::Semaphore;

use crate::hosts::{is_safe_host, normalize_host};

const MAX_CONCURRENT: usize = 16;
const LOOKUP_TIMEOUT: Duration = Duration::from_millis(1500);
const MAX_HOSTS: usize = 1024;
pub const PRIVATE_VENDOR: &str = "Private/random";

const OUI_DATA: &str = include_str!("../data/oui.txt");

struct OuiTable {
    names: Vec<&'static str>,
    prefixes: HashMap<u32, u32>,
}

fn oui_table() -> &'static OuiTable {
    static TABLE: OnceLock<OuiTable> = OnceLock::new();
    TABLE.get_or_init(|| parse_oui(OUI_DATA))
}

/// `Name<TAB>AABBCC,DDEEFF,...` per line.
fn parse_oui(data: &'static str) -> OuiTable {
    let mut names = Vec::new();
    let mut prefixes = HashMap::new();
    for line in data.lines() {
        let Some((name, list)) = line.split_once('\t') else {
            continue;
        };
        let index = names.len() as u32;
        names.push(name);
        for prefix in list.split(',') {
            if let Ok(value) = u32::from_str_radix(prefix, 16)
                && prefix.len() == 6
            {
                prefixes.insert(value, index);
            }
        }
    }
    OuiTable { names, prefixes }
}

/// A MAC in any common spelling (`aa:bb:cc:dd:ee:ff`, `AA-BB-…`,
/// `0:1:2:3:4:5`, `aabb.ccdd.eeff`, `aabbccddeeff`) as lower-case
/// `aa:bb:cc:dd:ee:ff`. `None` for anything else and for the all-zero
/// address.
pub fn normalize_mac(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() || text.len() > 17 {
        return None;
    }
    let mut octets = Vec::with_capacity(6);
    if text.contains([':', '-']) {
        let parts: Vec<&str> = text.split([':', '-']).collect();
        if parts.len() != 6 {
            return None;
        }
        for part in parts {
            if part.is_empty() || part.len() > 2 {
                return None;
            }
            octets.push(u8::from_str_radix(part, 16).ok()?);
        }
    } else {
        let digits: String = if text.contains('.') {
            let groups: Vec<&str> = text.split('.').collect();
            if groups.len() != 3 || groups.iter().any(|group| group.len() != 4) {
                return None;
            }
            groups.concat()
        } else {
            text.to_string()
        };
        if digits.len() != 12 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        for index in 0..6 {
            octets.push(u8::from_str_radix(&digits[index * 2..index * 2 + 2], 16).ok()?);
        }
    }
    if octets.iter().all(|octet| *octet == 0) {
        return None;
    }
    Some(
        octets
            .iter()
            .map(|octet| format!("{octet:02x}"))
            .collect::<Vec<_>>()
            .join(":"),
    )
}

/// Vendor short name for a MAC. `Private/random` for a locally administered
/// address; `None` for a multicast address, an unknown prefix, or bad input.
pub fn mac_vendor(mac: &str) -> Option<String> {
    let mac = normalize_mac(mac)?;
    let first = u8::from_str_radix(&mac[0..2], 16).ok()?;
    if first & 0x01 != 0 {
        return None;
    }
    if first & 0x02 != 0 {
        return Some(PRIVATE_VENDOR.to_string());
    }
    let prefix = u32::from_str_radix(&mac[0..8].replace(':', ""), 16).ok()?;
    let table = oui_table();
    table
        .prefixes
        .get(&prefix)
        .and_then(|index| table.names.get(*index as usize))
        .map(|name| (*name).to_string())
}

/// The address to look up: an IP literal, with the scope of a zoned
/// link-local IPv6 address. `None` for a hostname or an invalid host.
fn lookup_target(host: &str) -> Option<(String, SocketAddr)> {
    let host = normalize_host(host)?;
    let (bare, zone) = match host.split_once('%') {
        Some((bare, zone)) => (bare, Some(zone)),
        None => (host.as_str(), None),
    };
    let ip: IpAddr = bare.parse().ok()?;
    let socket = match (ip, zone) {
        (IpAddr::V6(v6), Some(zone)) => {
            SocketAddr::V6(SocketAddrV6::new(v6, 0, 0, scope_id(zone)?))
        }
        (_, Some(_)) => return None,
        (ip, None) => SocketAddr::new(ip, 0),
    };
    Some((host, socket))
}

/// A zone is an interface index (Windows) or an interface name.
fn scope_id(zone: &str) -> Option<u32> {
    if let Ok(index) = zone.parse::<u32>() {
        return Some(index);
    }
    if_addrs::get_if_addrs()
        .ok()?
        .into_iter()
        .find(|interface| interface.name == zone)
        .and_then(|interface| interface.index)
}

/// A resolver answer as a node-safe host name: trailing dot dropped,
/// lower-cased, and rejected when it is an address or fails `is_safe_host`.
pub fn clean_ptr_name(name: &str) -> Option<String> {
    let name = name.trim().trim_end_matches('.').to_ascii_lowercase();
    if name.is_empty() || name.parse::<IpAddr>().is_ok() {
        return None;
    }
    // getnameinfo may echo a numeric address with a zone.
    if name.contains(':') || name.contains('%') {
        return None;
    }
    is_safe_host(&name).then_some(name)
}

async fn reverse_lookup(socket: SocketAddr) -> Option<String> {
    let lookup = tokio::task::spawn_blocking(move || {
        // Flags 0: the numeric fallback is filtered by `clean_ptr_name`.
        dns_lookup::getnameinfo(&socket, 0)
            .ok()
            .map(|(name, _)| name)
    });
    match tokio::time::timeout(LOOKUP_TIMEOUT, lookup).await {
        Ok(Ok(Some(name))) => clean_ptr_name(&name),
        _ => None,
    }
}

/// Request entries: `"192.168.1.10"` or `{ "ip": "...", "mac": "..." }`.
/// Returns `(ip, socket, mac)` entries, validated, deduplicated and capped.
pub fn parse_requests(hosts: &[Value]) -> Vec<(String, SocketAddr, Option<String>)> {
    let mut out: Vec<(String, SocketAddr, Option<String>)> = Vec::new();
    for entry in hosts.iter().take(MAX_HOSTS) {
        let (ip, mac) = match entry {
            Value::String(ip) => (ip.as_str(), None),
            Value::Object(object) => (
                object.get("ip").and_then(Value::as_str).unwrap_or(""),
                object.get("mac").and_then(Value::as_str),
            ),
            _ => continue,
        };
        let Some((ip, socket)) = lookup_target(ip) else {
            continue;
        };
        if out.iter().any(|seen| seen.0 == ip) {
            continue;
        }
        out.push((ip, socket, mac.and_then(normalize_mac)));
    }
    out
}

/// `{ "<ip>": { "hostname": "nas.lan" | null, "vendor": "Synology" | null } }`.
/// Each result is also emitted as `network-enrich-result` (`{ ip, hostname,
/// vendor }`) as soon as it is known.
pub async fn enrich(app: &AppHandle, hosts: &[Value]) -> Value {
    let requests = parse_requests(hosts);
    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT));
    let mut tasks = tokio::task::JoinSet::new();
    for (ip, socket, mac) in requests {
        let semaphore = Arc::clone(&semaphore);
        tasks.spawn(async move {
            let vendor = mac.as_deref().and_then(mac_vendor);
            let hostname = match semaphore.acquire_owned().await {
                Ok(_permit) => reverse_lookup(socket).await,
                Err(_) => None,
            };
            (ip, hostname, vendor)
        });
    }
    let mut results = Map::new();
    while let Some(joined) = tasks.join_next().await {
        let Ok((ip, hostname, vendor)) = joined else {
            continue;
        };
        let _ = app.emit(
            "network-enrich-result",
            json!({ "ip": ip, "hostname": hostname, "vendor": vendor }),
        );
        results.insert(ip, json!({ "hostname": hostname, "vendor": vendor }));
    }
    Value::Object(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_common_mac_spellings() {
        assert_eq!(
            normalize_mac("AA-BB-CC-DD-EE-FF").as_deref(),
            Some("aa:bb:cc:dd:ee:ff")
        );
        assert_eq!(
            normalize_mac("0:1:2:a:b:c").as_deref(),
            Some("00:01:02:0a:0b:0c")
        );
        assert_eq!(
            normalize_mac("aabb.ccdd.eeff").as_deref(),
            Some("aa:bb:cc:dd:ee:ff")
        );
        assert_eq!(
            normalize_mac(" AABBCCDDEEFF ").as_deref(),
            Some("aa:bb:cc:dd:ee:ff")
        );
        assert_eq!(normalize_mac("00:00:00:00:00:00"), None);
        assert_eq!(normalize_mac("aa:bb:cc:dd:ee"), None);
        assert_eq!(normalize_mac("aa:bb:cc:dd:ee:fg"), None);
        assert_eq!(normalize_mac("aabb.ccdd.eef"), None);
        assert_eq!(normalize_mac("aa:bb:cc:dd:ee:ff;id"), None);
        assert_eq!(normalize_mac("<incomplete>"), None);
    }

    #[test]
    fn looks_up_vendors_and_flags_random_macs() {
        assert_eq!(
            mac_vendor("B8:27:EB:12:34:56").as_deref(),
            Some("Raspberry Pi Foundation")
        );
        assert_eq!(mac_vendor("00-0c-29-aa-bb-cc").as_deref(), Some("VMware"));
        // 0x02 bit: locally administered (randomised Wi-Fi address).
        assert_eq!(
            mac_vendor("da:a1:19:00:00:01").as_deref(),
            Some(PRIVATE_VENDOR)
        );
        assert_eq!(
            mac_vendor("02:00:00:00:00:01").as_deref(),
            Some(PRIVATE_VENDOR)
        );
        // Multicast, malformed.
        assert_eq!(mac_vendor("01:00:5e:00:00:01"), None);
        assert_eq!(mac_vendor("nope"), None);
    }

    #[test]
    fn oui_table_parses_every_line() {
        let table = oui_table();
        assert!(table.names.len() > 10_000);
        assert!(table.prefixes.len() > 30_000);
        assert!(
            table
                .names
                .iter()
                .all(|name| !name.is_empty() && !name.contains('\t'))
        );
    }

    #[test]
    fn requests_are_validated_and_deduplicated() {
        let hosts = vec![
            json!("192.168.1.10"),
            json!({ "ip": "192.168.1.10", "mac": "aa:bb:cc:dd:ee:ff" }),
            json!({ "ip": "2001:db8::1", "mac": "AA-BB-CC-DD-EE-FF" }),
            json!({ "ip": "[2001:db8::2]" }),
            json!("nas.local"),
            json!("192.168.1.1;id"),
            json!("$(reboot)"),
            json!({ "ip": 5 }),
            json!(42),
        ];
        let parsed = parse_requests(&hosts);
        let ips: Vec<&str> = parsed.iter().map(|entry| entry.0.as_str()).collect();
        assert_eq!(ips, vec!["192.168.1.10", "2001:db8::1", "2001:db8::2"]);
        assert_eq!(parsed[0].2, None);
        assert_eq!(parsed[1].2.as_deref(), Some("aa:bb:cc:dd:ee:ff"));
    }

    #[test]
    fn zoned_link_local_keeps_a_numeric_scope() {
        let (ip, socket) = lookup_target("fe80::1%12").unwrap();
        assert_eq!(ip, "fe80::1%12");
        match socket {
            SocketAddr::V6(v6) => assert_eq!(v6.scope_id(), 12),
            SocketAddr::V4(_) => panic!("expected IPv6"),
        }
        assert!(lookup_target("2001:db8::1%eth0").is_none());
    }

    #[test]
    fn ptr_names_are_cleaned() {
        assert_eq!(clean_ptr_name("NAS.lan.").as_deref(), Some("nas.lan"));
        assert_eq!(clean_ptr_name("192.168.1.10"), None);
        assert_eq!(clean_ptr_name("fe80::1%eth0"), None);
        assert_eq!(clean_ptr_name("2001:db8::1"), None);
        assert_eq!(clean_ptr_name("bad name"), None);
        assert_eq!(clean_ptr_name(""), None);
    }
}
