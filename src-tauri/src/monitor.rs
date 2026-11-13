//! Periodic ping, or a TCP connect when the node has a port.
//!
//! Status events omit `sshPass`. The canvas copies the password back from the
//! configuration it already holds.

use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use tauri::{AppHandle, Emitter};
use tokio::task::JoinHandle;

use crate::hosts::{is_safe_port, monitoring_interval};
use crate::network::{check_port, ping_host};

enum Probe {
    Ping(String),
    Tcp(u16),
    Offline,
}

pub fn start(app: AppHandle, config: Value) -> JoinHandle<()> {
    let interval = monitoring_interval(config.get("interval").and_then(Value::as_f64));
    let nodes = match config.get("nodes") {
        Some(Value::Array(nodes)) => nodes.clone(),
        _ => Vec::new(),
    };
    tokio::spawn(async move {
        loop {
            let payload = probe_all(&nodes).await;
            if app.emit("monitor-status", payload).is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(interval)).await;
        }
    })
}

async fn probe_all(nodes: &[Value]) -> Value {
    let mut tasks = tokio::task::JoinSet::new();
    for (index, node) in nodes.iter().cloned().enumerate() {
        tasks.spawn(async move { (index, probe_node(node).await) });
    }
    let mut ordered = vec![Value::Null; nodes.len()];
    while let Some(joined) = tasks.join_next().await {
        if let Ok((index, node)) = joined {
            ordered[index] = node;
        }
    }
    json!({
        "nodes": ordered,
        "updated": chrono::Local::now().format("%H:%M:%S").to_string(),
    })
}

async fn probe_node(node: Value) -> Value {
    let start = Instant::now();
    let Some(object) = node.as_object() else {
        return node;
    };
    let online = match classify(object) {
        Probe::Tcp(port) => {
            let host = object.get("address").and_then(Value::as_str).unwrap_or("");
            check_port(host, port, Duration::from_millis(1000)).await
        }
        Probe::Ping(host) => ping_host(&host, Duration::from_millis(2000)).await.online,
        Probe::Offline => false,
    };
    let mut public = object.clone();
    public.remove("sshPass");
    public.insert("status".to_string(), Value::Bool(online));
    public.insert(
        "responseTime".to_string(),
        json!(start.elapsed().as_millis() as u64),
    );
    Value::Object(public)
}

fn classify(node: &Map<String, Value>) -> Probe {
    match node.get("port") {
        Some(Value::Number(number)) if json_number_is_truthy(number) => {
            match integer_port(number) {
                Some(port) => Probe::Tcp(port),
                None => Probe::Offline,
            }
        }
        Some(Value::String(text)) if !text.is_empty() => match text.parse::<i64>() {
            Ok(port) if is_safe_port(port) => Probe::Tcp(port as u16),
            _ => Probe::Offline,
        },
        Some(Value::Bool(true)) => Probe::Offline,
        _ => match node.get("address").and_then(Value::as_str) {
            Some(address) if !address.is_empty() => Probe::Ping(address.to_string()),
            _ => Probe::Offline,
        },
    }
}

fn json_number_is_truthy(number: &serde_json::Number) -> bool {
    number.as_f64().is_some_and(|value| value != 0.0)
}

fn integer_port(number: &serde_json::Number) -> Option<u16> {
    let value = number.as_f64()?;
    if value.fract() != 0.0 || !is_safe_port(value as i64) {
        return None;
    }
    u16::try_from(value as i64).ok()
}
