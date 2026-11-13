//! SSH passwords and key passphrases live in the OS keyring, keyed by node id.
//!
//! The topology document only records that a secret exists and which kind it is
//! (`sshSecret.type` is `password` or `passphrase`). Export keeps that marker and
//! drops every secret value. If the keyring cannot store a new secret, the save
//! fails and nothing is written in clear text.

use std::collections::{HashMap, HashSet};

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};

const SERVICE: &str = "custom-network-topology";
const LEGACY_KEY_ACCOUNT: &str = "topology-key";
const PREFIX: &str = "enc:v1:";
const MAX_SECRET_BYTES: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SecretKind {
    Password,
    Passphrase,
}

impl SecretKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Passphrase => "passphrase",
        }
    }

    fn noun(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Passphrase => "key passphrase",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "password" => Some(Self::Password),
            "passphrase" => Some(Self::Passphrase),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretValue {
    pub kind: SecretKind,
    pub value: String,
}

#[derive(Clone, Copy, Debug)]
enum SecretReason {
    New,
    Move,
    Remove,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum StoreFailure {
    Unavailable,
    TimedOut,
}

pub trait SecretStore {
    fn get(&self, account: &str) -> Result<Option<String>, StoreFailure>;
    fn set(&self, account: &str, secret: &str) -> Result<(), StoreFailure>;
    fn delete(&self, account: &str) -> Result<(), StoreFailure>;
}

#[cfg(feature = "os-keyring")]
pub struct KeyringStore;

#[cfg(feature = "os-keyring")]
impl SecretStore for KeyringStore {
    fn get(&self, account: &str) -> Result<Option<String>, StoreFailure> {
        let account = account.to_string();
        call_keyring(move || {
            let entry =
                keyring::Entry::new(SERVICE, &account).map_err(|_| StoreFailure::Unavailable)?;
            match entry.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(StoreFailure::Unavailable),
            }
        })
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), StoreFailure> {
        let account = account.to_string();
        let secret = secret.to_string();
        call_keyring(move || {
            let entry =
                keyring::Entry::new(SERVICE, &account).map_err(|_| StoreFailure::Unavailable)?;
            entry
                .set_password(&secret)
                .map_err(|_| StoreFailure::Unavailable)
        })
    }

    fn delete(&self, account: &str) -> Result<(), StoreFailure> {
        let account = account.to_string();
        call_keyring(move || {
            let entry =
                keyring::Entry::new(SERVICE, &account).map_err(|_| StoreFailure::Unavailable)?;
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err(StoreFailure::Unavailable),
            }
        })
    }
}

#[cfg(feature = "os-keyring")]
fn call_keyring<T, F>(work: F) -> Result<T, StoreFailure>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, StoreFailure> + Send + 'static,
{
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(work());
    });
    match receiver.recv_timeout(std::time::Duration::from_secs(8)) {
        Ok(result) => result,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(StoreFailure::TimedOut),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(StoreFailure::Unavailable),
    }
}

#[cfg(feature = "os-keyring")]
pub fn lookup(node_id: &str, kind: SecretKind) -> Result<Option<String>, String> {
    if !is_safe_node_id(node_id) {
        return Ok(None);
    }
    match KeyringStore.get(&account(node_id, kind)) {
        Ok(value) => Ok(value),
        Err(failure) => Err(read_message(failure, kind)),
    }
}

pub fn contains_secret_values(document: &Value) -> bool {
    nodes(document).iter().any(|node| {
        let Some(object) = node.as_object() else {
            return false;
        };
        raw_field(object, "sshPass").is_some()
            || raw_field(object, "sshPassphrase").is_some()
            || object.get("_encrypted").and_then(Value::as_bool) == Some(true)
            || secret_object_value(object).is_some()
    })
}

pub fn needs_legacy_key(document: &Value) -> bool {
    nodes(document).iter().any(|node| {
        let Some(object) = node.as_object() else {
            return false;
        };
        field_needs_legacy_key(object, "sshPass") || field_needs_legacy_key(object, "sshPassphrase")
    })
}

