// The node create/edit modal: fields, ports, container type and VLAN zones,
// parent container, SSH secret fields, validation and save.

import { Hosts, QuickActions, SnmpUI, Topology, lucide } from './libs.js';
import { escapeHtml, safeCssColor } from './util.js';
import { state } from './state.js';
import {
  closeModal,
  onAction,
  openModal,
  setSecretHint,
  toastError,
  toastSuccess,
  toastWarning
} from './ui.js';
import { saveConfig } from './io.js';
import { renderTree } from './canvas-render.js';
import { renderHostList } from './host-list.js';
import { saveStateForUndo } from './undo.js';
import { startMonitoring, stopMonitoring } from './monitoring.js';

let nodeSecretClear = false;

// Temporary ports storage for the modal
let editingNodePorts = [];

// Variable to track zones being edited
let editingContainerZones = [];

export function openNodeModal(node = null) {
  const isNew = !node;
  document.getElementById('node-modal-title').innerHTML = isNew
    ? '<i data-lucide="plus" class="w-5 h-5 inline mr-2"></i>Add Node'
    : '<i data-lucide="edit" class="w-5 h-5 inline mr-2"></i>Edit Node';

  document.getElementById('node-edit-id').value = node ? node.id : '';
  document.getElementById('node-name').value = node ? node.name : '';
  document.getElementById('node-address').value = node ? node.address : '';
  document.getElementById('node-port').value = node && node.port ? node.port : '';
  document.getElementById('node-icon-type').value = node ? node.iconType : 'lucide';
  document.getElementById('node-icon').value = node ? node.icon : 'circle';
  document.getElementById('node-ssh-port').value = node && node.sshPort ? node.sshPort : 22;
  document.getElementById('node-ssh-user').value = node ? node.sshUser || '' : '';
  document.getElementById('node-ssh-pass').value = '';
  document.getElementById('node-ssh-passphrase').value = '';
  const secretType = Topology.secretType(node);
  const sshAuth = node && (node.sshAuth === 'key' || secretType === 'passphrase') ? 'key' : 'password';
  document.getElementById('node-ssh-auth').value = sshAuth;
  document.getElementById('node-ssh-key-path').value = node && node.sshKeyPath ? node.sshKeyPath : '';
  QuickActions.fillNodeForm(node);
  nodeSecretClear = false;
  refreshNodeSecretHint(node);
  toggleNodeSshAuth();
  SnmpUI.fillForm(node);
  const cable = node ? Topology.primaryCable(state.config, node.id) : null;
  document.getElementById('node-link-type').value = cable ? (cable.medium || '') : '';
  document.getElementById('node-link-speed').value = cable ? (cable.speed || '') : '';

  // Container options
  document.getElementById('node-is-container').value = node && node.isContainer ? 'true' : 'false';
  document.getElementById('node-container-type').value = node ? node.containerType || 'proxmox' : 'proxmox';

  // Load zones for container nodes
  if (node && node.isContainer && node.zones) {
    editingContainerZones = JSON.parse(JSON.stringify(node.zones));
  } else {
    editingContainerZones = [];
  }
  renderContainerZonesList();

  toggleContainerOptions();

  // Populate parent container dropdown
  populateContainerDropdown(node);

  // Set zone for child nodes
  if (node && node.zoneId) {
    const nodeZoneSelect = document.getElementById('node-zone');
    if (nodeZoneSelect) {
      setTimeout(() => {
        nodeZoneSelect.value = node.zoneId;
      }, 0);
    }
  }

  // Initialize ports
  if (node && node.ports && node.ports.length > 0) {
    editingNodePorts = JSON.parse(JSON.stringify(node.ports));
  } else {
    // Default ports for new nodes
    const nodeId = node ? node.id : 'node_' + Date.now();
    editingNodePorts = [
      { id: `${nodeId}_in`, name: 'IN', side: 'top' },
      { id: `${nodeId}_out`, name: 'OUT', side: 'bottom' }
    ];
  }
  renderNodePortsList();

  // Populate parent dropdowns
  const primarySelect = document.getElementById('node-primary-parent');
  const secondarySelect = document.getElementById('node-secondary-parent');

  let options = '<option value="">No Parent (Root)</option>';
  state.config.nodes.forEach(n => {
    if (!node || n.id !== node.id) {
      options += `<option value="${n.id}">${escapeHtml(n.name)}</option>`;
    }
  });

  primarySelect.innerHTML = options;
  secondarySelect.innerHTML = options;

  if (node) {
    primarySelect.value = Topology.parentNodeId(state.config, node.id, 'primary') || '';
    secondarySelect.value = Topology.parentNodeId(state.config, node.id, 'failover') || '';
  }

  openModal('node-modal');
}

