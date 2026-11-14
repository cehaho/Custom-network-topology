//! Host, port, and scan checks.
//!
//! These rules are the Rust copy of `renderer/js/hosts.js` (re-exported by
//! `lib/hosts.js`). Change both together.
//! A label like `001` is rejected because some `ping` builds treat it as octal.
//!
//! A host is an IPv4 address, an IPv6 literal, or a hostname. IPv6 accepts the
//! full, compressed and IPv4-embedded forms. A zone (`fe80::1%eth0`,
//! `fe80::1%12`) is accepted only on a link-local address (fe80::/10).
//! Brackets (`[::1]`) are accepted by `normalize_host`, which strips them.

use std::net::Ipv6Addr;

const MAX_HOST_LENGTH: usize = 253;
const MAX_ZONE_LENGTH: usize = 32;

pub fn is_safe_host(host: &str) -> bool {
    if host.is_empty() || host.len() > MAX_HOST_LENGTH {
        return false;
    }
    if host.contains(':') {
        return is_ipv6(host);
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.iter().any(|label| label.is_empty()) {
        return false;
    }
    let ipv4 = labels.len() == 4 && labels.iter().copied().all(is_octet_label);
    let hostname = labels.iter().copied().all(is_hostname_label);
    if !ipv4 && !hostname {
        return false;
    }
    !labels.iter().copied().any(is_leading_zero_numeric)
}

/// An IPv6 literal, with an optional zone on a link-local address.
pub fn is_ipv6(host: &str) -> bool {
    if host.is_empty() || host.len() > MAX_HOST_LENGTH {
        return false;
    }
    let (address, zone) = split_zone(host);
    let Ok(parsed) = address.parse::<Ipv6Addr>() else {
        return false;
    };
    match zone {
        None => true,
        Some(zone) => is_zone(zone) && (parsed.segments()[0] & 0xffc0) == 0xfe80,
    }
}

/// Trims, strips one pair of brackets around an IPv6 literal, and checks.
/// Returns the bare host.
pub fn normalize_host(host: &str) -> Option<String> {
    let value = host.trim();
    if let Some(inner) = value
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    {
        return is_ipv6(inner).then(|| inner.to_string());
    }
    is_safe_host(value).then(|| value.to_string())
}

/// `host:port`, with brackets around an IPv6 literal: `[::1]:22`.
pub fn format_host_port(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// Canonical text of a host: an IPv6 literal in RFC 5952 form (zone kept),
/// so `2001:DB8:0::1` and `2001:db8::1` name the same host; anything else
/// lower-cased.
pub fn canonical_host(host: &str) -> String {
    let host = host.trim();
    let (address, zone) = split_zone(host);
    if let Ok(parsed) = address.parse::<Ipv6Addr>() {
        return match zone {
            Some(zone) => format!("{parsed}%{zone}"),
            None => parsed.to_string(),
        };
    }
    host.to_ascii_lowercase()
}

pub fn is_safe_base_ip(base_ip: &str) -> bool {
    let labels: Vec<&str> = base_ip.split('.').collect();
    labels.len() == 3 && labels.iter().copied().all(is_octet_label)
}

pub fn is_safe_port(port: i64) -> bool {
    (1..=65535).contains(&port)
}

pub fn clamp_scan_range(start: i64, end: i64) -> Option<(i64, i64)> {
    if !(1..=254).contains(&start) || !(1..=254).contains(&end) || start > end {
        return None;
    }
    Some((start, end))
}

/// Program and argv for one ping. Never a shell. `os` is a value of
/// `std::env::consts::OS`. An IPv6 literal uses `ping -6` (Linux, Windows)
/// or `ping6` (macOS and the BSDs, whose `ping` is IPv4 only).
pub fn ping_command(host: &str, os: &str) -> (&'static str, Vec<String>) {
    let v6 = host.contains(':');
    let mut args: Vec<String> = Vec::new();
    if os == "windows" {
        if v6 {
            args.push("-6".to_string());
        }
        args.extend(["-n", "1", "-w", "1000", host].map(str::to_string));
        return ("ping", args);
    }
    if v6
        && matches!(
            os,
            "macos" | "ios" | "freebsd" | "openbsd" | "netbsd" | "dragonfly"
        )
    {
        args.extend(["-c", "1", host].map(str::to_string));
        return ("ping6", args);
    }
    if v6 {
        args.push("-6".to_string());
    }
    args.extend(["-c", "1", "-W", "1", host].map(str::to_string));
    ("ping", args)
}

pub fn monitoring_interval(requested: Option<f64>) -> u64 {
    match requested {
        Some(value) if value.is_finite() && (1000.0..=60_000.0).contains(&value) => value as u64,
        _ => 5000,
    }
}

pub fn confirmation_count(requested: Option<f64>) -> u64 {
    match requested {
        Some(value)
            if value.is_finite() && value.fract() == 0.0 && (2.0..=10.0).contains(&value) =>
        {
            value as u64
        }
        _ => 2,
    }
}

pub fn is_reasonable_username(username: &str) -> bool {
    !username.is_empty()
        && username.len() <= 128
        && !username
            .bytes()
            .any(|byte| byte == b'\0' || byte == b'\r' || byte == b'\n')
}

fn split_zone(host: &str) -> (&str, Option<&str>) {
    match host.split_once('%') {
        Some((address, zone)) => (address, Some(zone)),
        None => (host, None),
    }
}

fn is_zone(zone: &str) -> bool {
    let bytes = zone.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_ZONE_LENGTH
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn is_octet_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    match bytes.len() {
        1 => bytes[0].is_ascii_digit(),
        2 => bytes[0].is_ascii_digit() && bytes[1].is_ascii_digit() && bytes[0] != b'0',
        3 => {
            bytes.iter().all(|byte| byte.is_ascii_digit()) && {
                let value = label.parse::<u16>().unwrap_or(256);
                (100..=255).contains(&value)
            }
        }
        _ => false,
    }
}

fn is_hostname_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    if bytes.is_empty() || bytes.len() > 63 || !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    if bytes.len() == 1 {
        return true;
    }
    bytes[bytes.len() - 1].is_ascii_alphanumeric()
        && bytes[1..bytes.len() - 1]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
}

fn is_leading_zero_numeric(label: &str) -> bool {
    let bytes = label.as_bytes();
    bytes.len() >= 2 && bytes[0] == b'0' && bytes.iter().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ipv4_and_hostnames() {
        assert!(is_safe_host("192.168.1.1"));
        assert!(is_safe_host("8.8.8.8"));
        assert!(is_safe_host("gateway.local"));
        assert!(is_safe_host("a"));
        assert!(is_safe_host("0.0.0.0"));
    }

    #[test]
    fn rejects_shell_metacharacters_and_octal_looking_labels() {
        assert!(!is_safe_host("192.168.1.1;id"));
        assert!(!is_safe_host("8.8.8.8 && whoami"));
        assert!(!is_safe_host("$(reboot)"));
        assert!(!is_safe_host("host`id`"));
        assert!(!is_safe_host(""));
        assert!(!is_safe_host("192.168.001.1"));
        assert!(!is_safe_host("192.168.00.1"));
    }

    #[test]
    fn accepts_a_three_octet_base_only() {
        assert!(is_safe_base_ip("192.168.1"));
        assert!(is_safe_base_ip("10.0.0"));
        assert!(!is_safe_base_ip("192.168.1.1"));
        assert!(!is_safe_base_ip("192.168.001"));
        assert!(!is_safe_base_ip("192.168.1;id"));
        assert!(!is_safe_base_ip("192.168"));
    }

    #[test]
    fn validates_ports_and_scan_bounds() {
        assert!(is_safe_port(22));
        assert!(is_safe_port(65535));
        assert!(!is_safe_port(0));
        assert!(!is_safe_port(65536));
        assert_eq!(clamp_scan_range(1, 254), Some((1, 254)));
        assert_eq!(clamp_scan_range(10, 2), None);
        assert_eq!(clamp_scan_range(0, 10), None);
        assert_eq!(clamp_scan_range(1, 255), None);
    }

    #[test]
    fn builds_ping_arguments_without_a_shell() {
        assert_eq!(
            ping_command("192.168.1.1", "linux"),
            ("ping", strings(&["-c", "1", "-W", "1", "192.168.1.1"]))
        );
        assert_eq!(
            ping_command("10.0.0.1", "windows"),
            ("ping", strings(&["-n", "1", "-w", "1000", "10.0.0.1"]))
        );
        assert_eq!(
            ping_command("::1", "linux"),
            ("ping", strings(&["-6", "-c", "1", "-W", "1", "::1"]))
        );
        assert_eq!(
            ping_command("fe80::1%12", "windows"),
            (
                "ping",
                strings(&["-6", "-n", "1", "-w", "1000", "fe80::1%12"])
            )
        );
        assert_eq!(
            ping_command("2001:db8::1", "macos"),
            ("ping6", strings(&["-c", "1", "2001:db8::1"]))
        );
        assert_eq!(
            ping_command("192.168.1.1", "macos"),
            ("ping", strings(&["-c", "1", "-W", "1", "192.168.1.1"]))
        );
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn accepts_ipv6_literals() {
        for host in [
            "::1",
            "::",
            "2001:db8::1",
            "2001:DB8:0:0:0:0:0:1",
            "fe80::1",
            "fe80::1%eth0",
            "fe80::aede:48ff:fe00:1122%en0",
            "fe80::1%12",
            "::ffff:192.168.1.1",
            "64:ff9b::192.0.2.33",
            "1:2:3:4:5:6:7:8",
            "1:2:3:4:5:6:7::",
            "::2:3:4:5:6:7:8",
        ] {
            assert!(is_safe_host(host), "{host}");
        }
    }

    #[test]
    fn rejects_malformed_or_unsafe_ipv6() {
        for host in [
            ":::",
            "1:::2",
            "1::2::3",
            "1:2:3:4:5:6:7:8:9",
            "1:2:3:4:5:6:7",
            "12345::1",
            "g::1",
            ":1",
            "1:",
            "[::1]",
            "::1 ",
            "::1;id",
            "::1%eth0",
            "2001:db8::1%eth0",
            "fe80::1%",
            "fe80::1%eth0;id",
            "fe80::1%eth 0",
            "fe80::1%-eth0",
            "fe80::1%$(reboot)",
            "::ffff:192.168.001.1",
            "::ffff:256.1.1.1",
            "::1/64",
        ] {
            assert!(!is_safe_host(host), "{host}");
        }
    }

    #[test]
    fn normalizes_brackets_and_formats_host_ports() {
        assert_eq!(normalize_host("[::1]").as_deref(), Some("::1"));
        assert_eq!(
            normalize_host(" [fe80::1%eth0] ").as_deref(),
            Some("fe80::1%eth0")
        );
        assert_eq!(
            normalize_host("192.168.1.1").as_deref(),
            Some("192.168.1.1")
        );
        assert_eq!(normalize_host("[192.168.1.1]"), None);
        assert_eq!(normalize_host("[gateway]"), None);
        assert_eq!(normalize_host("[::1"), None);
        assert_eq!(normalize_host("[[::1]]"), None);
        assert_eq!(normalize_host("::1;id"), None);
        assert_eq!(format_host_port("::1", 22), "[::1]:22");
        assert_eq!(format_host_port("10.0.0.1", 22), "10.0.0.1:22");
        assert_eq!(format_host_port("router.lan", 2222), "router.lan:2222");
        assert_eq!(canonical_host("2001:DB8:0:0::1"), "2001:db8::1");
        assert_eq!(canonical_host("FE80::1%eth0"), "fe80::1%eth0");
        assert_eq!(canonical_host("Router.LAN"), "router.lan");
    }

    #[test]
    fn clamps_the_monitoring_interval() {
        assert_eq!(monitoring_interval(Some(2000.0)), 2000);
        assert_eq!(monitoring_interval(Some(50.0)), 5000);
        assert_eq!(monitoring_interval(None), 5000);
        assert_eq!(monitoring_interval(Some(60_000.0)), 60_000);
        assert_eq!(monitoring_interval(Some(f64::NAN)), 5000);
        assert_eq!(confirmation_count(None), 2);
        assert_eq!(confirmation_count(Some(1.0)), 2);
        assert_eq!(confirmation_count(Some(4.0)), 4);
        assert_eq!(confirmation_count(Some(2.5)), 2);
    }
}