/// Pull secret values off an imported document. The returned map is held in
/// memory until the user confirms the import and a later save stores it.
pub fn take_secret_values(
    document: &mut Value,
    legacy_key: Option<&[u8; 32]>,
) -> Result<HashMap<String, SecretValue>, String> {
    let mut copy = document.clone();
    let mut pending = HashMap::new();
    let Some(nodes) = copy.get_mut("nodes").and_then(Value::as_array_mut) else {
        *document = copy;
        return Ok(pending);
    };
    for node in nodes.iter_mut() {
        let Some(object) = node.as_object_mut() else {
            continue;
        };
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some(secret) = take_node_secret(object, legacy_key)? {
            if !is_safe_node_id(&id) {
                return Err(node_id_message(secret.kind));
            }
            validate_secret(&secret)?;
            pending.insert(id, secret);
        }
    }
    *document = copy;
    Ok(pending)
}

/// Remove secret values from a backup copy after they have already been stored.
pub fn drop_secret_values(document: &mut Value) {
    let Some(nodes) = node_array_mut(document) else {
        return;
    };
    for node in nodes {
        let Some(object) = node.as_object_mut() else {
            continue;
        };
        let kind = marker_kind(object)
            .or_else(|| raw_field(object, "sshPass").map(|_| SecretKind::Password))
            .or_else(|| raw_field(object, "sshPassphrase").map(|_| SecretKind::Passphrase));
        scrub_fields(object);
        if let Some(kind) = kind {
            object.insert("sshSecret".to_string(), marker(kind));
        }
    }
}

pub fn strip_for_export(document: &mut Value) {
    drop_secret_values(document);
}

pub fn seal_document(
    document: Value,
    previous: Option<&Value>,
    pending: &HashMap<String, SecretValue>,
    store: &dyn SecretStore,
    from_disk: bool,
) -> Result<Value, String> {
    let mut document = document;
    let previous_nodes = index_previous(previous);
    let legacy_key = legacy_key_if_needed(&document, &previous_nodes, store)?;
    let mut plans = Vec::new();
    let mut kept = HashSet::new();

    let nodes = document
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for (index, node) in nodes.iter().enumerate() {
        let Some(object) = node.as_object() else {
            continue;
        };
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        kept.insert(id.clone());
        let previous = previous_nodes.get(&id);
        let pending_secret = pending.get(&id);
        plans.push((
            index,
            id,
            plan_node(
                object,
                previous,
                pending_secret,
                legacy_key.as_ref(),
                from_disk,
            )?,
        ));
    }

    let mut ops = Vec::new();
    for (_, id, action) in &plans {
        match action {
            Action::Store(secret) => {
                if !is_safe_node_id(id) {
                    return Err(node_id_message(secret.kind));
                }
                validate_secret(secret)?;
                ops.push(Op::Set {
                    account: account(id, secret.kind),
                    value: secret.value.clone(),
                    kind: secret.kind,
                    reason: SecretReason::New,
                });
                let other = other_kind(secret.kind);
                ops.push(Op::Delete {
                    account: account(id, other),
                    kind: other,
                    reason: SecretReason::Remove,
                });
            }
            Action::Move(secret) => {
                if !is_safe_node_id(id) {
                    return Err(move_failure(StoreFailure::Unavailable));
                }
                validate_secret(secret).map_err(|_| {
                    "A password in the topology file could not be moved. The file was not changed."
                        .to_string()
                })?;
                ops.push(Op::Set {
                    account: account(id, secret.kind),
                    value: secret.value.clone(),
                    kind: secret.kind,
                    reason: SecretReason::Move,
                });
                let other = other_kind(secret.kind);
                ops.push(Op::Delete {
                    account: account(id, other),
                    kind: other,
                    reason: SecretReason::Remove,
                });
            }
            Action::Clear => {
                if is_safe_node_id(id) {
                    ops.push(delete_op(id, SecretKind::Password));
                    ops.push(delete_op(id, SecretKind::Passphrase));
                }
            }
            Action::Keep(_) | Action::Absent => {}
        }
    }
    for (id, previous) in &previous_nodes {
        if kept.contains(id) || !previous.had_secret || !is_safe_node_id(id) {
            continue;
        }
        ops.push(delete_op(id, SecretKind::Password));
        ops.push(delete_op(id, SecretKind::Passphrase));
    }

    apply_ops(store, &ops)?;

    if let Some(nodes) = document.get_mut("nodes").and_then(Value::as_array_mut) {
        for (index, _, action) in &plans {
            let Some(object) = nodes.get_mut(*index).and_then(Value::as_object_mut) else {
                continue;
            };
            scrub_fields(object);
            match action {
                Action::Store(secret) | Action::Move(secret) => {
                    object.insert("sshSecret".to_string(), marker(secret.kind));
                }
                Action::Keep(kind) => {
                    object.insert("sshSecret".to_string(), marker(*kind));
                }
                Action::Clear | Action::Absent => {
                    object.remove("sshSecret");
                }
            }
        }
    }
    Ok(document)
}

