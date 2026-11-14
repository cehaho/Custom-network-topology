// The network discovery modal: interface choice, scan, enrichment (reverse
// DNS, MAC vendor) and adding the selected hosts to the canvas.

import { Discovery, Hosts, Topology } from './libs.js';
import { escapeHtml } from './util.js';
import { state } from './state.js';
import {
  closeModal,
  onAction,
  openModal,
  toastError,
  toastInfo,
  toastSuccess,
  toastWarning
} from './ui.js';
import { saveConfig } from './io.js';
import { viewportCenterPercent } from './viewport.js';
import { renderTree } from './canvas-render.js';
import { renderHostList } from './host-list.js';
import { startMonitoring, stopMonitoring } from './monitoring.js';

let discoveredHosts = [];
let networkInterfaces = []; // Store interfaces for reference
let discoveryGeneration = 0; // ignores enrichment results from an older scan

export async function openDiscoveryModal() {
  if (!window.desktopAPI) {
    toastWarning('Discovery Unavailable', 'Network discovery is only available in the desktop application');
    return;
  }

  // Get network interfaces
  // The range scan is IPv4 only; IPv6 entries (family "IPv6") are skipped
  // here. IPv6 hosts come from the neighbour table after the scan.
  const localInfo = await window.desktopAPI.network.getLocalInfo();
  networkInterfaces = (Array.isArray(localInfo) ? localInfo : []).filter((iface) =>
    iface.family !== 'IPv6' &&
    // A /32 has no neighbours to scan (WSL puts 10.255.255.254/32 on lo).
    iface.netmask !== '255.255.255.255' &&
    iface.interface !== 'lo');
  const select = document.getElementById('discovery-interface');
  select.innerHTML = '';

  networkInterfaces.forEach((iface, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.textContent = `${iface.interface} - ${iface.address} (${iface.netmask})`;
    opt.dataset.address = iface.address;
    opt.dataset.netmask = iface.netmask;
    select.appendChild(opt);
  });

  // Add change listener to update IP range when interface changes
  select.onchange = () => updateDiscoveryRange();

  // Set default base IP from first interface
  updateDiscoveryRange();

  discoveredHosts = [];
  document.getElementById('discovery-results').classList.add('hidden');
  document.getElementById('discovery-status').classList.add('hidden');
  document.getElementById('btn-add-discovered').classList.add('hidden');
  document.getElementById('btn-start-scan').classList.remove('hidden');
  document.getElementById('btn-start-scan').textContent = 'Start Scan';

  openModal('discovery-modal');
}

function updateDiscoveryRange() {
  const select = document.getElementById('discovery-interface');
  const selectedIdx = parseInt(select.value) || 0;

  if (networkInterfaces.length > 0 && networkInterfaces[selectedIdx]) {
    const iface = networkInterfaces[selectedIdx];
    const ipParts = iface.address.split('.');
    const maskParts = iface.netmask.split('.');

    // Calculate network range based on netmask
    const baseIp = ipParts.slice(0, 3).join('.');
    document.getElementById('discovery-base').value = baseIp;

    // Calculate start and end based on netmask
    // For /24 (255.255.255.0): range is 1-254
    // For /16 (255.255.0.0): we'll limit to current subnet
    const lastOctetMask = parseInt(maskParts[3]) || 0;

    if (lastOctetMask === 0) {
      // /24 or larger - scan 1-254
      document.getElementById('discovery-start').value = 1;
      document.getElementById('discovery-end').value = 254;
    } else {
      // Smaller subnet - calculate range
      const hostBits = 256 - lastOctetMask;
      const networkPart = parseInt(ipParts[3]) & lastOctetMask;
      document.getElementById('discovery-start').value = networkPart + 1;
      document.getElementById('discovery-end').value = Math.min(networkPart + hostBits - 2, 254);
    }
  }
}

