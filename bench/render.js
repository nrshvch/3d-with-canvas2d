// ---------------------------------------------------------------------------
// render.js -- competing emission strategies.  All share Scene's output
// (depth-sorted triangle id list + palette index + screen bbox).
// Zero allocation per frame.
// ---------------------------------------------------------------------------
'use strict';

function Stats() { this.reset(); }
Stats.prototype.reset = function () {
  this.fills = 0; this.subpaths = 0; this.verts = 0; this.styleSets = 0; this.strokes = 0; this.seamEdges = 0;
  // Largest single fill() in path verbs.  Firefox declines GPU tessellation
  // above gfx.canvas.accelerated.gpu-path-complexity (4000) and rasterises
  // that path in software into an uploaded mask instead, so the MAXIMUM
  // matters where the mean does not.
  this.maxFillVerts = 0;
};

// ---------------------------------------------------------------------------
function Renderer(scene, tileSize) {
  const nt = scene.m.nt, nv = scene.m.nv;
  this.s = scene;
  this.setTile(tileSize || 16);

  this.batchOf = new Int32Array(nt);
  this.bNext   = new Int32Array(nt);      // tri -> next tri in its batch
  this.bHead   = new Int32Array(nt);
  this.bTail   = new Int32Array(nt);
  // Int32, not Uint8: any experiment that multiplies the palette (fog bands
  // folded into the colour, 4.10) exceeds 256 colours, and a Uint8 index
  // truncates SILENTLY -- typed arrays swallow the out-of-range write and the
  // batcher then emits nothing at all.
  this.bColor  = new Int32Array(nt);
  this.nB      = 0;
  this.openByColor = new Int32Array(1 << 16);   // see bColor above
  this.openByKey = new Int32Array(256 * 1024);
  this.cov = new Int32Array(4096);
  // smallHead is allocated by setTile(), which the constructor already called
  this.smallNext = new Int32Array(nt);    // slot -> next slot in the same tile
  this.smallTri  = new Int32Array(nt);    // slot -> triangle id
  this.smallOrd  = new Int32Array(nt);
  this.epoch = 0;
  this.baseTag = 0;
  this.lbx0 = new Float32Array(nt); this.lby0 = new Float32Array(nt);
  this.lbx1 = new Float32Array(nt); this.lby1 = new Float32Array(nt);

  // boundary extraction scratch
  const ec = nt * 3;
  this.eFrom = new Int32Array(ec);
  this.eTo   = new Int32Array(ec);
  this.eNext = new Int32Array(ec);
  this.eUsed = new Uint8Array(ec);
  this.eSeam = new Uint8Array(ec);
  this.vHead = new Int32Array(nv).fill(-1);
  this.touch = new Int32Array(ec);
  this.lx = new Float32Array(ec + 4);
  this.ly = new Float32Array(ec + 4);
  this.ox = new Float32Array(ec + 4);
  this.oy = new Float32Array(ec + 4);

  this.closePaths = false;
  this.collinearEps2 = 0.0025;            // (0.05 px)^2
}

Renderer.prototype.setTile = function (px) {
  this.tile = px;
  this.tileShift = Math.log2(px) | 0;
  this.tw = (this.s.W >> this.tileShift) + 2;
  this.th = (this.s.H >> this.tileShift) + 2;
  if (!this.tileStamp || this.tileStamp.length < this.tw * this.th) {
    this.tileStamp = new Int32Array(this.tw * this.th);
    this.epoch = 0;
  }
  if (!this.cov || this.cov.length < this.tw * this.th)
    this.cov = new Int32Array(this.tw * this.th);
  if (!this.smallHead || this.smallHead.length < this.tw * this.th)
    this.smallHead = new Int32Array(this.tw * this.th);
};

