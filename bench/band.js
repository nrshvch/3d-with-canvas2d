// ---------------------------------------------------------------------------
// band.js -- the fixture that separates the two gap repairs.
//
// The cube (cube.js) has only convex quads, so outsetting an edge and banding
// it with a stroke both work and the choice looks like taste.  A boundary loop
// out of the flat-colour batcher is not a convex quad: it is a long, possibly
// non-convex ring with reflex corners, sharp teeth and near-degenerate
// vertices.  This fixture is that shape, reduced to its essentials and
// textured:
//
//   two charts tiling one rotated, sheared rectangle, split by a SAWTOOTH
//   boundary that carries alternating convex and reflex corners, two very
//   sharp teeth and one sliver.
//
// Both repairs get the same two rules (4.8): treat only edges shared with a
// visible neighbour, and only on the chart drawn FIRST.  The difference is
// what they do with them:
//
//   OUTSET  moves the vertices -- offset the selected edge lines and
//           re-intersect.  Measured here, that still CLOSES the gap on this
//           boundary (0.12 px residual): the interesting failure is not a
//           surviving crack, it is where else the boundary ends up.  A moved
//           vertex is shared with the adjacent edges, so the outline travels
//           too -- 11.4 px of coverage moved and 459 pixels changed more than
//           3 px away from the seam being repaired.  The mitre limit a sharp
//           tooth forces is not free either: clamping at 2x instead of 4x puts
//           0.4 px of gap back.
//   BAND    moves nothing -- lay the selected edges' band on the first-drawn
//           chart, in that chart's own texture.  Inside the chart the band
//           repaints texels that are already there (a no-op); outside it the
//           later chart covers it.  Corner shape never enters the argument, and
//           the measurement agrees: 1.05 px of outline moved, ZERO pixels
//           changed off the seam.  Emit it as quads in one FILL, not as a
//           pattern stroke -- see (3b).
// ---------------------------------------------------------------------------
'use strict';

const BTEX_N = 512, BPAD = 12;
const BAND_TEXTURE = (function () {
  const c = document.createElement('canvas');
  c.width = c.height = BTEX_N;
  const x = c.getContext('2d');
  x.fillStyle = '#0d1117';                 // opaque base FIRST (see cube.js)
  x.fillRect(0, 0, BTEX_N, BTEX_N);
  // a fine checker plus rules: high-frequency content, so a band carrying the
  // WRONG colour cannot hide, and neither can a 1px displacement
  for (let j = 0; j < 32; j++) for (let i = 0; i < 32; i++) {
    x.fillStyle = ((i ^ j) & 1) ? '#3d6ea5' : '#c9d6e3';
    x.fillRect(i * 16, j * 16, 16, 16);
  }
  x.strokeStyle = '#e8462f'; x.lineWidth = 3;
  for (let k = 0; k <= 8; k++) {
    x.beginPath(); x.moveTo(0, k * 64); x.lineTo(BTEX_N, k * 64); x.stroke();
    x.beginPath(); x.moveTo(k * 64, 0); x.lineTo(k * 64, BTEX_N); x.stroke();
  }
  return c;
})();

// --- the sawtooth ----------------------------------------------------------
// pitch list chosen to include the three shapes that break an outset:
// ordinary teeth, two very sharp ones (small pitch against a full-amplitude
// swing) and a sliver (two short pitches back to back).
const TEETH = [46, 46, 46, 10, 46, 46, 6, 6, 46, 46, 14, 46];
const BAMP = 26;
const PLANE = (function () {
  const B = [];                            // shared boundary, plane space
  let v = 0;
  const xm = 300;
  B.push([xm, 0]);
  for (let k = 0; k < TEETH.length; k++) {
    v += TEETH[k];
    B.push([xm + ((k & 1) ? 0 : BAMP), v]);
  }
  v += 40; B.push([xm, v]);                // land back on the mid line
  return { B, xm, PU: 600, PV: v };
})();

// P = left chart, drawn FIRST (farther).  Q = right chart, drawn second.
// Both loops contain the sawtooth exactly, so the charts tile the rectangle
// with no T-junctions: the boundary is genuinely shared, which is what makes
// the seam a seam.
const PLOOP = (function () {
  const p = [[0, 0]];
  for (const b of PLANE.B) p.push([b[0], b[1]]);
  p.push([0, PLANE.PV]);
  return p;
})();
const QLOOP = (function () {
  const q = [[PLANE.PU, 0], [PLANE.PU, PLANE.PV]];
  for (let i = PLANE.B.length - 1; i >= 0; i--) q.push([PLANE.B[i][0], PLANE.B[i][1]]);
  return q;
})();
// edges of P shared with Q: edge i runs PLOOP[i] -> PLOOP[i+1], and
// PLOOP[1 .. B.length] are the sawtooth vertices
const PSHARED = (function () {
  const s = new Int8Array(PLOOP.length);
  for (let i = 1; i <= PLANE.B.length - 1; i++) s[i] = 1;
  return s;
})();

