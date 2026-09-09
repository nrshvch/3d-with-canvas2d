// ---------------------------------------------------------------------------
// state.js -- what does touching the canvas2d STATE MACHINE cost?
//
// Every case draws exactly the same 8000 triangles with the same colour.  The
// only difference is which state calls surround them.  Subtract the reference
// row to get the cost of the state call itself.
//
// Loaded by micropage.html only, so the scene benchmark in index.html is
// unaffected.
// ---------------------------------------------------------------------------
'use strict';

(function () {
  const N = CLOUD_N, c = CLOUD;

  function tri(ctx, i) {
    const o = (i % N) * 6;
    ctx.beginPath();
    ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
    ctx.fill();
  }

  // ---- reference: fillStyle set ONCE, nothing else touched ----------------
  MICRO['state: reference, style set once'] = function (ctx) {
    ctx.fillStyle = '#88aa55';
    for (let i = 0; i < N; i++) tri(ctx, i);
  };
  MICRO['state: fillStyle = same string /fill'] = function (ctx) {
    const s = '#88aa55';
    for (let i = 0; i < N; i++) { ctx.fillStyle = s; tri(ctx, i); }
  };
  MICRO['state: fillStyle = equal but new str'] = function (ctx) {
    for (let i = 0; i < N; i++) { ctx.fillStyle = '#88aa' + '55'; tri(ctx, i); }
  };
  MICRO['state: save/restore per fill'] = function (ctx) {
    ctx.fillStyle = '#88aa55';
    for (let i = 0; i < N; i++) { ctx.save(); tri(ctx, i); ctx.restore(); }
  };
  MICRO['state: setTransform(identity) /fill'] = function (ctx) {
    ctx.fillStyle = '#88aa55';
    for (let i = 0; i < N; i++) { ctx.setTransform(1, 0, 0, 1, 0, 0); tri(ctx, i); }
  };
  MICRO['state: translate +/- per fill'] = function (ctx) {
    ctx.fillStyle = '#88aa55';
    for (let i = 0; i < N; i++) { ctx.translate(1, 1); tri(ctx, i); ctx.translate(-1, -1); }
  };
  MICRO['state: globalAlpha = 1 per fill'] = function (ctx) {
    ctx.fillStyle = '#88aa55';
    for (let i = 0; i < N; i++) { ctx.globalAlpha = 1; tri(ctx, i); }
  };
  MICRO['state: globalAlpha alternating'] = function (ctx) {
    ctx.fillStyle = '#88aa55';
    for (let i = 0; i < N; i++) { ctx.globalAlpha = (i & 1) ? 1 : 0.999; tri(ctx, i); }
    ctx.globalAlpha = 1;
  };
  MICRO['state: gCO = source-over per fill'] = function (ctx) {
    ctx.fillStyle = '#88aa55';
    for (let i = 0; i < N; i++) { ctx.globalCompositeOperation = 'source-over'; tri(ctx, i); }
  };
  MICRO['state: shadowBlur = 0 set per fill'] = function (ctx) {
    ctx.fillStyle = '#88aa55';
    for (let i = 0; i < N; i++) { ctx.shadowBlur = 0; tri(ctx, i); }
  };
  MICRO['state: fill("nonzero") explicit arg'] = function (ctx) {
    ctx.fillStyle = '#88aa55';
    for (let i = 0; i < N; i++) {
      const o = i * 6;
      ctx.beginPath();
      ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
      ctx.fill('nonzero');
    }
  };
  MICRO['state: fill("evenodd")'] = function (ctx) {
    ctx.fillStyle = '#88aa55';
    for (let i = 0; i < N; i++) {
      const o = i * 6;
      ctx.beginPath();
      ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
      ctx.fill('evenodd');
    }
  };
  MICRO['state: rect clip every 100 fills'] = function (ctx) {
    ctx.fillStyle = '#88aa55';
    for (let g = 0; g < N; g += 100) {
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, MW, MH); ctx.clip();
      for (let i = g; i < g + 100; i++) tri(ctx, i);
      ctx.restore();
    }
  };
  MICRO['state: stroke() instead of fill()'] = function (ctx) {
    ctx.strokeStyle = '#88aa55'; ctx.lineWidth = 1;
    for (let i = 0; i < N; i++) {
      const o = i * 6;
      ctx.beginPath();
      ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
      ctx.closePath(); ctx.stroke();
    }
  };
  MICRO['state: fill() + stroke() (seam hack)'] = function (ctx) {
    ctx.fillStyle = '#88aa55'; ctx.strokeStyle = '#88aa55'; ctx.lineWidth = 1;
    for (let i = 0; i < N; i++) {
      const o = i * 6;
      ctx.beginPath();
      ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
      ctx.fill(); ctx.stroke();
    }
  };

  // ---- shadows are in a different league: 500 fills, not 8000 -------------
  MICRO['state: shadowBlur = 4 ACTIVE (x500)'] = function (ctx) {
    ctx.fillStyle = '#88aa55';
    ctx.shadowBlur = 4; ctx.shadowColor = 'rgba(0,0,0,0.5)';
    for (let i = 0; i < 500; i++) tri(ctx, i);
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
  };
  MICRO['state: no shadow      (x500 ref)'] = function (ctx) {
    ctx.fillStyle = '#88aa55';
    for (let i = 0; i < 500; i++) tri(ctx, i);
  };

  // ---- clearing the frame --------------------------------------------------
  MICRO['clear: fillRect whole canvas x200'] = function (ctx) {
    ctx.fillStyle = '#101014';
    for (let i = 0; i < 200; i++) ctx.fillRect(0, 0, MW, MH);
  };
  MICRO['clear: clearRect whole canvas x200'] = function (ctx) {
    for (let i = 0; i < 200; i++) ctx.clearRect(0, 0, MW, MH);
  };
  MICRO['clear: canvas.width = w  x200'] = function (ctx) {
    for (let i = 0; i < 200; i++) ctx.canvas.width = MW;
  };

  // ---- transform: baked into coords vs left to the context ----------------
  const BAKED = (function () {
    const a = new Float32Array(N * 6);
    for (let i = 0; i < N * 6; i += 2) { a[i] = c[i] * 0.75 + 40; a[i + 1] = c[i + 1] * 0.75 + 40; }
    return a;
  })();
  MICRO['xform: baked into coordinates'] = function (ctx) {
    ctx.fillStyle = '#88aa55';
    for (let i = 0; i < N; i++) {
      const o = i * 6;
      ctx.beginPath();
      ctx.moveTo(BAKED[o], BAKED[o + 1]); ctx.lineTo(BAKED[o + 2], BAKED[o + 3]); ctx.lineTo(BAKED[o + 4], BAKED[o + 5]);
      ctx.fill();
    }
  };
  MICRO['xform: ctx.setTransform once'] = function (ctx) {
    ctx.fillStyle = '#88aa55';
    ctx.setTransform(0.75, 0, 0, 0.75, 40, 40);
    for (let i = 0; i < N; i++) tri(ctx, i);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };
})();
