//! One interactive shell per node.
//!
//! Host keys are accepted without pinning. The previous client did the same.
//! Checking the key against a known-hosts file is a later change.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{Handle, Handler, Msg};
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf, Disconnect};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};

use crate::hosts::{is_reasonable_username, is_safe_host, is_safe_port};

const MAX_WRITE_BYTES: usize = 1024 * 1024;
const MAX_KEY_BYTES: u64 = 1024 * 1024;

type ShellWriter = ChannelWriteHalf<Msg>;

enum SessionCmd {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

struct LiveSession {
    tx: UnboundedSender<SessionCmd>,
    generation: u64,
}

pub struct Hub {
    sessions: HashMap<String, LiveSession>,
    next_generation: u64,
}

impl Hub {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            next_generation: 1,
        }
    }
}

struct AcceptHostKey;

impl Handler for AcceptHostKey {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

pub async fn connect(app: AppHandle, hub: Arc<Mutex<Hub>>, request: Value) -> Value {
    let Some(request) = request.as_object() else {
        return failure("Invalid SSH host, port, or username");
    };
    let node_id = match request.get("nodeId").and_then(Value::as_str) {
        Some(node_id) if !node_id.is_empty() && node_id.len() <= 128 => node_id.to_string(),
        _ => return failure("Invalid node id"),
    };
    let host = request.get("host").and_then(Value::as_str).unwrap_or("");
    let port = request.get("port").and_then(Value::as_u64).unwrap_or(22);
    let username = request
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !is_safe_host(host)
        || port > u64::from(u16::MAX)
        || !is_safe_port(port as i64)
        || !is_reasonable_username(username)
    {
        return failure("Invalid SSH host, port, or username");
    }
    let password = request
        .get("password")
        .and_then(Value::as_str)
        .map(str::to_string);
    let passphrase = request
        .get("passphrase")
        .and_then(Value::as_str)
        .map(str::to_string);
    let key_path = request
        .get("privateKeyPath")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .map(str::to_string);

    let opened = open_shell(
        host.to_string(),
        port as u16,
        username.to_string(),
        password,
        key_path,
        passphrase,
    );
    let (session, mut reader, writer) =
        match tokio::time::timeout(Duration::from_secs(10), opened).await {
            Ok(Ok(shell)) => shell,
            Ok(Err(error)) => return failure(&error),
            Err(_) => return failure("Connection timed out"),
        };

    let (tx, mut rx) = unbounded_channel();
    let generation = {
        let mut guard = hub.lock().await;
        if let Some(previous) = guard.sessions.remove(&node_id) {
            let _ = previous.tx.send(SessionCmd::Close);
        }
        let generation = guard.next_generation;
        guard.next_generation = guard.next_generation.wrapping_add(1);
        guard
            .sessions
            .insert(node_id.clone(), LiveSession { tx, generation });
        generation
    };

    let node_for_task = node_id.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                message = reader.wait() => {
                    match message {
                        Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                            let text = String::from_utf8_lossy(&data).into_owned();
                            let _ = app.emit("ssh-data", json!({ "nodeId": &node_for_task, "data": text }));
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                }
                command = rx.recv() => {
                    match command {
                        Some(SessionCmd::Data(bytes)) => {
                            if writer.data_bytes(bytes).await.is_err() {
                                break;
                            }
                        }
                        Some(SessionCmd::Resize { cols, rows }) => {
                            let _ = writer.window_change(cols, rows, 0, 0).await;
                        }
                        Some(SessionCmd::Close) | None => break,
                    }
                }
            }
        }
        let _ = writer.close().await;
        let _ = session.disconnect(Disconnect::ByApplication, "", "").await;
        let mut guard = hub.lock().await;
        if guard
            .sessions
            .get(&node_for_task)
            .is_some_and(|live| live.generation == generation)
        {
            guard.sessions.remove(&node_for_task);
            drop(guard);
            let _ = app.emit("ssh-closed", json!({ "nodeId": node_for_task }));
        }
    });

    json!({ "success": true })
}

