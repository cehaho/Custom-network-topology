// The node context menu (right click) and its entries.

import { AppDialog, QuickActions, lucide } from './libs.js';
import { escapeHtml, formatDuration } from './util.js';
import { state } from './state.js';
import { toastError, toastInfo, toastSuccess } from './ui.js';
import { saveConfig } from './io.js';
import { renderTree, toggleContainerExpand } from './canvas-render.js';
import { updateMinimap } from './minimap.js';
import { renderHostList } from './host-list.js';
import { saveStateForUndo } from './undo.js';
import { historyLabel, historyWhen, statusHistory } from './monitoring.js';
import { openSSHModal } from './ssh.js';
import { openNodeModal } from './node-form.js';

let contextMenuNode = null;

export function showNodeContextMenu(e, node) {
  e.preventDefault();
  e.stopPropagation();

  contextMenuNode = node;
  const menu = document.getElementById('context-menu');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';

  // Handle container-specific options
  const containerSection = document.getElementById('context-container-section');
  const childSection = document.getElementById('context-child-section');
  const addToContainerSection = document.getElementById('context-add-to-container-section');
  const addToContainerItems = document.getElementById('context-add-to-container-items');
  const containerToggle = document.getElementById('context-container-toggle');

  // Show container toggle if node is a container
  if (node.isContainer) {
    containerSection.classList.remove('hidden');
    const isExpanded = node.expanded !== false;
    containerToggle.innerHTML = `
      <i data-lucide="${isExpanded ? 'chevrons-down-up' : 'chevrons-up-down'}" class="w-4 h-4"></i>
      <span>${isExpanded ? 'Collapse' : 'Expand'} Container</span>
    `;
  } else {
    containerSection.classList.add('hidden');
  }

  // Show "Remove from container" if node is in a container
  if (node.containerId && !node.isContainer) {
    childSection.classList.remove('hidden');
  } else {
    childSection.classList.add('hidden');
  }

  // Show "Add to container" options for standalone non-container nodes
  const containers = state.config.nodes.filter(n => n.isContainer && n.id !== node.id);
  if (!node.isContainer && !node.containerId && containers.length > 0) {
    addToContainerSection.classList.remove('hidden');
    addToContainerItems.innerHTML = containers.map(c => `
      <div class="context-menu-item" data-add-to-container="${escapeHtml(c.id)}">
        <i data-lucide="log-in" class="w-4 h-4"></i>
        <span>Add to ${escapeHtml(c.name)}</span>
      </div>
    `).join('');
    addToContainerItems.querySelectorAll('[data-add-to-container]').forEach((item) => {
      item.addEventListener('click', () => addToContainerFromContext(item.dataset.addToContainer));
    });
  } else {
    addToContainerSection.classList.add('hidden');
    addToContainerItems.innerHTML = '';
  }

  QuickActions.prepareMenu(node);
  menu.classList.remove('hidden');
  lucide.createIcons();
}

export function hideContextMenu() {
  document.getElementById('context-menu').classList.add('hidden');
  contextMenuNode = null;
}

function openSSHFromContext() {
  const node = contextMenuNode;
  if (!node) return;
  hideContextMenu();
  openSSHModal(node);
}

function editNodeFromContext() {
  const node = contextMenuNode;
  if (!node) return;
  hideContextMenu();
  openNodeModal(node);
}

async function pingNodeFromContext() {
  const node = contextMenuNode;
  if (!node || !window.desktopAPI) return;
  hideContextMenu();

  const result = await window.desktopAPI.network.ping(node.address);
  if (result.success) {
    toastSuccess('Ping Successful', `${node.address} responded in ${result.duration}ms`);
  } else {
    toastError('Ping Failed', `${node.address} did not respond (${result.duration}ms)`);
  }
}

function copyAddressFromContext() {
  const node = contextMenuNode;
  if (!node) return;
  hideContextMenu();
  QuickActions.copyAddress(node);
}

function openWebFromContext() {
  const node = contextMenuNode;
  if (!node) return;
  hideContextMenu();
  QuickActions.openWeb(node);
}

function tracerouteFromContext() {
  const node = contextMenuNode;
  if (!node) return;
  hideContextMenu();
  QuickActions.traceroute(node);
}

function wakeFromContext() {
  const node = contextMenuNode;
  if (!node) return;
  hideContextMenu();
  QuickActions.wake(node);
}

