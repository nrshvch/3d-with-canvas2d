// node bench/bandx.mjs         -- the in-line band's junctions, and which fixes are exact
// BANDX_ONLY=4 node bench/bandx.mjs   -- section 4 (the shipped code's cost) alone, ~1 min
// ---------------------------------------------------------------------------
// 4.8's in-line band (option 7) steps out perpendicular by w on every
// boundary edge shared with a visible neighbour drawn LATER, and back.  At
// batcher scale (4.12) that leaves self-crossings wherever two band edges
// meet at a reflex corner, where an edge is shorter than w, and where a band
// meets the loop somewhere else.  This script
//
//   1. classifies every band/band junction of every boundary loop,
//   2. counts the crossings each variant leaves, by how far apart along the
//      loop the two crossing segments are (<= 3 segments = a junction's own
//      tangle; > 8 = the band running into another part of the loop), and
//   3. VERIFIES exactness instead of arguing it: for every batch a fix
//      touched, it samples the nonzero winding of the whole batch path (all
//      its loops together -- a hole loop means nothing on its own) on a
//      0.25 px lattice around every vertex, fixed against unfixed, and counts
//      the samples whose filled/unfilled state differs.
//   4. prices the fixes in the SHIPPED code: src/painter2d.js's whole draw()
//      into an inert context (A8, configs interleaved, min of 60) and through
//      Firefox's tessellator (A9), with seamBandFixes = none / exact / the
//      default, against no repair and the stroke.
//
// Counts only, no browser, deterministic (C4 batches, A4).  The pixel side --
// what a fix does to the rendered frame, and whether the rasteriser gets the
// fixed or the unfixed path closer to the 4x truth -- is tesspage.html part B.
// ---------------------------------------------------------------------------
import { setup, CASES } from './tess.mjs';
import { bandLoop, collinear, MIT, BAND_W, E_BAND } from './pathshape.js';
import { PainterBatcher, BAND_EXACT, BAND_DEFAULT, BAND_SKIP_SHORT, BAND_TIGHT } from '../src/painter2d.js';
import { WgrContext, bufferVerts } from './wgr.mjs';

const INERT = { beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {}, fillRect() {},
                fillStyle: '', strokeStyle: '', lineWidth: 1 };
function priceFixes(X) {
  const { mesh, scene, s } = X;
  const mk = o => new PainterBatcher(Object.assign({ width: 1280, height: 720, triangleCount: mesh.nt, vertexCount: mesh.nv,
    indices: mesh.idx, adjacency: mesh.adj, palette: scene.pal }, o));
  const rows = [['no repair', { seamBand: 0, strokeSeams: false }], ['0.5 px seam stroke (C1)', { seamBand: 0 }],
                ['band, no fixes', { seamBandFixes: 0 }], ['band, exact fixes', { seamBandFixes: BAND_EXACT }],
                ['band, default (+ free ends)', { seamBandFixes: BAND_DEFAULT }],
                ['band, default + tight mitre', { seamBandFixes: BAND_DEFAULT | BAND_TIGHT }],
                ['band, default + skip short', { seamBandFixes: BAND_DEFAULT | BAND_SKIP_SHORT }]];
  console.log('  4. the fixes in src/painter2d.js, per frame: whole draw() JS (A8, configs interleaved, min of 60) and tessellated output (A9)');
  console.log('  ' + pd('config', 30) + rp('fills', 7) + rp('strokes', 8) + rp('pathV', 8) + rp('A8 ms', 8) + rp('A9 verts', 10));
  // interleaved round-robin: timed one after another, the last config ran
  // ~1-3 ms slower than when timed first (JIT / GC order), which is the size
  // of the effect being measured
  const B = rows.map(([, o]) => mk(o)), best = B.map(() => Infinity);
  for (let r = 0; r < 60; r++) for (let i = 0; i < B.length; i++) {
    const j = (i + r) % B.length, t0 = performance.now();
    B[j].draw(INERT, s); best[j] = Math.min(best[j], performance.now() - t0);
  }
  rows.forEach(([name], i) => {
    const b = B[i], wc = new WgrContext(1 << 23, 1280, 720); b.draw(wc, s);
    console.log('  ' + pd(name, 30) + rp(b.fills, 7) + rp(b.strokes, 8) + rp(b.verts, 8) + rp(best[i].toFixed(2), 8) + rp(bufferVerts(wc), 10));
  });
}

const VARIANTS = ['band', 'band+spike', 'band+spike+reflex',
                  'band+spike+reflexAny', 'band+spike+reflexAny+noPinch',   // the mitre past 90 deg: a candidate
                  'band+exact+endclip', 'band+exact2',                      // the single-band clip, unguarded / guarded
                  'band+all+bevel', 'band+all+short1', 'band+exact+shortReflex',
                  'band+exact+end8', 'band+exact2+end8', 'band+exact2+end8+shortReflex'];
