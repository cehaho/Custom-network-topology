//! Periodic ping, or a TCP connect when the node names a port.
//!
//! At most twenty probes run at once. The next cycle starts only after this
//! one finishes, so a slow pass does not overlap the next. Status becomes
//! `up` or `down` after two agreeing results. The event sent to the canvas is
//! the id, the confirmed state, the delay, and the short history. It does not
//! include the node, and it does not include `sshPass`.
//!
//! The address is an argument of `ping`, or the target of a TCP connect. It is
//! never placed in a shell command. An address that is not a host is skipped.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;

use crate::config::{read_status, write_status};
use crate::hosts::{confirmation_count, monitoring_interval};
use crate::network::{check_port, ping_host};
use crate::probe::{
    Confirmation, PROBE_LIMIT, ProbePlan, ProbeState, clean_history, map_bounded, plan_probe,
    public_node, push_sample,
};

struct Measured {
    id: String,
    online: Option<bool>,
    response_time: Option<u64>,
    /// Round-trip time of this probe in ms; `None` when it failed.
    rtt: Option<f64>,
    detail: Option<String>,
}

pub fn start(app: AppHandle, config: Value) -> JoinHandle<()> {
    let interval = monitoring_interval(configured_interval(&config));
    let confirmations = confirmation_count(configured_confirmations(&config)).min(255) as u8;
    let nodes = match config.get("nodes") {
        Some(Value::Array(nodes)) => nodes.clone(),
        _ => Vec::new(),
    };
    tokio::spawn(async move {
        let mut states: HashMap<String, Confirmation> = HashMap::new();
        let mut history = history_map(&read_status(&app));
        loop {
            let started = Instant::now();
            let measured = measure_all(nodes.clone()).await;
            let mut dirty = false;
            let mut seen = HashSet::new();
            let mut public = Vec::new();
            let at = chrono::Utc::now().to_rfc3339();
            for sample in measured {
                if sample.id.is_empty() {
                    continue;
                }
                seen.insert(sample.id.clone());
                let slot = states.entry(sample.id.clone()).or_default();
                if let Some(online) = sample.online {
                    let reading = if online {
                        ProbeState::Up
                    } else {
                        ProbeState::Down
                    };
                    slot.observe(reading, confirmations);
                    if slot.state != ProbeState::Unknown {
                        let entries = history.entry(sample.id.clone()).or_default();
                        push_sample(entries, &at, slot.state, sample.response_time.unwrap_or(0));
                        dirty = true;
                    }
                }
                let entries = history.get(&sample.id).map(Vec::as_slice).unwrap_or(&[]);
                let mut entry = public_node(&sample.id, slot.state, sample.response_time, entries);
                with_latency(&mut entry, sample.online, sample.rtt);
                public.push(entry);
                // Which check failed (or passed), for a node with a `probe`.
                if let (Some(detail), Some(item)) = (
                    &sample.detail,
                    public.last_mut().and_then(Value::as_object_mut),
                ) {
                    item.insert("detail".to_string(), json!(detail));
                }
            }
            let before = history.len();
            history.retain(|id, _| seen.contains(id));
            if history.len() != before {
                dirty = true;
            }
            if dirty && write_status(&app, &status_document(&history)).is_err() {
                log::warn!("status history was not saved");
            }
            let payload = json!({
                "nodes": public,
                "updated": chrono::Local::now().format("%H:%M:%S").to_string(),
            });
            if app.emit("monitor-status", payload).is_err() {
                break;
            }
            let pause = Duration::from_millis(interval).saturating_sub(started.elapsed());
            tokio::time::sleep(pause).await;
        }
    })
}

