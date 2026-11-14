// Drawing of the links between node ports (drawLines), their look, and the
// selected link.

import { Probe, SnmpUI, TopologyCanvas } from './libs.js';
import { displayedNodes, state } from './state.js';
import { saveConfig } from './io.js';
import { getWorld } from './viewport.js';
import { CanvasSearch } from './search-ui.js';

export function linkAppearance(conn, nodes) {
  const statusById = new Map((nodes || []).map((node) => [node.id, node.status]));
  const active = Probe.activeLink(state.config.links, conn.targetNodeId, statusById);
  const isActive = Boolean(active && active.id === conn.id);
  return Probe.linkLook(
    conn.role,
    isActive,
    statusById.get(conn.sourceNodeId),
    statusById.get(conn.targetNodeId)
  );
}

export function drawLines() {
  const svg = document.getElementById('connections-layer');
  if (!svg) return;
  svg.setAttribute('width', '300%');
  svg.setAttribute('height', '300%');
  svg.innerHTML = '';

  // Draw connections from config.links array
  state.config.links.forEach(conn => {
    const sourceNode = state.config.nodes.find(n => n.id === conn.sourceNodeId);
    const targetNode = state.config.nodes.find(n => n.id === conn.targetNodeId);
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
    if (state.selectedConnectionId === conn.id) {
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
    const stroke = TopologyCanvas.linkStroke(look);
    path.setAttribute('stroke-opacity', stroke.opacity);
    if (stroke.dash) path.setAttribute('stroke-dasharray', stroke.dash);
    path.classList.add('connection-main');
    group.appendChild(path);

    // Only the active link, and only while both ends answer, moves.
    if (stroke.animated) {
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

    SnmpUI.decorateLink(group, conn, state.config, () => { saveConfig(); drawLines(); });

    // Click handler for selection
    group.addEventListener('click', (e) => {
      e.stopPropagation();
      selectConnection(conn.id);
    });

    // Enable pointer events for connection groups
    group.style.pointerEvents = 'auto';

    svg.appendChild(group);

    // Draw link speed/type label if available
    const labelText = TopologyCanvas.linkLabel(conn);
    if (labelText) {
      const box = TopologyCanvas.labelBox(x1, y1, x2, y2, labelText);

      const textBg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      textBg.setAttribute('x', box.x);
      textBg.setAttribute('y', box.y);
      textBg.setAttribute('width', box.width);
      textBg.setAttribute('height', box.height);
      textBg.setAttribute('rx', 4);
      textBg.setAttribute('fill', 'rgba(15, 23, 42, 0.9)');
      textBg.setAttribute('stroke', baseColor);
      textBg.setAttribute('stroke-width', '1');
      svg.appendChild(textBg);

      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute('x', box.textX);
      text.setAttribute('y', box.textY);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', '#e2e8f0');
      text.setAttribute('font-size', '10');
      text.setAttribute('font-family', 'monospace');
      text.setAttribute('font-weight', 'bold');
      text.textContent = labelText;
      svg.appendChild(text);
    }
  });
  CanvasSearch.decorate();
}

// Get the pixel position of a port on a node
export function getPortPosition(nodeEl, port, node) {
  // Try to find the actual port element for precise positioning
  if (port && port.id) {
    const portEl = nodeEl.querySelector(`[data-port-id="${port.id}"]`);
    if (portEl) {
      // Get port element's center position relative to world
      const portRect = portEl.getBoundingClientRect();
      const worldRect = getWorld().getBoundingClientRect();

      // Calculate position in world coordinates (accounting for zoom/pan)
      const x = (portRect.left + portRect.width / 2 - worldRect.left) / state.scale;
      const y = (portRect.top + portRect.height / 2 - worldRect.top) / state.scale;

      return { x, y };
    }
  }

  // Fallback: node box from layout (offsetLeft/Top is the centre due to CSS transform)
  const box = { x: nodeEl.offsetLeft, y: nodeEl.offsetTop, width: nodeEl.offsetWidth, height: nodeEl.offsetHeight };
  return TopologyCanvas.portAnchor(box, node.ports || [], port);
}

// Create a bezier path between two points, considering port sides
export function createBezierPath(x1, y1, x2, y2, sourceSide, targetSide) {
  return TopologyCanvas.bezierPath(x1, y1, x2, y2, sourceSide, targetSide);
}

function selectConnection(connId) {
  // Toggle selection if clicking the same connection
  if (state.selectedConnectionId === connId) {
    state.selectedConnectionId = null;
  } else {
    state.selectedConnectionId = connId;
  }
  drawLines(); // Re-render to show selection
}

export function deselectConnection() {
  if (state.selectedConnectionId) {
    state.selectedConnectionId = null;
    drawLines();
  }
}
