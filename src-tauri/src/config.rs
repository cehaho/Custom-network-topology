//! Topology file: the same JSON shape the canvas already saves.
//!
//! Passwords are sealed with AES-256-GCM when the OS keyring can hold the key.
//! Ciphertext is `enc:v1:` plus base64(nonce || ciphertext). If the keyring is
//! unavailable the password stays plain text and `_encrypted` is false.
//!
//! Values written by Electron `safeStorage` use another format. They are left
//! as stored so a later save does not wrap them a second time.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use aes_gcm::aead::{Aead, Generate};
use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};

const MAX_CONFIG_BYTES: usize = 5 * 1024 * 1024;
const PREFIX: &str = "enc:v1:";
const SAMPLE: &str = include_str!("../../renderer/config.json");
const KEYRING_SERVICE: &str = "custom-network-topology";
const KEYRING_USER: &str = "topology-key";

pub fn load(app: &AppHandle) -> Value {
    let Ok(path) = resolve_config_path(app) else {
        return empty_config();
    };
    if !path.is_file() {
        if write_atomic(&path, SAMPLE).is_err() {
            return parse_sample();
        }
    }
    match read_config_file(&path) {
        Ok(mut config) => {
            reveal_passwords(&mut config, encryption_key().as_ref());
            config
        }
        Err(error) => {
            log::warn!("config load failed: {error}");
            empty_config()
        }
    }
}

pub fn save(app: &AppHandle, config: Value) -> Value {
    let path = match resolve_config_path(app) {
        Ok(path) => path,
        Err(error) => return failure(&error),
    };
    match prepare_for_disk(config) {
        Ok(body) => match write_atomic(&path, &body) {
            Ok(()) => json!({ "success": true }),
            Err(error) => failure(&error),
        },
        Err(error) => failure(&error),
    }
}

pub fn export(app: &AppHandle, config: Value) -> Value {
    let body = match normalize(config).and_then(|value| pretty(&value)) {
        Ok(body) => body,
        Err(error) => return failure(&error),
    };
    let picked = app
        .dialog()
        .file()
        .set_title("Export Configuration")
        .set_file_name("topology-config.json")
        .add_filter("JSON Files", &["json"])
        .blocking_save_file();
    let Some(path) = file_path(picked) else {
        return json!({ "success": false, "canceled": true });
    };
    match write_atomic(&path, &body) {
        Ok(()) => json!({ "success": true, "path": path.display().to_string() }),
        Err(error) => failure(&error),
    }
}

pub fn import(app: &AppHandle) -> Value {
    let picked = app
        .dialog()
        .file()
        .set_title("Import Configuration")
        .add_filter("JSON Files", &["json"])
        .blocking_pick_file();
    let Some(path) = file_path(picked) else {
        return json!({ "success": false, "canceled": true });
    };
    match read_config_file(&path) {
        Ok(config) => json!({ "success": true, "config": config }),
        Err(error) => failure(&error),
    }
}

pub fn browse_key(app: &AppHandle) -> Value {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Select SSH Private Key")
        .add_filter("SSH Keys", &["pem", "key", "ppk"])
        .add_filter("All Files", &["*"]);
    if let Some(ssh_dir) = default_ssh_dir() {
        dialog = dialog.set_directory(ssh_dir);
    }
    let Some(path) = file_path(dialog.blocking_pick_file()) else {
        return json!({ "success": false, "canceled": true });
    };
    json!({ "success": true, "path": path.display().to_string() })
}

fn prepare_for_disk(config: Value) -> Result<String, String> {
    let mut normalized = normalize(config)?;
    protect_passwords(&mut normalized, encryption_key().as_ref());
    pretty(&normalized)
}

fn pretty(config: &Value) -> Result<String, String> {
    let body = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    if body.len() > MAX_CONFIG_BYTES {
        return Err("Configuration file is larger than 5 MB".to_string());
    }
    Ok(body)
}