// --- plane -> screen, and plane -> texture --------------------------------
const BW = 1000, BH = 700;
// deliberately anisotropic and sheared, so a stroke width taken in TEXTURE
// space comes out wrong by a different factor in each direction
const BM = (function () {
  const th = 0.21, c = Math.cos(th), s = Math.sin(th);
  const k = [[1.02, 0.19], [0.0, 0.80]];                 // shear + squash
  return [c * k[0][0] - s * k[1][0], s * k[0][0] + c * k[1][0],
          c * k[0][1] - s * k[1][1], s * k[0][1] + c * k[1][1],
          120, 90];
})();
const BUV = [BPAD, BPAD, (BTEX_N - 2 * BPAD) / PLANE.PU, (BTEX_N - 2 * BPAD) / PLANE.PV];

let BSS = 1;                                // supersample factor for references
function bandBuild(ss) { BSS = ss || 1; }

function planeToScreen(u, v, out, o) {
  out[o] = (BM[0] * u + BM[2] * v + BM[4]) * BSS;
  out[o + 1] = (BM[1] * u + BM[3] * v + BM[5]) * BSS;
}
// affine mapping ATLAS pixels -> screen: what setTransform and the pattern need
const BCA = new Float64Array(6);
function bandAffine() {
  const su = BUV[2], sv = BUV[3];
  BCA[0] = BM[0] * BSS / su; BCA[1] = BM[1] * BSS / su;
  BCA[2] = BM[2] * BSS / sv; BCA[3] = BM[3] * BSS / sv;
  BCA[4] = BM[4] * BSS - BCA[0] * BUV[0] - BCA[2] * BUV[1];
  BCA[5] = BM[5] * BSS - BCA[1] * BUV[0] - BCA[3] * BUV[1];
}

function loopScreen(loop, out) {
  for (let i = 0; i < loop.length; i++) planeToScreen(loop[i][0], loop[i][1], out, i * 2);
  return out;
}
function loopUV(loop, out) {
  for (let i = 0; i < loop.length; i++) {
    out[i * 2] = BUV[0] + loop[i][0] * BUV[2];
    out[i * 2 + 1] = BUV[1] + loop[i][1] * BUV[3];
  }
  return out;
}

const PS = new Float64Array(PLOOP.length * 2), QS = new Float64Array(QLOOP.length * 2);
const PU_ = new Float64Array(PLOOP.length * 2), QU_ = new Float64Array(QLOOP.length * 2);
const POUT = new Float64Array(PLOOP.length * 2);
const PUVOUT = new Float64Array(PLOOP.length * 2);
const LX_ = new Float64Array(PLOOP.length), LY_ = new Float64Array(PLOOP.length),
      LC_ = new Float64Array(PLOOP.length);

// --- general-polygon outset: offset selected edge lines, re-intersect ------
// The honest generic implementation, mitre limit included -- without one a
// sharp tooth sends the vertex arbitrarily far.  mitreLimit is in multiples
// of d; pass 0 for no clamp.
function outsetLoop(sx, n, sel, d, mitreLimit, out) {
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area2 += sx[i * 2] * sx[j * 2 + 1] - sx[j * 2] * sx[i * 2 + 1];
  }
  const sgn = area2 > 0 ? 1 : -1;          // so "outward" is unambiguous
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = sx[j * 2] - sx[i * 2], ey = sx[j * 2 + 1] - sx[i * 2 + 1];
    const len = Math.hypot(ex, ey) || 1;
    const nx = sgn * ey / len, ny = -sgn * ex / len;
    LX_[i] = nx; LY_[i] = ny;
    LC_[i] = nx * sx[i * 2] + ny * sx[i * 2 + 1] + (sel[i] ? d : 0);
  }
  for (let i = 0; i < n; i++) {
    const ep = (i + n - 1) % n, ec = i;
    const a1 = LX_[ep], b1 = LY_[ep], c1 = LC_[ep];
    const a2 = LX_[ec], b2 = LY_[ec], c2 = LC_[ec];
    const det = a1 * b2 - a2 * b1;
    let x, y;
    if (Math.abs(det) < 1e-9) {
      const dd = sel[ep] ? d : 0;
      x = sx[i * 2] + a1 * dd; y = sx[i * 2 + 1] + b1 * dd;
    } else {
      x = (c1 * b2 - c2 * b1) / det; y = (a1 * c2 - a2 * c1) / det;
    }
    if (mitreLimit > 0) {
      const dx = x - sx[i * 2], dy = y - sx[i * 2 + 1];
      const L = Math.hypot(dx, dy), cap = mitreLimit * d;
      if (L > cap && L > 0) { x = sx[i * 2] + dx * cap / L; y = sx[i * 2 + 1] + dy * cap / L; }
    }
    out[i * 2] = x; out[i * 2 + 1] = y;
  }
}

function screenToUV(sx, n, out) {
  const a = BCA[0], b = BCA[1], c = BCA[2], d = BCA[3], e = BCA[4], f = BCA[5];
  const det = a * d - b * c, inv = det ? 1 / det : 0;
  for (let i = 0; i < n; i++) {
    const px = sx[i * 2] - e, py = sx[i * 2 + 1] - f;
    out[i * 2] = (px * d - py * c) * inv;
    out[i * 2 + 1] = (py * a - px * b) * inv;
  }
}

