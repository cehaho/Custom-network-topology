//! Pinned SSH host keys (trust on first use).
//!
//! The file `known_hosts.json` sits next to the topology file. It holds only
//! public data: for each `host:port`, the key algorithm, its SHA256
//! fingerprint, and the full public key in OpenSSH form. Matching compares the
//! full key, not just the fingerprint.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

const FILE_VERSION: u32 = 1;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// Serialises read-modify-write cycles on the file within this process.
static FILE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKey {
    pub algorithm: String,
    pub fingerprint: String,
    /// `<algorithm> <base64>` as in an OpenSSH known_hosts line.
    pub key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    #[serde(flatten)]
    key: HostKey,
    #[serde(default)]
    added_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Document {
    version: u32,
    #[serde(default)]
    hosts: BTreeMap<String, Entry>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    Unknown,
    Match,
    Mismatch { stored: HostKey },
}

pub fn entry_name(host: &str, port: u16) -> String {
    let host = host.trim().to_ascii_lowercase();
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// Compares `presented` with what is pinned for `host:port`.
pub fn check(path: &Path, host: &str, port: u16, presented: &HostKey) -> Result<Verdict, String> {
    let _guard = lock();
    let document = read(path)?;
    Ok(match document.hosts.get(&entry_name(host, port)) {
        None => Verdict::Unknown,
        Some(entry) if entry.key.key == presented.key => Verdict::Match,
        Some(entry) => Verdict::Mismatch {
            stored: entry.key.clone(),
        },
    })
}

/// Pins `key` for `host:port`. Refuses to replace a different pinned key:
/// the caller must `forget` it first.
pub fn remember(path: &Path, host: &str, port: u16, key: &HostKey) -> Result<(), String> {
    let _guard = lock();
    let mut document = read(path)?;
    let name = entry_name(host, port);
    if let Some(existing) = document.hosts.get(&name) {
        if existing.key.key == key.key {
            return Ok(());
        }
        return Err("A different host key is already stored for this host".to_string());
    }
    document.hosts.insert(
        name,
        Entry {
            key: key.clone(),
            added_at: chrono::Utc::now().to_rfc3339(),
        },
    );
    write(path, &document)
}

/// Drops the pinned key for `host:port`. Returns whether one existed.
pub fn forget(path: &Path, host: &str, port: u16) -> Result<bool, String> {
    let _guard = lock();
    let mut document = read(path)?;
    if document.hosts.remove(&entry_name(host, port)).is_none() {
        return Ok(false);
    }
    write(path, &document)?;
    Ok(true)
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    FILE_LOCK.lock().unwrap_or_else(|error| error.into_inner())
}

fn read(path: &Path) -> Result<Document, String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Document {
                version: FILE_VERSION,
                hosts: BTreeMap::new(),
            });
        }
        Err(error) => return Err(format!("Failed to read known hosts: {error}")),
    };
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return Err("Failed to read known hosts: not a file or too large".to_string());
    }
    let body = std::fs::read_to_string(path)
        .map_err(|error| format!("Failed to read known hosts: {error}"))?;
    let document: Document = serde_json::from_str(&body)
        .map_err(|error| format!("Known hosts file is invalid: {error}"))?;
    if document.version != FILE_VERSION {
        return Err("Known hosts file has an unknown version".to_string());
    }
    Ok(document)
}

fn write(path: &Path, document: &Document) -> Result<(), String> {
    let body = serde_json::to_string_pretty(document).map_err(|error| error.to_string())?;
    crate::config::write_atomic(path, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cnt-known-hosts-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("known_hosts.json")
    }

    fn key(material: &str) -> HostKey {
        HostKey {
            algorithm: "ssh-ed25519".to_string(),
            fingerprint: format!("SHA256:{material}"),
            key: format!("ssh-ed25519 {material}"),
        }
    }

    #[test]
    fn unknown_when_file_is_missing_or_host_absent() {
        let path = temp_path("unknown");
        assert_eq!(
            check(&path, "10.0.0.1", 22, &key("A")).unwrap(),
            Verdict::Unknown
        );
        remember(&path, "10.0.0.1", 22, &key("A")).unwrap();
        assert_eq!(
            check(&path, "10.0.0.2", 22, &key("A")).unwrap(),
            Verdict::Unknown
        );
        assert_eq!(
            check(&path, "10.0.0.1", 2222, &key("A")).unwrap(),
            Verdict::Unknown
        );
    }

    #[test]
    fn remembered_key_matches_and_host_is_case_insensitive() {
        let path = temp_path("match");
        remember(&path, "Router.LAN", 22, &key("A")).unwrap();
        assert_eq!(
            check(&path, "router.lan", 22, &key("A")).unwrap(),
            Verdict::Match
        );
        // Remembering the same key again is a no-op.
        remember(&path, "router.lan", 22, &key("A")).unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("\"router.lan:22\""));
        assert!(body.contains("SHA256:A"));
    }

    #[test]
    fn different_key_is_a_mismatch_and_is_not_overwritten() {
        let path = temp_path("mismatch");
        remember(&path, "10.0.0.1", 22, &key("A")).unwrap();
        assert_eq!(
            check(&path, "10.0.0.1", 22, &key("B")).unwrap(),
            Verdict::Mismatch { stored: key("A") }
        );
        assert!(remember(&path, "10.0.0.1", 22, &key("B")).is_err());
        assert_eq!(
            check(&path, "10.0.0.1", 22, &key("A")).unwrap(),
            Verdict::Match
        );
    }

    #[test]
    fn forget_removes_only_that_entry() {
        let path = temp_path("forget");
        remember(&path, "10.0.0.1", 22, &key("A")).unwrap();
        remember(&path, "10.0.0.2", 22, &key("C")).unwrap();
        assert!(forget(&path, "10.0.0.1", 22).unwrap());
        assert!(!forget(&path, "10.0.0.1", 22).unwrap());
        assert_eq!(
            check(&path, "10.0.0.1", 22, &key("B")).unwrap(),
            Verdict::Unknown
        );
        assert_eq!(
            check(&path, "10.0.0.2", 22, &key("C")).unwrap(),
            Verdict::Match
        );
        remember(&path, "10.0.0.1", 22, &key("B")).unwrap();
        assert_eq!(
            check(&path, "10.0.0.1", 22, &key("B")).unwrap(),
            Verdict::Match
        );
    }

    #[test]
    fn corrupt_file_is_an_error_not_an_empty_store() {
        let path = temp_path("corrupt");
        std::fs::write(&path, "not json").unwrap();
        assert!(check(&path, "10.0.0.1", 22, &key("A")).is_err());
        assert!(remember(&path, "10.0.0.1", 22, &key("A")).is_err());
    }
}
