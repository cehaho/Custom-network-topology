// Per-node probe definitions (`node.probe`).
//
// Keep these rules aligned with src-tauri/src/probe_kinds.rs. A node without
// `probe` keeps the default probe (ping, or TCP on `port`). A node with one is
// up only when every configured check passes. Every check targets the node's
// own address: there is no host or URL field.
//
//   probe: {
//     ping: true,
//     tcp:  { ports: [22, 443], mode: 'all' | 'any' },
//     http: { scheme: 'http' | 'https', port: 8443, path: '/health',
//             expectStatus: '200-399', timeoutMs: 3000, insecureTls: false },
//     dns:  { name: 'example.com', type: 'A' | 'AAAA', port: 53, timeoutMs: 2000 }
//   }
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.ProbeChecks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_TCP_PORTS = 16;
  const MAX_PATH_LENGTH = 256;
  const DEFAULT_STATUS = '200-399';
  const HTTP_TIMEOUT = { low: 500, value: 3000, high: 30000 };
  const DNS_TIMEOUT = { low: 500, value: 2000, high: 10000 };
  const STATUS_ERROR = 'http.expectStatus must look like 200 or 200-399';

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function has(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function absent(value) {
    return value === undefined || value === null;
  }

  function present(value) {
    return !absent(value) && value !== false;
  }

  function fail(error) {
    const err = new Error(error);
    err.probeError = true;
    throw err;
  }

  function portValue(value) {
    let number = NaN;
    if (typeof value === 'number') number = value;
    else if (typeof value === 'string' && /^[0-9]+$/.test(value)) number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 65535) return null;
    return number;
  }

  function timeoutValue(value, bounds) {
    if (absent(value)) return bounds.value;
    if (typeof value !== 'number' || !Number.isInteger(value)) return null;
    if (value < bounds.low || value > bounds.high) return null;
    return value;
  }

  function parseStatus(textValue) {
    const code = (part) => {
      if (!/^[0-9]{3}$/.test(part)) return null;
      const number = Number(part);
      return number >= 100 && number <= 599 ? number : null;
    };
    const dash = textValue.indexOf('-');
    let low;
    let high;
    if (dash === -1) {
      low = code(textValue);
      high = low;
    } else {
      low = code(textValue.slice(0, dash));
      high = code(textValue.slice(dash + 1));
    }
    if (low === null || high === null || low > high) return null;
    return low === high ? String(low) : low + '-' + high;
  }

  function isSafePath(path) {
    return typeof path === 'string'
      && path.length <= MAX_PATH_LENGTH
      && path.charAt(0) === '/'
      && path.slice(0, 2) !== '//'
      && /^[A-Za-z0-9/\-._~%?&=+,;:!*'()$]*$/.test(path);
  }

  function isQueryName(name) {
    if (!name || name.length > 253) return false;
    const labels = name.split('.');
    if (labels.every((label) => /^[0-9]*$/.test(label))) return false;
    return labels.every((label) => label.length >= 1 && label.length <= 63
      && /^[A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?$/.test(label));
  }

  function parseTcp(value) {
    if (!isObject(value)) fail('tcp must be an object');
    if (!Array.isArray(value.ports)) fail('tcp.ports must be a list of ports');
    const ports = [];
    value.ports.forEach((item) => {
      const port = portValue(item);
      if (port === null) fail('tcp.ports holds an invalid port');
      if (ports.indexOf(port) === -1) ports.push(port);
    });
    if (ports.length > MAX_TCP_PORTS) fail('tcp.ports holds more than ' + MAX_TCP_PORTS + ' ports');
    let mode = 'all';
    if (!absent(value.mode)) {
      if (value.mode !== 'all' && value.mode !== 'any') fail('tcp.mode must be "all" or "any"');
      mode = value.mode;
    }
    return ports.length ? { ports: ports, mode: mode } : null;
  }

  function parseHttp(value) {
    if (!isObject(value)) fail('http must be an object');
    if (has(value, 'host') || has(value, 'url')) {
      fail('http.host and http.url are not allowed: the check targets the node address');
    }
    let scheme = 'http';
    if (!absent(value.scheme)) {
      if (value.scheme !== 'http' && value.scheme !== 'https') fail('http.scheme must be "http" or "https"');
      scheme = value.scheme;
    }
    let port = null;
    if (!absent(value.port) && value.port !== '') {
      port = portValue(value.port);
      if (port === null) fail('http.port is not a valid port');
    }
    let path = '/';
    if (!absent(value.path) && value.path !== '') {
      if (!isSafePath(value.path)) fail('http.path must start with / and hold URL characters only');
      path = value.path;
    }
    let expectStatus = DEFAULT_STATUS;
    if (!absent(value.expectStatus) && value.expectStatus !== '') {
      let parsed = null;
      if (typeof value.expectStatus === 'string') parsed = parseStatus(value.expectStatus);
      else if (Number.isInteger(value.expectStatus) && value.expectStatus >= 0) parsed = parseStatus(String(value.expectStatus));
      if (parsed === null) fail(STATUS_ERROR);
      expectStatus = parsed;
    }
    const timeoutMs = timeoutValue(value.timeoutMs, HTTP_TIMEOUT);
    if (timeoutMs === null) fail('http.timeoutMs must be between 500 and 30000');
    let insecureTls = false;
    if (!absent(value.insecureTls)) {
      if (typeof value.insecureTls !== 'boolean') fail('http.insecureTls must be true or false');
      insecureTls = value.insecureTls && scheme === 'https';
    }
    const out = { scheme: scheme };
    if (port !== null) out.port = port;
    out.path = path;
    out.expectStatus = expectStatus;
    out.timeoutMs = timeoutMs;
    out.insecureTls = insecureTls;
    return out;
  }

  function parseDns(value) {
    if (!isObject(value)) fail('dns must be an object');
    if (typeof value.name !== 'string') fail('dns.name must be a host name');
    const name = value.name.trim().replace(/\.+$/, '').toLowerCase();
    if (!isQueryName(name)) fail('dns.name must be a host name');
    let type = 'A';
    if (!absent(value.type)) {
      const kind = typeof value.type === 'string' ? value.type.toUpperCase() : '';
      if (kind !== 'A' && kind !== 'AAAA') fail('dns.type must be "A" or "AAAA"');
      type = kind;
    }
    let port = 53;
    if (!absent(value.port) && value.port !== '') {
      port = portValue(value.port);
      if (port === null) fail('dns.port is not a valid port');
    }
    const timeoutMs = timeoutValue(value.timeoutMs, DNS_TIMEOUT);
    if (timeoutMs === null) fail('dns.timeoutMs must be between 500 and 10000');
    return { name: name, type: type, port: port, timeoutMs: timeoutMs };
  }

  // { ok: true, probe } with `probe` canonical or null (no check), or
  // { ok: false, error }.
  function normalize(raw) {
    if (absent(raw)) return { ok: true, probe: null };
    if (!isObject(raw)) return { ok: false, error: 'must be an object' };
    try {
      const probe = {};
      if (!absent(raw.ping)) {
        if (typeof raw.ping !== 'boolean') fail('ping must be true or false');
        if (raw.ping) probe.ping = true;
      }
      if (present(raw.tcp)) {
        const tcp = parseTcp(raw.tcp);
        if (tcp) probe.tcp = tcp;
      }
      if (present(raw.http)) probe.http = parseHttp(raw.http);
      if (present(raw.dns)) probe.dns = parseDns(raw.dns);
      return { ok: true, probe: Object.keys(probe).length ? probe : null };
    } catch (error) {
      if (error && error.probeError) return { ok: false, error: error.message };
      throw error;
    }
  }

  function nodeError(node) {
    if (!isObject(node) || !has(node, 'probe')) return '';
    const result = normalize(node.probe);
    if (result.ok) return '';
    const id = typeof node.id === 'string' ? node.id : '';
    return (id ? 'Node ' + id + ' probe: ' : 'Node probe: ') + result.error;
  }

  // Flat values for the editor.
  function toForm(probe) {
    const source = normalize(probe);
    const value = source.ok && source.probe ? source.probe : {};
    const http = value.http || null;
    const dns = value.dns || null;
    return {
      ping: value.ping === true,
      tcpPorts: value.tcp ? value.tcp.ports.join(',') : '',
      tcpMode: value.tcp ? value.tcp.mode : 'all',
      httpScheme: http ? http.scheme : '',
      httpPort: http && http.port ? String(http.port) : '',
      httpPath: http && http.path !== '/' ? http.path : '',
      httpStatus: http && http.expectStatus !== DEFAULT_STATUS ? http.expectStatus : '',
      httpInsecure: !!(http && http.insecureTls),
      dnsName: dns ? dns.name : '',
      dnsType: dns ? dns.type : 'A'
    };
  }

  // Editor values back to a probe. Timeouts and the DNS port come from the
  // previous probe, which the compact editor does not show.
  function fromForm(form, previous) {
    const before = normalize(previous);
    const old = before.ok && before.probe ? before.probe : {};
    const raw = {};
    if (form.ping) raw.ping = true;
    const portsText = String(form.tcpPorts || '').trim();
    if (portsText) {
      const ports = portsText.split(/[\s,]+/).filter(Boolean).map((item) => (/^[0-9]+$/.test(item) ? Number(item) : item));
      raw.tcp = { ports: ports, mode: form.tcpMode === 'any' ? 'any' : 'all' };
    }
    if (form.httpScheme === 'http' || form.httpScheme === 'https') {
      raw.http = {
        scheme: form.httpScheme,
        port: String(form.httpPort || '').trim(),
        path: String(form.httpPath || '').trim(),
        expectStatus: String(form.httpStatus || '').trim(),
        insecureTls: !!form.httpInsecure
      };
      if (old.http) raw.http.timeoutMs = old.http.timeoutMs;
    }
    const dnsName = String(form.dnsName || '').trim();
    if (dnsName) {
      raw.dns = { name: dnsName, type: form.dnsType === 'AAAA' ? 'AAAA' : 'A' };
      if (old.dns) {
        raw.dns.port = old.dns.port;
        raw.dns.timeoutMs = old.dns.timeoutMs;
      }
    }
    return normalize(raw);
  }

  function summary(probe) {
    const result = normalize(probe);
    if (!result.ok || !result.probe) return '';
    const parts = [];
    const value = result.probe;
    if (value.ping) parts.push('ping');
    if (value.tcp) parts.push('tcp ' + value.tcp.ports.join(value.tcp.mode === 'any' ? '|' : ','));
    if (value.http) parts.push(value.http.scheme);
    if (value.dns) parts.push('dns ' + value.dns.name);
    return parts.join(' · ');
  }

  return {
    MAX_TCP_PORTS: MAX_TCP_PORTS,
    normalize: normalize,
    nodeError: nodeError,
    isSafePath: isSafePath,
    toForm: toForm,
    fromForm: fromForm,
    summary: summary
  };
});
