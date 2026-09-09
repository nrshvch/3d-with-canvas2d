// node bench/occlude.js
// ---------------------------------------------------------------------------
// Z-LESS OCCLUSION CULLING FOR A PAINTER'S-ALGORITHM CANVAS2D ENGINE.
//
// The observation the whole thing rests on: a painter's-algorithm renderer
// already owns a total depth order.  So it does not need depth *values* to
// occlusion-cull -- walk the same sorted list the other way (near -> far) and
// the only question left is the 2D one, "is this face's screen footprint
// already fully claimed?"  That is a coverage-buffer question, not a
// depth-buffer question.  Cf. Doom's `solidsegs` / Build's C-buffer (1D), and
// Intel's Masked Software Occlusion Culling (2016) with the depth half of
// every tile deleted, because the sort already did that job.
//
// The mark and the test are the SAME operation.  Marking a face that is
// already fully covered writes no new bit; so "did I set a bit?" answers
// "was I visible?" for free.  One pass, no query phase, no hierarchy needed.
//
//   for t in order, near -> far:
//       newbits = 0
//       for each sample row of t: OR the row's span into the mask,
//                                 remember whether any bit was 0 before
//       if (t had samples && newbits === 0)  ->  t is invisible, drop it
//
// Coverage lives in a bitmask: one Int32 per 32 samples of a scanline, so a
// span costs O(span/32) word ops, not O(span) pixel ops.  Spans come from
// exact edge/scanline intersections -- no per-pixel edge functions.
//
// What is measured here
//   cull%      faces dropped / faces submitted
//   miss       faces the culler kept that a perfect culler would have dropped
//   FALSE      faces dropped that a true per-pixel Z-BUFFER says are visible.
//              Two sources: (a) sub-sample slivers, whose contribution is real
//              but analytic-AA-thin, (b) genuine painter-sort inversions,
//              which are already wrong in the painter -- culling just makes
//              them wrong more visibly.
//   RMSE       against a 3x3-supersampled render of the uncrossed-out scene.
// ---------------------------------------------------------------------------
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const sb = { performance: { now: () => Number(process.hrtime.bigint()) / 1e6 }, console, Math, Date };
vm.createContext(sb);
// --- orientation flag -----------------------------------------------------
// bench/scene.js keeps `area > 0` in screen space, and with the winding the
// mesh generators emit that is the FAR sheet of every closed mesh: measured,
// a 64x32 sphere keeps 2753 faces of mean z 3.376 and drops 1343 of mean z
// 2.535, and under perspective you see LESS than a hemisphere, so 1343 is the
// front-facing count.  Every number in this repo was therefore taken on the
// back sheet.  It barely matters for fill/vertex counts, but it changes the
// self-occlusion structure completely, so measure both.
const FRONT = process.argv.includes('--front');
for (const f of ['mesh.js', 'scene.js', 'render.js']) {
  let src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  if (FRONT && f === 'scene.js') {
    const before = src;
    src = src.replace('if (area <= 0) continue;', 'if (area >= 0) continue;');
    if (src === before) throw new Error('could not flip the backface test');
  }
  vm.runInContext(src, sb, { filename: f });
}
const { makeTorusKnot, makeSphere, makeGrid, makeSoup, makeInstances,
        Scene, Renderer, Stats } = sb;

const W = 1280, H = 720;
const ANG = [0.4, 0.9, 0.13, 3.1, 620];

