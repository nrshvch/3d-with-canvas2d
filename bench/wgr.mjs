// bench/wgr.mjs -- Firefox 156's path tessellator (WGR), in plain Node.
// ---------------------------------------------------------------------------
// import { wgr } from './wgr.mjs';
// const r = wgr(pathBuf, nFloats);  // -> { verts, bytes, traps, scans }
//
// `pathBuf` is a Float32Array of subpaths, [n, x0, y0, ... x(n-1), y(n-1), n, ...]
// in device pixels, filled NONZERO like canvas2d's fill(). Every subpath is
// closed, as fill() closes it.
//
//   verts  OutputVertex count WGR produced -- what DrawTargetWebgl uploads into
//          the shared gpu-path-size buffer (12 bytes each) on a cache miss
//   bytes  verts * 12
//   traps  simple trapezoids emitted (the fast path: 6 triangles each, with
//          the antialiasing ramps folded into the two sloped sides)
//   scans  per-scanline "complex scans" emitted (the slow path: every
//          coverage interval across the WHOLE row of the WHOLE path)
//
// and aaStroke(buf, n, width) does the same for a stroke, through aa-stroke.
//
// Built from Firefox's own vendored source by bench/wgr/build.mjs; see there.
// ---------------------------------------------------------------------------
// Isomorphic: Node reads the file, a browser page fetches it -- so a page can
// count the tessellation of the very paths it just drew.
const WASM_URL = new URL('./wgr/wgr.wasm', import.meta.url);
const bytes = typeof window === 'undefined'
  ? (await import('fs')).readFileSync(WASM_URL)
  : await (await fetch(WASM_URL)).arrayBuffer();
const { instance } = await WebAssembly.instantiate(bytes, {});
const X = instance.exports;

// Firefox's path vertex buffer: gfx.canvas.accelerated.gpu-path-size MB of
// 12-byte OutputVertex (x, y, coverage).
export const OUTPUT_VERTEX_BYTES = 12;
export const pathBufferVerts = (mb) => Math.floor(mb * 1024 * 1024 / OUTPUT_VERTEX_BYTES);

export function wgr(buf, n, clipW = 1280, clipH = 720) {
  const ptr = X.input_ptr(n);
  new Float32Array(X.memory.buffer, ptr, n).set(buf.subarray(0, n));
  const verts = X.raster(n, clipW, clipH);
  return { verts, bytes: verts * OUTPUT_VERTEX_BYTES, traps: X.trapezoids(), scans: X.complex_scans() };
}

// aa-stroke, as GenerateStrokeVertexBuffer drives it.  `buf` holds
// [n, closed, x0, y0, ...] per subpath.  Returns output vertices (12 bytes).
// An UPPER BOUND on what Firefox uploads for the stroke: a still stroke load
// stays accelerated at 1.2x this count and demotes by 2.0x (T67), so the real
// figure is 50-83 % of it.  The fill count (wgr) is exact: 27 of 27 verdicts.
export function aaStroke(buf, n, width) {
  const ptr = X.input_ptr(n);
  new Float32Array(X.memory.buffer, ptr, n).set(buf.subarray(0, n));
  return X.stroke(n, width);
}

// Total path-vertex-buffer output of a WgrContext: fills (WGR) + strokes
// (aa-stroke), counting every fill as a miss.
export const bufferVerts = (c) => c.verts + c.strokeVerts;
// ... and counting only the fills whose CACHE KEY is new this frame, which is
// what actually has to fit in gpu-path-size (T68).  DrawPathAccel keys its
// path cache on the path relative to its own integer bounds origin (origin
// quantised to 1/4 px), in WGR's 28.4 fixed point, and DrawWGRPath draws a
// hit from the vertex range already in the buffer.  A translated copy of a
// shape costs a cache hit, not buffer space.  On a batched 3D frame nearly
// every path is unique and the two counts agree; on a load of repeated shapes
// (a mesh of identical cells, sprites, glyph-like fills) they do not.
export const uniqBufferVerts = (c) => c.uniqVerts + c.uniqStrokeVerts;

