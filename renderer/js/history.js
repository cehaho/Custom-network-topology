// Per-node latency history: a bounded ring buffer of probe results, the
// statistics shown on hover, and the sparkline path.
//
// Pure logic, no DOM: the hover tooltip lives in app/latency-ui.js. A sample is
// { at: epoch ms, ok: boolean, rtt: ms or null }. A failed probe keeps its
// place in the buffer so the sparkline shows a gap and availability counts it.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LatencyHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HISTORY_SIZE = 120;

  function clampSize(size) {
    const value = Math.floor(Number(size));
    return Number.isFinite(value) && value >= 1 && value <= 10000 ? value : HISTORY_SIZE;
  }

  function cleanRtt(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function cleanTime(value, fallback) {
    const time = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(time) ? time : fallback;
  }

  function normalizeSample(sample, fallbackTime) {
    if (!sample || typeof sample.ok !== 'boolean') return null;
    return {
      at: cleanTime(sample.at, fallbackTime == null ? Date.now() : fallbackTime),
      ok: sample.ok,
      rtt: sample.ok ? cleanRtt(sample.rtt) : null
    };
  }

  function createBuffer(size) {
    return { size: clampSize(size), samples: [] };
  }

  // Appends a sample and drops the oldest beyond the buffer size.
  function push(buffer, sample, fallbackTime) {
    const clean = normalizeSample(sample, fallbackTime);
    if (!buffer || !clean) return buffer;
    buffer.samples.push(clean);
    if (buffer.samples.length > buffer.size) {
      buffer.samples.splice(0, buffer.samples.length - buffer.size);
    }
    return buffer;
  }

  // One node of a `monitor-status` event as a sample. `reachable` is the raw
  // result of this probe; an older event without it falls back to the
  // confirmed status. A node that was not probed (`unknown`) gives null.
  function sampleFromStatus(entry, now) {
    if (!entry) return null;
    let ok;
    if (typeof entry.reachable === 'boolean') ok = entry.reachable;
    else if (entry.status === 'up' || entry.status === 'online') ok = true;
    else if (entry.status === 'down' || entry.status === 'offline') ok = false;
    else return null;
    const rtt = cleanRtt(entry.rtt) != null ? cleanRtt(entry.rtt) : cleanRtt(entry.responseTime);
    return normalizeSample({ at: now, ok: ok, rtt: ok ? rtt : null }, now);
  }

  // Samples from the history saved in status.json ({ at, status, responseTime }).
  function samplesFromHistory(entries) {
    if (!Array.isArray(entries)) return [];
    const samples = [];
    entries.forEach((entry) => {
      if (!entry) return;
      const status = entry.status;
      if (status !== 'up' && status !== 'down') return;
      const at = cleanTime(entry.at || entry.time, NaN);
      if (!Number.isFinite(at)) return;
      const ok = status === 'up';
      samples.push({ at: at, ok: ok, rtt: ok ? cleanRtt(entry.responseTime) : null });
    });
    return samples;
  }

  function stats(samples) {
    const list = Array.isArray(samples) ? samples : [];
    let up = 0;
    let min = null;
    let max = null;
    let sum = 0;
    let timed = 0;
    list.forEach((sample) => {
      if (!sample.ok) return;
      up += 1;
      if (sample.rtt == null) return;
      timed += 1;
      sum += sample.rtt;
      if (min == null || sample.rtt < min) min = sample.rtt;
      if (max == null || sample.rtt > max) max = sample.rtt;
    });
    const last = list.length ? list[list.length - 1] : null;
    return {
      count: list.length,
      up: up,
      down: list.length - up,
      availability: list.length ? (up / list.length) * 100 : null,
      current: last && last.ok ? last.rtt : null,
      lastOk: last ? last.ok : null,
      min: min,
      avg: timed ? sum / timed : null,
      max: max
    };
  }

  function round(value) {
    return Math.round(value * 10) / 10;
  }

  // SVG path for the latency line over `size` slots, oldest on the left and
  // the newest at the right edge. A failed sample breaks the line: the next
  // success starts a new `M` segment. A lone point between two failures is a
  // zero-length segment, visible with a round line cap. `failures` lists the
  // x of each failed sample, for a marker. The y scale starts at 0.
  function sparkline(samples, options) {
    const opts = options || {};
    const width = Number(opts.width) > 0 ? Number(opts.width) : 120;
    const height = Number(opts.height) > 0 ? Number(opts.height) : 28;
    const pad = Number(opts.padding) >= 0 ? Number(opts.padding) : 2;
    const list = Array.isArray(samples) ? samples : [];
    const size = Math.max(clampSize(opts.size || list.length || 1), list.length);
    const values = list.filter((s) => s.ok && s.rtt != null).map((s) => s.rtt);
    const top = values.length ? Math.max.apply(null, values) : 0;
    const scale = top > 0 ? top : 1;
    const step = size > 1 ? (width - pad * 2) / (size - 1) : 0;
    const offset = size - list.length;
    const segments = [];
    const failures = [];
    let current = null;
    list.forEach((sample, index) => {
      const x = round(pad + (offset + index) * step);
      if (!sample.ok || sample.rtt == null) {
        if (!sample.ok) failures.push(x);
        current = null;
        return;
      }
      const y = round(height - pad - (sample.rtt / scale) * (height - pad * 2));
      if (!current) {
        current = [];
        segments.push(current);
      }
      current.push(x + ' ' + y);
    });
    const path = segments
      .map((points) => {
        const rest = points.length > 1 ? points.slice(1) : points;
        return 'M' + points[0] + ' ' + rest.map((point) => 'L' + point).join(' ');
      })
      .join(' ');
    return { path: path, failures: failures, max: top, width: width, height: height };
  }

  function sparklineSvg(samples, options) {
    const opts = options || {};
    const line = sparkline(samples, opts);
    const stroke = opts.stroke || '#38bdf8';
    const fail = opts.failColor || '#ef4444';
    const marks = line.failures
      .map((x) => `<line x1="${x}" y1="${line.height - 4}" x2="${x}" y2="${line.height}" stroke="${fail}" stroke-width="1.5"/>`)
      .join('');
    const path = line.path
      ? `<path d="${line.path}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`
      : '';
    return `<svg class="latency-sparkline" xmlns="http://www.w3.org/2000/svg" width="${line.width}" height="${line.height}" viewBox="0 0 ${line.width} ${line.height}" role="img" aria-label="Latency history">${path}${marks}</svg>`;
  }

  function formatMs(value) {
    if (value == null || !Number.isFinite(value)) return '—';
    if (value < 1) return '<1 ms';
    if (value < 10) return value.toFixed(1) + ' ms';
    return Math.round(value) + ' ms';
  }

  function formatPercent(value) {
    if (value == null || !Number.isFinite(value)) return '—';
    if (value === 100 || value === 0) return value + '%';
    return value.toFixed(1) + '%';
  }

  // One buffer per node id. `record` takes a whole `monitor-status` event.
  // A buffer that is still empty is seeded from the saved history first, so a
  // restart does not start from nothing. A node no longer reported is dropped.
  function createStore(size) {
    const bufferSize = clampSize(size);
    const buffers = new Map();

    function bufferFor(id) {
      let buffer = buffers.get(id);
      if (!buffer) {
        buffer = createBuffer(bufferSize);
        buffers.set(id, buffer);
      }
      return buffer;
    }

    function record(event, now) {
      if (!event || !Array.isArray(event.nodes)) return;
      const time = now == null ? Date.now() : now;
      const seen = new Set();
      event.nodes.forEach((entry) => {
        if (!entry || typeof entry.id !== 'string' || !entry.id) return;
        seen.add(entry.id);
        const fresh = !buffers.has(entry.id);
        const sample = sampleFromStatus(entry, time);
        if (!sample && fresh) return;
        const buffer = bufferFor(entry.id);
        // The saved history already ends with this cycle when the state was
        // confirmed, so the live sample is only added when nothing was seeded.
        const saved = fresh ? samplesFromHistory(entry.history) : [];
        saved.forEach((item) => push(buffer, item));
        if (sample && !saved.length) push(buffer, sample);
      });
      Array.from(buffers.keys()).forEach((id) => {
        if (!seen.has(id)) buffers.delete(id);
      });
    }

    return {
      size: bufferSize,
      record: record,
      samples: (id) => (buffers.has(id) ? buffers.get(id).samples.slice() : []),
      stats: (id) => stats(buffers.has(id) ? buffers.get(id).samples : []),
      clear: () => buffers.clear()
    };
  }

  return {
    HISTORY_SIZE: HISTORY_SIZE,
    createBuffer: createBuffer,
    push: push,
    sampleFromStatus: sampleFromStatus,
    samplesFromHistory: samplesFromHistory,
    stats: stats,
    sparkline: sparkline,
    sparklineSvg: sparklineSvg,
    formatMs: formatMs,
    formatPercent: formatPercent,
    createStore: createStore
  };
});
