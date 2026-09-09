// node bench/optfigs.mjs
// ---------------------------------------------------------------------------
// Figures 2 and 3 for 4.8, read out of the shipped code paths rather than
// drawn: the loops come from the same functions the benchmark renders.
//
//   assets/seam-run-s14.svg     option 7 against option 8b along a run of
//                               shared edges -- the step-out-and-back with a
//                               notch at every shared vertex, against one
//                               mitred chain
//   assets/seam-corner-s8.svg   the same pair at a run end that lands on a
//                               silhouette corner, where the two go in
//                               different directions and nothing is collinear
//
// The capture records the CTM at each moveTo/lineTo, because these options set
// a per-face transform and emit their path in texture space -- mapping every
// point through one matrix (an earlier version of this script) silently put
// different faces in different coordinate systems.
//
// Band width is exaggerated in the figures, and labelled, so a 1 px structure
// is legible in print.  Everything else is to scale.
// ---------------------------------------------------------------------------
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { createContext, runInContext } from 'vm';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, '..', 'assets');
mkdirSync(ASSETS, { recursive: true });

const C = { bg: '#f7f7fa', ink: '#1c1c22', dim: '#9a9aa6', far: '#4f81bd', near: '#c0504d',
            band: '#e08a10', good: '#2e8b3d', grid: '#e2e2ea' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// --- a canvas stub that remembers the transform per point ------------------
function fakeCtx() {
  const rec = { subpaths: [] };
  let M = [1, 0, 0, 1, 0, 0], cur = null;
  const noop = () => {};
  const put = (x, y, kind) => {
    const p = [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
    if (kind === 'M') { cur = [p]; rec.subpaths.push(cur); } else cur.push(p);
  };
  return {
    rec,
    setTransform(a, b, c, d, e, f) { M = [a, b, c, d, e, f]; },
    moveTo(x, y) { put(x, y, 'M'); }, lineTo(x, y) { put(x, y, 'L'); },
    beginPath: noop, closePath: noop, fill: noop, stroke: noop,
    fillRect: noop, strokeRect: noop, save: noop, restore: noop, drawImage: noop,
    createPattern: () => ({ setTransform: noop }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }), putImageData: noop, clearRect: noop,
    set fillStyle(v) {}, get fillStyle() { return '#000'; },
    set strokeStyle(v) {}, get strokeStyle() { return '#000'; },
    set lineWidth(v) {}, get lineWidth() { return 1; },
    set lineCap(v) {}, set lineJoin(v) {}, set miterLimit(v) {}, set font(v) {}, fillText: noop
  };
}
function load(file) {
  const sb = { console, Math, Number, Object, Array, Float64Array, Float32Array, Int32Array,
               Int8Array, Uint8Array, Uint32Array, Map, Set, String, JSON, isFinite,
               document: { createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx() }) } };
  createContext(sb);
  runInContext(readFileSync(join(__dirname, file), 'utf8'), sb, { filename: file });
  return sb;
}
function capture(sb, call) {
  const ctx = fakeCtx();
  sb.__ctx = ctx;
  runInContext(call, sb);
  return ctx.rec.subpaths;
}

// --- SVG framing, fitted to the content ------------------------------------
function fig(title, note, layers, w, h, gridStep, win) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  if (win) {
    x0 = win[0] - win[2] / 2; x1 = win[0] + win[2] / 2;
    const sp = win[2] * h / w; y0 = win[1] - sp / 2; y1 = win[1] + sp / 2;
  } else {
  for (const L of layers) for (const p of L.pts) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  const mx = (x1 - x0) * 0.10 + 1, my = (y1 - y0) * 0.10 + 1;
  x0 -= mx; x1 += mx; y0 -= my; y1 += my; }
  const k = Math.min(w / (x1 - x0), h / (y1 - y0));
  const cxc = (x0 + x1) / 2, cyc = (y0 + y1) / 2;
  const tx = (p) => [(p[0] - cxc) * k + w / 2, (p[1] - cyc) * k + h / 2];
  const step = gridStep || (k >= 8 ? 1 : k >= 3 ? 5 : 10);
  let g = `<rect width="${w}" height="${h + 46}" fill="${C.bg}"/>
  <rect x="0" y="0" width="${w}" height="${h}" fill="#fff" stroke="${C.grid}"/>
  <clipPath id="cl"><rect x="1" y="1" width="${w - 2}" height="${h - 2}"/></clipPath><g clip-path="url(#cl)">`;
  for (let x = Math.ceil((cxc - w / k / 2) / step) * step; x <= cxc + w / k / 2; x += step) {
    const p = tx([x, cyc]);
    g += `<line x1="${p[0].toFixed(1)}" y1="0" x2="${p[0].toFixed(1)}" y2="${h}" stroke="${C.grid}" stroke-width="0.6"/>`;
  }
  for (let y = Math.ceil((cyc - h / k / 2) / step) * step; y <= cyc + h / k / 2; y += step) {
    const p = tx([cxc, y]);
    g += `<line x1="0" y1="${p[1].toFixed(1)}" x2="${w}" y2="${p[1].toFixed(1)}" stroke="${C.grid}" stroke-width="0.6"/>`;
  }
  for (const L of layers) {
    const pts = L.pts.map(tx);
    if (pts.length > 1)
      g += `<path d="M ${pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L ')}${L.close ? ' Z' : ''}" fill="${L.fill || 'none'}" ${L.fill ? 'fill-opacity="0.14"' : ''} stroke="${L.col}" stroke-width="${L.w || 1.8}"${L.dash ? ' stroke-dasharray="' + L.dash + '"' : ''} stroke-linejoin="miter"/>`;
    for (const p of pts) g += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${L.r || 3.2}" fill="${L.col}"/>`;
  }
  g += '</g>';
  let ly = 17;
  for (const L of layers) {
    g += `<text x="${w - 9}" y="${ly}" text-anchor="end" font-family="monospace" font-size="11" fill="${L.col}">${esc(L.name)}</text>`;
    ly += 15;
  }
  g += `<text x="${w - 9}" y="${h - 7}" text-anchor="end" font-family="monospace" font-size="9" fill="${C.dim}">grid ${step} px · ${k.toFixed(1)}x</text>`;
  g += `<text x="4" y="${h + 17}" font-family="monospace" font-size="12" font-weight="bold" fill="${C.ink}">${esc(title)}</text>`;
  g += `<text x="4" y="${h + 33}" font-family="monospace" font-size="10" fill="${C.dim}">${esc(note)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h + 46}" viewBox="0 0 ${w} ${h + 46}">${g}</svg>`;
}

