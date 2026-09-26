// node src/painter2d.test.mjs
// Self-test for the shipped module: builds a small indexed mesh, projects it,
// runs the batcher against a fake 2d context, and asserts that
//   - every visible triangle is emitted exactly once
//   - the total signed area of the filled paths equals the sum of the
//     triangle areas (edge cancellation preserves the region exactly)
//   - the verb cap is respected
//   - seamBand replaces the stroke, only ever ADDS area, and its junction
//     fixes are exact: sampled nonzero winding against a plain option-7 band
import { PainterBatcher, buildAdjacency, weldSoup, reorderByDepthBands, COVERAGE_BBOX, bandLoop, BAND_EXACT, BAND_DEFAULT } from './painter2d.js';

// ---- fake context: accumulates signed area, counts calls -------------------
class AreaCtx {
  constructor() { this.fills = 0; this.strokes = 0; this.subpaths = 0; this.verts = 0; this.area = 0; this.closes = 0; this._r(); }
  _r() { this.sx0 = 0; this.sy0 = 0; this.cx = 0; this.cy = 0; this.open = false; }
  _flush() { if (this.open) { this.acc += this.cx * this.sy0 - this.sx0 * this.cy; this.open = false; } }
  beginPath() { this._flush(); this._r(); this.acc = 0; }
  moveTo(x, y) { this._flush(); this.subpaths++; this.verts++; this.sx0 = x; this.sy0 = y; this.cx = x; this.cy = y; this.open = true; }
  lineTo(x, y) { this.verts++; this.acc += this.cx * y - x * this.cy; this.cx = x; this.cy = y; }
  closePath() { this.closes++; }
  fill() { this._flush(); this.fills++; this.area += this.acc; this.acc = 0; this._r(); }
  stroke() { this.strokes++; }
  set strokeStyle(v) { this._sstyle = v; }
  set lineWidth(v) { this._lw = v; }
  get lineWidth() { return this._lw; }
  get strokeStyle() { return this._sstyle; }
  set fillStyle(v) { this._style = v; }
  get fillStyle() { return this._style; }
}
AreaCtx.prototype.acc = 0;

// ---- a wavy grid: manifold, lots of shared edges ---------------------------
const N = 60;
const nv = (N + 1) * (N + 1), nt = N * N * 2;
const mx = new Float32Array(nv), my = new Float32Array(nv), mz = new Float32Array(nv);
for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
  const k = i * (N + 1) + j;
  mx[k] = (j / N - 0.5) * 2.4; mz[k] = (i / N - 0.5) * 2.4;
  my[k] = 0.3 * Math.sin(j * 0.31) * Math.cos(i * 0.27);
}
const indices = new Uint32Array(nt * 3);
const material = new Uint8Array(nt);
let t = 0;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const a = i * (N + 1) + j, b = (i + 1) * (N + 1) + j,
        c = (i + 1) * (N + 1) + j + 1, d = i * (N + 1) + j + 1;
  indices[3 * t] = a; indices[3 * t + 1] = b; indices[3 * t + 2] = c; material[t] = ((i + j) / (2 * N) * 4) | 0; t++;
  indices[3 * t] = a; indices[3 * t + 1] = c; indices[3 * t + 2] = d; material[t] = ((i + j) / (2 * N) * 4) | 0; t++;
}
const adjacency = buildAdjacency(indices, nv);

// ---- project / cull / shade / sort (the part the caller owns) --------------
const W = 1280, H = 720, SHADES = 24;
const sx = new Float32Array(nv), sy = new Float32Array(nv), sz = new Float32Array(nv);
const colour = new Uint8Array(nt);
const bx0 = new Float32Array(nt), by0 = new Float32Array(nt),
      bx1 = new Float32Array(nt), by1 = new Float32Array(nt);
const order = new Int32Array(nt);

