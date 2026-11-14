// Undo/redo of node and link edits (secrets are never kept in the stacks).

import { Topology } from './libs.js';
import { state } from './state.js';
import { toastInfo, toastWarning } from './ui.js';
import { saveConfig } from './io.js';
import { renderTree } from './canvas-render.js';
import { updateMinimap } from './minimap.js';
import { renderHostList } from './host-list.js';

let undoStack = [];
let redoStack = [];
const MAX_UNDO_HISTORY = 50;

function cloneNodesWithoutSecrets(nodes) {
  const copy = JSON.parse(JSON.stringify(nodes || []));
  copy.forEach((node) => Topology.stripNodeSecretValues(node));
  return copy;
}

export function saveStateForUndo(actionName = 'Change') {
  // Deep clone current state
  const snapshot = {
    action: actionName,
    timestamp: Date.now(),
    nodes: cloneNodesWithoutSecrets(state.config.nodes),
    links: JSON.parse(JSON.stringify(state.config.links))
  };

  undoStack.push(snapshot);

  // Limit stack size
  if (undoStack.length > MAX_UNDO_HISTORY) {
    undoStack.shift();
  }

  // Clear redo stack when new action is performed
  redoStack = [];

  updateUndoRedoButtons();
}

export function undo() {
  if (undoStack.length === 0) {
    toastWarning('Undo', 'Nothing to undo');
    return;
  }

  // Save current state to redo stack
  const currentState = {
    action: 'Current',
    timestamp: Date.now(),
    nodes: cloneNodesWithoutSecrets(state.config.nodes),
    links: JSON.parse(JSON.stringify(state.config.links))
  };
  redoStack.push(currentState);

  // Restore previous state
  const previousState = undoStack.pop();
  state.config.nodes = previousState.nodes;
  state.config.links = previousState.links;

  // Re-render
  renderTree(state.config.nodes);
  renderHostList(state.config.nodes);
  saveConfig();
  updateMinimap();

  updateUndoRedoButtons();
  toastInfo('Undo', `Reverted: ${previousState.action}`);
}

export function redo() {
  if (redoStack.length === 0) {
    toastWarning('Redo', 'Nothing to redo');
    return;
  }

  // Save current state to undo stack
  const currentState = {
    action: 'Current',
    timestamp: Date.now(),
    nodes: cloneNodesWithoutSecrets(state.config.nodes),
    links: JSON.parse(JSON.stringify(state.config.links))
  };
  undoStack.push(currentState);

  // Restore next state
  const nextState = redoStack.pop();
  state.config.nodes = nextState.nodes;
  state.config.links = nextState.links;

  // Re-render
  renderTree(state.config.nodes);
  renderHostList(state.config.nodes);
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