function showStatusHistoryFromContext() {
  const node = contextMenuNode;
  if (!node) return;
  hideContextMenu();

  const history = statusHistory.get(node.id);
  const nodeName = node.name || node.id;
  const samples = history && Array.isArray(history.history) ? history.history : [];

  if (samples.length === 0) {
    toastInfo('Status History', `No history available for "${nodeName}". Start monitoring to track status.`);
    return;
  }

  const current = historyLabel(history.lastStatus);
  const held = history.lastChange ? ` for ${formatDuration(Date.now() - history.lastChange)}` : '';
  let message = `Current: ${current}${held}\n\n`;
  message += 'Recent samples:\n';

  samples.slice(-5).reverse().forEach((entry) => {
    const delay = entry.responseTime == null ? '' : ` (${entry.responseTime} ms)`;
    message += `• ${historyWhen(entry)}: ${historyLabel(entry.status)}${delay}\n`;
  });

  // Show as an in-page alert (could be improved with a dedicated modal)
  AppDialog.alert(`Status History for "${nodeName}"\n\n${message}`);
}

async function deleteNodeFromContext() {
  const node = contextMenuNode;
  if (!node) return;
  hideContextMenu();

  if (await AppDialog.confirm(`Delete node "${node.name}"?`, { danger: true })) {
    // Save state for undo
    saveStateForUndo(`Delete node "${node.name}"`);

    const idx = state.config.nodes.findIndex(n => n.id === node.id);
    if (idx !== -1) {
      // If this is a container, also remove containerId from children
      if (node.isContainer) {
        state.config.nodes.forEach(n => {
          if (n.containerId === node.id) {
            n.containerId = null;
          }
        });
      }
      // Also remove connections involving this node
      state.config.links = state.config.links.filter(c =>
        c.sourceNodeId !== node.id && c.targetNodeId !== node.id
      );
      state.config.nodes.splice(idx, 1);
      saveConfig();
      renderTree(state.config.nodes);
      renderHostList(state.config.nodes);
      updateMinimap();
      toastSuccess('Node Deleted', `"${node.name}" has been removed`);
    }
  }
}

function toggleContainerFromContext() {
  const node = contextMenuNode;
  if (!node || !node.isContainer) return;
  hideContextMenu();
  toggleContainerExpand(node.id);
}

function removeFromContainerFromContext() {
  const node = contextMenuNode;
  if (!node || !node.containerId) return;
  hideContextMenu();
  removeFromContainer(node.id);
}

function addToContainerFromContext(containerId) {
  const node = contextMenuNode;
  if (!node || node.isContainer) return;
  hideContextMenu();
  addToContainer(node.id, containerId);
}

// Remove node from container (make it standalone)
function removeFromContainer(nodeId) {
  const node = state.config.nodes.find(n => n.id === nodeId);
  if (node && node.containerId) {
    saveStateForUndo(`Remove "${node.name}" from container`);
    node.containerId = null;
    node.zoneId = null; // Also clear zone assignment
    renderTree(state.config.nodes);
    saveConfig();
    toastSuccess('Container', 'Node removed from container');
  }
}

// Add node to container (optionally to a specific zone)
function addToContainer(nodeId, containerId, zoneId = null) {
  const node = state.config.nodes.find(n => n.id === nodeId);
  const container = state.config.nodes.find(n => n.id === containerId);
  if (node && container && container.isContainer && !node.isContainer) {
    saveStateForUndo(`Add "${node.name}" to ${container.name}`);
    node.containerId = containerId;
    node.zoneId = zoneId;
    renderTree(state.config.nodes);
    saveConfig();
    toastSuccess('Container', `Node added to ${container.name}`);
  }
}

export function bindContextMenu() {
  const contextActions = {
    ssh: openSSHFromContext,
    edit: editNodeFromContext,
    ping: pingNodeFromContext,
    traceroute: tracerouteFromContext,
    'copy-address': copyAddressFromContext,
    'open-web': openWebFromContext,
    wake: wakeFromContext,
    'status-history': showStatusHistoryFromContext,
    'toggle-container': toggleContainerFromContext,
    'remove-from-container': removeFromContainerFromContext,
    delete: deleteNodeFromContext
  };
  document.querySelectorAll('[data-context-action]').forEach((item) => {
    const handler = contextActions[item.dataset.contextAction];
    if (handler) item.addEventListener('click', () => handler());
  });
}
