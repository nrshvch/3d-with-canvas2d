// node bench/ffcache.mjs [bufMB]   -- predict Firefox's A7 verdict, frame by frame
// ---------------------------------------------------------------------------
// The idea.  A9 (bench/wgr.mjs) prices a frame as the tessellated output of
// its paths, and against gpu-path-size that predicts a STILL frame's verdict.
// It cannot say what happens to a moving one, because the verdict is not
// decided by the output alone: it is decided by DrawTargetWebgl's bookkeeping,
// frame after frame.  That bookkeeping is small, deterministic and readable
// in FIREFOX_156_0_RELEASE's dom/canvas/DrawTargetWebgl.cpp, so this script
// runs it:
//
//   path cache   DrawPathAccel keys a path by its points RELATIVE TO ITS OWN
//                integer bounds origin (origin rounded to 1/4 px), in WGR's
//                28.4 fixed point (GenerateQuantizedPath).  A translated copy
//                of a shape is the same key.  8 192 entries, oldest evicted
//                (gfx.canvas.accelerated.cache-items).
//   buffer       DrawWGRPath appends a miss's output to the shared vertex
//                buffer (gpu-path-size); when it does not fit, it calls
//                ClearVertexRanges() -- every cached entry loses its vertices,
//                keeps its key -- and starts again from 0.  A hit whose
//                vertices were cleared is a miss.
//   profile      UsageProfile::EndFrame fails a frame when misses exceed 0.66
//                of its path draws; RequiresRefresh() demotes, permanently,
//                once 10 frames are counted and more than 0.3 of them failed.
//
// The trick is only that none of this needs a browser: the key is cacheKey()
// in bench/wgr.mjs, the output is WGR's own (M5), and the rest is counting.
// What it buys is the verdict of a MOVING frame, which is where every 3D
// renderer lives -- and the explanation of the field report that 20 000 small
// faces stay accelerated: small shapes collide in 1/16 px key space, so even
// a rotating view hits the cache (T68).
//
// What it does not model: readbacks, layers and fallbacks (the other terms of
// EndFrame -- none here), the texture-cache route a path takes when WGR
// declines it, and the byte limit of the cache (cache-size, 256 MB).  Checked
// against M6's browser verdicts in T68; a disagreement is a finding.
//
// Output: part N's loads (tesspage.html part N) held still, moved and turned,
// then S1-S3's cuts held still and rotating (part D) -- verdict, the frame it
// demoted on, and how often the buffer wrapped.  Counts only, deterministic.
// ---------------------------------------------------------------------------
import { wgr, aaStroke, cacheKey, pathBufferVerts } from './wgr.mjs';
import { fieldLoad, fieldMotion, runStrategy } from './pathshape.js';
import { CASES, setup } from './tess.mjs';

const W = 1280, H = 720, FRAMES = 45;
const BUF_MB = +(process.argv[2] || 4);

// one simulated DrawTargetWebgl canvas
export class GeckoCanvas {
  constructor({ bufMB = 4, cacheItems = 8192, profileFrames = 10, missRatio = 0.66, failRatio = 0.3 } = {}) {
    this.cap = pathBufferVerts(bufMB); this.cacheItems = cacheItems;
    this.profileFrames = profileFrames; this.missRatio = missRatio; this.failRatio = failRatio;
    this.cache = new Map();        // key -> { valid }; insertion order = age
    this.off = 0; this.wraps = 0; this.frames = 0; this.failed = 0; this.demotedAt = -1;
    this.miss = 0; this.hit = 0;
  }
  // one path draw: `buf`/`n` in bench/wgr.mjs's subpath format
  draw(buf, n, stroke, lw) {
    const k = (stroke ? 's' + lw + ':' : 'f') + cacheKey(buf, n, stroke ? lw / 2 : 0);
    const e = this.cache.get(k);
    if (e && e.valid) { this.hit++; this.cache.delete(k); this.cache.set(k, e); return; }
    let v;
    if (stroke) {
      const s = this.sbuf && this.sbuf.length >= n + (n >> 1) ? this.sbuf : (this.sbuf = new Float32Array(2 * n + 16));
      let i = 0, o = 0;
      while (i < n) { const c = buf[i]; s[o++] = c; s[o++] = 0; for (let j = 0; j < 2 * c; j++) s[o++] = buf[i + 1 + j]; i += 1 + 2 * c; }
      v = aaStroke(s, o, lw);
    } else v = wgr(buf, n, W, H).verts;
    if (v > this.cap - this.off) { for (const x of this.cache.values()) x.valid = false; this.off = 0; this.wraps++; }
    this.off += v; this.miss++;
    if (e) e.valid = true;
    else { this.cache.set(k, { valid: true }); if (this.cache.size > this.cacheItems) this.cache.delete(this.cache.keys().next().value); }
  }
  endFrame() {
    if (this.miss > this.missRatio * (this.miss + this.hit)) this.failed++;
    this.frames++; this.miss = 0; this.hit = 0;
    if (this.demotedAt < 0 && this.frames >= this.profileFrames && this.failed > this.failRatio * this.frames)
      this.demotedAt = this.frames;
  }
  get verdict() { return this.demotedAt < 0 ? 'ACCEL' : 'soft'; }
}

