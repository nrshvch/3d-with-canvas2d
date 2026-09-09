// ---------------------------------------------------------------------------
// painter2d.js
//
// Depth-sorted triangle soup -> the fewest possible canvas2d fill() calls,
// without changing what the frame looks like.
//
// Three ideas, in order of payoff:
//
//   1. REORDER UNDER AN OCCUPANCY GRID.  Two triangles only have to keep their
//      painter order if their interiors actually overlap on screen.  Walking
//      the depth-sorted list and stamping each triangle's covered tiles with
//      the ordinal of the batch that drew it turns "may I move this triangle
//      back to an earlier same-colour batch?" into one integer comparison.
//
//   2. EDGE CANCELLATION.  Triangles that land in the same batch and share a
//      mesh edge contribute that edge twice, in opposite directions.  Drop
//      both.  What survives is the boundary of the merged region: fewer
//      vertices for the rasteriser, and the antialiasing seam between the two
//      triangles disappears (which is a fidelity *gain* -- see the guide).
//
//   3. COLLINEAR CANCELLATION.  Tessellated surfaces produce long straight
//      boundary runs; drop the interior vertices of each run.
//
// Everything is a preallocated typed array.  The per-frame path allocates
// nothing, builds no strings, and calls no closures.
//
// See README.md for the measurements and for
// why several "obvious" optimisations are traps (closePath() is quadratic in
// Blink; batching without edge cancellation makes software rasterisation
// slower; Firefox stops accelerating a canvas that draws novel paths).
// ---------------------------------------------------------------------------
'use strict';

// ===========================================================================
// init-time helpers
// ===========================================================================

/**
 * Edge adjacency for an indexed mesh.  adj[3*t+e] is the triangle sharing
 * edge e of triangle t (edge e runs idx[3t+e] -> idx[3t+(e+1)%3]), or -1.
 * Build this ONCE; it only depends on topology, not on the transform.
 */
export function buildAdjacency(indices, vertexCount) {
  const nt = indices.length / 3;
  const adj = new Int32Array(nt * 3).fill(-1);
  const map = new Map();
  for (let t = 0; t < nt; t++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[3 * t + e], b = indices[3 * t + (e + 1) % 3];
      const key = a < b ? a * vertexCount + b : b * vertexCount + a;
      const prev = map.get(key);
      if (prev === undefined) { map.set(key, t * 3 + e); continue; }
      const pt = (prev / 3) | 0, pe = prev % 3;
      adj[3 * t + e] = pt;
      adj[3 * pt + pe] = t;
      map.delete(key);              // non-manifold edges stay unpaired
    }
  }
  return adj;
}

/**
 * Turn an un-indexed triangle soup into an indexed mesh by welding vertices
 * that coincide within `eps`.
 *
 * Do this.  A 3D engine's geometry is nearly always a watertight mesh that
 * merely arrives without shared indices, and edge cancellation cannot see the
 * shared edges until they share vertex ids.  Measured on an unindexed torus
 * knot: welding at load takes the emitted vertex count from 142 668 to 55 300
 * and restores full cancellation, matching a natively indexed mesh exactly.
 * Without it you still get the batching win (835 stroke calls instead of
 * 35 851) but none of the vertex reduction.
 * Returns {positions, indices, vertexCount}.  Init-time only.
 */
export function weldSoup(xyz, eps) {
  const n = xyz.length / 3, inv = 1 / (eps || 1e-4);
  const map = new Map();
  const indices = new Uint32Array(n);
  const px = new Float32Array(n), py = new Float32Array(n), pz = new Float32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
    const key = Math.round(x * inv) + ',' + Math.round(y * inv) + ',' + Math.round(z * inv);
    let v = map.get(key);
    if (v === undefined) { v = m++; map.set(key, v); px[v] = x; py[v] = y; pz[v] = z; }
    indices[i] = v;
  }
  return { px: px.subarray(0, m), py: py.subarray(0, m), pz: pz.subarray(0, m), indices, vertexCount: m };
}

/**
 * Optional, and strictly dominated by the occupancy grid on every scene
 * measured -- provided because it is far simpler and has the lowest recording
 * cost of any batching option, which matters if you are main-thread bound.
 *
 * Splits the depth-sorted list into `bands` equal-count bands and colour-sorts
 * within each band (stable, so depth order survives within one colour).  Plain
 * run-length batching then finds long runs.  One counting-sort pass.
 *
 * This is an APPROXIMATION: reordering inside a band can violate the painter
 * order for triangles that overlap within it.  `bands` is the quality knob --
 * more bands, less error, less batching.  Mutates s.order in place.  Call it
 * before draw(); allocates on first use only, so keep the returned scratch.
 */
