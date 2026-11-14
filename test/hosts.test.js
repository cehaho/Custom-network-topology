'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isSafeHost,
  isIpv6,
  normalizeHost,
  formatHostPort,
  pingCommand,
  isSafeBaseIp,
  isSafePort,
  clampScanRange,
  pingArgs,
  monitoringInterval,
  confirmationCount
} = require('../lib/hosts');

test('accepts IPv4 addresses and hostnames', () => {
  assert.equal(isSafeHost('192.168.1.1'), true);
  assert.equal(isSafeHost('8.8.8.8'), true);
  assert.equal(isSafeHost('gateway.local'), true);
  assert.equal(isSafeHost('a'), true);
});

test('rejects shell metacharacters and empty values', () => {
  assert.equal(isSafeHost('192.168.1.1;id'), false);
  assert.equal(isSafeHost('8.8.8.8 && whoami'), false);
  assert.equal(isSafeHost('$(reboot)'), false);
  assert.equal(isSafeHost('host`id`'), false);
  assert.equal(isSafeHost(''), false);
  assert.equal(isSafeHost(null), false);
  assert.equal(isSafeHost('192.168.001.1'), false);
});

test('accepts a three-octet scan base only', () => {
  assert.equal(isSafeBaseIp('192.168.1'), true);
  assert.equal(isSafeBaseIp('10.0.0'), true);
  assert.equal(isSafeBaseIp('192.168.1.1'), false);
  assert.equal(isSafeBaseIp('192.168.001'), false);
  assert.equal(isSafeBaseIp('192.168.1;id'), false);
  assert.equal(isSafeBaseIp('192.168'), false);
});

test('validates ports and scan bounds', () => {
  assert.equal(isSafePort(22), true);
  assert.equal(isSafePort(65535), true);
  assert.equal(isSafePort(0), false);
  assert.equal(isSafePort(65536), false);
  assert.equal(isSafePort(1.5), false);
  assert.equal(isSafePort('22'), true);
  assert.deepEqual(clampScanRange(1, 254), { start: 1, end: 254 });
  assert.equal(clampScanRange(10, 2), null);
  assert.equal(clampScanRange(0, 10), null);
  assert.equal(clampScanRange(1, 255), null);
});

test('builds ping arguments without a shell', () => {
  assert.deepEqual(pingArgs('192.168.1.1', 'linux'), ['-c', '1', '-W', '1', '192.168.1.1']);
  assert.deepEqual(pingArgs('10.0.0.1', 'win32'), ['-n', '1', '-w', '1000', '10.0.0.1']);
});

test('clamps the monitoring interval', () => {
  assert.equal(monitoringInterval(2000), 2000);
  assert.equal(monitoringInterval(50), 5000);
  assert.equal(monitoringInterval('nope'), 5000);
  assert.equal(monitoringInterval(undefined), 5000);
  assert.equal(monitoringInterval(60000), 60000);
  assert.equal(confirmationCount(undefined), 2);
  assert.equal(confirmationCount(1), 2);
  assert.equal(confirmationCount(4), 4);
});

// Keep these lists aligned with the IPv6 tests in src-tauri/src/hosts.rs.
const IPV6_OK = [
  '::1',
  '::',
  '2001:db8::1',
  '2001:DB8:0:0:0:0:0:1',
  'fe80::1',
  'fe80::1%eth0',
  'fe80::aede:48ff:fe00:1122%en0',
  'fe80::1%12',
  '::ffff:192.168.1.1',
  '64:ff9b::192.0.2.33',
  '1:2:3:4:5:6:7:8',
  '1:2:3:4:5:6:7::',
  '::2:3:4:5:6:7:8'
];

const IPV6_BAD = [
  ':::',
  '1:::2',
  '1::2::3',
  '1:2:3:4:5:6:7:8:9',
  '1:2:3:4:5:6:7',
  '12345::1',
  'g::1',
  ':1',
  '1:',
  '[::1]',
  '::1 ',
  '::1;id',
  '::1%eth0',
  '2001:db8::1%eth0',
  'fe80::1%',
  'fe80::1%eth0;id',
  'fe80::1%eth 0',
  'fe80::1%-eth0',
  'fe80::1%$(reboot)',
  '::ffff:192.168.001.1',
  '::ffff:256.1.1.1',
  '::1/64'
];

test('accepts IPv6 literals', () => {
  for (const host of IPV6_OK) {
    assert.equal(isSafeHost(host), true, host);
    assert.equal(isIpv6(host), true, host);
  }
  assert.equal(isIpv6('192.168.1.1'), false);
  assert.equal(isIpv6('gateway.local'), false);
});

test('rejects malformed or unsafe IPv6', () => {
  for (const host of IPV6_BAD) {
    assert.equal(isSafeHost(host), false, host);
  }
});

test('normalizes brackets and formats host:port', () => {
  assert.equal(normalizeHost('[::1]'), '::1');
  assert.equal(normalizeHost(' [fe80::1%eth0] '), 'fe80::1%eth0');
  assert.equal(normalizeHost('192.168.1.1'), '192.168.1.1');
  assert.equal(normalizeHost(' gateway.local '), 'gateway.local');
  assert.equal(normalizeHost('[192.168.1.1]'), null);
  assert.equal(normalizeHost('[gateway]'), null);
  assert.equal(normalizeHost('[::1'), null);
  assert.equal(normalizeHost('[[::1]]'), null);
  assert.equal(normalizeHost('[::1]:22'), null);
  assert.equal(normalizeHost('::1;id'), null);
  assert.equal(normalizeHost(null), null);
  assert.equal(formatHostPort('::1', 22), '[::1]:22');
  assert.equal(formatHostPort('10.0.0.1', 22), '10.0.0.1:22');
  assert.equal(formatHostPort('router.lan', 2222), 'router.lan:2222');
});

test('pings IPv6 with -6 or ping6 depending on the platform', () => {
  assert.deepEqual(pingCommand('::1', 'linux'), { command: 'ping', args: ['-6', '-c', '1', '-W', '1', '::1'] });
  assert.deepEqual(pingCommand('fe80::1%12', 'win32'), { command: 'ping', args: ['-6', '-n', '1', '-w', '1000', 'fe80::1%12'] });
  assert.deepEqual(pingCommand('2001:db8::1', 'darwin'), { command: 'ping6', args: ['-c', '1', '2001:db8::1'] });
  assert.deepEqual(pingCommand('192.168.1.1', 'darwin'), { command: 'ping', args: ['-c', '1', '-W', '1', '192.168.1.1'] });
  assert.deepEqual(pingArgs('gateway.local', 'win32'), ['-n', '1', '-w', '1000', 'gateway.local']);
});

test('the page loads hosts.js before the app modules and the module sets the global', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const hostsAt = html.indexOf('src="js/hosts.js"');
  assert.ok(hostsAt > 0, 'hosts.js is loaded');
  const appAt = html.indexOf('<script type="module" src="js/app/main.js">');
  assert.ok(appAt > 0 && hostsAt < appAt, 'before js/app/main.js');
  assert.equal(globalThis.Hosts, require('../lib/hosts'));
});
