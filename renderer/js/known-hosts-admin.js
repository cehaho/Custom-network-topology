// "SSH host keys" section of the Admin panel.
//
// Lists the pinned keys of known_hosts.json (no full key, only algorithm and
// SHA256 fingerprint), forgets one after confirmation, and imports an OpenSSH
// known_hosts file. The import never replaces a pinned key: conflicts are
// reported and left as they are.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.KnownHostsAdmin = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // `host:port`, with brackets around an IPv6 literal.
  function hostPort(host, port) {
    const text = String(host || '');
    return (text.includes(':') ? '[' + text + ']' : text) + ':' + port;
  }

  function filterEntries(entries, query) {
    const list = Array.isArray(entries) ? entries : [];
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return list.slice();
    return list.filter((entry) => {
      const haystack = [
        hostPort(entry.host, entry.port),
        entry.algorithm,
        entry.fingerprint
      ].join(' ').toLowerCase();
      return needle.split(/\s+/).every((word) => haystack.includes(word));
    });
  }

  function formatAdded(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }

  function plural(count, word, many) {
    return count + ' ' + (count === 1 ? word : (many || word + 's'));
  }

  // Lines of text describing an import summary.
  function summaryLines(summary) {
    const s = summary || {};
    const lines = [];
    lines.push('Imported ' + plural(s.imported || 0, 'host key') + '.');
    if (s.alreadyKnown) lines.push(plural(s.alreadyKnown, 'host') + ' already known.');
    if (s.skippedHashed) lines.push('Skipped ' + plural(s.skippedHashed, 'hashed entry', 'hashed entries') + ' (host names cannot be recovered).');
    if (s.skippedMarkers) lines.push('Skipped ' + plural(s.skippedMarkers, '@cert-authority / @revoked line') + '.');
    if (s.skippedInvalid) lines.push('Skipped ' + plural(s.skippedInvalid, 'invalid or unsupported line') + '.');
    const conflicts = Array.isArray(s.conflicts) ? s.conflicts : [];
    if (conflicts.length) {
      lines.push(plural(conflicts.length, 'conflict') + ' left unchanged (forget the stored key first to replace it):');
      conflicts.forEach((conflict) => {
        lines.push('  ' + hostPort(conflict.host, conflict.port)
          + ': stored ' + conflict.storedFingerprint
          + ', file ' + conflict.importedFingerprint);
      });
    }
    return lines;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function api() {
    const desktop = typeof window !== 'undefined' ? window.desktopAPI : null;
    return desktop && desktop.ssh && desktop.ssh.listHostKeys ? desktop.ssh : null;
  }

  // Renders the section into `container` and loads the entries.
  function mount(container) {
    if (!container) return;
    const state = { entries: [], query: '' };
    container.innerHTML = `
      <div class="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden shadow-xl mt-6">
        <div class="flex justify-between items-center gap-4 flex-wrap p-4 border-b border-slate-700">
          <div>
            <h2 class="text-lg font-bold text-white">SSH host keys</h2>
            <p class="text-slate-400 text-xs mt-1">Keys pinned on first connection (known_hosts.json). A forgotten host asks for confirmation again on the next connection.</p>
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <input id="kh-filter" type="search" placeholder="Filter host, algorithm, fingerprint" class="bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm w-64">
            <button id="kh-import" class="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg text-sm">
              <i data-lucide="file-key" class="w-4 h-4"></i> Import from OpenSSH known_hosts…
            </button>
          </div>
        </div>
        <pre id="kh-summary" class="hidden m-4 p-3 bg-slate-900/60 border border-slate-700 rounded text-xs text-slate-300 whitespace-pre-wrap"></pre>
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead class="bg-slate-900/50 text-slate-400 uppercase text-xs font-bold tracking-wider">
              <tr>
                <th class="p-3">Host</th>
                <th class="p-3">Port</th>
                <th class="p-3">Algorithm</th>
                <th class="p-3">Fingerprint (SHA256)</th>
                <th class="p-3">Added</th>
                <th class="p-3"></th>
              </tr>
            </thead>
            <tbody id="kh-list"></tbody>
          </table>
        </div>
      </div>`;
    const tbody = container.querySelector('#kh-list');
    const filter = container.querySelector('#kh-filter');
    const summary = container.querySelector('#kh-summary');
    const importButton = container.querySelector('#kh-import');

    function message(text) {
      tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-sm text-slate-500">${escapeHtml(text)}</td></tr>`;
    }

    function render() {
      const shown = filterEntries(state.entries, state.query);
      if (!state.entries.length) return message('No SSH host key is stored yet.');
      if (!shown.length) return message('No host key matches the filter.');
      tbody.innerHTML = shown.map((entry) => `
        <tr class="border-b border-slate-700 hover:bg-slate-700/30">
          <td class="p-3 text-sm font-mono text-slate-200">${escapeHtml(entry.host)}</td>
          <td class="p-3 text-sm font-mono">${escapeHtml(entry.port)}</td>
          <td class="p-3 text-xs">${escapeHtml(entry.algorithm)}</td>
          <td class="p-3 text-xs font-mono break-all">${escapeHtml(entry.fingerprint)}</td>
          <td class="p-3 text-xs text-slate-400">${escapeHtml(formatAdded(entry.addedAt))}</td>
          <td class="p-3 text-right">
            <button data-host="${escapeHtml(entry.host)}" data-port="${escapeHtml(entry.port)}" class="kh-forget text-slate-400 hover:text-red-400 text-xs px-2 py-1 border border-slate-600 rounded">Forget</button>
          </td>
        </tr>`).join('');
      tbody.querySelectorAll('.kh-forget').forEach((button) => {
        button.addEventListener('click', () => forget(button.dataset.host, Number(button.dataset.port)));
      });
    }

    async function load() {
      const ssh = api();
      if (!ssh) return message('Host keys are available in the desktop app only.');
      try {
        const result = await ssh.listHostKeys();
        if (!result || result.success === false) {
          return message((result && result.error) || 'Failed to read the host keys.');
        }
        state.entries = Array.isArray(result.entries) ? result.entries : [];
        render();
      } catch (error) {
        message('Failed to read the host keys: ' + error);
      }
    }

    async function forget(host, port) {
      const ssh = api();
      if (!ssh) return;
      const question = 'Forget the stored host key of ' + hostPort(host, port)
        + '? The next connection will ask you to confirm the server fingerprint again.';
      if (!window.confirm(question)) return;
      const result = await ssh.forgetHostKey(host, port);
      if (!result || result.success === false) {
        alert((result && result.error) || 'Failed to forget the host key.');
      }
      await load();
    }

    async function importFile() {
      const ssh = api();
      if (!ssh) return;
      importButton.disabled = true;
      try {
        const result = await ssh.importOpenSshKnownHosts();
        if (!result || result.canceled) return;
        summary.classList.remove('hidden');
        summary.textContent = result.success === false
          ? (result.error || 'Import failed.')
          : summaryLines(result.summary).join('\n');
        await load();
      } finally {
        importButton.disabled = false;
      }
    }

    filter.addEventListener('input', () => {
      state.query = filter.value;
      render();
    });
    importButton.addEventListener('click', importFile);
    if (!api()) importButton.disabled = true;
    load();
  }

  return {
    hostPort: hostPort,
    filterEntries: filterEntries,
    formatAdded: formatAdded,
    summaryLines: summaryLines,
    mount: mount
  };
});
