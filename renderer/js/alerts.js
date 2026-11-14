// State-change alerts: which confirmed transitions become a notification.
//
// Pure logic, no timers and no DOM. The monitor already confirms states, so
// this module only sees `up`, `down`, or `unknown` per node. The first
// confirmed state of a node is its baseline and is never announced; `unknown`
// is never announced either. A node is announced when its confirmed state
// differs from the last state announced for it, once the changes have settled
// (no other node changed for BURST_WINDOW_MS, or MAX_DELAY_MS passed since its
// own change) and the per-node cooldown has passed since its last
// notification. A change hidden by the cooldown is announced when the
// cooldown ends, if the node still differs from what was last announced.
// When more than SUMMARY_THRESHOLD nodes are due at once, one summary replaces
// the individual notifications.
//
// Keep the settings clamps aligned with normalizeSettings in
// renderer/js/topology.js and src-tauri/src/topology.rs.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.Alerts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_COOLDOWN_MS = 60000;
  const MIN_COOLDOWN_MS = 5000;
  const MAX_COOLDOWN_MS = 3600000;
  const BURST_WINDOW_MS = 3000;
  const MAX_DELAY_MS = 10000;
  const SUMMARY_THRESHOLD = 5;
  const SUMMARY_NAMES = 5;

  function cooldown(requested) {
    const value = Number(requested);
    if (Number.isFinite(value) && value >= MIN_COOLDOWN_MS && value <= MAX_COOLDOWN_MS) return value;
    return DEFAULT_COOLDOWN_MS;
  }

  function enabled(requested) {
    return requested !== false;
  }

  function readSettings(settings) {
    const source = settings && typeof settings === 'object' ? settings : {};
    return {
      enabled: enabled(source.alertsEnabled),
      cooldownMs: cooldown(source.alertCooldownMs)
    };
  }

  function confirmed(status) {
    if (status === true || status === 'up' || status === 'online') return 'up';
    if (status === false || status === 'down' || status === 'offline') return 'down';
    return 'unknown';
  }

  function createState() {
    return { nodes: new Map(), lastChangeAt: null };
  }

  // Record one monitor report. `nodes` is a list of { id, name, address, status }.
  function observe(state, nodes, now, settings) {
    const options = readSettings(settings);
    const seen = new Set();
    (Array.isArray(nodes) ? nodes : []).forEach((node) => {
      if (!node || typeof node.id !== 'string' || node.id === '') return;
      seen.add(node.id);
      const next = confirmed(node.status);
      let entry = state.nodes.get(node.id);
      if (!entry) {
        entry = { state: 'unknown', reported: null, changedAt: now, notifiedAt: null };
        state.nodes.set(node.id, entry);
      }
      entry.name = typeof node.name === 'string' && node.name ? node.name : node.id;
      entry.address = typeof node.address === 'string' ? node.address : '';
      if (next === 'unknown') return;
      if (entry.reported === null || !options.enabled) {
        entry.state = next;
        entry.reported = next;
        entry.changedAt = now;
        return;
      }
      if (entry.state !== next) {
        entry.state = next;
        entry.changedAt = now;
        state.lastChangeAt = now;
      }
    });
    Array.from(state.nodes.keys()).forEach((id) => {
      if (!seen.has(id)) state.nodes.delete(id);
    });
  }

  function dueAt(state, entry, options) {
    if (entry.reported === null || entry.state === entry.reported) return null;
    const lastChange = Math.max(entry.changedAt, state.lastChangeAt === null ? entry.changedAt : state.lastChangeAt);
    const settled = Math.min(lastChange + BURST_WINDOW_MS, entry.changedAt + MAX_DELAY_MS);
    const afterCooldown = entry.notifiedAt === null ? settled : entry.notifiedAt + options.cooldownMs;
    return Math.max(settled, afterCooldown);
  }

  // Earliest time at which flush() would return something, or null.
  function nextDue(state, settings) {
    const options = readSettings(settings);
    if (!options.enabled) return null;
    let earliest = null;
    state.nodes.forEach((entry) => {
      const at = dueAt(state, entry, options);
      if (at !== null && (earliest === null || at < earliest)) earliest = at;
    });
    return earliest;
  }

  function single(entry) {
    const where = entry.address ? ' (' + entry.address + ')' : '';
    if (entry.state === 'down') {
      return { kind: 'down', title: entry.name + ' is down', body: entry.name + where + ' stopped answering.' };
    }
    return { kind: 'up', title: entry.name + ' is back up', body: entry.name + where + ' answers again.' };
  }

  function summary(entries) {
    const down = entries.filter((entry) => entry.state === 'down');
    const up = entries.filter((entry) => entry.state === 'up');
    const parts = [];
    if (down.length) parts.push(down.length + ' down');
    if (up.length) parts.push(up.length + ' back up');
    const names = entries.slice(0, SUMMARY_NAMES).map((entry) => entry.name);
    const more = entries.length > SUMMARY_NAMES ? ', +' + (entries.length - SUMMARY_NAMES) + ' more' : '';
    return {
      kind: 'summary',
      title: entries.length + ' nodes changed state',
      body: parts.join(', ') + ': ' + names.join(', ') + more
    };
  }

  // Notifications due at `now`. Marks the announced nodes as reported.
  function flush(state, now, settings) {
    const options = readSettings(settings);
    if (!options.enabled) return [];
    const due = [];
    state.nodes.forEach((entry) => {
      const at = dueAt(state, entry, options);
      if (at !== null && at <= now) due.push(entry);
    });
    due.forEach((entry) => {
      entry.reported = entry.state;
      entry.notifiedAt = now;
    });
    if (due.length > SUMMARY_THRESHOLD) return [summary(due)];
    return due.map(single);
  }

  return {
    DEFAULT_COOLDOWN_MS: DEFAULT_COOLDOWN_MS,
    MIN_COOLDOWN_MS: MIN_COOLDOWN_MS,
    MAX_COOLDOWN_MS: MAX_COOLDOWN_MS,
    BURST_WINDOW_MS: BURST_WINDOW_MS,
    MAX_DELAY_MS: MAX_DELAY_MS,
    SUMMARY_THRESHOLD: SUMMARY_THRESHOLD,
    cooldown: cooldown,
    enabled: enabled,
    readSettings: readSettings,
    createState: createState,
    observe: observe,
    nextDue: nextDue,
    flush: flush
  };
});
