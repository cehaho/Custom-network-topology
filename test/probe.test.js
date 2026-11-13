'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Probe = require('../renderer/js/probe');
const Hosts = require('../lib/hosts');
const Topology = require('../renderer/js/topology');

test('stays unknown until two results agree', () => {
  let state = Probe.observe(null, true, 2);
  assert.equal(state.state, 'unknown');
  state = Probe.observe(state, false, 2);
  assert.equal(state.state, 'unknown');
  state = Probe.observe(state, false, 2);
  assert.equal(state.state, 'down');
});

test('one failure does not flip a confirmed state', () => {
  let state = Probe.observe(null, true, 2);
  state = Probe.observe(state, true, 2);
  assert.equal(state.state, 'up');
  state = Probe.observe(state, false, 1);
  assert.equal(state.state, 'up');
  assert.equal(state.streak, 1);
  state = Probe.observe(state, false, 2);
  assert.equal(state.state, 'down');
});

test('an ignored sample does not advance the streak', () => {
  let state = Probe.observe(null, true, 2);
  state = Probe.observe(state, null, 2);
  assert.equal(state.state, 'unknown');
  assert.equal(state.streak, 1);
  state = Probe.observe(state, true, 2);
  assert.equal(state.state, 'up');
});

test('the active link is the primary while that neighbor answers', () => {
  const doc = topology();
  const both = new Map([['gw', 'up'], ['backup', 'up'], ['pc', 'up']]);
  const active = Probe.activeLink(doc.links, 'pc', both);
  assert.equal(active.role, 'primary');
  assert.equal(active.sourceNodeId, 'gw');
  assert.equal(Probe.linkLook(active.role, true, 'up', 'up').animate, true);

  const standby = doc.links.find((link) => link.role === 'failover');
  const waiting = Probe.linkLook(standby.role, false, 'up', 'up');
  assert.equal(waiting.animate, false);
  assert.equal(waiting.waiting, true);
  assert.equal(waiting.color, Probe.COLOR_UP);
  assert.notEqual(waiting.color, '#fbbf24');
});

test('the active link moves to the failover only when its neighbor answers', () => {
  const doc = topology();
  const failed = new Map([['gw', 'down'], ['backup', 'up'], ['pc', 'up']]);
  const active = Probe.activeLink(doc.links, 'pc', failed);
  assert.equal(active.role, 'failover');
  assert.equal(active.sourceNodeId, 'backup');
  assert.equal(Probe.linkLook('failover', true, 'up', 'up').animate, true);

  const primary = doc.links.find((link) => link.role === 'primary');
  const down = Probe.linkLook(primary.role, false, 'down', 'up');
  assert.equal(down.animate, false);
  assert.equal(down.color, Probe.COLOR_DOWN);

  const neither = new Map([['gw', 'down'], ['backup', 'unknown']]);
  assert.equal(Probe.activeLink(doc.links, 'pc', neither).role, 'primary');
  const pending = new Map([['gw', 'unknown'], ['backup', 'up']]);
  assert.equal(Probe.activeLink(doc.links, 'pc', pending).role, 'failover');
});

test('an unknown path is not drawn as down and does not move', () => {
  const look = Probe.linkLook('primary', true, 'unknown', undefined);
  assert.equal(look.color, Probe.COLOR_UNKNOWN);
  assert.equal(look.animate, false);
  const dead = Probe.linkLook('primary', true, 'down', 'up');
  assert.equal(dead.animate, false);
});

test('a toast follows a confirmed change and stays quiet while a node flickers', () => {
  assert.equal(Probe.shouldToast(undefined, 'up', 1000, 0, Probe.TOAST_QUIET_MS), false);
  assert.equal(Probe.shouldToast('unknown', 'down', 1000, 0, Probe.TOAST_QUIET_MS), false);
  assert.equal(Probe.shouldToast('up', 'down', 20_000, 0, Probe.TOAST_QUIET_MS), true);
  assert.equal(Probe.shouldToast('up', 'down', 10_000, 1000, Probe.TOAST_QUIET_MS), false);
  assert.equal(Probe.shouldToast('down', 'up', 16_000, 1000, Probe.TOAST_QUIET_MS), true);
  assert.equal(Probe.shouldToast('up', 'up', 30_000, 0, Probe.TOAST_QUIET_MS), false);
});

test('the probe interval defaults to five seconds and stays adjustable', () => {
  assert.equal(Probe.PROBE_LIMIT, 20);
  assert.equal(Probe.monitoringInterval(undefined), 5000);
  assert.equal(Probe.monitoringInterval(50), 5000);
  assert.equal(Probe.monitoringInterval(2000), 2000);
  assert.equal(Probe.monitoringInterval(60000), 60000);
  assert.equal(Probe.confirmationCount(undefined), 2);
  assert.equal(Probe.confirmationCount(1), 2);
  assert.equal(Probe.confirmationCount(4), 4);
  for (const value of [undefined, 50, 2000, 5000, 60000, 'nope']) {
    assert.equal(Hosts.monitoringInterval(value), Probe.monitoringInterval(value));
    assert.equal(Hosts.confirmationCount(value), Probe.confirmationCount(value));
  }
});

function topology() {
  const doc = Topology.read({
    nodes: [
      { id: 'gw', name: 'gw' },
      { id: 'backup', name: 'backup' },
      { id: 'pc', name: 'pc' }
    ]
  }).document;
  Topology.setParent(doc, 'pc', 'primary', 'gw');
  Topology.setParent(doc, 'pc', 'failover', 'backup');
  return doc;
}
