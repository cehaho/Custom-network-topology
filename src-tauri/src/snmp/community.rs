//! SNMP community strings live in the OS keyring, like SSH secrets.
//!
//! Account: `snmp/<node id>/community` in the same keyring service as
//! `secrets.rs`. The document only keeps the marker
//! `snmpSecret: { "type": "community" }`. The renderer sends a new value as
//! `snmpCommunity` (or a hand-edited file holds `snmp.community`); a save moves
//! it into the keyring and removes it from the document. `snmpCommunityClear`
//! deletes the saved value. Exports keep the marker and never the value.

use std::collections::HashSet;

use serde_json::{Map, Value, json};

use crate::secrets::{SecretStore, StoreFailure};

pub const MARKER_FIELD: &str = "snmpSecret";
pub const VALUE_FIELD: &str = "snmpCommunity";
pub const CLEAR_FIELD: &str = "snmpCommunityClear";
const MARKER_TYPE: &str = "community";
const MAX_COMMUNITY_BYTES: usize = 255;

pub fn account(node_id: &str) -> String {
    format!("snmp/{node_id}/community")
}

/// True when a community value (not only the marker) is in this node.
pub fn has_value(node: &Map<String, Value>) -> bool {
    plain_value(node).is_some()
}

/// Backup copies and exports: drop the value, keep (or add) the marker.
pub fn scrub(node: &mut Map<String, Value>) {
    let saved = has_value(node) || has_marker(node);
    remove_values(node);
    if saved {
        node.insert(MARKER_FIELD.to_string(), marker());
    }
}

/// Import: a value found in the imported file is dropped and must be typed
/// again. A marker alone is kept.
pub fn drop_imported(node: &mut Map<String, Value>) {
    let had_value = has_value(node);
    remove_values(node);
    if had_value {
        node.remove(MARKER_FIELD);
    }
}

/// Moves new community values into the store and leaves only markers in the
/// document. The returned undo log restores the store if a later step of the
/// same save fails.
pub fn seal(
    document: &mut Value,
    previous: Option<&Value>,
    store: &dyn SecretStore,
) -> Result<Undo, String> {
    let previous_marked = marked_ids(previous);
    let Some(nodes) = document.get_mut("nodes").and_then(Value::as_array_mut) else {
        return Ok(Undo(Vec::new()));
    };
    let mut ops: Vec<(String, Option<String>)> = Vec::new();
    let mut kept = HashSet::new();
    let mut markers = Vec::new();
    for (index, node) in nodes.iter().enumerate() {
        let Some(object) = node.as_object() else {
            continue;
        };
        let id = object.get("id").and_then(Value::as_str).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        kept.insert(id.to_string());
        let saved = if object.get(CLEAR_FIELD).and_then(Value::as_bool) == Some(true) {
            if is_safe_node_id(id) {
                ops.push((account(id), None));
            }
            false
        } else if let Some(value) = plain_value(object) {
            if !is_safe_node_id(id) {
                return Err(
                    "This node id cannot be used as a keyring entry. The SNMP community was not saved."
                        .to_string(),
                );
            }
            validate(&value)?;
            ops.push((account(id), Some(value)));
            true
        } else {
            has_marker(object) || previous_marked.contains(id)
        };
        markers.push((index, saved));
    }
    for id in &previous_marked {
        if !kept.contains(id) && is_safe_node_id(id) {
            ops.push((account(id), None));
        }
    }

    let undo = apply(store, &ops)?;

    for (index, saved) in markers {
        let Some(object) = nodes.get_mut(index).and_then(Value::as_object_mut) else {
            continue;
        };
        remove_values(object);
        if saved {
            object.insert(MARKER_FIELD.to_string(), marker());
        } else {
            object.remove(MARKER_FIELD);
        }
    }
    Ok(undo)
}

#[derive(Debug)]
pub struct Undo(Vec<(String, Option<String>)>);

pub fn undo(store: &dyn SecretStore, log: &Undo) {
    restore(store, &log.0);
}

#[cfg(feature = "os-keyring")]
pub fn lookup(node_id: &str) -> Result<Option<String>, String> {
    if !is_safe_node_id(node_id) {
        return Ok(None);
    }
    match crate::secrets::KeyringStore.get(&account(node_id)) {
        Ok(value) => Ok(value),
        Err(StoreFailure::TimedOut) => Err(
            "The system keyring did not respond. The saved SNMP community cannot be read."
                .to_string(),
        ),
        Err(StoreFailure::Unavailable) => Err(
            "The system keyring is unavailable. The saved SNMP community cannot be read."
                .to_string(),
        ),
    }
}

fn apply(
    store: &dyn SecretStore,
    ops: &[(String, Option<String>)],
) -> Result<Undo, String> {
    let mut done = Vec::new();
    for (account, value) in ops {
        let previous = match store.get(account) {
            Ok(previous) => previous,
            Err(failure) => {
                restore(store, &done);
                return Err(failure_message(failure, value.is_some()));
            }
        };
        let result = match value {
            Some(value) => store.set(account, value),
            None => store.delete(account),
        };
        if let Err(failure) = result {
            restore(store, &done);
            return Err(failure_message(failure, value.is_some()));
        }
        done.push((account.clone(), previous));
    }
    Ok(Undo(done))
}

