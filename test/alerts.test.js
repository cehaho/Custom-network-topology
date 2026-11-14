const test = require('node:test');
const assert = require('node:assert/strict');
const Alerts = require('../renderer/js/alerts.js');
const Topology = require('../renderer/js/topology.js');

const B = Alerts.BURST_WINDOW_MS;

function node(id, status, extra) {
  return Object.assign({ id: id, name: id.toUpperCase(), address: '10.0.0.' + id.length, status: status }, extra);
}

function step(state, nodes, now, settings) {
  Alerts.observe(state, nodes, now, settings);
  return Alerts.flush(state, now, settings);
}

test('first confirmed state and unknown are never announced', () => {
  const state = Alerts.createState();
  assert.deepEqual(step(state, [node('a', 'unknown')], 0), []);
  assert.deepEqual(step(state, [node('a', 'up')], 1000), []);
  assert.equal(Alerts.nextDue(state), null);
  assert.deepEqual(step(state, [node('a', 'unknown')], 2000), []);
  assert.deepEqual(step(state, [node('a', 'up')], 10000), []);
  assert.equal(Alerts.nextDue(state), null);
});

test('up to down is announced with name and address after the burst window', () => {
  const state = Alerts.createState();
  step(state, [node('nas', 'up', { address: '192.168.1.5' })], 0);
  assert.deepEqual(step(state, [node('nas', 'down', { address: '192.168.1.5' })], 1000), []);
  assert.equal(Alerts.nextDue(state), 1000 + B);
  const out = Alerts.flush(state, 1000 + B);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'down');
  assert.equal(out[0].title, 'NAS is down');
  assert.match(out[0].body, /192\.168\.1\.5/);
  assert.deepEqual(Alerts.flush(state, 1000 + B + 1), []);
});

test('a flip that reverts inside the burst window is dropped', () => {
  const state = Alerts.createState();
  step(state, [node('a', 'up')], 0);
  step(state, [node('a', 'down')], 1000);
  step(state, [node('a', 'up')], 2000);
  assert.equal(Alerts.nextDue(state), null);
  assert.deepEqual(Alerts.flush(state, 10000), []);
});

test('cooldown holds the next notification and still reports the final state', () => {
  const state = Alerts.createState();
  const settings = { alertCooldownMs: 60000 };
  step(state, [node('a', 'up')], 0, settings);
  step(state, [node('a', 'down')], 0, settings);
  assert.equal(Alerts.flush(state, B, settings)[0].kind, 'down');
  step(state, [node('a', 'up')], 10000, settings);
  assert.deepEqual(Alerts.flush(state, 10000 + B, settings), []);
  assert.equal(Alerts.nextDue(state, settings), B + 60000);
  const later = Alerts.flush(state, B + 60000, settings);
  assert.equal(later.length, 1);
  assert.equal(later[0].title, 'A is back up');
});

test('a down-up-down sequence inside the cooldown is not announced again', () => {
  const state = Alerts.createState();
  step(state, [node('a', 'up')], 0);
  step(state, [node('a', 'down')], 0);
  assert.equal(Alerts.flush(state, B).length, 1);
  step(state, [node('a', 'up')], 10000);
  step(state, [node('a', 'down')], 20000);
  assert.equal(Alerts.nextDue(state), null);
});

test('more than five changes in a burst become one summary', () => {
  const state = Alerts.createState();
  const ids = ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff', 'ggggggg'];
  step(state, ids.map((id) => node(id, 'up')), 0);
  step(state, ids.slice(0, 4).map((id) => node(id, 'down')).concat(ids.slice(4).map((id) => node(id, 'up'))), 1000);
  step(state, ids.map((id) => node(id, 'down')), 2500);
  assert.deepEqual(Alerts.flush(state, 1000 + B), [], 'the second change pushes the batch back');
  const out = Alerts.flush(state, 2500 + B);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'summary');
  assert.equal(out[0].title, '7 nodes changed state');
  assert.match(out[0].body, /^7 down: A, BB, CCC, DDDD, EEEEE, \+2 more$/);
});

test('five changes stay individual', () => {
  const state = Alerts.createState();
  const ids = ['a', 'b', 'c', 'd', 'e'];
  step(state, ids.map((id) => node(id, 'down')), 0);
  step(state, ids.map((id) => node(id, 'up')), 0);
  const out = Alerts.flush(state, B);
  assert.equal(out.length, 5);
  assert.ok(out.every((item) => item.kind === 'up'));
});

test('a long burst is capped by MAX_DELAY_MS', () => {
  const state = Alerts.createState();
  step(state, [node('a', 'up'), node('b', 'up')], 0);
  step(state, [node('a', 'down'), node('b', 'up')], 0);
  let now = 0;
  let status = 'up';
  while (now < Alerts.MAX_DELAY_MS) {
    now += 1000;
    status = status === 'up' ? 'down' : 'up';
    Alerts.observe(state, [node('a', 'down'), node('b', status)], now);
  }
  const out = Alerts.flush(state, Alerts.MAX_DELAY_MS);
  assert.ok(out.some((item) => item.title === 'A is down'));
});

test('disabled alerts announce nothing and do not replay later', () => {
  const state = Alerts.createState();
  const off = { alertsEnabled: false };
  step(state, [node('a', 'up')], 0, off);
  step(state, [node('a', 'down')], 1000, off);
  assert.deepEqual(Alerts.flush(state, 100000, off), []);
  assert.equal(Alerts.nextDue(state, off), null);
  assert.deepEqual(step(state, [node('a', 'down')], 200000, {}), []);
  assert.equal(Alerts.nextDue(state, {}), null);
});

test('nodes missing from a report are forgotten', () => {
  const state = Alerts.createState();
  step(state, [node('a', 'up')], 0);
  step(state, [node('a', 'down')], 0);
  step(state, [], 1000);
  assert.deepEqual(Alerts.flush(state, 10000), []);
  assert.deepEqual(step(state, [node('a', 'down')], 20000), [], 'a returning node starts from a new baseline');
});

test('settings default and clamp', () => {
  assert.deepEqual(Alerts.readSettings(undefined), { enabled: true, cooldownMs: 60000 });
  assert.deepEqual(Alerts.readSettings({ alertsEnabled: false, alertCooldownMs: 120000 }), { enabled: false, cooldownMs: 120000 });
  assert.equal(Alerts.cooldown(100), 60000);
  assert.equal(Alerts.cooldown(7200000), 60000);
  assert.equal(Alerts.cooldown('30000'), 30000);
});

test('topology documents without alert settings get the defaults', () => {
  const prepared = Topology.prepare({ nodes: [{ id: 'a' }], settings: { showGrid: false } });
  assert.equal(prepared.document.settings.alertsEnabled, true);
  assert.equal(prepared.document.settings.alertCooldownMs, 60000);
  const kept = Topology.prepare({ nodes: [{ id: 'a' }], settings: { alertsEnabled: false, alertCooldownMs: 300000 } });
  assert.equal(kept.document.settings.alertsEnabled, false);
  assert.equal(kept.document.settings.alertCooldownMs, 300000);
  const clamped = Topology.prepare({ nodes: [{ id: 'a' }], settings: { alertCooldownMs: 1 } });
  assert.equal(clamped.document.settings.alertCooldownMs, 60000);
});
