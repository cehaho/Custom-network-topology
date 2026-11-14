//! Topology file: the same JSON shape the canvas already saves.
//!
//! SSH passwords and key passphrases are not stored in this file. `secrets`
//! keeps them in the OS keyring. The document only records that a secret exists
//! and its type. A save that cannot reach the keyring is refused.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::topology;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::secrets::SecretValue;

const MAX_CONFIG_BYTES: usize = 5 * 1024 * 1024;
const SAMPLE: &str = include_str!("../../renderer/config.json");

pub struct ImportOutput {
    pub response: Value,
    pub token: Option<String>,
    pub secrets: HashMap<String, SecretValue>,
}

pub fn load(app: &AppHandle) -> Value {
    let Ok(path) = resolve_config_path(app) else {
        return topology::empty_document();
    };
    if !path.is_file() {
        if write_atomic(&path, SAMPLE).is_err() {
            return parse_sample();
        }
    }
    match read_config_file(&path) {
        Ok(config) => match move_secrets_out_of_file(&path, config) {
            Ok(config) => config,
            Err(error) => failure(&error),
        },
        Err(error) => {
            log::warn!("config load failed: {error}");
            topology::empty_document()
        }
    }
}

pub fn save(app: &AppHandle, config: Value, pending: &HashMap<String, SecretValue>) -> Value {
    let path = match resolve_config_path(app) {
        Ok(path) => path,
        Err(error) => return failure(&error),
    };
    let previous = read_config_file(&path).ok();
    match prepare_for_disk(config, previous.as_ref(), pending) {
        Ok(clean) => {
            let body = match pretty(&clean) {
                Ok(body) => body,
                Err(error) => return failure(&error),
            };
            match write_replacing(&path, &body) {
                Ok(()) => {
                    scrub_backup(&path);
                    json!({ "success": true, "config": clean })
                }
                Err(error) => failure(&error),
            }
        }
        Err(error) => failure(&error),
    }
}

pub fn export(app: &AppHandle, config: Value) -> Value {
    let mut document = match topology::read_document(config) {
        Ok(document) => document,
        Err(error) => return failure(&error),
    };
    crate::secrets::strip_for_export(&mut document);
    let body = match pretty(&document) {
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

pub fn import(app: &AppHandle) -> ImportOutput {
    let picked = app
        .dialog()
        .file()
        .set_title("Import Configuration")
        .add_filter("JSON Files", &["json"])
        .blocking_pick_file();
    let Some(path) = file_path(picked) else {
        return import_done(
            json!({ "success": false, "canceled": true }),
            None,
            HashMap::new(),
        );
    };
    let mut config = match read_config_file(&path) {
        Ok(config) => config,
        Err(error) => return import_done(failure(&error), None, HashMap::new()),
    };
    let legacy_key = if crate::secrets::needs_legacy_key(&config) {
        match crate::secrets::read_legacy_key() {
            Ok(key) => key,
            Err(error) => return import_done(failure(&error), None, HashMap::new()),
        }
    } else {
        None
    };
    let pending = match crate::secrets::take_secret_values(&mut config, legacy_key.as_ref()) {
        Ok(pending) => pending,
        Err(error) => return import_done(failure(&error), None, HashMap::new()),
    };
    let token = if pending.is_empty() {
        None
    } else {
        Some(new_import_token())
    };
    let nodes = config["nodes"].as_array().map(Vec::len).unwrap_or(0);
    let links = config["links"].as_array().map(Vec::len).unwrap_or(0);
    let mut response = json!({
        "success": true,
        "config": config,
        "summary": {
            "nodes": nodes,
            "links": links,
            "schemaVersion": config["schemaVersion"].as_i64().unwrap_or(topology::SCHEMA_VERSION)
        }
    });
    if let Some(token) = &token {
        response["importToken"] = json!(token);
    }
    import_done(response, token, pending)
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

fn prepare_for_disk(
    config: Value,
    previous: Option<&Value>,
    pending: &HashMap<String, SecretValue>,
) -> Result<Value, String> {
    let normalized = topology::read_document(config)?;
    crate::secrets::seal_document(
        normalized,
        previous,
        pending,
        &crate::secrets::KeyringStore,
        false,
    )
}

fn move_secrets_out_of_file(path: &Path, config: Value) -> Result<Value, String> {
    if !crate::secrets::contains_secret_values(&config) {
        return Ok(config);
    }
    let clean = crate::secrets::seal_document(
        config,
        None,
        &HashMap::new(),
        &crate::secrets::KeyringStore,
        true,
    )?;
    let body = pretty(&clean)?;
    write_replacing(path, &body)?;
    scrub_backup(path);
    Ok(clean)
}

fn scrub_backup(path: &Path) {
    let backup = backup_path(path);
    let Ok(body) = std::fs::read_to_string(&backup) else {
        return;
    };
    let Ok(mut document) = serde_json::from_str::<Value>(&body) else {
        return;
    };
    if !crate::secrets::contains_secret_values(&document) {
        return;
    }
    crate::secrets::drop_secret_values(&mut document);
    let Ok(clean) = pretty(&document) else {
        return;
    };
    if write_private(&backup, &clean).is_ok() {
        restrict_permissions(&backup);
    }
}

fn backup_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config.json");
    path.with_file_name(format!("{file_name}.bak"))
}

fn import_done(
    response: Value,
    token: Option<String>,
    secrets: HashMap<String, SecretValue>,
) -> ImportOutput {
    ImportOutput {
        response,
        token,
        secrets,
    }
}

fn new_import_token() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

fn pretty(config: &Value) -> Result<String, String> {
    let body = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    if body.len() > MAX_CONFIG_BYTES {
        return Err("Configuration file is larger than 5 MB".to_string());
    }
    Ok(body)
}

fn parse_sample() -> Value {
    serde_json::from_str(SAMPLE)
        .ok()
        .and_then(|value| topology::read_document(value).ok())
        .unwrap_or_else(topology::empty_document)
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
    topology::read_document(parsed)
}

pub fn read_status(app: &AppHandle) -> Value {
    let Ok(path) = status_path(app) else {
        return json!({ "nodes": {} });
    };
    let Ok(body) = std::fs::read_to_string(path) else {
        return json!({ "nodes": {} });
    };
    serde_json::from_str(&body).unwrap_or_else(|_| json!({ "nodes": {} }))
}

pub fn write_status(app: &AppHandle, value: &Value) -> Result<(), String> {
    let path = status_path(app)?;
    let body = serde_json::to_string(value).map_err(|error| error.to_string())?;
    write_atomic(&path, &body)
}

fn status_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_config_path(app)?.with_file_name("status.json"))
}

