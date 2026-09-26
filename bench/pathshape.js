// bench/pathshape.js -- what shape of path the emitter hands the backend.
// ---------------------------------------------------------------------------
// ES module, loaded by Node (bench/tess.mjs, bench/bandx.mjs) and by the
// browser (bench/tesspage.html), so the paths that are COUNTED are the paths
// that are TIMED and DIFFED, byte for byte.
//
// Every strategy below draws the same faces in the same colours; they differ
// only in how the faces are cut into fill() calls and subpaths:
//
//   perFace      one fill() per triangle -- 3-vertex convex paths
//   noCancel     the batcher's batches, every triangle its own subpath: the
//                shared edges are still in the path, twice, in opposite
//                directions (what an unwelded mesh produces, 6.7)
//   boundary     the batcher's batches as boundary loops -- edge
//                cancellation + collinear drop (4.3), the shipped emitter
//                without its seam stroke
//   band         boundary + the in-line seam band (4.8, option 7): on every
//                edge shared with a visible neighbour drawn LATER, step out
//                perpendicular by w and back.  With `mit` options, the
//                junction fixes of 4.12.
//
// Nothing here allocates per frame after construction except the census.
// ---------------------------------------------------------------------------

// Flags on a boundary edge, from the side of the batch that owns the loop.
export const E_SILHOUETTE = 0;  // neighbour absent, culled or backfacing
export const E_SEAM_EARLY = 1;  // neighbour visible, other batch, drawn EARLIER
export const E_BAND = 2;        // neighbour visible, other batch, drawn LATER

// ===========================================================================
// Boundary loops with per-edge flags, exactly as PainterBatcher.emit() walks
// them (same edge set, same bucket-by-start-vertex chaining).
// ===========================================================================
export class Loops {
  constructor(nt, nv) {
    const ec = nt * 3;
    this.eFrom = new Int32Array(ec); this.eTo = new Int32Array(ec);
    this.eFlag = new Uint8Array(ec); this.eNext = new Int32Array(ec);
    this.eUsed = new Uint8Array(ec);
    this.vHead = new Int32Array(nv).fill(-1); this.touched = new Int32Array(ec);
    // output: loops, flat
    this.vid = new Int32Array(ec); this.flag = new Uint8Array(ec);
    this.apex = new Int32Array(ec);             // neighbour's third vertex across edge i, or -1
    this.pinch = new Uint8Array(ec);            // the batch's boundary passes through this vertex twice
    this.eApex = new Int32Array(ec);
    this.start = new Int32Array(ec); this.len = new Int32Array(ec); this.batch = new Int32Array(ec);
    this.nLoops = 0; this.nV = 0;
    this.batchLoop0 = new Int32Array(nt + 1);   // first loop index of batch b
  }

  extract(B, idx, adj) {
    const { bHead, bNext, batchOf } = B, tag = B.tagBase, nB = B.batchCount;
    const { eFrom, eTo, eFlag, eNext, eUsed, vHead, touched, vid, flag, start, len, batch, apex, eApex, pinch } = this;
    let nL = 0, nV = 0;
    for (let b = 0; b < nB; b++) {
      this.batchLoop0[b] = nL;
      const tb = tag + b;
      let ne = 0, nT = 0;
      for (let t = bHead[b]; t >= 0; t = bNext[t]) {
        for (let e = 0; e < 3; e++) {
          const n = adj[3 * t + e];
          if (n >= 0 && batchOf[n] === tb) continue;              // cancelled
          eFrom[ne] = idx[3 * t + e]; eTo[ne] = idx[3 * t + (e + 1) % 3];
          eApex[ne] = n >= 0 ? idx[3 * n] + idx[3 * n + 1] + idx[3 * n + 2] - eFrom[ne] - eTo[ne] : -1;
          const vis = n >= 0 && batchOf[n] >= tag && batchOf[n] < tag + nB;
          eFlag[ne] = !vis ? E_SILHOUETTE : (batchOf[n] > tb ? E_BAND : E_SEAM_EARLY);
          ne++;
        }
      }
      for (let e = 0; e < ne; e++) {
        const v = eFrom[e];
        if (vHead[v] === -1) touched[nT++] = v;
        eNext[e] = vHead[v]; vHead[v] = e; eUsed[e] = 0;
      }
      for (let e0 = 0; e0 < ne; e0++) {
        if (eUsed[e0]) continue;
        const s0 = nV;
        let e = e0;
        for (;;) {
          eUsed[e] = 1;
          vid[nV] = eFrom[e]; flag[nV] = eFlag[e]; apex[nV] = eApex[e];
          const h0 = vHead[eFrom[e]]; pinch[nV] = h0 !== -1 && eNext[h0] !== -1 ? 1 : 0;   // 2+ boundary edges leave v
          nV++;
          let nx = -1;
          for (let q = vHead[eTo[e]]; q !== -1; q = eNext[q]) if (!eUsed[q]) { nx = q; break; }
          if (nx === -1) break;
          e = nx;
        }
        if (nV - s0 < 3) { nV = s0; continue; }
        start[nL] = s0; len[nL] = nV - s0; batch[nL] = b; nL++;
      }
      for (let i = 0; i < nT; i++) vHead[touched[i]] = -1;
    }
    this.batchLoop0[nB] = nL;
    this.nLoops = nL; this.nV = nV;
    return this;
  }
}

