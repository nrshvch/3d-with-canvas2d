// ---------------------------------------------------------------------------
// micro.js -- isolate the individual costs of the canvas2d API so the scene
// numbers can be explained rather than just observed.
// Every case draws the SAME total area and the SAME number of vertices; only
// the shape of the API usage changes.
// ---------------------------------------------------------------------------
'use strict';

const MW = 1024, MH = 1024;

// deterministic triangle cloud, precomputed, no allocation during timing
function makeCloud(n, seed, size) {
  const xs = new Float32Array(n * 6);
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    const cx = rnd() * (MW - size), cy = rnd() * (MH - size);
    xs[i * 6 + 0] = cx;             xs[i * 6 + 1] = cy;
    xs[i * 6 + 2] = cx + size;      xs[i * 6 + 3] = cy + size * 0.3;
    xs[i * 6 + 4] = cx + size * 0.4; xs[i * 6 + 5] = cy + size;
  }
  return xs;
}

const CLOUD_N = 8000;
const CLOUD = makeCloud(CLOUD_N, 12345, 26);
const PAL = [];
const PAL_RGB = [];
for (let i = 0; i < 256; i++) {
  const r = (i * 37) & 255, g = (i * 91) & 255, b = (i * 13) & 255;
  PAL.push('#' + (r < 16 ? '0' : '') + r.toString(16) + (g < 16 ? '0' : '') + g.toString(16) + (b < 16 ? '0' : '') + b.toString(16));
  PAL_RGB.push('rgb(' + r + ',' + g + ',' + b + ')');
}

// --- case table ------------------------------------------------------------
// each case: (ctx) => void ; draws exactly CLOUD_N triangles
const MICRO = {
  // ---- 1. how much does a fill() call cost? -------------------------------
  'fill-per-tri              (8000 fills, 8000 subpaths)': function (ctx) {
    const c = CLOUD; ctx.fillStyle = '#88aa55';
    for (let i = 0; i < CLOUD_N; i++) {
      const o = i * 6;
      ctx.beginPath();
      ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
      ctx.fill();
    }
  },
  'fill-per-100              (80 fills, 8000 subpaths)': function (ctx) {
    const c = CLOUD; ctx.fillStyle = '#88aa55';
    for (let g = 0; g < CLOUD_N; g += 100) {
      ctx.beginPath();
      for (let i = g; i < g + 100; i++) {
        const o = i * 6;
        ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
      }
      ctx.fill();
    }
  },
  'fill-per-1000             (8 fills, 8000 subpaths)': function (ctx) {
    const c = CLOUD; ctx.fillStyle = '#88aa55';
    for (let g = 0; g < CLOUD_N; g += 1000) {
      ctx.beginPath();
      for (let i = g; i < g + 1000; i++) {
        const o = i * 6;
        ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
      }
      ctx.fill();
    }
  },
  'fill-single               (1 fill, 8000 subpaths)': function (ctx) {
    const c = CLOUD; ctx.fillStyle = '#88aa55';
    ctx.beginPath();
    for (let i = 0; i < CLOUD_N; i++) {
      const o = i * 6;
      ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
    }
    ctx.fill();
  },
  // ---- 2. does closePath() matter? ---------------------------------------
  'fill-single + closePath': function (ctx) {
    const c = CLOUD; ctx.fillStyle = '#88aa55';
    ctx.beginPath();
    for (let i = 0; i < CLOUD_N; i++) {
      const o = i * 6;
      ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
      ctx.closePath();
    }
    ctx.fill();
  },
  // ---- 3. does the extra explicit closing lineTo matter? ------------------
  'fill-single + closing lineTo': function (ctx) {
    const c = CLOUD; ctx.fillStyle = '#88aa55';
    ctx.beginPath();
    for (let i = 0; i < CLOUD_N; i++) {
      const o = i * 6;
      ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]);
      ctx.lineTo(c[o + 4], c[o + 5]); ctx.lineTo(c[o], c[o + 1]);
    }
    ctx.fill();
  },
  // ---- 4. path building with NO rasterisation (isolates record cost) -----
  'path-build only (no fill)': function (ctx) {
    const c = CLOUD;
    ctx.beginPath();
    for (let i = 0; i < CLOUD_N; i++) {
      const o = i * 6;
      ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
    }
  },
  // ---- 5. fillStyle cost --------------------------------------------------
  'style: constant string   (8000 fills)': function (ctx) {
    const c = CLOUD, s = PAL[7];
    for (let i = 0; i < CLOUD_N; i++) {
      const o = i * 6;
      ctx.fillStyle = s;
      ctx.beginPath();
      ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
      ctx.fill();
    }
  },
  'style: cycle 256 hex     (8000 fills)': function (ctx) {
    const c = CLOUD;
    for (let i = 0; i < CLOUD_N; i++) {
      const o = i * 6;
      ctx.fillStyle = PAL[i & 255];
      ctx.beginPath();
      ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
      ctx.fill();
    }
  },
  'style: cycle 256 rgb()   (8000 fills)': function (ctx) {
    const c = CLOUD;
    for (let i = 0; i < CLOUD_N; i++) {
      const o = i * 6;
      ctx.fillStyle = PAL_RGB[i & 255];
      ctx.beginPath();
      ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
      ctx.fill();
    }
  },
  'style: concat per call   (8000 fills)': function (ctx) {
    const c = CLOUD;
    for (let i = 0; i < CLOUD_N; i++) {
      const o = i * 6;
      const v = i & 255;
      ctx.fillStyle = 'rgb(' + v + ',' + ((v * 3) & 255) + ',' + ((v * 7) & 255) + ')';
      ctx.beginPath();
      ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
      ctx.fill();
    }
  },
  // ---- 6. Path2D --------------------------------------------------------
  'Path2D built per fill    (8000 fills)': function (ctx) {
    const c = CLOUD; ctx.fillStyle = '#88aa55';
    for (let i = 0; i < CLOUD_N; i++) {
      const o = i * 6;
      const p = new Path2D();
      p.moveTo(c[o], c[o + 1]); p.lineTo(c[o + 2], c[o + 3]); p.lineTo(c[o + 4], c[o + 5]);
      ctx.fill(p);
    }
  },
  'Path2D one, 8000 subpath (1 fill)': function (ctx) {
    const c = CLOUD; ctx.fillStyle = '#88aa55';
    const p = new Path2D();
    for (let i = 0; i < CLOUD_N; i++) {
      const o = i * 6;
      p.moveTo(c[o], c[o + 1]); p.lineTo(c[o + 2], c[o + 3]); p.lineTo(c[o + 4], c[o + 5]);
    }
    ctx.fill(p);
  },
  // ---- 7. integer snapping -----------------------------------------------
  'snapped to integers      (8000 fills)': function (ctx) {
    const c = CLOUD; ctx.fillStyle = '#88aa55';
    for (let i = 0; i < CLOUD_N; i++) {
      const o = i * 6;
      ctx.beginPath();
      ctx.moveTo(c[o] | 0, c[o + 1] | 0); ctx.lineTo(c[o + 2] | 0, c[o + 3] | 0); ctx.lineTo(c[o + 4] | 0, c[o + 5] | 0);
      ctx.fill();
    }
  },
  // ---- 8. fillRect: the canvas2d hyper-fast path, for scale --------------
  'fillRect x8000 (reference)': function (ctx) {
    const c = CLOUD; ctx.fillStyle = '#88aa55';
    for (let i = 0; i < CLOUD_N; i++) { const o = i * 6; ctx.fillRect(c[o], c[o + 1], 20, 20); }
  }
};