enum Action {
    Store(SecretValue),
    Move(SecretValue),
    Clear,
    Keep(SecretKind),
    Absent,
}

struct PreviousNode {
    had_secret: bool,
    kind: Option<SecretKind>,
    raw_password: Option<String>,
    raw_passphrase: Option<String>,
    password_encrypted: bool,
    passphrase_encrypted: bool,
}

enum Op {
    Set {
        account: String,
        value: String,
        kind: SecretKind,
        reason: SecretReason,
    },
    Delete {
        account: String,
        kind: SecretKind,
        reason: SecretReason,
    },
}

impl Op {
    fn account(&self) -> &str {
        match self {
            Self::Set { account, .. } | Self::Delete { account, .. } => account,
        }
    }

    fn kind(&self) -> SecretKind {
        match self {
            Self::Set { kind, .. } | Self::Delete { kind, .. } => *kind,
        }
    }

    fn reason(&self) -> SecretReason {
        match self {
            Self::Set { reason, .. } | Self::Delete { reason, .. } => *reason,
        }
    }
}

fn delete_op(node_id: &str, kind: SecretKind) -> Op {
    Op::Delete {
        account: account(node_id, kind),
        kind,
        reason: SecretReason::Remove,
    }
}

fn plan_node(
    object: &Map<String, Value>,
    previous: Option<&PreviousNode>,
    pending: Option<&SecretValue>,
    legacy_key: Option<&[u8; 32]>,
    from_disk: bool,
) -> Result<Action, String> {
    if object.get("sshSecretClear").and_then(Value::as_bool) == Some(true) {
        return Ok(Action::Clear);
    }
    if let Some(secret) = decode_node_secret(object, legacy_key)? {
        return Ok(if from_disk || secret_is_legacy(object) {
            Action::Move(secret)
        } else {
            Action::Store(secret)
        });
    }
    if let Some(secret) = pending {
        validate_secret(secret)?;
        return Ok(Action::Store(secret.clone()));
    }
    if let Some(kind) = marker_kind(object) {
        return Ok(Action::Keep(kind));
    }
    if let Some(previous) = previous {
        if let Some(secret) = decode_previous(previous, legacy_key)? {
            return Ok(Action::Move(secret));
        }
        if let Some(kind) = previous.kind {
            return Ok(Action::Keep(kind));
        }
    }
    Ok(Action::Absent)
}

fn secret_is_legacy(object: &Map<String, Value>) -> bool {
    object.get("_encrypted").and_then(Value::as_bool) == Some(true)
        || raw_field(object, "sshPass").is_some_and(|value| value.starts_with(PREFIX))
        || raw_field(object, "sshPassphrase").is_some_and(|value| value.starts_with(PREFIX))
}

fn decode_node_secret(
    object: &Map<String, Value>,
    legacy_key: Option<&[u8; 32]>,
) -> Result<Option<SecretValue>, String> {
    let auth = object
        .get("sshAuth")
        .and_then(Value::as_str)
        .unwrap_or("password");
    let password = decode_field(object, "sshPass", SecretKind::Password, legacy_key)?;
    let passphrase = decode_field(object, "sshPassphrase", SecretKind::Passphrase, legacy_key)?;
    let embedded = secret_object_value(object).map(|value| SecretValue {
        kind: marker_kind(object).unwrap_or(SecretKind::Password),
        value,
    });
    if auth == "key" {
        if let Some(secret) = passphrase.or(password).or(embedded) {
            return Ok(Some(secret));
        }
    } else if let Some(secret) = password.or(passphrase).or(embedded) {
        return Ok(Some(secret));
    }
    Ok(None)
}

fn decode_field(
    object: &Map<String, Value>,
    field: &str,
    kind: SecretKind,
    legacy_key: Option<&[u8; 32]>,
) -> Result<Option<SecretValue>, String> {
    let Some(stored) = raw_field(object, field) else {
        return Ok(None);
    };
    let encrypted = object.get("_encrypted").and_then(Value::as_bool) == Some(true)
        || stored.starts_with(PREFIX);
    let value = if encrypted {
        open_legacy(&stored, legacy_key)?
    } else {
        stored
    };
    Ok(Some(SecretValue { kind, value }))
}

