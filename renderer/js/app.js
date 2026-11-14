// ============================================
// Network Topology Application
// ============================================

// State
let config = Topology.emptyDocument();
let adminOpen = false;
let networkData = [];
let terminals = new Map();
let activeTerminal = null;
let monitoringActive = false;
let contextMenuNode = null;
let uptimeTrackers = new Map();
let pendingImportToken = null;
let nodeSecretClear = false;

// Status history tracking
let statusHistory = new Map(); // nodeId -> { lastStatus, lastChange, history: [{status, time}] }
const MAX_HISTORY_ENTRIES = 50;

// Connection dragging state
let isConnecting = false;
let connectionStart = null; // { nodeId, portId, element }

// Selected connection for deletion
let selectedConnectionId = null;

// Zoom/Pan Variables
let scale = 1, pointX = 0, pointY = 0, isPanning = false, startX = 0, startY = 0;

// Drag Variables
let isDragging = false, dragNode = null, dragStartX = 0, dragStartY = 0, nodeStartX = 0, nodeStartY = 0;

// Multi-select state
let selectedNodes = new Set();
let isSelecting = false;
let selectionStart = { x: 0, y: 0 };

// Undo/Redo state
let undoStack = [];
let redoStack = [];
const MAX_UNDO_HISTORY = 50;

// Mini-map state
let minimapVisible = false;

// Grid System Constants
const gridCols = [];
for (let i = 0; i < 26; i++) gridCols.push(String.fromCharCode(65 + i));
for (let i = 0; i < 26; i++) gridCols.push('A' + String.fromCharCode(65 + i));

// DOM Elements
const viewport = document.getElementById('viewport');
const world = document.getElementById('world');

// ============================================
// Initialization
// ============================================

async function init() {
  lucide.createIcons();
  drawGridSystem();
  setupEventListeners();
  await loadConfig();
  setupMonitoringListener();

  // Initialize theme
  initTheme();

  // Initialize minimap
  initMinimap();

  if (window.electronAPI) startMonitoring();
}