let BPAT = null, BSPAT = null;
const BMX = (typeof DOMMatrix !== 'undefined') ? new DOMMatrix() : null;
function bandPattern(ctx) { if (!BPAT) BPAT = ctx.createPattern(BAND_TEXTURE, 'repeat'); return BPAT; }
function bandSeamPattern(ctx) { if (!BSPAT) BSPAT = ctx.createPattern(BAND_TEXTURE, 'repeat'); return BSPAT; }

function pathUV(ctx, uv, n) {
  ctx.beginPath();
  ctx.moveTo(uv[0], uv[1]);
  for (let i = 1; i < n; i++) ctx.lineTo(uv[i * 2], uv[i * 2 + 1]);
  ctx.closePath();
}

// (1) plain: one pattern fill per chart, nothing done about the seam
function bandFillOnly(ctx, st) {
  bandAffine();
  loopUV(PLOOP, PU_); loopUV(QLOOP, QU_);
  ctx.fillStyle = bandPattern(ctx);
  ctx.setTransform(BCA[0], BCA[1], BCA[2], BCA[3], BCA[4], BCA[5]);
  pathUV(ctx, PU_, PLOOP.length); ctx.fill();
  pathUV(ctx, QU_, QLOOP.length); ctx.fill();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (st) { st.ops = 2; st.fills = 2; st.strokes = 0; }
}

// (2) outset the first-drawn chart's shared edges
function bandOutset(ctx, st, d, mitreLimit) {
  bandAffine();
  loopScreen(PLOOP, PS);
  loopUV(QLOOP, QU_);
  outsetLoop(PS, PLOOP.length, PSHARED, d * BSS, mitreLimit, POUT);
  screenToUV(POUT, PLOOP.length, PUVOUT);
  ctx.fillStyle = bandPattern(ctx);
  ctx.setTransform(BCA[0], BCA[1], BCA[2], BCA[3], BCA[4], BCA[5]);
  pathUV(ctx, PUVOUT, PLOOP.length); ctx.fill();
  pathUV(ctx, QU_, QLOOP.length); ctx.fill();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (st) { st.ops = 2; st.fills = 2; st.strokes = 0; }
}

// (3) the band: fill both charts untouched, then stroke P's shared edges in
// SCREEN space with P's own texture carried on the pattern
function bandSeamBand(ctx, st, widthPx, cap, opt) {
  const o = typeof opt === 'string' ? { flat: opt } : (opt || {});
  bandAffine();
  loopScreen(PLOOP, PS);
  loopUV(PLOOP, PU_); loopUV(QLOOP, QU_);
  const pat = bandPattern(ctx);
  ctx.fillStyle = pat;
  ctx.setTransform(BCA[0], BCA[1], BCA[2], BCA[3], BCA[4], BCA[5]);
  pathUV(ctx, PU_, PLOOP.length); ctx.fill();
  const n = PLOOP.length;
  ctx.lineCap = cap || 'butt';
  ctx.lineJoin = 'miter'; ctx.miterLimit = 10;
  let strokes = 0;
  if (o.texSpace) {
    // stay in texture space: the fill's own pattern is already correct there,
    // and the width divides back out by the map's scale -- one number, so an
    // anisotropic map gets it right only on average
    const sc = Math.sqrt(Math.abs(BCA[0] * BCA[3] - BCA[1] * BCA[2])) || 1;
    ctx.lineWidth = widthPx * BSS / sc;
    ctx.strokeStyle = pat;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (!PSHARED[i] || PSHARED[(i + n - 1) % n]) continue;
      ctx.moveTo(PU_[i * 2], PU_[i * 2 + 1]);
      let k = i;
      while (PSHARED[k]) { const j = (k + 1) % n; ctx.lineTo(PU_[j * 2], PU_[j * 2 + 1]); k = j; }
      strokes = 1;
    }
    if (strokes) ctx.stroke();
  } else {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = widthPx * BSS;
    if (o.flat) ctx.strokeStyle = o.flat;
    else {
      const sp = bandSeamPattern(ctx);
      if (BMX && CanvasPattern.prototype.setTransform) {
        BMX.a = BCA[0]; BMX.b = BCA[1]; BMX.c = BCA[2];
        BMX.d = BCA[3]; BMX.e = BCA[4]; BMX.f = BCA[5];
        sp.setTransform(BMX);
      }
      ctx.strokeStyle = sp;
    }
    const t = o.trim ? widthPx * BSS * 0.5 : 0;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (!PSHARED[i] || PSHARED[(i + n - 1) % n]) continue;   // run start
      let last = i;
      while (PSHARED[last]) last = (last + 1) % n;              // one past the run
      let x0 = PS[i * 2], y0 = PS[i * 2 + 1];
      let xe = PS[last * 2], ye = PS[last * 2 + 1];
      if (t) {
        const i1 = (i + 1) % n, lp = (last + n - 1) % n;
        let dx = PS[i1 * 2] - x0, dy = PS[i1 * 2 + 1] - y0, L = Math.hypot(dx, dy) || 1;
        x0 += dx / L * t; y0 += dy / L * t;
        dx = xe - PS[lp * 2]; dy = ye - PS[lp * 2 + 1]; L = Math.hypot(dx, dy) || 1;
        xe -= dx / L * t; ye -= dy / L * t;
      }
      ctx.moveTo(x0, y0);
      for (let k = (i + 1) % n; k !== last; k = (k + 1) % n) ctx.lineTo(PS[k * 2], PS[k * 2 + 1]);
      ctx.lineTo(xe, ye);
      strokes = 1;
    }
    if (strokes) ctx.stroke();
  }
  // Q last, so the band's outer half is covered exactly as an outset ring is
  ctx.setTransform(BCA[0], BCA[1], BCA[2], BCA[3], BCA[4], BCA[5]);
  pathUV(ctx, QU_, QLOOP.length); ctx.fill();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = 1; ctx.lineCap = 'butt';
  if (st) { st.ops = 2 + strokes; st.fills = 2; st.strokes = strokes; }
}