function project(ax, ay) {
  const ca = Math.cos(ax), sa = Math.sin(ax), cb = Math.cos(ay), sb = Math.sin(ay);
  for (let i = 0; i < nv; i++) {
    const X = mx[i], Y = my[i], Z = mz[i];
    const x1 = X * cb + Z * sb, z1 = -X * sb + Z * cb;
    const y1 = Y * ca - z1 * sa, z2 = Y * sa + z1 * ca + 3.2;
    const iw = 620 / z2;
    sx[i] = W * 0.5 + x1 * iw; sy[i] = H * 0.5 - y1 * iw; sz[i] = z2;
  }
  const zc = new Float32Array(nt);
  let n = 0;
  for (let k = 0; k < nt; k++) {
    const a = indices[3 * k], b = indices[3 * k + 1], c = indices[3 * k + 2];
    const area = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sy[b] - sy[a]) * (sx[c] - sx[a]);
    if (area <= 0) continue;
    let x0 = Math.min(sx[a], sx[b], sx[c]), x1v = Math.max(sx[a], sx[b], sx[c]);
    let y0 = Math.min(sy[a], sy[b], sy[c]), y1v = Math.max(sy[a], sy[b], sy[c]);
    if (x1v < 0 || y1v < 0 || x0 > W || y0 > H) continue;
    bx0[k] = x0; by0[k] = y0; bx1[k] = x1v; by1[k] = y1v;
    // flat shading from the face normal -- spatially coherent, which is what
    // makes adjacent triangles share a palette entry and lets edge
    // cancellation do anything at all
    const e1x = mx[b] - mx[a], e1y = my[b] - my[a], e1z = mz[b] - mz[a];
    const e2x = mx[c] - mx[a], e2y = my[c] - my[a], e2z = mz[c] - mz[a];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz) || 1;
    let lam = (nx * 0.4 + ny * 0.75 + nz * 0.53) / nl * 0.5 + 0.5;
    let sh = (lam * SHADES) | 0;
    if (sh < 0) sh = 0; else if (sh >= SHADES) sh = SHADES - 1;
    colour[k] = material[k] * SHADES + sh;
    zc[n] = (sz[a] + sz[b] + sz[c]) / 3;
    order[n] = k; n++;
  }
  const idxs = Array.from({ length: n }, (_, i) => i).sort((p, q) => zc[q] - zc[p]);
  const tmp = Int32Array.from(idxs.map(i => order[i]));
  order.set(tmp, 0);
  return n;
}

function triAreaSum(n) {
  let a = 0;
  for (let i = 0; i < n; i++) {
    const k = order[i], p = indices[3 * k], q = indices[3 * k + 1], r = indices[3 * k + 2];
    a += sx[p] * sy[q] - sx[q] * sy[p] + sx[q] * sy[r] - sx[r] * sy[q] + sx[r] * sy[p] - sx[p] * sy[r];
  }
  return a;
}

const palette = Array.from({ length: 256 }, (_, i) =>
  '#' + ((i * 7919) & 0xffffff).toString(16).padStart(6, '0'));

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failures++;
}

const nVis = project(0.55, 0.9);
const scene = { order, nVis, colour, sx, sy, bx0, by0, bx1, by1 };
const baseArea = triAreaSum(nVis);
console.log('mesh: ' + nt + ' triangles, ' + nVis + ' visible\n');