// ===========================================================================
// The band, and the junction fixes.
// ===========================================================================
//
// Loop orientation: the scene keeps triangles with positive screen-space
// cross product, and a boundary loop inherits that winding, so the interior
// is on the LEFT of every directed edge under (dx, dy) -> (-dy, dx), and the
// outward normal is (dy, -dx) / |d|.  A vertex whose turn has cross > 0 is
// convex; cross < 0 is reflex.
//
// mit = {
//   spike:  drop the zero-area out-and-back an in-line band leaves where two
//           collinear band edges meet (b' -> b -> b' with b' repeated).
//           EXACT: removes a degenerate sliver of zero area.
//   reflex: at a reflex junction of two band edges turning by <= 90 deg, the
//           two offset segments cross; replace (b'ab, b, b'bc) by their
//           intersection H.  EXACT in exact arithmetic: the path loses the
//           winding of the quad (H, b'ab, b, b'bc), which lies inside both
//           band quads, so every point of it stays covered.  Sharper reflex
//           corners are left alone (see the n1.n2 test below).
//   bevel:  at a convex junction of two band edges, replace (b'ab, b, b'bc)
//           by (b'ab, b'bc).  LOSSY: adds the triangle b, b'ab, b'bc outside
//           the polygon -- ink over whatever face owns that corner.
//   endclip: at a FREE END of a band run that sits on a reflex vertex, cut
//           the band where it crosses the neighbouring non-band edge.  LOSSY
//           by design: what it removes is ink over the face across that
//           edge, which was drawn earlier -- 4.8's outline spill.
//   end8:   at a FREE END of a run, put the band's corner on the line from
//           that vertex to the NEIGHBOUR's third vertex (qx, qy: the far
//           vertex of the triangle across the band edge) instead of on the
//           perpendicular -- 4.8's option 8, at run ends only.  The corner
//           then lies on an edge the later neighbour owns, so the band cannot
//           poke past that neighbour.  LOSSY by design: it removes ink.
//   shortMin: no band at all on a band edge shorter than this (px).  LOSSY:
//           can reopen a gap along that edge.
// }
export function bandLoop(px, py, fl, k, w, mit, ox, oy, qx, qy, pk) {
  // px/py: loop vertices, fl: edge flags (edge i = i -> i+1), k: count.
  // Writes into ox/oy, returns the output count.
  const shortMin2 = mit.shortMin ? mit.shortMin * mit.shortMin : 0;
  let m = 0;
  // does edge i carry a band?
  const isBand = (i) => {
    if (fl[i] !== E_BAND) return false;
    if (!shortMin2 && !mit.shortReflex) return true;
    const j = i + 1 === k ? 0 : i + 1;
    const dx = px[j] - px[i], dy = py[j] - py[i], d2 = dx * dx + dy * dy;
    if (shortMin2) return d2 >= shortMin2;
    // shortReflex: drop the band only on an edge shorter than w that meets
    // another band edge at a REFLEX vertex -- the one junction no exact fix
    // can take (the bands reach past each other's ends)
    if (d2 >= w * w) return true;
    const h = i === 0 ? k - 1 : i - 1, n = j + 1 === k ? 0 : j + 1;
    const reflexAt = (a, b, c) => (px[b] - px[a]) * (py[c] - py[b]) - (py[b] - py[a]) * (px[c] - px[b]) < 0;
    if (fl[h] === E_BAND && reflexAt(h, i, j)) return false;
    if (fl[j] === E_BAND && reflexAt(i, j, n)) return false;
    return true;
  };
  // Start the walk at a vertex that is NOT the junction of two band edges,
  // so every junction is met with its incoming band already emitted.  (A
  // loop that is one closed run has no such vertex; it keeps option 7's
  // notch at vertex 0 -- one vertex per such loop.)
  // Prefer a vertex whose INCOMING edge is not a band: then no run ends at
  // the walk's first vertex either, and every free end gets its fix.
  // noPinch: a vertex the loop passes through twice is a pinch -- the loop
  // touches itself there, so "the polygon continues across the other edge"
  // is false and the tight-corner fixes below would cut the band's ink on the
  // far side.  Found by bench/bandx.mjs's exactness check (4.12).
  // pk (from Loops.pinch) marks it batch-wide -- two LOOPS of one batch can
  // touch at a vertex too; without pk, fall back to repeats inside the loop.
  let pinch = null;
  if (mit.noPinch && pk) pinch = pk;
  else if (mit.noPinch) {
    pinch = new Uint8Array(k); const seen = new Map();
    for (let q = 0; q < k; q++) { const key = px[q] + ',' + py[q], o = seen.get(key); if (o !== undefined) { pinch[q] = 1; pinch[o] = 1; } else seen.set(key, q); }
  }
  let r = -1;
  for (let q = 0; q < k && r < 0; q++) if (!isBand(q === 0 ? k - 1 : q - 1)) r = q;
  if (r < 0) for (let q = 0; q < k; q++) if (!(isBand(q === 0 ? k - 1 : q - 1) && isBand(q))) { r = q; break; }
  if (r < 0) r = 0;
  for (let st = 0; st < k; st++) {
    const i = (r + st) % k;
    const j = i + 1 === k ? 0 : i + 1;
    const hp = i === 0 ? k - 1 : i - 1;               // previous edge
    const prevBand = isBand(hp), thisBand = isBand(i);
    // vertex i sits between edge hp and edge i
    if (st > 0 && prevBand && thisBand && (mit.spike || mit.reflex || mit.bevel)) {
      // the previous iteration emitted ... a', b'(hp); decide what to do at b
      const ax = px[hp], ay = py[hp], bx = px[i], by = py[i], cx = px[j], cy = py[j];
      const d1x = bx - ax, d1y = by - ay, d2x = cx - bx, d2y = cy - by;
      const l1 = Math.hypot(d1x, d1y) || 1, l2 = Math.hypot(d2x, d2y) || 1;
      const n1x = d1y / l1 * w, n1y = -d1x / l1 * w, n2x = d2y / l2 * w, n2y = -d2x / l2 * w;
      const cr = d1x * d2y - d1y * d2x;
      const e1x = bx + n1x, e1y = by + n1y, e2x = bx + n2x, e2y = by + n2y;
      const gap2 = (e1x - e2x) * (e1x - e2x) + (e1y - e2y) * (e1y - e2y);
      if (mit.spike && gap2 < 1e-8) {
        // collinear: b'ab == b'bc, the out-and-back is zero-area.  Keep b'ab
        // (already emitted), skip b and b'bc -- emit only b'bc's successor.
        const fx = cx + n2x, fy = cy + n2y;
        ox[m] = fx; oy[m] = fy; m++;
        continue;
      }
      // n1.n2 >= 0: the turn is at most 90 degrees.  Only then does the quad
      // (H, b'ab, b, b'bc) that the mitre removes lie inside BOTH band quads,
      // which is what makes it exact.  At a sharper reflex corner (a spike
      // tip) the quad reaches into the polygon and the mitre punches a hole.
      // ...and each quad corner must also lie within the OTHER band's
      // length: an edge shorter than the band reaches past its neighbour's
      // end cap -- the "edge shorter than the expansion" case.
      if (mit.reflex && cr < 0 && (n1x * n2x + n1y * n2y >= 0 || (mit.reflexAny && !(pinch && pinch[i]))) &&
          (n1x * d2x + n1y * d2y) / l2 <= l2 && -(n2x * d1x + n2y * d1y) / l1 <= l1) {
        // offset segments: S1 = [a'(= ox[m-2],oy[m-2]) .. e1], S2 = [e2 .. c']
        const sx0 = ox[m - 2], sy0 = oy[m - 2];
        const tx1 = cx + n2x, ty1 = cy + n2y;
        const hit = segHit(sx0, sy0, e1x, e1y, e2x, e2y, tx1, ty1);
        if (hit) {
          // replace e1 (last emitted) by the crossing; skip b and e2
          ox[m - 1] = HX; oy[m - 1] = HY;
          ox[m] = tx1; oy[m] = ty1; m++;
          continue;
        }
      }
      if (mit.bevel && cr > 0) {
        // skip b: straight from e1 to e2
        ox[m] = e2x; oy[m] = e2y; m++;
        ox[m] = cx + n2x; oy[m] = cy + n2y; m++;
        continue;
      }
    }
    if (mit.endclip && st > 0 && prevBand !== thisBand && !(pinch && pinch[i])) {
      // a FREE END at a reflex vertex: the band's perpendicular end cap
      // crosses the neighbouring (non-band) edge and paints over the face on
      // its far side, which was drawn earlier.  Cut the band at that edge.
      const ax = px[hp], ay = py[hp], bx = px[i], by = py[i], cx = px[j], cy = py[j];
      const d1x = bx - ax, d1y = by - ay, d2x = cx - bx, d2y = cy - by;
      if (d1x * d2y - d1y * d2x < 0) {
        if (prevBand) {
          // emitted ... a', e1 ; the band ends here.  Clip [a', e1] by [b, c].
          if (segHit(ox[m - 2], oy[m - 2], ox[m - 1], oy[m - 1], bx, by, cx, cy)) {
            ox[m - 1] = HX; oy[m - 1] = HY;          // replaces e1; b is skipped
            continue;
          }
        } else {
          // emitted ... p ; the band starts here.  Clip [e2, c'] by [p, b].
          const l = Math.hypot(d2x, d2y) || 1, nx = d2y / l * w, ny = -d2x / l * w;
          if (segHit(bx + nx, by + ny, cx + nx, cy + ny, ax, ay, bx, by)) {
            ox[m] = HX; oy[m] = HY; m++;             // replaces b and e2
            ox[m] = cx + nx; oy[m] = cy + ny; m++;
            continue;
          }
        }
      }
    }
    if (mit.end8 && st > 0 && prevBand && !thisBand && qx) {
      // run ends here: the last emitted point is the band corner b + n1 w
      const hq = hp;
      const cx = along(px[i], py[i], px[hq], py[hq], px[i], py[i], qx[hq], qy[hq], w);
      if (cx) { ox[m - 1] = AX; oy[m - 1] = AY; }
    }
    ox[m] = px[i]; oy[m] = py[i]; m++;
    if (thisBand) {
      const dx = px[j] - px[i], dy = py[j] - py[i];
      const l = Math.hypot(dx, dy) || 1;
      const nx = dy / l * w, ny = -dx / l * w;
      let sx = px[i] + nx, sy = py[i] + ny;
      // run starts here: the first band corner along a -> q instead
      if (mit.end8 && !prevBand && qx && along(px[i], py[i], px[i], py[i], px[j], py[j], qx[i], qy[i], w, true)) { sx = AX; sy = AY; }
      ox[m] = sx; oy[m] = sy; m++;
      ox[m] = px[j] + nx; oy[m] = py[j] + ny; m++;
    }
  }
  return m;
}

