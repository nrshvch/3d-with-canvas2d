// node bench/integrate.mjs [--far]
// ---------------------------------------------------------------------------
// The shipped modules, wired together, counts + CPU only (no canvas).
//
//     scene.build()  ->  occluder.cull()  ->  batcher.draw()
//
// Reports what the batcher is asked to do with and without the culler in
// front of it, and what the culler costs to get there.  The point of the
// table is the ratio between the two right-hand columns: CPU spent culling
// against path work removed.  Path work is what a canvas2d frame is priced
// in (see the guide's three cost centres); CPU is the cheap one.
//
// --far reproduces bench/scene.js as shipped, which keeps the BACK sheet of
// every closed mesh (its screen-space backface test has the wrong sign for
// the winding the generators emit).  Default flips it to the near sheet.
// ---------------------------------------------------------------------------
import { createRequire } from 'node:module';
import { PainterBatcher } from '../src/painter2d.js';
import { Occluder } from '../src/occluder.js';

const require = createRequire(import.meta.url);
const fs = require('fs'), vm = require('vm'), path = require('path');
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const FAR = process.argv.includes('--far');
const sb = { performance: { now: () => Number(process.hrtime.bigint()) / 1e6 }, console, Math, Date };
vm.createContext(sb);
for (const f of ['mesh.js', 'scene.js', 'render.js']) {
  let src = fs.readFileSync(path.join(here, f), 'utf8');
  if (!FAR && f === 'scene.js') {
    const before = src;
    src = src.replace('if (area <= 0) continue;', 'if (area >= 0) continue;');
    if (src === before) throw new Error('could not flip the backface test');
  }
  vm.runInContext(src, sb, { filename: f });
}
const { makeTorusKnot, makeSphere, makeGrid, makeInstances, Scene } = sb;

// ---- counting context -----------------------------------------------------
class CountCtx {
  constructor() { this.fills = 0; this.strokes = 0; this.subpaths = 0; this.verts = 0; }
  beginPath() { }
  moveTo() { this.subpaths++; this.verts++; }
  lineTo() { this.verts++; }
  closePath() { }
  fill() { this.fills++; }
  stroke() { this.strokes++; }
  set fillStyle(v) { }
  set strokeStyle(v) { }
  set lineWidth(v) { }
}

function timeIt(fn, iters) {
  fn(); fn(); fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 / iters;
}

const W = 1280, H = 720;
const ANG = [0.4, 0.9, 0.13, 3.1, 620];
const sp2 = makeSphere(96, 48, 4);
const cases = [
  ['torusKnot', makeTorusKnot(512, 64, 3, 7, 8), 24, 8, ANG],
  ['sphere', makeSphere(256, 128, 4), 24, 4, ANG],
  ['grid', makeGrid(180, 4), 24, 4, ANG],
  ['8spheres', makeInstances(sp2, [
    [-1.1, -1.1, -1.1], [1.1, -1.1, -1.1], [-1.1, 1.1, -1.1], [1.1, 1.1, -1.1],
    [-1.1, -1.1, 1.1], [1.1, -1.1, 1.1], [-1.1, 1.1, 1.1], [1.1, 1.1, 1.1]]),
    24, 4, [0.4, 0.9, 0.13, 6.0, 700]],
  ['5deep', makeInstances(sp2, [
    [0, 0, -2.2], [0, 0, -1.1], [0, 0, 0], [0, 0, 1.1], [0, 0, 2.2]]),
    24, 4, [0.4, 0.9, 0.13, 6.5, 900]]
];

console.log((FAR ? 'FAR sheet (bench/scene.js as shipped)' : 'NEAR sheet (backface sign corrected)') +
  '   ' + W + 'x' + H + '\n');
console.log('scene         faces        fills       verts      strokes   ' +
  'cullMs  batchMs  emitMs');
console.log('-'.repeat(94));

for (const [nm, mesh, sh, bd, ang] of cases) {
  const scene = new Scene(mesh, W, H, sh, bd);
  scene.build.apply(scene, ang);
  // painter2d reads `colour`; bench/scene.js calls it `col`
  const s = {
    order: scene.order, nVis: scene.nVis, colour: scene.col,
    sx: scene.sx, sy: scene.sy,
    bx0: scene.bx0, by0: scene.by0, bx1: scene.bx1, by1: scene.by1
  };
  const mk = () => new PainterBatcher({
    width: W, height: H, triangleCount: mesh.nt, vertexCount: mesh.nv,
    indices: mesh.idx, adjacency: mesh.adj, palette: scene.pal
  });
  const occ = new Occluder({
    width: W, height: H, triangleCount: mesh.nt,
    indices: mesh.idx, adjacency: mesh.adj, autoSkip: false
  });

  // --- baseline: batcher alone
  const B = mk(), c0 = new CountCtx();
  B.draw(c0, s);
  const batchMs0 = timeIt(() => B.batch(s), 20);
  const emitMs0 = timeIt(() => { B.batch(s); B.emit(new CountCtx(), s); }, 10) - batchMs0;

  // --- with the culler in front
  occ.cull(s);
  const s2 = Object.assign({}, s, { order: occ.list, nVis: occ.count });
  const B2 = mk(), c1 = new CountCtx();
  B2.draw(c1, s2);
  const cullMs = timeIt(() => occ.cull(s), 20);
  const batchMs1 = timeIt(() => B2.batch(s2), 20);
  const emitMs1 = timeIt(() => { B2.batch(s2); B2.emit(new CountCtx(), s2); }, 10) - batchMs1;

  const pc = (a, b) => (a === 0 ? '   -' : ((b - a >= 0 ? '+' : '') + (100 * (b - a) / a).toFixed(0) + '%'));
  console.log(nm.padEnd(11) + 'before' + String(s.nVis).padStart(9) +
    String(c0.fills).padStart(13) + String(c0.verts).padStart(12) +
    String(c0.strokes).padStart(13) + '       -' +
    batchMs0.toFixed(2).padStart(9) + emitMs0.toFixed(2).padStart(8));
  console.log(''.padEnd(11) + ' after' + String(s2.nVis).padStart(9) +
    String(c1.fills).padStart(13) + String(c1.verts).padStart(12) +
    String(c1.strokes).padStart(13) +
    cullMs.toFixed(2).padStart(9) + batchMs1.toFixed(2).padStart(9) + emitMs1.toFixed(2).padStart(8));
  console.log(''.padEnd(11) + '      ' + pc(s.nVis, s2.nVis).padStart(9) +
    pc(c0.fills, c1.fills).padStart(13) + pc(c0.verts, c1.verts).padStart(12) +
    pc(c0.strokes, c1.strokes).padStart(13) +
    ('net CPU ' + ((cullMs + batchMs1 + emitMs1) - (batchMs0 + emitMs0) >= 0 ? '+' : '') +
      ((cullMs + batchMs1 + emitMs1) - (batchMs0 + emitMs0)).toFixed(2) + ' ms').padStart(26));
  console.log('');
}