pub async fn write(hub: &Mutex<Hub>, node_id: &str, data: &str) -> Value {
    if data.len() > MAX_WRITE_BYTES {
        return failure("Write is too large");
    }
    send(hub, node_id, SessionCmd::Data(data.as_bytes().to_vec())).await
}

pub async fn resize(hub: &Mutex<Hub>, node_id: &str, cols: u32, rows: u32) -> Value {
    if !(1..=500).contains(&cols) || !(1..=500).contains(&rows) {
        return failure("Invalid terminal size");
    }
    send(hub, node_id, SessionCmd::Resize { cols, rows }).await
}

pub async fn disconnect(hub: &Mutex<Hub>, node_id: &str) -> Value {
    let mut guard = hub.lock().await;
    let Some(live) = guard.sessions.remove(node_id) else {
        return failure("Connection not found");
    };
    let _ = live.tx.send(SessionCmd::Close);
    json!({ "success": true })
}

async fn send(hub: &Mutex<Hub>, node_id: &str, command: SessionCmd) -> Value {
    let guard = hub.lock().await;
    let Some(live) = guard.sessions.get(node_id) else {
        return failure("Connection not found");
    };
    if live.tx.send(command).is_err() {
        return failure("Connection not found");
    }
    json!({ "success": true })
}

async fn open_shell(
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    key_path: Option<String>,
    passphrase: Option<String>,
) -> Result<(Handle<AcceptHostKey>, ChannelReadHalf, ShellWriter), String> {
    let mut config = russh::client::Config::default();
    config.keepalive_interval = Some(Duration::from_secs(10));
    config.keepalive_max = 3;
    config.nodelay = true;
    let mut session =
        russh::client::connect(Arc::new(config), (host.as_str(), port), AcceptHostKey)
            .await
            .map_err(|error| error.to_string())?;

    let authenticated = if let Some(path) = key_path {
        let key = load_private_key(&path, passphrase.as_deref())?;
        let hash_alg = if key.algorithm().is_rsa() {
            session
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten()
        } else {
            None
        };
        session
            .authenticate_publickey(
                username,
                PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
            )
            .await
            .map_err(|error| error.to_string())?
    } else if let Some(password) = password.filter(|password| !password.is_empty()) {
        session
            .authenticate_password(username, password)
            .await
            .map_err(|error| error.to_string())?
    } else {
        return Err("Missing credentials".to_string());
    };
    if !authenticated.success() {
        return Err("Authentication failed".to_string());
    }

    let channel = session
        .channel_open_session()
        .await
        .map_err(|error| error.to_string())?;
    let modes: &[(russh::Pty, u32)] = &[];
    channel
        .request_pty(false, "xterm-256color", 80, 24, 0, 0, modes)
        .await
        .map_err(|error| error.to_string())?;
    channel
        .request_shell(true)
        .await
        .map_err(|error| error.to_string())?;
    let (reader, writer) = channel.split();
    Ok((session, reader, writer))
}

fn load_private_key(path: &str, passphrase: Option<&str>) -> Result<PrivateKey, String> {
    if path.contains('\0') {
        return Err("Invalid private key path".to_string());
    }
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("Failed to read private key: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_KEY_BYTES {
        return Err("Failed to read private key: file is missing or larger than 1 MB".to_string());
    }
    let bytes =
        std::fs::read(path).map_err(|error| format!("Failed to read private key: {error}"))?;
    let text = String::from_utf8(bytes).map_err(|_| "Failed to read private key".to_string())?;
    if text.starts_with("PuTTY-User-Key-File-") {
        return PrivateKey::from_ppk(&text, passphrase.map(str::to_string))
            .map_err(|_| "Failed to read private key".to_string());
    }
    let key = PrivateKey::from_openssh(text.as_bytes())
        .map_err(|_| "Failed to read private key".to_string())?;
    if !key.is_encrypted() {
        return Ok(key);
    }
    let Some(passphrase) = passphrase.filter(|passphrase| !passphrase.is_empty()) else {
        return Err("Passphrase required".to_string());
    };
    key.decrypt(passphrase.as_bytes())
        .map_err(|_| "Failed to decrypt private key".to_string())
}

fn failure(error: &str) -> Value {
    json!({ "success": false, "error": error })
}
