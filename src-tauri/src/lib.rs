mod config;
mod hosts;
mod known_hosts;
mod known_hosts_admin;
mod monitor;
mod probe;
mod network;
mod secrets;
mod ssh;
mod topology;

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::Value;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

struct PendingImport {
    token: String,
    secrets: HashMap<String, secrets::SecretValue>,
}

struct AppState {
    ssh: Arc<Mutex<ssh::Hub>>,
    monitor: Mutex<Option<JoinHandle<()>>>,
    pending_import: StdMutex<Option<PendingImport>>,
}

#[tauri::command]
fn config_load(app: tauri::AppHandle) -> Value {
    config::load(&app)
}

#[tauri::command]
fn config_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: Value,
    import_token: Option<String>,
) -> Value {
    let pending = take_matching_import(&state, import_token.as_deref()).unwrap_or_default();
    let result = config::save(&app, config, &pending);
    if result.get("success").and_then(Value::as_bool) == Some(true) {
        let mut guard = pending_import(&state);
        if guard
            .as_ref()
            .is_some_and(|pending| Some(pending.token.as_str()) == import_token.as_deref())
        {
            *guard = None;
        }
    }
    result
}

fn pending_import<'a>(
    state: &'a tauri::State<'_, AppState>,
) -> std::sync::MutexGuard<'a, Option<PendingImport>> {
    state
        .pending_import
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

fn take_matching_import(
    state: &tauri::State<'_, AppState>,
    import_token: Option<&str>,
) -> Option<HashMap<String, secrets::SecretValue>> {
    let mut guard = pending_import(state);
    match guard.as_ref() {
        Some(pending) if import_token == Some(pending.token.as_str()) => {
            Some(pending.secrets.clone())
        }
        Some(_) => {
            *guard = None;
            None
        }
        None => None,
    }
}

#[tauri::command]
fn config_export(app: tauri::AppHandle, config: Value) -> Value {
    config::export(&app, config)
}

#[tauri::command]
fn config_import(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Value {
    let imported = config::import(&app);
    let mut guard = pending_import(&state);
    *guard = match (imported.token, imported.secrets.is_empty()) {
        (Some(token), false) => Some(PendingImport {
            token,
            secrets: imported.secrets,
        }),
        _ => None,
    };
    imported.response
}

#[tauri::command]
fn config_discard_import(state: tauri::State<'_, AppState>) -> Value {
    *pending_import(&state) = None;
    serde_json::json!({ "success": true })
}

#[tauri::command]
fn ssh_browse_key(app: tauri::AppHandle) -> Value {
    config::browse_key(&app)
}

#[tauri::command]
async fn ssh_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    connection_info: Value,
) -> Result<Value, String> {
    Ok(ssh::connect(app, Arc::clone(&state.ssh), connection_info).await)
}

#[tauri::command]
async fn ssh_write(
    state: tauri::State<'_, AppState>,
    node_id: String,
    data: String,
) -> Result<Value, String> {
    Ok(ssh::write(&state.ssh, &node_id, &data).await)
}

#[tauri::command]
async fn ssh_resize(
    state: tauri::State<'_, AppState>,
    node_id: String,
    cols: u32,
    rows: u32,
) -> Result<Value, String> {
    Ok(ssh::resize(&state.ssh, &node_id, cols, rows).await)
}

#[tauri::command]
async fn ssh_disconnect(
    state: tauri::State<'_, AppState>,
    node_id: String,
) -> Result<Value, String> {
    Ok(ssh::disconnect(&state.ssh, &node_id).await)
}

#[tauri::command]
fn ssh_forget_host_key(app: tauri::AppHandle, host: String, port: u64) -> Value {
    ssh::forget_host_key(&app, &host, port)
}

#[tauri::command]
fn ssh_known_hosts_list(app: tauri::AppHandle) -> Value {
    known_hosts_admin::list(&app)
}

#[tauri::command]
fn ssh_known_hosts_import_openssh(app: tauri::AppHandle) -> Value {
    known_hosts_admin::import_openssh(&app)
}

#[tauri::command]
fn network_local_info() -> Value {
    Value::Array(network::local_interfaces())
}

#[tauri::command]
async fn network_ping(host: String) -> Value {
    network::ping_command(&host).await
}

#[tauri::command]
async fn network_scan(
    app: tauri::AppHandle,
    base_ip: String,
    start_range: i64,
    end_range: i64,
) -> Result<Vec<Value>, String> {
    network::scan(&app, &base_ip, start_range, end_range).await
}

#[tauri::command]
async fn network_arp() -> Value {
    Value::Array(network::arp_table().await)
}

#[tauri::command]
async fn network_neighbors() -> Value {
    Value::Array(network::ipv6_neighbors().await)
}

#[tauri::command]
async fn monitor_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    config: Value,
) -> Result<Value, String> {
    let mut slot = state.monitor.lock().await;
    if let Some(previous) = slot.take() {
        previous.abort();
    }
    *slot = Some(monitor::start(app, config));
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
async fn monitor_stop(state: tauri::State<'_, AppState>) -> Result<Value, String> {
    if let Some(task) = state.monitor.lock().await.take() {
        task.abort();
    }
    Ok(serde_json::json!({ "success": true }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            ssh: Arc::new(Mutex::new(ssh::Hub::new())),
            monitor: Mutex::new(None),
            pending_import: StdMutex::new(None),
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config_load,
            config_save,
            config_export,
            config_import,
            config_discard_import,
            ssh_browse_key,
            ssh_connect,
            ssh_write,
            ssh_resize,
            ssh_disconnect,
            ssh_forget_host_key,
            ssh_known_hosts_list,
            ssh_known_hosts_import_openssh,
            network_local_info,
            network_ping,
            network_scan,
            network_arp,
            network_neighbors,
            monitor_start,
            monitor_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
