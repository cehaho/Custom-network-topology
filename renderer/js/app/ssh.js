// SSH: connection modal, host key prompts, xterm.js terminal tabs.

import { FitAddon, Terminal, Topology, lucide } from './libs.js';
import { escapeHtml } from './util.js';
import { state } from './state.js';
import {
  closeModal,
  onAction,
  openModal,
  setSecretHint,
  toastError,
  toastInfo,
  toastSuccess,
  toastWarning
} from './ui.js';
import { saveConfig } from './io.js';

const terminals = new Map();
let activeTerminal = null;

export function openSSHModal(node) {
  const source = (state.config.nodes || []).find((item) => item.id === node.id) || node;
  const type = Topology.secretType(source);
  const auth = source.sshAuth === 'key' || type === 'passphrase' ? 'key' : 'password';
  document.getElementById('ssh-host').value = source.address || '';
  document.getElementById('ssh-port').value = source.sshPort || 22;
  document.getElementById('ssh-username').value = source.sshUser || '';
  document.getElementById('ssh-password').value = '';
  document.getElementById('ssh-node-id').value = source.id;
  document.getElementById('ssh-auth-type').value = auth;
  document.getElementById('ssh-key-path').value = source.sshKeyPath || '';
  document.getElementById('ssh-passphrase').value = '';
  setSecretHint('ssh-password-hint', type === 'password' ? 'Secret saved. Leave blank to use it.' : '');
  setSecretHint('ssh-passphrase-hint', type === 'passphrase' ? 'Secret saved. Leave blank to use it.' : '');
  toggleSSHAuthFields();

  openModal('ssh-modal');
  lucide.createIcons();
}

function toggleSSHAuthFields() {
  const authType = document.getElementById('ssh-auth-type').value;
  const passwordGroup = document.getElementById('ssh-password-group');
  const keyGroup = document.getElementById('ssh-key-group');

  if (authType === 'password') {
    passwordGroup.classList.remove('hidden');
    keyGroup.classList.add('hidden');
  } else {
    passwordGroup.classList.add('hidden');
    keyGroup.classList.remove('hidden');
  }
}

async function browseSSHKey() {
  if (!window.desktopAPI) {
    toastWarning('Not Available', 'File browsing is only available in the desktop application');
    return;
  }

  const result = await window.desktopAPI.ssh.browseKey();
  if (result.success) {
    document.getElementById('ssh-key-path').value = result.path;
    toastInfo('Key Selected', `Selected: ${result.path.split(/[\\/]/).pop()}`);
  }
}

async function rememberSecret(nodeId, changes) {
  const node = (state.config.nodes || []).find((item) => item.id === nodeId);
  if (!node) return { success: true };
  let changed = false;
  if (changes.password) {
    node.sshAuth = 'password';
    node.sshPass = changes.password;
    delete node.sshPassphrase;
    delete node.sshSecretClear;
    changed = true;
  }
  if (changes.passphrase) {
    node.sshAuth = 'key';
    node.sshPassphrase = changes.passphrase;
    delete node.sshPass;
    delete node.sshSecretClear;
    changed = true;
  }
  if (changes.keyPath && changes.keyPath !== node.sshKeyPath) {
    node.sshAuth = 'key';
    node.sshKeyPath = changes.keyPath;
    changed = true;
  }
  if (!changed) return { success: true };
  return saveConfig();
}

