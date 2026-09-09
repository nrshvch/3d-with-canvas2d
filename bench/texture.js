// ---------------------------------------------------------------------------
// texture.js -- how do you actually get a texture onto a triangle in canvas2d,
// and what does each way cost?
//
// The conventional recipe is save + clip(triangle) + setTransform(UV->screen)
// + drawImage + restore, once per triangle.  There is a second recipe that is
// rarely used: set the context transform to the UV->screen map, build the
// path in TEXTURE space, and fill it with a CanvasPattern.  That one needs no
// clip and no save/restore -- and because it is an ordinary fill(), every
// batching trick from the flat-colour case still applies to it.
//
// Loaded by texpage.html.
// ---------------------------------------------------------------------------
'use strict';

const TEX_SIZE = 256;
const TEXTURE = (function () {
  const c = document.createElement('canvas');
  c.width = c.height = TEX_SIZE;
  const x = c.getContext('2d');
  for (let j = 0; j < 16; j++) {
    for (let i = 0; i < 16; i++) {
      const v = ((i ^ j) & 1) ? 210 : 60;
      x.fillStyle = 'rgb(' + (v + (i * 3 | 0)) + ',' + (v - (j * 2 | 0)) + ',' + (255 - v) + ')';
      x.fillRect(i * 16, j * 16, 16, 16);
    }
  }
  x.strokeStyle = 'rgba(255,255,255,0.5)';
  x.lineWidth = 1;
  for (let i = 0; i <= 16; i++) {
    x.beginPath(); x.moveTo(i * 16, 0); x.lineTo(i * 16, TEX_SIZE); x.stroke();
    x.beginPath(); x.moveTo(0, i * 16); x.lineTo(TEX_SIZE, i * 16); x.stroke();
  }
  return c;
})();

// --- a grid of quads, each split into two triangles, with UVs ---------------
// Screen positions are precomputed so nothing is solved inside the timed loop
// except the affine map itself.
const TN = 24;                                  // TN x TN quads
const QUADS = TN * TN;
const TRIS = QUADS * 2;
const TXY = new Float32Array(TRIS * 6);         // screen x,y per triangle
const TUV = new Float32Array(TRIS * 6);         // texture u,v per triangle
(function () {
  const W = 1000, H = 620, cell = Math.min(W / TN, H / TN);
  let t = 0;
  for (let j = 0; j < TN; j++) {
    for (let i = 0; i < TN; i++) {
      // a mild perspective-ish warp so the affine maps are not all identical
      const k = 1 + 0.35 * (j / TN);
      const x0 = 20 + i * cell * k, y0 = 20 + j * cell;
      const x1 = 20 + (i + 1) * cell * k, y1 = y0;
      const x2 = 20 + (i + 1) * cell * k, y2 = y0 + cell;
      const x3 = 20 + i * cell * k, y3 = y0 + cell;
      const u0 = (i / TN) * TEX_SIZE, v0 = (j / TN) * TEX_SIZE;
      const u1 = ((i + 1) / TN) * TEX_SIZE, v1 = v0;
      const u2 = u1, v2 = ((j + 1) / TN) * TEX_SIZE;
      const u3 = u0, v3 = v2;
      TXY.set([x0, y0, x1, y1, x2, y2], t * 6); TUV.set([u0, v0, u1, v1, u2, v2], t * 6); t++;
      TXY.set([x0, y0, x2, y2, x3, y3], t * 6); TUV.set([u0, v0, u2, v2, u3, v3], t * 6); t++;
    }
  }
})();