/// Pinned SSH host keys live beside the topology file. Public data only.
pub fn known_hosts_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_config_path(app)?.with_file_name("known_hosts.json"))
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

pub(crate) fn write_atomic(path: &Path, body: &str) -> Result<(), String> {
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
    file.sync_all().map_err(|error| error.to_string())?;
    Ok(())
}

fn write_replacing(path: &Path, body: &str) -> Result<(), String> {
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
    if path.is_file() {
        let backup = path.with_file_name(format!("{file_name}.bak"));
        if let Err(error) = std::fs::copy(path, &backup) {
            let _ = std::fs::remove_file(&temporary);
            return Err(error.to_string());
        }
        restrict_permissions(&backup);
    }
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    restrict_permissions(path);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacing_a_config_keeps_the_previous_file_beside_it() {
        let directory = std::env::temp_dir().join(format!(
            "topology-write-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("config.json");
        write_replacing(&path, "{\"schemaVersion\":1}\n").unwrap();
        write_replacing(&path, "{\"schemaVersion\":1,\"nodes\":[]}\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"schemaVersion\":1,\"nodes\":[]}\n"
        );
        assert_eq!(
            std::fs::read_to_string(directory.join("config.json.bak")).unwrap(),
            "{\"schemaVersion\":1}\n"
        );
        let names: Vec<_> = std::fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().all(|name| !name.contains(".tmp")));
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn invalid_topology_is_refused_before_replace() {
        let error = prepare_for_disk(
            json!({ "settings": { "showGrid": true } }),
            None,
            &HashMap::new(),
        )
        .unwrap_err();
        assert!(error.contains("no nodes"));
    }

    #[test]
    fn a_backup_copy_does_not_keep_a_password() {
        let directory = std::env::temp_dir().join(format!(
            "topology-secret-bak-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("config.json");
        let backup = directory.join("config.json.bak");
        std::fs::write(
            &backup,
            r#"{"schemaVersion":1,"nodes":[{"id":"node_a","sshPass":"s3cret","_encrypted":false}]}"#,
        )
        .unwrap();
        scrub_backup(&path);
        let body = std::fs::read_to_string(&backup).unwrap();
        assert!(!body.contains("s3cret"));
        assert!(!body.contains("_encrypted"));
        assert!(body.contains("\"type\": \"password\"") || body.contains("\"type\":\"password\""));
        let _ = std::fs::remove_dir_all(&directory);
    }
}