fn decode_previous(
    previous: &PreviousNode,
    legacy_key: Option<&[u8; 32]>,
) -> Result<Option<SecretValue>, String> {
    if let Some(stored) = &previous.raw_password {
        let value = if previous.password_encrypted || stored.starts_with(PREFIX) {
            open_legacy(stored, legacy_key)?
        } else {
            stored.clone()
        };
        return Ok(Some(SecretValue {
            kind: SecretKind::Password,
            value,
        }));
    }
    if let Some(stored) = &previous.raw_passphrase {
        let value = if previous.passphrase_encrypted || stored.starts_with(PREFIX) {
            open_legacy(stored, legacy_key)?
        } else {
            stored.clone()
        };
        return Ok(Some(SecretValue {
            kind: SecretKind::Passphrase,
            value,
        }));
    }
    Ok(None)
}

fn take_node_secret(
    object: &mut Map<String, Value>,
    legacy_key: Option<&[u8; 32]>,
) -> Result<Option<SecretValue>, String> {
    let secret = decode_node_secret(object, legacy_key)?;
    let kind = secret
        .as_ref()
        .map(|item| item.kind)
        .or_else(|| marker_kind(object));
    scrub_fields(object);
    if let Some(kind) = kind {
        object.insert("sshSecret".to_string(), marker(kind));
    }
    Ok(secret)
}

fn open_legacy(stored: &str, legacy_key: Option<&[u8; 32]>) -> Result<String, String> {
    let Some(payload) = stored.strip_prefix(PREFIX) else {
        return Err(
            "A password in the topology file uses an unknown encryption format. The file was not changed."
                .to_string(),
        );
    };
    let Some(key) = legacy_key else {
        return Err(move_failure(StoreFailure::Unavailable));
    };
    open(key, payload).ok_or_else(|| {
        "A password in the topology file could not be decrypted. The file was not changed."
            .to_string()
    })
}

fn legacy_key_if_needed(
    document: &Value,
    previous: &HashMap<String, PreviousNode>,
    store: &dyn SecretStore,
) -> Result<Option<[u8; 32]>, String> {
    let needed = needs_legacy_key(document)
        || previous.values().any(|node| {
            node.password_encrypted
                || node.passphrase_encrypted
                || node
                    .raw_password
                    .as_deref()
                    .is_some_and(|value| value.starts_with(PREFIX))
                || node
                    .raw_passphrase
                    .as_deref()
                    .is_some_and(|value| value.starts_with(PREFIX))
        });
    if !needed {
        return Ok(None);
    }
    match store.get(LEGACY_KEY_ACCOUNT) {
        Ok(Some(encoded)) => Ok(decode_key(&encoded)),
        Ok(None) => Ok(None),
        Err(failure) => Err(move_failure(failure)),
    }
}

fn index_previous(previous: Option<&Value>) -> HashMap<String, PreviousNode> {
    let mut indexed = HashMap::new();
    for node in nodes(previous.unwrap_or(&Value::Null)) {
        let Some(object) = node.as_object() else {
            continue;
        };
        let Some(id) = object.get("id").and_then(Value::as_str) else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        let raw_password = raw_field(object, "sshPass");
        let raw_passphrase = raw_field(object, "sshPassphrase");
        let encrypted = object.get("_encrypted").and_then(Value::as_bool) == Some(true);
        let kind = marker_kind(object)
            .or_else(|| raw_password.as_ref().map(|_| SecretKind::Password))
            .or_else(|| raw_passphrase.as_ref().map(|_| SecretKind::Passphrase));
        indexed.insert(
            id.to_string(),
            PreviousNode {
                had_secret: kind.is_some() || encrypted,
                kind,
                password_encrypted: encrypted && raw_password.is_some(),
                passphrase_encrypted: encrypted && raw_passphrase.is_some(),
                raw_password,
                raw_passphrase,
            },
        );
    }
    indexed
}

struct Rollback {
    account: String,
    previous: Option<String>,
}

