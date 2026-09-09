// node bench/prep.js [--tile N] [--bands N] [--trees N] [--grid N] [--start F]
// ---------------------------------------------------------------------------
// THE PREP STEP: dropping colour-redundant faces BEFORE the batcher walks them.
//
// This is the inverse of overdraw (4.9).  There a face is dropped because
// something opaque covers it.  Here it is dropped because the value it would
// write is the value already there -- a band-0 fog fill over a screen region
// that is already band 0.  Occlusion culling cannot see those: they are the
// FRONTMOST faces, individually visible, and they still cost the batcher three
// vertices each.
//
// THREE PREDICATES ARE MEASURED.
//
// P1  PRESENCE + BACKDROP.  The natural thing to reach for is a coverage claim
//     ("is this tile covered yet?") and it does not work: coverage needs
//     triangle INTERIORS (4.2), so a terrain triangle smaller than a tile
//     claims nothing, and the answer depends on draw order, so an interleaved
//     depth sort defeats it.  Ask about PRESENCE of a foreign class instead:
//         tileClass[tile] = -1 empty | c uniform | -2 mixed      (one Int32)
//         note:  scatter each face's screen BBOX into its tiles
//         test:  drop a class-c* face iff every tile in its bbox reads c*
//     Bbox-based, so tessellation density stops mattering.  Order-free, so the
//     sort does not matter.  Exact at ANY sample rate, given one condition:
//     the backdrop is c*.  Proof: every face covering a pixel in tile T has
//     its bbox touching T, so if T reads c* then every face there is class c*,
//     so every sub-sample of that pixel is c*, so the pixel is c* whether the
//     face was drawn or not.  Needs a canvas whose background you own.
//
// P2  CLUSTER KILL.  The same test at cluster granularity: O(clusters).
//
// P3  DOMINANT COVER.  For a pass whose background is NOT yours (the fill
//     canvas is pinned to fog colour by the halo fix), walk painter order
//     far -> near holding one bitmask M = "the current colour here is c*":
//         class c* face:  mark M; drop it if it set no new sample
//         other face:     CLEAR its footprint from M
//     Exact, no backdrop needed, one mask, one coverage pass -- each face
//     touches exactly one mask, so the clear costs no extra traffic.  Unlike
//     P1 it is exact only at the sample rate it runs at, so it is checked
//     against a 2x supersampled reference as well.
//
// Reported: faces, fills, vertices, the batcher's OWN cpu time, the prep's own
// cpu time, and a per-pixel COMPOSITE diff against the unprepped frame, which
// must be zero.  Vertices and fills are the record-stage currency (1.1);
// rasterisation is engine-side and needs a browser (see fogpage.html).
// ---------------------------------------------------------------------------
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const sb = { performance: { now: () => Number(process.hrtime.bigint()) / 1e6 }, console, Math, Date };
vm.createContext(sb);
function patch(src, from, to, why) {
  if (src.indexOf(from) < 0) throw new Error('could not patch: ' + why);
  return src.replace(from, to);
}
for (const f of ['mesh.js', 'scene.js', 'render.js']) {
  let src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  if (f === 'scene.js') src = patch(src, 'if (area <= 0) continue;', 'if (area >= 0) continue;', 'backface sign');
  vm.runInContext(src, sb, { filename: f });
}
const { Mesh, buildAdjacency, makeGrid, makeSphere, makeTorusKnot, makeInstances,
        Scene, Renderer, Stats } = sb;
const now = () => Number(process.hrtime.bigint()) / 1e6;

const W = 1280, H = 720;
const FOG_RGB = [90, 105, 130];
const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : +process.argv[i + 1]; };
const TILE = arg('--tile', 16);
const BANDS = arg('--bands', 8);
const NTREE = arg('--trees', 300);
const GRIDN = arg('--grid', 120);
const FOCUS = arg('--start', 0.65);

const COEF = { chromium: [0.26, 0.009], firefox: [0.65, 0.007] };  // us/fill, us/vert (1.1)
const predict = (f, v, e) => f * COEF[e][0] + v * COEF[e][1];

// ---------------------------------------------------------------------------
function CountCtx() { }
for (const k of ['beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke'])
  CountCtx.prototype[k] = function () { };
for (const k of ['fillStyle', 'strokeStyle', 'lineWidth'])
  Object.defineProperty(CountCtx.prototype, k, { set() { } });

// Batch + emit with a substituted colour key over a substituted face list.
// Densify the key first so its CARDINALITY is what matters, not its range.
// `reps` > 1 times the batcher's own CPU (no draw calls happen -- CountCtx is
// inert -- so a CPU timer is legitimate here, unlike around real draw calls).
function pass(scene, R, key, order, n, reps) {
  const dense = new Int32Array(scene.m.nt), seen = new Map();
  for (let i = 0; i < n; i++) {
    const t = order[i], k = key[t];
    let v = seen.get(k);
    if (v === undefined) { v = seen.size; seen.set(k, v); }
    dense[t] = v;
  }
  if (seen.size > (1 << 16)) throw new Error('colour cardinality overflow');
  const sCol = scene.col, sOrd = scene.order, sN = scene.nVis;
  scene.col = dense; scene.order = order; scene.nVis = n;
  R.setTile(4);
  const st = new Stats(), ctx = new CountCtx();
  let best = Infinity;
  for (let r = 0; r < (reps || 1); r++) {
    st.reset();
    const t0 = now();
    R.batchGridExact();
    R.emitBoundary(ctx, st, true, 2);
    const dt = now() - t0;
    if (dt < best) best = dt;
  }
  scene.col = sCol; scene.order = sOrd; scene.nVis = sN;
  return { fills: st.fills, verts: st.verts, strokes: st.strokes,
           colours: seen.size, faces: n, cpu: best };
}