// exact interior-overlap test for two projected triangles (separating axis on
// the six edge normals; touching counts as separated)
function triOverlapExact(sx, sy, idx, a, b) {
  const a0 = idx[3 * a], a1 = idx[3 * a + 1], a2 = idx[3 * a + 2];
  const b0 = idx[3 * b], b1 = idx[3 * b + 1], b2 = idx[3 * b + 2];
  const ax = sx[a0], ay = sy[a0], bx = sx[a1], by = sy[a1], cx = sx[a2], cy = sy[a2];
  const dx = sx[b0], dy = sy[b0], ex = sx[b1], ey = sy[b1], fx = sx[b2], fy = sy[b2];
  for (let pass = 0; pass < 2; pass++) {
    const p0x = pass ? dx : ax, p0y = pass ? dy : ay;
    const p1x = pass ? ex : bx, p1y = pass ? ey : by;
    const p2x = pass ? fx : cx, p2y = pass ? fy : cy;
    const q0x = pass ? ax : dx, q0y = pass ? ay : dy;
    const q1x = pass ? bx : ex, q1y = pass ? by : ey;
    const q2x = pass ? cx : fx, q2y = pass ? cy : fy;
    for (let i = 0; i < 3; i++) {
      const ux = i === 0 ? p0x : i === 1 ? p1x : p2x, uy = i === 0 ? p0y : i === 1 ? p1y : p2y;
      const vx = i === 0 ? p1x : i === 1 ? p2x : p0x, vy = i === 0 ? p1y : i === 1 ? p2y : p0y;
      const nx = -(vy - uy), ny = (vx - ux);
      let p_lo = nx * p0x + ny * p0y, p_hi = p_lo;
      let d1 = nx * p1x + ny * p1y; if (d1 < p_lo) p_lo = d1; else if (d1 > p_hi) p_hi = d1;
      let d2 = nx * p2x + ny * p2y; if (d2 < p_lo) p_lo = d2; else if (d2 > p_hi) p_hi = d2;
      let q_lo = nx * q0x + ny * q0y, q_hi = q_lo;
      let e1 = nx * q1x + ny * q1y; if (e1 < q_lo) q_lo = e1; else if (e1 > q_hi) q_hi = e1;
      let e2 = nx * q2x + ny * q2y; if (e2 < q_lo) q_lo = e2; else if (e2 > q_hi) q_hi = e2;
      if (p_hi <= q_lo || q_hi <= p_lo) return false;
    }
  }
  return true;
}

// === optional pre-ordering ==================================================
// "Make the soup less soupy": split the depth-sorted list into B equal-count
// bands and colour-sort inside each band (stable, so depth order survives
// within one colour).  One counting-sort pass, no allocation.
//
// This is an APPROXIMATION with a knob: B = nVis is the exact depth order,
// B = 1 is colour-only and visually wrong.  The point of measuring it is to
// see whether cheap ordering can replace the occupancy grid, and what it costs
// in fidelity.  Error is quantified against the 4x supersampled reference.
Renderer.prototype.reorderBands = function (B) {
  const s = this.s, n = s.nVis, order = s.order, col = s.col;
  if (n === 0) return;
  const nb = B * 256;
  if (!this.rbCount || this.rbCount.length < nb + 1) this.rbCount = new Uint32Array(nb + 1);
  if (!this.rbTmp || this.rbTmp.length < n) this.rbTmp = new Int32Array(n);
  if (!this.rbKey || this.rbKey.length < n) this.rbKey = new Uint32Array(n);
  const cnt = this.rbCount, tmp = this.rbTmp, key = this.rbKey;
  cnt.fill(0, 0, nb + 1);
  const scale = B / n;
  for (let i = 0; i < n; i++) {
    const k = ((i * scale) | 0) * 256 + col[order[i]];
    key[i] = k; cnt[k]++;
  }
  let acc = 0;
  for (let k = 0; k < nb; k++) { const c = cnt[k]; cnt[k] = acc; acc += c; }
  for (let i = 0; i < n; i++) tmp[cnt[key[i]]++] = order[i];   // stable
  order.set(tmp.subarray(0, n), 0);
};

// === batching ==============================================================

// consecutive runs of identical colour only -- the "free" batching
Renderer.prototype.batchRuns = function () {
  this.baseTag = 0;
  const s = this.s, n = s.nVis, order = s.order, col = s.col;
  const batchOf = this.batchOf, bNext = this.bNext,
        bHead = this.bHead, bTail = this.bTail, bColor = this.bColor;
  batchOf.fill(-1);
  let nb = 0, i = 0;
  while (i < n) {
    const c = col[order[i]];
    bColor[nb] = c; bHead[nb] = order[i];
    let prev = order[i]; batchOf[prev] = nb; i++;
    while (i < n && col[order[i]] === c) {
      const t = order[i]; bNext[prev] = t; batchOf[t] = nb; prev = t; i++;
    }
    bNext[prev] = -1; bTail[nb] = prev; nb++;
  }
  this.nB = nb;
};

