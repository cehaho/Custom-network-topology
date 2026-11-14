//! Topology document shared by the canvas and the admin table.
//!
//! Keep this aligned with `renderer/js/topology.js`. A legacy file (parent ids
//! or `connections`) is accepted on read. The object written back is
//! `schemaVersion`, `settings`, `nodes`, `links`, and `ports`.

use serde_json::{Map, Value, json};

pub const SCHEMA_VERSION: i64 = 1;

const RUNTIME_FIELDS: &[&str] = &["status", "uptime", "activeParentId", "level", "responseTime", "probeDetail"];
const PARENT_FIELDS: &[&str] = &["primaryParentId", "secondaryParentId"];

pub fn empty_document() -> Value {
    json!({
        "schemaVersion": SCHEMA_VERSION,
        "settings": default_settings(),
        "nodes": [],
        "links": [],
        "ports": []
    })
}

pub fn read_document(value: Value) -> Result<Value, String> {
    validate_incoming(&value)?;
    Ok(migrate(value))
}

fn default_settings() -> Value {
    json!({
        "showGrid": true,
        "gridSize": 100,
        "snapToGrid": true,
        "theme": "dark",
        "probeIntervalMs": 5000,
        "confirmations": 2
    })
}

fn validate_incoming(value: &Value) -> Result<(), String> {
    if let Value::Array(nodes) = value {
        if nodes.iter().all(Value::is_object) {
            return nodes.iter().try_for_each(crate::probe_kinds::check_node);
        }
        return Err("Configuration nodes must be objects".to_string());
    }
    let Value::Object(map) = value else {
        return Err("Configuration must be a JSON object".to_string());
    };
    let Some(nodes) = map.get("nodes") else {
        return Err("Configuration has no nodes".to_string());
    };
    let Value::Array(nodes) = nodes else {
        return Err("Configuration nodes must be an array".to_string());
    };
    if !nodes.iter().all(Value::is_object) {
        return Err("Configuration nodes must be objects".to_string());
    }
    for node in nodes {
        crate::probe_kinds::check_node(node)?;
    }
    if let Some(version) = map.get("schemaVersion") {
        if version.as_i64() != Some(SCHEMA_VERSION) {
            return Err(format!("Unsupported topology version: {version}"));
        }
    }
    require_array(map, "links")?;
    require_array(map, "connections")?;
    require_array(map, "ports")?;
    for key in ["links", "connections"] {
        if let Some(Value::Array(links)) = map.get(key) {
            if !links.iter().all(Value::is_object) {
                return Err("Configuration links must be objects".to_string());
            }
        }
    }
    Ok(())
}

fn require_array(map: &Map<String, Value>, key: &str) -> Result<(), String> {
    match map.get(key) {
        None | Some(Value::Array(_)) => Ok(()),
        Some(_) if key == "links" || key == "connections" => {
            Err(format!("Configuration {key} must be an array"))
        }
        Some(_) => Err("Configuration ports must be an array".to_string()),
    }
}