export function reorderByDepthBands(s, bands, scratch) {
  const n = s.nVis;
  if (n === 0) return scratch;
  const nb = bands * 256;
  if (!scratch || scratch.count.length < nb || scratch.tmp.length < n) {
    scratch = { count: new Uint32Array(nb), tmp: new Int32Array(n), key: new Uint32Array(n) };
  }
  const cnt = scratch.count, tmp = scratch.tmp, key = scratch.key;
  const order = s.order, colour = s.colour, scale = bands / n;
  cnt.fill(0, 0, nb);
  for (let i = 0; i < n; i++) {
    const k = ((i * scale) | 0) * 256 + colour[order[i]];
    key[i] = k; cnt[k]++;
  }
  let acc = 0;
  for (let k = 0; k < nb; k++) { const c = cnt[k]; cnt[k] = acc; acc += c; }
  for (let i = 0; i < n; i++) tmp[cnt[key[i]]++] = order[i];   // stable
  order.set(tmp.subarray(0, n), 0);
  return scratch;
}

// ===========================================================================
// PainterBatcher
// ===========================================================================
//
// Per-frame input (all preallocated by the caller, all indexed by triangle id
// except `order`, which is the depth-sorted list of triangle ids, back first):
//
//   order    Int32Array   visible triangle ids, far -> near
//   nVis     int          how many of `order` are live this frame
//   colour   Uint8Array   palette index per triangle
//   sx, sy   Float32Array projected screen x/y per *vertex*
//   bx0,by0,bx1,by1  Float32Array  screen bbox per triangle
//
// Static input: indices (Uint32Array), adjacency (Int32Array or null),
// palette (array of 256 CSS colour strings, pregenerated).

export const COVERAGE_INTERIOR = 0;  // tile centres covered  (default)
export const COVERAGE_BBOX     = 1;  // every tile the bbox touches (conservative)