// ===========================================================================
// the coverage mask
// ===========================================================================
function Coverage(W, H, ss) {
  this.ss = ss;
  this.sw = Math.round(W * ss); this.sh = Math.round(H * ss);
  this.wpr = (this.sw + 31) >> 5;
  this.cov = new Int32Array(this.wpr * this.sh);
  // --- hierarchy: one counter per BLOCK of 32 samples x 8 sample rows, of how
  // many of its 8 words are saturated.  8 means the whole block is claimed.
  // This is the only reason the culler is cheap: a face whose bbox lands
  // entirely in saturated blocks is rejected in 1-4 array reads, with no
  // scanline setup and no marking at all -- and marking it would have been a
  // no-op anyway, which is exactly why skipping it is safe.
  // (Intel's MSOC keeps two depth planes per tile as well; the painter's sort
  // has already done that job, so the counter is all that is left.)
  this.bh = (this.sh + 7) >> 3;
  this.blk = new Uint8Array(this.wpr * this.bh);
  this.blkRows = new Uint8Array(this.bh);      // sample rows per block row
  for (let b = 0; b < this.bh; b++) this.blkRows[b] = Math.min(8, this.sh - b * 8);
}
Coverage.prototype.clear = function () { this.cov.fill(0); this.blk.fill(0); };

// Conservative reject: is every block the pixel-space bbox touches saturated?
Coverage.prototype.bboxFull = function (x0, y0, x1, y1) {
  const ss = this.ss;
  let i0 = (x0 * ss) | 0, i1 = Math.ceil(x1 * ss) | 0;
  let j0 = (y0 * ss) | 0, j1 = Math.ceil(y1 * ss) | 0;
  if (i0 < 0) i0 = 0;
  if (j0 < 0) j0 = 0;
  if (i1 > this.sw - 1) i1 = this.sw - 1;
  if (j1 > this.sh - 1) j1 = this.sh - 1;
  if (i1 < i0 || j1 < j0) return 0;
  const w0 = i0 >> 5, w1 = i1 >> 5, b0 = j0 >> 3, b1 = j1 >> 3;
  const blk = this.blk, wpr = this.wpr, rows = this.blkRows;
  for (let b = b0; b <= b1; b++) {
    const need = rows[b], base = b * wpr;
    for (let w = w0; w <= w1; w++) if (blk[base + w] < need) return 0;
  }
  return 1;
};

// Mark the triangle and report whether it was already fully covered.
// Returns 1 = contributed no new sample (cullable), 0 = keep.
//
// The sample scale is folded into the vertices once, so the row loop has no
// multiply in it at all: both x limits walk by DDA, and the only branch is the
// one crossing the middle vertex.
Coverage.prototype.markTest = function (ax, ay, bx, by, cx, cy) {
  const ss = this.ss;
  let x0 = ax * ss, y0 = ay * ss, x1 = bx * ss, y1 = by * ss,
      x2 = cx * ss, y2 = cy * ss, tm;
  if (y0 > y1) { tm = x0; x0 = x1; x1 = tm; tm = y0; y0 = y1; y1 = tm; }
  if (y1 > y2) { tm = x1; x1 = x2; x2 = tm; tm = y1; y1 = y2; y2 = tm; }
  if (y0 > y1) { tm = x0; x0 = x1; x1 = tm; tm = y0; y0 = y1; y1 = tm; }
  const sw = this.sw, wpr = this.wpr, cov = this.cov, blk = this.blk;
  let j0 = Math.ceil(y0 - 0.5), j1 = Math.floor(y2 - 0.5);
  if (j0 < 0) j0 = 0;
  if (j1 > this.sh - 1) j1 = this.sh - 1;
  if (j1 < j0) return 0;                        // thinner than a sample row
  const g02 = (y2 > y0) ? (x2 - x0) / (y2 - y0) : 0;
  const g01 = (y1 > y0) ? (x1 - x0) / (y1 - y0) : 0;
  const g12 = (y2 > y1) ? (x2 - x1) / (y2 - y1) : 0;
  let yc = j0 + 0.5;
  let xa = x0 + (yc - y0) * g02, xb, gb;
  let lower = yc < y1;
  if (lower) { xb = x0 + (yc - y0) * g01; gb = g01; }
  else       { xb = x1 + (yc - y1) * g12; gb = g12; }
  let any = 0, neu = 0;
  for (let j = j0; j <= j1; j++) {
    const xl = xa < xb ? xa : xb, xr = xa < xb ? xb : xa;
    let is = Math.ceil(xl - 0.5), ie = Math.floor(xr - 0.5);
    if (is < 0) is = 0;
    if (ie > sw - 1) ie = sw - 1;
    if (ie >= is) {
      any = 1;
      const base = j * wpr, bbase = (j >> 3) * wpr;
      const w0 = is >> 5, w1 = ie >> 5;
      if (w0 === w1) {
        const m = (-1 << (is & 31)) & (-1 >>> (31 - (ie & 31)));
        const p = base + w0, old = cov[p];
        if ((m & ~old) !== 0) {
          neu = 1; const nw = old | m; cov[p] = nw;
          if (nw === -1) blk[bbase + w0]++;
        }
      } else {
        let m = -1 << (is & 31);
        let p = base + w0, old = cov[p];
        if ((m & ~old) !== 0) {
          neu = 1; const nw = old | m; cov[p] = nw;
          if (nw === -1) blk[bbase + w0]++;
        }
        for (let w = w0 + 1; w < w1; w++) {
          p = base + w;
          if (cov[p] !== -1) { neu = 1; cov[p] = -1; blk[bbase + w]++; }
        }
        m = -1 >>> (31 - (ie & 31));
        p = base + w1; old = cov[p];
        if ((m & ~old) !== 0) {
          neu = 1; const nw = old | m; cov[p] = nw;
          if (nw === -1) blk[bbase + w1]++;
        }
      }
    }
    xa += g02;
    if (lower && (j + 1.5) >= y1) { lower = false; gb = g12; xb = x1 + (j + 1.5 - y1) * g12; }
    else xb += gb;
  }
  return (any && !neu) ? 1 : 0;
};

