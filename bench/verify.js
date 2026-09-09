// node bench/verify.js -- algorithmic invariants, no canvas needed.
//   1. signed-area conservation  (edge cancellation must not change the region)
//   2. depth-order conservation  (every genuinely overlapping pair of
//      differently-coloured triangles keeps its relative order)
// Overlap is tested EXACTLY (separating-axis on the 6 edge normals), not by
// bounding box, because the whole point of the exact-coverage batcher is that
// edge-adjacent triangles do NOT overlap.
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const sb = { performance: { now: () => Number(process.hrtime.bigint()) / 1e6 }, console, Math, Date };
vm.createContext(sb);
for (const f of ['mesh.js', 'scene.js', 'render.js'])
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), sb, { filename: f });
const { makeTorusKnot, makeSphere, makeGrid, makeSoup, Scene, Renderer, Stats } = sb;
const STRATEGIES = vm.runInContext('STRATEGIES', sb);

// ---- fake 2d context that accumulates the signed area of every filled path -
function AreaCtx() { this.subpaths = 0; this.verts = 0; this.fills = 0; this.area = 0; this._reset(); }
AreaCtx.prototype._reset = function () { this._sx = 0; this._sy = 0; this._cx = 0; this._cy = 0; this._open = false; };
AreaCtx.prototype._flushSub = function () {
  if (this._open) { this._acc += this._cx * this._sy - this._sx * this._cy; this._open = false; }
};
AreaCtx.prototype.beginPath = function () { this._flushSub(); this._reset(); this._acc = 0; };
AreaCtx.prototype.moveTo = function (x, y) { this._flushSub(); this.subpaths++; this.verts++; this._sx = x; this._sy = y; this._cx = x; this._cy = y; this._open = true; };
AreaCtx.prototype.lineTo = function (x, y) { this.verts++; this._acc += this._cx * y - x * this._cy; this._cx = x; this._cy = y; };
AreaCtx.prototype.closePath = function () { };
AreaCtx.prototype.fill = function () { this._flushSub(); this.fills++; this.area += this._acc; this._acc = 0; this._reset(); };
Object.defineProperty(AreaCtx.prototype, 'fillStyle', { set() { }, get() { return '#000'; } });
AreaCtx.prototype._acc = 0;

function triAreaSum(s) {
  const idx = s.m.idx, sx = s.sx, sy = s.sy;
  let a = 0;
  for (let i = 0; i < s.nVis; i++) {
    const t = s.order[i], p = idx[3 * t], q = idx[3 * t + 1], r = idx[3 * t + 2];
    a += sx[p] * sy[q] - sx[q] * sy[p] + sx[q] * sy[r] - sx[r] * sy[q] + sx[r] * sy[p] - sx[p] * sy[r];
  }
  return a;
}

// ---- exact triangle/triangle interior intersection (SAT, 6 axes) ----------
const TA = new Float64Array(6), TB = new Float64Array(6);
function loadTri(s, t, dst) {
  const idx = s.m.idx;
  for (let k = 0; k < 3; k++) { const v = idx[3 * t + k]; dst[k * 2] = s.sx[v]; dst[k * 2 + 1] = s.sy[v]; }
}
function axisSeparates(P, Q) {
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const nx = -(P[j * 2 + 1] - P[i * 2 + 1]), ny = (P[j * 2] - P[i * 2]);
    let p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const dp = nx * P[k * 2] + ny * P[k * 2 + 1]; if (dp < p0) p0 = dp; if (dp > p1) p1 = dp;
      const dq = nx * Q[k * 2] + ny * Q[k * 2 + 1]; if (dq < q0) q0 = dq; if (dq > q1) q1 = dq;
    }
    if (p1 <= q0 || q1 <= p0) return true;      // touching counts as separated
  }
  return false;
}
function trisOverlap(s, t1, t2) {
  if (s.bx1[t1] <= s.bx0[t2] || s.bx1[t2] <= s.bx0[t1]) return false;
  if (s.by1[t1] <= s.by0[t2] || s.by1[t2] <= s.by0[t1]) return false;
  loadTri(s, t1, TA); loadTri(s, t2, TB);
  return !axisSeparates(TA, TB) && !axisSeparates(TB, TA);
}