let HX = 0, HY = 0, AX = 0, AY = 0;
// The point on the ray from (vx, vy) towards the neighbour's apex (qx, qy)
// that is w from the band edge's line.  The edge runs (e0 -> e1) when the
// run ENDS at v, (v -> e1) when it STARTS there (startRun); either way its
// outward normal is (dy, -dx).  Travel is clamped at the apex itself (a
// neighbour thinner than w), and a degenerate apex falls back to option 7.
function along(vx, vy, e0x, e0y, e1x, e1y, qx, qy, w, startRun) {
  let dx, dy;
  if (startRun) { dx = e1x - vx; dy = e1y - vy; } else { dx = vx - e0x; dy = vy - e0y; }
  const l = Math.hypot(dx, dy); if (!l || qx !== qx) return false;
  const nx = dy / l, ny = -dx / l;
  const dq = (qx - vx) * nx + (qy - vy) * ny;          // apex's distance outward
  if (!(dq > 1e-6)) return false;
  const t = Math.min(1, w / dq);
  AX = vx + t * (qx - vx); AY = vy + t * (qy - vy);
  return true;
}
// Proper intersection of segments P0P1 and Q0Q1; result in HX/HY.
function segHit(p0x, p0y, p1x, p1y, q0x, q0y, q1x, q1y) {
  const rx = p1x - p0x, ry = p1y - p0y, sx = q1x - q0x, sy = q1y - q0y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return false;
  const qpx = q0x - p0x, qpy = q0y - p0y;
  const t = (qpx * sy - qpy * sx) / den, u = (qpx * ry - qpy * rx) / den;
  if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return false;
  HX = p0x + t * rx; HY = p0y + t * ry;
  return true;
}

// 4.3's collinear pass, verbatim from PainterBatcher.emit(), plus exact
// removal of repeated points.  In place; returns the new count.
export function collinear(x, y, k, eps2, tx, ty) {
  let m = 0;
  for (let i = 0; i < k; i++) {
    if (m >= 1) {
      const ax = tx[m - 1], ay = ty[m - 1], j = (i + 1) % k;
      const d1x = x[i] - ax, d1y = y[i] - ay;
      if (d1x * d1x + d1y * d1y < 1e-12) continue;           // repeated point
      const d2x = x[j] - x[i], d2y = y[j] - y[i];
      const cr = d1x * d2y - d1y * d2x;
      const sx = d1x + d2x, sy = d1y + d2y;
      if (eps2 > 0 && cr * cr <= eps2 * (sx * sx + sy * sy) && (d1x * d2x + d1y * d2y) > 0) continue;
    }
    tx[m] = x[i]; ty[m] = y[i]; m++;
  }
  return m;
}

