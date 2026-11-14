// The zoom/pan transform of the canvas world and helpers that move it.

import { state } from './state.js';

export function getViewport() {
  return document.getElementById('viewport');
}

export function getWorld() {
  return document.getElementById('world');
}

export function updateTransform() {
  getWorld().style.transform = `translate(${state.pointX}px, ${state.pointY}px) scale(${state.scale})`;
}

export function focusOnNode(nodeId) {
  const node = state.config.nodes.find(n => n.id === nodeId);
  if (!node) return;

  const el = document.getElementById(`node-${nodeId}`);
  if (!el) return;

  // Calculate position to center the node
  const viewportRect = getViewport().getBoundingClientRect();
  // Centre of the node in canvas coordinates. The old code assumed a
  // 10000 px canvas and pushed the node off screen.
  // Measured on screen so CSS centring and nested child nodes are handled.
  const rect = el.getBoundingClientRect();
  const worldX = (rect.left + rect.width / 2 - viewportRect.left - state.pointX) / state.scale;
  const worldY = (rect.top + rect.height / 2 - viewportRect.top - state.pointY) / state.scale;
  const targetX = viewportRect.width / 2 - worldX * state.scale;
  const targetY = viewportRect.height / 2 - worldY * state.scale;

  // Animate pan to node
  const startX = state.pointX;
  const startY = state.pointY;
  const duration = 300;
  const startTime = performance.now();

  function animate(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic

    state.pointX = startX + (targetX - startX) * eased;
    state.pointY = startY + (targetY - startY) * eased;
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

// The canvas point (percent units) at the centre of the visible viewport.
export function viewportCenterPercent() {
  const rect = getViewport().getBoundingClientRect();
  const worldX = (rect.width / 2 - state.pointX) / state.scale;
  const worldY = (rect.height / 2 - state.pointY) / state.scale;
  return { x: (worldX / window.innerWidth) * 100, y: (worldY / window.innerHeight) * 100 };
}
