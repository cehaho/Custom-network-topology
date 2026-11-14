'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Canvas = require('../renderer/js/canvas.js');
const Probe = require('../renderer/js/probe.js');

const COLS = 'ABCDEFGHIJKLMNOPQRST'.split('');

// Records every 2D context call and property write, in order.
function recordingContext() {
  const calls = [];
  const target = {};
  const ctx = new Proxy(target, {
    get(_, name) {
      if (name === 'calls') return calls;
      if (name in target) return target[name];
      return (...args) => calls.push([name, ...args]);
    },
    set(_, name, value) {
      target[name] = value;
      calls.push(['set ' + String(name), value]);
      return true;
    }
  });
  return ctx;
}

function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message || ''} ${actual} != ${expected}`);
}

// ---- Grid ----

test('snap puts a position on the centre of its 5% cell', () => {
  assert.deepEqual(Canvas.snapToGrid(11, 23, true), { x: 12.5, y: 22.5 });
  assert.deepEqual(Canvas.snapToGrid(14.9, 25.1, true), { x: 12.5, y: 27.5 });
});

test('snap clamps to the first and last cells', () => {
  assert.deepEqual(Canvas.snapToGrid(-20, -20, true), { x: 2.5, y: 2.5 });
  assert.deepEqual(Canvas.snapToGrid(140, 400, true), { x: 97.5, y: 247.5 });
});

test('snap off leaves the position alone', () => {
  assert.deepEqual(Canvas.snapToGrid(11.3, 300, false), { x: 11.3, y: 300 });
});

test('grid cell names column letter and row number, ? off the grid', () => {
  assert.deepEqual(Canvas.gridCell(2.5, 2.5, COLS), { col: 'A', row: 1 });
  assert.deepEqual(Canvas.gridCell(97.5, 247.5, COLS), { col: 'T', row: 50 });
  assert.deepEqual(Canvas.gridCell(5, 5, COLS), { col: 'A', row: 1 }, 'a boundary belongs to the cell before');
  assert.deepEqual(Canvas.gridCell(0, 260, COLS), { col: '?', row: '?' });
});

test('a dragged node is held inside the grid area', () => {
  assert.deepEqual(Canvas.clampNodePosition(-5, 999), { x: 1, y: 250 });
  assert.deepEqual(Canvas.clampNodePosition(40, 60), { x: 40, y: 60 });
});

// ---- Zoom and pan ----

test('zoom keeps the world point under the cursor fixed', () => {
  const view = { scale: 1.5, pointX: 40, pointY: -20 };
  const before = Canvas.screenToWorld(view, 300, 200);
  const zoomedIn = Canvas.zoomAt(view, 300, 200, -100);
  near(zoomedIn.scale, 1.65);
  const after = Canvas.screenToWorld(zoomedIn, 300, 200);
  near(after.x, before.x, 'x');
  near(after.y, before.y, 'y');

  const zoomedOut = Canvas.zoomAt(view, 300, 200, 100);
  near(zoomedOut.scale, 1.5 / 1.1);
});

test('zoom stays between 0.1 and 5', () => {
  assert.equal(Canvas.zoomAt({ scale: 4.9, pointX: 0, pointY: 0 }, 0, 0, -1).scale, Canvas.MAX_SCALE);
  assert.equal(Canvas.zoomAt({ scale: 0.105, pointX: 0, pointY: 0 }, 0, 0, 1).scale, Canvas.MIN_SCALE);
});

test('screen to world removes the viewport origin, pan and scale', () => {
  const view = { scale: 2, pointX: 100, pointY: 50 };
  assert.deepEqual(Canvas.screenToWorld(view, 310, 260, 10, 10), { x: 100, y: 100 });
});

test('centring puts the world point in the middle of the viewport', () => {
  const view = { scale: 2, ...Canvas.centerOn(500, 300, 800, 600, 2) };
  assert.deepEqual(Canvas.screenToWorld(view, 400, 300), { x: 500, y: 300 });
});

// ---- Rectangle selection ----

test('a selection rectangle is the same whichever way it was dragged', () => {
  const expected = { x: 10, y: 20, width: 90, height: 60 };
  assert.deepEqual(Canvas.normalizeRect(10, 20, 100, 80), expected);
  assert.deepEqual(Canvas.normalizeRect(100, 80, 10, 20), expected);
});

test('rectangle selection picks the nodes whose centre is inside, edges included', () => {
  const nodes = [
    { id: 'in', x: 25, y: 25 },
    { id: 'edge', x: 50, y: 50 },
    { id: 'out', x: 75, y: 25 }
  ];
  // World 1000 x 800: centres at (250,200), (500,400), (750,200).
  const rect = { x: 200, y: 150, width: 300, height: 250 };
  assert.deepEqual(Canvas.nodesInRect(nodes, rect, 1000, 800), ['in', 'edge']);
  assert.deepEqual(Canvas.nodesInRect(nodes, { x: 0, y: 0, width: 0, height: 0 }, 1000, 800), []);
});

// ---- Ports and link paths ----

test('ports on one side spread out like the CSS', () => {
  const one = [{ id: 'a', side: 'top' }];
  assert.equal(Canvas.portOffsetPercent(one, one[0]), 50);
  const two = [{ id: 'a', side: 'top' }, { id: 'b', side: 'top' }, { id: 'c', side: 'left' }];
  assert.deepEqual(two.slice(0, 2).map((p) => Canvas.portOffsetPercent(two, p)), [35, 65]);
  const three = ['a', 'b', 'c'].map((id) => ({ id, side: 'bottom' }));
  assert.deepEqual(three.map((p) => Canvas.portOffsetPercent(three, p)), [30, 50, 70]);
  const five = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, side: 'right' }));
  assert.deepEqual(five.map((p) => Canvas.portOffsetPercent(five, p)), [20, 35, 50, 65, 80]);
});

test('port anchors sit on the matching edge of the node box', () => {
  const box = { x: 100, y: 200, width: 80, height: 40 };
  const ports = [
    { id: 't', side: 'top' },
    { id: 'b', side: 'bottom' },
    { id: 'l', side: 'left' },
    { id: 'r', side: 'right' }
  ];
  assert.deepEqual(Canvas.portAnchor(box, ports, ports[0]), { x: 100, y: 180 });
  assert.deepEqual(Canvas.portAnchor(box, ports, ports[1]), { x: 100, y: 220 });
  assert.deepEqual(Canvas.portAnchor(box, ports, ports[2]), { x: 60, y: 200 });
  assert.deepEqual(Canvas.portAnchor(box, ports, ports[3]), { x: 140, y: 200 });
});

test('a missing port anchors at the bottom centre', () => {
  const box = { x: 100, y: 200, width: 80, height: 40 };
  assert.deepEqual(Canvas.portAnchor(box, [], undefined), { x: 100, y: 220 });
});

test('a link leaves and enters along each port side', () => {
  // Vertical drop of 100: curvature is 50.
  assert.equal(
    Canvas.bezierPath(0, 0, 0, 100, 'bottom', 'top'),
    'M 0 0 C 0 50, 0 50, 0 100'
  );
  assert.equal(
    Canvas.bezierPath(0, 0, 60, 80, 'right', 'left'),
    'M 0 0 C 50 0, 10 80, 60 80'
  );
});

test('link curvature is capped at 100', () => {
  assert.equal(
    Canvas.bezierPath(0, 0, 0, 1000, 'bottom', 'top'),
    'M 0 0 C 0 100, 0 900, 0 1000'
  );
});

test('link label joins medium and speed and centres on the link', () => {
  assert.equal(Canvas.linkLabel({ medium: 'Fiber', speed: '10G' }), 'Fiber 10G');
  assert.equal(Canvas.linkLabel({ speed: '1G' }), '1G');
  assert.equal(Canvas.linkLabel({}), '');
  assert.deepEqual(Canvas.labelBox(0, 0, 100, 50, '1G'), {
    x: 40, y: 17, width: 20, height: 16, textX: 50, textY: 29
  });
});

test('link stroke follows the probe look', () => {
  const live = Probe.linkLook('primary', true, 'up', 'up');
  assert.deepEqual(Canvas.linkStroke(live), {
    color: Probe.COLOR_UP, opacity: '0.45', dash: null, animated: true
  });
  const standby = Probe.linkLook('failover', false, 'up', 'up');
  assert.deepEqual(Canvas.linkStroke(standby), {
    color: Probe.COLOR_UP, opacity: '0.28', dash: '2 7', animated: false
  });
  const broken = Probe.linkLook('primary', true, 'up', 'down');
  assert.equal(Canvas.linkStroke(broken).color, Probe.COLOR_DOWN);
  assert.equal(Canvas.linkStroke(broken).animated, false);
});

// ---- Auto-layout ----

test('auto-layout puts each hop one row lower and centres each row', () => {
  const nodes = ['gw', 'sw', 'nas', 'pc'].map((id) => ({ id, x: 0, y: 0 }));
  const links = [
    { sourceNodeId: 'gw', targetNodeId: 'sw' },
    { sourceNodeId: 'sw', targetNodeId: 'nas' },
    { sourceNodeId: 'sw', targetNodeId: 'pc' }
  ];
  const layout = Canvas.autoLayout(nodes, links);
  assert.equal(layout.levelCount, 3);
  assert.deepEqual(layout.positions.get('gw'), { x: 50, y: 10 });
  assert.deepEqual(layout.positions.get('sw'), { x: 50, y: 25 });
  assert.deepEqual(layout.positions.get('nas'), { x: 44, y: 40 });
  assert.deepEqual(layout.positions.get('pc'), { x: 56, y: 40 });
});

test('auto-layout keeps unlinked nodes on the top row', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }];
  const layout = Canvas.autoLayout(nodes, []);
  assert.equal(layout.levelCount, 1);
  assert.deepEqual(layout.positions.get('a'), { x: 44, y: 10 });
  assert.deepEqual(layout.positions.get('b'), { x: 56, y: 10 });
});

test('auto-layout on a loop starts from the best connected node', () => {
  const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const links = [
    { sourceNodeId: 'a', targetNodeId: 'b' },
    { sourceNodeId: 'b', targetNodeId: 'c' },
    { sourceNodeId: 'c', targetNodeId: 'a' },
    { sourceNodeId: 'b', targetNodeId: 'd' },
    { sourceNodeId: 'd', targetNodeId: 'b' }
  ];
  const layout = Canvas.autoLayout(nodes, links);
  assert.equal(layout.positions.get('b').y, 10);
  assert.equal(layout.positions.get('d').y, 25);
});

test('auto-layout clamps wide rows and deep trees to the 5-95 band', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: 'n' + i }));
  const wide = Canvas.autoLayout(nodes, []);
  const xs = [...wide.positions.values()].map((p) => p.x);
  assert.equal(Math.min(...xs), 5);
  assert.equal(Math.max(...xs), 95);

  const chain = nodes.slice(0, 1).concat(nodes.slice(1));
  const links = chain.slice(1).map((n, i) => ({ sourceNodeId: chain[i].id, targetNodeId: n.id }));
  const deep = Canvas.autoLayout(chain, links);
  assert.equal(deep.positions.get('n11').y, 95);
});

test('auto-layout ignores links to unknown nodes', () => {
  const layout = Canvas.autoLayout([{ id: 'a' }], [{ sourceNodeId: 'ghost', targetNodeId: 'a' }]);
  assert.deepEqual(layout.positions.get('a'), { x: 50, y: 10 });
});

// ---- Minimap ----

test('minimap draws background, then links, then nodes on top', () => {
  const ctx = recordingContext();
  const nodes = [
    { id: 'gw', x: 30, y: 15, status: 'up' },
    { id: 'nas', x: 60, y: 45, status: 'down' }
  ];
  const links = [
    { id: 'l1', sourceNodeId: 'gw', targetNodeId: 'nas', role: 'primary' },
    { id: 'dangling', sourceNodeId: 'gw', targetNodeId: 'ghost', role: 'primary' }
  ];
  Canvas.drawMinimap(ctx, {
    width: 200,
    height: 150,
    dark: true,
    nodes,
    links,
    lookFor: () => ({ color: '#ef4444', waiting: false }),
    colorFor: (node) => Canvas.minimapNodeColor(false, node.status)
  });

  const names = ctx.calls.map((c) => c[0]);
  assert.deepEqual(ctx.calls[0], ['set fillStyle', '#1e293b']);
  assert.deepEqual(ctx.calls[1], ['fillRect', 0, 0, 200, 150]);
  assert.equal(names.filter((n) => n === 'stroke').length, 1, 'the dangling link is skipped');
  assert.equal(names.filter((n) => n === 'arc').length, 2);
  assert.ok(names.lastIndexOf('stroke') < names.indexOf('arc'), 'links before nodes');

  // World is 300% of the viewport: x 30% -> 30/100 * 200/3 = 20.
  const moveTo = ctx.calls.find((c) => c[0] === 'moveTo');
  near(moveTo[1], 20);
  near(moveTo[2], 7.5);
  const fills = ctx.calls.filter((c) => c[0] === 'set fillStyle').map((c) => c[1]);
  assert.deepEqual(fills.slice(1), ['#22c55e', '#ef4444']);
  assert.equal(ctx.globalAlpha, 1, 'alpha restored after each link');
});

test('minimap dims a waiting failover and uses the light background', () => {
  const ctx = recordingContext();
  Canvas.drawMinimap(ctx, {
    width: 200,
    height: 150,
    dark: false,
    nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 10 }],
    links: [{ sourceNodeId: 'a', targetNodeId: 'b' }],
    lookFor: () => ({ color: '#94a3b8', waiting: true }),
    colorFor: () => '#94a3b8'
  });
  assert.deepEqual(ctx.calls[0], ['set fillStyle', '#f1f5f9']);
  const alphas = ctx.calls.filter((c) => c[0] === 'set globalAlpha').map((c) => c[1]);
  assert.deepEqual(alphas, [0.35, 1]);
});

test('minimap node colour: selection wins, then status', () => {
  assert.equal(Canvas.minimapNodeColor(true, 'down'), '#3b82f6');
  assert.equal(Canvas.minimapNodeColor(false, 'up'), '#22c55e');
  assert.equal(Canvas.minimapNodeColor(false, 'down'), '#ef4444');
  assert.equal(Canvas.minimapNodeColor(false, 'unknown'), '#94a3b8');
});

test('minimap viewport box tracks pan and zoom and is clipped', () => {
  // World 3000 x 1800 on a 200 x 150 minimap.
  const atOrigin = Canvas.minimapIndicator({ scale: 1, pointX: 0, pointY: 0 }, 1000, 600, 3000, 1800, 200, 150);
  near(atOrigin.left, 0);
  near(atOrigin.width, 200 / 3);
  near(atOrigin.height, 50);

  const zoomed = Canvas.minimapIndicator({ scale: 2, pointX: -1000, pointY: -600 }, 1000, 600, 3000, 1800, 200, 150);
  near(zoomed.left, 500 * 200 / 3000);
  near(zoomed.top, 300 * 150 / 1800);
  near(zoomed.width, 500 * 200 / 3000);

  const pastLeft = Canvas.minimapIndicator({ scale: 1, pointX: 300, pointY: 0 }, 1000, 600, 3000, 1800, 200, 150);
  assert.equal(pastLeft.left, 0, 'never left of the minimap');
});

test('a minimap click maps back to the world and recentres there', () => {
  const world = Canvas.minimapToWorld(100, 75, 200, 150, 3000, 1800);
  assert.deepEqual(world, { x: 1500, y: 900 });
  const view = { scale: 1.5, ...Canvas.centerOn(world.x, world.y, 1000, 600, 1.5) };
  assert.deepEqual(Canvas.screenToWorld(view, 500, 300), world);
});

// ---- Wiring ----

test('the page loads canvas.js before the app modules', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const canvasAt = html.indexOf('src="js/canvas.js"');
  const appAt = html.indexOf('<script type="module" src="js/app/main.js">');
  assert.ok(canvasAt > 0, 'canvas.js is loaded');
  assert.ok(appAt > 0 && canvasAt < appAt, 'before js/app/main.js');
});

test('the module also sets the browser global', () => {
  assert.equal(globalThis.TopologyCanvas, Canvas);
});
