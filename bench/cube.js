// ---------------------------------------------------------------------------
// cube.js -- the primary case: a face made of two coplanar triangles, drawn
// with ONE operation, and the gap between neighbouring faces killed by
// OUTSETTING rather than by stroking.
//
// Why merging kills the internal gap outright: the two triangles of a face
// share a diagonal.  Merge them into one polygon and that diagonal is never
// rasterised, so there is no conflation seam there to hide.  One fill, no
// stroke, no gap.
//
// What is left is the gap between DIFFERENT faces (a cube edge).  Those faces
// are not coplanar so they cannot merge.  Fix: draw the farther face slightly
// LARGER along the shared edge, so the nearer face's antialiased edge blends
// over solid coverage instead of over the background.  Two rules make it
// correct:
//   * only outset an edge whose neighbour is drawn LATER -- if the neighbour
//     already went down, growing over it moves the visible boundary;
//   * only outset shared edges, never silhouettes -- a silhouette outset just
//     makes the object half a pixel too big.
// Both tests are the same ones the flat-colour batcher already needed.
//
// The outset ring samples texture slightly outside the face's UV rect, and it
// is always covered by the neighbour, so what it samples never shows -- but it
// must be OPAQUE or the gap survives.  Hence the atlas is padded, which is
// standard practice for exactly this reason.
// ---------------------------------------------------------------------------
'use strict';

const CTEX = 512, PAD = 8;              // padded atlas: 2x3 faces, PAD gutter
const CUBE_TEXTURE = (function () {
  const c = document.createElement('canvas');
  c.width = c.height = CTEX;
  const x = c.getContext('2d');
  // Lay the atlas down on a fully opaque base FIRST.  The cell height is
  // 512/3, so the per-cell fillRects land on fractional boundaries and get
  // antialiased -- which left 1024 semi-transparent texels and showed up as a
  // "gap" deep inside every face, in every strategy.  A fixture bug that cost
  // real debugging time: if you measure gaps, prove your texture is opaque.
  x.fillStyle = '#101014';
  x.fillRect(0, 0, CTEX, CTEX);
  const cw = CTEX / 2, ch = CTEX / 3;
  const tint = ['#c0504d', '#4f81bd', '#9bbb59', '#8064a2', '#4bacc6', '#f79646'];
  for (let f = 0; f < 6; f++) {
    const ox = (f % 2) * cw, oy = ((f / 2) | 0) * ch;
    // fill the WHOLE cell including the gutter, so an outset that samples into
    // the gutter still gets opaque, near-correct texels
    x.fillStyle = tint[f];
    x.fillRect(ox, oy, cw, ch);
    x.fillStyle = 'rgba(0,0,0,0.35)';
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
      if ((i ^ j) & 1) x.fillRect(ox + PAD + i * (cw - 2 * PAD) / 8, oy + PAD + j * (ch - 2 * PAD) / 8,
                                  (cw - 2 * PAD) / 8, (ch - 2 * PAD) / 8);
    }
    x.fillStyle = '#fff';
    x.font = 'bold 40px sans-serif';
    x.fillText(String(f), ox + cw * 0.45, oy + ch * 0.58);
  }
  return c;
})();

// UV rect of face f, inset by PAD so an outset has real texels to sample
function faceUV(f) {
  const cw = CTEX / 2, ch = CTEX / 3;
  const ox = (f % 2) * cw, oy = ((f / 2) | 0) * ch;
  return [ox + PAD, oy + PAD, cw - 2 * PAD, ch - 2 * PAD];
}

// --- cube geometry: 6 faces, 4 corners each, CCW seen from outside ---------
const CUBE_V = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]
];
const CUBE_F = [
  [4, 5, 6, 7],   // +z
  [1, 0, 3, 2],   // -z
  [5, 1, 2, 6],   // +x
  [0, 4, 7, 3],   // -x
  [7, 6, 2, 3],   // +y
  [0, 1, 5, 4]    // -y
];
// neighbour face across edge e of face f (edge e = corner e -> corner e+1)
const CUBE_ADJ = (function () {
  const map = new Map(), adj = [];
  for (let f = 0; f < 6; f++) {
    adj.push([-1, -1, -1, -1]);
    for (let e = 0; e < 4; e++) {
      const a = CUBE_F[f][e], b = CUBE_F[f][(e + 1) % 4];
      const key = Math.min(a, b) * 8 + Math.max(a, b);
      const prev = map.get(key);
      if (prev === undefined) map.set(key, f * 4 + e);
      else { const pf = (prev / 4) | 0, pe = prev % 4; adj[f][e] = pf; adj[pf][pe] = f; }
    }
  }
  return adj;
})();

// --- per-frame state -------------------------------------------------------
const CW = 1000, CH = 700;
const SX = new Float64Array(8), SY = new Float64Array(8), SW = new Float64Array(8);
const FVIS = new Int8Array(6), FORD = new Int32Array(6), FPOS = new Int32Array(6);
let nFaceVis = 0;

function cubeBuild(ax, ay, dist, scale) {
  const ca = Math.cos(ax), sa = Math.sin(ax), cb = Math.cos(ay), sb = Math.sin(ay);
  for (let i = 0; i < 8; i++) {
    const X = CUBE_V[i][0], Y = CUBE_V[i][1], Z = CUBE_V[i][2];
    const x1 = X * cb + Z * sb, z1 = -X * sb + Z * cb;
    const y1 = Y * ca - z1 * sa, z2 = Y * sa + z1 * ca + dist;
    const w = z2 < 0.2 ? 0.2 : z2, iw = scale / w;
    SX[i] = CW * 0.5 + x1 * iw; SY[i] = CH * 0.5 - y1 * iw; SW[i] = w;
  }
  const depth = new Float64Array(6);
  nFaceVis = 0;
  for (let f = 0; f < 6; f++) {
    const q = CUBE_F[f];
    const area = (SX[q[1]] - SX[q[0]]) * (SY[q[2]] - SY[q[0]]) - (SY[q[1]] - SY[q[0]]) * (SX[q[2]] - SX[q[0]]);
    FVIS[f] = area > 0 ? 1 : 0;         // screen-CCW after the y flip
    depth[f] = (SW[q[0]] + SW[q[1]] + SW[q[2]] + SW[q[3]]) * 0.25;
    if (FVIS[f]) FORD[nFaceVis++] = f;
  }
  // back to front
  for (let i = 1; i < nFaceVis; i++) {
    const t = FORD[i]; let j = i - 1;
    while (j >= 0 && depth[FORD[j]] < depth[t]) { FORD[j + 1] = FORD[j]; j--; }
    FORD[j + 1] = t;
  }
  FPOS.fill(-1);
  for (let i = 0; i < nFaceVis; i++) FPOS[FORD[i]] = i;
  return nFaceVis;
}