// --- tangled vs simple -----------------------------------------------------
function polyRing(n, cx, cy, r, step) {
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const t = (i * step % n) / n * Math.PI * 2;
    a[i * 2] = cx + Math.cos(t) * r; a[i * 2 + 1] = cy + Math.sin(t) * r;
  }
  return a;
}
function wobbleRing(n, cx, cy, r) {
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / n * Math.PI * 2, rr = r * (i & 1 ? 0.55 : 1.0);
    a[i * 2] = cx + Math.cos(t) * rr; a[i * 2 + 1] = cy + Math.sin(t) * rr;
  }
  return a;
}
const TANGLE_N = 128, TANGLE_COPIES = 300;
const SHAPES = {
  'convex ring   (128 v, no self-int)':   polyRing(TANGLE_N, 0, 0, 60, 1),
  'star zigzag   (128 v, no self-int)':   wobbleRing(TANGLE_N, 0, 0, 60),
  'tangled star  (128 v, self-int x127)': polyRing(TANGLE_N, 0, 0, 60, 61)
};
for (const k in SHAPES) {
  const pts = SHAPES[k];
  MICRO['tangle: ' + k] = (function (pts) {
    return function (ctx) {
      ctx.fillStyle = '#88aa55';
      let s = 99991;
      for (let g = 0; g < TANGLE_COPIES; g++) {
        s = (s * 1664525 + 1013904223) >>> 0;
        const ox = (s >>> 8) % (MW - 140) + 70;
        s = (s * 1664525 + 1013904223) >>> 0;
        const oy = (s >>> 8) % (MH - 140) + 70;
        ctx.beginPath();
        ctx.moveTo(ox + pts[0], oy + pts[1]);
        for (let i = 1; i < TANGLE_N; i++) ctx.lineTo(ox + pts[i * 2], oy + pts[i * 2 + 1]);
        ctx.fill();
      }
    };
  })(pts);
}

