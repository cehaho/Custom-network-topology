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
                public.push(public_node(
                    &sample.id,
                    slot.state,
                    sample.response_time,
                    entries,
                ));
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
        };
    };
    // `plan_probe` drops an unsafe address. Nothing below builds a command
    // string from it: ping receives argv, TCP receives a socket address.
    let Some(plan) = plan_probe(object) else {
        return Measured {
            id,
            online: None,
            response_time: None,
        };
    };
    match plan {
        ProbePlan::Ping(host) => {
            let result = ping_host(&host, Duration::from_millis(2000)).await;
            Measured {
                id,
                online: Some(result.online),
                response_time: Some(result.duration_ms),
            }
        }
        ProbePlan::Tcp { host, port } => {
            let started = Instant::now();
            let online = check_port(&host, port, Duration::from_millis(1000)).await;
            Measured {
                id,
                online: Some(online),
                response_time: Some(started.elapsed().as_millis() as u64),
            }
        }
    }
}
