//! Quick actions of the node context menu: open the web UI, traceroute, and
//! Wake-on-LAN.
//!
//! Keep the node fields and URL rules aligned with `renderer/js/actions.js`.
//! Optional node fields: `mac` (`aa:bb:cc:dd:ee:ff`), `wolBroadcast` (an IPv4
//! address), `webUrlScheme` (`http` or `https`) and `webPort` (1-65535). An
//! invalid value is dropped when the document is read, so older files load
//! unchanged.
//!
//! `traceroute`, `traceroute6` and `tracert` are started with an argument
//! list, never a shell, after the host passed `normalize_host`.

use std::net::{IpAddr, Ipv4Addr};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::hosts::{is_safe_port, normalize_host};

pub const MAX_HOPS: u8 = 30;
pub const TRACEROUTE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_OUTPUT_LINES: usize = 200;
const MAX_LINE_LENGTH: usize = 512;
const WOL_PORT: u16 = 9;

// ---------------------------------------------------------------------------
// Node fields
// ---------------------------------------------------------------------------

/// Drops invalid quick-action fields and stores the valid ones in canonical
/// form. Absent fields stay absent.
pub fn normalize_action_fields(node: &mut Map<String, Value>) {
    match node.get("mac").map(mac_field) {
        Some(Some(mac)) => {
            node.insert("mac".to_string(), Value::String(mac));
        }
        Some(None) => {
            node.remove("mac");
        }
        None => {}
    }
    match node.get("wolBroadcast").map(broadcast_field) {
        Some(Some(address)) => {
            node.insert("wolBroadcast".to_string(), Value::String(address));
        }
        Some(None) => {
            node.remove("wolBroadcast");
        }
        None => {}
    }
    match node.get("webUrlScheme").map(scheme_field) {
        Some(Some(scheme)) => {
            node.insert(
                "webUrlScheme".to_string(),
                Value::String(scheme.to_string()),
            );
        }
        Some(None) => {
            node.remove("webUrlScheme");
        }
        None => {}
    }
    match node.get("webPort").map(port_field) {
        Some(Some(port)) => {
            node.insert("webPort".to_string(), json!(port));
        }
        Some(None) => {
            node.remove("webPort");
        }
        None => {}
    }
}

fn mac_field(value: &Value) -> Option<String> {
    value
        .as_str()
        .and_then(parse_mac)
        .map(|mac| format_mac(&mac))
}

fn broadcast_field(value: &Value) -> Option<String> {
    value
        .as_str()
        .and_then(parse_broadcast)
        .map(|address| address.to_string())
}

fn scheme_field(value: &Value) -> Option<&'static str> {
    match value.as_str()?.trim().to_ascii_lowercase().as_str() {
        "http" => Some("http"),
        "https" => Some("https"),
        _ => None,
    }
}

fn port_field(value: &Value) -> Option<u16> {
    let port = match value {
        Value::Number(number) => number.as_i64()?,
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() || text.len() > 5 || !text.bytes().all(|byte| byte.is_ascii_digit())
            {
                return None;
            }
            text.parse::<i64>().ok()?
        }
        _ => return None,
    };
    is_safe_port(port).then_some(port as u16)
}

// ---------------------------------------------------------------------------
// Web UI
// ---------------------------------------------------------------------------

/// `http(s)://host[:port]/` from a validated node address. An IPv6 literal is
/// bracketed and its zone written as `%25zone` (RFC 6874). Without a scheme,
/// port 443 and 8443 mean https and anything else http.
pub fn build_web_url(address: &str, scheme: Option<&str>, port: Option<u16>) -> Option<String> {
    let host = normalize_host(address)?;
    let scheme = match scheme.map(str::trim).filter(|scheme| !scheme.is_empty()) {
        Some(scheme) => scheme_field(&Value::String(scheme.to_string()))?,
        None if matches!(port, Some(443 | 8443)) => "https",
        None => "http",
    };
    if let Some(port) = port {
        if !is_safe_port(i64::from(port)) {
            return None;
        }
    }
    let host = if host.contains(':') {
        format!("[{}]", host.replacen('%', "%25", 1))
    } else {
        host.to_ascii_lowercase()
    };
    let default_port = if scheme == "https" { 443 } else { 80 };
    Some(match port {
        Some(port) if port != default_port => format!("{scheme}://{host}:{port}/"),
        _ => format!("{scheme}://{host}/"),
    })
}

