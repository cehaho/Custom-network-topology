// In-page replacements for window.alert, window.confirm and window.prompt.
//
// The WebKitGTK webview of Tauri on Linux shows no native dialog: alert does
// nothing, confirm returns false and prompt returns null. These draw a modal
// in the page instead and return Promises:
//   AppDialog.alert(message, { title })                         -> undefined
//   AppDialog.confirm(message, { title, okLabel, cancelLabel, danger }) -> boolean
//   AppDialog.prompt(message, { title, defaultValue, placeholder })     -> string | null
// Shared option: monospace (true/false; by default on when the message holds
// a key fingerprint). Only one dialog shows at a time; later calls wait.
//
// Keyboard: Enter activates the focused button (OK from the prompt input),
// Escape cancels, Tab stays inside the dialog. Clicking the backdrop cancels.
// Initial focus: OK, the input of a prompt, or Cancel for a `danger` confirm.
// The text goes in with textContent only. Styles: css/dialog.css.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.AppDialog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FINGERPRINT = /\b(SHA256|MD5):[A-Za-z0-9+/=:]{8,}/;

  function text(value) {
    return value == null ? '' : String(value);
  }

  function wantsMonospace(message, options) {
    if (typeof options.monospace === 'boolean') return options.monospace;
    return FINGERPRINT.test(message);
  }

  // Builds a dialog API bound to a document getter, so the tests can pass a
  // small fake DOM. The browser global uses the page document.
  function create(getDocument) {
    const queue = [];
    let active = null;

    function show(kind, message, options) {
      const opts = options && typeof options === 'object' ? options : {};
      return new Promise((resolve) => {
        queue.push({ kind: kind, message: text(message), options: opts, resolve: resolve });
        if (!active) next();
      });
    }

    function next() {
      const request = queue.shift();
      if (!request) return;
      const doc = getDocument();
      if (!doc || !doc.body) {
        // No page to draw on: answer like a dismissed dialog.
        request.resolve(cancelValue(request.kind));
        next();
        return;
      }
      active = open(doc, request);
    }

    function cancelValue(kind) {
      if (kind === 'confirm') return false;
      if (kind === 'prompt') return null;
      return undefined;
    }

    function element(doc, tag, className) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      return node;
    }

    function open(doc, request) {
      const opts = request.options;
      const danger = request.kind === 'confirm' && opts.danger === true;
      const previousFocus = doc.activeElement || null;
      const id = 'app-dialog-' + Math.random().toString(36).slice(2, 10);

      const backdrop = element(doc, 'div', 'app-dialog-backdrop');
      const box = element(doc, 'div', 'app-dialog' + (danger ? ' app-dialog-danger' : ''));
      box.setAttribute('role', request.kind === 'alert' ? 'alertdialog' : 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-describedby', id + '-message');

      if (opts.title) {
        const title = element(doc, 'h2', 'app-dialog-title');
        title.id = id + '-title';
        title.textContent = text(opts.title);
        box.setAttribute('aria-labelledby', title.id);
        box.appendChild(title);
      }

      const message = element(doc, 'div', 'app-dialog-message'
        + (wantsMonospace(request.message, opts) ? ' app-dialog-mono' : ''));
      message.id = id + '-message';
      message.textContent = request.message;
      box.appendChild(message);

      let input = null;
      if (request.kind === 'prompt') {
        input = element(doc, 'input', 'app-dialog-input');
        input.type = 'text';
        input.value = text(opts.defaultValue);
        if (opts.placeholder) input.placeholder = text(opts.placeholder);
        input.setAttribute('aria-labelledby', id + '-message');
        box.appendChild(input);
      }

      const buttons = element(doc, 'div', 'app-dialog-buttons');
      let cancelButton = null;
      if (request.kind !== 'alert') {
        cancelButton = element(doc, 'button', 'app-dialog-button app-dialog-cancel');
        cancelButton.type = 'button';
        cancelButton.textContent = text(opts.cancelLabel || 'Cancel');
        buttons.appendChild(cancelButton);
      }
      const okButton = element(doc, 'button', 'app-dialog-button app-dialog-ok' + (danger ? ' app-dialog-ok-danger' : ''));
      okButton.type = 'button';
      okButton.textContent = text(opts.okLabel || 'OK');
      buttons.appendChild(okButton);
      box.appendChild(buttons);
      backdrop.appendChild(box);

      const focusables = [input, cancelButton, okButton].filter(Boolean);
      let closed = false;

      function finish(confirmed) {
        if (closed) return;
        closed = true;
        doc.removeEventListener('keydown', onKey, true);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        if (previousFocus && typeof previousFocus.focus === 'function') {
          try { previousFocus.focus(); } catch (error) { /* element gone */ }
        }
        let value;
        if (request.kind === 'confirm') value = confirmed;
        else if (request.kind === 'prompt') value = confirmed ? text(input.value) : null;
        active = null;
        request.resolve(value);
        next();
      }

      function onKey(event) {
        // The dialog is modal: no app shortcut sees the key.
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          finish(doc.activeElement === cancelButton && cancelButton ? false : true);
        } else if (event.key === 'Tab') {
          event.preventDefault();
          const at = focusables.indexOf(doc.activeElement);
          const step = event.shiftKey ? -1 : 1;
          const to = at < 0 ? 0 : (at + step + focusables.length) % focusables.length;
          focusables[to].focus();
        }
      }

      okButton.addEventListener('click', () => finish(true));
      if (cancelButton) cancelButton.addEventListener('click', () => finish(false));
      backdrop.addEventListener('mousedown', (event) => {
        if (event.target === backdrop) event.preventDefault();
      });
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) finish(false);
      });
      doc.addEventListener('keydown', onKey, true);
      doc.body.appendChild(backdrop);

      const first = input || (danger ? cancelButton : okButton);
      first.focus();
      if (input && typeof input.select === 'function') input.select();

      return { kind: request.kind, finish: finish, element: backdrop };
    }

    return {
      alert: (message, options) => show('alert', message, options),
      confirm: (message, options) => show('confirm', message, options),
      prompt: (message, options) => show('prompt', message, options),
      isOpen: () => active !== null,
      pending: () => queue.length
    };
  }

  const page = create(() => (typeof document !== 'undefined' ? document : null));

  return {
    alert: page.alert,
    confirm: page.confirm,
    prompt: page.prompt,
    isOpen: page.isOpen,
    pending: page.pending,
    create: create,
    wantsMonospace: (message, options) => wantsMonospace(text(message), options || {})
  };
});