// --- affine map from a face's UV rect to its screen quad -------------------
// Exact at three corners; the fourth carries the homography error, which is
// what the eps test in texplane.js measures.
const CA = new Float64Array(6);
function faceAffine(f) {
  const q = CUBE_F[f], uv = faceUV(f);
  const u0 = uv[0], v0 = uv[1], du = uv[2], dv = uv[3];
  // corner order matches CUBE_F: (u0,v0) (u0+du,v0) (u0+du,v0+dv) (u0,v0+dv)
  const x0 = SX[q[0]], y0 = SY[q[0]], x1 = SX[q[1]], y1 = SY[q[1]], x3 = SX[q[3]], y3 = SY[q[3]];
  const a = (x1 - x0) / du, b = (y1 - y0) / du;
  const c = (x3 - x0) / dv, d = (y3 - y0) / dv;
  CA[0] = a; CA[1] = b; CA[2] = c; CA[3] = d;
  CA[4] = x0 - a * u0 - c * v0;
  CA[5] = y0 - b * u0 - d * v0;
  return (a * d - b * c) !== 0;
}

// --- outset: grow selected edges of the screen quad, then map back to UV ---
const OSX = new Float64Array(4), OSY = new Float64Array(4);
const OUV = new Float64Array(8);

function buildFacePathUV(f, outsetPx, all) {
  const q = CUBE_F[f], uv = faceUV(f);
  for (let i = 0; i < 4; i++) { OSX[i] = SX[q[i]]; OSY[i] = SY[q[i]]; }

  if (outsetPx > 0) {
    // which edges get grown: shared with a face drawn LATER (nearer), or --
    // for the unconditional options of the eight-way comparison -- all four
    const d = [0, 0, 0, 0];
    for (let e = 0; e < 4; e++) {
      if (all) { d[e] = outsetPx; continue; }
      const nb = CUBE_ADJ[f][e];
      if (nb >= 0 && FVIS[nb] && FPOS[nb] > FPOS[f]) d[e] = outsetPx;
    }
    if (d[0] || d[1] || d[2] || d[3]) {
      let cx = 0, cy = 0;
      for (let i = 0; i < 4; i++) { cx += OSX[i]; cy += OSY[i]; }
      cx *= 0.25; cy *= 0.25;
      // offset each selected edge line outward, then re-intersect at vertices
      const LX = new Float64Array(4), LY = new Float64Array(4), LC = new Float64Array(4);
      for (let e = 0; e < 4; e++) {
        const i0 = e, i1 = (e + 1) % 4;
        let ex = OSX[i1] - OSX[i0], ey = OSY[i1] - OSY[i0];
        const len = Math.hypot(ex, ey) || 1;
        let nx = ey / len, ny = -ex / len;
        // point the normal away from the centroid
        if (nx * (OSX[i0] - cx) + ny * (OSY[i0] - cy) < 0) { nx = -nx; ny = -ny; }
        LX[e] = nx; LY[e] = ny;
        LC[e] = nx * OSX[i0] + ny * OSY[i0] + d[e];
      }
      const nx2 = new Float64Array(4), ny2 = new Float64Array(4);
      for (let i = 0; i < 4; i++) {
        const ePrev = (i + 3) % 4, eCur = i;   // edges meeting at vertex i
        const a1 = LX[ePrev], b1 = LY[ePrev], c1 = LC[ePrev];
        const a2 = LX[eCur], b2 = LY[eCur], c2 = LC[eCur];
        const det = a1 * b2 - a2 * b1;
        if (Math.abs(det) < 1e-9) { nx2[i] = OSX[i]; ny2[i] = OSY[i]; }
        else { nx2[i] = (c1 * b2 - c2 * b1) / det; ny2[i] = (a1 * c2 - a2 * c1) / det; }
      }
      for (let i = 0; i < 4; i++) { OSX[i] = nx2[i]; OSY[i] = ny2[i]; }
    }
  }

  // map the (possibly grown) screen quad back through the affine map to UV,
  // so the pattern still lands exactly where it should on the original face
  const a = CA[0], b = CA[1], c = CA[2], d2 = CA[3], e2 = CA[4], f2 = CA[5];
  const det = a * d2 - b * c, inv = det ? 1 / det : 0;
  for (let i = 0; i < 4; i++) {
    const px = OSX[i] - e2, py = OSY[i] - f2;
    OUV[i * 2] = (px * d2 - py * c) * inv;
    OUV[i * 2 + 1] = (py * a - px * b) * inv;
  }
  return OUV;
}

let CPAT = null;
function cubePattern(ctx) {
  if (!CPAT) CPAT = ctx.createPattern(CUBE_TEXTURE, 'repeat');
  return CPAT;
}

// =========================================================================
// the strategies
// =========================================================================