fn migrate(value: Value) -> Value {
    let source = if let Value::Array(nodes) = value.clone() {
        json!({ "nodes": nodes })
    } else {
        value.clone()
    };
    let raw_ports = value.get("ports").cloned().unwrap_or(Value::Array(Vec::new()));
    let mut nodes = source
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for (index, node) in nodes.iter_mut().enumerate() {
        let Some(object) = node.as_object_mut() else {
            continue;
        };
        if object.get("id").and_then(Value::as_str).unwrap_or("").is_empty() {
            object.insert("id".to_string(), json!(format!("node_migrated_{index}")));
        }
    }

    attach_detached_ports(&mut nodes, &raw_ports);

    for node in &mut nodes {
        let Some(object) = node.as_object_mut() else {
            continue;
        };
        ensure_default_ports(object);
        crate::probe_kinds::normalize_node(object);
        if let Some(Value::Array(ports)) = object.get("ports").cloned() {
            let normalized = ports.iter().filter_map(normalize_port).collect();
            object.insert("ports".to_string(), Value::Array(normalized));
        }
    }

    let mut links = Vec::new();
    for key in ["links", "connections"] {
        if let Some(Value::Array(raw_links)) = value.get(key) {
            for raw_link in raw_links {
                if let Some(link) = normalize_link(raw_link) {
                    let id = link.get("id").and_then(Value::as_str).unwrap_or("");
                    if links.iter().any(|existing: &Value| {
                        existing.get("id").and_then(Value::as_str) == Some(id)
                    }) {
                        continue;
                    }
                    links.push(link);
                }
            }
        }
    }

    let planned: Vec<(String, Value, Value)> = nodes
        .iter()
        .filter_map(|node| {
            let object = node.as_object()?;
            let id = object.get("id")?.as_str()?.to_string();
            let primary = object.get("primaryParentId").cloned().unwrap_or(Value::Null);
            let secondary = object.get("secondaryParentId").cloned().unwrap_or(Value::Null);
            Some((id, primary, secondary))
        })
        .collect();
    for (id, primary, secondary) in planned {
        migrate_parent(&mut links, &mut nodes, &id, "primary", Some(&primary));
        migrate_parent(&mut links, &mut nodes, &id, "failover", Some(&secondary));
    }

    for node in &mut nodes {
        let Some(object) = node.as_object_mut() else {
            continue;
        };
        let id = object.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        for field in PARENT_FIELDS.iter().chain(RUNTIME_FIELDS.iter()) {
            object.remove(*field);
        }
        if let Some(primary_link) = parent_link_mut(&mut links, &id, "primary") {
            copy_if_empty(primary_link, "medium", object.get("linkType"));
            copy_if_empty(primary_link, "speed", object.get("linkSpeed"));
            object.remove("linkType");
            object.remove("linkSpeed");
        }
    }

    let settings = normalize_settings(source.get("settings"));
    let ports = collect_ports(&nodes);
    json!({
        "schemaVersion": SCHEMA_VERSION,
        "settings": settings,
        "nodes": nodes,
        "links": links,
        "ports": ports
    })
}

fn normalize_settings(value: Option<&Value>) -> Value {
    let mut settings = match default_settings() {
        Value::Object(map) => map,
        other => return other,
    };
    if let Some(Value::Object(source)) = value {
        for (key, item) in source {
            settings.insert(key.clone(), item.clone());
        }
    }
    let interval = crate::hosts::monitoring_interval(
        settings.get("probeIntervalMs").and_then(Value::as_f64),
    );
    let confirmations = crate::hosts::confirmation_count(
        settings.get("confirmations").and_then(Value::as_f64),
    );
    settings.insert("probeIntervalMs".to_string(), json!(interval));
    settings.insert("confirmations".to_string(), json!(confirmations));
    Value::Object(settings)
}

fn attach_detached_ports(nodes: &mut [Value], ports: &Value) {
    let Value::Array(ports) = ports else {
        return;
    };
    for node in nodes {
        let Some(object) = node.as_object_mut() else {
            continue;
        };
        if object
            .get("ports")
            .and_then(Value::as_array)
            .is_some_and(|list| !list.is_empty())
        {
            continue;
        }
        let id = object.get("id").and_then(Value::as_str).unwrap_or("");
        let attached: Vec<Value> = ports
            .iter()
            .filter(|port| port.get("nodeId").and_then(Value::as_str) == Some(id))
            .filter_map(|port| {
                let mut copy = port.as_object()?.clone();
                copy.remove("nodeId");
                Some(Value::Object(copy))
            })
            .collect();
        if !attached.is_empty() {
            object.insert("ports".to_string(), Value::Array(attached));
        }
    }
}

fn ensure_default_ports(node: &mut Map<String, Value>) {
    let missing = match node.get("ports") {
        Some(Value::Array(ports)) => ports.is_empty(),
        _ => true,
    };
    if !missing {
        return;
    }
    let id = node.get("id").and_then(Value::as_str).unwrap_or("node");
    node.insert(
        "ports".to_string(),
        json!([
            { "id": format!("{id}_in"), "name": "IN", "side": "top" },
            { "id": format!("{id}_out"), "name": "OUT", "side": "bottom" }
        ]),
    );
}

