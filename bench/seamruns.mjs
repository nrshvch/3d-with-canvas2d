// node bench/seamruns.mjs
// ---------------------------------------------------------------------------
// Where do a real batcher's seam runs END?
//
// 4.8's in-line band (the one-fill form) grows the polygon outward along its
// seam edges, and everything it adds is outside the polygon.  Outside is
// covered by the later neighbour along a run's LENGTH, but not at a run's
// free END -- so the in-line form's outline error is paid per free end, not
// per seam edge.  S14 (the sawtooth) has 2 free ends for 13 seam edges and
// pays almost nothing; S8 (a cube face) has 3 for 3 and pays 20x more.
//
// That made "how many free ends per seam edge?" the number the decision rule
// rests on, and it was never measured on batcher output -- so this does it.
// Counts only: no canvas, no timing, C4 (8.2).
//
// The band subset is NOT the same as 4.4's seam subset.  4.4 strokes an edge
// from whichever side draws last and does not care about order.  The band must
// be laid down by the polygon drawn FIRST, so the subset is
//     boundary edge, neighbour visible, neighbour in a different batch,
//     and that batch drawn LATER
// which is strictly smaller, and fragments differently along the loop.
// ---------------------------------------------------------------------------
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { createContext, runInContext } from 'vm';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PainterBatcher } from '../src/painter2d.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sb = { performance: { now: () => Number(process.hrtime.bigint()) / 1e6 }, console, Math, Date };
createContext(sb);
for (const f of ['mesh.js', 'scene.js'])
  runInContext(readFileSync(join(__dirname, f), 'utf8'), sb, { filename: f });
const { makeTorusKnot, makeSphere, makeGrid, Scene } = sb;

// a context that records nothing: we only want the batch assignment
const NullCtx = {
  beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
  set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, get lineWidth() { return 1; }
};

const W = 1280, H = 720;
const ANG = [0.4, 0.9, 0.13, 3.1, 620];

// Recompute the boundary edges of every batch exactly as emit() does, then
// chain the band subset into runs and count how many runs close on themselves
// (no free end at all) against how many stay open (two free ends each).
function analyse(B, s, mesh) {
  const idx = mesh.idx, adj = mesh.adj;
  const batchOf = B.batchOf, tag = B.tagBase, nB = B.batchCount;
  const bHead = B.bHead, bNext = B.bNext;
  const visible = (t) => t >= 0 && batchOf[t] >= tag && batchOf[t] < tag + nB;

  const R = {
    batches: 0, batchesWithBand: 0,
    boundary: 0, seam: 0, band: 0,
    runs: 0, closedRuns: 0, openRuns: 0, freeEnds: 0,
    runLenHist: new Map(), longestRun: 0
  };

  // per-batch scratch
  const eFrom = new Int32Array(4096), eTo = new Int32Array(4096);
  const eBand = new Uint8Array(4096), eUsed = new Uint8Array(4096);
  const eNextOf = new Int32Array(4096);
  const vHead = new Map();

  for (let b = 0; b < nB; b++) {
    const tb = tag + b;
    let ne = 0;
    let grow = null;
    for (let t = bHead[b]; t !== -1; t = bNext[t]) {
      for (let e = 0; e < 3; e++) {
        const n = adj[3 * t + e];
        if (n >= 0 && batchOf[n] === tb) continue;       // cancelled interior edge
        if (ne >= eFrom.length) { grow = true; break; }
        const a = idx[3 * t + e], c = idx[3 * t + ((e + 1) % 3)];
        eFrom[ne] = a; eTo[ne] = c;
        // the band subset: shared with a visible OTHER batch drawn LATER
        eBand[ne] = (visible(n) && batchOf[n] !== tb && batchOf[n] > tb) ? 1 : 0;
        if (visible(n) && batchOf[n] !== tb) R.seam++;
        ne++;
      }
      if (grow) break;
    }
    if (grow) { R.skipped = (R.skipped || 0) + 1; continue; }
    R.batches++;
    R.boundary += ne;

    let nBand = 0;
    vHead.clear();
    for (let e = 0; e < ne; e++) {
      eUsed[e] = 0;
      if (!eBand[e]) continue;
      nBand++;
      const v = eFrom[e];
      eNextOf[e] = vHead.has(v) ? vHead.get(v) : -1;
      vHead.set(v, e);
    }
    R.band += nBand;
    if (!nBand) continue;
    R.batchesWithBand++;

    // chain: follow eTo -> eFrom through the band subset only
    for (let e0 = 0; e0 < ne; e0++) {
      if (!eBand[e0] || eUsed[e0]) continue;
      const start = eFrom[e0];
      let e = e0, len = 0, closed = false;
      for (;;) {
        eUsed[e] = 1; len++;
        const w = eTo[e];
        if (w === start) { closed = true; break; }
        let nx = -1;
        for (let q = vHead.has(w) ? vHead.get(w) : -1; q !== -1; q = eNextOf[q]) {
          if (!eUsed[q]) { nx = q; break; }
        }
        if (nx === -1) break;
        e = nx;
      }
      R.runs++;
      if (closed) R.closedRuns++; else { R.openRuns++; R.freeEnds += 2; }
      if (len > R.longestRun) R.longestRun = len;
      const k = len >= 16 ? '16+' : len >= 8 ? '8-15' : len >= 4 ? '4-7' : String(len);
      R.runLenHist.set(k, (R.runLenHist.get(k) || 0) + 1);
    }
  }
  R.seam = R.seam / 1;     // counted once per side, both sides walked
  return R;
}

