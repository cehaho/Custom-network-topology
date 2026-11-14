#!/usr/bin/env node
// Builds src-tauri/data/oui.txt, the MAC vendor table used by discovery.
//
// Input: an IEEE MA-L listing, either the IEEE CSV
// (https://standards-oui.ieee.org/oui/oui.csv: Registry,Assignment,
// Organization Name,...) or Wireshark's `manuf` file
// (https://www.wireshark.org/download/automated/data/manuf.gz, gunzipped),
// whose third column is the IEEE organization name. Only 24-bit (MA-L)
// blocks are kept; names are shortened ("Cisco Systems, Inc" -> "Cisco
// Systems").
//
// Output: one line per vendor, `Name<TAB>prefix,prefix,...`, prefixes as six
// upper-case hex digits. Usage: node scripts/build-oui.js <input> [output]
'use strict';

const fs = require('fs');
const path = require('path');

const SUFFIXES = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'llc',
  'gmbh', 'ag', 'sa', 'srl', 'bv', 'nv', 'oy', 'ab', 'as', 'plc', 'pty', 'kg', 'spa', 'sas',
  'kk', 'lp', 'pte', 'sdn', 'bhd', 'mbh', 'cokg', 'coltd', 'ltda', 'technology', 'technologies',
  'tech', 'international', 'intl', 'group', 'holdings', 'the'
]);
const MAX_WORDS = 3;
const MAX_LENGTH = 28;
const SKIP = /^(ieee registration authority|private)$/i;

function shortName(full) {
  let name = String(full || '').replace(/\s+/g, ' ').trim();
  name = name.replace(/\(.*?\)/g, ' ').split(',')[0].replace(/\s+/g, ' ').trim();
  let words = name.split(' ').filter(Boolean);
  const bare = (word) => word.toLowerCase().replace(/[^a-z0-9]/g, '');
  while (words.length > 1 && (SUFFIXES.has(bare(words[words.length - 1])) || bare(words[words.length - 1]) === '')) {
    words.pop();
  }
  words = words.slice(0, MAX_WORDS);
  while (words.length > 1 && SUFFIXES.has(bare(words[words.length - 1]))) words.pop();
  let result = words.join(' ');
  if (result.length > MAX_LENGTH) result = result.slice(0, MAX_LENGTH);
  result = result.replace(/[&.,\s-]+$/, '');
  // Tabs and newlines would break the format.
  return result.replace(/[\t\r\n]/g, ' ');
}

function parseCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(field); field = ''; } else field += ch;
  }
  out.push(field);
  return out;
}

// [{ prefix: 'AABBCC', name: 'Full Name' }]
function readEntries(text) {
  const entries = [];
  text.split(/\r?\n/).forEach((line) => {
    if (!line || line.startsWith('#')) return;
    if (line.startsWith('MA-L,')) {
      const fields = parseCsvLine(line);
      entries.push({ prefix: fields[1], name: fields[2] });
      return;
    }
    const cols = line.split('\t');
    if (cols.length < 2) return;
    const block = cols[0].trim();
    if (!/^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){2}$/.test(block)) return; // MA-L only
    entries.push({ prefix: block.replace(/:/g, ''), name: (cols[2] || cols[1]).trim() });
  });
  return entries;
}

function build(text) {
  const byVendor = new Map();
  readEntries(text).forEach(({ prefix, name }) => {
    const hex = String(prefix).toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(hex) || SKIP.test(String(name).trim())) return;
    const short = shortName(name);
    if (!short) return;
    if (!byVendor.has(short)) byVendor.set(short, []);
    byVendor.get(short).push(hex);
  });
  return Array.from(byVendor.keys())
    .sort()
    .map((name) => `${name}\t${byVendor.get(name).sort().join(',')}`)
    .join('\n') + '\n';
}

if (require.main === module) {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node scripts/build-oui.js <oui.csv|manuf> [output]');
    process.exit(1);
  }
  const output = process.argv[3] || path.join(__dirname, '..', 'src-tauri', 'data', 'oui.txt');
  const table = build(fs.readFileSync(input, 'utf8'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, table);
  console.log(`Wrote ${output} (${table.length} bytes)`);
}

module.exports = { shortName, build };
