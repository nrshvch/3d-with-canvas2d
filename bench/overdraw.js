// node bench/overdraw.js
// ---------------------------------------------------------------------------
// How much occlusion headroom is there, really?  No canvas, no browser.
//
// Rasterises every visible (post-backface, post-frustum) triangle at 1 sample
// per pixel in NEAR->FAR order and records, per triangle:
//     area[t]  samples the triangle covers at all
//     won[t]   samples where it is the nearest coverer  (= its contribution
//              to the final image under an exact painter)
//
// won[t] === 0 means the triangle is submitted, tessellated, scan-converted,
// blended -- and then completely painted over.  That is the headroom: the
// number an occlusion culler is trying to capture.  Everything else in this
// file is bookkeeping around those two arrays.
//
// The near->far walk uses the SAME centroid-z order the painter uses, so the
// answer is not "what would a perfect z-buffer cull" but the strictly smaller
// and more honest "what could a culler that trusts this sort cull".
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
const { makeTorusKnot, makeSphere, makeGrid, makeSoup, Mesh, buildAdjacency, Scene, Renderer, Stats } = sb;

const W = 1280, H = 720;
const ANG = [0.4, 0.9, 0.13, 3.1, 620];

// ---------------------------------------------------------------------------
// instance a mesh k times at model-space offsets: a real *scene*, with real
// inter-object occlusion, which one solid object cannot exhibit.
// ---------------------------------------------------------------------------
function makeInstances(src, offsets) {
  const k = offsets.length;
  const m = new Mesh(src.nv * k, src.nt * k);
  for (let i = 0; i < k; i++) {
    const [ox, oy, oz] = offsets[i], vo = i * src.nv, to = i * src.nt;
    for (let v = 0; v < src.nv; v++) {
      m.px[vo + v] = src.px[v] + ox;
      m.py[vo + v] = src.py[v] + oy;
      m.pz[vo + v] = src.pz[v] + oz;
    }
    for (let t = 0; t < src.nt; t++) {
      m.idx[3 * (to + t)]     = src.idx[3 * t]     + vo;
      m.idx[3 * (to + t) + 1] = src.idx[3 * t + 1] + vo;
      m.idx[3 * (to + t) + 2] = src.idx[3 * t + 2] + vo;
      m.mat[to + t] = src.mat[t];
    }
  }
  return buildAdjacency(m);
}

// ---------------------------------------------------------------------------
// exact-ish visibility: 1 spp, near -> far, first writer wins
// ---------------------------------------------------------------------------
const owner = new Int32Array(W * H);
function visibility(s) {
  const idx = s.m.idx, sx = s.sx, sy = s.sy, order = s.order, n = s.nVis;
  const area = new Uint32Array(s.m.nt), won = new Uint32Array(s.m.nt);
  owner.fill(0);
  let totalArea = 0, unionPx = 0;
  for (let i = n - 1; i >= 0; i--) {                 // near -> far
    const t = order[i];
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    let ax = sx[a], ay = sy[a], bx = sx[b], by = sy[b], cx = sx[c], cy = sy[c];
    // half-plane rasterisation only accepts one winding; normalise so this
    // works whichever sheet the backface test kept
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < 0) {
      let tq = bx; bx = cx; cx = tq; tq = by; by = cy; cy = tq;
    }
    let x0 = Math.floor(Math.min(ax, bx, cx)); if (x0 < 0) x0 = 0;
    let x1 = Math.ceil(Math.max(ax, bx, cx));  if (x1 > W - 1) x1 = W - 1;
    let y0 = Math.floor(Math.min(ay, by, cy)); if (y0 < 0) y0 = 0;
    let y1 = Math.ceil(Math.max(ay, by, cy));  if (y1 > H - 1) y1 = H - 1;
    if (x1 < x0 || y1 < y0) continue;
    const dx0 = -(by - ay), dy0 = (bx - ax);
    const dx1 = -(cy - by), dy1 = (cx - bx);
    const dx2 = -(ay - cy), dy2 = (ax - cx);
    const px = x0 + 0.5, py = y0 + 0.5;
    let r0 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    let r1 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
    let r2 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
    let ar = 0, wn = 0;
    for (let y = y0; y <= y1; y++) {
      let f0 = r0, f1 = r1, f2 = r2;
      const row = y * W;
      for (let x = x0; x <= x1; x++) {
        if (f0 >= 0 && f1 >= 0 && f2 >= 0) {
          ar++;
          const p = row + x;
          if (owner[p] === 0) { owner[p] = t + 1; wn++; unionPx++; }
        }
        f0 += dx0; f1 += dx1; f2 += dx2;
      }
      r0 += dy0; r1 += dy1; r2 += dy2;
    }
    area[t] = ar; won[t] = wn; totalArea += ar;
  }
  return { area, won, totalArea, unionPx };
}

// ---------------------------------------------------------------------------
// batcher counts, on a chosen subset of the visible list
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

// Run the shipped grid batcher + boundary extraction over `keep` (a subset of
// scene.order, same relative order) and report what the frame would cost.
function batchCost(scene, keep) {
  const saveOrder = scene.order, saveN = scene.nVis;
  scene.order = keep; scene.nVis = keep.length;
  const R = new Renderer(scene, 4);
  R.setTile(4); R.batchGridExact();
  const c = new CountCtx(), st = new Stats();
  R.emitBoundary(c, st, true, 2);                   // collinear + seam stroke
  scene.order = saveOrder; scene.nVis = saveN;
  return { fills: c.fills, verts: c.verts, subpaths: c.subpaths, strokes: c.strokes };
}

