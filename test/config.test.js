'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Topology = require('../renderer/js/topology.js');

test('sample topology is the object shape the app loads', () => {
  const file = path.join(__dirname, '..', 'renderer', 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const loaded = Topology.read(config);

  assert.equal(loaded.ok, true);
  assert.equal(loaded.changed, false);
  assert.equal(config.schemaVersion, 1);
  assert.deepEqual(Object.keys(config), ['schemaVersion', 'settings', 'nodes', 'links', 'ports']);
  assert.equal(Array.isArray(config.nodes), true);
  assert.equal(Array.isArray(config.links), true);
  assert.equal(Array.isArray(config.ports), true);
  assert.equal(config.nodes.length, 4);
  assert.equal(config.links.length, 3);
  assert.equal(config.nodes.some((node) => node.sshPass), false);
  assert.equal(config.nodes.some((node) => Object.prototype.hasOwnProperty.call(node, 'primaryParentId')), false);

  const ids = new Set(config.nodes.map((node) => node.id));
  assert.equal(ids.size, config.nodes.length);
  config.links.forEach((link) => {
    assert.equal(ids.has(link.sourceNodeId), true);
    assert.equal(ids.has(link.targetNodeId), true);
  });
  config.nodes.forEach((node) => {
    assert.ok(node.ports.length > 0);
  });
});
