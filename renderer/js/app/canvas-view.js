// Mouse handling of the canvas viewport (zoom, pan, selection, drag routing),
// snap to grid, auto layout and image export.

import { TopologyCanvas, TopologyExport } from './libs.js';
import { displayedNodes, state } from './state.js';
import { toastError, toastSuccess, toastWarning } from './ui.js';
import { saveConfig } from './io.js';
import { getViewport, updateTransform } from './viewport.js';
import { getGridCell, renderTree, statusLabel, statusView } from './canvas-render.js';
import { updateMinimap } from './minimap.js';
import {
  clearSelection,
  endSelectionRect,
  isSelecting,
  startSelectionRect,
  updateSelectionRect
} from './selection.js';
import { saveStateForUndo } from './undo.js';
import { dragNode, endNodeDrag, handleNodeDrag, isDragging } from './canvas-edit.js';

let isPanning = false, startX = 0, startY = 0;

export function setupCanvasListeners() {
  // Zoom
  getViewport().addEventListener('wheel', (e) => {
    e.preventDefault();
    const next = TopologyCanvas.zoomAt({ scale: state.scale, pointX: state.pointX, pointY: state.pointY }, e.clientX, e.clientY, e.deltaY);
    state.scale = next.scale;
    state.pointX = next.pointX;
    state.pointY = next.pointY;
    updateTransform();
  });

  // Pan and Multi-select
  getViewport().addEventListener('mousedown', (e) => {
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
    startX = e.clientX - state.pointX;
    startY = e.clientY - state.pointY;
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
    state.pointX = e.clientX - startX;
    state.pointY = e.clientY - startY;
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
}

export function toggleSnapToGrid() {
  state.config.settings.snapToGrid = !state.config.settings.snapToGrid;
  updateSnapButton();
  saveConfig();
}

export function updateSnapButton() {
  const btn = document.getElementById('btn-snap');
  if (state.config.settings.snapToGrid) {
    btn.classList.add('active');
  } else {
    btn.classList.remove('active');
  }
}

export async function exportTopologyAsImage() {
  const nodes = state.config.nodes.length ? displayedNodes() : [];
  const statusById = new Map(nodes.map((n) => [n.id, n.status]));
  const typeLabels = { proxmox: 'Proxmox', docker: 'Docker', kubernetes: 'K8s', vmware: 'VMware', rack: 'Rack', cloud: 'Cloud', custom: 'Container' };
  await TopologyExport.exportImage({
    document,
    nodes,
    statusView,
    statusLabel: (node, view) => statusLabel(node, statusById, view),
    containerTypeLabel: (type) => typeLabels[type] || 'Container',
    gridCell: (node) => { const cell = getGridCell(node.x || 50, node.y || 50); return cell.col + cell.row; },
    toast: { success: toastSuccess, error: toastError },
    save: window.desktopAPI && window.desktopAPI.image
      ? (format, data, fileName) => window.desktopAPI.image.export(format, data, fileName)
      : null
  });
}

export function autoLayoutNodes() {
  if (state.config.nodes.length === 0) {
    toastWarning('No Nodes', 'Add some nodes first');
    return;
  }

  // Save state for undo
  saveStateForUndo('Auto-layout nodes');

  const layout = TopologyCanvas.autoLayout(state.config.nodes, state.config.links);
  state.config.nodes.forEach(node => {
    const position = layout.positions.get(node.id);
    if (position) {
      node.x = position.x;
      node.y = position.y;
    }
  });

  saveConfig();
  renderTree(state.config.nodes);
  toastSuccess('Layout Applied', `Organized ${state.config.nodes.length} nodes in ${layout.levelCount} levels`);
}
