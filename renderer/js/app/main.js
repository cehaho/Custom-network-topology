// Entry point of the canvas page (index.html loads it as a module after the
// classic library scripts). It wires the modules together, binds the
// toolbar and global shortcuts, and starts everything on DOMContentLoaded.

import { Admin, QuickActions, SnmpUI, Topology, lucide } from './libs.js';
import { state } from './state.js';
import { bindModalControls, openModal, toastError, toastInfo, toastSuccess } from './ui.js';
import { exportConfig, importTopologyInteractive, saveConfig } from './io.js';
import { initSearchUi } from './search-ui.js';
import { deselectConnection, drawLines } from './canvas-links.js';
import { drawGridSystem, renderTree, setNodeEventHandlers } from './canvas-render.js';
import { closeMinimap, initMinimap, toggleMinimap, updateMinimap } from './minimap.js';
import { applyNodeFilter, renderHostList } from './host-list.js';
import { clearSelection } from './selection.js';
import { redo, undo } from './undo.js';
import { deleteSelectedConnection, startConnection, startNodeDrag } from './canvas-edit.js';
import {
  autoLayoutNodes,
  exportTopologyAsImage,
  setupCanvasListeners,
  toggleSnapToGrid,
  updateSnapButton
} from './canvas-view.js';
import {
  setupMonitoringListener,
  startMonitoring,
  stopMonitoring,
  toggleMonitoring
} from './monitoring.js';
import { bindSshControls, setupSSHListeners } from './ssh.js';
import { bindNodeForm, openNodeModal } from './node-form.js';
import { bindContextMenu, hideContextMenu, showNodeContextMenu } from './context-menu.js';
import { bindDiscoveryControls, openDiscoveryModal } from './discovery-ui.js';
import { initTheme, toggleTheme } from './theme.js';
import { initLatencyUi } from './latency-ui.js';

// Quick actions (actions.js) report through the page toasts and open the
// traceroute modal.
QuickActions.useUi({ toastSuccess, toastError, toastInfo, openModal });

// The search box and the latency tooltip listen from load time, as the
// classic scripts did before DOMContentLoaded.
initSearchUi();
initLatencyUi();

setNodeEventHandlers({
  startDrag: startNodeDrag,
  startConnection: startConnection,
  contextMenu: showNodeContextMenu,
  open: openNodeModal
});

async function init() {
  lucide.createIcons();
  drawGridSystem();
  setupEventListeners();
  await loadConfig();
  setupMonitoringListener();
  SnmpUI.attach(() => requestAnimationFrame(drawLines));

  // Initialize theme
  initTheme();

  // Initialize minimap
  initMinimap();

  if (window.desktopAPI) startMonitoring();
}

async function loadConfig() {
  try {
    let raw = null;
    if (window.desktopAPI) {
      raw = await window.desktopAPI.config.load();
    } else {
      const res = await fetch('config.json');
      if (res.ok) raw = await res.json();
    }
    if (raw === null) return;
    if (raw.success === false) {
      toastError('Topology not loaded', raw.error || 'The topology file was not changed');
      return;
    }

    const loaded = Topology.read(raw);
    if (!loaded.ok) {
      console.error(loaded.error);
      toastError('Topology refused', loaded.error);
      return;
    }
    state.config = loaded.document;
    if (loaded.changed && window.desktopAPI) await saveConfig();

    updateSnapButton();
    renderTree(state.config.nodes);
    renderHostList(state.config.nodes);
  } catch (error) {
    console.error('Failed to load config:', error);
  }
}

async function applyImportedTopology(document) {
  state.config = document;
  const saved = await saveConfig();
  if (saved && saved.success === false) {
    toastError('Import refused', saved.error);
    return false;
  }
  updateSnapButton();
  if (state.monitoringActive) {
    await stopMonitoring();
    await startMonitoring();
  } else {
    renderTree(state.config.nodes);
    renderHostList(state.config.nodes);
  }
  const counts = Topology.summary(state.config);
  toastSuccess('Configuration imported', `${counts.nodes} nodes, ${counts.links} links`);
  return true;
}

