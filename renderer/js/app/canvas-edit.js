// Editing on the canvas with the mouse: dragging nodes (also into containers
// and VLAN zones), drawing links between ports, deleting the selected link.

import { AppDialog, TopologyCanvas } from './libs.js';
import { state } from './state.js';
import { toastSuccess } from './ui.js';
import { saveConfig } from './io.js';
import { getWorld } from './viewport.js';
import { createBezierPath, drawLines, getPortPosition } from './canvas-links.js';
import { renderTree } from './canvas-render.js';
import { updateMinimap } from './minimap.js';
import { clearSelection, toggleNodeSelection } from './selection.js';
import { saveStateForUndo } from './undo.js';

// Connection dragging state
let isConnecting = false;
let connectionStart = null; // { nodeId, portId, element }

// Node drag state (read by canvas-view.js)
export let isDragging = false;
export let dragNode = null;
let dragOffsetX = 0, dragOffsetY = 0;
let multiDragOffsets = new Map(); // For multi-select drag

function snapToGrid(x, y) {
  return TopologyCanvas.snapToGrid(x, y, state.config.settings.snapToGrid);
}

export function startConnection(e, node, portEl) {
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
  const sourceNode = state.config.nodes.find(n => n.id === connectionStart.nodeId);
  const sourcePort = sourceNode?.ports?.find(p => p.id === connectionStart.portId);
  const startPos = getPortPosition(sourceEl, sourcePort, sourceNode);

  // Get mouse position relative to world
  const worldRect = getWorld().getBoundingClientRect();
  const mouseX = (e.clientX - worldRect.left) / state.scale;
  const mouseY = (e.clientY - worldRect.top) / state.scale;

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
      const existingConn = state.config.links.find(c =>
        (c.sourceNodeId === connectionStart.nodeId && c.sourcePortId === connectionStart.portId &&
         c.targetNodeId === targetNodeId && c.targetPortId === targetPortId) ||
        (c.sourceNodeId === targetNodeId && c.sourcePortId === targetPortId &&
         c.targetNodeId === connectionStart.nodeId && c.targetPortId === connectionStart.portId)
      );

      if (!existingConn) {
        // Save state for undo
        const sourceNode = state.config.nodes.find(n => n.id === connectionStart.nodeId);
        const targetNode = state.config.nodes.find(n => n.id === targetNodeId);
        saveStateForUndo(`Connect "${sourceNode?.name || connectionStart.nodeId}" to "${targetNode?.name || targetNodeId}"`);

        // Create new connection
        state.config.links.push({
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
        renderTree(state.config.nodes);
        updateMinimap();
        toastSuccess('Connection Created', 'Nodes connected successfully');
      }
    }
  }

  isConnecting = false;
  connectionStart = null;
}

export async function deleteSelectedConnection() {
  if (!state.selectedConnectionId) return;

  const conn = state.config.links.find(c => c.id === state.selectedConnectionId);
  if (!conn) return;

  // Confirm deletion
  const sourceNode = state.config.nodes.find(n => n.id === conn.sourceNodeId);
  const targetNode = state.config.nodes.find(n => n.id === conn.targetNodeId);
  const sourceName = sourceNode?.name || conn.sourceNodeId;
  const targetName = targetNode?.name || conn.targetNodeId;

  if (await AppDialog.confirm(`Delete connection between "${sourceName}" and "${targetName}"?`, { danger: true })) {
    // Save state for undo
    saveStateForUndo(`Delete connection "${sourceName}" - "${targetName}"`);

    const idx = state.config.links.findIndex(c => c.id === conn.id);
    if (idx !== -1) {
      state.config.links.splice(idx, 1);
      state.selectedConnectionId = null;
      saveConfig();
      renderTree(state.config.nodes);
      updateMinimap();
      toastSuccess('Connection Deleted', 'Connection removed successfully');
    }
  }
}

export function startNodeDrag(e, node) {
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
  if (!state.selectedNodes.has(node.id)) {
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
  const mouseWorldX = (e.clientX - viewportRect.left - state.pointX) / state.scale;
  const mouseWorldY = (e.clientY - viewportRect.top - state.pointY) / state.scale;

  // Store the offset between mouse and node center (using vh/vw units)
  const nodeX = (node.x || 50) / 100 * worldWidth;
  const nodeY = (node.y || 50) / 100 * worldHeight;

  dragOffsetX = mouseWorldX - nodeX;
  dragOffsetY = mouseWorldY - nodeY;

  // Calculate offsets for all selected nodes (for multi-drag)
  multiDragOffsets.clear();
  if (state.selectedNodes.size > 0 && state.selectedNodes.has(node.id)) {
    state.selectedNodes.forEach(nodeId => {
      const selectedNode = state.config.nodes.find(n => n.id === nodeId);
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

export function handleNodeDrag(e) {
  if (!isDragging || !dragNode) return;
  e.preventDefault();

  const viewportEl = document.getElementById('viewport');
  const viewportRect = viewportEl.getBoundingClientRect();

  // Use vw/vh based dimensions for consistency with grid labels
  const worldWidth = window.innerWidth;
  const worldHeight = window.innerHeight;

  // Calculate mouse position in world coordinates (accounting for zoom/pan)
  const mouseWorldX = (e.clientX - viewportRect.left - state.pointX) / state.scale;
  const mouseWorldY = (e.clientY - viewportRect.top - state.pointY) / state.scale;

  // Multi-select drag
  if (multiDragOffsets.size > 0) {
    multiDragOffsets.forEach((offsets, nodeId) => {
      const node = state.config.nodes.find(n => n.id === nodeId);
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

export async function endNodeDrag(e) {
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
    const zone = droppedOnZone ? state.config.nodes.find(n => n.id === droppedOnContainer)?.zones?.find(z => z.id === droppedOnZone) : null;
    const zoneName = zone ? ` (VLAN ${zone.vlanId})` : '';
    saveStateForUndo(`Add node "${dragNode.name}" to container${zoneName}`);
    const node = state.config.nodes.find(n => n.id === dragNode.id);
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
    renderTree(state.config.nodes);
    updateMinimap();
    const container = state.config.nodes.find(n => n.id === droppedOnContainer);
    toastSuccess('Container', `Node added to ${container?.name || 'container'}${zoneName}`);
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
      const node = state.config.nodes.find(n => n.id === nodeId);
      if (node && node._tempX !== undefined) {
        hasChanges = true;
      }
    });

    if (hasChanges) {
      // Save state for undo
      saveStateForUndo(`Move ${multiDragOffsets.size} node(s)`);

      // Apply all position changes
      multiDragOffsets.forEach((_, nodeId) => {
        const node = state.config.nodes.find(n => n.id === nodeId);
        if (node && node._tempX !== undefined) {
          node.x = node._tempX;
          node.y = node._tempY;
          delete node._tempX;
          delete node._tempY;

          // Update networkData if it exists
          const dataNode = state.networkData.find(n => n.id === nodeId);
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
    const configNode = state.config.nodes.find(n => n.id === nodeId);
    if (configNode) {
      configNode.x = newX;
      configNode.y = newY;
    }

    // Update networkData if it exists
    const dataNode = state.networkData.find(n => n.id === nodeId);
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
