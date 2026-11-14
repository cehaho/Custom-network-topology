// Desktop bridge exposed to the renderer as window.desktopAPI.
// Inside Tauri this object calls invoke and events. In a browser it stays absent.
(function () {
  if (!window.__TAURI__ || !window.__TAURI__.core || !window.__TAURI__.event) return;

  const invoke = window.__TAURI__.core.invoke.bind(window.__TAURI__.core);
  const listen = window.__TAURI__.event.listen.bind(window.__TAURI__.event);

  function subscribe(eventName, callback) {
    let unsubscribe = null;
    let stopped = false;
    listen(eventName, (event) => {
      callback(event.payload);
    }).then((stop) => {
      unsubscribe = stop;
      if (stopped && typeof stop === 'function') stop();
    }).catch(() => {});
    return () => {
      stopped = true;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }

  const userAgent = navigator.userAgent || '';
  const platform = /Windows/i.test(userAgent) ? 'win32' : /Mac/i.test(userAgent) ? 'darwin' : 'linux';

  window.desktopAPI = {
    config: {
      load: () => invoke('config_load'),
      save: (config, importToken) => invoke('config_save', { config, importToken: importToken || null }),
      export: (config) => invoke('config_export', { config }),
      import: () => invoke('config_import'),
      discardImport: () => invoke('config_discard_import')
    },
    ssh: {
      connect: (connectionInfo) => invoke('ssh_connect', { connectionInfo }),
      write: (nodeId, data) => invoke('ssh_write', { nodeId, data }),
      resize: (nodeId, cols, rows) => invoke('ssh_resize', { nodeId, cols, rows }),
      disconnect: (nodeId) => invoke('ssh_disconnect', { nodeId }),
      forgetHostKey: (host, port) => invoke('ssh_forget_host_key', { host, port }),
      listHostKeys: () => invoke('ssh_known_hosts_list'),
      importOpenSshKnownHosts: () => invoke('ssh_known_hosts_import_openssh'),
      browseKey: () => invoke('ssh_browse_key'),
      onData: (callback) => subscribe('ssh-data', callback),
      onClosed: (callback) => subscribe('ssh-closed', callback)
    },
    network: {
      getLocalInfo: () => invoke('network_local_info'),
      ping: (host) => invoke('network_ping', { host }),
      scan: (baseIp, startRange, endRange) => invoke('network_scan', { baseIp, startRange, endRange }),
      arp: () => invoke('network_arp'),
      neighbors: () => invoke('network_neighbors'),
      enrich: (hosts) => invoke('network_enrich', { hosts }),
      onEnrichResult: (callback) => subscribe('network-enrich-result', callback),
      onScanProgress: (callback) => subscribe('network-scan-progress', callback)
    },
    image: {
      export: (format, data, fileName) => invoke('image_export', { format, data, fileName })
    },
    monitor: {
      start: (config) => invoke('monitor_start', { config }),
      stop: () => invoke('monitor_stop'),
      onStatus: (callback) => subscribe('monitor-status', callback)
    },
    alerts: {
      notify: (title, body) => invoke('alerts_notify', { title, body })
    },
    platform,
    isDesktop: true
  };
})();
