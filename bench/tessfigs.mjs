// node bench/tessfigs.mjs      -- the tessellation figures (3.5, 1.7, 6.16, 6.17)
// ---------------------------------------------------------------------------
// Four figures, each computed rather than drawn:
//
//   assets/tess-shapes.svg   3.5   one path per shape: what Firefox's own
//                                  tessellator (bench/wgr.mjs, run here) makes
//                                  of it, and what Skia on the CPU charged for
//                                  it (A3, read from bench/out/*-tess-m4.json)
//   assets/tess-budget.svg   6.16  a frame's tessellated output per repair --
//                                  none, the band, the seam stroke -- against
//                                  the 4 MB buffer, counted here through WGR
//                                  and aa-stroke on S1-S3
//   assets/merge-or-split.svg 1.7  the S18 layouts, drawn from the same
//                                  geometry tesspage.html part O timed
//                                  (bench/pathshape.js mergeLayouts()), with
//                                  the measured one-path / separate-fills cost
//   assets/accel-vs-soft.svg 6.17  20 000 separate fills: accelerated Firefox
//                                  against software, A2 held still, M6 (read
//                                  from bench/out/*-tessSGN-m6.json)
//
// Text is SVG <text>; the palette is `C`; each figure checks its declared
// height against the last line it writes.
// ---------------------------------------------------------------------------
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { WgrContext, bufferVerts, pathBufferVerts } from './wgr.mjs';
import { tierShapes, mergeLayouts, runStrategy } from './pathshape.js';
import { setup, CASES } from './tess.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, '..', 'assets'), OUT = join(__dirname, 'out');
mkdirSync(ASSETS, { recursive: true });
const C = { bg: '#f7f7fa', ink: '#1c1c22', dim: '#8a8a96', grid: '#e2e2ea', region: '#c7d7ee', shape: '#4f81bd',
            chrome: '#4f81bd', firefox: '#e08a10', band: '#e08a10', stroke: '#c0504d', good: '#2e8b3d', bad: '#d62728' };
const json = (f) => JSON.parse(readFileSync(join(OUT, f), 'utf8'));
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const text = (x, y, t, o = {}) => `<text x="${x}" y="${y}" font-size="${o.fs || 11}" fill="${o.col || C.ink}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.bold ? ' font-weight="bold"' : ''}>${esc(t)}</text>`;
const rect = (x, y, w, h, fill, op = 1) => `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}" fill-opacity="${op}"/>`;
const svgOpen = (W, H) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif"><rect width="${W}" height="${H}" fill="${C.bg}"/>`;
function write(name, svg, H, lastY) {
  if (lastY + 6 > H) throw new Error(name + ': declared height ' + H + ' < last line ' + lastY);
  writeFileSync(join(ASSETS, name), svg + '</svg>\n');
  console.log('wrote assets/' + name);
}
// a list of subpaths, fitted into a box, as one SVG path (nonzero)
function fitted(subs, x, y, w, h, fill, stroke) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of subs) for (const [a, b] of p) { x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, a); y1 = Math.max(y1, b); }
  const s = Math.min(w / (x1 - x0 || 1), h / (y1 - y0 || 1)), ox = x + (w - (x1 - x0) * s) / 2, oy = y + (h - (y1 - y0) * s) / 2;
  const d = subs.map(p => 'M' + p.map(([a, b]) => `${(ox + (a - x0) * s).toFixed(1)} ${(oy + (b - y0) * s).toFixed(1)}`).join(' L') + ' Z').join(' ');
  return `<path d="${d}" fill="${fill}" fill-opacity="0.55" stroke="${stroke}" stroke-width="0.8" fill-rule="nonzero"/>`;
}
// WGR output of one path made of `subs`
function wgrOf(subs) {
  const wc = new WgrContext(1 << 16, 1280, 720);
  wc.beginPath(); for (const p of subs) { wc.moveTo(p[0][0], p[0][1]); for (let i = 1; i < p.length; i++) wc.lineTo(p[i][0], p[i][1]); } wc.fill();
  return { verts: wc.verts, scans: wc.scans, traps: wc.traps };
}