// ===========================================================================
// Emitters.  `ctx` is anything canvas-shaped: a real CanvasRenderingContext2D,
// bench/wgr.mjs's WgrContext, or the census below.
// ===========================================================================
export class Emitter {
  constructor(nt) {
    const cap = nt * 9 + 16;
    this.px = new Float64Array(cap); this.py = new Float64Array(cap);
    this.fl = new Uint8Array(cap);
    this.ox = new Float64Array(cap); this.oy = new Float64Array(cap);
    this.tx = new Float64Array(cap); this.ty = new Float64Array(cap);
    this.qx = new Float64Array(cap); this.qy = new Float64Array(cap); this.pk = new Uint8Array(cap);
    this.fills = 0; this.verts = 0; this.subpaths = 0;
    this.onLoop = null;                  // census hook: (x, y, k, batch) => void
    this.onFill = null;                  // census hook: () => void
  }

  perFace(ctx, s, idx, pal) {
    const { order, colour, sx, sy } = s;
    this.fills = 0; this.verts = 0; this.subpaths = 0;
    for (let i = 0; i < s.nVis; i++) {
      const t = order[i], a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
      ctx.fillStyle = pal[colour[t]];
      ctx.beginPath(); ctx.moveTo(sx[a], sy[a]); ctx.lineTo(sx[b], sy[b]); ctx.lineTo(sx[c], sy[c]);
      if (this.onLoop) { this.tx[0] = sx[a]; this.ty[0] = sy[a]; this.tx[1] = sx[b]; this.ty[1] = sy[b];
                         this.tx[2] = sx[c]; this.ty[2] = sy[c]; this.onLoop(this.tx, this.ty, 3, i); }
      ctx.fill(); if (this.onFill) this.onFill();
      this.fills++; this.subpaths++; this.verts += 3;
    }
  }

  // One fill per triangle, with the seam repaired per triangle, the two ways
  // a per-face renderer can: an in-line band on every edge whose neighbour is
  // visible and drawn LATER (4.8 at face granularity), or C3's fill + stroke.
  perFaceBand(ctx, s, idx, adj, pal, w, mit, rank) {
    const { order, colour, sx, sy, nVis } = s, { px, py, fl, ox, oy, tx, ty } = this;
    for (let i = 0; i < nVis; i++) rank[order[i]] = i + 1;          // 0 = not visible
    this.fills = 0; this.verts = 0; this.subpaths = 0;
    for (let i = 0; i < nVis; i++) {
      const t = order[i];
      for (let e = 0; e < 3; e++) {
        const v = idx[3 * t + e], n = adj[3 * t + e];
        px[e] = sx[v]; py[e] = sy[v];
        fl[e] = n >= 0 && rank[n] > i + 1 ? E_BAND : (n >= 0 && rank[n] ? E_SEAM_EARLY : E_SILHOUETTE);
      }
      const m = collinear(ox, oy, bandLoop(px, py, fl, 3, w, mit, ox, oy), 0.0025, tx, ty);
      ctx.fillStyle = pal[colour[t]];
      ctx.beginPath(); ctx.moveTo(tx[0], ty[0]);
      for (let q = 1; q < m; q++) ctx.lineTo(tx[q], ty[q]);
      if (this.onLoop) this.onLoop(tx, ty, m, i);
      ctx.fill(); if (this.onFill) this.onFill();
      this.fills++; this.subpaths++; this.verts += m;
    }
    for (let i = 0; i < nVis; i++) rank[order[i]] = 0;
  }
  perFaceStroke(ctx, s, idx, pal, lw = 0.5) {
    const { order, colour, sx, sy } = s;
    this.fills = 0; this.verts = 0; this.subpaths = 0;
    ctx.lineWidth = lw;
    for (let i = 0; i < s.nVis; i++) {
      const t = order[i], a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
      const col = pal[colour[t]];
      ctx.fillStyle = col; ctx.strokeStyle = col;
      ctx.beginPath(); ctx.moveTo(sx[a], sy[a]); ctx.lineTo(sx[b], sy[b]); ctx.lineTo(sx[c], sy[c]);
      ctx.lineTo(sx[a], sy[a]);
      ctx.fill(); ctx.stroke();
      this.fills += 2; this.subpaths += 2; this.verts += 8;
    }
  }

  noCancel(ctx, B, s, idx, pal, verbCap = 4000) {
    const { sx, sy } = s;
    this.fills = 0; this.verts = 0; this.subpaths = 0;
    for (let b = 0; b < B.batchCount; b++) {
      ctx.fillStyle = pal[B.bColour[b]];
      ctx.beginPath();
      let verbs = 0;
      for (let t = B.bHead[b]; t >= 0; t = B.bNext[t]) {
        const a = idx[3 * t], q = idx[3 * t + 1], c = idx[3 * t + 2];
        ctx.moveTo(sx[a], sy[a]); ctx.lineTo(sx[q], sy[q]); ctx.lineTo(sx[c], sy[c]);
        if (this.onLoop) { this.tx[0] = sx[a]; this.ty[0] = sy[a]; this.tx[1] = sx[q]; this.ty[1] = sy[q];
                           this.tx[2] = sx[c]; this.ty[2] = sy[c]; this.onLoop(this.tx, this.ty, 3, b); }
        this.subpaths++; this.verts += 3; verbs += 4;
        if (verbCap && verbs >= verbCap) { ctx.fill(); this.fills++; if (this.onFill) this.onFill(); ctx.beginPath(); verbs = 0; }
      }
      if (verbs) { ctx.fill(); this.fills++; if (this.onFill) this.onFill(); }
    }
  }