// ---------------------------------------------------------------------------
// Conservative variant.  Two independent knobs, in samples:
//
//   dil  the TEST footprint is grown by this much.  A face is only culled if
//        its neighbourhood is covered too, so a face whose visible part is a
//        sub-pixel sliver survives.  Costs cull rate, buys fidelity.
//   ero  the MARK footprint is shrunk by this much.  This is the textbook
//        conservative-occluder rule -- and on a watertight tessellated mesh it
//        should be a TRAP: every face insets away from its own shared edges, so
//        the union never saturates and occluder fusion dies.  Measured, not
//        assumed.
//
// Spans go through a scratch array so the dilated test can consult the
// neighbouring rows, which an exact dilation needs at a diagonal edge.
// ---------------------------------------------------------------------------
Coverage.prototype.initSpans = function () {
  this.spL = new Int32Array(this.sh + 8);
  this.spR = new Int32Array(this.sh + 8);
};
Coverage.prototype.markTestD = function (ax, ay, bx, by, cx, cy, dil, ero) {
  const ss = this.ss;
  let x0 = ax * ss, y0 = ay * ss, x1 = bx * ss, y1 = by * ss,
      x2 = cx * ss, y2 = cy * ss, tm;
  if (y0 > y1) { tm = x0; x0 = x1; x1 = tm; tm = y0; y0 = y1; y1 = tm; }
  if (y1 > y2) { tm = x1; x1 = x2; x2 = tm; tm = y1; y1 = y2; y2 = tm; }
  if (y0 > y1) { tm = x0; x0 = x1; x1 = tm; tm = y0; y0 = y1; y1 = tm; }
  const sw = this.sw, sh = this.sh, wpr = this.wpr, cov = this.cov, blk = this.blk;
  const spL = this.spL, spR = this.spR;
  let j0 = Math.ceil(y0 - 0.5), j1 = Math.floor(y2 - 0.5);
  if (j0 < 0) j0 = 0;
  if (j1 > sh - 1) j1 = sh - 1;
  if (j1 < j0) return 0;
  const g02 = (y2 > y0) ? (x2 - x0) / (y2 - y0) : 0;
  const g01 = (y1 > y0) ? (x1 - x0) / (y1 - y0) : 0;
  const g12 = (y2 > y1) ? (x2 - x1) / (y2 - y1) : 0;
  let yc = j0 + 0.5;
  let xa = x0 + (yc - y0) * g02, xb, gb;
  let lower = yc < y1;
  if (lower) { xb = x0 + (yc - y0) * g01; gb = g01; }
  else       { xb = x1 + (yc - y1) * g12; gb = g12; }
  let any = 0;
  for (let j = j0; j <= j1; j++) {
    const xl = xa < xb ? xa : xb, xr = xa < xb ? xb : xa;
    const is = Math.ceil(xl - 0.5), ie = Math.floor(xr - 0.5);
    spL[j] = is; spR[j] = ie;
    if (ie >= is) any = 1;
    xa += g02;
    if (lower && (j + 1.5) >= y1) { lower = false; gb = g12; xb = x1 + (j + 1.5 - y1) * g12; }
    else xb += gb;
  }
  if (!any) return 0;

  // ---- test: is the dilated footprint already fully covered?
  let covered = 1;
  const tj0 = Math.max(0, j0 - dil), tj1 = Math.min(sh - 1, j1 + dil);
  for (let j = tj0; j <= tj1 && covered; j++) {
    let l = 2147483647, r = -2147483648;
    for (let jj = j - dil; jj <= j + dil; jj++) {
      if (jj < j0 || jj > j1 || spR[jj] < spL[jj]) continue;
      if (spL[jj] < l) l = spL[jj];
      if (spR[jj] > r) r = spR[jj];
    }
    if (r < l) continue;
    let ls = l - dil, rs = r + dil;
    if (ls < 0) ls = 0;
    if (rs > sw - 1) rs = sw - 1;
    if (rs < ls) continue;
    const base = j * wpr, w0 = ls >> 5, w1 = rs >> 5;
    if (w0 === w1) {
      const m = (-1 << (ls & 31)) & (-1 >>> (31 - (rs & 31)));
      if ((cov[base + w0] & m) !== m) covered = 0;
    } else {
      let m = -1 << (ls & 31);
      if ((cov[base + w0] & m) !== m) covered = 0;
      for (let w = w0 + 1; w < w1 && covered; w++) if (cov[base + w] !== -1) covered = 0;
      m = -1 >>> (31 - (rs & 31));
      if ((cov[base + w1] & m) !== m) covered = 0;
    }
  }
  if (covered) return 1;                 // cullable, and marking it is a no-op

  // ---- mark: the eroded footprint
  for (let j = j0 + ero; j <= j1 - ero; j++) {
    let ls = spL[j] + ero, rs = spR[j] - ero;
    if (ls < 0) ls = 0;
    if (rs > sw - 1) rs = sw - 1;
    if (rs < ls) continue;
    const base = j * wpr, bbase = (j >> 3) * wpr, w0 = ls >> 5, w1 = rs >> 5;
    if (w0 === w1) {
      const m = (-1 << (ls & 31)) & (-1 >>> (31 - (rs & 31)));
      const p = base + w0, old = cov[p], nw = old | m;
      if (nw !== old) { cov[p] = nw; if (nw === -1) blk[bbase + w0]++; }
    } else {
      let m = -1 << (ls & 31);
      let p = base + w0, old = cov[p], nw = old | m;
      if (nw !== old) { cov[p] = nw; if (nw === -1) blk[bbase + w0]++; }
      for (let w = w0 + 1; w < w1; w++) {
        p = base + w;
        if (cov[p] !== -1) { cov[p] = -1; blk[bbase + w]++; }
      }
      m = -1 >>> (31 - (rs & 31));
      p = base + w1; old = cov[p]; nw = old | m;
      if (nw !== old) { cov[p] = nw; if (nw === -1) blk[bbase + w1]++; }
    }
  }
  return 0;
};

