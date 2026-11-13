// Admin table. Embedded in the canvas it edits the document already in memory.
// Opened on its own, it reads and writes that same document.
(function () {
  'use strict';

  let hooks = null;
  let standaloneDocument = null;
  let dirty = false;
  let root = null;
  let importToken = null;

  function current() {
    return hooks && hooks.getDocument ? hooks.getDocument() : standaloneDocument;
  }

  function markDirty() {
    dirty = true;
  }

  function open(options) {
    hooks = options || {};
    dirty = false;
    root = document.getElementById('admin-root');
    if (!root) return;
    root.innerHTML = shell();
    root.classList.add('open');
    bind();
    render();
    if (window.lucide) lucide.createIcons();
  }

  async function requestClose() {
    if (dirty) {
      const saved = await persist();
      if (!saved) return;
    }
    if (root) {
      root.classList.remove('open');
      root.innerHTML = '';
    }
    const onClose = hooks && hooks.onClose;
    hooks = null;
    if (onClose) onClose();
  }

  async function startStandalone() {
    standaloneDocument = Topology.emptyDocument();
    hooks = {
      embedded: false,
      getDocument: () => standaloneDocument,
      replaceDocument: (document) => {
        standaloneDocument = document;
      },
      persist: persistStandalone,
      importDocument: importStandalone
    };
    try {
      let raw = null;
      if (window.electronAPI) raw = await window.electronAPI.config.load();
      else {
        const response = await fetch('config.json');
        if (response.ok) raw = await response.json();
      }
      if (raw && raw.success === false) {
        alert(raw.error || 'The topology file was not changed');
      } else if (raw) {
        const loaded = Topology.read(raw);
        if (!loaded.ok) {
          alert(loaded.error);
        } else {
          standaloneDocument = loaded.document;
          if (loaded.changed && window.electronAPI) {
            const saved = await window.electronAPI.config.save(standaloneDocument, null);
            if (saved && saved.success !== false && saved.config) {
              const again = Topology.read(saved.config);
              if (again.ok) standaloneDocument = again.document;
            }
          }
        }
      }
    } catch (error) {
      console.error(error);
    }
    open(hooks);
  }

  function shell() {
    return `
      <div class="max-w-[1600px] mx-auto p-6">
        <div class="flex justify-between items-center mb-6 gap-4 flex-wrap">
          <div class="flex items-center gap-4">
            <button id="admin-back" class="p-2 hover:bg-slate-800 rounded-lg transition" title="Back to canvas">
              <i data-lucide="arrow-left" class="w-5 h-5"></i>
            </button>
            <div>
              <h1 class="text-2xl font-bold text-white">Network Topology Admin</h1>
              <p class="text-slate-400 text-sm mt-1">Same topology as the canvas. Links, ports, containers, and zones stay in the document.</p>
            </div>
          </div>
          <div class="flex items-center gap-4 flex-wrap">
            <div class="flex items-center gap-4 bg-slate-800/50 px-4 py-2 rounded-lg border border-slate-700">
              <label class="flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" id="showGridCheck" class="w-4 h-4 rounded bg-slate-700 border-slate-500">
                Show Grid
              </label>
              <label class="flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" id="snapToGridCheck" class="w-4 h-4 rounded bg-slate-700 border-slate-500">
                Snap to Grid
              </label>
              <label class="flex items-center gap-2 text-sm text-slate-300">
                Probe
                <input type="number" id="probeIntervalSeconds" min="1" max="60" step="1" class="w-16 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm">
                s
              </label>
            </div>
            <button id="admin-import" class="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg text-sm">
              <i data-lucide="upload" class="w-4 h-4"></i> Import
            </button>
            <button id="admin-export" class="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-bold">
              <i data-lucide="download" class="w-4 h-4"></i> Export
            </button>
            <button id="admin-save" class="flex items-center gap-2 bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded-lg text-sm font-bold">
              <i data-lucide="save" class="w-4 h-4"></i> Save
            </button>
          </div>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div class="bg-slate-800/50 rounded-lg p-4 border border-slate-700"><div class="text-sm text-slate-400">Total Nodes</div><div id="stat-total" class="text-2xl font-bold text-white">0</div></div>
          <div class="bg-slate-800/50 rounded-lg p-4 border border-slate-700"><div class="text-sm text-slate-400">Root Nodes</div><div id="stat-roots" class="text-2xl font-bold text-blue-400">0</div></div>
          <div class="bg-slate-800/50 rounded-lg p-4 border border-slate-700"><div class="text-sm text-slate-400">With Failover</div><div id="stat-failover" class="text-2xl font-bold text-yellow-400">0</div></div>
          <div class="bg-slate-800/50 rounded-lg p-4 border border-slate-700"><div class="text-sm text-slate-400">SSH Configured</div><div id="stat-ssh" class="text-2xl font-bold text-green-400">0</div></div>
        </div>
        <div class="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden shadow-xl">
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse min-w-[1100px]">
              <thead class="bg-slate-900/50 text-slate-400 uppercase text-xs font-bold tracking-wider">
                <tr>
                  <th class="p-4">Node Name</th>
                  <th class="p-4">IP Address / Port</th>
                  <th class="p-4">Links</th>
                  <th class="p-4">Cable</th>
                  <th class="p-4">SSH</th>
                  <th class="p-4">Icon</th>
                  <th class="p-4 text-center">Preview</th>
                  <th class="p-4"></th>
                </tr>
              </thead>
              <tbody id="hostList"></tbody>
            </table>
          </div>
          <div class="p-4 bg-slate-900/30 border-t border-slate-700">
            <button id="admin-add" class="w-full py-3 border-2 border-dashed border-slate-600 text-slate-500 rounded-lg hover:border-blue-500 hover:text-blue-400">Add New Device Node</button>
          </div>
        </div>
      </div>`;
  }

  function bind() {
    const doc = current();
    const settings = (doc && doc.settings) || {};
    document.getElementById('showGridCheck').checked = settings.showGrid !== false;
    document.getElementById('snapToGridCheck').checked = settings.snapToGrid !== false;
    document.getElementById('showGridCheck').addEventListener('change', (event) => {
      current().settings.showGrid = event.target.checked;
      markDirty();
    });
    document.getElementById('snapToGridCheck').addEventListener('change', (event) => {
      current().settings.snapToGrid = event.target.checked;
      markDirty();
    });
    const intervalInput = document.getElementById('probeIntervalSeconds');
    const intervalMs = Probe.monitoringInterval(settings.probeIntervalMs);
    intervalInput.value = String(intervalMs / 1000);
    intervalInput.addEventListener('change', (event) => {
      const seconds = Number(event.target.value);
      const ms = Probe.monitoringInterval(Number.isFinite(seconds) ? seconds * 1000 : NaN);
      const doc = current();
      if (!doc.settings || typeof doc.settings !== 'object') doc.settings = {};
      doc.settings.probeIntervalMs = ms;
      event.target.value = String(ms / 1000);
      markDirty();
    });
    document.getElementById('admin-back').addEventListener('click', () => {
      if (hooks && hooks.embedded) requestClose();
      else leaveStandalone();
    });
    document.getElementById('admin-save').addEventListener('click', persist);
    document.getElementById('admin-export').addEventListener('click', exportDocument);
    document.getElementById('admin-import').addEventListener('click', importDocument);
    document.getElementById('admin-add').addEventListener('click', addRow);
  }

  function render() {
    const doc = current();
    const tbody = document.getElementById('hostList');
    if (!doc || !tbody) return;
    tbody.innerHTML = '';
    doc.nodes.forEach((host, index) => {
      const primary = Topology.parentNodeId(doc, host.id, 'primary') || '';
      const failover = Topology.parentNodeId(doc, host.id, 'failover') || '';
      const cable = Topology.primaryCable(doc, host.id);
      const medium = (cable && cable.medium) || host.linkType || '';
      const speed = (cable && cable.speed) || host.linkSpeed || '';
      const row = document.createElement('tr');
      row.className = 'border-b border-slate-700 hover:bg-slate-700/30';
      row.innerHTML = `
        <td class="p-3 align-top"><input data-field="name" data-index="${index}" value="${escapeHtml(host.name)}" class="bg-slate-900 border border-slate-600 rounded px-3 py-2 w-full text-sm text-slate-200"></td>
        <td class="p-3 align-top">
          <div class="flex gap-2">
            <input data-field="address" data-index="${index}" value="${escapeHtml(host.address)}" class="bg-slate-900 border border-slate-600 rounded px-2 py-2 w-28 text-sm font-mono" placeholder="IP">
            <input data-field="port" data-index="${index}" value="${host.port || ''}" class="bg-slate-900 border border-slate-600 rounded px-2 py-2 w-16 text-sm font-mono" placeholder="Port">
          </div>
        </td>
        <td class="p-3 align-top">
          <div class="flex flex-col gap-2">
            <label class="flex items-center gap-1 text-[10px] text-slate-500">Pri
              <select data-field="primary" data-index="${index}" class="bg-slate-900 border border-slate-600 rounded px-2 py-1.5 flex-1 text-xs">${parentOptions(doc, host.id, primary)}</select>
            </label>
            <label class="flex items-center gap-1 text-[10px] text-yellow-500">Fail
              <select data-field="failover" data-index="${index}" class="bg-slate-900 border border-slate-600 rounded px-2 py-1.5 flex-1 text-xs">${parentOptions(doc, host.id, failover)}</select>
            </label>
          </div>
        </td>
        <td class="p-3 align-top">
          <div class="flex flex-col gap-1">
            ${choice('medium', index, medium, ['', 'RJ45', 'DAC', 'Fiber', 'WiFi'], 'Type')}
            ${choice('speed', index, speed, ['', '100M', '1G', '2.5G', '5G', '10G', '25G', '40G', '100G'], 'Speed')}
          </div>
        </td>
        <td class="p-3 align-top">
          <div class="flex flex-col gap-1">
            <div class="flex gap-1">
              <input data-field="sshPort" data-index="${index}" value="${host.sshPort || 22}" class="bg-slate-900 border border-slate-600 rounded px-2 py-1 w-14 text-xs font-mono">
              <input data-field="sshUser" data-index="${index}" value="${escapeHtml(host.sshUser)}" class="bg-slate-900 border border-slate-600 rounded px-2 py-1 flex-1 text-xs" placeholder="User">
            </div>
            <select data-field="sshAuth" data-index="${index}" class="bg-slate-900 border border-slate-600 rounded px-2 py-1 w-full text-xs">
              <option value="password" ${host.sshAuth === 'key' ? '' : 'selected'}>Password</option>
              <option value="key" ${host.sshAuth === 'key' ? 'selected' : ''}>Private key</option>
            </select>
            <input type="password" data-field="sshPass" data-index="${index}" value="" autocomplete="new-password" placeholder="${host.sshAuth === 'key' ? 'Key passphrase' : 'Password'}" class="bg-slate-900 border border-slate-600 rounded px-2 py-1 w-full text-xs">
            ${secretLine(host, index)}
          </div>
        </td>
        <td class="p-3 align-top">
          <div class="flex gap-1">
            <select data-field="iconType" data-index="${index}" class="bg-slate-900 border border-slate-600 rounded text-xs p-1.5 w-16">
              <option value="lucide" ${host.iconType === 'lucide' ? 'selected' : ''}>Icon</option>
              <option value="url" ${host.iconType === 'url' ? 'selected' : ''}>URL</option>
              <option value="svg" ${host.iconType === 'svg' ? 'selected' : ''}>SVG</option>
            </select>
            <input data-field="icon" data-index="${index}" value="${escapeHtml(host.icon)}" class="bg-slate-900 border border-slate-600 rounded px-2 py-1.5 flex-1 text-xs">
          </div>
        </td>
        <td class="p-3 text-center align-top"><div class="w-10 h-10 bg-slate-800 rounded-full flex items-center justify-center border border-slate-600 mx-auto overflow-hidden">${iconPreview(host)}</div></td>
        <td class="p-3 text-right align-top">
          <button data-action="duplicate" data-index="${index}" class="text-slate-500 hover:text-blue-400 p-1.5" title="Duplicate"><i data-lucide="copy" class="w-4 h-4"></i></button>
          <button data-action="delete" data-index="${index}" class="text-slate-500 hover:text-red-400 p-1.5" title="Delete"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
        </td>`;
      tbody.appendChild(row);
    });
    tbody.querySelectorAll('input, select').forEach((field) => {
      field.addEventListener('change', onField);
    });
    tbody.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', onAction);
    });
    const sshCount = doc.nodes.filter((node) => node.sshUser).length;
    const roots = doc.nodes.filter((node) => !Topology.parentNodeId(doc, node.id, 'primary')).length;
    const failoverCount = doc.nodes.filter((node) => Topology.parentNodeId(doc, node.id, 'failover')).length;
    document.getElementById('stat-total').textContent = String(doc.nodes.length);
    document.getElementById('stat-roots').textContent = String(roots);
    document.getElementById('stat-failover').textContent = String(failoverCount);
    document.getElementById('stat-ssh').textContent = String(sshCount);
    if (window.lucide) lucide.createIcons();
  }

  function parentOptions(doc, nodeId, selected) {
    let html = `<option value="" ${selected ? '' : 'selected'}>No parent</option>`;
    doc.nodes.forEach((node) => {
      if (node.id === nodeId) return;
      html += `<option value="${escapeHtml(node.id)}" ${selected === node.id ? 'selected' : ''}>${escapeHtml(node.name || node.id)}</option>`;
    });
    return html;
  }

  function choice(field, index, selected, values, placeholder) {
    const options = values.map((value) => {
      const label = value || placeholder;
      return `<option value="${escapeHtml(value)}" ${selected === value ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
    return `<select data-field="${field}" data-index="${index}" class="bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs">${options}</select>`;
  }

  function secretLine(host, index) {
    const hint = Topology.secretHint(host);
    if (!hint) return '';
    const clear = Topology.secretType(host) && !host.sshSecretClear
      ? `<button type="button" data-action="clear-secret" data-index="${index}" class="text-[10px] text-slate-400 hover:text-red-400 text-left">Clear saved secret</button>`
      : '';
    return `<p class="text-[10px] text-emerald-400">${escapeHtml(hint)}</p>${clear}`;
  }

  function onField(event) {
    const doc = current();
    const index = Number(event.target.dataset.index);
    const field = event.target.dataset.field;
    const host = doc.nodes[index];
    if (!host) return;
    let value = event.target.value;
    if (field === 'primary' || field === 'failover') {
      Topology.setParent(doc, host.id, field === 'primary' ? 'primary' : 'failover', value || null);
    } else if (field === 'medium' || field === 'speed') {
      const cable = Topology.primaryCable(doc, host.id);
      const medium = field === 'medium' ? value : ((cable && cable.medium) || host.linkType || '');
      const speed = field === 'speed' ? value : ((cable && cable.speed) || host.linkSpeed || '');
      Topology.setCable(doc, host.id, medium, speed);
    } else if (field === 'port' || field === 'sshPort') {
      host[field] = value === '' ? null : parseInt(value, 10);
    } else if (field === 'sshAuth') {
      host.sshAuth = value === 'key' ? 'key' : 'password';
    } else if (field === 'sshPass') {
      Topology.acceptSecretEdit(host, value);
    } else {
      host[field] = value;
    }
    markDirty();
    render();
  }

  function onAction(event) {
    const button = event.currentTarget;
    const index = Number(button.dataset.index);
    if (button.dataset.action === 'duplicate') duplicateRow(index);
    if (button.dataset.action === 'delete') removeRow(index);
    if (button.dataset.action === 'clear-secret') {
      const doc = current();
      const host = doc && doc.nodes[index];
      if (!host) return;
      Topology.clearStoredSecret(host);
      markDirty();
      render();
    }
  }

  function addRow() {
    const doc = current();
    const node = Topology.createNode({});
    const column = doc.nodes.length % 10;
    const row = Math.floor(doc.nodes.length / 10);
    node.x = (column * 10) + 5;
    node.y = (row * 15) + 10;
    doc.nodes.push(node);
    doc.ports = Topology.collectPorts(doc.nodes);
    markDirty();
    render();
  }

  function duplicateRow(index) {
    const doc = current();
    const original = doc.nodes[index];
    if (!original) return;
    const id = 'node_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const copy = JSON.parse(JSON.stringify(original));
    copy.id = id;
    copy.name = (original.name || 'Unnamed') + ' (copy)';
    Topology.forgetInheritedSecret(copy);
    delete copy.primaryParentId;
    delete copy.secondaryParentId;
    delete copy.activeParentId;
    delete copy.status;
    delete copy.uptime;
    delete copy.level;
    delete copy.responseTime;
    if (Array.isArray(copy.ports)) {
      copy.ports = copy.ports.map((port, portIndex) => Object.assign({}, port, { id: id + '_port_' + portIndex }));
    }
    if (typeof copy.x === 'number') copy.x = Math.min(95, copy.x + 5);
    if (typeof copy.y === 'number') copy.y = Math.min(95, copy.y + 5);
    doc.nodes.push(copy);
    const primary = Topology.parentNodeId(doc, original.id, 'primary');
    const failover = Topology.parentNodeId(doc, original.id, 'failover');
    if (primary && primary !== id) Topology.setParent(doc, id, 'primary', primary);
    if (failover && failover !== id) Topology.setParent(doc, id, 'failover', failover);
    const cable = Topology.primaryCable(doc, original.id);
    if (cable) Topology.setCable(doc, id, cable.medium, cable.speed);
    doc.ports = Topology.collectPorts(doc.nodes);
    markDirty();
    render();
  }

  function removeRow(index) {
    const doc = current();
    const host = doc.nodes[index];
    if (!host) return;
    if (!window.confirm('Delete "' + (host.name || host.id) + '"?')) return;
    Topology.removeNode(doc, host.id);
    markDirty();
    render();
  }

  async function persist() {
    if (hooks && hooks.embedded && hooks.persist) {
      const result = await hooks.persist();
      if (result && result.success === false) {
        showToast('Failed to save: ' + result.error, 'error');
        return false;
      }
      dirty = false;
      showToast('Configuration saved', 'success');
      return true;
    }
    return persistStandalone();
  }

  async function persistStandalone() {
    const prepared = Topology.prepare(current());
    if (!prepared.ok) {
      showToast(prepared.error, 'error');
      return false;
    }
    if (window.electronAPI) {
      const result = await window.electronAPI.config.save(prepared.document, importToken);
      if (!result || result.success === false) {
        showToast('Failed to save: ' + ((result && result.error) || 'unknown error'), 'error');
        return false;
      }
      importToken = null;
      if (result.config) {
        const loaded = Topology.read(result.config);
        if (loaded.ok) {
          standaloneDocument = loaded.document;
          if (hooks && hooks.replaceDocument) hooks.replaceDocument(loaded.document);
        }
      }
    } else if (Topology.hasSecretValues(prepared.document)) {
      showToast('The system keyring is unavailable. The password was not saved.', 'error');
      return false;
    } else {
      standaloneDocument = Topology.withoutSecretValues(prepared.document);
      if (hooks && hooks.replaceDocument) hooks.replaceDocument(standaloneDocument);
      download(standaloneDocument);
    }
    dirty = false;
    showToast('Configuration saved', 'success');
    return true;
  }

  async function exportDocument() {
    const prepared = Topology.prepare(current());
    if (!prepared.ok) {
      showToast(prepared.error, 'error');
      return;
    }
    const exported = Topology.withoutSecretValues(prepared.document);
    if (window.electronAPI) await window.electronAPI.config.export(exported);
    else download(exported);
  }

  async function importDocument() {
    const imported = hooks && hooks.importDocument ? await hooks.importDocument() : null;
    if (!imported) return;
    if (hooks.replaceDocument) hooks.replaceDocument(imported);
    else standaloneDocument = imported;
    dirty = true;
    const saved = await persist();
    if (saved) render();
  }

  async function importStandalone() {
    if (window.electronAPI) {
      const result = await window.electronAPI.config.import();
      if (!result || result.canceled) return null;
      if (!result.success || !result.config) {
        alert((result && result.error) || 'Import failed');
        return null;
      }
      const loaded = Topology.read(result.config);
      if (!loaded.ok) {
        alert(loaded.error);
        return null;
      }
      if (!window.confirm(Topology.importMessage(loaded.document))) {
        importToken = null;
        if (window.electronAPI.config.discardImport) await window.electronAPI.config.discardImport();
        return null;
      }
      importToken = result.importToken || null;
      return loaded.document;
    }
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const loaded = Topology.read(JSON.parse(String(reader.result)));
            if (!loaded.ok) {
              alert(loaded.error);
              resolve(null);
              return;
            }
            if (Topology.hasSecretValues(loaded.document)) {
              alert('Passwords in this file were not imported. The system keyring is unavailable, so they were not saved.');
              loaded.document = Topology.withoutSecretValues(loaded.document);
              (loaded.document.nodes || []).forEach((node) => {
                delete node.sshSecret;
              });
            }
            if (!window.confirm(Topology.importMessage(loaded.document))) {
              resolve(null);
              return;
            }
            resolve(loaded.document);
          } catch (error) {
            alert('Invalid config file.');
            resolve(null);
          }
        };
        reader.readAsText(file);
      };
      input.click();
    });
  }

  async function leaveStandalone() {
    if (dirty) {
      const saved = await persistStandalone();
      if (!saved) return;
    }
    window.location.href = 'index.html';
  }

  function download(doc) {
    const link = document.createElement('a');
    link.href = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(doc, null, 2));
    link.download = 'config.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = 'fixed bottom-4 right-4 px-4 py-3 rounded-lg shadow-lg text-sm font-medium z-50 text-white '
      + (type === 'success' ? 'bg-green-600' : 'bg-red-600');
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeLucideName(name) {
    return /^[a-z0-9-]+$/i.test(name || '') ? name : 'circle';
  }

  function sanitizeSvg(svg) {
    if (typeof svg !== 'string') return '';
    const trimmed = svg.trim();
    if (!trimmed.startsWith('<svg') || !trimmed.endsWith('</svg>')) return '';
    if (/<script|<\/script|on\w+\s*=|javascript:|data:/i.test(trimmed)) return '';
    return trimmed;
  }

  function iconPreview(host) {
    if (host.iconType === 'url') {
      return `<img src="${escapeHtml(host.icon)}" class="w-full h-full object-cover" alt="">`;
    }
    if (host.iconType === 'svg') {
      return sanitizeSvg(host.icon) || '<div class="text-[8px] text-slate-500">SVG</div>';
    }
    return `<i data-lucide="${safeLucideName(host.icon)}" class="w-5 h-5 text-slate-400"></i>`;
  }

  window.Admin = {
    open: open,
    requestClose: requestClose,
    startStandalone: startStandalone
  };
})();
