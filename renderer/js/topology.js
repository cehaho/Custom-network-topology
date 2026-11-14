// One topology document for the canvas and the admin table.
//
// Keep this aligned with src-tauri/src/topology.rs. Both sides accept the
// legacy file (parent ids, `connections`) and write the same object:
// schemaVersion, settings, nodes, links, ports.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.Topology = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  const DOCUMENT_KEYS = ['schemaVersion', 'settings', 'nodes', 'links', 'ports'];
  const RUNTIME_FIELDS = ['status', 'uptime', 'activeParentId', 'level', 'responseTime', 'probeDetail'];
  const PARENT_FIELDS = ['primaryParentId', 'secondaryParentId'];

  function emptyDocument() {
    return {
      schemaVersion: SCHEMA_VERSION,
      settings: defaultSettings(),
      nodes: [],
      links: [],
      ports: []
    };
  }

  function defaultSettings() {
    return {
      showGrid: true,
      gridSize: 100,
      snapToGrid: true,
      theme: 'dark',
      probeIntervalMs: 5000,
      confirmations: 2
    };
  }

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function text(value) {
    return typeof value === 'string' ? value : '';
  }

  // Per-node probe rules live in probe-checks.js (loaded before this file).
  function probeChecks() {
    if (typeof module === 'object' && module.exports && typeof require === 'function') {
      return require('./probe-checks.js');
    }
    return globalThis.ProbeChecks || null;
  }

  function probeError(nodes) {
    const checks = probeChecks();
    if (!checks) return '';
    for (let index = 0; index < nodes.length; index += 1) {
      const error = checks.nodeError(nodes[index]);
      if (error) return error;
    }
    return '';
  }

  function normalizeNodeProbe(node) {
    const checks = probeChecks();
    if (!checks || !Object.prototype.hasOwnProperty.call(node, 'probe')) return false;
    const result = checks.normalize(node.probe);
    if (result.ok && result.probe) {
      const same = JSON.stringify(result.probe) === JSON.stringify(node.probe);
      node.probe = result.probe;
      return !same;
    }
    delete node.probe;
    return true;
  }

  function validateIncoming(raw) {
    if (Array.isArray(raw)) {
      if (!raw.every(isObject)) return 'Configuration nodes must be objects';
      return probeError(raw);
    }
    if (!isObject(raw)) return 'Configuration must be a JSON object';
    if (!Object.prototype.hasOwnProperty.call(raw, 'nodes')) return 'Configuration has no nodes';
    if (!Array.isArray(raw.nodes)) return 'Configuration nodes must be an array';
    if (!raw.nodes.every(isObject)) return 'Configuration nodes must be objects';
    const nodeProbeError = probeError(raw.nodes);
    if (nodeProbeError) return nodeProbeError;
    if (raw.schemaVersion !== undefined && raw.schemaVersion !== SCHEMA_VERSION) {
      return 'Unsupported topology version: ' + String(raw.schemaVersion);
    }
    if (raw.links !== undefined && !Array.isArray(raw.links)) return 'Configuration links must be an array';
    if (raw.connections !== undefined && !Array.isArray(raw.connections)) {
      return 'Configuration connections must be an array';
    }
    if (raw.ports !== undefined && !Array.isArray(raw.ports)) return 'Configuration ports must be an array';
    const links = [].concat(raw.links || [], raw.connections || []);
    if (!links.every(isObject)) return 'Configuration links must be objects';
    return '';
  }

  function read(raw) {
    const error = validateIncoming(raw);
    if (error) return { ok: false, error: error };
    const migrated = migrate(raw);
    return { ok: true, document: migrated.document, changed: migrated.changed };
  }

  function prepare(raw) {
    return read(raw);
  }

  function migrate(raw) {
    let changed = false;
    const source = Array.isArray(raw) ? { nodes: raw } : raw;
    if (Array.isArray(raw) || !isObject(raw) || raw.schemaVersion !== SCHEMA_VERSION) changed = true;
    if (isObject(raw) && Object.prototype.hasOwnProperty.call(raw, 'connections')) changed = true;
    if (isObject(raw)) {
      Object.keys(raw).forEach((key) => {
        if (DOCUMENT_KEYS.indexOf(key) === -1) changed = true;
      });
    }

    const nodes = (source.nodes || []).map((node, index) => {
      const copy = clone(node);
      if (typeof copy.id !== 'string' || copy.id === '') {
        copy.id = 'node_migrated_' + index;
        changed = true;
      }
      return copy;
    });

    attachDetachedPorts(nodes, isObject(raw) ? raw.ports : []);

    nodes.forEach((node) => {
      PARENT_FIELDS.concat(RUNTIME_FIELDS).forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(node, field)) changed = true;
      });
      if (Object.prototype.hasOwnProperty.call(node, 'linkType') || Object.prototype.hasOwnProperty.call(node, 'linkSpeed')) {
        changed = true;
      }
      if (!Array.isArray(node.ports) || node.ports.length === 0) changed = true;
      ensureDefaultPorts(node);
      if (normalizeNodeProbe(node)) changed = true;
      node.ports = node.ports.map(normalizePort).filter(Boolean);
    });

    const incomingLinks = []
      .concat(isObject(raw) && Array.isArray(raw.links) ? raw.links : [])
      .concat(isObject(raw) && Array.isArray(raw.connections) ? raw.connections : []);
    if (!isObject(raw) || !Array.isArray(raw.links)) changed = true;

    const links = [];
    incomingLinks.forEach((rawLink) => {
      const normalized = normalizeLink(rawLink);
      if (!normalized) return;
      if (linkNeedsRewrite(rawLink)) changed = true;
      if (!links.some((link) => link.id === normalized.id)) links.push(normalized);
    });

    nodes.forEach((node) => {
      changed = migrateParent(links, nodes, node, 'primary', node.primaryParentId) || changed;
      changed = migrateParent(links, nodes, node, 'failover', node.secondaryParentId) || changed;
      PARENT_FIELDS.concat(RUNTIME_FIELDS).forEach((field) => {
        delete node[field];
      });
      const primary = parentLink(links, node.id, 'primary');
      if (primary) {
        if (!primary.medium && node.linkType) primary.medium = node.linkType;
        if (!primary.speed && node.linkSpeed) primary.speed = node.linkSpeed;
        delete node.linkType;
        delete node.linkSpeed;
      }
    });

    const settings = normalizeSettings(source.settings);
    if (!isObject(raw) || JSON.stringify(settings) !== JSON.stringify(raw.settings || {})) {
      if (!settingsMatch(raw && raw.settings, settings)) changed = true;
    }

    const ports = collectPorts(nodes);
    if (!isObject(raw) || !Array.isArray(raw.ports) || !portsMatch(ports, raw.ports)) changed = true;

    return {
      changed: changed,
      document: {
        schemaVersion: SCHEMA_VERSION,
        settings: settings,
        nodes: nodes,
        links: links,
        ports: ports
      }
    };
  }

  function settingsMatch(original, normalized) {
    if (!isObject(original)) return false;
    const keys = Object.keys(normalized);
    if (keys.length !== Object.keys(original).length) return false;
    return keys.every((key) => original[key] === normalized[key]);
  }

  function normalizeSettings(raw) {
    const source = isObject(raw) ? raw : {};
    const settings = Object.assign(defaultSettings(), source);
    settings.probeIntervalMs = clampInterval(settings.probeIntervalMs);
    settings.confirmations = clampConfirmations(settings.confirmations);
    return settings;
  }

  function clampInterval(requested) {
    const value = Number(requested);
    if (Number.isFinite(value) && value >= 1000 && value <= 60000) return value;
    return 5000;
  }

  function clampConfirmations(requested) {
    const value = Number(requested);
    if (Number.isInteger(value) && value >= 2 && value <= 10) return value;
    return 2;
  }

  function attachDetachedPorts(nodes, ports) {
    if (!Array.isArray(ports)) return;
    nodes.forEach((node) => {
      if (Array.isArray(node.ports) && node.ports.length > 0) return;
      const attached = ports
        .filter((port) => isObject(port) && port.nodeId === node.id)
        .map((port) => {
          const copy = clone(port);
          delete copy.nodeId;
          return copy;
        });
      if (attached.length > 0) node.ports = attached;
    });
  }

  function ensureDefaultPorts(node) {
    if (!Array.isArray(node.ports) || node.ports.length === 0) {
      node.ports = [
        { id: node.id + '_in', name: 'IN', side: 'top' },
        { id: node.id + '_out', name: 'OUT', side: 'bottom' }
      ];
    }
  }

  function normalizePort(port) {
    if (!isObject(port)) return null;
    const id = typeof port.id === 'string' && port.id ? port.id : '';
    if (!id) return null;
    const copy = clone(port);
    copy.id = id;
    copy.name = typeof port.name === 'string' && port.name ? port.name : id;
    copy.side = typeof port.side === 'string' && port.side ? port.side : 'bottom';
    delete copy.nodeId;
    return copy;
  }

  function linkNeedsRewrite(rawLink) {
    if (!isObject(rawLink)) return true;
    if (rawLink.role !== 'primary' && rawLink.role !== 'failover') return true;
    if (Object.prototype.hasOwnProperty.call(rawLink, 'isFailover')) return true;
    if (Object.prototype.hasOwnProperty.call(rawLink, 'linkType')) return true;
    if (Object.prototype.hasOwnProperty.call(rawLink, 'linkSpeed')) return true;
    if (typeof rawLink.id !== 'string' || !rawLink.id) return true;
    return false;
  }

  function normalizeLink(rawLink) {
    if (!isObject(rawLink)) return null;
    const role = rawLink.role === 'failover' || rawLink.isFailover === true ? 'failover' : 'primary';
    const link = clone(rawLink);
    delete link.isFailover;
    delete link.linkType;
    delete link.linkSpeed;
    link.role = role;
    link.medium = valueOr(rawLink.medium, rawLink.linkType);
    link.speed = valueOr(rawLink.speed, rawLink.linkSpeed);
    if (typeof link.sourceNodeId !== 'string') link.sourceNodeId = text(link.sourceNodeId);
    if (typeof link.targetNodeId !== 'string') link.targetNodeId = text(link.targetNodeId);
    if (typeof link.id !== 'string' || !link.id) {
      link.id = 'link_' + (link.targetNodeId || 'x') + '_' + role;
    }
    return link;
  }

  function valueOr(primary, fallback) {
    if (primary !== undefined && primary !== null && primary !== '') return primary;
    if (fallback !== undefined && fallback !== null && fallback !== '') return fallback;
    return null;
  }

  function migrateParent(links, nodes, node, role, parentId) {
    if (typeof parentId !== 'string' || parentId === '' || parentId === node.id) return false;
    const parent = nodes.find((candidate) => candidate.id === parentId);
    if (!parent) return false;
    ensureDefaultPorts(parent);
    ensureDefaultPorts(node);
    const existing = links.find((link) => sameCable(link, parentId, node.id, role));
    if (existing) {
      let touched = false;
      if (role === 'primary') {
        if (!existing.medium && node.linkType) {
          existing.medium = node.linkType;
          touched = true;
        }
        if (!existing.speed && node.linkSpeed) {
          existing.speed = node.linkSpeed;
          touched = true;
        }
      }
      return touched;
    }
    links.push({
      id: uniqueLinkId(links, 'link_' + node.id + '_' + role),
      sourceNodeId: parent.id,
      sourcePortId: ensurePort(parent, 'bottom', 'out', 'OUT'),
      targetNodeId: node.id,
      targetPortId: ensurePort(node, 'top', 'in', 'IN'),
      role: role,
      medium: role === 'primary' ? valueOr(node.linkType, null) : null,
      speed: role === 'primary' ? valueOr(node.linkSpeed, null) : null
    });
    return true;
  }

  function uniqueLinkId(links, base) {
    if (!links.some((link) => link.id === base)) return base;
    let suffix = 2;
    while (links.some((link) => link.id === base + '_' + suffix)) suffix += 1;
    return base + '_' + suffix;
  }

  function sameCable(link, parentId, childId, role) {
    if (!link || link.role !== role) return false;
    const forward = link.sourceNodeId === parentId && link.targetNodeId === childId;
    const backward = link.sourceNodeId === childId && link.targetNodeId === parentId;
    return forward || backward;
  }

  function ensurePort(node, side, suffix, name) {
    if (!Array.isArray(node.ports)) node.ports = [];
    const existing = node.ports.find((port) => port.side === side);
    if (existing && existing.id) return existing.id;
    const id = node.id + '_' + suffix;
    if (!node.ports.some((port) => port.id === id)) {
      node.ports.push({ id: id, name: name, side: side });
    }
    return id;
  }

  function parentLink(links, childId, role) {
    const canonicalId = 'link_' + childId + '_' + role;
    return links.find((link) => link.id === canonicalId && link.targetNodeId === childId && link.role === role)
      || links.find((link) => link.targetNodeId === childId && link.role === role)
      || null;
  }

  function parentNodeId(doc, childId, role) {
    const link = parentLink((doc && doc.links) || [], childId, role === 'secondary' ? 'failover' : role);
    return link ? link.sourceNodeId : null;
  }

  function primaryCable(doc, childId) {
    return parentLink((doc && doc.links) || [], childId, 'primary');
  }

  function setParent(doc, childId, role, parentId) {
    const normalizedRole = role === 'secondary' ? 'failover' : role;
    if (!doc || !Array.isArray(doc.links) || childId === parentId) return doc;
    const existing = parentLink(doc.links, childId, normalizedRole);
    if (!parentId) {
      if (existing) doc.links = doc.links.filter((link) => link.id !== existing.id);
      doc.ports = collectPorts(doc.nodes || []);
      return doc;
    }
    const child = (doc.nodes || []).find((node) => node.id === childId);
    const parent = (doc.nodes || []).find((node) => node.id === parentId);
    if (!child || !parent) return doc;
    ensureDefaultPorts(child);
    ensureDefaultPorts(parent);
    const sourcePortId = ensurePort(parent, 'bottom', 'out', 'OUT');
    const targetPortId = (existing && existing.targetPortId) || ensurePort(child, 'top', 'in', 'IN');
    if (existing) {
      existing.sourceNodeId = parent.id;
      existing.sourcePortId = sourcePortId;
      existing.targetNodeId = child.id;
      existing.targetPortId = targetPortId;
      existing.role = normalizedRole;
    } else {
      doc.links.push({
        id: 'link_' + childId + '_' + normalizedRole,
        sourceNodeId: parent.id,
        sourcePortId: sourcePortId,
        targetNodeId: child.id,
        targetPortId: targetPortId,
        role: normalizedRole,
        medium: normalizedRole === 'primary' ? valueOr(child.linkType, null) : null,
        speed: normalizedRole === 'primary' ? valueOr(child.linkSpeed, null) : null
      });
    }
    if (normalizedRole === 'primary') {
      delete child.linkType;
      delete child.linkSpeed;
    }
    doc.ports = collectPorts(doc.nodes);
    return doc;
  }

  function setCable(doc, childId, medium, speed) {
    const link = parentLink((doc && doc.links) || [], childId, 'primary');
    const mediumValue = medium || null;
    const speedValue = speed || null;
    if (link) {
      link.medium = mediumValue;
      link.speed = speedValue;
      const node = (doc.nodes || []).find((candidate) => candidate.id === childId);
      if (node) {
        delete node.linkType;
        delete node.linkSpeed;
      }
      return doc;
    }
    const node = (doc.nodes || []).find((candidate) => candidate.id === childId);
    if (!node) return doc;
    if (mediumValue) node.linkType = mediumValue;
    else delete node.linkType;
    if (speedValue) node.linkSpeed = speedValue;
    else delete node.linkSpeed;
    return doc;
  }

  function removeNode(doc, nodeId) {
    if (!doc || !Array.isArray(doc.nodes)) return doc;
    doc.nodes = doc.nodes.filter((node) => node.id !== nodeId);
    doc.links = (doc.links || []).filter((link) => link.sourceNodeId !== nodeId && link.targetNodeId !== nodeId);
    doc.nodes.forEach((node) => {
      if (node.containerId === nodeId) node.containerId = null;
    });
    doc.ports = collectPorts(doc.nodes);
    return doc;
  }

  function collectPorts(nodes) {
    const ports = [];
    (nodes || []).forEach((node) => {
      (node.ports || []).forEach((port) => {
        if (!port || typeof port.id !== 'string') return;
        const copy = clone(port);
        delete copy.nodeId;
        copy.nodeId = node.id;
        ports.push(copy);
      });
    });
    return ports;
  }

  function portsMatch(expected, actual) {
    const project = (port) => ({
      id: port && port.id,
      nodeId: port && port.nodeId,
      name: port && port.name,
      side: port && port.side
    });
    return JSON.stringify((expected || []).map(project)) === JSON.stringify((actual || []).map(project));
  }

  function createNode(partial) {
    const source = partial || {};
    const id = typeof source.id === 'string' && source.id
      ? source.id
      : 'node_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const node = {
      id: id,
      name: source.name || 'Unnamed',
      address: source.address || '',
      port: source.port === undefined || source.port === '' ? null : source.port,
      icon: source.icon || 'circle',
      iconType: source.iconType || 'lucide',
      x: source.x === undefined ? null : source.x,
      y: source.y === undefined ? null : source.y,
      sshPort: source.sshPort || 22,
      sshUser: source.sshUser || '',
      sshAuth: source.sshAuth === 'key' ? 'key' : 'password',
      ports: Array.isArray(source.ports) && source.ports.length > 0
        ? source.ports.map(normalizePort).filter(Boolean)
        : [
          { id: id + '_in', name: 'IN', side: 'top' },
          { id: id + '_out', name: 'OUT', side: 'bottom' }
        ]
    };
    ['isContainer', 'containerType', 'zones', 'containerId', 'zoneId', 'expanded', 'probe'].forEach((key) => {
      if (source[key] !== undefined) node[key] = source[key];
    });
    return node;
  }

  function secretType(node) {
    const secret = node && node.sshSecret;
    if (!secret || (secret.type !== 'password' && secret.type !== 'passphrase')) return '';
    return secret.type;
  }

  function stripNodeSecretValues(node) {
    if (!node || typeof node !== 'object') return;
    delete node.sshPass;
    delete node.sshPassphrase;
    delete node._encrypted;
    delete node.sshSecretClear;
    if (node.sshSecret && typeof node.sshSecret === 'object') {
      const type = secretType(node);
      if (type) node.sshSecret = { type: type };
      else delete node.sshSecret;
    }
  }

  function withoutSecretValues(document) {
    const copy = clone(document || emptyDocument());
    (copy.nodes || []).forEach(stripNodeSecretValues);
    return copy;
  }

  function hasSecretValues(document) {
    return ((document && document.nodes) || []).some((node) => {
      if (!node) return false;
      if (node.sshPass || node.sshPassphrase || node._encrypted === true) return true;
      const secret = node.sshSecret;
      return !!(secret && (secret.value || secret.secret));
    });
  }

  function secretHint(node) {
    if (!node) return '';
    if (node.sshSecretClear) return 'Secret will be removed';
    if (node.sshPass || node.sshPassphrase) return 'New secret will be saved';
    if (secretType(node)) return 'Secret saved';
    return '';
  }

  function acceptSecretEdit(node, value) {
    if (!node || !value) return;
    delete node.sshSecretClear;
    if (node.sshAuth === 'key') {
      node.sshPassphrase = value;
      delete node.sshPass;
    } else {
      node.sshPass = value;
      delete node.sshPassphrase;
    }
  }

  function clearStoredSecret(node) {
    if (!node) return;
    delete node.sshPass;
    delete node.sshPassphrase;
    delete node.sshSecret;
    node.sshSecretClear = true;
  }

  function forgetInheritedSecret(node) {
    stripNodeSecretValues(node);
    if (node) {
      delete node.sshSecret;
      delete node.sshSecretClear;
    }
  }

  function summary(doc) {
    const document = doc || emptyDocument();
    return {
      nodes: Array.isArray(document.nodes) ? document.nodes.length : 0,
      links: Array.isArray(document.links) ? document.links.length : 0,
      schemaVersion: document.schemaVersion || SCHEMA_VERSION
    };
  }

  function importMessage(doc) {
    const counts = summary(doc);
    return 'Replace the current topology?\n\nNodes: ' + counts.nodes
      + '\nLinks: ' + counts.links
      + '\nVersion: ' + counts.schemaVersion;
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    emptyDocument: emptyDocument,
    read: read,
    prepare: prepare,
    summary: summary,
    importMessage: importMessage,
    parentNodeId: parentNodeId,
    primaryCable: primaryCable,
    setParent: setParent,
    setCable: setCable,
    removeNode: removeNode,
    createNode: createNode,
    collectPorts: collectPorts,
    secretType: secretType,
    stripNodeSecretValues: stripNodeSecretValues,
    withoutSecretValues: withoutSecretValues,
    hasSecretValues: hasSecretValues,
    secretHint: secretHint,
    acceptSecretEdit: acceptSecretEdit,
    clearStoredSecret: clearStoredSecret,
    forgetInheritedSecret: forgetInheritedSecret
  };
});
