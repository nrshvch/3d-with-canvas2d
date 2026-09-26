// node bench/bandfigs.mjs      -- assets/band-junctions.svg (4.12)
// ---------------------------------------------------------------------------
// The in-line band's junction cases -- where option 7's out-and-back detours
// cross, overlap or spill -- and what each fix does, read out of
// bench/pathshape.js's bandLoop() rather than drawn.  Every outline is that
// function's output on a small loop built to show the case, and every
// panel's verdict is COMPUTED: the script samples the nonzero winding of the
// unfixed and the fixed path on a 0.5-unit lattice and paints the samples
// whose filled/unfilled state differs.  "Exact" below means that count is 0.
//
//   a  reflex, turn <= 90 deg, both edges banded: mitre       exact, default
//   b  reflex, turn > 90 deg (a tight corner), polygon thick
//      behind it: the same mitre                              exact here
//   c  tight corner, ONE edge banded: clip the band where
//      its cap crosses the plain edge                         exact, default
//   d  tight corner, the polygon a sliver thinner than w
//      behind it: the mitre removes ink the band threw
//      through the sliver                                     changes pixels
//   e  a pinch -- the boundary passes through the vertex
//      twice: the clip would cut the band on the far side     guarded
//   f  an edge shorter than w at a reflex corner: no exact
//      fix; dropping its band reopens a sliver of seam        optional
//   g  a convex corner: option 7 leaves a notch back to the
//      tip; a bevel would paint over the third polygon that
//      shares the tip                                         declined
//   h  a run's free end: the corner follows the later
//      neighbour's own edge instead of the perpendicular      default
//
// Band width is exaggerated (w = 16 units, labelled) so a 1 px structure is
// legible.  Everything else is to scale.
// ---------------------------------------------------------------------------
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { bandLoop, E_BAND, E_SILHOUETTE } from './pathshape.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, '..', 'assets');
mkdirSync(ASSETS, { recursive: true });
const C = { bg: '#f7f7fa', ink: '#1c1c22', dim: '#8a8a96', far: '#4f81bd', near: '#c0504d',
            band: '#e08a10', good: '#2e8b3d', grid: '#e2e2ea', hole: '#d62728', region: '#c7d7ee', third: '#8e6bbf' };
const W_BAND = 16;
const B = E_BAND, S = E_SILHOUETTE;