// Toggle container type options visibility
function toggleContainerOptions() {
  const isContainer = document.getElementById('node-is-container').value === 'true';
  const containerTypeGroup = document.getElementById('container-type-group');
  const containerZonesGroup = document.getElementById('container-zones-group');
  const containerParentGroup = document.getElementById('container-parent-group');
  const nodeZoneGroup = document.getElementById('node-zone-group');

  containerTypeGroup.style.display = isContainer ? 'block' : 'none';
  containerZonesGroup.style.display = isContainer ? 'block' : 'none';

  // Show parent container and zone selection for non-container nodes
  containerParentGroup.style.display = isContainer ? 'none' : 'block';

  // Update zone dropdown visibility based on parent container selection
  if (!isContainer) {
    updateZoneDropdown();
  } else {
    if (nodeZoneGroup) nodeZoneGroup.style.display = 'none';
  }
}

// Update zone dropdown when parent container changes
function updateZoneDropdown() {
  const containerId = document.getElementById('node-parent-container').value;
  const nodeZoneGroup = document.getElementById('node-zone-group');
  const nodeZoneSelect = document.getElementById('node-zone');

  if (!containerId) {
    if (nodeZoneGroup) nodeZoneGroup.style.display = 'none';
    return;
  }

  const container = state.config.nodes.find(n => n.id === containerId);
  if (!container || !container.zones || container.zones.length === 0) {
    if (nodeZoneGroup) nodeZoneGroup.style.display = 'none';
    return;
  }

  if (nodeZoneGroup) nodeZoneGroup.style.display = 'block';
  let options = '<option value="">No zone (default)</option>';
  container.zones.forEach(zone => {
    options += `<option value="${zone.id}">VLAN ${zone.vlanId} - ${escapeHtml(zone.name)}</option>`;
  });
  if (nodeZoneSelect) nodeZoneSelect.innerHTML = options;
}

// Add a new VLAN zone
function addContainerZone() {
  const newZone = {
    id: 'zone-' + Date.now(),
    vlanId: editingContainerZones.length > 0 ? Math.max(...editingContainerZones.map(z => z.vlanId || 0)) + 10 : 10,
    name: 'New Zone',
    color: getRandomZoneColor()
  };
  editingContainerZones.push(newZone);
  renderContainerZonesList();
}

// Remove a VLAN zone
function removeContainerZone(zoneId) {
  editingContainerZones = editingContainerZones.filter(z => z.id !== zoneId);
  renderContainerZonesList();
}

// Update a VLAN zone property
function updateContainerZone(zoneId, property, value) {
  const zone = editingContainerZones.find(z => z.id === zoneId);
  if (zone) {
    zone[property] = property === 'vlanId' ? parseInt(value) || 0 : value;
  }
}

// Get a random color for zones
function getRandomZoneColor() {
  const colors = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];
  return colors[Math.floor(Math.random() * colors.length)];
}

