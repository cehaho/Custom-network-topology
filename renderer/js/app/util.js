// Pure helpers: HTML escaping, sanitising of user-supplied icon/colour values,
// duration formatting.

export function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ' + (minutes % 60) + 'm';
  const days = Math.floor(hours / 24);
  return days + 'd ' + (hours % 24) + 'h';
}

export function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeLucideName(name) {
  return /^[a-z0-9-]+$/i.test(name || '') ? name : 'circle';
}

export function safeContainerType(type) {
  const allowed = ['proxmox', 'docker', 'kubernetes', 'vmware', 'rack', 'cloud', 'custom'];
  return allowed.includes(type) ? type : 'custom';
}

export function safeCssColor(color) {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color || '') ? color : '#64748b';
}

export function sanitizeSvg(svg) {
  if (typeof svg !== 'string') return '';
  const trimmed = svg.trim();
  if (!trimmed.startsWith('<svg') || !trimmed.endsWith('</svg>')) return '';
  if (/<script|<\/script|on\w+\s*=|javascript:|data:/i.test(trimmed)) return '';
  return trimmed;
}
