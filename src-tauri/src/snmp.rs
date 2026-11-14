//! Read-only SNMPv2c: system info and interface load for opted-in nodes.
//!
//! `snmp_start` polls every enabled node every N seconds (default 30) and
//! emits one `snmp-data` event per node. `snmp_stop` ends the loop. The
//! community is read from the keyring by node id (`community.rs`); the
//! renderer never sends it here.
//!
//! Each request waits 1.5 s and is retried once. Interface tables are read
//! with GETBULK (GETNEXT if the agent refuses it) and stop at 64 interfaces.
//! Rates come from 64-bit counters when the agent has them, else 32-bit ones.

pub mod ber;
pub mod community;
pub mod model;
pub mod rate;

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tokio::net::UdpSocket;
use tokio::sync::Semaphore;
use tokio::task::{JoinHandle, JoinSet};

use ber::{PduKind, SnmpValue};
use rate::{CounterWidth, Sample};

const TIMEOUT: Duration = Duration::from_millis(1500);
const RETRIES: usize = 1;
const MAX_INTERFACES: usize = 64;
const BULK_REPETITIONS: u32 = 16;
const MAX_REQUESTS_PER_COLUMN: usize = 16;
const DEFAULT_INTERVAL_SECS: u64 = 30;
const MIN_INTERVAL_SECS: u64 = 10;
const MAX_INTERVAL_SECS: u64 = 3600;
const MAX_NODES: usize = 256;
const MAX_CONCURRENT: usize = 8;
const MAX_TEXT: usize = 256;

const SYS_DESCR: &str = "1.3.6.1.2.1.1.1.0";
const SYS_UPTIME: &str = "1.3.6.1.2.1.1.3.0";
const SYS_NAME: &str = "1.3.6.1.2.1.1.5.0";
const IF_DESCR: &str = "1.3.6.1.2.1.2.2.1.2";
const IF_SPEED: &str = "1.3.6.1.2.1.2.2.1.5";
const IF_OPER_STATUS: &str = "1.3.6.1.2.1.2.2.1.8";
const IF_IN_OCTETS: &str = "1.3.6.1.2.1.2.2.1.10";
const IF_OUT_OCTETS: &str = "1.3.6.1.2.1.2.2.1.16";
const IF_NAME: &str = "1.3.6.1.2.1.31.1.1.1.1";
const IF_HC_IN_OCTETS: &str = "1.3.6.1.2.1.31.1.1.1.6";
const IF_HC_OUT_OCTETS: &str = "1.3.6.1.2.1.31.1.1.1.10";
const IF_HIGH_SPEED: &str = "1.3.6.1.2.1.31.1.1.1.15";

static TASK: StdMutex<Option<JoinHandle<()>>> = StdMutex::new(None);

#[tauri::command]
pub async fn snmp_start(app: AppHandle, config: Value) -> Result<Value, String> {
    let targets = parse_targets(&config);
    let interval = interval_secs(&config);
    let count = targets.len();
    let mut slot = TASK.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(previous) = slot.take() {
        previous.abort();
    }
    if count > 0 {
        *slot = Some(start(app, targets, interval));
    }
    Ok(json!({ "success": true, "nodes": count, "intervalSecs": interval }))
}

#[tauri::command]
pub async fn snmp_stop() -> Result<Value, String> {
    if let Some(task) = TASK
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take()
    {
        task.abort();
    }
    Ok(json!({ "success": true }))
}

#[derive(Clone, Debug)]
struct Target {
    id: String,
    host: String,
    port: u16,
}

fn parse_targets(config: &Value) -> Vec<Target> {
    let mut targets = Vec::new();
    for node in config
        .get("nodes")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        if targets.len() >= MAX_NODES {
            break;
        }
        let id = node.get("id").and_then(Value::as_str).unwrap_or("");
        let address = node.get("address").and_then(Value::as_str).unwrap_or("");
        let Some(host) = crate::hosts::normalize_host(address) else {
            continue;
        };
        if id.is_empty() || id.len() > 128 || !crate::hosts::is_safe_host(&host) {
            continue;
        }
        let port = node
            .get("port")
            .and_then(Value::as_u64)
            .filter(|port| (1..=65535).contains(port))
            .unwrap_or(model::DEFAULT_PORT) as u16;
        if targets.iter().any(|target: &Target| target.id == id) {
            continue;
        }
        targets.push(Target {
            id: id.to_string(),
            host,
            port,
        });
    }
    targets
}

fn interval_secs(config: &Value) -> u64 {
    config
        .get("intervalSecs")
        .and_then(Value::as_u64)
        .map(|secs| secs.clamp(MIN_INTERVAL_SECS, MAX_INTERVAL_SECS))
        .unwrap_or(DEFAULT_INTERVAL_SECS)
}