for (const cfg of [
  { label: 'interior t4, cap 4000', tile: 4 },
  { label: 'interior t2, cap 4000', tile: 2 },
  { label: 'interior t4, no cap', tile: 4, maxVerbsPerFill: 0 },
  { label: 'interior t4, cap 120', tile: 4, maxVerbsPerFill: 120 },
  { label: 'bbox t8 (conservative)', tile: 8, coverage: COVERAGE_BBOX },
  { label: 'interior t4 + locality 256', tile: 4, localityTile: 256 },
  { label: 'no adjacency (soup mode)', tile: 4, noAdj: true },
  { label: 'soup mode + autoFallback', tile: 4, noAdj: true, autoFallback: true },
  { label: 'coherent mesh + autoFallback', tile: 2, autoFallback: true },
  { label: 'interior t2 + strokeSeams', tile: 2, stroke: true },
  { label: 'interior t2 + stroke + cap 120', tile: 2, stroke: true, maxVerbsPerFill: 120 },
  { label: 'default (stroke on, no adj)', tile: 2, stroke: true, noAdj: true },
  { label: 'interior t2 + SEAM-only stroke', tile: 2, stroke: true, seamOnly: true }
]) {
  const B = new PainterBatcher({
    width: W, height: H, triangleCount: nt, vertexCount: nv,
    indices, adjacency: cfg.noAdj ? null : adjacency, palette,
    tile: cfg.tile, coverage: cfg.coverage, maxVerbsPerFill: cfg.maxVerbsPerFill,
    localityTile: cfg.localityTile,
    strokeSeams: cfg.stroke === true,
    seamStrokeOnly: cfg.seamOnly === true,
    seamBand: 0,       // these are the UNBANDED emission's invariants (exact area,
                       // one stroke per fill); the band's own checks are below
    autoFallback: cfg.autoFallback === undefined ? false : cfg.autoFallback
  });
  const ctx = new AreaCtx();
  B.draw(ctx, scene);

  // every visible triangle emitted exactly once
  let emitted = 0;
  for (let b = 0; b < B.batchCount; b++) for (let k = B.bHead[b]; k >= 0; k = B.bNext[k]) emitted++;
  const areaErr = Math.abs(ctx.area - baseArea) / Math.abs(baseArea) * 100;
  const maxVerbs = B.maxPathVerbs;

  console.log(cfg.label.padEnd(30) +
    'fills=' + String(ctx.fills).padStart(6) +
    ' subpaths=' + String(ctx.subpaths).padStart(6) +
    ' verts=' + String(ctx.verts).padStart(7) +
    ' strokes=' + String(ctx.strokes).padStart(5) +
    (cfg.seamOnly ? ' seamEdges=' + B.seamEdges : '') +
    ' (' + (100 * ctx.verts / (nVis * 3)).toFixed(1) + '% verts of per-tri)' +
    (cfg.autoFallback ? (B.usedFallback ? '  [fell back]' : '  [batched]') : ''));
  check('all triangles emitted once', emitted === nVis, emitted + '/' + nVis);
  check('area conserved', areaErr < 0.05, areaErr.toFixed(4) + '%');
  check('no closePath() emitted', ctx.closes === 0);
  if (cfg.stroke === true && !cfg.seamOnly) check('one stroke per fill', ctx.strokes === ctx.fills, ctx.strokes + '/' + ctx.fills);
  else if (cfg.seamOnly) check('seam-only strokes <= fills, seams found', ctx.strokes > 0 && ctx.strokes <= ctx.fills && B.seamEdges > 0, 'strokes=' + ctx.strokes + ' seamEdges=' + B.seamEdges);
  else check('no strokes when disabled', ctx.strokes === 0);
  if (cfg.maxVerbsPerFill) check('verb cap respected', maxVerbs <= cfg.maxVerbsPerFill + 1024, 'maxPathVerbs=' + maxVerbs);
  else check('path verbs reported', maxVerbs > 0, 'maxPathVerbs=' + maxVerbs);
}