async function startNetworkScan() {
  if (!window.desktopAPI) return;

  const baseIp = document.getElementById('discovery-base').value.trim();
  const startRange = parseInt(document.getElementById('discovery-start').value, 10);
  const endRange = parseInt(document.getElementById('discovery-end').value, 10);

  if (!baseIp) {
    toastError('Missing Input', 'Please enter a base IP address');
    return;
  }
  if (!Number.isInteger(startRange) || !Number.isInteger(endRange) || startRange < 1 || endRange > 254 || startRange > endRange) {
    toastError('Invalid range', 'Scan range must be between 1 and 254');
    return;
  }

  discoveredHosts = [];
  discoveryGeneration += 1;
  document.getElementById('discovery-status').classList.remove('hidden');
  document.getElementById('discovery-results').classList.add('hidden');
  document.getElementById('btn-start-scan').classList.add('hidden');
  document.getElementById('discovery-progress-bar').style.width = '0%';
  document.getElementById('discovery-text').textContent = 'Scanning...';

  // Listen for progress updates
  const removeProgressListener = window.desktopAPI.network.onScanProgress((progress) => {
    const percent = Math.round((progress.current / progress.total) * 100);
    document.getElementById('discovery-progress-bar').style.width = percent + '%';
    document.getElementById('discovery-text').textContent = `Scanning... ${progress.current}/${progress.total} (Found: ${progress.found})`;
  });

  let results;
  try {
    results = await window.desktopAPI.network.scan(baseIp, startRange, endRange);
  } catch (error) {
    removeProgressListener();
    document.getElementById('btn-start-scan').classList.remove('hidden');
    document.getElementById('discovery-text').textContent = 'Scan failed';
    toastError('Scan failed', error && error.message ? error.message : 'Invalid scan range');
    return;
  }

  removeProgressListener();

  // Also get ARP table for MAC addresses
  const arpTable = await window.desktopAPI.network.arp();

  // Merge results
  discoveredHosts = results.map(r => {
    const arpEntry = arpTable.find(a => a.ip === r.ip);
    return {
      ip: r.ip,
      mac: arpEntry ? arpEntry.mac : null,
      selected: true
    };
  });

  // IPv6 hosts: a subnet sweep is not feasible, so read the neighbour table.
  // They start unselected (link-local entries are often duplicates of an
  // IPv4 host already found).
  let neighbors = [];
  try {
    neighbors = window.desktopAPI.network.neighbors ? await window.desktopAPI.network.neighbors() : [];
  } catch (error) {
    neighbors = [];
  }
  (Array.isArray(neighbors) ? neighbors : []).forEach((entry) => {
    if (!entry || !Hosts.isIpv6(entry.ip)) return;
    discoveredHosts.push({ ip: entry.ip, mac: entry.mac || null, selected: false, ipv6: true });
  });

  // Filter out already configured hosts
  discoveredHosts = Discovery.newHosts(discoveredHosts, state.config.nodes)
    .map((host) => Object.assign({ hostname: null, vendor: null, name: '', nameEdited: false }, host));

  document.getElementById('discovery-text').textContent = `Found ${discoveredHosts.length} new hosts`;
  document.getElementById('discovery-progress-bar').style.width = '100%';

  // Show results
  renderDiscoveryResults();

  if (discoveredHosts.length > 0) {
    document.getElementById('btn-add-discovered').classList.remove('hidden');
  }
  document.getElementById('btn-start-scan').classList.remove('hidden');
  document.getElementById('btn-start-scan').textContent = 'Scan Again';

  enrichDiscoveredHosts();
}

// Reverse DNS names and MAC vendors arrive after the scan, row by row.
async function enrichDiscoveredHosts() {
  const api = window.desktopAPI && window.desktopAPI.network;
  if (!api || !api.enrich || discoveredHosts.length === 0) return;
  const generation = discoveryGeneration;
  const apply = (ip, info) => {
    if (generation !== discoveryGeneration || !info) return;
    const idx = discoveredHosts.findIndex((host) => host.ip === ip);
    if (idx === -1) return;
    const host = discoveredHosts[idx];
    host.hostname = info.hostname || host.hostname || null;
    host.vendor = info.vendor || host.vendor || null;
    updateDiscoveryRow(idx);
  };
  const stop = api.onEnrichResult ? api.onEnrichResult((result) => result && apply(result.ip, result)) : () => {};
  try {
    const results = await api.enrich(discoveredHosts.map((host) => ({ ip: host.ip, mac: host.mac || null })));
    Object.keys(results || {}).forEach((ip) => apply(ip, results[ip]));
  } catch (error) {
    console.warn('Discovery enrichment failed', error);
  } finally {
    stop();
  }
}