// depth-safe reordering: a triangle may join an OLDER same-colour batch iff no
// batch created after that batch has touched any tile the triangle covers.
// (Skia GrOpsTask / Godot item reordering, but with an O(1) occupancy grid
//  instead of a fixed-length look-back window.)
Renderer.prototype.batchGrid = function () {
  this.baseTag = 0;
  const s = this.s, n = s.nVis, order = s.order, col = s.col;
  const bx0 = s.bx0, by0 = s.by0, bx1 = s.bx1, by1 = s.by1;
  const batchOf = this.batchOf, bNext = this.bNext,
        bHead = this.bHead, bTail = this.bTail, bColor = this.bColor;
  const stamp = this.tileStamp, tw = this.tw, th = this.th, sh = this.tileShift;
  const open = this.openByColor;
  batchOf.fill(-1); stamp.fill(0); open.fill(-1);
  this.epoch = 0;                        // raw ordinals written: reset epoch base
  let nb = 0;

  for (let i = 0; i < n; i++) {
    const t = order[i], c = col[t];
    let tx0 = bx0[t] >> sh, ty0 = by0[t] >> sh;
    let tx1 = bx1[t] >> sh, ty1 = by1[t] >> sh;
    if (tx0 < 0) tx0 = 0;
    if (ty0 < 0) ty0 = 0;
    if (tx1 >= tw) tx1 = tw - 1;
    if (ty1 >= th) ty1 = th - 1;

    let maxS = 0;
    for (let y = ty0; y <= ty1; y++) {
      const row = y * tw;
      for (let x = tx0; x <= tx1; x++) { const v = stamp[row + x]; if (v > maxS) maxS = v; }
    }

    let b = open[c];
    if (b < 0 || (b + 1) < maxS) {         // ordinal of batch b is b+1
      b = nb++; bColor[b] = c; bHead[b] = t; bTail[b] = t; bNext[t] = -1; open[c] = b;
    } else {
      bNext[bTail[b]] = t; bTail[b] = t; bNext[t] = -1;
    }
    batchOf[t] = b;

    const ord = b + 1;
    for (let y = ty0; y <= ty1; y++) {
      const row = y * tw;
      for (let x = tx0; x <= tx1; x++) stamp[row + x] = ord;
    }
  }
  this.nB = nb;
  this.epoch = nb + 1;                   // keep epoch above the raw ordinals
};

