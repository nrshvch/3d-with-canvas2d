// node bench/optgeom.mjs
// ---------------------------------------------------------------------------
// Where do options 6, 7, 8 and 8b actually put their vertices, and which of
// those vertices are REDUNDANT?
//
// Two questions, both geometric, both answerable without a canvas:
//
//  1. Option 6 (move the verts) and option 8b (add verts, neighbour direction
//     at a run's free ends, mitre in between) look as though they must agree
//     at a free end: both put a point on the intersection of the offset seam
//     line with a line the boundary already follows.  If the regions are the
//     same, the pixel measurements must be too -- and they are not (S14
//     outline 11.36 against 0.42), so one of the two is not doing what its
//     name says.  This dumps both and diffs them.
//
//  2. Firefox caps path vertices per frame (1.11, ~10 000), so 2 added
//     vertices per shared edge is a real budget item.  An added vertex is
//     redundant exactly when it is COLLINEAR with its neighbours in the
//     emitted loop -- 4.3 already has the exact test and the batcher already
//     runs it.  This counts how many of each option's vertices survive it.
// ---------------------------------------------------------------------------
import { readFileSync } from 'fs';
import { createContext, runInContext } from 'vm';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- a canvas stub good enough for band.js's texture construction ----------
function fakeCtx() {
  const rec = { pts: [], ops: [] };
  const noop = () => {};
  return {
    rec,
    fillRect: noop, strokeRect: noop, beginPath() { rec.ops.push('begin'); },
    moveTo(x, y) { rec.pts.push([x, y, 'M']); }, lineTo(x, y) { rec.pts.push([x, y, 'L']); },
    closePath() { rec.ops.push('close'); }, fill() { rec.ops.push('fill'); },
    stroke() { rec.ops.push('stroke'); }, setTransform: noop, save: noop, restore: noop,
    drawImage: noop, createPattern: () => ({ setTransform: noop }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: noop, clearRect: noop,
    set fillStyle(v) {}, get fillStyle() { return '#000'; },
    set strokeStyle(v) {}, get strokeStyle() { return '#000'; },
    set lineWidth(v) {}, get lineWidth() { return 1; },
    set lineCap(v) {}, set lineJoin(v) {}, set miterLimit(v) {}, set font(v) {},
    fillText: noop
  };
}
const sb = {
  console, Math, Number, Object, Array, Float64Array, Float32Array, Int32Array,
  Int8Array, Uint8Array, Uint32Array, Map, Set, String, JSON, isFinite,
  document: { createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx() }) }
};
createContext(sb);
runInContext(readFileSync(join(__dirname, 'band.js'), 'utf8'), sb, { filename: 'band.js' });

// --- read back the geometry -------------------------------------------------
// NOTE: top-level `const` in a vm script lives in the script's lexical scope,
// not on the sandbox object, so everything is read through evaluated
// expressions rather than off `sb`.
const ev = (expr) => runInContext(expr, sb);
ev('bandBuild(1); bandAffine();');
const n = ev('PLOOP.length');
ev('loopScreen(PLOOP, PS); loopScreen(QLOOP, QS); loopUV(PLOOP, PU_);');
const PS = ev('Array.from(PS)'), PSHARED = ev('Array.from(PSHARED)');
const orig = [];
for (let i = 0; i < n; i++) orig.push([PS[i * 2], PS[i * 2 + 1]]);

const W = 1.0;   // 1 px band / outset, matching the measured rows

// option 6: move the vertices
ev(`outsetLoop(PS, ${n}, PSHARED, ${W}, 4, POUT);`);
const POUT = ev('Array.from(POUT)');
const opt6 = [];
for (let i = 0; i < n; i++) opt6.push([POUT[i * 2], POUT[i * 2 + 1]]);