// ============================================================================
// 1. tess-shapes.svg -- one path, six shapes
// ============================================================================
{
  const T = tierShapes();
  const sq = [[590, 310], [590, 410], [690, 410], [690, 310]];
  const tri = [[[590, 310], [590, 410], [690, 410]], [[590, 310], [690, 410], [690, 310]]];
  const a3c = Object.fromEntries(json('edge-tess-m4.json').tiers.map(r => [r.shape, r.usPerFill]));
  const a3f = Object.fromEntries(json('firefox-nonaccel-tess-m4.json').tiers.map(r => [r.shape, r.usPerFill]));
  const rows = [
    ['a square, 4 points', [sq], null],
    ['the square as 2 triangles', tri, null],
    ['convex 48-gon', T.convex, 'convex'],
    ['concave 48-point star', T.concave, 'concave'],
    ['self-crossing {48/17} star', T.crossing, 'crossing'],
    ['16 disjoint hexagons, one path', T.subpaths, 'subpaths'],
  ].map(([name, subs, key]) => ({ name, subs, key, ...wgrOf(subs) }));
  for (const r of rows) if (r.key) {
    const rec = json('edge-tess-m4.json').tiers.find(t => t.shape === r.key);
    if (rec.wgrVerts !== r.verts) throw new Error('tess-shapes: WGR count drifted from the measured run for ' + r.key);
  }
  const W = 640, rowH = 58, top = 84, H = top + rows.length * rowH + 58;
  const maxV = Math.max(...rows.map(r => r.verts)), maxA = Math.max(...Object.values(a3c));
  let s = svgOpen(W, H);
  s += text(12, 22, 'What the tessellators make of one path', { fs: 14, bold: true });
  s += text(12, 40, 'WGR output = Firefox 156\'s accelerated tessellator, run on each path (bench/wgr.mjs). A3 = Skia on the CPU,', { col: C.dim, fs: 10.5 });
  s += text(12, 54, 'µs per fill, the same path 200× (M4; Chromium / Firefox software). Every path encloses ~25 000 px² except the squares.', { col: C.dim, fs: 10.5 });
  s += text(250, top - 4, 'WGR output vertices', { fs: 10, col: C.dim });
  s += text(470, top - 4, 'Skia CPU, µs per fill', { fs: 10, col: C.dim });
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    s += rect(8, y + 4, W - 16, rowH - 6, '#fff');
    s += fitted(r.subs, 16, y + 9, 44, 44, C.region, C.shape);
    s += text(70, y + 24, r.name, { fs: 11 });
    s += text(70, y + 39, r.scans ? `${r.traps} trapezoids, ${r.scans} rows of complex scans` : `${r.traps} trapezoid${r.traps === 1 ? '' : 's'}, no complex scans`, { fs: 9.5, col: C.dim });
    const bw = 190 * r.verts / maxV;
    s += rect(250, y + 16, bw, 12, r.scans > r.traps ? C.bad : C.good, 0.75) + text(254 + bw, y + 26, `${r.verts}`, { fs: 10 });
    if (r.key) {
      const c = a3c[r.key], f = a3f[r.key];
      s += rect(470, y + 12, 120 * c / maxA, 9, C.chrome, 0.8) + text(474 + 120 * c / maxA, y + 20, `${c}`, { fs: 9.5 });
      s += rect(470, y + 24, 120 * f / maxA, 9, C.firefox, 0.8) + text(474 + 120 * f / maxA, y + 32, `${f}`, { fs: 9.5 });
    } else s += text(470, y + 26, 'not timed', { fs: 9.5, col: C.dim });
  });
  const ly = top + rows.length * rowH + 14;
  s += rect(12, ly, 12, 9, C.good, 0.75) + text(30, ly + 8, 'mostly trapezoids (the fast path)', { fs: 10 });
  s += rect(230, ly, 12, 9, C.bad, 0.75) + text(248, ly + 8, 'mostly complex scans (the slow path)', { fs: 10 });
  s += rect(470, ly, 12, 9, C.chrome, 0.8) + text(488, ly + 8, 'Chromium', { fs: 10 });
  s += rect(550, ly, 12, 9, C.firefox, 0.8) + text(568, ly + 8, 'Firefox', { fs: 10 });
  s += text(12, ly + 30, 'The shared diagonal is two coincident edges winding opposite ways: every row it spans goes to complex scans (§3.5).', { fs: 10, col: C.dim });
  write('tess-shapes.svg', s, H, ly + 30);
}

