// node bench/prepdiagrams.mjs
// ---------------------------------------------------------------------------
// Writes the figures for 4.11 into assets/.
//
//   assets/prep-predicate.svg    the two predicates on the same content:
//                                a coverage claim, which finds nothing, and a
//                                foreign-class presence test, which does
//   assets/prep-contiguity.svg   the cancellation law -- the cost of a drop is
//                                the perimeter of the dropped set
//   assets/prep-backdrop.svg     the clear-colour reassignment, and the void
//                                identity that makes the drop exact
//
// The tile states in figure 1 and the emitted boundaries in figure 2 are
// COMPUTED here by running the actual predicates over the synthetic content,
// not drawn by hand -- same discipline as optdiagrams.mjs.  The content itself
// is synthetic and chosen so one picture holds every case.
// ---------------------------------------------------------------------------
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, '..', 'assets');
mkdirSync(ASSETS, { recursive: true });

const C = {
  bg: '#f7f7fa', ink: '#1c1c22', dim: '#8a8a96', panel: '#fff', grid: '#dcdce4',
  a: '#4f81bd', aFill: 'rgba(79,129,189,0.18)',      // the dominant class c*
  b: '#f0a030', bFill: 'rgba(240,160,48,0.40)',      // a foreign class
  bad: '#d02020', good: '#2e8b3d', drop: '#b9b9c4'
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const T = (x, y, s, o = {}) =>
  `<text x="${x}" y="${y}" font-family="${o.mono ? 'monospace' : 'sans-serif'}" ` +
  `font-size="${o.size || 11}" fill="${o.fill || C.ink}"` +
  `${o.anchor ? ` text-anchor="${o.anchor}"` : ''}` +
  `${o.weight ? ` font-weight="${o.weight}"` : ''}>${esc(s)}</text>`;
const poly = (pts, fill, stroke, sw = 1, dash) =>
  `<path d="M ${pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L ')} Z" ` +
  `fill="${fill}" stroke="${stroke}" stroke-width="${sw}"` +
  `${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;

// ===========================================================================
// shared synthetic content: a densely tessellated sheet (the terrain), one
// prop mesh standing on it, and a wedge of a second class in one corner.
// Every triangle is SMALLER than a tile -- that is the whole point.
// ===========================================================================
const PW = 372, PH = 250;               // panel size
const TS = 62;                          // tile size, so 6 x 4 tiles
const TX = Math.ceil(PW / TS), TY = Math.ceil(PH / TS);
const NX = 12, NY = 8;                  // sheet resolution: 192 triangles

function buildContent() {
  const tris = [];
  const dx = PW / NX, dy = PH / NY;
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const x = i * dx, y = j * dy;
    const jit = ((i * 7 + j * 13) % 5 - 2) * 1.1;   // deterministic wobble
    const a = [x, y + jit], b = [x + dx, y], c = [x + dx, y + dy], d = [x, y + dy];
    tris.push({ p: [a, b, c], src: 'sheet' });
    tris.push({ p: [a, c, d], src: 'sheet' });
  }
  // the prop: a fan, sitting in the middle-left, same class as the sheet
  const cx = 132, cy = 118, R = 34;
  for (let k = 0; k < 9; k++) {
    const t0 = (k / 9) * Math.PI * 2, t1 = ((k + 1) / 9) * Math.PI * 2;
    tris.push({
      p: [[cx, cy - 6], [cx + R * Math.cos(t0), cy + R * 0.8 * Math.sin(t0)],
          [cx + R * Math.cos(t1), cy + R * 0.8 * Math.sin(t1)]], src: 'prop'
    });
  }
  // class: the foreign class occupies a corner wedge
  for (const t of tris) {
    const mx = (t.p[0][0] + t.p[1][0] + t.p[2][0]) / 3;
    const my = (t.p[0][1] + t.p[1][1] + t.p[2][1]) / 3;
    t.cls = (mx + my > PW + PH - 190) ? 1 : 0;       // 1 = foreign, 0 = c*
    t.bb = [Math.min(...t.p.map(q => q[0])), Math.min(...t.p.map(q => q[1])),
            Math.max(...t.p.map(q => q[0])), Math.max(...t.p.map(q => q[1]))];
  }
  return tris;
}
const CONTENT = buildContent();

// --- predicate A: a coverage claim.  A tile is claimed only when some single
// triangle's INTERIOR covers it (4.2).  Nothing here is that big.
function coverageClaim(tris) {
  const claimed = new Uint8Array(TX * TY);
  const inside = (t, px, py) => {
    const [a, b, c] = t.p;
    const s = Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) || 1;
    return s * ((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0])) >= 0 &&
           s * ((c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0])) >= 0 &&
           s * ((a[0] - c[0]) * (py - c[1]) - (a[1] - c[1]) * (px - c[0])) >= 0;
  };
  for (const t of tris) for (let j = 0; j < TY; j++) for (let i = 0; i < TX; i++) {
    if (claimed[j * TX + i]) continue;
    let all = true;
    for (let q = 0; q < 4 && all; q++)
      if (!inside(t, i * TS + (q & 1) * TS, j * TS + (q >> 1) * TS)) all = false;
    if (all) claimed[j * TX + i] = 1;
  }
  return claimed;
}
// --- predicate B: foreign-class presence.  -1 empty, c uniform, -2 mixed.
function presence(tris) {
  const g = new Int32Array(TX * TY).fill(-1);
  for (const t of tris) {
    const i0 = Math.max(0, Math.floor(t.bb[0] / TS)), i1 = Math.min(TX - 1, Math.floor(t.bb[2] / TS));
    const j0 = Math.max(0, Math.floor(t.bb[1] / TS)), j1 = Math.min(TY - 1, Math.floor(t.bb[3] / TS));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const p = j * TX + i;
      if (g[p] === -1) g[p] = t.cls; else if (g[p] !== t.cls) g[p] = -2;
    }
  }
  return g;
}
function dropsUnder(tris, g, cStar) {
  return tris.map(t => {
    if (t.cls !== cStar) return false;
    const i0 = Math.max(0, Math.floor(t.bb[0] / TS)), i1 = Math.min(TX - 1, Math.floor(t.bb[2] / TS));
    const j0 = Math.max(0, Math.floor(t.bb[1] / TS)), j1 = Math.min(TY - 1, Math.floor(t.bb[3] / TS));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++)
      if (g[j * TX + i] !== cStar) return false;
    return true;
  });
}

// ===========================================================================
// figure 1: the two predicates
// ===========================================================================
function figPredicate() {
  const claimed = coverageClaim(CONTENT);
  const g = presence(CONTENT);
  const drops = dropsUnder(CONTENT, g, 0);
  const nDropA = 0;                                  // nothing is ever claimed
  const nDropB = drops.filter(Boolean).length;
  const nC = CONTENT.filter(t => t.cls === 0).length;

  const W = 2 * PW + 3 * 16, HEAD = 46, FOOT = 74, H = HEAD + PH + FOOT;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="${C.bg}"/>`];
  out.push(T(16, 20, 'The same content, two predicates. Every triangle is smaller than a tile.',
    { size: 12, weight: 'bold' }));
  out.push(T(16, 36, 'Dense sheet + one prop, all class c* (blue); a foreign class in the corner (orange).',
    { size: 11, fill: C.dim }));

  const panels = [
    { x: 16, title: 'coverage claim: "is this tile covered yet?"',
      sub: 'claimed = some ONE triangle interior covers the tile (4.2)' },
    { x: 16 * 2 + PW, title: 'presence: "is a foreign class present here?"',
      sub: 'tile = -1 empty | c uniform | -2 mixed, from BBOXES' }
  ];
  panels.forEach((pn, k) => {
    out.push(`<g transform="translate(${pn.x},${HEAD})">`);
    out.push(`<clipPath id="cpp${k}"><rect x="0" y="0" width="${PW}" height="${PH}"/></clipPath>`);
    out.push(`<rect x="0" y="0" width="${PW}" height="${PH}" fill="${C.panel}" stroke="${C.grid}"/>`);
    out.push(`<g clip-path="url(#cpp${k})">`);
    // tile shading
    for (let j = 0; j < TY; j++) for (let i = 0; i < TX; i++) {
      const p = j * TX + i;
      let fill = 'none', lbl = '', lc = C.dim;
      if (k === 0) { fill = claimed[p] ? 'rgba(46,139,61,0.16)' : 'none'; lbl = claimed[p] ? 'claimed' : ''; }
      else if (g[p] === 0) { fill = 'rgba(46,139,61,0.16)'; lbl = 'c*'; lc = C.good; }
      else if (g[p] === -2) { fill = 'rgba(208,32,32,0.10)'; lbl = 'mixed'; lc = C.bad; }
      else if (g[p] === 1) { fill = 'rgba(240,160,48,0.20)'; lbl = 'foreign'; lc = C.b; }
      if (fill !== 'none')
        out.push(`<rect x="${i * TS}" y="${j * TS}" width="${TS}" height="${TS}" fill="${fill}"/>`);
      if (lbl) out.push(T(i * TS + 4, j * TS + 11, lbl, { size: 8, fill: lc, mono: true }));
    }
    // triangles
    CONTENT.forEach((t, ti) => {
      const dropped = k === 1 && drops[ti];
      const col = t.cls === 1 ? C.b : C.a;
      const fl = dropped ? 'none' : (t.cls === 1 ? C.bFill : C.aFill);
      const wide = t.src === 'prop';
      out.push(poly(t.p, fl, dropped ? C.drop : col,
        dropped ? 0.6 : (wide ? 1.5 : 0.8), dropped ? '2 2' : null));
    });
    // tile lines on top
    for (let i = 1; i < TX; i++)
      out.push(`<line x1="${i * TS}" y1="0" x2="${i * TS}" y2="${PH}" stroke="${C.ink}" stroke-width="0.7" stroke-opacity="0.5"/>`);
    for (let j = 1; j < TY; j++)
      out.push(`<line x1="0" y1="${j * TS}" x2="${PW}" y2="${j * TS}" stroke="${C.ink}" stroke-width="0.7" stroke-opacity="0.5"/>`);
    if (k === 0) {
      out.push(`<rect x="${PW / 2 - 118}" y="${PH - 44}" width="236" height="30" fill="#fff" fill-opacity="0.92" stroke="${C.bad}"/>`);
      out.push(T(PW / 2, PH - 24, 'no tile is ever claimed', { size: 13, anchor: 'middle', fill: C.bad, weight: 'bold' }));
    }
    out.push(T(132, 90, 'prop', { size: 9, anchor: 'middle', fill: C.ink, mono: true }));
    out.push('</g>');
    out.push(T(0, PH + 18, pn.title, { size: 11, weight: 'bold' }));
    out.push(T(0, PH + 33, pn.sub, { size: 10, fill: C.dim }));
    const n = k === 0 ? nDropA : nDropB;
    out.push(T(0, PH + 52, (k === 0 ? 'drops ' : 'drops ') + n + ' of ' + nC + ' class-c* faces',
      { size: 11, weight: 'bold', fill: n ? C.good : C.bad, mono: true }));
    out.push(T(0, PH + 66, k === 0
      ? 'no triangle covers a tile interior, so nothing ever claims'
      : 'dashed = dropped; the backdrop is c*, so the pixels are unchanged',
      { size: 10, fill: C.dim }));
    out.push('</g>');
  });
  out.push('</svg>');
  return out.join('\n');
}

