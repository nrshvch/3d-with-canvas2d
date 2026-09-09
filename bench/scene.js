// ---------------------------------------------------------------------------
// scene.js -- per-frame transform / backface cull / flat shade / depth sort.
// Zero allocation after construction.  This is the part every strategy shares,
// so it is excluded from the strategy comparison but measured on its own.
// ---------------------------------------------------------------------------
'use strict';

function Scene(mesh, W, H, palShades, palBands) {
  this.m = mesh;
  this.W = W; this.H = H;
  const nv = mesh.nv, nt = mesh.nt;

  // projected vertices
  this.sx = new Float32Array(nv);
  this.sy = new Float32Array(nv);
  this.sz = new Float32Array(nv);

  // per visible-triangle SoA, indexed by *visible slot*
  this.vis    = new Int32Array(nt);       // slot -> triangle id
  this.order  = new Int32Array(nt);       // depth-sorted slot list -> triangle id
  this.col    = new Uint8Array(nt);       // triangle id -> palette index
  this.bx0    = new Float32Array(nt);     // triangle id -> screen bbox
  this.by0    = new Float32Array(nt);
  this.bx1    = new Float32Array(nt);
  this.by1    = new Float32Array(nt);
  this.nVis   = 0;

  // radix sort scratch (16-bit key, single pass)
  this.key    = new Uint16Array(nt);
  this.cnt    = new Uint32Array(65536);
  this.zc     = new Float32Array(nt);

  this.palShades = palShades;             // shades per material band
  this.palBands  = palBands;
  this.pal = new Array(256);              // pregenerated CSS colour strings
  this.palRGB = new Uint8Array(256 * 3);
  for (let b = 0; b < palBands; b++) {
    const hue = (b / palBands) * 360;
    for (let s = 0; s < palShades; s++) {
      const i = b * palShades + s;
      if (i > 255) break;
      const l = 0.14 + 0.80 * (s / Math.max(1, palShades - 1));
      const rgb = hsl2rgb(hue, 0.62, l);
      this.palRGB[i * 3] = rgb[0]; this.palRGB[i * 3 + 1] = rgb[1]; this.palRGB[i * 3 + 2] = rgb[2];
      this.pal[i] = '#' + hex2(rgb[0]) + hex2(rgb[1]) + hex2(rgb[2]);
    }
  }
}

function hex2(v) { return (v < 16 ? '0' : '') + v.toString(16); }
function hsl2rgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, hp = h / 60, x = c * (1 - Math.abs(hp % 2 - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; } else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; } else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; } else { r = c; b = x; }
  const mm = l - c / 2;
  return [Math.round((r + mm) * 255), Math.round((g + mm) * 255), Math.round((b + mm) * 255)];
}

// ---------------------------------------------------------------------------
Scene.prototype.build = function (ax, ay, az, dist, scale) {
  const m = this.m, nv = m.nv, nt = m.nt;
  const sx = this.sx, sy = this.sy, sz = this.sz;
  const cx = Math.cos(ax), sxr = Math.sin(ax);
  const cy = Math.cos(ay), syr = Math.sin(ay);
  const cz = Math.cos(az), szr = Math.sin(az);
  const cxp = this.W * 0.5, cyp = this.H * 0.5;
  const f = scale;

  // rotation matrix (ZYX)
  const r00 = cy * cz, r01 = cy * szr, r02 = -syr;
  const r10 = sxr * syr * cz - cx * szr, r11 = sxr * syr * szr + cx * cz, r12 = sxr * cy;
  const r20 = cx * syr * cz + sxr * szr, r21 = cx * syr * szr - sxr * cz, r22 = cx * cy;

  for (let i = 0; i < nv; i++) {
    const X = m.px[i], Y = m.py[i], Z = m.pz[i];
    const vx = r00 * X + r01 * Y + r02 * Z;
    const vy = r10 * X + r11 * Y + r12 * Z;
    const vz = r20 * X + r21 * Y + r22 * Z + dist;
    const iw = f / vz;
    sx[i] = cxp + vx * iw;
    sy[i] = cyp - vy * iw;
    sz[i] = vz;
  }

  // light dir in view space
  const lx = 0.40, ly = 0.62, lz = -0.67;
  const idx = m.idx, mat = m.mat, col = this.col, vis = this.vis;
  const bx0 = this.bx0, by0 = this.by0, bx1 = this.bx1, by1 = this.by1;
  const key = this.key, shades = this.palShades;
  const W = this.W, H = this.H;

  let n = 0, zmin = Infinity, zmax = -Infinity;
  for (let t = 0; t < nt; t++) {
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
    const ax0 = sx[a], ay0 = sy[a], bx = sx[b], by = sy[b], cx0 = sx[c], cy0 = sy[c];
    // backface cull in screen space (also kills degenerates)
    const area = (bx - ax0) * (cy0 - ay0) - (by - ay0) * (cx0 - ax0);
    if (area <= 0) continue;
    // frustum cull (screen bbox)
    let x0 = ax0 < bx ? ax0 : bx; if (cx0 < x0) x0 = cx0;
    let x1 = ax0 > bx ? ax0 : bx; if (cx0 > x1) x1 = cx0;
    let y0 = ay0 < by ? ay0 : by; if (cy0 < y0) y0 = cy0;
    let y1 = ay0 > by ? ay0 : by; if (cy0 > y1) y1 = cy0;
    if (x1 < 0 || y1 < 0 || x0 > W || y0 > H) continue;

    // flat shade from the *view-space* normal of the model triangle
    const aX = m.px[a], aY = m.py[a], aZ = m.pz[a];
    const e1x = m.px[b] - aX, e1y = m.py[b] - aY, e1z = m.pz[b] - aZ;
    const e2x = m.px[c] - aX, e2y = m.py[c] - aY, e2z = m.pz[c] - aZ;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const vnx = r00 * nx + r01 * ny + r02 * nz;
    const vny = r10 * nx + r11 * ny + r12 * nz;
    const vnz = r20 * nx + r21 * ny + r22 * nz;
    const nl = Math.sqrt(vnx * vnx + vny * vny + vnz * vnz) || 1;
    let lam = (vnx * lx + vny * ly + vnz * lz) / nl;
    lam = lam * 0.5 + 0.5;
    let s = (lam * shades) | 0; if (s < 0) s = 0; else if (s >= shades) s = shades - 1;
    col[t] = mat[t] * shades + s;

    bx0[t] = x0; by0[t] = y0; bx1[t] = x1; by1[t] = y1;
    const z = (sz[a] + sz[b] + sz[c]) * 0.3333333;
    if (z < zmin) zmin = z; if (z > zmax) zmax = z;
    vis[n] = t; this.zc[n] = z;
    n++;
  }
  this.nVis = n;
  if (n === 0) return this;

  // ---- 16-bit radix (counting) sort, back-to-front = descending z ----------
  const span = (zmax - zmin) || 1, ks = 65535 / span;
  const zc = this.zc;
  for (let i = 0; i < n; i++) key[i] = 65535 - (((zc[i] - zmin) * ks) | 0); // far first
  const cnt = this.cnt; cnt.fill(0);
  for (let i = 0; i < n; i++) cnt[key[i]]++;
  let acc = 0;
  for (let k = 0; k < 65536; k++) { const c0 = cnt[k]; cnt[k] = acc; acc += c0; }
  const order = this.order;
  for (let i = 0; i < n; i++) order[cnt[key[i]]++] = vis[i];
  return this;
};