// ---------------------------------------------------------------------------
// Traceroute
// ---------------------------------------------------------------------------

/// Program and argv for one traceroute. Never a shell. `os` is a value of
/// `std::env::consts::OS`. Numeric output, at most 30 hops, 2 s per probe.
pub fn traceroute_command(host: &str, os: &str) -> (&'static str, Vec<String>) {
    let v6 = host.contains(':');
    let hops = MAX_HOPS.to_string();
    let mut args: Vec<String> = Vec::new();
    if os == "windows" {
        if v6 {
            args.push("-6".to_string());
        }
        args.extend(["-d", "-h", hops.as_str(), "-w", "2000", host].map(str::to_string));
        return ("tracert", args);
    }
    if v6
        && matches!(
            os,
            "macos" | "ios" | "freebsd" | "openbsd" | "netbsd" | "dragonfly"
        )
    {
        args.extend(["-n", "-m", hops.as_str(), "-w", "2", "-q", "3", host].map(str::to_string));
        return ("traceroute6", args);
    }
    if v6 {
        args.push("-6".to_string());
    }
    args.extend(["-n", "-m", hops.as_str(), "-w", "2", "-q", "3", host].map(str::to_string));
    ("traceroute", args)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Hop {
    pub hop: u8,
    pub address: Option<String>,
    /// One entry per probe: the round trip in ms, or `None` for `*`.
    /// Windows `<1 ms` is read as 1.
    pub rtts: Vec<Option<f64>>,
}

impl Hop {
    pub fn to_json(&self) -> Value {
        json!({ "hop": self.hop, "address": self.address, "rtts": self.rtts })
    }
}

/// Parses traceroute (Linux, macOS, BSD) and tracert (Windows, any language)
/// output. Lines that do not start with a hop number are skipped. A hop that
/// lists several routers keeps the first address.
pub fn parse_traceroute(output: &str) -> Vec<Hop> {
    output.lines().filter_map(parse_hop_line).collect()
}

fn parse_hop_line(line: &str) -> Option<Hop> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    let hop: u8 = tokens.first()?.parse().ok()?;
    if hop == 0 {
        return None;
    }
    let mut address: Option<String> = None;
    let mut bracketed = false;
    let mut rtts = Vec::new();
    let mut index = 1;
    while index < tokens.len() {
        let token = tokens[index];
        let next = tokens.get(index + 1).copied();
        if token == "*" {
            rtts.push(None);
        } else if let Some(value) = rtt_value(token, next) {
            rtts.push(Some(value));
            if !token.ends_with("ms") {
                index += 1;
            }
        } else if let Some(ip) = address_token(token) {
            // `name (ip)` or `name [ip]`: the first bracketed IP wins,
            // otherwise the first bare IP.
            let in_brackets = token.starts_with('(') || token.starts_with('[');
            if address.is_none() || (in_brackets && !bracketed) {
                address = Some(ip);
                bracketed = in_brackets;
            }
        }
        index += 1;
    }
    Some(Hop { hop, address, rtts })
}

fn rtt_value(token: &str, next: Option<&str>) -> Option<f64> {
    let (number, has_unit) = match token.strip_suffix("ms") {
        Some(number) if !number.is_empty() => (number, true),
        _ => (token, false),
    };
    if !has_unit && next != Some("ms") {
        return None;
    }
    let number = number.strip_prefix('<').unwrap_or(number).replace(',', ".");
    let value: f64 = number.parse().ok()?;
    (value.is_finite() && value >= 0.0).then_some(value)
}

fn address_token(token: &str) -> Option<String> {
    let trimmed = token.trim_matches(|c| matches!(c, '(' | ')' | '[' | ']'));
    for candidate in [trimmed, trimmed.trim_end_matches([':', ',', '.'])] {
        let (bare, zone) = match candidate.split_once('%') {
            Some((bare, zone)) => (bare, Some(zone)),
            None => (candidate, None),
        };
        if let Ok(ip) = bare.parse::<IpAddr>() {
            let canonical = ip.to_string();
            let full = match zone {
                Some(zone) => format!("{canonical}%{zone}"),
                None => canonical,
            };
            if crate::hosts::is_safe_host(&full) {
                return Some(full);
            }
        }
    }
    None
}

