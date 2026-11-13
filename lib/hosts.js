'use strict';

// Keep these rules aligned with src-tauri/src/hosts.rs.

const MAX_HOST_LENGTH = 253;

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = `(?:${OCTET}\\.){3}${OCTET}`;
const BASE_IP = `(?:${OCTET}\\.){2}${OCTET}`;
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const HOSTNAME = `${LABEL}(?:\\.${LABEL})*`;

const HOST_RE = new RegExp(`^(?:${IPV4}|${HOSTNAME})$`);
const BASE_RE = new RegExp(`^${BASE_IP}$`);

function isSafeHost(host) {
  if (typeof host !== 'string' || host.length === 0 || host.length > MAX_HOST_LENGTH) return false;
  if (!HOST_RE.test(host)) return false;
  // Leading zeros make some ping builds treat the octet as octal.
  return !host.split('.').some((label) => /^0\d+$/.test(label));
}

function isSafeBaseIp(baseIp) {
  return typeof baseIp === 'string' && BASE_RE.test(baseIp);
}

function isSafePort(port) {
  const value = Number(port);
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function clampScanRange(start, end) {
  const rangeStart = Number(start);
  const rangeEnd = Number(end);
  if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd)) return null;
  if (rangeStart < 1 || rangeEnd > 254 || rangeStart > rangeEnd) return null;
  return { start: rangeStart, end: rangeEnd };
}

function pingArgs(host, platform = process.platform) {
  if (platform === 'win32') {
    return ['-n', '1', '-w', '1000', host];
  }
  return ['-c', '1', '-W', '1', host];
}

function monitoringInterval(requested) {
  const value = Number(requested);
  if (Number.isFinite(value) && value >= 1000 && value <= 60000) return value;
  return 2000;
}

module.exports = {
  isSafeHost,
  isSafeBaseIp,
  isSafePort,
  clampScanRange,
  pingArgs,
  monitoringInterval
};