// (3b) the same band, as a FILL: one quad per seam edge, all wound the same
// way, all subpaths of ONE path, one pattern fill in texture space.  A
// pattern fill is the fast recipe of 4.7; a pattern STROKE is not (Gecko
// cannot accelerate it at all).  Overlap around each shared vertex does what
// the stroke's mitre join did, so the corner shape still never enters.
const QB2 = new Float64Array(8);
function bandPointUV(x, y, out, o) {
  const a = BCA[0], b = BCA[1], c = BCA[2], d = BCA[3];
  const det = a * d - b * c, inv = det ? 1 / det : 0;
  const px = x - BCA[4], py = y - BCA[5];
  out[o] = (px * d - py * c) * inv;
  out[o + 1] = (py * a - px * b) * inv;
}
function bandQuadBand(ctx, st, widthPx, mode, trim) {
  const outward = mode === 'outward';
  bandAffine();
  loopScreen(PLOOP, PS);
  loopUV(PLOOP, PU_); loopUV(QLOOP, QU_);
  const n = PLOOP.length;
  ctx.fillStyle = bandPattern(ctx);
  ctx.setTransform(BCA[0], BCA[1], BCA[2], BCA[3], BCA[4], BCA[5]);
  pathUV(ctx, PU_, n); ctx.fill();
  // winding sign of the loop, so the normal points out of P
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area2 += PS[i * 2] * PS[j * 2 + 1] - PS[j * 2] * PS[i * 2 + 1];
  }
  const sgn = area2 > 0 ? 1 : -1;
  const w = widthPx * BSS;
  const wIn = outward ? 0 : w * 0.5, wOut = outward ? w : w * 0.5;
  ctx.beginPath();
  let nq = 0;
  for (let i = 0; i < n; i++) {
    if (!PSHARED[i]) continue;
    const j = (i + 1) % n;
    const ax = PS[i * 2], ay = PS[i * 2 + 1], bx = PS[j * 2], by = PS[j * 2 + 1];
    const ex = bx - ax, ey = by - ay, L = Math.hypot(ex, ey) || 1;
    const nx = sgn * ey / L, ny = -sgn * ex / L;
    let tax = ax, tay = ay, tbx = bx, tby = by;
    if (trim) {                      // see the note in cube.js
      const ux = ex / L, uy = ey / L, t = w * 0.5;
      if (!PSHARED[(i + n - 1) % n]) { tax += ux * t; tay += uy * t; }
      if (!PSHARED[j]) { tbx -= ux * t; tby -= uy * t; }
    }
    bandPointUV(tax + nx * wOut, tay + ny * wOut, QB2, 0);
    bandPointUV(tbx + nx * wOut, tby + ny * wOut, QB2, 2);
    bandPointUV(tbx - nx * wIn, tby - ny * wIn, QB2, 4);
    bandPointUV(tax - nx * wIn, tay - ny * wIn, QB2, 6);
    ctx.moveTo(QB2[0], QB2[1]);
    ctx.lineTo(QB2[2], QB2[3]);
    ctx.lineTo(QB2[4], QB2[5]);
    ctx.lineTo(QB2[6], QB2[7]);
    ctx.closePath();
    nq++;
  }
  if (nq) ctx.fill();
  pathUV(ctx, QU_, QLOOP.length); ctx.fill();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (st) { st.ops = nq ? 3 : 2; st.fills = nq ? 3 : 2; st.strokes = 0; }
}

