// ---------------------------------------------------------------------------
// texplane.js -- merging coplanar textured triangles, and the constraint that
// decides how far you can go.
//
// THE CONSTRAINT.  ctx.setTransform() is AFFINE: six numbers, no perspective
// divide.  For a plane under perspective projection the exact texture->screen
// map is a HOMOGRAPHY, which is affine only where w is constant across the
// region.  So:
//
//   * two coplanar triangles can share one fill EXACTLY when their quad is a
//     parallelogram in screen space (w constant) -- then one affine map
//     reproduces both;
//   * otherwise merging is an APPROXIMATION whose error grows with the region,
//     and the merge test is "does one affine map fit this region within eps
//     pixels".
//
// That is the same shape as every other decision in this project: an error
// bound in pixels drives how aggressively you merge.  Realised here as an
// adaptive quadtree over texture space (classic affine subdivision), which for
// a regular grid is the efficient form of "grow a coplanar chart until the
// affine fit breaks".  Each leaf emits ONE fill: four vertices in texture
// space, one setTransform, no clip, no drawImage.
// ---------------------------------------------------------------------------
'use strict';

const PTEX = 512;
const PLANE_TEXTURE = (function () {
  const c = document.createElement('canvas');
  c.width = c.height = PTEX;
  const x = c.getContext('2d');
  for (let j = 0; j < 32; j++) for (let i = 0; i < 32; i++) {
    const v = ((i ^ j) & 1) ? 205 : 55;
    x.fillStyle = 'rgb(' + v + ',' + (v * 0.7 + 40 | 0) + ',' + (255 - v) + ')';
    x.fillRect(i * 16, j * 16, 16, 16);
  }
  x.fillStyle = '#fff';
  for (let j = 0; j < 32; j += 4) for (let i = 0; i < 32; i += 4) x.fillRect(i * 16 + 6, j * 16 + 6, 4, 4);
  return c;
})();

// --- the plane, and its exact texture->screen map ---------------------------
// Model: the unit square in the XZ plane, tilted, perspective projected.
// (u,v) in [0,PTEX]^2 maps linearly to the model square, so H(u,v) is exact.
const PW = 1280, PH = 720;
let PVIEW = null;
function setPlaneView(pitch, dist, scale, yaw) {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  PVIEW = { cp, sp, cy, sy, dist, scale };
}
setPlaneView(1.05, 2.4, 900, 0.35);

// exact projection of the surface point at texture coordinate (u,v)
const HP = new Float64Array(3);
function project(u, v) {
  const s = 2.6;
  const X = (u / PTEX - 0.5) * s, Z = (v / PTEX - 0.5) * s;
  const { cp, sp, cy, sy, dist, scale } = PVIEW;
  const x1 = X * cy + Z * sy, z1 = -X * sy + Z * cy;
  const y2 = -z1 * sp, z2 = z1 * cp + dist;
  const w = z2 <= 0.05 ? 0.05 : z2;
  const iw = scale / w;
  HP[0] = PW * 0.5 + x1 * iw;
  HP[1] = PH * 0.55 + y2 * iw;
  HP[2] = w;
  return HP;
}

// --- affine fit, exact at three texture points ------------------------------
function fitAffine(u0, v0, u1, v1, u2, v2, dst) {
  let p = project(u0, v0); const x0 = p[0], y0 = p[1];
  p = project(u1, v1); const x1 = p[0], y1 = p[1];
  p = project(u2, v2); const x2 = p[0], y2 = p[1];
  const du0 = u0 - u2, du1 = u1 - u2, dv0 = v0 - v2, dv1 = v1 - v2;
  const den = du0 * dv1 - du1 * dv0;
  if (!den) return false;
  const inv = 1 / den;
  const a = ((x0 - x2) * dv1 - (x1 - x2) * dv0) * inv;
  const c = (du0 * (x1 - x2) - du1 * (x0 - x2)) * inv;
  const b = ((y0 - y2) * dv1 - (y1 - y2) * dv0) * inv;
  const d = (du0 * (y1 - y2) - du1 * (y0 - y2)) * inv;
  dst[0] = a; dst[1] = b; dst[2] = c; dst[3] = d;
  dst[4] = x2 - a * u2 - c * v2;
  dst[5] = y2 - b * u2 - d * v2;
  return true;
}

// worst screen-space error of an affine map over a texture-space rectangle,
// sampled at the corners, edge midpoints and centre
const PROBE_U = [0, 1, 0, 1, 0.5, 0.5, 0, 1, 0.5];
const PROBE_V = [0, 0, 1, 1, 0, 1, 0.5, 0.5, 0.5];
function affineError(u0, v0, du, dv, A) {
  let worst = 0;
  for (let i = 0; i < 9; i++) {
    const u = u0 + PROBE_U[i] * du, v = v0 + PROBE_V[i] * dv;
    const p = project(u, v);
    const ex = A[0] * u + A[2] * v + A[4] - p[0];
    const ey = A[1] * u + A[3] * v + A[5] - p[1];
    const e = ex * ex + ey * ey;
    if (e > worst) worst = e;
  }
  return Math.sqrt(worst);
}