// The guard must fire on genuine soup -- independent triangles, random
// colours, real mutual overlap -- and must not fire on a coherent mesh.
// (Note: a coherent mesh with adjacency deliberately disabled should NOT
// trigger it, because a 10x fill reduction is still a win even with no edge
// cancellation. Measured: Chromium sphere 69.2ms -> 36.2ms in that case.)
{
  const SN = 4000;
  const sIdx = new Uint32Array(SN * 3), sCol = new Uint8Array(SN);
  const sSx = new Float32Array(SN * 3), sSy = new Float32Array(SN * 3);
  const sB = [0, 1, 2, 3].map(() => new Float32Array(SN));
  const sOrd = new Int32Array(SN);
  let seed = 12345 >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let t = 0; t < SN; t++) {
    const cx = rnd() * (W - 60) + 20, cy = rnd() * (H - 60) + 20;
    const p = [[cx, cy], [cx + 26, cy + 6], [cx + 8, cy + 26]];
    for (let e = 0; e < 3; e++) { sIdx[3 * t + e] = 3 * t + e; sSx[3 * t + e] = p[e][0]; sSy[3 * t + e] = p[e][1]; }
    sB[0][t] = cx; sB[1][t] = cy; sB[2][t] = cx + 26; sB[3][t] = cy + 26;
    sCol[t] = (rnd() * 256) | 0;
    sOrd[t] = t;
  }
  const soupScene = { order: sOrd, nVis: SN, colour: sCol, sx: sSx, sy: sSy,
                      bx0: sB[0], by0: sB[1], bx1: sB[2], by1: sB[3] };
  const soup = new PainterBatcher({ width: W, height: H, triangleCount: SN,
    vertexCount: SN * 3, indices: sIdx, adjacency: null, palette, tile: 2,
    autoFallback: true });
  const sc = new AreaCtx();
  soup.draw(sc, soupScene);
  check('guard falls back on real soup', soup.usedFallback === true,
        'fills=' + soup.fills + '/' + SN);

  const mesh = new PainterBatcher({ width: W, height: H, triangleCount: nt,
    vertexCount: nv, indices, adjacency, palette, tile: 2, autoFallback: true });
  mesh.draw(new AreaCtx(), scene);
  check('guard batches a coherent mesh', mesh.usedFallback === false,
        'fills=' + mesh.fills + '/' + nVis);

  const noAdj = new PainterBatcher({ width: W, height: H, triangleCount: nt,
    vertexCount: nv, indices, adjacency: null, palette, tile: 2,
    autoFallback: true });
  noAdj.draw(new AreaCtx(), scene);
  check('guard still batches when fills collapse but edges do not',
        noAdj.usedFallback === false, 'fills=' + noAdj.fills + '/' + nVis);
}

// reorderByDepthBands: still a permutation, still every triangle drawn once
{
  const before = Array.from(order.subarray(0, nVis)).sort((a, b) => a - b);
  let sc = null;
  for (const bands of [256, 64, 16]) {
    const copy = { order: Int32Array.from(order), nVis, colour, sx, sy, bx0, by0, bx1, by1 };
    sc = reorderByDepthBands(copy, bands, sc);
    const after = Array.from(copy.order.subarray(0, nVis)).sort((a, b) => a - b);
    let same = after.length === before.length;
    for (let i = 0; same && i < after.length; i++) if (after[i] !== before[i]) same = false;
    check('reorderByDepthBands(' + bands + ') is a permutation', same);
    const B = new PainterBatcher({ width: W, height: H, triangleCount: nt, vertexCount: nv,
      indices, adjacency, palette, tile: 2, strokeSeams: true, autoFallback: false });
    const cc = new AreaCtx();
    B.batch(copy); B.emit(cc, copy);
    let n2 = 0;
    for (let b = 0; b < B.batchCount; b++) for (let k = B.bHead[b]; k >= 0; k = B.bNext[k]) n2++;
    check('  bands=' + bands + ' emits every triangle', n2 === nVis,
          'fills=' + cc.fills + ' verts=' + cc.verts);
  }
}

// weldSoup round-trip
{
  const xyz = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const w = weldSoup(xyz, 1e-4);
  check('weldSoup dedupes shared vertices', w.vertexCount === 4, 'got ' + w.vertexCount);
  const a = buildAdjacency(w.indices, w.vertexCount);
  let paired = 0;
  for (let i = 0; i < a.length; i++) if (a[i] >= 0) paired++;
  check('welded quad has one shared edge', paired === 2, 'paired=' + paired);
}