// Same as batchGrid, but a triangle claims only the tiles whose CENTRE it
// actually covers, instead of every tile its bbox touches.
//
// Why this matters: two edge-adjacent triangles share an edge but no interior.
// With bbox stamping they always look like a conflict, which is what kept the
// bbox grid ~50x away from the theoretical batch floor.  With centre sampling
// each tile centre belongs to exactly one triangle of a watertight surface, so
// a single-layer surface produces ZERO conflicts and collapses to one batch
// per colour.  Overlaps smaller than one tile can be missed -- that is the
// deliberate trade, and it is exactly the sub-pixel sliver region where the
// per-triangle baseline is itself producing conflation seams.
Renderer.prototype.batchGridExact = function (macroShift) {
  const s = this.s, n = s.nVis, order = s.order, col = s.col, idx = s.m.idx;
  const sx = s.sx, sy = s.sy;
  const bx0 = s.bx0, by0 = s.by0, bx1 = s.bx1, by1 = s.by1;
  const batchOf = this.batchOf, bNext = this.bNext,
        bHead = this.bHead, bTail = this.bTail, bColor = this.bColor;
  const stamp = this.tileStamp, tw = this.tw, th = this.th, sh = this.tileShift;
  const ts = this.tile, half = ts * 0.5;
  const open = this.openByColor, cov = this.cov;
  const smallHead = this.smallHead, smallNext = this.smallNext,
        smallTri = this.smallTri, smallOrd = this.smallOrd;
  // Sub-tile triangles cover no tile centre, so the grid alone cannot see
  // them.  The cheap fallback is to let them claim their centroid tile, which
  // is conservative -- and once most triangles are smaller than a tile that
  // fallback IS the batcher, so batching stops working.  With exactSmall they
  // instead go into a short per-tile list and are tested pairwise and
  // EXACTLY.  Adjacent sub-pixel triangles tile the surface rather than
  // overlapping it, so nearly every one of those tests comes back false.
  const exactSmall = this.exactSmall !== false;
  const SMALL_WALK = this.smallWalk === undefined ? 16 : this.smallWalk;

  let base = this.epoch + 1;
  if (base > 0x7ff00000 - (s.m.nt + 2)) { stamp.fill(0); smallHead.fill(0); base = 1; }
  this.epoch = base + s.m.nt + 1;
  this.baseTag = base;

  const ms = macroShift | 0;
  const mw = ms ? ((s.W >> ms) + 2) : 1;
  const mh = ms ? ((s.H >> ms) + 2) : 1;
  const mn = mw * mh;
  const openN = ms ? this.openByKey : open;
  if (ms) openN.fill(-1, 0, 256 * mn); else openN.fill(-1);
  let nb = 0, smallSlot = 0, smallTests = 0;

  for (let i = 0; i < n; i++) {
    const t = order[i], c = col[t];
    let tx0 = bx0[t] >> sh, ty0 = by0[t] >> sh;
    let tx1 = bx1[t] >> sh, ty1 = by1[t] >> sh;
    if (tx0 < 0) tx0 = 0;
    if (ty0 < 0) ty0 = 0;
    if (tx1 >= tw) tx1 = tw - 1;
    if (ty1 >= th) ty1 = th - 1;
    if (tx1 < tx0 || ty1 < ty0) continue;

    const ia = idx[3 * t], ib = idx[3 * t + 1], ic = idx[3 * t + 2];
    const ax = sx[ia], ay = sy[ia], bxv = sx[ib], byv = sy[ib], cxv = sx[ic], cyv = sy[ic];
    let maxS = base, nc = 0;

    // ---- read: tile stamps (large triangles) over the bbox range, plus an
    // exact walk of the small-triangle lists in the same tiles ---------------
    if (tx0 === tx1 && ty0 === ty1) {
      const p = ty0 * tw + tx0;
      cov[nc++] = p;
      const v = stamp[p]; if (v > maxS) maxS = v;
      if (exactSmall) {
        let slot = smallHead[p] - base, guard = 0;
        while (slot >= 0 && guard++ < SMALL_WALK) {
          if (smallOrd[slot] > maxS && triOverlapExact(sx, sy, idx, smallTri[slot], t)) maxS = smallOrd[slot];
          smallTests++;
          slot = smallNext[slot];
        }
      }
    } else {
      const sx0 = -(byv - ay) * ts, sy0 = (bxv - ax) * ts;
      const sx1 = -(cyv - byv) * ts, sy1 = (cxv - bxv) * ts;
      const sx2 = -(ay - cyv) * ts, sy2 = (ax - cxv) * ts;
      const ox = tx0 * ts + half, oy = ty0 * ts + half;
      let e0 = (bxv - ax) * (oy - ay) - (byv - ay) * (ox - ax);
      let e1 = (cxv - bxv) * (oy - byv) - (cyv - byv) * (ox - bxv);
      let e2 = (ax - cxv) * (oy - cyv) - (ay - cyv) * (ox - cxv);
      for (let y = ty0; y <= ty1; y++) {
        let f0 = e0, f1 = e1, f2 = e2;
        const row = y * tw;
        for (let x = tx0; x <= tx1; x++) {
          const p = row + x;
          if (f0 >= 0 && f1 >= 0 && f2 >= 0) {
            cov[nc++] = p;
            const v = stamp[p]; if (v > maxS) maxS = v;
          }
          // a small triangle can sit in a tile whose centre this one does not
          // cover, so the small lists are walked over the whole bbox range
          if (exactSmall) {
            let slot = smallHead[p] - base, guard = 0;
            while (slot >= 0 && guard++ < SMALL_WALK) {
              if (smallOrd[slot] > maxS && triOverlapExact(sx, sy, idx, smallTri[slot], t)) maxS = smallOrd[slot];
              smallTests++;
              slot = smallNext[slot];
            }
          }
          f0 += sx0; f1 += sx1; f2 += sx2;
        }
        e0 += sy0; e1 += sy1; e2 += sy2;
      }
      if (nc === 0) {                     // thinner than one tile: centroid
        let fx = ((ax + bxv + cxv) * 0.3333333) >> sh;
        let fy = ((ay + byv + cyv) * 0.3333333) >> sh;
        if (fx < 0) fx = 0; else if (fx >= tw) fx = tw - 1;
        if (fy < 0) fy = 0; else if (fy >= th) fy = th - 1;
        const p = fy * tw + fx;
        cov[nc++] = p;
        const v = stamp[p]; if (v > maxS) maxS = v;   // must still be read
      }
    }
    // "small" = claims exactly one tile and covered no centre with area
    const isSmall = exactSmall && nc === 1;

    let key = c;
    if (ms) {
      const mx = (bx0[t] + bx1[t]) * 0.5, my = (by0[t] + by1[t]) * 0.5;
      let gx = mx >> ms, gy = my >> ms;
      if (gx < 0) gx = 0;
      if (gy < 0) gy = 0;
      key = c * mn + gy * mw + gx;
    }
    let b = openN[key];
    if (b < 0 || (base + b + 1) < maxS) {
      b = nb++; bColor[b] = c; bHead[b] = t; bTail[b] = t; bNext[t] = -1; openN[key] = b;
    } else {
      bNext[bTail[b]] = t; bTail[b] = t; bNext[t] = -1;
    }
    batchOf[t] = base + b;
    const ord = base + b + 1;

    // ---- write ------------------------------------------------------------
    if (isSmall) {
      // register in the tile list ONLY.  Writing the tile stamp as well is
      // what made the exact test pointless: the conservative claim was still
      // blocking every other small triangle in the tile.
      const p = cov[0], slot = smallSlot++;
      smallTri[slot] = t; smallOrd[slot] = ord;
      const prev = smallHead[p] - base;
      smallNext[slot] = prev >= 0 ? prev : -1;
      smallHead[p] = base + slot;
    } else {
      for (let k = 0; k < nc; k++) stamp[cov[k]] = ord;
    }
  }
  this.nB = nb;
  this.lastSmallTests = smallTests;
  this.lastSmallCount = smallSlot;
};

