// Canvas geometry: grid snap, zoom and pan, port anchors, link paths,
// rectangle selection, auto-layout and the minimap.
//
// Pure functions only. app.js owns the DOM and the view state
// ({ scale, pointX, pointY }) and passes measurements in. Node positions are
// percentages of the viewport (x of the width, y of the height); the grid is
// 20 columns by 50 rows of 5% each.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.TopologyCanvas = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GRID_STEP = 5;
  const GRID_ROWS = 50;
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 5;
  const ZOOM_STEP = 1.1;
  const MINIMAP_WIDTH = 200;
  const MINIMAP_HEIGHT = 150;
  const WORLD_FACTOR = 3; // the world is 300% of the viewport

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // Snap to the centre of a 5% cell. Off: the position is left alone.
  function snapToGrid(x, y, enabled) {
    if (!enabled) return { x: x, y: y };
    const offset = GRID_STEP / 2;
    const snappedX = Math.round((x - offset) / GRID_STEP) * GRID_STEP + offset;
    const snappedY = Math.round((y - offset) / GRID_STEP) * GRID_STEP + offset;
    return {
      x: clamp(snappedX, offset, 100 - offset),
      y: clamp(snappedY, offset, GRID_ROWS * GRID_STEP - offset)
    };
  }

  function gridCell(x, y, cols) {
    const colIndex = Math.floor((x - 0.01) / GRID_STEP);
    const rowIndex = Math.floor((y - 0.01) / GRID_STEP) + 1;
    return {
      col: colIndex >= 0 && colIndex < cols.length ? cols[colIndex] : '?',
      row: rowIndex >= 1 && rowIndex <= GRID_ROWS ? rowIndex : '?'
    };
  }

  // Keep a dragged node on the grid area before snapping.
  function clampNodePosition(x, y) {
    return { x: clamp(x, 1, 99), y: clamp(y, 1, GRID_ROWS * GRID_STEP) };
  }

  // Zoom one step around the cursor: the world point under it stays put.
  function zoomAt(view, clientX, clientY, deltaY) {
    const xs = (clientX - view.pointX) / view.scale;
    const ys = (clientY - view.pointY) / view.scale;
    const grown = -deltaY > 0 ? view.scale * ZOOM_STEP : view.scale / ZOOM_STEP;
    const scale = clamp(grown, MIN_SCALE, MAX_SCALE);
    return { scale: scale, pointX: clientX - xs * scale, pointY: clientY - ys * scale };
  }

  function screenToWorld(view, clientX, clientY, originLeft, originTop) {
    return {
      x: (clientX - (originLeft || 0) - view.pointX) / view.scale,
      y: (clientY - (originTop || 0) - view.pointY) / view.scale
    };
  }

  // Pan offset that puts a world point in the middle of the viewport.
  function centerOn(worldX, worldY, viewportWidth, viewportHeight, scale) {
    return {
      pointX: viewportWidth / 2 - worldX * scale,
      pointY: viewportHeight / 2 - worldY * scale
    };
  }

  function normalizeRect(ax, ay, bx, by) {
    return {
      x: Math.min(ax, bx),
      y: Math.min(ay, by),
      width: Math.abs(bx - ax),
      height: Math.abs(by - ay)
    };
  }

  function nodeInRect(node, rect, worldWidth, worldHeight) {
    const x = (node.x / 100) * worldWidth;
    const y = (node.y / 100) * worldHeight;
    return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
  }

  function nodesInRect(nodes, rect, worldWidth, worldHeight) {
    return (nodes || [])
      .filter((node) => nodeInRect(node, rect, worldWidth, worldHeight))
      .map((node) => node.id);
  }

  // Where a port sits along its side, in percent. Matches the CSS spread.
  function portOffsetPercent(ports, port) {
    const side = port ? port.side : undefined;
    const id = port ? port.id : undefined;
    const sameSide = (ports || []).filter((p) => p.side === side);
    const count = sameSide.length;
    if (count <= 1) return 50;
    const index = sameSide.findIndex((p) => p.id === id);
    const positions = count === 2 ? [35, 65]
      : count === 3 ? [30, 50, 70]
      : Array.from({ length: count }, (_, i) => 20 + (60 * i / (count - 1)));
    return positions[index] || 50;
  }

  // Anchor of a port on a node box whose (x, y) is the centre.
  function portAnchor(box, ports, port) {
    const offset = portOffsetPercent(ports, port);
    const left = box.x - box.width / 2;
    const top = box.y - box.height / 2;
    switch ((port && port.side) || 'bottom') {
      case 'top':
        return { x: left + box.width * offset / 100, y: top };
      case 'bottom':
        return { x: left + box.width * offset / 100, y: box.y + box.height / 2 };
      case 'left':
        return { x: left, y: top + box.height * offset / 100 };
      case 'right':
        return { x: box.x + box.width / 2, y: top + box.height * offset / 100 };
      default:
        return { x: box.x, y: box.y };
    }
  }

  function controlPoint(x, y, side, curvature) {
    switch (side) {
      case 'top': return { x: x, y: y - curvature };
      case 'bottom': return { x: x, y: y + curvature };
      case 'left': return { x: x - curvature, y: y };
      case 'right': return { x: x + curvature, y: y };
      default: return { x: x, y: y };
    }
  }

  // Cubic curve leaving each port along its side's normal.
  function bezierPath(x1, y1, x2, y2, sourceSide, targetSide) {
    const distance = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
    const curvature = Math.min(distance * 0.5, 100);
    const c1 = controlPoint(x1, y1, sourceSide, curvature);
    const c2 = controlPoint(x2, y2, targetSide, curvature);
    return `M ${x1} ${y1} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${x2} ${y2}`;
  }

  function linkLabel(link) {
    return [link && link.medium, link && link.speed].filter(Boolean).join(' ');
  }

  // Background box and text anchor for a label at the middle of a link.
  function labelBox(x1, y1, x2, y2, text) {
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    const width = String(text).length * 6 + 8;
    return {
      x: midX - width / 2,
      y: midY - 8,
      width: width,
      height: 16,
      textX: midX,
      textY: midY + 4
    };
  }

  // Stroke of the base path for a Probe.linkLook result.
  function linkStroke(look) {
    return {
      color: look.color,
      opacity: look.waiting ? '0.28' : '0.45',
      dash: look.waiting ? '2 7' : null,
      animated: Boolean(look.animate)
    };
  }

  // Breadth-first levels from the roots (no incoming link), one row per level.
  // Returns new positions; the caller writes them to the nodes.
  function autoLayout(nodes, links) {
    const list = nodes || [];
    const connections = links || [];
    const adjacency = new Map();
    list.forEach((node) => adjacency.set(node.id, new Set()));
    connections.forEach((conn) => {
      if (adjacency.has(conn.sourceNodeId) && adjacency.has(conn.targetNodeId)) {
        adjacency.get(conn.sourceNodeId).add(conn.targetNodeId);
        adjacency.get(conn.targetNodeId).add(conn.sourceNodeId);
      }
    });

    let roots = list.filter((node) => !connections.some((c) => c.targetNodeId === node.id));
    if (roots.length === 0 && list.length) {
      roots = [list.reduce((best, node) => {
        const conns = adjacency.get(node.id).size;
        const bestConns = adjacency.get(best.id).size;
        return conns > bestConns ? node : best;
      }, list[0])];
    }

    const levels = new Map();
    const visited = new Set();
    const queue = roots.map((n) => ({ id: n.id, level: 0 }));
    while (queue.length > 0) {
      const item = queue.shift();
      if (visited.has(item.id)) continue;
      visited.add(item.id);
      levels.set(item.id, item.level);
      adjacency.get(item.id).forEach((neighborId) => {
        if (!visited.has(neighborId)) queue.push({ id: neighborId, level: item.level + 1 });
      });
    }
    list.forEach((node) => {
      if (!levels.has(node.id)) levels.set(node.id, 0);
    });

    const byLevel = new Map();
    levels.forEach((level, id) => {
      if (!byLevel.has(level)) byLevel.set(level, []);
      byLevel.get(level).push(id);
    });

    const positions = new Map();
    byLevel.forEach((ids, level) => {
      const startX = 50 - (ids.length * 12) / 2 + 6;
      ids.forEach((id, idx) => {
        positions.set(id, {
          x: clamp(startX + idx * 12, 5, 95),
          y: clamp(10 + level * 15, 5, 95)
        });
      });
    });
    return { positions: positions, levelCount: byLevel.size };
  }

  function minimapNodeColor(selected, state) {
    if (selected) return '#3b82f6';
    if (state === 'up') return '#22c55e';
    if (state === 'down') return '#ef4444';
    return '#94a3b8';
  }

  // Minimap point for a node position. The world is 300% of the viewport.
  function minimapPoint(node, width, height) {
    return {
      x: (node.x / 100) * (width / WORLD_FACTOR),
      y: (node.y / 100) * (height / WORLD_FACTOR)
    };
  }

  // Draw links first, then nodes on top, onto a 2D context.
  // options: { width, height, dark, nodes, links, lookFor(link), colorFor(node) }
  function drawMinimap(ctx, options) {
    const width = options.width || MINIMAP_WIDTH;
    const height = options.height || MINIMAP_HEIGHT;
    const nodes = options.nodes || [];
    const byId = new Map();
    nodes.forEach((n) => { if (!byId.has(n.id)) byId.set(n.id, n); });

    ctx.fillStyle = options.dark ? '#1e293b' : '#f1f5f9';
    ctx.fillRect(0, 0, width, height);
    ctx.lineWidth = 1;

    (options.links || []).forEach((link) => {
      const source = byId.get(link.sourceNodeId);
      const target = byId.get(link.targetNodeId);
      if (!source || !target) return;
      const a = minimapPoint(source, width, height);
      const b = minimapPoint(target, width, height);
      const look = options.lookFor(link);
      ctx.beginPath();
      ctx.strokeStyle = look.color;
      ctx.globalAlpha = look.waiting ? 0.35 : 0.75;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    nodes.forEach((node) => {
      const p = minimapPoint(node, width, height);
      ctx.fillStyle = options.colorFor(node);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // The visible part of the world, in minimap pixels, clipped to the minimap.
  function minimapIndicator(view, viewportWidth, viewportHeight, worldWidth, worldHeight, width, height) {
    const w = width || MINIMAP_WIDTH;
    const h = height || MINIMAP_HEIGHT;
    const sx = w / worldWidth;
    const sy = h / worldHeight;
    const x = (-view.pointX / view.scale) * sx;
    const y = (-view.pointY / view.scale) * sy;
    return {
      left: Math.max(0, x),
      top: Math.max(0, y),
      width: Math.min(w - x, (viewportWidth / view.scale) * sx),
      height: Math.min(h - y, (viewportHeight / view.scale) * sy)
    };
  }

  // A click on the minimap, as the world point it stands for.
  function minimapToWorld(clickX, clickY, width, height, worldWidth, worldHeight) {
    return {
      x: (clickX / width) * worldWidth,
      y: (clickY / height) * worldHeight
    };
  }

  return {
    GRID_STEP: GRID_STEP,
    GRID_ROWS: GRID_ROWS,
    MIN_SCALE: MIN_SCALE,
    MAX_SCALE: MAX_SCALE,
    MINIMAP_WIDTH: MINIMAP_WIDTH,
    MINIMAP_HEIGHT: MINIMAP_HEIGHT,
    WORLD_FACTOR: WORLD_FACTOR,
    snapToGrid: snapToGrid,
    gridCell: gridCell,
    clampNodePosition: clampNodePosition,
    zoomAt: zoomAt,
    screenToWorld: screenToWorld,
    centerOn: centerOn,
    normalizeRect: normalizeRect,
    nodeInRect: nodeInRect,
    nodesInRect: nodesInRect,
    portOffsetPercent: portOffsetPercent,
    portAnchor: portAnchor,
    bezierPath: bezierPath,
    linkLabel: linkLabel,
    labelBox: labelBox,
    linkStroke: linkStroke,
    autoLayout: autoLayout,
    minimapNodeColor: minimapNodeColor,
    minimapPoint: minimapPoint,
    drawMinimap: drawMinimap,
    minimapIndicator: minimapIndicator,
    minimapToWorld: minimapToWorld
  };
});
