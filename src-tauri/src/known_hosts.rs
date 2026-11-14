//! Pinned SSH host keys (trust on first use).
//!
//! The file `known_hosts.json` sits next to the topology file. It holds only
//! public data: for each `host:port` (`[addr]:port` for IPv6), the key algorithm, its SHA256
//! fingerprint, and the full public key in OpenSSH form. Matching compares the
//! full key, not just the fingerprint.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::hosts::{canonical_host, format_host_port};

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

/// The key of a pinned host: `host:port` for IPv4 and hostnames (lower-cased,
/// as before), `[addr]:port` for IPv6 with the address in canonical form, so
/// `[2001:db8::1]:22` stays unambiguous and `2001:DB8:0::1` matches it.
pub fn entry_name(host: &str, port: u16) -> String {
    format_host_port(&canonical_host(host), port)
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

/// A pinned entry as shown in Admin: no full key, only what identifies it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub fingerprint: String,
    pub added_at: String,
}

/// Every pinned entry, sorted by entry name.
pub fn list(path: &Path) -> Result<Vec<Listed>, String> {
    let _guard = lock();
    let document = read(path)?;
    Ok(document
        .hosts
        .iter()
        .filter_map(|(name, entry)| {
            let (host, port) = split_entry_name(name)?;
            Some(Listed {
                host,
                port,
                algorithm: entry.key.algorithm.clone(),
                fingerprint: entry.key.fingerprint.clone(),
                added_at: entry.added_at.clone(),
            })
        })
        .collect())
}

/// Inverse of `entry_name`: `host:port` or `[addr]:port`.
pub fn split_entry_name(name: &str) -> Option<(String, u16)> {
    let (host, port) = match name.strip_prefix('[') {
        Some(rest) => rest.split_once("]:")?,
        None => name.rsplit_once(':')?,
    };
    let port = port.parse::<u16>().ok().filter(|port| *port != 0)?;
    (!host.is_empty()).then(|| (host.to_string(), port))
}

/// Largest OpenSSH known_hosts file read by the import.
pub const MAX_OPENSSH_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// One line of an OpenSSH `known_hosts` file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenSshLine {
    /// Empty line or `#` comment.
    Blank,
    /// `|1|salt|hash` host field: the host name cannot be recovered.
    Hashed,
    /// `@cert-authority` or `@revoked` line.
    Marker,
    /// Unusable line, with the reason.
    Invalid(String),
    /// `host:port` pairs (canonical host) and the key they share.
    Entry {
        hosts: Vec<(String, u16)>,
        key: HostKey,
    },
}

const IMPORTED_KEY_TYPES: &[&str] = &[
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "ssh-rsa",
];

/// Parses one OpenSSH known_hosts line. Host patterns with wildcards or
/// negation are dropped; a line left with no host is invalid.
pub fn parse_openssh_line(line: &str) -> OpenSshLine {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return OpenSshLine::Blank;
    }
    if line.starts_with('@') {
        return OpenSshLine::Marker;
    }
    let mut fields = line.split_ascii_whitespace();
    let (Some(patterns), Some(key_type), Some(material)) =
        (fields.next(), fields.next(), fields.next())
    else {
        return OpenSshLine::Invalid("missing fields".to_string());
    };
    if patterns.starts_with('|') {
        return OpenSshLine::Hashed;
    }
    if !IMPORTED_KEY_TYPES.contains(&key_type) {
        return OpenSshLine::Invalid(format!("unsupported key type {key_type}"));
    }
    let key = match parse_public_key(key_type, material) {
        Ok(key) => key,
        Err(error) => return OpenSshLine::Invalid(error),
    };
    let mut hosts: Vec<(String, u16)> = Vec::new();
    for pattern in patterns.split(',') {
        if let Some(host) = parse_host_pattern(pattern) {
            if !hosts.contains(&host) {
                hosts.push(host);
            }
        }
    }
    if hosts.is_empty() {
        return OpenSshLine::Invalid("no usable host".to_string());
    }
    OpenSshLine::Entry { hosts, key }
}