// options 7, 8, 8b: capture the emitted path and map UV back to screen
function capture(call) {
  const ctx = fakeCtx();
  sb.__ctx = ctx;
  ev(call);
  const B = ev('Array.from(BCA)');
  const a = B[0], b = B[1], c = B[2], d = B[3], e = B[4], f = B[5];
  // the first subpath is P; stop at the second moveTo
  const out = [];
  for (let i = 0; i < ctx.rec.pts.length; i++) {
    const p = ctx.rec.pts[i];
    if (p[2] === 'M' && out.length) break;
    out.push([a * p[0] + c * p[1] + e, b * p[0] + d * p[1] + f]);
  }
  return out;
}
const opt7 = capture(`bandUnionBand(__ctx, null, ${W}, 'inline');`);
const opt8 = capture(`bandOptNeighbour(__ctx, null, ${W}, 4);`);
const opt8b = capture(`bandOptNeighbourMitred(__ctx, null, ${W}, 4);`);

const fmt = (p) => '(' + p[0].toFixed(2) + ',' + p[1].toFixed(2) + ')';
const pad = (s, k) => String(s).padEnd(k);

console.log('S14, P has ' + n + ' vertices, shared edges ' + PSHARED.reduce((a, b) => a + b, 0) +
            ', band width ' + W + ' px\n');
console.log('emitted vertex counts:');
console.log('  original loop            ' + n);
console.log('  option 6  move verts     ' + opt6.length);
console.log('  option 7  add 2/edge     ' + opt7.length);
console.log('  option 8  add 2/edge     ' + opt8.length);
console.log('  option 8b add, mitred    ' + opt8b.length);

// --- does option 6 agree with 8b at the run's free ends? -------------------
console.log('\nfree ends of the run (vertex 1 and vertex ' + (n - 2) + '):');
for (const v of [1, n - 2]) {
  console.log('  original      ' + fmt(orig[v]));
  console.log('  option 6 put  ' + fmt(opt6[v]) + '   moved ' +
              Math.hypot(opt6[v][0] - orig[v][0], opt6[v][1] - orig[v][1]).toFixed(3) + ' px');
}
console.log('\noption 8b emitted loop (screen):');
console.log('  ' + opt8b.map(fmt).join(' '));
console.log('\noption 6 emitted loop (screen):');
console.log('  ' + opt6.map(fmt).join(' '));

// --- 4.3's exact collinearity test, applied to each emitted loop -----------
// drop p if  cross^2 <= eps^2 * |d1+d2|^2  and  d1.d2 > 0
function droppable(loop, eps) {
  const m = loop.length;
  let drop = 0;
  const which = [];
  for (let i = 0; i < m; i++) {
    const a = loop[(i + m - 1) % m], p = loop[i], c = loop[(i + 1) % m];
    const d1x = p[0] - a[0], d1y = p[1] - a[1];
    const d2x = c[0] - p[0], d2y = c[1] - p[1];
    const cross = d1x * d2y - d1y * d2x;
    const sx = d1x + d2x, sy = d1y + d2y;
    if (cross * cross <= eps * eps * (sx * sx + sy * sy) && (d1x * d2x + d1y * d2y) > 0) {
      drop++; which.push(i);
    }
  }
  return { drop, which };
}
console.log('\ncollinear vertices droppable at eps = 0.05 px (4.3’s shipped value):');
for (const [nm, loop] of [['original', orig], ['option 6', opt6], ['option 7', opt7],
                          ['option 8', opt8], ['option 8b', opt8b]]) {
  const r = droppable(loop, 0.05);
  console.log('  ' + pad(nm, 11) + pad(loop.length + ' verts', 10) +
              '-> drop ' + pad(r.drop, 4) + ' -> ' + (loop.length - r.drop) + ' kept' +
              (r.which.length ? '   at ' + r.which.join(',') : ''));
}
console.log('\nsame, at eps = 0.5 px (looser, for reference):');
for (const [nm, loop] of [['option 7', opt7], ['option 8', opt8], ['option 8b', opt8b]]) {
  const r = droppable(loop, 0.5);
  console.log('  ' + pad(nm, 11) + pad(loop.length + ' verts', 10) +
              '-> drop ' + pad(r.drop, 4) + ' -> ' + (loop.length - r.drop) + ' kept');
}

