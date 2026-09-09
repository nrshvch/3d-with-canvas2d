// ---------------------------------------------------------------------------
// harness.js -- canvas2d is a DEFERRED, GPU-backed API: performance.now()
// around fill() measures display-list recording, not rasterisation.  So we
// measure on three independent axes and report all three.
//
//   RECORD     cost of the JS + the canvas API calls (display list build).
//              Tight loop on a GPU canvas, no flush.  What you control in JS.
//   THROUGHPUT GPU-INCLUSIVE.  N repeats of the draw inside one rAF callback,
//              sized so the frame is far above the vsync period; the presented
//              frame interval then cannot be faster than CPU+GPU per frame.
//              Reported as ms per single draw.
//   RASTER     willReadFrequently canvas -> Skia CPU backend, + a 1px
//              getImageData to force completion.  Pure software rasterisation
//              cost, and the best proxy for a non-accelerated fallback.
//
// plus PIXEL VALIDATION against the per-triangle baseline.
// ---------------------------------------------------------------------------
'use strict';

const RESULTS = { env: {}, scenes: [], micro: [], notes: [] };

function median(a) { const b = Float64Array.from(a).sort(); return b[b.length >> 1]; }
function pct(a, p) { const b = Float64Array.from(a).sort(); return b[Math.min(b.length - 1, (b.length * p) | 0)]; }
function mkCanvas(W, H, opts) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  return { c, ctx: c.getContext('2d', opts) };
}
function clear(ctx, W, H) { ctx.fillStyle = '#101014'; ctx.fillRect(0, 0, W, H); }
function nextFrame() { return new Promise(r => requestAnimationFrame(r)); }
function timeLoop(fn, iters) {
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn(i);
  return (performance.now() - t0) / iters;
}

// --- RECORD / RASTER -------------------------------------------------------
function runPass(caseFn, R, ctx, W, H, angleAt, iters, flush) {
  const st = new Stats(), s = R.s, samples = new Float64Array(iters);
  for (let i = 0; i < iters; i++) {
    const a = angleAt(i);
    s.build(a[0], a[1], a[2], a[3], a[4]);
    st.reset();
    const t0 = performance.now();
    clear(ctx, W, H);
    caseFn(R, ctx, st);
    if (flush) ctx.getImageData(0, 0, 1, 1);
    samples[i] = performance.now() - t0;
  }
  return { ms: median(samples), p95: pct(samples, 0.95), st };
}

function runScenePass(R, angleAt, iters) {
  const s = R.s, samples = new Float64Array(iters);
  for (let i = 0; i < iters; i++) {
    const a = angleAt(i);
    const t0 = performance.now();
    s.build(a[0], a[1], a[2], a[3], a[4]);
    samples[i] = performance.now() - t0;
  }
  return median(samples);
}

