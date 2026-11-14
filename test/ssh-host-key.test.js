'use strict';

// The SSH connect flow waits for the in-page host key confirmation
// (AppDialog.confirm resolves later) before it retries with the accepted
// fingerprint. With the native confirm gone, a missing await would read a
// Promise as "yes" or skip the question.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const appDir = path.join(__dirname, '..', 'renderer', 'js', 'app');

function stubElement(value) {
  return {
    value: value === undefined ? '' : value,
    textContent: '',
    className: '',
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}
  };
}

async function setup(answer) {
  const asked = [];
  const connects = [];
  const values = {
    'ssh-node-id': 'n1', 'ssh-host': '10.0.0.5', 'ssh-port': '2222', 'ssh-username': 'admin',
    'ssh-auth-type': 'key', 'ssh-key-path': '/home/me/.ssh/id_ed25519', 'ssh-passphrase': ''
  };
  const elements = new Map();
  const clicks = {};
  globalThis.window = globalThis;
  globalThis.document = {
    getElementById: (id) => {
      if (id === 'toast-container') return null;
      if (!elements.has(id)) elements.set(id, stubElement(values[id]));
      return elements.get(id);
    },
    querySelectorAll: (selector) => {
      const name = (selector.match(/data-action="([^"]+)"/) || [])[1];
      return [{ addEventListener: (type, handler) => { clicks[name] = handler; } }];
    }
  };
  globalThis.AppDialog = {
    confirm: (message, options) => new Promise((resolve) => {
      asked.push({ message, options });
      setTimeout(() => resolve(answer), 10);
    })
  };
  globalThis.desktopAPI = {
    ssh: {
      connect: async (info) => {
        connects.push(Object.assign({}, info));
        if (connects.length === 1) {
          return {
            success: false,
            error: 'unknown host key',
            hostKey: { status: 'unknown', host: '10.0.0.5', port: 2222, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abcdefgh12345678' }
          };
        }
        return { success: false, error: 'stop here' };
      }
    }
  };
  ['probe-checks.js', 'topology.js'].forEach((file) => require(path.join(appDir, '..', file)));
  const ssh = await import(pathToFileURL(path.join(appDir, 'ssh.js')).href);
  ssh.bindSshControls();
  return { asked, connects, connect: () => clicks['connect-ssh']() };
}

test('the first connection waits for the confirmation, then retries with the fingerprint', async () => {
  const { asked, connects, connect } = await setup(true);
  await connect();
  assert.equal(asked.length, 1);
  assert.match(asked[0].message, /^First connection to 10\.0\.0\.5:2222\./);
  assert.match(asked[0].message, /SHA256:abcdefgh12345678/);
  assert.equal(connects.length, 2, 'connects again once the user accepted');
  assert.equal(connects[0].acceptHostKey, undefined);
  assert.equal(connects[1].acceptHostKey, 'SHA256:abcdefgh12345678');
  assert.equal(globalThis.document.getElementById('terminal-status').textContent, 'Failed');

  // Cancel: no second connection.
  globalThis.AppDialog.confirm = () => Promise.resolve(false);
  connects.length = 0;
  await connect();
  assert.equal(connects.length, 1);
});