async function loadConfig() {
  try {
    let raw = null;
    if (window.electronAPI) {
      raw = await window.electronAPI.config.load();
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
    config = loaded.document;
    if (loaded.changed && window.electronAPI) await saveConfig();

    updateSnapButton();
    renderTree(config.nodes);
    renderHostList(config.nodes);
  } catch (error) {
    console.error('Failed to load config:', error);
  }
}

async function saveConfig() {
  const prepared = Topology.prepare(config);
  if (!prepared.ok) {
    console.error(prepared.error);
    return { success: false, error: prepared.error };
  }
  const snapshot = prepared.document;
  try {
    if (!window.electronAPI) {
      config = snapshot;
      if (Topology.hasSecretValues(snapshot)) {
        (config.nodes || []).forEach((node) => Topology.stripNodeSecretValues(node));
        return {
          success: false,
          error: 'The system keyring is unavailable. The password was not saved.'
        };
      }
      return { success: true };
    }
    const result = await window.electronAPI.config.save(snapshot, pendingImportToken);
    if (result && result.success !== false && result.config) {
      const loaded = Topology.read(result.config);
      config = loaded.ok ? loaded.document : Topology.withoutSecretValues(snapshot);
      pendingImportToken = null;
      return result;
    }
    config = snapshot;
    (config.nodes || []).forEach((node) => Topology.stripNodeSecretValues(node));
    return result || { success: false, error: 'Save failed' };
  } catch (error) {
    console.error('Failed to save config:', error);
    config = snapshot;
    (config.nodes || []).forEach((node) => Topology.stripNodeSecretValues(node));
    return { success: false, error: error && error.message ? error.message : 'Save failed' };
  }
}

async function importTopologyInteractive() {
  if (!window.electronAPI) return null;
  const result = await window.electronAPI.config.import();
  if (!result || result.canceled) return null;
  if (!result.success || !result.config) {
    toastError('Import refused', (result && result.error) || 'Import failed');
    return null;
  }
  const loaded = Topology.read(result.config);
  if (!loaded.ok) {
    toastError('Import refused', loaded.error);
    return null;
  }
  if (!window.confirm(Topology.importMessage(loaded.document))) {
    pendingImportToken = null;
    if (window.electronAPI.config.discardImport) await window.electronAPI.config.discardImport();
    return null;
  }
  pendingImportToken = result.importToken || null;
  return loaded.document;
}

async function applyImportedTopology(document) {
  config = document;
  const saved = await saveConfig();
  if (saved && saved.success === false) {
    toastError('Import refused', saved.error);
    return false;
  }
  updateSnapButton();
  if (monitoringActive) {
    await stopMonitoring();
    await startMonitoring();
  } else {
    renderTree(config.nodes);
    renderHostList(config.nodes);
  }
  const counts = Topology.summary(config);
  toastSuccess('Configuration imported', `${counts.nodes} nodes, ${counts.links} links`);
  return true;
}

function parentIdOf(nodeId, role) {
  return Topology.parentNodeId(config, nodeId, role);
}

function openAdminPanel() {
  adminOpen = true;
  Admin.open({
    embedded: true,
    getDocument: () => config,
    replaceDocument: (document) => {
      config = document;
    },
    persist: async () => {
      const result = await saveConfig();
      if (monitoringActive && (!result || result.success !== false)) {
        await stopMonitoring();
        await startMonitoring();
      }
      return result || { success: true };
    },
    onClose: () => {
      adminOpen = false;
      if (monitoringActive && networkData.length) {
        const known = new Set(config.nodes.map((node) => node.id));
        networkData = networkData.filter((node) => known.has(node.id));
        networkData.forEach((node) => {
          const configNode = config.nodes.find((candidate) => candidate.id === node.id);
          if (!configNode) return;
          node.name = configNode.name;
          node.address = configNode.address;
          node.port = configNode.port;
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
        config.nodes.forEach((node) => {
          if (!networkData.some((candidate) => candidate.id === node.id)) {
            networkData.push(JSON.parse(JSON.stringify(node)));
          }
        });
        renderTree(networkData);
        renderHostList(networkData);
      } else {
        renderTree(config.nodes);
        renderHostList(config.nodes);
      }
      updateSnapButton();
      updateMinimap();
    },
    importDocument: importTopologyInteractive
  });
}

// ============================================
// Grid System
// ============================================

function drawGridSystem() {
  const labelContainer = document.getElementById('grid-labels');
  labelContainer.innerHTML = '';

  gridCols.forEach((char, i) => {
    const el = document.createElement('div');
    el.className = 'grid-label';
    el.innerText = char;
    el.style.top = '0';
    el.style.left = (i * 5) + 'vw';
    el.style.width = '5vw';
    el.style.height = '20px';
    labelContainer.appendChild(el);
  });

  for (let i = 1; i <= 50; i++) {
    const el = document.createElement('div');
    el.className = 'grid-label';
    el.innerText = i;
    el.style.left = '0';
    el.style.top = ((i - 1) * 5) + 'vh';
    el.style.height = '5vh';
    el.style.width = '20px';
    el.style.justifyContent = 'flex-start';
    el.style.paddingLeft = '4px';
    labelContainer.appendChild(el);
  }
}

function snapToGrid(x, y) {
  if (!config.settings.snapToGrid) return { x, y };

  // Snap to 5% grid (matching the visual grid)
  const gridStep = 5;
  const offset = 2.5; // Center of grid cell

  const snappedX = Math.round((x - offset) / gridStep) * gridStep + offset;
  const snappedY = Math.round((y - offset) / gridStep) * gridStep + offset;

  return {
    x: Math.max(2.5, Math.min(97.5, snappedX)),
    y: Math.max(2.5, Math.min(247.5, snappedY)) // 50 rows * 5% = 250%, center at 247.5
  };
}

function getGridCell(x, y) {
  const colIndex = Math.floor((x - 0.01) / 5);
  const rowIndex = Math.floor((y - 0.01) / 5) + 1;

  const col = colIndex >= 0 && colIndex < gridCols.length ? gridCols[colIndex] : '?';
  const row = rowIndex >= 1 && rowIndex <= 50 ? rowIndex : '?';

  return { col, row };
}

// ============================================
// Zoom & Pan
// ============================================

function setupEventListeners() {
  // Zoom
  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const xs = (e.clientX - pointX) / scale;
    const ys = (e.clientY - pointY) / scale;
    const delta = -e.deltaY;
    scale = delta > 0 ? scale * 1.1 : scale / 1.1;
    scale = Math.min(Math.max(0.1, scale), 5);
    pointX = e.clientX - xs * scale;
    pointY = e.clientY - ys * scale;
    updateTransform();
  });

  // Pan and Multi-select
  viewport.addEventListener('mousedown', (e) => {
    if (e.target.closest('.node-container')) return;
    if (isDragging) return; // Don't start panning while dragging

    // Shift+click starts selection rectangle
    if (e.shiftKey) {
      startSelectionRect(e);
      return;
    }

    // Clear selection when clicking on empty area without shift
    if (!e.shiftKey && !e.ctrlKey) {
      clearSelection();
    }

    isPanning = true;
    startX = e.clientX - pointX;
    startY = e.clientY - pointY;
  });

  window.addEventListener('mousemove', (e) => {
    if (isSelecting) {
      updateSelectionRect(e);
      return;
    }
    if (isDragging && dragNode) {
      handleNodeDrag(e);
      return;
    }
    if (!isPanning) return;
    e.preventDefault();
    pointX = e.clientX - startX;
    pointY = e.clientY - startY;
    updateTransform();
    updateMinimap();
  });

  window.addEventListener('mouseup', async (e) => {
    if (isSelecting) {
      endSelectionRect(e);
      return;
    }
    isPanning = false;
    if (isDragging && dragNode) {
      await endNodeDrag(e);
    }
  });

  // Context menu
  document.addEventListener('click', (e) => {
    if (adminOpen) return;
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
    if (adminOpen) {
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
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedConnectionId) {
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

  document.getElementById('btn-export').addEventListener('click', async () => {
    if (!window.electronAPI) return;
    const prepared = Topology.prepare(config);
    if (!prepared.ok) {
      toastError('Export refused', prepared.error);
      return;
    }
    const exported = Topology.withoutSecretValues(prepared.document);
    const result = await window.electronAPI.config.export(exported);
    if (result && result.success === false && !result.canceled) {
      toastError('Export refused', result.error || 'Export failed');
    }
  });

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
  document.getElementById('minimap-close').addEventListener('click', () => {
    minimapVisible = false;
    document.getElementById('minimap').classList.add('hidden');
    document.getElementById('btn-minimap').classList.remove('active');
  });

  // Search and filter
  document.getElementById('node-search').addEventListener('input', applyNodeFilter);
  document.getElementById('node-filter-status').addEventListener('change', applyNodeFilter);

  // Window resize - use networkData if monitoring, otherwise config
  window.addEventListener('resize', () => {
    if (monitoringActive && networkData.length) {
      // Merge positions from config before rendering
      networkData.forEach(node => {
        const configNode = config.nodes.find(n => n.id === node.id);
        if (configNode) {
          node.x = configNode.x;
          node.y = configNode.y;
        }
      });
      renderTree(networkData);
    } else if (config.nodes.length) {
      renderTree(config.nodes);
    }
  });
}

function updateTransform() {
  world.style.transform = `translate(${pointX}px, ${pointY}px) scale(${scale})`;
}

// ============================================
// Node Rendering
// ============================================

function displayedNodes() {
  return monitoringActive && networkData.length ? networkData : config.nodes;
}

function statusView(status) {
  const state = Probe.canonicalStatus(status);
  if (state === 'up') {
    return {
      state: state,
      label: 'ONLINE',
      short: 'ON',
      className: 'online',
      color: '#16a34a',
      background: 'rgba(34,197,94,0.06)',
      dot: 'bg-green-500',
      text: 'text-green-400'
    };
  }
  if (state === 'down') {
    return {
      state: state,
      label: 'OFFLINE',
      short: 'OFF',
      className: 'offline',
      color: '#ef4444',
      background: 'rgba(239,68,68,0.06)',
      dot: 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]',
      text: 'text-red-400 font-bold'
    };
  }
  return {
    state: state,
    label: 'UNKNOWN',
    short: '…',
    className: 'unknown',
    color: '#94a3b8',
    background: 'rgba(148,163,184,0.08)',
    dot: 'bg-slate-400',
    text: 'text-slate-400'
  };
}

function statusLabel(node, statusById, view) {
  const active = Probe.activeLink(config.links, node.id, statusById);
  if (active && active.role === 'failover') return view.label + ' · FAILOVER';
  return view.label;
}

function linkAppearance(conn, nodes) {
  const statusById = new Map((nodes || []).map((node) => [node.id, node.status]));
  const active = Probe.activeLink(config.links, conn.targetNodeId, statusById);
  const isActive = Boolean(active && active.id === conn.id);
  return Probe.linkLook(
    conn.role,
    isActive,
    statusById.get(conn.sourceNodeId),
    statusById.get(conn.targetNodeId)
  );
}

function renderTree(nodes) {
  const container = document.getElementById('tree-container');
  container.innerHTML = '';

  const nodeMap = {};
  const primaryById = {};
  const statusById = new Map();
  nodes.forEach(n => {
    primaryById[n.id] = parentIdOf(n.id, 'primary');
    n.level = 0;
    nodeMap[n.id] = n;
    statusById.set(n.id, n.status);
  });

  // Calculate levels from primary links. The parent id is not stored on the node.
  for (let i = 0; i < 6; i++) {
    nodes.forEach(n => {
      const parentId = primaryById[n.id];
      if (parentId && nodeMap[parentId]) {
        n.level = Math.max(n.level, nodeMap[parentId].level + 1);
      }
    });
  }

  const maxLevel = nodes.reduce((m, x) => Math.max(m, x.level || 0), 0);
  const levels = {};
  for (let l = 0; l <= maxLevel; l++) {
    levels[l] = nodes.filter(n => n.level === l);
  }

  // Helper function to generate ports HTML
  function generatePortsHtml(node) {
    const ports = node.ports || [];
    const portsByPosition = { top: [], bottom: [], left: [], right: [] };
    ports.forEach(port => {
      if (portsByPosition[port.side]) {
        portsByPosition[port.side].push(port);
      }
    });

    const totalPorts = ports.length;
    const hasMultiplePorts = totalPorts >= 2;

    let portsHtml = '<div class="node-ports">';
    Object.entries(portsByPosition).forEach(([side, sidePorts]) => {
      const count = sidePorts.length;
      sidePorts.forEach((port, idx) => {
        const isConnected = config.links.some(c =>
          (c.sourceNodeId === node.id && c.sourcePortId === port.id) ||
          (c.targetNodeId === node.id && c.targetPortId === port.id)
        );

        let posPercent = 50;
        if (count > 1) {
          posPercent = ((idx + 1) / (count + 1)) * 100;
        }

        let posStyle = '';
        if (side === 'top' || side === 'bottom') {
          posStyle = `left: ${posPercent}%; transform: translateX(-50%);`;
          if (side === 'top') posStyle += ' top: -6px;';
          else posStyle += ' bottom: -6px;';
        } else {
          posStyle = `top: ${posPercent}%; transform: translateY(-50%);`;
          if (side === 'left') posStyle += ' left: -6px;';
          else posStyle += ' right: -6px;';
        }

        const alwaysVisible = (side === 'bottom' || hasMultiplePorts) ? 'always-visible' : '';

        portsHtml += `
          <div class="port-handle ${isConnected ? 'connected' : ''}"
               style="${posStyle}"
               data-node-id="${node.id}"
               data-port-id="${port.id}"
               data-side="${side}"
               data-index="${idx}"
               title="${escapeHtml(port.name)}"></div>
          <span class="port-label ${alwaysVisible}" style="${posStyle}">${escapeHtml(port.name)}</span>
        `;
      });
    });
    portsHtml += '</div>';
    return portsHtml;
  }

  // Helper function to generate icon HTML
  function generateIconHtml(node) {
    if (node.iconType === 'url') {
      return `<img src="${escapeHtml(node.icon || '')}" class="w-full h-full object-cover" onerror="this.style.display='none'">`;
    }
    if (node.iconType === 'svg') {
      return sanitizeSvg(node.icon) || '<i data-lucide="help-circle" class="w-8 h-8"></i>';
    }
    return `<i data-lucide="${safeLucideName(node.icon)}" class="w-8 h-8"></i>`;
  }

  // Separate containers from regular nodes
  const containerNodes = nodes.filter(n => n.isContainer);
  const childNodes = nodes.filter(n => n.containerId && !n.isContainer);
  const standaloneNodes = nodes.filter(n => !n.isContainer && !n.containerId);

  // First, render container nodes
  containerNodes.forEach(node => {
    const el = document.createElement('div');
    el.id = `node-${node.id}`;
    el.className = `node-container card is-container container-${safeContainerType(node.containerType)}`;
    el.dataset.nodeId = node.id;
    el.dataset.isContainer = 'true';

    // Get children of this container
    const children = childNodes.filter(c => c.containerId === node.id);
    const isExpanded = node.expanded !== false;

    let leftPos, topPos;
    if (node.x !== null && node.x !== undefined) {
      leftPos = node.x + '%';
    } else {
      const levelNodes = levels[node.level];
      const idx = levelNodes.indexOf(node);
      const slice = 100 / (levelNodes.length + 1);
      leftPos = (slice * (idx + 1)) + '%';
    }
    if (node.y !== null && node.y !== undefined) {
      topPos = node.y + '%';
    } else {
      topPos = (maxLevel === 0) ? '50%' : (85 - (node.level * (70 / maxLevel))) + '%';
    }

    el.style.left = leftPos;
    el.style.top = topPos;
    el.style.pointerEvents = 'auto';

    const view = statusView(node.status);
    const iconHtml = generateIconHtml(node);
    const portsHtml = generatePortsHtml(node);

    // Container type labels
    const containerTypeLabels = {
      proxmox: 'Proxmox',
      docker: 'Docker',
      kubernetes: 'K8s',
      vmware: 'VMware',
      rack: 'Rack',
      cloud: 'Cloud',
      custom: 'Container'
    };

    // Helper function to generate child node HTML
    function generateChildHtml(child, idx) {
      const childView = statusView(child.status);
      const childIconHtml = generateIconHtml(child);
      return `
        <div class="child-node" data-node-id="${child.id}" data-child-index="${idx}">
          <div class="child-node-icon">
            ${childIconHtml}
          </div>
          <div class="child-node-info">
            <div class="child-node-name">${escapeHtml(child.name || child.id)}</div>
            <div class="child-node-address">${escapeHtml(child.address || '')}</div>
          </div>
          <div class="child-node-status ${childView.className}">
            ${childView.short}
          </div>
        </div>
      `;
    }

    // Generate children HTML with VLAN zones support
    let childrenHtml = '';
    const zones = node.zones || [];

    if (isExpanded) {
      if (zones.length > 0) {
        // Group children by zones
        zones.forEach(zone => {
          const zoneChildren = children.filter(c => c.zoneId === zone.id);
          const zoneColor = safeCssColor(zone.color);

          childrenHtml += `
            <div class="vlan-zone" data-zone-id="${escapeHtml(zone.id)}">
              <div class="vlan-zone-header" onclick="toggleZoneCollapse('${jsAttr(node.id)}', '${jsAttr(zone.id)}')">
                <div class="vlan-zone-header-left">
                  <span class="vlan-zone-badge" style="background: ${zoneColor}20; color: ${zoneColor}; border: 1px solid ${zoneColor}40;">
                    VLAN ${escapeHtml(zone.vlanId)}
                  </span>
                  <span class="vlan-zone-name">${escapeHtml(zone.name)}</span>
                </div>
                <span class="vlan-zone-count">${zoneChildren.length} node${zoneChildren.length !== 1 ? 's' : ''}</span>
              </div>
              <div class="vlan-zone-content" id="zone-content-${zone.id}">
                ${zoneChildren.length > 0
                  ? zoneChildren.map((child, idx) => generateChildHtml(child, idx)).join('')
                  : '<div class="vlan-zone-empty">No nodes in this zone</div>'
                }
                <div class="vlan-zone-drop" data-container-id="${node.id}" data-zone-id="${zone.id}">
                  Drop node here
                </div>
              </div>
            </div>
          `;
        });

        // Show unassigned nodes (not in any zone)
        const unassignedNodes = children.filter(c => !c.zoneId);
        if (unassignedNodes.length > 0) {
          childrenHtml += `
            <div class="vlan-zone">
              <div class="vlan-zone-header">
                <div class="vlan-zone-header-left">
                  <span class="vlan-zone-badge" style="background: rgba(100,100,100,0.2); color: #888;">
                    DEFAULT
                  </span>
                  <span class="vlan-zone-name">Unassigned</span>
                </div>
                <span class="vlan-zone-count">${unassignedNodes.length} node${unassignedNodes.length !== 1 ? 's' : ''}</span>
              </div>
              <div class="vlan-zone-content">
                ${unassignedNodes.map((child, idx) => generateChildHtml(child, idx)).join('')}
              </div>
            </div>
          `;
        }
      } else if (children.length > 0) {
        // No zones defined, show all children flat
        children.forEach((child, idx) => {
          childrenHtml += generateChildHtml(child, idx);
        });
      }
    }

    el.innerHTML = `
      ${portsHtml}
      <div class="container-header">
        <div class="container-header-left">
          <button class="container-toggle" onclick="toggleContainerExpand('${node.id}')">
            <i data-lucide="${isExpanded ? 'chevron-down' : 'chevron-right'}" class="w-4 h-4"></i>
          </button>
          <div class="container-icon">
            ${iconHtml}
          </div>
          <div class="container-title">
            <div class="container-name">${escapeHtml(node.name || node.id)}</div>
            <div class="container-type-badge">${containerTypeLabels[node.containerType] || 'Container'}</div>
          </div>
        </div>
        <div class="container-header-right">
          <span class="container-count">${children.length} node${children.length !== 1 ? 's' : ''}</span>
          <div class="container-status ${view.className}">
            ${statusLabel(node, statusById, view)}
          </div>
        </div>
      </div>
      <div class="container-content ${isExpanded ? '' : 'collapsed'}">
        ${childrenHtml || '<div class="container-empty">Drop nodes here or create new ones</div>'}
        ${zones.length === 0 ? `
          <div class="container-drop-zone" data-container-id="${node.id}">
            <i data-lucide="plus" class="w-4 h-4"></i>
            <span>Drop node here</span>
          </div>
        ` : ''}
      </div>
    `;

    // Event listeners for container
    el.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('port-handle')) return;
      if (e.target.closest('.container-toggle')) return;
      if (e.target.closest('.child-node')) return;
      startNodeDrag(e, node);
    });
    el.addEventListener('contextmenu', (e) => showNodeContextMenu(e, node));
    el.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.child-node') && !e.target.closest('.container-toggle')) {
        openNodeModal(node);
      }
    });

    // Child node event listeners
    el.querySelectorAll('.child-node').forEach(childEl => {
      const childId = childEl.dataset.nodeId;
      const childNode = children.find(c => c.id === childId);
      if (childNode) {
        childEl.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          openNodeModal(childNode);
        });
        childEl.addEventListener('contextmenu', (e) => {
          e.stopPropagation();
          showNodeContextMenu(e, childNode);
        });
      }
    });

    // Port event listeners
    el.querySelectorAll('.port-handle').forEach(portEl => {
      portEl.addEventListener('mousedown', (e) => startConnection(e, node, portEl));
    });

    container.appendChild(el);
  });

  // Then render standalone nodes (not in any container)
  standaloneNodes.forEach(node => {
    const el = document.createElement('div');
    el.id = `node-${node.id}`;
    el.className = 'node-container card';
    el.dataset.nodeId = node.id;

    let leftPos, topPos;
    if (node.x !== null && node.x !== undefined) {
      leftPos = node.x + '%';
    } else {
      const levelNodes = levels[node.level];
      const idx = levelNodes.indexOf(node);
      const slice = 100 / (levelNodes.length + 1);
      leftPos = (slice * (idx + 1)) + '%';
    }
    if (node.y !== null && node.y !== undefined) {
      topPos = node.y + '%';
    } else {
      topPos = (maxLevel === 0) ? '50%' : (85 - (node.level * (70 / maxLevel))) + '%';
    }

    el.style.left = leftPos;
    el.style.top = topPos;
    el.style.width = '140px';
    el.style.height = '140px';
    el.style.pointerEvents = 'auto';

    const view = statusView(node.status);
    const iconHtml = generateIconHtml(node);
    const gridCell = getGridCell(node.x || 50, node.y || 50);
    const portsHtml = generatePortsHtml(node);

    el.innerHTML = `
      ${portsHtml}
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:6px; padding:10px; box-sizing:border-box;">
        <div style="width:48px; height:48px; border-radius:999px; display:flex; align-items:center; justify-content:center; background: rgba(0,0,0,0.15); border:1px solid rgba(255,255,255,0.03); overflow:hidden;">
          ${iconHtml}
        </div>
        <div style="text-align:center; width:100%; color:#e6eef8;">
          <div style="font-weight:700; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(node.name || node.id)}</div>
          <div style="font-size:11px; color:var(--muted); font-family:monospace;">${escapeHtml(node.address || '')}</div>
          <div style="font-size:9px; color:#475569; font-family:monospace;">${gridCell.col}${gridCell.row}</div>
          <div style="margin-top:6px; font-size:10px; padding:4px 6px; border-radius:999px; display:inline-block; color:${view.color}; background:${view.background}; border:1px solid rgba(255,255,255,0.02); font-weight:700; letter-spacing:0.6px;">
            ${statusLabel(node, statusById, view)}
          </div>
        </div>
      </div>
    `;

    // Event listeners for node interaction
    el.addEventListener('mousedown', (e) => {
      // Don't start node drag if clicking on a port
      if (e.target.classList.contains('port-handle')) return;
      startNodeDrag(e, node);
    });
    el.addEventListener('contextmenu', (e) => showNodeContextMenu(e, node));
    el.addEventListener('dblclick', () => openNodeModal(node));

    // Port event listeners
    el.querySelectorAll('.port-handle').forEach(portEl => {
      portEl.addEventListener('mousedown', (e) => startConnection(e, node, portEl));
    });

    container.appendChild(el);
  });

  lucide.createIcons();
  requestAnimationFrame(drawLines);
}