// Render the zones list in the modal
function renderContainerZonesList() {
  const container = document.getElementById('container-zones-list');
  if (!container) return;

  if (editingContainerZones.length === 0) {
    container.innerHTML = '<div class="text-muted text-sm text-center py-2">No zones defined</div>';
    lucide.createIcons();
    return;
  }

  let html = '';
  editingContainerZones.forEach((zone) => {
    const zoneColor = safeCssColor(zone.color);
    const zoneDomId = escapeHtml(zone.id);
    html += `
      <div class="flex items-center gap-2 p-2 bg-slate-800 rounded mb-2" data-zone-id="${zoneDomId}">
        <input type="color" value="${zoneColor}"
               data-zone-field="color"
               class="w-8 h-8 rounded cursor-pointer border-0" style="padding: 0;">
        <input type="number" value="${escapeHtml(zone.vlanId)}" placeholder="VLAN ID"
               data-zone-field="vlanId"
               class="w-20 px-2 py-1 bg-slate-900 border border-slate-600 rounded text-sm">
        <input type="text" value="${escapeHtml(zone.name)}" placeholder="Zone name"
               data-zone-field="name"
               class="flex-1 px-2 py-1 bg-slate-900 border border-slate-600 rounded text-sm">
        <button data-zone-remove class="p-1 text-red-400 hover:text-red-300">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      </div>
    `;
  });
  container.innerHTML = html;
  container.querySelectorAll('[data-zone-id]').forEach((row) => {
    const zoneId = row.dataset.zoneId;
    row.querySelectorAll('[data-zone-field]').forEach((input) => {
      input.addEventListener('change', () => updateContainerZone(zoneId, input.dataset.zoneField, input.value));
    });
    row.querySelector('[data-zone-remove]').addEventListener('click', () => removeContainerZone(zoneId));
  });
  lucide.createIcons();
}

// Populate container dropdown with available containers
function populateContainerDropdown(currentNode) {
  const select = document.getElementById('node-parent-container');
  let options = '<option value="">No parent (standalone)</option>';

  // Find all container nodes
  state.config.nodes.forEach(n => {
    if (n.isContainer && (!currentNode || n.id !== currentNode.id)) {
      options += `<option value="${n.id}">${escapeHtml(n.name)} (${n.containerType || 'container'})</option>`;
    }
  });

  select.innerHTML = options;

  // Set current value
  if (currentNode && currentNode.containerId) {
    select.value = currentNode.containerId;
  }

  // Update zone dropdown after setting container
  updateZoneDropdown();
}

function renderNodePortsList() {
  const container = document.getElementById('node-ports-list');
  container.innerHTML = '';

  editingNodePorts.forEach((port, idx) => {
    const div = document.createElement('div');
    div.className = 'flex items-center gap-2 p-2 bg-slate-800 rounded';
    div.innerHTML = `
      <input type="text" value="${escapeHtml(port.name)}" placeholder="Name"
             data-port-field="name"
             class="flex-1 px-2 py-1 bg-slate-900 border border-slate-600 rounded text-sm">
      <select data-port-field="side"
              class="px-2 py-1 bg-slate-900 border border-slate-600 rounded text-sm">
        <option value="top" ${port.side === 'top' ? 'selected' : ''}>Top</option>
        <option value="bottom" ${port.side === 'bottom' ? 'selected' : ''}>Bottom</option>
        <option value="left" ${port.side === 'left' ? 'selected' : ''}>Left</option>
        <option value="right" ${port.side === 'right' ? 'selected' : ''}>Right</option>
      </select>
      <button data-port-remove class="p-1 text-red-400 hover:text-red-300">
        <i data-lucide="trash-2" class="w-4 h-4"></i>
      </button>
    `;
    div.querySelectorAll('[data-port-field]').forEach((input) => {
      input.addEventListener('change', () => updateNodePort(idx, input.dataset.portField, input.value));
    });
    div.querySelector('[data-port-remove]').addEventListener('click', () => removeNodePort(idx));
    container.appendChild(div);
  });

  lucide.createIcons();
}

function addNodePort() {
  const nodeId = document.getElementById('node-edit-id').value || 'node_' + Date.now();
  editingNodePorts.push({
    id: `${nodeId}_port_${Date.now()}`,
    name: `Port ${editingNodePorts.length + 1}`,
    side: 'bottom'
  });
  renderNodePortsList();
}

function updateNodePort(idx, field, value) {
  if (editingNodePorts[idx]) {
    editingNodePorts[idx][field] = value;
  }
}

function removeNodePort(idx) {
  editingNodePorts.splice(idx, 1);
  renderNodePortsList();
}

function toggleNodeSshAuth() {
  const useKey = document.getElementById('node-ssh-auth').value === 'key';
  document.getElementById('node-ssh-password-row').classList.toggle('hidden', useKey);
  document.getElementById('node-ssh-key-row').classList.toggle('hidden', !useKey);
}