function openAdminPanel() {
  state.adminOpen = true;
  Admin.open({
    embedded: true,
    getDocument: () => state.config,
    replaceDocument: (document) => {
      state.config = document;
    },
    persist: async () => {
      const result = await saveConfig();
      if (state.monitoringActive && (!result || result.success !== false)) {
        await stopMonitoring();
        await startMonitoring();
      }
      return result || { success: true };
    },
    onClose: () => {
      state.adminOpen = false;
      if (state.monitoringActive && state.networkData.length) {
        const known = new Set(state.config.nodes.map((node) => node.id));
        state.networkData = state.networkData.filter((node) => known.has(node.id));
        state.networkData.forEach((node) => {
          const configNode = state.config.nodes.find((candidate) => candidate.id === node.id);
          if (!configNode) return;
          node.name = configNode.name;
          node.address = configNode.address;
          node.port = configNode.port;
          node.probe = configNode.probe;
          node.icon = configNode.icon;
          node.iconType = configNode.iconType;
          node.ports = configNode.ports;
          node.isContainer = configNode.isContainer;
          node.containerType = configNode.containerType;
          node.containerId = configNode.containerId;
          node.zoneId = configNode.zoneId;
          node.zones = configNode.zones;
          node.expanded = configNode.expanded;
          node.x = configNode.x;
          node.y = configNode.y;
        });
        state.config.nodes.forEach((node) => {
          if (!state.networkData.some((candidate) => candidate.id === node.id)) {
            state.networkData.push(JSON.parse(JSON.stringify(node)));
          }
        });
        renderTree(state.networkData);
        renderHostList(state.networkData);
      } else {
        renderTree(state.config.nodes);
        renderHostList(state.config.nodes);
      }
      updateSnapButton();
      updateMinimap();
    },
    importDocument: importTopologyInteractive
  });
}

function setupEventListeners() {
  setupCanvasListeners();

  // Context menu
  document.addEventListener('click', (e) => {
    if (state.adminOpen) return;
    hideContextMenu();
    // Deselect connection when clicking outside of connections
    if (!e.target.closest('.connection-group') && !e.target.closest('.node-container')) {
      deselectConnection();
    }
  });
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.node-container')) {
      hideContextMenu();
    }
  });

  // Keyboard events - consolidated handler
  document.addEventListener('keydown', (e) => {
    if (state.adminOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        Admin.requestClose();
      }
      return;
    }
    // Check if user is typing in an input field or inside a modal
    const isInModal = e.target.closest('.modal') || e.target.closest('.modal-overlay');
    const isTyping = e.target.tagName === 'INPUT' ||
                     e.target.tagName === 'TEXTAREA' ||
                     e.target.tagName === 'SELECT' ||
                     e.target.isContentEditable;

    // If in modal, don't handle any shortcuts except Escape to close
    if (isInModal) {
      return; // Let the browser handle all keys normally in modals
    }

    // If typing in an input outside modal, still don't intercept
    if (isTyping) {
      return;
    }

    // Delete selected connection with Delete or Backspace key
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedConnectionId) {
      e.preventDefault();
      deleteSelectedConnection();
    }

    // Escape to deselect connection and clear node selection
    if (e.key === 'Escape') {
      deselectConnection();
      clearSelection();
    }

    // Ctrl+Z for Undo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
    }

    // Ctrl+Y or Ctrl+Shift+Z for Redo
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      redo();
    }
  });

  // Toolbar buttons
  document.getElementById('btn-admin').addEventListener('click', () => {
    openAdminPanel();
  });

  document.getElementById('btn-discover').addEventListener('click', openDiscoveryModal);
  document.getElementById('btn-snap').addEventListener('click', toggleSnapToGrid);

  document.getElementById('btn-import').addEventListener('click', async () => {
    const imported = await importTopologyInteractive();
    if (imported) await applyImportedTopology(imported);
  });

  document.getElementById('btn-export').addEventListener('click', exportConfig);

  document.getElementById('btn-monitoring').addEventListener('click', toggleMonitoring);
  document.getElementById('btn-export-image').addEventListener('click', exportTopologyAsImage);
  document.getElementById('btn-auto-layout').addEventListener('click', autoLayoutNodes);

  // Theme toggle
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  // Undo/Redo buttons
  document.getElementById('btn-undo').addEventListener('click', undo);
  document.getElementById('btn-redo').addEventListener('click', redo);

  // Mini-map toggle
  document.getElementById('btn-minimap').addEventListener('click', toggleMinimap);
  document.getElementById('minimap-close').addEventListener('click', closeMinimap);

  // Buttons, selects and menu entries of index.html
  bindModalControls();
  bindSshControls();
  bindDiscoveryControls();
  bindNodeForm();
  bindContextMenu();

  // Search and filter
  document.getElementById('node-search').addEventListener('input', applyNodeFilter);
  document.getElementById('node-filter-status').addEventListener('change', applyNodeFilter);

  // Window resize - use networkData if monitoring, otherwise config
  window.addEventListener('resize', () => {
    if (state.monitoringActive && state.networkData.length) {
      // Merge positions from config before rendering
      state.networkData.forEach(node => {
        const configNode = state.config.nodes.find(n => n.id === node.id);
        if (configNode) {
          node.x = configNode.x;
          node.y = configNode.y;
        }
      });
      renderTree(state.networkData);
    } else if (state.config.nodes.length) {
      renderTree(state.config.nodes);
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  init();
  setupSSHListeners();
});