/// Adds the raw result of this probe to the event: `reachable` (this one
/// sample, before confirmation; `null` when nothing was probed) and `rtt`
/// (round-trip ms with sub-millisecond precision, `null` on failure).
fn with_latency(entry: &mut Value, online: Option<bool>, rtt: Option<f64>) {
    if let Value::Object(object) = entry {
        object.insert("reachable".to_string(), json!(online));
        let rtt = rtt.filter(|ms| ms.is_finite() && *ms >= 0.0);
        object.insert(
            "rtt".to_string(),
            json!(rtt.map(|ms| (ms * 1000.0).round() / 1000.0)),
        );
    }
}

fn configured_interval(config: &Value) -> Option<f64> {
    config.get("interval").and_then(Value::as_f64).or_else(|| {
        config
            .pointer("/settings/probeIntervalMs")
            .and_then(Value::as_f64)
    })
}

fn configured_confirmations(config: &Value) -> Option<f64> {
    config
        .get("confirmations")
        .and_then(Value::as_f64)
        .or_else(|| {
            config
                .pointer("/settings/confirmations")
                .and_then(Value::as_f64)
        })
}

fn status_document(history: &HashMap<String, Vec<Value>>) -> Value {
    let nodes = history
        .iter()
        .map(|(id, entries)| (id.clone(), Value::Array(entries.clone())))
        .collect();
    json!({ "nodes": Value::Object(nodes) })
}

fn history_map(value: &Value) -> HashMap<String, Vec<Value>> {
    clean_history(value)
        .into_iter()
        .filter_map(|(id, entries)| entries.as_array().cloned().map(|entries| (id, entries)))
        .collect()
}

async fn measure_all(nodes: Vec<Value>) -> Vec<Measured> {
    map_bounded(nodes, PROBE_LIMIT, |node| Box::pin(measure_one(node))).await
}

async fn measure_one(node: Value) -> Measured {
    let id = node
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let Some(object) = node.as_object() else {
        return Measured {
            id,
            online: None,
            response_time: None,
            rtt: None,
            detail: None,
        };
    };
    // A `probe` object replaces the default ping / TCP probe.
    match crate::probe_kinds::plan(object) {
        crate::probe_kinds::RichPlan::Default => {}
        crate::probe_kinds::RichPlan::Skip => {
            return Measured {
                id,
                online: None,
                response_time: None,
                rtt: None,
                detail: None,
            };
        }
        crate::probe_kinds::RichPlan::Run(host, checks) => {
            let outcome = crate::probe_kinds::run(&host, &checks).await;
            return Measured {
                id,
                online: Some(outcome.online),
                response_time: Some(outcome.elapsed_ms),
                // Rich checks run in parallel; their wall time stands in for RTT.
                rtt: outcome.online.then_some(outcome.elapsed_ms as f64),
                detail: Some(outcome.detail),
            };
        }
    }
    // `plan_probe` drops an unsafe address. Nothing below builds a command
    // string from it: ping receives argv, TCP receives a socket address.
    let Some(plan) = plan_probe(object) else {
        return Measured {
            id,
            online: None,
            response_time: None,
            rtt: None,
            detail: None,
        };
    };
    match plan {
        ProbePlan::Ping(host) => {
            let result = ping_host(&host, Duration::from_millis(2000)).await;
            // The reply line's time is the round trip; the wall time of the
            // ping process stands in when the output had no time.
            let rtt = result
                .online
                .then(|| result.rtt_ms.unwrap_or(result.duration_ms as f64));
            Measured {
                id,
                online: Some(result.online),
                response_time: Some(rtt.map_or(result.duration_ms, |ms| ms.round() as u64)),
                rtt,
                detail: None,
            }
        }
        ProbePlan::Tcp { host, port } => {
            let started = Instant::now();
            let online = check_port(&host, port, Duration::from_millis(1000)).await;
            let elapsed = started.elapsed();
            Measured {
                id,
                online: Some(online),
                response_time: Some(elapsed.as_millis() as u64),
                rtt: online.then(|| elapsed.as_secs_f64() * 1000.0),
                detail: None,
            }
        }
    }
}
