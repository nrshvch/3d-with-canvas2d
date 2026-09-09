// node src/occluder.test.mjs
// Self-test for the shipped culler.  The interesting properties are not
// "does it run" but the safety ones, so each is checked against an
// independent brute-force rasteriser rather than against the culler itself:
//   - a face the culler drops really does own no pixel that a painter over the
//     FULL set would have given it  (no false culls, at 1 sample per pixel)
//   - survivors keep their painter order
//   - the skirt result is a superset of the bare result
//   - a convex closed mesh culls nothing, and the guard then stops paying
//   - nothing is allocated per frame
import { Occluder } from './occluder.js';
import { buildAdjacency } from './painter2d.js';

let failures = 0;
function check(name, ok, extra) {
  if (!ok) { failures++; console.log('FAIL  ' + name + (extra ? '  -- ' + extra : '')); }
  else console.log('ok    ' + name);
}

const W = 320, H = 240;

// ---------------------------------------------------------------------------
// two nested spheres: the inner one is completely hidden by the outer one, so
// a correct culler removes all of it and none of the outer one.
// ---------------------------------------------------------------------------
function sphere(segs, rings, r, cz) {
  const nv = segs * (rings + 1), nt = segs * rings * 2;
  const px = new Float32Array(nv), py = new Float32Array(nv), pz = new Float32Array(nv);
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI;
    for (let j = 0; j < segs; j++) {
      const th = (j / segs) * Math.PI * 2, k = i * segs + j;
      px[k] = r * Math.sin(phi) * Math.cos(th);
      py[k] = r * Math.cos(phi);
      pz[k] = r * Math.sin(phi) * Math.sin(th) + cz;
    }
  }
  const idx = new Uint32Array(nt * 3);
  let t = 0;
  for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
    const j1 = (j + 1) % segs;
    const a = i * segs + j, b = (i + 1) * segs + j, c = (i + 1) * segs + j1, d = i * segs + j1;
    idx[3 * t] = a; idx[3 * t + 1] = b; idx[3 * t + 2] = c; t++;
    idx[3 * t] = a; idx[3 * t + 1] = c; idx[3 * t + 2] = d; t++;
  }
  return { nv, nt, px, py, pz, idx };
}

function merge(parts) {
  let nv = 0, nt = 0;
  for (const p of parts) { nv += p.nv; nt += p.nt; }
  const px = new Float32Array(nv), py = new Float32Array(nv), pz = new Float32Array(nv);
  const idx = new Uint32Array(nt * 3);
  let vo = 0, to = 0;
  for (const p of parts) {
    px.set(p.px, vo); py.set(p.py, vo); pz.set(p.pz, vo);
    for (let i = 0; i < p.nt * 3; i++) idx[to * 3 + i] = p.idx[i] + vo;
    vo += p.nv; to += p.nt;
  }
  return { nv, nt, px, py, pz, idx };
}

// project + backface cull + depth sort: the part the engine already has
function project(m, dist, scale) {
  const sx = new Float32Array(m.nv), sy = new Float32Array(m.nv), sz = new Float32Array(m.nv);
  for (let i = 0; i < m.nv; i++) {
    const vz = m.pz[i] + dist, iw = scale / vz;
    sx[i] = W * 0.5 + m.px[i] * iw;
    sy[i] = H * 0.5 - m.py[i] * iw;
    sz[i] = vz;
  }
  const bx0 = new Float32Array(m.nt), by0 = new Float32Array(m.nt),
        bx1 = new Float32Array(m.nt), by1 = new Float32Array(m.nt);
  const vis = [];
  for (let t = 0; t < m.nt; t++) {
    const a = m.idx[3 * t], b = m.idx[3 * t + 1], c = m.idx[3 * t + 2];
    // NOTE the sign.  With sy flipped for screen space and the winding this
    // generator emits, the NEAR-facing triangle has negative screen area.
    // bench/scene.js keeps the other one, which is why every measurement in
    // bench/ was taken on the far sheet of the mesh.
    const ar = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sy[b] - sy[a]) * (sx[c] - sx[a]);
    if (ar >= 0) continue;
    bx0[t] = Math.min(sx[a], sx[b], sx[c]); bx1[t] = Math.max(sx[a], sx[b], sx[c]);
    by0[t] = Math.min(sy[a], sy[b], sy[c]); by1[t] = Math.max(sy[a], sy[b], sy[c]);
    if (bx1[t] < 0 || by1[t] < 0 || bx0[t] > W || by0[t] > H) continue;
    vis.push([t, (sz[a] + sz[b] + sz[c]) / 3]);
  }
  vis.sort((p, q) => q[1] - p[1]);                               // far first
  const order = new Int32Array(m.nt);
  for (let i = 0; i < vis.length; i++) order[i] = vis[i][0];
  return { order, nVis: vis.length, sx, sy, sz, bx0, by0, bx1, by1 };
}