// --- solve the affine map taking (u,v) -> (x,y) for one triangle ------------
const AFF = new Float64Array(6);
function affineFor(t) {
  const o = t * 6;
  const u0 = TUV[o], v0 = TUV[o + 1], u1 = TUV[o + 2], v1 = TUV[o + 3], u2 = TUV[o + 4], v2 = TUV[o + 5];
  const x0 = TXY[o], y0 = TXY[o + 1], x1 = TXY[o + 2], y1 = TXY[o + 3], x2 = TXY[o + 4], y2 = TXY[o + 5];
  const du0 = u0 - u2, du1 = u1 - u2, dv0 = v0 - v2, dv1 = v1 - v2;
  const den = du0 * dv1 - du1 * dv0;
  if (den === 0) { AFF[0] = 1; AFF[1] = 0; AFF[2] = 0; AFF[3] = 1; AFF[4] = 0; AFF[5] = 0; return false; }
  const inv = 1 / den;
  const dx0 = x0 - x2, dx1 = x1 - x2, dy0 = y0 - y2, dy1 = y1 - y2;
  const a = (dx0 * dv1 - dx1 * dv0) * inv;
  const c = (du0 * dx1 - du1 * dx0) * inv;
  const b = (dy0 * dv1 - dy1 * dv0) * inv;
  const d = (du0 * dy1 - du1 * dy0) * inv;
  AFF[0] = a; AFF[1] = b; AFF[2] = c; AFF[3] = d;
  AFF[4] = x2 - a * u2 - c * v2;
  AFF[5] = y2 - b * u2 - d * v2;
  return true;
}

let PATTERN = null;
function pattern(ctx) {
  if (!PATTERN) PATTERN = ctx.createPattern(TEXTURE, 'no-repeat');
  return PATTERN;
}

