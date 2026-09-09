// ---------------------------------------------------------------------------
// mesh.js -- indexed meshes + static edge adjacency.  Built ONCE, never in the
// hot loop.  Everything is a typed array (SoA) so the render loop allocates 0.
// ---------------------------------------------------------------------------
'use strict';

function Mesh(nv, nt) {
  this.nv = nv;
  this.nt = nt;
  this.px = new Float32Array(nv);
  this.py = new Float32Array(nv);
  this.pz = new Float32Array(nv);
  this.idx = new Uint32Array(nt * 3);
  this.mat = new Uint8Array(nt);          // material band (0..matBands-1)
  this.adj = new Int32Array(nt * 3);      // adj[3t+e] = neighbour tri across edge e, or -1
  this.adj.fill(-1);
}

// edge e of triangle t goes idx[3t+e] -> idx[3t+(e+1)%3]
function buildAdjacency(m) {
  const map = new Map();                  // key = lo*nv+hi  ->  packed (t*3+e)+1
  const idx = m.idx, nv = m.nv;
  for (let t = 0; t < m.nt; t++) {
    for (let e = 0; e < 3; e++) {
      const a = idx[3 * t + e];
      const b = idx[3 * t + ((e + 1) % 3)];
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const key = lo * nv + hi;
      const prev = map.get(key);
      if (prev === undefined) {
        map.set(key, t * 3 + e);
      } else {
        const pt = (prev / 3) | 0, pe = prev % 3;
        m.adj[3 * t + e] = pt;
        m.adj[3 * pt + pe] = t;
        map.delete(key);                  // >2 faces per edge: leave rest unpaired
      }
    }
  }
  return m;
}

// --- torus knot tube: dense, fully manifold, strong normal coherence --------
function makeTorusKnot(segs, sides, p, q, matBands) {
  const nv = segs * sides;
  const nt = segs * sides * 2;
  const m = new Mesh(nv, nt);
  const R = 1.0, r = 0.34;
  const cur = new Float32Array(3), tan = new Float32Array(3),
        nrm = new Float32Array(3), bin = new Float32Array(3);
  for (let i = 0; i < segs; i++) {
    const u = (i / segs) * Math.PI * 2 * p;
    const cu = Math.cos(u), su = Math.sin(u);
    const qp = (q / p) * u, cqp = Math.cos(qp);
    cur[0] = R * (2 + cqp) * 0.5 * cu;
    cur[1] = R * (2 + cqp) * 0.5 * su;
    cur[2] = R * Math.sin(qp) * 0.5;
    // numeric tangent
    const u2 = u + 0.01, cu2 = Math.cos(u2), su2 = Math.sin(u2);
    const qp2 = (q / p) * u2, cqp2 = Math.cos(qp2);
    tan[0] = R * (2 + cqp2) * 0.5 * cu2 - cur[0];
    tan[1] = R * (2 + cqp2) * 0.5 * su2 - cur[1];
    tan[2] = R * Math.sin(qp2) * 0.5 - cur[2];
    let tl = Math.hypot(tan[0], tan[1], tan[2]);
    tan[0] /= tl; tan[1] /= tl; tan[2] /= tl;
    // frame
    nrm[0] = -tan[1]; nrm[1] = tan[0]; nrm[2] = 0;
    let nl = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1;
    nrm[0] /= nl; nrm[1] /= nl; nrm[2] /= nl;
    bin[0] = tan[1] * nrm[2] - tan[2] * nrm[1];
    bin[1] = tan[2] * nrm[0] - tan[0] * nrm[2];
    bin[2] = tan[0] * nrm[1] - tan[1] * nrm[0];
    for (let j = 0; j < sides; j++) {
      const v = (j / sides) * Math.PI * 2;
      const cv = Math.cos(v), sv = Math.sin(v);
      const k = i * sides + j;
      m.px[k] = cur[0] + r * (cv * nrm[0] + sv * bin[0]);
      m.py[k] = cur[1] + r * (cv * nrm[1] + sv * bin[1]);
      m.pz[k] = cur[2] + r * (cv * nrm[2] + sv * bin[2]);
    }
  }
  let t = 0;
  for (let i = 0; i < segs; i++) {
    const i1 = (i + 1) % segs;
    for (let j = 0; j < sides; j++) {
      const j1 = (j + 1) % sides;
      const a = i * sides + j, b = i1 * sides + j, c = i1 * sides + j1, d = i * sides + j1;
      const band = ((i / segs) * matBands) | 0;
      m.idx[3 * t] = a; m.idx[3 * t + 1] = b; m.idx[3 * t + 2] = c; m.mat[t] = band; t++;
      m.idx[3 * t] = a; m.idx[3 * t + 1] = c; m.idx[3 * t + 2] = d; m.mat[t] = band; t++;
    }
  }
  return buildAdjacency(m);
}