  // boundary (w = 0) or banded boundary.  `mit` as bandLoop().
  // splitConvex: a loop that is convex gets a fill() of its own (after the
  // batch's other loops -- same colour, so the order cannot matter), which is
  // the only way a boundary loop reaches Skia's convex tier or Ganesh's
  // AAConvex op: a multi-subpath path is never convex.
  loops(ctx, L, s, pal, colourOfBatch, w = 0, mit = {}, eps = 0.05, verbCap = 4000, splitConvex = false) {
    this.fills = 0; this.verts = 0; this.subpaths = 0;
    for (let b = 0, l = 0; l < L.nLoops; b++) {
      const l0 = L.batchLoop0[b], l1 = L.batchLoop0[b + 1];
      l = l1;
      if (l1 === l0) continue;
      ctx.fillStyle = pal[colourOfBatch[b]];
      // pass 1: every loop (or, with splitConvex, every NON-convex loop) into one path
      let verbs = 0;
      ctx.beginPath();
      for (let q = l0; q < l1; q++) {
        const m = this.build(L, q, s, w, mit, eps);
        if (m < 3 || (splitConvex && isConvex(this.tx, this.ty, m))) continue;
        verbs += this.put(ctx, m, b);
        if (verbCap && verbs >= verbCap) { this.flush(ctx); ctx.beginPath(); verbs = 0; }
      }
      if (verbs) this.flush(ctx);
      if (!splitConvex) continue;
      // pass 2: each convex loop on its own
      for (let q = l0; q < l1; q++) {
        const m = this.build(L, q, s, w, mit, eps);
        if (m < 3 || !isConvex(this.tx, this.ty, m)) continue;
        ctx.beginPath(); this.put(ctx, m, b); this.flush(ctx);
      }
    }
  }
  build(L, q, s, w, mit, eps) {
    const { sx, sy } = s, { px, py, fl, ox, oy, tx, ty, qx, qy, pk } = this;
    const s0 = L.start[q], k = L.len[q];
    for (let i = 0; i < k; i++) {
      const v = L.vid[s0 + i], a = L.apex[s0 + i];
      px[i] = sx[v]; py[i] = sy[v]; fl[i] = L.flag[s0 + i]; pk[i] = L.pinch[s0 + i];
      qx[i] = a >= 0 ? sx[a] : NaN; qy[i] = a >= 0 ? sy[a] : NaN;
    }
    if (w > 0) return collinear(ox, oy, bandLoop(px, py, fl, k, w, mit, ox, oy, qx, qy, pk), eps * eps, tx, ty);
    return collinear(px, py, k, eps * eps, tx, ty);
  }
  put(ctx, m, b) {
    const { tx, ty } = this;
    ctx.moveTo(tx[0], ty[0]);
    for (let i = 1; i < m; i++) ctx.lineTo(tx[i], ty[i]);
    if (this.onLoop) this.onLoop(tx, ty, m, b);
    this.subpaths++; this.verts += m;
    return m + 1;
  }
  flush(ctx) { ctx.fill(); this.fills++; if (this.onFill) this.onFill(); }
}

// Convex and simple: every turn the same sign and the turns add to one full
// revolution (a star polygon has same-sign turns and winds twice).
export function isConvex(x, y, k) {
  let sgn = 0, sum = 0;
  for (let i = 0; i < k; i++) {
    const j = (i + 1) % k, h = (i + 2) % k;
    const ax = x[j] - x[i], ay = y[j] - y[i], bx = x[h] - x[j], by = y[h] - y[j];
    const c = ax * by - ay * bx;
    if (c > 1e-9) { if (sgn < 0) return false; sgn = 1; } else if (c < -1e-9) { if (sgn > 0) return false; sgn = -1; }
    sum += Math.atan2(c, ax * bx + ay * by);
  }
  return Math.abs(Math.abs(sum) - 2 * Math.PI) < 1e-3;
}

// ===========================================================================
// The strategies, by name -- shared by bench/tess.mjs and bench/tesspage.html.
// ===========================================================================
export const BAND_W = 1;
export const STRATS = [
  ['perFace', 'one fill per triangle, no seam repair'],
  ['perFace+band', 'one fill per triangle, in-line band (4.8, face granularity)'],
  ['perFace+stroke', 'C3: one fill + one stroke per triangle, lineWidth 0.5'],
  ['noCancel', 'batches, triangles as subpaths'],
  ['boundary', 'batches, boundary loops (C1 fill pass)'],
  ['boundary+loc128', 'boundary, batch key includes a 128 px macro-tile'],
  ['boundary+loc32', 'boundary, batch key includes a 32 px macro-tile'],
  ['boundary+cvxSplit', 'boundary, each convex loop its own fill'],
  ['noSelfOverlap', 'boundary, batches that never overlap themselves'],
  ['band', 'boundary + in-line band, option 7, w=1'],
  ['band+spike', '+ drop collinear out-and-backs (exact)'],
  ['band+spike+reflex', '+ mitre reflex junctions <= 90 deg (exact)'],
  ['band+all+bevel', '+ bevel convex junctions (lossy)'],
  ['band+all+short1', 'spike+reflex, no band on edges < 1 px (lossy)'],
  ['band+exact+endclip', 'spike+reflex, + clip a single band at a tight corner, unguarded'],
  ['band+exact+end8', 'spike+reflex, free-end corners on the neighbour edge (lossy)'],
  ['band+exact2', 'every exact fix: spike, reflex <= 90, single-band clip (pinch-guarded)'],
  ['band+exact2+end8', 'exact2 + free ends: src/painter2d.js seamBand: 1 (BAND_DEFAULT)'],
  ['band+exact2+end8+tight', '+ the mitre past 90 deg too (BAND_TIGHT: changes slivers)'],
  ['band+exact2+end8+shortReflex', '+ no band on a sub-w edge at a reflex junction (BAND_SKIP_SHORT, lossy)'],
  ['shipped', 'C1: boundary fill + seam-only stroke, lineWidth 0.5']
];
export const MIT = {
  band: {}, 'band+spike': { spike: true }, 'band+spike+reflex': { spike: true, reflex: true },
  'band+all+bevel': { spike: true, reflex: true, bevel: true },
  'band+all+short1': { spike: true, reflex: true, shortMin: 1 },
  'band+exact+endclip': { spike: true, reflex: true, endclip: true },
  'band+exact+end8': { spike: true, reflex: true, end8: true },
  // the tight-corner candidates (4.12): a mitre at ANY reflex turn, keeping
  // only the containment test; the single-band clip (endclip) with the exact
  // pair; and dropping the band on a sub-w edge at a reflex band junction
  'band+spike+reflexAny': { spike: true, reflex: true, reflexAny: true },
  'band+exact+shortReflex': { spike: true, reflex: true, shortReflex: true },
  'band+spike+reflexAny+noPinch': { spike: true, reflex: true, reflexAny: true, noPinch: true },
  'band+exact+endclip+noPinch': { spike: true, reflex: true, endclip: true, noPinch: true },
  // exact2 = every exact fix (spike, reflex <= 90, single-band clip with the
  // pinch guard): src/painter2d.js's BAND_EXACT since guide v1.51
  'band+exact2': { spike: true, reflex: true, endclip: true, noPinch: true },
  'band+exact2+end8': { spike: true, reflex: true, endclip: true, noPinch: true, end8: true },
  'band+exact2+end8+shortReflex': { spike: true, reflex: true, endclip: true, noPinch: true, end8: true, shortReflex: true },
  'band+exact2+end8+tight': { spike: true, reflex: true, endclip: true, noPinch: true, end8: true, reflexAny: true }
};

