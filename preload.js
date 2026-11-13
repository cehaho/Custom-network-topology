const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  config: {
    load: () => ipcRenderer.invoke('config:load'),
    save: (config) => ipcRenderer.invoke('config:save', config),
    export: (config) => ipcRenderer.invoke('config:export', config),
    import: () => ipcRenderer.invoke('config:import')
  },

  ssh: {
    connect: (connectionInfo) => ipcRenderer.invoke('ssh:connect', connectionInfo),
    write: (nodeId, data) => ipcRenderer.invoke('ssh:write', { nodeId, data }),
    resize: (nodeId, cols, rows) => ipcRenderer.invoke('ssh:resize', { nodeId, cols, rows }),
    disconnect: (nodeId) => ipcRenderer.invoke('ssh:disconnect', nodeId),
    browseKey: () => ipcRenderer.invoke('ssh:browseKey'),

    onData: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('ssh:data', handler);
      return () => ipcRenderer.removeListener('ssh:data', handler);
    },
    onClosed: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('ssh:closed', handler);
      return () => ipcRenderer.removeListener('ssh:closed', handler);
    }
  },

  network: {
    getLocalInfo: () => ipcRenderer.invoke('network:getLocalInfo'),
    ping: (host) => ipcRenderer.invoke('network:ping', host),
    scan: (baseIp, startRange, endRange) => ipcRenderer.invoke('network:scan', { baseIp, startRange, endRange }),
    arp: () => ipcRenderer.invoke('network:arp'),

    onScanProgress: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('network:scanProgress', handler);
      return () => ipcRenderer.removeListener('network:scanProgress', handler);
    }
  },

  monitor: {
    start: (config) => ipcRenderer.invoke('monitor:start', config),
    stop: () => ipcRenderer.invoke('monitor:stop'),

    onStatus: (callback) => {
      const handler = (event, data) => callback(data);
      ipcRenderer.on('monitor:status', handler);
      return () => ipcRenderer.removeListener('monitor:status', handler);
    }
  },

  platform: process.platform,
  isElectron: true
});
