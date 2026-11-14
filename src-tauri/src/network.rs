//! Local interfaces, ping, scan, ARP, and the IPv6 neighbour table.
//!
//! `ping`, `arp`, and the neighbour commands are started with an argument
//! list, never a shell.
//!
//! The range scan stays IPv4: sweeping an IPv6 subnet (2^64 addresses) is not
//! feasible. IPv6 hosts are found from the neighbour table instead
//! (`ip -6 neigh`, `ndp -an`, `netsh interface ipv6 show neighbors`).

use std::net::{Ipv4Addr, Ipv6Addr};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::hosts::{
    clamp_scan_range, is_safe_base_ip, is_safe_host, is_safe_port, normalize_host,
    ping_command as ping_argv,
};

const BATCH_SIZE: i64 = 20;

#[derive(Clone, Copy)]
pub struct Probe {
    pub online: bool,
    pub duration_ms: u64,
}

pub async fn ping_host(host: &str, timeout: Duration) -> Probe {
    let start = Instant::now();
    let Some(host) = normalize_host(host) else {
        return Probe {
            online: false,
            duration_ms: 0,
        };
    };
    let online = run_ping(&host, timeout).await;
    Probe {
        online,
        duration_ms: start.elapsed().as_millis() as u64,
    }
}

pub async fn check_port(host: &str, port: u16, timeout: Duration) -> bool {
    let Some(host) = normalize_host(host) else {
        return false;
    };
    if !is_safe_port(i64::from(port)) {
        return false;
    }
    // A (host, port) pair, not "host:port": an IPv6 literal would make that
    // string ambiguous. An IP literal is used as is; a zoned link-local
    // address or a hostname goes through the system resolver.
    let connect = tokio::net::TcpStream::connect((host.as_str(), port));
    match tokio::time::timeout(timeout, connect).await {
        Ok(Ok(stream)) => {
            drop(stream);
            true
        }
        _ => false,
    }
}

/// Non-loopback interface addresses. IPv4 entries come first and keep the
/// fields the discovery form reads (`interface`, `address`, `netmask`,
/// `mac`). IPv6 entries follow with `family: "IPv6"`, a `prefix` length, and
/// a `scope` (`link` or `global`); a link-local address carries its zone.
pub fn local_interfaces() -> Vec<Value> {
    let interfaces = if_addrs::get_if_addrs().unwrap_or_default();
    let mut v4 = Vec::new();
    let mut v6 = Vec::new();
    for interface in interfaces {
        if interface.is_loopback() {
            continue;
        }
        match &interface.addr {
            if_addrs::IfAddr::V4(address) => v4.push(json!({
                "interface": interface.name,
                "family": "IPv4",
                "address": address.ip.to_string(),
                "netmask": address.netmask.to_string(),
                "mac": mac_address(&interface.name),
            })),
            if_addrs::IfAddr::V6(address) => {
                let zone = if cfg!(windows) {
                    interface.index.map(|index| index.to_string())
                } else {
                    Some(interface.name.clone())
                };
                let Some(text) = interface_v6_address(address.ip, zone.as_deref()) else {
                    continue;
                };
                v6.push(json!({
                    "interface": interface.name,
                    "family": "IPv6",
                    "address": text,
                    "netmask": address.netmask.to_string(),
                    "prefix": address.prefixlen,
                    "scope": if is_link_local_v6(&address.ip) { "link" } else { "global" },
                    "mac": mac_address(&interface.name),
                }));
            }
        }
    }
    v4.extend(v6);
    v4
}

/// IPv6 address text for an interface: the zone is added to a link-local
/// address. Returns `None` for an address that is not a usable host.
fn interface_v6_address(ip: Ipv6Addr, zone: Option<&str>) -> Option<String> {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        return None;
    }
    let text = match zone {
        Some(zone) if is_link_local_v6(&ip) => format!("{ip}%{zone}"),
        _ => ip.to_string(),
    };
    is_safe_host(&text).then_some(text)
}