// ---------------------------------------------------------------------------
// scene: one big terrain mesh + many small separate meshes standing on it.
// This is the shape a coarse coverage claim fails on -- the terrain is
// tessellated far below tile size and its faces interleave with the props in
// the depth sort, which is exactly the reported failure mode.
// ---------------------------------------------------------------------------
function gridHeight(x, z, n) {
  const j = (x / 2.4 + 0.5) * n, i = (z / 2.4 + 0.5) * n;
  return 0.30 * Math.sin(j * 0.31) * Math.cos(i * 0.27);
}
function scatter(src, places) {
  const k = places.length, m = new Mesh(src.nv * k, src.nt * k);
  for (let p = 0; p < k; p++) {
    const ox = places[p][0], oy = places[p][1], oz = places[p][2], s = places[p][3];
    const vo = p * src.nv, to = p * src.nt;
    for (let v = 0; v < src.nv; v++) {
      m.px[vo + v] = src.px[v] * s * 0.38 + ox;
      m.py[vo + v] = src.py[v] * s + oy;
      m.pz[vo + v] = src.pz[v] * s * 0.38 + oz;
    }
    for (let t = 0; t < src.nt; t++) {
      m.idx[3 * (to + t)] = src.idx[3 * t] + vo;
      m.idx[3 * (to + t) + 1] = src.idx[3 * t + 1] + vo;
      m.idx[3 * (to + t) + 2] = src.idx[3 * t + 2] + vo;
      m.mat[to + t] = src.mat[t];
    }
  }
  return m;
}
function merge(parts) {
  let nv = 0, nt = 0;
  for (const p of parts) { nv += p.nv; nt += p.nt; }
  const m = new Mesh(nv, nt);
  let vo = 0, to = 0;
  for (const p of parts) {
    m.px.set(p.px, vo); m.py.set(p.py, vo); m.pz.set(p.pz, vo);
    for (let i = 0; i < p.nt * 3; i++) m.idx[to * 3 + i] = p.idx[i] + vo;
    m.mat.set(p.mat, to);
    vo += p.nv; to += p.nt;
  }
  return buildAdjacency(m);
}
function makeIso(gridN, nTree, twoMat, seed) {
  const terrain = makeGrid(gridN, 1);
  for (let t = 0; t < terrain.nt; t++) terrain.mat[t] = 0;
  const crown = makeSphere(10, 5, 1);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const places = [];
  for (let i = 0; i < nTree; i++) {
    const x = (rnd() - 0.5) * 2.2, z = (rnd() - 0.5) * 2.2;
    const sc = 0.055 + rnd() * 0.045;
    places.push([x, gridHeight(x, z, gridN) + sc * 0.9, z, sc]);
  }
  const trees = scatter(crown, places);
  for (let t = 0; t < trees.nt; t++) trees.mat[t] = twoMat ? 1 : 0;
  const m = merge([terrain, trees]);
  const cluster = new Int32Array(m.nt);
  const PS = 4, pw = (gridN >> PS) + 1;
  for (let t = 0; t < terrain.nt; t++) {
    const q = t >> 1, i = (q / gridN) | 0, j = q % gridN;
    cluster[t] = (i >> PS) * pw + (j >> PS);
  }
  const base = pw * pw;
  for (let t = 0; t < trees.nt; t++) cluster[terrain.nt + t] = base + ((t / crown.nt) | 0);
  m.cluster = cluster; m.nClust = base + nTree; m.nTerrain = terrain.nt;
  return m;
}
function autoCluster(m, per) {
  const cluster = new Int32Array(m.nt);
  for (let t = 0; t < m.nt; t++) cluster[t] = (t / per) | 0;
  m.cluster = cluster; m.nClust = Math.ceil(m.nt / per);
  return m;
}

// ---------------------------------------------------------------------------
// fog: radial about a world point, with a PLATEAU -- d is exactly 0 inside
// `start` of the radius, which is how game fog is written (fogStart / fogEnd)
// and what creates the large single-class region.  Swept, so the win is
// reported as a function of how much screen the dominant class owns.
// ---------------------------------------------------------------------------
function bandsOf(scene, out, zr, B, START) {
  const idx = scene.m.idx, sx = scene.sx, sy = scene.sy, sz = scene.sz;
  const n = scene.nVis, order = scene.order;
  for (let i = 0; i < n; i++) {
    const t = order[i];
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    const vz = (sz[a] + sz[b] + sz[c]) / 3;
    const px = (sx[a] + sx[b] + sx[c]) / 3, py = (sy[a] + sy[b] + sy[c]) / 3;
    const dx = (px - zr.cx) * vz / zr.scale, dy = (py - zr.cy) * vz / zr.scale;
    const dz = vz - zr.cz;
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz) / zr.radius;
    let u = (r - START) / (1 - START);
    if (u < 0) u = 0; else if (u > 1) u = 1;
    let bd = (u * (B - 1) + 0.5) | 0;
    if (bd > B - 1) bd = B - 1;
    out[t] = bd;
  }
}

