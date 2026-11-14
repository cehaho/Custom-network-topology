// SNMP v2c read-only view: node tooltip and link load.
//
// The desktop side polls nodes whose `snmp.enabled` is true and sends one
// `snmp-data` event per node. The community is never in this file or in the
// topology document: a typed value goes out once as `snmpCommunity`, the save
// moves it into the OS keyring and leaves `snmpSecret: { type: 'community' }`.
//
// A link shows load when one endpoint has SNMP data and the interface is known:
// `snmpIfIndex` or `snmpIfName` on the link (optionally `snmpNodeId`), or a
// port name equal to the interface name or description.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.SnmpUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_PORT = 161;
  const DEFAULT_INTERVAL_SECS = 30;
  const MIN_INTERVAL_SECS = 10;
  const MAX_INTERVAL_SECS = 3600;

  const state = {
    data: new Map(),
    onUpdate: null,
    unsubscribe: null,
    formClear: false
  };

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function isEnabled(node) {
    return !!(node && isObject(node.snmp) && node.snmp.enabled === true
      && typeof node.address === 'string' && node.address.trim() !== '');
  }

  function intervalSecs(settings) {
    const value = Number(settings && settings.snmpIntervalSecs);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_INTERVAL_SECS;
    return Math.min(MAX_INTERVAL_SECS, Math.max(MIN_INTERVAL_SECS, Math.round(value)));
  }

  function startRequest(doc) {
    const nodes = ((doc && doc.nodes) || []).filter(isEnabled).map((node) => ({
      id: node.id,
      address: node.address.trim(),
      port: Number.isInteger(node.snmp.port) ? node.snmp.port : DEFAULT_PORT
    }));
    return { nodes: nodes, intervalSecs: intervalSecs(doc && doc.settings) };
  }

  function formatBps(bps) {
    if (typeof bps !== 'number' || !Number.isFinite(bps) || bps < 0) return '-';
    const units = ['b/s', 'kb/s', 'Mb/s', 'Gb/s', 'Tb/s'];
    let value = bps;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
      value /= 1000;
      unit += 1;
    }
    const digits = unit === 0 || value >= 100 ? 0 : 1;
    return value.toFixed(digits) + ' ' + units[unit];
  }

  function formatUptime(secs) {
    if (typeof secs !== 'number' || !Number.isFinite(secs) || secs < 0) return '-';
    const days = Math.floor(secs / 86400);
    const hours = Math.floor((secs % 86400) / 3600);
    const minutes = Math.floor((secs % 3600) / 60);
    if (days > 0) return days + 'd ' + hours + 'h';
    if (hours > 0) return hours + 'h ' + minutes + 'm';
    return minutes + 'm';
  }

  function sameName(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.trim() !== ''
      && a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  function interfaceByName(data, name) {
    const list = (data && data.interfaces) || [];
    return list.find((item) => sameName(item.name, name))
      || list.find((item) => sameName(item.descr, name))
      || null;
  }

  function interfaceByIndex(data, index) {
    return ((data && data.interfaces) || []).find((item) => item.index === index) || null;
  }

  function endpointPortName(link, node, side) {
    const portId = side === 'source' ? link.sourcePortId : link.targetPortId;
    const port = ((node && node.ports) || []).find((item) => item.id === portId);
    return port ? port.name : '';
  }

  // Which interface carries this link, and on which endpoint.
  function linkInterface(link, doc, dataById) {
    if (!link) return null;
    const nodes = (doc && doc.nodes) || [];
    const sides = [
      { side: 'source', id: link.sourceNodeId },
      { side: 'target', id: link.targetNodeId }
    ].filter((entry) => !link.snmpNodeId || entry.id === link.snmpNodeId);
    const explicit = Number.isInteger(link.snmpIfIndex) || typeof link.snmpIfName === 'string';
    for (const entry of sides) {
      const data = dataById.get(entry.id);
      if (!data || !data.ok) continue;
      let iface = null;
      if (Number.isInteger(link.snmpIfIndex)) iface = interfaceByIndex(data, link.snmpIfIndex);
      if (!iface && typeof link.snmpIfName === 'string') iface = interfaceByName(data, link.snmpIfName);
      if (!iface && !explicit) {
        const node = nodes.find((item) => item.id === entry.id);
        iface = interfaceByName(data, endpointPortName(link, node, entry.side));
      }
      if (iface) return { nodeId: entry.id, iface: iface };
    }
    return null;
  }

  function linkLoad(link, doc, dataById) {
    const found = linkInterface(link, doc, dataById || state.data);
    if (!found) return null;
    const iface = found.iface;
    const rates = [iface.inBps, iface.outBps].filter((value) => typeof value === 'number');
    const peak = rates.length ? Math.max.apply(null, rates) : null;
    const speed = typeof iface.speedBps === 'number' && iface.speedBps > 0 ? iface.speedBps : null;
    const utilization = peak !== null && speed ? Math.min(1, peak / speed) : null;
    return {
      nodeId: found.nodeId,
      index: iface.index,
      name: iface.name || iface.descr || ('if' + iface.index),
      operStatus: iface.operStatus,
      inBps: typeof iface.inBps === 'number' ? iface.inBps : null,
      outBps: typeof iface.outBps === 'number' ? iface.outBps : null,
      speedBps: speed,
      utilization: utilization
    };
  }

  function loadStyle(utilization) {
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null;
    const share = Math.max(0, Math.min(1, utilization));
    let color = '#22c55e';
    if (share >= 0.85) color = '#ef4444';
    else if (share >= 0.6) color = '#f97316';
    else if (share >= 0.3) color = '#eab308';
    return { color: color, width: 2 + Math.round(share * 6) };
  }

  function loadText(load, nodeName) {
    if (!load) return '';
    let text = load.name + (nodeName ? ' on ' + nodeName : '')
      + ': in ' + formatBps(load.inBps) + ', out ' + formatBps(load.outBps);
    if (load.speedBps) {
      text += ' of ' + formatBps(load.speedBps);
      if (load.utilization !== null) text += ' (' + Math.round(load.utilization * 100) + '%)';
    }
    if (load.operStatus && load.operStatus !== 'up') text += ' [' + load.operStatus + ']';
    return text;
  }

  function tooltip(data) {
    if (!data) return '';
    if (!data.ok) return 'SNMP: ' + (data.error || 'no answer');
    const interfaces = Array.isArray(data.interfaces) ? data.interfaces : [];
    const up = interfaces.filter((item) => item.operStatus === 'up').length;
    const lines = [
      'SNMP: ' + (data.sysName || '(no sysName)'),
      data.sysDescr ? String(data.sysDescr).slice(0, 120) : '',
      'Uptime: ' + formatUptime(data.uptimeSecs),
      'Interfaces: ' + up + ' up of ' + interfaces.length + (data.truncated ? ' (first 64)' : '')
    ].filter(Boolean);
    const busiest = interfaces
      .filter((item) => typeof item.inBps === 'number' || typeof item.outBps === 'number')
      .sort((a, b) => Math.max(b.inBps || 0, b.outBps || 0) - Math.max(a.inBps || 0, a.outBps || 0))
      .slice(0, 5);
    busiest.forEach((item) => {
      lines.push('  ' + (item.name || item.descr || ('if' + item.index))
        + ': in ' + formatBps(item.inBps) + ', out ' + formatBps(item.outBps));
    });
    return lines.join('\n');
  }

  function accept(payload) {
    if (!isObject(payload) || typeof payload.id !== 'string' || !payload.id) return false;
    state.data.set(payload.id, payload);
    return true;
  }

  // ---- Admin table cell ----

  function adminCell(host, index, escapeHtml) {
    const snmp = isObject(host.snmp) ? host.snmp : {};
    const saved = isObject(host.snmpSecret) && host.snmpSecret.type === 'community';
    let hint = '';
    if (host.snmpCommunityClear) hint = 'Community will be removed';
    else if (host.snmpCommunity) hint = 'New community will be saved';
    else if (saved) hint = 'Community saved';
    const clear = saved && !host.snmpCommunityClear
      ? `<button type="button" data-action="clear-snmp-community" data-index="${index}" class="text-[10px] text-slate-400 hover:text-red-400 text-left">Clear community</button>`
      : '';
    return `
            <div class="flex items-center gap-1 mt-1 pt-1 border-t border-slate-700">
              <label class="flex items-center gap-1 text-[10px] text-slate-400"><input type="checkbox" data-field="snmpEnabled" data-index="${index}" ${snmp.enabled ? 'checked' : ''}> SNMP</label>
              <input data-field="snmpPort" data-index="${index}" value="${escapeHtml(String(snmp.port || DEFAULT_PORT))}" class="bg-slate-900 border border-slate-600 rounded px-2 py-1 w-14 text-xs font-mono" title="SNMP port">
            </div>
            <input type="password" data-field="snmpCommunity" data-index="${index}" value="" autocomplete="new-password" placeholder="SNMP community" class="bg-slate-900 border border-slate-600 rounded px-2 py-1 w-full text-xs">
            ${hint ? `<p class="text-[10px] text-emerald-400">${escapeHtml(hint)}</p>` : ''}${clear}`;
  }

  function ensureSettings(host) {
    if (!isObject(host.snmp)) host.snmp = { enabled: false, port: DEFAULT_PORT, version: '2c' };
    return host.snmp;
  }

  // Returns true when the field belongs to SNMP.
  function applyAdminField(host, field, input) {
    if (field === 'snmpEnabled') {
      ensureSettings(host).enabled = !!input.checked;
      return true;
    }
    if (field === 'snmpPort') {
      const port = parseInt(input.value, 10);
      ensureSettings(host).port = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT;
      return true;
    }
    if (field === 'snmpCommunity') {
      if (input.value) {
        host.snmpCommunity = input.value;
        delete host.snmpCommunityClear;
      }
      return true;
    }
    return false;
  }

  function clearCommunity(host) {
    delete host.snmpCommunity;
    delete host.snmpSecret;
    host.snmpCommunityClear = true;
  }

  // ---- Browser-only glue ----

  function api() {
    return typeof window !== 'undefined' && window.desktopAPI && window.desktopAPI.snmp
      ? window.desktopAPI.snmp
      : null;
  }

  function attach(onUpdate) {
    state.onUpdate = onUpdate;
    const bridge = api();
    if (!bridge || state.unsubscribe) return;
    state.unsubscribe = bridge.onData((payload) => {
      if (!accept(payload)) return;
      const el = document.getElementById('node-' + payload.id);
      if (el) el.title = tooltip(payload);
      if (typeof state.onUpdate === 'function') state.onUpdate(payload);
    });
  }

  async function start(doc) {
    const bridge = api();
    if (!bridge) return;
    const request = startRequest(doc);
    const enabled = new Set(request.nodes.map((node) => node.id));
    Array.from(state.data.keys()).forEach((id) => {
      if (!enabled.has(id)) state.data.delete(id);
    });
    try {
      await bridge.start(request);
    } catch (error) {
      console.error('SNMP start failed:', error);
    }
  }

  async function stop() {
    const bridge = api();
    if (!bridge) return;
    try {
      await bridge.stop();
    } catch (error) {
      console.error('SNMP stop failed:', error);
    }
  }

  function decorateNode(el, nodeId) {
    const data = state.data.get(nodeId);
    if (el && data) el.title = tooltip(data);
  }

  // Color and thicken a drawn link by load, and allow editing its interface.
  function decorateLink(group, conn, doc, onEdit) {
    if (!group || !conn) return;
    const load = linkLoad(conn, doc, state.data);
    const style = load ? loadStyle(load.utilization) : null;
    if (style) {
      group.querySelectorAll('path:not(.connection-hitbox)').forEach((path) => {
        path.setAttribute('stroke', style.color);
        path.setAttribute('stroke-width', String(style.width));
      });
    }
    if (load) {
      const owner = ((doc && doc.nodes) || []).find((node) => node.id === load.nodeId);
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = loadText(load, owner && (owner.name || owner.id));
      group.appendChild(title);
    }
    if (typeof onEdit === 'function') {
      group.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        editLinkInterface(conn, doc).then((changed) => {
          if (changed) onEdit();
        });
      });
    }
  }

  // Resolves true when the link changed.
  async function editLinkInterface(conn, doc) {
    const dialog = globalThis.AppDialog;
    if (!dialog) return false;
    const nodes = (doc && doc.nodes) || [];
    const owners = [conn.sourceNodeId, conn.targetNodeId]
      .map((id) => nodes.find((node) => node.id === id))
      .filter((node) => node && isObject(node.snmp) && node.snmp.enabled);
    if (owners.length === 0) {
      await dialog.alert('Enable SNMP on one end of this link first.');
      return false;
    }
    const owner = owners.find((node) => node.id === conn.snmpNodeId) || owners[0];
    const current = Number.isInteger(conn.snmpIfIndex) ? String(conn.snmpIfIndex) : (conn.snmpIfName || '');
    const answer = await dialog.prompt(
      'SNMP interface on "' + (owner.name || owner.id) + '" for this link (ifIndex or name). Leave empty to match by port name.',
      { defaultValue: current }
    );
    if (answer === null) return false;
    const value = answer.trim();
    delete conn.snmpIfIndex;
    delete conn.snmpIfName;
    delete conn.snmpNodeId;
    if (value) {
      if (/^\d+$/.test(value)) conn.snmpIfIndex = Number(value);
      else conn.snmpIfName = value.slice(0, 64);
      conn.snmpNodeId = owner.id;
    }
    return true;
  }

  // ---- Node modal ----

  function byId(id) {
    return typeof document !== 'undefined' ? document.getElementById(id) : null;
  }

  function refreshFormHint(saved) {
    const hint = byId('snmp-community-hint');
    const clear = byId('snmp-community-clear');
    const text = state.formClear ? 'Community will be removed' : (saved ? 'Community saved. Leave blank to keep it.' : '');
    if (hint) {
      hint.textContent = text;
      hint.classList.toggle('hidden', !text);
    }
    if (clear) clear.classList.toggle('hidden', state.formClear || !saved);
  }

  function fillForm(node) {
    const snmp = node && isObject(node.snmp) ? node.snmp : {};
    const enabled = byId('snmp-enabled');
    const port = byId('snmp-port');
    const community = byId('snmp-community');
    if (enabled) enabled.checked = snmp.enabled === true;
    if (port) port.value = snmp.port || DEFAULT_PORT;
    if (community) community.value = '';
    state.formClear = false;
    refreshFormHint(!!(node && isObject(node.snmpSecret) && node.snmpSecret.type === 'community'));
  }

  function clearFormCommunity() {
    state.formClear = true;
    const community = byId('snmp-community');
    if (community) community.value = '';
    refreshFormHint(false);
  }

  // Copies the form into nodeData. Returns an error message, or '' when valid.
  function readForm(nodeData) {
    const enabled = byId('snmp-enabled');
    if (!enabled) return '';
    const portText = String((byId('snmp-port') || {}).value || '').trim();
    const port = portText ? Number(portText) : DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'SNMP port must be between 1 and 65535';
    const community = (byId('snmp-community') || {}).value || '';
    const previous = isObject(nodeData.snmp) ? nodeData.snmp : null;
    if (enabled.checked || previous || community) {
      nodeData.snmp = { enabled: enabled.checked, port: port, version: '2c' };
    }
    delete nodeData.snmpCommunity;
    delete nodeData.snmpCommunityClear;
    if (state.formClear) {
      delete nodeData.snmpSecret;
      nodeData.snmpCommunityClear = true;
    } else if (community) {
      nodeData.snmpCommunity = community;
    }
    return '';
  }

  return {
    DEFAULT_PORT: DEFAULT_PORT,
    isEnabled: isEnabled,
    intervalSecs: intervalSecs,
    startRequest: startRequest,
    formatBps: formatBps,
    formatUptime: formatUptime,
    linkInterface: linkInterface,
    linkLoad: linkLoad,
    loadStyle: loadStyle,
    loadText: loadText,
    tooltip: tooltip,
    accept: accept,
    adminCell: adminCell,
    applyAdminField: applyAdminField,
    clearCommunity: clearCommunity,
    attach: attach,
    start: start,
    stop: stop,
    decorateNode: decorateNode,
    decorateLink: decorateLink,
    editLinkInterface: editLinkInterface,
    fillForm: fillForm,
    clearFormCommunity: clearFormCommunity,
    readForm: readForm,
    _state: state
  };
});