function drawLines() {
  const svg = document.getElementById('connections-layer');
  if (!svg) return;
  svg.setAttribute('width', '300%');
  svg.setAttribute('height', '300%');
  svg.innerHTML = '';

  // Draw connections from config.links array
  config.links.forEach(conn => {
    const sourceNode = config.nodes.find(n => n.id === conn.sourceNodeId);
    const targetNode = config.nodes.find(n => n.id === conn.targetNodeId);
    if (!sourceNode || !targetNode) return;

    const sourceEl = document.getElementById(`node-${conn.sourceNodeId}`);
    const targetEl = document.getElementById(`node-${conn.targetNodeId}`);
    if (!sourceEl || !targetEl) return;

    // Get port positions
    const sourcePort = sourceNode.ports?.find(p => p.id === conn.sourcePortId);
    const targetPort = targetNode.ports?.find(p => p.id === conn.targetPortId);

    // Calculate connection points based on port positions
    const sourcePos = getPortPosition(sourceEl, sourcePort, sourceNode);
    const targetPos = getPortPosition(targetEl, targetPort, targetNode);

    const x1 = sourcePos.x;
    const y1 = sourcePos.y;
    const x2 = targetPos.x;
    const y2 = targetPos.y;

    // Create bezier curve path
    const d = createBezierPath(x1, y1, x2, y2, sourcePort?.side || 'bottom', targetPort?.side || 'top');

    const look = linkAppearance(conn, displayedNodes());
    const baseColor = look.color;

    // Create group for this connection
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.classList.add('connection-group');
    group.dataset.connectionId = conn.id;
    if (selectedConnectionId === conn.id) {
      group.classList.add('selected');
    }

    // Invisible hitbox for easier clicking
    const hitbox = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hitbox.setAttribute('d', d);
    hitbox.classList.add('connection-hitbox');
    group.appendChild(hitbox);

    // Base path
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', baseColor);
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-opacity', look.waiting ? '0.28' : '0.45');
    if (look.waiting) path.setAttribute('stroke-dasharray', '2 7');
    path.classList.add('connection-main');
    group.appendChild(path);

    // Only the active link, and only while both ends answer, moves.
    if (look.animate) {
      const pathFwd = document.createElementNS("http://www.w3.org/2000/svg", "path");
      pathFwd.setAttribute('d', d);
      pathFwd.setAttribute('fill', 'none');
      pathFwd.setAttribute('stroke', baseColor);
      pathFwd.setAttribute('stroke-width', '2');
      pathFwd.setAttribute('stroke-dasharray', '8 8');
      pathFwd.classList.add('animate-flow', 'connection-animated');
      group.appendChild(pathFwd);

      const pathRev = document.createElementNS("http://www.w3.org/2000/svg", "path");
      pathRev.setAttribute('d', d);
      pathRev.setAttribute('fill', 'none');
      pathRev.setAttribute('stroke', baseColor);
      pathRev.setAttribute('stroke-width', '2');
      pathRev.setAttribute('stroke-dasharray', '8 8');
      pathRev.setAttribute('stroke-opacity', '0.6');
      pathRev.classList.add('animate-flow-reverse', 'connection-animated');
      group.appendChild(pathRev);
    }

    // Click handler for selection
    group.addEventListener('click', (e) => {
      e.stopPropagation();
      selectConnection(conn.id);
    });

    // Enable pointer events for connection groups
    group.style.pointerEvents = 'auto';

    svg.appendChild(group);

    // Draw link speed/type label if available
    if (conn.medium || conn.speed) {
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;

      let labelParts = [];
      if (conn.medium) labelParts.push(conn.medium);
      if (conn.speed) labelParts.push(conn.speed);
      const labelText = labelParts.join(' ');

      const textBg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      const textWidth = labelText.length * 6 + 8;
      textBg.setAttribute('x', midX - textWidth / 2);
      textBg.setAttribute('y', midY - 8);
      textBg.setAttribute('width', textWidth);
      textBg.setAttribute('height', 16);
      textBg.setAttribute('rx', 4);
      textBg.setAttribute('fill', 'rgba(15, 23, 42, 0.9)');
      textBg.setAttribute('stroke', baseColor);
      textBg.setAttribute('stroke-width', '1');
      svg.appendChild(textBg);

      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute('x', midX);
      text.setAttribute('y', midY + 4);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', '#e2e8f0');
      text.setAttribute('font-size', '10');
      text.setAttribute('font-family', 'monospace');
      text.setAttribute('font-weight', 'bold');
      text.textContent = labelText;
      svg.appendChild(text);
    }
  });
}

// Get the pixel position of a port on a node
function getPortPosition(nodeEl, port, node) {
  // Try to find the actual port element for precise positioning
  if (port && port.id) {
    const portEl = nodeEl.querySelector(`[data-port-id="${port.id}"]`);
    if (portEl) {
      // Get port element's center position relative to world
      const portRect = portEl.getBoundingClientRect();
      const worldRect = world.getBoundingClientRect();

      // Calculate position in world coordinates (accounting for zoom/pan)
      const x = (portRect.left + portRect.width / 2 - worldRect.left) / scale;
      const y = (portRect.top + portRect.height / 2 - worldRect.top) / scale;

      return { x, y };
    }
  }

  // Fallback: calculate based on node position
  const nodeW = nodeEl.offsetWidth;
  const nodeH = nodeEl.offsetHeight;

  // Node center (offsetLeft/Top is already the center due to CSS transform)
  const nodeX = nodeEl.offsetLeft;
  const nodeY = nodeEl.offsetTop;

  // Get port index for positioning multiple ports on same side
  const samePortSide = (node.ports || []).filter(p => p.side === port?.side);
  const portIndex = samePortSide.findIndex(p => p.id === port?.id);
  const portCount = samePortSide.length;

  // Calculate offset for multiple ports (spread them out) - match CSS percentages
  let offsetPercent = 50;
  if (portCount > 1) {
    // CSS uses 30%, 50%, 70% for 3 ports
    const positions = portCount === 2 ? [35, 65] :
                      portCount === 3 ? [30, 50, 70] :
                      Array.from({length: portCount}, (_, i) => 20 + (60 * i / (portCount - 1)));
    offsetPercent = positions[portIndex] || 50;
  }

  const side = port?.side || 'bottom';
  switch (side) {
    case 'top':
      return { x: nodeX - nodeW / 2 + (nodeW * offsetPercent / 100), y: nodeY - nodeH / 2 };
    case 'bottom':
      return { x: nodeX - nodeW / 2 + (nodeW * offsetPercent / 100), y: nodeY + nodeH / 2 };
    case 'left':
      return { x: nodeX - nodeW / 2, y: nodeY - nodeH / 2 + (nodeH * offsetPercent / 100) };
    case 'right':
      return { x: nodeX + nodeW / 2, y: nodeY - nodeH / 2 + (nodeH * offsetPercent / 100) };
    default:
      return { x: nodeX, y: nodeY };
  }
}

// Create a bezier path between two points, considering port sides
function createBezierPath(x1, y1, x2, y2, sourceSide, targetSide) {
  const distance = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
  const curvature = Math.min(distance * 0.5, 100);

  let cx1 = x1, cy1 = y1, cx2 = x2, cy2 = y2;

  // Adjust control points based on port sides
  switch (sourceSide) {
    case 'top': cy1 = y1 - curvature; break;
    case 'bottom': cy1 = y1 + curvature; break;
    case 'left': cx1 = x1 - curvature; break;
    case 'right': cx1 = x1 + curvature; break;
  }

  switch (targetSide) {
    case 'top': cy2 = y2 - curvature; break;
    case 'bottom': cy2 = y2 + curvature; break;
    case 'left': cx2 = x2 - curvature; break;
    case 'right': cx2 = x2 + curvature; break;
  }

  return `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
}

// ============================================
// Connection Drag & Drop
// ============================================

function startConnection(e, node, portEl) {
  e.stopPropagation();
  e.preventDefault();

  isConnecting = true;
  connectionStart = {
    nodeId: node.id,
    portId: portEl.dataset.portId,
    element: portEl
  };

  // Add temporary line SVG
  const svg = document.getElementById('connections-layer');
  const tempLine = document.createElementNS("http://www.w3.org/2000/svg", "path");
  tempLine.id = 'temp-connection';
  tempLine.setAttribute('fill', 'none');
  tempLine.setAttribute('stroke', '#3b82f6');
  tempLine.setAttribute('stroke-width', '2');
  tempLine.setAttribute('stroke-dasharray', '5 5');
  svg.appendChild(tempLine);

  document.addEventListener('mousemove', handleConnectionDrag);
  document.addEventListener('mouseup', endConnection);
}

function handleConnectionDrag(e) {
  if (!isConnecting || !connectionStart) return;

  const svg = document.getElementById('connections-layer');
  const tempLine = document.getElementById('temp-connection');
  if (!tempLine) return;

  const sourceEl = document.getElementById(`node-${connectionStart.nodeId}`);
  const sourceNode = config.nodes.find(n => n.id === connectionStart.nodeId);
  const sourcePort = sourceNode?.ports?.find(p => p.id === connectionStart.portId);
  const startPos = getPortPosition(sourceEl, sourcePort, sourceNode);

  // Get mouse position relative to world
  const worldRect = world.getBoundingClientRect();
  const mouseX = (e.clientX - worldRect.left) / scale;
  const mouseY = (e.clientY - worldRect.top) / scale;

  const d = createBezierPath(startPos.x, startPos.y, mouseX, mouseY, sourcePort?.side || 'bottom', 'top');
  tempLine.setAttribute('d', d);
}

function endConnection(e) {
  document.removeEventListener('mousemove', handleConnectionDrag);
  document.removeEventListener('mouseup', endConnection);

  // Remove temp line
  const tempLine = document.getElementById('temp-connection');
  if (tempLine) tempLine.remove();

  if (!isConnecting || !connectionStart) {
    isConnecting = false;
    connectionStart = null;
    return;
  }

  // Check if we dropped on a port
  const targetPort = e.target.closest('.port-handle');
  if (targetPort && targetPort !== connectionStart.element) {
    const targetNodeId = targetPort.dataset.nodeId;
    const targetPortId = targetPort.dataset.portId;

    // Don't connect to same node
    if (targetNodeId !== connectionStart.nodeId) {
      // Check if connection already exists
      const existingConn = config.links.find(c =>
        (c.sourceNodeId === connectionStart.nodeId && c.sourcePortId === connectionStart.portId &&
         c.targetNodeId === targetNodeId && c.targetPortId === targetPortId) ||
        (c.sourceNodeId === targetNodeId && c.sourcePortId === targetPortId &&
         c.targetNodeId === connectionStart.nodeId && c.targetPortId === connectionStart.portId)
      );

      if (!existingConn) {
        // Save state for undo
        const sourceNode = config.nodes.find(n => n.id === connectionStart.nodeId);
        const targetNode = config.nodes.find(n => n.id === targetNodeId);
        saveStateForUndo(`Connect "${sourceNode?.name || connectionStart.nodeId}" to "${targetNode?.name || targetNodeId}"`);

        // Create new connection
        config.links.push({
          id: `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          sourceNodeId: connectionStart.nodeId,
          sourcePortId: connectionStart.portId,
          targetNodeId: targetNodeId,
          targetPortId: targetPortId,
          role: 'primary',
          medium: null,
          speed: null
        });

        saveConfig();
        renderTree(config.nodes);
        updateMinimap();
        toastSuccess('Connection Created', 'Nodes connected successfully');
      }
    }
  }

  isConnecting = false;
  connectionStart = null;
}

// ============================================
// Connection Selection & Deletion
// ============================================

function selectConnection(connId) {
  // Toggle selection if clicking the same connection
  if (selectedConnectionId === connId) {
    selectedConnectionId = null;
  } else {
    selectedConnectionId = connId;
  }
  drawLines(); // Re-render to show selection
}

function deselectConnection() {
  if (selectedConnectionId) {
    selectedConnectionId = null;
    drawLines();
  }
}

function deleteSelectedConnection() {
  if (!selectedConnectionId) return;

  const conn = config.links.find(c => c.id === selectedConnectionId);
  if (!conn) return;

  // Confirm deletion
  const sourceNode = config.nodes.find(n => n.id === conn.sourceNodeId);
  const targetNode = config.nodes.find(n => n.id === conn.targetNodeId);
  const sourceName = sourceNode?.name || conn.sourceNodeId;
  const targetName = targetNode?.name || conn.targetNodeId;

  if (confirm(`Delete connection between "${sourceName}" and "${targetName}"?`)) {
    // Save state for undo
    saveStateForUndo(`Delete connection "${sourceName}" - "${targetName}"`);

    const idx = config.links.findIndex(c => c.id === selectedConnectionId);
    if (idx !== -1) {
      config.links.splice(idx, 1);
      selectedConnectionId = null;
      saveConfig();
      renderTree(config.nodes);
      updateMinimap();
      toastSuccess('Connection Deleted', 'Connection removed successfully');
    }
  }
}

// ============================================
// Node Drag & Drop
// ============================================

let dragOffsetX = 0, dragOffsetY = 0;
let multiDragOffsets = new Map(); // For multi-select drag

function startNodeDrag(e, node) {
  if (e.button !== 0) return; // Only left click
  e.stopPropagation();
  e.preventDefault();

  // Ctrl+click toggles selection
  if (e.ctrlKey || e.metaKey) {
    toggleNodeSelection(node.id);
    return;
  }

  // If clicking on a selected node, drag all selected nodes
  // If clicking on an unselected node, clear selection and drag just that node
  if (!selectedNodes.has(node.id)) {
    clearSelection();
  }

  isDragging = true;
  dragNode = node;

  // Get the node element and its current position
  const el = document.getElementById(`node-${node.id}`);
  const viewportEl = document.getElementById('viewport');
  const viewportRect = viewportEl.getBoundingClientRect();

  // Use vw/vh based dimensions for consistency with grid labels
  const worldWidth = window.innerWidth;
  const worldHeight = window.innerHeight;

  // Calculate mouse position relative to viewport, accounting for zoom/pan
  const mouseWorldX = (e.clientX - viewportRect.left - pointX) / scale;
  const mouseWorldY = (e.clientY - viewportRect.top - pointY) / scale;

  // Store the offset between mouse and node center (using vh/vw units)
  const nodeX = (node.x || 50) / 100 * worldWidth;
  const nodeY = (node.y || 50) / 100 * worldHeight;

  dragOffsetX = mouseWorldX - nodeX;
  dragOffsetY = mouseWorldY - nodeY;

  // Calculate offsets for all selected nodes (for multi-drag)
  multiDragOffsets.clear();
  if (selectedNodes.size > 0 && selectedNodes.has(node.id)) {
    selectedNodes.forEach(nodeId => {
      const selectedNode = config.nodes.find(n => n.id === nodeId);
      if (selectedNode) {
        const snX = (selectedNode.x || 50) / 100 * worldWidth;
        const snY = (selectedNode.y || 50) / 100 * worldHeight;
        multiDragOffsets.set(nodeId, {
          offsetX: mouseWorldX - snX,
          offsetY: mouseWorldY - snY
        });
      }
    });
  }

  el.classList.add('dragging');

  // Prevent text selection during drag and set body class for cursor
  document.body.style.userSelect = 'none';
  document.body.classList.add('dragging-node');
}