// ============================================================================
// 2. tess-budget.svg -- a frame's tessellated output per repair
// ============================================================================
{
  const budget = pathBufferVerts(4);
  const cuts = [['no repair', 'boundary'], ['in-line band (the default)', 'band+exact2+end8'], ['0.5 px seam stroke (C1)', 'shipped']];
  const scenes = [];
  for (const [nm, mk, sh, bd] of CASES) {
    const X = setup(mk, sh, bd);
    scenes.push({ nm, bars: cuts.map(([label, st]) => { const wc = new WgrContext(1 << 23, 1280, 720); runStrategy(st, X, wc); return { label, fill: wc.verts, stroke: wc.strokeVerts, total: bufferVerts(wc) }; }) });
  }
  const W = 640, top = 70, rowH = 92, H = top + scenes.length * rowH + 60;
  const maxB = Math.max(...scenes.flatMap(s => s.bars.map(b => b.total))) / budget;
  const X0 = 190, XW = 400, sx = (v) => X0 + XW * (v / budget) / maxB;
  let s = svgOpen(W, H);
  s += text(12, 22, 'A frame\'s tessellated output, per seam repair, against Firefox\'s 4 MB buffer', { fs: 14, bold: true });
  s += text(12, 40, 'Counted through Firefox 156\'s own tessellators on S1–S3 (WGR for fills, aa-stroke for strokes). The stroke\'s share', { col: C.dim, fs: 10.5 });
  s += text(12, 54, 'is aa-stroke\'s model, good to about ±20 % (T67). The dashed line is gpu-path-size = 4 MB: past it a still frame demotes.', { col: C.dim, fs: 10.5 });
  scenes.forEach((sc, i) => {
    const y = top + i * rowH;
    s += rect(8, y, W - 16, rowH - 8, '#fff');
    s += text(16, y + 16, sc.nm, { fs: 11.5, bold: true });
    sc.bars.forEach((b, j) => {
      const by = y + 24 + j * 19;
      s += text(16, by + 10, b.label, { fs: 10 });
      s += rect(X0, by, sx(b.fill) - X0, 13, C.region);
      if (j === 1) { const base = sc.bars[0].fill; s += rect(sx(base), by, sx(b.fill) - sx(base), 13, C.band, 0.8); }
      if (b.stroke) s += rect(sx(b.fill), by, sx(b.total) - sx(b.fill), 13, C.stroke, 0.75);
      s += text(sx(b.total) + 4, by + 10, `${(b.total / budget).toFixed(2)}×`, { fs: 10 });
    });
    s += `<path d="M${sx(budget).toFixed(1)} ${y + 20} V${y + rowH - 12}" stroke="${C.ink}" stroke-dasharray="3 3"/>`;
  });
  const ly = top + scenes.length * rowH + 10;
  s += rect(12, ly, 12, 9, C.region) + text(30, ly + 8, 'the fills, welded', { fs: 10 });
  s += rect(150, ly, 12, 9, C.band, 0.8) + text(168, ly + 8, 'what the band adds', { fs: 10 });
  s += rect(300, ly, 12, 9, C.stroke, 0.75) + text(318, ly + 8, 'the seam stroke\'s second tessellation', { fs: 10 });
  s += text(12, ly + 30, 'The frame is judged whole: on S2 the band keeps a still frame at 0.40× the buffer; the stroke puts it past 1.0 (§6.16).', { fs: 10, col: C.dim });
  write('tess-budget.svg', s, H, ly + 30);
}

