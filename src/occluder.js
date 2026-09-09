// ---------------------------------------------------------------------------
// occluder.js
//
// Occlusion culling for a painter's-algorithm renderer, with no depth buffer
// and no per-pixel depth anywhere.
//
// THE IDEA.  A painter already owns a total depth order.  Walk that same list
// the other way -- near to far -- and "is this face visible?" stops being a
// depth question and becomes a 2D one: "is its screen footprint already
// claimed?"  That is a coverage buffer, and coverage is one bit per sample.
// This is Doom's `solidsegs` and Build's C-buffer generalised from 1D to 2D,
// or equivalently Intel's Masked Software Occlusion Culling (2016) with the
// depth half of each tile deleted, because the sort has already done that job.
//
// THE TRICK.  The mark and the test are the same operation.  Marking a face
// that is already fully covered sets no new bit -- so "did I set a bit?"
// answers "was I visible?" for free.  No query phase, no second traversal.
//
// WHY IT PAYS HERE MORE THAN ON A GPU.  On a GPU, culling a hidden triangle
// saves its pixels.  In canvas2d the pixels are the cheap part (an opaque
// source-over fill is the cheapest blend there is); what costs is path verbs
// and fill calls.  Culling removes the face from the *batcher's input*, so it
// takes vertices and fills with it.  Measured on a 65k torus knot: 56 % of
// submitted faces contribute no pixel at all, and dropping them takes 108 800
// path vertices to 52 918 and 1 039 fills to 655.  And one cull serves every
// pass -- albedo, shading, fog -- so the saving lands three times.
//
// WHAT IT COSTS.  ~3 ms of CPU at 35 k faces, 1280x720, in node.  Two things
// make that affordable: coverage is a bitmask, so a span costs O(span/32) word
// ops instead of O(span) pixel ops; and a block hierarchy rejects a hidden
// face in one to four array reads without any scanline setup.
//
// See README.md for the measurements, and
// bench/occlude.js for the sweep that chose these defaults.
// ---------------------------------------------------------------------------
'use strict';