export class PainterBatcher {
  /**
   * @param {object} o
   *   width, height          canvas size in CSS px
   *   triangleCount          upper bound on triangles
   *   vertexCount            upper bound on vertices
   *   indices                Uint32Array, 3 per triangle
   *   adjacency              Int32Array from buildAdjacency(), or null
   *   palette                array of CSS colour strings, indexed 0..255
   *   tile                   occupancy grid cell size in px: a power of two,
   *                          or 'auto' (default).  A FIXED tile is the wrong
   *                          answer -- the batcher's quality depends on the
   *                          ratio of triangle size to tile size, not on the
   *                          tile size itself.  Measured on one mesh at six
   *                          projection scales, the best tile tracked the mean
   *                          triangle area every time, and choosing it from
   *                          that area alone also made batching CHEAPER
   *                          (2.4 ms against 16.6 ms for a fixed 1 px grid on
   *                          large triangles).  'auto' does that.
   *   coverage               COVERAGE_INTERIOR | COVERAGE_BBOX
   *   maxVerbsPerFill        split a batch once it reaches this many path
   *                          verbs.  0 = unlimited.  See the guide: Firefox
   *                          only GPU-tessellates paths below
   *                          gfx.canvas.accelerated.gpu-path-complexity
   *                          (4000), and Skia's triangulating renderer gives
   *                          up above 1<<14.
   *   collinearEpsPx         drop a boundary vertex that sits within this many
   *                          px of the straight line through its neighbours.
   *                          0 disables.
   *   strokeSeams            default TRUE, and you almost certainly want to
   *                          leave it that way.  After filling a batch, stroke
   *                          the
   *                          same path in the same colour with lineWidth 1.
   *                          Canvas2D composites the antialiased coverage of
   *                          each fill separately, so a boundary between two
   *                          differently-coloured regions shows a background
   *                          seam; stroking closes it.  This is what
   *                          per-triangle canvas2d renderers do on EVERY
   *                          triangle -- here it is one stroke per batch,
   *                          because edge cancellation already deleted every
   *                          interior edge.  Measured on the torus knot: the
   *                          per-triangle version needs 36 180 strokes, this
   *                          needs 859, at the same measured fidelity.
   *                          Stroking is not optional for a 3D renderer: it is
   *                          the only way canvas2d can close a conflation seam,
   *                          so it is a constraint to optimise under, not a
   *                          cost to switch off.  Set it false ONLY for
   *                          geometry you know shares no edges at all, where
   *                          there is no seam to close and the stroke is pure
   *                          half-pixel bloat.
   *
   *                          IMPORTANT: if `adjacency` is null, nothing cancels
   *                          and every triangle edge is still stroked.  The fix
   *                          is to weld() at load, not to stop stroking --
   *                          measured, welding an unindexed torus knot takes
   *                          the emitted vertex count from 142 668 back to
   *                          55 300, exactly matching the natively indexed
   *                          mesh.
   *   strokeWidth            default 0.5.  The conventional seam stroke uses
   *                          lineWidth 1, which turns out to OVER-correct: an
   *                          opaque 1 px stroke centred on a colour boundary
   *                          spills half a pixel into the neighbouring region,
   *                          shifting the boundary toward whichever side is
   *                          stroked last.  Measured against a supersampled
   *                          reference, 0.5 is markedly closer to truth than
   *                          1.0 at identical cost.
   *   seamStrokeOnly         default TRUE.  The stroke pass then covers
   *                          only the edges that are genuinely seams -- shared
   *                          with another VISIBLE triangle that landed in a
   *                          different batch -- and skips silhouette edges,
   *                          which have no second triangle behind them and so
   *                          no conflation deficit to repair.  A silhouette
   *                          edge composites correctly on its own -- whatever
   *                          is behind it already covers the pixel fully -- so
   *                          stroking it only inflates the object by half a
   *                          pixel all the way round.
   *                          Costs a second path (roughly doubles emitted
   *                          vertices) but measured only +3 to +5 % of frame
   *                          time end to end, for ~20 % lower RMSE against a
   *                          supersampled reference.  Degrades safely: with no
   *                          adjacency there is no way to tell a seam from a
   *                          silhouette, so it falls back to stroking the whole
   *                          boundary rather than stroking nothing.
   *   autoFallback           default true.  After batching, cheaply predict
   *                          how much the batcher actually bought this frame;
   *                          if it bought little (unweldable soup, no colour
   *                          coherence, heavy real overlap) emit per-triangle
   *                          instead.  This is what lets one configuration be
   *                          correct on every engine and every mesh without
   *                          the caller writing any checks.
   *   fallbackFillRatio      fall back when fills > this x nVisible (0.25)
   *   fallbackVertRatio      ...AND verts > this x 3 x nVisible (0.85)
   *   localityTile           if non-zero (a power of two, e.g. 256), the
   *                          triangle's macro-tile joins the batch key, so a
   *                          batch never spans the whole screen.  Costs more
   *                          fills; buys a smaller bbox per path, which the
   *                          scanline rasteriser cares about (measured 2.1x on
   *                          clustered vs scattered subpaths at identical fill
   *                          and vertex counts).  Only worth it when you are
   *                          rasterising on the CPU.
   */
  constructor(o) {
    const nt = o.triangleCount, nv = o.vertexCount;
    this.W = o.width; this.H = o.height;
    this.indices = o.indices;
    this.adjacency = o.adjacency || null;
    this.palette = o.palette;
    this.coverage = o.coverage === undefined ? COVERAGE_INTERIOR : o.coverage;
    this.maxVerbsPerFill = o.maxVerbsPerFill === undefined ? 4000 : o.maxVerbsPerFill;
    this.localityShift = o.localityTile ? (Math.log2(o.localityTile) | 0) : 0;
    this.strokeSeams = o.strokeSeams !== false;
    this.strokeWidth = o.strokeWidth === undefined ? 0.5 : o.strokeWidth;
    this.seamStrokeOnly = o.seamStrokeOnly !== false;
    this.autoFallback = o.autoFallback !== false;
    this.fallbackFillRatio = o.fallbackFillRatio === undefined ? 0.25 : o.fallbackFillRatio;
    this.fallbackVertRatio = o.fallbackVertRatio === undefined ? 0.85 : o.fallbackVertRatio;
    this.usedFallback = false;
    this.collinearEps2 = (o.collinearEpsPx === undefined ? 0.05 : o.collinearEpsPx) ** 2;

    // --- batches (linked lists over triangle ids, no arrays of arrays) -----
    this.batchOf = new Int32Array(nt);   // triangle -> tagged batch id
    this.bNext   = new Int32Array(nt);   // triangle -> next triangle in batch
    this.bHead   = new Int32Array(nt);
    this.bTail   = new Int32Array(nt);
    this.bColour = new Uint8Array(nt);
    this.bVerbs  = new Int32Array(nt);
    this.openByColour = new Int32Array(256);
    this.openByKey = null;   // lazily sized when localityTile is used
    this.batchCount = 0;
    this.epoch = 0;
    this.tagBase = 0;

    // --- occupancy grid ----------------------------------------------------
    this.autoTile = (o.tile === undefined || o.tile === 'auto');
    this.setTile(this.autoTile ? 4 : o.tile);

    // --- boundary extraction scratch --------------------------------------
    const ec = nt * 3;
    this.eFrom = new Int32Array(ec);
    this.eTo   = new Int32Array(ec);
    this.eNext = new Int32Array(ec);
    this.eUsed = new Uint8Array(ec);
    this.eSeam = new Uint8Array(ec);
    this.vHead = new Int32Array(nv).fill(-1);
    this.touched = new Int32Array(ec);
    this.loopX = new Float32Array(ec + 4);
    this.loopY = new Float32Array(ec + 4);
    this.outX  = new Float32Array(ec + 4);
    this.outY  = new Float32Array(ec + 4);

    // --- counters (diagnostics; free to read, never allocated) -------------
    this.fills = 0; this.subpaths = 0; this.verts = 0; this.strokes = 0; this.maxPathVerbs = 0;
  }

