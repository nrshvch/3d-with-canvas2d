// node bench/fog.js [--far] [--radial]
// ---------------------------------------------------------------------------
// FOG IN A DEFERRED CANVAS2D PIPELINE: five architectures, priced.
//
// The pipeline under test is a deferred one: an albedo pass, a shading pass
// MULTIPLIED over it (which also softens the conflation seams, §4.4), and then
// fog.  Fog as usually written costs two more geometry passes and a composite
// chain, and one link in that chain -- inverting the depth map, whether by
// `globalCompositeOperation = 'difference'` or by `ctx.filter = 'invert(1)'` --
// is not on Firefox's accelerated list at all (§3.2), so it demotes the canvas
// to software permanently.
//
// The old-school answer is to stop computing fog in SCREEN space and compute it
// in COLOUR space: Doom's COLORMAP, Quake's light levels, PS1 depth cueing.
// Quantise depth into B bands per face and look the fogged colour up in a
// pregenerated palette.  Fog then costs zero canvas operations -- but in THIS
// renderer the batcher merges faces by colour, so fog bands split batches.
//
// What decides it is that each pass is coloured by a DIFFERENT key, and the
// keys have very different cardinalities:
//
//     albedo pass       material            (8 here)
//     shading pass      shade level         (24 here)
//     fog keep/add      fog band alone      (B)          <- batches to ~B fills
//     folded            material x shade x fog band      <- the expensive one
//
// A fog pass coloured by band ALONE is nearly free in draw calls. That is the
// number that decides the architecture, and it is not obvious from the API.
//
// Cost is reported as fills and vertices, plus the record-stage cost predicted
// by the coefficients measured in 1.1, so the architectures are comparable in
// one number.  Composite cost is NOT included here -- it is engine-side and
// needs a browser; see bench/fogpage.html.
// ---------------------------------------------------------------------------
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const sb = { performance: { now: () => Number(process.hrtime.bigint()) / 1e6 }, console, Math, Date };
vm.createContext(sb);
const FRONT = !process.argv.includes('--far');
function patch(src, from, to, why) {
  if (src.indexOf(from) < 0) throw new Error('could not patch: ' + why);
  return src.replace(from, to);
}
for (const f of ['mesh.js', 'scene.js', 'render.js']) {
  let src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  if (FRONT && f === 'scene.js')
    src = patch(src, 'if (area <= 0) continue;', 'if (area >= 0) continue;', 'backface sign');
  // NOTE: render.js's batch-colour index used to be Uint8 and had to be
  // widened here, because folding fog into the colour exceeds 256 colours and
  // a Uint8 index truncates SILENTLY -- the write is swallowed and the batcher
  // then emits nothing at all.  render.js now carries Int32 at source, so
  // there is nothing to patch; the assertion in pass() is the remaining guard.
  vm.runInContext(src, sb, { filename: f });
}
const { makeTorusKnot, makeSphere, makeGrid, makeInstances, Scene, Renderer, Stats } = sb;

const W = 1280, H = 720;
const ANG = [0.4, 0.9, 0.13, 3.1, 620];
const RADIAL = process.argv.includes('--radial');
const FOG_RGB = [90, 105, 130];
const BANDS = process.argv.includes('--sweep') ? [2, 4, 8, 16, 32, 64] : [8, 16, 32];

// record-stage coefficients, measured (§1.1). us per fill, us per vertex.
const COEF = { chromium: [0.26, 0.009], firefox: [0.65, 0.007] };
const predict = (fills, verts, e) => fills * COEF[e][0] + verts * COEF[e][1];

// ---------------------------------------------------------------------------
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

// Batch + emit with a substituted per-triangle colour key, densified first so
// the key's *cardinality* is what matters and not its numeric range.
function pass(scene, key) {
  const n = scene.nVis, order = scene.order;
  const dense = new Int32Array(scene.m.nt), seen = new Map();
  for (let i = 0; i < n; i++) {
    const t = order[i], k = key[t];
    let v = seen.get(k);
    if (v === undefined) { v = seen.size; seen.set(k, v); }
    dense[t] = v;
  }
  if (seen.size > (1 << 16)) throw new Error('colour cardinality overflow');
  const save = scene.col;
  scene.col = dense;
  const R = new Renderer(scene, 4);
  R.setTile(4); R.batchGridExact();
  const c = new CountCtx(), st = new Stats();
  R.emitBoundary(c, st, true, 2);
  scene.col = save;
  c.colours = seen.size;
  return c;
}

// ---------------------------------------------------------------------------
function densityAt(vz, sxp, syp, zr) {
  if (!RADIAL) {
    const t = (vz - zr.near) / (zr.far - zr.near);
    return t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const dx = (sxp - zr.cx) * vz / zr.scale, dy = (syp - zr.cy) * vz / zr.scale;
  const dz = vz - zr.cz;
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz) / zr.radius;
  return r < 0 ? 0 : r > 1 ? 1 : r;
}