// --- THROUGHPUT (GPU-inclusive) -------------------------------------------
// One rAF callback issues `reps` complete draws. The presented frame interval
// is bounded below by max(CPU, GPU) work per frame, so with reps chosen to put
// the frame well above the vsync period the interval divided by reps is a
// genuine end-to-end per-draw cost, not just the recording cost.
function runThroughput(caseFn, R, ctx, W, H, angleAt, targetMs, frames) {
  // Chromium pipelines canvas raster deeply: rAF intervals alternate between
  // one vsync and several, so the MEDIAN interval is meaningless.  What is
  // meaningful is total wall time / frames -- the sustained rate the pipeline
  // can actually retire, which includes GPU work by construction.
  return new Promise(resolve => {
    const s = R.s, st = new Stats();
    let i = 0, t0 = 0, done = false, warm = 8;
    const cpu = [];
    clear(ctx, W, H);
    const wd = setTimeout(() => {
      if (done) return; done = true;
      resolve({ perDrawMs: NaN, reps: 1, cpuPerDrawMs: NaN, frameMs: NaN, throttled: true, st });
    }, 120000);
    function step(ts) {
      if (done) return;
      if (warm > 0) { warm--; if (warm === 0) t0 = ts; }
      const a = angleAt(i++);
      s.build(a[0], a[1], a[2], a[3], a[4]);
      st.reset();
      const c0 = performance.now();
      clear(ctx, W, H);
      caseFn(R, ctx, st);
      if (warm === 0) cpu.push(performance.now() - c0);
      if (warm === 0 && cpu.length >= frames) {
        done = true; clearTimeout(wd);
        const mean = (ts - t0) / cpu.length;
        let sum = 0; for (const v of cpu) sum += v;
        resolve({ perDrawMs: mean, reps: 1, cpuPerDrawMs: sum / cpu.length,
                  frameMs: mean, medFrameMs: median(cpu), st,
                  vsyncBound: mean < 18 });
        return;
      }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
}

// --- 4x supersampled ground truth -----------------------------------------
// "no visual regression" has to be measured against TRUTH, not against the
// per-triangle baseline: the baseline itself is wrong at every shared edge,
// because canvas2d composites each triangle's antialiased coverage separately
// (conflation artifacts).  Merging adjacent same-colour triangles removes
// those seams, so it necessarily differs from the baseline -- in the direction
// of being correct.  A 4x4 box-filtered render is the reference.
let GT = null;
// lineWidthDevicePx > 0 renders the reference with fill+stroke, which removes
// the residual conflation deficit that supersampling alone only attenuates:
// at SS=4 a 1-device-pixel stroke is 0.25 CSS px wide, straddling the shared
// edge by +/-0.125 px, which is very close to the coverage the two triangles
// jointly owe that pixel.  Reporting against BOTH references shows whether a
// ranking depends on the reference.
function groundTruth(baseFn, R, W, H, angle, SS, lineWidthDevicePx) {
  const big = mkCanvas(W * SS, H * SS, { alpha: false, willReadFrequently: true });
  const st = new Stats();
  big.ctx.setTransform(SS, 0, 0, SS, 0, 0);
  if (lineWidthDevicePx) big.ctx.lineWidth = lineWidthDevicePx / SS;
  clear(big.ctx, W, H);
  R.s.build(angle[0], angle[1], angle[2], angle[3], angle[4]);
  baseFn(R, big.ctx, st);
  const src = big.ctx.getImageData(0, 0, W * SS, H * SS).data;
  const dst = new Uint8ClampedArray(W * H * 4);
  const inv = 1 / (SS * SS), rw = W * SS;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        let o = ((y * SS + sy) * rw + x * SS) * 4;
        for (let sx = 0; sx < SS; sx++) { r += src[o]; g += src[o + 1]; b += src[o + 2]; o += 4; }
      }
      const d = (y * W + x) * 4;
      dst[d] = r * inv; dst[d + 1] = g * inv; dst[d + 2] = b * inv; dst[d + 3] = 255;
    }
  }
  big.c.width = big.c.height = 1;      // release ~60MB immediately
  return dst;
}

function compareTo(ref, data, W, H) {
  let n = 0, g8 = 0, g48 = 0, sum = 0, sq = 0, maxd = 0;
  for (let i = 0; i < ref.length; i += 4) {
    const d0 = Math.abs(ref[i] - data[i]), d1 = Math.abs(ref[i + 1] - data[i + 1]), d2 = Math.abs(ref[i + 2] - data[i + 2]);
    const d = d0 > d1 ? (d0 > d2 ? d0 : d2) : (d1 > d2 ? d1 : d2);
    if (d > 0) n++;
    if (d > 8) g8++;
    if (d > 48) g48++;
    sum += d; sq += d * d;
    if (d > maxd) maxd = d;
  }
  const tot = W * H;
  return { anyPct: +(100 * n / tot).toFixed(3), gt8Pct: +(100 * g8 / tot).toFixed(3),
           gt48Pct: +(100 * g48 / tot).toFixed(3), mae: +(sum / tot).toFixed(3),
           rmse: +Math.sqrt(sq / tot).toFixed(3), maxDelta: maxd };
}

