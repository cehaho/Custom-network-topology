// Dark/light theme.

import { lucide } from './libs.js';
import { state } from './state.js';
import { toastInfo } from './ui.js';
import { saveConfig } from './io.js';

export function initTheme() {
  const savedTheme = state.config.settings?.theme || localStorage.getItem('theme') || 'dark';
  applyTheme(savedTheme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const themeIcon = document.getElementById('theme-icon');
  if (themeIcon) {
    // Update icon based on theme
    themeIcon.setAttribute('data-lucide', theme === 'dark' ? 'moon' : 'sun');
    lucide.createIcons();
  }
  state.config.settings.theme = theme;
  localStorage.setItem('theme', theme);
}

export function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(newTheme);
  saveConfig();
  toastInfo('Theme Changed', `Switched to ${newTheme} mode`);
}
