'use strict';

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
    throw new Error(`Missing ${relativePath}. Install dependencies before copying the terminal vendor files.`);
  }
  return absolute;
}

fs.rmSync(vendor, { recursive: true, force: true });
fs.mkdirSync(vendor, { recursive: true });

copyDir(requireDir('node_modules/xterm/lib'), path.join(vendor, 'xterm'));
copyDir(requireDir('node_modules/xterm-addon-fit/lib'), path.join(vendor, 'xterm-addon-fit'));
fs.copyFileSync(
  requireDir('node_modules/xterm/css/xterm.css'),
  path.join(vendor, 'xterm.css')
);

console.log('Copied xterm assets to renderer/vendor');
