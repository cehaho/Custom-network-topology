'use strict';

// The in-page dialog (renderer/js/dialog.js) that replaces alert / confirm /
// prompt, which the WebKitGTK webview does not show. Driven here with a tiny
// fake DOM.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const AppDialog = require('../renderer/js/dialog.js');

const renderer = path.join(__dirname, '..', 'renderer');

class FakeElement {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.id = '';
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((node) => node !== child);
    child.parentNode = null;
    return child;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); }
  focus() { this.ownerDocument.activeElement = this; }
  select() { this.selected = true; }
  click() { this.dispatch('click', { target: this }); }
  dispatch(type, event) { (this.listeners[type] || []).forEach((handler) => handler(event)); }
  find(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const found = child.find(predicate);
      if (found) return found;
    }
    return null;
  }
  byClass(name) { return this.find((node) => node.className.split(' ').includes(name)); }
}

function fakeDocument() {
  const doc = {
    activeElement: null,
    listeners: {},
    createElement: (tag) => new FakeElement(doc, tag),
    addEventListener(type, handler, capture) {
      assert.equal(capture, true, 'the key listener runs in the capture phase');
      (doc.listeners[type] = doc.listeners[type] || []).push(handler);
    },
    removeEventListener(type, handler) {
      doc.listeners[type] = (doc.listeners[type] || []).filter((item) => item !== handler);
    }
  };
  doc.body = new FakeElement(doc, 'body');
  doc.key = (key, extra) => {
    const event = Object.assign({
      key: key,
      stopped: false,
      prevented: false,
      stopPropagation() { this.stopped = true; },
      preventDefault() { this.prevented = true; }
    }, extra || {});
    (doc.listeners.keydown || []).slice().forEach((handler) => handler(event));
    return event;
  };
  doc.dialog = () => doc.body.byClass('app-dialog-backdrop');
  return doc;
}

function setup() {
  const doc = fakeDocument();
  return { doc, dialog: AppDialog.create(() => doc) };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('exports the API and a browser global', () => {
  ['alert', 'confirm', 'prompt', 'create', 'isOpen'].forEach((name) => {
    assert.equal(typeof AppDialog[name], 'function', name);
  });
  assert.equal(globalThis.AppDialog, AppDialog);
});

test('alert shows the text with textContent, a title, and resolves on Enter', async () => {
  const { doc, dialog } = setup();
  const done = dialog.alert('Line 1\n<b>Line 2</b>', { title: 'Status' });
  const backdrop = doc.dialog();
  assert.ok(backdrop);
  assert.equal(backdrop.byClass('app-dialog-message').textContent, 'Line 1\n<b>Line 2</b>');
  assert.equal(backdrop.byClass('app-dialog-title').textContent, 'Status');
  assert.equal(backdrop.byClass('app-dialog-cancel'), null, 'an alert has no Cancel');
  assert.equal(doc.activeElement, backdrop.byClass('app-dialog-ok'));
  const event = doc.key('Enter');
  assert.ok(event.stopped, 'app shortcuts do not see the key');
  assert.equal(await done, undefined);
  assert.equal(doc.dialog(), null, 'the dialog is removed');
  assert.deepEqual(doc.listeners.keydown, []);
});

test('confirm: OK resolves true, Cancel / Escape / backdrop resolve false', async () => {
  const { doc, dialog } = setup();
  let done = dialog.confirm('Delete?');
  doc.dialog().byClass('app-dialog-ok').click();
  assert.equal(await done, true);

  done = dialog.confirm('Delete?');
  doc.dialog().byClass('app-dialog-cancel').click();
  assert.equal(await done, false);

  done = dialog.confirm('Delete?');
  doc.key('Escape');
  assert.equal(await done, false);

  done = dialog.confirm('Delete?');
  const backdrop = doc.dialog();
  backdrop.byClass('app-dialog').dispatch('click', { target: backdrop.byClass('app-dialog') });
  assert.equal(dialog.isOpen(), true, 'a click inside the box does not cancel');
  backdrop.dispatch('click', { target: backdrop });
  assert.equal(await done, false);
});

test('confirm: Enter on the initial OK accepts; a danger confirm focuses Cancel first', async () => {
  const { doc, dialog } = setup();
  let done = dialog.confirm('Go?', { okLabel: 'Go', cancelLabel: 'Stay' });
  assert.equal(doc.dialog().byClass('app-dialog-ok').textContent, 'Go');
  assert.equal(doc.dialog().byClass('app-dialog-cancel').textContent, 'Stay');
  doc.key('Enter');
  assert.equal(await done, true);

  done = dialog.confirm('Delete node "a"?', { danger: true });
  const backdrop = doc.dialog();
  assert.equal(doc.activeElement, backdrop.byClass('app-dialog-cancel'));
  assert.match(backdrop.byClass('app-dialog-ok').className, /app-dialog-ok-danger/);
  doc.key('Enter');
  assert.equal(await done, false, 'Enter on the focused Cancel cancels');

  done = dialog.confirm('Delete node "a"?', { danger: true });
  doc.key('Tab');
  assert.equal(doc.activeElement, doc.dialog().byClass('app-dialog-ok'), 'Tab moves to OK');
  doc.key('Tab');
  assert.equal(doc.activeElement, doc.dialog().byClass('app-dialog-cancel'), 'and wraps around');
  doc.key('Tab', { shiftKey: true });
  doc.key('Enter');
  assert.equal(await done, true);
});

test('prompt: returns the typed value, null when cancelled', async () => {
  const { doc, dialog } = setup();
  let done = dialog.prompt('Interface?', { defaultValue: 'eth0', placeholder: 'ifIndex' });
  const input = doc.dialog().byClass('app-dialog-input');
  assert.equal(input.value, 'eth0');
  assert.equal(input.placeholder, 'ifIndex');
  assert.equal(doc.activeElement, input, 'the input has the focus');
  input.value = '  12 ';
  doc.key('Enter');
  assert.equal(await done, '  12 ', 'the value is returned as typed');

  done = dialog.prompt('Interface?');
  assert.equal(doc.dialog().byClass('app-dialog-input').value, '');
  doc.key('Escape');
  assert.equal(await done, null);
});

test('only one dialog at a time: later calls wait in order', async () => {
  const { doc, dialog } = setup();
  const order = [];
  const first = dialog.confirm('first').then((value) => order.push(['first', value]));
  const second = dialog.alert('second').then(() => order.push(['second']));
  const third = dialog.prompt('third').then((value) => order.push(['third', value]));
  assert.equal(doc.body.children.length, 1);
  assert.equal(dialog.pending(), 2);
  assert.equal(doc.dialog().byClass('app-dialog-message').textContent, 'first');

  doc.key('Enter');
  await flush();
  assert.equal(doc.body.children.length, 1);
  assert.equal(doc.dialog().byClass('app-dialog-message').textContent, 'second');
  doc.key('Escape');
  await flush();
  assert.equal(doc.dialog().byClass('app-dialog-message').textContent, 'third');
  doc.dialog().byClass('app-dialog-input').value = 'x';
  doc.dialog().byClass('app-dialog-ok').click();
  await Promise.all([first, second, third]);
  assert.deepEqual(order, [['first', true], ['second'], ['third', 'x']]);
  assert.equal(dialog.isOpen(), false);
  assert.equal(doc.body.children.length, 0);
});

test('focus returns to the element that had it', async () => {
  const { doc, dialog } = setup();
  const before = doc.createElement('button');
  before.focus();
  const done = dialog.alert('hi');
  assert.notEqual(doc.activeElement, before);
  doc.key('Escape');
  await done;
  assert.equal(doc.activeElement, before);
});

test('fingerprints are shown in monospace', () => {
  assert.equal(AppDialog.wantsMonospace('ssh-ed25519\nSHA256:abcdEFGH1234+/xyz'), true);
  assert.equal(AppDialog.wantsMonospace('Delete node "a"?'), false);
  assert.equal(AppDialog.wantsMonospace('SHA256:abcdEFGH1234', { monospace: false }), false);
  const { doc, dialog } = setup();
  dialog.confirm('key SHA256:abcdEFGH1234+/xyz');
  assert.match(doc.dialog().byClass('app-dialog-message').className, /app-dialog-mono/);
  doc.key('Escape');
});

test('without a document the dialog answers like a dismissed one', async () => {
  const dialog = AppDialog.create(() => null);
  assert.equal(await dialog.alert('x'), undefined);
  assert.equal(await dialog.confirm('x'), false);
  assert.equal(await dialog.prompt('x'), null);
});

// ---- Static checks ----

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

test('no native alert / confirm / prompt call remains in renderer/js', () => {
  const files = walk(path.join(renderer, 'js')).filter((file) => path.basename(file) !== 'dialog.js');
  assert.ok(files.length > 20);
  files.forEach((file) => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, at) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      // Allowed: AppDialog.alert(…), dialog.prompt(…) and other method calls.
      const bare = line.match(/(^|[^.\w$])(alert|confirm|prompt)\s*\(/);
      const onWindow = line.match(/\b(window|globalThis|self)\.(alert|confirm|prompt)\s*\(/);
      assert.ok(!bare && !onWindow, path.relative(renderer, file) + ':' + (at + 1) + ': ' + line.trim());
    });
  });
});