// X = { mesh, scene, s, B, Bloc: {32: batcher, 128: batcher}, L, E }
export function makeX(PainterBatcher, mesh, scene, s, W, H) {
  const mkB = (loc) => new PainterBatcher({ width: W, height: H, triangleCount: mesh.nt,
    vertexCount: mesh.nv, indices: mesh.idx, adjacency: mesh.adj, palette: scene.pal,
    strokeSeams: false, localityTile: loc });
  // C1 is the STROKE configuration: seamBand pinned to 0, since the shipped
  // default became the band in guide v1.30 (T69)
  const shipped = new PainterBatcher({ width: W, height: H, triangleCount: mesh.nt,
    vertexCount: mesh.nv, indices: mesh.idx, adjacency: mesh.adj, palette: scene.pal, seamBand: 0 });
  return { mesh, scene, s, B: mkB(0), Bloc: { 32: mkB(32), 128: mkB(128) }, shipped,
           rank: new Int32Array(mesh.nt),
           L: new Loops(mesh.nt, mesh.nv), E: new Emitter(mesh.nt), frame: 0 };
}

export function runStrategy(name, X, ctx) {
  const { mesh, scene, s, L, E } = X;
  if (name === 'perFace') { E.perFace(ctx, s, mesh.idx, scene.pal); return; }
  if (name === 'perFace+band') { E.perFaceBand(ctx, s, mesh.idx, mesh.adj, scene.pal, BAND_W, MIT['band+spike+reflex'], X.rank); return; }
  if (name === 'perFace+stroke') { E.perFaceStroke(ctx, s, mesh.idx, scene.pal); return; }
  if (name === 'shipped') {
    // the guide's C1, unchanged: src/painter2d.js draw() with its defaults
    X.shipped.draw(ctx, s);
    E.fills = X.shipped.fills + X.shipped.strokes; E.verts = X.shipped.verts; E.subpaths = X.shipped.subpaths;
    return;
  }
  const B = name === 'boundary+loc128' ? X.Bloc[128] : name === 'boundary+loc32' ? X.Bloc[32] : X.B;
  if (name === 'noSelfOverlap') batchNoSelfOverlap(B, s); else B.batch(s);
  if (name === 'noCancel') { E.noCancel(ctx, B, s, mesh.idx, scene.pal); return; }
  L.extract(B, mesh.idx, mesh.adj);
  if (MIT[name]) E.loops(ctx, L, s, scene.pal, B.bColour, BAND_W, MIT[name]);
  else E.loops(ctx, L, s, scene.pal, B.bColour, 0, {}, 0.05, 4000, name === 'boundary+cvxSplit');
}

// ===========================================================================
// Census: per-loop geometry that decides which rasteriser path a fill takes.
// ===========================================================================
// Skia's CPU scan converter (Chromium software raster, demoted Firefox) has
// three tiers, from SkScan_AAAPath.cpp:
//   mask     bbox <= 32 px wide and align4(w) * h <= 1024 -- any shape
//   convex   isKnownToBeConvex(): ONE contour, convex -- aaa_walk_convex_edges
//   general  everything else -- aaa_walk_edges + SafeRLEAdditiveBlitter
// A multi-subpath path is never convex, however convex each subpath is.
export class Census {
  constructor() { this.reset(); this.cell = 8; this.grid = new Map(); }
  reset() {
    this.loops = 0; this.convexLoops = 0; this.crossLoops = 0; this.crossings = 0;
    this.fills = 0; this.tierMask = 0; this.tierConvex = 0; this.tierGeneral = 0;
    this.edges = 0; this.shortEdges = 0;  // edges shorter than 1 px
    this._fillLoops = 0; this._fillConvex = false;
    this._bx0 = Infinity; this._by0 = Infinity; this._bx1 = -Infinity; this._by1 = -Infinity;
  }
  hookInto(em) {
    em.onLoop = (x, y, k) => this.loop(x, y, k);
    em.onFill = () => this.fill();
  }
  loop(x, y, k) {
    this.loops++; this.edges += k;
    let pos = 0, neg = 0;
    for (let i = 0; i < k; i++) {
      const j = (i + 1) % k, h = (i + 2) % k;
      const d1x = x[j] - x[i], d1y = y[j] - y[i], d2x = x[h] - x[j], d2y = y[h] - y[j];
      const c = d1x * d2y - d1y * d2x;
      if (c > 1e-9) pos++; else if (c < -1e-9) neg++;
      if (d1x * d1x + d1y * d1y < 1) this.shortEdges++;
      if (x[i] < this._bx0) this._bx0 = x[i]; if (x[i] > this._bx1) this._bx1 = x[i];
      if (y[i] < this._by0) this._by0 = y[i]; if (y[i] > this._by1) this._by1 = y[i];
    }
    const nc = k > 3 ? this.selfCrossings(x, y, k) : 0;
    if (nc) { this.crossLoops++; this.crossings += nc; }
    const convex = nc === 0 && (pos === 0 || neg === 0);
    if (convex) this.convexLoops++;
    this._fillLoops++; this._fillConvex = convex;
  }
  fill() {
    this.fills++;
    const w = Math.ceil(this._bx1) - Math.floor(this._bx0), h = Math.ceil(this._by1) - Math.floor(this._by0);
    if (w <= 32 && ((w + 3) & ~3) * h <= 1024) this.tierMask++;
    else if (this._fillLoops === 1 && this._fillConvex) this.tierConvex++;
    else this.tierGeneral++;
    this._fillLoops = 0; this._fillConvex = false;
    this._bx0 = Infinity; this._by0 = Infinity; this._bx1 = -Infinity; this._by1 = -Infinity;
  }
  // proper crossings between non-adjacent edges of one loop, via a hash grid
  selfCrossings(x, y, k) {
    const g = this.grid; g.clear();
    const cs = this.cell;
    for (let i = 0; i < k; i++) {
      const j = (i + 1) % k;
      const x0 = Math.floor(Math.min(x[i], x[j]) / cs), x1 = Math.floor(Math.max(x[i], x[j]) / cs);
      const y0 = Math.floor(Math.min(y[i], y[j]) / cs), y1 = Math.floor(Math.max(y[i], y[j]) / cs);
      for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
        const key = gy * 100003 + gx;
        let a = g.get(key); if (!a) { a = []; g.set(key, a); } a.push(i);
      }
    }
    const seen = new Set();
    let n = 0;
    for (const a of g.values()) {
      for (let p = 0; p < a.length; p++) for (let q = p + 1; q < a.length; q++) {
        let e = a[p], f = a[q]; if (e > f) { const t = e; e = f; f = t; }
        if (f === e + 1 || (e === 0 && f === k - 1)) continue;      // adjacent
        const key = e * k + f; if (seen.has(key)) continue; seen.add(key);
        const e2 = (e + 1) % k, f2 = (f + 1) % k;
        if (segHit(x[e], y[e], x[e2], y[e2], x[f], y[f], x[f2], y[f2])) n++;
      }
    }
    return n;
  }
}