// claimed exact -- a change here is a bug; for the rest the check REPORTS whether they are
const EXACT = new Set(['band', 'band+spike', 'band+spike+reflex', 'band+exact2']);
const W = BAND_W;

function hit(p0x, p0y, p1x, p1y, q0x, q0y, q1x, q1y) {
  const rx = p1x - p0x, ry = p1y - p0y, sx = q1x - q0x, sy = q1y - q0y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return false;
  const qpx = q0x - p0x, qpy = q0y - p0y;
  const t = (qpx * sy - qpy * sx) / den, u = (qpx * ry - qpy * rx) / den;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}
function wind(loops, x, y) {
  let w = 0;
  for (const [xs, ys, n] of loops) for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1, x0 = xs[i], y0 = ys[i], x1 = xs[j], y1 = ys[j];
    if (y0 <= y) { if (y1 > y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) > 0) w++; }
    else if (y1 <= y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) < 0) w--;
  }
  return w;
}

const rp = (v, n) => String(v).padStart(n), pd = (v, n) => String(v).padEnd(n);
console.log(`In-line band (option 7, w = ${W} px) at batcher scale: junctions, crossings, exactness.`);
console.log('Exactness = sampled nonzero winding of each whole batch path, fixed vs unfixed, 0.25 px lattice.\n');

