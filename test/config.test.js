'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('sample topology is the object shape the app loads', () => {
  const file = path.join(__dirname, '..', 'renderer', 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));

  assert.equal(typeof config.settings, 'object');
  assert.equal(Array.isArray(config.nodes), true);
  assert.equal(config.nodes.length, 4);
  assert.equal(config.nodes.some((node) => node.sshPass), false);

  const ids = new Set(config.nodes.map((node) => node.id));
  assert.equal(ids.size, config.nodes.length);
  for (const node of config.nodes) {
    if (node.primaryParentId) assert.equal(ids.has(node.primaryParentId), true);
    if (node.secondaryParentId) assert.equal(ids.has(node.secondaryParentId), true);
  }
});