// (4) the 4.4 repair for comparison: stroke the WHOLE boundary of every chart
// in its own texture, right after its fill.  Note the lineWidth: the context
// is in texture space here, so the width has to be divided back out by the
// map's scale -- and the map is anisotropic, so no single divisor is right.
function bandFullStroke(ctx, st, widthPx) {
  bandAffine();
  loopUV(PLOOP, PU_); loopUV(QLOOP, QU_);
  const pat = bandPattern(ctx);
  ctx.fillStyle = pat; ctx.strokeStyle = pat;
  ctx.setTransform(BCA[0], BCA[1], BCA[2], BCA[3], BCA[4], BCA[5]);
  const sc = Math.sqrt(Math.abs(BCA[0] * BCA[3] - BCA[1] * BCA[2])) || 1;
  ctx.lineWidth = widthPx * BSS / sc;
  pathUV(ctx, PU_, PLOOP.length); ctx.fill(); ctx.stroke();
  pathUV(ctx, QU_, QLOOP.length); ctx.fill(); ctx.stroke();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = 1;
  if (st) { st.ops = 4; st.fills = 2; st.strokes = 2; }
}

// the exact silhouette: both charts as subpaths of ONE path, one fill, so
// there is no internal seam anywhere and this is the true union coverage
function bandUnion(ctx) {
  bandAffine();
  loopScreen(PLOOP, PS); loopScreen(QLOOP, QS);
  ctx.beginPath();
  ctx.moveTo(PS[0], PS[1]);
  for (let i = 1; i < PLOOP.length; i++) ctx.lineTo(PS[i * 2], PS[i * 2 + 1]);
  ctx.closePath();
  ctx.moveTo(QS[0], QS[1]);
  for (let i = 1; i < QLOOP.length; i++) ctx.lineTo(QS[i * 2], QS[i * 2 + 1]);
  ctx.closePath();
  ctx.fill();
}

// screen-space segments of the shared boundary, for localising a residual
function bandSeamSegs() {
  const segs = [];
  const n = PLOOP.length;
  loopScreen(PLOOP, PS);
  for (let i = 0; i < n; i++) {
    if (!PSHARED[i]) continue;
    const j = (i + 1) % n;
    segs.push([PS[i * 2], PS[i * 2 + 1], PS[j * 2], PS[j * 2 + 1]]);
  }
  return segs;
}

// how sharp does this boundary actually get?  reported so the fixture is
// described by measurement rather than by adjective
function bandGeometry() {
  const n = PLOOP.length;
  bandAffine();
  loopScreen(PLOOP, PS);
  let reflex = 0, minAng = 999, nShared = 0, len = 0, area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area2 += PS[i * 2] * PS[j * 2 + 1] - PS[j * 2] * PS[i * 2 + 1];
  }
  const sgn = area2 > 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const h = (i + n - 1) % n, j = (i + 1) % n;
    const ax = PS[i * 2] - PS[h * 2], ay = PS[i * 2 + 1] - PS[h * 2 + 1];
    const bx = PS[j * 2] - PS[i * 2], by = PS[j * 2 + 1] - PS[i * 2 + 1];
    const cr = sgn * (ax * by - ay * bx), dt = ax * bx + ay * by;
    const turn = Math.atan2(cr, dt) * 180 / Math.PI;       // +ve = convex
    if (turn < -1) reflex++;
    const interior = 180 - turn;
    if (interior < minAng) minAng = interior;
    if (PSHARED[i]) { nShared++; len += Math.hypot(bx, by); }
  }
  return { verts: n, reflex, minInteriorDeg: +minAng.toFixed(1),
           sharedEdges: nShared, sharedLenPx: +len.toFixed(0) };
}

