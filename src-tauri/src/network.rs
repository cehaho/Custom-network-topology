//! Local interfaces, ping, scan, and ARP.
//!
//! `ping` and `arp` are started with an argument list, never a shell.

use std::net::Ipv4Addr;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::hosts::{clamp_scan_range, is_safe_base_ip, is_safe_host, is_safe_port, ping_args};

const BATCH_SIZE: i64 = 20;

#[derive(Clone, Copy)]
pub struct Probe {
    pub online: bool,
    pub duration_ms: u64,
}

pub async fn ping_host(host: &str, timeout: Duration) -> Probe {
    let start = Instant::now();
    if !is_safe_host(host) {
        return Probe {
            online: false,
            duration_ms: 0,
        };
    }
    let online = run_ping(host, timeout).await;
    Probe {
        online,
        duration_ms: start.elapsed().as_millis() as u64,
    }
}

pub async fn check_port(host: &str, port: u16, timeout: Duration) -> bool {
    if !is_safe_host(host) || !is_safe_port(i64::from(port)) {
        return false;
    }
    let address = format!("{host}:{port}");
    match tokio::time::timeout(timeout, tokio::net::TcpStream::connect(address)).await {
        Ok(Ok(stream)) => {
            drop(stream);
            true
        }
        _ => false,
    }
}

pub fn local_interfaces() -> Vec<Value> {
    let interfaces = if_addrs::get_if_addrs().unwrap_or_default();
    interfaces
        .into_iter()
        .filter_map(|interface| {
            if interface.is_loopback() {
                return None;
            }
            let if_addrs::IfAddr::V4(address) = interface.addr else {
                return None;
            };
            Some(json!({
                "interface": interface.name,
                "address": address.ip.to_string(),
                "netmask": address.netmask.to_string(),
                "mac": mac_address(&interface.name),
            }))
        })
        .collect()
}

pub async fn ping_command(host: &str) -> Value {
    if !is_safe_host(host) {
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
    let mut command = Command::new("arp");
    command
        .arg("-a")
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let Ok(mut child) = command.spawn() else {
        return Vec::new();
    };
    let mut stdout = String::new();
    let read = async {
        if let Some(pipe) = child.stdout.as_mut() {
            let _ = pipe.read_to_string(&mut stdout).await;
        }
        let _ = child.wait().await;
    };
    if tokio::time::timeout(Duration::from_secs(5), read)
        .await
        .is_err()
    {
        return Vec::new();
    }
    parse_arp(&stdout, cfg!(windows))
}

pub fn parse_arp(stdout: &str, windows: bool) -> Vec<Value> {
    stdout
        .lines()
        .filter_map(|line| parse_arp_line(line, windows))
        .map(|(ip, mac)| json!({ "ip": ip, "mac": mac }))
        .collect()
}

async fn run_ping(host: &str, timeout: Duration) -> bool {
    let mut command = Command::new("ping");
    command
        .args(ping_args(host, cfg!(windows)))
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
}