fn apply_ops(store: &dyn SecretStore, ops: &[Op]) -> Result<(), String> {
    let mut done = Vec::new();
    for op in ops {
        let previous = match store.get(op.account()) {
            Ok(value) => value,
            Err(failure) => {
                restore(store, &done);
                return Err(failure_message(failure, op.reason(), op.kind()));
            }
        };
        let result = match op {
            Op::Set { account, value, .. } => store.set(account, value),
            Op::Delete { account, .. } => store.delete(account),
        };
        if let Err(failure) = result {
            restore(store, &done);
            return Err(failure_message(failure, op.reason(), op.kind()));
        }
        done.push(Rollback {
            account: op.account().to_string(),
            previous,
        });
    }
    Ok(())
}

fn restore(store: &dyn SecretStore, done: &[Rollback]) {
    for item in done.iter().rev() {
        match &item.previous {
            Some(value) => {
                let _ = store.set(&item.account, value);
            }
            None => {
                let _ = store.delete(&item.account);
            }
        }
    }
}

fn failure_message(failure: StoreFailure, reason: SecretReason, kind: SecretKind) -> String {
    match (failure, reason) {
        (StoreFailure::TimedOut, SecretReason::New) => format!(
            "The system keyring did not respond. The {} was not saved.",
            kind.noun()
        ),
        (StoreFailure::Unavailable, SecretReason::New) => format!(
            "The system keyring is unavailable. The {} was not saved.",
            kind.noun()
        ),
        (StoreFailure::TimedOut, SecretReason::Move) => {
            "The system keyring did not respond, so existing passwords cannot be moved out of the topology file. The file was not changed.".to_string()
        }
        (StoreFailure::Unavailable, SecretReason::Move) => move_failure(failure),
        (_, SecretReason::Remove) => match failure {
            StoreFailure::TimedOut => {
                "The system keyring did not respond. The saved secret could not be removed, so the topology file was not changed.".to_string()
            }
            StoreFailure::Unavailable => {
                "The system keyring is unavailable. The saved secret could not be removed, so the topology file was not changed.".to_string()
            }
        },
    }
}

fn move_failure(failure: StoreFailure) -> String {
    match failure {
        StoreFailure::TimedOut => {
            "The system keyring did not respond, so existing passwords cannot be moved out of the topology file. The file was not changed.".to_string()
        }
        StoreFailure::Unavailable => {
            "The system keyring is unavailable, so existing passwords cannot be moved out of the topology file. The file was not changed.".to_string()
        }
    }
}

fn read_message(failure: StoreFailure, kind: SecretKind) -> String {
    match failure {
        StoreFailure::TimedOut => format!(
            "The system keyring did not respond. The saved {} cannot be read.",
            kind.noun()
        ),
        StoreFailure::Unavailable => format!(
            "The system keyring is unavailable. The saved {} cannot be read.",
            kind.noun()
        ),
    }
}

fn node_id_message(kind: SecretKind) -> String {
    format!(
        "This node id cannot be used as a keyring entry. The {} was not saved.",
        kind.noun()
    )
}

fn validate_secret(secret: &SecretValue) -> Result<(), String> {
    if secret.value.is_empty()
        || secret.value.len() > MAX_SECRET_BYTES
        || secret.value.contains('\0')
    {
        return Err(format!(
            "The {} cannot be stored in the system keyring. It was not saved.",
            secret.kind.noun()
        ));
    }
    Ok(())
}

fn other_kind(kind: SecretKind) -> SecretKind {
    match kind {
        SecretKind::Password => SecretKind::Passphrase,
        SecretKind::Passphrase => SecretKind::Password,
    }
}

fn account(node_id: &str, kind: SecretKind) -> String {
    format!("ssh/{node_id}/{}", kind.as_str())
}

fn is_safe_node_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=128).contains(&bytes.len()) && bytes.iter().all(|byte| !byte.is_ascii_control())
}

fn marker(kind: SecretKind) -> Value {
    json!({ "type": kind.as_str() })
}

fn marker_kind(object: &Map<String, Value>) -> Option<SecretKind> {
    object
        .get("sshSecret")
        .and_then(|secret| secret.get("type"))
        .and_then(Value::as_str)
        .and_then(SecretKind::parse)
}

