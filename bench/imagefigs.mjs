// ---------------------------------------------------------------------------
// imagefigs.mjs -- assets/image-sources.svg (§4.13, T75-T77).
//
// Every bar is read out of the committed bench/out/ results of
// bench/imagepage.html, so the figure cannot drift from the runs it
// summarises:
//   M4 (no GPU)  edge-img-m4.json (Chromium --disable-gpu),
//                firefox-nonaccel-img-m4.json (Firefox software)
//   M6 (GPU)     edge-img2-gpu-r1..r2.json (Chrome, Skia Graphite) and
//                safari-img2-gpu-r1..r2.json: the median of the two runs
//   and assets/texture-materials.svg (§4.14, T78-T79) from part M and part B
//   top:    A2 sustained ms per frame of the workload, recipe x source.  A
//           row that ran at the display's refresh rate (frames >= 340 in the
//           ~3.5 s window, any run) is an upper bound: drawn faint, marked <=.
//   bottom: A10 first use -- the first draw of a fresh 2048x2048 source per
//           preparation, with the second draw as a tick.
// Text is SVG <text>; the palette is `C`; the declared height is checked
// against the last line written.
//
//   node bench/imagefigs.mjs
// ---------------------------------------------------------------------------
import { writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out'), ASSETS = join(HERE, '..', 'assets');
const C = { bg: '#f7f7fa', ink: '#1c1c22', dim: '#8a8a96', grid: '#e2e2ea',
            chrome: '#4f81bd', firefox: '#e08a10', gpu: '#2e8b3d', safari: '#8e5ea2', second: '#55555f' };
const SRC = { 'img-png': 1, 'img-jpg': 0.8, 'bitmap': 0.6, 'canvas': 0.4 };   // fill opacity per source
const json = f => JSON.parse(readFileSync(join(OUT, f), 'utf8'));
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const text = (x, y, t, o = {}) => `<text x="${x}" y="${y}" font-size="${o.fs || 11}" fill="${o.col || C.ink}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.bold ? ' font-weight="bold"' : ''}>${esc(t)}</text>`;
const rect = (x, y, w, h, fill, op = 1) => `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}" fill-opacity="${op}"/>`;
const med = a => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };

// merge repeated runs: per row the median A2, floored if any run was floored
function merged(files) {
  const js = files.map(json);
  const out = { sprite: [], tri: [], first: [] };
  for (const k of ['sprite', 'tri']) js[0][k].forEach((r, i) => {
    const rows = js.map(j => j[k][i]);
    out[k].push({ recipe: r.recipe, source: r.source, sustMs: med(rows.map(e => e.sustMs)),
                  floored: rows.some(e => e.floored || e.frames >= 340) });
  });
  js[0].first.forEach((r, i) => {
    const rows = js.map(j => j.first[i]);
    out.first.push({ source: r.source, firstMs: med(rows.map(e => e.firstMs)),
                     secondMs: med(rows.map(e => e.secondMs)), blockMs: med(rows.map(e => e.blockMs)) });
  });
  return out;
}
// M6: the second, calibrated round (the first left many GPU rows on the floor)
const M6 = merged([1, 2].map(i => `edge-img2-gpu-r${i}.json`));
const SAF = merged([1, 2].map(i => `safari-img2-gpu-r${i}.json`));
const ENG = [
  ['M4 · Chromium 141, CPU', merged(['edge-img-m4.json']), C.chrome],
  ['M6 · Chrome 153, Graphite GPU', M6, C.gpu],
  ['M4 · Firefox 156, software', merged(['firefox-nonaccel-img-m4.json']), C.firefox],
  ['M6 · Safari 26.6.2', SAF, C.safari]];