/// Fallbacks tried in order when the previous program is missing or refuses
/// an option: GNU inetutils `traceroute` (common on Debian/WSL) has no `-n`
/// (it is numeric by default) and no `-6`, so IPv6 falls back to
/// `traceroute6`. Windows and macOS have a single variant.
pub fn traceroute_commands(host: &str, os: &str) -> Vec<(&'static str, Vec<String>)> {
    let primary = traceroute_command(host, os);
    if os == "windows" || primary.0 == "traceroute6" {
        return vec![primary];
    }
    let without = |args: &[String], drop: &[&str]| -> Vec<String> {
        args.iter()
            .filter(|arg| !drop.contains(&arg.as_str()))
            .cloned()
            .collect()
    };
    let mut commands = vec![primary.clone(), (primary.0, without(&primary.1, &["-n"]))];
    if host.contains(':') {
        commands.push(("traceroute6", without(&primary.1, &["-6"])));
        commands.push(("traceroute6", without(&primary.1, &["-6", "-n"])));
    }
    commands
}

struct Attempt {
    program: &'static str,
    lines: Vec<String>,
    errors: Vec<String>,
    exited_ok: bool,
    timed_out: bool,
    started: bool,
}

async fn run_attempt(
    program: &'static str,
    args: &[String],
    deadline: tokio::time::Instant,
) -> Attempt {
    let mut attempt = Attempt {
        program,
        lines: Vec::new(),
        errors: Vec::new(),
        exited_ok: false,
        timed_out: false,
        started: false,
    };
    let mut command = Command::new(program);
    command
        .args(args)
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            attempt
                .errors
                .push(format!("Could not start {program}: {error}"));
            return attempt;
        }
    };
    attempt.started = true;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let lines = &mut attempt.lines;
    let errors = &mut attempt.errors;
    let read = async {
        let out = async {
            if let Some(stdout) = stdout {
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    push_line(lines, &line);
                }
            }
        };
        let err = async {
            if let Some(stderr) = stderr {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    push_line(errors, &line);
                }
            }
        };
        tokio::join!(out, err);
        child.wait().await.ok()
    };
    // Dropping `read` on timeout drops the child, which kills it.
    match tokio::time::timeout_at(deadline, read).await {
        Ok(status) => attempt.exited_ok = status.is_some_and(|status| status.success()),
        Err(_) => attempt.timed_out = true,
    }
    attempt
}

/// Runs traceroute for a validated host and returns its lines and hops.
/// Stops after `TRACEROUTE_TIMEOUT` (all attempts together) and returns what
/// was read so far.
pub async fn traceroute(host: &str) -> Value {
    let Some(host) = normalize_host(host) else {
        return json!({ "success": false, "host": host, "error": "Invalid host" });
    };
    let deadline = tokio::time::Instant::now() + TRACEROUTE_TIMEOUT;
    let mut last: Option<Attempt> = None;
    for (program, args) in traceroute_commands(&host, std::env::consts::OS) {
        let attempt = run_attempt(program, &args, deadline).await;
        // Output, success or a timeout ends the search; a missing program or
        // a refused option (exit without output) tries the next variant.
        let done = attempt.exited_ok || attempt.timed_out || !attempt.lines.is_empty();
        let keep_previous =
            !attempt.started && last.as_ref().is_some_and(|previous| previous.started);
        if !keep_previous {
            last = Some(attempt);
        }
        if done {
            break;
        }
    }
    let Some(attempt) = last else {
        return json!({ "success": false, "host": host, "error": "No traceroute program" });
    };
    let output = attempt.lines.join("\n");
    let hops: Vec<Value> = parse_traceroute(&output).iter().map(Hop::to_json).collect();
    let success = attempt.exited_ok || !hops.is_empty();
    let mut result = json!({
        "success": success,
        "host": host,
        "command": attempt.program,
        "lines": attempt.lines,
        "hops": hops,
        "timedOut": attempt.timed_out,
    });
    if attempt.timed_out {
        result["error"] = Value::String("Traceroute stopped after 30 seconds".to_string());
    } else if !attempt.errors.is_empty() && hops.is_empty() {
        result["error"] = Value::String(attempt.errors.join("\n"));
    }
    result
}