function makeCullD(dil, ero) {
  return function (scene, cov, keep) {
    cov.clear();
    if (!cov.spL) cov.initSpans();
    const idx = scene.m.idx, sx = scene.sx, sy = scene.sy;
    const bx0 = scene.bx0, by0 = scene.by0, bx1 = scene.bx1, by1 = scene.by1;
    const order = scene.order, n = scene.nVis;
    const d = dil / cov.ss;                       // dilation in pixel units
    let nk = 0;
    for (let i = n - 1; i >= 0; i--) {
      const t = order[i];
      // the hierarchy test is conservative already (bbox superset of the
      // triangle), but grow it by the dilation so it agrees with the exact test
      if (cov.bboxFull(bx0[t] - d, by0[t] - d, bx1[t] + d, by1[t] + d)) continue;
      const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
      if (!cov.markTestD(sx[a], sy[a], sx[b], sy[b], sx[c], sy[c], dil, ero))
        keep[n - 1 - nk++] = t;
    }
    return nk;
  };
}

// ---------------------------------------------------------------------------
// the culler.  Walks scene.order near -> far and writes the survivors back
// into `keep` from the far end, so the result comes out in painter order
// (far -> near) with no reverse pass.
// ---------------------------------------------------------------------------
function cullMask(scene, cov, keep) {
  cov.clear();
  const idx = scene.m.idx, sx = scene.sx, sy = scene.sy;
  const order = scene.order, n = scene.nVis;
  let nk = 0;
  for (let i = n - 1; i >= 0; i--) {
    const t = order[i], a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    if (!cov.markTest(sx[a], sy[a], sx[b], sy[b], sx[c], sy[c]))
      keep[n - 1 - nk++] = t;
  }
  return nk;
}