function handleNodeDrag(e) {
  if (!isDragging || !dragNode) return;
  e.preventDefault();

  const viewportEl = document.getElementById('viewport');
  const viewportRect = viewportEl.getBoundingClientRect();

  // Use vw/vh based dimensions for consistency with grid labels
  const worldWidth = window.innerWidth;
  const worldHeight = window.innerHeight;

  // Calculate mouse position in world coordinates (accounting for zoom/pan)
  const mouseWorldX = (e.clientX - viewportRect.left - pointX) / scale;
  const mouseWorldY = (e.clientY - viewportRect.top - pointY) / scale;

  // Multi-select drag
  if (multiDragOffsets.size > 0) {
    multiDragOffsets.forEach((offsets, nodeId) => {
      const node = config.nodes.find(n => n.id === nodeId);
      if (!node) return;

      let newX = ((mouseWorldX - offsets.offsetX) / worldWidth) * 100;
      let newY = ((mouseWorldY - offsets.offsetY) / worldHeight) * 100;

      // Clamp values
      newX = Math.max(1, Math.min(99, newX));
      newY = Math.max(1, Math.min(250, newY));

      // Apply snap-to-grid if enabled
      const snapped = snapToGrid(newX, newY);

      // Update visual position
      const el = document.getElementById(`node-${nodeId}`);
      if (el) {
        el.style.left = snapped.x + '%';
        el.style.top = snapped.y + '%';
      }

      // Store temporary position
      node._tempX = snapped.x;
      node._tempY = snapped.y;
    });
  } else {
    // Single node drag
    let newX = ((mouseWorldX - dragOffsetX) / worldWidth) * 100;
    let newY = ((mouseWorldY - dragOffsetY) / worldHeight) * 100;

    // Clamp values to keep node within bounds (allow full grid range)
    newX = Math.max(1, Math.min(99, newX));
    newY = Math.max(1, Math.min(250, newY)); // Grid extends to 250vh (50 rows * 5vh)

    // Apply snap-to-grid if enabled
    const snapped = snapToGrid(newX, newY);

    // Update visual position immediately
    const el = document.getElementById(`node-${dragNode.id}`);
    el.style.left = snapped.x + '%';
    el.style.top = snapped.y + '%';

    // Store temporary position
    dragNode._tempX = snapped.x;
    dragNode._tempY = snapped.y;
  }

  // Update lines in real-time
  drawLines();

  // Check for container and zone drop zones (only for non-container nodes)
  if (!dragNode.isContainer) {
    const mouseX = e.clientX;
    const mouseY = e.clientY;

    // Check container drop zones
    const containerDropZones = document.querySelectorAll('.container-drop-zone');
    containerDropZones.forEach(zone => {
      const rect = zone.getBoundingClientRect();
      const isOver = mouseX >= rect.left && mouseX <= rect.right &&
                     mouseY >= rect.top && mouseY <= rect.bottom;
      const containerId = zone.dataset.containerId;

      // Don't allow dropping on own container if already in one
      if (containerId !== dragNode.containerId) {
        zone.classList.toggle('drag-over', isOver);
      }
    });

    // Check VLAN zone drop zones
    const zoneDropZones = document.querySelectorAll('.vlan-zone-drop');
    zoneDropZones.forEach(zone => {
      const rect = zone.getBoundingClientRect();
      const isOver = mouseX >= rect.left && mouseX <= rect.right &&
                     mouseY >= rect.top && mouseY <= rect.bottom;
      zone.classList.toggle('drag-over', isOver);
    });
  }
}

async function endNodeDrag(e) {
  if (!isDragging || !dragNode) return;

  // Check if dropping on a container or zone drop zone (only for non-container nodes)
  let droppedOnContainer = null;
  let droppedOnZone = null;

  if (!dragNode.isContainer && e) {
    const mouseX = e.clientX;
    const mouseY = e.clientY;

    // First check VLAN zone drop zones (higher priority)
    const zoneDropZones = document.querySelectorAll('.vlan-zone-drop');
    zoneDropZones.forEach(zone => {
      const rect = zone.getBoundingClientRect();
      const isOver = mouseX >= rect.left && mouseX <= rect.right &&
                     mouseY >= rect.top && mouseY <= rect.bottom;
      if (isOver) {
        droppedOnContainer = zone.dataset.containerId;
        droppedOnZone = zone.dataset.zoneId;
      }
      zone.classList.remove('drag-over');
    });

    // Then check container drop zones (if not already dropped on a zone)
    if (!droppedOnContainer) {
      const containerDropZones = document.querySelectorAll('.container-drop-zone');
      containerDropZones.forEach(zone => {
        const rect = zone.getBoundingClientRect();
        const isOver = mouseX >= rect.left && mouseX <= rect.right &&
                       mouseY >= rect.top && mouseY <= rect.bottom;
        if (isOver) {
          droppedOnContainer = zone.dataset.containerId;
        }
        zone.classList.remove('drag-over');
      });
    }
  }

  // Clear any remaining drag-over states
  document.querySelectorAll('.container-drop-zone.drag-over, .vlan-zone-drop.drag-over').forEach(zone => {
    zone.classList.remove('drag-over');
  });

  // Handle container/zone drop
  if (droppedOnContainer && (droppedOnContainer !== dragNode.containerId || droppedOnZone !== dragNode.zoneId)) {
    const zone = droppedOnZone ? config.nodes.find(n => n.id === droppedOnContainer)?.zones?.find(z => z.id === droppedOnZone) : null;
    const zoneName = zone ? ` (VLAN ${zone.vlanId})` : '';
    saveStateForUndo(`Add node "${dragNode.name}" to container${zoneName}`);
    const node = config.nodes.find(n => n.id === dragNode.id);
    if (node) {
      node.containerId = droppedOnContainer;
      node.zoneId = droppedOnZone;
      // Clear temporary position
      delete node._tempX;
      delete node._tempY;
    }
    isDragging = false;
    dragNode = null;
    dragOffsetX = 0;
    dragOffsetY = 0;
    multiDragOffsets.clear();
    await saveConfig();
    renderTree(config.nodes);
    updateMinimap();
    const container = config.nodes.find(n => n.id === droppedOnContainer);
    showNotification(`Node added to ${container?.name || 'container'}${zoneName}`, 'success');
    return;
  }

  // Original endNodeDrag logic follows

  const el = document.getElementById(`node-${dragNode.id}`);
  el.classList.remove('dragging');

  // Restore text selection and remove body class
  document.body.style.userSelect = '';
  document.body.classList.remove('dragging-node');

  let hasChanges = false;

  // Multi-select drag
  if (multiDragOffsets.size > 0) {
    // Check if any node moved
    multiDragOffsets.forEach((_, nodeId) => {
      const node = config.nodes.find(n => n.id === nodeId);
      if (node && node._tempX !== undefined) {
        hasChanges = true;
      }
    });

    if (hasChanges) {
      // Save state for undo
      saveStateForUndo(`Move ${multiDragOffsets.size} node(s)`);

      // Apply all position changes
      multiDragOffsets.forEach((_, nodeId) => {
        const node = config.nodes.find(n => n.id === nodeId);
        if (node && node._tempX !== undefined) {
          node.x = node._tempX;
          node.y = node._tempY;
          delete node._tempX;
          delete node._tempY;

          // Update networkData if it exists
          const dataNode = networkData.find(n => n.id === nodeId);
          if (dataNode) {
            dataNode.x = node.x;
            dataNode.y = node.y;
          }
        }
      });
    }
  } else if (dragNode._tempX !== undefined) {
    // Single node drag
    hasChanges = true;

    // Save state for undo
    saveStateForUndo(`Move node "${dragNode.name || dragNode.id}"`);

    const newX = dragNode._tempX;
    const newY = dragNode._tempY;

    delete dragNode._tempX;
    delete dragNode._tempY;

    // Update ALL references to this node
    const nodeId = dragNode.id;

    // Update config.nodes (source of truth)
    const configNode = config.nodes.find(n => n.id === nodeId);
    if (configNode) {
      configNode.x = newX;
      configNode.y = newY;
    }

    // Update networkData if it exists
    const dataNode = networkData.find(n => n.id === nodeId);
    if (dataNode) {
      dataNode.x = newX;
      dataNode.y = newY;
    }

    // Update dragNode itself
    dragNode.x = newX;
    dragNode.y = newY;
  }

  if (hasChanges) {
    // Save to disk and wait for completion
    await saveConfig();
    updateMinimap();
  }

  isDragging = false;
  dragNode = null;
  dragOffsetX = 0;
  dragOffsetY = 0;
  multiDragOffsets.clear();
}

// ============================================
// Host List
// ============================================

function renderHostList(nodes) {
  const list = document.getElementById('host-list-content');
  document.getElementById('host-count').innerText = nodes.length;

  const rank = { down: 0, unknown: 1, up: 2 };
  const sortedNodes = [...nodes].sort((a, b) => {
    const left = rank[Probe.canonicalStatus(a.status)];
    const right = rank[Probe.canonicalStatus(b.status)];
    if (left === right) return (a.name || '').localeCompare(b.name || '');
    return left - right;
  });

  let html = '';
  sortedNodes.forEach(node => {
    const view = statusView(node.status);
    const colorClass = view.dot;
    const uptimeText = node.uptime || '—';
    const listLabel = view.state === 'up' ? 'UP' : view.state === 'down' ? 'DOWN' : 'UNKNOWN';
    const statusColor = view.text;

    html += `
      <div class="host-row" data-node-id="${node.id}">
        <div class="flex items-center">
          <div class="status-dot ${colorClass}"></div>
          <div class="flex flex-col">
            <span class="font-bold text-slate-200">${escapeHtml(node.name || '')}</span>
            <span class="text-[10px] text-slate-500 font-mono">${escapeHtml(node.address || '')}</span>
          </div>
        </div>
        <div class="text-right">
          <div class="text-[10px] ${statusColor}">${listLabel}</div>
          <div class="status-text">${uptimeText}</div>
        </div>
      </div>
    `;
  });
  list.innerHTML = html;

  // Add click handlers to focus on node
  list.querySelectorAll('.host-row').forEach(row => {
    row.addEventListener('click', () => {
      const nodeId = row.dataset.nodeId;
      focusOnNode(nodeId);
    });
  });
}

function applyNodeFilter() {
  const searchTerm = document.getElementById('node-search').value.toLowerCase().trim();
  const statusFilter = document.getElementById('node-filter-status').value;

  // Get nodes from monitoring data if active, otherwise from config
  const sourceNodes = monitoringActive && networkData.length ? networkData : config.nodes;

  // Filter nodes
  const filteredNodes = sourceNodes.filter(node => {
    // Search filter (name or address)
    const matchesSearch = !searchTerm ||
      (node.name && node.name.toLowerCase().includes(searchTerm)) ||
      (node.address && node.address.toLowerCase().includes(searchTerm));

    // Status filter
    let matchesStatus = true;
    const state = Probe.canonicalStatus(node.status);
    if (statusFilter === 'online') {
      matchesStatus = state === 'up';
    } else if (statusFilter === 'offline') {
      matchesStatus = state === 'down';
    } else if (statusFilter === 'unknown') {
      matchesStatus = state === 'unknown';
    }

    return matchesSearch && matchesStatus;
  });

  // Update host list with filtered nodes
  renderHostList(filteredNodes);

  // Update host count to show filtered/total
  const countEl = document.getElementById('host-count');
  if (searchTerm || statusFilter !== 'all') {
    countEl.innerText = `${filteredNodes.length}/${sourceNodes.length}`;
  } else {
    countEl.innerText = sourceNodes.length;
  }

  // Highlight matching nodes in viewport
  highlightFilteredNodes(filteredNodes.map(n => n.id));
}

function highlightFilteredNodes(matchingIds) {
  const searchTerm = document.getElementById('node-search').value.trim();
  const statusFilter = document.getElementById('node-filter-status').value;
  const isFiltering = searchTerm || statusFilter !== 'all';

  document.querySelectorAll('.node-container').forEach(el => {
    const nodeId = el.id.replace('node-', '');
    if (isFiltering) {
      if (matchingIds.includes(nodeId)) {
        el.style.opacity = '1';
        el.style.filter = 'none';
      } else {
        el.style.opacity = '0.3';
        el.style.filter = 'grayscale(50%)';
      }
    } else {
      el.style.opacity = '1';
      el.style.filter = 'none';
    }
  });
}

function focusOnNode(nodeId) {
  const node = config.nodes.find(n => n.id === nodeId);
  if (!node) return;

  const el = document.getElementById(`node-${nodeId}`);
  if (!el) return;

  // Calculate position to center the node
  const viewportRect = viewport.getBoundingClientRect();
  const targetX = viewportRect.width / 2 - (node.x / 100 * 10000) * scale;
  const targetY = viewportRect.height / 2 - (node.y / 100 * 10000) * scale;

  // Animate pan to node
  const startX = pointX;
  const startY = pointY;
  const duration = 300;
  const startTime = performance.now();

  function animate(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic

    pointX = startX + (targetX - startX) * eased;
    pointY = startY + (targetY - startY) * eased;
    updateTransform();

    if (progress < 1) {
      requestAnimationFrame(animate);
    } else {
      // Flash highlight effect
      el.style.transition = 'box-shadow 0.2s';
      el.style.boxShadow = '0 0 20px 10px rgba(59, 130, 246, 0.6)';
      setTimeout(() => {
        el.style.boxShadow = '';
        setTimeout(() => { el.style.transition = ''; }, 200);
      }, 500);
    }
  }

  requestAnimationFrame(animate);
}

