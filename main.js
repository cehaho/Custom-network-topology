const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client } = require('ssh2');
const net = require('net');
const { execFile } = require('child_process');
const os = require('os');
const {
  isSafeHost,
  isSafeBaseIp,
  isSafePort,
  clampScanRange,
  pingArgs,
  monitoringInterval
} = require('./lib/hosts');

const sshConnections = new Map();
const MAX_CONFIG_BYTES = 5 * 1024 * 1024;

let mainWindow;
let monitoringIntervalId = null;
let monitoringConfig = null;

const getConfigPath = () => path.join(app.getPath('userData'), 'config.json');

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function encryptPassword(password) {
  if (!password) return { value: null, encrypted: false };
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return {
        value: safeStorage.encryptString(password).toString('base64'),
        encrypted: true
      };
    }
  } catch (error) {
    console.error('Encryption failed:', error);
  }
  return { value: password, encrypted: false };
}

function decryptPassword(storedPassword) {
  if (!storedPassword) return null;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(storedPassword, 'base64'));
    }
  } catch (error) {
    return storedPassword;
  }
  return storedPassword;
}

function encryptConfigPasswords(config) {
  if (!config || !Array.isArray(config.nodes)) return config;

  const encrypted = JSON.parse(JSON.stringify(config));
  encrypted.nodes = encrypted.nodes.map((node) => {
    if (!node.sshPass || node._encrypted) return node;
    const result = encryptPassword(node.sshPass);
    return {
      ...node,
      sshPass: result.value,
      _encrypted: result.encrypted
    };
  });
  return encrypted;
}

function decryptConfigPasswords(config) {
  if (!config || !Array.isArray(config.nodes)) return config;

  const decrypted = JSON.parse(JSON.stringify(config));
  decrypted.nodes = decrypted.nodes.map((node) => {
    if (!node.sshPass || !node._encrypted) return node;
    return {
      ...node,
      sshPass: decryptPassword(node.sshPass),
      _encrypted: false
    };
  });
  return decrypted;
}

function emptyConfig() {
  return {
    settings: { showGrid: true, gridSize: 100, snapToGrid: true },
    nodes: [],
    connections: []
  };
}

function normalizeConfig(parsed) {
  if (Array.isArray(parsed)) {
    return { ...emptyConfig(), nodes: parsed };
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Configuration must be a JSON object or an array of nodes');
  }
  return {
    settings: parsed.settings && typeof parsed.settings === 'object'
      ? parsed.settings
      : emptyConfig().settings,
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    connections: Array.isArray(parsed.connections) ? parsed.connections : []
  };
}

function readConfigFile(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_CONFIG_BYTES) {
    throw new Error('Configuration file is larger than 5 MB');
  }
  return normalizeConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function pingHost(host, timeoutMs) {
  return new Promise((resolve) => {
    if (!isSafeHost(host)) {
      resolve({ online: false, duration: 0 });
      return;
    }
    const start = Date.now();
    execFile('ping', pingArgs(host), { timeout: timeoutMs }, (error) => {
      resolve({ online: !error, duration: Date.now() - start });
    });
  });
}

function checkPort(host, port, timeout) {
  return new Promise((resolve) => {
    if (!isSafeHost(host) || !isSafePort(port)) {
      resolve(false);
      return;
    }
    const socket = new net.Socket();
    const numericPort = Number(port);
    let settled = false;

    const finish = (online) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(online);
    };

    socket.setTimeout(timeout);
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
    socket.on('timeout', () => finish(false));
    socket.connect(numericPort, host);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    title: 'Network Topology'
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  if (process.argv.includes('--smoke')) {
    mainWindow.webContents.on('did-fail-load', (_event, code, description) => {
      console.error(`SMOKE load failed: ${code} ${description}`);
      app.exit(1);
    });
    mainWindow.webContents.on('did-finish-load', async () => {
      try {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const result = await mainWindow.webContents.executeJavaScript(`({
          terminal: typeof Terminal,
          fit: !!(window.FitAddon && window.FitAddon.FitAddon),
          api: !!(window.electronAPI && window.electronAPI.config && window.electronAPI.ssh && window.electronAPI.monitor),
          nodes: document.querySelectorAll('.node-container').length
        })`);
        const ok = result.terminal === 'function' && result.fit && result.api && result.nodes > 0;
        console.log(`SMOKE ${JSON.stringify(result)}`);
        app.exit(ok ? 0 : 1);
      } catch (error) {
        console.error(error);
        app.exit(1);
      }
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    sshConnections.forEach((connection) => {
      try {
        connection.conn.end();
      } catch (error) {
        console.error('Failed to close SSH connection:', error);
      }
    });
    sshConnections.clear();
  });
}

function stopMonitoring() {
  if (monitoringIntervalId) {
    clearInterval(monitoringIntervalId);
    monitoringIntervalId = null;
  }
  monitoringConfig = null;
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopMonitoring();
});

ipcMain.handle('config:load', async () => {
  try {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) {
      const defaultConfig = path.join(__dirname, 'renderer', 'config.json');
      if (fs.existsSync(defaultConfig)) {
        fs.copyFileSync(defaultConfig, configPath);
      } else {
        return emptyConfig();
      }
    }
    return decryptConfigPasswords(readConfigFile(configPath));
  } catch (error) {
    console.error('Error loading config:', error);
    return emptyConfig();
  }
});

