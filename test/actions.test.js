'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Topology = require('../renderer/js/topology.js');
const QuickActions = require('../renderer/js/actions.js');

const root = path.join(__dirname, '..');

test('parses MAC notations into the canonical form', () => {
  assert.equal(Topology.parseMac('aa:bb:cc:0d:ee:ff'), 'aa:bb:cc:0d:ee:ff');
  assert.equal(Topology.parseMac('AA-BB-CC-0D-EE-FF'), 'aa:bb:cc:0d:ee:ff');
  assert.equal(Topology.parseMac('aabb.cc0d.eeff'), 'aa:bb:cc:0d:ee:ff');
  assert.equal(Topology.parseMac('aabbcc0deeff'), 'aa:bb:cc:0d:ee:ff');
  assert.equal(Topology.parseMac(' aa:bb:cc:0d:ee:ff '), 'aa:bb:cc:0d:ee:ff');
});

test('refuses malformed, zero, broadcast and multicast MACs', () => {
  [
    '', 'aa:bb:cc:dd:ee', 'aa:bb:cc:dd:ee:ff:00', 'aa:bb-cc:dd:ee:ff', 'aa:bb:cc:dd:ee:fg',
    'aabb.ccdd.eef', '00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff', '01:00:5e:00:00:01',
    'aa:bb:cc:dd:ee:ff; reboot', null, 42
  ].forEach((value) => assert.equal(Topology.parseMac(value), null, String(value)));
});

test('broadcast must be a unicast or broadcast IPv4 address', () => {
  assert.equal(Topology.parseBroadcast('192.168.1.255'), '192.168.1.255');
  assert.equal(Topology.parseBroadcast('255.255.255.255'), '255.255.255.255');
  ['0.0.0.0', '224.0.0.1', '::1', 'host.local', '192.168.1.255;id', '010.0.0.1'].forEach((value) => {
    assert.equal(Topology.parseBroadcast(value), null, value);
  });
});

test('builds web URLs only from validated addresses (same cases as actions.rs)', () => {
  const cases = [
    [['192.168.1.1', null, null], 'http://192.168.1.1/'],
    [['192.168.1.1', null, 443], 'https://192.168.1.1/'],
    [['192.168.1.1', 'https', 8443], 'https://192.168.1.1:8443/'],
    [['192.168.1.1', 'HTTP', 80], 'http://192.168.1.1/'],
    [['NAS.local', 'http', 5000], 'http://nas.local:5000/'],
    [['2001:db8::1', null, 8080], 'http://[2001:db8::1]:8080/'],
    [['[::1]', 'https', null], 'https://[::1]/'],
    [['fe80::1%eth0', null, null], 'http://[fe80::1%25eth0]/'],
    [['192.168.1.1', 'javascript', null], null],
    [['192.168.1.1', 'file', null], null],
    [['evil.com/@x', null, null], null],
    [['a b', null, null], null],
    [['192.168.1.1', null, 0], null]
  ];
  cases.forEach(([args, expected]) => {
    assert.equal(QuickActions.buildWebUrl(...args), expected, JSON.stringify(args));
  });
  assert.equal(QuickActions.nodeWebUrl({ address: '10.0.0.2', webUrlScheme: 'https', webPort: 9443 }), 'https://10.0.0.2:9443/');
  assert.equal(QuickActions.nodeWebUrl({ address: '' }), null);
});

test('the document keeps valid quick-action fields and drops invalid ones', () => {
  const result = Topology.read({
    schemaVersion: 1,
    settings: {},
    nodes: [
      { id: 'a', name: 'A', address: '10.0.0.1', mac: 'AA-BB-CC-DD-EE-01', wolBroadcast: '10.0.0.255', webUrlScheme: 'HTTPS', webPort: '8443' },
      { id: 'b', name: 'B', address: '10.0.0.2', mac: 'nope', wolBroadcast: '::1', webUrlScheme: 'ftp', webPort: '+80' },
      { id: 'c', name: 'C', address: '10.0.0.3' }
    ],
    links: [],
    ports: []
  });
  assert.equal(result.ok, true);
  const [a, b, c] = result.document.nodes;
  assert.equal(a.mac, 'aa:bb:cc:dd:ee:01');
  assert.equal(a.wolBroadcast, '10.0.0.255');
  assert.equal(a.webUrlScheme, 'https');
  assert.equal(a.webPort, 8443);
  ['mac', 'wolBroadcast', 'webUrlScheme', 'webPort'].forEach((key) => {
    assert.equal(Object.prototype.hasOwnProperty.call(b, key), false, key);
    assert.equal(Object.prototype.hasOwnProperty.call(c, key), false, key);
  });
  assert.equal(result.changed, true);
});

test('a document already in canonical form is not rewritten for these fields', () => {
  const first = Topology.read({ nodes: [{ id: 'a', name: 'A', address: '10.0.0.1', mac: 'aa:bb:cc:dd:ee:01', webPort: 8080 }] });
  const second = Topology.read(first.document);
  assert.equal(second.changed, false);
  assert.deepEqual(second.document, first.document);
});

test('discovered nodes keep their MAC', () => {
  const node = Topology.createNode({ id: 'n', address: '192.168.1.20', mac: 'AA:BB:CC:DD:EE:02' });
  assert.equal(node.mac, 'aa:bb:cc:dd:ee:02');
  const without = Topology.createNode({ id: 'm', address: '192.168.1.21', mac: undefined });
  assert.equal(Object.prototype.hasOwnProperty.call(without, 'mac'), false);
});

test('node form fields are set or removed', () => {
  const node = { id: 'a', mac: 'aa:bb:cc:dd:ee:01', webPort: 8080 };
  QuickActions.applyNodeFields(node, { mac: null, wolBroadcast: '10.0.0.255', webUrlScheme: null, webPort: 81 });
  assert.deepEqual(node, { id: 'a', wolBroadcast: '10.0.0.255', webPort: 81 });
});

test('formats parsed hops for the traceroute panel', () => {
  const text = QuickActions.formatHops([
    { hop: 1, address: '192.168.1.1', rtts: [0.512, 1, null] },
    { hop: 2, address: null, rtts: [null, null, null] }
  ]);
  const lines = text.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^ {2}1 {2}192\.168\.1\.1 +0\.51 ms {2}1\.00 ms {2}\*$/);
  assert.match(lines[1], /^ {2}2 {2}\* +\* {2}\* {2}\*$/);
});

test('the quick-action commands are wired in Rust, the bridge and the capability', () => {
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const lib = read('src-tauri/src/lib.rs');
  const build = read('src-tauri/build.rs');
  const capability = JSON.parse(read('src-tauri/capabilities/default.json'));
  const bridge = read('renderer/js/desktop.js');
  ['actions_open_web', 'actions_traceroute', 'actions_wake'].forEach((command) => {
    assert.match(lib, new RegExp('fn ' + command + '\\('), command);
    assert.match(lib, new RegExp('\\b' + command + ',\\n'), command);
    assert.ok(build.includes('"' + command + '"'), command);
    assert.ok(capability.permissions.includes('allow-' + command.replace(/_/g, '-')), command);
    assert.ok(bridge.includes("'" + command + "'"), command);
  });
  // The renderer never gets the generic opener permission: the URL is rebuilt in Rust.
  assert.equal(capability.permissions.some((permission) => String(permission).startsWith('opener:')), false);
});