/// `host` (port 22) or `[host]:port`, with the host canonical as in
/// `entry_name`. Wildcards, negations and invalid hosts give `None`.
fn parse_host_pattern(pattern: &str) -> Option<(String, u16)> {
    if pattern.is_empty() || pattern.contains(['*', '?', '!']) {
        return None;
    }
    let (host, port) = match pattern.strip_prefix('[') {
        Some(rest) => {
            let (host, port) = rest.split_once("]:")?;
            let port = port.parse::<u16>().ok().filter(|port| *port != 0)?;
            (host, port)
        }
        None => (pattern, 22),
    };
    let host = crate::hosts::normalize_host(host)?;
    Some((canonical_host(&host), port))
}

/// Parses `<type> <base64>` and returns it in the form `ssh::connect` pins:
/// re-encoded without comment, with its SHA256 fingerprint.
pub fn parse_public_key(key_type: &str, material: &str) -> Result<HostKey, String> {
    use russh::keys::{HashAlg, PublicKey};
    let public = PublicKey::from_openssh(&format!("{key_type} {material}"))
        .map_err(|_| "invalid public key".to_string())?;
    let algorithm = public.algorithm().to_string();
    if algorithm != key_type {
        return Err("key type does not match the key".to_string());
    }
    let public = PublicKey::from(public.key_data().clone());
    let fingerprint = public.key_data().fingerprint(HashAlg::Sha256).to_string();
    let key = public
        .to_openssh()
        .map_err(|_| "invalid public key".to_string())?;
    Ok(HostKey {
        algorithm,
        fingerprint,
        key: key.trim().to_string(),
    })
}

/// A host whose imported key differs from the pinned one. Left unchanged.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub host: String,
    pub port: u16,
    pub stored_algorithm: String,
    pub stored_fingerprint: String,
    pub imported_algorithm: String,
    pub imported_fingerprint: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub imported: usize,
    pub already_known: usize,
    pub skipped_hashed: usize,
    pub skipped_markers: usize,
    pub skipped_invalid: usize,
    pub conflicts: Vec<Conflict>,
}

/// Rank of an algorithm in russh's default host key preference: the key the
/// server will present when it has several.
fn preference(algorithm: &str) -> usize {
    IMPORTED_KEY_TYPES
        .iter()
        .position(|known| *known == algorithm)
        .unwrap_or(IMPORTED_KEY_TYPES.len())
}