// --- acceleration-demotion probe ------------------------------------------
// Firefox scores every canvas frame in DrawTargetWebgl::UsageProfile and
// permanently drops the canvas to software when too many frames "fail".
// A fresh canvas + a per-frame time series makes that step visible.
function demotionProbe(caseFn, R, W, H, angleAt, frames) {
  return new Promise(resolve => {
    const c = mkCanvas(W, H, { alpha: false });
    c.c.style.cssText = 'position:absolute;left:-4000px;top:0;width:320px;height:180px';
    document.body.appendChild(c.c);
    const st = new Stats(), iv = [], cpuMs = [];
    let i = 0, last = -1, done = false;
    const wd = setTimeout(() => { if (!done) { done = true; c.c.remove(); resolve({ iv, cpuMs, throttled: true }); } }, 60000);
    function step(ts) {
      if (done) return;
      if (last >= 0) iv.push(+(ts - last).toFixed(2));
      last = ts;
      const a = angleAt(i);
      R.s.build(a[0], a[1], a[2], a[3], a[4]);
      st.reset();
      const t0 = performance.now();
      clear(c.ctx, W, H);
      caseFn(R, c.ctx, st);
      cpuMs.push(+(performance.now() - t0).toFixed(2));
      if (++i >= frames) { done = true; clearTimeout(wd); c.c.remove(); resolve({ iv, cpuMs }); return; }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
}

// --- pixel validation ------------------------------------------------------
let VA = null, VB = null;
function validate(baseFn, caseFn, R, W, H, angle) {
  if (!VA) { VA = mkCanvas(W, H, { alpha: false, willReadFrequently: true }); VB = mkCanvas(W, H, { alpha: false, willReadFrequently: true }); }
  const s = R.s, st = new Stats();
  s.build(angle[0], angle[1], angle[2], angle[3], angle[4]);
  clear(VA.ctx, W, H); baseFn(R, VA.ctx, st);
  s.build(angle[0], angle[1], angle[2], angle[3], angle[4]);
  st.reset();
  clear(VB.ctx, W, H); caseFn(R, VB.ctx, st);
  const da = VA.ctx.getImageData(0, 0, W, H).data;
  const db = VB.ctx.getImageData(0, 0, W, H).data;
  let diff = 0, g8 = 0, g48 = 0, maxd = 0, sum = 0;
  for (let i = 0; i < da.length; i += 4) {
    const d0 = Math.abs(da[i] - db[i]), d1 = Math.abs(da[i + 1] - db[i + 1]), d2 = Math.abs(da[i + 2] - db[i + 2]);
    const d = d0 > d1 ? (d0 > d2 ? d0 : d2) : (d1 > d2 ? d1 : d2);
    if (d > 0) { diff++; sum += d; }
    if (d > 8) g8++;
    if (d > 48) g48++;
    if (d > maxd) maxd = d;
  }
  const total = W * H;
  return {
    anyPct: +(100 * diff / total).toFixed(4),
    gt8Pct: +(100 * g8 / total).toFixed(4),
    gt48Pct: +(100 * g48 / total).toFixed(4),
    maxDelta: maxd,
    meanOverDiff: diff ? +(sum / diff).toFixed(2) : 0
  };
}

function renderToData(caseFn, R, W, H, angle) {
  if (!VA) { VA = mkCanvas(W, H, { alpha: false, willReadFrequently: true }); VB = mkCanvas(W, H, { alpha: false, willReadFrequently: true }); }
  const st = new Stats();
  R.s.build(angle[0], angle[1], angle[2], angle[3], angle[4]);
  clear(VB.ctx, W, H);
  caseFn(R, VB.ctx, st);
  return VB.ctx.getImageData(0, 0, W, H).data;
}

function post(tag, obj) {
  return fetch('/result?tag=' + encodeURIComponent(tag), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj)
  }).catch(() => { });
}
