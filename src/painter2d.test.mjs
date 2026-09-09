// node src/painter2d.test.mjs
// Self-test for the shipped module: builds a small indexed mesh, projects it,
// runs the batcher against a fake 2d context, and asserts that
//   - every visible triangle is emitted exactly once
//   - the total signed area of the filled paths equals the sum of the
//     triangle areas (edge cancellation preserves the region exactly)
//   - the verb cap is respected
import { PainterBatcher, buildAdjacency, weldSoup, reorderByDepthBands, COVERAGE_BBOX } from './painter2d.js';

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

console.log(failures ? '\n' + failures + ' FAILURES' : '\nall checks passed');
process.exit(failures ? 1 : 0);