// ============================================================================
// 3. merge-or-split.svg -- the S18 layouts and what merging them cost
// ============================================================================
{
  const runs = ['edge-tessO-m4-r1.json', 'edge-tessO-m4-r2.json'].map(json);
  const runsF = ['firefox-nonaccel-tessO-m4-r1.json', 'firefox-nonaccel-tessO-m4-r2.json'].map(json);
  const minOf = (rs, layout, cut) => Math.min(...rs.map(r => r.overlap.find(o => o.layout === layout && o.cut === cut).a3Us));
  const L = mergeLayouts().filter(([, , both]) => both);
  const W = 640, top = 84, rowH = 50, H = top + L.length * rowH + 64;
  let s = svgOpen(W, H);
  s += text(12, 22, 'One path or separate fills? The same shapes both ways', { fs: 14, bold: true });
  s += text(12, 40, 'A3 on Skia\'s CPU path, µs per layout (calls + raster), min of 2 runs, M4 — Chromium (upper bar) and Firefox software (lower);', { col: C.dim, fs: 10.5 });
  s += text(12, 54, 'geometry drawn from bench/pathshape.js mergeLayouts(), the shapes tesspage.html part O timed. Ratio = separate ÷ merged.', { col: C.dim, fs: 10.5 });
  const rows = L.map(([name, subs]) => ({ name, subs,
    c1: minOf(runs, name, 'one path'), cs: minOf(runs, name, 'separate'), f1: minOf(runsF, name, 'one path'), fs: minOf(runsF, name, 'separate'),
    w1: runs[0].overlap.find(o => o.layout === name && o.cut === 'one path').wgrVerts, ws: runs[0].overlap.find(o => o.layout === name && o.cut === 'separate').wgrVerts }));
  const maxT = Math.max(...rows.flatMap(r => [r.c1, r.cs, r.f1, r.fs]));
  const X0 = 270, XW = 115, bx = (v) => XW * v / maxT;
  s += text(X0, top - 4, 'merged', { fs: 10, col: C.dim }) + text(X0 + 130, top - 4, 'separate', { fs: 10, col: C.dim }) + text(W - 16, top - 4, 'ratio · WGR', { fs: 10, col: C.dim, anchor: 'end' });
  rows.forEach((r, i) => {
    const y = top + i * rowH, win = (r.cs / r.c1 + r.fs / r.f1) / 2;
    s += rect(8, y + 2, W - 16, rowH - 6, '#fff');
    s += fitted(r.subs, 14, y + 6, 58, 36, C.region, C.shape);
    s += text(80, y + 22, r.name, { fs: 10.5 });
    s += rect(X0, y + 10, bx(r.c1), 9, C.chrome, 0.8) + rect(X0, y + 22, bx(r.f1), 9, C.firefox, 0.8);
    s += rect(X0 + 130, y + 10, bx(r.cs), 9, C.chrome, 0.8) + rect(X0 + 130, y + 22, bx(r.fs), 9, C.firefox, 0.8);
    s += text(W - 16, y + 20, `${(r.cs / r.c1).toFixed(2)}× · ${(r.fs / r.f1).toFixed(2)}×`, { fs: 10.5, anchor: 'end', col: win >= 1.1 ? C.good : win <= 0.9 ? C.bad : C.ink, bold: true });
    s += text(W - 16, y + 34, `WGR ${r.w1} / ${r.ws}`, { fs: 9.5, anchor: 'end', col: r.w1 > 1.2 * r.ws ? C.bad : C.dim });
  });
  const ly = top + rows.length * rowH + 10;
  s += text(12, ly + 8, 'green ratio: merging wins by ≥ 10 %; red: it loses by ≥ 10 %; red WGR: merged is > 1.2× the separate fills\' output.', { fs: 10, col: C.dim });
  s += text(12, ly + 24, 'Merging pays when shapes touch or come in numbers; it stops paying for small scattered shapes (each alone', { fs: 10, col: C.dim });
  s += text(12, ly + 38, 'is in Skia\'s mask tier) and for a lone overlapping pair (§1.7).', { fs: 10, col: C.dim });
  write('merge-or-split.svg', s, H, ly + 38);
}