// ---------------------------------------------------------------------------
// P1 -- ClassPrep.  `noteAll` is the walk the pass already makes to compute
// its colour key, with the histogram and the bbox scatter folded in.
// ---------------------------------------------------------------------------
function ClassPrep(o) {
  this.ts = o.tile; this.sh = Math.log2(o.tile) | 0;
  this.tw = ((o.width - 1) >> this.sh) + 1;
  this.th = ((o.height - 1) >> this.sh) + 1;
  this.tile = new Int32Array(this.tw * this.th);
  this.area = new Float64Array(o.classes);
  this.classes = o.classes;
  this.list = new Int32Array(o.triangleCount);
  this.dropMask = new Uint8Array(o.triangleCount);
  this.count = 0; this.dropped = 0; this.cStar = -1;
}
ClassPrep.prototype.noteAll = function (s, cls) {
  const n = s.nVis, order = s.order, idx = s.m.idx, sx = s.sx, sy = s.sy;
  const bx0 = s.bx0, by0 = s.by0, bx1 = s.bx1, by1 = s.by1;
  const sh = this.sh, tw = this.tw, th = this.th, g = this.tile, ar = this.area;
  g.fill(-1); ar.fill(0);
  for (let q = 0; q < n; q++) {
    const t = order[q], c = cls[t];
    const a = idx[3 * t], b = idx[3 * t + 1], k = idx[3 * t + 2];
    ar[c] += Math.abs((sx[b] - sx[a]) * (sy[k] - sy[a]) - (sy[b] - sy[a]) * (sx[k] - sx[a]));
    let i0 = bx0[t] >> sh, i1 = bx1[t] >> sh, j0 = by0[t] >> sh, j1 = by1[t] >> sh;
    if (i0 < 0) i0 = 0;
    if (j0 < 0) j0 = 0;
    if (i1 >= tw) i1 = tw - 1;
    if (j1 >= th) j1 = th - 1;
    for (let j = j0; j <= j1; j++) {
      const row = j * tw;
      for (let i = i0; i <= i1; i++) {
        const p = row + i, v = g[p];
        if (v === -1) g[p] = c; else if (v !== c) g[p] = -2;
      }
    }
  }
};
// `only` optionally restricts dropping to a subset -- used to price a
// scattered drop against a contiguous one (the cancellation law, 6.11).
ClassPrep.prototype.resolve = function (s, cls, only) {
  let best = -1, bv = -1;
  for (let c = 0; c < this.classes; c++) if (this.area[c] > bv) { bv = this.area[c]; best = c; }
  this.cStar = best;
  const sh = this.sh, tw = this.tw, th = this.th, g = this.tile;
  const bx0 = s.bx0, by0 = s.by0, bx1 = s.bx1, by1 = s.by1;
  const order = s.order, n = s.nVis, list = this.list, dm = this.dropMask;
  let k = 0;
  for (let q = 0; q < n; q++) {
    const t = order[q];
    let drop = 0;
    if (cls[t] === best && (only === undefined || only[t])) {
      let i0 = bx0[t] >> sh, i1 = bx1[t] >> sh, j0 = by0[t] >> sh, j1 = by1[t] >> sh;
      if (i0 < 0) i0 = 0;
      if (j0 < 0) j0 = 0;
      if (i1 >= tw) i1 = tw - 1;
      if (j1 >= th) j1 = th - 1;
      drop = 1;
      for (let j = j0; j <= j1 && drop; j++) {
        const row = j * tw;
        for (let i = i0; i <= i1; i++) if (g[row + i] !== best) { drop = 0; break; }
      }
    }
    dm[t] = drop;
    if (!drop) list[k++] = t;
  }
  this.count = k; this.dropped = n - k;
  return best;
};