fn restore(store: &dyn SecretStore, done: &[(String, Option<String>)]) {
    for (account, previous) in done.iter().rev() {
        let _ = match previous {
            Some(value) => store.set(account, value),
            None => store.delete(account),
        };
    }
}

fn failure_message(failure: StoreFailure, saving: bool) -> String {
    let keyring = match failure {
        StoreFailure::TimedOut => "The system keyring did not respond.",
        StoreFailure::Unavailable => "The system keyring is unavailable.",
    };
    if saving {
        format!("{keyring} The SNMP community was not saved.")
    } else {
        format!(
            "{keyring} The saved SNMP community could not be removed, so the topology file was not changed."
        )
    }
}

fn validate(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_COMMUNITY_BYTES || value.contains('\0') {
        return Err(
            "The SNMP community must be 1 to 255 bytes. It was not saved.".to_string(),
        );
    }
    Ok(())
}

fn plain_value(node: &Map<String, Value>) -> Option<String> {
    let candidates = [
        node.get(VALUE_FIELD),
        node.get("snmp").and_then(|snmp| snmp.get("community")),
        node.get(MARKER_FIELD).and_then(|marker| marker.get("value")),
    ];
    candidates
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .find(|value| !value.is_empty())
        .map(str::to_string)
}

fn has_marker(node: &Map<String, Value>) -> bool {
    node.get(MARKER_FIELD)
        .and_then(|marker| marker.get("type"))
        .and_then(Value::as_str)
        == Some(MARKER_TYPE)
}

fn remove_values(node: &mut Map<String, Value>) {
    node.remove(VALUE_FIELD);
    node.remove(CLEAR_FIELD);
    if let Some(snmp) = node.get_mut("snmp").and_then(Value::as_object_mut) {
        snmp.remove("community");
    }
    if node.contains_key(MARKER_FIELD) {
        if has_marker(node) {
            node.insert(MARKER_FIELD.to_string(), marker());
        } else {
            node.remove(MARKER_FIELD);
        }
    }
}