// ============================================
// Context Menu
// ============================================

function showNodeContextMenu(e, node) {
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
  const containers = config.nodes.filter(n => n.isContainer && n.id !== node.id);
  if (!node.isContainer && !node.containerId && containers.length > 0) {
    addToContainerSection.classList.remove('hidden');
    addToContainerItems.innerHTML = containers.map(c => `
      <div class="context-menu-item" onclick="addToContainerFromContext('${jsAttr(c.id)}')">
        <i data-lucide="log-in" class="w-4 h-4"></i>
        <span>Add to ${escapeHtml(c.name)}</span>
      </div>
    `).join('');
  } else {
    addToContainerSection.classList.add('hidden');
    addToContainerItems.innerHTML = '';
  }

  menu.classList.remove('hidden');
  lucide.createIcons();
}

function hideContextMenu() {
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
  if (!contextMenuNode || !window.electronAPI) return;
  hideContextMenu();

  const result = await window.electronAPI.network.ping(contextMenuNode.address);
  if (result.success) {
    toastSuccess('Ping Successful', `${contextMenuNode.address} responded in ${result.duration}ms`);
  } else {
    toastError('Ping Failed', `${contextMenuNode.address} did not respond (${result.duration}ms)`);
  }
}

function showStatusHistoryFromContext() {
  if (!contextMenuNode) return;
  hideContextMenu();

  const history = statusHistory.get(contextMenuNode.id);
  const nodeName = contextMenuNode.name || contextMenuNode.id;
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

  // Show as alert for now (could be improved with a modal)
  alert(`Status History for "${nodeName}"\n\n${message}`);
}

function deleteNodeFromContext() {
  if (!contextMenuNode) return;
  hideContextMenu();

  if (confirm(`Delete node "${contextMenuNode.name}"?`)) {
    // Save state for undo
    saveStateForUndo(`Delete node "${contextMenuNode.name}"`);

    const idx = config.nodes.findIndex(n => n.id === contextMenuNode.id);
    if (idx !== -1) {
      // If this is a container, also remove containerId from children
      if (contextMenuNode.isContainer) {
        config.nodes.forEach(n => {
          if (n.containerId === contextMenuNode.id) {
            n.containerId = null;
          }
        });
      }
      // Also remove connections involving this node
      config.links = config.links.filter(c =>
        c.sourceNodeId !== contextMenuNode.id && c.targetNodeId !== contextMenuNode.id
      );
      config.nodes.splice(idx, 1);
      saveConfig();
      renderTree(config.nodes);
      renderHostList(config.nodes);
      updateMinimap();
      toastSuccess('Node Deleted', `"${contextMenuNode.name}" has been removed`);
    }
  }
}

function toggleContainerFromContext() {
  if (!contextMenuNode || !contextMenuNode.isContainer) return;
  hideContextMenu();
  toggleContainerExpand(contextMenuNode.id);
}

function removeFromContainerFromContext() {
  if (!contextMenuNode || !contextMenuNode.containerId) return;
  hideContextMenu();
  removeFromContainer(contextMenuNode.id);
}

function addToContainerFromContext(containerId) {
  if (!contextMenuNode || contextMenuNode.isContainer) return;
  hideContextMenu();
  addToContainer(contextMenuNode.id, containerId);
}

// ============================================
// Modals
// ============================================

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
  lucide.createIcons();
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// ============================================
// SSH Modal & Terminal
// ============================================

function openSSHModal(node) {
  const source = (config.nodes || []).find((item) => item.id === node.id) || node;
  const type = Topology.secretType(source);
  const auth = source.sshAuth === 'key' || type === 'passphrase' ? 'key' : 'password';
  document.getElementById('ssh-host').value = source.address || '';
  document.getElementById('ssh-port').value = source.sshPort || 22;
  document.getElementById('ssh-username').value = source.sshUser || '';
  document.getElementById('ssh-password').value = '';
  document.getElementById('ssh-node-id').value = source.id;
  document.getElementById('ssh-auth-type').value = auth;
  document.getElementById('ssh-key-path').value = source.sshKeyPath || '';
  document.getElementById('ssh-passphrase').value = '';
  setSecretHint('ssh-password-hint', type === 'password' ? 'Secret saved. Leave blank to use it.' : '');
  setSecretHint('ssh-passphrase-hint', type === 'passphrase' ? 'Secret saved. Leave blank to use it.' : '');
  toggleSSHAuthFields();

  openModal('ssh-modal');
  lucide.createIcons();
}

function setSecretHint(id, text) {
  const hint = document.getElementById(id);
  if (!hint) return;
  hint.textContent = text || '';
  hint.classList.toggle('hidden', !text);
}

function toggleSSHAuthFields() {
  const authType = document.getElementById('ssh-auth-type').value;
  const passwordGroup = document.getElementById('ssh-password-group');
  const keyGroup = document.getElementById('ssh-key-group');

  if (authType === 'password') {
    passwordGroup.classList.remove('hidden');
    keyGroup.classList.add('hidden');
  } else {
    passwordGroup.classList.add('hidden');
    keyGroup.classList.remove('hidden');
  }
}

async function browseSSHKey() {
  if (!window.electronAPI) {
    toastWarning('Not Available', 'File browsing is only available in the desktop application');
    return;
  }

  const result = await window.electronAPI.ssh.browseKey();
  if (result.success) {
    document.getElementById('ssh-key-path').value = result.path;
    toastInfo('Key Selected', `Selected: ${result.path.split(/[\\/]/).pop()}`);
  }
}

async function rememberSecret(nodeId, changes) {
  const node = (config.nodes || []).find((item) => item.id === nodeId);
  if (!node) return { success: true };
  let changed = false;
  if (changes.password) {
    node.sshAuth = 'password';
    node.sshPass = changes.password;
    delete node.sshPassphrase;
    delete node.sshSecretClear;
    changed = true;
  }
  if (changes.passphrase) {
    node.sshAuth = 'key';
    node.sshPassphrase = changes.passphrase;
    delete node.sshPass;
    delete node.sshSecretClear;
    changed = true;
  }
  if (changes.keyPath && changes.keyPath !== node.sshKeyPath) {
    node.sshAuth = 'key';
    node.sshKeyPath = changes.keyPath;
    changed = true;
  }
  if (!changed) return { success: true };
  return saveConfig();
}

async function connectSSH() {
  if (!window.electronAPI) {
    toastWarning('SSH Unavailable', 'SSH is only available in the desktop application');
    return;
  }

  const nodeId = document.getElementById('ssh-node-id').value;
  const host = document.getElementById('ssh-host').value;
  const port = parseInt(document.getElementById('ssh-port').value) || 22;
  const username = document.getElementById('ssh-username').value;
  const authType = document.getElementById('ssh-auth-type').value;

  if (!host || !username) {
    toastError('Missing Credentials', 'Host and username are required');
    return;
  }

  // Build connection info based on auth type
  const connectionInfo = { nodeId, host, port, username };

  const node = (config.nodes || []).find((item) => item.id === nodeId);
  const storedType = Topology.secretType(node);

  if (authType === 'password') {
    const password = document.getElementById('ssh-password').value;
    if (password) {
      connectionInfo.password = password;
      const saved = await rememberSecret(nodeId, { password: password });
      if (!saved || saved.success === false) {
        toastError('Password not saved', (saved && saved.error) || 'The password was not saved');
      }
    } else if (storedType !== 'password') {
      toastError('Missing Password', 'Password is required');
      return;
    }
  } else {
    const keyPath = document.getElementById('ssh-key-path').value;
    if (!keyPath) {
      toastError('Missing Key', 'Private key file is required');
      return;
    }
    connectionInfo.privateKeyPath = keyPath;
    const passphrase = document.getElementById('ssh-passphrase').value;
    if (passphrase) {
      connectionInfo.passphrase = passphrase;
    }
    const saved = await rememberSecret(nodeId, {
      passphrase: passphrase,
      keyPath: keyPath
    });
    if (passphrase && (!saved || saved.success === false)) {
      toastError('Password not saved', (saved && saved.error) || 'The key passphrase was not saved');
    }
  }

  closeModal('ssh-modal');

  // Show connecting status
  document.getElementById('terminal-status').textContent = 'Connecting...';
  document.getElementById('terminal-status').className = 'text-xs px-2 py-0.5 rounded bg-yellow-600';

  let result = await window.electronAPI.ssh.connect(connectionInfo);
  if (!result.success && result.hostKey && result.hostKey.status === 'unknown' && confirmUnknownHostKey(result.hostKey)) {
    connectionInfo.acceptHostKey = result.hostKey.fingerprint;
    result = await window.electronAPI.ssh.connect(connectionInfo);
  }

  if (result.success) {
    document.getElementById('terminal-status').textContent = 'Connected';
    document.getElementById('terminal-status').className = 'text-xs px-2 py-0.5 rounded bg-green-600';
    createTerminalTab(nodeId, host);
    toastSuccess('SSH Connected', `Connected to ${host}`);
  } else {
    document.getElementById('terminal-status').textContent = 'Failed';
    document.getElementById('terminal-status').className = 'text-xs px-2 py-0.5 rounded bg-red-600';
    toastError('SSH Connection Failed', result.error);
    if (result.hostKey && result.hostKey.status === 'mismatch') {
      await offerToForgetHostKey(result.hostKey);
    }
  }
}

// The fingerprint is shown in full so the user can compare it with the server
// (for example `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`).
function confirmUnknownHostKey(hostKey) {
  return window.confirm(
    `First connection to ${hostKey.host}:${hostKey.port}.\n\n` +
    `The server presented this host key:\n` +
    `${hostKey.algorithm}\n${hostKey.fingerprint}\n\n` +
    `Only continue if this fingerprint matches the server's.\n` +
    `OK: trust and remember this key, then connect.\nCancel: do not connect.`
  );
}

async function offerToForgetHostKey(hostKey) {
  const forget = window.confirm(
    `HOST KEY MISMATCH for ${hostKey.host}:${hostKey.port}.\n\n` +
    `Stored key:\n${hostKey.storedAlgorithm}\n${hostKey.storedFingerprint}\n\n` +
    `Presented key:\n${hostKey.algorithm}\n${hostKey.fingerprint}\n\n` +
    `Someone may be intercepting the connection. Only forget the stored key ` +
    `if you know the server's key changed (reinstall, new key).\n\n` +
    `OK: forget the stored key (you will be asked to verify the new one on the next connection).\n` +
    `Cancel: keep the stored key.`
  );
  if (!forget) return;
  const removed = await window.electronAPI.ssh.forgetHostKey(hostKey.host, hostKey.port);
  if (removed && removed.success) {
    toastSuccess('Host key forgotten', `Connect again to verify the new key of ${hostKey.host}`);
  } else {
    toastError('Host key not forgotten', (removed && removed.error) || 'The stored host key was not removed');
  }
}

function createTerminalTab(nodeId, host) {
  // Hide placeholder
  document.getElementById('terminal-placeholder').classList.add('hidden');

  // Create tab
  const tabs = document.getElementById('terminal-tabs');
  const tab = document.createElement('div');
  tab.className = 'terminal-tab active';
  tab.dataset.nodeId = nodeId;
  tab.innerHTML = `
    <span>${escapeHtml(host)}</span>
    <button class="close-btn text-slate-500 hover:text-red-400" type="button">
      <i data-lucide="x" class="w-3 h-3"></i>
    </button>
  `;
  tab.addEventListener('click', (e) => {
    if (e.target.closest('.close-btn')) {
      closeTerminalTab(nodeId);
      return;
    }
    switchTerminal(nodeId);
  });

  // Deactivate other tabs
  tabs.querySelectorAll('.terminal-tab').forEach(t => t.classList.remove('active'));
  tabs.appendChild(tab);

  // Create terminal instance container
  const instances = document.getElementById('terminal-instances');
  const termDiv = document.createElement('div');
  termDiv.id = `terminal-${nodeId}`;
  termDiv.className = 'terminal-instance h-full';
  instances.querySelectorAll('.terminal-instance').forEach(t => t.style.display = 'none');
  instances.appendChild(termDiv);

  // Initialize xterm.js (will be loaded dynamically)
  initTerminal(nodeId, termDiv);

  lucide.createIcons();
}

function sendTerminalSize(nodeId, term) {
  if (!window.electronAPI || !term) return;
  const cols = term.cols;
  const rows = term.rows;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
  window.electronAPI.ssh.resize(nodeId, cols, rows);
}

async function initTerminal(nodeId, container) {
  if (typeof Terminal === 'undefined') {
    toastError('Terminal unavailable', 'xterm.js did not load. Run npm install, then restart the app.');
    return;
  }

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: '#1a1a2e',
      foreground: '#e2e8f0',
      cursor: '#3b82f6',
      selection: 'rgba(59, 130, 246, 0.3)'
    }
  });

  term.open(container);

  term.onData(data => {
    if (window.electronAPI) {
      window.electronAPI.ssh.write(nodeId, data);
    }
  });

  let onResize = null;
  const FitConstructor = window.FitAddon && window.FitAddon.FitAddon;
  if (typeof FitConstructor === 'function') {
    const fitAddon = new FitConstructor();
    term.loadAddon(fitAddon);
    onResize = () => {
      if (!terminals.has(nodeId)) return;
      fitAddon.fit();
      sendTerminalSize(nodeId, term);
    };
    requestAnimationFrame(onResize);
    window.addEventListener('resize', onResize);
  }

  terminals.set(nodeId, { term, container, onResize });
  activeTerminal = nodeId;
}

