// Quick actions of the node context menu: copy address, open web UI,
// traceroute, Wake-on-LAN.
//
// Keep the URL rules aligned with src-tauri/src/actions.rs. The node fields
// (`mac`, `wolBroadcast`, `webUrlScheme`, `webPort`) are validated by
// Topology (renderer/js/topology.js) and by the Rust side. The browser is
// opened by the Rust command, which rebuilds the URL from the node address;
// the renderer never passes a free-form URL.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.QuickActions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const Topology = root.Topology || (typeof require === 'function' ? require('./topology.js') : null);
  const Hosts = root.Hosts || (typeof require === 'function' ? require('./hosts.js') : null);

  // `http(s)://host[:port]/` or null. IPv6 is bracketed, its zone written
  // `%25zone`. Without a scheme, 443 and 8443 mean https.
  function buildWebUrl(address, scheme, port) {
    const host = typeof address === 'string' ? Hosts.normalizeHost(address) : null;
    if (!host) return null;
    let finalScheme;
    if (scheme === undefined || scheme === null || String(scheme).trim() === '') {
      finalScheme = port === 443 || port === 8443 ? 'https' : 'http';
    } else {
      finalScheme = Topology.parseWebScheme(String(scheme));
      if (!finalScheme) return null;
    }
    let finalPort = null;
    if (port !== undefined && port !== null && port !== '') {
      finalPort = Topology.parseWebPort(port);
      if (finalPort === null) return null;
    }
    const hostText = host.indexOf(':') !== -1
      ? '[' + host.replace('%', '%25') + ']'
      : host.toLowerCase();
    const defaultPort = finalScheme === 'https' ? 443 : 80;
    return finalPort && finalPort !== defaultPort
      ? finalScheme + '://' + hostText + ':' + finalPort + '/'
      : finalScheme + '://' + hostText + '/';
  }

  function nodeWebUrl(node) {
    if (!node) return null;
    return buildWebUrl(node.address, node.webUrlScheme, node.webPort === undefined ? null : node.webPort);
  }

  function formatRtt(value) {
    if (value === null || value === undefined) return '*';
    return (value < 10 ? value.toFixed(2) : value.toFixed(1)) + ' ms';
  }

  // One text row per parsed hop: "  3  10.0.0.1  1.20 ms  * ".
  function formatHops(hops) {
    return (hops || []).map((hop) => {
      const rtts = (hop.rtts || []).map(formatRtt).join('  ');
      return String(hop.hop).padStart(3, ' ') + '  ' + (hop.address || '*').padEnd(40, ' ') + '  ' + rtts;
    }).join('\n');
  }

  // ---------------------------------------------------------------------
  // Browser-only UI (the functions below touch the DOM).
  // ---------------------------------------------------------------------

  function el(id) {
    return root.document ? root.document.getElementById(id) : null;
  }

  // The page hands over its toasts and modal opener (renderer/js/app/main.js):
  // { toastSuccess, toastError, toastInfo, openModal }.
  let ui = {};

  function useUi(hooks) {
    ui = hooks || {};
  }

  function notify(kind, title, message) {
    const fn = { success: ui.toastSuccess, error: ui.toastError, info: ui.toastInfo }[kind];
    if (typeof fn === 'function') fn(title, message);
  }

  function desktop() {
    return root.desktopAPI && root.desktopAPI.actions ? root.desktopAPI.actions : null;
  }

  // Shows the Open Web UI / Wake-on-LAN entries only when they apply.
  function prepareMenu(node) {
    const web = el('context-open-web');
    if (web) {
      const url = nodeWebUrl(node);
      web.classList.toggle('hidden', !url);
      web.title = url || '';
    }
    const wake = el('context-wake');
    if (wake) wake.classList.toggle('hidden', !(node && Topology.parseMac(node.mac || '')));
    const trace = el('context-traceroute');
    if (trace) trace.classList.toggle('hidden', !(node && Hosts.normalizeHost(node.address || '')));
    const copy = el('context-copy-address');
    if (copy) copy.classList.toggle('hidden', !(node && node.address));
  }

  async function copyText(text) {
    try {
      if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
        await root.navigator.clipboard.writeText(text);
        return true;
      }
    } catch (error) {
      // Fall through to the textarea copy below.
    }
    const doc = root.document;
    if (!doc) return false;
    const area = doc.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    doc.body.appendChild(area);
    area.select();
    let copied = false;
    try {
      copied = doc.execCommand('copy');
    } catch (error) {
      copied = false;
    }
    area.remove();
    return copied;
  }

  async function copyAddress(node) {
    if (!node || !node.address) return;
    const text = Hosts.normalizeHost(node.address) || node.address;
    if (await copyText(text)) notify('success', 'Address Copied', text);
    else notify('error', 'Copy Failed', 'The clipboard is not available');
  }

  async function openWeb(node) {
    const url = nodeWebUrl(node);
    if (!url) {
      notify('error', 'Open Web UI', 'This node has no valid address, scheme or port');
      return;
    }
    const api = desktop();
    if (!api) {
      root.open(url, '_blank', 'noopener');
      return;
    }
    const port = node.webPort === undefined ? null : Topology.parseWebPort(node.webPort);
    const result = await api.openWeb(Hosts.normalizeHost(node.address), node.webUrlScheme || null, port);
    if (result && result.success) notify('info', 'Opening Web UI', result.url);
    else notify('error', 'Open Web UI Failed', (result && result.error) || url);
  }

  let tracerouteRun = 0;

  async function traceroute(node) {
    const host = node ? Hosts.normalizeHost(node.address || '') : null;
    if (!host) {
      notify('error', 'Traceroute', 'This node has no valid address');
      return;
    }
    const api = desktop();
    if (!api) {
      notify('error', 'Traceroute', 'Traceroute needs the desktop app');
      return;
    }
    const run = ++tracerouteRun;
    el('traceroute-title').textContent = 'Traceroute to ' + host;
    el('traceroute-status').textContent = 'Running (up to 30 hops, 30 s)…';
    el('traceroute-output').textContent = '';
    if (typeof ui.openModal === 'function') ui.openModal('traceroute-modal');
    let result;
    try {
      result = await api.traceroute(host);
    } catch (error) {
      result = { success: false, error: String(error) };
    }
    if (run !== tracerouteRun) return;
    const hops = Array.isArray(result.hops) ? result.hops : [];
    const lines = Array.isArray(result.lines) ? result.lines : [];
    let status = hops.length + ' hop' + (hops.length === 1 ? '' : 's');
    if (result.timedOut) status += ' (stopped after 30 s)';
    if (result.error) status += ' - ' + result.error;
    el('traceroute-status').textContent = status;
    el('traceroute-output').textContent = hops.length > 0 ? formatHops(hops) : lines.join('\n');
  }

  async function wake(node) {
    const mac = node ? Topology.parseMac(node.mac || '') : null;
    if (!mac) {
      notify('error', 'Wake-on-LAN', 'This node has no valid MAC address');
      return;
    }
    const api = desktop();
    if (!api) {
      notify('error', 'Wake-on-LAN', 'Wake-on-LAN needs the desktop app');
      return;
    }
    const result = await api.wake(mac, node.wolBroadcast || null);
    if (result && result.success) {
      notify('success', 'Magic Packet Sent', mac + ' via ' + result.broadcast + ':' + result.port);
    } else {
      notify('error', 'Wake-on-LAN Failed', (result && result.error) || mac);
    }
  }

  // Node form: fills and reads the "Quick actions" inputs.
  function fillNodeForm(node) {
    const set = (id, value) => {
      const input = el(id);
      if (input) input.value = value === undefined || value === null ? '' : value;
    };
    set('node-mac', node && node.mac);
    set('node-wol-broadcast', node && node.wolBroadcast);
    set('node-web-scheme', node && node.webUrlScheme);
    set('node-web-port', node && node.webPort);
  }

  // Returns the fields to store, or null after reporting the first invalid one.
  function readNodeForm() {
    const value = (id) => (el(id) ? el(id).value.trim() : '');
    const checks = [
      ['mac', 'node-mac', Topology.parseMac, 'MAC address must look like aa:bb:cc:dd:ee:ff'],
      ['wolBroadcast', 'node-wol-broadcast', Topology.parseBroadcast, 'Broadcast address must be an IPv4 address'],
      ['webUrlScheme', 'node-web-scheme', Topology.parseWebScheme, 'Web scheme must be http or https'],
      ['webPort', 'node-web-port', Topology.parseWebPort, 'Web port must be between 1 and 65535']
    ];
    const fields = {};
    for (const [key, id, parse, message] of checks) {
      const text = value(id);
      if (!text) {
        fields[key] = null;
        continue;
      }
      const parsed = parse(text);
      if (parsed === null) {
        notify('error', 'Validation Error', message);
        if (el(id)) el(id).focus();
        return null;
      }
      fields[key] = parsed;
    }
    return fields;
  }

  function applyNodeFields(nodeData, fields) {
    Object.keys(fields || {}).forEach((key) => {
      if (fields[key] === null) delete nodeData[key];
      else nodeData[key] = fields[key];
    });
    return nodeData;
  }

  return {
    buildWebUrl: buildWebUrl,
    nodeWebUrl: nodeWebUrl,
    formatHops: formatHops,
    applyNodeFields: applyNodeFields,
    useUi: useUi,
    prepareMenu: prepareMenu,
    copyAddress: copyAddress,
    openWeb: openWeb,
    traceroute: traceroute,
    wake: wake,
    fillNodeForm: fillNodeForm,
    readNodeForm: readNodeForm
  };
});
