// Host, port, and scan checks shared by the renderer and the Node tests.
//
// Keep these rules aligned with src-tauri/src/hosts.rs. A host is an IPv4
// address, an IPv6 literal, or a hostname. The value ends up as an argument of
// `ping`, the target of a TCP connect, or an SSH host, so it never contains a
// space, a shell metacharacter, or a leading `-`.
//
// IPv6: full, compressed (`::`), and IPv4-embedded (`::ffff:192.0.2.1`) forms
// are accepted. A zone (`fe80::1%eth0`, `fe80::1%12`) is accepted only on a
// link-local address (fe80::/10). Brackets (`[::1]`) are accepted by
// `normalizeHost`, which strips them; `isSafeHost` takes the bare form.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.Hosts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_HOST_LENGTH = 253;
  const MAX_ZONE_LENGTH = 32;

  const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
  const IPV4 = `(?:${OCTET}\\.){3}${OCTET}`;
  const BASE_IP = `(?:${OCTET}\\.){2}${OCTET}`;
  const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
  const HOSTNAME = `${LABEL}(?:\\.${LABEL})*`;

  const HOST_RE = new RegExp(`^(?:${IPV4}|${HOSTNAME})$`);
  const IPV4_RE = new RegExp(`^${IPV4}$`);
  const BASE_RE = new RegExp(`^${BASE_IP}$`);
  const GROUP_RE = /^[0-9A-Fa-f]{1,4}$/;
  const ZONE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

  function defaultPlatform() {
    return typeof process !== 'undefined' && process && process.platform ? process.platform : '';
  }

  // Returns the eight 16-bit groups of an IPv6 address (no zone), or null.
  function ipv6Groups(text) {
    if (typeof text !== 'string' || text.length < 2 || text.length > 45) return null;
    let head = text;
    let tail4 = null;
    const lastColon = text.lastIndexOf(':');
    if (lastColon === -1) return null;
    if (text.indexOf('.') !== -1) {
      tail4 = text.slice(lastColon + 1);
      if (!IPV4_RE.test(tail4)) return null;
      head = text.slice(0, lastColon + 1);
      // `::1.2.3.4` keeps its `::`; `1::2:1.2.3.4` becomes `1::2:`.
      if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1);
    }
    const width = tail4 ? 6 : 8;
    const parts = head.split('::');
    if (parts.length > 2) return null;
    const parse = (chunk) => {
      if (chunk === '') return [];
      const groups = chunk.split(':');
      if (!groups.every((group) => GROUP_RE.test(group))) return null;
      return groups.map((group) => parseInt(group, 16));
    };
    const left = parse(parts[0]);
    if (!left) return null;
    let groups;
    if (parts.length === 2) {
      const right = parse(parts[1]);
      if (!right) return null;
      // `::` stands for at least one zero group.
      if (left.length + right.length > width - 1) return null;
      groups = left.concat(new Array(width - left.length - right.length).fill(0), right);
    } else {
      if (left.length !== width) return null;
      groups = left;
    }
    if (tail4) {
      const octets = tail4.split('.').map(Number);
      groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    }
    return groups;
  }

  function splitZone(text) {
    const index = text.indexOf('%');
    if (index === -1) return { address: text, zone: null };
    return { address: text.slice(0, index), zone: text.slice(index + 1) };
  }

  function isIpv6(host) {
    if (typeof host !== 'string' || host.length === 0 || host.length > MAX_HOST_LENGTH) return false;
    const { address, zone } = splitZone(host);
    const groups = ipv6Groups(address);
    if (!groups) return false;
    if (zone === null) return true;
    if (zone.length === 0 || zone.length > MAX_ZONE_LENGTH || !ZONE_RE.test(zone)) return false;
    // A zone only means something on a link-local address.
    return (groups[0] & 0xffc0) === 0xfe80;
  }

  function isSafeHost(host) {
    if (typeof host !== 'string' || host.length === 0 || host.length > MAX_HOST_LENGTH) return false;
    if (host.indexOf(':') !== -1) return isIpv6(host);
    if (!HOST_RE.test(host)) return false;
    // Leading zeros make some ping builds treat the octet as octal.
    return !host.split('.').some((label) => /^0\d+$/.test(label));
  }

  // Trims, strips one pair of brackets around an IPv6 literal, and checks.
  // Returns the bare host, or null.
  function normalizeHost(host) {
    if (typeof host !== 'string') return null;
    let value = host.trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1);
      return isIpv6(value) ? value : null;
    }
    return isSafeHost(value) ? value : null;
  }

  // `host:port`, with brackets around an IPv6 literal: `[::1]:22`.
  function formatHostPort(host, port) {
    return host.indexOf(':') !== -1 ? `[${host}]:${port}` : `${host}:${port}`;
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

  // Program and argv for one ping. Never a shell. An IPv6 literal uses
  // `ping -6` (Linux, Windows) or `ping6` (macOS and the BSDs).
  function pingCommand(host, platform = defaultPlatform()) {
    const v6 = host.indexOf(':') !== -1;
    if (platform === 'win32') {
      return { command: 'ping', args: (v6 ? ['-6'] : []).concat(['-n', '1', '-w', '1000', host]) };
    }
    if (v6 && ['darwin', 'freebsd', 'openbsd', 'netbsd'].indexOf(platform) !== -1) {
      return { command: 'ping6', args: ['-c', '1', host] };
    }
    return { command: 'ping', args: (v6 ? ['-6'] : []).concat(['-c', '1', '-W', '1', host]) };
  }

  function pingArgs(host, platform = defaultPlatform()) {
    return pingCommand(host, platform).args;
  }

  function monitoringInterval(requested) {
    const value = Number(requested);
    if (Number.isFinite(value) && value >= 1000 && value <= 60000) return value;
    return 5000;
  }

  function confirmationCount(requested) {
    const value = Number(requested);
    if (Number.isInteger(value) && value >= 2 && value <= 10) return value;
    return 2;
  }

  return {
    isSafeHost: isSafeHost,
    isIpv6: isIpv6,
    normalizeHost: normalizeHost,
    formatHostPort: formatHostPort,
    isSafeBaseIp: isSafeBaseIp,
    isSafePort: isSafePort,
    clampScanRange: clampScanRange,
    pingCommand: pingCommand,
    pingArgs: pingArgs,
    monitoringInterval: monitoringInterval,
    confirmationCount: confirmationCount
  };
});
