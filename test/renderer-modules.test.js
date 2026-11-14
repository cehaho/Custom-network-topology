'use strict';

// Structure of the renderer: index.html loads the library scripts, then the
// ES modules of renderer/js/app/ (entry: main.js). No inline handlers or
// inline scripts, so the CSP needs no 'unsafe-inline' for scripts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const renderer = path.join(root, 'renderer');
const appDir = path.join(renderer, 'js', 'app');
const read = (file) => fs.readFileSync(path.join(renderer, file), 'utf8');
const modules = fs.readdirSync(appDir).filter((file) => file.endsWith('.js')).sort();
const source = (file) => fs.readFileSync(path.join(appDir, file), 'utf8');

const LIBRARIES = [
  'dialog.js', 'probe-checks.js', 'topology.js', 'hosts.js', 'probe.js', 'alerts.js', 'canvas.js', 'search.js',
  'export.js', 'discovery.js', 'history.js', 'desktop.js', 'known-hosts-admin.js', 'snmp.js',
  'admin.js', 'actions.js'
];

function scriptSources(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map((match) => ({
    attrs: match[1],
    body: match[2].trim(),
    src: (match[1].match(/\bsrc="([^"]+)"/) || [])[1] || null
  }));
}

function scriptSrcPolicy(html) {
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp, 'the page has a CSP');
  const directive = csp[1].split(';').map((part) => part.trim()).find((part) => part.startsWith('script-src'));
  assert.ok(directive, 'the CSP has script-src');
  return directive;
}

for (const page of ['index.html', 'admin.html']) {
  test(page + ' has no inline handlers or inline scripts, and the CSP forbids them', () => {
    const html = read(page);
    assert.doesNotMatch(html, /<[^>]*\son[a-z]+\s*=/i, 'no on*= attribute');
    assert.doesNotMatch(html, /javascript:/i);
    scriptSources(html).forEach((script) => {
      assert.ok(script.src, 'every <script> has a src');
      assert.equal(script.body, '', script.src + ' has no inline body');
    });
    assert.equal(scriptSrcPolicy(html), "script-src 'self'");
  });
}

test('index.html loads the libraries as classic scripts, then the app as one module', () => {
  const scripts = scriptSources(read('index.html'));
  const modulesLoaded = scripts.filter((script) => /type="module"/.test(script.attrs));
  assert.deepEqual(modulesLoaded.map((script) => script.src), ['js/app/main.js']);
  const mainAt = scripts.findIndex((script) => script.src === 'js/app/main.js');
  assert.equal(mainAt, scripts.length - 1, 'the module comes last');
  LIBRARIES.forEach((file) => {
    const at = scripts.findIndex((script) => script.src === 'js/' + file);
    assert.ok(at >= 0 && at < mainAt, file + ' is loaded before the module');
  });
  assert.ok(fs.existsSync(path.join(renderer, 'css', 'app.css')));
  assert.match(read('index.html'), /<link rel="stylesheet" href="css\/app\.css">/);
  assert.doesNotMatch(read('index.html'), /<style>/);
});

test('the old global scripts are gone', () => {
  ['app.js', 'search-ui.js', 'latency-ui.js', 'alert-notifier.js'].forEach((file) => {
    assert.ok(!fs.existsSync(path.join(renderer, 'js', file)), 'js/' + file + ' was moved');
    assert.doesNotMatch(read('index.html'), new RegExp('src="js/' + file.replace('.', '\\.') + '"'));
  });
});

test('admin.html still runs on its own', () => {
  const scripts = scriptSources(read('admin.html')).map((script) => script.src);
  const adminAt = scripts.indexOf('js/admin.js');
  assert.ok(adminAt > 0);
  assert.equal(scripts.indexOf('js/admin-page.js'), adminAt + 1);
  assert.ok(!scripts.some((src) => src.startsWith('js/app/')), 'admin.html does not need the canvas modules');
  assert.match(fs.readFileSync(path.join(renderer, 'js', 'admin-page.js'), 'utf8'), /Admin\.startStandalone\(\)/);
});

test('every import of the app modules names an export of an existing module', () => {
  const exportsOf = new Map(modules.map((file) => {
    const names = new Set();
    for (const match of source(file).matchAll(/^export (?:async )?(?:function|const|let) ([\w$]+)/gm)) {
      names.add(match[1]);
    }
    return [file, names];
  }));
  modules.forEach((file) => {
    for (const match of source(file).matchAll(/^import \{([^}]+)\} from '\.\/([\w-]+\.js)';/gm)) {
      const target = match[2];
      assert.ok(exportsOf.has(target), file + ' imports missing ' + target);
      match[1].split(',').map((name) => name.trim().split(/\s+as\s+/)[0]).filter(Boolean).forEach((name) => {
        assert.ok(exportsOf.get(target).has(name), file + ' imports ' + name + ' that ' + target + ' does not export');
      });
    }
    assert.doesNotMatch(source(file), /^import (?!\{)/m, file + ' uses named imports only');
  });
});

test('the app modules publish nothing on window', () => {
  modules.forEach((file) => {
    assert.doesNotMatch(source(file), /\bwindow\.[A-Za-z_$][\w$]*\s*=(?!=)/, file);
    assert.doesNotMatch(source(file), /\bglobalThis\.[A-Za-z_$][\w$]*\s*=(?!=)/, file);
  });
});

test('every data-action, data-context-action and data-close-modal of index.html is wired', () => {
  const html = read('index.html');
  const all = modules.map(source).join('\n');
  const actions = [...html.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(actions.length >= 10);
  actions.forEach((name) => assert.ok(all.includes("onAction('" + name + "'"), 'data-action ' + name));
  const menu = source('context-menu.js');
  const entries = [...html.matchAll(/data-context-action="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(entries.length, 11);
  entries.forEach((name) => {
    const key = /^[a-z]+$/.test(name) ? name + ':' : "'" + name + "':";
    assert.ok(menu.includes(key), 'data-context-action ' + name);
  });
  [...html.matchAll(/data-close-modal="([^"]+)"/g)].forEach((match) => {
    assert.match(html, new RegExp('id="' + match[1] + '"'), match[1] + ' exists');
  });
  assert.match(source('ui.js'), /\[data-close-modal\]/);
});

test('the modules load and link in Node (no DOM work at import time but main.js listeners)', async () => {
  const added = [];
  globalThis.window = globalThis;
  globalThis.addEventListener = (type) => added.push('window:' + type);
  globalThis.document = {
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: (type) => added.push('document:' + type)
  };
  LIBRARIES.filter((file) => !['desktop.js', 'admin.js', 'known-hosts-admin.js'].includes(file))
    .forEach((file) => require(path.join(renderer, 'js', file)));
  let ui = null;
  const useUi = globalThis.QuickActions.useUi;
  globalThis.QuickActions.useUi = (hooks) => { ui = hooks; useUi(hooks); };

  const main = await import(pathToFileURL(path.join(appDir, 'main.js')).href);
  assert.deepEqual(Object.keys(main), [], 'main.js exports nothing');
  assert.ok(added.includes('document:DOMContentLoaded'));
  assert.deepEqual(Object.keys(ui).sort(), ['openModal', 'toastError', 'toastInfo', 'toastSuccess']);

  // Every module links on its own as well.
  for (const file of modules) {
    await import(pathToFileURL(path.join(appDir, file)).href);
  }
  const { state, displayedNodes } = await import(pathToFileURL(path.join(appDir, 'state.js')).href);
  assert.deepEqual(state.config, globalThis.Topology.emptyDocument());
  assert.equal(displayedNodes(), state.config.nodes);
});