// ---------------------------------------------------------------------------
// banding quality: exact per-PIXEL fog (perspective-correct) against the
// per-FACE band the palette approach is forced to use.
// ---------------------------------------------------------------------------
const owner = new Int32Array(W * H), exactD = new Float32Array(W * H);
function ownerPass(scene, zr) {
  const idx = scene.m.idx, sx = scene.sx, sy = scene.sy, sz = scene.sz;
  const order = scene.order, n = scene.nVis;
  owner.fill(-1);
  for (let i = n - 1; i >= 0; i--) {
    const t = order[i];
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    let ax = sx[a], ay = sy[a], bx = sx[b], by = sy[b], cx = sx[c], cy = sy[c];
    let iwa = 1 / sz[a], iwb = 1 / sz[b], iwc = 1 / sz[c];
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < 0) {
      let q = bx; bx = cx; cx = q; q = by; by = cy; cy = q; q = iwb; iwb = iwc; iwc = q;
    }
    const A2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (A2 === 0) continue;
    const iA2 = 1 / A2;
    let X0 = Math.floor(Math.min(ax, bx, cx)); if (X0 < 0) X0 = 0;
    let X1 = Math.ceil(Math.max(ax, bx, cx)); if (X1 > W - 1) X1 = W - 1;
    let Y0 = Math.floor(Math.min(ay, by, cy)); if (Y0 < 0) Y0 = 0;
    let Y1 = Math.ceil(Math.max(ay, by, cy)); if (Y1 > H - 1) Y1 = H - 1;
    if (X1 < X0 || Y1 < Y0) continue;
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
          const p = row + x;
          if (owner[p] === -1) {
            owner[p] = t;
            exactD[p] = densityAt(1 / ((f1 * iwa + f2 * iwb + f0 * iwc) * iA2),
                                  x + 0.5, y + 0.5, zr);
          }
        }
        f0 += dx0; f1 += dx1; f2 += dx2;
      }
      r0 += dy0; r1 += dy1; r2 += dy2;
    }
  }
}
function bandError(scene, bandOf, B) {
  const pal = scene.palRGB;
  let cnt = 0, sq = 0, maxd = 0, g8 = 0, g16 = 0;
  for (let p = 0; p < W * H; p++) {
    const t = owner[p];
    if (t < 0) continue;
    cnt++;
    const ci = scene.col[t] * 3, de = exactD[p];
    const db = B <= 1 ? 0 : bandOf[t] / (B - 1);
    let d = 0;
    for (let k = 0; k < 3; k++) {
      const base = pal[ci + k];
      const e = Math.abs((base * (1 - de) + FOG_RGB[k] * de) -
                         (base * (1 - db) + FOG_RGB[k] * db));
      if (e > d) d = e;
    }
    sq += d * d; if (d > maxd) maxd = d;
    if (d > 8) g8++;
    if (d > 16) g16++;
  }
  return { rmse: Math.sqrt(sq / cnt), maxd, g8: 100 * g8 / cnt, g16: 100 * g16 / cnt };
}

// ---------------------------------------------------------------------------
const sp2 = makeSphere(96, 48, 4);
const scenes = [
  ['torusKnot', makeTorusKnot(512, 64, 3, 7, 8), 24, 8, ANG],
  ['grid', makeGrid(180, 4), 24, 4, ANG],
  ['sphere', makeSphere(256, 128, 4), 24, 4, ANG],
  ['5deep', makeInstances(sp2, [
    [0, 0, -2.2], [0, 0, -1.1], [0, 0, 0], [0, 0, 1.1], [0, 0, 2.2]]),
    24, 4, [0.4, 0.9, 0.13, 6.5, 900]]
];

console.log('fog ' + (RADIAL ? 'RADIAL about a world point' : 'LINEAR in view depth') +
  ',  tint rgb(' + FOG_RGB.join(',') + '),  ' + W + 'x' + H +
  ',  ' + (FRONT ? 'near' : 'far') + ' sheet');
console.log('\ncomposites:  M = multiply   L = lighter (OP_ADD)   ' +
  'X = invert, NOT accelerated in Firefox (demotes the canvas)');

