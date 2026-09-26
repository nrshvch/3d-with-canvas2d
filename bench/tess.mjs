// node bench/tess.mjs            -- what each path shape costs the tessellator
// ---------------------------------------------------------------------------
// Same faces, same colours, same batch assignment -- only the way they are cut
// into fill() calls and subpaths varies.  For each, on S1-S3:
//
//   fills, path verts        what the page issues (A4, the record-stage model)
//   WGR verts / MB           what Firefox's ACCELERATED backend uploads per
//                            frame: bench/wgr.mjs runs Firefox 156's own
//                            tessellator over every fill (A9)
//   uniq x buf               the same, counting only fills whose path-cache
//                            key is new this frame -- what the buffer really
//                            holds (T68); equal to x buf when no shape repeats
//   scans / traps            its slow and fast outputs: per-scanline complex
//                            scans against simple trapezoids
//   loops convex / crossing  per emitted subpath
//   Skia tier                which of SkScan_AAAPath's three CPU paths the fill
//                            takes (mask / convex / general) -- the software
//                            rasteriser of Chromium and of demoted Firefox
//   maxVerbs                 the largest single path (fill or stroke) in WGR
//                            path types -- what gpu-path-complexity caps
//   A8 ms                    the strategy's own JS -- batching, boundary and
//                            band construction -- against an inert context,
//                            min of 8 (8.1).  tesspage's A3 includes this.
//
// Counts only, no browser, deterministic.  The timing side is
// bench/tesspage.html.
// ---------------------------------------------------------------------------
import { readFileSync } from 'fs';
import { createContext, runInContext } from 'vm';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PainterBatcher } from '../src/painter2d.js';
import { WgrContext, pathBufferVerts, bufferVerts, uniqBufferVerts } from './wgr.mjs';
import { Census, STRATS, BAND_W, makeX, runStrategy } from './pathshape.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sb = { performance: { now: () => Number(process.hrtime.bigint()) / 1e6 }, console, Math, Date };
createContext(sb);
for (const f of ['mesh.js', 'scene.js'])
  runInContext(readFileSync(join(__dirname, f), 'utf8'), sb, { filename: f });
const { makeTorusKnot, makeSphere, makeGrid, Scene } = sb;

const W = 1280, H = 720, ANG = [0.4, 0.9, 0.13, 3.1, 620];
export const CASES = [
  ['S1 torusKnot', () => makeTorusKnot(512, 64, 3, 7, 8), 24, 8],
  ['S2 sphere', () => makeSphere(256, 128, 4), 24, 4],
  ['S3 grid', () => makeGrid(180, 4), 24, 4]
];

export function setup(mk, sh, bd, scale = 620) {
  const mesh = mk();
  const scene = new Scene(mesh, W, H, sh, bd);
  scene.build(ANG[0], ANG[1], ANG[2], ANG[3], scale);
  const s = { order: scene.order, nVis: scene.nVis, colour: scene.col, sx: scene.sx, sy: scene.sy,
              bx0: scene.bx0, by0: scene.by0, bx1: scene.bx1, by1: scene.by1 };
  return makeX(PainterBatcher, mesh, scene, s, W, H);
}

// A8's inert context: every canvas call is a no-op, so the timer holds only
// the strategy's own JS (8.1).
const noop = () => {};
const INERT = { beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, fill: noop, stroke: noop,
  fillRect: noop, set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, get lineWidth() { return 1; } };

const isMain = import.meta.url === 'file://' + process.argv[1];
if (isMain) {
  const budget = pathBufferVerts(4);
  const rp = (v, n) => String(v).padStart(n), pd = (v, n) => String(v).padEnd(n);
  console.log('Tessellator cost of the same frame, cut into paths ' + STRATS.length + ' ways.  Counts, no browser.');
  console.log(`WGR = Firefox 156 wpf-gpu-raster (bench/wgr.mjs). Buffer at default gpu-path-size 4 MB = ${budget} output verts.`);
  console.log(`Skia tier from SkScan_AAAPath.cpp: mask (bbox <= 32 px wide, <= 1024 px2), convex (1 convex contour), general.\n`);
  for (const [nm, mk, sh, bd] of CASES) {
    const X = setup(mk, sh, bd);
    console.log(`${nm}: ${X.s.nVis} visible triangles, tile ${X.B.tile} px, band w = ${BAND_W} px`);
    console.log(pd('strategy', 20) + rp('fills', 7) + rp('pathV', 8) + rp('buf verts', 11) + rp('MB', 7) +
      rp('x buf', 6) + rp('uniq', 6) + rp('scans', 8) + rp('traps', 8) + rp('scanFills', 10) + rp('maxFillMB', 10) +
      rp('loops', 7) + rp('convex', 7) + rp('crossL', 7) + rp('cross', 7) +
      rp('mask', 6) + rp('cvx', 6) + rp('gen', 6) + rp('A8 ms', 8) + rp('maxVerbs', 9));
    for (const [st] of STRATS) {
      const ctx = new WgrContext(1 << 23, W, H);
      const C = new Census(); C.hookInto(X.E);
      // WgrContext and Census both need the fills; tee them
      const tee = {
        beginPath: () => ctx.beginPath(), moveTo: (x, y) => ctx.moveTo(x, y), lineTo: (x, y) => ctx.lineTo(x, y),
        fill: () => ctx.fill(), stroke: () => ctx.stroke(),
        set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, get lineWidth() { return 1; }
      };
      runStrategy(st, X, tee);
      X.E.onLoop = null; X.E.onFill = null;
      const fills = X.E.fills, verts = X.E.verts;
      let a8 = Infinity;
      for (let r = 0; r < 8; r++) { const t0 = performance.now(); runStrategy(st, X, INERT); a8 = Math.min(a8, performance.now() - t0); }
      const bv = bufferVerts(ctx);
      console.log(pd(st, 20) + rp(fills, 7) + rp(verts, 8) + rp(bv, 11) +
        rp((bv * 12 / 1048576).toFixed(2), 7) + rp((bv / budget).toFixed(2), 6) + rp((uniqBufferVerts(ctx) / budget).toFixed(2), 6) +
        rp(ctx.scans, 8) + rp(ctx.traps, 8) + rp(ctx.scanFills, 10) +
        rp((ctx.maxVerts * 12 / 1048576).toFixed(3), 10) +
        rp(C.loops, 7) + rp(C.convexLoops, 7) + rp(C.crossLoops, 7) + rp(C.crossings, 7) +
        rp(C.tierMask, 6) + rp(C.tierConvex, 6) + rp(C.tierGeneral, 6) + rp(a8.toFixed(2), 8) + rp(ctx.maxVerbs, 9) +
        (ctx.strokes ? `   incl. ${ctx.strokes} strokes = ${ctx.strokeVerts} aa-stroke verts` : ''));
    }
    console.log('');
  }
}