// (3c) the band folded into P's OWN path -- one fill, no extra operation.
// See cube.js (i).  Conflation happens between fills, so a band that is a
// subpath of the polygon's own path cannot conflate with it: nonzero fills the
// union as one region with one coverage.
//   'inline'   : on a seam edge a->b emit a, a+n*w, b+n*w, b.  +2 verts/edge.
//                The outset without the re-intersection: no original vertex
//                moves, so the corners and the outline stay put.
//   'subpaths' : the loop plus one band quad per seam edge, all wound alike.
//                +4 verts/edge, and the overlap covers the corner that the
//                inline detour notches out.
function bandUnionBand(ctx, st, widthPx, mode, trim) {
  const inline = mode !== 'subpaths';
  bandAffine();
  loopScreen(PLOOP, PS);
  loopUV(PLOOP, PU_); loopUV(QLOOP, QU_);
  const n = PLOOP.length;
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area2 += PS[i * 2] * PS[j * 2 + 1] - PS[j * 2] * PS[i * 2 + 1];
  }
  const sgn = area2 > 0 ? 1 : -1;
  const w = widthPx * BSS;
  const wOut = inline ? w : w * 0.5, wIn = inline ? 0 : w * 0.5;
  ctx.fillStyle = bandPattern(ctx);
  ctx.setTransform(BCA[0], BCA[1], BCA[2], BCA[3], BCA[4], BCA[5]);
  ctx.beginPath();
  let verts = 0;
  if (inline) {
    for (let i = 0; i < n; i++) {
      if (i === 0) ctx.moveTo(PU_[0], PU_[1]); else ctx.lineTo(PU_[i * 2], PU_[i * 2 + 1]);
      verts++;
      if (!PSHARED[i]) continue;
      const j = (i + 1) % n;
      const ax = PS[i * 2], ay = PS[i * 2 + 1], bx = PS[j * 2], by = PS[j * 2 + 1];
      const ex = bx - ax, ey = by - ay, L = Math.hypot(ex, ey) || 1;
      const nx = sgn * ey / L, ny = -sgn * ex / L;
      let tax = ax, tay = ay, tbx = bx, tby = by;
      if (trim) {                       // see cube.js (i)
        const ux = ex / L, uy = ey / L, t = w * 0.5;
        if (!PSHARED[(i + n - 1) % n]) { tax += ux * t; tay += uy * t; }
        if (!PSHARED[j]) { tbx -= ux * t; tby -= uy * t; }
      }
      bandPointUV(tax + nx * wOut, tay + ny * wOut, QB2, 0);
      bandPointUV(tbx + nx * wOut, tby + ny * wOut, QB2, 2);
      ctx.lineTo(QB2[0], QB2[1]); ctx.lineTo(QB2[2], QB2[3]);
      verts += 2;
    }
    ctx.closePath();
  } else {
    pathUV(ctx, PU_, n);
    verts += n;
    for (let i = 0; i < n; i++) {
      if (!PSHARED[i]) continue;
      const j = (i + 1) % n;
      const ax = PS[i * 2], ay = PS[i * 2 + 1], bx = PS[j * 2], by = PS[j * 2 + 1];
      const ex = bx - ax, ey = by - ay, L = Math.hypot(ex, ey) || 1;
      const nx = sgn * ey / L, ny = -sgn * ex / L;
      const x0 = ax + nx * wOut, y0 = ay + ny * wOut;
      const x1 = bx + nx * wOut, y1 = by + ny * wOut;
      const x2 = bx - nx * wIn, y2 = by - ny * wIn;
      const x3 = ax - nx * wIn, y3 = ay - ny * wIn;
      const qa = x0 * y1 - x1 * y0 + x1 * y2 - x2 * y1 + x2 * y3 - x3 * y2 + x3 * y0 - x0 * y3;
      if ((qa > 0 ? 1 : -1) === sgn) {
        bandPointUV(x0, y0, QB2, 0); bandPointUV(x1, y1, QB2, 2);
        bandPointUV(x2, y2, QB2, 4); bandPointUV(x3, y3, QB2, 6);
      } else {
        bandPointUV(x3, y3, QB2, 0); bandPointUV(x2, y2, QB2, 2);
        bandPointUV(x1, y1, QB2, 4); bandPointUV(x0, y0, QB2, 6);
      }
      ctx.moveTo(QB2[0], QB2[1]); ctx.lineTo(QB2[2], QB2[3]);
      ctx.lineTo(QB2[4], QB2[5]); ctx.lineTo(QB2[6], QB2[7]);
      ctx.closePath();
      verts += 4;
    }
  }
  ctx.fill();
  pathUV(ctx, QU_, QLOOP.length); ctx.fill();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (st) { st.ops = 2; st.fills = 2; st.strokes = 0; st.verts = verts; }
}

// =========================================================================
// The eight-option comparison on the non-convex boundary.  Numbering matches
// cube.js.  P is the farther chart (drawn first), Q the nearer.
// =========================================================================
const PALL = (function () { const a = new Int8Array(PLOOP.length); a.fill(1); return a; })();

// Q's other edge at each end of P's shared edge i.  Q traverses the shared
// boundary in the opposite direction, so at a = PLOOP[i] the next Q vertex is
// the one after a in QLOOP, and at b = PLOOP[i+1] it is the one before b.
// Built once, by matching plane coordinates -- both loops come from the same
// vertex list, so the match is exact.
const QAFTER = new Int32Array(PLOOP.length).fill(-1);
const QBEFORE = new Int32Array(PLOOP.length).fill(-1);
(function () {
  const n = PLOOP.length, m = QLOOP.length;
  const key = (v) => v[0] + ':' + v[1];
  const qat = new Map();
  for (let j = 0; j < m; j++) qat.set(key(QLOOP[j]), j);
  for (let i = 0; i < n; i++) {
    if (!PSHARED[i]) continue;
    const ja = qat.get(key(PLOOP[i]));
    const jb = qat.get(key(PLOOP[(i + 1) % n]));
    if (ja !== undefined) QAFTER[i] = (ja + 1) % m;
    if (jb !== undefined) QBEFORE[i] = (jb + m - 1) % m;
  }
})();