fn normalize_port(port: &Value) -> Option<Value> {
    let mut copy = port.as_object()?.clone();
    let id = copy.get("id").and_then(Value::as_str)?.to_string();
    if id.is_empty() {
        return None;
    }
    let name = copy
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or(id.as_str())
        .to_string();
    let side = copy
        .get("side")
        .and_then(Value::as_str)
        .filter(|side| !side.is_empty())
        .unwrap_or("bottom")
        .to_string();
    copy.insert("id".to_string(), Value::String(id));
    copy.insert("name".to_string(), Value::String(name));
    copy.insert("side".to_string(), Value::String(side));
    copy.remove("nodeId");
    Some(Value::Object(copy))
}

fn normalize_link(raw: &Value) -> Option<Value> {
    let mut link = raw.as_object()?.clone();
    let role = if link.get("role").and_then(Value::as_str) == Some("failover")
        || link.get("isFailover").and_then(Value::as_bool) == Some(true)
    {
        "failover"
    } else {
        "primary"
    };
    let medium = first_present(link.get("medium"), link.get("linkType"));
    let speed = first_present(link.get("speed"), link.get("linkSpeed"));
    link.remove("isFailover");
    link.remove("linkType");
    link.remove("linkSpeed");
    link.insert("role".to_string(), json!(role));
    link.insert("medium".to_string(), medium);
    link.insert("speed".to_string(), speed);
    let source = link
        .get("sourceNodeId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let target = link
        .get("targetNodeId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    link.insert("sourceNodeId".to_string(), Value::String(source));
    link.insert("targetNodeId".to_string(), Value::String(target.clone()));
    let id = link.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    if id.is_empty() {
        let fallback = if target.is_empty() {
            format!("link_x_{role}")
        } else {
            format!("link_{target}_{role}")
        };
        link.insert("id".to_string(), Value::String(fallback));
    }
    Some(Value::Object(link))
}

fn first_present(primary: Option<&Value>, fallback: Option<&Value>) -> Value {
    for candidate in [primary, fallback].into_iter().flatten() {
        if candidate.is_null() {
            continue;
        }
        if candidate.as_str().is_some_and(str::is_empty) {
            continue;
        }
        return candidate.clone();
    }
    Value::Null
}

fn migrate_parent(
    links: &mut Vec<Value>,
    nodes: &mut [Value],
    child_id: &str,
    role: &str,
    parent_id: Option<&Value>,
) {
    let Some(parent_id) = parent_id.and_then(Value::as_str) else {
        return;
    };
    if parent_id.is_empty() || parent_id == child_id {
        return;
    }
    if !nodes.iter().any(|node| node.get("id").and_then(Value::as_str) == Some(parent_id)) {
        return;
    }
    if links.iter().any(|link| same_cable(link, parent_id, child_id, role)) {
        return;
    }
    let Some(parent_index) = nodes
        .iter()
        .position(|node| node.get("id").and_then(Value::as_str) == Some(parent_id))
    else {
        return;
    };
    let Some(child_index) = nodes
        .iter()
        .position(|node| node.get("id").and_then(Value::as_str) == Some(child_id))
    else {
        return;
    };
    let source_port = ensure_port(
        nodes[parent_index].as_object_mut().expect("parent"),
        "bottom",
        "out",
        "OUT",
    );
    let target_port = ensure_port(
        nodes[child_index].as_object_mut().expect("child"),
        "top",
        "in",
        "IN",
    );
    let medium = if role == "primary" {
        first_present(nodes[child_index].get("linkType"), None)
    } else {
        Value::Null
    };
    let speed = if role == "primary" {
        first_present(nodes[child_index].get("linkSpeed"), None)
    } else {
        Value::Null
    };
    let id = unique_link_id(links, &format!("link_{child_id}_{role}"));
    links.push(json!({
        "id": id,
        "sourceNodeId": parent_id,
        "sourcePortId": source_port,
        "targetNodeId": child_id,
        "targetPortId": target_port,
        "role": role,
        "medium": medium,
        "speed": speed
    }));
}

fn same_cable(link: &Value, parent_id: &str, child_id: &str, role: &str) -> bool {
    if link.get("role").and_then(Value::as_str) != Some(role) {
        return false;
    }
    let source = link.get("sourceNodeId").and_then(Value::as_str).unwrap_or("");
    let target = link.get("targetNodeId").and_then(Value::as_str).unwrap_or("");
    (source == parent_id && target == child_id) || (source == child_id && target == parent_id)
}

fn ensure_port(node: &mut Map<String, Value>, side: &str, suffix: &str, name: &str) -> String {
    if let Some(Value::Array(ports)) = node.get("ports") {
        if let Some(id) = ports.iter().find_map(|port| {
            if port.get("side").and_then(Value::as_str) != Some(side) {
                return None;
            }
            port.get("id").and_then(Value::as_str).filter(|id| !id.is_empty())
        }) {
            return id.to_string();
        }
    }
    let node_id = node.get("id").and_then(Value::as_str).unwrap_or("node");
    let id = format!("{node_id}_{suffix}");
    let ports = node
        .entry("ports".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    if let Value::Array(list) = ports {
        if !list.iter().any(|port| port.get("id").and_then(Value::as_str) == Some(id.as_str())) {
            list.push(json!({ "id": id, "name": name, "side": side }));
        }
    }
    id
}

fn unique_link_id(links: &[Value], base: &str) -> String {
    if !links.iter().any(|link| link.get("id").and_then(Value::as_str) == Some(base)) {
        return base.to_string();
    }
    let mut suffix = 2;
    loop {
        let candidate = format!("{base}_{suffix}");
        if !links
            .iter()
            .any(|link| link.get("id").and_then(Value::as_str) == Some(candidate.as_str()))
        {
            return candidate;
        }
        suffix += 1;
    }
}

fn parent_link_mut<'a>(links: &'a mut [Value], child_id: &str, role: &str) -> Option<&'a mut Value> {
    let canonical = format!("link_{child_id}_{role}");
    if let Some(index) = links.iter().position(|link| {
        link.get("id").and_then(Value::as_str) == Some(canonical.as_str())
            && link.get("targetNodeId").and_then(Value::as_str) == Some(child_id)
            && link.get("role").and_then(Value::as_str) == Some(role)
    }) {
        return links.get_mut(index);
    }
    let index = links.iter().position(|link| {
        link.get("targetNodeId").and_then(Value::as_str) == Some(child_id)
            && link.get("role").and_then(Value::as_str) == Some(role)
    })?;
    links.get_mut(index)
}

fn copy_if_empty(link: &mut Value, key: &str, fallback: Option<&Value>) {
    let empty = match link.get(key) {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => text.is_empty(),
        Some(_) => false,
    };
    if empty {
        if let Some(value) = fallback {
            if !value.is_null() && !value.as_str().is_some_and(str::is_empty) {
                link.as_object_mut()
                    .expect("link")
                    .insert(key.to_string(), value.clone());
            }
        }
    }
}

fn collect_ports(nodes: &[Value]) -> Vec<Value> {
    let mut ports = Vec::new();
    for node in nodes {
        let Some(node_id) = node.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(list) = node.get("ports").and_then(Value::as_array) else {
            continue;
        };
        for port in list {
            let Some(mut copy) = port.as_object().cloned() else {
                continue;
            };
            if copy.get("id").and_then(Value::as_str).unwrap_or("").is_empty() {
                continue;
            }
            copy.insert("nodeId".to_string(), Value::String(node_id.to_string()));
            ports.push(Value::Object(copy));
        }
    }
    ports
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_parents_become_stable_links_and_keep_drawn_cables() {
        let legacy = json!({
            "settings": { "showGrid": true, "gridSize": 100 },
            "nodes": [
                {
                    "id": "node_gateway",
                    "name": "Gateway Router",
                    "primaryParentId": null,
                    "secondaryParentId": null
                },
                {
                    "id": "node_nas",
                    "name": "NAS Storage",
                    "primaryParentId": "node_gateway",
                    "secondaryParentId": "node_gateway",
                    "linkType": "RJ45",
                    "linkSpeed": "1G",
                    "isContainer": true,
                    "containerType": "proxmox",
                    "zones": [{ "id": "zone_lan", "name": "LAN" }],
                    "expanded": false,
                    "ports": [{ "id": "node_nas_wan", "name": "WAN", "side": "top" }]
                }
            ],
            "connections": [{
                "id": "mouse_1",
                "sourceNodeId": "node_gateway",
                "sourcePortId": "node_gateway_out",
                "targetNodeId": "node_nas",
                "targetPortId": "node_nas_wan",
                "isFailover": false,
                "linkType": "Fiber",
                "linkSpeed": "10G"
            }]
        });
        let document = read_document(legacy).unwrap();
        let nas = &document["nodes"][1];
        assert!(nas.get("primaryParentId").is_none());
        assert!(nas.get("secondaryParentId").is_none());
        assert!(nas.get("linkType").is_none());
        assert_eq!(nas["isContainer"], true);
        assert_eq!(nas["containerType"], "proxmox");
        assert_eq!(nas["expanded"], false);
        assert_eq!(nas["zones"][0]["id"], "zone_lan");
        assert_eq!(nas["ports"][0]["id"], "node_nas_wan");

        let links = document["links"].as_array().unwrap();
        let mouse = links.iter().find(|link| link["id"] == "mouse_1").unwrap();
        assert_eq!(mouse["role"], "primary");
        assert_eq!(mouse["medium"], "Fiber");
        assert_eq!(mouse["speed"], "10G");
        assert!(mouse.get("isFailover").is_none());
        let failover = links.iter().find(|link| link["role"] == "failover").unwrap();
        assert_eq!(failover["id"], "link_node_nas_failover");
        assert_eq!(failover["sourceNodeId"], "node_gateway");
        assert!(document["ports"]
            .as_array()
            .unwrap()
            .iter()
            .any(|port| port["id"] == "node_nas_wan" && port["nodeId"] == "node_nas"));

        let again = read_document(document.clone()).unwrap();
        assert_eq!(
            again["links"].as_array().unwrap().iter().find(|link| link["role"] == "failover").unwrap()["id"],
            "link_node_nas_failover"
        );
    }

    #[test]
    fn save_keeps_links_ports_containers_and_zones() {
        let document = read_document(json!({
            "schemaVersion": 1,
            "settings": { "showGrid": false, "theme": "light", "probeIntervalMs": 5000 },
            "nodes": [
                {
                    "id": "hv",
                    "name": "pve",
                    "status": true,
                    "uptime": "3m",
                    "activeParentId": "gw",
                    "level": 2,
                    "responseTime": 4,
                    "isContainer": true,
                    "zones": [{ "id": "z1", "name": "vlan10" }],
                    "ports": [{ "id": "hv_in", "name": "IN", "side": "top" }]
                },
                {
                    "id": "vm",
                    "name": "vm",
                    "containerId": "hv",
                    "zoneId": "z1",
                    "ports": [{ "id": "vm_in", "name": "IN", "side": "left", "vlan": 10 }]
                }
            ],
            "links": [{
                "id": "kept",
                "sourceNodeId": "hv",
                "sourcePortId": "hv_in",
                "targetNodeId": "vm",
                "targetPortId": "vm_in",
                "role": "primary",
                "medium": "DAC",
                "speed": "25G",
                "note": "drawn"
            }],
            "unexpected": true
        }))
        .unwrap();

        assert!(document.get("unexpected").is_none());
        assert_eq!(document["settings"]["showGrid"], false);
        assert_eq!(document["settings"]["theme"], "light");
        assert_eq!(document["settings"]["probeIntervalMs"], 5000);
        assert_eq!(document["settings"]["confirmations"], 2);
        assert_eq!(document["settings"]["snapToGrid"], true);
        assert_eq!(document["links"].as_array().unwrap().len(), 1);
        assert_eq!(document["links"][0]["id"], "kept");
        assert_eq!(document["links"][0]["note"], "drawn");
        assert!(document["nodes"][0].get("status").is_none());
        assert!(document["nodes"][0].get("activeParentId").is_none());
        assert_eq!(document["nodes"][0]["isContainer"], true);
        assert_eq!(document["nodes"][0]["zones"][0]["id"], "z1");
        assert_eq!(document["nodes"][0]["ports"][0]["id"], "hv_in");
        assert_eq!(document["nodes"][1]["containerId"], "hv");
        assert_eq!(document["nodes"][1]["zoneId"], "z1");
        assert_eq!(document["nodes"][1]["ports"][0]["vlan"], 10);
    }

    #[test]
    fn migrated_links_attach_to_ports_that_exist() {
        let document = read_document(json!({
            "nodes": [
                { "id": "gw", "ports": [{ "id": "gw_in", "name": "IN", "side": "top" }] },
                { "id": "pc", "primaryParentId": "gw", "secondaryParentId": "gw" }
            ]
        }))
        .unwrap();
        let nodes = document["nodes"].as_array().unwrap();
        for link in document["links"].as_array().unwrap() {
            let source = nodes.iter().find(|node| node["id"] == link["sourceNodeId"]).unwrap();
            let target = nodes.iter().find(|node| node["id"] == link["targetNodeId"]).unwrap();
            assert!(source["ports"].as_array().unwrap().iter().any(|port| port["id"] == link["sourcePortId"]));
            assert!(target["ports"].as_array().unwrap().iter().any(|port| port["id"] == link["targetPortId"]));
        }
        let again = read_document(document).unwrap();
        assert!(again["nodes"][0].get("primaryParentId").is_none());
    }

    #[test]
    fn probe_settings_fall_back_to_five_seconds_and_two_confirmations() {
        let prepared = read_document(json!({
            "nodes": [],
            "settings": { "probeIntervalMs": 50, "confirmations": 1 }
        }))
        .unwrap();
        assert_eq!(prepared["settings"]["probeIntervalMs"], 5000);
        assert_eq!(prepared["settings"]["confirmations"], 2);
        let kept = read_document(json!({
            "nodes": [],
            "settings": { "probeIntervalMs": 2000, "confirmations": 4 }
        }))
        .unwrap();
        assert_eq!(kept["settings"]["probeIntervalMs"], 2000);
        assert_eq!(kept["settings"]["confirmations"], 4);
    }

    #[test]
    fn node_probes_are_checked_and_kept_in_canonical_form() {
        let document = read_document(json!({
            "nodes": [
                { "id": "plain", "address": "10.0.0.1", "port": 22 },
                { "id": "web", "address": "10.0.0.2", "probe": { "tcp": { "ports": [443, "80"] }, "http": { "scheme": "https" } } },
                { "id": "empty", "address": "10.0.0.3", "probe": {} }
            ]
        }))
        .unwrap();
        assert!(document["nodes"][0].get("probe").is_none());
        assert_eq!(document["nodes"][0]["port"], 22);
        assert_eq!(document["nodes"][1]["probe"]["tcp"], json!({ "ports": [443, 80], "mode": "all" }));
        assert_eq!(document["nodes"][1]["probe"]["http"]["insecureTls"], false);
        assert_eq!(document["nodes"][1]["probe"]["http"]["expectStatus"], "200-399");
        assert!(document["nodes"][2].get("probe").is_none());

        let refused = read_document(json!({
            "nodes": [{ "id": "gw", "probe": { "http": { "host": "evil.example" } } }]
        }));
        assert!(refused.unwrap_err().starts_with("Node gw probe:"));
        assert!(read_document(json!([{ "id": "gw", "probe": { "dns": { "name": "a b" } } }])).is_err());
    }

    #[test]
    fn refuses_a_file_without_nodes_or_with_an_unknown_version() {
        assert!(read_document(json!({ "settings": {} })).is_err());
        assert!(read_document(json!({ "schemaVersion": 2, "nodes": [] })).is_err());
        assert!(read_document(json!({ "nodes": [] })).is_ok());
        assert!(read_document(json!([])).is_ok());
        assert!(read_document(json!({ "nodes": "nope" })).is_err());
    }
}