const WID = 1000, COLW = 500, LX = 128, BW = 230;
let s = '', y = 26;
s += text(16, y, 'Sprites, triangles and image sources, CPU (M4) and GPU (M6) — bench/imagepage.html, T75–T77', { fs: 13, bold: true });
y += 18;
s += text(16, y, 'A2 sustained, ms per frame of the workload, each panel on its own scale. Bars per source: img-png, img-jpg, bitmap, canvas (dark → light).', { col: C.dim, fs: 10 });
y += 13;
s += text(16, y, 'Faint bar with ≤ = the row ran at the display refresh: an upper bound, not a cost. M6 is the median of 2 calibrated runs.', { col: C.dim, fs: 10 });

// --- top: recipes x sources, two engines per band -----------------------------
const groups = [['sprite', 'drawImage', '2000 sprites, 1:1'], ['sprite', 'pattern fillRect', ''],
                ['sprite', 'drawImage rot+1.5x', '2000 sprites, rotated 1.5×'], ['sprite', 'pattern rot+1.5x', ''],
                ['tri', 'clip + drawImage', '1152 triangles'], ['tri', 'pattern fill', '']];
const short = { 'drawImage': 'drawImage', 'pattern fillRect': 'pattern', 'drawImage rot+1.5x': 'drawImage',
                'pattern rot+1.5x': 'pattern', 'clip + drawImage': 'clip+drawImage', 'pattern fill': 'pattern fill' };
function panel(x0, y0, [ename, j, col]) {
  let yy = y0 + 22, o = text(x0 + 16, yy, ename, { bold: true, col });
  const rows = groups.map(([k, r]) => j[k].filter(e => e.recipe === r));
  const sc = BW / Math.max(...rows.flat().map(e => e.sustMs));
  for (let g = 0; g < groups.length; g++) {
    yy += 8;
    if (groups[g][2]) { yy += 12; o += text(x0 + 16, yy, groups[g][2], { col: C.dim, fs: 10 }); yy += 2; }
    o += text(x0 + LX - 8, yy + 18, short[groups[g][1]], { anchor: 'end' });
    for (const e of rows[g]) { o += rect(x0 + LX, yy, e.sustMs * sc, 6, col, e.floored ? 0.18 : SRC[e.source]); yy += 7; }
    const lo = Math.min(...rows[g].map(e => e.sustMs)), hi = Math.max(...rows[g].map(e => e.sustMs));
    const fl = rows[g].some(e => e.floored), all = rows[g].every(e => e.floored);
    const lab = (all ? '≤ ' : '') + (lo < 10 ? lo.toFixed(2) : lo.toFixed(1)) + (hi - lo > 0.05 ? '–' + (hi < 10 ? hi.toFixed(2) : hi.toFixed(1)) : '') + ' ms' + (fl && !all ? ' (some ≤)' : '');
    o += text(x0 + LX + hi * sc + 6, yy - 6, lab, { fs: 10 });
  }
  return [o, yy];
}
for (let b = 0; b < 2; b++) {
  const [l, yl] = panel(0, y, ENG[b * 2]), [r, yr] = panel(COLW, y, ENG[b * 2 + 1]);
  s += l + r; y = Math.max(yl, yr) + 6;
}

// --- bottom: first use --------------------------------------------------------
y += 30;
s += text(16, y, 'A10 first use of a fresh 2048×2048 source: first draw + 1 px read, ms. Dark tick = the second draw.', { bold: true, fs: 12 });
y += 14;
s += text(16, y, 'Preparation (onload, decode(), createImageBitmap) is not in the bar; the canvas row adds its main-thread copy at creation, light.', { col: C.dim, fs: 10 });
const kinds = ['img-png (onload only)', 'img-png + decode()', 'img-jpg (onload only)', 'img-jpg + decode()',
               'bitmap (png blob)', 'bitmap (jpg blob)', 'canvas (img drawn in)'];