fn is_link_local_v6(ip: &Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

pub async fn ping_command(host: &str) -> Value {
    if normalize_host(host).is_none() {
        return json!({
            "success": false,
            "host": host,
            "duration": 0,
            "error": "Invalid host"
        });
    }
    let result = ping_host(host, Duration::from_millis(5000)).await;
    json!({
        "success": result.online,
        "host": host,
        "duration": result.duration_ms,
    })
}

pub async fn scan(
    app: &AppHandle,
    base_ip: &str,
    start: i64,
    end: i64,
) -> Result<Vec<Value>, String> {
    let Some((start, end)) = clamp_scan_range(start, end).filter(|_| is_safe_base_ip(base_ip))
    else {
        return Err("Invalid scan range".to_string());
    };
    let total = end - start + 1;
    let mut results = Vec::new();
    let mut cursor = start;
    while cursor <= end {
        let batch_end = (cursor + BATCH_SIZE - 1).min(end);
        let mut tasks = tokio::task::JoinSet::new();
        for octet in cursor..=batch_end {
            let ip = format!("{base_ip}.{octet}");
            tasks.spawn(async move {
                let online = ping_host(&ip, Duration::from_millis(2000)).await.online;
                (ip, online)
            });
        }
        while let Some(joined) = tasks.join_next().await {
            if let Ok((ip, true)) = joined {
                results.push(json!({ "ip": ip, "online": true }));
            }
        }
        let _ = app.emit(
            "network-scan-progress",
            json!({
                "current": batch_end - start + 1,
                "total": total,
                "found": results.len(),
            }),
        );
        cursor = batch_end + 1;
    }
    Ok(results)
}

pub async fn arp_table() -> Vec<Value> {
    match capture("arp", &["-a"]).await {
        Some(stdout) => parse_arp(&stdout, cfg!(windows)),
        None => Vec::new(),
    }
}

/// IPv6 neighbours from the system table: `{ ip, mac, interface }`. A
/// link-local address carries its zone. Empty when the command is missing.
pub async fn ipv6_neighbors() -> Vec<Value> {
    let os = std::env::consts::OS;
    let (program, args): (&str, &[&str]) = match os {
        "windows" => ("netsh", &["interface", "ipv6", "show", "neighbors"]),
        "macos" | "ios" | "freebsd" | "openbsd" | "netbsd" | "dragonfly" => ("ndp", &["-an"]),
        _ => ("ip", &["-6", "neigh", "show"]),
    };
    match capture(program, args).await {
        Some(stdout) => parse_neighbors(&stdout, os),
        None => Vec::new(),
    }
}

/// Runs a fixed program with fixed arguments (no shell) and returns stdout.
async fn capture(program: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let mut stdout = String::new();
    let read = async {
        if let Some(pipe) = child.stdout.as_mut() {
            let _ = pipe.read_to_string(&mut stdout).await;
        }
        let _ = child.wait().await;
    };
    tokio::time::timeout(Duration::from_secs(5), read)
        .await
        .ok()?;
    Some(stdout)
}

/// Parses `ip -6 neigh` (Linux and others), `ndp -an` (macOS, BSD) or
/// `netsh interface ipv6 show neighbors` (Windows). `os` is a value of
/// `std::env::consts::OS`. Incomplete, failed, multicast and unreachable
/// entries are dropped; every address passes `is_safe_host`.
pub fn parse_neighbors(stdout: &str, os: &str) -> Vec<Value> {
    let mut found: Vec<(String, String, String)> = Vec::new();
    let mut windows_index: Option<String> = None;
    for line in stdout.lines() {
        let entry = match os {
            "windows" => parse_netsh_line(line, &mut windows_index),
            "macos" | "ios" | "freebsd" | "openbsd" | "netbsd" | "dragonfly" => {
                parse_ndp_line(line)
            }
            _ => parse_ip_neigh_line(line),
        };
        if let Some(entry) = entry
            && !found.iter().any(|seen| seen.0 == entry.0)
        {
            found.push(entry);
        }
    }
    found
        .into_iter()
        .map(|(ip, mac, interface)| json!({ "ip": ip, "mac": mac, "interface": interface }))
        .collect()
}

/// `fe80::1 dev eth0 lladdr aa:bb:cc:dd:ee:ff router REACHABLE`
fn parse_ip_neigh_line(line: &str) -> Option<(String, String, String)> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let address = *tokens.first()?;
    let state = *tokens.last()?;
    if matches!(state, "FAILED" | "INCOMPLETE" | "NONE") {
        return None;
    }
    let after = |key: &str| {
        tokens
            .iter()
            .position(|token| *token == key)
            .and_then(|index| tokens.get(index + 1).copied())
    };
    let interface = after("dev").unwrap_or("");
    let mac = after("lladdr")?;
    neighbor(address, mac, interface)
}

/// `fe80::1%en0  0:11:22:33:44:55  en0 23h59m58s S R`
fn parse_ndp_line(line: &str) -> Option<(String, String, String)> {
    let mut tokens = line.split_whitespace();
    let address = tokens.next()?;
    let mac = tokens.next()?;
    let interface = tokens.next().unwrap_or("");
    neighbor(address, mac, interface)
}