// seamBand at batcher scale: no strokes at all, the same batches, and area
// that can only grow (the band lies outside the loop it extends).
{
  const mk = (band) => new PainterBatcher({ width: W, height: H, triangleCount: nt, vertexCount: nv,
    indices, adjacency, palette, tile: 2, seamBand: band, autoFallback: false });
  const plain = mk(0), banded = mk(1);
  const c0 = new AreaCtx(), c1 = new AreaCtx();
  plain.strokeSeams = false; plain.draw(c0, scene);
  banded.draw(c1, scene);
  check('seamBand: no stroke() at all', c1.strokes === 0, 'strokes=' + c1.strokes);
  check('seamBand: same fills as the unbanded batches', c1.fills === c0.fills, c1.fills + '/' + c0.fills);
  check('seamBand: area only grows', c1.area >= c0.area - 1e-3 * Math.abs(c0.area),
        (100 * (c1.area - c0.area) / Math.abs(c0.area)).toFixed(2) + '% added');
  check('seamBand: no closePath()', c1.closes === 0);

  // the default is the band (T69), and it needs adjacency to find the seams
  const def = new PainterBatcher({ width: W, height: H, triangleCount: nt, vertexCount: nv,
    indices, adjacency, palette, tile: 2, autoFallback: false });
  const cd = new AreaCtx(); def.draw(cd, scene);
  check('seamBand defaults to 1: default options emit the banded frame',
        def.seamBand === 1 && cd.strokes === 0 && cd.fills === c1.fills && Math.abs(cd.area - c1.area) < 1e-6 * Math.abs(c1.area),
        'seamBand=' + def.seamBand + ' strokes=' + cd.strokes);
  const na = new PainterBatcher({ width: W, height: H, triangleCount: nt, vertexCount: nv,
    indices, adjacency: null, palette, tile: 2, autoFallback: false });
  const cn = new AreaCtx(); na.draw(cn, scene);
  check('seamBand default without adjacency falls back to the stroke', cn.strokes > 0, 'strokes=' + cn.strokes);
}

// The junction fixes are exact: against option 7 with no fixes (built here,
// independently), the nonzero-filled region is the same at every sample.
// Random star-shaped loops give convex and reflex corners of every angle,
// including sharp spikes (where a mitre would cut a hole, so none is made)
// and edges shorter than the band (where the mitre would overreach).
{
  let seed = 777 >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const wind = (xs, ys, n, x, y) => {
    let w = 0;
    for (let i = 0; i < n; i++) {
      const j = i + 1 === n ? 0 : i + 1, x0 = xs[i], y0 = ys[i], x1 = xs[j], y1 = ys[j];
      if (y0 <= y) { if (y1 > y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) > 0) w++; }
      else if (y1 <= y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) < 0) w--;
    }
    return w;
  };
  let loops = 0, samples = 0, differ = 0, onEdge = 0, mitred = 0;
  const ox = new Float32Array(256), oy = new Float32Array(256);
  const NO_APEX = new Int32Array(64).fill(-1);
  for (let trial = 0; trial < 300; trial++) {
    const k = 5 + ((rnd() * 20) | 0), bw = 1;
    const x = new Float32Array(k), y = new Float32Array(k), f = new Uint8Array(k);
    for (let i = 0; i < k; i++) {
      // positive screen-space orientation (the batcher's): angle DEcreasing
      // in y-down coordinates is counter-clockwise on screen... so walk the
      // angle backwards and let the radius jump to make reflex corners
      const a = -i / k * Math.PI * 2, r = 6 + rnd() * (rnd() < 0.3 ? 2 : 30);
      x[i] = 100 + r * Math.cos(a); y[i] = 100 + r * Math.sin(a);
      f[i] = rnd() < 0.8 ? 2 : (rnd() < 0.5 ? 1 : 0);
    }
    // orientation check: the batcher's loops have positive signed area
    let A = 0; for (let i = 0; i < k; i++) { const j = (i + 1) % k; A += x[i] * y[j] - x[j] * y[i]; }
    if (A <= 0) { x.reverse(); y.reverse(); }
    // reference: option 7, no fixes
    const rx = [], ry = [];
    for (let i = 0; i < k; i++) {
      const j = (i + 1) % k;
      rx.push(x[i]); ry.push(y[i]);
      if (f[i] === 2) {
        const dx = x[j] - x[i], dy = y[j] - y[i], l = Math.hypot(dx, dy) || 1;
        rx.push(x[i] + dy / l * bw, x[j] + dy / l * bw); ry.push(y[i] - dx / l * bw, y[j] - dx / l * bw);
      }
    }
    const m = bandLoop(x, y, f, NO_APEX, x, y, k, bw, ox, oy);   // no apexes: junction fixes only
    if (m < rx.length) mitred++;
    loops++;
    for (let i = 0; i < rx.length; i++) for (let dy = -2; dy <= 2; dy += 0.25) for (let dx = -2; dx <= 2; dx += 0.25) {
      const px = rx[i] + dx + 0.013, py = ry[i] + dy + 0.007;
      samples++;
      if ((wind(rx, ry, rx.length, px, py) !== 0) !== (wind(ox, oy, m, px, py) !== 0)) {
        // distance to the nearest edge of either loop
        let d = 1e9;
        for (const [qx, qy, n] of [[rx, ry, rx.length], [ox, oy, m]]) for (let q = 0; q < n; q++) {
          const r = (q + 1) % n, ex = qx[r] - qx[q], ey = qy[r] - qy[q], L2 = ex * ex + ey * ey || 1;
          const t = Math.max(0, Math.min(1, ((px - qx[q]) * ex + (py - qy[q]) * ey) / L2));
          d = Math.min(d, Math.hypot(px - qx[q] - t * ex, py - qy[q] - t * ey));
        }
        // the batcher stores points as Float32: a sample within 1e-4 px of an
        // edge can flip on rounding alone.  Those are counted, not failed.
        if (d > 1e-4) differ++; else onEdge++;
      }
    }
  }
  check('bandLoop junction fixes are exact', differ === 0,
        `${differ} of ${samples} samples differ (+${onEdge} within 1e-4 px of an edge: float32), ${loops} loops, ${mitred} with a fix applied`);
  check('bandLoop fixes actually fire', mitred > 50, mitred + ' loops');
}