ipcMain.handle('config:save', async (event, config) => {
  try {
    const normalized = normalizeConfig(config);
    const encryptedConfig = encryptConfigPasswords(normalized);
    fs.writeFileSync(getConfigPath(), JSON.stringify(encryptedConfig, null, 2));
    return { success: true };
  } catch (error) {
    console.error('Error saving config:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('config:export', async (event, config) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Configuration',
      defaultPath: 'topology-config.json',
      filters: [{ name: 'JSON Files', extensions: ['json'] }]
    });

    if (!result.canceled && result.filePath) {
      fs.writeFileSync(result.filePath, JSON.stringify(normalizeConfig(config), null, 2));
      return { success: true, path: result.filePath };
    }
    return { success: false, canceled: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('config:import', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Configuration',
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
      properties: ['openFile']
    });

    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, config: readConfigFile(result.filePaths[0]) };
    }
    return { success: false, canceled: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('ssh:browseKey', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select SSH Private Key',
      properties: ['openFile'],
      filters: [
        { name: 'SSH Keys', extensions: ['pem', 'key', 'ppk'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      defaultPath: path.join(os.homedir(), '.ssh')
    });

    if (!result.canceled && result.filePaths.length > 0) {
      return { success: true, path: result.filePaths[0] };
    }
    return { success: false, canceled: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

function isReasonableUsername(username) {
  return typeof username === 'string' && username.length > 0 && username.length <= 128 && !/[\r\n\0]/.test(username);
}

ipcMain.handle('ssh:connect', async (event, connectionInfo) => {
  const info = connectionInfo || {};
  const host = info.host;
  const port = info.port == null ? 22 : info.port;
  const username = info.username;
  const password = info.password;
  const privateKeyPath = info.privateKeyPath;
  const passphrase = info.passphrase;
  const nodeId = info.nodeId;

  if (typeof nodeId !== 'string' || nodeId.length === 0 || nodeId.length > 128) {
    return { success: false, error: 'Invalid node id' };
  }
  if (!isSafeHost(host) || !isSafePort(port) || !isReasonableUsername(username)) {
    return { success: false, error: 'Invalid SSH host, port, or username' };
  }

  return new Promise((resolve) => {
    const conn = new Client();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color' }, (err, stream) => {
        if (err) {
          conn.end();
          finish({ success: false, error: err.message });
          return;
        }

        sshConnections.set(nodeId, { conn, stream });

        stream.on('data', (data) => {
          sendToRenderer('ssh:data', { nodeId, data: data.toString() });
        });

        stream.on('close', () => {
          sendToRenderer('ssh:closed', { nodeId });
          sshConnections.delete(nodeId);
        });

        stream.stderr.on('data', (data) => {
          sendToRenderer('ssh:data', { nodeId, data: data.toString() });
        });

        finish({ success: true });
      });
    });

    conn.on('error', (err) => {
      finish({ success: false, error: err.message });
    });

    conn.on('close', () => {
      if (sshConnections.has(nodeId)) {
        sendToRenderer('ssh:closed', { nodeId });
        sshConnections.delete(nodeId);
      }
    });

    const connectConfig = {
      host,
      port: Number(port),
      username,
      readyTimeout: 10000,
      keepaliveInterval: 10000
    };

    if (privateKeyPath) {
      if (typeof privateKeyPath !== 'string') {
        finish({ success: false, error: 'Invalid private key path' });
        return;
      }
      try {
        connectConfig.privateKey = fs.readFileSync(privateKeyPath);
        if (passphrase) connectConfig.passphrase = passphrase;
      } catch (keyError) {
        finish({ success: false, error: `Failed to read private key: ${keyError.message}` });
        return;
      }
    } else if (password) {
      connectConfig.password = password;
    }

    try {
      conn.connect(connectConfig);
    } catch (error) {
      finish({ success: false, error: error.message });
    }
  });
});

