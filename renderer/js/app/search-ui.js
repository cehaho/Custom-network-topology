// Canvas search box: highlights matching nodes, dims the rest, and steps
// through matches. Matching rules live in search.js (NodeSearch).
//
// Hooks: CanvasSearch.filter(nodes) from applyNodeFilter (host-list.js), and
// CanvasSearch.decorate() after renderTree and drawLines rebuild the DOM.

import { NodeSearch } from './libs.js';
import { displayedNodes, state } from './state.js';
import { focusOnNode } from './viewport.js';

const STATUS_SELECT = { online: 'up', offline: 'down', unknown: 'unknown' };
const CLASSES = ['search-hit', 'search-dim', 'search-contains', 'search-current'];

const search = {
  active: false,
  matches: [],      // node ids, document order
  index: -1,        // current match, -1 before the first Enter
  currentId: null,
  states: new Map()
};

function input() { return document.getElementById('node-search'); }
function statusSelect() { return document.getElementById('node-filter-status'); }
function counter() { return document.getElementById('node-search-count'); }

function queryText() {
  const box = input();
  const select = statusSelect();
  let text = box ? box.value : '';
  const status = select ? STATUS_SELECT[select.value] : undefined;
  if (status) text += ' status:' + status;
  return text;
}

function currentNodes() {
  return displayedNodes() || [];
}

function recompute(nodes) {
  const list = nodes || currentNodes();
  const query = NodeSearch.parseQuery(queryText());
  search.active = !query.empty;
  search.matches = search.active ? NodeSearch.findMatches(list, query) : list.map((n) => n.id);
  search.states = search.active ? NodeSearch.nodeStates(list, search.matches) : new Map();
  const kept = search.currentId ? search.matches.indexOf(search.currentId) : -1;
  search.index = kept;
  if (kept < 0) search.currentId = null;
  return list;
}

function setClasses(el, look, isCurrent) {
  el.classList.remove.apply(el.classList, CLASSES);
  if (!look) return;
  el.classList.add('search-' + look);
  if (isCurrent) el.classList.add('search-current');
}

function paintNodes() {
  document.querySelectorAll('.node-container, .child-node').forEach((el) => {
    const id = el.dataset.nodeId || el.id.replace(/^node-/, '');
    const look = search.active ? (search.states.get(id) || 'dim') : null;
    setClasses(el, look, search.active && id === search.currentId);
  });
}

function paintLinks() {
  const links = (state.config && state.config.links) || [];
  const byId = new Map(links.map((link) => [link.id, link]));
  document.querySelectorAll('#connections-layer .connection-group').forEach((group) => {
    const link = byId.get(group.dataset.connectionId);
    const dim = search.active && (!link || NodeSearch.linkDimmed(link, search.states));
    // The link label (rect + text) follows its group in the SVG.
    let el = group;
    do {
      el.classList.toggle('search-dim', dim);
      el = el.nextElementSibling;
    } while (el && !el.classList.contains('connection-group'));
  });
}

function paintCount() {
  const el = counter();
  if (!el) return;
  if (!search.active) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.textContent = NodeSearch.countLabel(search.index, search.matches.length);
  el.classList.toggle('search-count-empty', search.matches.length === 0);
}

function paint() {
  paintNodes();
  paintLinks();
  paintCount();
}

// Hook for applyNodeFilter: returns the nodes the host list should show.
function filter(nodes) {
  const list = recompute(nodes);
  paint();
  if (!search.active) return list;
  const wanted = new Set(search.matches);
  return list.filter((node) => wanted.has(node.id));
}

// Hook after the canvas is redrawn (statuses may have changed too).
function decorate() {
  recompute();
  paint();
}

function step(delta) {
  recompute();
  if (!search.active || !search.matches.length) {
    paint();
    return;
  }
  search.index = NodeSearch.cycle(search.index, search.matches.length, delta);
  search.currentId = search.matches[search.index];
  paint();
  const nodes = currentNodes();
  const byId = NodeSearch.indexNodes(nodes);
  const target = NodeSearch.focusTarget(byId.get(search.currentId), byId);
  if (target) focusOnNode(target);
}

function clear() {
  const box = input();
  if (!box) return;
  box.value = '';
  search.currentId = null;
  box.dispatchEvent(new Event('input', { bubbles: true }));
}

function onInputKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    step(e.shiftKey ? -1 : 1);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    step(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    step(-1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (input().value) clear();
    else input().blur();
  }
}

function onGlobalKey(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  if (String(e.key).toLowerCase() !== 'f') return;
  if (state.adminOpen) return;
  if (e.target && e.target.closest && (e.target.closest('.modal') || e.target.closest('.modal-overlay'))) return;
  const box = input();
  if (!box) return;
  e.preventDefault();
  box.focus();
  box.select();
}

export function initSearchUi() {
  const box = input();
  if (!box) return;
  box.addEventListener('keydown', onInputKey);
  document.addEventListener('keydown', onGlobalKey);
}

export const CanvasSearch = {
  filter: filter,
  decorate: decorate,
  next: () => step(1),
  previous: () => step(-1),
  clear: clear
};
