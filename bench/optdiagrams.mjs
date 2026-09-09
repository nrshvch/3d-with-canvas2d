// node bench/optdiagrams.mjs
// ---------------------------------------------------------------------------
// Writes the figures for 4.8 into assets/.
//
//   assets/seam-options.svg   schematic: what each of the eight options does
//                             to the same pair of polygons
//
// This is a DRAWING -- a synthetic pair of polygons chosen so both kinds of
// run end are visible in one picture, with the band width exaggerated.  The
// two figures that are dumps of the shipped code paths live in optfigs.mjs;
// keeping them in separate scripts means neither can overwrite the other.
// ---------------------------------------------------------------------------
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { createContext, runInContext } from 'vm';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, '..', 'assets');
mkdirSync(ASSETS, { recursive: true });

// ---- palette, readable on a light or a dark page ---------------------------
const C = {
  bg: '#f7f7fa', ink: '#1c1c22', dim: '#8a8a96', far: '#4f81bd', near: '#c0504d',
  band: '#f0a030', bandFill: 'rgba(240,160,48,0.45)', bad: '#d02020', good: '#2e8b3d',
  grid: '#dcdce4'
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// ===========================================================================
// figure 1: the schematic
// ===========================================================================
// One pair of polygons, drawn ten times.  P (farther, drawn first) is on the
// left, Q (nearer) on the right, sharing the edge A->B.  At A the two
// polygons' other edges continue STRAIGHT through the vertex; at B they meet
// at a corner.  That is deliberate: it is the difference option 8 turns on.
const PANEL_W = 250, PANEL_H = 190, COLS = 3, PAD = 14, LABEL_H = 34;

const A = [125, 40], B = [108, 150];              // the shared edge
const P = [[18, 26], A, B, [22, 166]];            // farther, left
const Q = [[232, 30], A, B, [206, 172]].slice();  // nearer, right -- built below
// Q must traverse the shared edge backwards, and its other edge at A must be
// collinear with P's other edge at A.  P's edge into A comes from [18,26], so
// Q's edge out of A continues that same direction.
const dirPA = [A[0] - P[0][0], A[1] - P[0][1]];
const QA = [A[0] + dirPA[0] * 0.62, A[1] + dirPA[1] * 0.62];
const QLOOPS = [QA, [236, 176], [150, 190], B, A];   // A -> ... -> B -> A order below

function polyPath(pts) {
  return 'M ' + pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L ') + ' Z';
}
function norm(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  return [dx / L, dy / L];
}
// outward normal of A->B for P (P is to the left, so outward points right)
function outN() {
  const [ux, uy] = norm(A, B);
  let n = [uy, -ux];
  const cx = P.reduce((s, p) => s + p[0], 0) / P.length;
  const cy = P.reduce((s, p) => s + p[1], 0) / P.length;
  if (n[0] * (A[0] - cx) + n[1] * (A[1] - cy) < 0) n = [-n[0], -n[1]];
  return n;
}
const N = outN();
const Wb = 13;                                    // band width, exaggerated for print

// Q's loop, drawn so the shared edge is traversed B -> A
const QPOLY = [[232, 30], QA, [236, 176], [150, 190], B, A];

function panel(i, title, sub, body) {
  const cx = (i % COLS) * (PANEL_W + PAD), cy = ((i / COLS) | 0) * (PANEL_H + LABEL_H + PAD);
  return `<g transform="translate(${cx},${cy})">
  <clipPath id="cp${i}"><rect x="0" y="0" width="${PANEL_W}" height="${PANEL_H}"/></clipPath>
  <rect x="0" y="0" width="${PANEL_W}" height="${PANEL_H}" fill="#fff" stroke="${C.grid}"/>
  <g clip-path="url(#cp${i})">${body}</g>
  <text x="4" y="${PANEL_H + 14}" font-family="monospace" font-size="12" font-weight="bold" fill="${C.ink}">${esc(title)}</text>
  <text x="4" y="${PANEL_H + 27}" font-family="monospace" font-size="10" fill="${C.dim}">${esc(sub)}</text>
</g>`;
}
const basePolys = (dimP) => `
  <path d="${polyPath(QPOLY)}" fill="${C.near}" fill-opacity="0.20" stroke="${C.near}" stroke-width="1"/>
  <path d="${polyPath(P)}" fill="${C.far}" fill-opacity="${dimP ? 0.10 : 0.22}" stroke="${C.far}" stroke-width="1" ${dimP ? 'stroke-dasharray="3 2"' : ''}/>
  <line x1="${A[0]}" y1="${A[1]}" x2="${B[0]}" y2="${B[1]}" stroke="${C.ink}" stroke-width="1.6"/>
  <circle cx="${A[0]}" cy="${A[1]}" r="2.6" fill="${C.ink}"/>
  <circle cx="${B[0]}" cy="${B[1]}" r="2.6" fill="${C.ink}"/>
  <text x="${A[0] + 6}" y="${A[1] - 4}" font-family="monospace" font-size="11" fill="${C.ink}">a</text>
  <text x="${B[0] + 6}" y="${B[1] + 13}" font-family="monospace" font-size="11" fill="${C.ink}">b</text>`;

function strokeBand(pts, closed) {
  const d = closed ? polyPath(pts) : 'M ' + pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L ');
  return `<path d="${d}" fill="none" stroke="${C.bandFill}" stroke-width="${Wb}" stroke-linejoin="miter"/>`;
}
function expandLoop(pts, sel, d) {
  // offset selected edge lines outward, re-intersect (option 2/4/6's move)
  const n = pts.length;
  let a2 = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a2 += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]; }
  const sgn = a2 > 0 ? 1 : -1;
  const L = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [ux, uy] = norm(pts[i], pts[j]);
    const nx = sgn * uy, ny = -sgn * ux;
    L.push([nx, ny, nx * pts[i][0] + ny * pts[i][1] + (sel[i] ? d : 0)]);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = L[(i + n - 1) % n], c = L[i];
    const det = p[0] * c[1] - c[0] * p[1];
    if (Math.abs(det) < 1e-9) { out.push(pts[i].slice()); continue; }
    out.push([(p[2] * c[1] - c[2] * p[1]) / det, (p[0] * c[2] - c[0] * p[2]) / det]);
  }
  return out;
}
const ALL = [1, 1, 1, 1], SHARED = [0, 1, 0, 0];    // P's edge 1 is a->b
const mark = (p, col, r) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${r || 3.2}" fill="${col}"/>`;
const arrow = (a, b, col) => `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" stroke="${col}" stroke-width="1.2" marker-end="url(#ah)"/>`;