export class Occluder {
  /**
   * @param {object} o
   *   width, height     canvas size in CSS px
   *   triangleCount     upper bound on triangles
   *   indices           Uint32Array, 3 per triangle
   *   adjacency         Int32Array from buildAdjacency(), or null.  With it,
   *                     `skirt` works and the culler is nearly artefact-free;
   *                     without it the culler still runs, just noisier.
   *   sampleScale       samples per pixel per axis.  1 (default) puts the
   *                     coverage grid on the same lattice the rasteriser
   *                     samples, which is the right answer: 0.5 quadruples
   *                     the visible error for 20 % less time, and 2 costs
   *                     50 % more time than `skirt` does for less fidelity.
   *   skirt             default TRUE, and the single best line in the file if
   *                     you have adjacency.  Refuse to cull a face that has a
   *                     surviving neighbour across a shared mesh edge.
   *                     Rationale: the sampled test's whole residual error is
   *                     faces whose visible part is a sub-sample sliver, and
   *                     those sit on an occlusion boundary with a kept face on
   *                     the other side.  Measured on the torus knot, the skirt
   *                     costs 2.7 points of cull rate (56.4 % -> 53.7 %) and
   *                     takes the pixels that differ from a supersampled
   *                     reference by more than 16/255 from 349 to 26, with
   *                     none at all above 64/255.  That is better fidelity
   *                     than doubling the sample rate, at a third of the cost.
   *   minRate           default 0.06.  If a frame culls a smaller fraction
   *                     than this, the culler is not paying for itself, so
   *                     skip it for a while (see `autoSkip`).  A convex closed
   *                     mesh -- a sphere -- has NOTHING to cull after backface
   *                     culling: one sheet, zero overdraw.  Measured, the
   *                     culler spends 3.2 ms on a 45 k sphere to remove
   *                     exactly zero faces, so this guard is not optional.
   *   autoSkip          default true.  Exponential back-off, 4 -> 64 frames,
   *                     re-probing at the end of each interval.  Amortised
   *                     worst case on unculled content: one 3 ms frame in 64,
   *                     i.e. 0.05 ms/frame.  This is CHC++'s "don't re-query
   *                     what was visible" reduced to its simplest useful form,
   *                     and it is why one configuration is safe on any mesh.
   */
  constructor(o) {
    const nt = o.triangleCount;
    this.W = o.width; this.H = o.height;
    this.indices = o.indices;
    this.adjacency = o.adjacency || null;
    this.ss = o.sampleScale === undefined ? 1 : o.sampleScale;
    this.skirt = o.skirt !== false && this.adjacency !== null;
    this.minRate = o.minRate === undefined ? 0.06 : o.minRate;
    this.autoSkip = o.autoSkip !== false;

    // --- coverage: one Int32 per 32 samples of a sample row -----------------
    this.sw = Math.round(this.W * this.ss);
    this.sh = Math.round(this.H * this.ss);
    this.wpr = (this.sw + 31) >> 5;
    this.cov = new Int32Array(this.wpr * this.sh);

    // --- hierarchy: per block of 32 samples x 8 sample rows, how many of the
    // 8 words are saturated.  All 8 means the block is finished, so a face
    // whose bbox lands entirely in finished blocks is rejected without any
    // scanline work -- and marking it would have been a no-op anyway, which is
    // what makes skipping it exact rather than approximate.
    this.bh = (this.sh + 7) >> 3;
    this.blk = new Uint8Array(this.wpr * this.bh);
    this.blkRows = new Uint8Array(this.bh);
    for (let b = 0; b < this.bh; b++) this.blkRows[b] = Math.min(8, this.sh - b * 8);

    // --- output + scratch (preallocated; the per-frame path allocates nothing)
    this.list = null;           // survivors, far -> near.  Feed to the batcher.
    this.count = 0;
    this.keep = new Int32Array(nt);
    this.mark = new Int32Array(nt);   // epoch-tagged keep set, never cleared
    this.epoch = 0;

    // --- diagnostics (free to read) ----------------------------------------
    this.culled = 0; this.rate = 0; this.skipped = false;
    this.backoff = 0; this.skipFrames = 0;
  }