function switchTerminal(nodeId) {
  const tabs = document.getElementById('terminal-tabs');
  tabs.querySelectorAll('.terminal-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.nodeId === nodeId);
  });

  const instances = document.getElementById('terminal-instances');
  instances.querySelectorAll('.terminal-instance').forEach(t => {
    t.style.display = t.id === `terminal-${nodeId}` ? 'block' : 'none';
  });

  activeTerminal = nodeId;
}

async function closeTerminalTab(nodeId) {
  const tabs = document.getElementById('terminal-tabs');
  const tab = [...tabs.querySelectorAll('.terminal-tab')].find((item) => item.dataset.nodeId === nodeId);
  const termDiv = document.getElementById(`terminal-${nodeId}`);
  const termData = terminals.get(nodeId);
  if (!tab && !termDiv && !termData) return;

  terminals.delete(nodeId);
  if (termData && termData.onResize) {
    window.removeEventListener('resize', termData.onResize);
  }
  if (termData && termData.term) {
    termData.term.dispose();
  }
  if (window.electronAPI) {
    await window.electronAPI.ssh.disconnect(nodeId);
  }

  if (tab) tab.remove();
  if (termDiv) termDiv.remove();

  // Show placeholder if no terminals left
  if (terminals.size === 0) {
    document.getElementById('terminal-placeholder').classList.remove('hidden');
    document.getElementById('terminal-status').textContent = 'No Connection';
    document.getElementById('terminal-status').className = 'text-xs px-2 py-0.5 rounded bg-slate-700';
  } else {
    // Switch to another terminal
    const firstTab = tabs.querySelector('.terminal-tab');
    if (firstTab) {
      switchTerminal(firstTab.dataset.nodeId);
    }
  }
}

// SSH data listener
function setupSSHListeners() {
  if (!window.electronAPI) return;

  window.electronAPI.ssh.onData(({ nodeId, data }) => {
    const termData = terminals.get(nodeId);
    if (termData && termData.term) {
      termData.term.write(data);
    }
  });

  window.electronAPI.ssh.onClosed(({ nodeId }) => {
    closeTerminalTab(nodeId);
  });
}

// ============================================
// Node Edit Modal
// ============================================

// Temporary ports storage for the modal
let editingNodePorts = [];

function openNodeModal(node = null) {
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
  nodeSecretClear = false;
  refreshNodeSecretHint(node);
  toggleNodeSshAuth();
  const cable = node ? Topology.primaryCable(config, node.id) : null;
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
  config.nodes.forEach(n => {
    if (!node || n.id !== node.id) {
      options += `<option value="${n.id}">${escapeHtml(n.name)}</option>`;
    }
  });

  primarySelect.innerHTML = options;
  secondarySelect.innerHTML = options;

  if (node) {
    primarySelect.value = Topology.parentNodeId(config, node.id, 'primary') || '';
    secondarySelect.value = Topology.parentNodeId(config, node.id, 'failover') || '';
  }

  openModal('node-modal');
}

// Variable to track zones being edited
let editingContainerZones = [];

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

  const container = config.nodes.find(n => n.id === containerId);
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
    const zoneDomId = jsAttr(zone.id);
    html += `
      <div class="flex items-center gap-2 p-2 bg-slate-800 rounded mb-2">
        <input type="color" value="${zoneColor}"
               onchange="updateContainerZone('${zoneDomId}', 'color', this.value)"
               class="w-8 h-8 rounded cursor-pointer border-0" style="padding: 0;">
        <input type="number" value="${escapeHtml(zone.vlanId)}" placeholder="VLAN ID"
               onchange="updateContainerZone('${zoneDomId}', 'vlanId', this.value)"
               class="w-20 px-2 py-1 bg-slate-900 border border-slate-600 rounded text-sm">
        <input type="text" value="${escapeHtml(zone.name)}" placeholder="Zone name"
               onchange="updateContainerZone('${zoneDomId}', 'name', this.value)"
               class="flex-1 px-2 py-1 bg-slate-900 border border-slate-600 rounded text-sm">
        <button onclick="removeContainerZone('${zoneDomId}')" class="p-1 text-red-400 hover:text-red-300">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      </div>
    `;
  });
  container.innerHTML = html;
  lucide.createIcons();
}