// Same result, hierarchy first: reject on the block counters before doing any
// scanline work.  The bbox is a superset of the triangle, so a full-bbox
// verdict is conservative -- this never culls anything cullMask would keep.
function cullHier(scene, cov, keep) {
  cov.clear();
  const idx = scene.m.idx, sx = scene.sx, sy = scene.sy;
  const bx0 = scene.bx0, by0 = scene.by0, bx1 = scene.bx1, by1 = scene.by1;
  const order = scene.order, n = scene.nVis;
  let nk = 0, fast = 0;
  for (let i = n - 1; i >= 0; i--) {
    const t = order[i];
    if (cov.bboxFull(bx0[t], by0[t], bx1[t], by1[t])) { fast++; continue; }
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    if (!cov.markTest(sx[a], sy[a], sx[b], sy[b], sx[c], sy[c]))
      keep[n - 1 - nk++] = t;
  }
  cullHier.fast = fast;
  return nk;
}


// ---------------------------------------------------------------------------
// One-face SKIRT.
//
// The residual error of the sampled test is not spread evenly: it is entirely
// faces whose visible part is a sub-sample sliver, and those live in exactly
// one place -- straddling an occlusion boundary, with a KEPT face on the other
// side of a shared mesh edge.  So refuse to cull any face that has a surviving
// neighbour.  One O(nVis) pass over the adjacency the batcher already needs,
// no extra rasterisation, and it buys most of what doubling the sample rate
// would buy.
//
// Written as a second pass over `order` far -> near, so the survivor list
// comes out in painter order directly.
// ---------------------------------------------------------------------------
const keepEpoch = new Int32Array(1 << 20);
let epochId = 0;
function cullSkirt(scene, cov, keep) {
  const n = scene.nVis, order = scene.order, adj = scene.m.adj;
  const nk = cullHier(scene, cov, keep);
  const ep = ++epochId;
  for (let i = n - nk; i < n; i++) keepEpoch[keep[i]] = ep;
  let m = 0;
  for (let i = 0; i < n; i++) {
    const t = order[i];
    if (keepEpoch[t] === ep) { keep[m++] = t; continue; }
    const n0 = adj[3 * t], n1 = adj[3 * t + 1], n2 = adj[3 * t + 2];
    if ((n0 >= 0 && keepEpoch[n0] === ep) ||
        (n1 >= 0 && keepEpoch[n1] === ep) ||
        (n2 >= 0 && keepEpoch[n2] === ep)) keep[m++] = t;
  }
  // the skirt result already sits at keep[0..m), far -> near
  cullSkirt.head = 0;
  return m;
}

