//! Per-node probe definitions: several TCP ports, an HTTP(S) check, a DNS
//! check, and optionally ICMP ping.
//!
//! Keep the document rules aligned with `renderer/js/probe-checks.js`.
//!
//! A node without a `probe` object keeps the default probe (ping, or a TCP
//! connect on `port`). A node with one runs every configured check; it is up
//! only when every check passes. Each check targets the node's own address:
//! the HTTP URL is built from that address, a port, and a path, so an imported
//! file cannot point a check at another host. Redirects are not followed.
//!
//! ```json
//! "probe": {
//!   "ping": true,
//!   "tcp":  { "ports": [22, 443], "mode": "all" },
//!   "http": { "scheme": "https", "port": 8443, "path": "/health",
//!             "expectStatus": "200-399", "timeoutMs": 3000, "insecureTls": false },
//!   "dns":  { "name": "example.com", "type": "A", "port": 53, "timeoutMs": 2000 }
//! }
//! ```

use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use crate::hosts::{format_host_port, normalize_host};

pub const MAX_TCP_PORTS: usize = 16;
const MAX_PATH_LENGTH: usize = 256;
const DEFAULT_STATUS: (u16, u16) = (200, 399);
const HTTP_TIMEOUT: (u64, u64, u64) = (500, 3000, 30000);
const DNS_TIMEOUT: (u64, u64, u64) = (500, 2000, 10000);
const TCP_TIMEOUT: Duration = Duration::from_millis(1000);
const PING_TIMEOUT: Duration = Duration::from_millis(2000);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TcpCheck {
    pub ports: Vec<u16>,
    pub any: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpCheck {
    pub https: bool,
    pub port: Option<u16>,
    pub path: String,
    pub status: (u16, u16),
    pub timeout_ms: u64,
    pub insecure_tls: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DnsCheck {
    pub name: String,
    pub aaaa: bool,
    pub port: u16,
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Checks {
    pub ping: bool,
    pub tcp: Option<TcpCheck>,
    pub http: Option<HttpCheck>,
    pub dns: Option<DnsCheck>,
}

impl Checks {
    pub fn is_empty(&self) -> bool {
        !self.ping && self.tcp.is_none() && self.http.is_none() && self.dns.is_none()
    }
}

/// What the monitor does with a node.
#[derive(Debug, PartialEq, Eq)]
pub enum RichPlan {
    /// No `probe` object: the default ping / TCP probe applies.
    Default,
    /// A `probe` object that is invalid, or an address that is not a host.
    Skip,
    Run(String, Checks),
}

pub fn plan(node: &Map<String, Value>) -> RichPlan {
    let checks = match node.get("probe").map(parse_checks) {
        None | Some(Ok(None)) => return RichPlan::Default,
        Some(Err(_)) => return RichPlan::Skip,
        Some(Ok(Some(checks))) => checks,
    };
    let address = node.get("address").and_then(Value::as_str).unwrap_or("");
    match normalize_host(address) {
        Some(host) => RichPlan::Run(host, checks),
        None => RichPlan::Skip,
    }
}

/// Checks a node's `probe` for the topology reader. The error names the node.
pub fn check_node(node: &Value) -> Result<(), String> {
    let Some(probe) = node.get("probe") else {
        return Ok(());
    };
    parse_checks(probe).map(|_| ()).map_err(|error| {
        let id = node.get("id").and_then(Value::as_str).unwrap_or("");
        if id.is_empty() {
            format!("Node probe: {error}")
        } else {
            format!("Node {id} probe: {error}")
        }
    })
}

/// Rewrites `probe` in its canonical form, or removes it when it holds no
/// check. Call after `check_node`; an invalid probe is removed as well.
pub fn normalize_node(node: &mut Map<String, Value>) {
    let Some(probe) = node.get("probe") else {
        return;
    };
    match parse_checks(probe) {
        Ok(Some(checks)) => {
            node.insert("probe".to_string(), to_json(&checks));
        }
        _ => {
            node.remove("probe");
        }
    }
}

/// `Ok(None)` for `null` or a probe with no check.
pub fn parse_checks(value: &Value) -> Result<Option<Checks>, String> {
    let object = match value {
        Value::Null => return Ok(None),
        Value::Object(object) => object,
        _ => return Err("must be an object".to_string()),
    };
    let mut checks = Checks::default();
    match object.get("ping") {
        None | Some(Value::Null) => {}
        Some(Value::Bool(flag)) => checks.ping = *flag,
        Some(_) => return Err("ping must be true or false".to_string()),
    }
    if let Some(tcp) = present(object.get("tcp")) {
        checks.tcp = parse_tcp(tcp)?;
    }
    if let Some(http) = present(object.get("http")) {
        checks.http = Some(parse_http(http)?);
    }
    if let Some(dns) = present(object.get("dns")) {
        checks.dns = Some(parse_dns(dns)?);
    }
    Ok((!checks.is_empty()).then_some(checks))
}

pub fn to_json(checks: &Checks) -> Value {
    let mut out = Map::new();
    if checks.ping {
        out.insert("ping".to_string(), json!(true));
    }
    if let Some(tcp) = &checks.tcp {
        out.insert(
            "tcp".to_string(),
            json!({ "ports": tcp.ports, "mode": if tcp.any { "any" } else { "all" } }),
        );
    }
    if let Some(http) = &checks.http {
        let mut item = Map::new();
        item.insert("scheme".to_string(), json!(if http.https { "https" } else { "http" }));
        if let Some(port) = http.port {
            item.insert("port".to_string(), json!(port));
        }
        item.insert("path".to_string(), json!(http.path));
        item.insert("expectStatus".to_string(), json!(status_text(http.status)));
        item.insert("timeoutMs".to_string(), json!(http.timeout_ms));
        item.insert("insecureTls".to_string(), json!(http.insecure_tls));
        out.insert("http".to_string(), Value::Object(item));
    }
    if let Some(dns) = &checks.dns {
        out.insert(
            "dns".to_string(),
            json!({
                "name": dns.name,
                "type": if dns.aaaa { "AAAA" } else { "A" },
                "port": dns.port,
                "timeoutMs": dns.timeout_ms,
            }),
        );
    }
    Value::Object(out)
}

fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null() && *value != &Value::Bool(false))
}

fn parse_tcp(value: &Value) -> Result<Option<TcpCheck>, String> {
    let object = value.as_object().ok_or("tcp must be an object")?;
    let list = match object.get("ports") {
        Some(Value::Array(list)) => list,
        _ => return Err("tcp.ports must be a list of ports".to_string()),
    };
    let mut ports: Vec<u16> = Vec::new();
    for item in list {
        let port = port_value(item).ok_or("tcp.ports holds an invalid port")?;
        if !ports.contains(&port) {
            ports.push(port);
        }
    }
    if ports.len() > MAX_TCP_PORTS {
        return Err(format!("tcp.ports holds more than {MAX_TCP_PORTS} ports"));
    }
    let any = match object.get("mode") {
        None | Some(Value::Null) => false,
        Some(Value::String(mode)) if mode == "all" => false,
        Some(Value::String(mode)) if mode == "any" => true,
        Some(_) => return Err("tcp.mode must be \"all\" or \"any\"".to_string()),
    };
    Ok((!ports.is_empty()).then_some(TcpCheck { ports, any }))
}

fn parse_http(value: &Value) -> Result<HttpCheck, String> {
    let object = value.as_object().ok_or("http must be an object")?;
    if object.contains_key("host") || object.contains_key("url") {
        return Err("http.host and http.url are not allowed: the check targets the node address".to_string());
    }
    let https = match object.get("scheme") {
        None | Some(Value::Null) => false,
        Some(Value::String(scheme)) if scheme == "http" => false,
        Some(Value::String(scheme)) if scheme == "https" => true,
        Some(_) => return Err("http.scheme must be \"http\" or \"https\"".to_string()),
    };
    let port = match object.get("port") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(item) => Some(port_value(item).ok_or("http.port is not a valid port")?),
    };
    let path = match object.get("path") {
        None | Some(Value::Null) => "/".to_string(),
        Some(Value::String(text)) if text.is_empty() => "/".to_string(),
        Some(Value::String(text)) if is_safe_path(text) => text.clone(),
        Some(_) => return Err("http.path must start with / and hold URL characters only".to_string()),
    };
    let status = match object.get("expectStatus") {
        None | Some(Value::Null) => DEFAULT_STATUS,
        Some(Value::String(text)) if text.is_empty() => DEFAULT_STATUS,
        Some(Value::String(text)) => parse_status(text).ok_or("http.expectStatus must look like 200 or 200-399")?,
        Some(Value::Number(number)) => number
            .as_u64()
            .and_then(|code| parse_status(&code.to_string()))
            .ok_or("http.expectStatus must look like 200 or 200-399")?,
        Some(_) => return Err("http.expectStatus must look like 200 or 200-399".to_string()),
    };
    let timeout_ms = timeout_value(object.get("timeoutMs"), HTTP_TIMEOUT)
        .ok_or("http.timeoutMs must be between 500 and 30000")?;
    let insecure_tls = match object.get("insecureTls") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag && https,
        Some(_) => return Err("http.insecureTls must be true or false".to_string()),
    };
    Ok(HttpCheck {
        https,
        port,
        path,
        status,
        timeout_ms,
        insecure_tls,
    })
}

