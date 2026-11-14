'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Search = require('../renderer/js/search.js');

const nodes = [
  { id: 'gw', name: 'Gateway', address: '192.168.1.1', icon: 'router', status: 'up' },
  { id: 'nas', name: 'Storage NAS', address: '192.168.1.20', icon: 'server', status: 'down' },
  { id: 'v6', name: 'Lab box', address: 'fe80::1ff:fe23:4567:890a', icon: 'server', status: 'unknown' },
  {
    id: 'pve', name: 'Proxmox', address: '10.0.0.5', icon: 'box', isContainer: true, containerType: 'proxmox', status: true,
    zones: [{ id: 'z10', name: 'DMZ', vlanId: '10' }, { id: 'z20', name: 'Office', vlanId: 20 }]
  },
  { id: 'web', name: 'web-01', address: '10.0.10.2', icon: 'globe', containerId: 'pve', zoneId: 'z10', status: false },
  { id: 'db', name: 'db-01', address: '10.0.20.2', icon: 'database', containerId: 'pve', zoneId: 'z20' }
];

const ids = (query) => Search.findMatches(nodes, query);

test('tokenize keeps quoted values and field prefixes together', () => {
  assert.deepEqual(Search.tokenize('  name:"core switch"  status:down "a b" '), ['name:core switch', 'status:down', 'a b']);
  assert.deepEqual(Search.tokenize(''), []);
});

test('parseQuery reads fields, aliases, OR lists and negation', () => {
  const q = Search.parseQuery('IP:10.0. status:Offline,pending -type:Docker free');
  assert.deepEqual(q.terms, [
    { field: 'address', values: ['10.0.'], negate: false },
    { field: 'status', values: ['down', 'unknown'], negate: false },
    { field: 'type', values: ['docker'], negate: true },
    { field: 'text', values: ['free'], negate: false }
  ]);
  assert.equal(q.empty, false);
  assert.equal(Search.parseQuery('   ').empty, true);
  // An incomplete field while typing is ignored.
  assert.equal(Search.parseQuery('status:').empty, true);
  // Unknown prefixes are free text (IPv6, URLs).
  assert.deepEqual(Search.parseQuery('fe80::1').terms, [{ field: 'text', values: ['fe80::1'], negate: false }]);
});

test('empty query matches every node', () => {
  assert.deepEqual(ids(''), nodes.map((n) => n.id));
});

test('free text matches name and partial address, case-insensitively', () => {
  assert.deepEqual(ids('nas'), ['nas']);
  assert.deepEqual(ids('GATE'), ['gw']);
  assert.deepEqual(ids('192.168.1.'), ['gw', 'nas']);
  assert.deepEqual(ids('FE80::1FF'), ['v6']);
  assert.deepEqual(ids('4567:890a'), ['v6']);
});

test('free text also matches type, zone and status words', () => {
  assert.deepEqual(ids('server'), ['nas', 'v6']);
  assert.deepEqual(ids('dmz'), ['pve', 'web']);
  assert.deepEqual(ids('offline'), ['nas', 'web']);
});

test('status filter uses canonical states', () => {
  assert.deepEqual(ids('status:down'), ['nas', 'web']);
  assert.deepEqual(ids('status:up'), ['gw', 'pve']);
  assert.deepEqual(ids('status:unknown'), ['v6', 'db']);
  assert.deepEqual(ids('status:down,unknown'), ['nas', 'v6', 'web', 'db']);
});

test('vlan is exact, zone is partial on name or VLAN', () => {
  assert.deepEqual(ids('vlan:10'), ['pve', 'web']);
  assert.deepEqual(ids('vlan:2'), []);
  assert.deepEqual(ids('vlan:20'), ['pve', 'db']);
  assert.deepEqual(ids('zone:off'), ['pve', 'db']);
});

test('type matches icon, container type and "container"', () => {
  assert.deepEqual(ids('type:server'), ['nas', 'v6']);
  assert.deepEqual(ids('type:proxmox'), ['pve']);
  assert.deepEqual(ids('type:container'), ['pve']);
});

test('terms combine with AND and can be negated', () => {
  assert.deepEqual(ids('type:server status:down'), ['nas']);
  assert.deepEqual(ids('ip:10. -vlan:10'), ['db']);
  assert.deepEqual(ids('-status:up'), ['nas', 'v6', 'web', 'db']);
  assert.deepEqual(ids('name:"web-01"'), ['web']);
});

test('svg and url icons are not treated as types', () => {
  const list = [{ id: 'a', name: 'A', iconType: 'svg', icon: '<svg>server</svg>' }];
  assert.deepEqual(Search.findMatches(list, 'type:server'), []);
});

test('nodeStates keeps containers of matches lit', () => {
  const states = Search.nodeStates(nodes, ['web', 'gw']);
  assert.equal(states.get('web'), 'hit');
  assert.equal(states.get('gw'), 'hit');
  assert.equal(states.get('pve'), 'contains');
  assert.equal(states.get('db'), 'dim');
  assert.equal(states.get('nas'), 'dim');
});

test('links are dimmed only between two dimmed ends', () => {
  const states = Search.nodeStates(nodes, ['gw']);
  assert.equal(Search.linkDimmed({ sourceNodeId: 'gw', targetNodeId: 'nas' }, states), false);
  assert.equal(Search.linkDimmed({ sourceNodeId: 'nas', targetNodeId: 'v6' }, states), true);
  assert.equal(Search.linkDimmed({ sourceNodeId: 'missing', targetNodeId: 'v6' }, states), true);
});

test('cycle wraps both ways and starts at the right end', () => {
  assert.equal(Search.cycle(-1, 3, 1), 0);
  assert.equal(Search.cycle(-1, 3, -1), 2);
  assert.equal(Search.cycle(2, 3, 1), 0);
  assert.equal(Search.cycle(0, 3, -1), 2);
  assert.equal(Search.cycle(1, 3, 1), 2);
  assert.equal(Search.cycle(5, 3, 1), 0);
  assert.equal(Search.cycle(0, 0, 1), -1);
});

test('countLabel shows "n / m"', () => {
  assert.equal(Search.countLabel(-1, 4), '0 / 4');
  assert.equal(Search.countLabel(1, 4), '2 / 4');
  assert.equal(Search.countLabel(-1, 0), '0 / 0');
});

test('focusTarget centers children on their container', () => {
  const byId = Search.indexNodes(nodes);
  assert.equal(Search.focusTarget(byId.get('web'), byId), 'pve');
  assert.equal(Search.focusTarget(byId.get('gw'), byId), 'gw');
  assert.equal(Search.focusTarget(undefined, byId), null);
});

test('search scripts load before app.js and app.js uses the hooks', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const at = (name) => html.indexOf(`<script src="js/${name}"></script>`);
  assert.ok(at('search.js') > 0 && at('search.js') < at('search-ui.js'));
  assert.ok(at('search-ui.js') < at('app.js'));
  assert.match(html, /id="node-search-count"/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'app.js'), 'utf8');
  assert.match(app, /CanvasSearch\.filter\(sourceNodes\)/);
  assert.ok((app.match(/CanvasSearch\.decorate\(\)/g) || []).length >= 2);
});

test('search.js sets a browser global', () => {
  const sandbox = {};
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'search.js'), 'utf8');
  new Function('globalThis', 'module', source)(sandbox, undefined);
  assert.equal(typeof sandbox.NodeSearch.findMatches, 'function');
});
