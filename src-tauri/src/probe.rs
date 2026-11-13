//! Probe queue, confirmed state, and the status history.
//!
//! A host is an argument to `ping`, or the address of a TCP connect. It is
//! never interpolated into a shell. An address that fails the host check is
//! ignored: it is not a `down` result.
//!
//! Keep the confirmation rule aligned with `renderer/js/probe.js`.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::{Map, Value, json};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::hosts::{confirmation_count, is_safe_host, is_safe_port};

pub const PROBE_LIMIT: usize = 20;
pub const HISTORY_LIMIT: usize = 50;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeState {
    Unknown,
    Up,
    Down,
}

impl ProbeState {
    pub fn as_str(self) -> &'static str {
        match self {
            ProbeState::Unknown => "unknown",
            ProbeState::Up => "up",
            ProbeState::Down => "down",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Confirmation {
    pub state: ProbeState,
    pub pending: Option<ProbeState>,
    pub streak: u8,
}

impl Default for Confirmation {
    fn default() -> Self {
        Self::new()
    }
}

impl Confirmation {
    pub fn new() -> Self {
        Self {
            state: ProbeState::Unknown,
            pending: None,
            streak: 0,
        }
    }

    pub fn observe(&mut self, sample: ProbeState, required: u8) {
        if sample == ProbeState::Unknown {
            return;
        }
        let required = confirmation_count(Some(f64::from(required))).min(255) as u8;
        if self.pending == Some(sample) {
            self.streak = self.streak.saturating_add(1);
        } else {
            self.pending = Some(sample);
            self.streak = 1;
        }
        if self.streak >= required {
            self.state = sample;
        }
    }
}

pub enum ProbePlan {
    Ping(String),
    Tcp { host: String, port: u16 },
}

pub fn plan_probe(node: &Map<String, Value>) -> Option<ProbePlan> {
    let address = node.get("address").and_then(Value::as_str).unwrap_or("");
    if !is_safe_host(address) {
        return None;
    }
    match node.get("port") {
        None | Some(Value::Null) => Some(ProbePlan::Ping(address.to_string())),
        Some(Value::String(text)) if text.is_empty() => Some(ProbePlan::Ping(address.to_string())),
        Some(port) => {
            let port = parse_port(port)?;
            Some(ProbePlan::Tcp {
                host: address.to_string(),
                port,
            })
        }
    }
}

pub fn push_sample(entries: &mut Vec<Value>, at: &str, status: ProbeState, response_time: u64) {
    if status == ProbeState::Unknown {
        return;
    }
    entries.push(json!({
        "at": at,
        "status": status.as_str(),
        "responseTime": response_time,
    }));
    if entries.len() > HISTORY_LIMIT {
        let overflow = entries.len() - HISTORY_LIMIT;
        entries.drain(0..overflow);
    }
}

pub fn clean_history(value: &Value) -> Map<String, Value> {
    let mut nodes = Map::new();
    let Some(source) = value.get("nodes").and_then(Value::as_object) else {
        return nodes;
    };
    for (id, entries) in source {
        if id.is_empty() {
            continue;
        }
        let Some(list) = entries.as_array() else {
            continue;
        };
        let mut cleaned: Vec<Value> = list.iter().filter_map(clean_sample).collect();
        if cleaned.len() > HISTORY_LIMIT {
            let overflow = cleaned.len() - HISTORY_LIMIT;
            cleaned.drain(0..overflow);
        }
        if !cleaned.is_empty() {
            nodes.insert(id.clone(), Value::Array(cleaned));
        }
    }
    nodes
}

pub fn public_node(
    id: &str,
    state: ProbeState,
    response_time: Option<u64>,
    history: &[Value],
) -> Value {
    json!({
        "id": id,
        "status": state.as_str(),
        "responseTime": response_time,
        "history": history,
    })
}

pub async fn map_bounded<T, R, F>(items: Vec<T>, limit: usize, task: F) -> Vec<R>
where
    T: Send + 'static,
    R: Send + 'static,
    F: Fn(T) -> Pin<Box<dyn Future<Output = R> + Send>> + Send + Sync + 'static,
{
    if items.is_empty() {
        return Vec::new();
    }
    let task = Arc::new(task);
    let semaphore = Arc::new(Semaphore::new(limit.max(1)));
    let mut join = JoinSet::new();
    for (index, item) in items.into_iter().enumerate() {
        let task = Arc::clone(&task);
        let semaphore = Arc::clone(&semaphore);
        join.spawn(async move {
            let permit = semaphore.acquire_owned().await;
            let value = task(item).await;
            drop(permit);
            (index, value)
        });
    }
    let mut combined = Vec::new();
    while let Some(joined) = join.join_next().await {
        if let Ok(pair) = joined {
            combined.push(pair);
        }
    }
    combined.sort_by_key(|(index, _)| *index);
    combined.into_iter().map(|(_, value)| value).collect()
}

fn parse_port(value: &Value) -> Option<u16> {
    let port = match value {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => text.parse::<f64>().ok()?,
        _ => return None,
    };
    if !port.is_finite() || port.fract() != 0.0 || !is_safe_port(port as i64) {
        return None;
    }
    u16::try_from(port as i64).ok()
}

fn clean_sample(value: &Value) -> Option<Value> {
    let status = value.get("status").and_then(Value::as_str)?;
    if status != "up" && status != "down" {
        return None;
    }
    let at = value.get("at").and_then(Value::as_str)?;
    if at.is_empty() || at.len() > 40 || at.chars().any(|ch| ch.is_control()) {
        return None;
    }
    let response_time = match value.get("responseTime") {
        Some(Value::Number(number)) => number.as_u64().or_else(|| {
            number
                .as_f64()
                .filter(|value| value.is_finite() && *value >= 0.0)
                .map(|value| value as u64)
        }),
        _ => None,
    };
    Some(json!({
        "at": at,
        "status": status,
        "responseTime": response_time,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn stays_unknown_until_two_results_agree() {
        let mut state = Confirmation::new();
        state.observe(ProbeState::Up, 2);
        assert_eq!(state.state, ProbeState::Unknown);
        state.observe(ProbeState::Down, 2);
        assert_eq!(state.state, ProbeState::Unknown);
        state.observe(ProbeState::Down, 2);
        assert_eq!(state.state, ProbeState::Down);
    }

    #[test]
    fn one_failure_does_not_flip_a_confirmed_state() {
        let mut state = Confirmation::new();
        state.observe(ProbeState::Up, 2);
        state.observe(ProbeState::Up, 2);
        assert_eq!(state.state, ProbeState::Up);
        state.observe(ProbeState::Down, 1);
        assert_eq!(state.state, ProbeState::Up);
        state.observe(ProbeState::Down, 2);
        assert_eq!(state.state, ProbeState::Down);
    }

    #[test]
    fn an_ignored_sample_does_not_advance_the_streak() {
        let mut state = Confirmation::new();
        state.observe(ProbeState::Up, 2);
        state.observe(ProbeState::Unknown, 2);
        assert_eq!(state.streak, 1);
        assert_eq!(state.state, ProbeState::Unknown);
        state.observe(ProbeState::Up, 2);
        assert_eq!(state.state, ProbeState::Up);
    }

    #[test]
    fn unsafe_hosts_are_not_probes() {
        assert!(plan_probe(&node("192.168.1.1;id", None)).is_none());
        assert!(plan_probe(&node("$(reboot)", None)).is_none());
        assert!(plan_probe(&node("8.8.8.8 && whoami", None)).is_none());
        assert!(plan_probe(&node("", None)).is_none());
        assert!(plan_probe(&node("192.168.001.1", None)).is_none());
        assert!(matches!(
            plan_probe(&node("192.168.1.1", None)),
            Some(ProbePlan::Ping(_))
        ));
        assert!(matches!(
            plan_probe(&node("gateway.local", Some(json!(22)))),
            Some(ProbePlan::Tcp { port: 22, .. })
        ));
        assert!(plan_probe(&node("192.168.1.1", Some(json!(0)))).is_none());
        assert!(plan_probe(&node("192.168.1.1", Some(json!(70000)))).is_none());
        assert!(matches!(
            plan_probe(&node("10.0.0.1", Some(Value::Null))),
            Some(ProbePlan::Ping(_))
        ));
    }

    #[test]
    fn history_keeps_state_and_drops_secrets() {
        let mut entries = Vec::new();
        push_sample(&mut entries, "2026-11-13T18:00:00Z", ProbeState::Unknown, 4);
        assert!(entries.is_empty());
        push_sample(&mut entries, "2026-11-13T18:00:00Z", ProbeState::Up, 4);
        push_sample(&mut entries, "2026-11-13T18:00:05Z", ProbeState::Down, 9);
        for index in 0..HISTORY_LIMIT {
            push_sample(
                &mut entries,
                "2026-11-13T18:00:10Z",
                ProbeState::Up,
                index as u64,
            );
        }
        assert_eq!(entries.len(), HISTORY_LIMIT);
        assert_eq!(entries[0]["responseTime"], 0);
        assert_eq!(
            entries[HISTORY_LIMIT - 1]["responseTime"],
            (HISTORY_LIMIT - 1) as u64
        );

        let raw = json!({
            "nodes": {
                "pc": [
                    { "at": "2026-11-13T18:00:00Z", "status": "up", "responseTime": 4, "sshPass": "s3cret" },
                    { "at": "bad\nline", "status": "down", "responseTime": 1 },
                    { "status": "up" }
                ]
            },
            "sshPass": "s3cret"
        });
        let cleaned = clean_history(&raw);
        let text = Value::Object(cleaned.clone()).to_string();
        assert!(!text.contains("sshPass"));
        assert!(!text.contains("s3cret"));
        assert_eq!(cleaned["pc"].as_array().unwrap().len(), 1);
        assert_eq!(cleaned["pc"][0]["status"], "up");
        assert_eq!(cleaned["pc"][0]["responseTime"], 4);

        let event = public_node(
            "pc",
            ProbeState::Up,
            Some(4),
            cleaned["pc"].as_array().unwrap(),
        );
        assert_eq!(event["status"], "up");
        assert!(event.get("sshPass").is_none());
        assert!(event.get("address").is_none());
    }

    #[tokio::test]
    async fn the_queue_never_runs_more_than_twenty_probes() {
        let current = Arc::new(AtomicUsize::new(0));
        let highest = Arc::new(AtomicUsize::new(0));
        let current_task = Arc::clone(&current);
        let highest_task = Arc::clone(&highest);
        let results = map_bounded((0..40).collect::<Vec<_>>(), PROBE_LIMIT, move |index| {
            let current_task = Arc::clone(&current_task);
            let highest_task = Arc::clone(&highest_task);
            Box::pin(async move {
                let now = current_task.fetch_add(1, Ordering::SeqCst) + 1;
                highest_task.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(40)).await;
                current_task.fetch_sub(1, Ordering::SeqCst);
                index
            })
        })
        .await;
        assert_eq!(results, (0..40).collect::<Vec<_>>());
        let peak = highest.load(Ordering::SeqCst);
        assert!(peak > 1, "probes ran together");
        assert!(peak <= PROBE_LIMIT, "peak {peak} exceeded {PROBE_LIMIT}");
    }

    fn node(address: &str, port: Option<Value>) -> Map<String, Value> {
        let mut object = Map::new();
        object.insert("address".to_string(), json!(address));
        if let Some(port) = port {
            object.insert("port".to_string(), port);
        }
        object
    }
}