fn parse_dns(value: &Value) -> Result<DnsCheck, String> {
    let object = value.as_object().ok_or("dns must be an object")?;
    let name = match object.get("name") {
        Some(Value::String(text)) => {
            let trimmed = text.trim().trim_end_matches('.').to_ascii_lowercase();
            if !is_query_name(&trimmed) {
                return Err("dns.name must be a host name".to_string());
            }
            trimmed
        }
        _ => return Err("dns.name must be a host name".to_string()),
    };
    let aaaa = match object.get("type") {
        None | Some(Value::Null) => false,
        Some(Value::String(kind)) if kind.eq_ignore_ascii_case("a") => false,
        Some(Value::String(kind)) if kind.eq_ignore_ascii_case("aaaa") => true,
        Some(_) => return Err("dns.type must be \"A\" or \"AAAA\"".to_string()),
    };
    let port = match object.get("port") {
        None | Some(Value::Null) => 53,
        Some(Value::String(text)) if text.is_empty() => 53,
        Some(item) => port_value(item).ok_or("dns.port is not a valid port")?,
    };
    let timeout_ms = timeout_value(object.get("timeoutMs"), DNS_TIMEOUT)
        .ok_or("dns.timeoutMs must be between 500 and 10000")?;
    Ok(DnsCheck {
        name,
        aaaa,
        port,
        timeout_ms,
    })
}