// Skia GrOpsTask / Godot RasterizerCanvasBatcher style: bounded look-back over
// the most recent K batches, exact bbox test, stop at the first intersection.
Renderer.prototype.batchLookback = function (K) {
  this.baseTag = 0;
  const s = this.s, n = s.nVis, order = s.order, col = s.col;
  const bx0 = s.bx0, by0 = s.by0, bx1 = s.bx1, by1 = s.by1;
  const batchOf = this.batchOf, bNext = this.bNext,
        bHead = this.bHead, bTail = this.bTail, bColor = this.bColor;
  const lbx0 = this.lbx0, lby0 = this.lby0, lbx1 = this.lbx1, lby1 = this.lby1;
  batchOf.fill(-1);
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const t = order[i], c = col[t];
    const x0 = bx0[t], y0 = by0[t], x1 = bx1[t], y1 = by1[t];
    let hit = -1;
    const lo = nb - K > 0 ? nb - K : 0;
    for (let b = nb - 1; b >= lo; b--) {
      if (bColor[b] === c) { hit = b; break; }
      if (!(lbx1[b] < x0 || lbx0[b] > x1 || lby1[b] < y0 || lby0[b] > y1)) break; // blocked
    }
    if (hit < 0) {
      const b = nb++;
      bColor[b] = c; bHead[b] = t; bTail[b] = t; bNext[t] = -1; batchOf[t] = b;
      lbx0[b] = x0; lby0[b] = y0; lbx1[b] = x1; lby1[b] = y1;
    } else {
      bNext[bTail[hit]] = t; bTail[hit] = t; bNext[t] = -1; batchOf[t] = hit;
      if (x0 < lbx0[hit]) lbx0[hit] = x0;
      if (y0 < lby0[hit]) lby0[hit] = y0;
      if (x1 > lbx1[hit]) lbx1[hit] = x1;
      if (y1 > lby1[hit]) lby1[hit] = y1;
    }
  }
  this.nB = nb;
};

// upper bound on batching: one batch per colour, depth order ignored.
// VISUALLY WRONG where colours overlap -- measured only to bound the win.
Renderer.prototype.batchColorOnly = function () {
  this.baseTag = 0;
  const s = this.s, n = s.nVis, order = s.order, col = s.col;
  const batchOf = this.batchOf, bNext = this.bNext,
        bHead = this.bHead, bTail = this.bTail, bColor = this.bColor;
  const open = this.openByColor;
  batchOf.fill(-1); open.fill(-1);
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const t = order[i], c = col[t];
    let b = open[c];
    if (b < 0) { b = nb++; bColor[b] = c; bHead[b] = t; bTail[b] = t; bNext[t] = -1; open[c] = b; }
    else { bNext[bTail[b]] = t; bTail[b] = t; bNext[t] = -1; }
    batchOf[t] = b;
  }
  this.nB = nb;
};

// === emission ==============================================================

