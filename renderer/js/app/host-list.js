// The "Host Status" side panel and the search/status filter applied to it.

import { Probe } from './libs.js';
import { escapeHtml } from './util.js';
import { state } from './state.js';
import { focusOnNode } from './viewport.js';
import { CanvasSearch } from './search-ui.js';
import { statusView } from './canvas-render.js';

export function renderHostList(nodes) {
  const list = document.getElementById('host-list-content');
  document.getElementById('host-count').innerText = nodes.length;

  const rank = { down: 0, unknown: 1, up: 2 };
  const sortedNodes = [...nodes].sort((a, b) => {
    const left = rank[Probe.canonicalStatus(a.status)];
    const right = rank[Probe.canonicalStatus(b.status)];
    if (left === right) return (a.name || '').localeCompare(b.name || '');
    return left - right;
  });

  let html = '';
  sortedNodes.forEach(node => {
    const view = statusView(node.status);
    const colorClass = view.dot;
    const uptimeText = node.uptime || '—';
    const listLabel = view.state === 'up' ? 'UP' : view.state === 'down' ? 'DOWN' : 'UNKNOWN';
    const statusColor = view.text;

    html += `
      <div class="host-row" data-node-id="${node.id}"${node.probeDetail ? ` title="${escapeHtml(node.probeDetail)}"` : ''}>
        <div class="flex items-center">
          <div class="status-dot ${colorClass}"></div>
          <div class="flex flex-col">
            <span class="font-bold text-slate-200">${escapeHtml(node.name || '')}</span>
            <span class="text-[10px] text-slate-500 font-mono">${escapeHtml(node.address || '')}</span>
          </div>
        </div>
        <div class="text-right">
          <div class="text-[10px] ${statusColor}">${listLabel}</div>
          <div class="status-text">${uptimeText}</div>
        </div>
      </div>
    `;
  });
  list.innerHTML = html;

  // Add click handlers to focus on node
  list.querySelectorAll('.host-row').forEach(row => {
    row.addEventListener('click', () => {
      const nodeId = row.dataset.nodeId;
      focusOnNode(nodeId);
    });
  });
}

export function applyNodeFilter() {
  const searchTerm = document.getElementById('node-search').value.toLowerCase().trim();
  const statusFilter = document.getElementById('node-filter-status').value;

  // Get nodes from monitoring data if active, otherwise from config
  const sourceNodes = state.monitoringActive && state.networkData.length ? state.networkData : state.config.nodes;

  // Filter nodes (query syntax in search.js); also highlights the canvas.
  const filteredNodes = CanvasSearch.filter(sourceNodes);

  // Update host list with filtered nodes
  renderHostList(filteredNodes);

  // Update host count to show filtered/total
  const countEl = document.getElementById('host-count');
  if (searchTerm || statusFilter !== 'all') {
    countEl.innerText = `${filteredNodes.length}/${sourceNodes.length}`;
  } else {
    countEl.innerText = sourceNodes.length;
  }
}