/// `Interface 12: Ethernet` sets the zone index for the rows that follow;
/// `fe80::1   00-11-22-33-44-55   Reachable (Router)` is a row.
fn parse_netsh_line(line: &str, index: &mut Option<String>) -> Option<(String, String, String)> {
    let trimmed = line.trim();
    if let Some(rest) = trimmed.strip_prefix("Interface ") {
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() {
            *index = Some(digits);
        }
        return None;
    }
    let mut tokens = trimmed.split_whitespace();
    let address = tokens.next()?;
    let mac = tokens.next()?;
    let kind = tokens.next().unwrap_or("");
    if kind.eq_ignore_ascii_case("Unreachable") || kind.eq_ignore_ascii_case("Incomplete") {
        return None;
    }
    neighbor(address, mac, index.as_deref().unwrap_or(""))
}

/// Builds a checked `(ip, mac, interface)` entry. `zone` names the
/// interface; it is appended to a link-local address that has none.
fn neighbor(address: &str, mac: &str, zone: &str) -> Option<(String, String, String)> {
    let (bare, existing_zone) = match address.split_once('%') {
        Some((bare, zone)) => (bare, Some(zone)),
        None => (address, None),
    };
    let ip: Ipv6Addr = bare.parse().ok()?;
    if ip.is_multicast() || ip.is_unspecified() || ip.is_loopback() {
        return None;
    }
    let mac = normalize_neighbor_mac(mac)?;
    let interface = existing_zone.unwrap_or(zone);
    let text = if is_link_local_v6(&ip) {
        if interface.is_empty() {
            return None;
        }
        format!("{ip}%{interface}")
    } else {
        ip.to_string()
    };
    if !is_safe_host(&text) {
        return None;
    }
    Some((text, mac, interface.to_string()))
}

/// `0:11:22:33:44:55` or `00-11-22-33-44-55` → `00:11:22:33:44:55`. An
/// all-zero address (Windows' unreachable rows) is not a neighbour.
fn normalize_neighbor_mac(token: &str) -> Option<String> {
    let parts: Vec<&str> = token.split([':', '-']).collect();
    if parts.len() != 6
        || parts.iter().any(|part| {
            part.is_empty() || part.len() > 2 || !part.bytes().all(|b| b.is_ascii_hexdigit())
        })
    {
        return None;
    }
    let mac = parts
        .iter()
        .map(|part| format!("{:0>2}", part.to_ascii_lowercase()))
        .collect::<Vec<_>>()
        .join(":");
    (mac != "00:00:00:00:00:00").then_some(mac)
}

pub fn parse_arp(stdout: &str, windows: bool) -> Vec<Value> {
    stdout
        .lines()
        .filter_map(|line| parse_arp_line(line, windows))
        .map(|(ip, mac)| json!({ "ip": ip, "mac": mac }))
        .collect()
}

async fn run_ping(host: &str, timeout: Duration) -> bool {
    let (program, args) = ping_argv(host, std::env::consts::OS);
    let mut command = Command::new(program);
    command
        .args(args)
        .kill_on_drop(true)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status.success(),
        _ => {
            let _ = child.kill().await;
            false
        }
    }
}

fn mac_address(name: &str) -> String {
    if !name
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'))
    {
        return String::new();
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string(format!("/sys/class/net/{name}/address"))
            .map(|value| value.trim().to_ascii_lowercase())
            .unwrap_or_default()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = name;
        String::new()
    }
}

fn parse_arp_line(line: &str, windows: bool) -> Option<(String, String)> {
    if windows {
        let mut parts = line.split_whitespace();
        let ip = parts.next()?;
        let mac = parts.next()?;
        if !is_safe_host(ip) || !is_mac_token(mac) {
            return None;
        }
        return Some((ip.to_string(), normalize_mac(mac)));
    }
    let start = line.find('(')?;
    let end = line[start + 1..].find(')')? + start + 1;
    let ip = &line[start + 1..end];
    if !is_safe_host(ip) || ip.parse::<Ipv4Addr>().is_err() {
        return None;
    }
    let rest = line[end + 1..].trim_start();
    let rest = rest
        .strip_prefix("at")
        .or_else(|| rest.strip_prefix("AT"))?;
    let mac = rest.trim_start().split_whitespace().next()?;
    if !is_mac_token(mac) {
        return None;
    }
    Some((ip.to_string(), normalize_mac(mac)))
}

fn is_mac_token(token: &str) -> bool {
    let bytes = token.as_bytes();
    bytes.len() >= 11
        && bytes.iter().any(|byte| *byte == b':' || *byte == b'-')
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() || *byte == b':' || *byte == b'-')
}