ipcMain.handle('ssh:write', async (event, payload) => {
  const nodeId = payload && payload.nodeId;
  const data = payload && payload.data;
  const connection = sshConnections.get(nodeId);
  if (connection && connection.stream && typeof data === 'string') {
    connection.stream.write(data);
    return { success: true };
  }
  return { success: false, error: 'Connection not found' };
});

ipcMain.handle('ssh:resize', async (event, payload) => {
  const nodeId = payload && payload.nodeId;
  const cols = payload && payload.cols;
  const rows = payload && payload.rows;
  const connection = sshConnections.get(nodeId);
  if (!connection || !connection.stream) {
    return { success: false, error: 'Connection not found' };
  }
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 500 || rows > 500) {
    return { success: false, error: 'Invalid terminal size' };
  }
  connection.stream.setWindow(rows, cols, 0, 0);
  return { success: true };
});

ipcMain.handle('ssh:disconnect', async (event, nodeId) => {
  const connection = sshConnections.get(nodeId);
  if (connection) {
    try {
      connection.conn.end();
    } catch (error) {
      console.error('Failed to disconnect SSH:', error);
    }
    sshConnections.delete(nodeId);
    return { success: true };
  }
  return { success: false, error: 'Connection not found' };
});

ipcMain.handle('network:getLocalInfo', async () => {
  const interfaces = os.networkInterfaces();
  const result = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs || []) {
      const isIpv4 = addr.family === 'IPv4' || addr.family === 4;
      if (isIpv4 && !addr.internal) {
        result.push({
          interface: name,
          address: addr.address,
          netmask: addr.netmask,
          mac: addr.mac
        });
      }
    }
  }

  return result;
});

ipcMain.handle('network:ping', async (event, host) => {
  const start = Date.now();
  const result = await pingHost(host, 5000);
  if (!isSafeHost(host)) {
    return { success: false, host, duration: 0, error: 'Invalid host' };
  }
  return { success: result.online, host, duration: result.duration || (Date.now() - start) };
});

ipcMain.handle('network:scan', async (event, payload) => {
  const baseIp = payload && payload.baseIp;
  const range = clampScanRange(payload && payload.startRange, payload && payload.endRange);
  if (!isSafeBaseIp(baseIp) || !range) {
    throw new Error('Invalid scan range');
  }

  const results = [];
  const batchSize = 20;

  for (let start = range.start; start <= range.end; start += batchSize) {
    const end = Math.min(start + batchSize - 1, range.end);
    const batch = [];
    for (let octet = start; octet <= end; octet += 1) {
      const ip = `${baseIp}.${octet}`;
      batch.push(pingHost(ip, 2000).then((result) => {
        if (result && result.online) results.push({ ip, online: true });
      }));
    }
    await Promise.all(batch);
    sendToRenderer('network:scanProgress', {
      current: end - range.start + 1,
      total: range.end - range.start + 1,
      found: results.length
    });
  }

  return results;
});

ipcMain.handle('network:arp', async () => {
  return new Promise((resolve) => {
    execFile('arp', ['-a'], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }

      const entries = [];
      const isWindows = process.platform === 'win32';
      for (const line of String(stdout).split('\n')) {
        const match = isWindows
          ? line.match(/(\d+\.\d+\.\d+\.\d+)\s+([\da-f-]+)/i)
          : line.match(/\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([\da-f:]+)/i);

        if (match && isSafeHost(match[1])) {
          entries.push({
            ip: match[1],
            mac: match[2].replace(/-/g, ':').toLowerCase()
          });
        }
      }
      resolve(entries);
    });
  });
});

async function runMonitoring() {
  if (!monitoringConfig || !Array.isArray(monitoringConfig.nodes)) return;

  const statusResults = await Promise.all(monitoringConfig.nodes.map(async (node) => {
    const start = Date.now();
    let online = false;

    if (node && node.port) {
      online = await checkPort(node.address, node.port, 1000);
    } else if (node && node.address) {
      const result = await pingHost(node.address, 2000);
      online = Boolean(result && result.online);
    }

    const publicNode = { ...(node || {}) };
    delete publicNode.sshPass;
    return {
      ...publicNode,
      status: online,
      responseTime: Date.now() - start
    };
  }));

  sendToRenderer('monitor:status', {
    nodes: statusResults,
    updated: new Date().toLocaleTimeString()
  });
}

ipcMain.handle('monitor:start', async (event, config) => {
  if (monitoringIntervalId) {
    clearInterval(monitoringIntervalId);
    monitoringIntervalId = null;
  }
  monitoringConfig = normalizeConfig(config);

  await runMonitoring();
  monitoringIntervalId = setInterval(runMonitoring, monitoringInterval(config && config.interval));
  return { success: true };
});

ipcMain.handle('monitor:stop', async () => {
  stopMonitoring();
  return { success: true };
});