// ===========================================================================
// S14: along a run of shared edges
// ===========================================================================
{
  const sb = load('band.js');
  const WB = 4;            // exaggerated for legibility; measured rows use 1 px
  runInContext('bandBuild(1); bandAffine(); loopScreen(PLOOP, PS); loopUV(PLOOP, PU_);', sb);
  const n = runInContext('PLOOP.length', sb);
  const PSs = runInContext('Array.from(PS)', sb);
  const orig = []; for (let i = 0; i < n; i++) orig.push([PSs[i * 2], PSs[i * 2 + 1]]);
  const o7 = capture(sb, `bandUnionBand(__ctx, null, ${WB}, 'inline');`)[0];
  const o8b = capture(sb, `bandOptNeighbourMitred(__ctx, null, ${WB}, 4);`)[0];
  // three teeth in the middle of the run, so both structures are visible
  const win = (loop, lo, hi) => loop.filter(p => p[1] > lo && p[1] < hi);
  const lo = orig[3][1], hi = orig[7][1];
  writeFileSync(join(ASSETS, 'seam-run-s14.svg'), fig(
    'S14  option 7 against option 8b, along a run of shared edges',
    'band width drawn at ' + WB + ' px for legibility. 7 steps out and NOTCHES BACK to every shared vertex (2 verts/edge, 42 total); 8b mitres the run into one chain (+2 total, 18).',
    [{ name: 'original boundary', pts: win(orig, lo - 8, hi + 8), col: C.dim, dash: '4 3', w: 1.6, r: 3 },
     { name: 'option 7   add 2 per edge', pts: win(o7, lo, hi), col: C.band, w: 2, r: 3.4 },
     { name: 'option 8b  add + mitre', pts: win(o8b, lo, hi), col: C.good, w: 1.6, r: 2.8 }],
    620, 380, 10));
  console.log('wrote assets/seam-run-s14.svg');
}

// ===========================================================================
// S8: a run end on a silhouette corner
// ===========================================================================
{
  const sb = load('cube.js');
  const WB = 6;
  runInContext('cubeBuild(0.55, 0.72, 3.4, 620);', sb);
  const SX = runInContext('Array.from(SX)', sb), SY = runInContext('Array.from(SY)', sb);
  const FORD = runInContext('Array.from(FORD)', sb);
  const faces = JSON.parse(runInContext('JSON.stringify(CUBE_F)', sb));
  const f0 = FORD[0];                                  // farthest face: 2 seam edges
  const quad = faces[f0].map(i => [SX[i], SY[i]]);
  // subpath order matches FORD, so face f0 is subpath 0 in every option
  const o6 = capture(sb, `drawPerFace(__ctx, null, ${WB});`)[0];
  const o8b = capture(sb, `optNeighbourBandMitred(__ctx, null, ${WB}, 4);`)[0];
  // the free end: a vertex of f0 with a seam edge on exactly one side
  runInContext(`faceAffine(${f0}); faceSeamRuns(${f0});`, sb);
  const sel = runInContext('Array.from(SEAMSEL)', sb);
  let endV = 0;
  for (let v = 0; v < 4; v++) if ((sel[(v + 3) % 4] === 1) !== (sel[v] === 1)) { endV = v; break; }
  const focus = quad[endV];
  writeFileSync(join(ASSETS, 'seam-corner-s8.svg'), fig(
    'S8  the same pair where a run end lands on a silhouette corner',
    'band width drawn at ' + WB + ' px. 6 slides the vertex along the face’s own edge; 8b follows the NEIGHBOUR’s edge. Nothing is collinear here, so 0 of 16 verts drop and the two differ by up to 129/255.',
    [{ name: 'original face', pts: quad, col: C.dim, close: true, dash: '4 3', w: 1.6, r: 3 },
     { name: 'option 6   move verts', pts: o6, col: C.far, close: true, w: 2, r: 3.6 },
     { name: 'option 8b  add + mitre', pts: o8b, col: C.good, close: true, w: 1.6, r: 2.8 }],
    620, 400, 5, [focus[0], focus[1], 90]));
  console.log('wrote assets/seam-corner-s8.svg');
}