fn start(app: AppHandle, targets: Vec<Target>, interval: u64) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut communities: HashMap<String, String> = HashMap::new();
        let mut history: HashMap<String, HashMap<u32, Counters>> = HashMap::new();
        let gate = Arc::new(Semaphore::new(MAX_CONCURRENT));
        let mut ticker = tokio::time::interval(Duration::from_secs(interval));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            let mut jobs = JoinSet::new();
            for target in &targets {
                let community = match communities.get(&target.id) {
                    Some(community) => community.clone(),
                    None => match read_community(&target.id).await {
                        Ok(community) => {
                            communities.insert(target.id.clone(), community.clone());
                            community
                        }
                        Err(error) => {
                            emit(&app, failure_payload(&target.id, &error));
                            continue;
                        }
                    },
                };
                let target = target.clone();
                let gate = Arc::clone(&gate);
                jobs.spawn(async move {
                    let _permit = gate.acquire_owned().await;
                    let result = poll(&target, &community).await;
                    (target.id, result)
                });
            }
            while let Some(joined) = jobs.join_next().await {
                let Ok((id, result)) = joined else {
                    continue;
                };
                let payload = match result {
                    Ok(snapshot) => {
                        let previous = history.entry(id.clone()).or_default();
                        let payload = snapshot_payload(&id, &snapshot, previous);
                        *previous = counters_of(&snapshot);
                        payload
                    }
                    Err(error) => failure_payload(&id, &error),
                };
                emit(&app, payload);
            }
        }
    })
}

async fn read_community(id: &str) -> Result<String, String> {
    let id = id.to_string();
    let found = tokio::task::spawn_blocking(move || community::lookup(&id))
        .await
        .map_err(|_| "The system keyring could not be read.".to_string())??;
    found.ok_or_else(|| "No SNMP community is saved for this node. Enter it again.".to_string())
}

fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit("snmp-data", payload);
}

fn failure_payload(id: &str, error: &str) -> Value {
    json!({ "id": id, "ok": false, "error": error, "updated": now_ms() })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Clone, Debug, Default)]
struct Interface {
    index: u32,
    descr: String,
    name: String,
    oper_status: Option<i64>,
    speed_bps: Option<u64>,
    in_octets: Option<u64>,
    out_octets: Option<u64>,
}

#[derive(Debug)]
struct Snapshot {
    sys_name: String,
    sys_descr: String,
    uptime_ticks: Option<u32>,
    width: CounterWidth,
    interfaces: Vec<Interface>,
    truncated: bool,
    at_ms: u64,
}

#[derive(Clone, Copy, Debug)]
struct Counters {
    width: CounterWidth,
    input: Option<Sample>,
    output: Option<Sample>,
}

fn counters_of(snapshot: &Snapshot) -> HashMap<u32, Counters> {
    snapshot
        .interfaces
        .iter()
        .map(|interface| {
            let sample = |octets: Option<u64>| {
                octets.map(|octets| Sample {
                    octets,
                    at_ms: snapshot.at_ms,
                    uptime_ticks: snapshot.uptime_ticks,
                })
            };
            (
                interface.index,
                Counters {
                    width: snapshot.width,
                    input: sample(interface.in_octets),
                    output: sample(interface.out_octets),
                },
            )
        })
        .collect()
}

fn snapshot_payload(id: &str, snapshot: &Snapshot, previous: &HashMap<u32, Counters>) -> Value {
    let interfaces: Vec<Value> = snapshot
        .interfaces
        .iter()
        .map(|interface| {
            let before = previous
                .get(&interface.index)
                .filter(|counters| counters.width == snapshot.width);
            let current = |octets: Option<u64>| {
                octets.map(|octets| Sample {
                    octets,
                    at_ms: snapshot.at_ms,
                    uptime_ticks: snapshot.uptime_ticks,
                })
            };
            let rate_of = |old: Option<Sample>, new: Option<Sample>| match (old, new) {
                (Some(old), Some(new)) => {
                    rate::bits_per_second(&old, &new, snapshot.width, interface.speed_bps)
                        .map(|bps| bps.round() as u64)
                }
                _ => None,
            };
            let in_bps = rate_of(before.and_then(|c| c.input), current(interface.in_octets));
            let out_bps = rate_of(before.and_then(|c| c.output), current(interface.out_octets));
            json!({
                "index": interface.index,
                "descr": interface.descr,
                "name": interface.name,
                "operStatus": oper_status_name(interface.oper_status),
                "speedBps": interface.speed_bps,
                "inBps": in_bps,
                "outBps": out_bps
            })
        })
        .collect();
    json!({
        "id": id,
        "ok": true,
        "updated": snapshot.at_ms,
        "sysName": snapshot.sys_name,
        "sysDescr": snapshot.sys_descr,
        "uptimeSecs": snapshot.uptime_ticks.map(|ticks| ticks / 100),
        "counters": match snapshot.width { CounterWidth::Bits64 => 64, CounterWidth::Bits32 => 32 },
        "truncated": snapshot.truncated,
        "interfaces": interfaces
    })
}

