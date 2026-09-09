// node bench/optimality.js
//
// Two questions the timing benchmarks cannot answer:
//
//  1. HOW FAR FROM OPTIMAL is the greedy batcher?  "Number of distinct
//     colours" is a useless floor -- it ignores the depth constraints
//     entirely.  A real lower bound: take any chain in the constraint DAG
//     (u before v whenever they overlap and u is behind v).  Every element of
//     a chain keeps its relative order in any valid emission, so each colour
//     change along the chain forces a new batch.  Hence
//
//         minBatches >= 1 + max over chains of (colour changes along it)
//
//     computable by DP over the depth order, which IS a topological order.
//
//  2. WHAT HAPPENS WHEN TRIANGLES GET SMALLER THAN A TILE?  The occupancy
//     grid claims tiles by centre coverage; a sub-tile triangle covers no
//     centre and falls back to claiming the one tile holding its centroid.
//     That is conservative, so as triangle size drops below the tile the
//     batcher should degrade toward bounding-box behaviour.  Sweep the
//     projection scale and watch it.
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const sb = { performance: { now: () => Number(process.hrtime.bigint()) / 1e6 }, console, Math, Date, Map };
vm.createContext(sb);
for (const f of ['mesh.js', 'scene.js', 'render.js'])
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), sb, { filename: f });
const { makeTorusKnot, makeSphere, makeGrid, Scene, Renderer, Stats } = sb;

function CountCtx() { this.fills = 0; this.verts = 0; }
CountCtx.prototype.beginPath = function () { };
CountCtx.prototype.moveTo = function () { this.verts++; };
CountCtx.prototype.lineTo = function () { this.verts++; };
CountCtx.prototype.closePath = function () { };
CountCtx.prototype.fill = function () { this.fills++; };
CountCtx.prototype.stroke = function () { };
Object.defineProperty(CountCtx.prototype, 'fillStyle', { set() { } });
Object.defineProperty(CountCtx.prototype, 'strokeStyle', { set() { } });

// ---- exact triangle/triangle interior overlap (SAT) ------------------------
const TA = new Float64Array(6), TB = new Float64Array(6);
function loadTri(s, t, d) {
  const idx = s.m.idx;
  for (let k = 0; k < 3; k++) { const v = idx[3 * t + k]; d[k * 2] = s.sx[v]; d[k * 2 + 1] = s.sy[v]; }
}
function sep(P, Q) {
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const nx = -(P[j * 2 + 1] - P[i * 2 + 1]), ny = (P[j * 2] - P[i * 2]);
    let p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const a = nx * P[k * 2] + ny * P[k * 2 + 1]; if (a < p0) p0 = a; if (a > p1) p1 = a;
      const b = nx * Q[k * 2] + ny * Q[k * 2 + 1]; if (b < q0) q0 = b; if (b > q1) q1 = b;
    }
    if (p1 <= q0 || q1 <= p0) return true;
  }
  return false;
}
function overlap(s, a, b) {
  if (s.bx1[a] <= s.bx0[b] || s.bx1[b] <= s.bx0[a]) return false;
  if (s.by1[a] <= s.by0[b] || s.by1[b] <= s.by0[a]) return false;
  loadTri(s, a, TA); loadTri(s, b, TB);
  return !sep(TA, TB) && !sep(TB, TA);
}

// ---- chain lower bound -----------------------------------------------------
function chainLowerBound(s) {
  const n = s.nVis, order = s.order, col = s.col;
  const depth = new Int32Array(s.m.nt).fill(-1);
  for (let i = 0; i < n; i++) depth[order[i]] = i;

  const CS = 24, gw = Math.ceil(s.W / CS) + 2, gh = Math.ceil(s.H / CS) + 2;
  const buckets = new Array(gw * gh);
  const f = new Int32Array(n);            // f[i] = best colour-changes ending at order[i]
  let best = 0, pairs = 0;

  for (let i = 0; i < n; i++) {
    const t = order[i];
    let x0 = Math.max(0, Math.floor(s.bx0[t] / CS)), x1 = Math.min(gw - 1, Math.floor(s.bx1[t] / CS));
    let y0 = Math.max(0, Math.floor(s.by0[t] / CS)), y1 = Math.min(gh - 1, Math.floor(s.by1[t] / CS));
    let fi = 0;
    const seen = new Set();
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const B = buckets[y * gw + x];
      if (!B) continue;
      for (let k = 0; k < B.length; k++) {
        const u = B[k];
        if (seen.has(u)) continue;
        seen.add(u);
        pairs++;
        if (!overlap(s, u, t)) continue;
        const cand = f[depth[u]] + (col[u] !== col[t] ? 1 : 0);
        if (cand > fi) fi = cand;
      }
    }
    f[i] = fi;
    if (fi > best) best = fi;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const k = y * gw + x; (buckets[k] || (buckets[k] = [])).push(t);
    }
  }
  return { lb: best + 1, pairsTested: pairs };
}

function distinctColours(s) {
  const seen = new Uint8Array(256);
  for (let i = 0; i < s.nVis; i++) seen[s.col[s.order[i]]] = 1;
  let n = 0; for (let i = 0; i < 256; i++) n += seen[i];
  return n;
}