pub fn normalize(value: Value) -> Result<Value, String> {
    if let Value::Array(nodes) = value {
        let mut config = empty_config();
        config["nodes"] = Value::Array(nodes);
        return Ok(config);
    }
    let Value::Object(map) = value else {
        return Err("Configuration must be a JSON object or an array of nodes".to_string());
    };
    let settings = match map.get("settings") {
        Some(Value::Object(_)) => map.get("settings").cloned().unwrap_or(Value::Null),
        _ => empty_config()["settings"].clone(),
    };
    let nodes = match map.get("nodes") {
        Some(Value::Array(nodes)) => Value::Array(nodes.clone()),
        _ => Value::Array(Vec::new()),
    };
    let connections = match map.get("connections") {
        Some(Value::Array(connections)) => Value::Array(connections.clone()),
        _ => Value::Array(Vec::new()),
    };
    Ok(json!({
        "settings": settings,
        "nodes": nodes,
        "connections": connections,
    }))
}

fn empty_config() -> Value {
    json!({
        "settings": { "showGrid": true, "gridSize": 100, "snapToGrid": true },
        "nodes": [],
        "connections": []
    })
}

fn parse_sample() -> Value {
    serde_json::from_str(SAMPLE)
        .ok()
        .and_then(|value| normalize(value).ok())
        .unwrap_or_else(empty_config)
}

fn read_config_file(path: &Path) -> Result<Value, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut reader = file.take(MAX_CONFIG_BYTES as u64 + 1);
    let mut body = String::new();
    reader
        .read_to_string(&mut body)
        .map_err(|error| error.to_string())?;
    if body.len() > MAX_CONFIG_BYTES {
        return Err("Configuration file is larger than 5 MB".to_string());
    }
    let parsed = serde_json::from_str(&body).map_err(|error| error.to_string())?;
    normalize(parsed)
}

fn resolve_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(legacy) = legacy_config_path() {
        if legacy.is_file() {
            return Ok(legacy);
        }
    }
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("config.json"))
}

fn legacy_config_path() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let home = std::env::var_os("HOME")?;
        Some(PathBuf::from(home).join(".config/custom-network-topology/config.json"))
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        Some(
            PathBuf::from(home)
                .join("Library/Application Support/custom-network-topology/config.json"),
        )
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")?;
        Some(PathBuf::from(appdata).join("custom-network-topology/config.json"))
    }
}

fn write_atomic(path: &Path, body: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "Configuration path has no directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config.json");
    let temporary = parent.join(format!(".{file_name}.{}.tmp", std::process::id()));
    write_private(&temporary, body)?;
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    restrict_permissions(path);
    Ok(())
}

fn write_private(path: &Path, body: &str) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    file.write_all(body.as_bytes())
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn restrict_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn file_path(picked: Option<FilePath>) -> Option<PathBuf> {
    picked.and_then(|path| path.into_path().ok())
}

fn default_ssh_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let directory = PathBuf::from(home).join(".ssh");
    directory.is_dir().then_some(directory)
}

fn failure(error: &str) -> Value {
    json!({ "success": false, "error": error })
}

fn protect_passwords(config: &mut Value, key: Option<&[u8; 32]>) {
    let Some(nodes) = config.get_mut("nodes").and_then(Value::as_array_mut) else {
        return;
    };
    for node in nodes {
        let Some(object) = node.as_object_mut() else {
            continue;
        };
        let Some(password) = object.get("sshPass").and_then(Value::as_str) else {
            continue;
        };
        if password.is_empty() || object.get("_encrypted").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let password = password.to_string();
        match key.and_then(|key| seal(key, &password)) {
            Some(ciphertext) => {
                object.insert("sshPass".to_string(), Value::String(ciphertext));
                object.insert("_encrypted".to_string(), Value::Bool(true));
            }
            None => {
                object.insert("sshPass".to_string(), Value::String(password));
                object.insert("_encrypted".to_string(), Value::Bool(false));
            }
        }
    }
}

fn reveal_passwords(config: &mut Value, key: Option<&[u8; 32]>) {
    let Some(nodes) = config.get_mut("nodes").and_then(Value::as_array_mut) else {
        return;
    };
    for node in nodes {
        let Some(object) = node.as_object_mut() else {
            continue;
        };
        if object.get("_encrypted").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let Some(stored) = object.get("sshPass").and_then(Value::as_str) else {
            continue;
        };
        let Some(payload) = stored.strip_prefix(PREFIX) else {
            continue;
        };
        let Some(key) = key else {
            continue;
        };
        let Some(password) = open(key, payload) else {
            continue;
        };
        object.insert("sshPass".to_string(), Value::String(password));
        object.insert("_encrypted".to_string(), Value::Bool(false));
    }
}