  // Best tile from the mean screen area of a triangle.  Fitted to a six-point
  // sweep (270, 87, 24, 5.9, 1.5, 0.4 px^2): it reproduced the measured
  // optimum at every point.
  static tileForArea(meanTriArea) {
    const want = Math.sqrt(meanTriArea) / 4;
    let p = 1;
    while (p * 2 <= want && p < 8) p *= 2;
    if (p < 8 && Math.abs(Math.log2(want / (p * 2))) < Math.abs(Math.log2(want / p))) p *= 2;
    return Math.max(1, Math.min(8, p));
  }

  // one sampled pass over the bboxes; ~free next to the batching itself
  chooseTile(s) {
    const n = s.nVis;
    if (n === 0) return this.tile;
    const step = n > 4096 ? (n / 2048) | 0 : 1;
    let area = 0, k = 0;
    for (let i = 0; i < n; i += step) {
      const t = s.order[i];
      area += (s.bx1[t] - s.bx0[t]) * (s.by1[t] - s.by0[t]) * 0.5;
      k++;
    }
    const want = PainterBatcher.tileForArea(area / k);
    // hysteresis: only move when it is a clear step, so a slow zoom does not
    // flap the grid (and reallocate) every frame
    if (want !== this.tile && (want >= this.tile * 2 || want * 2 <= this.tile)) return want;
    return this.tile;
  }

  setTile(px) {
    this.tile = px;
    this.tileShift = Math.log2(px) | 0;
    this.tw = (this.W >> this.tileShift) + 2;
    this.th = (this.H >> this.tileShift) + 2;
    const n = this.tw * this.th;
    if (!this.stamp || this.stamp.length < n) {
      this.stamp = new Int32Array(n);
      this.covered = new Int32Array(n);
      this.epoch = 0;
    }
  }