// --- subpath-count scaling for ONE fill ------------------------------------
[10, 100, 1000, 4000, 8000, 16000].forEach(function (k) {
  MICRO['scale: 1 fill / ' + k + ' subpaths (x' + Math.round(16000 / k) + ')'] = function (ctx) {
    const c = CLOUD, reps = Math.round(16000 / k);
    ctx.fillStyle = '#88aa55';
    for (let rp = 0; rp < reps; rp++) {
      ctx.beginPath();
      for (let i = 0; i < k; i++) {
        const o = (i % CLOUD_N) * 6;
        ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
      }
      ctx.fill();
    }
  };
});

// --- closePath() scaling: is it O(1) or O(n) per call? ---------------------
// (a huge multi-subpath path + closePath per subpath looked quadratic in the
//  first Chromium run; this isolates it)
[250, 1000, 4000, 8000].forEach(function (k) {
  const reps = Math.max(1, Math.round(8000 / k));
  MICRO['closePath: ' + k + ' subpaths/fill x' + reps + '  NO close'] = function (ctx) {
    const c = CLOUD;
    ctx.fillStyle = '#88aa55';
    for (let rp = 0; rp < reps; rp++) {
      ctx.beginPath();
      for (let i = 0; i < k; i++) {
        const o = ((i + rp * k) % CLOUD_N) * 6;
        ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
      }
      ctx.fill();
    }
  };
  MICRO['closePath: ' + k + ' subpaths/fill x' + reps + '  +close'] = function (ctx) {
    const c = CLOUD;
    ctx.fillStyle = '#88aa55';
    for (let rp = 0; rp < reps; rp++) {
      ctx.beginPath();
      for (let i = 0; i < k; i++) {
        const o = ((i + rp * k) % CLOUD_N) * 6;
        ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
        ctx.closePath();
      }
      ctx.fill();
    }
  };
});

// --- batch-size sweep: 12000 triangles, N per fill --------------------------
// Firefox only GPU-tessellates paths with <= gfx.canvas.accelerated
// .gpu-path-complexity (4000) verbs; a triangle subpath is 4 verbs, so the
// cliff should sit at ~1000 triangles per fill.
[50, 125, 250, 500, 900, 1000, 1100, 1500, 3000, 6000].forEach(function (k) {
  MICRO['batch: 12000 tris, ' + k + '/fill'] = function (ctx) {
    const c = CLOUD, total = 12000;
    ctx.fillStyle = '#88aa55';
    for (let g = 0; g < total; g += k) {
      ctx.beginPath();
      const end = Math.min(g + k, total);
      for (let i = g; i < end; i++) {
        const o = (i % CLOUD_N) * 6;
        ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]);
      }
      ctx.fill();
    }
  };
});

// --- locality: same subpath count, clustered vs scattered -------------------
// A merged path whose subpaths are scattered over the whole canvas forces the
// scanline rasteriser to keep every edge in the active list; a merged path
// whose subpaths are local does not.
const CLUSTER = (function () {
  const n = 8000, xs = new Float32Array(n * 6);
  let s = 4242 >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    const cl = (i / 100) | 0;                       // 80 clusters of 100
    const bx = (cl % 10) * 100 + 10, by = ((cl / 10) | 0) * 100 + 10;
    const cx = bx + rnd() * 70, cy = by + rnd() * 70;
    xs[i * 6] = cx; xs[i * 6 + 1] = cy;
    xs[i * 6 + 2] = cx + 26; xs[i * 6 + 3] = cy + 8;
    xs[i * 6 + 4] = cx + 10; xs[i * 6 + 5] = cy + 26;
  }
  return xs;
})();
MICRO['locality: 80 fills x100 scattered'] = function (ctx) {
  const c = CLOUD; ctx.fillStyle = '#88aa55';
  for (let g = 0; g < 8000; g += 100) {
    ctx.beginPath();
    for (let i = g; i < g + 100; i++) { const o = i * 6; ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]); }
    ctx.fill();
  }
};
MICRO['locality: 80 fills x100 clustered'] = function (ctx) {
  const c = CLUSTER; ctx.fillStyle = '#88aa55';
  for (let g = 0; g < 8000; g += 100) {
    ctx.beginPath();
    for (let i = g; i < g + 100; i++) { const o = i * 6; ctx.moveTo(c[o], c[o + 1]); ctx.lineTo(c[o + 2], c[o + 3]); ctx.lineTo(c[o + 4], c[o + 5]); }
    ctx.fill();
  }
};