// ===========================================================================
// Non-overlapping batches: PainterBatcher's walk with one extra rule -- a
// face may not join a batch whose own faces already claim one of its tiles.
// The shipped batcher allows it (two same-coloured faces on different sheets
// may share a batch, since order among equal colours is irrelevant), which
// puts overlapping, same-winding subpaths into one path.
// Returns the number of batches; B's batch arrays are rewritten in place.
// ===========================================================================
export function batchNoSelfOverlap(B, s) {
  // reuse B's own first pass for tile choice and scratch, then redo the walk
  B.batch(s);
  const n = s.nVis, order = s.order, colour = s.colour, idx = B.indices;
  const { sx, sy, bx0, by0, bx1, by1 } = s;
  const { batchOf, bNext, bHead, bTail, bColour, bVerbs, stamp, covered: cov } = B;
  const tw = B.tw, th = B.th, sh = B.tileShift, ts = B.tile, half = ts * 0.5;
  const open = B.openByColour;
  if (!B._strict || B._strict.length < cov.length) B._strict = new Uint8Array(cov.length);
  // sstamp: like stamp, but written only by STRICT claims -- a tile centre
  // strictly inside the face.  Epoch-tagged like stamp, so it is reset with it.
  if (!B._sstamp || B._sstamp.length < stamp.length) B._sstamp = new Int32Array(stamp.length);
  const strict = B._strict, sstamp = B._sstamp;
  let base = B.epoch + 1;
  if (base > 0x7ff00000 - (batchOf.length + 2)) { stamp.fill(0); sstamp.fill(0); base = 1; }
  B.epoch = base + batchOf.length + 1;
  B.tagBase = base;
  open.fill(-1);
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const t = order[i], c = colour[t];
    let tx0 = bx0[t] >> sh, ty0 = by0[t] >> sh, tx1 = bx1[t] >> sh, ty1 = by1[t] >> sh;
    if (tx0 < 0) tx0 = 0; if (ty0 < 0) ty0 = 0;
    if (tx1 >= tw) tx1 = tw - 1; if (ty1 >= th) ty1 = th - 1;
    if (tx1 < tx0 || ty1 < ty0) continue;
    let maxOrd = base, nc = 0;
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
      for (let x = tx0; x <= tx1; x++) {
        if (f0 >= 0 && f1 >= 0 && f2 >= 0) {
          const p = y * tw + x; strict[nc] = f0 > 0 && f1 > 0 && f2 > 0 ? 1 : 0; cov[nc++] = p;
          const v = stamp[p]; if (v > maxOrd) maxOrd = v;
        }
        f0 += dx0; f1 += dx1; f2 += dx2;
      }
      r0 += dy0; r1 += dy1; r2 += dy2;
    }
    if (nc === 0) {
      let fx = ((ax + bxv + cxv) * 0.3333333) >> sh, fy = ((ay + byv + cyv) * 0.3333333) >> sh;
      if (fx < 0) fx = 0; else if (fx >= tw) fx = tw - 1;
      if (fy < 0) fy = 0; else if (fy >= th) fy = th - 1;
      const p = fy * tw + fx; strict[nc] = 0; cov[nc++] = p; const v = stamp[p]; if (v > maxOrd) maxOrd = v;
    }
    let bb = open[c];
    // the one new rule: maxOrd === own ordinal means a face of THIS batch
    // already claims a tile this face covers -- a self-overlap
    // The self-overlap test counts only tile centres STRICTLY inside both
    // faces: a centre exactly on a shared edge belongs to both neighbours, and
    // a sub-tile face's centroid tile is a stand-in, not a coverage claim.
    let self = false;
    if (bb >= 0 && (base + bb + 1) === maxOrd)
      for (let k = 0; k < nc; k++) if (strict[k] && sstamp[cov[k]] === base + bb + 1) { self = true; break; }
    if (bb < 0 || (base + bb + 1) < maxOrd || self) {
      bb = nb++;
      bColour[bb] = c; bHead[bb] = t; bTail[bb] = t; bNext[t] = -1; bVerbs[bb] = 1; open[c] = bb;
    } else {
      bNext[bTail[bb]] = t; bTail[bb] = t; bNext[t] = -1; bVerbs[bb]++;
    }
    batchOf[t] = base + bb;
    const ord = base + bb + 1;
    for (let k = 0; k < nc; k++) { stamp[cov[k]] = ord; if (strict[k]) sstamp[cov[k]] = ord; }
  }
  B.batchCount = nb;
  return nb;
}