function renderDiscoveryResults() {
  const container = document.getElementById('discovery-results');
  container.innerHTML = '';
  container.classList.remove('hidden');
  if (discoveredHosts.length === 0) return;

  const table = document.createElement('table');
  table.className = 'discovery-table';
  table.innerHTML = '<thead><tr><th></th><th>Address</th><th>Hostname</th><th>Vendor</th><th>MAC</th><th>Node name</th></tr></thead>';
  const body = document.createElement('tbody');
  discoveredHosts.forEach((host, idx) => {
    const row = document.createElement('tr');
    row.dataset.idx = String(idx);
    row.innerHTML = `
      <td><input type="checkbox" class="discovery-select" ${host.selected ? 'checked' : ''}></td>
      <td class="font-mono">${escapeHtml(host.ip)}${host.ipv6 ? ' <span class="text-slate-500">IPv6</span>' : ''}</td>
      <td class="discovery-hostname text-slate-400"></td>
      <td class="discovery-vendor text-slate-400"></td>
      <td class="font-mono text-slate-500">${host.mac ? escapeHtml(host.mac) : ''}</td>
      <td><input type="text" class="form-input discovery-name" maxlength="64"></td>
    `;
    row.querySelector('.discovery-select').addEventListener('change', (event) => {
      host.selected = event.target.checked;
    });
    row.querySelector('.discovery-name').addEventListener('input', (event) => {
      host.name = event.target.value;
      host.nameEdited = true;
    });
    body.appendChild(row);
  });
  table.appendChild(body);
  container.appendChild(table);
  discoveredHosts.forEach((host, idx) => updateDiscoveryRow(idx));
}

// Refreshes the hostname, vendor and suggested name cells of one row.
function updateDiscoveryRow(idx) {
  const host = discoveredHosts[idx];
  const row = document.querySelector(`#discovery-results tr[data-idx="${idx}"]`);
  if (!host || !row) return;
  row.querySelector('.discovery-hostname').textContent = host.hostname || '';
  row.querySelector('.discovery-vendor').textContent = host.vendor || '';
  if (!host.nameEdited) {
    host.name = Discovery.suggestName(host);
    row.querySelector('.discovery-name').value = host.name;
  }
}

async function addDiscoveredNodes() {
  const selected = discoveredHosts.filter(h => h.selected);
  const fields = Discovery.nodesForHosts(selected, state.config.nodes, viewportCenterPercent());
  const stamp = Date.now();

  fields.forEach((field, idx) => {
    const node = Topology.createNode(Object.assign({ id: 'node_' + stamp + '_' + idx }, field));
    if (field.mac) node.mac = field.mac;
    state.config.nodes.push(node);
  });

  const saved = await saveConfig();
  if (saved && saved.success === false) {
    toastError('Save failed', saved.error || 'The topology could not be saved');
  } else if (fields.length > 0) {
    toastSuccess('Devices added', `${fields.length} node${fields.length === 1 ? '' : 's'} added to the canvas`);
  }
  if (selected.length > fields.length) {
    toastInfo('Skipped', `${selected.length - fields.length} address${selected.length - fields.length === 1 ? ' is' : 'es are'} already on the canvas`);
  }
  closeModal('discovery-modal');

  // Restart monitoring with new nodes if it was active
  if (state.monitoringActive) {
    await stopMonitoring();
    await startMonitoring();
  } else {
    // If monitoring is not active, just render from config
    renderTree(state.config.nodes);
    renderHostList(state.config.nodes);
  }
}

export function bindDiscoveryControls() {
  onAction('start-scan', startNetworkScan);
  onAction('add-discovered', addDiscoveredNodes);
}
