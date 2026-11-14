// Discovery helpers: suggested node names and icons from reverse DNS and
// MAC vendor, deduplication against the canvas, and placement of new nodes.
//
// Pure functions only. app.js owns the dialog and the document; positions
// are canvas percentages (see canvas.js: x of the width, y of the height).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.Discovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PRIVATE_VENDOR = 'Private/random';
  const PLACE_STEP_X = 10;
  const PLACE_STEP_Y = 12;
  const MIN_GAP = 6; // a new node keeps this distance from existing ones
  const MAX_X = 95;
  const MIN_X = 5;
  const MIN_Y = 5;
  const MAX_Y = 245; // 50 rows of 5%

  // Vendor and hostname hints, checked in order. Icons are Lucide names.
  const ICON_RULES = [
    { icon: 'printer', vendor: /\b(brother|canon|epson|lexmark|xerox|kyocera|ricoh|konica|sharp)\b/i, host: /\b(printer|print|prn|mfp)\b/i },
    { icon: 'cctv', vendor: /\b(hikvision|dahua|axis communications|reolink|hanwha|vivotek|mobotix)\b/i, host: /\b(cam|camera|ipcam|nvr|dvr)\b/i },
    { icon: 'hard-drive', vendor: /\b(synology|qnap|western digital|seagate|buffalo|asustor|netapp)\b/i, host: /\b(nas|storage|backup)\b/i },
    { icon: 'router', vendor: /\b(cisco|juniper|mikrotik|routerboard|ubiquiti|netgear|tp-link|tp link|sagemcom|avm|arcadyan|zyxel|draytek|fortinet|palo alto|aruba|ruckus|technicolor|huawei|zte|sercomm|arris|commscope|linksys|d-link)\b/i, host: /\b(router|gw|gateway|fw|firewall|switch|sw|ap|wap|livebox|freebox|fritz)\b/i },
    { icon: 'server', vendor: /\b(vmware|supermicro|dell|hewlett|hpe|lenovo|proxmox|nutanix|xensource|qemu|parallels)\b/i, host: /\b(srv|server|esx|esxi|pve|proxmox|hyperv|vm|db|sql|web|mail|dns|dc)\b/i },
    { icon: 'cpu', vendor: /\b(raspberry|espressif|arduino|particle|tuya|shelly|sonoff|itead|silicon labs)\b/i, host: /\b(pi|rpi|raspberrypi|esp|iot|sensor|plug)\b/i },
    { icon: 'tv', vendor: /\b(roku|lg electronics|vizio|tcl|hisense|nvidia|chromecast)\b/i, host: /\b(tv|chromecast|roku|shield|appletv)\b/i },
    { icon: 'speaker', vendor: /\b(sonos|bose|harman|denon|yamaha)\b/i, host: /\b(sonos|speaker|echo|homepod)\b/i },
    { icon: 'smartphone', vendor: /\b(oneplus|oppo|vivo|realme|motorola mobility|xiaomi)\b/i, host: /\b(phone|iphone|android|pixel|galaxy)\b/i },
    { icon: 'laptop', vendor: /\b(apple|intel corporate|liteon|azurewave|hon hai|quanta|compal|wistron|pegatron)\b/i, host: /\b(laptop|macbook|notebook|desktop|pc|workstation|imac)\b/i }
  ];

  function isIpLiteral(text) {
    const value = String(text || '');
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':');
  }

  // Canonical address text for comparison: trimmed, unbracketed, lower-case,
  // an IPv6 literal compressed (RFC 5952 via URL) with its zone kept.
  function canonicalAddress(address) {
    let text = String(address || '').trim().toLowerCase();
    if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
    if (!text.includes(':')) return text;
    const index = text.indexOf('%');
    const bare = index === -1 ? text : text.slice(0, index);
    const zone = index === -1 ? '' : text.slice(index);
    try {
      return new URL('http://[' + bare + ']/').hostname.slice(1, -1) + zone;
    } catch (error) {
      return text;
    }
  }

  // "nas.home.lan" -> "nas". Empty for an address or nothing.
  function shortHostName(hostname) {
    const text = String(hostname || '').trim().replace(/\.$/, '');
    if (!text || isIpLiteral(text)) return '';
    return text.split('.')[0];
  }

  function usableVendor(vendor) {
    const text = String(vendor || '').trim();
    return text && text !== PRIVATE_VENDOR ? text : '';
  }

  // Last IPv4 octet or last IPv6 group: "192.168.1.42" -> "42".
  function addressSuffix(ip) {
    const text = String(ip || '').split('%')[0];
    const parts = text.includes(':') ? text.split(':') : text.split('.');
    return parts[parts.length - 1] || text;
  }

  // PTR short name, else "<vendor> <last octet>", else "Device <ip>".
  function suggestName(host) {
    const entry = host || {};
    const short = shortHostName(entry.hostname);
    if (short) return short;
    const vendor = usableVendor(entry.vendor);
    if (vendor) return vendor + ' ' + addressSuffix(entry.ip);
    return 'Device ' + String(entry.ip || '');
  }

  // A Lucide icon name from hostname keywords first, then the vendor.
  function suggestIcon(host) {
    const entry = host || {};
    const words = shortHostName(entry.hostname).replace(/[-_]+/g, ' ').replace(/(\D)(\d)/g, '$1 $2');
    if (words) {
      const byHost = ICON_RULES.find((rule) => rule.host.test(words));
      if (byHost) return byHost.icon;
    }
    const vendor = usableVendor(entry.vendor);
    if (vendor) {
      const byVendor = ICON_RULES.find((rule) => rule.vendor.test(vendor));
      if (byVendor) return byVendor.icon;
    }
    return 'circle';
  }

  // Hosts whose address is not already a node (nor repeated in the list).
  function newHosts(hosts, nodes) {
    const seen = new Set((nodes || []).map((node) => canonicalAddress(node && node.address)).filter(Boolean));
    const out = [];
    (hosts || []).forEach((host) => {
      if (!host || !host.ip) return;
      const key = canonicalAddress(host.ip);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(host);
    });
    return out;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // `count` positions on a grid around `center`, filled ring by ring
  // (nearest cells first), skipping cells within MIN_GAP of an existing node.
  function placeNear(center, count, existing) {
    const cx = clamp(Number(center && center.x) || 50, MIN_X, MAX_X);
    const cy = clamp(Number(center && center.y) || 50, MIN_Y, MAX_Y);
    const taken = (existing || [])
      .filter((node) => node && Number.isFinite(node.x) && Number.isFinite(node.y))
      .map((node) => ({ x: node.x, y: node.y }));
    const free = (x, y) => taken.every((p) => Math.abs(p.x - x) >= MIN_GAP || Math.abs(p.y - y) >= MIN_GAP);
    const positions = [];
    const maxRing = Math.ceil((MAX_Y - MIN_Y) / PLACE_STEP_Y) + 1;
    for (let ring = 0; positions.length < count && ring <= maxRing; ring += 1) {
      const cells = [];
      for (let row = -ring; row <= ring; row += 1) {
        for (let col = -ring; col <= ring; col += 1) {
          if (Math.max(Math.abs(row), Math.abs(col)) !== ring) continue;
          cells.push({ row: row, col: col });
        }
      }
      // Row by row, left to right, so a batch reads like a grid.
      cells.sort((a, b) => a.row - b.row || a.col - b.col);
      for (const cell of cells) {
        if (positions.length >= count) break;
        const x = cx + cell.col * PLACE_STEP_X;
        const y = cy + cell.row * PLACE_STEP_Y;
        if (x < MIN_X || x > MAX_X || y < MIN_Y || y > MAX_Y || !free(x, y)) continue;
        const point = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
        positions.push(point);
        taken.push(point);
      }
    }
    // Canvas full: stack the rest on the centre rather than drop them.
    while (positions.length < count) positions.push({ x: cx, y: cy });
    return positions;
  }

  // Node fields for the selected hosts that are not on the canvas yet:
  // { name, address, mac?, icon, iconType, x, y }. `host.name` (edited in
  // the dialog) wins over the suggestion.
  function nodesForHosts(hosts, nodes, center) {
    const fresh = newHosts(hosts, nodes);
    const positions = placeNear(center, fresh.length, nodes);
    return fresh.map((host, index) => {
      const node = {
        name: String(host.name || '').trim() || suggestName(host),
        address: host.ip,
        icon: suggestIcon(host),
        iconType: 'lucide',
        x: positions[index].x,
        y: positions[index].y
      };
      if (host.mac) node.mac = String(host.mac).toLowerCase();
      return node;
    });
  }

  return {
    PRIVATE_VENDOR: PRIVATE_VENDOR,
    canonicalAddress: canonicalAddress,
    shortHostName: shortHostName,
    suggestName: suggestName,
    suggestIcon: suggestIcon,
    newHosts: newHosts,
    placeNear: placeNear,
    nodesForHosts: nodesForHosts
  };
});