// ===========================================================================
// The field report's load (T68): N separate triangle fills
// ===========================================================================
// 'scatter': random position and orientation, edge L px.  'mesh': a square
// grid of L px cells, two triangles each, sharing the diagonal, every cell at
// the same sub-pixel phase -- so a mesh load has exactly two distinct shapes.
// Returns a Float32Array of 6 floats per triangle.  Deterministic in `seed`.
export function fieldLoad(kind, L, N, seed, W = 1280, H = 720) {
  const T = new Float32Array(N * 6);
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  if (kind === 'scatter') {
    for (let i = 0; i < N; i++) {
      const x0 = 20 + rnd() * (W - 40), y0 = 20 + rnd() * (H - 40), a = rnd() * Math.PI * 2;
      for (let v = 0; v < 3; v++) {
        const b = a + v * 2 * Math.PI / 3, rr = L / Math.sqrt(3);
        T[i * 6 + 2 * v] = x0 + rr * Math.cos(b); T[i * 6 + 2 * v + 1] = y0 + rr * Math.sin(b);
      }
    }
  } else {
    const n = Math.ceil(Math.sqrt(N / 2)), ox = (W - n * L) / 2, oy = Math.max(4, (H - n * L) / 2);
    let i = 0;
    for (let y = 0; y < n && i < N; y++) for (let x = 0; x < n && i < N; x++) {
      const x0 = ox + x * L + 0.13, y0 = oy + y * L + 0.29, x1 = x0 + L, y1 = y0 + L;
      T.set([x0, y0, x1, y0, x1, y1], 6 * i++); if (i < N) T.set([x0, y0, x1, y1, x0, y1], 6 * i++);
    }
  }
  return T;
}
// ... and its three motions, frame f: 'still'; 'moved' -- every triangle
// shifted by the same fresh fraction of a pixel (a new position, the same
// cache key); 'turned' -- every triangle rotated about its centroid by a
// fresh angle (a new shape).  Writes into `out` (same length as T).
export function fieldMotion(T, mode, f, out) {
  const N = T.length / 6;
  if (mode === 'still') { out.set(T); return out; }
  if (mode === 'moved') {
    const dx = ((f + 1) * 0.6180339) % 1;
    for (let k = 0; k < T.length; k += 2) { out[k] = T[k] + dx; out[k + 1] = T[k + 1]; }
    return out;
  }
  for (let i = 0; i < N; i++) {
    const o = 6 * i, cx = (T[o] + T[o + 2] + T[o + 4]) / 3, cy = (T[o + 1] + T[o + 3] + T[o + 5]) / 3;
    const a = (((f + 1) * 0.6180339 + i * 0.7548777) % 1) * 6.2831853, ca = Math.cos(a), sa = Math.sin(a);
    for (let v = 0; v < 3; v++) {
      const ux = T[o + 2 * v] - cx, uy = T[o + 2 * v + 1] - cy;
      out[o + 2 * v] = cx + ca * ux - sa * uy; out[o + 2 * v + 1] = cy + sa * ux + ca * uy;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Test shapes shared by bench/tesspage.html and bench/tessfigs.mjs, so a
// figure draws exactly the geometry the timings were taken on.
// S17 -- one path, the Skia tier by shape (tesspage parts S and G):
export function tierShapes() {
  const cx = 640, cy = 360, n = 48, R = 90;
  const conv = [], conc = [], cross = [];
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2;
    conv.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
    const r2 = i % 2 ? R * 0.55 : R * 1.1;
    conc.push([cx + r2 * Math.cos(a), cy + r2 * Math.sin(a)]);
    const a3 = (i * 17 % n) / n * Math.PI * 2;                  // star polygon {48/17}
    cross.push([cx + R * Math.cos(a3), cy + R * Math.sin(a3)]);
  }
  const sub = [];                                                // 16 disjoint hexagons
  for (let k = 0; k < 16; k++) {
    const ox = 400 + (k % 4) * 130, oy = 200 + ((k / 4) | 0) * 100, h = [];
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; h.push([ox + 22 * Math.cos(a), oy + 22 * Math.sin(a)]); }
    sub.push(h);
  }
  return { convex: [conv], concave: [conc], crossing: [cross], subpaths: sub };
}

// S18 -- merge or split (tesspage part O): [name, shapes, also as separate
// fills?, the layout whose one-path image this one must equal]
export function mergeLayouts() {
  const hex = (cx, cy, r) => { const h = []; for (let i = 0; i < 6; i++) { const a = -i / 6 * Math.PI * 2; h.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } return h; };
  const sq = (x, y, s) => [[x, y], [x, y + s], [x + s, y + s], [x + s, y]];
  const rect = (x, y, w, h) => [[x, y], [x, y + h], [x + w, y + h], [x + w, y]];
  const grid = (d, f, dy = d) => { const o = []; for (let k = 0; k < 16; k++) o.push(f(640 + ((k % 4) - 1.5) * d, 360 + (((k / 4) | 0) - 1.5) * dy)); return o; };
  const tri = (cx, cy, r, a) => [0, 1, 2].map(i => [cx + r * Math.cos(a + i * 2.0944), cy + r * Math.sin(a + i * 2.0944)]);
  // [name, shapes, also as separate fills?, the layout whose one-path image this one must equal]
  return [
    ['disjoint hexagons', grid(60, (x, y) => hex(x, y, 22)), true],
    // the same 16, spread over the canvas: one path's bbox is the whole screen
    ['disjoint hexagons, spread', grid(300, (x, y) => hex(x, y, 22), 170), true],
    // 16 small triangles scattered: each fill alone is in Skia's mask tier
    ['16 small triangles (r 4), spread', grid(300, (x, y) => tri(x + 0.37, y + 0.37, 4, x * 0.01), 170), true],
    // off the pixel grid by 0.37 px, so every shared edge is antialiased on both
    // sides -- on whole pixels a shared edge has no AA and no seam to show
    ['touching squares, edges left in', grid(30, (x, y) => sq(x - 14.63, y - 14.63, 30)), true],
    ['touching squares, cancelled', [sq(580.37, 300.37, 120)], false, 'touching squares, edges left in'],
    ['hexagons, light overlap', grid(38, (x, y) => hex(x, y, 22)), true],
    ['hexagons, heavy overlap', grid(12, (x, y) => hex(x, y, 22)), true],
    // ONE pair of same-colour polygons that overlap without sharing an edge
    ['two hexagons overlapping (r 60)', [hex(600.37, 360.37, 60), hex(670.37, 380.37, 60)], true],
    ['two rectangles overlapping', [rect(560.37, 300.37, 120, 80), rect(620.37, 340.37, 120, 80)], true],
    // ...and the same pair as its union outline, computed ahead of time
    ['two rectangles, union outline', [[[560.37, 300.37], [560.37, 380.37], [620.37, 380.37], [620.37, 420.37], [740.37, 420.37],
                                       [740.37, 340.37], [680.37, 340.37], [680.37, 300.37]]], false, 'two rectangles overlapping'],
  ];
}