// one subpath per triangle
Renderer.prototype.emitTris = function (ctx, st, stroke) {
  const s = this.s, idx = s.m.idx, sx = s.sx, sy = s.sy, pal = s.pal;
  const bHead = this.bHead, bNext = this.bNext, bColor = this.bColor;
  const cp = this.closePaths;
  for (let b = 0; b < this.nB; b++) {
    ctx.beginPath();
    let cnt = 0;
    for (let t = bHead[b]; t >= 0; t = bNext[t]) {
      const a = idx[3 * t], q = idx[3 * t + 1], r = idx[3 * t + 2];
      ctx.moveTo(sx[a], sy[a]); ctx.lineTo(sx[q], sy[q]); ctx.lineTo(sx[r], sy[r]);
      // stroke() does NOT close subpaths the way fill() does, so a stroked
      // subpath needs its closing edge spelled out.  An explicit lineTo is
      // used rather than closePath() -- see the O(N^2) trap.
      if (stroke) ctx.lineTo(sx[a], sy[a]);
      if (cp) ctx.closePath();
      cnt++;
    }
    st.subpaths += cnt; st.verts += cnt * (stroke ? 4 : 3);
    const col = pal[bColor[b]];
    { const dv = cnt * (stroke ? 4 : 3); if (dv > st.maxFillVerts) st.maxFillVerts = dv; }
    ctx.fillStyle = col; st.styleSets++;
    ctx.fill(); st.fills++;
    if (stroke) { ctx.strokeStyle = col; ctx.stroke(); st.strokes++; }
  }
};