  // -------------------------------------------------------------------------
  // Mark the triangle, and report whether it was already fully covered.
  // Returns 1 = contributed no new sample, i.e. invisible.  0 = keep.
  //
  // The sample scale is folded into the vertices once, so the row loop holds
  // no multiply at all: both x limits walk by DDA and the only branch is the
  // one crossing the middle vertex.
  // -------------------------------------------------------------------------
  markTest(ax, ay, bx, by, cx, cy) {
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
    if (j1 < j0) return 0;                 // thinner than one sample row: keep
    const g02 = (y2 > y0) ? (x2 - x0) / (y2 - y0) : 0;
    const g01 = (y1 > y0) ? (x1 - x0) / (y1 - y0) : 0;
    const g12 = (y2 > y1) ? (x2 - x1) / (y2 - y1) : 0;
    const yc = j0 + 0.5;
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
        const base = j * wpr, bb = (j >> 3) * wpr;
        const w0 = is >> 5, w1 = ie >> 5;
        if (w0 === w1) {
          const m = (-1 << (is & 31)) & (-1 >>> (31 - (ie & 31)));
          const p = base + w0, old = cov[p], nw = old | m;
          if (nw !== old) { neu = 1; cov[p] = nw; if (nw === -1) blk[bb + w0]++; }
        } else {
          let m = -1 << (is & 31);
          let p = base + w0, old = cov[p], nw = old | m;
          if (nw !== old) { neu = 1; cov[p] = nw; if (nw === -1) blk[bb + w0]++; }
          for (let w = w0 + 1; w < w1; w++) {
            p = base + w;
            if (cov[p] !== -1) { neu = 1; cov[p] = -1; blk[bb + w]++; }
          }
          m = -1 >>> (31 - (ie & 31));
          p = base + w1; old = cov[p]; nw = old | m;
          if (nw !== old) { neu = 1; cov[p] = nw; if (nw === -1) blk[bb + w1]++; }
        }
      }
      xa += g02;
      if (lower && (j + 1.5) >= y1) { lower = false; gb = g12; xb = x1 + (j + 1.5 - y1) * g12; }
      else xb += gb;
    }
    return (any && !neu) ? 1 : 0;
  }

  // Conservative reject: is every block the pixel-space bbox touches finished?
  // The bbox is a superset of the triangle, so a yes here is never wrong.
  bboxFull(x0, y0, x1, y1) {
    const ss = this.ss;
    let i0 = (x0 * ss) | 0, i1 = Math.ceil(x1 * ss);
    let j0 = (y0 * ss) | 0, j1 = Math.ceil(y1 * ss);
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
  }

  /**
   * Cull one frame.  Reads the same `s` the batcher reads: order, nVis, sx,
   * sy, bx0/by0/bx1/by1.  Afterwards `this.list` / `this.count` are the
   * survivors in painter order (far -> near) -- hand those straight to the
   * batcher:
   *
   *     occ.cull(s);
   *     s.order = occ.list; s.nVis = occ.count;
   *     batcher.draw(ctx, s);
   *
   * When the guard decides not to bother, `list`/`count` come back as the
   * caller's own order/nVis, so that snippet stays correct either way.
   */
  cull(s) {
    const n = s.nVis;
    if (n === 0 || (this.autoSkip && this.skipFrames > 0)) {
      this.skipFrames--; this.skipped = true;
      this.culled = 0; this.rate = 0;
      this.list = s.order; this.count = n;
      return n;
    }
    this.skipped = false;
    this.cov.fill(0); this.blk.fill(0);

    const idx = this.indices, sx = s.sx, sy = s.sy;
    const bx0 = s.bx0, by0 = s.by0, bx1 = s.bx1, by1 = s.by1;
    const order = s.order, keep = this.keep;
    let nk = 0;
    // Near -> far.  Survivors are written from the far end of `keep`, so they
    // come out in painter order with no reverse pass.
    for (let i = n - 1; i >= 0; i--) {
      const t = order[i];
      if (this.bboxFull(bx0[t], by0[t], bx1[t], by1[t])) continue;
      const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
      if (!this.markTest(sx[a], sy[a], sx[b], sy[b], sx[c], sy[c]))
        keep[n - 1 - nk++] = t;
    }

    let head = n - nk;
    if (this.skirt) {
      // Un-cull every face with a surviving neighbour.  One O(n) pass over
      // `order` far -> near, so the result lands at keep[0..m) already sorted.
      const adj = this.adjacency, mark = this.mark, ep = ++this.epoch;
      for (let i = head; i < n; i++) mark[keep[i]] = ep;
      let m = 0;
      for (let i = 0; i < n; i++) {
        const t = order[i];
        if (mark[t] === ep) { keep[m++] = t; continue; }
        const n0 = adj[3 * t], n1 = adj[3 * t + 1], n2 = adj[3 * t + 2];
        if ((n0 >= 0 && mark[n0] === ep) ||
            (n1 >= 0 && mark[n1] === ep) ||
            (n2 >= 0 && mark[n2] === ep)) keep[m++] = t;
      }
      head = 0; nk = m;
    }

    this.list = keep.subarray(head, head + nk);
    this.count = nk;
    this.culled = n - nk;
    this.rate = this.culled / n;

    if (this.autoSkip) {
      if (this.rate < this.minRate) {
        this.backoff = this.backoff ? Math.min(this.backoff * 2, 64) : 4;
        this.skipFrames = this.backoff;
      } else {
        this.backoff = 0;
      }
    }
    return nk;
  }
}