  // -------------------------------------------------------------------------
  // pass 1: group triangles into single-coloured, depth-safe batches
  // -------------------------------------------------------------------------
  batch(s) {
    if (this.autoTile) {
      const want = this.chooseTile(s);
      if (want !== this.tile) this.setTile(want);
    }
    const n = s.nVis, order = s.order, colour = s.colour, idx = this.indices;
    const sx = s.sx, sy = s.sy;
    const bx0 = s.bx0, by0 = s.by0, bx1 = s.bx1, by1 = s.by1;
    const batchOf = this.batchOf, bNext = this.bNext, bHead = this.bHead,
          bTail = this.bTail, bColour = this.bColour, bVerbs = this.bVerbs;
    const stamp = this.stamp, cov = this.covered;
    const tw = this.tw, th = this.th, sh = this.tileShift, ts = this.tile, half = ts * 0.5;
    const interior = this.coverage === COVERAGE_INTERIOR;
    const ls = this.localityShift;
    const mw = ls ? ((this.W >> ls) + 2) : 1;
    const mn = ls ? mw * ((this.H >> ls) + 2) : 1;
    if (ls && (!this.openByKey || this.openByKey.length < 256 * mn))
      this.openByKey = new Int32Array(256 * mn);
    const open = ls ? this.openByKey : this.openByColour;

    // Epoch tagging: ordinals from frame k live in [base, base+nt), disjoint
    // from every other frame, so last frame's grid reads as "older than
    // everything" and we never have to clear it.
    let base = this.epoch + 1;
    if (base > 0x7ff00000 - (batchOf.length + 2)) { stamp.fill(0); base = 1; }
    this.epoch = base + batchOf.length + 1;
    this.tagBase = base;
    open.fill(-1);
    let nb = 0;


    for (let i = 0; i < n; i++) {
      const t = order[i], c = colour[t];
      let tx0 = bx0[t] >> sh, ty0 = by0[t] >> sh;
      let tx1 = bx1[t] >> sh, ty1 = by1[t] >> sh;
      if (tx0 < 0) tx0 = 0;
      if (ty0 < 0) ty0 = 0;
      if (tx1 >= tw) tx1 = tw - 1;
      if (ty1 >= th) ty1 = th - 1;
      if (tx1 < tx0 || ty1 < ty0) continue;

      let maxOrd = base, nc = 0;

      if (!interior || (tx0 === tx1 && ty0 === ty1)) {
        for (let y = ty0; y <= ty1; y++) {
          const row = y * tw;
          for (let x = tx0; x <= tx1; x++) {
            const p = row + x;
            cov[nc++] = p;
            const v = stamp[p]; if (v > maxOrd) maxOrd = v;
          }
        }
      } else {
        // Half-plane edge functions sampled at tile centres, stepped
        // incrementally.  Each tile centre of a watertight surface belongs to
        // exactly one triangle, so edge-adjacent triangles do NOT collide --
        // which is the whole reason this beats bbox stamping by ~10x.
        const a = idx[3 * t], b = idx[3 * t + 1], cq = idx[3 * t + 2];
        const ax = sx[a], ay = sy[a], bxv = sx[b], byv = sy[b], cxv = sx[cq], cyv = sy[cq];
        const dx0 = -(byv - ay) * ts, dy0 = (bxv - ax) * ts;
        const dx1 = -(cyv - byv) * ts, dy1 = (cxv - bxv) * ts;
        const dx2 = -(ay - cyv) * ts, dy2 = (ax - cxv) * ts;
        const ox = tx0 * ts + half, oy = ty0 * ts + half;
        let r0 = (bxv - ax) * (oy - ay) - (byv - ay) * (ox - ax);
        let r1 = (cxv - bxv) * (oy - byv) - (cyv - byv) * (ox - bxv);
        let r2 = (ax - cxv) * (oy - cyv) - (ay - cyv) * (ox - cxv);
        for (let y = ty0; y <= ty1; y++) {
          let f0 = r0, f1 = r1, f2 = r2;
          const row = y * tw;
          for (let x = tx0; x <= tx1; x++) {
            if (f0 >= 0 && f1 >= 0 && f2 >= 0) {
              const p = row + x;
              cov[nc++] = p;
              const v = stamp[p]; if (v > maxOrd) maxOrd = v;
            }
            f0 += dx0; f1 += dx1; f2 += dx2;
          }
          r0 += dy0; r1 += dy1; r2 += dy2;
        }
        if (nc === 0) {                       // thinner than one tile
          let fx = ((ax + bxv + cxv) * 0.3333333) >> sh;
          let fy = ((ay + byv + cyv) * 0.3333333) >> sh;
          if (fx < 0) fx = 0; else if (fx >= tw) fx = tw - 1;
          if (fy < 0) fy = 0; else if (fy >= th) fy = th - 1;
          const p = fy * tw + fx;
          cov[nc++] = p;
          const v = stamp[p]; if (v > maxOrd) maxOrd = v;
        }
      }

      let key = c;
      if (ls) {
        let gx = ((bx0[t] + bx1[t]) * 0.5) >> ls, gy = ((by0[t] + by1[t]) * 0.5) >> ls;
        if (gx < 0) gx = 0;
        if (gy < 0) gy = 0;
        key = c * mn + gy * mw + gx;
      }
      let b = open[key];
      // b is joinable iff no batch newer than b has claimed any tile this
      // triangle covers.  Ordinals are unique, so >= is exact.
      if (b < 0 || (base + b + 1) < maxOrd) {
        b = nb++;
        bColour[b] = c; bHead[b] = t; bTail[b] = t; bNext[t] = -1;
        bVerbs[b] = 1; open[key] = b;
      } else {
        bNext[bTail[b]] = t; bTail[b] = t; bNext[t] = -1;
        bVerbs[b]++;
      }
      batchOf[t] = base + b;

      const ord = base + b + 1;
      for (let k = 0; k < nc; k++) stamp[cov[k]] = ord;
    }
    this.batchCount = nb;
    return nb;
  }