fn oper_status_name(status: Option<i64>) -> &'static str {
    match status {
        Some(1) => "up",
        Some(2) => "down",
        Some(3) => "testing",
        Some(5) => "dormant",
        Some(6) => "notPresent",
        Some(7) => "lowerLayerDown",
        _ => "unknown",
    }
}

async fn poll(target: &Target, community: &str) -> Result<Snapshot, String> {
    let mut session = Session::open(&target.host, target.port, community).await?;
    let system = session
        .request(
            PduKind::Get,
            &[oid(SYS_DESCR), oid(SYS_NAME), oid(SYS_UPTIME)],
        )
        .await?;
    let text = |index: usize| {
        system
            .get(index)
            .and_then(|(_, value)| value.as_text())
            .map(|value| clip(&value))
            .unwrap_or_default()
    };
    let sys_descr = text(0);
    let sys_name = text(1);
    let uptime_ticks = match system.get(2).map(|(_, value)| value) {
        Some(SnmpValue::TimeTicks(ticks)) => Some(*ticks),
        _ => None,
    };

    let (descr, truncated) = session.walk(IF_DESCR).await?;
    let mut rows: BTreeMap<u32, Interface> = descr
        .into_iter()
        .map(|(index, value)| {
            (
                index,
                Interface {
                    index,
                    descr: value.as_text().map(|text| clip(&text)).unwrap_or_default(),
                    ..Interface::default()
                },
            )
        })
        .collect();

    // Optional columns: an agent without IF-MIB extensions just leaves them empty.
    for (index, value) in session.walk_optional(IF_NAME).await {
        if let (Some(row), Some(text)) = (rows.get_mut(&index), value.as_text()) {
            row.name = clip(&text);
        }
    }
    for (index, value) in session.walk_optional(IF_OPER_STATUS).await {
        if let (Some(row), SnmpValue::Integer(status)) = (rows.get_mut(&index), value) {
            row.oper_status = Some(status);
        }
    }
    let high_speed = session.walk_optional(IF_HIGH_SPEED).await;
    let speed = if high_speed.is_empty() {
        session.walk_optional(IF_SPEED).await
    } else {
        BTreeMap::new()
    };
    for row in rows.values_mut() {
        row.speed_bps = rate::link_speed_bps(
            high_speed.get(&row.index).and_then(SnmpValue::as_u64),
            speed.get(&row.index).and_then(SnmpValue::as_u64),
        );
    }

    let mut width = CounterWidth::Bits64;
    let mut input = session.walk_optional(IF_HC_IN_OCTETS).await;
    let mut output = BTreeMap::new();
    if !input.is_empty() {
        output = session.walk_optional(IF_HC_OUT_OCTETS).await;
    }
    if input.is_empty() || output.is_empty() {
        width = CounterWidth::Bits32;
        input = session.walk_optional(IF_IN_OCTETS).await;
        output = session.walk_optional(IF_OUT_OCTETS).await;
    }
    for row in rows.values_mut() {
        row.in_octets = input.get(&row.index).and_then(SnmpValue::as_u64);
        row.out_octets = output.get(&row.index).and_then(SnmpValue::as_u64);
    }

    Ok(Snapshot {
        sys_name,
        sys_descr,
        uptime_ticks,
        width,
        interfaces: rows.into_values().collect(),
        truncated,
        at_ms: now_ms(),
    })
}

fn clip(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .filter(|character| !character.is_control() || *character == ' ')
        .take(MAX_TEXT)
        .collect();
    cleaned.trim().to_string()
}

fn oid(text: &str) -> Vec<u32> {
    ber::parse_oid(text).unwrap_or_default()
}

struct Session {
    socket: UdpSocket,
    community: Vec<u8>,
    next_id: i32,
    bulk: bool,
}

