// Canvas search: query parsing and node matching.
//
// Pure functions only; app/search-ui.js owns the DOM. A query is a list of
// whitespace-separated terms, all of which must match (AND):
//   free text       name, address, type, zone name or VLAN, status
//   name:core       node name contains "core"
//   ip:10.0.        address contains "10.0." (aliases: addr, address, host)
//   vlan:10         node sits in a zone with VLAN id 10 (exact)
//   zone:dmz        zone name or VLAN id contains "dmz"
//   type:server     icon, container type, or "container" contains "server"
//   status:down     up/online/on, down/offline/off, unknown/pending
// Values can be quoted ("core switch"), separated by commas for OR
// (status:down,unknown) and a leading "-" negates a term (-type:docker).
// Matching is case-insensitive. A token whose prefix is not a known field
// (e.g. fe80::1) is free text, so IPv6 addresses need no quoting.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.NodeSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FIELD_ALIASES = {
    name: 'name',
    ip: 'address',
    addr: 'address',
    address: 'address',
    host: 'address',
    vlan: 'vlan',
    zone: 'zone',
    type: 'type',
    status: 'status',
    state: 'status'
  };

  const STATUS_ALIASES = {
    up: 'up', online: 'up', on: 'up', ok: 'up',
    down: 'down', offline: 'down', off: 'down',
    unknown: 'unknown', pending: 'unknown', '?': 'unknown'
  };

  function lower(value) {
    return value === undefined || value === null ? '' : String(value).toLowerCase();
  }

  // Split on whitespace, keeping "quoted values" (also after field:) whole.
  function tokenize(text) {
    const tokens = [];
    const source = String(text || '');
    let current = '';
    let quoted = false;
    let started = false;
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (ch === '"') {
        quoted = !quoted;
        started = true;
        continue;
      }
      if (!quoted && /\s/.test(ch)) {
        if (started) tokens.push(current);
        current = '';
        started = false;
        continue;
      }
      current += ch;
      started = true;
    }
    if (started) tokens.push(current);
    return tokens.filter((token) => token.length > 0);
  }

  function canonicalStatusValue(value) {
    return STATUS_ALIASES[lower(value)] || lower(value);
  }

  function parseTerm(token) {
    let raw = token;
    let negate = false;
    if (raw.length > 1 && raw[0] === '-') {
      negate = true;
      raw = raw.slice(1);
    }
    const colon = raw.indexOf(':');
    if (colon > 0) {
      const field = FIELD_ALIASES[lower(raw.slice(0, colon))];
      const rest = raw.slice(colon + 1);
      if (field && rest.length > 0) {
        let values = rest.split(',').map(lower).filter((v) => v.length > 0);
        if (field === 'status') values = values.map(canonicalStatusValue);
        if (values.length === 0) return null;
        return { field: field, values: values, negate: negate };
      }
      // "status:" while typing: ignore the incomplete term.
      if (field) return null;
    }
    return { field: 'text', values: [lower(raw)], negate: negate };
  }

  function parseQuery(text) {
    const terms = tokenize(text).map(parseTerm).filter(Boolean);
    return { terms: terms, empty: terms.length === 0 };
  }

  function canonicalStatus(status) {
    if (status === true || status === 'up' || status === 'online') return 'up';
    if (status === false || status === 'down' || status === 'offline') return 'down';
    return 'unknown';
  }

  function zonesOf(node, byId) {
    const zones = [];
    if (node.zoneId && node.containerId && byId.has(node.containerId)) {
      const container = byId.get(node.containerId);
      const zone = (container.zones || []).find((z) => z && z.id === node.zoneId);
      if (zone) zones.push(zone);
    }
    if (node.isContainer) {
      (node.zones || []).forEach((zone) => { if (zone) zones.push(zone); });
    }
    return zones;
  }

  // Everything a query can look at, lowercased.
  function facets(node, byId) {
    const lookup = byId || new Map();
    const types = [];
    if (node.icon && node.iconType !== 'svg' && node.iconType !== 'url') types.push(lower(node.icon));
    if (node.containerType) types.push(lower(node.containerType));
    if (node.isContainer) types.push('container');
    if (node.type) types.push(lower(node.type));
    const zones = zonesOf(node, lookup);
    return {
      name: lower(node.name || node.id),
      address: lower(node.address),
      status: canonicalStatus(node.status),
      types: types,
      vlans: zones.map((zone) => lower(zone.vlanId)).filter((v) => v.length > 0),
      zones: zones.map((zone) => lower(zone.name)).filter((v) => v.length > 0)
    };
  }

  function some(list, value) {
    return list.some((item) => item.includes(value));
  }

  function valueMatches(field, value, f) {
    switch (field) {
      case 'name': return f.name.includes(value);
      case 'address': return f.address.includes(value);
      case 'vlan': return f.vlans.includes(value);
      case 'zone': return some(f.zones, value) || some(f.vlans, value);
      case 'type': return some(f.types, value);
      case 'status': return f.status === value;
      default:
        return f.name.includes(value) ||
          f.address.includes(value) ||
          some(f.types, value) ||
          some(f.zones, value) ||
          f.vlans.some((vlan) => vlan === value || ('vlan' + vlan) === value) ||
          f.status === canonicalStatusValue(value);
    }
  }

  function termMatches(term, f) {
    const hit = term.values.some((value) => valueMatches(term.field, value, f));
    return term.negate ? !hit : hit;
  }

  function matchesNode(node, query, byId) {
    if (!query || query.empty) return true;
    const f = facets(node, byId);
    return query.terms.every((term) => termMatches(term, f));
  }

  function indexNodes(nodes) {
    const byId = new Map();
    (nodes || []).forEach((node) => { if (node && !byId.has(node.id)) byId.set(node.id, node); });
    return byId;
  }

  // Ids of the matching nodes, in document order. Empty query: every node.
  function findMatches(nodes, query) {
    const list = nodes || [];
    const byId = indexNodes(list);
    const parsed = typeof query === 'string' ? parseQuery(query) : query;
    return list.filter((node) => matchesNode(node, parsed, byId)).map((node) => node.id);
  }

  // Look of every node while a search is active:
  //   'hit'      the node matches
  //   'contains' a container that does not match but holds a match (kept lit
  //              so its matching children stay readable)
  //   'dim'      everything else
  function nodeStates(nodes, matchIds) {
    const matches = matchIds instanceof Set ? matchIds : new Set(matchIds || []);
    const holders = new Set();
    (nodes || []).forEach((node) => {
      if (matches.has(node.id) && node.containerId) holders.add(node.containerId);
    });
    const states = new Map();
    (nodes || []).forEach((node) => {
      if (matches.has(node.id)) states.set(node.id, 'hit');
      else if (holders.has(node.id)) states.set(node.id, 'contains');
      else states.set(node.id, 'dim');
    });
    return states;
  }

  // A link is dimmed only when both of its ends are dimmed.
  function linkDimmed(link, states) {
    const source = states.get(link.sourceNodeId);
    const target = states.get(link.targetNodeId);
    return (source === undefined || source === 'dim') && (target === undefined || target === 'dim');
  }

  // Step through matches with wrap-around. index -1 means "none yet".
  function cycle(index, count, delta) {
    if (!count) return -1;
    if (index < 0 || index >= count) return delta < 0 ? count - 1 : 0;
    return ((index + delta) % count + count) % count;
  }

  function countLabel(index, count) {
    if (!count) return '0 / 0';
    return (index >= 0 ? index + 1 : 0) + ' / ' + count;
  }

  // The element to center on: children live inside their container's box.
  function focusTarget(node, byId) {
    if (node && node.containerId && byId && byId.has(node.containerId)) return node.containerId;
    return node ? node.id : null;
  }

  return {
    tokenize: tokenize,
    parseQuery: parseQuery,
    facets: facets,
    matchesNode: matchesNode,
    findMatches: findMatches,
    nodeStates: nodeStates,
    linkDimmed: linkDimmed,
    cycle: cycle,
    countLabel: countLabel,
    focusTarget: focusTarget,
    indexNodes: indexNodes
  };
});
