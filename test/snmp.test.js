'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Topology = require('../renderer/js/topology.js');
const SnmpUI = require('../renderer/js/snmp.js');

function doc(nodes, links) {
  return { schemaVersion: 1, settings: {}, nodes: nodes, links: links || [], ports: [] };
}

test('node SNMP settings are normalized like the Rust side', () => {
  const read = Topology.read(doc([
    { id: 'a', snmp: { enabled: true, port: 99999, version: '3', extra: 1 }, snmpSecret: { type: 'community' } },
    { id: 'b', snmp: true, snmpSecret: { type: 'password' }, snmpCommunity: 5, snmpCommunityClear: 'yes' },
    { id: 'c', snmp: { enabled: true, port: 1161, community: 'public' } }
  ]));
  assert.equal(read.ok, true);
  const [a, b, c] = read.document.nodes;
  assert.deepEqual(a.snmp, { enabled: true, port: 161, version: '2c' });
  assert.deepEqual(a.snmpSecret, { type: 'community' });
  assert.equal(b.snmp, undefined);
  assert.equal(b.snmpSecret, undefined);
  assert.equal(b.snmpCommunity, undefined);
  assert.equal(b.snmpCommunityClear, undefined);
  assert.equal(c.snmp.port, 1161);
  assert.equal(c.snmp.community, 'public');
  assert.equal(read.changed, true);
});

test('link interface fields are checked', () => {
  const read = Topology.read(doc(
    [{ id: 'a' }, { id: 'b' }],
    [
      { id: 'l1', sourceNodeId: 'a', targetNodeId: 'b', role: 'primary', snmpIfIndex: '12', snmpIfName: ' ge-0/0/1 ', snmpNodeId: 'b' },
      { id: 'l2', sourceNodeId: 'a', targetNodeId: 'b', role: 'primary', snmpIfIndex: 0, snmpIfName: '', snmpNodeId: 'zz' }
    ]
  ));
  const [l1, l2] = read.document.links;
  assert.equal(l1.snmpIfIndex, 12);
  assert.equal(l1.snmpIfName, 'ge-0/0/1');
  assert.equal(l1.snmpNodeId, 'b');
  assert.equal(l2.snmpIfIndex, undefined);
  assert.equal(l2.snmpIfName, undefined);
  assert.equal(l2.snmpNodeId, undefined);
});

test('the community never survives a strip or an export copy', () => {
  const source = doc([
    { id: 'a', snmp: { enabled: true, port: 161, version: '2c', community: 'x' }, snmpCommunity: 'y', snmpSecret: { type: 'community', value: 'z' } },
    { id: 'b', snmpCommunity: 'unsaved' }
  ]);
  assert.equal(Topology.hasSecretValues(source), true);
  const exported = Topology.withoutSecretValues(source);
  const body = JSON.stringify(exported);
  assert.ok(!body.includes('"x"') && !body.includes('"y"') && !body.includes('"z"') && !body.includes('unsaved'));
  assert.deepEqual(exported.nodes[0].snmpSecret, { type: 'community' });
  // A value that was never saved does not turn into a "saved" marker.
  assert.equal(exported.nodes[1].snmpSecret, undefined);
  assert.equal(Topology.hasSecretValues(exported), false);
  assert.equal(Topology.snmpCommunitySaved(exported.nodes[0]), true);
});

test('a duplicated node does not inherit the community marker', () => {
  const node = { id: 'a', snmpSecret: { type: 'community' }, snmp: { enabled: true, port: 161, version: '2c' } };
  Topology.forgetInheritedSecret(node);
  assert.equal(node.snmpSecret, undefined);
  assert.equal(node.snmp.enabled, true);
});

test('only enabled nodes with an address are polled, community not sent', () => {
  const request = SnmpUI.startRequest(doc([
    { id: 'a', address: '10.0.0.1', snmp: { enabled: true, port: 1161 }, snmpSecret: { type: 'community' } },
    { id: 'b', address: '10.0.0.2', snmp: { enabled: false, port: 161 } },
    { id: 'c', address: '', snmp: { enabled: true, port: 161 } },
    { id: 'd', address: '10.0.0.4' }
  ]));
  assert.deepEqual(request, { nodes: [{ id: 'a', address: '10.0.0.1', port: 1161 }], intervalSecs: 30 });
  assert.equal(SnmpUI.intervalSecs({ snmpIntervalSecs: 2 }), 10);
  assert.equal(SnmpUI.intervalSecs({ snmpIntervalSecs: 120 }), 120);
});

test('rates and uptime are readable', () => {
  assert.equal(SnmpUI.formatBps(null), '-');
  assert.equal(SnmpUI.formatBps(512), '512 b/s');
  assert.equal(SnmpUI.formatBps(1234567), '1.2 Mb/s');
  assert.equal(SnmpUI.formatBps(250e9), '250 Gb/s');
  assert.equal(SnmpUI.formatUptime(90061), '1d 1h');
  assert.equal(SnmpUI.formatUptime(3720), '1h 2m');
});