/// Imports an OpenSSH known_hosts text. The store keeps one key per
/// `host:port`: when the file lists several, the one the client prefers is
/// pinned. A host already pinned to a key not in the file is a conflict and
/// stays as it is; nothing is overwritten.
pub fn import_openssh(path: &Path, text: &str) -> Result<ImportSummary, String> {
    let mut summary = ImportSummary::default();
    let mut found: BTreeMap<String, (String, u16, Vec<HostKey>)> = BTreeMap::new();
    for line in text.lines() {
        match parse_openssh_line(line) {
            OpenSshLine::Blank => {}
            OpenSshLine::Hashed => summary.skipped_hashed += 1,
            OpenSshLine::Marker => summary.skipped_markers += 1,
            OpenSshLine::Invalid(_) => summary.skipped_invalid += 1,
            OpenSshLine::Entry { hosts, key } => {
                for (host, port) in hosts {
                    let name = format_host_port(&host, port);
                    let slot = found
                        .entry(name)
                        .or_insert_with(|| (host, port, Vec::new()));
                    if !slot.2.contains(&key) {
                        slot.2.push(key.clone());
                    }
                }
            }
        }
    }

    let _guard = lock();
    let mut document = read(path)?;
    let added_at = chrono::Utc::now().to_rfc3339();
    for (name, (host, port, mut keys)) in found {
        keys.sort_by_key(|key| preference(&key.algorithm));
        let chosen = &keys[0];
        match document.hosts.get(&name) {
            Some(existing) if keys.iter().any(|key| key.key == existing.key.key) => {
                summary.already_known += 1;
            }
            Some(existing) => summary.conflicts.push(Conflict {
                host,
                port,
                stored_algorithm: existing.key.algorithm.clone(),
                stored_fingerprint: existing.key.fingerprint.clone(),
                imported_algorithm: chosen.algorithm.clone(),
                imported_fingerprint: chosen.fingerprint.clone(),
            }),
            None => {
                document.hosts.insert(
                    name,
                    Entry {
                        key: chosen.clone(),
                        added_at: added_at.clone(),
                    },
                );
                summary.imported += 1;
            }
        }
    }
    if summary.imported > 0 {
        write(path, &document)?;
    }
    Ok(summary)
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
    fn ipv6_entries_are_bracketed_and_canonical() {
        assert_eq!(entry_name("10.0.0.1", 22), "10.0.0.1:22");
        assert_eq!(entry_name("Router.LAN", 22), "router.lan:22");
        assert_eq!(entry_name("::1", 22), "[::1]:22");
        assert_eq!(entry_name("2001:DB8:0:0::1", 2222), "[2001:db8::1]:2222");
        assert_eq!(entry_name("fe80::1%eth0", 22), "[fe80::1%eth0]:22");

        let path = temp_path("ipv6");
        remember(&path, "2001:db8::1", 22, &key("A")).unwrap();
        assert_eq!(
            check(&path, "2001:DB8:0::1", 22, &key("A")).unwrap(),
            Verdict::Match
        );
        assert_eq!(
            check(&path, "2001:db8::1", 2222, &key("A")).unwrap(),
            Verdict::Unknown
        );
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("\"[2001:db8::1]:22\""));
    }

    // Generated with `ssh-keygen`; fingerprints are from `ssh-keygen -lf`.
    const ED25519: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIEZtyCp5b/Ox4McH9DQYOwt/IYQyxJdcLEhzIKPthUjg";
    const ED25519_FP: &str = "SHA256:YaE3i1UxkYBfk+s6XKDDUoropxf+Ay4sPS5/1F23Fec";
    const ED25519_B: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIK2G2tzWOb5XYOq2yIqiQUTfWt4K44NQUPjRLaZtyJ25";
    const ED25519_B_FP: &str = "SHA256:JgQJud7HA7vhYZkcYqLuGcKepcxDGW12vPC+Z6F+sAw";
    const ECDSA: &str = "AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBKNWAzCcnPeKL+l48TYzajsxtEG33+GaEVA8o+O9ppskW/N0TzlsSievaDP4jyHBO5lwEmephxSri9yWiQbIJho=";
    const ECDSA_FP: &str = "SHA256:3Xs94/Dce1afUDtli8NN0AXguPAvxQnQD5r8erhcucM";
    const RSA: &str = "AAAAB3NzaC1yc2EAAAADAQABAAABAQCs7hWg2NjCuEwK7FahfjmgfkAe+E0uqQwO4xlTGK6QpfqqdOwLzJfoHnVJyMJ8CM9VYpnynnBAiYHcVLh9Y/Th2HxGANAJDxOCIoCbzb55f85MIHqBhG3zzBjiUPBkbqIULUU3A0BonJzQrH+AkAhix+YuPN+t+W2agrg1KZWT30Idb+46hldg4jIYhn4G9sBvNT7fwycES6CxeYqGcsWU1OkCE5wRnSfPT+xQc0He73UjASam9LA+GR+yoNehCiRDN9L7kf2RAUFdxjk7T8kCzcQNKc9+0tvCK+JhC+Hx9IGHaQpsuTSG3pPX5AY5sZjxqa8S37/3WMbng0mHO8ER";
    const RSA_FP: &str = "SHA256:nar5NKjrLOG1kCdDHxiKOdEHqdVN2ki/S6VAo2s9y4k";

    fn entry(line: &str) -> (Vec<(String, u16)>, HostKey) {
        match parse_openssh_line(line) {
            OpenSshLine::Entry { hosts, key } => (hosts, key),
            other => panic!("expected an entry for {line:?}, got {other:?}"),
        }
    }

    fn hosts(list: &[(&str, u16)]) -> Vec<(String, u16)> {
        list.iter().map(|(h, p)| (h.to_string(), *p)).collect()
    }

    #[test]
    fn fingerprints_match_ssh_keygen() {
        let (_, key) = entry(&format!("router ssh-ed25519 {ED25519} test"));
        assert_eq!(key.algorithm, "ssh-ed25519");
        assert_eq!(key.fingerprint, ED25519_FP);
        // Stored without the comment, as `ssh::connect` pins it.
        assert_eq!(key.key, format!("ssh-ed25519 {ED25519}"));
        let (_, key) = entry(&format!("router ecdsa-sha2-nistp256 {ECDSA}"));
        assert_eq!(key.algorithm, "ecdsa-sha2-nistp256");
        assert_eq!(key.fingerprint, ECDSA_FP);
        let (_, key) = entry(&format!("router ssh-rsa {RSA}"));
        assert_eq!(key.algorithm, "ssh-rsa");
        assert_eq!(key.fingerprint, RSA_FP);
    }

    #[test]
    fn plain_bracketed_and_listed_hosts() {
        let (list, _) = entry(&format!("Router.LAN ssh-ed25519 {ED25519}"));
        assert_eq!(list, hosts(&[("router.lan", 22)]));
        let (list, _) = entry(&format!("[10.0.0.1]:2222 ssh-ed25519 {ED25519}"));
        assert_eq!(list, hosts(&[("10.0.0.1", 2222)]));
        let (list, _) = entry(&format!(
            "gw,10.0.0.1,[gw]:2200,GW ssh-ed25519 {ED25519} comment with spaces"
        ));
        assert_eq!(list, hosts(&[("gw", 22), ("10.0.0.1", 22), ("gw", 2200)]));
    }

    #[test]
    fn ipv6_hosts_are_canonical() {
        let (list, _) = entry(&format!("[::1]:2222 ssh-ed25519 {ED25519}"));
        assert_eq!(list, hosts(&[("::1", 2222)]));
        let (list, _) = entry(&format!(
            "2001:DB8:0::1,[2001:db8::2]:22 ssh-ed25519 {ED25519}"
        ));
        assert_eq!(list, hosts(&[("2001:db8::1", 22), ("2001:db8::2", 22)]));
        assert_eq!(
            split_entry_name("[::1]:2222"),
            Some(("::1".to_string(), 2222))
        );
        assert_eq!(split_entry_name("gw:22"), Some(("gw".to_string(), 22)));
        assert_eq!(split_entry_name("gw"), None);
    }

    #[test]
    fn skipped_lines_are_classified() {
        assert_eq!(parse_openssh_line(""), OpenSshLine::Blank);
        assert_eq!(parse_openssh_line("   # a comment"), OpenSshLine::Blank);
        assert_eq!(
            parse_openssh_line(&format!("|1|c2FsdA==|aGFzaA== ssh-ed25519 {ED25519}")),
            OpenSshLine::Hashed
        );
        assert_eq!(
            parse_openssh_line(&format!("@cert-authority *.lan ssh-ed25519 {ED25519}")),
            OpenSshLine::Marker
        );
        assert_eq!(
            parse_openssh_line(&format!("@revoked gw ssh-ed25519 {ED25519}")),
            OpenSshLine::Marker
        );
        for line in [
            "gw ssh-ed25519".to_string(),
            "gw ssh-ed25519 not-base64!".to_string(),
            format!("gw ssh-dss {ED25519}"),
            format!("gw ssh-rsa {ED25519}"),
            format!("*.lan,!bad ssh-ed25519 {ED25519}"),
            format!("[gw]:0 ssh-ed25519 {ED25519}"),
            format!("[gw]:x ssh-ed25519 {ED25519}"),
            format!("bad_host ssh-ed25519 {ED25519}"),
        ] {
            assert!(
                matches!(parse_openssh_line(&line), OpenSshLine::Invalid(_)),
                "{line}"
            );
        }
        // A wildcard among real hosts is dropped; the line still counts.
        let (list, _) = entry(&format!("gw,*.lan ssh-ed25519 {ED25519}"));
        assert_eq!(list, hosts(&[("gw", 22)]));
    }

    #[test]
    fn import_pins_preferred_key_and_reports_conflicts() {
        let path = temp_path("import");
        let conflicting = parse_public_key("ssh-ed25519", ED25519_B).unwrap();
        remember(&path, "10.0.0.9", 22, &conflicting).unwrap();
        let known = parse_public_key("ssh-ed25519", ED25519).unwrap();
        remember(&path, "10.0.0.8", 22, &known).unwrap();
        let text = [
            "# header".to_string(),
            format!("gw ssh-rsa {RSA}"),
            format!("gw ssh-ed25519 {ED25519}"),
            format!("gw ecdsa-sha2-nistp256 {ECDSA}"),
            format!("[::1]:2222 ecdsa-sha2-nistp256 {ECDSA}"),
            format!("10.0.0.9 ssh-ed25519 {ED25519}"),
            format!("10.0.0.8 ssh-rsa {RSA}"),
            format!("10.0.0.8 ssh-ed25519 {ED25519}"),
            format!("|1|c2FsdA==|aGFzaA== ssh-ed25519 {ED25519}"),
            format!("|1|c2FsdB==|aGFzaB== ssh-ed25519 {ED25519}"),
            format!("@revoked gw ssh-ed25519 {ED25519}"),
            "garbage".to_string(),
        ]
        .join("\n");
        let summary = import_openssh(&path, &text).unwrap();
        assert_eq!(summary.imported, 2);
        assert_eq!(summary.already_known, 1);
        assert_eq!(summary.skipped_hashed, 2);
        assert_eq!(summary.skipped_markers, 1);
        assert_eq!(summary.skipped_invalid, 1);
        assert_eq!(
            summary.conflicts,
            vec![Conflict {
                host: "10.0.0.9".to_string(),
                port: 22,
                stored_algorithm: "ssh-ed25519".to_string(),
                stored_fingerprint: ED25519_B_FP.to_string(),
                imported_algorithm: "ssh-ed25519".to_string(),
                imported_fingerprint: ED25519_FP.to_string(),
            }]
        );
        // The conflicting key is left untouched.
        assert_eq!(
            check(&path, "10.0.0.9", 22, &conflicting).unwrap(),
            Verdict::Match
        );
        // gw has three keys; the ed25519 one is what the client negotiates.
        assert_eq!(check(&path, "gw", 22, &known).unwrap(), Verdict::Match);

        let listed = list(&path).unwrap();
        let names: Vec<(String, u16)> = listed.iter().map(|e| (e.host.clone(), e.port)).collect();
        assert_eq!(
            names,
            hosts(&[
                ("10.0.0.8", 22),
                ("10.0.0.9", 22),
                ("::1", 2222),
                ("gw", 22)
            ])
        );
        let v6 = &listed[2];
        assert_eq!(v6.algorithm, "ecdsa-sha2-nistp256");
        assert_eq!(v6.fingerprint, ECDSA_FP);
        assert!(!v6.added_at.is_empty());

        // Importing again changes nothing.
        let again = import_openssh(&path, &text).unwrap();
        assert_eq!(again.imported, 0);
        assert_eq!(again.already_known, 3);
        assert_eq!(again.conflicts.len(), 1);
    }

    #[test]
    fn corrupt_file_is_an_error_not_an_empty_store() {
        let path = temp_path("corrupt");
        std::fs::write(&path, "not json").unwrap();
        assert!(check(&path, "10.0.0.1", 22, &key("A")).is_err());
        assert!(remember(&path, "10.0.0.1", 22, &key("A")).is_err());
    }
}