const FE = [ENG[0], ENG[2], ENG[1], ENG[3]];
const FLX = 190, FBW = 640;
const fsc = FBW / Math.max(...FE.flatMap(([, j]) => j.first.map(e => e.firstMs + e.blockMs)));
for (const k of kinds) {
  y += 10;
  s += text(FLX - 8, y + 24, k, { anchor: 'end' });
  for (const [, j, col] of FE) {
    const e = j.first.find(f => f.source === k);
    const tot = e.firstMs + e.blockMs;
    s += rect(FLX, y, e.blockMs * fsc, 7, col, 0.35);
    s += rect(FLX + e.blockMs * fsc, y, e.firstMs * fsc, 7, col, 1);
    s += rect(FLX + e.blockMs * fsc + e.secondMs * fsc - 1, y - 1, 2, 9, C.second);
    s += text(FLX + tot * fsc + 6, y + 7, (e.blockMs ? e.blockMs.toFixed(0) + ' + ' : '') + e.firstMs.toFixed(1) + ' ms' + (e.secondMs > 10 ? ' (2nd ' + e.secondMs.toFixed(1) + ')' : ''), { fs: 9 });
    y += 11;
  }
}
y += 24;
let lx = 16;
for (const [n, , col] of FE) { s += rect(lx, y - 8, 10, 8, col); s += text(lx + 14, y, n, { fs: 10 }); lx += 200; }
y += 16;
s += text(16, y, 'M4 has no GPU; M6 is an Apple M4 MacBook Air at 100 Hz. M6 Firefox is left out: its per-case acceleration verdict was not recorded.', { col: C.dim, fs: 10 });

