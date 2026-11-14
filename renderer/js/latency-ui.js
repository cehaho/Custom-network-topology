// Latency tooltip: hovering a node on the canvas (or its row in the host
// list) shows the current round-trip time, min/avg/max, availability over the
// last samples, and a sparkline. The buffers live in history.js; this file
// only listens to `monitor-status` and draws the tooltip.
(function () {
  'use strict';

  if (typeof document === 'undefined' || !window.LatencyHistory) return;
  const History = window.LatencyHistory;
  const store = History.createStore(History.HISTORY_SIZE);
  const TARGETS = '.node-container[data-node-id], .child-node[data-node-id], .host-row[data-node-id]';
  let tooltip = null;
  let hoveredId = null;
  let lastPointer = { x: 0, y: 0 };

  window.LatencyStore = store;

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function nodeName(id) {
    // `config` is the topology document declared in app.js.
    const doc = typeof config !== 'undefined' ? config : null; // eslint-disable-line no-undef
    const nodes = doc && Array.isArray(doc.nodes) ? doc.nodes : [];
    for (const node of nodes) {
      if (node && node.id === id) return node.name || id;
      const children = node && Array.isArray(node.children) ? node.children : [];
      const child = children.find((item) => item && item.id === id);
      if (child) return child.name || id;
    }
    return id;
  }

  function ensureTooltip() {
    if (tooltip) return tooltip;
    tooltip = document.createElement('div');
    tooltip.id = 'latency-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.style.cssText = [
      'position:fixed', 'z-index:9999', 'pointer-events:none', 'display:none',
      'min-width:170px', 'padding:8px 10px', 'border-radius:8px', 'font-size:11px',
      'line-height:1.5', 'background:var(--bg-modal)', 'color:var(--text-primary)',
      'border:1px solid var(--border-color)', 'box-shadow:0 6px 20px rgba(0,0,0,0.35)'
    ].join(';');
    document.body.appendChild(tooltip);
    return tooltip;
  }

  function row(label, value) {
    return `<div style="display:flex;justify-content:space-between;gap:12px;"><span style="color:var(--text-secondary);">${label}</span><span style="font-family:monospace;">${escapeText(value)}</span></div>`;
  }

  function content(id) {
    const stats = store.stats(id);
    const title = `<div style="font-weight:700;margin-bottom:4px;">${escapeText(nodeName(id))}</div>`;
    if (!stats.count) {
      return title + '<div style="color:var(--text-muted);">No latency samples yet. Start monitoring.</div>';
    }
    const current = stats.lastOk === false ? 'timeout' : History.formatMs(stats.current);
    const spark = History.sparklineSvg(store.samples(id), {
      width: 160, height: 32, size: store.size
    });
    return title
      + row('Latency', current)
      + row('Min / Avg / Max', `${History.formatMs(stats.min)} / ${History.formatMs(stats.avg)} / ${History.formatMs(stats.max)}`)
      + row('Availability', `${History.formatPercent(stats.availability)} (${stats.up}/${stats.count})`)
      + `<div style="margin-top:6px;background:rgba(128,128,128,0.08);border-radius:4px;">${spark}</div>`;
  }

  function place() {
    if (!tooltip) return;
    const margin = 14;
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    let left = lastPointer.x + margin;
    let top = lastPointer.y + margin;
    if (left + width > window.innerWidth - 4) left = lastPointer.x - width - margin;
    if (top + height > window.innerHeight - 4) top = lastPointer.y - height - margin;
    tooltip.style.left = Math.max(4, left) + 'px';
    tooltip.style.top = Math.max(4, top) + 'px';
  }

  function show(id) {
    const element = ensureTooltip();
    hoveredId = id;
    element.innerHTML = content(id);
    element.style.display = 'block';
    place();
  }

  function hide() {
    hoveredId = null;
    if (tooltip) tooltip.style.display = 'none';
  }

  document.addEventListener('mouseover', (event) => {
    const target = event.target && event.target.closest ? event.target.closest(TARGETS) : null;
    // A child node sits inside its container: the innermost match wins.
    if (!target) {
      if (hoveredId) hide();
      return;
    }
    lastPointer = { x: event.clientX, y: event.clientY };
    const id = target.dataset.nodeId;
    if (id !== hoveredId) show(id);
  });

  document.addEventListener('mousemove', (event) => {
    if (!hoveredId) return;
    lastPointer = { x: event.clientX, y: event.clientY };
    place();
  });

  // Dragging or panning hides the tooltip until the pointer comes back.
  document.addEventListener('mousedown', hide);
  window.addEventListener('blur', hide);

  if (window.desktopAPI && window.desktopAPI.monitor && window.desktopAPI.monitor.onStatus) {
    window.desktopAPI.monitor.onStatus((data) => {
      store.record(data);
      if (hoveredId && tooltip && tooltip.style.display !== 'none') {
        tooltip.innerHTML = content(hoveredId);
        place();
      }
    });
  }
})();