fn port_value(value: &Value) -> Option<u16> {
    let number = match value {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) => {
            text.parse::<f64>().ok()?
        }
        _ => return None,
    };
    if !number.is_finite() || number.fract() != 0.0 || !(1.0..=65535.0).contains(&number) {
        return None;
    }
    Some(number as u16)
}

fn timeout_value(value: Option<&Value>, (low, default, high): (u64, u64, u64)) -> Option<u64> {
    let number = match value {
        None | Some(Value::Null) => return Some(default),
        Some(Value::Number(number)) => number.as_f64()?,
        _ => return None,
    };
    if !number.is_finite() || number.fract() != 0.0 || number < low as f64 || number > high as f64 {
        return None;
    }
    Some(number as u64)
}

fn parse_status(text: &str) -> Option<(u16, u16)> {
    let code = |part: &str| -> Option<u16> {
        if part.len() != 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse::<u16>().ok().filter(|code| (100..=599).contains(code))
    };
    let (low, high) = match text.split_once('-') {
        Some((low, high)) => (code(low)?, code(high)?),
        None => {
            let single = code(text)?;
            (single, single)
        }
    };
    (low <= high).then_some((low, high))
}

fn status_text((low, high): (u16, u16)) -> String {
    if low == high {
        low.to_string()
    } else {
        format!("{low}-{high}")
    }
}