// shared-edge cancellation -> boundary loops -> one subpath per loop
// strokeMode: 0 = no stroke, 1 = stroke the whole boundary,
//             2 = stroke only the edges that are actually seams, i.e. shared
//                 with another VISIBLE triangle that landed in a different
//                 batch.  A silhouette edge has no second triangle behind it,
//                 so there is no conflation deficit there and stroking it only
//                 inflates the object by half a pixel.
// bStart lets a caller emit a SLICE of the batches, [bStart, nB).  Only used
// by the experiment that asks whether Firefox's path budget is per canvas or
// shared, which needs several canvases to draw DIFFERENT paths.
Renderer.prototype.emitBoundary = function (ctx, st, collinear, strokeMode, bStart) {
  const s = this.s, m = s.m, idx = m.idx, adj = m.adj, sx = s.sx, sy = s.sy, pal = s.pal;
  const bHead = this.bHead, bNext = this.bNext, bColor = this.bColor, batchOf = this.batchOf;
  const eFrom = this.eFrom, eTo = this.eTo, eNext = this.eNext, eUsed = this.eUsed;
  const vHead = this.vHead, touch = this.touch;
  const lx = this.lx, ly = this.ly, ox = this.ox, oy = this.oy;
  const eps2 = this.collinearEps2, cp = this.closePaths;
  const eSeam = this.eSeam;
  const sm = strokeMode === true ? 1 : (strokeMode | 0);
  const nBatches = this.nB;

  const tag = this.baseTag;
  // a neighbour is visible this frame iff its tagged batch id is in range
  const vis = (nb) => (nb >= 0 && batchOf[nb] >= tag && batchOf[nb] < tag + nBatches) ? 1 : 0;
  for (let b = (bStart | 0); b < this.nB; b++) {
    const tb = tag + b;
    const w0 = st.verts;
    // 1. collect surviving (non-shared) directed edges
    let ne = 0, nTouch = 0;
    for (let t = bHead[b]; t >= 0; t = bNext[t]) {
      const i0 = idx[3 * t], i1 = idx[3 * t + 1], i2 = idx[3 * t + 2];
      const n0 = adj[3 * t], n1 = adj[3 * t + 1], n2 = adj[3 * t + 2];
      if (n0 < 0 || batchOf[n0] !== tb) { eFrom[ne] = i0; eTo[ne] = i1; eSeam[ne] = vis(n0); ne++; }
      if (n1 < 0 || batchOf[n1] !== tb) { eFrom[ne] = i1; eTo[ne] = i2; eSeam[ne] = vis(n1); ne++; }
      if (n2 < 0 || batchOf[n2] !== tb) { eFrom[ne] = i2; eTo[ne] = i0; eSeam[ne] = vis(n2); ne++; }
    }
    // 2. bucket edges by from-vertex
    for (let e = 0; e < ne; e++) {
      const v = eFrom[e];
      if (vHead[v] === -1) touch[nTouch++] = v;
      eNext[e] = vHead[v]; vHead[v] = e; eUsed[e] = 0;
    }
    // 3. walk loops.  Under NONZERO fill the winding field is the sum of the
    //    directed edge contributions, so ANY pairing of the surviving edges
    //    into closed loops renders identically.
    ctx.beginPath();
    for (let e0 = 0; e0 < ne; e0++) {
      if (eUsed[e0]) continue;
      let k = 0, e = e0;
      for (;;) {
        eUsed[e] = 1;
        const v = eFrom[e];
        lx[k] = sx[v]; ly[k] = sy[v]; k++;
        const w2 = eTo[e];
        let nx = -1;
        for (let q = vHead[w2]; q !== -1; q = eNext[q]) { if (eUsed[q] === 0) { nx = q; break; } }
        if (nx === -1) break;
        e = nx;
      }
      if (k < 3) continue;
      let w = k;
      if (collinear) {
        w = 0;
        for (let i = 0; i < k; i++) {
          if (w >= 1) {
            const ax = ox[w - 1], ay = oy[w - 1];
            const j = (i + 1) % k;
            const d1x = lx[i] - ax, d1y = ly[i] - ay;
            const d2x = lx[j] - lx[i], d2y = ly[j] - ly[i];
            const cr = d1x * d2y - d1y * d2x;
            const tx = d1x + d2x, ty = d1y + d2y;
            if (cr * cr <= eps2 * (tx * tx + ty * ty) && (d1x * d2x + d1y * d2y) > 0) continue;
          }
          ox[w] = lx[i]; oy[w] = ly[i]; w++;
        }
        if (w < 3) continue;
        ctx.moveTo(ox[0], oy[0]);
        for (let i = 1; i < w; i++) ctx.lineTo(ox[i], oy[i]);
        if (sm === 1) ctx.lineTo(ox[0], oy[0]);
      } else {
        ctx.moveTo(lx[0], ly[0]);
        for (let i = 1; i < k; i++) ctx.lineTo(lx[i], ly[i]);
        if (sm === 1) ctx.lineTo(lx[0], ly[0]);
      }
      if (cp) ctx.closePath();
      st.subpaths++; st.verts += w + (sm === 1 ? 1 : 0);
    }
    const col = pal[bColor[b]];
    if (w0 >= 0) { const dv = st.verts - w0; if (dv > st.maxFillVerts) st.maxFillVerts = dv; }
    ctx.fillStyle = col; st.styleSets++;
    // Under destination-over the FIRST draw wins, so to keep the stroke on top
    // of the fill (which is what source-over gives) the order must invert.
    if (sm === 1 && this.strokeFirst) {
      ctx.strokeStyle = col; ctx.stroke(); st.strokes++;
      ctx.fill(); st.fills++;
    } else {
      ctx.fill(); st.fills++;
      if (sm === 1) { ctx.strokeStyle = col; ctx.stroke(); st.strokes++; }
    }

    if (sm === 2) {
      // second path: only the seam edges, chained into open polylines so each
      // one costs about one vertex rather than the two a bare segment needs.
      for (let i = 0; i < nTouch; i++) vHead[touch[i]] = -1;
      let nS = 0;
      for (let e = 0; e < ne; e++) {
        if (!eSeam[e]) continue;
        const v = eFrom[e];
        if (vHead[v] === -1) touch[nTouch++] = v;
        eNext[e] = vHead[v]; vHead[v] = e; eUsed[e] = 0; nS++;
      }
      if (nS) {
        ctx.beginPath();
        for (let e0 = 0; e0 < ne; e0++) {
          if (!eSeam[e0] || eUsed[e0]) continue;
          let e = e0;
          ctx.moveTo(sx[eFrom[e]], sy[eFrom[e]]);
          let vcount = 1;
          for (;;) {
            eUsed[e] = 1;
            const w2 = eTo[e];
            ctx.lineTo(sx[w2], sy[w2]); vcount++;
            let nx = -1;
            for (let q = vHead[w2]; q !== -1; q = eNext[q]) {
              if (eUsed[q] === 0 && eSeam[q]) { nx = q; break; }
            }
            if (nx === -1) break;
            e = nx;
          }
          st.subpaths++; st.verts += vcount;
        }
        ctx.strokeStyle = col; ctx.stroke(); st.strokes++;
      }
      st.seamEdges += nS;
    }
    for (let i = 0; i < nTouch; i++) vHead[touch[i]] = -1;
  }
};