// The panels are written in whichever order was convenient; bandLoop wants
// the batcher's orientation (region on the left under (dx,dy) -> (-dy,dx)),
// so reverse a loop that is the other way, carrying each edge's flag, apex
// and each vertex's pinch mark with it.
function orient(P0, fl0, ap0, pk0) {
  let A = 0;
  for (let i = 0; i < P0.length; i++) { const j = (i + 1) % P0.length; A += P0[i][0] * P0[j][1] - P0[j][0] * P0[i][1]; }
  if (A > 0) return [P0, fl0, ap0, pk0];
  const k = P0.length, P = P0.slice().reverse();
  return [P, P.map((_, i) => fl0[(2 * k - 2 - i) % k]), ap0 && P.map((_, i) => ap0[(2 * k - 2 - i) % k]), pk0 && P.map((_, i) => pk0[k - 1 - i])];
}
function band(P0, fl0, mit, ap0, pk0) {
  const [P, F, Q, K] = orient(P0, fl0, ap0, pk0), k = P.length;
  const px = Float64Array.from(P, p => p[0]), py = Float64Array.from(P, p => p[1]), fl = Uint8Array.from(F);
  const qx = new Float64Array(k).fill(NaN), qy = new Float64Array(k).fill(NaN);
  if (Q) Q.forEach((q, i) => { if (q) { qx[i] = q[0]; qy[i] = q[1]; } });
  const ox = new Float64Array(4 * k + 8), oy = new Float64Array(4 * k + 8);
  const m = bandLoop(px, py, fl, k, W_BAND, mit, ox, oy, qx, qy, K ? Uint8Array.from(K) : undefined);
  return Array.from({ length: m }, (_, i) => [ox[i], oy[i]]);
}
const wind = (L, x, y) => {
  let w = 0;
  for (let i = 0; i < L.length; i++) {
    const [x0, y0] = L[i], [x1, y1] = L[(i + 1) % L.length];
    if (y0 <= y) { if (y1 > y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) > 0) w++; }
    else if (y1 <= y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) < 0) w--;
  }
  return w;
};
// the samples whose filled state differs between two paths (0.5-unit lattice)
function changed(a, b) {
  const out = []; let n = 0;
  for (let y = -60; y < 320; y += 0.5) for (let x = -60; x < 320; x += 0.5) {
    n++;
    if ((wind(a, x + 0.013, y + 0.007) !== 0) !== (wind(b, x + 0.013, y + 0.007) !== 0)) out.push([x, y]);
  }
  return [out, n];
}
const path = (P, close = true) => 'M' + P.map(p => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' L') + (close ? ' Z' : '');
function crossings(P) {
  const out = [], k = P.length;
  for (let a = 0; a < k; a++) for (let b = a + 2; b < k; b++) {
    if (a === 0 && b === k - 1) continue;
    const p0 = P[a], p1 = P[(a + 1) % k], q0 = P[b], q1 = P[(b + 1) % k];
    const rx = p1[0] - p0[0], ry = p1[1] - p0[1], sx = q1[0] - q0[0], sy = q1[1] - q0[1];
    const den = rx * sy - ry * sx; if (Math.abs(den) < 1e-12) continue;
    const t = ((q0[0] - p0[0]) * sy - (q0[1] - p0[1]) * sx) / den, u = ((q0[0] - p0[0]) * ry - (q0[1] - p0[1]) * rx) / den;
    if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) out.push([p0[0] + t * rx, p0[1] + t * ry]);
  }
  return out;
}
const poly = (P, fill, op = 0.35) => `<path d="${path(P)}" fill="${fill}" fill-opacity="${op}" stroke="none"/>`;
const outline = (P, col, dash, wdt = 1.3) => `<path d="${path(P)}" fill="none" stroke="${col}" stroke-width="${wdt}" vector-effect="non-scaling-stroke"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const dot = (p, col, r = 2.6) => `<circle cx="${p[0].toFixed(2)}" cy="${p[1].toFixed(2)}" r="${r}" fill="${col}"/>`;
const label = (p, t, col = C.ink, dx = 4, dy = -4, fs = 10) => `<text x="${(p[0] + dx).toFixed(1)}" y="${(p[1] + dy).toFixed(1)}" font-size="${fs.toFixed(2)}" fill="${col}">${t}</text>`;
const X = (p, col) => `<path d="M${(p[0] - 3.5).toFixed(1)} ${(p[1] - 3.5).toFixed(1)} L${(p[0] + 3.5).toFixed(1)} ${(p[1] + 3.5).toFixed(1)} M${(p[0] - 3.5).toFixed(1)} ${(p[1] + 3.5).toFixed(1)} L${(p[0] + 3.5).toFixed(1)} ${(p[1] - 3.5).toFixed(1)}" stroke="${col}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;
// changed samples as one path of 0.5-unit cells
const cells = (pts) => pts.length ? `<path d="${pts.map(([x, y]) => `M${x.toFixed(1)} ${y.toFixed(1)}h0.6v0.6h-0.6z`).join('')}" fill="${C.hole}"/>` : '';

// One panel: the region, the unfixed band dashed, the fixed band solid, the
// crossings each leaves, and the changed samples in red.  `alt` draws a
// second, rejected outline in red dashes instead of the fixed one's cells.
function scene(P, fl, mit, opt = {}) {
  const o7 = band(P, fl, {}, opt.apex, opt.pinch), fx = band(P, fl, mit, opt.apex, opt.pinch);
  const cmpTo = opt.alt ? band(P, fl, opt.alt, opt.apex, opt.pinch) : fx;
  const [diff, n] = changed(o7, cmpTo);
  let body = (opt.under || '') + poly(fx, C.band, 0.22) + poly(P, C.region, 1) + (opt.over || '') +
             outline(o7, C.band, '5 3') + outline(fx, C.good, null, 1.2) +
             (opt.alt ? outline(cmpTo, C.hole, '2 2', 1.2) : '') +
             crossings(o7).map(p => X(p, C.hole)).join('') + cells(diff) + (opt.marks || '');
  // zoom: draw the body scaled by v.s about (v.cx, v.cy), centred in the 250-wide view
  if (opt.view) { const v = opt.view; body = `<g transform="translate(125,${v.ty || 100}) scale(${v.s}) translate(${-v.cx},${-v.cy})">${body}</g>`; }
  const verts = `${o7.length} → ${(opt.alt ? cmpTo : fx).length} vertices`;
  const verdict = diff.length === 0 ? 'no sample changes' : `${diff.length} samples change`;
  return { body, stat: (opt.alt ? 'rejected fix: ' : '') + verts + ', ' + verdict, diff: diff.length, fx, o7 };
}

const PW = 290, PH = 262;
function panel(ox, oy, title, lines, s) {
  let g = `<g transform="translate(${ox},${oy})">`;
  g += `<rect x="0" y="0" width="${PW}" height="${PH}" fill="#fff" stroke="${C.grid}"/>`;
  g += `<text x="10" y="18" font-size="12.5" font-weight="bold" fill="${C.ink}">${title}</text>`;
  lines.forEach((l, i) => { g += `<text x="10" y="${34 + i * 14}" font-size="10.5" fill="${C.dim}">${l}</text>`; });
  const sy = 34 + lines.length * 14;
  g += `<text x="10" y="${sy}" font-size="10.5" fill="${s.diff ? C.hole : C.good}">${s.stat}</text>`;
  const top = sy + 8, id = 'clip' + (panel.n = (panel.n || 0) + 1);
  g += `<clipPath id="${id}"><rect x="0" y="0" width="250" height="${PH - top - 10}"/></clipPath>`;
  g += `<g transform="translate(20,${top})"><g clip-path="url(#${id})">${s.body}</g></g></g>`;
  return g;
}