const sample = {
  id: 'sw',
  ok: true,
  sysName: 'core-sw',
  sysDescr: 'Example switch',
  uptimeSecs: 3600,
  interfaces: [
    { index: 1, name: 'ge-0/0/0', descr: 'GigabitEthernet0', operStatus: 'up', speedBps: 1e9, inBps: 700e6, outBps: 100e6 },
    { index: 2, name: 'ge-0/0/1', descr: 'GigabitEthernet1', operStatus: 'down', speedBps: 1e9, inBps: 0, outBps: 0 },
    { index: 3, name: 'uplink', descr: 'TenGig', operStatus: 'up', speedBps: 0, inBps: 5e6, outBps: null }
  ]
};

function topology() {
  return doc(
    [
      { id: 'sw', name: 'Core', snmp: { enabled: true, port: 161, version: '2c' }, ports: [{ id: 'sw_p1', name: 'GE-0/0/0', side: 'bottom' }] },
      { id: 'host', name: 'Host', ports: [{ id: 'host_in', name: 'IN', side: 'top' }] }
    ],
    []
  );
}

test('link load follows the explicit interface, then the port name', () => {
  const data = new Map([['sw', sample]]);
  const docValue = topology();
  const byIndex = SnmpUI.linkLoad({ sourceNodeId: 'sw', targetNodeId: 'host', snmpIfIndex: 2 }, docValue, data);
  assert.equal(byIndex.name, 'ge-0/0/1');
  assert.equal(byIndex.utilization, 0);

  const byPort = SnmpUI.linkLoad({ sourceNodeId: 'sw', sourcePortId: 'sw_p1', targetNodeId: 'host', targetPortId: 'host_in' }, docValue, data);
  assert.equal(byPort.index, 1);
  assert.equal(byPort.utilization, 0.7);
  assert.equal(SnmpUI.loadStyle(byPort.utilization).color, '#f97316');

  const byName = SnmpUI.linkLoad({ sourceNodeId: 'host', targetNodeId: 'sw', snmpIfName: 'tengig' }, docValue, data);
  assert.equal(byName.index, 3);
  assert.equal(byName.speedBps, null);
  assert.equal(byName.utilization, null);

  // An explicit interface that does not exist does not fall back to the port.
  assert.equal(SnmpUI.linkLoad({ sourceNodeId: 'sw', sourcePortId: 'sw_p1', targetNodeId: 'host', snmpIfIndex: 99 }, docValue, data), null);
  // snmpNodeId restricts the endpoint.
  assert.equal(SnmpUI.linkLoad({ sourceNodeId: 'sw', targetNodeId: 'host', snmpIfIndex: 1, snmpNodeId: 'host' }, docValue, data), null);
  // Failed polls give no load.
  assert.equal(SnmpUI.linkLoad({ sourceNodeId: 'sw', targetNodeId: 'host', snmpIfIndex: 1 }, docValue, new Map([['sw', { id: 'sw', ok: false }]])), null);
});

test('load colors and widths grow with utilization', () => {
  assert.equal(SnmpUI.loadStyle(null), null);
  assert.deepEqual(SnmpUI.loadStyle(0.1), { color: '#22c55e', width: 3 });
  assert.deepEqual(SnmpUI.loadStyle(0.5), { color: '#eab308', width: 5 });
  assert.deepEqual(SnmpUI.loadStyle(2), { color: '#ef4444', width: 8 });
});

test('tooltip lists system info and busiest interfaces', () => {
  const text = SnmpUI.tooltip(sample);
  assert.match(text, /SNMP: core-sw/);
  assert.match(text, /Uptime: 1h 0m/);
  assert.match(text, /Interfaces: 2 up of 3/);
  assert.ok(text.indexOf('ge-0/0/0') < text.indexOf('uplink'));
  assert.equal(SnmpUI.tooltip({ id: 'x', ok: false, error: 'No SNMP response' }), 'SNMP: No SNMP response');
  const load = SnmpUI.linkLoad({ sourceNodeId: 'sw', targetNodeId: 'host', snmpIfIndex: 1 }, topology(), new Map([['sw', sample]]));
  assert.equal(SnmpUI.loadText(load, 'Core'), 'ge-0/0/0 on Core: in 700 Mb/s, out 100 Mb/s of 1.0 Gb/s (70%)');
});

test('admin fields edit SNMP settings and keep the community out of the marker', () => {
  const host = { id: 'a' };
  assert.equal(SnmpUI.applyAdminField(host, 'snmpEnabled', { checked: true }), true);
  assert.equal(SnmpUI.applyAdminField(host, 'snmpPort', { value: '70000' }), true);
  assert.deepEqual(host.snmp, { enabled: true, port: 161, version: '2c' });
  SnmpUI.applyAdminField(host, 'snmpCommunity', { value: 'private' });
  assert.equal(host.snmpCommunity, 'private');
  assert.equal(SnmpUI.applyAdminField(host, 'name', { value: 'x' }), false);
  const html = SnmpUI.adminCell(host, 0, (value) => String(value));
  assert.ok(!html.includes('private'));
  assert.match(html, /New community will be saved/);
  host.snmpSecret = { type: 'community' };
  SnmpUI.clearCommunity(host);
  assert.equal(host.snmpCommunityClear, true);
  assert.equal(host.snmpSecret, undefined);
  assert.equal(host.snmpCommunity, undefined);
});

test('accept ignores malformed events', () => {
  assert.equal(SnmpUI.accept(null), false);
  assert.equal(SnmpUI.accept({ ok: true }), false);
  assert.equal(SnmpUI.accept({ id: 'n1', ok: true, interfaces: [] }), true);
  assert.ok(SnmpUI._state.data.has('n1'));
});