const TEXMICRO = {
  // ---- the conventional recipe -------------------------------------------
  'tex: clip + drawImage  per tri': function (ctx) {
    for (let t = 0; t < TRIS; t++) {
      const o = t * 6;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(TXY[o], TXY[o + 1]); ctx.lineTo(TXY[o + 2], TXY[o + 3]); ctx.lineTo(TXY[o + 4], TXY[o + 5]);
      ctx.clip();
      affineFor(t);
      ctx.setTransform(AFF[0], AFF[1], AFF[2], AFF[3], AFF[4], AFF[5]);
      ctx.drawImage(TEXTURE, 0, 0);
      ctx.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  },
  // how much of that is the clip?
  'tex: drawImage only (no clip)': function (ctx) {
    for (let t = 0; t < TRIS; t++) {
      affineFor(t);
      ctx.setTransform(AFF[0], AFF[1], AFF[2], AFF[3], AFF[4], AFF[5]);
      ctx.drawImage(TEXTURE, 0, 0);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  },
  // how much is the save/restore?
  'tex: clip only (no drawImage)': function (ctx) {
    for (let t = 0; t < TRIS; t++) {
      const o = t * 6;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(TXY[o], TXY[o + 1]); ctx.lineTo(TXY[o + 2], TXY[o + 3]); ctx.lineTo(TXY[o + 4], TXY[o + 5]);
      ctx.clip();
      ctx.restore();
    }
  },
  // ---- the pattern recipe: path in TEXTURE space, no clip ----------------
  'tex: pattern fill  per tri': function (ctx) {
    const p = pattern(ctx);
    ctx.fillStyle = p;
    for (let t = 0; t < TRIS; t++) {
      const o = t * 6;
      affineFor(t);
      ctx.setTransform(AFF[0], AFF[1], AFF[2], AFF[3], AFF[4], AFF[5]);
      ctx.beginPath();
      ctx.moveTo(TUV[o], TUV[o + 1]); ctx.lineTo(TUV[o + 2], TUV[o + 3]); ctx.lineTo(TUV[o + 4], TUV[o + 5]);
      ctx.fill();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  },
  // ---- merged: N triangles under ONE transform and ONE fill -------------
  // The upper bound on what coplanar merging can buy: every quad's two
  // triangles do share one affine map here, so pair them up.
  'tex: pattern fill  per QUAD (2 tri)': function (ctx) {
    const p = pattern(ctx);
    ctx.fillStyle = p;
    for (let q = 0; q < QUADS; q++) {
      const t = q * 2, o = t * 6, o2 = (t + 1) * 6;
      affineFor(t);
      ctx.setTransform(AFF[0], AFF[1], AFF[2], AFF[3], AFF[4], AFF[5]);
      ctx.beginPath();
      // boundary of the merged quad in texture space: the shared diagonal is
      // gone, so it is 4 vertices rather than 2x3
      ctx.moveTo(TUV[o], TUV[o + 1]);
      ctx.lineTo(TUV[o + 2], TUV[o + 3]);
      ctx.lineTo(TUV[o + 4], TUV[o + 5]);
      ctx.lineTo(TUV[o2 + 4], TUV[o2 + 5]);
      ctx.fill();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  },
  // one transform, one fill, MANY subpaths -- only legal when the affine maps
  // agree, which they do not here; timed purely as the ceiling
  'tex: pattern 1 fill / row (CEILING)': function (ctx) {
    const p = pattern(ctx);
    ctx.fillStyle = p;
    for (let j = 0; j < TN; j++) {
      affineFor(j * TN * 2);
      ctx.setTransform(AFF[0], AFF[1], AFF[2], AFF[3], AFF[4], AFF[5]);
      ctx.beginPath();
      for (let i = 0; i < TN; i++) {
        const t = (j * TN + i) * 2, o = t * 6, o2 = (t + 1) * 6;
        ctx.moveTo(TUV[o], TUV[o + 1]);
        ctx.lineTo(TUV[o + 2], TUV[o + 3]);
        ctx.lineTo(TUV[o + 4], TUV[o + 5]);
        ctx.lineTo(TUV[o2 + 4], TUV[o2 + 5]);
      }
      ctx.fill();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  },
  'tex: pattern 1 fill TOTAL (CEILING)': function (ctx) {
    const p = pattern(ctx);
    ctx.fillStyle = p;
    affineFor(0);
    ctx.setTransform(AFF[0], AFF[1], AFF[2], AFF[3], AFF[4], AFF[5]);
    ctx.beginPath();
    for (let q = 0; q < QUADS; q++) {
      const t = q * 2, o = t * 6, o2 = (t + 1) * 6;
      ctx.moveTo(TUV[o], TUV[o + 1]);
      ctx.lineTo(TUV[o + 2], TUV[o + 3]);
      ctx.lineTo(TUV[o + 4], TUV[o + 5]);
      ctx.lineTo(TUV[o2 + 4], TUV[o2 + 5]);
    }
    ctx.fill();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  },
  // ---- does mutating one pattern's transform work / cost? ---------------
  'tex: pattern.setTransform per tri': function (ctx) {
    const p = pattern(ctx);
    ctx.fillStyle = p;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const m = new DOMMatrix();
    for (let t = 0; t < TRIS; t++) {
      const o = t * 6;
      affineFor(t);
      m.a = AFF[0]; m.b = AFF[1]; m.c = AFF[2]; m.d = AFF[3]; m.e = AFF[4]; m.f = AFF[5];
      p.setTransform(m);
      ctx.beginPath();
      ctx.moveTo(TXY[o], TXY[o + 1]); ctx.lineTo(TXY[o + 2], TXY[o + 3]); ctx.lineTo(TXY[o + 4], TXY[o + 5]);
      ctx.fill();
    }
  },
  // ---- flat-colour reference, same geometry -----------------------------
  'tex: flat colour fill per tri (ref)': function (ctx) {
    ctx.fillStyle = '#88aa55';
    for (let t = 0; t < TRIS; t++) {
      const o = t * 6;
      ctx.beginPath();
      ctx.moveTo(TXY[o], TXY[o + 1]); ctx.lineTo(TXY[o + 2], TXY[o + 3]); ctx.lineTo(TXY[o + 4], TXY[o + 5]);
      ctx.fill();
    }
  }
};
