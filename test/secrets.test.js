'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Topology = require('../renderer/js/topology.js');

test('a node secret is a type marker, and the value stays out of an export', () => {
  const document = {
    schemaVersion: 1,
    settings: { showGrid: true, gridSize: 100, snapToGrid: true, theme: 'dark' },
    nodes: [
      {
        id: 'node_a',
        name: 'A',
        sshPass: 's3cret',
        _encrypted: true,
        sshSecret: { type: 'password', value: 's3cret' }
      },
      {
        id: 'node_b',
        name: 'B',
        sshAuth: 'key',
        sshPassphrase: 'phrase'
      }
    ],
    links: [],
    ports: []
  };

  assert.equal(Topology.hasSecretValues(document), true);
  const exported = Topology.withoutSecretValues(document);
  const body = JSON.stringify(exported);
  assert.equal(body.includes('s3cret'), false);
  assert.equal(body.includes('phrase'), false);
  assert.equal(body.includes('_encrypted'), false);
  assert.equal(exported.nodes[0].sshSecret.type, 'password');
  assert.equal(exported.nodes[0].sshSecret.value, undefined);
  assert.equal(exported.nodes[1].sshPassphrase, undefined);
  assert.equal(document.nodes[0].sshPass, 's3cret');
});

test('an empty password field does not clear a saved secret', () => {
  const node = { id: 'node_a', sshSecret: { type: 'password' } };
  Topology.acceptSecretEdit(node, '');
  assert.equal(node.sshSecret.type, 'password');
  assert.equal(node.sshPass, undefined);
  assert.equal(Topology.secretHint(node), 'Secret saved');

  Topology.acceptSecretEdit(node, 'next');
  assert.equal(node.sshPass, 'next');
  assert.equal(Topology.secretHint(node), 'New secret will be saved');
  assert.equal(node.sshSecretClear, undefined);
});

test('clearing a secret is explicit', () => {
  const node = { id: 'node_a', sshPass: 'typed', sshSecret: { type: 'password' } };
  Topology.clearStoredSecret(node);
  assert.equal(node.sshPass, undefined);
  assert.equal(node.sshSecret, undefined);
  assert.equal(node.sshSecretClear, true);
  assert.equal(Topology.secretHint(node), 'Secret will be removed');
});

test('a duplicated node does not inherit the secret marker', () => {
  const copy = {
    id: 'node_copy',
    sshPass: 's3cret',
    sshSecret: { type: 'passphrase' },
    sshKeyPath: '/home/user/.ssh/id_ed25519'
  };
  Topology.forgetInheritedSecret(copy);
  assert.equal(copy.sshPass, undefined);
  assert.equal(copy.sshSecret, undefined);
  assert.equal(copy.sshKeyPath, '/home/user/.ssh/id_ed25519');
});

test('new nodes are created without a password', () => {
  const node = Topology.createNode({ name: 'Lab' });
  assert.equal(node.sshPass, undefined);
  assert.equal(node.sshPassphrase, undefined);
  assert.equal(node.sshSecret, undefined);
  assert.equal(node.sshAuth, 'password');
});

test('reading a topology keeps a typed password available for the save that stores it', () => {
  const loaded = Topology.read({
    nodes: [{ id: 'node_a', name: 'A', sshPass: 's3cret', sshSecret: { type: 'password' } }]
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.document.nodes[0].sshPass, 's3cret');
  assert.equal(loaded.document.nodes[0].sshSecret.type, 'password');
});