// ============================================================================
// 4. accel-vs-soft.svg -- "slower than software" on 20 000 separate fills
// ============================================================================
{
  const acc = json('firefox-dbg-tessSGN-m6.json').field, sw = json('firefox-nonaccel-tessSGN-m6.json').field;
  const acc8 = json('firefox-bigbuf8-tessN-m6.json').field;
  const rows = acc.map(a => {
    const s = sw.find(x => x.kind === a.kind && x.L === a.L), b8 = acc8.find(x => x.kind === a.kind && x.L === a.L);
    return { name: `${a.kind === 'mesh' ? 'mesh' : 'scattered'}, ${a.L} px`, acc: a.a2Still, accV: a.a2Verdict, soft: s.a2Still, acc8: b8 && b8.a2Still, acc8V: b8 && b8.a2Verdict, uniq: a.uniqOfBuffer };
  });
  const W = 640, top = 72, rowH = 34, H = top + rows.length * rowH + 60;
  const maxT = Math.max(...rows.flatMap(r => [r.acc, r.soft, r.acc8 || 0]));
  const X0 = 200, XW = 330, bx = (v) => XW * v / maxT;
  let s = svgOpen(W, H);
  s += text(12, 22, '20 000 separate fills on Firefox: accelerated against software', { fs: 14, bold: true });
  s += text(12, 40, 'A2 sustained ms per frame, held still, M6 (Firefox 156.0.1, Apple M4 GPU). The verdict is Gecko\'s own (A7): "accel"', { col: C.dim, fs: 10.5 });
  s += text(12, 54, 'means the green debug square was on. Each load is 60 000 path vertices; "of buffer" counts one tessellation per distinct shape.', { col: C.dim, fs: 10.5 });
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    s += rect(8, y, W - 16, rowH - 4, '#fff');
    s += text(16, y + 13, r.name, { fs: 10.5 }) + text(16, y + 25, `${r.uniq.toFixed(2)} of the 4 MB buffer`, { fs: 9, col: C.dim });
    s += rect(X0, y + 5, bx(r.acc), 9, r.accV === 'ACCEL' ? C.bad : C.dim, 0.8) + text(X0 + bx(r.acc) + 4, y + 13, `${r.acc.toFixed(1)} ${r.accV === 'ACCEL' ? 'accel' : 'demoted'} (4 MB)`, { fs: 9.5 });
    s += rect(X0, y + 17, bx(r.soft), 9, C.good, 0.8) + text(X0 + bx(r.soft) + 4, y + 25, `${r.soft.toFixed(1)} software`, { fs: 9.5 });
  });
  const ly = top + rows.length * rowH + 10;
  s += rect(12, ly, 12, 9, C.bad, 0.8) + text(30, ly + 8, 'accelerated (green square on)', { fs: 10 });
  s += rect(220, ly, 12, 9, C.dim, 0.8) + text(238, ly + 8, 'demoted to software by Gecko', { fs: 10 });
  s += rect(420, ly, 12, 9, C.good, 0.8) + text(438, ly + 8, 'acceleration off', { fs: 10 });
  s += text(12, ly + 30, 'Every load Gecko keeps accelerated runs 3.3–4.4× slower than software: the cost is per fill() call, not tessellation (§6.17).', { fs: 10, col: C.dim });
  write('accel-vs-soft.svg', s, H, ly + 30);
}
