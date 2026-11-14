// Multi-select: Shift-drag selection rectangle and Ctrl-click toggling.

import { TopologyCanvas } from './libs.js';
import { state } from './state.js';
import { toastInfo } from './ui.js';
import { getViewport } from './viewport.js';

export let isSelecting = false;
const selectionStart = { x: 0, y: 0 };

export function startSelectionRect(e) {
  isSelecting = true;
  const viewportRect = getViewport().getBoundingClientRect();

  // Calculate position in world coordinates
  selectionStart.x = (e.clientX - viewportRect.left - state.pointX) / state.scale;
  selectionStart.y = (e.clientY - viewportRect.top - state.pointY) / state.scale;

  const rect = document.getElementById('selection-rect');
  rect.style.left = selectionStart.x + 'px';
  rect.style.top = selectionStart.y + 'px';
  rect.style.width = '0px';
  rect.style.height = '0px';
  rect.classList.remove('hidden');
}

export function updateSelectionRect(e) {
  if (!isSelecting) return;

  const viewportRect = getViewport().getBoundingClientRect();
  const currentX = (e.clientX - viewportRect.left - state.pointX) / state.scale;
  const currentY = (e.clientY - viewportRect.top - state.pointY) / state.scale;

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

export function endSelectionRect(e) {
  if (!isSelecting) return;
  isSelecting = false;

  const rect = document.getElementById('selection-rect');
  rect.classList.add('hidden');

  // Finalize selection
  const viewportRect = getViewport().getBoundingClientRect();
  const currentX = (e.clientX - viewportRect.left - state.pointX) / state.scale;
  const currentY = (e.clientY - viewportRect.top - state.pointY) / state.scale;

  const x = Math.min(selectionStart.x, currentX);
  const y = Math.min(selectionStart.y, currentY);
  const width = Math.abs(currentX - selectionStart.x);
  const height = Math.abs(currentY - selectionStart.y);

  selectNodesInRect(x, y, width, height);
}

function highlightNodesInRect(rectX, rectY, rectW, rectH) {
  document.querySelectorAll('.node-container').forEach(el => {
    const nodeId = el.dataset.nodeId;
    const node = state.config.nodes.find(n => n.id === nodeId);
    if (!node) return;

    const rect = { x: rectX, y: rectY, width: rectW, height: rectH };
    const isInside = TopologyCanvas.nodeInRect(node, rect, window.innerWidth, window.innerHeight);

    if (isInside) {
      el.classList.add('selected');
    } else if (!state.selectedNodes.has(nodeId)) {
      el.classList.remove('selected');
    }
  });
}

function selectNodesInRect(rectX, rectY, rectW, rectH) {
  const rect = { x: rectX, y: rectY, width: rectW, height: rectH };
  TopologyCanvas.nodesInRect(state.config.nodes, rect, window.innerWidth, window.innerHeight)
    .forEach(id => state.selectedNodes.add(id));

  updateSelectionVisuals();

  if (state.selectedNodes.size > 0) {
    toastInfo('Selection', `${state.selectedNodes.size} node(s) selected`);
  }
}

export function toggleNodeSelection(nodeId) {
  if (state.selectedNodes.has(nodeId)) {
    state.selectedNodes.delete(nodeId);
  } else {
    state.selectedNodes.add(nodeId);
  }
  updateSelectionVisuals();
}

export function clearSelection() {
  state.selectedNodes.clear();
  updateSelectionVisuals();
}

function updateSelectionVisuals() {
  document.querySelectorAll('.node-container').forEach(el => {
    const nodeId = el.dataset.nodeId;
    if (state.selectedNodes.has(nodeId)) {
      el.classList.add('selected');
    } else {
      el.classList.remove('selected');
    }
  });
}