const parts = [];
const EXACT = { spike: true, reflex: true };
const notch = [[-40, -40], [-40, 300], [300, 300], [300, -40], [150, -40], [125, 130], [100, -40]];

// a: reflex <= 90, both banded
{
  const P = [[-40, -40], [-40, 300], [110, 300], [110, 80], [300, 80], [300, -40]];
  const s = scene(P, [S, S, B, B, S, S], EXACT, { marks: dot([110, 80], C.ink) + label([110, 80], 'b', C.ink, -12, -6) });
  if (s.diff) throw new Error('panel a must be exact');
  parts.push(['a  reflex ≤ 90°, both edges banded', ['the two bands overlap at the corner (a w × w', 'square); mitre them to one point H. DEFAULT.'], s]);
}
// b: tight corner, thick polygon
{
  const s = scene(notch, [S, S, S, S, B, B, S], { spike: true, reflex: true, reflexAny: true },
                  { marks: dot([125, 130], C.ink) + label([125, 130], 'b', C.ink, 5, 14) });
  if (s.diff) throw new Error('panel b must be exact');
  parts.push(['b  tight corner (> 90°), both banded', ['each band pokes across the other edge into the', 'polygon; mitre them: exact while it is thick.'], s]);
}
// c: tight corner, one band -> clip
{
  const s = scene(notch, [S, S, S, S, B, S, S], { spike: true, reflex: true, endclip: true },
                  { marks: dot([125, 130], C.ink) + label([125, 130], 'b', C.ink, 5, 14) });
  if (s.diff) throw new Error('panel c must be exact');
  parts.push(['c  tight corner, one edge banded', ['the cap crosses the plain edge into the polygon;', 'stop the band at the crossing. DEFAULT.'], s]);
}
// d: tight corner, a sliver behind it
{
  const P = [[20, 20], [160, 20], [172, 260], [160, 120], [20, 250]];
  const s = scene(P, [S, S, B, B, S], { spike: true, reflex: true, reflexAny: true },
                  { view: { s: 2.2, cx: 160, cy: 130, ty: 90 },
                    marks: dot([160, 120], C.ink, 1.3) + label([160, 120], 'b', C.ink, -6, -2, 10 / 2.2) + label([172, 150], 'sliver', C.ink, 2, 0, 10 / 2.2) });
  if (!s.diff) throw new Error('panel d must change the region');
  parts.push(['d  tight corner, a sliver behind it', ['a band reaches through the sliver past its far', 'edge; the mitre removes that spill. OPTIONAL.'], s]);
}
// e: a pinch -- the unguarded clip cuts the band on the far side
{
  const c = [125, 130], P = [c, [20, 20], [20, 280], c, [140, 290], [175, 280]];
  const fl = [S, S, B, S, S, S], pk = [1, 0, 0, 1, 0, 0];
  const s = scene(P, fl, { spike: true, reflex: true, endclip: true, noPinch: true },
                  { pinch: pk, alt: { spike: true, reflex: true, endclip: true },
                    view: { s: 1.8, cx: 128, cy: 160, ty: 90 },
                    marks: dot(c, C.ink, 1.6) + label(c, 'pinch', C.ink, 4, -3, 10 / 1.8) });
  if (!s.diff) throw new Error('panel e: the unguarded clip must change the region');
  if (changed(s.o7, s.fx)[0].length) throw new Error('panel e: the guarded clip must be exact');
  parts.push(['e  a pinch: the boundary meets itself', ['the lobe behind the plain edge tapers to 0 at', 'the vertex; clip (red dashes) cuts ink. GUARDED.'], s]);
}
// f: an edge shorter than w at a reflex corner
{
  const P = [[-40, -40], [-40, 300], [300, 300], [300, -40], [140, -40], [131, 120], [119, 120], [110, -40]];
  const s = scene(P, [S, S, S, S, B, B, S, S], { spike: true, reflex: true, shortReflex: true },
                  { marks: label([119, 120], '12 &lt; w', C.ink, -8, 30) });
  if (!s.diff) throw new Error('panel f must change the region');
  parts.push(['f  an edge shorter than w, reflex corner', ['the bands reach past each other\'s ends: no', 'exact fix. Drop that band (lossy). OPTIONAL.'], s]);
}
// g: a convex corner -- why no bevel
{
  const P = [[20, 250], [20, 90], [150, 40], [250, 150], [250, 250]];
  const tip = [150, 40];
  // the third polygon T shares the tip and sits in the wedge between the two bands
  const T = [tip, [90, -40], [230, -40]];
  const s = scene(P, [S, B, B, S, S], EXACT,
                  { alt: { spike: true, reflex: true, bevel: true }, under: poly(T, C.third, 0.3),
                    marks: dot(tip, C.ink) + label(tip, 'tip', C.ink, 6, 2) + label([150, -20], 'T', C.third, -4, 0) });
  parts.push(['g  convex corner: keep the notch', ['option 7 returns to the tip between the bands; a', 'bevel (red) would paint over T. DECLINED.'], s]);
}
// h: a free end
{
  const P = [[40, 300], [40, 110], [190, 110], [260, 300]], q = [100, 20];
  const Q = [[40, 110], q, [190, 110]];
  const s = scene(P, [S, B, S, S], { spike: true, reflex: true, end8: true },
                  { apex: [null, q, null, null], under: poly(Q, C.near, 0.25),
                    marks: dot(q, C.near) + label(q, 'q', C.near, 6, 4) + label([100, 80], 'Q (later)', C.near, -24, 8) +
                           dot([190, 110], C.ink) + label([190, 110], 'b', C.ink, 5, 14) + dot([40, 110], C.ink) + label([40, 110], 'a', C.ink, -12, 14) });
  parts.push(['h  a free end: follow the neighbour', ['the perpendicular corner spills past Q; put it', 'on Q\'s own edge b→q. No q known: perpendicular.'], s]);
}