  // -------------------------------------------------------------------------
  // pass 2: emit.  One fill() per batch, boundary loops only.
  // -------------------------------------------------------------------------
  emit(ctx, s) {
    const idx = this.indices, adj = this.adjacency, sx = s.sx, sy = s.sy;
    const pal = this.palette;
    const bHead = this.bHead, bNext = this.bNext, bColour = this.bColour,
          batchOf = this.batchOf, tag = this.tagBase;
    const eFrom = this.eFrom, eTo = this.eTo, eNext = this.eNext, eUsed = this.eUsed;
    const eSeam = this.eSeam;
    const vHead = this.vHead, touched = this.touched;
    const lx = this.loopX, ly = this.loopY, ox = this.outX, oy = this.outY;
    const eps2 = this.collinearEps2, doCollinear = eps2 > 0;
    const verbCap = this.maxVerbsPerFill;
    const doStroke = this.strokeSeams;
    const seamOnly = doStroke && this.seamStrokeOnly && adj !== null;
    const nB = this.batchCount;
    let fills = 0, subpaths = 0, verts = 0, strokes = 0, maxPathVerbs = 0, seamEdges = 0;
    if (doStroke) ctx.lineWidth = this.strokeWidth;

    for (let b = 0; b < this.batchCount; b++) {
      const tb = tag + b;

      // ---- collect the directed edges that are NOT shared inside the batch
      let ne = 0, nTouch = 0;
      if (adj) {
        for (let t = bHead[b]; t >= 0; t = bNext[t]) {
          const i0 = idx[3 * t], i1 = idx[3 * t + 1], i2 = idx[3 * t + 2];
          const n0 = adj[3 * t], n1 = adj[3 * t + 1], n2 = adj[3 * t + 2];
          // A surviving edge is a SEAM only if the triangle on the other side
          // is visible this frame and landed in a different batch: then two
          // fills share it and the antialiasing conflates.  Otherwise it is a
          // silhouette, where there is nothing to conflate with.
          if (n0 < 0 || batchOf[n0] !== tb) {
            eFrom[ne] = i0; eTo[ne] = i1;
            eSeam[ne] = (n0 >= 0 && batchOf[n0] >= tag && batchOf[n0] < tag + nB) ? 1 : 0; ne++;
          }
          if (n1 < 0 || batchOf[n1] !== tb) {
            eFrom[ne] = i1; eTo[ne] = i2;
            eSeam[ne] = (n1 >= 0 && batchOf[n1] >= tag && batchOf[n1] < tag + nB) ? 1 : 0; ne++;
          }
          if (n2 < 0 || batchOf[n2] !== tb) {
            eFrom[ne] = i2; eTo[ne] = i0;
            eSeam[ne] = (n2 >= 0 && batchOf[n2] >= tag && batchOf[n2] < tag + nB) ? 1 : 0; ne++;
          }
        }
      } else {
        for (let t = bHead[b]; t >= 0; t = bNext[t]) {
          const i0 = idx[3 * t], i1 = idx[3 * t + 1], i2 = idx[3 * t + 2];
          eFrom[ne] = i0; eTo[ne] = i1; ne++;
          eFrom[ne] = i1; eTo[ne] = i2; ne++;
          eFrom[ne] = i2; eTo[ne] = i0; ne++;
        }
      }

      // ---- bucket by start vertex
      for (let e = 0; e < ne; e++) {
        const v = eFrom[e];
        if (vHead[v] === -1) touched[nTouch++] = v;
        eNext[e] = vHead[v]; vHead[v] = e; eUsed[e] = 0;
      }

      // ---- chain into closed loops
      //
      // The surviving edge set is the boundary of a 2-chain, so in-degree
      // equals out-degree at every vertex: a maximal walk always returns to
      // where it started (Euler).  And under the nonzero rule the filled
      // region is determined by the multiset of directed edges alone, so it
      // does not matter HOW the walk pairs them up at a pinch vertex.
      // Styles first: the cap below may need to flush mid-batch, and every
      // flush in this batch uses the same colour.
      const col = pal[bColour[b]];       // pregenerated hex, never built here
      ctx.fillStyle = col;
      if (doStroke) ctx.strokeStyle = col;
      ctx.beginPath();
      let pathVerbs = 0;
      for (let e0 = 0; e0 < ne; e0++) {
        if (eUsed[e0]) continue;
        let k = 0, e = e0;
        for (;;) {
          eUsed[e] = 1;
          const v = eFrom[e];
          lx[k] = sx[v]; ly[k] = sy[v]; k++;
          const w = eTo[e];
          let nx = -1;
          for (let q = vHead[w]; q !== -1; q = eNext[q]) { if (eUsed[q] === 0) { nx = q; break; } }
          if (nx === -1) break;
          e = nx;
        }
        if (k < 3) continue;

        let m = k;
        if (doCollinear) {
          m = 0;
          for (let i = 0; i < k; i++) {
            if (m >= 1) {
              const ax = ox[m - 1], ay = oy[m - 1], j = (i + 1) % k;
              const d1x = lx[i] - ax, d1y = ly[i] - ay;
              const d2x = lx[j] - lx[i], d2y = ly[j] - ly[i];
              const cr = d1x * d2y - d1y * d2x;
              const tx = d1x + d2x, ty = d1y + d2y;
              // |cross| / |A->C| is the distance of the dropped vertex from
              // the straight line that would replace it.
              if (cr * cr <= eps2 * (tx * tx + ty * ty) && (d1x * d2x + d1y * d2y) > 0) continue;
            }
            ox[m] = lx[i]; oy[m] = ly[i]; m++;
          }
          if (m < 3) continue;
          ctx.moveTo(ox[0], oy[0]);
          for (let i = 1; i < m; i++) ctx.lineTo(ox[i], oy[i]);
          // stroke() does not close subpaths the way fill() does, so the
          // closing edge has to be spelled out.  An explicit lineTo, never
          // closePath() -- that is the O(N^2) trap.
          if (doStroke && !seamOnly) ctx.lineTo(ox[0], oy[0]);
        } else {
          ctx.moveTo(lx[0], ly[0]);
          for (let i = 1; i < k; i++) ctx.lineTo(lx[i], ly[i]);
          if (doStroke && !seamOnly) ctx.lineTo(lx[0], ly[0]);
        }
        // NO closePath(): fill() closes every subpath implicitly, and in Blink
        // closePath() recomputes the whole path's bounding box, which makes
        // building an N-subpath path O(N^2).  Measured 390x on 8000 subpaths.
        subpaths++; verts += m; pathVerbs += m + 1;
        // Split the batch's geometry across several fills once the path gets
        // too complex for the engine's fast path (Firefox: 4000 verbs).  Safe
        // at any point -- everything in this batch is the same colour, so the
        // order between the pieces cannot matter.
        if (pathVerbs > maxPathVerbs) maxPathVerbs = pathVerbs;
        if (verbCap && pathVerbs >= verbCap) {
          ctx.fill(); fills++;
          if (doStroke && !seamOnly) { ctx.stroke(); strokes++; }
          ctx.beginPath(); pathVerbs = 0;
        }
      }
      for (let i = 0; i < nTouch; i++) vHead[touched[i]] = -1;

      if (pathVerbs > 0) {
        ctx.fill(); fills++;
        if (doStroke && !seamOnly) { ctx.stroke(); strokes++; }
      }

      if (seamOnly) {
        // Second path: seam edges only, chained into open polylines so each
        // costs about one vertex rather than the two a bare segment needs.
        for (let i = 0; i < nTouch; i++) vHead[touched[i]] = -1;
        nTouch = 0;
        let nS = 0;
        for (let e = 0; e < ne; e++) {
          if (!eSeam[e]) continue;
          const v = eFrom[e];
          if (vHead[v] === -1) touched[nTouch++] = v;
          eNext[e] = vHead[v]; vHead[v] = e; eUsed[e] = 0; nS++;
        }
        if (nS) {
          seamEdges += nS;
          ctx.beginPath();
          for (let e0 = 0; e0 < ne; e0++) {
            if (!eSeam[e0] || eUsed[e0]) continue;
            let e = e0, vc = 1;
            ctx.moveTo(sx[eFrom[e]], sy[eFrom[e]]);
            for (;;) {
              eUsed[e] = 1;
              const w2 = eTo[e];
              ctx.lineTo(sx[w2], sy[w2]); vc++;
              let nx = -1;
              for (let q = vHead[w2]; q !== -1; q = eNext[q]) {
                if (eUsed[q] === 0 && eSeam[q]) { nx = q; break; }
              }
              if (nx === -1) break;
              e = nx;
            }
            subpaths++; verts += vc;
          }
          ctx.stroke(); strokes++;
        }
        // vHead was rebuilt for the seam pass, so it has to be cleared again
        // or the next batch walks into this one's edges.
        for (let i = 0; i < nTouch; i++) vHead[touched[i]] = -1;
      }
    }
    this.fills = fills; this.subpaths = subpaths; this.verts = verts;
    this.strokes = strokes; this.maxPathVerbs = maxPathVerbs;
    this.seamEdges = seamEdges;
  }