// ---- full pairwise check via a uniform bucket grid ------------------------
function checkOrder(R, minAreaPx) {
  const s = R.s, n = s.nVis, order = s.order, col = s.col;
  const pos = new Int32Array(s.m.nt).fill(-1);
  let p = 0;
  for (let b = 0; b < R.nB; b++) for (let t = R.bHead[b]; t >= 0; t = R.bNext[t]) pos[t] = p++;
  if (p !== n) return 'EMITTED ' + p + ' of ' + n;
  const depth = new Int32Array(s.m.nt).fill(-1);
  for (let i = 0; i < n; i++) depth[order[i]] = i;

  const CS = 32, gw = Math.ceil(s.W / CS) + 2, gh = Math.ceil(s.H / CS) + 2;
  const buckets = new Array(gw * gh);
  for (let i = 0; i < n; i++) {
    const t = order[i];
    let x0 = Math.max(0, Math.floor(s.bx0[t] / CS)), x1 = Math.min(gw - 1, Math.floor(s.bx1[t] / CS));
    let y0 = Math.max(0, Math.floor(s.by0[t] / CS)), y1 = Math.min(gh - 1, Math.floor(s.by1[t] / CS));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const k = y * gw + x; (buckets[k] || (buckets[k] = [])).push(t);
    }
  }
  let bad = 0, checked = 0, seen = new Set();
  for (let k = 0; k < buckets.length; k++) {
    const B = buckets[k]; if (!B) continue;
    for (let a = 0; a < B.length; a++) for (let b = a + 1; b < B.length; b++) {
      const t1 = B[a], t2 = B[b];
      if (col[t1] === col[t2]) continue;
      const key = t1 < t2 ? t1 * 1e7 + t2 : t2 * 1e7 + t1;
      if (seen.has(key)) continue; seen.add(key);
      if (!trisOverlap(s, t1, t2)) continue;
      checked++;
      const first = depth[t1] < depth[t2] ? t1 : t2, second = first === t1 ? t2 : t1;
      if (pos[first] > pos[second]) bad++;
    }
  }
  return (bad === 0 ? 'OK' : 'VIOLATIONS ' + bad) + ' / ' + checked + ' overlapping pairs';
}

const cases = [
  ['torusKnot', makeTorusKnot(200, 40, 3, 7, 8), 24, 8],
  ['sphere', makeSphere(120, 60, 4), 24, 4],
  ['grid', makeGrid(80, 4), 24, 4],
  ['soup', makeSoup(8000, 8, 777), 32, 8]
];
const strats = ['tri', 'run', 'runBoundary', 'grid', 'gridBoundary',
                'gridX', 'gridXBoundary', 'gridXBoundaryCol', 'gridXLocal'];

for (const [nm, mesh, sh, bd] of cases) {
  const scene = new Scene(mesh, 1280, 720, sh, bd);
  const R = new Renderer(scene, 4);
  scene.build(0.4, 0.9, 0.13, 3.1, 620);
  const base = triAreaSum(scene);
  console.log('\n=== ' + nm + ' ===  visible=' + scene.nVis);
  for (const st of strats) {
    const c = new AreaCtx(), stats = new Stats();
    STRATEGIES[st](R, c, stats);
    const err = Math.abs(c.area - base) / Math.abs(base) * 100;
    const ord = st === 'tri' ? 'baseline' : checkOrder(R);
    console.log('  ' + st.padEnd(18) +
      'fills=' + String(c.fills).padStart(6) +
      ' subpaths=' + String(c.subpaths).padStart(6) +
      ' verts=' + String(c.verts).padStart(7) +
      ' areaErr=' + err.toFixed(4) + '%  ' + ord);
  }
}