// --- UV sphere: classic flat-shaded ball, huge same-colour bands ------------
function makeSphere(segs, rings, matBands) {
  const nv = segs * (rings + 1);
  const nt = segs * rings * 2;
  const m = new Mesh(nv, nt);
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI;
    for (let j = 0; j < segs; j++) {
      const th = (j / segs) * Math.PI * 2, k = i * segs + j;
      m.px[k] = Math.sin(phi) * Math.cos(th);
      m.py[k] = Math.cos(phi);
      m.pz[k] = Math.sin(phi) * Math.sin(th);
    }
  }
  let t = 0;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      const a = i * segs + j, b = (i + 1) * segs + j, c = (i + 1) * segs + j1, d = i * segs + j1;
      const band = ((j / segs) * matBands) | 0;
      m.idx[3 * t] = a; m.idx[3 * t + 1] = b; m.idx[3 * t + 2] = c; m.mat[t] = band; t++;
      m.idx[3 * t] = a; m.idx[3 * t + 1] = c; m.idx[3 * t + 2] = d; m.mat[t] = band; t++;
    }
  }
  return buildAdjacency(m);
}

// --- heightfield grid: near-planar, best case for collinear cancellation ----
function makeGrid(n, matBands) {
  const nv = (n + 1) * (n + 1), nt = n * n * 2;
  const m = new Mesh(nv, nt);
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    const k = i * (n + 1) + j;
    m.px[k] = (j / n - 0.5) * 2.4;
    m.pz[k] = (i / n - 0.5) * 2.4;
    m.py[k] = 0.30 * Math.sin(j * 0.31) * Math.cos(i * 0.27);
  }
  let t = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = i * (n + 1) + j, b = (i + 1) * (n + 1) + j,
          c = (i + 1) * (n + 1) + j + 1, d = i * (n + 1) + j + 1;
    const band = (((i + j) / (2 * n)) * matBands) | 0;
    m.idx[3 * t] = a; m.idx[3 * t + 1] = b; m.idx[3 * t + 2] = c; m.mat[t] = band; t++;
    m.idx[3 * t] = a; m.idx[3 * t + 1] = c; m.idx[3 * t + 2] = d; m.mat[t] = band; t++;
  }
  return buildAdjacency(m);
}

// --- true soup: no shared edges at all, random colours. Adversarial case. ---
function makeSoup(nt, matBands, seed) {
  const m = new Mesh(nt * 3, nt);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let t = 0; t < nt; t++) {
    const cx = rnd() * 2 - 1, cy = rnd() * 2 - 1, cz = rnd() * 2 - 1;
    for (let e = 0; e < 3; e++) {
      const k = t * 3 + e;
      m.px[k] = cx + (rnd() - 0.5) * 0.22;
      m.py[k] = cy + (rnd() - 0.5) * 0.22;
      m.pz[k] = cz + (rnd() - 0.5) * 0.22;
      m.idx[k] = k;
    }
    m.mat[t] = (rnd() * matBands) | 0;
  }
  return m; // adjacency stays -1 everywhere
}

// --- what a real engine hands you: a watertight mesh with NO shared indices.
// Geometrically identical to the source mesh (so the seams are all there and
// all need hiding), but adjacency is invisible until you weld it back.
function makeUnindexed(src) {
  const nt = src.nt, m = new Mesh(nt * 3, nt);
  for (let t = 0; t < nt; t++) {
    for (let e = 0; e < 3; e++) {
      const v = src.idx[3 * t + e], k = t * 3 + e;
      m.px[k] = src.px[v]; m.py[k] = src.py[v]; m.pz[k] = src.pz[v];
      m.idx[k] = k;
    }
    m.mat[t] = src.mat[t];
  }
  return m;                       // adjacency stays -1: nothing shares a vertex
}

// Weld coincident vertices back together, then rebuild adjacency.  Init-time.
function weldMesh(src, eps) {
  const inv = 1 / (eps || 1e-5), map = new Map();
  const nv = src.nv, remap = new Uint32Array(nv);
  const px = new Float32Array(nv), py = new Float32Array(nv), pz = new Float32Array(nv);
  let n = 0;
  for (let i = 0; i < nv; i++) {
    const key = Math.round(src.px[i] * inv) + ',' + Math.round(src.py[i] * inv) + ',' + Math.round(src.pz[i] * inv);
    let v = map.get(key);
    if (v === undefined) { v = n++; map.set(key, v); px[v] = src.px[i]; py[v] = src.py[i]; pz[v] = src.pz[i]; }
    remap[i] = v;
  }
  const m = new Mesh(n, src.nt);
  m.px.set(px.subarray(0, n)); m.py.set(py.subarray(0, n)); m.pz.set(pz.subarray(0, n));
  for (let i = 0; i < src.nt * 3; i++) m.idx[i] = remap[src.idx[i]];
  m.mat.set(src.mat);
  return buildAdjacency(m);
}

// --- k instances of a mesh at model-space offsets: a real *scene*, with real
// inter-object occlusion, which one solid object cannot exhibit. Adjacency is
// per instance automatically (instances share no vertex indices).
function makeInstances(src, offsets) {
  const k = offsets.length;
  const m = new Mesh(src.nv * k, src.nt * k);
  for (let i = 0; i < k; i++) {
    const ox = offsets[i][0], oy = offsets[i][1], oz = offsets[i][2];
    const vo = i * src.nv, to = i * src.nt;
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