// brute-force: who owns each pixel under a painter over `list` (far -> near)?
function ownerOf(m, s, list) {
  const own = new Int32Array(W * H).fill(-1);
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const a = m.idx[3 * t], b = m.idx[3 * t + 1], c = m.idx[3 * t + 2];
    let ax = s.sx[a], ay = s.sy[a], bx = s.sx[b], by = s.sy[b], cx = s.sx[c], cy = s.sy[c];
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < 0) {      // normalise winding
      let tq = bx; bx = cx; cx = tq; tq = by; by = cy; cy = tq;
    }
    const X0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const X1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    const Y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const Y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const f0 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      const f1 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
      const f2 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
      if (f0 >= 0 && f1 >= 0 && f2 >= 0) own[y * W + x] = t;
    }
  }
  return own;
}

// ---------------------------------------------------------------------------
{
  const m = merge([sphere(48, 24, 1.0, 0), sphere(48, 24, 0.55, 0)]);
  const adj = buildAdjacency(m.idx, m.nv);
  const s = project(m, 4, 300);
  check('nested spheres: both hemispheres survive projection', s.nVis > 1000, 'nVis=' + s.nVis);

  const full = ownerOf(m, s, Array.from(s.order.subarray(0, s.nVis)));
  const seen = new Set();
  for (let p = 0; p < full.length; p++) if (full[p] >= 0) seen.add(full[p]);

  const bare = new Occluder({
    width: W, height: H, triangleCount: m.nt, indices: m.idx,
    adjacency: adj, skirt: false, autoSkip: false
  });
  bare.cull(s);
  const bareSet = new Set(Array.from(bare.list));

  // no false culls: everything that owns a pixel in the full render survived
  let bad = 0;
  for (const t of seen) if (!bareSet.has(t)) bad++;
  check('no false culls at 1 spp', bad === 0, bad + ' faces owning pixels were dropped');

  check('culls the hidden inner sphere', bare.rate > 0.3,
    'rate=' + bare.rate.toFixed(3) + ' (' + bare.culled + '/' + s.nVis + ')');

  // survivors keep painter order (a subsequence of `order`)
  let k = 0, ok = true;
  for (let i = 0; i < s.nVis && k < bare.count; i++) if (s.order[i] === bare.list[k]) k++;
  check('survivors keep painter order', k === bare.count && ok, k + ' of ' + bare.count);

  // the skirt is a superset
  const sk = new Occluder({
    width: W, height: H, triangleCount: m.nt, indices: m.idx,
    adjacency: adj, skirt: true, autoSkip: false
  });
  sk.cull(s);
  const skSet = new Set(Array.from(sk.list));
  let missing = 0;
  for (const t of bareSet) if (!skSet.has(t)) missing++;
  check('skirt keeps everything the bare culler kept', missing === 0, missing + ' missing');
  // ...and here it costs NOTHING, which is the point worth pinning down: the
  // skirt only grows across shared mesh edges, so it charges for a surface
  // occluding ITSELF and is free for one object occluding another.  Two
  // separate spheres share no edge, so the rates are identical.
  check('skirt is free for inter-object occlusion', sk.rate === bare.rate,
    'skirt=' + sk.rate.toFixed(3) + ' bare=' + bare.rate.toFixed(3));

  // culling the culled set again must be a no-op: it is already all visible
  const s2 = Object.assign({}, s, { order: sk.list, nVis: sk.count });
  const again = new Occluder({
    width: W, height: H, triangleCount: m.nt, indices: m.idx,
    adjacency: adj, skirt: true, autoSkip: false
  });
  again.cull(s2);
  check('culling is idempotent', again.culled === 0, 'dropped ' + again.culled + ' more');
}