// ===========================================================================
// ground truth: a real per-pixel z-buffer at 1 spp (perspective-correct 1/z)
// ===========================================================================
const zb = new Float32Array(W * H), zo = new Int32Array(W * H);
function zbufTruth(scene) {
  const idx = scene.m.idx, sx = scene.sx, sy = scene.sy, sz = scene.sz;
  const order = scene.order, n = scene.nVis;
  const won = new Uint32Array(scene.m.nt);
  zb.fill(0); zo.fill(0);
  for (let i = 0; i < n; i++) {
    const t = order[i];
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    let ax = sx[a], ay = sy[a], bx = sx[b], by = sy[b], cx = sx[c], cy = sy[c];
    let iwa = 1 / sz[a], iwb = 1 / sz[b], iwc = 1 / sz[c];
    // half-plane rasterisation only accepts one winding; normalise so this
    // works whichever sheet the backface test kept
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < 0) {
      let tq = bx; bx = cx; cx = tq; tq = by; by = cy; cy = tq;
      tq = iwb; iwb = iwc; iwc = tq;
    }

    let X0 = Math.floor(Math.min(ax, bx, cx)); if (X0 < 0) X0 = 0;
    let X1 = Math.ceil(Math.max(ax, bx, cx)); if (X1 > W - 1) X1 = W - 1;
    let Y0 = Math.floor(Math.min(ay, by, cy)); if (Y0 < 0) Y0 = 0;
    let Y1 = Math.ceil(Math.max(ay, by, cy)); if (Y1 > H - 1) Y1 = H - 1;
    if (X1 < X0 || Y1 < Y0) continue;
    const A2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (A2 === 0) continue;
    const iA2 = 1 / A2;
    const dx0 = -(by - ay), dy0 = bx - ax;
    const dx1 = -(cy - by), dy1 = cx - bx;
    const dx2 = -(ay - cy), dy2 = ax - cx;
    const px = X0 + 0.5, py = Y0 + 0.5;
    let r0 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    let r1 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
    let r2 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
    for (let y = Y0; y <= Y1; y++) {
      let f0 = r0, f1 = r1, f2 = r2;
      const row = y * W;
      for (let x = X0; x <= X1; x++) {
        if (f0 >= 0 && f1 >= 0 && f2 >= 0) {
          const iw = (f1 * iwa + f2 * iwb + f0 * iwc) * iA2;
          const p = row + x;
          if (iw > zb[p]) { zb[p] = iw; zo[p] = t + 1; }
        }
        f0 += dx0; f1 += dx1; f2 += dx2;
      }
      r0 += dy0; r1 += dy1; r2 += dy2;
    }
  }
  for (let p = 0; p < W * H; p++) { const o = zo[p]; if (o) won[o - 1]++; }
  return won;
}