// ---------------------------------------------------------------------------
// P2 -- cluster kill.  Same test, cluster granularity, O(clusters).
// ---------------------------------------------------------------------------
const CPS = {};
function clusterPrep(s, cls, prep, mesh) {
  const nC = mesh.nClust, cl = mesh.cluster, n = s.nVis, order = s.order;
  if (!CPS.lo || CPS.lo.length < nC) {
    CPS.lo = new Int32Array(nC); CPS.hi = new Int32Array(nC);
    CPS.cx0 = new Float32Array(nC); CPS.cy0 = new Float32Array(nC);
    CPS.cx1 = new Float32Array(nC); CPS.cy1 = new Float32Array(nC);
    CPS.kill = new Uint8Array(nC); CPS.list = new Int32Array(s.m.nt);
  }
  const lo = CPS.lo, hi = CPS.hi, cx0 = CPS.cx0, cy0 = CPS.cy0,
        cx1 = CPS.cx1, cy1 = CPS.cy1;
  const t0 = now();
  lo.fill(1 << 30); hi.fill(-1);
  cx0.fill(1e9); cy0.fill(1e9); cx1.fill(-1e9); cy1.fill(-1e9);
  for (let q = 0; q < n; q++) {
    const t = order[q], c = cl[t], b = cls[t];
    if (b < lo[c]) lo[c] = b;
    if (b > hi[c]) hi[c] = b;
    if (s.bx0[t] < cx0[c]) cx0[c] = s.bx0[t];
    if (s.by0[t] < cy0[c]) cy0[c] = s.by0[t];
    if (s.bx1[t] > cx1[c]) cx1[c] = s.bx1[t];
    if (s.by1[t] > cy1[c]) cy1[c] = s.by1[t];
  }
  const sh = prep.sh, tw = prep.tw, th = prep.th, g = prep.tile, best = prep.cStar;
  const kill = CPS.kill; kill.fill(0);
  let nKill = 0, nLive = 0;
  for (let c = 0; c < nC; c++) {
    if (hi[c] < 0) continue;
    nLive++;
    if (lo[c] !== best || hi[c] !== best) continue;
    let i0 = cx0[c] >> sh, i1 = cx1[c] >> sh, j0 = cy0[c] >> sh, j1 = cy1[c] >> sh;
    if (i0 < 0) i0 = 0;
    if (j0 < 0) j0 = 0;
    if (i1 >= tw) i1 = tw - 1;
    if (j1 >= th) j1 = th - 1;
    let ok = 1;
    for (let j = j0; j <= j1 && ok; j++) {
      const row = j * tw;
      for (let i = i0; i <= i1; i++) if (g[row + i] !== best) { ok = 0; break; }
    }
    if (ok) { kill[c] = 1; nKill++; }
  }
  const list = CPS.list;
  let k = 0;
  for (let q = 0; q < n; q++) { const t = order[q]; if (!kill[cl[t]]) list[k++] = t; }
  const cpu = now() - t0;
  return { list: new Int32Array(list.subarray(0, k)), count: k, live: nLive,
           killed: nKill, cpu };
}

// ---------------------------------------------------------------------------
// P3 -- dominant cover.  One bitmask M = "the current colour here is c*".
// Painter order far -> near: a c* face that sets no new sample is redundant;
// a face of any other class CLEARS its footprint from M.  Exact, and needs no
// control over the backdrop.
// ---------------------------------------------------------------------------
function DomCover(o) {
  this.W = o.width; this.H = o.height;
  this.ss = o.sampleScale || 1;
  this.sw = Math.round(this.W * this.ss);
  this.sh = Math.round(this.H * this.ss);
  this.wpr = (this.sw + 31) >> 5;
  this.cov = new Int32Array(this.wpr * this.sh);
  this.list = new Int32Array(o.triangleCount);
  this.count = 0; this.dropped = 0;
}
// mode 0: OR the triangle in, return 1 if it covered samples and set none new.
// mode 1: AND-NOT the triangle out.  Returns 0.
DomCover.prototype.rast = function (ax, ay, bx, by, cx, cy, mode) {
  const ss = this.ss;
  let x0 = ax * ss, y0 = ay * ss, x1 = bx * ss, y1 = by * ss,
      x2 = cx * ss, y2 = cy * ss, tm;
  if (y0 > y1) { tm = x0; x0 = x1; x1 = tm; tm = y0; y0 = y1; y1 = tm; }
  if (y1 > y2) { tm = x1; x1 = x2; x2 = tm; tm = y1; y1 = y2; y2 = tm; }
  if (y0 > y1) { tm = x0; x0 = x1; x1 = tm; tm = y0; y0 = y1; y1 = tm; }
  const sw = this.sw, wpr = this.wpr, cov = this.cov;
  let j0 = Math.ceil(y0 - 0.5), j1 = Math.floor(y2 - 0.5);
  if (j0 < 0) j0 = 0;
  if (j1 > this.sh - 1) j1 = this.sh - 1;
  if (j1 < j0) return 0;                    // thinner than a sample row: keep
  const g02 = (y2 > y0) ? (x2 - x0) / (y2 - y0) : 0;
  const g01 = (y1 > y0) ? (x1 - x0) / (y1 - y0) : 0;
  const g12 = (y2 > y1) ? (x2 - x1) / (y2 - y1) : 0;
  const yc = j0 + 0.5;
  let xa = x0 + (yc - y0) * g02, xb, gb;
  let lower = yc < y1;
  if (lower) { xb = x0 + (yc - y0) * g01; gb = g01; }
  else { xb = x1 + (yc - y1) * g12; gb = g12; }
  let any = 0, neu = 0;
  for (let j = j0; j <= j1; j++) {
    const xl = xa < xb ? xa : xb, xr = xa < xb ? xb : xa;
    let is = Math.ceil(xl - 0.5), ie = Math.floor(xr - 0.5);
    if (is < 0) is = 0;
    if (ie > sw - 1) ie = sw - 1;
    if (ie >= is) {
      any = 1;
      const base = j * wpr, w0 = is >> 5, w1 = ie >> 5;
      if (w0 === w1) {
        const m = (-1 << (is & 31)) & (-1 >>> (31 - (ie & 31)));
        const p = base + w0, old = cov[p];
        if (mode === 0) { const nw = old | m; if (nw !== old) { neu = 1; cov[p] = nw; } }
        else cov[p] = old & ~m;
      } else {
        let m = -1 << (is & 31);
        let p = base + w0, old = cov[p];
        if (mode === 0) { const nw = old | m; if (nw !== old) { neu = 1; cov[p] = nw; } }
        else cov[p] = old & ~m;
        for (let w = w0 + 1; w < w1; w++) {
          p = base + w;
          if (mode === 0) { if (cov[p] !== -1) { neu = 1; cov[p] = -1; } }
          else cov[p] = 0;
        }
        m = -1 >>> (31 - (ie & 31));
        p = base + w1; old = cov[p];
        if (mode === 0) { const nw = old | m; if (nw !== old) { neu = 1; cov[p] = nw; } }
        else cov[p] = old & ~m;
      }
    }
    xa += g02;
    if (lower && (j + 1.5) >= y1) { lower = false; gb = g12; xb = x1 + (j + 1.5 - y1) * g12; }
    else xb += gb;
  }
  return (mode === 0 && any && !neu) ? 1 : 0;
};
DomCover.prototype.run = function (s, cls, cStar) {
  const t0 = now();
  this.cov.fill(0);
  const idx = s.m.idx, sx = s.sx, sy = s.sy, order = s.order, n = s.nVis;
  const list = this.list;
  let k = 0;
  for (let q = 0; q < n; q++) {                   // far -> near = painter order
    const t = order[q];
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    if (cls[t] === cStar) {
      if (this.rast(sx[a], sy[a], sx[b], sy[b], sx[c], sy[c], 0)) continue;
      list[k++] = t;
    } else {
      this.rast(sx[a], sy[a], sx[b], sy[b], sx[c], sy[c], 1);
      list[k++] = t;
    }
  }
  this.count = k; this.dropped = n - k; this.cpu = now() - t0;
  return k;
};