// Populate container dropdown with available containers
function populateContainerDropdown(currentNode) {
  const select = document.getElementById('node-parent-container');
  let options = '<option value="">No parent (standalone)</option>';

  // Find all container nodes
  config.nodes.forEach(n => {
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

// Toggle container expand/collapse
function toggleContainerExpand(nodeId) {
  const node = config.nodes.find(n => n.id === nodeId);
  if (node && node.isContainer) {
    node.expanded = !node.expanded;
    saveUndo();
    renderTree(config.nodes);
    saveConfig();
  }
}

// Toggle VLAN zone collapse
function toggleZoneCollapse(containerId, zoneId) {
  const zoneContent = document.getElementById(`zone-content-${zoneId}`);
  if (zoneContent) {
    zoneContent.classList.toggle('collapsed');
  }
}

// Remove node from container (make it standalone)
function removeFromContainer(nodeId) {
  const node = config.nodes.find(n => n.id === nodeId);
  if (node && node.containerId) {
    saveUndo();
    node.containerId = null;
    node.zoneId = null; // Also clear zone assignment
    renderTree(config.nodes);
    saveConfig();
    showNotification('Node removed from container', 'success');
  }
}

// Add node to container (optionally to a specific zone)
function addToContainer(nodeId, containerId, zoneId = null) {
  const node = config.nodes.find(n => n.id === nodeId);
  const container = config.nodes.find(n => n.id === containerId);
  if (node && container && container.isContainer && !node.isContainer) {
    saveUndo();
    node.containerId = containerId;
    node.zoneId = zoneId;
    renderTree(config.nodes);
    saveConfig();
    showNotification(`Node added to ${container.name}`, 'success');
  }
}

function renderNodePortsList() {
  const container = document.getElementById('node-ports-list');
  container.innerHTML = '';

  editingNodePorts.forEach((port, idx) => {
    const div = document.createElement('div');
    div.className = 'flex items-center gap-2 p-2 bg-slate-800 rounded';
    div.innerHTML = `
      <input type="text" value="${escapeHtml(port.name)}" placeholder="Name"
             onchange="updateNodePort(${idx}, 'name', this.value)"
             class="flex-1 px-2 py-1 bg-slate-900 border border-slate-600 rounded text-sm">
      <select onchange="updateNodePort(${idx}, 'side', this.value)"
              class="px-2 py-1 bg-slate-900 border border-slate-600 rounded text-sm">
        <option value="top" ${port.side === 'top' ? 'selected' : ''}>Top</option>
        <option value="bottom" ${port.side === 'bottom' ? 'selected' : ''}>Bottom</option>
        <option value="left" ${port.side === 'left' ? 'selected' : ''}>Left</option>
        <option value="right" ${port.side === 'right' ? 'selected' : ''}>Right</option>
      </select>
      <button onclick="removeNodePort(${idx})" class="p-1 text-red-400 hover:text-red-300">
        <i data-lucide="trash-2" class="w-4 h-4"></i>
      </button>
    `;
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
  if (!window.electronAPI) {
    toastWarning('Not Available', 'File browsing is only available in the desktop application');
    return;
  }
  const result = await window.electronAPI.ssh.browseKey();
  if (result && result.success) {
    document.getElementById('node-ssh-key-path').value = result.path;
  }
}

async function saveNode() {
  const id = document.getElementById('node-edit-id').value;
  const name = document.getElementById('node-name').value.trim();
  const address = document.getElementById('node-address').value.trim();
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

  const newNodeId = id || 'node_' + Date.now();

  // Update port IDs if this is a new node
  const ports = editingNodePorts.map(p => ({
    ...p,
    id: p.id.startsWith('node_') ? p.id : `${newNodeId}_${p.name.toLowerCase().replace(/\s+/g, '_')}`
  }));

  const previous = id ? config.nodes.find((node) => node.id === id) : null;
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
  delete nodeData.sshPass;
  delete nodeData.sshPassphrase;
  delete nodeData._encrypted;
  delete nodeData.sshSecretClear;
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
  if (!previous) nodeData.expanded = true;

  // Save state for undo before making changes
  saveStateForUndo(id ? `Edit node "${name}"` : `Add node "${name}"`);

  if (id) {
    // Update existing node
    const idx = config.nodes.findIndex(n => n.id === id);
    if (idx !== -1) {
      nodeData.x = config.nodes[idx].x;
      nodeData.y = config.nodes[idx].y;
      if (typeof config.nodes[idx].expanded === 'boolean') {
        nodeData.expanded = config.nodes[idx].expanded;
      }
      config.nodes[idx] = nodeData;
    }
  } else {
    // Add new node - auto position
    const existingCount = config.nodes.length;
    const col = existingCount % 10;
    const row = Math.floor(existingCount / 10);
    nodeData.x = (col * 10) + 5;
    nodeData.y = (row * 15) + 10;
    config.nodes.push(nodeData);
  }

  Topology.setParent(config, newNodeId, 'primary', primaryParentId);
  Topology.setParent(config, newNodeId, 'failover', secondaryParentId);
  Topology.setCable(config, newNodeId, linkType, linkSpeed);

  const saved = await saveConfig();
  if (!saved || saved.success === false) {
    toastError('Save refused', (saved && saved.error) || 'Save failed');
    return;
  }
  closeModal('node-modal');
  renderTree(config.nodes);
  renderHostList(config.nodes);

  // Show success toast
  toastSuccess(id ? 'Node Updated' : 'Node Created', `"${name}" has been ${id ? 'updated' : 'added'} successfully`);

  // Restart monitoring with updated config
  if (monitoringActive) {
    stopMonitoring().then(() => startMonitoring());
  }
}

// ============================================
// Network Discovery
// ============================================

let discoveredHosts = [];
let networkInterfaces = []; // Store interfaces for reference

async function openDiscoveryModal() {
  if (!window.electronAPI) {
    toastWarning('Discovery Unavailable', 'Network discovery is only available in the desktop application');
    return;
  }

  // Get network interfaces
  networkInterfaces = await window.electronAPI.network.getLocalInfo();
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
  if (!window.electronAPI) return;

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
  document.getElementById('discovery-status').classList.remove('hidden');
  document.getElementById('discovery-results').classList.add('hidden');
  document.getElementById('btn-start-scan').classList.add('hidden');
  document.getElementById('discovery-progress-bar').style.width = '0%';
  document.getElementById('discovery-text').textContent = 'Scanning...';

  // Listen for progress updates
  const removeProgressListener = window.electronAPI.network.onScanProgress((progress) => {
    const percent = Math.round((progress.current / progress.total) * 100);
    document.getElementById('discovery-progress-bar').style.width = percent + '%';
    document.getElementById('discovery-text').textContent = `Scanning... ${progress.current}/${progress.total} (Found: ${progress.found})`;
  });

  let results;
  try {
    results = await window.electronAPI.network.scan(baseIp, startRange, endRange);
  } catch (error) {
    removeProgressListener();
    document.getElementById('btn-start-scan').classList.remove('hidden');
    document.getElementById('discovery-text').textContent = 'Scan failed';
    toastError('Scan failed', error && error.message ? error.message : 'Invalid scan range');
    return;
  }

  removeProgressListener();

  // Also get ARP table for MAC addresses
  const arpTable = await window.electronAPI.network.arp();

  // Merge results
  discoveredHosts = results.map(r => {
    const arpEntry = arpTable.find(a => a.ip === r.ip);
    return {
      ip: r.ip,
      mac: arpEntry ? arpEntry.mac : null,
      selected: true
    };
  });

  // Filter out already configured hosts
  const configuredIps = config.nodes.map(n => n.address);
  discoveredHosts = discoveredHosts.filter(h => !configuredIps.includes(h.ip));

  document.getElementById('discovery-text').textContent = `Found ${discoveredHosts.length} new hosts`;
  document.getElementById('discovery-progress-bar').style.width = '100%';

  // Show results
  renderDiscoveryResults();

  if (discoveredHosts.length > 0) {
    document.getElementById('btn-add-discovered').classList.remove('hidden');
  }
  document.getElementById('btn-start-scan').classList.remove('hidden');
  document.getElementById('btn-start-scan').textContent = 'Scan Again';
}

function renderDiscoveryResults() {
  const container = document.getElementById('discovery-results');
  container.innerHTML = '';
  container.classList.remove('hidden');

  discoveredHosts.forEach((host, idx) => {
    const div = document.createElement('div');
    div.className = 'discovered-host';
    div.innerHTML = `
      <div>
        <input type="checkbox" ${host.selected ? 'checked' : ''} onchange="discoveredHosts[${idx}].selected = this.checked" class="mr-2">
        <span class="font-mono text-sm">${host.ip}</span>
        ${host.mac ? `<span class="text-xs text-slate-500 ml-2">${host.mac}</span>` : ''}
      </div>
    `;
    container.appendChild(div);
  });
}

async function addDiscoveredNodes() {
  const selected = discoveredHosts.filter(h => h.selected);
  const startCount = config.nodes.length;

  selected.forEach((host, idx) => {
    const col = (startCount + idx) % 10;
    const row = Math.floor((startCount + idx) / 10);

    config.nodes.push(Topology.createNode({
      id: 'node_' + Date.now() + '_' + idx,
      name: `Device ${host.ip}`,
      address: host.ip,
      icon: 'circle',
      iconType: 'lucide',
      x: (col * 10) + 5,
      y: (row * 15) + 10
    }));
  });

  saveConfig();
  closeModal('discovery-modal');

  // Restart monitoring with new nodes if it was active
  if (monitoringActive) {
    await stopMonitoring();
    await startMonitoring();
  } else {
    // If monitoring is not active, just render from config
    renderTree(config.nodes);
    renderHostList(config.nodes);
  }
}

// ============================================
// Snap to Grid
// ============================================

function toggleSnapToGrid() {
  config.settings.snapToGrid = !config.settings.snapToGrid;
  updateSnapButton();
  saveConfig();
}

function updateSnapButton() {
  const btn = document.getElementById('btn-snap');
  if (config.settings.snapToGrid) {
    btn.classList.add('active');
  } else {
    btn.classList.remove('active');
  }
}

// ============================================
// Export Topology as Image
// ============================================

async function exportTopologyAsImage() {
  toastInfo('Exporting...', 'Preparing topology image');

  // Get the world element containing all nodes and connections
  const worldEl = document.getElementById('world');
  const svgEl = document.getElementById('connections-layer');

  if (!worldEl || config.nodes.length === 0) {
    toastError('Export Failed', 'No topology to export');
    return;
  }

  // Calculate bounds of all nodes
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  config.nodes.forEach(node => {
    const x = (node.x / 100) * 10000;
    const y = (node.y / 100) * 10000;
    minX = Math.min(minX, x - 60);
    minY = Math.min(minY, y - 60);
    maxX = Math.max(maxX, x + 60);
    maxY = Math.max(maxY, y + 60);
  });

  const padding = 50;
  const width = maxX - minX + padding * 2;
  const height = maxY - minY + padding * 2;

  // Create canvas
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Fill background
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);

  // Draw grid (optional)
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  const gridSize = 100;
  for (let x = 0; x < width; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Draw connections
  (config.links || []).forEach(conn => {
    const sourceNode = config.nodes.find(n => n.id === conn.sourceNodeId);
    const targetNode = config.nodes.find(n => n.id === conn.targetNodeId);
    if (!sourceNode || !targetNode) return;

    const x1 = (sourceNode.x / 100) * 10000 - minX + padding;
    const y1 = (sourceNode.y / 100) * 10000 - minY + padding;
    const x2 = (targetNode.x / 100) * 10000 - minX + padding;
    const y2 = (targetNode.y / 100) * 10000 - minY + padding;

    // Get status for color
    const look = linkAppearance(conn, displayedNodes());
    const color = look.color;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = look.waiting ? 0.35 : 0.75;

    // Draw bezier curve
    ctx.beginPath();
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const cpY = Math.min(y1, y2) - 50;
    ctx.moveTo(x1, y1);
    ctx.quadraticCurveTo(midX, cpY, x2, y2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Draw link label if available
    if (conn.medium || conn.speed) {
      const labelX = midX;
      const labelY = (y1 + y2) / 2 - 10;
      const labelText = [conn.medium, conn.speed].filter(Boolean).join(' ');

      ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
      const textWidth = ctx.measureText(labelText).width + 10;
      ctx.fillRect(labelX - textWidth / 2, labelY - 8, textWidth, 16);

      ctx.fillStyle = '#e2e8f0';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(labelText, labelX, labelY + 4);
    }
  });

  // Draw nodes
  config.nodes.forEach(node => {
    const x = (node.x / 100) * 10000 - minX + padding;
    const y = (node.y / 100) * 10000 - minY + padding;

    // Get status
    const nodeData = networkData.find(n => n.id === node.id) || node;
    const view = statusView(nodeData.status);

    // Node background
    const gradient = ctx.createLinearGradient(x - 50, y - 50, x + 50, y + 50);
    gradient.addColorStop(0, 'rgba(30, 41, 59, 0.95)');
    gradient.addColorStop(1, 'rgba(15, 23, 42, 0.95)');
    ctx.fillStyle = gradient;

    // Rounded rectangle
    const w = 100, h = 100, r = 12;
    ctx.beginPath();
    ctx.moveTo(x - w/2 + r, y - h/2);
    ctx.lineTo(x + w/2 - r, y - h/2);
    ctx.quadraticCurveTo(x + w/2, y - h/2, x + w/2, y - h/2 + r);
    ctx.lineTo(x + w/2, y + h/2 - r);
    ctx.quadraticCurveTo(x + w/2, y + h/2, x + w/2 - r, y + h/2);
    ctx.lineTo(x - w/2 + r, y + h/2);
    ctx.quadraticCurveTo(x - w/2, y + h/2, x - w/2, y + h/2 - r);
    ctx.lineTo(x - w/2, y - h/2 + r);
    ctx.quadraticCurveTo(x - w/2, y - h/2, x - w/2 + r, y - h/2);
    ctx.closePath();
    ctx.fill();

    // Border
    ctx.strokeStyle = view.state === 'up'
      ? 'rgba(34, 197, 94, 0.5)'
      : view.state === 'down'
        ? 'rgba(239, 68, 68, 0.5)'
        : 'rgba(148, 163, 184, 0.45)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Status indicator
    ctx.fillStyle = view.state === 'up' ? '#22c55e' : view.state === 'down' ? '#ef4444' : '#94a3b8';
    ctx.beginPath();
    ctx.arc(x + 40, y - 40, 6, 0, Math.PI * 2);
    ctx.fill();

    // Node name
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(node.name || 'Unknown', x, y + 30);

    // Node address
    ctx.fillStyle = '#64748b';
    ctx.font = '9px monospace';
    ctx.fillText(node.address || '', x, y + 42);
  });

  // Convert to blob and download
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `topology-${new Date().toISOString().slice(0, 10)}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toastSuccess('Export Complete', 'Topology image saved');
  }, 'image/png');
}

// ============================================
// Auto Layout
// ============================================

function autoLayoutNodes() {
  if (config.nodes.length === 0) {
    toastWarning('No Nodes', 'Add some nodes first');
    return;
  }

  // Save state for undo
  saveStateForUndo('Auto-layout nodes');

  // Build adjacency map from connections
  const connections = config.links || [];
  const adjacency = new Map();

  config.nodes.forEach(node => {
    adjacency.set(node.id, new Set());
  });

  connections.forEach(conn => {
    if (adjacency.has(conn.sourceNodeId) && adjacency.has(conn.targetNodeId)) {
      adjacency.get(conn.sourceNodeId).add(conn.targetNodeId);
      adjacency.get(conn.targetNodeId).add(conn.sourceNodeId);
    }
  });

  // Find root nodes (nodes with no incoming connections or most connections)
  let rootNodes = config.nodes.filter(node => {
    const incoming = connections.filter(c => c.targetNodeId === node.id).length;
    return incoming === 0;
  });

  if (rootNodes.length === 0) {
    // No clear root, use the node with most connections
    rootNodes = [config.nodes.reduce((best, node) => {
      const conns = adjacency.get(node.id)?.size || 0;
      const bestConns = adjacency.get(best.id)?.size || 0;
      return conns > bestConns ? node : best;
    }, config.nodes[0])];
  }

  // BFS to assign levels
  const levels = new Map();
  const visited = new Set();
  let queue = rootNodes.map(n => ({ id: n.id, level: 0 }));

  while (queue.length > 0) {
    const { id, level } = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    levels.set(id, level);

    const neighbors = adjacency.get(id) || new Set();
    neighbors.forEach(neighborId => {
      if (!visited.has(neighborId)) {
        queue.push({ id: neighborId, level: level + 1 });
      }
    });
  }

  // Handle disconnected nodes
  config.nodes.forEach(node => {
    if (!levels.has(node.id)) {
      levels.set(node.id, 0);
    }
  });

  // Group nodes by level
  const nodesByLevel = new Map();
  levels.forEach((level, nodeId) => {
    if (!nodesByLevel.has(level)) {
      nodesByLevel.set(level, []);
    }
    nodesByLevel.get(level).push(nodeId);
  });

  // Position nodes
  const levelSpacing = 15; // vertical spacing in %
  const startY = 10;
  const startX = 50; // center

  nodesByLevel.forEach((nodeIds, level) => {
    const count = nodeIds.length;
    const totalWidth = count * 12; // spacing between nodes in %
    const startXForLevel = startX - totalWidth / 2 + 6;

    nodeIds.forEach((nodeId, idx) => {
      const node = config.nodes.find(n => n.id === nodeId);
      if (node) {
        node.x = Math.max(5, Math.min(95, startXForLevel + idx * 12));
        node.y = Math.max(5, Math.min(95, startY + level * levelSpacing));
      }
    });
  });

  saveConfig();
  renderTree(config.nodes);
  toastSuccess('Layout Applied', `Organized ${config.nodes.length} nodes in ${nodesByLevel.size} levels`);
}

// ============================================
// Monitoring
// ============================================

function setupMonitoringListener() {
  if (!window.electronAPI) return;

  window.electronAPI.monitor.onStatus((data) => {
    if (!data || !Array.isArray(data.nodes)) return;
    const updated = document.getElementById('last-updated');
    if (updated) updated.textContent = 'Last Update: ' + (data.updated || '');
    const reported = new Map(data.nodes.map((node) => [node.id, node]));
    const now = Date.now();

    networkData = config.nodes.map((configNode) => {
      const entry = reported.get(configNode.id);
      const copy = Object.assign({}, configNode);
      copy.status = entry ? entry.status : 'unknown';
      copy.responseTime = entry && entry.responseTime != null ? entry.responseTime : null;
      delete copy.activeParentId;
      const secretType = Topology.secretType(copy);
      if (secretType) copy.sshSecret = { type: secretType };
      else delete copy.sshSecret;
      delete copy.sshPass;
      delete copy.sshPassphrase;
      delete copy._encrypted;
      delete copy.sshSecretClear;

      const state = Probe.canonicalStatus(copy.status);
      const tracker = uptimeTrackers.get(copy.id);
      if (!tracker || tracker.status !== state) {
        uptimeTrackers.set(copy.id, { status: state, since: now });
      }
      const since = uptimeTrackers.get(copy.id).since;
      copy.uptime = state === 'unknown' ? 'confirming' : formatDuration(now - since);
      rememberStatus(copy.id, copy.name, state, entry && entry.history, now);
      return copy;
    });

    renderTree(networkData);
    renderHostList(networkData);
  });
}

async function startMonitoring() {
  if (!window.electronAPI || monitoringActive) return;

  const settings = config.settings || {};
  await window.electronAPI.monitor.start({
    nodes: (config.nodes || []).map((node) => ({
      id: node.id,
      address: typeof node.address === 'string' ? node.address : '',
      port: node.port == null || node.port === '' ? null : node.port
    })),
    interval: Probe.monitoringInterval(settings.probeIntervalMs),
    confirmations: Probe.confirmationCount(settings.confirmations)
  });

  monitoringActive = true;
  document.getElementById('btn-monitoring').classList.add('active');
}

async function stopMonitoring() {
  if (!window.electronAPI || !monitoringActive) return;

  await window.electronAPI.monitor.stop();
  monitoringActive = false;
  document.getElementById('btn-monitoring').classList.remove('active');
}

async function toggleMonitoring() {
  if (monitoringActive) {
    await stopMonitoring();
  } else {
    await startMonitoring();
  }
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ' + (minutes % 60) + 'm';
  const days = Math.floor(hours / 24);
  return days + 'd ' + (hours % 24) + 'h';
}

// ============================================
// Status History Tracking
// ============================================

function rememberStatus(nodeId, nodeName, state, history, now) {
  const previous = statusHistory.get(nodeId);
  let lastToast = previous ? previous.lastToast : 0;
  if (Probe.shouldToast(previous && previous.lastStatus, state, now, lastToast, Probe.TOAST_QUIET_MS)) {
    const name = nodeName || nodeId;
    if (state === 'up') toastSuccess('Node Online', `"${name}" is now online`);
    else toastError('Node Offline', `"${name}" went offline`);
    lastToast = now;
  }
  const samples = Array.isArray(history)
    ? history.slice(-MAX_HISTORY_ENTRIES)
    : (previous && previous.history) || [];
  statusHistory.set(nodeId, {
    lastStatus: state,
    lastToast: lastToast,
    lastChange: previous && previous.lastStatus === state ? previous.lastChange : now,
    history: samples
  });
}

function historyWhen(entry) {
  const date = new Date(entry && (entry.at || entry.time));
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function historyLabel(status) {
  const state = Probe.canonicalStatus(status);
  if (state === 'up') return 'Online';
  if (state === 'down') return 'Offline';
  return 'Unknown';
}

// ============================================
// Utilities
// ============================================

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJs(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\r/g, '')
    .replace(/\n/g, '');
}

function jsAttr(value) {
  return escapeHtml(escapeJs(value));
}

function safeLucideName(name) {
  return /^[a-z0-9-]+$/i.test(name || '') ? name : 'circle';
}

function safeContainerType(type) {
  const allowed = ['proxmox', 'docker', 'kubernetes', 'vmware', 'rack', 'cloud', 'custom'];
  return allowed.includes(type) ? type : 'custom';
}

function safeCssColor(color) {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color || '') ? color : '#64748b';
}

function sanitizeSvg(svg) {
  if (typeof svg !== 'string') return '';
  const trimmed = svg.trim();
  if (!trimmed.startsWith('<svg') || !trimmed.endsWith('</svg>')) return '';
  if (/<script|<\/script|on\w+\s*=|javascript:|data:/i.test(trimmed)) return '';
  return trimmed;
}

function togglePanel(id) {
  const panel = document.getElementById(id + '-content');
  if (panel) {
    panel.classList.toggle('hidden');
  }
}

// ============================================
// Toast Notifications
// ============================================

const toastIcons = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>'
};

function showToast(type, title, message, duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${toastIcons[type] || toastIcons.info}</div>
    <div class="toast-content">
      <div class="toast-title">${escapeHtml(title)}</div>
      ${message ? `<div class="toast-message">${escapeHtml(message)}</div>` : ''}
    </div>
    <div class="toast-close" onclick="this.parentElement.remove()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M18 6L6 18M6 6l12 12"/>
      </svg>
    </div>
  `;

  container.appendChild(toast);

  // Auto-dismiss
  if (duration > 0) {
    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  return toast;
}

// Convenience functions
function toastSuccess(title, message) { return showToast('success', title, message); }
function toastError(title, message) { return showToast('error', title, message, 6000); }
function toastWarning(title, message) { return showToast('warning', title, message, 5000); }
function toastInfo(title, message) { return showToast('info', title, message); }

// ============================================
// Input Validation
// ============================================

function isValidIP(ip) {
  if (!ip) return false;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every(part => {
    const num = parseInt(part, 10);
    return !isNaN(num) && num >= 0 && num <= 255 && part === num.toString();
  });
}

function isValidHostname(hostname) {
  if (!hostname) return false;
  // Allow IP addresses and valid hostnames
  if (isValidIP(hostname)) return true;
  const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return hostnameRegex.test(hostname);
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
    toastError('Validation Error', 'Invalid IP address or hostname');
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

// ============================================
// Theme Toggle
// ============================================

function initTheme() {
  const savedTheme = config.settings?.theme || localStorage.getItem('theme') || 'dark';
  applyTheme(savedTheme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const themeIcon = document.getElementById('theme-icon');
  if (themeIcon) {
    // Update icon based on theme
    themeIcon.setAttribute('data-lucide', theme === 'dark' ? 'moon' : 'sun');
    lucide.createIcons();
  }
  config.settings.theme = theme;
  localStorage.setItem('theme', theme);
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(newTheme);
  saveConfig();
  toastInfo('Theme Changed', `Switched to ${newTheme} mode`);
}

// ============================================
// Multi-Select Functions
// ============================================

function startSelectionRect(e) {
  isSelecting = true;
  const viewportRect = viewport.getBoundingClientRect();

  // Calculate position in world coordinates
  selectionStart.x = (e.clientX - viewportRect.left - pointX) / scale;
  selectionStart.y = (e.clientY - viewportRect.top - pointY) / scale;

  const rect = document.getElementById('selection-rect');
  rect.style.left = selectionStart.x + 'px';
  rect.style.top = selectionStart.y + 'px';
  rect.style.width = '0px';
  rect.style.height = '0px';
  rect.classList.remove('hidden');
}

function updateSelectionRect(e) {
  if (!isSelecting) return;

  const viewportRect = viewport.getBoundingClientRect();
  const currentX = (e.clientX - viewportRect.left - pointX) / scale;
  const currentY = (e.clientY - viewportRect.top - pointY) / scale;

  const rect = document.getElementById('selection-rect');
  const x = Math.min(selectionStart.x, currentX);
  const y = Math.min(selectionStart.y, currentY);
  const width = Math.abs(currentX - selectionStart.x);
  const height = Math.abs(currentY - selectionStart.y);

  rect.style.left = x + 'px';
  rect.style.top = y + 'px';
  rect.style.width = width + 'px';
  rect.style.height = height + 'px';

  // Highlight nodes inside selection rectangle
  highlightNodesInRect(x, y, width, height);
}

function endSelectionRect(e) {
  if (!isSelecting) return;
  isSelecting = false;

  const rect = document.getElementById('selection-rect');
  rect.classList.add('hidden');

  // Finalize selection
  const viewportRect = viewport.getBoundingClientRect();
  const currentX = (e.clientX - viewportRect.left - pointX) / scale;
  const currentY = (e.clientY - viewportRect.top - pointY) / scale;

  const x = Math.min(selectionStart.x, currentX);
  const y = Math.min(selectionStart.y, currentY);
  const width = Math.abs(currentX - selectionStart.x);
  const height = Math.abs(currentY - selectionStart.y);

  selectNodesInRect(x, y, width, height);
}

function highlightNodesInRect(rectX, rectY, rectW, rectH) {
  document.querySelectorAll('.node-container').forEach(el => {
    const nodeId = el.dataset.nodeId;
    const node = config.nodes.find(n => n.id === nodeId);
    if (!node) return;

    // Calculate node position in world pixels
    const worldWidth = window.innerWidth;
    const worldHeight = window.innerHeight;
    const nodeX = (node.x / 100) * worldWidth;
    const nodeY = (node.y / 100) * worldHeight;

    // Check if node is inside rect
    const isInside = nodeX >= rectX && nodeX <= rectX + rectW &&
                     nodeY >= rectY && nodeY <= rectY + rectH;

    if (isInside) {
      el.classList.add('selected');
    } else if (!selectedNodes.has(nodeId)) {
      el.classList.remove('selected');
    }
  });
}

function selectNodesInRect(rectX, rectY, rectW, rectH) {
  const worldWidth = window.innerWidth;
  const worldHeight = window.innerHeight;

  config.nodes.forEach(node => {
    const nodeX = (node.x / 100) * worldWidth;
    const nodeY = (node.y / 100) * worldHeight;

    const isInside = nodeX >= rectX && nodeX <= rectX + rectW &&
                     nodeY >= rectY && nodeY <= rectY + rectH;

    if (isInside) {
      selectedNodes.add(node.id);
    }
  });

  updateSelectionVisuals();

  if (selectedNodes.size > 0) {
    toastInfo('Selection', `${selectedNodes.size} node(s) selected`);
  }
}

function toggleNodeSelection(nodeId) {
  if (selectedNodes.has(nodeId)) {
    selectedNodes.delete(nodeId);
  } else {
    selectedNodes.add(nodeId);
  }
  updateSelectionVisuals();
}

function clearSelection() {
  selectedNodes.clear();
  updateSelectionVisuals();
}

function updateSelectionVisuals() {
  document.querySelectorAll('.node-container').forEach(el => {
    const nodeId = el.dataset.nodeId;
    if (selectedNodes.has(nodeId)) {
      el.classList.add('selected');
    } else {
      el.classList.remove('selected');
    }
  });
}

// ============================================
// Undo/Redo System
// ============================================

function cloneNodesWithoutSecrets(nodes) {
  const copy = JSON.parse(JSON.stringify(nodes || []));
  copy.forEach((node) => Topology.stripNodeSecretValues(node));
  return copy;
}

function saveStateForUndo(actionName = 'Change') {
  // Deep clone current state
  const state = {
    action: actionName,
    timestamp: Date.now(),
    nodes: cloneNodesWithoutSecrets(config.nodes),
    links: JSON.parse(JSON.stringify(config.links))
  };

  undoStack.push(state);

  // Limit stack size
  if (undoStack.length > MAX_UNDO_HISTORY) {
    undoStack.shift();
  }

  // Clear redo stack when new action is performed
  redoStack = [];

  updateUndoRedoButtons();
}

function undo() {
  if (undoStack.length === 0) {
    toastWarning('Undo', 'Nothing to undo');
    return;
  }

  // Save current state to redo stack
  const currentState = {
    action: 'Current',
    timestamp: Date.now(),
    nodes: cloneNodesWithoutSecrets(config.nodes),
    links: JSON.parse(JSON.stringify(config.links))
  };
  redoStack.push(currentState);

  // Restore previous state
  const previousState = undoStack.pop();
  config.nodes = previousState.nodes;
  config.links = previousState.links;

  // Re-render
  renderTree(config.nodes);
  renderHostList(config.nodes);
  saveConfig();
  updateMinimap();

  updateUndoRedoButtons();
  toastInfo('Undo', `Reverted: ${previousState.action}`);
}

function redo() {
  if (redoStack.length === 0) {
    toastWarning('Redo', 'Nothing to redo');
    return;
  }

  // Save current state to undo stack
  const currentState = {
    action: 'Current',
    timestamp: Date.now(),
    nodes: cloneNodesWithoutSecrets(config.nodes),
    links: JSON.parse(JSON.stringify(config.links))
  };
  undoStack.push(currentState);

  // Restore next state
  const nextState = redoStack.pop();
  config.nodes = nextState.nodes;
  config.links = nextState.links;

  // Re-render
  renderTree(config.nodes);
  renderHostList(config.nodes);
  saveConfig();
  updateMinimap();

  updateUndoRedoButtons();
  toastInfo('Redo', `Restored changes`);
}

function updateUndoRedoButtons() {
  const undoBtn = document.getElementById('btn-undo');
  const redoBtn = document.getElementById('btn-redo');

  if (undoBtn) {
    undoBtn.disabled = undoStack.length === 0;
    undoBtn.title = undoStack.length > 0
      ? `Undo: ${undoStack[undoStack.length - 1].action} (Ctrl+Z)`
      : 'Nothing to undo (Ctrl+Z)';
  }

  if (redoBtn) {
    redoBtn.disabled = redoStack.length === 0;
    redoBtn.title = redoStack.length > 0
      ? `Redo (Ctrl+Y)`
      : 'Nothing to redo (Ctrl+Y)';
  }
}

// ============================================
// Mini-map
// ============================================

function initMinimap() {
  const minimapCanvas = document.getElementById('minimap-canvas');
  const minimap = document.getElementById('minimap');

  if (!minimapCanvas || !minimap) return;

  // Make minimap clickable for navigation
  minimap.addEventListener('click', (e) => {
    if (e.target.id === 'minimap-close' || e.target.closest('#minimap-close')) return;

    const rect = minimapCanvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // Calculate world position
    const minimapWidth = minimapCanvas.width;
    const minimapHeight = minimapCanvas.height;
    const worldWidth = window.innerWidth * 3; // 300% of viewport
    const worldHeight = window.innerHeight * 3;

    const worldX = (clickX / minimapWidth) * worldWidth;
    const worldY = (clickY / minimapHeight) * worldHeight;

    // Center viewport on this position
    const viewportRect = viewport.getBoundingClientRect();
    pointX = viewportRect.width / 2 - worldX * scale;
    pointY = viewportRect.height / 2 - worldY * scale;

    updateTransform();
    updateMinimap();
  });

  lucide.createIcons();
}

function toggleMinimap() {
  minimapVisible = !minimapVisible;
  const minimap = document.getElementById('minimap');
  const btn = document.getElementById('btn-minimap');

  if (minimapVisible) {
    minimap.classList.remove('hidden');
    btn.classList.add('active');
    updateMinimap();
  } else {
    minimap.classList.add('hidden');
    btn.classList.remove('active');
  }
}

function updateMinimap() {
  if (!minimapVisible) return;

  const canvas = document.getElementById('minimap-canvas');
  const viewportIndicator = document.getElementById('minimap-viewport');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const minimapWidth = 200;
  const minimapHeight = 150;

  canvas.width = minimapWidth;
  canvas.height = minimapHeight;

  // Clear canvas
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  ctx.fillStyle = isDark ? '#1e293b' : '#f1f5f9';
  ctx.fillRect(0, 0, minimapWidth, minimapHeight);

  // World dimensions (300% of viewport)
  const worldWidth = window.innerWidth * 3;
  const worldHeight = window.innerHeight * 3;

  // Scale factor for minimap
  const scaleX = minimapWidth / worldWidth;
  const scaleY = minimapHeight / worldHeight;

  // Draw connections. Color follows the ends and the active choice.
  ctx.lineWidth = 1;

  config.links.forEach(conn => {
    const sourceNode = config.nodes.find(n => n.id === conn.sourceNodeId);
    const targetNode = config.nodes.find(n => n.id === conn.targetNodeId);
    if (!sourceNode || !targetNode) return;

    const x1 = (sourceNode.x / 100) * window.innerWidth * scaleX;
    const y1 = (sourceNode.y / 100) * window.innerHeight * scaleY;
    const x2 = (targetNode.x / 100) * window.innerWidth * scaleX;
    const y2 = (targetNode.y / 100) * window.innerHeight * scaleY;
    const look = linkAppearance(conn, displayedNodes());

    ctx.beginPath();
    ctx.strokeStyle = look.color;
    ctx.globalAlpha = look.waiting ? 0.35 : 0.75;
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  });

  // Draw nodes
  config.nodes.forEach(node => {
    const x = (node.x / 100) * window.innerWidth * scaleX;
    const y = (node.y / 100) * window.innerHeight * scaleY;

    // Node color based on status
    const live = networkData.find(n => n.id === node.id) || node;
    const view = statusView(live.status);

    ctx.fillStyle = selectedNodes.has(node.id) ? '#3b82f6' :
                    view.state === 'up' ? '#22c55e' :
                    view.state === 'down' ? '#ef4444' : '#94a3b8';

    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  // Update viewport indicator
  if (viewportIndicator) {
    const viewportRect = viewport.getBoundingClientRect();

    // Calculate visible area in world coordinates
    const visibleX = -pointX / scale;
    const visibleY = -pointY / scale;
    const visibleWidth = viewportRect.width / scale;
    const visibleHeight = viewportRect.height / scale;

    // Convert to minimap coordinates
    const indicatorX = visibleX * scaleX;
    const indicatorY = visibleY * scaleY;
    const indicatorW = visibleWidth * scaleX;
    const indicatorH = visibleHeight * scaleY;

    viewportIndicator.style.left = Math.max(0, indicatorX) + 'px';
    viewportIndicator.style.top = Math.max(0, indicatorY) + 'px';
    viewportIndicator.style.width = Math.min(minimapWidth - indicatorX, indicatorW) + 'px';
    viewportIndicator.style.height = Math.min(minimapHeight - indicatorY, indicatorH) + 'px';
  }
}

// ============================================
// Initialize
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  init();
  setupSSHListeners();
});