fn secret_object_value(object: &Map<String, Value>) -> Option<String> {
    let secret = object.get("sshSecret")?;
    let value = secret
        .get("value")
        .and_then(Value::as_str)
        .or_else(|| secret.get("secret").and_then(Value::as_str))?;
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn raw_field(object: &Map<String, Value>, field: &str) -> Option<String> {
    let value = object.get(field)?.as_str()?;
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn field_needs_legacy_key(object: &Map<String, Value>, field: &str) -> bool {
    raw_field(object, field).is_some_and(|value| value.starts_with(PREFIX))
}

fn scrub_fields(object: &mut Map<String, Value>) {
    object.remove("sshPass");
    object.remove("sshPassphrase");
    object.remove("_encrypted");
    object.remove("sshSecretClear");
}

fn nodes(document: &Value) -> Vec<Value> {
    if let Value::Array(nodes) = document {
        return nodes.clone();
    }
    document
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn node_array_mut(document: &mut Value) -> Option<&mut Vec<Value>> {
    if document.is_array() {
        return document.as_array_mut();
    }
    document.get_mut("nodes").and_then(Value::as_array_mut)
}

#[cfg(feature = "os-keyring")]
pub fn read_legacy_key() -> Result<Option<[u8; 32]>, String> {
    match KeyringStore.get(LEGACY_KEY_ACCOUNT) {
        Ok(Some(encoded)) => Ok(decode_key(&encoded)),
        Ok(None) => Ok(None),
        Err(failure) => Err(move_failure(failure)),
    }
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

fn open(key: &[u8; 32], payload: &str) -> Option<String> {
    let packed = STANDARD.decode(payload).ok()?;
    if packed.len() <= 12 {
        return None;
    }
    let (nonce_bytes, ciphertext) = packed.split_at(12);
    let key = Key::<Aes256Gcm>::try_from(key.as_slice()).ok()?;
    let cipher = Aes256Gcm::new(&key);
    let nonce = Nonce::try_from(nonce_bytes).ok()?;
    let plain = cipher.decrypt(&nonce, ciphertext).ok()?;
    String::from_utf8(plain).ok()
}

#[cfg(test)]
fn seal(key: &[u8; 32], plaintext: &str) -> String {
    use aes_gcm::aead::Generate;
    let key = Key::<Aes256Gcm>::try_from(key.as_slice()).unwrap();
    let cipher = Aes256Gcm::new(&key);
    let nonce = Nonce::generate();
    let ciphertext = cipher.encrypt(&nonce, plaintext.as_bytes()).unwrap();
    let mut packed = Vec::with_capacity(nonce.len() + ciphertext.len());
    packed.extend_from_slice(&nonce);
    packed.extend_from_slice(&ciphertext);
    format!("{PREFIX}{}", STANDARD.encode(packed))
}

#[cfg(test)]
pub struct MemoryStore {
    available: bool,
    entries: std::cell::RefCell<HashMap<String, String>>,
}

#[cfg(test)]
impl MemoryStore {
    pub fn open() -> Self {
        Self {
            available: true,
            entries: std::cell::RefCell::new(HashMap::new()),
        }
    }

    pub fn closed() -> Self {
        Self {
            available: false,
            entries: std::cell::RefCell::new(HashMap::new()),
        }
    }

    fn has(&self, account: &str) -> bool {
        self.entries.borrow().contains_key(account)
    }
}

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, StoreFailure> {
        if !self.available {
            return Err(StoreFailure::Unavailable);
        }
        Ok(self.entries.borrow().get(account).cloned())
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), StoreFailure> {
        if !self.available {
            return Err(StoreFailure::Unavailable);
        }
        self.entries
            .borrow_mut()
            .insert(account.to_string(), secret.to_string());
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), StoreFailure> {
        if !self.available {
            return Err(StoreFailure::Unavailable);
        }
        self.entries.borrow_mut().remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(nodes: Value) -> Value {
        json!({
            "schemaVersion": 1,
            "settings": {},
            "nodes": nodes,
            "links": [],
            "ports": []
        })
    }

    #[test]
    fn a_new_password_leaves_the_document_and_enters_the_store() {
        let store = MemoryStore::open();
        let clean = seal_document(
            document(json!([{ "id": "node_a", "name": "A", "sshPass": "s3cret" }])),
            None,
            &HashMap::new(),
            &store,
            false,
        )
        .unwrap();
        let node = &clean["nodes"][0];
        assert!(node.get("sshPass").is_none());
        assert!(node.get("_encrypted").is_none());
        assert_eq!(node["sshSecret"]["type"], "password");
        assert_eq!(
            store.get("ssh/node_a/password").unwrap().as_deref(),
            Some("s3cret")
        );
        let body = serde_json::to_string(&clean).unwrap();
        assert!(!body.contains("s3cret"));
        assert!(!body.contains("_encrypted"));
        assert!(!body.contains("enc:v1:"));
    }

    #[test]
    fn an_empty_password_does_not_remove_a_saved_secret() {
        let store = MemoryStore::open();
        store.set("ssh/node_a/password", "kept").unwrap();
        let clean = seal_document(
            document(json!([{
                "id": "node_a",
                "sshPass": "",
                "sshSecret": { "type": "password" }
            }])),
            None,
            &HashMap::new(),
            &store,
            false,
        )
        .unwrap();
        assert_eq!(clean["nodes"][0]["sshSecret"]["type"], "password");
        assert_eq!(
            store.get("ssh/node_a/password").unwrap().as_deref(),
            Some("kept")
        );
    }

    #[test]
    fn clearing_a_secret_removes_it_from_the_store_and_the_marker() {
        let store = MemoryStore::open();
        store.set("ssh/node_a/password", "gone").unwrap();
        let clean = seal_document(
            document(json!([{
                "id": "node_a",
                "sshSecretClear": true,
                "sshSecret": { "type": "password" }
            }])),
            None,
            &HashMap::new(),
            &store,
            false,
        )
        .unwrap();
        assert!(clean["nodes"][0].get("sshSecret").is_none());
        assert!(clean["nodes"][0].get("sshSecretClear").is_none());
        assert!(store.get("ssh/node_a/password").unwrap().is_none());
    }

    #[test]
    fn a_closed_keyring_refuses_a_new_password_without_a_plaintext_document() {
        let store = MemoryStore::closed();
        let error = seal_document(
            document(json!([{ "id": "node_a", "sshPass": "s3cret" }])),
            None,
            &HashMap::new(),
            &store,
            false,
        )
        .unwrap_err();
        assert_eq!(
            error,
            "The system keyring is unavailable. The password was not saved."
        );
        assert!(!error.contains("s3cret"));
        assert!(!error.contains("_encrypted"));
        assert!(!store.has("ssh/node_a/password"));
    }

    #[test]
    fn a_password_already_in_the_file_is_not_rewritten_when_the_keyring_is_closed() {
        let store = MemoryStore::closed();
        let error = seal_document(
            document(json!([{ "id": "node_a", "sshPass": "s3cret" }])),
            None,
            &HashMap::new(),
            &store,
            true,
        )
        .unwrap_err();
        assert_eq!(
            error,
            "The system keyring is unavailable, so existing passwords cannot be moved out of the topology file. The file was not changed."
        );
        assert!(!error.contains("s3cret"));
        assert!(!store.has("ssh/node_a/password"));
    }

    #[test]
    fn a_marker_alone_can_be_saved_while_the_keyring_is_closed() {
        let store = MemoryStore::closed();
        let clean = seal_document(
            document(json!([{
                "id": "node_a",
                "name": "A",
                "sshSecret": { "type": "passphrase", "value": "should-not-stay" }
            }])),
            None,
            &HashMap::new(),
            &store,
            false,
        )
        .unwrap_err();
        // A value hiding inside the marker is still a secret and must be refused.
        assert!(clean.contains("keyring"));
        assert!(!clean.contains("should-not-stay"));
    }

    #[test]
    fn a_marker_without_a_value_does_not_need_the_keyring() {
        let store = MemoryStore::closed();
        let clean = seal_document(
            document(json!([{
                "id": "node_a",
                "sshSecret": { "type": "password" }
            }])),
            None,
            &HashMap::new(),
            &store,
            false,
        )
        .unwrap();
        assert_eq!(clean["nodes"][0]["sshSecret"]["type"], "password");
        assert!(clean["nodes"][0].get("sshPass").is_none());
    }

    #[test]
    fn legacy_ciphertext_is_moved_and_not_left_in_the_document() {
        let key = [9u8; 32];
        let stored = seal(&key, "legacy-secret");
        let store = MemoryStore::open();
        store
            .set(LEGACY_KEY_ACCOUNT, &STANDARD.encode(key))
            .unwrap();
        let clean = seal_document(
            document(json!([{
                "id": "node_a",
                "sshPass": stored,
                "_encrypted": true
            }])),
            None,
            &HashMap::new(),
            &store,
            false,
        )
        .unwrap();
        assert!(clean["nodes"][0].get("sshPass").is_none());
        assert!(clean["nodes"][0].get("_encrypted").is_none());
        assert_eq!(clean["nodes"][0]["sshSecret"]["type"], "password");
        assert_eq!(
            store.get("ssh/node_a/password").unwrap().as_deref(),
            Some("legacy-secret")
        );
        let body = serde_json::to_string(&clean).unwrap();
        assert!(!body.contains("legacy-secret"));
        assert!(!body.contains("enc:v1:"));
    }

    #[test]
    fn unknown_ciphertext_is_refused_and_not_stored_as_plaintext() {
        let store = MemoryStore::open();
        let error = seal_document(
            document(json!([{
                "id": "node_a",
                "sshPass": "electron-blob",
                "_encrypted": true
            }])),
            None,
            &HashMap::new(),
            &store,
            false,
        )
        .unwrap_err();
        assert!(error.contains("unknown encryption format"));
        assert!(!error.contains("electron-blob"));
        assert!(!store.has("ssh/node_a/password"));
    }

    #[test]
    fn removing_a_node_deletes_its_secret() {
        let store = MemoryStore::open();
        store.set("ssh/node_a/password", "gone").unwrap();
        let previous = document(json!([{
            "id": "node_a",
            "sshSecret": { "type": "password" }
        }]));
        let clean = seal_document(
            document(json!([])),
            Some(&previous),
            &HashMap::new(),
            &store,
            false,
        )
        .unwrap();
        assert!(clean["nodes"].as_array().unwrap().is_empty());
        assert!(store.get("ssh/node_a/password").unwrap().is_none());
    }

    #[test]
    fn a_passphrase_replaces_a_password() {
        let store = MemoryStore::open();
        store.set("ssh/node_a/password", "old").unwrap();
        let clean = seal_document(
            document(json!([{
                "id": "node_a",
                "sshAuth": "key",
                "sshPassphrase": "phrase"
            }])),
            None,
            &HashMap::new(),
            &store,
            false,
        )
        .unwrap();
        assert_eq!(clean["nodes"][0]["sshSecret"]["type"], "passphrase");
        assert!(clean["nodes"][0].get("sshPassphrase").is_none());
        assert!(store.get("ssh/node_a/password").unwrap().is_none());
        assert_eq!(
            store.get("ssh/node_a/passphrase").unwrap().as_deref(),
            Some("phrase")
        );
    }

    #[test]
    fn export_keeps_the_type_and_drops_the_secret() {
        let mut exported = document(json!([{
            "id": "node_a",
            "sshPass": "s3cret",
            "_encrypted": false,
            "sshSecret": { "type": "password", "value": "s3cret" }
        }]));
        strip_for_export(&mut exported);
        let body = serde_json::to_string(&exported).unwrap();
        assert!(!body.contains("s3cret"));
        assert!(!body.contains("_encrypted"));
        assert_eq!(exported["nodes"][0]["sshSecret"]["type"], "password");
        assert!(exported["nodes"][0]["sshSecret"].get("value").is_none());
    }

    #[test]
    fn a_failed_second_secret_rolls_back_the_first() {
        let store = RollbackStore::default();
        let error = seal_document(
            document(json!([
                { "id": "node_a", "sshPass": "first" },
                { "id": "node_b", "sshPass": "second" }
            ])),
            None,
            &HashMap::new(),
            &store,
            false,
        )
        .unwrap_err();
        assert!(error.contains("keyring"));
        assert!(store.get("ssh/node_a/password").unwrap().is_none());
        assert!(!error.contains("first"));
        assert!(!error.contains("second"));
    }

    #[derive(Default)]
    struct RollbackStore {
        entries: std::cell::RefCell<HashMap<String, String>>,
    }

    impl SecretStore for RollbackStore {
        fn get(&self, account: &str) -> Result<Option<String>, StoreFailure> {
            Ok(self.entries.borrow().get(account).cloned())
        }

        fn set(&self, account: &str, secret: &str) -> Result<(), StoreFailure> {
            if account.ends_with("node_b/password") {
                return Err(StoreFailure::Unavailable);
            }
            self.entries
                .borrow_mut()
                .insert(account.to_string(), secret.to_string());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), StoreFailure> {
            self.entries.borrow_mut().remove(account);
            Ok(())
        }
    }
}