const USERS = ['known-hosts-admin.js', 'snmp.js', 'admin.js'];

for (const page of ['index.html', 'admin.html']) {
  test(page + ' loads dialog.js and its stylesheet before the scripts that use it', () => {
    const html = fs.readFileSync(path.join(renderer, page), 'utf8');
    const srcs = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);
    const at = srcs.indexOf('js/dialog.js');
    assert.ok(at >= 0, 'dialog.js is loaded');
    const users = USERS.map((file) => 'js/' + file).concat(page === 'index.html' ? ['js/app/main.js'] : ['js/admin-page.js']);
    users.forEach((src) => {
      const userAt = srcs.indexOf(src);
      assert.ok(userAt > at, src + ' comes after dialog.js');
    });
    assert.match(html, /<link rel="stylesheet" href="css\/dialog\.css">/);
  });
}

test('the modules get AppDialog through libs.js', () => {
  const libs = fs.readFileSync(path.join(renderer, 'js', 'app', 'libs.js'), 'utf8');
  assert.match(libs, /export const AppDialog = g\.AppDialog;/);
  ['ssh.js', 'context-menu.js', 'canvas-edit.js', 'io.js'].forEach((file) => {
    const text = fs.readFileSync(path.join(renderer, 'js', 'app', file), 'utf8');
    assert.match(text, /import \{[^}]*\bAppDialog\b[^}]*\} from '\.\/libs\.js';/, file);
  });
});

test('the SSH connect flow awaits the host key confirmation', () => {
  const ssh = fs.readFileSync(path.join(renderer, 'js', 'app', 'ssh.js'), 'utf8');
  assert.match(ssh, /status === 'unknown' && await confirmUnknownHostKey\(result\.hostKey\)/);
  assert.match(ssh, /function confirmUnknownHostKey\(hostKey\) \{\n\s*return AppDialog\.confirm\(/);
  assert.match(ssh, /const forget = await AppDialog\.confirm\(/);
});