impl Session {
    async fn open(host: &str, port: u16, community: &str) -> Result<Self, String> {
        let target = tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| format!("Cannot resolve {host}"))?
            .next()
            .ok_or_else(|| format!("Cannot resolve {host}"))?;
        let local: SocketAddr = if target.is_ipv4() {
            SocketAddr::from(([0, 0, 0, 0], 0))
        } else {
            SocketAddr::from(([0u16; 8], 0))
        };
        let socket = UdpSocket::bind(local)
            .await
            .map_err(|error| format!("Cannot open a UDP socket: {error}"))?;
        socket
            .connect(target)
            .await
            .map_err(|error| format!("Cannot reach {host}: {error}"))?;
        let seed = (now_ms() as i32 & 0x3FFF_FFFF).max(1);
        Ok(Self {
            socket,
            community: community.as_bytes().to_vec(),
            next_id: seed,
            bulk: true,
        })
    }

    async fn request(
        &mut self,
        kind: PduKind,
        oids: &[Vec<u32>],
    ) -> Result<Vec<(Vec<u32>, SnmpValue)>, String> {
        let mut buffer = vec![0u8; 65_535];
        for _ in 0..=RETRIES {
            self.next_id = if self.next_id >= 0x7FFF_FFFF { 1 } else { self.next_id + 1 };
            let request_id = self.next_id;
            let packet = ber::encode_request(&self.community, request_id, kind, oids)?;
            self.socket
                .send(&packet)
                .await
                .map_err(|error| format!("SNMP send failed: {error}"))?;
            let deadline = Instant::now() + TIMEOUT;
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                let received =
                    match tokio::time::timeout(remaining, self.socket.recv(&mut buffer)).await {
                        Err(_) => break,
                        Ok(Err(error)) => {
                            if error.kind() == std::io::ErrorKind::ConnectionRefused {
                                return Err("The SNMP port is closed".to_string());
                            }
                            return Err(format!("SNMP receive failed: {error}"));
                        }
                        Ok(Ok(length)) => length,
                    };
                let Ok(response) = ber::decode_response(&buffer[..received]) else {
                    continue;
                };
                if response.request_id != i64::from(request_id)
                    || response.version != ber::VERSION_2C
                {
                    continue;
                }
                if response.error_status != 0 {
                    return Err(format!(
                        "The agent answered {}",
                        ber::error_name(response.error_status)
                    ));
                }
                return Ok(response.varbinds);
            }
        }
        Err("No SNMP response. Check the address, port and community.".to_string())
    }

    /// One table column, index -> value. Single-index tables only (ifTable).
    async fn walk(&mut self, column: &str) -> Result<(BTreeMap<u32, SnmpValue>, bool), String> {
        let prefix = oid(column);
        let mut rows = BTreeMap::new();
        let mut cursor = prefix.clone();
        for _ in 0..MAX_REQUESTS_PER_COLUMN {
            let kind = if self.bulk {
                PduKind::GetBulk {
                    non_repeaters: 0,
                    max_repetitions: BULK_REPETITIONS,
                }
            } else {
                PduKind::GetNext
            };
            let varbinds = match self.request(kind, &[cursor.clone()]).await {
                Ok(varbinds) => varbinds,
                Err(error) if self.bulk && error.starts_with("The agent answered") => {
                    self.bulk = false;
                    continue;
                }
                Err(error) => return Err(error),
            };
            if varbinds.is_empty() {
                return Ok((rows, false));
            }
            for (name, value) in varbinds {
                if !name.starts_with(&prefix) || value.is_exception() || name <= cursor {
                    return Ok((rows, false));
                }
                cursor = name.clone();
                if name.len() == prefix.len() + 1 {
                    if rows.len() >= MAX_INTERFACES {
                        return Ok((rows, true));
                    }
                    rows.insert(name[prefix.len()], value);
                }
            }
        }
        let full = rows.len() >= MAX_INTERFACES;
        Ok((rows, full))
    }

    async fn walk_optional(&mut self, column: &str) -> BTreeMap<u32, SnmpValue> {
        self.walk(column)
            .await
            .map(|(rows, _)| rows)
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_skip_bad_hosts_and_default_the_port() {
        let targets = parse_targets(&json!({
            "nodes": [
                { "id": "a", "address": "10.0.0.1" },
                { "id": "b", "address": "10.0.0.2", "port": 1161 },
                { "id": "c", "address": "bad host; rm" },
                { "id": "", "address": "10.0.0.3" },
                { "id": "a", "address": "10.0.0.4" }
            ]
        }));
        let summary: Vec<_> = targets.iter().map(|t| (t.id.as_str(), t.port)).collect();
        assert_eq!(summary, vec![("a", 161), ("b", 1161)]);
    }

    #[test]
    fn the_interval_is_clamped() {
        assert_eq!(interval_secs(&json!({})), 30);
        assert_eq!(interval_secs(&json!({ "intervalSecs": 1 })), 10);
        assert_eq!(interval_secs(&json!({ "intervalSecs": 99999 })), 3600);
    }
}
