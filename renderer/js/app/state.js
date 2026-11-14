// Shared mutable state of the canvas page. Modules read and write these fields
// (state.config = ...) instead of sharing globals. State that only one module
// needs stays private to that module.

import { Topology } from './libs.js';

export const state = {
  // The topology document being edited.
  config: Topology.emptyDocument(),
  // Latest monitor report: copies of config.nodes with status fields.
  networkData: [],
  monitoringActive: false,
  // The embedded admin table is open: canvas shortcuts are off.
  adminOpen: false,
  // Zoom/pan transform of #world.
  scale: 1,
  pointX: 0,
  pointY: 0,
  // Multi-selection (node ids) and the selected link.
  selectedNodes: new Set(),
  selectedConnectionId: null,
  minimapVisible: false
};

export function displayedNodes() {
  return state.monitoringActive && state.networkData.length ? state.networkData : state.config.nodes;
}