// ---------------------------------------------------------------------------
// uniform-tile KEEPER -- the other pure-filter fill-pass option: a tile whose
// census is {c} and which some single face fully contains keeps that face and
// drops every other class-c face whose bbox lies inside it.
// ---------------------------------------------------------------------------
function triContainsRect(sx, sy, idx, t, x0, y0, x1, y1) {
  const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
  const ax = sx[a], ay = sy[a], bx = sx[b], by = sy[b], cx = sx[c], cy = sy[c];
  const ar = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (ar === 0) return false;
  const g = ar > 0 ? 1 : -1;
  for (let q = 0; q < 4; q++) {
    const px = (q & 1) ? x1 : x0, py = (q & 2) ? y1 : y0;
    if (g * ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) < 0) return false;
    if (g * ((cx - bx) * (py - by) - (cy - by) * (px - bx)) < 0) return false;
    if (g * ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) < 0) return false;
  }
  return true;
}
function keeperPrep(s, cls, prep) {
  const sh = prep.sh, ts = prep.ts, tw = prep.tw, th = prep.th, g = prep.tile;
  const n = s.nVis, order = s.order, idx = s.m.idx, sx = s.sx, sy = s.sy;
  const keeper = new Int32Array(tw * th).fill(-1);
  for (let q = 0; q < n; q++) {
    const t = order[q];
    let i0 = s.bx0[t] >> sh, i1 = s.bx1[t] >> sh, j0 = s.by0[t] >> sh, j1 = s.by1[t] >> sh;
    if (i0 < 0) i0 = 0;
    if (j0 < 0) j0 = 0;
    if (i1 >= tw) i1 = tw - 1;
    if (j1 >= th) j1 = th - 1;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const p = j * tw + i;
      if (g[p] !== cls[t] || keeper[p] >= 0) continue;
      if (triContainsRect(sx, sy, idx, t, i * ts, j * ts, (i + 1) * ts, (j + 1) * ts)) keeper[p] = t;
    }
  }
  const isKeeper = new Uint8Array(s.m.nt);
  let tiles = 0;
  for (let p = 0; p < tw * th; p++) if (keeper[p] >= 0) { isKeeper[keeper[p]] = 1; tiles++; }
  const list = new Int32Array(n);
  let k = 0;
  for (let q = 0; q < n; q++) {
    const t = order[q];
    let drop = 0;
    if (!isKeeper[t]) {
      let i0 = s.bx0[t] >> sh, i1 = s.bx1[t] >> sh, j0 = s.by0[t] >> sh, j1 = s.by1[t] >> sh;
      if (i0 < 0) i0 = 0;
      if (j0 < 0) j0 = 0;
      if (i1 >= tw) i1 = tw - 1;
      if (j1 >= th) j1 = th - 1;
      drop = 1;
      for (let j = j0; j <= j1 && drop; j++) for (let i = i0; i <= i1; i++) {
        const p = j * tw + i;
        if (g[p] !== cls[t] || keeper[p] < 0) { drop = 0; break; }
      }
    }
    if (!drop) list[k++] = t;
  }
  return { list: list.subarray(0, k), count: k, keptTiles: tiles, totTiles: tw * th };
}