// ===========================================================================
// figure 2: the cancellation law
// ===========================================================================
// One batch: a 7x5 grid of quads, welded, all one colour.  Edge cancellation
// emits only the edges NOT shared inside the batch, so the emitted boundary is
// the outline of the KEPT set -- and every hole in it has to be gone round.
function figContiguity() {
  const GX = 7, GY = 5, CW = 30, CH = 30, OX = 12, OY = 26;
  const cells = [];
  for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) cells.push({ i, j });
  // three drop sets over the same cells
  // Two drop sets of the SAME SIZE (8 quads = 16 faces), one contiguous and one
  // with no two members adjacent.  Same faces removed, different perimeter --
  // which is the entire content of the law.
  const none = () => false;
  const block = ({ i, j }) => i >= 1 && i <= 4 && j >= 1 && j <= 2;
  const scatter = ({ i, j }) => i >= 1 && i <= 5 && j >= 1 && j <= 3 && (i + j) % 2 === 0;

  // emitted boundary = edges of kept cells whose neighbour is not kept.
  // Counted in EDGE UNITS, which is what the vertex count tracks.
  function boundary(keep) {
    const isKeep = (i, j) => i >= 0 && i < GX && j >= 0 && j < GY && keep[j * GX + i];
    const segs = [];
    for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
      if (!isKeep(i, j)) continue;
      const x = OX + i * CW, y = OY + j * CH;
      if (!isKeep(i, j - 1)) segs.push([x, y, x + CW, y]);
      if (!isKeep(i, j + 1)) segs.push([x, y + CH, x + CW, y + CH]);
      if (!isKeep(i - 1, j)) segs.push([x, y, x, y + CH]);
      if (!isKeep(i + 1, j)) segs.push([x + CW, y, x + CW, y + CH]);
    }
    return segs;
  }
  const variants = [
    { name: 'drop nothing', pred: none, note: 'boundary = the outline, once' },
    { name: 'drop 8 quads, contiguous', pred: block, note: 'boundary = outline + ONE hole' },
    { name: 'drop 8 quads, none adjacent', pred: scatter, note: 'boundary = outline + a hole EACH' }
  ];
  const PWc = OX * 2 + GX * CW, PHc = OY + GY * CH + 60;
  const W = variants.length * PWc + (variants.length + 1) * 12, HEAD = 44;
  const H = HEAD + PHc + 30;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="${C.bg}"/>`];
  out.push(T(12, 20, 'The cancellation law: a drop costs the PERIMETER of the dropped set.',
    { size: 12, weight: 'bold' }));
  out.push(T(12, 36, 'One batch, one colour, welded. Edge cancellation emits only the edges not shared inside it (4.3).',
    { size: 11, fill: C.dim }));

  variants.forEach((v, k) => {
    const keep = new Uint8Array(GX * GY);
    cells.forEach((c, q) => { keep[q] = v.pred(c, q) ? 0 : 1; });
    const segs = boundary(keep);
    out.push(`<g transform="translate(${12 + k * (PWc + 12)},${HEAD})">`);
    out.push(`<rect x="0" y="0" width="${PWc}" height="${PHc}" fill="${C.panel}" stroke="${C.grid}"/>`);
    cells.forEach((c, q) => {
      const x = OX + c.i * CW, y = OY + c.j * CH;
      out.push(`<rect x="${x}" y="${y}" width="${CW}" height="${CH}" fill="${keep[q] ? C.aFill : 'none'}" stroke="${keep[q] ? C.a : C.drop}" stroke-width="0.7"${keep[q] ? '' : ' stroke-dasharray="2 2"'}/>`);
      out.push(`<line x1="${x}" y1="${y}" x2="${x + CW}" y2="${y + CH}" stroke="${keep[q] ? C.a : C.drop}" stroke-width="0.5" stroke-opacity="0.7"${keep[q] ? '' : ' stroke-dasharray="2 2"'}/>`);
    });
    for (const g of segs)
      out.push(`<line x1="${g[0]}" y1="${g[1]}" x2="${g[2]}" y2="${g[3]}" stroke="${C.bad}" stroke-width="2.4"/>`);
    out.push(T(OX, 18, v.name, { size: 11, weight: 'bold' }));
    out.push(T(OX, OY + GY * CH + 20, 'emitted boundary: ' + segs.length + ' edge units',
      { size: 11, mono: true, weight: 'bold', fill: segs.length > 40 ? C.bad : (segs.length > 24 ? C.b : C.good) }));
    out.push(T(OX, OY + GY * CH + 35, v.note, { size: 10, fill: C.dim }));
    out.push(T(OX, OY + GY * CH + 50, 'faces drawn: ' + keep.reduce((a, b) => a + b, 0) * 2 + ' of 70',
      { size: 10, fill: C.dim, mono: true }));
    out.push('</g>');
  });
  out.push(T(12, H - 10,
    'Measured at batcher scale (T54): the same droppable set, half of it dropped, cost 1.68x-4.28x the vertices of dropping NONE.',
    { size: 10.5, fill: C.bad }));
  out.push('</svg>');
  return out.join('\n');
}

// ===========================================================================
// figure 3: the backdrop reassignment, and why the void still comes out right
// ===========================================================================
function figBackdrop() {
  const rows = [
    { id: 'F', what: 'fill / albedo', ref: 'fog colour', pre: 'fog colour', chg: false },
    { id: 'S', what: 'shade', ref: 'white  (=1)', pre: 'white  (=1)', chg: false },
    { id: 'K', what: 'fog keep  (1-d)', ref: 'BLACK  (d=1)', pre: 'WHITE  (d=0)', chg: true },
    { id: 'A', what: 'fog add  (fog*d)', ref: 'fog colour', pre: 'BLACK  (0)', chg: true }
  ];
  const W = 778, H = 332, CX = 34, RH = 30, TOP = 96;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="${C.bg}"/>`];
  out.push(T(CX - 18, 22, 'What has to change to make the dominant class the backdrop, and why the void survives it.',
    { size: 12, weight: 'bold' }));
  out.push(T(CX - 18, 40, 'out  =  F · S · K  +  A', { size: 13, mono: true, weight: 'bold' }));
  out.push(T(CX - 18, 58, 'T42 clears the fog buffers only, because K = black over void multiplies the stale fill and shade canvases by zero.',
    { size: 10.5, fill: C.dim }));
  out.push(T(CX - 18, 73, 'Setting K = white to make band 0 the backdrop ends that, so F and S must now actually be cleared: +2 full-canvas fillRects.',
    { size: 10.5, fill: C.dim }));

  const colX = [CX, CX + 150, CX + 330, CX + 510];
  out.push(T(colX[0], TOP - 10, 'buffer', { size: 10, weight: 'bold', fill: C.dim }));
  out.push(T(colX[1], TOP - 10, 'what it holds', { size: 10, weight: 'bold', fill: C.dim }));
  out.push(T(colX[2], TOP - 10, 'reference background', { size: 10, weight: 'bold', fill: C.dim }));
  out.push(T(colX[3], TOP - 10, 'prepped background', { size: 10, weight: 'bold', fill: C.dim }));
  rows.forEach((r, k) => {
    const y = TOP + k * RH;
    out.push(`<rect x="${CX - 18}" y="${y - 14}" width="${W - 2 * (CX - 18)}" height="${RH - 4}" fill="${k % 2 ? 'rgba(0,0,0,0.02)' : 'none'}"/>`);
    out.push(T(colX[0], y + 4, r.id, { size: 13, mono: true, weight: 'bold', fill: r.chg ? C.bad : C.ink }));
    out.push(T(colX[1], y + 4, r.what, { size: 11, mono: true }));
    out.push(T(colX[2], y + 4, r.ref, { size: 11, mono: true, fill: C.dim }));
    out.push(T(colX[3], y + 4, r.pre, { size: 11, mono: true, fill: r.chg ? C.bad : C.dim, weight: r.chg ? 'bold' : null }));
  });

  const vy = TOP + rows.length * RH + 22;
  out.push(T(CX - 18, vy, 'The void, evaluated in both arrangements:', { size: 11, weight: 'bold' }));
  out.push(T(CX - 18, vy + 20,
    'reference   out = fog · 1 · 0      + fog   =  fog colour', { size: 11.5, mono: true }));
  out.push(T(CX - 18, vy + 38,
    'prepped     out = fog · 1 · 1      + 0     =  fog colour', { size: 11.5, mono: true }));
  out.push(T(CX + 430, vy + 29, 'identical, and it is why the drop is exact', { size: 11, fill: C.good, weight: 'bold' }));
  out.push(T(CX - 18, vy + 60,
    'Verified against a 2x supersampled reference: composite cdiff 0 of 3 686 400 samples on every scene (T56). The band MAP does differ',
    { size: 10.5, fill: C.dim }));
  out.push(T(CX - 18, vy + 74,
    'over void - exactly the uncovered fraction of the screen - because the fill canvas’s own fog-colour background resolves it.',
    { size: 10.5, fill: C.dim }));
  out.push('</svg>');
  return out.join('\n');
}

writeFileSync(join(ASSETS, 'prep-predicate.svg'), figPredicate());
writeFileSync(join(ASSETS, 'prep-contiguity.svg'), figContiguity());
writeFileSync(join(ASSETS, 'prep-backdrop.svg'), figBackdrop());
console.log('wrote assets/prep-predicate.svg, assets/prep-contiguity.svg, assets/prep-backdrop.svg');