/// An absolute path with an optional query. No `#`, no backslash, no space,
/// no control character, nothing that could end the authority early.
pub fn is_safe_path(path: &str) -> bool {
    path.len() <= MAX_PATH_LENGTH
        && path.starts_with('/')
        && !path.starts_with("//")
        && path.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'/' | b'-' | b'.' | b'_' | b'~' | b'%' | b'?' | b'&' | b'=' | b'+' | b',' | b';' | b':' | b'!' | b'*' | b'\'' | b'(' | b')' | b'$'
                )
        })
}

fn is_query_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 253 {
        return false;
    }
    let labels: Vec<&str> = name.split('.').collect();
    if labels.iter().all(|label| label.bytes().all(|b| b.is_ascii_digit())) {
        return false;
    }
    labels.iter().all(|label| {
        let bytes = label.as_bytes();
        !bytes.is_empty()
            && bytes.len() <= 63
            && bytes[0].is_ascii_alphanumeric()
            && bytes[bytes.len() - 1].is_ascii_alphanumeric()
            && bytes.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_')
    })
}

// ---------------------------------------------------------------- running

pub struct Outcome {
    pub online: bool,
    pub elapsed_ms: u64,
    pub detail: String,
}

/// Runs every check at once. `detail` lists the failed checks, or a short
/// summary when all pass.
pub async fn run(host: &str, checks: &Checks) -> Outcome {
    let started = Instant::now();
    let ping = async {
        if !checks.ping {
            return None;
        }
        let probe = crate::network::ping_host(host, PING_TIMEOUT).await;
        Some(if probe.online { Ok("ping".to_string()) } else { Err("ping: no reply".to_string()) })
    };
    let tcp = async {
        let check = checks.tcp.as_ref()?;
        Some(run_tcp(host, check).await)
    };
    let http = async {
        let check = checks.http.as_ref()?;
        Some(run_http(host, check).await)
    };
    let dns = async {
        let check = checks.dns.as_ref()?;
        Some(run_dns(host, check).await)
    };
    let (ping, tcp, http, dns) = tokio::join!(ping, tcp, http, dns);
    let results: Vec<Result<String, String>> = [ping, tcp, http, dns].into_iter().flatten().collect();
    let (online, detail) = summarize(&results);
    Outcome {
        online,
        elapsed_ms: started.elapsed().as_millis() as u64,
        detail,
    }
}

pub fn summarize(results: &[Result<String, String>]) -> (bool, String) {
    let failures: Vec<&str> = results.iter().filter_map(|r| r.as_ref().err()).map(String::as_str).collect();
    if failures.is_empty() {
        let passes: Vec<&str> = results.iter().filter_map(|r| r.as_ref().ok()).map(String::as_str).collect();
        (true, passes.join(" · "))
    } else {
        (false, failures.join(" · "))
    }
}

async fn run_tcp(host: &str, check: &TcpCheck) -> Result<String, String> {
    let mut attempts = tokio::task::JoinSet::new();
    for port in check.ports.iter().copied() {
        let host = host.to_string();
        attempts.spawn(async move { (port, crate::network::check_port(&host, port, TCP_TIMEOUT).await) });
    }
    let mut results = Vec::new();
    while let Some(joined) = attempts.join_next().await {
        if let Ok(pair) = joined {
            results.push(pair);
        }
    }
    results.sort_unstable();
    let open: Vec<u16> = results.iter().filter(|(_, ok)| *ok).map(|(port, _)| *port).collect();
    let closed: Vec<u16> = check.ports.iter().copied().filter(|port| !open.contains(port)).collect();
    tcp_verdict(check, &open, &closed)
}