async function connectSSH() {
  if (!window.desktopAPI) {
    toastWarning('SSH Unavailable', 'SSH is only available in the desktop application');
    return;
  }

  const nodeId = document.getElementById('ssh-node-id').value;
  const host = document.getElementById('ssh-host').value;
  const port = parseInt(document.getElementById('ssh-port').value) || 22;
  const username = document.getElementById('ssh-username').value;
  const authType = document.getElementById('ssh-auth-type').value;

  if (!host || !username) {
    toastError('Missing Credentials', 'Host and username are required');
    return;
  }

  // Build connection info based on auth type
  const connectionInfo = { nodeId, host, port, username };

  const node = (state.config.nodes || []).find((item) => item.id === nodeId);
  const storedType = Topology.secretType(node);

  if (authType === 'password') {
    const password = document.getElementById('ssh-password').value;
    if (password) {
      connectionInfo.password = password;
      const saved = await rememberSecret(nodeId, { password: password });
      if (!saved || saved.success === false) {
        toastError('Password not saved', (saved && saved.error) || 'The password was not saved');
      }
    } else if (storedType !== 'password') {
      toastError('Missing Password', 'Password is required');
      return;
    }
  } else {
    const keyPath = document.getElementById('ssh-key-path').value;
    if (!keyPath) {
      toastError('Missing Key', 'Private key file is required');
      return;
    }
    connectionInfo.privateKeyPath = keyPath;
    const passphrase = document.getElementById('ssh-passphrase').value;
    if (passphrase) {
      connectionInfo.passphrase = passphrase;
    }
    const saved = await rememberSecret(nodeId, {
      passphrase: passphrase,
      keyPath: keyPath
    });
    if (passphrase && (!saved || saved.success === false)) {
      toastError('Password not saved', (saved && saved.error) || 'The key passphrase was not saved');
    }
  }

  closeModal('ssh-modal');

  // Show connecting status
  document.getElementById('terminal-status').textContent = 'Connecting...';
  document.getElementById('terminal-status').className = 'text-xs px-2 py-0.5 rounded bg-yellow-600';

  let result = await window.desktopAPI.ssh.connect(connectionInfo);
  if (!result.success && result.hostKey && result.hostKey.status === 'unknown' && confirmUnknownHostKey(result.hostKey)) {
    connectionInfo.acceptHostKey = result.hostKey.fingerprint;
    result = await window.desktopAPI.ssh.connect(connectionInfo);
  }

  if (result.success) {
    document.getElementById('terminal-status').textContent = 'Connected';
    document.getElementById('terminal-status').className = 'text-xs px-2 py-0.5 rounded bg-green-600';
    createTerminalTab(nodeId, host);
    toastSuccess('SSH Connected', `Connected to ${host}`);
  } else {
    document.getElementById('terminal-status').textContent = 'Failed';
    document.getElementById('terminal-status').className = 'text-xs px-2 py-0.5 rounded bg-red-600';
    toastError('SSH Connection Failed', result.error);
    if (result.hostKey && result.hostKey.status === 'mismatch') {
      await offerToForgetHostKey(result.hostKey);
    }
  }
}

// The fingerprint is shown in full so the user can compare it with the server
// (for example `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`).
function confirmUnknownHostKey(hostKey) {
  return window.confirm(
    `First connection to ${hostKey.host}:${hostKey.port}.\n\n` +
    `The server presented this host key:\n` +
    `${hostKey.algorithm}\n${hostKey.fingerprint}\n\n` +
    `Only continue if this fingerprint matches the server's.\n` +
    `OK: trust and remember this key, then connect.\nCancel: do not connect.`
  );
}

async function offerToForgetHostKey(hostKey) {
  const forget = window.confirm(
    `HOST KEY MISMATCH for ${hostKey.host}:${hostKey.port}.\n\n` +
    `Stored key:\n${hostKey.storedAlgorithm}\n${hostKey.storedFingerprint}\n\n` +
    `Presented key:\n${hostKey.algorithm}\n${hostKey.fingerprint}\n\n` +
    `Someone may be intercepting the connection. Only forget the stored key ` +
    `if you know the server's key changed (reinstall, new key).\n\n` +
    `OK: forget the stored key (you will be asked to verify the new one on the next connection).\n` +
    `Cancel: keep the stored key.`
  );
  if (!forget) return;
  const removed = await window.desktopAPI.ssh.forgetHostKey(hostKey.host, hostKey.port);
  if (removed && removed.success) {
    toastSuccess('Host key forgotten', `Connect again to verify the new key of ${hostKey.host}`);
  } else {
    toastError('Host key not forgotten', (removed && removed.error) || 'The stored host key was not removed');
  }
}

function createTerminalTab(nodeId, host) {
  // Hide placeholder
  document.getElementById('terminal-placeholder').classList.add('hidden');

  // Create tab
  const tabs = document.getElementById('terminal-tabs');
  const tab = document.createElement('div');
  tab.className = 'terminal-tab active';
  tab.dataset.nodeId = nodeId;
  tab.innerHTML = `
    <span>${escapeHtml(host)}</span>
    <button class="close-btn text-slate-500 hover:text-red-400" type="button">
      <i data-lucide="x" class="w-3 h-3"></i>
    </button>
  `;
  tab.addEventListener('click', (e) => {
    if (e.target.closest('.close-btn')) {
      closeTerminalTab(nodeId);
      return;
    }
    switchTerminal(nodeId);
  });

  // Deactivate other tabs
  tabs.querySelectorAll('.terminal-tab').forEach(t => t.classList.remove('active'));
  tabs.appendChild(tab);

  // Create terminal instance container
  const instances = document.getElementById('terminal-instances');
  const termDiv = document.createElement('div');
  termDiv.id = `terminal-${nodeId}`;
  termDiv.className = 'terminal-instance h-full';
  instances.querySelectorAll('.terminal-instance').forEach(t => t.style.display = 'none');
  instances.appendChild(termDiv);

  // Initialize xterm.js (will be loaded dynamically)
  initTerminal(nodeId, termDiv);

  lucide.createIcons();
}