const panels = [];
panels.push(panel(0, '1  stroke all, all polys',
  'no adjacency, no depth test',
  basePolys(false) + strokeBand(P, true) + strokeBand(QPOLY, true)));
panels.push(panel(1, '2  expand all, all polys',
  'no adjacency, no depth test',
  basePolys(true) +
  `<path d="${polyPath(expandLoop(P, ALL, Wb / 2))}" fill="none" stroke="${C.bad}" stroke-width="1.6"/>` +
  `<path d="${polyPath(expandLoop(QPOLY, [1, 1, 1, 1, 1, 1], Wb / 2))}" fill="none" stroke="${C.bad}" stroke-width="1.6"/>`));
panels.push(panel(2, '3  stroke all, farther only',
  'depth test, whole boundary',
  basePolys(false) + strokeBand(P, true)));
panels.push(panel(3, '4  expand all, farther only',
  'depth test, whole boundary',
  basePolys(true) +
  `<path d="${polyPath(expandLoop(P, ALL, Wb / 2))}" fill="none" stroke="${C.bad}" stroke-width="1.6"/>`));
panels.push(panel(4, '5  stroke the shared edge',
  'separate path, straddles the edge',
  basePolys(false) + strokeBand([A, B], false)));
{
  const e = expandLoop(P, SHARED, Wb / 2);
  panels.push(panel(5, '6  expand edge, move verts',
    'a and b travel; adjacent edges slide',
    basePolys(true) +
    `<path d="${polyPath(e)}" fill="${C.band}" fill-opacity="0.18" stroke="${C.band}" stroke-width="1.6"/>` +
    arrow(A, e[1], C.bad) + arrow(B, e[2], C.bad) + mark(e[1], C.bad) + mark(e[2], C.bad)));
}
{
  const a2 = [A[0] + N[0] * Wb / 2, A[1] + N[1] * Wb / 2];
  const b2 = [B[0] + N[0] * Wb / 2, B[1] + N[1] * Wb / 2];
  const loop = [P[0], A, a2, b2, B, P[3]];
  panels.push(panel(6, '7  add 2 verts, along normal',
    'a and b stay; corners stick out',
    basePolys(true) +
    `<path d="${polyPath(loop)}" fill="${C.band}" fill-opacity="0.18" stroke="${C.band}" stroke-width="1.6"/>` +
    mark(a2, C.good) + mark(b2, C.good) +
    `<text x="${a2[0] + 5}" y="${a2[1] - 3}" font-family="monospace" font-size="10" fill="${C.good}">a'</text>` +
    `<text x="${b2[0] + 5}" y="${b2[1] + 12}" font-family="monospace" font-size="10" fill="${C.good}">b'</text>`));
}
{
  // option 8: the added vertex runs along Q's other edge at that corner, out
  // to where it is a full width clear of the shared edge
  function corner(v, d) {
    const [ux, uy] = norm(v, d);
    const dn = ux * N[0] + uy * N[1];
    const t = Math.abs(dn) < 1e-6 ? Wb / 2 : (Wb / 2) / dn;
    return [v[0] + ux * t, v[1] + uy * t];
  }
  const a2 = corner(A, QA);           // straight-through end: slides along the line
  const b2 = corner(B, [150, 190]);   // corner end: follows Q's other edge
  const loop = [P[0], A, a2, b2, B, P[3]];
  panels.push(panel(7, "8  add 2 verts, neighbour dir",
    "corner lands on a line Q owns",
    basePolys(true) +
    `<path d="${polyPath(loop)}" fill="${C.band}" fill-opacity="0.18" stroke="${C.band}" stroke-width="1.6"/>` +
    `<line x1="${A[0]}" y1="${A[1]}" x2="${QA[0]}" y2="${QA[1]}" stroke="${C.near}" stroke-width="0.9" stroke-dasharray="2 2"/>` +
    `<line x1="${B[0]}" y1="${B[1]}" x2="150" y2="190" stroke="${C.near}" stroke-width="0.9" stroke-dasharray="2 2"/>` +
    mark(a2, C.good) + mark(b2, C.good)));
}
{
  // 8b: two shared edges meeting at an interior vertex, mitred
  const M = [108, 150], Bx = [126, 246];
  const P2 = [[18, 26], A, M, Bx, [22, 250]];
  const sel2 = [0, 1, 1, 0, 0];
  const e = expandLoop(P2, sel2, Wb / 2);
  const loop = [P2[0], A, e[1], e[2], e[3], Bx, P2[4]];
  panels.push(panel(8, '8b  + mitre at run interiors',
    'no notch back to the shared vertex',
    `<path d="${polyPath(P2)}" fill="${C.far}" fill-opacity="0.10" stroke="${C.far}" stroke-width="1" stroke-dasharray="3 2"/>` +
    `<path d="${polyPath(loop)}" fill="${C.band}" fill-opacity="0.18" stroke="${C.band}" stroke-width="1.6"/>` +
    mark(e[1], C.good) + mark(e[2], C.good, 4.2) + mark(e[3], C.good) +
    `<text x="${e[2][0] + 6}" y="${e[2][1] + 4}" font-family="monospace" font-size="10" fill="${C.good}">mitre</text>` +
    `<circle cx="${M[0]}" cy="${M[1]}" r="2.6" fill="${C.ink}"/>`));
}

const F1W = COLS * PANEL_W + (COLS - 1) * PAD;
const F1H = 3 * (PANEL_H + LABEL_H) + 2 * PAD;
const fig1 = `<svg xmlns="http://www.w3.org/2000/svg" width="${F1W}" height="${F1H}" viewBox="0 0 ${F1W} ${F1H}">
<defs><marker id="ah" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
<path d="M0,0 L7,3.5 L0,7 z" fill="${C.bad}"/></marker></defs>
<rect width="${F1W}" height="${F1H}" fill="${C.bg}"/>
${panels.join('\n')}
</svg>`;
writeFileSync(join(ASSETS, 'seam-options.svg'), fig1);
console.log('wrote assets/seam-options.svg  (' + fig1.length + ' bytes)');