fn push_line(lines: &mut Vec<String>, line: &str) {
    if lines.len() >= MAX_OUTPUT_LINES {
        return;
    }
    let clean: String = line
        .chars()
        .filter(|c| !c.is_control() || *c == '\t')
        .take(MAX_LINE_LENGTH)
        .collect();
    lines.push(clean);
}

// ---------------------------------------------------------------------------
// Wake-on-LAN
// ---------------------------------------------------------------------------

/// Accepts `aa:bb:cc:dd:ee:ff`, `aa-bb-cc-dd-ee-ff`, `aabb.ccdd.eeff` and
/// `aabbccddeeff` (any case). The all-zero and broadcast addresses and
/// multicast addresses are refused: they never name one network card.
pub fn parse_mac(text: &str) -> Option<[u8; 6]> {
    let text = text.trim();
    let hex: String = if text.len() == 17 && (is_grouped(text, ':', 2) || is_grouped(text, '-', 2))
    {
        text.chars().filter(char::is_ascii_hexdigit).collect()
    } else if text.len() == 14 && is_grouped(text, '.', 4) {
        text.chars().filter(char::is_ascii_hexdigit).collect()
    } else if text.len() == 12 && text.chars().all(|c| c.is_ascii_hexdigit()) {
        text.to_string()
    } else {
        return None;
    };
    if hex.len() != 12 {
        return None;
    }
    let mut mac = [0u8; 6];
    for (index, byte) in mac.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).ok()?;
    }
    if mac == [0; 6] || mac[0] & 0x01 == 1 {
        return None;
    }
    Some(mac)
}

fn is_grouped(text: &str, separator: char, width: usize) -> bool {
    text.split(separator)
        .all(|group| group.len() == width && group.chars().all(|c| c.is_ascii_hexdigit()))
}

