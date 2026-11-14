// The mini-map: overview of the world and the visible part of it.

import { TopologyCanvas, lucide } from './libs.js';
import { displayedNodes, state } from './state.js';
import { getViewport, updateTransform } from './viewport.js';
import { linkAppearance } from './canvas-links.js';
import { statusView } from './canvas-render.js';

export function initMinimap() {
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

    const target = TopologyCanvas.minimapToWorld(clickX, clickY, minimapWidth, minimapHeight, worldWidth, worldHeight);

    // Center viewport on this position
    const viewportRect = getViewport().getBoundingClientRect();
    const centred = TopologyCanvas.centerOn(target.x, target.y, viewportRect.width, viewportRect.height, state.scale);
    state.pointX = centred.pointX;
    state.pointY = centred.pointY;

    updateTransform();
    updateMinimap();
  });

  lucide.createIcons();
}

export function toggleMinimap() {
  state.minimapVisible = !state.minimapVisible;
  const minimap = document.getElementById('minimap');
  const btn = document.getElementById('btn-minimap');

  if (state.minimapVisible) {
    minimap.classList.remove('hidden');
    btn.classList.add('active');
    updateMinimap();
  } else {
    minimap.classList.add('hidden');
    btn.classList.remove('active');
  }
}

export function updateMinimap() {
  if (!state.minimapVisible) return;

  const canvas = document.getElementById('minimap-canvas');
  const viewportIndicator = document.getElementById('minimap-viewport');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const minimapWidth = 200;
  const minimapHeight = 150;

  canvas.width = minimapWidth;
  canvas.height = minimapHeight;

  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  const shown = displayedNodes();
  TopologyCanvas.drawMinimap(ctx, {
    width: minimapWidth,
    height: minimapHeight,
    dark: isDark,
    nodes: state.config.nodes,
    links: state.config.links,
    // Color follows the ends and the active choice.
    lookFor: conn => linkAppearance(conn, shown),
    colorFor: node => {
      const live = state.networkData.find(n => n.id === node.id) || node;
      return TopologyCanvas.minimapNodeColor(state.selectedNodes.has(node.id), statusView(live.status).state);
    }
  });

  if (viewportIndicator) {
    const viewportRect = getViewport().getBoundingClientRect();
    const box = TopologyCanvas.minimapIndicator(
      { scale: state.scale, pointX: state.pointX, pointY: state.pointY },
      viewportRect.width,
      viewportRect.height,
      window.innerWidth * TopologyCanvas.WORLD_FACTOR,
      window.innerHeight * TopologyCanvas.WORLD_FACTOR,
      minimapWidth,
      minimapHeight
    );
    viewportIndicator.style.left = box.left + 'px';
    viewportIndicator.style.top = box.top + 'px';
    viewportIndicator.style.width = box.width + 'px';
    viewportIndicator.style.height = box.height + 'px';
  }
}

export function closeMinimap() {
  state.minimapVisible = false;
  document.getElementById('minimap').classList.add('hidden');
  document.getElementById('btn-minimap').classList.remove('active');
}