function refreshNodeSecretHint(node) {
  const type = Topology.secretType(node);
  setSecretHint(
    'node-ssh-pass-hint',
    nodeSecretClear ? 'Secret will be removed' : (type === 'password' ? 'Secret saved' : '')
  );
  setSecretHint(
    'node-ssh-passphrase-hint',
    nodeSecretClear ? 'Secret will be removed' : (type === 'passphrase' ? 'Secret saved' : '')
  );
  const clearButton = document.getElementById('node-ssh-secret-clear');
  if (clearButton) {
    clearButton.classList.toggle('hidden', nodeSecretClear || !type);
  }
}

function clearNodeSecretField() {
  nodeSecretClear = true;
  document.getElementById('node-ssh-pass').value = '';
  document.getElementById('node-ssh-passphrase').value = '';
  refreshNodeSecretHint(null);
}

async function browseNodeSshKey() {
  if (!window.desktopAPI) {
    toastWarning('Not Available', 'File browsing is only available in the desktop application');
    return;
  }
  const result = await window.desktopAPI.ssh.browseKey();
  if (result && result.success) {
    document.getElementById('node-ssh-key-path').value = result.path;
  }
}

async function saveNode() {
  const id = document.getElementById('node-edit-id').value;
  const name = document.getElementById('node-name').value.trim();
  // `[::1]` is stored as `::1`; validateNodeForm rejects anything else invalid.
  const typedAddress = document.getElementById('node-address').value.trim();
  const address = (typedAddress && Hosts.normalizeHost(typedAddress)) || typedAddress;
  const port = document.getElementById('node-port').value.trim();
  const iconType = document.getElementById('node-icon-type').value;
  const icon = document.getElementById('node-icon').value;
  const primaryParentId = document.getElementById('node-primary-parent').value || null;
  const secondaryParentId = document.getElementById('node-secondary-parent').value || null;
  const sshPort = document.getElementById('node-ssh-port').value.trim();
  const sshUser = document.getElementById('node-ssh-user').value;
  const sshAuth = document.getElementById('node-ssh-auth').value === 'key' ? 'key' : 'password';
  const typedPassword = document.getElementById('node-ssh-pass').value;
  const typedPassphrase = document.getElementById('node-ssh-passphrase').value;
  const sshKeyPath = document.getElementById('node-ssh-key-path').value.trim();
  const linkType = document.getElementById('node-link-type').value || null;
  const linkSpeed = document.getElementById('node-link-speed').value || null;

  // Container properties
  const isContainer = document.getElementById('node-is-container').value === 'true';
  const containerType = document.getElementById('node-container-type').value || 'custom';
  const containerId = document.getElementById('node-parent-container').value || null;
  const zoneId = document.getElementById('node-zone')?.value || null;

  if (!validateNodeForm()) return;
  const actionFields = QuickActions.readNodeForm();
  if (!actionFields) return;

  const newNodeId = id || 'node_' + Date.now();

  // Update port IDs if this is a new node
  const ports = editingNodePorts.map(p => ({
    ...p,
    id: p.id.startsWith('node_') ? p.id : `${newNodeId}_${p.name.toLowerCase().replace(/\s+/g, '_')}`
  }));

  const previous = id ? state.config.nodes.find((node) => node.id === id) : null;
  const nodeData = {
    ...(previous || {}),
    id: newNodeId,
    name,
    address,
    port: port ? parseInt(port, 10) : null,
    iconType,
    icon,
    sshPort: sshPort ? parseInt(sshPort, 10) : 22,
    sshUser,
    sshAuth,
    ports,
    isContainer,
    containerType: isContainer ? containerType : null,
    zones: isContainer ? editingContainerZones : null,
    containerId: isContainer ? null : containerId,
    zoneId: isContainer ? null : zoneId
  };
  delete nodeData.primaryParentId;
  delete nodeData.secondaryParentId;
  delete nodeData.activeParentId;
  delete nodeData.linkType;
  delete nodeData.linkSpeed;
  delete nodeData.status;
  delete nodeData.uptime;
  delete nodeData.level;
  delete nodeData.responseTime;
  delete nodeData.probeDetail;
  delete nodeData.sshPass;
  delete nodeData.sshPassphrase;
  delete nodeData._encrypted;
  delete nodeData.sshSecretClear;
  QuickActions.applyNodeFields(nodeData, actionFields);
  if (sshKeyPath) nodeData.sshKeyPath = sshKeyPath;
  else delete nodeData.sshKeyPath;
  if (nodeSecretClear) {
    delete nodeData.sshSecret;
    nodeData.sshSecretClear = true;
  } else if (sshAuth === 'key' && typedPassphrase) {
    nodeData.sshPassphrase = typedPassphrase;
  } else if (sshAuth !== 'key' && typedPassword) {
    nodeData.sshPass = typedPassword;
  }
  const snmpError = SnmpUI.readForm(nodeData);
  if (snmpError) {
    toastError('Validation Error', snmpError);
    return;
  }
  if (!previous) nodeData.expanded = true;

  // Save state for undo before making changes
  saveStateForUndo(id ? `Edit node "${name}"` : `Add node "${name}"`);

  if (id) {
    // Update existing node
    const idx = state.config.nodes.findIndex(n => n.id === id);
    if (idx !== -1) {
      nodeData.x = state.config.nodes[idx].x;
      nodeData.y = state.config.nodes[idx].y;
      if (typeof state.config.nodes[idx].expanded === 'boolean') {
        nodeData.expanded = state.config.nodes[idx].expanded;
      }
      state.config.nodes[idx] = nodeData;
    }
  } else {
    // Add new node - auto position
    const existingCount = state.config.nodes.length;
    const col = existingCount % 10;
    const row = Math.floor(existingCount / 10);
    nodeData.x = (col * 10) + 5;
    nodeData.y = (row * 15) + 10;
    state.config.nodes.push(nodeData);
  }

  Topology.setParent(state.config, newNodeId, 'primary', primaryParentId);
  Topology.setParent(state.config, newNodeId, 'failover', secondaryParentId);
  Topology.setCable(state.config, newNodeId, linkType, linkSpeed);

  const saved = await saveConfig();
  if (!saved || saved.success === false) {
    toastError('Save refused', (saved && saved.error) || 'Save failed');
    return;
  }
  closeModal('node-modal');
  renderTree(state.config.nodes);
  renderHostList(state.config.nodes);

  // Show success toast
  toastSuccess(id ? 'Node Updated' : 'Node Created', `"${name}" has been ${id ? 'updated' : 'added'} successfully`);

  // Restart monitoring with updated config
  if (state.monitoringActive) {
    stopMonitoring().then(() => startMonitoring());
  }
}