for (const [nm, mk, sh, bd] of CASES) {
  const X = setup(mk, sh, bd);
  if (process.env.BANDX_ONLY === '4') { console.log(nm); priceFixes(X); console.log(''); continue; }
  X.B.batch(X.s); X.L.extract(X.B, X.mesh.idx, X.mesh.adj);
  const L = X.L, sx = X.s.sx, sy = X.s.sy;
  const cap = 1 << 16;
  const px = new Float64Array(cap), py = new Float64Array(cap), fl = new Uint8Array(cap);
  const qx = new Float64Array(cap), qy = new Float64Array(cap);   // neighbour apex per edge (end8)
  const pk = new Uint8Array(cap);                                  // batch-wide pinch vertex (noPinch)
  const ox = new Float64Array(cap), oy = new Float64Array(cap), tx = new Float64Array(cap), ty = new Float64Array(cap);
  const load = (l) => { const s0 = L.start[l], k = L.len[l];
    for (let i = 0; i < k; i++) {
      const v = L.vid[s0 + i], a = L.apex[s0 + i];
      px[i] = sx[v]; py[i] = sy[v]; fl[i] = L.flag[s0 + i]; pk[i] = L.pinch[s0 + i];
      qx[i] = a >= 0 ? sx[a] : NaN; qy[i] = a >= 0 ? sy[a] : NaN;
    }
    return k; };

  // --- 1. junction census ---------------------------------------------------
  const J = { bandEdges: 0, short: 0, junctions: 0, collinear: 0, convex: 0, reflexFixable: 0, reflexSharp: 0, reflexShortEdge: 0,
              single: 0, singleReflex: 0, singleCross: 0, pinch: 0, freeEnds: 0 };
  for (let l = 0; l < L.nLoops; l++) {
    const k = load(l);
    for (let i = 0; i < k; i++) {
      if (fl[i] !== E_BAND) continue;
      const j = (i + 1) % k, h = (i + k - 1) % k;
      J.bandEdges++;
      const l2 = Math.hypot(px[j] - px[i], py[j] - py[i]);
      if (l2 < W) J.short++;
      if (fl[h] !== E_BAND) continue;
      if (pk[i]) J.pinch++;
      J.junctions++;
      const d1x = px[i] - px[h], d1y = py[i] - py[h], d2x = px[j] - px[i], d2y = py[j] - py[i];
      const l1 = Math.hypot(d1x, d1y) || 1;
      const cr = d1x * d2y - d1y * d2x;
      const n1x = d1y / l1 * W, n1y = -d1x / l1 * W, n2x = d2y / (l2 || 1) * W, n2y = -d2x / (l2 || 1) * W;
      if (Math.abs(n1x - n2x) + Math.abs(n1y - n2y) < 1e-6) J.collinear++;
      else if (cr > 0) J.convex++;
      else if (n1x * n2x + n1y * n2y < 0) J.reflexSharp++;
      else if ((n1x * d2x + n1y * d2y) / (l2 || 1) > l2 || -(n2x * d1x + n2y * d1y) / l1 > l1) J.reflexShortEdge++;
      else J.reflexFixable++;
    }
    // single-band junctions: a run starts or ends at vertex i against a plain edge
    for (let i = 0; i < k; i++) {
      const j = (i + 1) % k, h = (i + k - 1) % k;
      if ((fl[h] === E_BAND) === (fl[i] === E_BAND)) continue;
      J.single++;
      const d1x = px[i] - px[h], d1y = py[i] - py[h], d2x = px[j] - px[i], d2y = py[j] - py[i];
      if (d1x * d2y - d1y * d2x >= 0) continue;
      J.singleReflex++;
      // does the band's end cap cross the plain edge?  (what BAND_CLIP takes)
      if (fl[h] === E_BAND) {
        const l1 = Math.hypot(d1x, d1y) || 1, nx = d1y / l1 * W, ny = -d1x / l1 * W;
        if (hit(px[h] + nx, py[h] + ny, px[i] + nx, py[i] + ny, px[i], py[i], px[j], py[j])) J.singleCross++;
      } else {
        const l2 = Math.hypot(d2x, d2y) || 1, nx = d2y / l2 * W, ny = -d2x / l2 * W;
        if (hit(px[i] + nx, py[i] + ny, px[j] + nx, py[j] + ny, px[h], py[h], px[i], py[i])) J.singleCross++;
      }
    }
  }
  console.log(`${nm}: ${X.s.nVis} visible, ${X.B.batchCount} batches, ${L.nLoops} loops, ${J.bandEdges} band edges ` +
              `(${J.short} shorter than w)`);
  console.log(`  band/band junctions ${J.junctions}: collinear ${J.collinear}, convex ${J.convex}, ` +
              `reflex <= 90 deg ${J.reflexFixable}, reflex > 90 deg ${J.reflexSharp}, reflex blocked by a short edge ${J.reflexShortEdge}; ` +
              `at a pinch vertex ${J.pinch}`);
  console.log(`  run ends against a plain edge ${J.single}: at a reflex vertex ${J.singleReflex}, ` +
              `and the band's end cap crosses that edge ${J.singleCross}`);

  // --- 2 + 3. per variant ---------------------------------------------------
  console.log('  ' + pd('variant', 29) + rp('pathV', 8) + rp('cross<=3', 9) + rp('4..8', 6) + rp('far', 6) +
              rp('batches', 8) + rp('samples', 11) + rp('differ', 8) + '  exact?');
  const loopsOf = (b, mit) => {
    const out = [];
    for (let l = L.batchLoop0[b]; l < L.batchLoop0[b + 1]; l++) {
      const k = load(l);
      const a = new Float64Array(4 * k + 8), c = new Float64Array(4 * k + 8);
      out.push([a, c, mit ? bandLoop(px, py, fl, k, W, mit, a, c, qx, qy, pk) : 0]);
    }
    return out;
  };
  for (const v of VARIANTS) {
    const H = { near: 0, mid: 0, far: 0 };
    let pv = 0;
    for (let l = 0; l < L.nLoops; l++) {
      const k = load(l);
      const m = collinear(ox, oy, bandLoop(px, py, fl, k, W, MIT[v], ox, oy, qx, qy, pk), 0.0025, tx, ty);
      pv += m;
      if (m > 3000) continue;                       // O(m^2) below; none this size here
      for (let a = 0; a < m; a++) for (let b = a + 2; b < m; b++) {
        if (a === 0 && b === m - 1) continue;
        if (hit(tx[a], ty[a], tx[(a + 1) % m], ty[(a + 1) % m], tx[b], ty[b], tx[(b + 1) % m], ty[(b + 1) % m])) {
          const d = Math.min(b - a, m - (b - a));
          if (d <= 3) H.near++; else if (d <= 8) H.mid++; else H.far++;
        }
      }
    }
    let batches = 0, samples = 0, differ = 0;
    if (v !== 'band') for (let b = 0; b < X.B.batchCount; b++) {
      const A = loopsOf(b, MIT.band), M = loopsOf(b, MIT[v]);
      let changed = false;
      for (let i = 0; i < A.length; i++) if (A[i][2] !== M[i][2]) { changed = true; break; }
      if (!changed) continue;
      batches++;
      for (let i = 0; i < A.length; i++) {
        if (A[i][2] === M[i][2]) continue;
        const [xs, ys, n] = A[i];
        for (let q = 0; q < n; q++) for (let dy = -2; dy <= 2; dy += 0.25) for (let dx = -2; dx <= 2; dx += 0.25) {
          const x = xs[q] + dx + 0.013, y = ys[q] + dy + 0.007;          // off-lattice, never on an edge
          samples++;
          if ((wind(A, x, y) !== 0) !== (wind(M, x, y) !== 0)) differ++;
        }
      }
    }
    const verdict = v === 'band' ? '(reference)' : differ === 0 ? 'EXACT' : EXACT.has(v) ? 'NOT EXACT -- bug' : 'changes the region';
    console.log('  ' + pd(v, 29) + rp(pv, 8) + rp(H.near, 9) + rp(H.mid, 6) + rp(H.far, 6) +
                rp(v === 'band' ? '-' : batches, 8) + rp(v === 'band' ? '-' : samples, 11) + rp(v === 'band' ? '-' : differ, 8) + '  ' + verdict);
  }
  priceFixes(X);
  console.log('');
}
