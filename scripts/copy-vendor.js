'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'renderer', 'vendor');

function copyDir(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else if (entry.isFile() && !entry.name.endsWith('.map')) {
      fs.copyFileSync(from, to);
    }
  }
}

function requireDir(relativePath) {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Missing ${relativePath}. Install dependencies before copying the vendor files.`);
  }
  return absolute;
}

fs.rmSync(vendor, { recursive: true, force: true });
fs.mkdirSync(vendor, { recursive: true });

copyDir(requireDir('node_modules/@xterm/xterm/lib'), path.join(vendor, 'xterm'));
copyDir(requireDir('node_modules/@xterm/addon-fit/lib'), path.join(vendor, 'addon-fit'));
fs.copyFileSync(
  requireDir('node_modules/@xterm/xterm/css/xterm.css'),
  path.join(vendor, 'xterm.css')
);
fs.copyFileSync(
  requireDir('node_modules/lucide/dist/umd/lucide.min.js'),
  path.join(vendor, 'lucide.min.js')
);

// Build only the Tailwind utilities used in renderer/ instead of the runtime Play CDN.
execFileSync(
  process.execPath,
  [
    requireDir('node_modules/tailwindcss/lib/cli.js'),
    '--config', path.join(root, 'tailwind.config.js'),
    '--input', path.join(root, 'tailwind.css'),
    '--output', path.join(vendor, 'tailwind.css'),
    '--minify'
  ],
  { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] }
);

console.log('Copied xterm and Lucide, built Tailwind CSS into renderer/vendor');