fn marked_ids(previous: Option<&Value>) -> HashSet<String> {
    previous
        .and_then(|document| document.get("nodes"))
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(Value::as_object)
                .filter(|node| has_marker(node) || has_value(node))
                .filter_map(|node| node.get("id").and_then(Value::as_str))
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn marker() -> Value {
    json!({ "type": MARKER_TYPE })
}

fn is_safe_node_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (1..=128).contains(&bytes.len()) && bytes.iter().all(|byte| !byte.is_ascii_control())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryStore;

    fn document(nodes: Value) -> Value {
        json!({ "schemaVersion": 1, "nodes": nodes, "links": [], "ports": [] })
    }

    #[test]
    fn a_new_community_enters_the_store_and_leaves_the_document() {
        let store = MemoryStore::open();
        let mut doc = document(json!([{
            "id": "sw1",
            "snmp": { "enabled": true, "port": 161, "version": "2c" },
            "snmpCommunity": "s3cret"
        }]));
        seal(&mut doc, None, &store).unwrap();
        assert_eq!(store.get("snmp/sw1/community").unwrap().as_deref(), Some("s3cret"));
        let body = doc.to_string();
        assert!(!body.contains("s3cret"));
        assert_eq!(doc["nodes"][0]["snmpSecret"]["type"], "community");
        assert!(doc["nodes"][0].get("snmpCommunity").is_none());
    }

    #[test]
    fn a_community_typed_in_the_file_is_moved() {
        let store = MemoryStore::open();
        let mut doc = document(json!([{ "id": "sw1", "snmp": { "enabled": true, "community": "public" } }]));
        seal(&mut doc, None, &store).unwrap();
        assert_eq!(store.get("snmp/sw1/community").unwrap().as_deref(), Some("public"));
        assert!(doc["nodes"][0]["snmp"].get("community").is_none());
        assert_eq!(doc["nodes"][0]["snmpSecret"]["type"], "community");
    }

    #[test]
    fn a_marker_alone_keeps_the_saved_value_without_touching_the_store() {
        let store = MemoryStore::closed();
        let mut doc = document(json!([{ "id": "sw1", "snmpSecret": { "type": "community" } }]));
        seal(&mut doc, None, &store).unwrap();
        assert_eq!(doc["nodes"][0]["snmpSecret"]["type"], "community");
    }

    #[test]
    fn clearing_removes_the_value_and_the_marker() {
        let store = MemoryStore::open();
        store.set("snmp/sw1/community", "old").unwrap();
        let mut doc = document(json!([{ "id": "sw1", "snmpCommunityClear": true, "snmpSecret": { "type": "community" } }]));
        seal(&mut doc, None, &store).unwrap();
        assert_eq!(store.get("snmp/sw1/community").unwrap(), None);
        assert!(doc["nodes"][0].get("snmpSecret").is_none());
        assert!(doc["nodes"][0].get("snmpCommunityClear").is_none());
    }

    #[test]
    fn removing_a_node_deletes_its_community() {
        let store = MemoryStore::open();
        store.set("snmp/gone/community", "old").unwrap();
        let previous = document(json!([{ "id": "gone", "snmpSecret": { "type": "community" } }]));
        let mut doc = document(json!([]));
        seal(&mut doc, Some(&previous), &store).unwrap();
        assert_eq!(store.get("snmp/gone/community").unwrap(), None);
    }

    #[test]
    fn a_closed_keyring_refuses_a_new_community() {
        let store = MemoryStore::closed();
        let mut doc = document(json!([{ "id": "sw1", "snmpCommunity": "s3cret" }]));
        let error = seal(&mut doc, None, &store).unwrap_err();
        assert!(error.contains("SNMP community was not saved"));
    }

    #[test]
    fn undo_restores_the_previous_value() {
        let store = MemoryStore::open();
        store.set("snmp/sw1/community", "old").unwrap();
        let mut doc = document(json!([{ "id": "sw1", "snmpCommunity": "new" }]));
        let log = seal(&mut doc, None, &store).unwrap();
        assert_eq!(store.get("snmp/sw1/community").unwrap().as_deref(), Some("new"));
        undo(&store, &log);
        assert_eq!(store.get("snmp/sw1/community").unwrap().as_deref(), Some("old"));
    }

    #[test]
    fn export_scrub_keeps_the_marker_and_import_drops_the_value() {
        let mut node = json!({ "id": "a", "snmpCommunity": "x", "snmp": { "community": "y" } })
            .as_object()
            .unwrap()
            .clone();
        let mut exported = node.clone();
        scrub(&mut exported);
        assert_eq!(exported["snmpSecret"], json!({ "type": "community" }));
        assert!(!Value::Object(exported).to_string().contains("\"x\""));
        drop_imported(&mut node);
        assert!(node.get("snmpSecret").is_none());
        assert!(node.get("snmpCommunity").is_none());
        assert!(node["snmp"].get("community").is_none());
    }

    /// Refuses every SSH account; SNMP accounts work.
    struct SshClosed(MemoryStore);

    impl SecretStore for SshClosed {
        fn get(&self, account: &str) -> Result<Option<String>, StoreFailure> {
            self.0.get(account)
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), StoreFailure> {
            if account.starts_with("ssh/") {
                return Err(StoreFailure::Unavailable);
            }
            self.0.set(account, secret)
        }
        fn delete(&self, account: &str) -> Result<(), StoreFailure> {
            self.0.delete(account)
        }
    }

    #[test]
    fn a_full_save_stores_ssh_and_snmp_secrets_side_by_side() {
        let store = MemoryStore::open();
        let doc = document(json!([{
            "id": "sw1",
            "sshPass": "ssh-pw",
            "snmpCommunity": "snmp-c"
        }]));
        let clean = crate::secrets::seal_document(
            doc,
            None,
            &std::collections::HashMap::new(),
            &store,
            false,
        )
        .unwrap();
        assert_eq!(store.get("ssh/sw1/password").unwrap().as_deref(), Some("ssh-pw"));
        assert_eq!(store.get("snmp/sw1/community").unwrap().as_deref(), Some("snmp-c"));
        let body = clean.to_string();
        assert!(!body.contains("ssh-pw") && !body.contains("snmp-c"));
        assert!(!crate::secrets::contains_secret_values(&clean));
    }

    #[test]
    fn a_failed_ssh_secret_rolls_back_the_community() {
        let store = SshClosed(MemoryStore::open());
        store.0.set("snmp/sw1/community", "old").unwrap();
        let doc = document(json!([{ "id": "sw1", "sshPass": "pw", "snmpCommunity": "new" }]));
        let result = crate::secrets::seal_document(
            doc,
            None,
            &std::collections::HashMap::new(),
            &store,
            false,
        );
        assert!(result.is_err());
        assert_eq!(store.get("snmp/sw1/community").unwrap().as_deref(), Some("old"));
    }

    #[test]
    fn export_and_import_go_through_the_secrets_helpers() {
        let mut doc = document(json!([{ "id": "sw1", "snmpCommunity": "c", "snmpSecret": { "type": "community" } }]));
        assert!(crate::secrets::contains_secret_values(&doc));
        crate::secrets::strip_for_export(&mut doc);
        assert_eq!(doc["nodes"][0]["snmpSecret"], json!({ "type": "community" }));
        assert!(doc["nodes"][0].get("snmpCommunity").is_none());

        let mut imported = document(json!([{ "id": "sw1", "snmp": { "enabled": true, "community": "c" } }]));
        let pending = crate::secrets::take_secret_values(&mut imported, None).unwrap();
        assert!(pending.is_empty());
        assert!(imported["nodes"][0]["snmp"].get("community").is_none());
        assert!(imported["nodes"][0].get("snmpSecret").is_none());
    }

    #[test]
    fn an_oversized_community_is_refused() {
        let store = MemoryStore::open();
        let mut doc = document(json!([{ "id": "sw1", "snmpCommunity": "x".repeat(256) }]));
        assert!(seal(&mut doc, None, &store).is_err());
        assert_eq!(store.get("snmp/sw1/community").unwrap(), None);
    }
}