// ===========================================================================
// supersampled reference render, for the fidelity delta
// ===========================================================================
function renderRGB(scene, list, SS) {
  const w = W * SS, h = H * SS;
  const buf = new Uint8Array(w * h * 3);
  buf.fill(16);
  const idx = scene.m.idx, sx = scene.sx, sy = scene.sy, col = scene.col;
  const pal = scene.palRGB;
  for (let i = 0; i < list.length; i++) {          // painter order, far -> near
    const t = list[i];
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    let ax = sx[a] * SS, ay = sy[a] * SS, bx = sx[b] * SS, by = sy[b] * SS,
        cx = sx[c] * SS, cy = sy[c] * SS;
    // half-plane rasterisation only accepts one winding; normalise so this
    // works whichever sheet the backface test kept
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < 0) {
      let tq = bx; bx = cx; cx = tq; tq = by; by = cy; cy = tq;
    }

    let X0 = Math.floor(Math.min(ax, bx, cx)); if (X0 < 0) X0 = 0;
    let X1 = Math.ceil(Math.max(ax, bx, cx)); if (X1 > w - 1) X1 = w - 1;
    let Y0 = Math.floor(Math.min(ay, by, cy)); if (Y0 < 0) Y0 = 0;
    let Y1 = Math.ceil(Math.max(ay, by, cy)); if (Y1 > h - 1) Y1 = h - 1;
    if (X1 < X0 || Y1 < Y0) continue;
    const ci = col[t] * 3, R = pal[ci], G = pal[ci + 1], B = pal[ci + 2];
    const dx0 = -(by - ay), dy0 = bx - ax;
    const dx1 = -(cy - by), dy1 = cx - bx;
    const dx2 = -(ay - cy), dy2 = ax - cx;
    const px = X0 + 0.5, py = Y0 + 0.5;
    let r0 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    let r1 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
    let r2 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
    for (let y = Y0; y <= Y1; y++) {
      let f0 = r0, f1 = r1, f2 = r2;
      const row = y * w;
      for (let x = X0; x <= X1; x++) {
        if (f0 >= 0 && f1 >= 0 && f2 >= 0) {
          const p = (row + x) * 3;
          buf[p] = R; buf[p + 1] = G; buf[p + 2] = B;
        }
        f0 += dx0; f1 += dx1; f2 += dx2;
      }
      r0 += dy0; r1 += dy1; r2 += dy2;
    }
  }
  // box-filter down to W x H
  const out = new Float32Array(W * H * 3), inv = 1 / (SS * SS);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let R = 0, G = 0, B = 0;
      for (let sy2 = 0; sy2 < SS; sy2++) {
        const row = (y * SS + sy2) * w;
        for (let sx2 = 0; sx2 < SS; sx2++) {
          const p = (row + x * SS + sx2) * 3;
          R += buf[p]; G += buf[p + 1]; B += buf[p + 2];
        }
      }
      const q = (y * W + x) * 3;
      out[q] = R * inv; out[q + 1] = G * inv; out[q + 2] = B * inv;
    }
  }
  return out;
}
function rmse(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s / a.length);
}
function maxAbs(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; }
  return m;
}
// How the error is DISTRIBUTED matters more than its peak: a thousand pixels
// off by 3 is invisible, one pixel off by 200 is a sparkle once it animates.
function errHist(a, b) {
  let n2 = 0, n16 = 0, n64 = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]),
                       Math.abs(a[i + 2] - b[i + 2]));
    if (d > 2) n2++;
    if (d > 16) n16++;
    if (d > 64) n64++;
  }
  return [n2, n16, n64];
}

// ===========================================================================
// batcher counts on a face subset
// ===========================================================================
function CountCtx() { this.fills = 0; this.subpaths = 0; this.verts = 0; this.strokes = 0; }
CountCtx.prototype.beginPath = function () { };
CountCtx.prototype.moveTo = function () { this.subpaths++; this.verts++; };
CountCtx.prototype.lineTo = function () { this.verts++; };
CountCtx.prototype.closePath = function () { };
CountCtx.prototype.fill = function () { this.fills++; };
CountCtx.prototype.stroke = function () { this.strokes++; };
Object.defineProperty(CountCtx.prototype, 'fillStyle', { set() { } });
Object.defineProperty(CountCtx.prototype, 'strokeStyle', { set() { } });
Object.defineProperty(CountCtx.prototype, 'lineWidth', { set() { } });

function batchCost(scene, keep) {
  const so = scene.order, sn = scene.nVis;
  scene.order = keep; scene.nVis = keep.length;
  const R = new Renderer(scene, 4);
  R.setTile(4); R.batchGridExact();
  const c = new CountCtx(), st = new Stats();
  R.emitBoundary(c, st, true, 2);
  scene.order = so; scene.nVis = sn;
  return c;
}

function timeIt(fn, iters) {
  fn(); fn(); fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 / iters;
}