const pad = (s, n) => String(s).padEnd(n);
const rp = (s, n) => String(s).padStart(n);

console.log('Free ends of the BAND subset per batch boundary loop.');
console.log('The in-line one-fill band (4.8) pays its outline error per free END,');
console.log('so "ends per band edge" is the number its decision rule needs.\n');

const cases = [
  ['S1 torusKnot', makeTorusKnot(512, 64, 3, 7, 8), 24, 8],
  ['S2 sphere', makeSphere(256, 128, 4), 24, 4],
  ['S3 grid', makeGrid(180, 4), 24, 4]
];

const rows = [];
for (const [nm, mesh, sh, bd] of cases) {
  const scene = new Scene(mesh, W, H, sh, bd);
  scene.build.apply(scene, ANG);
  const B = new PainterBatcher({
    width: W, height: H, triangleCount: mesh.nt, vertexCount: mesh.nv,
    indices: mesh.idx, adjacency: mesh.adj, palette: scene.pal,
    tile: 2, strokeSeams: true, seamStrokeOnly: true, strokeWidth: 0.5,
    seamBand: 0           // the seam-STROKE pass is what this counts; the default is the band since v1.30
  });
  const s = { order: scene.order, nVis: scene.nVis, colour: scene.col,
              sx: scene.sx, sy: scene.sy,
              bx0: scene.bx0, by0: scene.by0, bx1: scene.bx1, by1: scene.by1 };
  B.draw(NullCtx, s);
  const R = analyse(B, s, mesh);
  rows.push([nm, scene.nVis, R]);
}

console.log(pad('fixture', 15) + rp('vis tris', 9) + rp('batches', 8) + rp('boundary', 9) +
            rp('seams', 7) + rp('band', 7) + rp('runs', 6) + rp('closed', 7) + rp('open', 6) +
            rp('freeEnds', 9) + rp('ends/band', 11) + rp('longest', 8));
for (const [nm, nVis, R] of rows) {
  console.log(pad(nm, 15) + rp(nVis, 9) + rp(R.batches, 8) + rp(R.boundary, 9) +
              rp(R.seam / 2, 7) + rp(R.band, 7) + rp(R.runs, 6) + rp(R.closedRuns, 7) + rp(R.openRuns, 6) +
              rp(R.freeEnds, 9) + rp((R.freeEnds / (R.band || 1)).toFixed(3), 11) +
              rp(R.longestRun, 8) + (R.skipped ? '  (skipped ' + R.skipped + ' oversized)' : ''));
}
console.log('\nrun-length distribution (band edges per run):');
for (const [nm, , R] of rows) {
  const h = [...R.runLenHist.entries()].sort((a, b) => (a[0] === '16+' ? 99 : a[0] === '8-15' ? 98 : a[0] === '4-7' ? 97 : +a[0]) -
                                                       (b[0] === '16+' ? 99 : b[0] === '8-15' ? 98 : b[0] === '4-7' ? 97 : +b[0]));
  console.log('  ' + pad(nm, 15) + h.map(([k, v]) => k + ':' + v).join('  '));
}
console.log('\nreference points from 4.8: S14 sawtooth 2 ends / 13 band edges = 0.154');
console.log('                           S8 cube face  3 ends /  3 band edges = 1.000');
