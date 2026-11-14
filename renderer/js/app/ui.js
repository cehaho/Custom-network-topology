// Toasts, modals, collapsible panels and the helpers that bind buttons of
// index.html (data-action, data-close-modal, data-toggle-panel).

import { lucide } from './libs.js';
import { escapeHtml } from './util.js';

export function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
  lucide.createIcons();
}

export function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

export function setSecretHint(id, text) {
  const hint = document.getElementById(id);
  if (!hint) return;
  hint.textContent = text || '';
  hint.classList.toggle('hidden', !text);
}

function togglePanel(id) {
  const panel = document.getElementById(id + '-content');
  if (panel) {
    panel.classList.toggle('hidden');
  }
}

const toastIcons = {
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>'
};

function showToast(type, title, message, duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${toastIcons[type] || toastIcons.info}</div>
    <div class="toast-content">
      <div class="toast-title">${escapeHtml(title)}</div>
      ${message ? `<div class="toast-message">${escapeHtml(message)}</div>` : ''}
    </div>
    <div class="toast-close">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M18 6L6 18M6 6l12 12"/>
      </svg>
    </div>
  `;

  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
  container.appendChild(toast);

  // Auto-dismiss
  if (duration > 0) {
    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  return toast;
}

// Convenience functions
export function toastSuccess(title, message) { return showToast('success', title, message); }

export function toastError(title, message) { return showToast('error', title, message, 6000); }

export function toastWarning(title, message) { return showToast('warning', title, message, 5000); }

export function toastInfo(title, message) { return showToast('info', title, message); }

// Calls handler() (without the event) when an element with
// data-action="<name>" is clicked.
export function onAction(name, handler) {
  document.querySelectorAll(`[data-action="${name}"]`).forEach((el) => {
    el.addEventListener('click', () => handler());
  });
}

export function bindModalControls() {
  document.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', () => closeModal(button.dataset.closeModal));
  });
  document.querySelectorAll('[data-toggle-panel]').forEach((header) => {
    header.addEventListener('click', () => togglePanel(header.dataset.togglePanel));
  });
}