pub fn tcp_verdict(check: &TcpCheck, open: &[u16], closed: &[u16]) -> Result<String, String> {
    let list = |ports: &[u16]| ports.iter().map(u16::to_string).collect::<Vec<_>>().join(",");
    let passed = if check.any { !open.is_empty() } else { closed.is_empty() };
    if passed {
        Ok(format!("tcp {}", list(open)))
    } else {
        Err(format!("tcp {} closed", list(closed)))
    }
}

/// The URL of an HTTP check. The host is always the node's address.
pub fn http_url(host: &str, check: &HttpCheck) -> Option<String> {
    if host.contains('%') {
        return None;
    }
    let scheme = if check.https { "https" } else { "http" };
    let authority = match check.port {
        Some(port) => format_host_port(host, port),
        None if host.contains(':') => format!("[{host}]"),
        None => host.to_string(),
    };
    if !is_safe_path(&check.path) {
        return None;
    }
    Some(format!("{scheme}://{authority}{}", check.path))
}

async fn run_http(host: &str, check: &HttpCheck) -> Result<String, String> {
    let Some(url) = http_url(host, check) else {
        return Err("http: zoned address not supported".to_string());
    };
    let Ok(parsed) = reqwest::Url::parse(&url) else {
        return Err("http: bad URL".to_string());
    };
    let expected = if host.contains(':') { format!("[{}]", host.to_ascii_lowercase()) } else { host.to_ascii_lowercase() };
    let same_host = parsed
        .host_str()
        .is_some_and(|actual| actual.eq_ignore_ascii_case(&expected) || canonical_v6(actual) == canonical_v6(&expected));
    if !same_host {
        return Err("http: host differs from node".to_string());
    }
    let timeout = Duration::from_millis(check.timeout_ms);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(timeout)
        .connect_timeout(timeout)
        .user_agent("network-topology-probe")
        .tls_danger_accept_invalid_certs(check.insecure_tls)
        .build();
    let Ok(client) = client else {
        return Err("http: client error".to_string());
    };
    match client.get(parsed).send().await {
        Ok(response) => {
            let code = response.status().as_u16();
            if (check.status.0..=check.status.1).contains(&code) {
                Ok(format!("http {code}"))
            } else {
                Err(format!("http {code} (expected {})", status_text(check.status)))
            }
        }
        Err(error) if error.is_timeout() => Err("http: timeout".to_string()),
        Err(error) if error.is_connect() => Err("http: connection failed".to_string()),
        Err(_) => Err("http: request failed".to_string()),
    }
}

fn canonical_v6(text: &str) -> String {
    let bare = text.trim_start_matches('[').trim_end_matches(']');
    bare.parse::<std::net::Ipv6Addr>()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| bare.to_ascii_lowercase())
}

pub fn dns_query(id: u16, name: &str, aaaa: bool) -> Option<Vec<u8>> {
    if !is_query_name(name) {
        return None;
    }
    let mut packet = Vec::with_capacity(18 + name.len());
    packet.extend_from_slice(&id.to_be_bytes());
    packet.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
    for label in name.split('.') {
        packet.push(label.len() as u8);
        packet.extend_from_slice(label.as_bytes());
    }
    packet.push(0);
    packet.extend_from_slice(&(if aaaa { 28u16 } else { 1u16 }).to_be_bytes());
    packet.extend_from_slice(&1u16.to_be_bytes());
    Some(packet)
}