// --- are the regions actually the same? ------------------------------------
// If option 6's loop and option 8b's loop enclose the same region, then their
// rendered images must agree, and any measured difference between them is a
// measurement artefact rather than a property of the option.
function area(loop) {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
function inside(loop, x, y) {
  let w = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length];
    if (p[1] <= y) { if (q[1] > y && (q[0] - p[0]) * (y - p[1]) - (x - p[0]) * (q[1] - p[1]) > 0) w++; }
    else if (q[1] <= y && (q[0] - p[0]) * (y - p[1]) - (x - p[0]) * (q[1] - p[1]) < 0) w--;
  }
  return w !== 0;
}
function symDiff(A, B) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const L of [A, B]) for (const p of L) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  const S = 4;                       // 1/S px sampling
  let diff = 0, tot = 0;
  for (let y = Math.floor(y0) - 2; y <= Math.ceil(y1) + 2; y += 1 / S) {
    for (let x = Math.floor(x0) - 2; x <= Math.ceil(x1) + 2; x += 1 / S) {
      const a = inside(A, x, y), b = inside(B, x, y);
      if (a || b) tot++;
      if (a !== b) diff++;
    }
  }
  return { diffPx: diff / (S * S), unionPx: tot / (S * S) };
}
console.log('\nsigned area of each emitted loop (screen px2):');
for (const [nm, loop] of [['original', orig], ['option 6', opt6], ['option 7', opt7],
                          ['option 8', opt8], ['option 8b', opt8b]])
  console.log('  ' + pad(nm, 11) + area(loop).toFixed(3));
const sd = symDiff(opt6, opt8b);
console.log('\noption 6 against option 8b: symmetric difference ' + sd.diffPx.toFixed(3) +
            ' px2 of ' + sd.unionPx.toFixed(0) + ' px2 union');
const sd2 = symDiff(opt7, opt8b);
console.log('option 7 against option 8b: symmetric difference ' + sd2.diffPx.toFixed(3) + ' px2');

// ---------------------------------------------------------------------------
// The same two questions on S8, where a seam run's free end sits on a cube
// silhouette corner rather than on a straight edge.  If the two polygons'
// adjacent edges there are NOT collinear, option 8b's added vertex is not
// redundant and the collinear test must keep it.
// ---------------------------------------------------------------------------
const cs = { console, Math, Number, Object, Array, Float64Array, Float32Array,
             Int32Array, Int8Array, Uint8Array, Uint32Array, Map, Set, String, JSON,
             document: { createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx() }) } };
createContext(cs);
runInContext(readFileSync(join(__dirname, 'cube.js'), 'utf8'), cs, { filename: 'cube.js' });
const cev = (e) => runInContext(e, cs);
cev('cubeBuild(0.55, 0.72, 3.4, 620);');

function captureCube(call) {
  const ctx = fakeCtx();
  cs.__ctx = ctx;
  cev(call);
  // one subpath per visible face; keep them separate
  const CAs = [];
  const faces = [];
  let cur = null;
  for (const p of ctx.rec.pts) {
    if (p[2] === 'M') { cur = []; faces.push(cur); }
    cur.push([p[0], p[1]]);
  }
  return faces;
}
// per-face affines differ, so compare in UV space per face -- vertex counts and
// collinearity are affine-invariant, which is all we need here
const c6 = captureCube('drawPerFace(__ctx, null, 1.0);');
const c7 = captureCube('drawPerFaceUnionBand(__ctx, null, 1.0, "inline");');
const c8b = captureCube('optNeighbourBandMitred(__ctx, null, 1.0, 4);');
const c0 = captureCube('drawPerFace(__ctx, null, 0);');

console.log('\n=== S8 textured cube ===');
console.log('per-face emitted vertex counts (3 visible faces, back to front):');
const cnt = (fs) => fs.map(f => f.length).join(' + ') + '  = ' + fs.reduce((a, f) => a + f.length, 0);
console.log('  no repair   ' + cnt(c0));
console.log('  option 6    ' + cnt(c6));
console.log('  option 7    ' + cnt(c7));
console.log('  option 8b   ' + cnt(c8b));
console.log('\ncollinear vertices droppable at eps = 0.05 px, per face:');
for (const [nm, fs] of [['option 6', c6], ['option 7', c7], ['option 8b', c8b]]) {
  const parts = fs.map(f => { const r = droppable(f, 0.05); return r.drop + '/' + f.length; });
  const tot = fs.reduce((a, f) => a + droppable(f, 0.05).drop, 0);
  console.log('  ' + pad(nm, 11) + parts.join('  ') + '   total dropped ' + tot);
}