// 1 / 3: fill, then stroke the whole boundary of every chart / of P only
function bandOptStrokeAll(ctx, st, widthPx, farOnly) {
  bandAffine();
  loopScreen(PLOOP, PS); loopScreen(QLOOP, QS);
  loopUV(PLOOP, PU_); loopUV(QLOOP, QU_);
  const pat = bandPattern(ctx), sp = bandSeamPattern(ctx);
  if (BMX && CanvasPattern.prototype.setTransform) {
    BMX.a = BCA[0]; BMX.b = BCA[1]; BMX.c = BCA[2];
    BMX.d = BCA[3]; BMX.e = BCA[4]; BMX.f = BCA[5];
    sp.setTransform(BMX);
  }
  let fills = 0, strokes = 0;
  const strokeLoop = (S, n) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = sp; ctx.lineWidth = widthPx * BSS;
    ctx.lineJoin = 'miter'; ctx.miterLimit = 10;
    ctx.beginPath();
    ctx.moveTo(S[0], S[1]);
    for (let i = 1; i < n; i++) ctx.lineTo(S[i * 2], S[i * 2 + 1]);
    ctx.closePath(); ctx.stroke(); strokes++;
  };
  ctx.fillStyle = pat;
  ctx.setTransform(BCA[0], BCA[1], BCA[2], BCA[3], BCA[4], BCA[5]);
  pathUV(ctx, PU_, PLOOP.length); ctx.fill(); fills++;
  strokeLoop(PS, PLOOP.length);                       // P always: it is farther
  ctx.setTransform(BCA[0], BCA[1], BCA[2], BCA[3], BCA[4], BCA[5]);
  ctx.fillStyle = pat;
  pathUV(ctx, QU_, QLOOP.length); ctx.fill(); fills++;
  if (!farOnly) strokeLoop(QS, QLOOP.length);         // Q too, unconditionally
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = 1;
  if (st) { st.ops = fills + strokes; st.fills = fills; st.strokes = strokes; }
}

// 2 / 4: expand every edge, by moving vertices
function bandOptExpandAll(ctx, st, widthPx, farOnly) {
  bandAffine();
  loopScreen(PLOOP, PS); loopScreen(QLOOP, QS);
  loopUV(PLOOP, PU_); loopUV(QLOOP, QU_);
  ctx.fillStyle = bandPattern(ctx);
  outsetLoop(PS, PLOOP.length, PALL, widthPx * BSS, 4, POUT);
  screenToUV(POUT, PLOOP.length, PUVOUT);
  ctx.setTransform(BCA[0], BCA[1], BCA[2], BCA[3], BCA[4], BCA[5]);
  pathUV(ctx, PUVOUT, PLOOP.length); ctx.fill();
  if (!farOnly) {
    const QOUT = new Float64Array(QLOOP.length * 2), QUV2 = new Float64Array(QLOOP.length * 2);
    const QA = new Int8Array(QLOOP.length); QA.fill(1);
    outsetLoop(QS, QLOOP.length, QA, widthPx * BSS, 4, QOUT);
    screenToUV(QOUT, QLOOP.length, QUV2);
    pathUV(ctx, QUV2, QLOOP.length); ctx.fill();
  } else {
    pathUV(ctx, QU_, QLOOP.length); ctx.fill();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (st) { st.ops = 2; st.fills = 2; st.strokes = 0; }
}

// 8: in-line vertices placed along Q's adjacent edges
function bandOptNeighbour(ctx, st, widthPx, limit) {
  const lim = limit || 4;
  bandAffine();
  loopScreen(PLOOP, PS); loopScreen(QLOOP, QS);
  loopUV(PLOOP, PU_); loopUV(QLOOP, QU_);
  const n = PLOOP.length, w = widthPx * BSS;
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area2 += PS[i * 2] * PS[j * 2 + 1] - PS[j * 2] * PS[i * 2 + 1];
  }
  const sgn = area2 > 0 ? 1 : -1;
  ctx.fillStyle = bandPattern(ctx);
  ctx.setTransform(BCA[0], BCA[1], BCA[2], BCA[3], BCA[4], BCA[5]);
  ctx.beginPath();
  let verts = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0) ctx.moveTo(PU_[0], PU_[1]); else ctx.lineTo(PU_[i * 2], PU_[i * 2 + 1]);
    verts++;
    if (!PSHARED[i]) continue;
    const j = (i + 1) % n;
    const ax = PS[i * 2], ay = PS[i * 2 + 1], bx = PS[j * 2], by = PS[j * 2 + 1];
    const ex = bx - ax, ey = by - ay, L = Math.hypot(ex, ey) || 1;
    const nx = sgn * ey / L, ny = -sgn * ex / L;
    let dax = nx, day = ny, dbx = nx, dby = ny;
    if (QAFTER[i] >= 0) { dax = QS[QAFTER[i] * 2] - ax; day = QS[QAFTER[i] * 2 + 1] - ay; }
    if (QBEFORE[i] >= 0) { dbx = QS[QBEFORE[i] * 2] - bx; dby = QS[QBEFORE[i] * 2 + 1] - by; }
    bandCorner2(ax, ay, dax, day, ax, ay, nx, ny, w, lim);
    bandPointUV(BC2[0], BC2[1], QB2, 0);
    bandCorner2(bx, by, dbx, dby, ax, ay, nx, ny, w, lim);
    bandPointUV(BC2[0], BC2[1], QB2, 2);
    ctx.lineTo(QB2[0], QB2[1]); ctx.lineTo(QB2[2], QB2[3]);
    verts += 2;
  }
  ctx.closePath();
  ctx.fill();
  pathUV(ctx, QU_, QLOOP.length); ctx.fill();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (st) { st.ops = 2; st.fills = 2; st.strokes = 0; st.verts = verts; }
}
const BC2 = new Float64Array(2);
function bandCorner2(px, py, dx, dy, ax, ay, nx, ny, w, limit) {
  const dn = dx * nx + dy * ny;
  if (Math.abs(dn) < 1e-6) { BC2[0] = px + nx * w; BC2[1] = py + ny * w; return; }
  const need = w - ((px - ax) * nx + (py - ay) * ny);
  let t = need / dn;
  const L = Math.hypot(dx, dy) || 1;
  const cap = limit * w / L;
  if (t > cap) t = cap; else if (t < 0) t = 0;
  BC2[0] = px + dx * t; BC2[1] = py + dy * t;
}