// (a) what the user has now: two triangles per face, clip + drawImage each
function drawPerTriClip(ctx, st) {
  let n = 0;
  for (let i = 0; i < nFaceVis; i++) {
    const f = FORD[i], q = CUBE_F[f], uv = faceUV(f);
    const cu = [uv[0], uv[0] + uv[2], uv[0] + uv[2], uv[0]];
    const cv = [uv[1], uv[1], uv[1] + uv[3], uv[1] + uv[3]];
    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
      const A = triAffine(cu[tri[0]], cv[tri[0]], SX[q[tri[0]]], SY[q[tri[0]]],
                          cu[tri[1]], cv[tri[1]], SX[q[tri[1]]], SY[q[tri[1]]],
                          cu[tri[2]], cv[tri[2]], SX[q[tri[2]]], SY[q[tri[2]]]);
      if (!A) continue;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(SX[q[tri[0]]], SY[q[tri[0]]]);
      ctx.lineTo(SX[q[tri[1]]], SY[q[tri[1]]]);
      ctx.lineTo(SX[q[tri[2]]], SY[q[tri[2]]]);
      ctx.clip();
      ctx.setTransform(TRA[0], TRA[1], TRA[2], TRA[3], TRA[4], TRA[5]);
      ctx.drawImage(CUBE_TEXTURE, 0, 0);
      ctx.restore();
      n++;
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (st) { st.ops = n; st.fills = 0; st.draws = n; }
}
const TRA = new Float64Array(6);
function triAffine(u0, v0, x0, y0, u1, v1, x1, y1, u2, v2, x2, y2) {
  const du0 = u0 - u2, du1 = u1 - u2, dv0 = v0 - v2, dv1 = v1 - v2;
  const den = du0 * dv1 - du1 * dv0;
  if (!den) return false;
  const inv = 1 / den;
  const a = ((x0 - x2) * dv1 - (x1 - x2) * dv0) * inv;
  const c = (du0 * (x1 - x2) - du1 * (x0 - x2)) * inv;
  const b = ((y0 - y2) * dv1 - (y1 - y2) * dv0) * inv;
  const d = (du0 * (y1 - y2) - du1 * (y0 - y2)) * inv;
  TRA[0] = a; TRA[1] = b; TRA[2] = c; TRA[3] = d;
  TRA[4] = x2 - a * u2 - c * v2; TRA[5] = y2 - b * u2 - d * v2;
  return true;
}

// (b) two triangles per face, pattern fill
function drawPerTriPattern(ctx, st) {
  ctx.fillStyle = cubePattern(ctx);
  let n = 0;
  for (let i = 0; i < nFaceVis; i++) {
    const f = FORD[i], q = CUBE_F[f], uv = faceUV(f);
    const cu = [uv[0], uv[0] + uv[2], uv[0] + uv[2], uv[0]];
    const cv = [uv[1], uv[1], uv[1] + uv[3], uv[1] + uv[3]];
    for (const tri of [[0, 1, 2], [0, 2, 3]]) {
      if (!triAffine(cu[tri[0]], cv[tri[0]], SX[q[tri[0]]], SY[q[tri[0]]],
                     cu[tri[1]], cv[tri[1]], SX[q[tri[1]]], SY[q[tri[1]]],
                     cu[tri[2]], cv[tri[2]], SX[q[tri[2]]], SY[q[tri[2]]])) continue;
      ctx.setTransform(TRA[0], TRA[1], TRA[2], TRA[3], TRA[4], TRA[5]);
      ctx.beginPath();
      ctx.moveTo(cu[tri[0]], cv[tri[0]]);
      ctx.lineTo(cu[tri[1]], cv[tri[1]]);
      ctx.lineTo(cu[tri[2]], cv[tri[2]]);
      ctx.fill();
      n++;
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (st) { st.ops = n; st.fills = n; st.draws = 0; }
}

// (c) THE PRIMARY PATH: one fill per face, optional outset to kill the gap
function drawPerFace(ctx, st, outsetPx) {
  ctx.fillStyle = cubePattern(ctx);
  let n = 0;
  for (let i = 0; i < nFaceVis; i++) {
    const f = FORD[i];
    if (!faceAffine(f)) continue;
    const p = buildFacePathUV(f, outsetPx);
    ctx.setTransform(CA[0], CA[1], CA[2], CA[3], CA[4], CA[5]);
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[2], p[3]);
    ctx.lineTo(p[4], p[5]);
    ctx.lineTo(p[6], p[7]);
    ctx.fill();
    n++;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (st) { st.ops = n; st.fills = n; st.draws = 0; }
}

// (d) the rejected alternative, for comparison only
function drawPerFaceStroke(ctx, st) {
  ctx.fillStyle = cubePattern(ctx);
  ctx.strokeStyle = cubePattern(ctx);
  ctx.lineWidth = 0.5;
  let n = 0;
  for (let i = 0; i < nFaceVis; i++) {
    const f = FORD[i];
    if (!faceAffine(f)) continue;
    const p = buildFacePathUV(f, 0);
    ctx.setTransform(CA[0], CA[1], CA[2], CA[3], CA[4], CA[5]);
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]); ctx.lineTo(p[2], p[3]);
    ctx.lineTo(p[4], p[5]); ctx.lineTo(p[6], p[7]); ctx.lineTo(p[0], p[1]);
    ctx.fill(); ctx.stroke();
    n++;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = 1;
  if (st) { st.ops = n * 2; st.fills = n; st.draws = 0; }
}

// =========================================================================
// (g) THE SEAM BAND -- gap repair that moves no vertex at all.
//
// The outset above is correct but it MOVES GEOMETRY: offsetting an edge
// re-intersects the two adjacent edge lines, so the vertices at both ends of
// the edge travel, and a vertex is shared with the adjacent edges:
//   * if an adjacent edge is a silhouette, its vertex slides outward along it
//     and the object's own outline grows, in a place nothing will cover --
//     measured, 23.3 px of coverage moved and 453 pixels changed more than 3px
//     away from the seam being repaired;
//   * on a general (non-convex) loop the displacement is no longer the edge
//     normal, and the mitre a sharp corner forces has to be clamped -- which
//     costs gap back (band.js measures 0.12 -> 0.52 at a 2x clamp).
//
// NOTE: the band below is measured as a STROKE, which is the obvious
// implementation and the wrong one -- a pattern stroke costs 7-9x more on
// Firefox than the same band as a fill, and the heaviest ones drop the canvas
// out of acceleration.  (h) is the one to ship.
//
// The band gets the same coverage without touching a single vertex: fill the
// face exactly as the primary path does, then STROKE only the shared edges of
// that face -- and only on the face that is drawn FIRST -- with the face's own
// texture.  The stroke straddles the edge, so
//   * the half lying OUTSIDE the face is covered later by the nearer
//     neighbour, exactly as the outset ring was, and
//   * the half lying INSIDE the face paints the same texels the fill already
//     put there, through the same affine map, so it is a provable no-op.
// The band is therefore invisible everywhere except in the pixels straddling
// the shared edge, which are the pixels it exists to finish covering.
//
// Two mechanics matter:
//   * stroke in SCREEN space, not in texture space.  The fill runs with the
//     face affine on the context, where `lineWidth` would be in texture units
//     and would come out scaled and anisotropic.  Reset the transform and put
//     the affine on the PATTERN instead (`CanvasPattern.setTransform`), and
//     lineWidth is device pixels again while the texture still lands where it
//     belongs.
//   * lineWidth is TWICE the outset that would do the same job: a centred
//     stroke of width w reaches w/2 past the edge, and §4.8 measured that a
//     straddling pixel needs a full pixel of cover.  So w = 2.
// =========================================================================
const SEAMSEL = new Int8Array(4);
const SEAMRUN = new Int32Array(8);     // (startEdge, length) pairs
let nSeamRuns = 0, seamClosed = 0;

// Which edges of face f are seams the face will lose to a NEARER neighbour --
// the same two tests the outset uses: shared with a visible face (not a
// silhouette), and that face is drawn later.  Chained into maximal runs so an
// adjacent pair strokes as one polyline and mitres at the vertex they share
// instead of leaving two butt caps there.
function faceSeamRuns(f) {
  nSeamRuns = 0; seamClosed = 0;
  let n = 0;
  for (let e = 0; e < 4; e++) {
    const nb = CUBE_ADJ[f][e];
    const s = (nb >= 0 && FVIS[nb] && FPOS[nb] > FPOS[f]) ? 1 : 0;
    SEAMSEL[e] = s; n += s;
  }
  if (n === 0) return 0;
  if (n === 4) { SEAMRUN[0] = 0; SEAMRUN[1] = 4; nSeamRuns = 1; seamClosed = 1; return 4; }
  for (let e = 0; e < 4; e++) {
    if (SEAMSEL[e] && !SEAMSEL[(e + 3) & 3]) {
      let len = 1;
      while (SEAMSEL[(e + len) & 3]) len++;
      SEAMRUN[nSeamRuns * 2] = e; SEAMRUN[nSeamRuns * 2 + 1] = len; nSeamRuns++;
    }
  }
  return n;
}

let SPAT = null;
const SEAMM = (typeof DOMMatrix !== 'undefined') ? new DOMMatrix() : null;
function seamPattern(ctx) {
  if (!SPAT) SPAT = ctx.createPattern(CUBE_TEXTURE, 'repeat');
  return SPAT;
}
const PATTERN_SETTRANSFORM =
  typeof CanvasPattern !== 'undefined' && !!CanvasPattern.prototype.setTransform;

// widthPx: screen-space stroke width.  cap: 'butt' | 'square' | 'round'.
// opt.flat:    a CSS colour instead of the face's own pattern -- measured only
//              to show why the band has to carry the texture.
// opt.texSpace: stroke with the context still in TEXTURE space, reusing the
//              fill's own pattern and dividing the width back out by the
//              affine's scale.  One state change fewer and no
//              pattern.setTransform, at the price of a width that is only
//              right on average when the map is anisotropic.
// opt.trim:    pull each free end of a seam run back along its own segment by
//              half the width, so a butt cap that lands on the silhouette
//              cannot spill past the outline.
function drawPerFaceSeamBand(ctx, st, widthPx, cap, opt) {
  const o = typeof opt === 'string' ? { flat: opt } : (opt || {});
  const pat = cubePattern(ctx);
  const spat = o.flat ? null : (o.texSpace ? pat : seamPattern(ctx));
  ctx.lineJoin = 'miter'; ctx.miterLimit = 10;
  ctx.lineCap = cap || 'butt';
  let fills = 0, strokes = 0;
  for (let i = 0; i < nFaceVis; i++) {
    const f = FORD[i];
    if (!faceAffine(f)) continue;
    const p = buildFacePathUV(f, 0);          // NO outset: vertices untouched
    ctx.setTransform(CA[0], CA[1], CA[2], CA[3], CA[4], CA[5]);
    ctx.fillStyle = pat;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[2], p[3]);
    ctx.lineTo(p[4], p[5]);
    ctx.lineTo(p[6], p[7]);
    ctx.fill();
    fills++;
    if (!faceSeamRuns(f)) continue;
    const q = CUBE_F[f];
    if (o.texSpace) {
      // already in texture space, and the pattern maps texture space to user
      // space by identity here, so the texture lands exactly as the fill's did
      const sc = Math.sqrt(Math.abs(CA[0] * CA[3] - CA[1] * CA[2])) || 1;
      ctx.lineWidth = widthPx / sc;
      ctx.strokeStyle = spat;
      ctx.beginPath();
      for (let r = 0; r < nSeamRuns; r++) {
        const s0 = SEAMRUN[r * 2], len = SEAMRUN[r * 2 + 1];
        ctx.moveTo(p[s0 * 2], p[s0 * 2 + 1]);
        for (let k = 1; k <= len; k++) { const vi = (s0 + k) & 3; ctx.lineTo(p[vi * 2], p[vi * 2 + 1]); }
        if (seamClosed) ctx.closePath();
      }
      ctx.stroke();
      strokes++;
      continue;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);       // screen space: lineWidth in device px
    ctx.lineWidth = widthPx;
    if (spat) {
      if (PATTERN_SETTRANSFORM) {
        SEAMM.a = CA[0]; SEAMM.b = CA[1]; SEAMM.c = CA[2];
        SEAMM.d = CA[3]; SEAMM.e = CA[4]; SEAMM.f = CA[5];
        spat.setTransform(SEAMM);
      }
      ctx.strokeStyle = spat;
    } else {
      ctx.strokeStyle = o.flat;
    }
    const t = o.trim ? widthPx * 0.5 : 0;
    ctx.beginPath();
    for (let r = 0; r < nSeamRuns; r++) {
      const s0 = SEAMRUN[r * 2], len = SEAMRUN[r * 2 + 1];
      let x0 = SX[q[s0]], y0 = SY[q[s0]];
      let xe = SX[q[(s0 + len) & 3]], ye = SY[q[(s0 + len) & 3]];
      if (t && !seamClosed) {
        const x1 = SX[q[(s0 + 1) & 3]], y1 = SY[q[(s0 + 1) & 3]];
        let dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
        x0 += dx / L * t; y0 += dy / L * t;
        const xp = SX[q[(s0 + len + 3) & 3]], yp = SY[q[(s0 + len + 3) & 3]];
        dx = xe - xp; dy = ye - yp; L = Math.hypot(dx, dy) || 1;
        xe -= dx / L * t; ye -= dy / L * t;
      }
      ctx.moveTo(x0, y0);
      for (let k = 1; k < len; k++) { const vi = q[(s0 + k) & 3]; ctx.lineTo(SX[vi], SY[vi]); }
      ctx.lineTo(xe, ye);
      if (seamClosed) ctx.closePath();
    }
    ctx.stroke();
    strokes++;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = 1; ctx.lineCap = 'butt';
  if (st) { st.ops = fills + strokes; st.fills = fills; st.strokes = strokes; st.draws = 0; }
}

// =========================================================================
// (h) THE SAME BAND, AS A FILL.
//
// The band above is a stroke, and a stroke with a CanvasPattern on it is not
// the fast path: Gecko cannot accelerate it at all (measured), and Skia pays
// for it too.  But the band is just a quadrilateral per edge -- the edge
// extruded along its normal -- and a pattern FILL whose path is in texture
// space is the fast recipe 4.7 already established.
//
// So emit one quad per seam edge as a SUBPATH of a single path and fill it
// once.  Every quad is wound the same way (the normal is always the left
// normal of the edge direction), so under the nonzero rule the overlapping
// quads fill their union -- no conflation between them, because it is one
// fill.  Consecutive quads overlap around the vertex they share, which is
// what a mitre join was doing for the stroke.
//
// mode 'centred'  the band straddles the edge, exactly like the stroke.  The
//                 inner half repaints texels that are already there.
// mode 'outward'  the band sits entirely OUTSIDE the face, so it cannot touch
//                 the face's own interior even in principle, and every pixel
//                 it paints is one the nearer neighbour is about to cover.
//                 Needs the full width outward, so widthPx is not halved.
// =========================================================================
const QB = new Float64Array(8);
function screenToFaceUV(x, y, out, o) {
  const a = CA[0], b = CA[1], c = CA[2], d = CA[3];
  const det = a * d - b * c, inv = det ? 1 / det : 0;
  const px = x - CA[4], py = y - CA[5];
  out[o] = (px * d - py * c) * inv;
  out[o + 1] = (py * a - px * b) * inv;
}
function drawPerFaceQuadBand(ctx, st, widthPx, mode, trim) {
  const outward = mode === 'outward';
  const pat = cubePattern(ctx);
  ctx.fillStyle = pat;
  let fills = 0, bands = 0;
  for (let i = 0; i < nFaceVis; i++) {
    const f = FORD[i];
    if (!faceAffine(f)) continue;
    const p = buildFacePathUV(f, 0);          // vertices untouched
    ctx.setTransform(CA[0], CA[1], CA[2], CA[3], CA[4], CA[5]);
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[2], p[3]);
    ctx.lineTo(p[4], p[5]);
    ctx.lineTo(p[6], p[7]);
    ctx.fill();
    fills++;
    if (!faceSeamRuns(f)) continue;
    // centroid, so the normal can be pointed away from the face
    const q = CUBE_F[f];
    let cx = 0, cy = 0;
    for (let k = 0; k < 4; k++) { cx += SX[q[k]]; cy += SY[q[k]]; }
    cx *= 0.25; cy *= 0.25;
    ctx.beginPath();
    let n = 0;
    for (let e = 0; e < 4; e++) {
      if (!SEAMSEL[e]) continue;
      const i0 = q[e], i1 = q[(e + 1) & 3];
      const ax = SX[i0], ay = SY[i0], bx = SX[i1], by = SY[i1];
      const ex = bx - ax, ey = by - ay;
      const L = Math.hypot(ex, ey) || 1;
      let nx = ey / L, ny = -ex / L;
      if (nx * (ax - cx) + ny * (ay - cy) < 0) { nx = -nx; ny = -ny; }
      const wIn = outward ? 0 : widthPx * 0.5, wOut = outward ? widthPx : widthPx * 0.5;
      // A free end of a seam run sits on the silhouette, and there the band's
      // outer half is the one thing nothing covers.  Pulling that end back
      // half a width keeps every painted pixel inside the outline, and gives
      // up the last half pixel of seam in exchange.
      let tax = ax, tay = ay, tbx = bx, tby = by;
      if (trim) {
        const ux = ex / L, uy = ey / L, t = widthPx * 0.5;
        if (!SEAMSEL[(e + 3) & 3]) { tax += ux * t; tay += uy * t; }
        if (!SEAMSEL[(e + 1) & 3]) { tbx -= ux * t; tby -= uy * t; }
      }
      screenToFaceUV(tax + nx * wOut, tay + ny * wOut, QB, 0);
      screenToFaceUV(tbx + nx * wOut, tby + ny * wOut, QB, 2);
      screenToFaceUV(tbx - nx * wIn, tby - ny * wIn, QB, 4);
      screenToFaceUV(tax - nx * wIn, tay - ny * wIn, QB, 6);
      ctx.moveTo(QB[0], QB[1]);
      ctx.lineTo(QB[2], QB[3]);
      ctx.lineTo(QB[4], QB[5]);
      ctx.lineTo(QB[6], QB[7]);
      ctx.closePath();
      n++;
    }
    if (n) { ctx.fill(); bands++; }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (st) { st.ops = fills + bands; st.fills = fills + bands; st.strokes = 0; st.draws = 0; }
}

// How many seam edges are there to band, and how many faces carry at least
// one?  Reported so the op count in the table can be read.
function seamBandCounts() {
  let edges = 0, faces = 0;
  for (let i = 0; i < nFaceVis; i++) {
    const n = faceSeamRuns(FORD[i]);
    if (n) { faces++; edges += n; }
  }
  return { edges, faces };
}

// =========================================================================
// (i) THE BAND FOLDED INTO THE POLYGON'S OWN PATH -- one fill, no extra op.
//
// (h) gives the band its own fill().  It does not need one.  Conflation only
// happens BETWEEN fills, so if the band is a subpath of the polygon's own path
// the two are rasterised as a single region with a single coverage -- there is
// no interior edge between them to conflate, and the extra operation goes
// away.  Two ways to say it:
//
//   'inline'    walk the polygon's own loop and, on a seam edge a->b, emit
//               a, a+n*w, b+n*w, b.  +2 vertices per seam edge, no extra
//               subpath.  This is the outset WITHOUT the re-intersection:
//               a and b never move, so the corners and the silhouette are
//               left exactly where they were.  Where two seam edges meet the
//               detour returns to the shared vertex, which cuts a notch of
//               depth w into the band at that corner.
//   'subpaths'  the polygon loop plus one band quad per seam edge, every
//               subpath wound the SAME way, one fill.  Nonzero fills the
//               union, so the quads' overlap covers the corner the notch
//               would have left -- at 4 vertices per seam edge instead of 2.
// =========================================================================
function drawPerFaceUnionBand(ctx, st, widthPx, mode, trim) {
  const inline = mode !== 'subpaths';
  ctx.fillStyle = cubePattern(ctx);
  let fills = 0, verts = 0;
  for (let i = 0; i < nFaceVis; i++) {
    const f = FORD[i];
    if (!faceAffine(f)) continue;
    const p = buildFacePathUV(f, 0);              // untouched quad, in UV
    const q = CUBE_F[f];
    const nSeam = faceSeamRuns(f);
    ctx.setTransform(CA[0], CA[1], CA[2], CA[3], CA[4], CA[5]);
    ctx.beginPath();
    if (!nSeam) {
      ctx.moveTo(p[0], p[1]); ctx.lineTo(p[2], p[3]);
      ctx.lineTo(p[4], p[5]); ctx.lineTo(p[6], p[7]);
      ctx.closePath();
      verts += 4;
      ctx.fill(); fills++;
      continue;
    }
    let cx = 0, cy = 0;
    for (let k = 0; k < 4; k++) { cx += SX[q[k]]; cy += SY[q[k]]; }
    cx *= 0.25; cy *= 0.25;
    const wOut = inline ? widthPx : widthPx * 0.5;
    const wIn = inline ? 0 : widthPx * 0.5;
    if (inline) {
      for (let e = 0; e < 4; e++) {
        if (e === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[e * 2], p[e * 2 + 1]);
        verts++;
        if (!SEAMSEL[e]) continue;
        const i0 = q[e], i1 = q[(e + 1) & 3];
        const ax = SX[i0], ay = SY[i0], bx = SX[i1], by = SY[i1];
        const ex = bx - ax, ey = by - ay, L = Math.hypot(ex, ey) || 1;
        let nx = ey / L, ny = -ex / L;
        if (nx * (ax - cx) + ny * (ay - cy) < 0) { nx = -nx; ny = -ny; }
        // The detour's ends are the one place the added strip has nothing over
        // it: a run ends on the silhouette, and past that corner the
        // neighbour has stopped.  Pull each free end back along the edge.
        let tax = ax, tay = ay, tbx = bx, tby = by;
        if (trim) {
          const ux = ex / L, uy = ey / L, t = widthPx * 0.5;
          if (!SEAMSEL[(e + 3) & 3]) { tax += ux * t; tay += uy * t; }
          if (!SEAMSEL[(e + 1) & 3]) { tbx -= ux * t; tby -= uy * t; }
        }
        screenToFaceUV(tax + nx * wOut, tay + ny * wOut, QB, 0);
        screenToFaceUV(tbx + nx * wOut, tby + ny * wOut, QB, 2);
        ctx.lineTo(QB[0], QB[1]); ctx.lineTo(QB[2], QB[3]);
        verts += 2;
      }
      ctx.closePath();
    } else {
      // the face loop first, then a quad per seam edge, all wound alike.  The
      // face is screen-CCW (FVIS keeps area > 0), so orient each quad to match.
      ctx.moveTo(p[0], p[1]); ctx.lineTo(p[2], p[3]);
      ctx.lineTo(p[4], p[5]); ctx.lineTo(p[6], p[7]);
      ctx.closePath();
      verts += 4;
      for (let e = 0; e < 4; e++) {
        if (!SEAMSEL[e]) continue;
        const i0 = q[e], i1 = q[(e + 1) & 3];
        const ax = SX[i0], ay = SY[i0], bx = SX[i1], by = SY[i1];
        const ex = bx - ax, ey = by - ay, L = Math.hypot(ex, ey) || 1;
        let nx = ey / L, ny = -ex / L;
        if (nx * (ax - cx) + ny * (ay - cy) < 0) { nx = -nx; ny = -ny; }
        const x0 = ax + nx * wOut, y0 = ay + ny * wOut;
        const x1 = bx + nx * wOut, y1 = by + ny * wOut;
        const x2 = bx - nx * wIn, y2 = by - ny * wIn;
        const x3 = ax - nx * wIn, y3 = ay - ny * wIn;
        // signed area in SCREEN space; reverse if it does not match the face
        const a2 = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
        if (a2 > 0) {
          screenToFaceUV(x0, y0, QB, 0); screenToFaceUV(x1, y1, QB, 2);
          screenToFaceUV(x2, y2, QB, 4); screenToFaceUV(x3, y3, QB, 6);
        } else {
          screenToFaceUV(x3, y3, QB, 0); screenToFaceUV(x2, y2, QB, 2);
          screenToFaceUV(x1, y1, QB, 4); screenToFaceUV(x0, y0, QB, 6);
        }
        ctx.moveTo(QB[0], QB[1]); ctx.lineTo(QB[2], QB[3]);
        ctx.lineTo(QB[4], QB[5]); ctx.lineTo(QB[6], QB[7]);
        ctx.closePath();
        verts += 4;
      }
    }
    ctx.fill(); fills++;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (st) { st.ops = fills; st.fills = fills; st.strokes = 0; st.verts = verts; }
}

// =========================================================================
// The eight-option comparison.
//
// Everything above explored the design space; these are the eight forms worth
// keeping, each named by what it actually does.  1-2 are unconditional (no
// adjacency and no depth test), 3-4 use the depth test but treat the whole
// boundary, 5-8 use both tests and treat only the shared edge.
//
//   1  stroke every edge of every polygon
//   2  expand every edge of every polygon
//   3  stroke every edge of the farther polygon
//   4  expand every edge of the farther polygon
//   5  stroke only the shared edge, on the farther polygon      = (g)
//   6  expand only the shared edge, by moving its vertices      = 4.8's outset
//   7  expand only the shared edge, by adding 2 offset vertices = (i) in-line
//   8  as 7, but place the added vertices along the NEIGHBOUR's adjacent
//      edge instead of along the shared edge's normal.  The band's corner
//      then lies on a line the neighbour itself owns, so it cannot poke past
//      the neighbour's outline -- which is what 7 pays for at a free end of a
//      run.  Where two shared edges meet it also mitres them together instead
//      of notching back to the shared vertex.
// =========================================================================
function faceHasLaterNeighbour(f) {
  for (let e = 0; e < 4; e++) {
    const nb = CUBE_ADJ[f][e];
    if (nb >= 0 && FVIS[nb] && FPOS[nb] > FPOS[f]) return true;
  }
  return false;
}

// 1 / 3: fill, then stroke the whole boundary.  farOnly gates on the face
// having something drawn later to conflate with.
function optStrokeAll(ctx, st, widthPx, farOnly) {
  const pat = cubePattern(ctx);
  ctx.fillStyle = pat;
  let fills = 0, strokes = 0;
  for (let i = 0; i < nFaceVis; i++) {
    const f = FORD[i];
    if (!faceAffine(f)) continue;
    const p = buildFacePathUV(f, 0);
    ctx.setTransform(CA[0], CA[1], CA[2], CA[3], CA[4], CA[5]);
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]); ctx.lineTo(p[2], p[3]);
    ctx.lineTo(p[4], p[5]); ctx.lineTo(p[6], p[7]);
    ctx.closePath();
    ctx.fill(); fills++;
    if (farOnly && !faceHasLaterNeighbour(f)) continue;
    ctx.setTransform(1, 0, 0, 1, 0, 0);      // screen space: device-px width
    const sp = seamPattern(ctx);
    if (PATTERN_SETTRANSFORM) {
      SEAMM.a = CA[0]; SEAMM.b = CA[1]; SEAMM.c = CA[2];
      SEAMM.d = CA[3]; SEAMM.e = CA[4]; SEAMM.f = CA[5];
      sp.setTransform(SEAMM);
    }
    ctx.strokeStyle = sp;
    ctx.lineWidth = widthPx; ctx.lineJoin = 'miter'; ctx.miterLimit = 10;
    const q = CUBE_F[f];
    ctx.beginPath();
    ctx.moveTo(SX[q[0]], SY[q[0]]);
    for (let k = 1; k < 4; k++) ctx.lineTo(SX[q[k]], SY[q[k]]);
    ctx.closePath();
    ctx.stroke(); strokes++;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineWidth = 1;
  if (st) { st.ops = fills + strokes; st.fills = fills; st.strokes = strokes; }
}

// 2 / 4: expand every edge, by moving vertices (re-intersecting)
function optExpandAll(ctx, st, widthPx, farOnly) {
  ctx.fillStyle = cubePattern(ctx);
  let fills = 0;
  for (let i = 0; i < nFaceVis; i++) {
    const f = FORD[i];
    if (!faceAffine(f)) continue;
    const grow = (!farOnly || faceHasLaterNeighbour(f)) ? widthPx : 0;
    const p = buildFacePathUV(f, grow, true);
    ctx.setTransform(CA[0], CA[1], CA[2], CA[3], CA[4], CA[5]);
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]); ctx.lineTo(p[2], p[3]);
    ctx.lineTo(p[4], p[5]); ctx.lineTo(p[6], p[7]);
    ctx.closePath();
    ctx.fill(); fills++;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (st) { st.ops = fills; st.fills = fills; st.strokes = 0; }
}

// The neighbour's OTHER edge at each end of a shared edge.  The neighbour
// traverses the shared edge backwards (b then a), so after a comes qn[ia+1]
// and before b comes qn[ib-1]; both point into the neighbour's own footprint.
const NBV = new Int32Array(2);
function nbAdjacent(f, e) {
  const q = CUBE_F[f], nb = CUBE_ADJ[f][e];
  if (nb < 0) return false;
  const qn = CUBE_F[nb];
  const a = q[e], b = q[(e + 1) & 3];
  let ia = -1, ib = -1;
  for (let k = 0; k < 4; k++) { if (qn[k] === a) ia = k; else if (qn[k] === b) ib = k; }
  if (ia < 0 || ib < 0) return false;
  NBV[0] = qn[(ia + 1) & 3];
  NBV[1] = qn[(ib + 3) & 3];
  return true;
}

// Intersect the line through (px,py) along (dx,dy) with the line parallel to
// the shared edge and offset outward by w.  Travel is clamped, so a direction
// nearly parallel to the edge cannot send the vertex to infinity.
const BC = new Float64Array(2);
function bandCorner(px, py, dx, dy, ax, ay, nx, ny, w, limit) {
  const dn = dx * nx + dy * ny;
  if (Math.abs(dn) < 1e-6) { BC[0] = px + nx * w; BC[1] = py + ny * w; return; }
  const need = w - ((px - ax) * nx + (py - ay) * ny);
  let t = need / dn;
  const L = Math.hypot(dx, dy) || 1;
  const cap = limit * w / L;
  if (t > cap) t = cap; else if (t < 0) t = 0;
  BC[0] = px + dx * t; BC[1] = py + dy * t;
}

// 8: in-line vertices, placed along the neighbour's adjacent edges
function optNeighbourBand(ctx, st, widthPx, limit) {
  ctx.fillStyle = cubePattern(ctx);
  const lim = limit || 4;
  let fills = 0, verts = 0;
  for (let i = 0; i < nFaceVis; i++) {
    const f = FORD[i];
    if (!faceAffine(f)) continue;
    const p = buildFacePathUV(f, 0);
    const q = CUBE_F[f];
    const nSeam = faceSeamRuns(f);
    let cx = 0, cy = 0;
    for (let k = 0; k < 4; k++) { cx += SX[q[k]]; cy += SY[q[k]]; }
    cx *= 0.25; cy *= 0.25;
    ctx.setTransform(CA[0], CA[1], CA[2], CA[3], CA[4], CA[5]);
    ctx.beginPath();
    for (let e = 0; e < 4; e++) {
      if (e === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[e * 2], p[e * 2 + 1]);
      verts++;
      if (!nSeam || !SEAMSEL[e]) continue;
      const ax = SX[q[e]], ay = SY[q[e]];
      const bx = SX[q[(e + 1) & 3]], by = SY[q[(e + 1) & 3]];
      const ex = bx - ax, ey = by - ay, L = Math.hypot(ex, ey) || 1;
      let nx = ey / L, ny = -ex / L;
      if (nx * (ax - cx) + ny * (ay - cy) < 0) { nx = -nx; ny = -ny; }
      let dax = nx, day = ny, dbx = nx, dby = ny;
      if (nbAdjacent(f, e)) {
        dax = SX[NBV[0]] - ax; day = SY[NBV[0]] - ay;
        dbx = SX[NBV[1]] - bx; dby = SY[NBV[1]] - by;
      }
      bandCorner(ax, ay, dax, day, ax, ay, nx, ny, widthPx, lim);
      screenToFaceUV(BC[0], BC[1], QB, 0);
      bandCorner(bx, by, dbx, dby, ax, ay, nx, ny, widthPx, lim);
      screenToFaceUV(BC[0], BC[1], QB, 2);
      ctx.lineTo(QB[0], QB[1]); ctx.lineTo(QB[2], QB[3]);
      verts += 2;
    }
    ctx.closePath();
    ctx.fill(); fills++;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (st) { st.ops = fills; st.fills = fills; st.strokes = 0; st.verts = verts; }
}

// 8b: option 8, applied only where its premise holds.
//
// Option 8 places an added vertex along the NEIGHBOUR's other edge at that
// corner.  At a free end of a run of shared edges that is exactly right: the
// neighbour's other edge is a real, different edge, so the corner lands on a
// line the neighbour owns and cannot poke past it.  At a vertex INTERIOR to a
// run it is wrong: the neighbour's other edge there IS the next shared edge,
// so the direction is tangential and the band never reaches outward -- 19.39
// px2 of gap on S14, one deficit per interior vertex.
//
// So: neighbour direction at the ends, ordinary mitre (intersect the two
// offset lines) in between.  Mitring also merges consecutive band segments
// into a single chain, so a run of k edges costs k+1 added vertices rather
// than 2k, and the notch at the shared vertex disappears with them.
const EN = new Float64Array(8), EC = new Float64Array(4);   // per-edge normal, offset line
const OUTV = new Float64Array(48);
function edgeLines(f, widthPx, cx, cy) {
  const q = CUBE_F[f];
  for (let e = 0; e < 4; e++) {
    const ax = SX[q[e]], ay = SY[q[e]];
    const ex = SX[q[(e + 1) & 3]] - ax, ey = SY[q[(e + 1) & 3]] - ay;
    const L = Math.hypot(ex, ey) || 1;
    let nx = ey / L, ny = -ex / L;
    if (nx * (ax - cx) + ny * (ay - cy) < 0) { nx = -nx; ny = -ny; }
    EN[e * 2] = nx; EN[e * 2 + 1] = ny;
    EC[e] = nx * ax + ny * ay + widthPx;
  }
}
function optNeighbourBandMitred(ctx, st, widthPx, limit) {
  ctx.fillStyle = cubePattern(ctx);
  const lim = limit || 4;
  let fills = 0, verts = 0;
  for (let i = 0; i < nFaceVis; i++) {
    const f = FORD[i];
    if (!faceAffine(f)) continue;
    const p = buildFacePathUV(f, 0);
    const q = CUBE_F[f];
    const nSeam = faceSeamRuns(f);
    ctx.setTransform(CA[0], CA[1], CA[2], CA[3], CA[4], CA[5]);
    if (!nSeam || nSeam === 4) {
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]); ctx.lineTo(p[2], p[3]);
      ctx.lineTo(p[4], p[5]); ctx.lineTo(p[6], p[7]);
      ctx.closePath();
      ctx.fill(); fills++; verts += 4;
      continue;
    }
    let cx = 0, cy = 0;
    for (let k = 0; k < 4; k++) { cx += SX[q[k]]; cy += SY[q[k]]; }
    cx *= 0.25; cy *= 0.25;
    edgeLines(f, widthPx, cx, cy);
    // a vertex interior to a run has a shared edge on both sides
    const interior = (v) => SEAMSEL[(v + 3) & 3] === 1 && SEAMSEL[v] === 1;
    let start = -1;
    for (let v = 0; v < 4; v++) if (!interior(v)) { start = v; break; }
    let n = 0;
    const push = (x, y) => { OUTV[n * 2] = x; OUTV[n * 2 + 1] = y; n++; };
    const corner = (v) => {
      const prev = (v + 3) & 3;
      const ps = SEAMSEL[prev] === 1, cs = SEAMSEL[v] === 1;
      if (ps && cs) {                                   // mitre the two bands
        const a1 = EN[prev * 2], b1 = EN[prev * 2 + 1], c1 = EC[prev];
        const a2 = EN[v * 2], b2 = EN[v * 2 + 1], c2 = EC[v];
        const det = a1 * b2 - a2 * b1;
        if (Math.abs(det) < 1e-9) { push(SX[q[v]] + a2 * widthPx, SY[q[v]] + b2 * widthPx); return; }
        let x = (c1 * b2 - c2 * b1) / det, y = (a1 * c2 - a2 * c1) / det;
        const dx = x - SX[q[v]], dy = y - SY[q[v]], L = Math.hypot(dx, dy), cap = lim * widthPx;
        if (L > cap && L > 0) { x = SX[q[v]] + dx * cap / L; y = SY[q[v]] + dy * cap / L; }
        push(x, y); return;
      }
      // free end: follow the neighbour's other edge at this corner
      const e = cs ? v : prev;
      const nx = EN[e * 2], ny = EN[e * 2 + 1];
      const ax = SX[q[e]], ay = SY[q[e]];
      let dx = nx, dy = ny;
      if (nbAdjacent(f, e)) {
        const w2 = cs ? NBV[0] : NBV[1];
        dx = SX[w2] - SX[q[v]]; dy = SY[w2] - SY[q[v]];
      }
      bandCorner(SX[q[v]], SY[q[v]], dx, dy, ax, ay, nx, ny, widthPx, lim);
      push(BC[0], BC[1]);
    };
    for (let k = 0; k < 4; k++) {
      const v = (start + k) & 3;
      if (interior(v)) continue;                        // no notch back to it
      push(SX[q[v]], SY[q[v]]);
      if (SEAMSEL[v]) {
        let len = 0;
        while (SEAMSEL[(v + len) & 3]) len++;
        for (let j = 0; j <= len; j++) corner((v + j) & 3);
      }
    }
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      screenToFaceUV(OUTV[k * 2], OUTV[k * 2 + 1], QB, 0);
      if (k === 0) ctx.moveTo(QB[0], QB[1]); else ctx.lineTo(QB[0], QB[1]);
    }
    ctx.closePath();
    ctx.fill(); fills++; verts += n;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (st) { st.ops = fills; st.fills = fills; st.strokes = 0; st.verts = verts; }
}