for (const [nm, mesh, shades, matBands, ang] of scenes) {
  const scene = new Scene(mesh, W, H, shades, matBands);
  scene.build.apply(scene, ang);
  const n = scene.nVis, idx = mesh.idx, sz = scene.sz, nt = mesh.nt;

  const fz = new Float32Array(nt), fx = new Float32Array(nt), fy = new Float32Array(nt);
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = scene.order[i];
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    fz[t] = (sz[a] + sz[b] + sz[c]) / 3;
    fx[t] = (scene.sx[a] + scene.sx[b] + scene.sx[c]) / 3;
    fy[t] = (scene.sy[a] + scene.sy[b] + scene.sy[c]) / 3;
    if (fz[t] < zmin) zmin = fz[t];
    if (fz[t] > zmax) zmax = fz[t];
  }
  const zr = { near: zmin, far: zmax, cx: W * 0.5, cy: H * 0.5,
               cz: (zmin + zmax) * 0.5, scale: ang[4], radius: (zmax - zmin) * 0.75 };
  ownerPass(scene, zr);

  // the two passes the engine already draws, keyed the way it actually keys them
  const matKey = new Int32Array(nt), shKey = new Int32Array(nt);
  for (let i = 0; i < n; i++) {
    const t = scene.order[i];
    matKey[t] = (scene.col[t] / shades) | 0;
    shKey[t] = scene.col[t] % shades;
  }
  const pAlbedo = pass(scene, matKey);
  const pShade = pass(scene, shKey);
  const noFog = { fills: pAlbedo.fills + pShade.fills, verts: pAlbedo.verts + pShade.verts };

  console.log('\n=== ' + nm + '   visible ' + n +
    '   albedo ' + pAlbedo.fills + 'f/' + pAlbedo.verts + 'v (' + pAlbedo.colours + ' col)' +
    '   shade ' + pShade.fills + 'f/' + pShade.verts + 'v (' + pShade.colours + ' col)');

  const bandOf = new Uint8Array(nt);
  for (const B of BANDS) {
    for (let i = 0; i < n; i++) {
      const t = scene.order[i];
      const d = densityAt(fz[t], fx[t], fy[t], zr);
      let b = (d * (B - 1) + 0.5) | 0;
      if (b > B - 1) b = B - 1;
      bandOf[t] = b;
    }
    const fogKey = new Int32Array(nt), shFogKey = new Int32Array(nt), allKey = new Int32Array(nt);
    for (let i = 0; i < n; i++) {
      const t = scene.order[i];
      fogKey[t] = bandOf[t];
      shFogKey[t] = shKey[t] * B + bandOf[t];
      allKey[t] = (matKey[t] * shades + shKey[t]) * B + bandOf[t];
    }
    const pFog = pass(scene, fogKey);
    const pShFog = pass(scene, shFogKey);
    const pAll = pass(scene, allKey);
    const q = bandError(scene, bandOf, B);

    // --- the five architectures ------------------------------------------
    // out = albedo*shade*(1-d) + fog*d.  A derives the additive term from the
    // keep map by inverting it IN PLACE, which is why it needs only one fog
    // pass -- and why it beats B and C end to end despite `difference` being
    // off Firefox's accelerated list.  See 4.10.
    const arch = [
      ['A keep,invert,tint,add', [pAlbedo, pShade, pFog], 'M+X+tint+L', 3],
      ['B keep + add, 2 passes', [pAlbedo, pShade, pFog, pFog], 'M+M+L', 3],
      ['C keep in shade + add', [pAlbedo, pShFog, pFog], 'M + L', 2],
      ['D folded [needs FLAT albedo]', [pAll], '(none)', 0],
      ['E keep in shade [BLACK fog only]', [pAlbedo, pShFog], 'M', 1]
    ];
    console.log('  B=' + String(B).padEnd(4) +
      'RMSE ' + q.rmse.toFixed(2) + '  maxD ' + String(q.maxd | 0).padStart(3) +
      '  %>8 ' + q.g8.toFixed(2) + '  %>16 ' + q.g16.toFixed(2) +
      '   (fog pass: ' + pFog.fills + 'f/' + pFog.verts + 'v, ' + pFog.colours + ' col)');
    console.log('        ' + 'architecture'.padEnd(26) + 'fills'.padStart(7) +
      'verts'.padStart(9) + '   composite'.padEnd(14) +
      'rec.Cr'.padStart(8) + 'rec.Fx'.padStart(8) + '  vs no fog');
    for (const [name, passes, comp] of arch) {
      let f = 0, v = 0;
      for (const p of passes) { f += p.fills; v += p.verts; }
      const cr = predict(f, v, 'chromium'), fxp = predict(f, v, 'firefox');
      const cr0 = predict(noFog.fills, noFog.verts, 'chromium');
      const fx0 = predict(noFog.fills, noFog.verts, 'firefox');
      console.log('        ' + name.padEnd(26) + String(f).padStart(7) +
        String(v).padStart(9) + ('   ' + comp).padEnd(14) +
        (cr / 1000).toFixed(2).padStart(8) + (fxp / 1000).toFixed(2).padStart(8) +
        ('  ' + (cr / cr0).toFixed(2) + 'x / ' + (fxp / fx0).toFixed(2) + 'x').padStart(14));
    }
  }
}
console.log('\nrec.Cr / rec.Fx are PREDICTED record-stage ms from the §1.1 coefficients,');
console.log('geometry only -- composite cost is engine-side, see bench/fogpage.html.');