// ---------------------------------------------------------------------------
// per-pixel ground truth: frontmost face id per sample, at scale `ss`
// ---------------------------------------------------------------------------
function ownerPass(scene, order, n, owner, ss) {
  const idx = scene.m.idx, sx = scene.sx, sy = scene.sy;
  const SW = W * ss, SH = H * ss;
  owner.fill(-1);
  for (let i = n - 1; i >= 0; i--) {
    const t = order[i];
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    let ax = sx[a] * ss, ay = sy[a] * ss, bx = sx[b] * ss, by = sy[b] * ss,
        cx = sx[c] * ss, cy = sy[c] * ss;
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < 0) {
      let q = bx; bx = cx; cx = q; q = by; by = cy; cy = q;
    }
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) === 0) continue;
    let X0 = Math.floor(Math.min(ax, bx, cx)); if (X0 < 0) X0 = 0;
    let X1 = Math.ceil(Math.max(ax, bx, cx)); if (X1 > SW - 1) X1 = SW - 1;
    let Y0 = Math.floor(Math.min(ay, by, cy)); if (Y0 < 0) Y0 = 0;
    let Y1 = Math.ceil(Math.max(ay, by, cy)); if (Y1 > SH - 1) Y1 = SH - 1;
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
      const row = y * SW;
      for (let x = X0; x <= X1; x++) {
        if (f0 >= 0 && f1 >= 0 && f2 >= 0 && owner[row + x] === -1) owner[row + x] = t;
        f0 += dx0; f1 += dx1; f2 += dx2;
      }
      r0 += dy0; r1 += dy1; r2 += dy2;
    }
  }
}
// The exact correctness test for a pass keyed by `cls`: at every sample, does
// the class that ends up painted differ?  A pass paints ONE colour per class,
// so a class match is a pixel match -- comparing palette RGB instead would
// compare the shade too, which this pass never writes.
function classDiff(cls, ownerA, ownerB, backA, backB, ns) {
  let diff = 0;
  for (let p = 0; p < ns; p++) {
    const a = ownerA[p], b = ownerB[p];
    const ca = a >= 0 ? cls[a] : backA, cb = b >= 0 ? cls[b] : backB;
    if (ca !== cb) diff++;
  }
  return diff;
}
// End-to-end magnitude for the fog pass: out = scene*(1-d) + fog*d.  The
// albedo comes from `ownerScene` on BOTH sides, because prepping the fog pass
// does not change the fill pass's face list -- only the fog map's `d` moves.
// Void resolves to fog colour in both, because the fill canvas's own
// background is fog colour (4.10, the halo fix), so this covers the void too.
function compositeDiff(scene, band, ownerScene, ownerRef, ownerPrep, B,
                       backRef, backPrep, ns) {
  const pal = scene.palRGB, col = scene.col;
  let diff = 0, maxd = 0;
  for (let p = 0; p < ns; p++) {
    const bR = ownerRef[p] >= 0 ? band[ownerRef[p]] : backRef;
    const bP = ownerPrep[p] >= 0 ? band[ownerPrep[p]] : backPrep;
    if (bR === bP) continue;
    const os = ownerScene[p];
    const dR = B <= 1 ? 0 : bR / (B - 1), dP = B <= 1 ? 0 : bP / (B - 1);
    let d = 0;
    for (let k = 0; k < 3; k++) {
      const base = os >= 0 ? pal[col[os] * 3 + k] : FOG_RGB[k];
      const e = Math.abs((base * (1 - dR) + FOG_RGB[k] * dR) -
                         (base * (1 - dP) + FOG_RGB[k] * dP));
      if (e > d) d = e;
    }
    if (d > 0) diff++;
    if (d > maxd) maxd = d;
  }
  return { diff, maxd };
}
// ---------------------------------------------------------------------------
const pad = (v, w) => String(v).padStart(w);
const f2 = (v, w, p) => v.toFixed(p === undefined ? 2 : p).padStart(w);

function zrangeOf(scene) {
  const idx = scene.m.idx, sz = scene.sz, n = scene.nVis, order = scene.order;
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = order[i];
    const z = (sz[idx[3 * t]] + sz[idx[3 * t + 1]] + sz[idx[3 * t + 2]]) / 3;
    if (z < zmin) zmin = z;
    if (z > zmax) zmax = z;
  }
  return { near: zmin, far: zmax, cx: W * 0.5, cy: H * 0.5,
           cz: (zmin + zmax) * 0.5, radius: (zmax - zmin) * 0.75 };
}

const HDR = '    faces   fills    verts  rec.Fx   drop%    vs base   batch ms  prep ms   cdiff maxD';
function row(label, r, base, dropPct, prepMs, diff) {
  const fx = predict(r.fills, r.verts, 'firefox');
  const fx0 = base ? predict(base.fills, base.verts, 'firefox') : fx;
  return '   ' + label.padEnd(17) + pad(r.faces, 7) + pad(r.fills, 8) + pad(r.verts, 9) +
    f2(fx / 1000, 8, 3) + pad(dropPct === null ? '-' : dropPct.toFixed(1), 8) +
    pad((fx / fx0).toFixed(2) + 'x', 11) + f2(r.cpu, 11, 3) +
    (prepMs === null ? pad('-', 9) : f2(prepMs, 9, 3)) +
    (diff ? pad(diff.diff, 8) + pad(diff.maxd.toFixed(0), 5) : '');
}