function sendTerminalSize(nodeId, term) {
  if (!window.desktopAPI || !term) return;
  const cols = term.cols;
  const rows = term.rows;
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
  window.desktopAPI.ssh.resize(nodeId, cols, rows);
}

async function initTerminal(nodeId, container) {
  if (typeof Terminal === 'undefined') {
    toastError('Terminal unavailable', 'xterm.js did not load. Run npm install, then restart the app.');
    return;
  }

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: '#1a1a2e',
      foreground: '#e2e8f0',
      cursor: '#3b82f6',
      selectionBackground: 'rgba(59, 130, 246, 0.3)'
    }
  });

  term.open(container);

  term.onData(data => {
    if (window.desktopAPI) {
      window.desktopAPI.ssh.write(nodeId, data);
    }
  });

  let onResize = null;
  const FitConstructor = FitAddon && FitAddon.FitAddon;
  if (typeof FitConstructor === 'function') {
    const fitAddon = new FitConstructor();
    term.loadAddon(fitAddon);
    onResize = () => {
      if (!terminals.has(nodeId)) return;
      fitAddon.fit();
      sendTerminalSize(nodeId, term);
    };
    requestAnimationFrame(onResize);
    window.addEventListener('resize', onResize);
  }

  terminals.set(nodeId, { term, container, onResize });
  activeTerminal = nodeId;
}

function switchTerminal(nodeId) {
  const tabs = document.getElementById('terminal-tabs');
  tabs.querySelectorAll('.terminal-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.nodeId === nodeId);
  });

  const instances = document.getElementById('terminal-instances');
  instances.querySelectorAll('.terminal-instance').forEach(t => {
    t.style.display = t.id === `terminal-${nodeId}` ? 'block' : 'none';
  });

  activeTerminal = nodeId;
}

async function closeTerminalTab(nodeId) {
  const tabs = document.getElementById('terminal-tabs');
  const tab = [...tabs.querySelectorAll('.terminal-tab')].find((item) => item.dataset.nodeId === nodeId);
  const termDiv = document.getElementById(`terminal-${nodeId}`);
  const termData = terminals.get(nodeId);
  if (!tab && !termDiv && !termData) return;

  terminals.delete(nodeId);
  if (termData && termData.onResize) {
    window.removeEventListener('resize', termData.onResize);
  }
  if (termData && termData.term) {
    termData.term.dispose();
  }
  if (window.desktopAPI) {
    await window.desktopAPI.ssh.disconnect(nodeId);
  }

  if (tab) tab.remove();
  if (termDiv) termDiv.remove();

  // Show placeholder if no terminals left
  if (terminals.size === 0) {
    document.getElementById('terminal-placeholder').classList.remove('hidden');
    document.getElementById('terminal-status').textContent = 'No Connection';
    document.getElementById('terminal-status').className = 'text-xs px-2 py-0.5 rounded bg-slate-700';
  } else {
    // Switch to another terminal
    const firstTab = tabs.querySelector('.terminal-tab');
    if (firstTab) {
      switchTerminal(firstTab.dataset.nodeId);
    }
  }
}

// SSH data listener
export function setupSSHListeners() {
  if (!window.desktopAPI) return;

  window.desktopAPI.ssh.onData(({ nodeId, data }) => {
    const termData = terminals.get(nodeId);
    if (termData && termData.term) {
      termData.term.write(data);
    }
  });

  window.desktopAPI.ssh.onClosed(({ nodeId }) => {
    closeTerminalTab(nodeId);
  });
}

export function bindSshControls() {
  onAction('browse-ssh-key', browseSSHKey);
  onAction('connect-ssh', connectSSH);
  document.getElementById('ssh-auth-type').addEventListener('change', () => toggleSSHAuthFields());
}
