// Topology image export: a standalone SVG built from the canvas, and a PNG
// rasterised from that SVG.
//
// The pure part (escaping, icon sanitising, bounds, SVG serialisation) runs in
// Node for the tests. The DOM part measures the live canvas, shows the options
// dialog and hands the bytes to the desktop bridge, which saves them through a
// native save dialog. The renderer never picks the file path itself.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.TopologyExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PADDING = 40;
  const MAX_CANVAS_SIDE = 16384;
  const MAX_CANVAS_AREA = 16384 * 8192;
  const FONT = 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

  const THEMES = {
    dark: {
      background: '#0f172a',
      grid: '#ffffff',
      gridOpacity: '0.03',
      card: '#1e293b',
      cardStroke: '#334155',
      iconBg: '#0f172a',
      text: '#f8fafc',
      muted: '#94a3b8',
      faint: '#475569',
      labelBg: '#0f172a',
      labelText: '#e2e8f0',
      row: '#0f172a'
    },
    light: {
      background: '#f8fafc',
      grid: '#000000',
      gridOpacity: '0.05',
      card: '#ffffff',
      cardStroke: '#cbd5e1',
      iconBg: '#f1f5f9',
      text: '#0f172a',
      muted: '#475569',
      faint: '#94a3b8',
      labelBg: '#ffffff',
      labelText: '#1e293b',
      row: '#f1f5f9'
    }
  };

  // ---------- escaping and value guards ----------

  function escapeXml(value) {
    return String(value === null || value === undefined ? '' : value)
      // Characters XML 1.0 forbids would make the whole file unreadable.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function num(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback === undefined ? 0 : fallback;
    return Math.round(n * 100) / 100;
  }

  const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
  const RGB = /^rgba?\(\s*\d{1,3}(?:\.\d+)?\s*,\s*\d{1,3}(?:\.\d+)?\s*,\s*\d{1,3}(?:\.\d+)?\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/;

  function safeColor(color, fallback) {
    const text = String(color || '').trim();
    if (HEX.test(text) || RGB.test(text)) return text;
    return fallback || '#64748b';
  }

  function truncate(text, maxChars) {
    const value = String(text === null || text === undefined ? '' : text);
    const limit = Math.max(1, Math.floor(maxChars));
    return value.length > limit ? value.slice(0, Math.max(1, limit - 1)) + '…' : value;
  }

  // ---------- icons ----------

  const ICON_TAGS = new Set(['g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect']);
  const ICON_ATTRS = new Set([
    'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height',
    'points', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'stroke-miterlimit', 'stroke-dasharray', 'stroke-opacity', 'fill-opacity', 'fill-rule',
    'clip-rule', 'opacity', 'transform'
  ]);
  const SAFE_VALUE = /^[#\w\s.,%()+\-]*$/;
  const ICON_DEPTH = 8;
  const ICON_ELEMENTS = 400;

  function safeAttrValue(name, value, currentColor) {
    let text = String(value === null || value === undefined ? '' : value).trim();
    if (text.length > 20000) return null;
    if (!SAFE_VALUE.test(text)) return null;
    if (/url|javascript|expression|script/i.test(text)) return null;
    if ((name === 'fill' || name === 'stroke') && /^currentcolor$/i.test(text)) text = currentColor;
    return text;
  }

  // Serialises the children of an icon tree ({ tag, attrs, children }) keeping
  // only drawing elements and presentation attributes. Anything else (scripts,
  // links, images, styles, event handlers, foreignObject) is dropped.
  function sanitizeIconChildren(children, currentColor) {
    let budget = ICON_ELEMENTS;
    function walk(nodes, depth) {
      if (!Array.isArray(nodes) || depth > ICON_DEPTH) return '';
      let out = '';
      for (const node of nodes) {
        if (budget <= 0) break;
        if (!node || typeof node.tag !== 'string') continue;
        const tag = node.tag.toLowerCase();
        if (!ICON_TAGS.has(tag)) continue;
        budget -= 1;
        let attrs = '';
        Object.keys(node.attrs || {}).forEach((key) => {
          const name = key.toLowerCase();
          if (!ICON_ATTRS.has(name)) return;
          const value = safeAttrValue(name, node.attrs[key], currentColor);
          if (value === null) return;
          attrs += ' ' + name + '="' + escapeXml(value) + '"';
        });
        const inner = tag === 'g' ? walk(node.children, depth + 1) : '';
        out += inner ? '<' + tag + attrs + '>' + inner + '</' + tag + '>' : '<' + tag + attrs + '/>';
      }
      return out;
    }
    return walk(children, 0);
  }

  function iconViewBox(attrs) {
    const raw = String((attrs && (attrs.viewBox || attrs.viewbox)) || '').trim();
    const parts = raw.split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      return parts.map((part) => num(part)).join(' ');
    }
    const width = Number(attrs && attrs.width);
    const height = Number(attrs && attrs.height);
    if (width > 0 && height > 0) return '0 0 ' + num(width) + ' ' + num(height);
    return '0 0 24 24';
  }

  // One icon, inlined as a nested <svg>. A missing or unusable icon becomes a
  // circle with the first letter of the name.
  function renderIcon(icon, cx, cy, size, color, fallbackText) {
    const x = num(cx - size / 2);
    const y = num(cy - size / 2);
    if (icon && icon.kind === 'svg' && icon.tree) {
      const attrs = icon.tree.attrs || {};
      const body = sanitizeIconChildren(icon.tree.children, color);
      if (body) {
        let rootAttrs = '';
        ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'].forEach((name) => {
          if (attrs[name] === undefined) return;
          const value = safeAttrValue(name, attrs[name], color);
          if (value !== null) rootAttrs += ' ' + name + '="' + escapeXml(value) + '"';
        });
        return '<svg x="' + x + '" y="' + y + '" width="' + num(size) + '" height="' + num(size) +
          '" viewBox="' + iconViewBox(attrs) + '"' + rootAttrs + '>' + body + '</svg>';
      }
    }
    const letter = String(fallbackText || '?').trim().charAt(0).toUpperCase() || '?';
    return '<circle cx="' + num(cx) + '" cy="' + num(cy) + '" r="' + num(size / 2) +
      '" fill="none" stroke="' + escapeXml(color) + '" stroke-width="1.5"/>' +
      '<text x="' + num(cx) + '" y="' + num(cy + size * 0.18) + '" text-anchor="middle" class="icon-letter" font-size="' +
      num(size * 0.5) + '" fill="' + escapeXml(color) + '">' + escapeXml(letter) + '</text>';
  }

  // ---------- geometry ----------

  // Every coordinate pair of a path. Bezier control points bound the curve,
  // so their box contains the drawn line.
  function pathPoints(d) {
    const numbers = String(d || '').match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
    const points = [];
    for (let i = 0; i + 1 < numbers.length; i += 2) {
      const x = Number(numbers[i]);
      const y = Number(numbers[i + 1]);
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x: x, y: y });
    }
    return points;
  }

  // Path data is numbers and command letters only.
  function validPath(d) {
    const text = String(d || '');
    return text.trim() !== '' && /^[MmLlHhVvCcSsQqTtAaZz0-9eE\s.,+\-]+$/.test(text);
  }

  function computeBounds(scene, padding) {
    const pad = padding === undefined ? PADDING : padding;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    function addBox(box) {
      if (!box) return;
      const x = Number(box.x);
      const y = Number(box.y);
      const w = Number(box.width) || 0;
      const h = Number(box.height) || 0;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    }
    const s = scene || {};
    (s.nodes || []).forEach(addBox);
    (s.containers || []).forEach(addBox);
    (s.linkLabels || []).forEach(addBox);
    (s.links || []).forEach((link) => {
      if (!validPath(link.d)) return;
      pathPoints(link.d).forEach((point) => addBox({ x: point.x, y: point.y, width: 0, height: 0 }));
    });
    if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 2 * pad || 1, height: 2 * pad || 1 };
    return {
      x: num(minX - pad),
      y: num(minY - pad),
      width: num(maxX - minX + 2 * pad),
      height: num(maxY - minY + 2 * pad)
    };
  }

  // Raster size for a PNG, scaled down when the browser canvas could not hold it.
  function pngSize(width, height, scale) {
    let factor = Number(scale) > 0 ? Number(scale) : 1;
    const w = Math.max(1, Number(width) || 1);
    const h = Math.max(1, Number(height) || 1);
    factor = Math.min(factor, MAX_CANVAS_SIDE / w, MAX_CANVAS_SIDE / h, Math.sqrt(MAX_CANVAS_AREA / (w * h)));
    return {
      width: Math.max(1, Math.floor(w * factor)),
      height: Math.max(1, Math.floor(h * factor)),
      scale: factor
    };
  }

  function exportFileName(format, date) {
    const day = (date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date())
      .toISOString()
      .slice(0, 10);
    return 'topology-' + day + '.' + (format === 'svg' ? 'svg' : 'png');
  }

  // ---------- serialisation ----------

  function styleBlock(theme) {
    return '<style>' +
      'text{font-family:' + FONT + ';}' +
      '.name{font-weight:700;font-size:12px;fill:' + theme.text + ';}' +
      '.addr{font-family:' + MONO + ';font-size:11px;fill:' + theme.muted + ';}' +
      '.cell{font-family:' + MONO + ';font-size:9px;fill:' + theme.faint + ';}' +
      '.status{font-weight:700;font-size:10px;letter-spacing:0.6px;}' +
      '.badge{font-size:10px;fill:' + theme.muted + ';}' +
      '.zone{font-weight:600;font-size:11px;fill:' + theme.text + ';}' +
      '.count{font-size:10px;fill:' + theme.muted + ';}' +
      '.link-label{font-family:' + MONO + ';font-weight:700;font-size:10px;fill:' + theme.labelText + ';}' +
      '.icon-letter{font-weight:700;}' +
      '</style>';
  }

  function rect(box, attrs) {
    return '<rect x="' + num(box.x) + '" y="' + num(box.y) + '" width="' + num(box.width, 0) +
      '" height="' + num(box.height, 0) + '"' + (attrs || '') + '/>';
  }

  function text(x, y, value, attrs) {
    return '<text x="' + num(x) + '" y="' + num(y) + '"' + (attrs || '') + '>' + escapeXml(value) + '</text>';
  }

  function statusOf(item) {
    const status = item && item.status ? item.status : {};
    return {
      color: safeColor(status.color, '#94a3b8'),
      label: String(status.label || ''),
      short: String(status.short || status.label || '')
    };
  }

  function renderNode(node, theme) {
    const status = statusOf(node);
    const w = num(node.width, 140);
    const h = num(node.height, 140);
    const x = num(node.x);
    const y = num(node.y);
    const cx = x + w / 2;
    const name = node.name || node.id || 'Unknown';
    const chars = (w - 16) / 7;
    let out = '<g class="node">';
    out += rect({ x: x, y: y, width: w, height: h },
      ' rx="12" fill="' + theme.card + '" stroke="' + status.color + '" stroke-opacity="0.5" stroke-width="2"');
    out += '<circle cx="' + num(cx) + '" cy="' + num(y + 34) + '" r="24" fill="' + theme.iconBg + '" stroke="' +
      theme.cardStroke + '" stroke-width="1"/>';
    out += renderIcon(node.icon, cx, y + 34, 28, theme.text, name);
    out += text(cx, y + 76, truncate(name, chars), ' class="name" text-anchor="middle"');
    if (node.address) out += text(cx, y + 90, truncate(node.address, (w - 8) / 6.6), ' class="addr" text-anchor="middle"');
    if (node.cell) out += text(cx, y + 102, node.cell, ' class="cell" text-anchor="middle"');
    if (status.label) {
      const pillW = Math.min(w - 12, status.label.length * 6.4 + 14);
      out += rect({ x: cx - pillW / 2, y: y + 108, width: pillW, height: 18 },
        ' rx="9" fill="' + status.color + '" fill-opacity="0.12"');
      out += text(cx, y + 121, status.label, ' class="status" text-anchor="middle" fill="' + status.color + '"');
    }
    return out + '</g>';
  }

  function renderContainer(container, theme) {
    const status = statusOf(container);
    const x = num(container.x);
    const y = num(container.y);
    const w = num(container.width, 280);
    const h = num(container.height, 60);
    const headerH = Math.min(h, num(container.headerHeight, 52));
    const name = container.name || container.id || 'Container';
    let out = '<g class="container">';
    out += rect({ x: x, y: y, width: w, height: h },
      ' rx="12" fill="' + theme.card + '" stroke="' + status.color + '" stroke-opacity="0.45" stroke-width="2"');
    const iconCy = y + headerH / 2;
    out += renderIcon(container.icon, x + 26, iconCy, 22, theme.text, name);
    const rightText = [container.count, status.label].filter(Boolean).join('  ');
    const nameChars = (w - 60 - rightText.length * 6.5) / 7;
    out += text(x + 46, iconCy - 2, truncate(name, nameChars), ' class="name"');
    if (container.typeLabel) out += text(x + 46, iconCy + 12, container.typeLabel, ' class="badge"');
    if (container.count) {
      out += text(x + w - 12 - (status.label ? status.label.length * 6.4 + 10 : 0), iconCy + 4,
        container.count, ' class="count" text-anchor="end"');
    }
    if (status.label) {
      out += text(x + w - 12, iconCy + 4, status.label, ' class="status" text-anchor="end" fill="' + status.color + '"');
    }
    (container.zones || []).forEach((zone) => {
      const color = safeColor(zone.color, '#64748b');
      out += rect(zone, ' rx="8" fill="' + color + '" fill-opacity="0.06" stroke="' + color + '" stroke-opacity="0.45" stroke-width="1"');
      const label = [zone.badge, zone.name].filter(Boolean).join(' · ');
      out += text(num(zone.x) + 10, num(zone.y) + 16, truncate(label, (num(zone.width) - 70) / 6.5), ' class="zone" fill="' + color + '"');
      if (zone.count) out += text(num(zone.x) + num(zone.width) - 10, num(zone.y) + 16, zone.count, ' class="count" text-anchor="end"');
    });
    (container.children || []).forEach((child) => {
      const childStatus = statusOf(child);
      const cw = num(child.width);
      const ch = num(child.height);
      const cx = num(child.x);
      const cy = num(child.y);
      const childName = child.name || child.id || '';
      out += rect(child, ' rx="6" fill="' + theme.row + '" fill-opacity="0.7" stroke="' + theme.cardStroke + '" stroke-width="1"');
      out += renderIcon(child.icon, cx + 16, cy + ch / 2, 16, theme.text, childName);
      const chars = (cw - 80) / 7;
      out += text(cx + 32, cy + ch / 2 - (child.address ? 2 : -4), truncate(childName, chars), ' class="name"');
      if (child.address) out += text(cx + 32, cy + ch / 2 + 11, truncate(child.address, (cw - 80) / 6.6), ' class="addr"');
      if (childStatus.short) {
        out += text(cx + cw - 8, cy + ch / 2 + 4, childStatus.short, ' class="status" text-anchor="end" fill="' + childStatus.color + '"');
      }
    });
    return out + '</g>';
  }

  function renderLink(link) {
    const d = String(link.d || '');
    if (!validPath(d)) return '';
    const color = safeColor(link.color, '#94a3b8');
    let attrs = ' fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round"';
    attrs += ' stroke-opacity="' + num(link.opacity, 0.75) + '"';
    if (link.dash && /^[\d.\s,]+$/.test(String(link.dash))) attrs += ' stroke-dasharray="' + escapeXml(link.dash) + '"';
    return '<path d="' + escapeXml(d) + '"' + attrs + '/>';
  }

  function renderLinkLabel(label, theme) {
    const color = safeColor(label.color, '#94a3b8');
    const cx = label.textX !== undefined ? label.textX : num(label.x) + num(label.width) / 2;
    const cy = label.textY !== undefined ? label.textY : num(label.y) + num(label.height) / 2 + 4;
    return rect(label, ' rx="4" fill="' + theme.labelBg + '" fill-opacity="0.9" stroke="' + color + '" stroke-width="1"') +
      text(cx, cy, label.text, ' class="link-label" text-anchor="middle"');
  }

  function grid(bounds, theme) {
    const step = 100;
    let d = '';
    const startX = Math.ceil(bounds.x / step) * step;
    const startY = Math.ceil(bounds.y / step) * step;
    for (let x = startX; x < bounds.x + bounds.width; x += step) d += 'M' + num(x) + ' ' + num(bounds.y) + 'V' + num(bounds.y + bounds.height);
    for (let y = startY; y < bounds.y + bounds.height; y += step) d += 'M' + num(bounds.x) + ' ' + num(y) + 'H' + num(bounds.x + bounds.width);
    return d ? '<path d="' + d + '" stroke="' + theme.grid + '" stroke-opacity="' + theme.gridOpacity + '" stroke-width="1" fill="none"/>' : '';
  }

  // scene: { nodes, containers, links, linkLabels } in canvas pixels, boxes by
  // their top-left corner. options: { theme: 'dark' | 'light', grid: boolean,
  // title: string }.
  function buildSvg(scene, options) {
    const opts = options || {};
    const theme = THEMES[opts.theme] || THEMES.dark;
    const s = scene || {};
    const bounds = computeBounds(s, opts.padding);
    let out = '<?xml version="1.0" encoding="UTF-8"?>\n';
    out += '<svg xmlns="' + SVG_NS + '" version="1.1" width="' + bounds.width + '" height="' + bounds.height +
      '" viewBox="' + bounds.x + ' ' + bounds.y + ' ' + bounds.width + ' ' + bounds.height + '">';
    out += '<title>' + escapeXml(opts.title || 'Network topology') + '</title>';
    out += styleBlock(theme);
    out += rect(bounds, ' fill="' + theme.background + '"');
    if (opts.grid !== false) out += grid(bounds, theme);
    out += '<g class="links">' + (s.links || []).map(renderLink).join('') + '</g>';
    out += '<g class="link-labels">' + (s.linkLabels || []).map((label) => renderLinkLabel(label, theme)).join('') + '</g>';
    out += '<g class="containers">' + (s.containers || []).map((c) => renderContainer(c, theme)).join('') + '</g>';
    out += '<g class="nodes">' + (s.nodes || []).map((n) => renderNode(n, theme)).join('') + '</g>';
    out += '</svg>\n';
    return { svg: out, width: bounds.width, height: bounds.height, bounds: bounds };
  }

  // ---------- DOM: scene collection ----------

  function iconTree(el) {
    if (!el) return null;
    function convert(node) {
      const attrs = {};
      Array.from(node.attributes || []).forEach((attr) => { attrs[attr.name] = attr.value; });
      return {
        tag: String(node.localName || node.tagName || '').toLowerCase(),
        attrs: attrs,
        children: Array.from(node.children || []).map(convert)
      };
    }
    return convert(el);
  }

  function iconOf(scope) {
    if (!scope) return null;
    const svg = scope.querySelector('svg');
    return svg ? { kind: 'svg', tree: iconTree(svg) } : { kind: 'letter' };
  }

  // Measures the live canvas. deps: { document, nodes (with status),
  // statusView(status), statusLabel(node, view), containerTypeLabel(type),
  // gridCell(node) }.
  function collectScene(deps) {
    const doc = deps.document || document;
    const world = doc.getElementById('world');
    const layer = doc.getElementById('connections-layer');
    if (!world) return { nodes: [], containers: [], links: [], linkLabels: [] };
    const worldRect = world.getBoundingClientRect();
    const zoom = world.offsetWidth > 0 ? worldRect.width / world.offsetWidth || 1 : 1;
    function boxOf(el) {
      const r = el.getBoundingClientRect();
      return {
        x: (r.left - worldRect.left) / zoom,
        y: (r.top - worldRect.top) / zoom,
        width: r.width / zoom,
        height: r.height / zoom
      };
    }
    function status(node) {
      const view = deps.statusView(node.status);
      return {
        color: view.color,
        label: deps.statusLabel ? deps.statusLabel(node, view) : view.label,
        short: view.short
      };
    }
    function plural(count) {
      return count + ' node' + (count !== 1 ? 's' : '');
    }

    const all = deps.nodes || [];
    const byId = new Map(all.map((node) => [node.id, node]));
    const scene = { nodes: [], containers: [], links: [], linkLabels: [] };

    all.forEach((node) => {
      if (node.containerId && !node.isContainer) return;
      const el = doc.getElementById('node-' + node.id);
      if (!el) return;
      const box = boxOf(el);
      if (!node.isContainer) {
        const cell = deps.gridCell ? deps.gridCell(node) : '';
        scene.nodes.push(Object.assign(box, {
          id: node.id,
          name: node.name || node.id,
          address: node.address || '',
          cell: cell,
          status: status(node),
          icon: iconOf(el.querySelector('[style*="border-radius:999px"]') || el)
        }));
        return;
      }
      const header = el.querySelector('.container-header');
      const children = all.filter((child) => child.containerId === node.id && !child.isContainer);
      const container = Object.assign(box, {
        id: node.id,
        name: node.name || node.id,
        typeLabel: deps.containerTypeLabel ? deps.containerTypeLabel(node.containerType) : '',
        count: plural(children.length),
        status: status(node),
        icon: iconOf(el.querySelector('.container-icon')),
        headerHeight: header ? boxOf(header).height : 52,
        zones: [],
        children: []
      });
      el.querySelectorAll('.vlan-zone').forEach((zoneEl) => {
        const header = zoneEl.querySelector('.vlan-zone-header') || zoneEl;
        const zoneId = zoneEl.dataset.zoneId;
        const zone = (node.zones || []).find((candidate) => candidate.id === zoneId);
        const countEl = zoneEl.querySelector('.vlan-zone-count');
        container.zones.push(Object.assign(boxOf(zoneEl), {
          name: zone ? zone.name : 'Unassigned',
          badge: zone ? 'VLAN ' + (zone.vlanId === undefined ? '' : zone.vlanId) : 'DEFAULT',
          color: zone ? zone.color : '#888888',
          count: countEl ? countEl.textContent.trim() : '',
          headerHeight: boxOf(header).height
        }));
      });
      el.querySelectorAll('.child-node').forEach((childEl) => {
        const child = byId.get(childEl.dataset.nodeId);
        if (!child) return;
        container.children.push(Object.assign(boxOf(childEl), {
          id: child.id,
          name: child.name || child.id,
          address: child.address || '',
          status: status(child),
          icon: iconOf(childEl.querySelector('.child-node-icon'))
        }));
      });
      scene.containers.push(container);
    });

    if (layer) {
      let label = null;
      Array.from(layer.children).forEach((el) => {
        const tag = String(el.localName || '').toLowerCase();
        if (tag === 'g' && el.classList.contains('connection-group')) {
          const main = el.querySelector('.connection-main');
          if (!main) return;
          const animated = Boolean(el.querySelector('.connection-animated'));
          scene.links.push({
            d: main.getAttribute('d'),
            color: main.getAttribute('stroke'),
            opacity: animated ? 0.9 : main.getAttribute('stroke-opacity'),
            dash: main.getAttribute('stroke-dasharray')
          });
        } else if (tag === 'rect') {
          label = {
            x: Number(el.getAttribute('x')),
            y: Number(el.getAttribute('y')),
            width: Number(el.getAttribute('width')),
            height: Number(el.getAttribute('height')),
            color: el.getAttribute('stroke'),
            text: ''
          };
          scene.linkLabels.push(label);
        } else if (tag === 'text' && label) {
          label.text = el.textContent;
          label.textX = Number(el.getAttribute('x'));
          label.textY = Number(el.getAttribute('y'));
          label = null;
        }
      });
    }
    return scene;
  }

  // ---------- DOM: rasterising and saving ----------

  function svgToPngBase64(svg, width, height, scale) {
    const size = pngSize(width, height, scale);
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = size.width;
          canvas.height = size.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(image, 0, 0, size.width, size.height);
          const url = canvas.toDataURL('image/png');
          resolve(url.slice(url.indexOf(',') + 1));
        } catch (error) {
          reject(error);
        }
      };
      image.onerror = () => reject(new Error('The SVG could not be rasterised'));
      image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    });
  }

  function utf8ToBase64(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  // Options dialog. Resolves { format, scale, theme } or null when canceled.
  function askOptions(defaults) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.id = 'export-image-modal';
      overlay.innerHTML =
        '<div class="modal" style="width:380px">' +
        '<div class="modal-header"><h3>Export Image</h3></div>' +
        '<div class="modal-body">' +
        '<div class="form-group"><label class="form-label">Format</label>' +
        '<select id="export-format" class="form-input"><option value="png">PNG</option><option value="svg">SVG</option></select></div>' +
        '<div class="form-group" id="export-scale-group"><label class="form-label">Scale</label>' +
        '<select id="export-scale" class="form-input"><option value="1">1x</option><option value="2">2x</option></select></div>' +
        '<div class="form-group"><label class="form-label">Background</label>' +
        '<select id="export-theme" class="form-input"><option value="dark">Dark</option><option value="light">Light</option></select></div>' +
        '</div>' +
        '<div class="modal-footer">' +
        '<button class="btn btn-secondary" data-action="cancel">Cancel</button>' +
        '<button class="btn btn-primary" data-action="save">Save...</button>' +
        '</div></div>';
      document.body.appendChild(overlay);
      const format = overlay.querySelector('#export-format');
      const scale = overlay.querySelector('#export-scale');
      const theme = overlay.querySelector('#export-theme');
      format.value = defaults.format || 'png';
      scale.value = String(defaults.scale || 1);
      theme.value = defaults.theme || 'dark';
      const scaleGroup = overlay.querySelector('#export-scale-group');
      const syncScale = () => { scaleGroup.style.display = format.value === 'png' ? '' : 'none'; };
      format.addEventListener('change', syncScale);
      syncScale();
      function done(value) {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(value);
      }
      function onKey(event) {
        if (event.key === 'Escape') { event.stopPropagation(); done(null); }
      }
      document.addEventListener('keydown', onKey, true);
      overlay.addEventListener('click', (event) => {
        const action = event.target.closest && event.target.closest('[data-action]');
        if (event.target === overlay || (action && action.dataset.action === 'cancel')) return done(null);
        if (action && action.dataset.action === 'save') {
          done({ format: format.value === 'svg' ? 'svg' : 'png', scale: scale.value === '2' ? 2 : 1, theme: theme.value === 'light' ? 'light' : 'dark' });
        }
      });
    });
  }

  let lastOptions = null;

  // Entry point used by app/canvas-view.js. deps: everything collectScene needs, plus
  // toast { info, success, error } and save(format, base64, fileName).
  async function exportImage(deps) {
    if (!deps.nodes || deps.nodes.length === 0) {
      deps.toast.error('Export Failed', 'No topology to export');
      return;
    }
    if (typeof deps.save !== 'function') {
      deps.toast.error('Export Failed', 'Image export needs the desktop app');
      return;
    }
    const currentTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const options = await askOptions(lastOptions || { format: 'png', scale: 1, theme: currentTheme });
    if (!options) return;
    lastOptions = options;
    try {
      const scene = collectScene(deps);
      const built = buildSvg(scene, { theme: options.theme });
      const data = options.format === 'svg'
        ? utf8ToBase64(built.svg)
        : await svgToPngBase64(built.svg, built.width, built.height, options.scale);
      const result = await deps.save(options.format, data, exportFileName(options.format, new Date()));
      if (result && result.success) {
        deps.toast.success('Export Complete', result.path ? 'Saved to ' + result.path : 'Topology image saved');
      } else if (!(result && result.canceled)) {
        deps.toast.error('Export Failed', (result && result.error) || 'The image was not saved');
      }
    } catch (error) {
      deps.toast.error('Export Failed', (error && error.message) || String(error));
    }
  }

  return {
    THEMES: THEMES,
    escapeXml: escapeXml,
    safeColor: safeColor,
    truncate: truncate,
    sanitizeIconChildren: sanitizeIconChildren,
    renderIcon: renderIcon,
    pathPoints: pathPoints,
    computeBounds: computeBounds,
    pngSize: pngSize,
    exportFileName: exportFileName,
    buildSvg: buildSvg,
    collectScene: collectScene,
    exportImage: exportImage
  };
});