/// `None` when the packet is not a reply to `id`; otherwise the verdict.
pub fn dns_verdict(id: u16, reply: &[u8]) -> Option<Result<String, String>> {
    if reply.len() < 12 || u16::from_be_bytes([reply[0], reply[1]]) != id || reply[2] & 0x80 == 0 {
        return None;
    }
    let rcode = reply[3] & 0x0f;
    let answers = u16::from_be_bytes([reply[6], reply[7]]);
    Some(match rcode {
        0 if answers > 0 => Ok(format!("dns {answers} answer{}", if answers == 1 { "" } else { "s" })),
        0 => Err("dns: no answer".to_string()),
        1 => Err("dns: FORMERR".to_string()),
        2 => Err("dns: SERVFAIL".to_string()),
        3 => Err("dns: NXDOMAIN".to_string()),
        5 => Err("dns: REFUSED".to_string()),
        other => Err(format!("dns: rcode {other}")),
    })
}

async fn run_dns(host: &str, check: &DnsCheck) -> Result<String, String> {
    let deadline = Duration::from_millis(check.timeout_ms);
    match tokio::time::timeout(deadline, dns_exchange(host, check)).await {
        Ok(result) => result,
        Err(_) => Err("dns: timeout".to_string()),
    }
}

async fn dns_exchange(host: &str, check: &DnsCheck) -> Result<String, String> {
    let target = tokio::net::lookup_host((host, check.port))
        .await
        .ok()
        .and_then(|mut addresses| addresses.next())
        .ok_or("dns: server not resolved")?;
    let local = if target.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" };
    let socket = tokio::net::UdpSocket::bind(local)
        .await
        .map_err(|_| "dns: no socket".to_string())?;
    socket
        .connect(target)
        .await
        .map_err(|_| "dns: unreachable".to_string())?;
    let id = query_id();
    let query = dns_query(id, &check.name, check.aaaa).ok_or("dns: bad name")?;
    socket
        .send(&query)
        .await
        .map_err(|_| "dns: send failed".to_string())?;
    let mut buffer = [0u8; 1500];
    loop {
        let size = socket
            .recv(&mut buffer)
            .await
            .map_err(|_| "dns: no reply".to_string())?;
        if let Some(verdict) = dns_verdict(id, &buffer[..size]) {
            return verdict;
        }
    }
}

