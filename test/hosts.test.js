'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isSafeHost,
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
