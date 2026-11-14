'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const KnownHostsAdmin = require('../renderer/js/known-hosts-admin');

const entries = [
  { host: '10.0.0.1', port: 22, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:AAAA', addedAt: '2026-01-02T03:04:05Z' },
  { host: '::1', port: 2222, algorithm: 'ecdsa-sha2-nistp256', fingerprint: 'SHA256:BBBB', addedAt: '' },
  { host: 'router.lan', port: 22, algorithm: 'ssh-rsa', fingerprint: 'SHA256:CcCc', addedAt: 'nope' }
];

test('host:port brackets IPv6 literals', () => {
  assert.equal(KnownHostsAdmin.hostPort('10.0.0.1', 22), '10.0.0.1:22');
  assert.equal(KnownHostsAdmin.hostPort('::1', 2222), '[::1]:2222');
});

test('filter matches host, port, algorithm and fingerprint, case-insensitively', () => {
  const hosts = (query) => KnownHostsAdmin.filterEntries(entries, query).map((entry) => entry.host);
  assert.deepEqual(hosts(''), ['10.0.0.1', '::1', 'router.lan']);
  assert.deepEqual(hosts('  ROUTER '), ['router.lan']);
  assert.deepEqual(hosts('[::1]:2222'), ['::1']);
  assert.deepEqual(hosts('ecdsa'), ['::1']);
  assert.deepEqual(hosts('sha256:cccc'), ['router.lan']);
  assert.deepEqual(hosts('ssh :22'), ['10.0.0.1', 'router.lan']);
  assert.deepEqual(hosts('nothing'), []);
  assert.deepEqual(KnownHostsAdmin.filterEntries(null, 'x'), []);
});

test('added date is shown in UTC, empty when missing or invalid', () => {
  assert.equal(KnownHostsAdmin.formatAdded('2026-01-02T03:04:05Z'), '2026-01-02 03:04 UTC');
  assert.equal(KnownHostsAdmin.formatAdded(''), '');
  assert.equal(KnownHostsAdmin.formatAdded('nope'), '');
});

test('import summary lists skips and conflicts', () => {
  const lines = KnownHostsAdmin.summaryLines({
    imported: 1,
    alreadyKnown: 2,
    skippedHashed: 3,
    skippedMarkers: 1,
    skippedInvalid: 0,
    conflicts: [{
      host: '2001:db8::1', port: 22, storedFingerprint: 'SHA256:old', importedFingerprint: 'SHA256:new'
    }]
  });
  assert.deepEqual(lines, [
    'Imported 1 host key.',
    '2 hosts already known.',
    'Skipped 3 hashed entries (host names cannot be recovered).',
    'Skipped 1 @cert-authority / @revoked line.',
    '1 conflict left unchanged (forget the stored key first to replace it):',
    '  [2001:db8::1]:22: stored SHA256:old, file SHA256:new'
  ]);
  assert.deepEqual(KnownHostsAdmin.summaryLines({}), ['Imported 0 host keys.']);
});

test('commands are registered, allowed and bridged', () => {
  const root = path.join(__dirname, '..');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const lib = read('src-tauri/src/lib.rs');
  const build = read('src-tauri/build.rs');
  const capabilities = JSON.parse(read('src-tauri/capabilities/default.json'));
  const desktop = read('renderer/js/desktop.js');
  for (const command of ['ssh_known_hosts_list', 'ssh_known_hosts_import_openssh', 'ssh_forget_host_key']) {
    assert.ok(lib.includes('fn ' + command + '('), command + ' is defined');
    assert.ok(lib.includes('            ' + command + ',\n'), command + ' is in the handler');
    assert.ok(build.includes('"' + command + '"'), command + ' is in build.rs');
    assert.ok(capabilities.permissions.includes('allow-' + command.replace(/_/g, '-')), command + ' is allowed');
    assert.ok(desktop.includes("invoke('" + command + "'"), command + ' is bridged');
  }
  for (const page of ['renderer/index.html', 'renderer/admin.html']) {
    const html = read(page);
    const at = html.indexOf('src="js/known-hosts-admin.js"');
    assert.ok(at > 0, 'loaded in ' + page);
    assert.ok(at < html.indexOf('src="js/admin.js"'), 'before admin.js in ' + page);
  }
});