pub fn format_mac(mac: &[u8; 6]) -> String {
    mac.iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// 6 bytes of 0xFF followed by the MAC repeated 16 times (102 bytes).
pub fn magic_packet(mac: &[u8; 6]) -> [u8; 102] {
    let mut packet = [0xFFu8; 102];
    for repeat in 0..16 {
        packet[6 + repeat * 6..12 + repeat * 6].copy_from_slice(mac);
    }
    packet
}

/// An IPv4 address to send the magic packet to (a subnet broadcast such as
/// `192.168.1.255`, or a unicast relay). Multicast and `0.0.0.0` are refused.
pub fn parse_broadcast(text: &str) -> Option<Ipv4Addr> {
    let text = text.trim();
    if !crate::hosts::is_safe_host(text) {
        return None;
    }
    let address: Ipv4Addr = text.parse().ok()?;
    if address.is_unspecified() || address.is_multicast() {
        return None;
    }
    Some(address)
}

pub async fn wake(mac: &str, broadcast: Option<&str>) -> Value {
    let Some(parsed) = parse_mac(mac) else {
        return json!({ "success": false, "error": "Invalid MAC address" });
    };
    let target = match broadcast.map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => match parse_broadcast(text) {
            Some(address) => address,
            None => return json!({ "success": false, "error": "Invalid broadcast address" }),
        },
        None => Ipv4Addr::BROADCAST,
    };
    let packet = magic_packet(&parsed);
    let sent = async {
        let socket = tokio::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
        socket.set_broadcast(true)?;
        socket.send_to(&packet, (target, WOL_PORT)).await
    };
    match tokio::time::timeout(Duration::from_secs(5), sent).await {
        Ok(Ok(_)) => json!({
            "success": true,
            "mac": format_mac(&parsed),
            "broadcast": target.to_string(),
            "port": WOL_PORT
        }),
        Ok(Err(error)) => json!({ "success": false, "error": error.to_string() }),
        Err(_) => json!({ "success": false, "error": "Timed out sending the magic packet" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mac_notations() {
        let expected = [0xaa, 0xbb, 0xcc, 0x0d, 0xee, 0xff];
        assert_eq!(parse_mac("aa:bb:cc:0d:ee:ff"), Some(expected));
        assert_eq!(parse_mac("AA-BB-CC-0D-EE-FF"), Some(expected));
        assert_eq!(parse_mac("aabb.cc0d.eeff"), Some(expected));
        assert_eq!(parse_mac("aabbcc0deeff"), Some(expected));
        assert_eq!(parse_mac("  aa:bb:cc:0d:ee:ff "), Some(expected));
        assert_eq!(format_mac(&expected), "aa:bb:cc:0d:ee:ff");
    }

    #[test]
    fn refuses_malformed_or_group_macs() {
        for bad in [
            "",
            "aa:bb:cc:dd:ee",
            "aa:bb:cc:dd:ee:ff:00",
            "aa:bb-cc:dd:ee:ff",
            "aa:bb:cc:dd:ee:fg",
            "a:bb:cc:dd:ee:fff",
            "aabb.ccdd.eef",
            "00:00:00:00:00:00",
            "ff:ff:ff:ff:ff:ff",
            "01:00:5e:00:00:01",
            "aa:bb:cc:dd:ee:ff; reboot",
        ] {
            assert_eq!(parse_mac(bad), None, "{bad}");
        }
    }

    #[test]
    fn builds_the_magic_packet() {
        let mac = [0x00, 0x11, 0x22, 0x33, 0x44, 0x55];
        let packet = magic_packet(&mac);
        assert_eq!(packet.len(), 102);
        assert_eq!(&packet[..6], &[0xFF; 6]);
        for repeat in 0..16 {
            assert_eq!(&packet[6 + repeat * 6..12 + repeat * 6], &mac);
        }
    }

    #[test]
    fn broadcast_must_be_ipv4() {
        assert_eq!(
            parse_broadcast("192.168.1.255"),
            Some(Ipv4Addr::new(192, 168, 1, 255))
        );
        assert_eq!(
            parse_broadcast("255.255.255.255"),
            Some(Ipv4Addr::BROADCAST)
        );
        assert_eq!(parse_broadcast("0.0.0.0"), None);
        assert_eq!(parse_broadcast("224.0.0.1"), None);
        assert_eq!(parse_broadcast("::1"), None);
        assert_eq!(parse_broadcast("host.local"), None);
        assert_eq!(parse_broadcast("192.168.1.255;id"), None);
    }

    #[test]
    fn builds_web_urls_from_validated_addresses() {
        assert_eq!(
            build_web_url("192.168.1.1", None, None).as_deref(),
            Some("http://192.168.1.1/")
        );
        assert_eq!(
            build_web_url("192.168.1.1", None, Some(443)).as_deref(),
            Some("https://192.168.1.1/")
        );
        assert_eq!(
            build_web_url("192.168.1.1", Some("https"), Some(8443)).as_deref(),
            Some("https://192.168.1.1:8443/")
        );
        assert_eq!(
            build_web_url("192.168.1.1", Some("HTTP"), Some(80)).as_deref(),
            Some("http://192.168.1.1/")
        );
        assert_eq!(
            build_web_url("NAS.local", Some("http"), Some(5000)).as_deref(),
            Some("http://nas.local:5000/")
        );
        assert_eq!(
            build_web_url("2001:db8::1", None, Some(8080)).as_deref(),
            Some("http://[2001:db8::1]:8080/")
        );
        assert_eq!(
            build_web_url("[::1]", Some("https"), None).as_deref(),
            Some("https://[::1]/")
        );
        assert_eq!(
            build_web_url("fe80::1%eth0", None, None).as_deref(),
            Some("http://[fe80::1%25eth0]/")
        );
        assert_eq!(build_web_url("192.168.1.1", Some("javascript"), None), None);
        assert_eq!(build_web_url("192.168.1.1", Some("file"), None), None);
        assert_eq!(build_web_url("evil.com/@x", None, None), None);
        assert_eq!(build_web_url("a b", None, None), None);
        assert_eq!(build_web_url("192.168.1.1", None, Some(0)), None);
    }

    #[test]
    fn normalizes_node_fields_and_drops_invalid_ones() {
        let mut node = json!({
            "id": "n1",
            "mac": "AA-BB-CC-DD-EE-01",
            "wolBroadcast": " 10.0.0.255 ",
            "webUrlScheme": "HTTPS",
            "webPort": "8443"
        });
        normalize_action_fields(node.as_object_mut().unwrap());
        assert_eq!(node["mac"], "aa:bb:cc:dd:ee:01");
        assert_eq!(node["wolBroadcast"], "10.0.0.255");
        assert_eq!(node["webUrlScheme"], "https");
        assert_eq!(node["webPort"], 8443);

        let mut bad = json!({
            "id": "n2",
            "mac": "nope",
            "wolBroadcast": "::1",
            "webUrlScheme": "ftp",
            "webPort": "+80"
        });
        normalize_action_fields(bad.as_object_mut().unwrap());
        let object = bad.as_object().unwrap();
        for key in ["mac", "wolBroadcast", "webUrlScheme", "webPort"] {
            assert!(!object.contains_key(key), "{key}");
        }

        let mut legacy = json!({ "id": "n3" });
        normalize_action_fields(legacy.as_object_mut().unwrap());
        assert_eq!(legacy, json!({ "id": "n3" }));
    }

    #[test]
    fn traceroute_argv_per_platform() {
        assert_eq!(
            traceroute_command("192.168.1.1", "linux"),
            (
                "traceroute",
                ["-n", "-m", "30", "-w", "2", "-q", "3", "192.168.1.1"]
                    .map(String::from)
                    .to_vec()
            )
        );
        assert_eq!(
            traceroute_command("2001:db8::1", "linux"),
            (
                "traceroute",
                ["-6", "-n", "-m", "30", "-w", "2", "-q", "3", "2001:db8::1"]
                    .map(String::from)
                    .to_vec()
            )
        );
        assert_eq!(traceroute_command("2001:db8::1", "macos").0, "traceroute6");
        assert_eq!(traceroute_command("192.168.1.1", "macos").0, "traceroute");
        assert_eq!(
            traceroute_command("192.168.1.1", "windows"),
            (
                "tracert",
                ["-d", "-h", "30", "-w", "2000", "192.168.1.1"]
                    .map(String::from)
                    .to_vec()
            )
        );
        assert_eq!(traceroute_commands("192.168.1.1", "windows").len(), 1);
        assert_eq!(traceroute_commands("2001:db8::1", "macos").len(), 1);
        let linux_v4 = traceroute_commands("192.168.1.1", "linux");
        assert_eq!(linux_v4.len(), 2);
        assert_eq!(
            linux_v4[1].1,
            ["-m", "30", "-w", "2", "-q", "3", "192.168.1.1"]
                .map(String::from)
                .to_vec()
        );
        let linux_v6 = traceroute_commands("2001:db8::1", "linux");
        assert_eq!(linux_v6.len(), 4);
        assert_eq!(
            linux_v6[2],
            (
                "traceroute6",
                ["-n", "-m", "30", "-w", "2", "-q", "3", "2001:db8::1"]
                    .map(String::from)
                    .to_vec()
            )
        );
        for (_, args) in linux_v6 {
            assert_eq!(args.last().map(String::as_str), Some("2001:db8::1"));
        }
        assert_eq!(
            traceroute_command("::1", "windows"),
            (
                "tracert",
                ["-6", "-d", "-h", "30", "-w", "2000", "::1"]
                    .map(String::from)
                    .to_vec()
            )
        );
    }

    fn hop(hop: u8, address: Option<&str>, rtts: &[Option<f64>]) -> Hop {
        Hop {
            hop,
            address: address.map(String::from),
            rtts: rtts.to_vec(),
        }
    }

    #[test]
    fn parses_linux_traceroute() {
        let output = "traceroute to 8.8.8.8 (8.8.8.8), 30 hops max, 60 byte packets\n \
            1  192.168.1.1  0.512 ms  0.443 ms  0.401 ms\n \
            2  * * *\n \
            3  10.0.0.1  9.120 ms 10.0.0.2  9.501 ms *\n \
            4  8.8.8.8  12.3 ms !H  12.1 ms  12.0 ms\n";
        assert_eq!(
            parse_traceroute(output),
            vec![
                hop(
                    1,
                    Some("192.168.1.1"),
                    &[Some(0.512), Some(0.443), Some(0.401)]
                ),
                hop(2, None, &[None, None, None]),
                hop(3, Some("10.0.0.1"), &[Some(9.12), Some(9.501), None]),
                hop(4, Some("8.8.8.8"), &[Some(12.3), Some(12.1), Some(12.0)]),
            ]
        );
    }

    #[test]
    fn parses_gnu_inetutils_traceroute() {
        let output = "traceroute to 127.0.0.1 (127.0.0.1), 30 hops max\n  \
            1   127.0.0.1  0.002ms  0.001ms  0.001ms \n";
        assert_eq!(
            parse_traceroute(output),
            vec![hop(
                1,
                Some("127.0.0.1"),
                &[Some(0.002), Some(0.001), Some(0.001)]
            )]
        );
    }

    #[test]
    fn parses_named_hops_and_ipv6() {
        let output = "traceroute6 to 2001:db8::1 (2001:db8::1), 30 hops max\n \
            1  router.lan (192.168.1.1)  1.1 ms  1.0 ms  0.9 ms\n \
            2  2001:DB8:0::fe  3.2 ms  3.1 ms  3.0 ms\n";
        assert_eq!(
            parse_traceroute(output),
            vec![
                hop(1, Some("192.168.1.1"), &[Some(1.1), Some(1.0), Some(0.9)]),
                hop(2, Some("2001:db8::fe"), &[Some(3.2), Some(3.1), Some(3.0)]),
            ]
        );
    }

    #[test]
    fn parses_macos_traceroute() {
        let output = "traceroute to example.com (93.184.216.34), 30 hops max, 52 byte packets\n \
            1  192.168.0.1  2.345 ms  1.987 ms  1.876 ms\n \
            2  * 100.64.0.1  15.002 ms  14.771 ms\n";
        assert_eq!(
            parse_traceroute(output),
            vec![
                hop(
                    1,
                    Some("192.168.0.1"),
                    &[Some(2.345), Some(1.987), Some(1.876)]
                ),
                hop(2, Some("100.64.0.1"), &[None, Some(15.002), Some(14.771)]),
            ]
        );
    }

    #[test]
    fn parses_windows_tracert_in_english() {
        let output = "\r\nTracing route to 8.8.8.8 over a maximum of 30 hops\r\n\r\n  \
            1    <1 ms    <1 ms    <1 ms  192.168.1.1\r\n  \
            2     5 ms     4 ms     6 ms  10.0.0.1\r\n  \
            3     *        *        *     Request timed out.\r\n  \
            4    12 ms    11 ms    13 ms  dns.google [8.8.8.8]\r\n\r\nTrace complete.\r\n";
        assert_eq!(
            parse_traceroute(output),
            vec![
                hop(1, Some("192.168.1.1"), &[Some(1.0), Some(1.0), Some(1.0)]),
                hop(2, Some("10.0.0.1"), &[Some(5.0), Some(4.0), Some(6.0)]),
                hop(3, None, &[None, None, None]),
                hop(4, Some("8.8.8.8"), &[Some(12.0), Some(11.0), Some(13.0)]),
            ]
        );
    }

    #[test]
    fn parses_windows_tracert_in_french() {
        let output = "\r\nDétermination de l’itinéraire vers 8.8.8.8 avec un maximum de 30 sauts.\r\n\r\n  \
            1    <1 ms    <1 ms    <1 ms  box.home [192.168.1.254]\r\n  \
            2     *        *        *     Délai d’attente de la demande dépassé.\r\n  \
            3     8 ms     7 ms     9 ms  2001:db8::2\r\n\r\nItinéraire déterminé.\r\n";
        assert_eq!(
            parse_traceroute(output),
            vec![
                hop(1, Some("192.168.1.254"), &[Some(1.0), Some(1.0), Some(1.0)]),
                hop(2, None, &[None, None, None]),
                hop(3, Some("2001:db8::2"), &[Some(8.0), Some(7.0), Some(9.0)]),
            ]
        );
    }

    #[test]
    fn parser_never_returns_an_unsafe_address() {
        let output = " 1  $(reboot)  1 ms\n 2  192.168.1.1;id  2 ms\n 3  -rf  3 ms\n";
        for hop in parse_traceroute(output) {
            assert_eq!(hop.address, None);
        }
    }

    #[test]
    fn invalid_hosts_never_reach_traceroute() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for bad in ["", "-n", "8.8.8.8 -m 1", "$(id)", "a;b"] {
            let result = runtime.block_on(traceroute(bad));
            assert_eq!(result["success"], false, "{bad}");
            assert_eq!(result["error"], "Invalid host");
        }
    }
}
