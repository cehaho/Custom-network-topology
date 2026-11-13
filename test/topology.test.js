'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Topology = require('../renderer/js/topology.js');

const legacy = {
  settings: { showGrid: true, gridSize: 100 },
  nodes: [
    {
      id: 'node_gateway',
      name: 'Gateway Router',
      address: '192.168.1.1',
      primaryParentId: null,
      secondaryParentId: null,
      icon: 'router',
      iconType: 'lucide',
      x: 50,
      y: 85
    },
    {
      id: 'node_nas',
      name: 'NAS Storage',
      address: '192.168.1.100',
      primaryParentId: 'node_gateway',
      secondaryParentId: 'node_gateway',
      linkType: 'RJ45',
      linkSpeed: '1G',
      icon: 'hard-drive',
      iconType: 'lucide',
      x: 30,
      y: 50,
      isContainer: true,
      containerType: 'proxmox',
      zones: [{ id: 'zone_lan', name: 'LAN', color: '#3b82f6' }],
      expanded: false,
      ports: [{ id: 'node_nas_wan', name: 'WAN', side: 'top' }]
    }
  ],
  connections: [
    {
      id: 'mouse_1',
      sourceNodeId: 'node_gateway',
      sourcePortId: 'node_gateway_out',
      targetNodeId: 'node_nas',
      targetPortId: 'node_nas_wan',
      isFailover: false,
      linkType: 'Fiber',
      linkSpeed: '10G'
    }
  ]
};

test('legacy parents become stable links and leave the node', () => {
  const first = Topology.read(legacy);
  assert.equal(first.ok, true);
  assert.equal(first.changed, true);

  const nas = first.document.nodes.find((node) => node.id === 'node_nas');
  assert.equal(nas.primaryParentId, undefined);
  assert.equal(nas.secondaryParentId, undefined);
  assert.equal(nas.linkType, undefined);
  assert.equal(nas.isContainer, true);
  assert.equal(nas.containerType, 'proxmox');
  assert.equal(nas.expanded, false);
  assert.deepEqual(nas.zones, [{ id: 'zone_lan', name: 'LAN', color: '#3b82f6' }]);
  assert.equal(nas.ports[0].id, 'node_nas_wan');

  const mouse = first.document.links.find((link) => link.id === 'mouse_1');
  assert.ok(mouse);
  assert.equal(mouse.role, 'primary');
  assert.equal(mouse.medium, 'Fiber');
  assert.equal(mouse.speed, '10G');
  assert.equal(mouse.isFailover, undefined);

  const failover = first.document.links.find((link) => link.role === 'failover');
  assert.equal(failover.id, 'link_node_nas_failover');
  assert.equal(failover.sourceNodeId, 'node_gateway');
  assert.equal(failover.targetNodeId, 'node_nas');

  assert.equal(first.document.schemaVersion, 1);
  assert.ok(Array.isArray(first.document.ports));
  assert.ok(first.document.ports.some((port) => port.id === 'node_nas_wan' && port.nodeId === 'node_nas'));

  const second = Topology.read(first.document);
  assert.equal(second.changed, false);
  assert.equal(second.document.links.find((link) => link.role === 'failover').id, failover.id);
  assert.deepEqual(second.document, first.document);
});

test('a save keeps links, ports, containers, and zones', () => {
  const prepared = Topology.prepare({
    schemaVersion: 1,
    settings: { showGrid: false, theme: 'light', probeIntervalMs: 5000 },
    nodes: [
      {
        id: 'hv',
        name: 'pve',
        address: '10.0.0.2',
        status: true,
        uptime: '3m',
        activeParentId: 'gw',
        level: 2,
        responseTime: 4,
        isContainer: true,
        zones: [{ id: 'z1', name: 'vlan10' }],
        ports: [{ id: 'hv_in', name: 'IN', side: 'top' }],
        containerId: null
      },
      {
        id: 'vm',
        name: 'vm',
        address: '10.0.0.3',
        containerId: 'hv',
        zoneId: 'z1',
        ports: [{ id: 'vm_in', name: 'IN', side: 'left', vlan: 10 }]
      }
    ],
    links: [
      {
        id: 'kept',
        sourceNodeId: 'hv',
        sourcePortId: 'hv_in',
        targetNodeId: 'vm',
        targetPortId: 'vm_in',
        role: 'primary',
        medium: 'DAC',
        speed: '25G',
        note: 'drawn'
      }
    ],
    unexpected: true
  });

  assert.equal(prepared.ok, true);
  assert.equal(prepared.document.unexpected, undefined);
  assert.equal(prepared.document.settings.showGrid, false);
  assert.equal(prepared.document.settings.theme, 'light');
  assert.equal(prepared.document.settings.probeIntervalMs, 5000);
  assert.equal(prepared.document.settings.confirmations, 2);
  assert.equal(prepared.document.settings.snapToGrid, true);
  assert.equal(prepared.document.links.length, 1);
  assert.equal(prepared.document.links[0].id, 'kept');
  assert.equal(prepared.document.links[0].note, 'drawn');
  const hv = prepared.document.nodes[0];
  const vm = prepared.document.nodes[1];
  assert.equal(hv.status, undefined);
  assert.equal(hv.activeParentId, undefined);
  assert.equal(hv.isContainer, true);
  assert.deepEqual(hv.zones, [{ id: 'z1', name: 'vlan10' }]);
  assert.equal(hv.ports[0].id, 'hv_in');
  assert.equal(vm.containerId, 'hv');
  assert.equal(vm.zoneId, 'z1');
  assert.equal(vm.ports[0].vlan, 10);
  assert.ok(prepared.document.ports.some((port) => port.id === 'vm_in' && port.nodeId === 'vm' && port.vlan === 10));
});