// 8b on the general loop: neighbour direction at a run's free ends, ordinary
// mitre between consecutive band segments.  See cube.js (8b).
const BEN = new Float64Array(PLOOP.length * 2), BEC = new Float64Array(PLOOP.length);
const BOUT = new Float64Array(PLOOP.length * 6);
function bandOptNeighbourMitred(ctx, st, widthPx, limit) {
  const lim = limit || 4;
  bandAffine();
  loopScreen(PLOOP, PS); loopScreen(QLOOP, QS);
  loopUV(PLOOP, PU_); loopUV(QLOOP, QU_);
  const n = PLOOP.length, w = widthPx * BSS;
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area2 += PS[i * 2] * PS[j * 2 + 1] - PS[j * 2] * PS[i * 2 + 1];
  }
  const sgn = area2 > 0 ? 1 : -1;
  for (let e = 0; e < n; e++) {
    const j = (e + 1) % n;
    const ax = PS[e * 2], ay = PS[e * 2 + 1];
    const ex = PS[j * 2] - ax, ey = PS[j * 2 + 1] - ay, L = Math.hypot(ex, ey) || 1;
    const nx = sgn * ey / L, ny = -sgn * ex / L;
    BEN[e * 2] = nx; BEN[e * 2 + 1] = ny;
    BEC[e] = nx * ax + ny * ay + w;
  }
  const interior = (v) => PSHARED[(v + n - 1) % n] === 1 && PSHARED[v] === 1;
  let start = -1;
  for (let v = 0; v < n; v++) if (!interior(v)) { start = v; break; }
  let m = 0;
  const push = (x, y) => { BOUT[m * 2] = x; BOUT[m * 2 + 1] = y; m++; };
  const corner = (v) => {
    const prev = (v + n - 1) % n;
    const ps = PSHARED[prev] === 1, cs = PSHARED[v] === 1;
    const vx = PS[v * 2], vy = PS[v * 2 + 1];
    if (ps && cs) {
      const a1 = BEN[prev * 2], b1 = BEN[prev * 2 + 1], c1 = BEC[prev];
      const a2 = BEN[v * 2], b2 = BEN[v * 2 + 1], c2 = BEC[v];
      const det = a1 * b2 - a2 * b1;
      if (Math.abs(det) < 1e-9) { push(vx + a2 * w, vy + b2 * w); return; }
      let x = (c1 * b2 - c2 * b1) / det, y = (a1 * c2 - a2 * c1) / det;
      const dx = x - vx, dy = y - vy, L = Math.hypot(dx, dy), cap = lim * w;
      if (L > cap && L > 0) { x = vx + dx * cap / L; y = vy + dy * cap / L; }
      push(x, y); return;
    }
    const e = cs ? v : prev;
    const nx = BEN[e * 2], ny = BEN[e * 2 + 1];
    const ax = PS[e * 2], ay = PS[e * 2 + 1];
    let dx = nx, dy = ny;
    const qi = cs ? QAFTER[e] : QBEFORE[e];
    if (qi >= 0) { dx = QS[qi * 2] - vx; dy = QS[qi * 2 + 1] - vy; }
    bandCorner2(vx, vy, dx, dy, ax, ay, nx, ny, w, lim);
    push(BC2[0], BC2[1]);
  };
  for (let k = 0; k < n; k++) {
    const v = (start + k) % n;
    if (interior(v)) continue;
    push(PS[v * 2], PS[v * 2 + 1]);
    if (PSHARED[v]) {
      let len = 0;
      while (PSHARED[(v + len) % n]) len++;
      for (let j = 0; j <= len; j++) corner((v + j) % n);
    }
  }
  ctx.fillStyle = bandPattern(ctx);
  ctx.setTransform(BCA[0], BCA[1], BCA[2], BCA[3], BCA[4], BCA[5]);
  ctx.beginPath();
  for (let k = 0; k < m; k++) {
    bandPointUV(BOUT[k * 2], BOUT[k * 2 + 1], QB2, 0);
    if (k === 0) ctx.moveTo(QB2[0], QB2[1]); else ctx.lineTo(QB2[0], QB2[1]);
  }
  ctx.closePath();
  ctx.fill();
  pathUV(ctx, QU_, QLOOP.length); ctx.fill();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (st) { st.ops = 2; st.fills = 2; st.strokes = 0; st.verts = m; }
}