// --- adaptive subdivision: collect leaves whose affine fit is within eps ----
// Preallocated; recursion depth is bounded so a bad eps cannot hang.
const MAXLEAF = 1 << 16;
const LEAF_U = new Float32Array(MAXLEAF), LEAF_V = new Float32Array(MAXLEAF);
const LEAF_DU = new Float32Array(MAXLEAF), LEAF_DV = new Float32Array(MAXLEAF);
const LEAF_A = new Float64Array(MAXLEAF * 6);
const TMPA = new Float64Array(6);
let nLeaf = 0;

function subdivide(u0, v0, du, dv, eps, depth) {
  if (nLeaf >= MAXLEAF) return;
  // fit to three corners of this rectangle
  const ok = fitAffine(u0, v0, u0 + du, v0, u0, v0 + dv, TMPA);
  const err = ok ? affineError(u0, v0, du, dv, TMPA) : Infinity;
  if (!ok || (err > eps && depth < 9)) {
    const hu = du * 0.5, hv = dv * 0.5;
    subdivide(u0, v0, hu, hv, eps, depth + 1);
    subdivide(u0 + hu, v0, hu, hv, eps, depth + 1);
    subdivide(u0, v0 + hv, hu, hv, eps, depth + 1);
    subdivide(u0 + hu, v0 + hv, hu, hv, eps, depth + 1);
    return;
  }
  const i = nLeaf++;
  LEAF_U[i] = u0; LEAF_V[i] = v0; LEAF_DU[i] = du; LEAF_DV[i] = dv;
  for (let k = 0; k < 6; k++) LEAF_A[i * 6 + k] = TMPA[k];
}

function buildLeaves(eps) {
  nLeaf = 0;
  subdivide(0, 0, PTEX, PTEX, eps, 0);
  return nLeaf;
}

// --- uniform grids, for the "no merging" comparisons ------------------------
function buildUniform(n, perTriangle) {
  nLeaf = 0;
  const step = PTEX / n;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if (nLeaf + 2 > MAXLEAF) return nLeaf;
    const u = i * step, v = j * step;
    if (perTriangle) {
      // two triangles, each with its own exact-at-its-corners affine map
      for (const tri of [0, 1]) {
        const i2 = nLeaf++;
        LEAF_U[i2] = u; LEAF_V[i2] = v; LEAF_DU[i2] = step; LEAF_DV[i2] = -(tri + 1);
        fitAffine(u, v, u + step, v + (tri ? step : 0), u + (tri ? 0 : step), v + step, TMPA);
        for (let k = 0; k < 6; k++) LEAF_A[i2 * 6 + k] = TMPA[k];
      }
    } else {
      const i2 = nLeaf++;
      LEAF_U[i2] = u; LEAF_V[i2] = v; LEAF_DU[i2] = step; LEAF_DV[i2] = step;
      fitAffine(u, v, u + step, v, u, v + step, TMPA);
      for (let k = 0; k < 6; k++) LEAF_A[i2 * 6 + k] = TMPA[k];
    }
  }
  return nLeaf;
}

// --- emission ---------------------------------------------------------------
// One setTransform + one fill per leaf.  The path is in TEXTURE space, so the
// pattern needs no transform of its own and there is no clip anywhere.
let PPAT = null;
function planePattern(ctx) {
  if (!PPAT) PPAT = ctx.createPattern(PLANE_TEXTURE, 'no-repeat');
  return PPAT;
}

function emitLeaves(ctx, stats) {
  ctx.fillStyle = planePattern(ctx);
  let fills = 0, verts = 0;
  for (let i = 0; i < nLeaf; i++) {
    const u = LEAF_U[i], v = LEAF_V[i], du = LEAF_DU[i], dv = LEAF_DV[i];
    const o = i * 6;
    ctx.setTransform(LEAF_A[o], LEAF_A[o + 1], LEAF_A[o + 2], LEAF_A[o + 3], LEAF_A[o + 4], LEAF_A[o + 5]);
    ctx.beginPath();
    if (dv < 0) {                       // triangle leaf (dv encodes which half)
      const step = du;
      if (dv === -1) { ctx.moveTo(u, v); ctx.lineTo(u + step, v); ctx.lineTo(u, v + step); }
      else { ctx.moveTo(u + step, v); ctx.lineTo(u + step, v + step); ctx.lineTo(u, v + step); }
      verts += 3;
    } else {
      ctx.moveTo(u, v); ctx.lineTo(u + du, v); ctx.lineTo(u + du, v + dv); ctx.lineTo(u, v + dv);
      verts += 4;
    }
    ctx.fill();
    fills++;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (stats) { stats.fills = fills; stats.verts = verts; }
}
