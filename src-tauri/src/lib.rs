mod config;
mod hosts;
mod monitor;
mod network;
mod ssh;

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

struct AppState {
    ssh: Arc<Mutex<ssh::Hub>>,
    monitor: Mutex<Option<JoinHandle<()>>>,
}

#[tauri::command]
fn config_load(app: tauri::AppHandle) -> Value {
    config::load(&app)
}

#[tauri::command]
fn config_save(app: tauri::AppHandle, config: Value) -> Value {
    config::save(&app, config)
}

#[tauri::command]
fn config_export(app: tauri::AppHandle, config: Value) -> Value {
    config::export(&app, config)
}

#[tauri::command]
fn config_import(app: tauri::AppHandle) -> Value {
    config::import(&app)
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
            ssh_browse_key,
            ssh_connect,
            ssh_write,
            ssh_resize,
            ssh_disconnect,
            network_local_info,
            network_ping,
            network_scan,
            network_arp,
            monitor_start,
            monitor_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