  // -------------------------------------------------------------------------
  // How many vertices will emit() actually produce?  Every interior edge that
  // cancels removes one directed edge, and each directed edge contributes one
  // vertex.  So predicted = 3*nVis - cancelled, exactly, and it costs one
  // O(nVis) pass of array reads -- far cheaper than emitting and regretting it.
  // -------------------------------------------------------------------------
  predictVerts(s) {
    const adj = this.adjacency;
    if (!adj) return s.nVis * 3;
    const bHead = this.bHead, bNext = this.bNext, batchOf = this.batchOf, tag = this.tagBase;
    let cancelled = 0;
    for (let b = 0; b < this.batchCount; b++) {
      const tb = tag + b;
      for (let t = bHead[b]; t >= 0; t = bNext[t]) {
        const n0 = adj[3 * t], n1 = adj[3 * t + 1], n2 = adj[3 * t + 2];
        if (n0 >= 0 && batchOf[n0] === tb) cancelled++;
        if (n1 >= 0 && batchOf[n1] === tb) cancelled++;
        if (n2 >= 0 && batchOf[n2] === tb) cancelled++;
      }
    }
    return s.nVis * 3 - cancelled;
  }

  // The baseline, kept as a real code path so the fallback is one call away.
  emitPerTriangle(ctx, s) {
    const idx = this.indices, sx = s.sx, sy = s.sy, pal = this.palette;
    const order = s.order, colour = s.colour, n = s.nVis;
    const doStroke = this.strokeSeams;
    if (doStroke) ctx.lineWidth = this.strokeWidth;
    for (let i = 0; i < n; i++) {
      const t = order[i], a = idx[3 * t], q = idx[3 * t + 1], r = idx[3 * t + 2];
      const ax = sx[a], ay = sy[a];
      ctx.beginPath();
      ctx.moveTo(ax, ay); ctx.lineTo(sx[q], sy[q]); ctx.lineTo(sx[r], sy[r]);
      const col = pal[colour[t]];
      ctx.fillStyle = col;
      if (doStroke) { ctx.lineTo(ax, ay); ctx.strokeStyle = col; ctx.fill(); ctx.stroke(); }
      else ctx.fill();
    }
    this.fills = n; this.strokes = doStroke ? n : 0;
    this.subpaths = n; this.verts = n * (doStroke ? 4 : 3);
    this.maxPathVerbs = doStroke ? 5 : 4;
  }

  /**
   * batch + emit, with the content guard.  This is the only call a consumer
   * needs, on any engine.
   */
  draw(ctx, s) {
    this.batch(s);
    if (this.autoFallback && s.nVis > 0) {
      // Batching almost always pays once stroking is in the picture, because a
      // stroke is per PATH: even with zero edge cancellation, an unwelded mesh
      // still goes from 35 851 stroke calls to 835.  The guard is only for
      // genuinely degenerate content -- independent overlapping triangles with
      // random colours -- where neither the fill count nor the vertex count
      // moves enough to pay for leaving the engine's simple-primitive path.
      const verts = this.predictVerts(s);
      if (this.batchCount > s.nVis * this.fallbackFillRatio &&
          verts > s.nVis * 3 * this.fallbackVertRatio) {
        this.usedFallback = true;
        this.emitPerTriangle(ctx, s);
        return;
      }
    }
    this.usedFallback = false;
    this.emit(ctx, s);
  }
}
