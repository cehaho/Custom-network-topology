'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ProbeChecks = require('../renderer/js/probe-checks.js');
const Topology = require('../renderer/js/topology.js');

// The same cases run in src-tauri/src/probe_kinds.rs.
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'probe-checks.json'), 'utf8'));

test('shared probe fixture gives the same result as the Rust reader', () => {
  cases.forEach((item) => {
    const result = ProbeChecks.normalize(item.probe);
    if (item.error) {
      assert.deepEqual(result, { ok: false, error: item.error }, JSON.stringify(item.probe));
    } else {
      assert.equal(result.ok, true, JSON.stringify(item.probe) + ' ' + result.error);
      assert.deepEqual(result.probe, item.result);
    }
  });
});

test('a node without probe keeps the default and the legacy port', () => {
  const loaded = Topology.read({
    schemaVersion: 1,
    nodes: [
      { id: 'a', address: '10.0.0.1', port: 22 },
      { id: 'b', address: '10.0.0.2' },
      { id: 'c', address: '10.0.0.3', probe: {} }
    ],
    links: []
  });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.document.nodes[0].port, 22);
  assert.equal('probe' in loaded.document.nodes[0], false);
  assert.equal('probe' in loaded.document.nodes[1], false);
  assert.equal('probe' in loaded.document.nodes[2], false);
  assert.equal(loaded.changed, true);
});

test('topology keeps probes in canonical form and refuses bad ones', () => {
  const loaded = Topology.read({
    nodes: [{ id: 'web', address: 'nas.lan', probe: { tcp: { ports: ['443', 80] }, http: { scheme: 'https' } } }]
  });
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.document.nodes[0].probe, {
    tcp: { ports: [443, 80], mode: 'all' },
    http: { scheme: 'https', path: '/', expectStatus: '200-399', timeoutMs: 3000, insecureTls: false }
  });
  const again = Topology.read(loaded.document);
  assert.deepEqual(again.document.nodes[0].probe, loaded.document.nodes[0].probe);

  const refused = Topology.read({ nodes: [{ id: 'gw', probe: { http: { host: 'evil.example' } } }] });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /^Node gw probe: http\.host/);
  assert.equal(Topology.read([{ id: 'gw', probe: { dns: { name: 'a b' } } }]).ok, false);
});

test('runtime probe detail is not saved', () => {
  const loaded = Topology.read({ nodes: [{ id: 'a', probeDetail: 'http 500', probe: { ping: true } }] });
  assert.equal('probeDetail' in loaded.document.nodes[0], false);
  assert.deepEqual(loaded.document.nodes[0].probe, { ping: true });
});

test('createNode carries the probe', () => {
  const node = Topology.createNode({ id: 'n', probe: { ping: true } });
  assert.deepEqual(node.probe, { ping: true });
});

test('editor form round-trips and keeps hidden timeouts', () => {
  const probe = {
    ping: true,
    tcp: { ports: [22, 443], mode: 'any' },
    http: { scheme: 'https', port: 8443, path: '/health', expectStatus: '200', timeoutMs: 9000, insecureTls: true },
    dns: { name: 'example.com', type: 'AAAA', port: 5353, timeoutMs: 1500 }
  };
  const form = ProbeChecks.toForm(probe);
  assert.equal(form.tcpPorts, '22,443');
  assert.equal(form.httpInsecure, true);
  const back = ProbeChecks.fromForm(form, probe);
  assert.deepEqual(back, { ok: true, probe: probe });

  const cleared = ProbeChecks.fromForm(Object.assign({}, form, {
    ping: false, tcpPorts: '', httpScheme: '', dnsName: ''
  }), probe);
  assert.deepEqual(cleared, { ok: true, probe: null });

  const bad = ProbeChecks.fromForm(Object.assign(ProbeChecks.toForm(null), { tcpPorts: '22, abc' }), null);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'tcp.ports holds an invalid port');

  const spaced = ProbeChecks.fromForm(Object.assign(ProbeChecks.toForm(null), { tcpPorts: ' 22 443 ' }), null);
  assert.deepEqual(spaced.probe, { tcp: { ports: [22, 443], mode: 'all' } });
});

test('TLS verification stays on unless asked, and only for https', () => {
  const form = Object.assign(ProbeChecks.toForm(null), { httpScheme: 'http', httpInsecure: true });
  assert.equal(ProbeChecks.fromForm(form, null).probe.http.insecureTls, false);
  const secure = Object.assign(ProbeChecks.toForm(null), { httpScheme: 'https' });
  assert.equal(ProbeChecks.fromForm(secure, null).probe.http.insecureTls, false);
});

test('summary is short', () => {
  assert.equal(ProbeChecks.summary(null), '');
  assert.equal(
    ProbeChecks.summary({ ping: true, tcp: { ports: [22, 80], mode: 'any' }, http: { scheme: 'https' }, dns: { name: 'x.lan' } }),
    'ping · tcp 22|80 · https · dns x.lan'
  );
});

test('the pages load probe-checks.js before topology.js', () => {
  ['index.html', 'admin.html'].forEach((page) => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', page), 'utf8');
    const checks = html.indexOf('js/probe-checks.js');
    assert.ok(checks !== -1, page);
    assert.ok(checks < html.indexOf('js/topology.js'), page);
  });
});
