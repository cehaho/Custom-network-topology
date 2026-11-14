'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const History = require('../renderer/js/history');

function samples(list) {
  return list.map((rtt, index) => ({ at: index * 1000, ok: rtt !== null, rtt }));
}

test('the ring buffer keeps the last samples only', () => {
  const buffer = History.createBuffer(3);
  for (let index = 0; index < 5; index += 1) {
    History.push(buffer, { at: index, ok: true, rtt: index });
  }
  assert.deepEqual(buffer.samples.map((s) => s.rtt), [2, 3, 4]);
  assert.equal(History.createBuffer().size, History.HISTORY_SIZE);
  assert.equal(History.HISTORY_SIZE, 120);
});

test('a failed sample carries no latency, an invalid one is ignored', () => {
  const buffer = History.createBuffer(5);
  History.push(buffer, { at: 1, ok: false, rtt: 12 });
  History.push(buffer, { at: 2, ok: 'yes', rtt: 12 });
  History.push(buffer, { at: 3, ok: true, rtt: -4 });
  History.push(buffer, { at: 4, ok: true, rtt: 'abc' });
  assert.deepEqual(buffer.samples, [
    { at: 1, ok: false, rtt: null },
    { at: 3, ok: true, rtt: null },
    { at: 4, ok: true, rtt: null }
  ]);
});

test('stats give min, avg, max and availability over the buffer', () => {
  const result = History.stats(samples([10, null, 20, 30, null]));
  assert.equal(result.count, 5);
  assert.equal(result.up, 3);
  assert.equal(result.down, 2);
  assert.equal(result.availability, 60);
  assert.equal(result.min, 10);
  assert.equal(result.avg, 20);
  assert.equal(result.max, 30);
  assert.equal(result.current, null);
  assert.equal(result.lastOk, false);

  const healthy = History.stats(samples([4, 2.5]));
  assert.equal(healthy.current, 2.5);
  assert.equal(healthy.availability, 100);

  const empty = History.stats([]);
  assert.equal(empty.availability, null);
  assert.equal(empty.avg, null);
});

test('a monitor event becomes a sample from the raw result', () => {
  assert.deepEqual(
    History.sampleFromStatus({ id: 'a', status: 'up', reachable: true, rtt: 1.234, responseTime: 1 }, 5),
    { at: 5, ok: true, rtt: 1.234 }
  );
  // Confirmed up, but this probe failed: the raw result wins.
  assert.deepEqual(
    History.sampleFromStatus({ id: 'a', status: 'up', reachable: false, rtt: null, responseTime: 2000 }, 5),
    { at: 5, ok: false, rtt: null }
  );
  // An older event without `reachable` or `rtt` falls back to status and responseTime.
  assert.deepEqual(History.sampleFromStatus({ id: 'a', status: 'up', responseTime: 7 }, 5), { at: 5, ok: true, rtt: 7 });
  assert.equal(History.sampleFromStatus({ id: 'a', status: 'unknown', reachable: null }, 5), null);
});

test('the store seeds from saved history once, then records live samples', () => {
  const store = History.createStore(4);
  store.record({
    nodes: [
      {
        id: 'pc',
        status: 'up',
        reachable: true,
        rtt: 3,
        history: [
          { at: '2026-11-13T18:00:00Z', status: 'up', responseTime: 5 },
          { at: '2026-11-13T18:00:05Z', status: 'down', responseTime: 2000 },
          { at: 'bad', status: 'up', responseTime: 1 },
          { at: '2026-11-13T18:00:10Z', status: 'up', responseTime: 3 }
        ]
      },
      { id: 'unprobed', status: 'unknown', reachable: null, history: [] }
    ]
  }, Date.parse('2026-11-13T18:00:11Z'));
  assert.deepEqual(store.samples('pc').map((s) => [s.ok, s.rtt]), [[true, 5], [false, null], [true, 3]]);
  assert.deepEqual(store.samples('unprobed'), []);

  store.record({ nodes: [{ id: 'pc', status: 'up', reachable: true, rtt: 8, history: [] }] }, 20);
  store.record({ nodes: [{ id: 'pc', status: 'up', reachable: true, rtt: 9, history: [] }] }, 30);
  assert.deepEqual(store.samples('pc').map((s) => s.rtt), [null, 3, 8, 9]);
  assert.equal(store.stats('pc').availability, 75);

  // A node no longer reported is forgotten.
  store.record({ nodes: [{ id: 'other', status: 'down', reachable: false }] }, 40);
  assert.deepEqual(store.samples('pc'), []);
  assert.equal(store.samples('other').length, 1);
});

test('the sparkline breaks at failures and ends at the right edge', () => {
  const line = History.sparkline(samples([10, 20, null, 5]), { width: 100, height: 20, padding: 0, size: 4 });
  // Two segments: x 0 to 33.3, then a lone point at x 100.
  assert.equal(line.path, 'M0 10 L33.3 0 M100 15 L100 15');
  assert.deepEqual(line.failures, [66.7]);
  assert.equal(line.max, 20);

  // A short buffer is drawn against the full width, aligned on the right.
  const short = History.sparkline(samples([10, 10]), { width: 100, height: 20, padding: 0, size: 5 });
  assert.equal(short.path, 'M75 0 L100 0');

  const none = History.sparkline([], { width: 100, height: 20 });
  assert.equal(none.path, '');
});

test('the sparkline svg holds the path and failure marks', () => {
  const svg = History.sparklineSvg(samples([10, null, 12]), { width: 60, height: 20, size: 3 });
  assert.match(svg, /^<svg /);
  assert.match(svg, /<path d="M/);
  assert.equal((svg.match(/<line /g) || []).length, 1);
  assert.doesNotMatch(History.sparklineSvg([]), /<path/);
});

test('latency and percentages are formatted for the tooltip', () => {
  assert.equal(History.formatMs(0.5), '<1 ms');
  assert.equal(History.formatMs(3.456), '3.5 ms');
  assert.equal(History.formatMs(42.6), '43 ms');
  assert.equal(History.formatMs(null), '—');
  assert.equal(History.formatPercent(100), '100%');
  assert.equal(History.formatPercent(66.6667), '66.7%');
  assert.equal(History.formatPercent(null), '—');
});