fn normalize_mac(token: &str) -> String {
    token.replace('-', ":").to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unix_and_windows_arp_lines() {
        let unix = parse_arp(
            "? (192.168.1.1) at aa:bb:cc:dd:ee:ff [ether] on eth0\n? (192.168.1.2) at <incomplete> on eth0\n",
            false,
        );
        assert_eq!(unix.len(), 1);
        assert_eq!(unix[0]["ip"], "192.168.1.1");
        assert_eq!(unix[0]["mac"], "aa:bb:cc:dd:ee:ff");

        let windows = parse_arp("192.168.1.20     AA-BB-CC-DD-EE-FF     dynamic\n", true);
        assert_eq!(windows[0]["mac"], "aa:bb:cc:dd:ee:ff");
    }

    #[test]
    fn parses_linux_ipv6_neighbors() {
        let out = "fe80::1 dev eth0 lladdr aa:bb:cc:dd:ee:ff router STALE\n\
                   2001:db8::20 dev eth0 lladdr 11:22:33:44:55:66 REACHABLE\n\
                   fe80::5 dev eth0 FAILED\n\
                   2001:db8::30 dev eth0 INCOMPLETE\n\
                   ff02::1 dev eth0 lladdr 33:33:00:00:00:01 NOARP\n";
        let found = parse_neighbors(out, "linux");
        assert_eq!(found.len(), 2);
        assert_eq!(found[0]["ip"], "fe80::1%eth0");
        assert_eq!(found[0]["mac"], "aa:bb:cc:dd:ee:ff");
        assert_eq!(found[0]["interface"], "eth0");
        assert_eq!(found[1]["ip"], "2001:db8::20");
    }

    #[test]
    fn parses_macos_ndp() {
        let out = "Neighbor                        Linklayer Address  Netif Expire    St Flgs Prbs\n\
                   fe80::1%en0                     0:11:22:33:44:5    en0 23h59m58s S  R\n\
                   2001:db8::5                     a:b:c:d:e:f        en0 permanent R\n\
                   2001:db8::6                     (incomplete)       en0 expired   N\n";
        let found = parse_neighbors(out, "macos");
        assert_eq!(found.len(), 2);
        assert_eq!(found[0]["ip"], "fe80::1%en0");
        assert_eq!(found[0]["mac"], "00:11:22:33:44:05");
        assert_eq!(found[1]["ip"], "2001:db8::5");
        assert_eq!(found[1]["mac"], "0a:0b:0c:0d:0e:0f");
    }

    #[test]
    fn parses_windows_netsh_neighbors() {
        let out = "\r\nInterface 1: Loopback Pseudo-Interface 1\r\n\r\n\
                   Internet Address                              Physical Address   Type\r\n\
                   --------------------------------------------  -----------------  -----------\r\n\
                   ff02::c                                                          Permanent\r\n\
                   \r\nInterface 12 : Ethernet\r\n\r\n\
                   fe80::1                                       00-11-22-33-44-55  Reachable (Router)\r\n\
                   2001:db8::9                                   00-11-22-33-44-66  Stale\r\n\
                   2001:db8::a                                   00-00-00-00-00-00  Unreachable\r\n\
                   ff02::1                                       33-33-00-00-00-01  Permanent\r\n";
        let found = parse_neighbors(out, "windows");
        assert_eq!(found.len(), 2);
        assert_eq!(found[0]["ip"], "fe80::1%12");
        assert_eq!(found[0]["mac"], "00:11:22:33:44:55");
        assert_eq!(found[1]["ip"], "2001:db8::9");
    }

    #[test]
    fn neighbor_rows_cannot_inject() {
        assert!(
            parse_neighbors(
                "fe80::1 dev $(id) lladdr aa:bb:cc:dd:ee:ff REACHABLE\n",
                "linux"
            )
            .is_empty()
        );
        assert!(
            parse_neighbors(
                "2001:db8::1;id dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE\n",
                "linux"
            )
            .is_empty()
        );
        assert!(
            parse_neighbors("fe80::1 lladdr aa:bb:cc:dd:ee:ff REACHABLE\n", "linux").is_empty()
        );
    }

    #[test]
    fn interface_addresses_carry_a_zone_when_link_local() {
        let link: Ipv6Addr = "fe80::1".parse().unwrap();
        let global: Ipv6Addr = "2001:db8::1".parse().unwrap();
        assert_eq!(
            interface_v6_address(link, Some("eth0")).as_deref(),
            Some("fe80::1%eth0")
        );
        assert_eq!(
            interface_v6_address(global, Some("eth0")).as_deref(),
            Some("2001:db8::1")
        );
        assert_eq!(interface_v6_address(Ipv6Addr::LOCALHOST, None), None);
        assert_eq!(interface_v6_address(link, Some("bad name")), None);
    }
}
