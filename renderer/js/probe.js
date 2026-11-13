// Probe confirmation and the active link.
//
// The main process probes hosts. A state stays `unknown` until two agreeing
// results, and one miss does not flip a confirmed state. The canvas then
// chooses the active link: the primary while that neighbor answers, otherwise
// the failover while its neighbor answers, otherwise the primary.
//
// Keep the interval and confirmation clamps aligned with lib/hosts.js and
// src-tauri/src/hosts.rs. Keep the active-link rule aligned with
// src-tauri/src/probe.rs.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.Probe = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PROBE_LIMIT = 20;
  const DEFAULT_INTERVAL_MS = 5000;
  const DEFAULT_CONFIRMATIONS = 2;
  const TOAST_QUIET_MS = 15000;
  const COLOR_UP = '#22c55e';
  const COLOR_DOWN = '#ef4444';
  const COLOR_UNKNOWN = '#64748b';

  function monitoringInterval(requested) {
    const value = Number(requested);
    if (Number.isFinite(value) && value >= 1000 && value <= 60000) return value;
    return DEFAULT_INTERVAL_MS;
  }

  function confirmationCount(requested) {
    const value = Number(requested);
    if (Number.isInteger(value) && value >= 2 && value <= 10) return value;
    return DEFAULT_CONFIRMATIONS;
  }

  function canonicalStatus(status) {
    if (status === true || status === 'up' || status === 'online') return 'up';
    if (status === false || status === 'down' || status === 'offline') return 'down';
    return 'unknown';
  }

  function sampleOf(online) {
    if (online === true || online === 'up') return 'up';
    if (online === false || online === 'down') return 'down';
    return null;
  }

  function observe(previous, online, required) {
    const requiredCount = confirmationCount(required);
    const prior = previous || {};
    const state = canonicalStatus(prior.state);
    const pending = prior.pending === 'up' || prior.pending === 'down' ? prior.pending : null;
    const streak = Number.isInteger(prior.streak) && prior.streak > 0 ? prior.streak : 0;
    const sample = sampleOf(online);
    if (!sample) return { state: state, pending: pending, streak: streak };
    const nextStreak = pending === sample ? streak + 1 : 1;
    return {
      state: nextStreak >= requiredCount ? sample : state,
      pending: sample,
      streak: nextStreak
    };
  }

  function readStatus(statusById, id) {
    if (!statusById || typeof id !== 'string' || id === '') return undefined;
    if (typeof statusById.get === 'function') return statusById.get(id);
    return statusById[id];
  }

  function parentLink(links, childId, role) {
    if (typeof childId !== 'string' || childId === '') return null;
    const list = Array.isArray(links) ? links : [];
    const canonicalId = 'link_' + childId + '_' + role;
    return list.find((link) => link && link.id === canonicalId && link.targetNodeId === childId && link.role === role)
      || list.find((link) => link && link.targetNodeId === childId && link.role === role)
      || null;
  }

  function activeLink(links, nodeId, statusById) {
    const primary = parentLink(links, nodeId, 'primary');
    const failover = parentLink(links, nodeId, 'failover');
    if (primary && failover) {
      if (canonicalStatus(readStatus(statusById, primary.sourceNodeId)) === 'up') return primary;
      if (canonicalStatus(readStatus(statusById, failover.sourceNodeId)) === 'up') return failover;
      return primary;
    }
    return primary || failover || null;
  }

  function linkLook(role, active, sourceStatus, targetStatus) {
    const source = canonicalStatus(sourceStatus);
    const target = canonicalStatus(targetStatus);
    let color = COLOR_UNKNOWN;
    if (source === 'down' || target === 'down') color = COLOR_DOWN;
    else if (source === 'up' && target === 'up') color = COLOR_UP;
    const waiting = !active && role === 'failover';
    return {
      color: color,
      animate: Boolean(active) && source === 'up' && target === 'up',
      waiting: waiting
    };
  }

  function shouldToast(previous, next, now, lastToastAt, quietMs) {
    const from = canonicalStatus(previous);
    const to = canonicalStatus(next);
    if (from !== 'up' && from !== 'down') return false;
    if (to !== 'up' && to !== 'down') return false;
    if (from === to) return false;
    const quiet = Number(quietMs);
    const silence = Number.isFinite(quiet) && quiet > 0 ? quiet : TOAST_QUIET_MS;
    const last = Number(lastToastAt);
    if (Number.isFinite(last) && last > 0 && Number(now) - last < silence) return false;
    return true;
  }

  return {
    PROBE_LIMIT: PROBE_LIMIT,
    DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS,
    DEFAULT_CONFIRMATIONS: DEFAULT_CONFIRMATIONS,
    TOAST_QUIET_MS: TOAST_QUIET_MS,
    COLOR_UP: COLOR_UP,
    COLOR_DOWN: COLOR_DOWN,
    COLOR_UNKNOWN: COLOR_UNKNOWN,
    monitoringInterval: monitoringInterval,
    confirmationCount: confirmationCount,
    canonicalStatus: canonicalStatus,
    observe: observe,
    activeLink: activeLink,
    linkLook: linkLook,
    shouldToast: shouldToast
  };
});