fn encryption_key() -> Option<[u8; 32]> {
    *KEY.get_or_init(load_or_create_key)
}

fn load_or_create_key() -> Option<[u8; 32]> {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(keyring_key());
    });
    receiver.recv_timeout(Duration::from_secs(2)).ok().flatten()
}

fn keyring_key() -> Option<[u8; 32]> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()?;
    if let Ok(existing) = entry.get_password() {
        return decode_key(&existing);
    }
    let generated = aes_gcm::Key::<Aes256Gcm>::generate();
    let mut key = [0u8; 32];
    key.copy_from_slice(generated.as_slice());
    let encoded = STANDARD.encode(key);
    entry.set_password(&encoded).ok()?;
    Some(key)
}

fn decode_key(encoded: &str) -> Option<[u8; 32]> {
    let bytes = STANDARD.decode(encoded.trim()).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Some(key)
}

fn seal(key: &[u8; 32], plaintext: &str) -> Option<String> {
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::try_from(key.as_slice()).ok()?);
    let nonce = Nonce::generate();
    let ciphertext = cipher.encrypt(&nonce, plaintext.as_bytes()).ok()?;
    let mut packed = Vec::with_capacity(nonce.len() + ciphertext.len());
    packed.extend_from_slice(&nonce);
    packed.extend_from_slice(&ciphertext);
    Some(format!("{PREFIX}{}", STANDARD.encode(packed)))
}

fn open(key: &[u8; 32], payload: &str) -> Option<String> {
    let packed = STANDARD.decode(payload).ok()?;
    if packed.len() <= 12 {
        return None;
    }
    let (nonce_bytes, ciphertext) = packed.split_at(12);
    let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::try_from(key.as_slice()).ok()?);
    let nonce = Nonce::try_from(nonce_bytes).ok()?;
    let plain = cipher.decrypt(&nonce, ciphertext).ok()?;
    String::from_utf8(plain).ok()
}

static KEY: OnceLock<Option<[u8; 32]>> = OnceLock::new();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_legacy_arrays_and_drops_unknown_top_level_keys() {
        let legacy = normalize(json!([{ "id": "n1", "sshPass": "secret" }])).unwrap();
        assert_eq!(legacy["nodes"][0]["id"], "n1");
        assert!(legacy["connections"].as_array().unwrap().is_empty());

        let extra = normalize(json!({
            "settings": { "showGrid": false },
            "nodes": [],
            "connections": [{ "id": "c1" }],
            "unexpected": true
        }))
        .unwrap();
        assert!(extra.get("unexpected").is_none());
        assert_eq!(extra["settings"]["showGrid"], false);
        assert_eq!(extra["connections"][0]["id"], "c1");
    }

    #[test]
    fn seals_and_reveals_passwords_without_touching_electron_ciphertext() {
        let key = [7u8; 32];
        let mut config = json!({
            "nodes": [
                { "id": "a", "sshPass": "s3cret" },
                { "id": "b", "sshPass": "" },
                { "id": "c", "sshPass": "electron-blob", "_encrypted": true }
            ]
        });
        protect_passwords(&mut config, Some(&key));
        let stored = config["nodes"][0]["sshPass"].as_str().unwrap().to_string();
        assert!(stored.starts_with(PREFIX));
        assert_eq!(config["nodes"][0]["_encrypted"], true);
        assert_eq!(config["nodes"][1]["sshPass"], "");
        assert_eq!(config["nodes"][2]["sshPass"], "electron-blob");

        reveal_passwords(&mut config, Some(&key));
        assert_eq!(config["nodes"][0]["sshPass"], "s3cret");
        assert_eq!(config["nodes"][0]["_encrypted"], false);
        assert_eq!(config["nodes"][2]["_encrypted"], true);

        config["nodes"][0]["sshPass"] = Value::String("enc:v1:not-valid".to_string());
        config["nodes"][0]["_encrypted"] = Value::Bool(true);
        reveal_passwords(&mut config, Some(&key));
        assert_eq!(config["nodes"][0]["sshPass"], "enc:v1:not-valid");
        assert_eq!(config["nodes"][0]["_encrypted"], true);
    }
}