// The free-end rule: a one-edge run gets both corners on the neighbour's own
// edges, each exactly w out from the band edge's line.
{
  // square a(0,0) b(40,0) c(40,40) d(0,40): positive winding, region on the
  // +y side of a->b.  Band on a->b only; the neighbour across it has its
  // third vertex at q = (20, -30), on the outward side.
  const x = new Float32Array([0, 40, 40, 0]), y = new Float32Array([0, 0, 40, 40]);
  let A = 0; for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; A += x[i] * y[j] - x[j] * y[i]; }
  const f = new Uint8Array([2, 0, 0, 0]), q = new Int32Array([4, -1, -1, -1]);
  const sxq = new Float32Array([0, 0, 0, 0, 20]), syq = new Float32Array([0, 0, 0, 0, -30]);
  const ox = new Float32Array(16), oy = new Float32Array(16);
  const m = bandLoop(x, y, f, q, sxq, syq, 4, 1, ox, oy);
  const pts = Array.from({ length: m }, (_, i) => [ox[i], oy[i]]);
  const onSeg = (p, a, b) => Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) < 1e-3;
  const corners = pts.filter(p => p[1] < -1e-3);
  check('free end: loop has positive winding', A > 0, 'area2=' + A);
  check('free end: two corners, both w out', corners.length === 2 && corners.every(p => Math.abs(p[1] + 1) < 1e-4),
        JSON.stringify(corners));
  check('free end: corners lie on the neighbour\'s edges',
        corners.length === 2 && corners.some(p => onSeg(p, [0, 0], [20, -30])) && corners.some(p => onSeg(p, [40, 0], [20, -30])));
}