const HGT = y + 14;
if (y + 6 > HGT) throw new Error('declared height < last line');
writeFileSync(join(ASSETS, 'image-sources.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="${WID}" height="${HGT}" viewBox="0 0 ${WID} ${HGT}" font-family="Helvetica, Arial, sans-serif"><rect width="${WID}" height="${HGT}" fill="${C.bg}"/>` + s + '</svg>\n');
console.log('wrote assets/image-sources.svg (' + WID + 'x' + HGT + ')');

// --- assets/texture-materials.svg: part M (S22) and part B (S23), M6 --------
{
  const E2 = [['Chrome 153, Graphite', 'edge', C.gpu], ['Safari 26.6.2', 'safari', C.safari],
              ['Firefox 156, software', 'firefox-nonaccel', C.firefox]];
  const mfiles = (e, tag, n) => e === 'firefox-nonaccel' ? [e + '-imgM-gpu-r1.json'] : [1, 2, 3].slice(0, n).map(i => `${e}-${tag}-gpu-r${i}.json`);
  const matOf = files => { const js = files.map(json); return js[0].mat.map((r, i) => ({ recipe: r.recipe, source: r.source, sustMs: med(js.map(j => j.mat[i].sustMs)) })); };
  const W2 = 1000, LX2 = 128, BW2 = 115, PW = 330;
  let t = '', yy = 26;
  t += text(16, yy, 'Tiled materials (S22) and whole-image draws by size (S23) on M6 — bench/imagepage.html, T78–T79', { fs: 13, bold: true });
  yy += 18;
  t += text(16, yy, 'A2 sustained, ms per frame, each panel on its own scale; median of 3 runs (Firefox software: 1). Bars per source: img-png, bitmap, 128 px canvas (dark → light).', { col: C.dim, fs: 10 });
  const SRC3 = { 'img-png': 1, 'bitmap': 0.65, 'canvas': 0.35 };
  const recs = ['pattern repeat', 'clip + pre-tiled', 'clip + per tile'];
  let ytop = yy + 10, ymax = 0;
  E2.forEach(([name, e, col], k) => {
    const x0 = k * PW;
    let y = ytop + 20;
    t += text(x0 + 16, y, name, { bold: true, col });
    for (const [lab, tag, n] of [['tiled 4 × 4', 'imgM', 3], ['1 × 1', 'imgM1', 1]]) {
      if (e === 'firefox-nonaccel' && tag === 'imgM1') { y += 18; t += text(x0 + 16, y, '1 × 1: not measured', { col: C.dim, fs: 10 }); continue; }
      const rows = matOf(mfiles(e, tag, n));
      const sc = BW2 / Math.max(...rows.map(r => r.sustMs));
      y += 18; t += text(x0 + 16, y, lab, { col: C.dim, fs: 10 });
      for (const rc of recs) {
        y += 6;
        t += text(x0 + LX2 - 8, y + 12, rc, { anchor: 'end', fs: 10 });
        const rr = rows.filter(r => r.recipe === rc);
        for (const r of rr) { t += rect(x0 + LX2, y, r.sustMs * sc, 6, col, SRC3[r.source]); y += 7; }
        const lo = Math.min(...rr.map(r => r.sustMs)), hi = Math.max(...rr.map(r => r.sustMs));
        const f = v => v < 10 ? v.toFixed(2) : v.toFixed(0);
        t += text(x0 + LX2 + hi * sc + 4, y - 6, f(lo) + (hi - lo > 0.005 ? '–' + f(hi) : ''), { fs: 9 });
      }
    }
    ymax = Math.max(ymax, y);
  });
  // part B: <img> / bitmap / canvas per size, log-ish via own scale per engine
  yy = ymax + 34;
  t += text(16, yy, 'S23: 16 whole-image drawImage per frame (A2, ms, median of 2 runs). Faint = on the refresh floor, an upper bound.', { bold: true, fs: 12 });
  const sizes = [256, 512, 1024, 2048, 4096];
  ytop = yy + 6; ymax = 0;
  E2.forEach(([name, e, col], k) => {
    const x0 = k * PW, files = e === 'firefox-nonaccel' ? [e + '-imgM-gpu-r1.json'] : [1, 2].map(i => `${e}-imgB-gpu-r${i}.json`);
    const js = files.map(json);
    const rows = js[0].size.map((r, i) => ({ size: r.size, source: r.source, sustMs: med(js.map(j => j.size[i].sustMs)), floored: js.some(j => j.size[i].floored) }));
    const sc = BW2 / Math.max(...rows.map(r => r.sustMs));
    let y = ytop + 20;
    t += text(x0 + 16, y, name, { bold: true, col });
    for (const n of sizes) {
      y += 6;
      t += text(x0 + LX2 - 8, y + 12, n + ' px', { anchor: 'end', fs: 10 });
      const rr = rows.filter(r => r.size === n);
      for (const r of rr) { t += rect(x0 + LX2, y, Math.max(1, r.sustMs * sc), 6, col, r.floored ? 0.15 : SRC3[r.source]); y += 7; }
      const img = rr.find(r => r.source === 'img-png'), bm = rr.find(r => r.source === 'bitmap');
      const lab = bm.floored ? 'img ' + img.sustMs.toFixed(2) + ' (bitmap ≤)' : 'img ÷ bitmap ' + (img.sustMs / bm.sustMs).toFixed(2) + '×';
      t += text(x0 + LX2 + Math.max(...rr.map(r => r.sustMs)) * sc + 4, y - 6, lab, { fs: 9 });
    }
    ymax = Math.max(ymax, y);
  });
  yy = ymax + 22;
  t += text(16, yy, 'M6 Firefox accelerated profile left out: every row demoted during its timing loop (T78), so its A2 is mixed-regime.', { col: C.dim, fs: 10 });
  const H2 = yy + 14;
  if (yy + 6 > H2) throw new Error('declared height < last line');
  writeFileSync(join(ASSETS, 'texture-materials.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W2}" height="${H2}" viewBox="0 0 ${W2} ${H2}" font-family="Helvetica, Arial, sans-serif"><rect width="${W2}" height="${H2}" fill="${C.bg}"/>` + t + '</svg>\n');
  console.log('wrote assets/texture-materials.svg (' + W2 + 'x' + H2 + ')');
}