function main() {
  const isoA = makeIso(GRIDN, NTREE, false, 12345);
  const isoB = makeIso(GRIDN, NTREE, true, 12345);
  const ANG_ISO = [0.5236, 0.7854, 0, 3.0, 1600];       // 30 deg pitch, 45 deg yaw
  const ANG = [0.4, 0.9, 0.13, 3.1, 620];
  const sp2 = makeSphere(96, 48, 4);
  const scenes = [
    ['iso terrain+props, one material', isoA, ANG_ISO, 24, 2],
    ['iso terrain+props, props differ', isoB, ANG_ISO, 24, 2],
    ['torusKnot', autoCluster(makeTorusKnot(512, 64, 3, 7, 8), 512), ANG, 24, 8],
    ['sphere (convex, the guard case)', autoCluster(makeSphere(256, 128, 4), 512), ANG, 24, 4],
    ['5deep', autoCluster(makeInstances(sp2, [[0, 0, -2.2], [0, 0, -1.1],
       [0, 0, 0], [0, 0, 1.1], [0, 0, 2.2]]), sp2.nt), [0.4, 0.9, 0.13, 6.5, 900], 24, 4]
  ];
  const STARTS = [0.0, 0.30, 0.50, 0.65, 0.80];
  const B = BANDS, REPS = 8;
  const o1 = new Int32Array(W * H), p1 = new Int32Array(W * H);
  const o2 = new Int32Array(W * H * 4), p2 = new Int32Array(W * H * 4);

  console.log('PREP STEP: colour-redundancy filter ahead of the batcher');
  console.log(W + 'x' + H + ',  ' + B + ' fog bands,  prep tile ' + TILE +
    'px,  batcher tile 4px,  fog rgb(' + FOG_RGB.join(',') + ')');
  console.log('rec.Fx = predicted record-stage ms (1.1 coefficients).  batch ms = the');
  console.log('batcher\'s own cpu (batchGridExact + emitBoundary), min of ' + REPS + '.');
  console.log('cdiff = samples whose FINAL COMPOSITE differs from the unprepped frame.');

  for (const [nm, mesh, ang, shades, matBands] of scenes) {
    const scene = new Scene(mesh, W, H, shades, matBands);
    scene.build.apply(scene, ang);
    const n = scene.nVis, nt = mesh.nt;
    const band = new Uint8Array(nt);
    const R = new Renderer(scene, 4);
    const prep = new ClassPrep({ width: W, height: H, tile: TILE, classes: B, triangleCount: nt });
    const dom = new DomCover({ width: W, height: H, triangleCount: nt });
    ownerPass(scene, scene.order, n, o1, 1);
    let cov = 0;
    for (let p = 0; p < W * H; p++) if (o1[p] >= 0) cov++;
    const zr = zrangeOf(scene);
    zr.scale = ang[4];

    console.log('\n=== ' + nm + '   faces ' + nt + '   visible ' + n +
      '   screen covered ' + (100 * cov / (W * H)).toFixed(1) + '%   clusters ' + mesh.nClust);

    // ---- sweep: how the P1 win tracks the dominant class's screen share ----
    console.log('  fog pass, P1 presence+backdrop, swept over fogStart:');
    console.log('   fogStart  c*  c*px%   faces    verts   vs base   drop%   prep ms  cdiff');
    for (const START of STARTS) {
      bandsOf(scene, band, zr, B, START);
      const base = pass(scene, R, band, scene.order, n, 2);
      prep.noteAll(scene, band);
      prep.resolve(scene, band);
      const kept = new Int32Array(prep.list.subarray(0, prep.count));
      const got = pass(scene, R, band, kept, prep.count, 2);
      let cpx = 0;
      for (let p = 0; p < W * H; p++) if (o1[p] >= 0 && band[o1[p]] === prep.cStar) cpx++;
      ownerPass(scene, kept, prep.count, p1, 1);
      const vd = compositeDiff(scene, band, o1, o1, p1, B, B - 1, prep.cStar, W * H);
      let tp = Infinity;
      for (let r = 0; r < 25; r++) {
        const t0 = now();
        prep.noteAll(scene, band);
        prep.resolve(scene, band);
        const dt = now() - t0;
        if (dt < tp) tp = dt;
      }
      const fx = predict(got.fills, got.verts, 'firefox');
      const fx0 = predict(base.fills, base.verts, 'firefox');
      console.log('   ' + f2(START, 6) + pad(prep.cStar, 5) +
        pad((100 * cpx / Math.max(1, cov)).toFixed(0) + '%', 7) +
        pad(got.faces, 8) + pad(got.verts, 9) +
        pad((fx / fx0).toFixed(2) + 'x', 10) +
        pad((100 * prep.dropped / n).toFixed(1), 8) + f2(tp, 10, 3) + pad(vd.diff, 7));
    }

    // ---- the four predicates head to head, at one fogStart ----------------
    bandsOf(scene, band, zr, B, FOCUS);
    const base = pass(scene, R, band, scene.order, n, REPS);
    console.log('  fog pass at fogStart ' + FOCUS + ', predicates head to head:');
    console.log(HDR);
    console.log(row('baseline', base, base, null, null, null));

    prep.noteAll(scene, band);
    prep.resolve(scene, band);
    const fullMask = new Uint8Array(prep.dropMask);
    const keptP1 = new Int32Array(prep.list.subarray(0, prep.count));
    const rP1 = pass(scene, R, band, keptP1, prep.count, REPS);
    let tp1 = Infinity;
    for (let r = 0; r < 25; r++) {
      const t0 = now();
      prep.noteAll(scene, band); prep.resolve(scene, band);
      const dt = now() - t0; if (dt < tp1) tp1 = dt;
    }
    ownerPass(scene, keptP1, prep.count, p1, 1);
    console.log(row('P1 presence', rP1, base, 100 * prep.dropped / n, tp1,
      compositeDiff(scene, band, o1, o1, p1, B, B - 1, prep.cStar, W * H)));
    ownerPass(scene, scene.order, n, o2, 2);
    ownerPass(scene, keptP1, prep.count, p2, 2);
    {
      // The band MAP legitimately differs over void (ref says far band, P1 says
      // c*); what must match is the COMPOSITE, which the fill canvas's
      // fog-colour background resolves identically either way.  So price the
      // composite, and report the map difference separately to show where it is.
      const s2x = compositeDiff(scene, band, o2, o2, p2, B, B - 1, prep.cStar, W * H * 4);
      console.log('                     ...2x supersampled: composite cdiff ' + s2x.diff +
        ' of ' + (W * H * 4) + ',  band-map differs on ' +
        classDiff(band, o2, p2, B - 1, prep.cStar, W * H * 4) + ' (all void)');
    }

    const cp = clusterPrep(scene, band, prep, mesh);
    const rP2 = pass(scene, R, band, cp.list, cp.count, REPS);
    ownerPass(scene, cp.list, cp.count, p1, 1);
    console.log(row('P2 cluster kill', rP2, base, 100 * (n - cp.count) / n, cp.cpu,
      compositeDiff(scene, band, o1, o1, p1, B, B - 1, prep.cStar, W * H)) +
      '   ' + cp.killed + '/' + cp.live + ' clusters');

    dom.run(scene, band, prep.cStar);
    const keptP3 = new Int32Array(dom.list.subarray(0, dom.count));
    const rP3 = pass(scene, R, band, keptP3, dom.count, REPS);
    ownerPass(scene, keptP3, dom.count, p1, 1);
    // P3 keeps the ORIGINAL backdrop -- that is the whole point of it
    console.log(row('P3 dom.cover', rP3, base, 100 * dom.dropped / n, dom.cpu,
      compositeDiff(scene, band, o1, o1, p1, B, B - 1, B - 1, W * H)));
    ownerPass(scene, keptP3, dom.count, p2, 2);
    console.log('                     ...2x supersampled: band mismatches ' +
      classDiff(band, o2, p2, B - 1, B - 1, W * H * 4) + ' of ' + (W * H * 4));

    // ---- the control: the SAME droppable set, scattered ------------------
    let s2 = 99991 >>> 0;
    const rnd = () => ((s2 = (s2 * 1664525 + 1013904223) >>> 0) / 4294967296);
    const half = new Uint8Array(nt);
    for (let q = 0; q < n; q++) { const t = scene.order[q]; if (fullMask[t] && rnd() < 0.5) half[t] = 1; }
    prep.noteAll(scene, band);
    prep.resolve(scene, band, half);
    const rSc = pass(scene, R, band,
      new Int32Array(prep.list.subarray(0, prep.count)), prep.count, REPS);
    console.log(row('  scattered 50%', rSc, base, 100 * prep.dropped / n, null, null) +
      '   <- same faces, half of them, no contiguity');

    // ---- the fill pass: keyed by material, backdrop NOT ours -------------
    const matKey = new Int32Array(nt);
    for (let i = 0; i < n; i++) { const t = scene.order[i]; matKey[t] = (scene.col[t] / shades) | 0; }
    let bestMat = 0;
    {
      const a = new Float64Array(256);
      for (let i = 0; i < n; i++) a[matKey[scene.order[i]]]++;
      for (let c = 1; c < 256; c++) if (a[c] > a[bestMat]) bestMat = c;
    }
    const fbase = pass(scene, R, matKey, scene.order, n, REPS);
    console.log('  fill pass, keyed by material (' + matBands +
      ' materials, dominant ' + bestMat + '):');
    console.log(HDR);
    console.log(row('baseline', fbase, fbase, null, null, null));
    dom.run(scene, matKey, bestMat);
    const fkept = new Int32Array(dom.list.subarray(0, dom.count));
    const fP3 = pass(scene, R, matKey, fkept, dom.count, REPS);
    ownerPass(scene, fkept, dom.count, p1, 1);
    console.log(row('P3 dom.cover', fP3, fbase, 100 * dom.dropped / n, dom.cpu,
      { diff: classDiff(matKey, o1, p1, -1, -1, W * H), maxd: 0 }));
    ownerPass(scene, scene.order, n, o2, 2);
    ownerPass(scene, fkept, dom.count, p2, 2);
    console.log('                     ...2x supersampled: material mismatches ' +
      classDiff(matKey, o2, p2, -1, -1, W * H * 4) + ' of ' + (W * H * 4));
    for (const ts of [4, 16]) {
      const kp = new ClassPrep({ width: W, height: H, tile: ts, classes: 256, triangleCount: nt });
      const t0 = now();
      kp.noteAll(scene, matKey);
      const kr = keeperPrep(scene, matKey, kp);
      const kms = now() - t0;
      const kres = pass(scene, R, matKey, kr.list, kr.count, REPS);
      ownerPass(scene, kr.list, kr.count, p1, 1);
      console.log(row('keeper ' + ts + 'px tile', kres, fbase, 100 * (n - kr.count) / n, kms,
        { diff: classDiff(matKey, o1, p1, -1, -1, W * H), maxd: 0 }) +
        '   keepered tiles ' + kr.keptTiles + '/' + kr.totTiles);
    }
  }
  console.log('\nVertices and fills are the record-stage currency (1.1); rasterisation is');
  console.log('engine-side and needs a browser (fogpage.html).  batch ms is measured with');
  console.log('an inert context, so no deferred GPU work hides inside it.');
}
main();