// ===========================================================================
const sp2 = makeSphere(96, 48, 4);
const scenes = [
  ['torusKnot', makeTorusKnot(512, 64, 3, 7, 8), 24, 8, ANG],
  ['sphere', makeSphere(256, 128, 4), 24, 4, ANG],
  ['grid', makeGrid(180, 4), 24, 4, ANG],
  ['soup40k', makeSoup(40000, 8, 777), 32, 8, ANG],
  ['8spheres', makeInstances(sp2, [
    [-1.1, -1.1, -1.1], [1.1, -1.1, -1.1], [-1.1, 1.1, -1.1], [1.1, 1.1, -1.1],
    [-1.1, -1.1, 1.1], [1.1, -1.1, 1.1], [-1.1, 1.1, 1.1], [1.1, 1.1, 1.1]]),
    24, 4, [0.4, 0.9, 0.13, 6.0, 700]],
  ['5deep', makeInstances(sp2, [
    [0, 0, -2.2], [0, 0, -1.1], [0, 0, 0], [0, 0, 1.1], [0, 0, 2.2]]),
    24, 4, [0.4, 0.9, 0.13, 6.5, 900]]
];

const SSLIST = [0.5, 1, 2];
const doFidelity = process.argv.includes('--rmse');

for (const [nm, mesh, sh, bd, ang] of scenes) {
  const scene = new Scene(mesh, W, H, sh, bd);
  scene.build.apply(scene, ang);
  const n = scene.nVis;
  const truth = zbufTruth(scene);
  const all = new Int32Array(scene.order.subarray(0, n));
  const base = batchCost(scene, all);
  let ref = null;
  if (doFidelity) ref = renderRGB(scene, all, 3);

  console.log('\n=== ' + nm + '  visible ' + n + '  (base: ' + base.fills +
    ' fills, ' + base.verts + ' verts)');
  console.log('  variant     cull%   kept    ms   ' +
    'FALSE culls (px)      fills     verts   ' +
    (doFidelity ? 'RMSE maxD   px>2/>16/>64' : ''));

  const keep = new Int32Array(n);
  const variants = [];
  for (const ss of SSLIST) variants.push(['hier  ss=' + ss, ss, cullHier]);
  for (const ss of [1, 2]) variants.push(['dil1  ss=' + ss, ss, makeCullD(1, 0)]);
  for (const ss of [1, 2]) variants.push(['dil1ero1 ss=' + ss, ss, makeCullD(1, 1)]);
  for (const ss of [0.5, 1, 2]) variants.push(['skirt ss=' + ss, ss, cullSkirt]);
  for (const [label, ss, fn] of variants) {
    const cov = new Coverage(W, H, ss);
    const nk = fn(scene, cov, keep);
    const kept = (fn === cullSkirt) ? keep.subarray(0, nk) : keep.subarray(n - nk);
    // false culls: dropped, but a real z-buffer says they own pixels
    const dropped = new Uint8Array(mesh.nt);
    for (let i = 0; i < n; i++) dropped[scene.order[i]] = 1;
    for (let i = 0; i < nk; i++) dropped[kept[i]] = 0;
    let fc = 0, fcPx = 0;
    for (let t = 0; t < mesh.nt; t++) if (dropped[t] && truth[t] > 0) { fc++; fcPx += truth[t]; }
    const c = batchCost(scene, new Int32Array(kept));
    const ms = timeIt(() => fn(scene, cov, keep), 20);
    let fid = '';
    if (doFidelity) {
      const img = renderRGB(scene, new Int32Array(kept), 3);
      const hh = errHist(ref, img);
      fid = rmse(ref, img).toFixed(3).padStart(7) + maxAbs(ref, img).toFixed(0).padStart(5) +
            (hh[0] + '/' + hh[1] + '/' + hh[2]).padStart(20);
    }
    console.log('  ' + label.padEnd(11) +
      (100 * (n - nk) / n).toFixed(1).padStart(7) + '%' +
      String(nk).padStart(8) + ms.toFixed(2).padStart(7) +
      (String(fc) + ' (' + fcPx + ')').padStart(18) +
      String(c.fills).padStart(11) + String(c.verts).padStart(10) + fid);
  }
}