function fillsFor(R, tile, exactSmall) {
  R.exactSmall = exactSmall !== false;
  R.setTile(tile); R.batchGridExact();
  const c = new CountCtx(); R.emitBoundary(c, new Stats(), true, 0);
  return { fills: c.fills, verts: c.verts };
}

function batchMs(R, tile, iters, exactSmall) {
  R.exactSmall = exactSmall !== false;
  R.setTile(tile); R.batchGridExact(); R.batchGridExact();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) R.batchGridExact();
  return Number(process.hrtime.bigint() - t0) / 1e6 / iters;
}

// tile size that the sweep says is best, from the mean triangle area alone
function autoTile(meanTriArea) {
  const t = Math.sqrt(meanTriArea) / 4;
  let p = 1;
  while (p * 2 <= t && p < 8) p *= 2;
  if (p < 8 && Math.abs(Math.log2(t / (p * 2))) < Math.abs(Math.log2(t / p))) p *= 2;
  return Math.max(1, Math.min(8, p));
}

// ===========================================================================
console.log('=== 1. how close is the greedy to the best possible? ===\n');
const cases = [
  ['torusKnot', makeTorusKnot(200, 40, 3, 7, 8), 24, 8],
  ['sphere', makeSphere(120, 60, 4), 24, 4],
  ['grid', makeGrid(80, 4), 24, 4]
];
for (const [nm, mesh, sh, bd] of cases) {
  const s = new Scene(mesh, 1280, 720, sh, bd);
  const R = new Renderer(s, 2);
  s.build(0.4, 0.9, 0.13, 3.1, 620);
  const nc = distinctColours(s);
  const t0 = Date.now();
  const { lb, pairsTested } = chainLowerBound(s);
  const g1 = fillsFor(R, 1), g2 = fillsFor(R, 2), g4 = fillsFor(R, 4);
  // a colour needs at least one batch, and a chain needs one per colour change
  const LB = Math.max(lb, nc);
  const bestG = Math.min(g1.fills, g2.fills, g4.fills);
  console.log(nm.padEnd(11) + 'visible=' + String(s.nVis).padStart(6) +
    '  colours=' + String(nc).padStart(4) +
    '  chainLB=' + String(lb).padStart(4) +
    '  LB=' + String(LB).padStart(4) +
    '   greedy t1=' + String(g1.fills).padStart(5) +
    ' t2=' + String(g2.fills).padStart(5) +
    ' t4=' + String(g4.fills).padStart(5) +
    '   best/LB=' + (bestG / LB).toFixed(2) + 'x' +
    '   [' + ((Date.now() - t0) / 1000).toFixed(1) + 's]');
}

console.log('\n=== 2. what happens as triangles shrink below the tile? ===');
console.log('(same mesh, projection scaled down; tri area is the mean screen area)\n');
const mesh = makeTorusKnot(320, 48, 3, 7, 8);
const s2 = new Scene(mesh, 1280, 720, 24, 8);
const R2 = new Renderer(s2, 2);
console.log('scale'.padStart(6) + 'visible'.padStart(8) + 'triArea'.padStart(9) +
  'LB'.padStart(5) + 'f@t8'.padStart(7) + 'f@t4'.padStart(7) + 'f@t2'.padStart(7) +
  'f@t1'.padStart(7) + ' auto'.padStart(6) + 'centroid'.padStart(10) + 'EXACT'.padStart(8) +
  'gain'.padStart(7) + 'ms.cen'.padStart(8) + 'ms.exa'.padStart(8));
for (const scale of [1200, 620, 320, 160, 80, 40]) {
  s2.build(0.4, 0.9, 0.13, 3.1, scale);
  if (s2.nVis === 0) continue;
  let area = 0;
  for (let i = 0; i < s2.nVis; i++) {
    const t = s2.order[i];
    area += (s2.bx1[t] - s2.bx0[t]) * (s2.by1[t] - s2.by0[t]) * 0.5;
  }
  area /= s2.nVis;
  const nc = distinctColours(s2);
  const a8 = fillsFor(R2, 8, false), a4 = fillsFor(R2, 4, false), a2 = fillsFor(R2, 2, false), a1 = fillsFor(R2, 1, false);
  const at = autoTile(area);
  const cen = fillsFor(R2, at, false).fills;   // old centroid fallback
  const exa = fillsFor(R2, at, true).fills;    // exact sub-tile tests
  console.log(String(scale).padStart(6) + String(s2.nVis).padStart(8) +
    area.toFixed(1).padStart(9) + String(nc).padStart(5) +
    String(a8.fills).padStart(7) + String(a4.fills).padStart(7) +
    String(a2.fills).padStart(7) + String(a1.fills).padStart(7) +
    String(at).padStart(6) + String(cen).padStart(10) + String(exa).padStart(8) +
    (cen / exa).toFixed(2).padStart(6) + 'x' +
    batchMs(R2, at, 12, false).toFixed(2).padStart(8) +
    batchMs(R2, at, 12, true).toFixed(2).padStart(8));
}