// === strategies ============================================================
const STRATEGIES = {
  // baseline: one beginPath + one fill per triangle
  tri: function (R, ctx, st) {
    const s = R.s, idx = s.m.idx, sx = s.sx, sy = s.sy, pal = s.pal,
          order = s.order, col = s.col, n = s.nVis;
    for (let i = 0; i < n; i++) {
      const t = order[i], a = idx[3 * t], q = idx[3 * t + 1], r = idx[3 * t + 2];
      ctx.beginPath();
      ctx.moveTo(sx[a], sy[a]); ctx.lineTo(sx[q], sy[q]); ctx.lineTo(sx[r], sy[r]);
      ctx.fillStyle = pal[col[t]];
      ctx.fill();
    }
    st.fills += n; st.subpaths += n; st.verts += n * 3; st.styleSets += n;
  },
  // baseline + explicit closePath
  triClose: function (R, ctx, st) {
    const s = R.s, idx = s.m.idx, sx = s.sx, sy = s.sy, pal = s.pal,
          order = s.order, col = s.col, n = s.nVis;
    for (let i = 0; i < n; i++) {
      const t = order[i], a = idx[3 * t], q = idx[3 * t + 1], r = idx[3 * t + 2];
      ctx.beginPath();
      ctx.moveTo(sx[a], sy[a]); ctx.lineTo(sx[q], sy[q]); ctx.lineTo(sx[r], sy[r]);
      ctx.closePath();
      ctx.fillStyle = pal[col[t]];
      ctx.fill();
    }
    st.fills += n; st.subpaths += n; st.verts += n * 3; st.styleSets += n;
  },
  // THE REAL-WORLD BASELINE: per triangle, fill then stroke in the same
  // colour, because that is what canvas2d renderers do to hide the
  // antialiasing conflation seam between adjacent triangles.
  triStroke: function (R, ctx, st) {
    const s = R.s, idx = s.m.idx, sx = s.sx, sy = s.sy, pal = s.pal,
          order = s.order, col = s.col, n = s.nVis;
    for (let i = 0; i < n; i++) {
      const t = order[i], a = idx[3 * t], q = idx[3 * t + 1], r = idx[3 * t + 2];
      const ax = sx[a], ay = sy[a];
      ctx.beginPath();
      ctx.moveTo(ax, ay); ctx.lineTo(sx[q], sy[q]); ctx.lineTo(sx[r], sy[r]); ctx.lineTo(ax, ay);
      const c = pal[col[t]];
      ctx.fillStyle = c; ctx.strokeStyle = c;
      ctx.fill(); ctx.stroke();
    }
    st.fills += n; st.strokes += n; st.subpaths += n; st.verts += n * 4; st.styleSets += n * 2;
  },
  // free win: merge consecutive equal-colour triangles
  run:             function (R, c, st) { R.batchRuns();      R.emitTris(c, st); },
  runBoundary:     function (R, c, st) { R.batchRuns();      R.emitBoundary(c, st, false); },
  runBoundaryCol:  function (R, c, st) { R.batchRuns();      R.emitBoundary(c, st, true); },
  // depth-safe reordering with an occupancy grid
  grid:            function (R, c, st) { R.batchGrid();      R.emitTris(c, st); },
  gridBoundary:    function (R, c, st) { R.batchGrid();      R.emitBoundary(c, st, false); },
  gridBoundaryCol: function (R, c, st) { R.batchGrid();      R.emitBoundary(c, st, true); },
  // exact interior coverage grid
  gridX:            function (R, c, st) { R.batchGridExact(); R.emitTris(c, st); },
  gridXBoundary:    function (R, c, st) { R.batchGridExact(); R.emitBoundary(c, st, false); },
  gridXBoundaryCol: function (R, c, st) { R.batchGridExact(); R.emitBoundary(c, st, true); },
  gridXLocal:       function (R, c, st) { R.batchGridExact(8); R.emitBoundary(c, st, true); },
  // --- fill+stroke seam-hiding on top of batching -------------------------
  gridXStroke:      function (R, c, st) { R.setTile(2); R.batchGridExact(); R.emitBoundary(c, st, true, 1); },
  gridXSeamStroke:  function (R, c, st) { R.setTile(2); R.batchGridExact(); R.emitBoundary(c, st, true, 2); },
  // --- cheap pre-ordering: depth bands + colour sort ----------------------
  bandsRuns:        function (R, c, st) { R.reorderBands(64); R.batchRuns(); R.emitBoundary(c, st, true); },
  bandsRunsStroke:  function (R, c, st) { R.reorderBands(64); R.batchRuns(); R.emitBoundary(c, st, true, true); },
  bandsGrid:        function (R, c, st) { R.reorderBands(64); R.setTile(2); R.batchGridExact(); R.emitBoundary(c, st, true); },
  // unreachable ceiling: ignore depth entirely
  colorOnly:       function (R, c, st) { R.batchColorOnly(); R.emitBoundary(c, st, true); }
};