// ---------------------------------------------------------------------------
const scenes = [];
{
  const tk = makeTorusKnot(512, 64, 3, 7, 8);
  const sp = makeSphere(256, 128, 4);
  const sp2 = makeSphere(96, 48, 4);
  const gr = makeGrid(180, 4);
  scenes.push(['torusKnot', tk, 24, 8, ANG]);
  scenes.push(['sphere', sp, 24, 4, ANG]);
  scenes.push(['grid', gr, 24, 4, ANG]);
  scenes.push(['soup40k', makeSoup(40000, 8, 777), 32, 8, ANG]);
  // 8 spheres in a 2x2x2 block: classic inter-object occlusion
  scenes.push(['8spheres', makeInstances(sp2, [
    [-1.1, -1.1, -1.1], [1.1, -1.1, -1.1], [-1.1, 1.1, -1.1], [1.1, 1.1, -1.1],
    [-1.1, -1.1, 1.1], [1.1, -1.1, 1.1], [-1.1, 1.1, 1.1], [1.1, 1.1, 1.1]]),
    24, 4, [0.4, 0.9, 0.13, 6.0, 700]]);
  // 5 spheres stacked straight down the view axis: worst case, near-total
  // occlusion of everything behind the first
  scenes.push(['5deep', makeInstances(sp2, [
    [0, 0, -2.2], [0, 0, -1.1], [0, 0, 0], [0, 0, 1.1], [0, 0, 2.2]]),
    24, 4, [0.4, 0.9, 0.13, 6.5, 900]]);
}

console.log('scene            tris   visible  unionPx  Sum(area)  overdraw   ' +
            'occluded      occl.area  sub-sample');
console.log('-'.repeat(104));
const results = [];
for (const [nm, mesh, sh, bd, ang] of scenes) {
  const scene = new Scene(mesh, W, H, sh, bd);
  scene.build.apply(scene, ang);
  const v = visibility(scene);
  // A face with won===0 is one of two very different things:
  //   area  >  0 : genuinely OCCLUDED -- covered pixels, all of them stolen
  //   area === 0 : SUB-SAMPLE -- smaller than a pixel centre.  Not occluded,
  //                and NOT safe to drop: it is part of a watertight surface,
  //                and removing it punches a hole that costs boundary edges.
  let occl = 0, occlArea = 0, sub = 0;
  for (let i = 0; i < scene.nVis; i++) {
    const t = scene.order[i];
    if (v.won[t] === 0) {
      if (v.area[t] > 0) { occl++; occlArea += v.area[t]; } else sub++;
    }
  }
  results.push({ nm, scene, v, occl, sub, mesh });
  console.log(
    nm.padEnd(12) + String(mesh.nt).padStart(8) + String(scene.nVis).padStart(10) +
    String(v.unionPx).padStart(9) + String(v.totalArea).padStart(11) +
    (v.totalArea / v.unionPx).toFixed(2).padStart(10) + 'x' +
    (String(occl) + ' (' + (100 * occl / scene.nVis).toFixed(1) + '%)').padStart(16) +
    ((100 * occlArea / v.totalArea).toFixed(1) + '%').padStart(11) +
    ((100 * sub / scene.nVis).toFixed(1) + '%').padStart(12));
}

// ---------------------------------------------------------------------------
// What does removing exactly the hidden faces buy in the cost centres that
// actually price a canvas2d frame?  (Perfect culler, zero cull cost: the
// ceiling, not a proposal.)
// ---------------------------------------------------------------------------
console.log('\nceiling: cost with a PERFECT, FREE culler (grid tile=4, boundary+collinear+seam stroke)');
console.log('scene         faces->faces      fills->fills       verts->verts       strokes');
console.log('-'.repeat(96));
for (const r of results) {
  const { scene, v } = r;
  const all = new Int32Array(scene.order.subarray(0, scene.nVis));
  const pick = (dropSub) => {
    const k = [];
    for (let i = 0; i < scene.nVis; i++) {
      const t = scene.order[i];
      if (v.won[t] > 0 || (!dropSub && v.area[t] === 0)) k.push(t);
    }
    return new Int32Array(k);
  };
  const keep = pick(false), keepSub = pick(true);
  const a = batchCost(scene, all), b = batchCost(scene, keep), c = batchCost(scene, keepSub);
  const pct = (x, y) => (x === 0 ? '  --  ' : ((y > x ? '+' : '') + (100 * (y - x) / x).toFixed(0) + '%'));
  console.log(r.nm.padEnd(12) +
    (all.length + '->' + keep.length).padStart(16) + pct(all.length, keep.length).padStart(7) +
    (a.fills + '->' + b.fills).padStart(15) + pct(a.fills, b.fills).padStart(7) +
    (a.verts + '->' + b.verts).padStart(17) + pct(a.verts, b.verts).padStart(7) +
    (a.strokes + '->' + b.strokes).padStart(13));
  // ...and what happens if you ALSO drop the sub-sample faces, which own no
  // pixel centre but are not occluded.  They are part of a watertight surface,
  // so removing them punches holes and the boundary grows.
  console.log(''.padEnd(12) + ('+drop sub-sample: ' + keepSub.length).padStart(23) +
    (c.fills + ' fills ' + pct(b.fills, c.fills)).padStart(20) +
    (c.verts + ' verts ' + pct(b.verts, c.verts)).padStart(24));
}
