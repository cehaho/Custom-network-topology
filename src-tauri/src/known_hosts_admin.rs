//! Admin commands for the pinned SSH host keys: list them and import an
//! OpenSSH `known_hosts` file. Forgetting a key is `ssh::forget_host_key`.

use std::io::Read;
use std::path::PathBuf;

use serde_json::{Value, json};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::known_hosts::{self, MAX_OPENSSH_FILE_BYTES};

/// Pinned entries without the full keys.
pub fn list(app: &AppHandle) -> Value {
    let path = match crate::config::known_hosts_path(app) {
        Ok(path) => path,
        Err(error) => return failure(&error),
    };
    match known_hosts::list(&path) {
        Ok(entries) => json!({ "success": true, "entries": entries }),
        Err(error) => failure(&error),
    }
}

/// Asks for an OpenSSH known_hosts file (default `~/.ssh/known_hosts`) and
/// imports its plain entries. Existing different keys are reported, never
/// replaced.
pub fn import_openssh(app: &AppHandle) -> Value {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Import OpenSSH known_hosts")
        .add_filter("All Files", &["*"]);
    if let Some(ssh_dir) = default_ssh_dir() {
        if ssh_dir.join("known_hosts").is_file() {
            dialog = dialog.set_file_name("known_hosts");
        }
        dialog = dialog.set_directory(ssh_dir);
    }
    let Some(source) = dialog
        .blocking_pick_file()
        .and_then(|picked| picked.into_path().ok())
    else {
        return json!({ "success": false, "canceled": true });
    };
    let text = match read_limited(&source) {
        Ok(text) => text,
        Err(error) => return failure(&error),
    };
    let store = match crate::config::known_hosts_path(app) {
        Ok(path) => path,
        Err(error) => return failure(&error),
    };
    match known_hosts::import_openssh(&store, &text) {
        Ok(summary) => json!({ "success": true, "summary": summary }),
        Err(error) => failure(&error),
    }
}

fn read_limited(path: &std::path::Path) -> Result<String, String> {
    let file = std::fs::File::open(path)
        .map_err(|error| format!("Failed to read the known_hosts file: {error}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_OPENSSH_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read the known_hosts file: {error}"))?;
    if bytes.len() as u64 > MAX_OPENSSH_FILE_BYTES {
        return Err("The known_hosts file is too large".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "The known_hosts file is not valid text".to_string())
}

fn default_ssh_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let directory = PathBuf::from(home).join(".ssh");
    directory.is_dir().then_some(directory)
}

fn failure(error: &str) -> Value {
    json!({ "success": false, "error": error })
}