// The key, as a string: bounds -> origin rounded to 1/4 px -> RoundedOut ->
// points relative to that origin plus the rounding residue -> add_point's
// round((x - 0.5) * 16).  `pad` inflates the bounds for a stroke's width.
// Subpath lengths go in too (WGR's point types).
export function cacheKey(b, n, pad = 0) {
  let x0 = Infinity, y0 = Infinity;
  for (let i = 0; i < n;) { const k = b[i]; for (let j = 0; j < k; j++) { const x = b[i + 1 + 2 * j], y = b[i + 2 + 2 * j]; if (x < x0) x0 = x; if (y < y0) y0 = y; } i += 1 + 2 * k; }
  x0 -= pad; y0 -= pad;
  const qx = Math.round(x0 * 4) / 4, qy = Math.round(y0 * 4) / 4;
  const ox = Math.max(0, Math.floor(qx)) + (x0 - qx), oy = Math.max(0, Math.floor(qy)) + (y0 - qy);
  let s = '';
  for (let i = 0; i < n;) {
    const k = b[i]; s += k + ':';
    for (let j = 0; j < k; j++) s += Math.round((Math.fround(b[i + 1 + 2 * j] - ox) - 0.5) * 16) + ',' + Math.round((Math.fround(b[i + 2 + 2 * j] - oy) - 0.5) * 16) + ',';
    i += 1 + 2 * k;
  }
  return s;
}

// A canvas2d-shaped recorder, so the same emitter code that drives a real
// context can drive WGR: beginPath/moveTo/lineTo/fill. Each fill() is one
// DrawTargetWebgl::Fill -> one WGR tessellation, exactly as Firefox issues
// them. Totals accumulate until reset().
export class WgrContext {
  constructor(cap = 1 << 22, W = 1280, H = 720) {
    this.buf = new Float32Array(cap); this.W = W; this.H = H; this.lw = 1;
    this.reset();
  }
  reset() {
    this.n = 0; this.head = -1;
    this.fills = 0; this.pathVerts = 0; this.subpaths = 0;
    this.verts = 0; this.traps = 0; this.scans = 0; this.maxVerts = 0;
    this.scanFills = 0;          // fills that needed at least one complex scan
    this.strokes = 0; this.strokeVerts = 0;   // aa-stroke output, see stroke()
    this.maxVerbs = 0;           // largest single path, in WGR path types (verbs):
                                 // gpu-path-complexity (4000) is compared to this
    this.seen = new Set();       // cache keys drawn since reset() -- see uniqBufferVerts
    this.uniqVerts = 0; this.uniqStrokeVerts = 0; this.keys = 0; this.hits = 0;
  }
  // true when this path's key is new since reset()
  miss(prefix, pad) {
    const k = prefix + cacheKey(this.buf, this.n, pad);
    if (this.seen.has(k)) { this.hits++; return false; }
    this.seen.add(k); this.keys++; return true;
  }
  beginPath() { this.n = 0; this.head = -1; }
  moveTo(x, y) {
    this.head = this.n; this.buf[this.n++] = 1; this.buf[this.n++] = x; this.buf[this.n++] = y;
    this.subpaths++; this.pathVerts++;
  }
  lineTo(x, y) {
    this.buf[this.head]++; this.buf[this.n++] = x; this.buf[this.n++] = y; this.pathVerts++;
  }
  closePath() {}
  verbs() { let v = 0, i = 0; while (i < this.n) { v += this.buf[i]; i += 1 + 2 * this.buf[i]; } return v; }
  fill() {
    if (this.n === 0) return;
    const vb = this.verbs(); if (vb > this.maxVerbs) this.maxVerbs = vb;
    const r = wgr(this.buf, this.n, this.W, this.H);
    this.fills++; this.verts += r.verts; this.traps += r.traps; this.scans += r.scans;
    if (r.scans > 0) this.scanFills++;
    if (r.verts > this.maxVerts) this.maxVerts = r.verts;
    if (this.miss('f', 0)) this.uniqVerts += r.verts;
  }
  // A solid, opaque stroke goes through aa-stroke (SupportsAAStroke ->
  // AAStrokeMode::Geometry) into the same path vertex buffer.  Canvas2d's
  // stroke defaults: butt caps, miter joins, miterLimit 10.  Subpaths are
  // open unless closePath() was called, and nothing here calls it.
  stroke() {
    if (this.n === 0) return;
    const vb = this.verbs(); if (vb > this.maxVerbs) this.maxVerbs = vb;
    const b = this.buf, s = this.sbuf || (this.sbuf = new Float32Array(this.buf.length + (this.buf.length >> 1)));
    let i = 0, o = 0;
    while (i < this.n) { const k = b[i]; s[o++] = k; s[o++] = 0; for (let j = 0; j < 2 * k; j++) s[o++] = b[i + 1 + j]; i += 1 + 2 * k; }
    const v = aaStroke(s, o, this.lw);
    this.strokes++; this.strokeVerts += v;
    if (v > this.maxVerts) this.maxVerts = v;
    if (this.miss('s' + this.lw + ':', this.lw / 2)) this.uniqStrokeVerts += v;
  }
  fillRect() {}
  set fillStyle(v) {} get fillStyle() { return '#000'; }
  set strokeStyle(v) {} set lineWidth(v) { this.lw = v; } get lineWidth() { return this.lw; }
  set globalCompositeOperation(v) {} set filter(v) {}
}