// --- seamBandFixes: 0 is option 7 verbatim (k + 2 per band edge); the exact
// pair only ever removes vertices; the default is what bandLoop does unasked
{
  let seed = 11, ok0 = true, okE = true, okD = true, n = 0;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let it = 0; it < 500; it++) {
    const k = 3 + Math.floor(rnd() * 12), x = new Float64Array(k), y = new Float64Array(k), f = new Uint8Array(k), q = new Int32Array(k).fill(-1);
    for (let i = 0; i < k; i++) { const a = -2 * Math.PI * i / k, R = 30 + rnd() * 60; x[i] = 200 + R * Math.cos(a); y[i] = 200 + R * Math.sin(a); f[i] = rnd() < 0.7 ? 2 : 0; }
    let A = 0; for (let i = 0; i < k; i++) { const j = (i + 1) % k; A += x[i] * y[j] - y[i] * x[j]; }
    if (A < 0) { x.reverse(); y.reverse(); }
    let bands = 0; for (let i = 0; i < k; i++) if (f[i] === 2) bands++;
    const ox = new Float64Array(3 * k + 4), oy = new Float64Array(3 * k + 4), px = new Float64Array(3 * k + 4), py = new Float64Array(3 * k + 4);
    const m0 = bandLoop(x, y, f, q, x, y, k, 1, ox, oy, 0), mE = bandLoop(x, y, f, q, x, y, k, 1, px, py, BAND_EXACT);
    const mD = bandLoop(x, y, f, q, x, y, k, 1, px, py, BAND_DEFAULT), mU = bandLoop(x, y, f, q, x, y, k, 1, ox, oy);
    if (m0 !== k + 2 * bands) ok0 = false;
    if (mE > m0) okE = false;
    if (mD !== mU) okD = false;
    n++;
  }
  check('seamBandFixes 0 emits option 7 verbatim', ok0, n + ' loops');
  check('exact fixes never add vertices', okE);
  check('bandLoop default is BAND_DEFAULT', okD);
}

// --- the guide's readable bandLoop (README 1.4, "The path recipe") is the shipped one
{
  const { readFileSync } = await import('node:fs');
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const at = md.indexOf('<!-- bandLoop-snippet -->');
  const src = at < 0 ? '' : md.slice(md.indexOf('```js\n', at) + 6, md.indexOf('\n```', at + 30));
  const readable = src && new Function(src + '\nreturn bandLoop;')();
  let seed = 7, loops = 0, bad = 0, maxd = 0;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let it = 0; readable && it < 3000; it++) {
    const k = 3 + Math.floor(rnd() * 14), P = [], seam = [], apex = [];
    for (let i = 0; i < k; i++) {
      const a = -2 * Math.PI * i / k, R = Math.max(0.3, (rnd() < 0.4 ? 20 : 60) + rnd() * 50 + (rnd() < 0.1 ? -60 : 0));
      P.push([200 + Math.cos(a) * R, 200 + Math.sin(a) * R]);
    }
    let A = 0;
    for (let i = 0; i < k; i++) { const p = P[i], r = P[(i + 1) % k]; A += p[0] * r[1] - p[1] * r[0]; }
    if (A < 0) P.reverse();
    const x = new Float64Array(k), y = new Float64Array(k), f = new Uint8Array(k), q = new Int32Array(k);
    const sxq = new Float64Array(2 * k), syq = new Float64Array(2 * k);
    for (let i = 0; i < k; i++) {
      x[i] = sxq[i] = P[i][0]; y[i] = syq[i] = P[i][1];
      seam.push(rnd() < 0.7); f[i] = seam[i] ? 2 : 0;
      if (rnd() < 0.8) {
        const j = (i + 1) % k, dx = P[j][0] - P[i][0], dy = P[j][1] - P[i][1], l = Math.hypot(dx, dy), s = (rnd() - 0.2) * 30;
        sxq[k + i] = (P[i][0] + P[j][0]) / 2 + dy / l * s; syq[k + i] = (P[i][1] + P[j][1]) / 2 - dx / l * s;
        q[i] = k + i; apex.push([sxq[k + i], syq[k + i]]);
      } else { q[i] = -1; apex.push(null); }
    }
    const ox = new Float64Array(3 * k + 4), oy = new Float64Array(3 * k + 4);
    const m = bandLoop(x, y, f, q, sxq, syq, k, 1, ox, oy), o = readable(P, seam, apex, 1);
    loops++;
    if (o.length !== m) { bad++; continue; }
    for (let i = 0; i < m; i++) maxd = Math.max(maxd, Math.abs(o[i][0] - ox[i]), Math.abs(o[i][1] - oy[i]));
  }
  check('README bandLoop snippet found', !!readable);
  check('README bandLoop snippet emits the shipped loops', readable && bad === 0 && maxd < 1e-9,
        `${loops} random loops, ${bad} length mismatches, max |d| ${maxd.toExponential(1)} px`);
}

console.log(failures ? '\n' + failures + ' FAILURES' : '\nall checks passed');
process.exit(failures ? 1 : 0);