// a canvas2d-shaped front end, so runStrategy() can draw into it
class SimContext {
  constructor(g) { this.g = g; this.buf = new Float32Array(1 << 22); this.n = 0; this.head = -1; this.lw = 1; }
  beginPath() { this.n = 0; this.head = -1; }
  moveTo(x, y) { if (this.n + 3 > this.buf.length) this.grow(); this.head = this.n; this.buf[this.n++] = 1; this.buf[this.n++] = x; this.buf[this.n++] = y; }
  lineTo(x, y) { if (this.n + 2 > this.buf.length) this.grow(); this.buf[this.head]++; this.buf[this.n++] = x; this.buf[this.n++] = y; }
  grow() { const b = new Float32Array(this.buf.length * 2); b.set(this.buf); this.buf = b; }
  closePath() {}
  fill() { if (this.n) this.g.draw(this.buf, this.n, false, 0); }
  stroke() { if (this.n) this.g.draw(this.buf, this.n, true, this.lw); }
  fillRect() {}
  set fillStyle(v) {} set strokeStyle(v) {} set lineWidth(v) { this.lw = v; } get lineWidth() { return this.lw; }
}

const isMain = import.meta.url === 'file://' + process.argv[1];
if (isMain) {
  const rp = (v, n) => String(v).padStart(n), pd = (v, n) => String(v).padEnd(n);
  const cell = (g) => pd(g.verdict + (g.demotedAt > 0 ? ' @' + g.demotedAt : '') + (g.wraps ? '  w' + g.wraps : ''), 18);
  console.log(`Gecko's path cache + ${BUF_MB} MB vertex buffer + UsageProfile, simulated over ${FRAMES} frames (T68).`);
  console.log('Firefox 156 DrawTargetWebgl rules; verdict, the frame it demoted on (@), buffer wraps (w).\n');

  console.log('part N: 20 000 separate triangle fills (M6 measured all 27 in T68)');
  console.log('  ' + pd('load', 14) + pd('still', 18) + pd('moved', 18) + pd('turned', 18));
  const buf = new Float32Array(7); buf[0] = 3;
  for (const [kind, L] of [['scatter', 1], ['scatter', 2], ['scatter', 4], ['scatter', 8], ['scatter', 15],
                           ['mesh', 1], ['mesh', 2], ['mesh', 4], ['mesh', 7]]) {
    const T = fieldLoad(kind, L, 20000, 99, W, H), F = new Float32Array(T.length);
    let line = '  ' + pd(kind + ' ' + L + ' px', 14);
    for (const mode of ['still', 'moved', 'turned']) {
      const g = new GeckoCanvas({ bufMB: BUF_MB });
      for (let f = 0; f < FRAMES; f++) {
        fieldMotion(T, mode, f, F);
        for (let i = 0; i < 20000; i++) { buf.set(F.subarray(6 * i, 6 * i + 6), 1); g.draw(buf, 7, false, 0); }
        g.endFrame();
      }
      line += cell(g);
    }
    console.log(line);
  }

  console.log('\nS1-S3 cuts (part D): held still, and rotating 0.002 rad per frame');
  console.log('  ' + pd('scene / cut', 34) + pd('still', 18) + pd('rotating', 18));
  const ANG = [0.4, 0.9, 0.13, 3.1, 620];
  for (const [nm, mk, sh, bd] of CASES) {
    const X = setup(mk, sh, bd);
    for (const st of ['perFace', 'boundary', 'band+exact+end8', 'shipped']) {
      let line = '  ' + pd(nm + ' / ' + st, 34);
      for (const rot of [false, true]) {
        const g = new GeckoCanvas({ bufMB: BUF_MB }), ctx = new SimContext(g);
        for (let f = 0; f < FRAMES; f++) {
          X.scene.build(ANG[0], ANG[1], ANG[2] + (rot ? 0.002 * (f % 50) : 0), ANG[3], ANG[4]); X.s.nVis = X.scene.nVis;
          runStrategy(st, X, ctx); g.endFrame();
          if (g.demotedAt > 0) break;          // permanent: nothing left to learn
        }
        line += cell(g);
      }
      console.log(line);
    }
  }
}
