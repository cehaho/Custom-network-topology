//! SNMP fields of the topology document.
//!
//! Keep this aligned with `normalizeSnmp` / `normalizeLinkSnmp` in
//! `renderer/js/topology.js`.
//!
//! Node: `snmp: { enabled, port, version: "2c" }`, plus the secret marker
//! `snmpSecret: { type: "community" }` (see `community.rs`). The community
//! itself never stays in the document.
//!
//! Link: `snmpIfIndex` (ifIndex) or `snmpIfName` (ifName / ifDescr), and
//! optionally `snmpNodeId`, the endpoint that owns that interface.

use serde_json::{Map, Value, json};

pub const DEFAULT_PORT: u64 = 161;
pub const MAX_IF_NAME: usize = 64;
pub const MAX_IF_INDEX: u64 = 2_147_483_647;

pub fn normalize_node(node: &mut Map<String, Value>) {
    if let Some(value) = node.get("snmp") {
        match value {
            Value::Object(snmp) => {
                let normalized = normalize_settings(snmp);
                node.insert("snmp".to_string(), normalized);
            }
            _ => {
                node.remove("snmp");
            }
        }
    }
    if node
        .get(super::community::MARKER_FIELD)
        .is_some_and(|marker| marker.get("type").and_then(Value::as_str) != Some("community"))
    {
        node.remove(super::community::MARKER_FIELD);
    }
    if node
        .get(super::community::VALUE_FIELD)
        .is_some_and(|value| !value.is_string())
    {
        node.remove(super::community::VALUE_FIELD);
    }
    if node
        .get(super::community::CLEAR_FIELD)
        .is_some_and(|value| value.as_bool() != Some(true))
    {
        node.remove(super::community::CLEAR_FIELD);
    }
}

fn normalize_settings(snmp: &Map<String, Value>) -> Value {
    let enabled = snmp.get("enabled").and_then(Value::as_bool) == Some(true);
    let port = snmp
        .get("port")
        .and_then(Value::as_u64)
        .filter(|port| (1..=65535).contains(port))
        .unwrap_or(DEFAULT_PORT);
    let mut normalized = json!({ "enabled": enabled, "port": port, "version": "2c" });
    // A plain community typed into the file is kept until the save moves it
    // into the keyring.
    if let Some(community) = snmp.get("community").and_then(Value::as_str) {
        if !community.is_empty() {
            normalized["community"] = json!(community);
        }
    }
    normalized
}

pub fn normalize_link(link: &mut Map<String, Value>) {
    match link.get("snmpIfIndex").map(if_index) {
        Some(Some(index)) => {
            link.insert("snmpIfIndex".to_string(), json!(index));
        }
        Some(None) => {
            link.remove("snmpIfIndex");
        }
        None => {}
    }
    match link.get("snmpIfName").map(if_name) {
        Some(Some(name)) => {
            link.insert("snmpIfName".to_string(), json!(name));
        }
        Some(None) => {
            link.remove("snmpIfName");
        }
        None => {}
    }
    if let Some(owner) = link.get("snmpNodeId") {
        let owner = owner.as_str().unwrap_or("");
        let source = link.get("sourceNodeId").and_then(Value::as_str).unwrap_or("");
        let target = link.get("targetNodeId").and_then(Value::as_str).unwrap_or("");
        if owner.is_empty() || (owner != source && owner != target) {
            link.remove("snmpNodeId");
        }
    }
}

fn if_index(value: &Value) -> Option<u64> {
    let index = match value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.trim().parse::<u64>().ok(),
        _ => None,
    }?;
    (1..=MAX_IF_INDEX).contains(&index).then_some(index)
}

fn if_name(value: &Value) -> Option<String> {
    let name = value.as_str()?.trim();
    if name.is_empty()
        || name.chars().count() > MAX_IF_NAME
        || name.chars().any(char::is_control)
    {
        return None;
    }
    Some(name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn node_settings_get_defaults_and_drop_unknown_keys() {
        let mut node = object(json!({
            "id": "a",
            "snmp": { "enabled": true, "port": 99999, "version": "3", "extra": 1 },
            "snmpSecret": { "type": "community" }
        }));
        normalize_node(&mut node);
        assert_eq!(node["snmp"], json!({ "enabled": true, "port": 161, "version": "2c" }));
        assert_eq!(node["snmpSecret"]["type"], "community");
    }

    #[test]
    fn a_bad_snmp_value_or_marker_is_removed() {
        let mut node = object(json!({
            "id": "a",
            "snmp": true,
            "snmpSecret": { "type": "password" },
            "snmpCommunity": 12,
            "snmpCommunityClear": "yes"
        }));
        normalize_node(&mut node);
        assert!(node.get("snmp").is_none());
        assert!(node.get("snmpSecret").is_none());
        assert!(node.get("snmpCommunity").is_none());
        assert!(node.get("snmpCommunityClear").is_none());
    }

    #[test]
    fn a_plain_community_survives_until_the_save_seals_it() {
        let mut node = object(json!({ "snmp": { "enabled": true, "community": "public", "port": 1161 } }));
        normalize_node(&mut node);
        assert_eq!(node["snmp"]["community"], "public");
        assert_eq!(node["snmp"]["port"], 1161);
    }

    #[test]
    fn link_interface_fields_are_checked() {
        let mut link = object(json!({
            "sourceNodeId": "a",
            "targetNodeId": "b",
            "snmpIfIndex": "12",
            "snmpIfName": "  ge-0/0/1 ",
            "snmpNodeId": "b"
        }));
        normalize_link(&mut link);
        assert_eq!(link["snmpIfIndex"], 12);
        assert_eq!(link["snmpIfName"], "ge-0/0/1");
        assert_eq!(link["snmpNodeId"], "b");

        let mut link = object(json!({
            "sourceNodeId": "a",
            "targetNodeId": "b",
            "snmpIfIndex": 0,
            "snmpIfName": "",
            "snmpNodeId": "c"
        }));
        normalize_link(&mut link);
        assert!(link.get("snmpIfIndex").is_none());
        assert!(link.get("snmpIfName").is_none());
        assert!(link.get("snmpNodeId").is_none());
    }
}