// the band must lie OUTSIDE the region: every fixed outline encloses at least the loop's area
const area = (P) => { let A = 0; for (let i = 0; i < P.length; i++) { const j = (i + 1) % P.length; A += P[i][0] * P[j][1] - P[j][0] * P[i][1]; } return Math.abs(A) / 2; };
for (const [t, , s] of parts) if (area(s.fx) < area(s.o7) * 0.5) throw new Error('band collapsed in panel ' + t);

const Wd = 620, rows = Math.ceil(parts.length / 2), ly = 10 + rows * (PH + 12) + 4, Hd = ly + 94;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Wd}" height="${Hd}" viewBox="0 0 ${Wd} ${Hd}" font-family="Helvetica, Arial, sans-serif">`;
svg += `<rect width="${Wd}" height="${Hd}" fill="${C.bg}"/>`;
parts.forEach(([t, lines, s], i) => { svg += panel(10 + (i % 2) * 305, 10 + ((i / 2) | 0) * (PH + 12), t, lines, s); });
svg += `<g transform="translate(10,${ly})" font-size="11" fill="${C.ink}">` +
  `<rect x="0" y="0" width="14" height="10" fill="${C.region}"/><text x="20" y="9">the batch's region (drawn first)</text>` +
  `<rect x="230" y="0" width="14" height="10" fill="${C.near}" fill-opacity="0.25"/><text x="250" y="9">Q, the later neighbour</text>` +
  `<rect x="420" y="0" width="14" height="10" fill="${C.third}" fill-opacity="0.3"/><text x="440" y="9">T, a third polygon</text>` +
  `<path d="M0 26 H14" stroke="${C.band}" stroke-width="1.3" stroke-dasharray="5 3"/><text x="20" y="30">option 7, no fix</text>` +
  `<path d="M230 26 H244" stroke="${C.good}" stroke-width="1.3"/><text x="250" y="30">bandLoop() with the fix</text>` +
  `<path d="M420 26 H434" stroke="${C.hole}" stroke-width="1.3" stroke-dasharray="2 2"/><text x="440" y="30">a rejected fix</text>` +
  `<path d="M0 44 L7 51 M0 51 L7 44" stroke="${C.hole}" stroke-width="1.5"/><text x="20" y="51">a self-crossing option 7 leaves</text>` +
  `<rect x="230" y="42" width="10" height="10" fill="${C.hole}"/><text x="250" y="51">samples whose filled state the fix changes</text>` +
  `<text x="0" y="70" fill="${C.dim}">w = ${W_BAND} units here, 1 px in the renderer (d and e zoomed). Outlines are bench/pathshape.js's bandLoop()</text>` +
  `<text x="0" y="84" fill="${C.dim}">output; each status line samples both paths' nonzero winding on a 0.5-unit lattice, 577 600 samples a panel.</text>` +
  `</g>`;
svg += '</svg>\n';
if (ly + 84 + 6 > Hd) throw new Error('figure height too small');
writeFileSync(join(ASSETS, 'band-junctions.svg'), svg);
for (const [t, , s] of parts) console.log(t.padEnd(40), s.stat);
console.log('wrote assets/band-junctions.svg');
