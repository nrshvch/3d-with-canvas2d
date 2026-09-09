// node bench/explore.js -- pure-JS parameter sweep. No canvas: only counts
// (fills / subpaths / vertices) + the CPU cost of the batching stage itself.
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const sb = { performance: { now: () => Number(process.hrtime.bigint()) / 1e6 }, console, Math, Date };
vm.createContext(sb);
for (const f of ['mesh.js', 'scene.js', 'render.js'])
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), sb, { filename: f });
const { makeTorusKnot, makeSphere, makeGrid, makeSoup, Scene, Renderer, Stats } = sb;

function CountCtx() { this.fills = 0; this.subpaths = 0; this.verts = 0; }
CountCtx.prototype.beginPath = function () { };
CountCtx.prototype.moveTo = function () { this.subpaths++; this.verts++; };
CountCtx.prototype.lineTo = function () { this.verts++; };
CountCtx.prototype.closePath = function () { };
CountCtx.prototype.fill = function () { this.fills++; };
Object.defineProperty(CountCtx.prototype, 'fillStyle', { set() { } });

const ANG = [0.4, 0.9, 0.13, 3.1, 620];
const W = 1280, H = 720;

const meshes = [
  ['torusKnot', makeTorusKnot(512, 64, 3, 7, 8), 24, 8],
  ['sphere', makeSphere(256, 128, 4), 24, 4],
  ['grid', makeGrid(180, 4), 24, 4],
  ['soup40k', makeSoup(40000, 8, 777), 32, 8]
];

function timeIt(fn, iters) {
  fn(); fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 / iters;
}

for (const [nm, mesh, sh, bd] of meshes) {
  const scene = new Scene(mesh, W, H, sh, bd);
  const R = new Renderer(scene, 16);
  scene.build.apply(scene, ANG);
  console.log('\n================ ' + nm + '  (tris=' + mesh.nt + ', visible=' + scene.nVis + ', colours=' + (sh * bd) + ') ================');
  console.log('batcher'.padEnd(24) + 'fills'.padStart(8) + 'subpaths'.padStart(10) + 'verts'.padStart(9) +
    '  tri/fill'.padStart(10) + '  batchMs'.padStart(9));

  const runs = [];
  runs.push(['baseline per-tri', null, () => { }]);
  runs.push(['runs (consecutive)', 'emitTris', () => R.batchRuns()]);
  for (const K of [4, 8, 16, 32, 64]) runs.push(['lookback K=' + K, 'emitTris', () => R.batchLookback(K)]);
  for (const T of [1, 2, 4, 8, 16, 32]) runs.push(['grid tile=' + T, 'emitTris', () => { R.setTile(T); R.batchGrid(); }]);
  for (const T of [1, 2, 4, 8, 16]) runs.push(['gridExact tile=' + T, 'emitTris', () => { R.setTile(T); R.batchGridExact(); }]);
  runs.push(['colorOnly (invalid)', 'emitTris', () => R.batchColorOnly()]);

  for (const [label, emit, batch] of runs) {
    if (emit === null) {
      console.log(label.padEnd(24) + String(scene.nVis).padStart(8) + String(scene.nVis).padStart(10) +
        String(scene.nVis * 3).padStart(9) + '1.00'.padStart(10) + '0.000'.padStart(9));
      continue;
    }
    batch();
    const c = new CountCtx(), st = new Stats();
    R.emitTris(c, st);
    const ms = timeIt(batch, 20);
    console.log(label.padEnd(24) + String(c.fills).padStart(8) + String(c.subpaths).padStart(10) +
      String(c.verts).padStart(9) + (scene.nVis / c.fills).toFixed(2).padStart(10) + ms.toFixed(3).padStart(9));
  }

  // --- what does boundary extraction add on top of the best batcher? -------
  console.log('\n  -- boundary extraction (edge cancellation) on top --');
  console.log('  ' + 'batcher'.padEnd(22) + 'fills'.padStart(8) + 'subpaths'.padStart(10) + 'verts'.padStart(9) +
    '  vs per-tri verts'.padStart(18) + '  emitMs'.padStart(9));
  const bset = [
    ['runs', () => R.batchRuns()],
    ['grid tile=2', () => { R.setTile(2); R.batchGrid(); }],
    ['grid tile=4', () => { R.setTile(4); R.batchGrid(); }],
    ['grid tile=8', () => { R.setTile(8); R.batchGrid(); }],
    ['gridExact tile=2', () => { R.setTile(2); R.batchGridExact(); }],
    ['gridExact tile=4', () => { R.setTile(4); R.batchGridExact(); }],
    ['gridExact tile=8', () => { R.setTile(8); R.batchGridExact(); }],
    ['lookback K=16', () => R.batchLookback(16)],
    ['colorOnly (invalid)', () => R.batchColorOnly()]
  ];
  for (const [label, batch] of bset) {
    batch();
    const c1 = new CountCtx(), s1 = new Stats(); R.emitBoundary(c1, s1, false);
    const c2 = new CountCtx(), s2 = new Stats(); R.emitBoundary(c2, s2, true);
    const em = timeIt(() => { const cc = new CountCtx(), ss = new Stats(); R.emitBoundary(cc, ss, true); }, 10);
    console.log('  ' + (label + ' +bnd').padEnd(22) + String(c1.fills).padStart(8) + String(c1.subpaths).padStart(10) +
      String(c1.verts).padStart(9) + (100 * c1.verts / (scene.nVis * 3)).toFixed(1).padStart(17) + '%' + ''.padStart(9));
    console.log('  ' + (label + ' +bnd+col').padEnd(22) + String(c2.fills).padStart(8) + String(c2.subpaths).padStart(10) +
      String(c2.verts).padStart(9) + (100 * c2.verts / (scene.nVis * 3)).toFixed(1).padStart(17) + '%' + em.toFixed(3).padStart(9));
  }
}
