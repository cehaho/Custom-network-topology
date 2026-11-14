// Monitoring: start/stop the backend monitor, turn its status events into
// node copies (state.networkData) with uptime, keep the status history.

import { Probe, SnmpUI, Topology } from './libs.js';
import { formatDuration } from './util.js';
import { state } from './state.js';
import { toastError, toastSuccess } from './ui.js';
import { renderTree } from './canvas-render.js';
import { renderHostList } from './host-list.js';
import { AlertNotifier } from './alert-notifier.js';

const uptimeTrackers = new Map();

// Status history tracking
export const statusHistory = new Map(); // nodeId -> { lastStatus, lastChange, history: [{status, time}] }
const MAX_HISTORY_ENTRIES = 50;

export function setupMonitoringListener() {
  if (!window.desktopAPI) return;

  window.desktopAPI.monitor.onStatus((data) => {
    if (!data || !Array.isArray(data.nodes)) return;
    const updated = document.getElementById('last-updated');
    if (updated) updated.textContent = 'Last Update: ' + (data.updated || '');
    const reported = new Map(data.nodes.map((node) => [node.id, node]));
    const now = Date.now();

    state.networkData = state.config.nodes.map((configNode) => {
      const entry = reported.get(configNode.id);
      const copy = Object.assign({}, configNode);
      copy.status = entry ? entry.status : 'unknown';
      copy.responseTime = entry && entry.responseTime != null ? entry.responseTime : null;
      copy.probeDetail = entry && typeof entry.detail === 'string' ? entry.detail : '';
      delete copy.activeParentId;
      const secretType = Topology.secretType(copy);
      if (secretType) copy.sshSecret = { type: secretType };
      else delete copy.sshSecret;
      delete copy.sshPass;
      delete copy.sshPassphrase;
      delete copy._encrypted;
      delete copy.sshSecretClear;

      const nodeState = Probe.canonicalStatus(copy.status);
      const tracker = uptimeTrackers.get(copy.id);
      if (!tracker || tracker.status !== nodeState) {
        uptimeTrackers.set(copy.id, { status: nodeState, since: now });
      }
      const since = uptimeTrackers.get(copy.id).since;
      copy.uptime = nodeState === 'unknown' ? 'confirming' : formatDuration(now - since);
      rememberStatus(copy.id, copy.name, nodeState, entry && entry.history, now);
      return copy;
    });

    AlertNotifier.observe(state.networkData, state.config.settings);
    renderTree(state.networkData);
    renderHostList(state.networkData);
  });
}

export async function startMonitoring() {
  if (!window.desktopAPI || state.monitoringActive) return;

  const settings = state.config.settings || {};
  AlertNotifier.reset();
  await window.desktopAPI.monitor.start({
    nodes: (state.config.nodes || []).map((node) => ({
      id: node.id,
      address: typeof node.address === 'string' ? node.address : '',
      port: node.port == null || node.port === '' ? null : node.port,
      probe: node.probe || null
    })),
    interval: Probe.monitoringInterval(settings.probeIntervalMs),
    confirmations: Probe.confirmationCount(settings.confirmations)
  });
  SnmpUI.start(state.config);

  state.monitoringActive = true;
  document.getElementById('btn-monitoring').classList.add('active');
}

export async function stopMonitoring() {
  if (!window.desktopAPI || !state.monitoringActive) return;

  await window.desktopAPI.monitor.stop();
  SnmpUI.stop();
  state.monitoringActive = false;
  document.getElementById('btn-monitoring').classList.remove('active');
}

export async function toggleMonitoring() {
  if (state.monitoringActive) {
    await stopMonitoring();
  } else {
    await startMonitoring();
  }
}

function rememberStatus(nodeId, nodeName, nodeState, history, now) {
  const previous = statusHistory.get(nodeId);
  let lastToast = previous ? previous.lastToast : 0;
  if (Probe.shouldToast(previous && previous.lastStatus, nodeState, now, lastToast, Probe.TOAST_QUIET_MS)) {
    const name = nodeName || nodeId;
    if (nodeState === 'up') toastSuccess('Node Online', `"${name}" is now online`);
    else toastError('Node Offline', `"${name}" went offline`);
    lastToast = now;
  }
  const samples = Array.isArray(history)
    ? history.slice(-MAX_HISTORY_ENTRIES)
    : (previous && previous.history) || [];
  statusHistory.set(nodeId, {
    lastStatus: nodeState,
    lastToast: lastToast,
    lastChange: previous && previous.lastStatus === nodeState ? previous.lastChange : now,
    history: samples
  });
}

export function historyWhen(entry) {
  const date = new Date(entry && (entry.at || entry.time));
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

export function historyLabel(status) {
  const nodeState = Probe.canonicalStatus(status);
  if (nodeState === 'up') return 'Online';
  if (nodeState === 'down') return 'Offline';
  return 'Unknown';
}