// IPv4, IPv6 (optionally `[bracketed]`, or `fe80::1%eth0` on link-local), or
// a hostname. Same rules as the backend (renderer/js/hosts.js).
function isValidHostname(hostname) {
  return !!hostname && Hosts.normalizeHost(hostname) !== null;
}

function isValidPort(port) {
  const num = parseInt(port, 10);
  return !isNaN(num) && num >= 1 && num <= 65535;
}

function validateNodeForm() {
  const name = document.getElementById('node-name').value.trim();
  const address = document.getElementById('node-address').value.trim();
  const port = document.getElementById('node-port').value.trim();
  const sshPort = document.getElementById('node-ssh-port').value.trim();

  if (!name) {
    toastError('Validation Error', 'Node name is required');
    document.getElementById('node-name').focus();
    return false;
  }

  if (address && !isValidHostname(address)) {
    toastError('Validation Error', 'Invalid IPv4/IPv6 address or hostname');
    document.getElementById('node-address').focus();
    return false;
  }

  if (port && !isValidPort(port)) {
    toastError('Validation Error', 'Port must be between 1 and 65535');
    document.getElementById('node-port').focus();
    return false;
  }

  if (sshPort && !isValidPort(sshPort)) {
    toastError('Validation Error', 'SSH port must be between 1 and 65535');
    document.getElementById('node-ssh-port').focus();
    return false;
  }

  return true;
}

export function bindNodeForm() {
  onAction('add-container-zone', addContainerZone);
  onAction('browse-node-ssh-key', browseNodeSshKey);
  onAction('clear-node-secret', clearNodeSecretField);
  onAction('clear-snmp-community', () => SnmpUI.clearFormCommunity());
  onAction('add-node-port', addNodePort);
  onAction('save-node', saveNode);
  document.getElementById('node-is-container').addEventListener('change', () => toggleContainerOptions());
  document.getElementById('node-parent-container').addEventListener('change', () => updateZoneDropdown());
  document.getElementById('node-ssh-auth').addEventListener('change', () => toggleNodeSshAuth());
}