// ---------------------------------------------------------------------------
// a convex closed mesh has one sheet after backface culling.  Nothing to cull,
// and the guard has to notice.
// ---------------------------------------------------------------------------
{
  const m = sphere(64, 32, 1.0, 0);
  const adj = buildAdjacency(m.idx, m.nv);
  const s = project(m, 4, 300);
  const occ = new Occluder({
    width: W, height: H, triangleCount: m.nt, indices: m.idx, adjacency: adj
  });
  occ.cull(s);
  check('convex mesh culls (almost) nothing', occ.rate < 0.02, 'rate=' + occ.rate.toFixed(4));
  check('guard arms after a wasted frame', occ.skipFrames > 0, 'skipFrames=' + occ.skipFrames);

  // back-off is 4 frames, then ONE re-probe, then 8, and so on: the culler
  // has to keep checking or it could never notice the camera moving into a
  // scene that does occlude.
  const arm = occ.skipFrames;
  let ran = 0;
  for (let f = 0; f < arm + 1; f++) { occ.cull(s); if (!occ.skipped) ran++; }
  check('guard skips the whole back-off interval', ran === 1,
    ran + ' of ' + (arm + 1) + ' frames ran (expected exactly the re-probe)');
  check('back-off doubles after a second wasted probe', occ.skipFrames === arm * 2,
    'skipFrames=' + occ.skipFrames + ' after arm=' + arm);
  occ.cull(s);
  check('a skipped frame passes the full list through',
    occ.skipped && occ.count === s.nVis && occ.list === s.order);
}

// ---------------------------------------------------------------------------
// zero allocation per frame
// ---------------------------------------------------------------------------
{
  const m = merge([sphere(40, 20, 1.0, 0), sphere(40, 20, 0.55, 0)]);
  const adj = buildAdjacency(m.idx, m.nv);
  const s = project(m, 4, 300);
  const occ = new Occluder({
    width: W, height: H, triangleCount: m.nt, indices: m.idx,
    adjacency: adj, autoSkip: false
  });
  for (let i = 0; i < 5; i++) occ.cull(s);

  // Assert the PROPERTY, not the heap: every frame's survivor list must be a
  // view onto the one preallocated buffer, and none of the fixed arrays may be
  // reallocated.  A heapUsed delta cannot test this -- without a forced GC it
  // reads collector noise, which is how this check used to fail intermittently
  // at 572 to 9134 bytes/frame against a 512-byte threshold.
  const keepBuf = occ.keep.buffer, covBuf = occ.cov.buffer,
        blkBuf = occ.blk.buffer, markBuf = occ.mark.buffer;
  let aliased = true, lens = true;
  const covLen = occ.cov.length, blkLen = occ.blk.length;
  for (let i = 0; i < 200; i++) {
    occ.cull(s);
    if (occ.list.buffer !== keepBuf) aliased = false;
    if (occ.cov.buffer !== covBuf || occ.blk.buffer !== blkBuf ||
        occ.mark.buffer !== markBuf) aliased = false;
    if (occ.cov.length !== covLen || occ.blk.length !== blkLen) lens = false;
  }
  check('survivor list is a view on the preallocated buffer', aliased);
  check('no buffer is reallocated across 200 frames', lens);

  // Informational, with a loose bound: the only object per frame is the
  // subarray view itself.  Needs --expose-gc to be meaningful, so it only
  // asserts when it can force a collection.
  if (global.gc) {
    global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 200; i++) occ.cull(s);
    global.gc();
    const grew = process.memoryUsage().heapUsed - before;
    check('heap flat across 200 frames (gc forced)', grew < 200 * 256,
      (grew / 200).toFixed(0) + ' bytes/frame');
  } else {
    console.log('skip  heap check (run with --expose-gc to enable)');
  }
}

console.log(failures ? '\n' + failures + ' FAILURES' : '\nall checks passed');
process.exit(failures ? 1 : 0);