fn query_id() -> u16 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.subsec_nanos())
        .unwrap_or(0);
    (nanos ^ (nanos >> 16)) as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(address: &str, probe: Value) -> Map<String, Value> {
        let mut object = Map::new();
        object.insert("id".to_string(), json!("n1"));
        object.insert("address".to_string(), json!(address));
        object.insert("probe".to_string(), probe);
        object
    }

    #[test]
    fn a_node_without_probe_keeps_the_default() {
        let mut object = Map::new();
        object.insert("address".to_string(), json!("10.0.0.1"));
        assert_eq!(plan(&object), RichPlan::Default);
        assert_eq!(plan(&node("10.0.0.1", Value::Null)), RichPlan::Default);
        assert_eq!(plan(&node("10.0.0.1", json!({}))), RichPlan::Default);
        assert_eq!(plan(&node("10.0.0.1", json!({ "tcp": { "ports": [] } }))), RichPlan::Default);
    }

    #[test]
    fn invalid_probes_and_hosts_are_skipped() {
        assert_eq!(plan(&node("10.0.0.1", json!("ping"))), RichPlan::Skip);
        assert_eq!(plan(&node("$(id)", json!({ "ping": true }))), RichPlan::Skip);
        assert_eq!(plan(&node("10.0.0.1", json!({ "tcp": { "ports": [0] } }))), RichPlan::Skip);
    }

    #[test]
    fn parses_and_normalizes_every_check() {
        let raw = json!({
            "ping": true,
            "tcp": { "ports": [22, "443", 22] },
            "http": { "scheme": "https", "port": 8443, "path": "/health?x=1", "expectStatus": "200-299", "insecureTls": true },
            "dns": { "name": "Example.COM.", "type": "aaaa" },
            "future": 1
        });
        let RichPlan::Run(host, checks) = plan(&node("[::1]", raw)) else {
            panic!("expected a plan");
        };
        assert_eq!(host, "::1");
        assert!(checks.ping);
        assert_eq!(checks.tcp, Some(TcpCheck { ports: vec![22, 443], any: false }));
        let http = checks.http.clone().unwrap();
        assert_eq!(http.status, (200, 299));
        assert_eq!(http.timeout_ms, 3000);
        assert!(http.insecure_tls);
        let dns = checks.dns.clone().unwrap();
        assert_eq!(dns.name, "example.com");
        assert!(dns.aaaa);
        assert_eq!(dns.port, 53);
        assert_eq!(
            to_json(&checks),
            json!({
                "ping": true,
                "tcp": { "ports": [22, 443], "mode": "all" },
                "http": { "scheme": "https", "port": 8443, "path": "/health?x=1", "expectStatus": "200-299", "timeoutMs": 3000, "insecureTls": true },
                "dns": { "name": "example.com", "type": "AAAA", "port": 53, "timeoutMs": 2000 }
            })
        );
    }

    #[test]
    fn insecure_tls_is_off_by_default_and_ignored_for_plain_http() {
        let checks = parse_checks(&json!({ "http": {} })).unwrap().unwrap();
        let http = checks.http.unwrap();
        assert!(!http.https && !http.insecure_tls);
        assert_eq!(http.path, "/");
        assert_eq!(http.status, (200, 399));
        let plain = parse_checks(&json!({ "http": { "insecureTls": true } })).unwrap().unwrap();
        assert!(!plain.http.unwrap().insecure_tls);
    }

    #[test]
    fn rejects_malformed_checks() {
        let bad = [
            json!({ "ping": "yes" }),
            json!({ "tcp": { "ports": [70000] } }),
            json!({ "tcp": { "ports": [22], "mode": "some" } }),
            json!({ "tcp": { "ports": (1..=17).collect::<Vec<u16>>() } }),
            json!({ "http": { "scheme": "ftp" } }),
            json!({ "http": { "path": "health" } }),
            json!({ "http": { "path": "//evil.example/" } }),
            json!({ "http": { "path": "/a b" } }),
            json!({ "http": { "path": "/#x" } }),
            json!({ "http": { "path": "/\\evil" } }),
            json!({ "http": { "path": "@evil.example/" } }),
            json!({ "http": { "expectStatus": "399-200" } }),
            json!({ "http": { "expectStatus": "abc" } }),
            json!({ "http": { "timeoutMs": 100 } }),
            json!({ "http": { "host": "evil.example", "path": "/" } }),
            json!({ "http": { "url": "http://evil.example/" } }),
            json!({ "dns": { "name": "" } }),
            json!({ "dns": { "name": "1.2.3.4" } }),
            json!({ "dns": { "name": "a;b" } }),
            json!({ "dns": { "name": "x.example", "type": "MX" } }),
        ];
        for probe in bad {
            assert!(parse_checks(&probe).is_err(), "accepted {probe}");
        }
        let error = check_node(&json!({ "id": "gw", "probe": { "tcp": { "ports": [0] } } })).unwrap_err();
        assert!(error.starts_with("Node gw probe:"), "{error}");
    }

    #[test]
    fn the_http_url_always_targets_the_node() {
        let check = |port: Option<u16>, path: &str| HttpCheck {
            https: false,
            port,
            path: path.to_string(),
            status: DEFAULT_STATUS,
            timeout_ms: 3000,
            insecure_tls: false,
        };
        assert_eq!(http_url("10.0.0.1", &check(None, "/")).unwrap(), "http://10.0.0.1/");
        assert_eq!(http_url("nas.lan", &check(Some(8080), "/x")).unwrap(), "http://nas.lan:8080/x");
        assert_eq!(http_url("2001:db8::1", &check(Some(80), "/")).unwrap(), "http://[2001:db8::1]:80/");
        assert_eq!(http_url("::1", &check(None, "/")).unwrap(), "http://[::1]/");
        assert!(http_url("fe80::1%eth0", &check(None, "/")).is_none());
        assert!(http_url("10.0.0.1", &check(None, "@evil/")).is_none());
        assert!(http_url("10.0.0.1", &check(None, "/@evil.example:80/")).is_none());
        let url = reqwest::Url::parse(&http_url("10.0.0.1", &check(None, "/evil.example:80/?a=b")).unwrap()).unwrap();
        assert_eq!(url.host_str(), Some("10.0.0.1"));
    }

    /// The same cases run in `test/probe-checks.test.js`.
    #[test]
    fn shared_fixture_matches_the_renderer() {
        let cases: Value =
            serde_json::from_str(include_str!("../../test/fixtures/probe-checks.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let parsed = parse_checks(&case["probe"]);
            if let Some(error) = case.get("error") {
                assert_eq!(parsed.as_ref().err().map(String::as_str), error.as_str(), "{case}");
            } else {
                let actual = parsed.unwrap_or_else(|e| panic!("{case}: {e}")).map(|c| to_json(&c));
                assert_eq!(actual.unwrap_or(Value::Null), case["result"], "{case}");
            }
        }
    }

    #[test]
    fn tcp_modes() {
        let all = TcpCheck { ports: vec![22, 443], any: false };
        let any = TcpCheck { any: true, ..all.clone() };
        assert_eq!(tcp_verdict(&all, &[22, 443], &[]), Ok("tcp 22,443".to_string()));
        assert_eq!(tcp_verdict(&all, &[22], &[443]), Err("tcp 443 closed".to_string()));
        assert_eq!(tcp_verdict(&any, &[22], &[443]), Ok("tcp 22".to_string()));
        assert_eq!(tcp_verdict(&any, &[], &[22, 443]), Err("tcp 22,443 closed".to_string()));
    }

    #[test]
    fn summary_names_the_failed_check() {
        let results = vec![Ok("tcp 22".to_string()), Err("http 500 (expected 200-399)".to_string())];
        assert_eq!(summarize(&results), (false, "http 500 (expected 200-399)".to_string()));
        let fine = vec![Ok("ping".to_string()), Ok("dns 1 answer".to_string())];
        assert_eq!(summarize(&fine), (true, "ping · dns 1 answer".to_string()));
    }

    #[test]
    fn builds_and_reads_dns_packets() {
        let query = dns_query(0xabcd, "nas.lan", false).unwrap();
        assert_eq!(&query[..4], &[0xab, 0xcd, 0x01, 0x00]);
        assert_eq!(&query[4..6], &[0, 1]);
        assert_eq!(&query[12..21], b"\x03nas\x03lan\x00");
        assert_eq!(&query[21..], &[0, 1, 0, 1]);
        assert_eq!(&dns_query(1, "x.lan", true).unwrap()[19..], &[0, 28, 0, 1]);
        assert!(dns_query(1, "bad name", false).is_none());

        let mut reply = query.clone();
        reply[2] = 0x81;
        reply[3] = 0x80;
        reply[7] = 1;
        assert_eq!(dns_verdict(0xabcd, &reply), Some(Ok("dns 1 answer".to_string())));
        assert_eq!(dns_verdict(0x1111, &reply), None);
        reply[7] = 0;
        assert_eq!(dns_verdict(0xabcd, &reply), Some(Err("dns: no answer".to_string())));
        reply[3] = 0x83;
        assert_eq!(dns_verdict(0xabcd, &reply), Some(Err("dns: NXDOMAIN".to_string())));
        assert_eq!(dns_verdict(0xabcd, &query), None, "a query is not a reply");
        assert_eq!(dns_verdict(0xabcd, &reply[..5]), None);
    }
}