test('refuses a file without nodes and an unknown version', () => {
  assert.equal(Topology.read({ settings: {} }).ok, false);
  assert.match(Topology.read({ settings: {} }).error, /no nodes/);
  assert.equal(Topology.read({ schemaVersion: 2, nodes: [] }).ok, false);
  assert.equal(Topology.read({ nodes: [] }).ok, true);
  assert.equal(Topology.read([]).ok, true);
  assert.equal(Topology.read({ nodes: 'nope' }).ok, false);
});

test('parent edits write links and do not put parent ids back', () => {
  const loaded = Topology.read({
    nodes: [
      { id: 'gw', name: 'gw' },
      { id: 'pc', name: 'pc', primaryParentId: 'gw' }
    ]
  });
  const doc = loaded.document;
  Topology.setParent(doc, 'pc', 'primary', null);
  assert.equal(Topology.parentNodeId(doc, 'pc', 'primary'), null);
  Topology.setParent(doc, 'pc', 'failover', 'gw');
  Topology.setCable(doc, 'pc', 'WiFi', '100M');
  const saved = Topology.prepare(doc);
  const pc = saved.document.nodes.find((node) => node.id === 'pc');
  assert.equal(pc.primaryParentId, undefined);
  assert.equal(pc.secondaryParentId, undefined);
  assert.equal(saved.document.links.some((link) => link.role === 'primary' && link.targetNodeId === 'pc'), false);
  const failover = saved.document.links.find((link) => link.role === 'failover');
  assert.equal(failover.sourceNodeId, 'gw');
  assert.equal(failover.id, 'link_pc_failover');
  const again = Topology.prepare(saved.document);
  assert.equal(again.document.links.find((link) => link.role === 'failover').id, 'link_pc_failover');
});

test('migrated links attach to ports that exist on the nodes', () => {
  const loaded = Topology.read({
    nodes: [
      { id: 'gw', ports: [{ id: 'gw_in', name: 'IN', side: 'top' }] },
      { id: 'pc', primaryParentId: 'gw', secondaryParentId: 'gw' }
    ]
  });
  assert.equal(loaded.ok, true);
  assert.ok(loaded.document.links.length >= 2);
  for (const link of loaded.document.links) {
    const source = loaded.document.nodes.find((node) => node.id === link.sourceNodeId);
    const target = loaded.document.nodes.find((node) => node.id === link.targetNodeId);
    assert.ok(source.ports.some((port) => port.id === link.sourcePortId));
    assert.ok(target.ports.some((port) => port.id === link.targetPortId));
  }
  const again = Topology.read(loaded.document);
  assert.equal(again.changed, false);
});

test('probe settings fall back to five seconds and two confirmations', () => {
  const prepared = Topology.prepare({
    nodes: [],
    settings: { probeIntervalMs: 50, confirmations: 1 }
  });
  assert.equal(prepared.document.settings.probeIntervalMs, 5000);
  assert.equal(prepared.document.settings.confirmations, 2);
  const kept = Topology.prepare({
    nodes: [],
    settings: { probeIntervalMs: 2000, confirmations: 4 }
  });
  assert.equal(kept.document.settings.probeIntervalMs, 2000);
  assert.equal(kept.document.settings.confirmations, 4);
});

test('the sample file is the shared document', () => {
  const file = path.join(__dirname, '..', 'renderer', 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const loaded = Topology.read(config);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.changed, false);
  assert.equal(loaded.document.schemaVersion, 1);
  assert.equal(loaded.document.nodes.length, 4);
  assert.equal(loaded.document.links.length, 3);
  assert.equal(loaded.document.nodes.some((node) => node.sshPass), false);
  assert.equal(loaded.document.nodes.some((node) => node.primaryParentId), false);
  loaded.document.links.forEach((link) => {
    assert.equal(link.role, 'primary');
    assert.equal(typeof link.id, 'string');
  });
});
