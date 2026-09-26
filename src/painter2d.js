// ---------------------------------------------------------------------------
// painter2d.js
//
// Depth-sorted triangle soup -> the fewest possible canvas2d fill() calls,
// without changing what the frame looks like.
//
// Four ideas, the first three in order of payoff:
//
//   1. REORDER UNDER AN OCCUPANCY GRID.  Two triangles only have to keep their
//      painter order if their interiors actually overlap on screen.  Walking
//      the depth-sorted list and stamping each triangle's covered tiles with
//      the ordinal of the batch that drew it turns "may I move this triangle
//      back to an earlier same-colour batch?" into one integer comparison.
//
//   2. EDGE CANCELLATION.  Triangles that land in the same batch and share a
//      mesh edge contribute that edge twice, in opposite directions.  Drop
//      both.  What survives is the boundary of the merged region: fewer
//      vertices for the rasteriser, and the antialiasing seam between the two
//      triangles disappears (which is a fidelity *gain* -- see the guide).
//
//   3. COLLINEAR CANCELLATION.  Tessellated surfaces produce long straight
//      boundary runs; drop the interior vertices of each run.
//
//   4. SEAM REPAIR IN THE PATH (seamBand).  A seam between two batches still
//      conflates.  Instead of stroking it (a second path per batch), the batch
//      drawn FIRST steps its own boundary out by w along every edge it shares
//      with a batch drawn later, and back -- 4.8's in-line band at batcher
//      scale (4.12).  Where two band edges meet at a reflex corner of at most
//      90 degrees the two offset segments cross; they are mitred to their
//      crossing, which is exact (sampled: 0 of 41M points change side) and
//      removes the self-crossing a tessellator would otherwise have to
//      resolve.  Sharper reflex corners keep the crossing, because there the
//      mitre would cut a hole.  A run's free ends go on the neighbour's own
//      edge, where option 7's corner would poke past the silhouette.  Why a
//      band and not a stroke: it closes the seam where a 0.5 px stroke leaves
//      a third of it, and on Firefox's accelerated backend the stroke is a
//      second tessellation into the same 4 MB buffer (0.6-4.4x the fills').
//      On by default since guide v1.30: measured on a hardware GPU (Chromium's
//      Skia Graphite on Apple M4, 4.12, T69) the band costs the canvas
//      0.80-0.81x the seam stroke it replaces, where a model fitted to Ganesh
//      had predicted it might cost more (see seamBand).
//
// Everything is a preallocated typed array.  The per-frame path allocates
// nothing, builds no strings, and calls no closures.
//
// See README.md for the measurements and for
// why several "obvious" optimisations are traps (closePath() is quadratic in
// Blink; batching without edge cancellation makes software rasterisation
// slower; Firefox stops accelerating a canvas that draws novel paths).
// ---------------------------------------------------------------------------
'use strict';

// ===========================================================================
// init-time helpers
// ===========================================================================

/**
 * Edge adjacency for an indexed mesh.  adj[3*t+e] is the triangle sharing
 * edge e of triangle t (edge e runs idx[3t+e] -> idx[3t+(e+1)%3]), or -1.
 * Build this ONCE; it only depends on topology, not on the transform.
 */
export function buildAdjacency(indices, vertexCount) {
  const nt = indices.length / 3;
  const adj = new Int32Array(nt * 3).fill(-1);
  const map = new Map();
  for (let t = 0; t < nt; t++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[3 * t + e], b = indices[3 * t + (e + 1) % 3];
      const key = a < b ? a * vertexCount + b : b * vertexCount + a;
      const prev = map.get(key);
      if (prev === undefined) { map.set(key, t * 3 + e); continue; }
      const pt = (prev / 3) | 0, pe = prev % 3;
      adj[3 * t + e] = pt;
      adj[3 * pt + pe] = t;
      map.delete(key);              // non-manifold edges stay unpaired
    }
  }
  return adj;
}

/**
 * Turn an un-indexed triangle soup into an indexed mesh by welding vertices
 * that coincide within `eps`.
 *
 * Do this.  A 3D engine's geometry is nearly always a watertight mesh that
 * merely arrives without shared indices, and edge cancellation cannot see the
 * shared edges until they share vertex ids.  Measured on an unindexed torus
 * knot: welding at load takes the emitted vertex count from 142 668 to 55 300
 * and restores full cancellation, matching a natively indexed mesh exactly.
 * Without it you still get the batching win (835 stroke calls instead of
 * 35 851) but none of the vertex reduction.
 * Returns {positions, indices, vertexCount}.  Init-time only.
 */
export function weldSoup(xyz, eps) {
  const n = xyz.length / 3, inv = 1 / (eps || 1e-4);
  const map = new Map();
  const indices = new Uint32Array(n);
  const px = new Float32Array(n), py = new Float32Array(n), pz = new Float32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
    const key = Math.round(x * inv) + ',' + Math.round(y * inv) + ',' + Math.round(z * inv);
    let v = map.get(key);
    if (v === undefined) { v = m++; map.set(key, v); px[v] = x; py[v] = y; pz[v] = z; }
    indices[i] = v;
  }
  return { px: px.subarray(0, m), py: py.subarray(0, m), pz: pz.subarray(0, m), indices, vertexCount: m };
}

/**
 * Optional, and strictly dominated by the occupancy grid on every scene
 * measured -- provided because it is far simpler and has the lowest recording
 * cost of any batching option, which matters if you are main-thread bound.
 *
 * Splits the depth-sorted list into `bands` equal-count bands and colour-sorts
 * within each band (stable, so depth order survives within one colour).  Plain
 * run-length batching then finds long runs.  One counting-sort pass.
 *
 * This is an APPROXIMATION: reordering inside a band can violate the painter
 * order for triangles that overlap within it.  `bands` is the quality knob --
 * more bands, less error, less batching.  Mutates s.order in place.  Call it
 * before draw(); allocates on first use only, so keep the returned scratch.
 */
export function reorderByDepthBands(s, bands, scratch) {
  const n = s.nVis;
  if (n === 0) return scratch;
  const nb = bands * 256;
  if (!scratch || scratch.count.length < nb || scratch.tmp.length < n) {
    scratch = { count: new Uint32Array(nb), tmp: new Int32Array(n), key: new Uint32Array(n) };
  }
  const cnt = scratch.count, tmp = scratch.tmp, key = scratch.key;
  const order = s.order, colour = s.colour, scale = bands / n;
  cnt.fill(0, 0, nb);
  for (let i = 0; i < n; i++) {
    const k = ((i * scale) | 0) * 256 + colour[order[i]];
    key[i] = k; cnt[k]++;
  }
  let acc = 0;
  for (let k = 0; k < nb; k++) { const c = cnt[k]; cnt[k] = acc; acc += c; }
  for (let i = 0; i < n; i++) tmp[cnt[key[i]]++] = order[i];   // stable
  order.set(tmp.subarray(0, n), 0);
  return scratch;
}

// ===========================================================================
// the in-path seam band (seamBand, idea 4)
// ===========================================================================
//
// Loop in (x, y), k points; f[i] is the flag of edge i -> i+1 (2 = band it)
// and q[i] the vertex id of the neighbour's third vertex across that edge
// (-1 if none), looked up in (sx, sy).  Writes the banded loop into (ox, oy)
// and returns its length (<= 3k).
//
// Orientation: the batcher keeps triangles with positive screen-space cross
// product and a boundary loop inherits it, so the region is on the LEFT of
// every edge under (dx, dy) -> (-dy, dx); outward is (dy, -dx) / |d|.
//
// Per band edge a -> b the loop becomes  a, a + n*w, b + n*w, b  (4.8's
// option 7; a and b do not move).  Two junction fixes, both EXACT -- they
// change which points the nonzero fill covers nowhere (bench/bandx.mjs
// samples it: 0 of 41 million points on S1-S3):
//   collinear  two band edges on one line leave b' -> b -> b' with b'
//              repeated, a zero-area spike: drop it.
//   reflex     two band edges meeting at a reflex corner that turns by at
//              most 90 degrees: their offset segments cross at H.  Replace
//              (b'ab, b, b'bc) by H.  The path loses the winding of the quad
//              (H, b'ab, b, b'bc), which lies inside BOTH band quads, so every
//              point of it stays covered.  Two conditions make that true and
//              both are tested: the turn is <= 90 degrees (n1.n2 >= 0 -- past
//              it the quad reaches into the polygon and the mitre cuts a
//              hole), and each band reaches the other's corner (an edge
//              shorter than w lets the quad poke past the other band's end).
// Everything else keeps option 7's shape, crossings included: nonzero fills
// the union regardless, and the rest was measured to buy nothing worth its
// inexactness (4.12).  One deliberate exception, and it is not exact: at a
// run's FREE ENDS the corner goes on the neighbour's own edge (freeEnd()
// below), because that is where the band's ink escapes past the silhouette.
//
// `fixes` selects them (default all three): BAND_SPIKE | BAND_MITRE are the
// exact pair, BAND_FREE_ENDS the lossy one.  Measured per frame in
// bench/bandx.mjs, section 4: what each costs in JS and what it removes.
//
// A third exact fix, BAND_CLIP, is the single-band case of the same corner:
// at a REFLEX vertex where a run starts or ends against a non-band edge, and
// the band's end cap crosses that edge, the cap's far part lies inside this
// polygon -- stop the band at the crossing.  Guarded by p[i] (the batch's
// boundary passes through the vertex twice, a PINCH): there the polygon does
// not continue across the edge, and clipping would cut the band's ink.
// bench/bandx.mjs: 0 changed samples on S1-S3 with the guard, 276 without.
//
// BAND_TIGHT is not exact and not default: the same mitre at a reflex turn
// SHARPER than 90 degrees (a tight corner), still with the containment test
// and the pinch guard.  Exact wherever the polygon is at least ~w thick
// behind the corner (bench/bandfigs.mjs panel b); where it is a sliver, the
// band reaches through it, and the mitre removes that spill (panel d) --
// 0 / 0 / 39 changed samples on S1-S3's 16-18 M, for 0.5-2.4 % fewer vertices.
//
// BAND_SKIP_SHORT is not exact and not default: no band on an edge shorter
// than w that meets another band edge at a reflex vertex -- the one junction
// no exact fix can take, because the two bands reach past each other's ends.
// It trades a sub-pixel stretch of seam cover for a simpler path (4.12).
export const BAND_SPIKE = 1, BAND_MITRE = 2, BAND_FREE_ENDS = 4, BAND_CLIP = 8, BAND_SKIP_SHORT = 16, BAND_TIGHT = 32;
export const BAND_EXACT = BAND_SPIKE | BAND_MITRE | BAND_CLIP, BAND_DEFAULT = BAND_EXACT | BAND_FREE_ENDS;
// Does edge i carry a band?  With BAND_SKIP_SHORT, not if it is shorter than
// w and meets another band edge at a reflex vertex.
function isBandEdge(x, y, f, k, i, w, fixes) {
  if (f[i] !== 2) return false;
  if (!(fixes & BAND_SKIP_SHORT)) return true;
  const j = i + 1 === k ? 0 : i + 1, dx = x[j] - x[i], dy = y[j] - y[i];
  if (dx * dx + dy * dy >= w * w) return true;
  const h = i === 0 ? k - 1 : i - 1, n = j + 1 === k ? 0 : j + 1;
  if (f[h] === 2 && (x[i] - x[h]) * dy - (y[i] - y[h]) * dx < 0) return false;
  if (f[j] === 2 && dx * (y[n] - y[j]) - dy * (x[n] - x[j]) < 0) return false;
  return true;
}
// Proper crossing of segments p0-p1 and q0-q1, strictly inside both; writes HX/HY.
let HX = 0, HY = 0;
function segHit(p0x, p0y, p1x, p1y, q0x, q0y, q1x, q1y) {
  const rx = p1x - p0x, ry = p1y - p0y, ux = q1x - q0x, uy = q1y - q0y;
  const den = rx * uy - ry * ux;
  if (den * den < 1e-24) return false;
  const qpx = q0x - p0x, qpy = q0y - p0y;
  const t = (qpx * uy - qpy * ux) / den, u = (qpx * ry - qpy * rx) / den;
  if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return false;
  HX = p0x + t * rx; HY = p0y + t * ry;
  return true;
}
export function bandLoop(x, y, f, q, sx, sy, k, w, ox, oy, fixes = BAND_DEFAULT, p = null) {
  // Start after an edge that is NOT a band: then every junction is reached
  // with its incoming band written, and no run ends at the first vertex.
  let r = -1;
  for (let i = 0; i < k && r < 0; i++) if (!isBandEdge(x, y, f, k, i === 0 ? k - 1 : i - 1, w, fixes)) r = i;
  if (r < 0) r = 0;                                   // one closed run: no free ends
  let m = 0;
  for (let st = 0; st < k; st++) {
    const i = r + st < k ? r + st : r + st - k;
    const j = i + 1 === k ? 0 : i + 1;
    const h = i === 0 ? k - 1 : i - 1;
    const here = isBandEdge(x, y, f, k, i, w, fixes), before = isBandEdge(x, y, f, k, h, w, fixes);
    if (st > 0 && here && before && (fixes & BAND_EXACT)) {
      const d1x = x[i] - x[h], d1y = y[i] - y[h], d2x = x[j] - x[i], d2y = y[j] - y[i];
      const l1 = Math.sqrt(d1x * d1x + d1y * d1y) || 1, l2 = Math.sqrt(d2x * d2x + d2y * d2y) || 1;
      const n1x = d1y / l1 * w, n1y = -d1x / l1 * w, n2x = d2y / l2 * w, n2y = -d2x / l2 * w;
      const e2x = x[i] + n2x, e2y = y[i] + n2y, cx = x[j] + n2x, cy = y[j] + n2y;
      const gx = ox[m - 1] - e2x, gy = oy[m - 1] - e2y;
      if ((fixes & BAND_SPIKE) && gx * gx + gy * gy < 1e-8) {   // collinear: b' repeated
        ox[m] = cx; oy[m] = cy; m++;
        continue;
      }
      if ((fixes & BAND_MITRE) && d1x * d2y - d1y * d2x < 0 &&
          (n1x * n2x + n1y * n2y >= 0 || ((fixes & BAND_TIGHT) && !(p && p[i]))) &&
          (n1x * d2x + n1y * d2y) / l2 <= l2 && -(n2x * d1x + n2y * d1y) / l1 <= l1) {
        // reflex, <= 90 degrees: intersect [a', b'ab] with [b'bc, c']
        const px = ox[m - 2], py = oy[m - 2], rx = ox[m - 1] - px, ry = oy[m - 1] - py;
        const ux = cx - e2x, uy = cy - e2y, den = rx * uy - ry * ux;
        if (den * den > 1e-24) {
          const qx = e2x - px, qy = e2y - py;
          const t = (qx * uy - qy * ux) / den, u = (qx * ry - qy * rx) / den;
          if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) {
            ox[m - 1] = px + t * rx; oy[m - 1] = py + t * ry;
            ox[m] = cx; oy[m] = cy; m++;
            continue;
          }
        }
      }
    }
    // A run starts or ends at a reflex vertex whose other edge its end cap
    // crosses: the far part of the cap is inside the polygon -- clip it.
    if ((fixes & BAND_CLIP) && st > 0 && before !== here && !(p && p[i]) &&
        (x[i] - x[h]) * (y[j] - y[i]) - (y[i] - y[h]) * (x[j] - x[i]) < 0) {
      if (before) {
        if (segHit(ox[m - 2], oy[m - 2], ox[m - 1], oy[m - 1], x[i], y[i], x[j], y[j])) {
          ox[m - 1] = HX; oy[m - 1] = HY;               // replaces the corner; x[i] is skipped
          continue;
        }
      } else {
        const dx = x[j] - x[i], dy = y[j] - y[i], l = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = dy / l * w, ny = -dx / l * w;
        if (segHit(x[i] + nx, y[i] + ny, x[j] + nx, y[j] + ny, x[h], y[h], x[i], y[i])) {
          ox[m] = HX; oy[m] = HY; m++;                    // replaces x[i] and the first corner
          ox[m] = x[j] + nx; oy[m] = y[j] + ny; m++;
          continue;
        }
      }
    }
    // A run ENDS here: move its last corner onto the neighbour's edge i -> q.
    if ((fixes & BAND_FREE_ENDS) && st > 0 && before && !here && q[h] >= 0 && freeEnd(x[i], y[i], x[i] - x[h], y[i] - y[h], sx[q[h]], sy[q[h]], w)) {
      ox[m - 1] = FX; oy[m - 1] = FY;
    }
    ox[m] = x[i]; oy[m] = y[i]; m++;
    if (here) {
      const dx = x[j] - x[i], dy = y[j] - y[i], l = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = dy / l * w, ny = -dx / l * w;
      // A run STARTS here: its first corner goes on the neighbour's edge i -> q.
      if ((fixes & BAND_FREE_ENDS) && !before && q[i] >= 0 && freeEnd(x[i], y[i], dx, dy, sx[q[i]], sy[q[i]], w)) { ox[m] = FX; oy[m] = FY; }
      else { ox[m] = x[i] + nx; oy[m] = y[i] + ny; }
      m++;
      ox[m] = x[j] + nx; oy[m] = y[j] + ny; m++;
    }
  }
  return m;
}

// Free ends (4.12's end8, 4.8's option 8 at run ends).  A band run that
// stops at vertex v, on an edge with direction (dx, dy) and the later
// neighbour's third vertex q, puts its corner on the segment v -> q, at the
// point that is w out from the edge's line -- a line the neighbour itself
// owns, so the corner cannot poke past the neighbour.  Measured at batcher
// scale: 12-37 % less ink outside the silhouette, for a gap that stays
// 26-44x smaller than the stroke's.  Travel stops at q itself (a neighbour
// thinner than w); a neighbour on the wrong side keeps option 7's
// perpendicular.
let FX = 0, FY = 0;
function freeEnd(vx, vy, dx, dy, qx, qy, w) {
  const l = Math.sqrt(dx * dx + dy * dy);
  if (!l) return false;
  const dq = ((qx - vx) * dy - (qy - vy) * dx) / l;   // q's distance outward
  if (!(dq > 1e-6)) return false;
  const t = w / dq < 1 ? w / dq : 1;
  FX = vx + t * (qx - vx); FY = vy + t * (qy - vy);
  return true;
}

// ===========================================================================
// PainterBatcher
// ===========================================================================
//
// Per-frame input (all preallocated by the caller, all indexed by triangle id
// except `order`, which is the depth-sorted list of triangle ids, back first):
//
//   order    Int32Array   visible triangle ids, far -> near
//   nVis     int          how many of `order` are live this frame
//   colour   Uint8Array   palette index per triangle
//   sx, sy   Float32Array projected screen x/y per *vertex*
//   bx0,by0,bx1,by1  Float32Array  screen bbox per triangle
//
// Static input: indices (Uint32Array), adjacency (Int32Array or null),
// palette (array of 256 CSS colour strings, pregenerated).

export const COVERAGE_INTERIOR = 0;  // tile centres covered  (default)
export const COVERAGE_BBOX     = 1;  // every tile the bbox touches (conservative)

export class PainterBatcher {
  /**
   * @param {object} o
   *   width, height          canvas size in CSS px
   *   triangleCount          upper bound on triangles
   *   vertexCount            upper bound on vertices
   *   indices                Uint32Array, 3 per triangle
   *   adjacency              Int32Array from buildAdjacency(), or null
   *   palette                array of CSS colour strings, indexed 0..255
   *   tile                   occupancy grid cell size in px: a power of two,
   *                          or 'auto' (default).  A FIXED tile is the wrong
   *                          answer -- the batcher's quality depends on the
   *                          ratio of triangle size to tile size, not on the
   *                          tile size itself.  Measured on one mesh at six
   *                          projection scales, the best tile tracked the mean
   *                          triangle area every time, and choosing it from
   *                          that area alone also made batching CHEAPER
   *                          (2.4 ms against 16.6 ms for a fixed 1 px grid on
   *                          large triangles).  'auto' does that.
   *   coverage               COVERAGE_INTERIOR | COVERAGE_BBOX
   *   maxVerbsPerFill        split a batch once it reaches this many path
   *                          verbs.  0 = unlimited.  See the guide: Firefox
   *                          only GPU-tessellates paths below
   *                          gfx.canvas.accelerated.gpu-path-complexity
   *                          (4000), and Skia's triangulating renderer gives
   *                          up above 1<<14.
   *   collinearEpsPx         drop a boundary vertex that sits within this many
   *                          px of the straight line through its neighbours.
   *                          0 disables.
   *   strokeSeams            default TRUE, and you almost certainly want to
   *                          leave it that way.  After filling a batch, stroke
   *                          the
   *                          same path in the same colour with lineWidth 1.
   *                          Canvas2D composites the antialiased coverage of
   *                          each fill separately, so a boundary between two
   *                          differently-coloured regions shows a background
   *                          seam; stroking closes it.  This is what
   *                          per-triangle canvas2d renderers do on EVERY
   *                          triangle -- here it is one stroke per batch,
   *                          because edge cancellation already deleted every
   *                          interior edge.  Measured on the torus knot: the
   *                          per-triangle version needs 36 180 strokes, this
   *                          needs 859, at the same measured fidelity.
   *                          Stroking is not optional for a 3D renderer: it is
   *                          the only way canvas2d can close a conflation seam,
   *                          so it is a constraint to optimise under, not a
   *                          cost to switch off.  Set it false ONLY for
   *                          geometry you know shares no edges at all, where
   *                          there is no seam to close and the stroke is pure
   *                          half-pixel bloat.
   *
   *                          IMPORTANT: if `adjacency` is null, nothing cancels
   *                          and every triangle edge is still stroked.  The fix
   *                          is to weld() at load, not to stop stroking --
   *                          measured, welding an unindexed torus knot takes
   *                          the emitted vertex count from 142 668 back to
   *                          55 300, exactly matching the natively indexed
   *                          mesh.
   *   strokeWidth            default 0.5.  The conventional seam stroke uses
   *                          lineWidth 1, which turns out to OVER-correct: an
   *                          opaque 1 px stroke centred on a colour boundary
   *                          spills half a pixel into the neighbouring region,
   *                          shifting the boundary toward whichever side is
   *                          stroked last.  Measured against a supersampled
   *                          reference, 0.5 is markedly closer to truth than
   *                          1.0 at identical cost.
   *   seamStrokeOnly         default TRUE.  The stroke pass then covers
   *                          only the edges that are genuinely seams -- shared
   *                          with another VISIBLE triangle that landed in a
   *                          different batch -- and skips silhouette edges,
   *                          which have no second triangle behind them and so
   *                          no conflation deficit to repair.  A silhouette
   *                          edge composites correctly on its own -- whatever
   *                          is behind it already covers the pixel fully -- so
   *                          stroking it only inflates the object by half a
   *                          pixel all the way round.
   *                          Costs a second path (roughly doubles emitted
   *                          vertices) but measured only +3 to +5 % of frame
   *                          time end to end, for ~20 % lower RMSE against a
   *                          supersampled reference.  Degrades safely: with no
   *                          adjacency there is no way to tell a seam from a
   *                          silhouette, so it falls back to stroking the whole
   *                          boundary rather than stroking nothing.
   *   seamBand               default 1.  Width in px of the in-path seam
   *                          band (idea 4 above; 1 is the measured choice,
   *                          0 turns it off).  When > 0 it REPLACES the seam
   *                          stroke:
   *                          strokeSeams is ignored, one fill() per batch and
   *                          no stroke() at all.  Needs `adjacency` -- without
   *                          it there is no way to know which edges are seams,
   *                          and the batcher falls back to strokeSeams.
   *                          Measured at batcher scale (4.12, T64): it leaves
   *                          0.7-1.4 % of the seam gap a supersampled union
   *                          says is there, where the 0.5 px stroke leaves
   *                          27-36 %; total coverage error (gap + ink past the
   *                          silhouette) 1.6-4x lower; the same software
   *                          raster cost within ~10 %; and it adds 4-13 % to
   *                          Firefox's tessellated output where the stroke
   *                          adds an estimated 60-440 %.  And on a hardware
   *                          GPU (T69: Chromium 153's Skia Graphite, Apple M4,
   *                          S1-S3, sustained A2, 5 runs) the canvas side of
   *                          the frame costs 0.80-0.81x the stroke's; the
   *                          whole frame ties
   *                          within 8 %, the difference being the band's own
   *                          JS.  It was 0 until that was measured, because
   *                          3.1's fitted Ganesh cost per merged-path vertex
   *                          (M1) predicted ~+18 ms on S1; measured, it is
   *                          +0.53 ms over no repair at all.  Ganesh -- the
   *                          backend that fit describes, on M1's discrete GPU
   *                          -- is still unmeasured for the band; and on
   *                          Safari (T72) the band costs the canvas 1.4-1.7x
   *                          the stroke, off the main thread, with the whole
   *                          frame tied.  seamBand: 0 restores the stroke if
   *                          your frame disagrees.
   *   seamBandFixes          default BAND_DEFAULT.  Which of the band's
   *                          junction fixes to apply (bandLoop above).
   *                          BAND_EXACT = BAND_SPIKE | BAND_MITRE | BAND_CLIP:
   *                          exact -- 6-20 % fewer band vertices, 41-46 % fewer
   *                          crossings, the filled region unchanged (0 of 41 M
   *                          sampled points, T63), +0.0-0.7 ms of JS (T73).
   *                          BAND_DEFAULT adds BAND_FREE_ENDS, not exact by
   *                          design: a run's end corners go on the later
   *                          neighbour's own edge, 12-37 % less ink past the
   *                          silhouette for a gap still 26-44x under the
   *                          stroke's (T65).  Optional, both not exact:
   *                          BAND_TIGHT (the mitre past 90 deg: 0.5-2.4 %
   *                          fewer vertices, changes only sliver spill) and
   *                          BAND_SKIP_SHORT (no band on a sub-w edge at a
   *                          reflex junction: S2's gap x3.1 for 3 % fewer
   *                          vertices).  BAND_EXACT alone keeps the band's
   *                          filled region exactly option 7's.
   *   autoFallback           default true.  After batching, cheaply predict
   *                          how much the batcher actually bought this frame;
   *                          if it bought little (unweldable soup, no colour
   *                          coherence, heavy real overlap) emit per-triangle
   *                          instead.  This is what lets one configuration be
   *                          correct on every engine and every mesh without
   *                          the caller writing any checks.
   *   fallbackFillRatio      fall back when fills > this x nVisible (0.25)
   *   fallbackVertRatio      ...AND verts > this x 3 x nVisible (0.85)
   *   localityTile           if non-zero (a power of two, e.g. 256), the
   *                          triangle's macro-tile joins the batch key, so a
   *                          batch never spans the whole screen.  Costs more
   *                          fills; buys a smaller bbox per path, which the
   *                          scanline rasteriser cares about (measured 2.1x on
   *                          clustered vs scattered subpaths at identical fill
   *                          and vertex counts).  Only worth it when you are
   *                          rasterising on the CPU.
   */
  constructor(o) {
    const nt = o.triangleCount, nv = o.vertexCount;
    this.W = o.width; this.H = o.height;
    this.indices = o.indices;
    this.adjacency = o.adjacency || null;
    this.palette = o.palette;
    this.coverage = o.coverage === undefined ? COVERAGE_INTERIOR : o.coverage;
    this.maxVerbsPerFill = o.maxVerbsPerFill === undefined ? 4000 : o.maxVerbsPerFill;
    this.localityShift = o.localityTile ? (Math.log2(o.localityTile) | 0) : 0;
    this.strokeSeams = o.strokeSeams !== false;
    this.strokeWidth = o.strokeWidth === undefined ? 0.5 : o.strokeWidth;
    this.seamStrokeOnly = o.seamStrokeOnly !== false;
    this.seamBand = o.seamBand === undefined ? 1 : o.seamBand > 0 ? +o.seamBand : 0;
    this.seamBandFixes = o.seamBandFixes === undefined ? BAND_DEFAULT : o.seamBandFixes | 0;
    this.autoFallback = o.autoFallback !== false;
    this.fallbackFillRatio = o.fallbackFillRatio === undefined ? 0.25 : o.fallbackFillRatio;
    this.fallbackVertRatio = o.fallbackVertRatio === undefined ? 0.85 : o.fallbackVertRatio;
    this.usedFallback = false;
    this.collinearEps2 = (o.collinearEpsPx === undefined ? 0.05 : o.collinearEpsPx) ** 2;

    // --- batches (linked lists over triangle ids, no arrays of arrays) -----
    this.batchOf = new Int32Array(nt);   // triangle -> tagged batch id
    this.bNext   = new Int32Array(nt);   // triangle -> next triangle in batch
    this.bHead   = new Int32Array(nt);
    this.bTail   = new Int32Array(nt);
    this.bColour = new Uint8Array(nt);
    this.bVerbs  = new Int32Array(nt);
    this.openByColour = new Int32Array(256);
    this.openByKey = null;   // lazily sized when localityTile is used
    this.batchCount = 0;
    this.epoch = 0;
    this.tagBase = 0;

    // --- occupancy grid ----------------------------------------------------
    this.autoTile = (o.tile === undefined || o.tile === 'auto');
    this.setTile(this.autoTile ? 4 : o.tile);

    // --- boundary extraction scratch --------------------------------------
    const ec = nt * 3;
    this.eFrom = new Int32Array(ec);
    this.eTo   = new Int32Array(ec);
    this.eNext = new Int32Array(ec);
    this.eUsed = new Uint8Array(ec);
    this.eSeam = new Uint8Array(ec);
    this.vHead = new Int32Array(nv).fill(-1);
    this.touched = new Int32Array(ec);
    this.loopX = new Float32Array(ec + 4);
    this.loopY = new Float32Array(ec + 4);
    this.loopF = new Uint8Array(ec + 4);        // edge i of the loop: 2 = band it
    this.loopQ = new Int32Array(ec + 4);        // edge i: the neighbour's third vertex, or -1
    this.loopP = new Uint8Array(ec + 4);        // vertex i: a pinch (2+ boundary edges leave it)
    this.eApex = new Int32Array(ec);
    // Float64: the band's junction tests decide on intermediate points, and
    // on a sub-pixel mesh edge float32 rounding flips them (measured: +4 %
    // path vertices on S2 from zero-area spikes that float64 never emits).
    this.outX  = new Float64Array(3 * ec + 4);
    this.outY  = new Float64Array(3 * ec + 4);
    this.bandX = new Float64Array(3 * ec + 4);
    this.bandY = new Float64Array(3 * ec + 4);

    // --- counters (diagnostics; free to read, never allocated) -------------
    this.fills = 0; this.subpaths = 0; this.verts = 0; this.strokes = 0; this.maxPathVerbs = 0;
  }

  // Best tile from the mean screen area of a triangle.  Fitted to a six-point
  // sweep (270, 87, 24, 5.9, 1.5, 0.4 px^2): it reproduced the measured
  // optimum at every point.
  static tileForArea(meanTriArea) {
    const want = Math.sqrt(meanTriArea) / 4;
    let p = 1;
    while (p * 2 <= want && p < 8) p *= 2;
    if (p < 8 && Math.abs(Math.log2(want / (p * 2))) < Math.abs(Math.log2(want / p))) p *= 2;
    return Math.max(1, Math.min(8, p));
  }

  // one sampled pass over the bboxes; ~free next to the batching itself
  chooseTile(s) {
    const n = s.nVis;
    if (n === 0) return this.tile;
    const step = n > 4096 ? (n / 2048) | 0 : 1;
    let area = 0, k = 0;
    for (let i = 0; i < n; i += step) {
      const t = s.order[i];
      area += (s.bx1[t] - s.bx0[t]) * (s.by1[t] - s.by0[t]) * 0.5;
      k++;
    }
    const want = PainterBatcher.tileForArea(area / k);
    // hysteresis: only move when it is a clear step, so a slow zoom does not
    // flap the grid (and reallocate) every frame
    if (want !== this.tile && (want >= this.tile * 2 || want * 2 <= this.tile)) return want;
    return this.tile;
  }

  setTile(px) {
    this.tile = px;
    this.tileShift = Math.log2(px) | 0;
    this.tw = (this.W >> this.tileShift) + 2;
    this.th = (this.H >> this.tileShift) + 2;
    const n = this.tw * this.th;
    if (!this.stamp || this.stamp.length < n) {
      this.stamp = new Int32Array(n);
      this.covered = new Int32Array(n);
      this.epoch = 0;
    }
  }

  // -------------------------------------------------------------------------
  // pass 1: group triangles into single-coloured, depth-safe batches
  // -------------------------------------------------------------------------
  batch(s) {
    if (this.autoTile) {
      const want = this.chooseTile(s);
      if (want !== this.tile) this.setTile(want);
    }
    const n = s.nVis, order = s.order, colour = s.colour, idx = this.indices;
    const sx = s.sx, sy = s.sy;
    const bx0 = s.bx0, by0 = s.by0, bx1 = s.bx1, by1 = s.by1;
    const batchOf = this.batchOf, bNext = this.bNext, bHead = this.bHead,
          bTail = this.bTail, bColour = this.bColour, bVerbs = this.bVerbs;
    const stamp = this.stamp, cov = this.covered;
    const tw = this.tw, th = this.th, sh = this.tileShift, ts = this.tile, half = ts * 0.5;
    const interior = this.coverage === COVERAGE_INTERIOR;
    const ls = this.localityShift;
    const mw = ls ? ((this.W >> ls) + 2) : 1;
    const mn = ls ? mw * ((this.H >> ls) + 2) : 1;
    if (ls && (!this.openByKey || this.openByKey.length < 256 * mn))
      this.openByKey = new Int32Array(256 * mn);
    const open = ls ? this.openByKey : this.openByColour;

    // Epoch tagging: ordinals from frame k live in [base, base+nt), disjoint
    // from every other frame, so last frame's grid reads as "older than
    // everything" and we never have to clear it.
    let base = this.epoch + 1;
    if (base > 0x7ff00000 - (batchOf.length + 2)) { stamp.fill(0); base = 1; }
    this.epoch = base + batchOf.length + 1;
    this.tagBase = base;
    open.fill(-1);
    let nb = 0;


    for (let i = 0; i < n; i++) {
      const t = order[i], c = colour[t];
      let tx0 = bx0[t] >> sh, ty0 = by0[t] >> sh;
      let tx1 = bx1[t] >> sh, ty1 = by1[t] >> sh;
      if (tx0 < 0) tx0 = 0;
      if (ty0 < 0) ty0 = 0;
      if (tx1 >= tw) tx1 = tw - 1;
      if (ty1 >= th) ty1 = th - 1;
      if (tx1 < tx0 || ty1 < ty0) continue;

      let maxOrd = base, nc = 0;

      if (!interior || (tx0 === tx1 && ty0 === ty1)) {
        for (let y = ty0; y <= ty1; y++) {
          const row = y * tw;
          for (let x = tx0; x <= tx1; x++) {
            const p = row + x;
            cov[nc++] = p;
            const v = stamp[p]; if (v > maxOrd) maxOrd = v;
          }
        }
      } else {
        // Half-plane edge functions sampled at tile centres, stepped
        // incrementally.  Each tile centre of a watertight surface belongs to
        // exactly one triangle, so edge-adjacent triangles do NOT collide --
        // which is the whole reason this beats bbox stamping by ~10x.
        const a = idx[3 * t], b = idx[3 * t + 1], cq = idx[3 * t + 2];
        const ax = sx[a], ay = sy[a], bxv = sx[b], byv = sy[b], cxv = sx[cq], cyv = sy[cq];
        const dx0 = -(byv - ay) * ts, dy0 = (bxv - ax) * ts;
        const dx1 = -(cyv - byv) * ts, dy1 = (cxv - bxv) * ts;
        const dx2 = -(ay - cyv) * ts, dy2 = (ax - cxv) * ts;
        const ox = tx0 * ts + half, oy = ty0 * ts + half;
        let r0 = (bxv - ax) * (oy - ay) - (byv - ay) * (ox - ax);
        let r1 = (cxv - bxv) * (oy - byv) - (cyv - byv) * (ox - bxv);
        let r2 = (ax - cxv) * (oy - cyv) - (ay - cyv) * (ox - cxv);
        for (let y = ty0; y <= ty1; y++) {
          let f0 = r0, f1 = r1, f2 = r2;
          const row = y * tw;
          for (let x = tx0; x <= tx1; x++) {
            if (f0 >= 0 && f1 >= 0 && f2 >= 0) {
              const p = row + x;
              cov[nc++] = p;
              const v = stamp[p]; if (v > maxOrd) maxOrd = v;
            }
            f0 += dx0; f1 += dx1; f2 += dx2;
          }
          r0 += dy0; r1 += dy1; r2 += dy2;
        }
        if (nc === 0) {                       // thinner than one tile
          let fx = ((ax + bxv + cxv) * 0.3333333) >> sh;
          let fy = ((ay + byv + cyv) * 0.3333333) >> sh;
          if (fx < 0) fx = 0; else if (fx >= tw) fx = tw - 1;
          if (fy < 0) fy = 0; else if (fy >= th) fy = th - 1;
          const p = fy * tw + fx;
          cov[nc++] = p;
          const v = stamp[p]; if (v > maxOrd) maxOrd = v;
        }
      }

      let key = c;
      if (ls) {
        let gx = ((bx0[t] + bx1[t]) * 0.5) >> ls, gy = ((by0[t] + by1[t]) * 0.5) >> ls;
        if (gx < 0) gx = 0;
        if (gy < 0) gy = 0;
        key = c * mn + gy * mw + gx;
      }
      let b = open[key];
      // b is joinable iff no batch newer than b has claimed any tile this
      // triangle covers.  Ordinals are unique, so >= is exact.
      if (b < 0 || (base + b + 1) < maxOrd) {
        b = nb++;
        bColour[b] = c; bHead[b] = t; bTail[b] = t; bNext[t] = -1;
        bVerbs[b] = 1; open[key] = b;
      } else {
        bNext[bTail[b]] = t; bTail[b] = t; bNext[t] = -1;
        bVerbs[b]++;
      }
      batchOf[t] = base + b;

      const ord = base + b + 1;
      for (let k = 0; k < nc; k++) stamp[cov[k]] = ord;
    }
    this.batchCount = nb;
    return nb;
  }

  // -------------------------------------------------------------------------
  // pass 2: emit.  One fill() per batch, boundary loops only.
  // -------------------------------------------------------------------------
  emit(ctx, s) {
    const idx = this.indices, adj = this.adjacency, sx = s.sx, sy = s.sy;
    const pal = this.palette;
    const bHead = this.bHead, bNext = this.bNext, bColour = this.bColour,
          batchOf = this.batchOf, tag = this.tagBase;
    const eFrom = this.eFrom, eTo = this.eTo, eNext = this.eNext, eUsed = this.eUsed;
    const eSeam = this.eSeam;
    const vHead = this.vHead, touched = this.touched;
    const lx = this.loopX, ly = this.loopY, ox = this.outX, oy = this.outY;
    const eps2 = this.collinearEps2, doCollinear = eps2 > 0;
    const verbCap = this.maxVerbsPerFill;
    const band = adj !== null ? this.seamBand : 0;
    const lf = this.loopF, lq = this.loopQ, lp = this.loopP, eApex = this.eApex, bx = this.bandX, by = this.bandY;
    const doStroke = this.strokeSeams && band === 0;
    const seamOnly = doStroke && this.seamStrokeOnly && adj !== null;
    const nB = this.batchCount;
    let fills = 0, subpaths = 0, verts = 0, strokes = 0, maxPathVerbs = 0, seamEdges = 0;
    if (doStroke) ctx.lineWidth = this.strokeWidth;

    for (let b = 0; b < this.batchCount; b++) {
      const tb = tag + b;

      // ---- collect the directed edges that are NOT shared inside the batch
      let ne = 0, nTouch = 0;
      if (adj) {
        for (let t = bHead[b]; t >= 0; t = bNext[t]) {
          const i0 = idx[3 * t], i1 = idx[3 * t + 1], i2 = idx[3 * t + 2];
          const n0 = adj[3 * t], n1 = adj[3 * t + 1], n2 = adj[3 * t + 2];
          // A surviving edge is a SEAM only if the triangle on the other side
          // is visible this frame and landed in a different batch: then two
          // fills share it and the antialiasing conflates.  Otherwise it is a
          // silhouette, where there is nothing to conflate with.  eSeam is 2
          // when that other batch is drawn LATER: the edges this batch's band
          // may repair, since only the first-drawn side can grow unseen.
          if (n0 < 0 || batchOf[n0] !== tb) {
            eFrom[ne] = i0; eTo[ne] = i1;
            eApex[ne] = n0 >= 0 ? idx[3 * n0] + idx[3 * n0 + 1] + idx[3 * n0 + 2] - i0 - i1 : -1;
            eSeam[ne] = (n0 >= 0 && batchOf[n0] >= tag && batchOf[n0] < tag + nB) ? (batchOf[n0] > tb ? 2 : 1) : 0; ne++;
          }
          if (n1 < 0 || batchOf[n1] !== tb) {
            eFrom[ne] = i1; eTo[ne] = i2;
            eApex[ne] = n1 >= 0 ? idx[3 * n1] + idx[3 * n1 + 1] + idx[3 * n1 + 2] - i1 - i2 : -1;
            eSeam[ne] = (n1 >= 0 && batchOf[n1] >= tag && batchOf[n1] < tag + nB) ? (batchOf[n1] > tb ? 2 : 1) : 0; ne++;
          }
          if (n2 < 0 || batchOf[n2] !== tb) {
            eFrom[ne] = i2; eTo[ne] = i0;
            eApex[ne] = n2 >= 0 ? idx[3 * n2] + idx[3 * n2 + 1] + idx[3 * n2 + 2] - i2 - i0 : -1;
            eSeam[ne] = (n2 >= 0 && batchOf[n2] >= tag && batchOf[n2] < tag + nB) ? (batchOf[n2] > tb ? 2 : 1) : 0; ne++;
          }
        }
      } else {
        for (let t = bHead[b]; t >= 0; t = bNext[t]) {
          const i0 = idx[3 * t], i1 = idx[3 * t + 1], i2 = idx[3 * t + 2];
          eFrom[ne] = i0; eTo[ne] = i1; ne++;
          eFrom[ne] = i1; eTo[ne] = i2; ne++;
          eFrom[ne] = i2; eTo[ne] = i0; ne++;
        }
      }

      // ---- bucket by start vertex
      for (let e = 0; e < ne; e++) {
        const v = eFrom[e];
        if (vHead[v] === -1) touched[nTouch++] = v;
        eNext[e] = vHead[v]; vHead[v] = e; eUsed[e] = 0;
      }

      // ---- chain into closed loops
      //
      // The surviving edge set is the boundary of a 2-chain, so in-degree
      // equals out-degree at every vertex: a maximal walk always returns to
      // where it started (Euler).  And under the nonzero rule the filled
      // region is determined by the multiset of directed edges alone, so it
      // does not matter HOW the walk pairs them up at a pinch vertex.
      // Styles first: the cap below may need to flush mid-batch, and every
      // flush in this batch uses the same colour.
      const col = pal[bColour[b]];       // pregenerated hex, never built here
      ctx.fillStyle = col;
      if (doStroke) ctx.strokeStyle = col;
      ctx.beginPath();
      let pathVerbs = 0;
      for (let e0 = 0; e0 < ne; e0++) {
        if (eUsed[e0]) continue;
        let k = 0, e = e0;
        for (;;) {
          eUsed[e] = 1;
          const v = eFrom[e];
          const h0 = vHead[v];
          lx[k] = sx[v]; ly[k] = sy[v]; lf[k] = eSeam[e]; lq[k] = eApex[e];
          lp[k] = h0 !== -1 && eNext[h0] !== -1 ? 1 : 0; k++;
          const w = eTo[e];
          let nx = -1;
          for (let q = vHead[w]; q !== -1; q = eNext[q]) { if (eUsed[q] === 0) { nx = q; break; } }
          if (nx === -1) break;
          e = nx;
        }
        if (k < 3) continue;

        // In-path seam band: rewrite the loop into bx/by, then let the
        // collinear pass below read from there.  Nothing else changes.
        let src = lx, srcY = ly;
        if (band > 0) { k = bandLoop(lx, ly, lf, lq, sx, sy, k, band, bx, by, this.seamBandFixes, lp); src = bx; srcY = by; }

        let m = k;
        if (doCollinear) {
          m = 0;
          for (let i = 0; i < k; i++) {
            if (m >= 1) {
              const ax = ox[m - 1], ay = oy[m - 1], j = (i + 1) % k;
              const d1x = src[i] - ax, d1y = srcY[i] - ay;
              if (band > 0 && d1x * d1x + d1y * d1y < 1e-12) continue;   // repeated point
              const d2x = src[j] - src[i], d2y = srcY[j] - srcY[i];
              const cr = d1x * d2y - d1y * d2x;
              const tx = d1x + d2x, ty = d1y + d2y;
              // |cross| / |A->C| is the distance of the dropped vertex from
              // the straight line that would replace it.
              if (cr * cr <= eps2 * (tx * tx + ty * ty) && (d1x * d2x + d1y * d2y) > 0) continue;
            }
            ox[m] = src[i]; oy[m] = srcY[i]; m++;
          }
          if (m < 3) continue;
          ctx.moveTo(ox[0], oy[0]);
          for (let i = 1; i < m; i++) ctx.lineTo(ox[i], oy[i]);
          // stroke() does not close subpaths the way fill() does, so the
          // closing edge has to be spelled out.  An explicit lineTo, never
          // closePath() -- that is the O(N^2) trap.
          if (doStroke && !seamOnly) ctx.lineTo(ox[0], oy[0]);
        } else {
          ctx.moveTo(src[0], srcY[0]);
          for (let i = 1; i < k; i++) ctx.lineTo(src[i], srcY[i]);
          if (doStroke && !seamOnly) ctx.lineTo(src[0], srcY[0]);
        }
        // NO closePath(): fill() closes every subpath implicitly, and in Blink
        // closePath() recomputes the whole path's bounding box, which makes
        // building an N-subpath path O(N^2).  Measured 390x on 8000 subpaths.
        subpaths++; verts += m; pathVerbs += m + 1;
        // Split the batch's geometry across several fills once the path gets
        // too complex for the engine's fast path (Firefox: 4000 verbs).  Safe
        // at any point -- everything in this batch is the same colour, so the
        // order between the pieces cannot matter.
        if (pathVerbs > maxPathVerbs) maxPathVerbs = pathVerbs;
        if (verbCap && pathVerbs >= verbCap) {
          ctx.fill(); fills++;
          if (doStroke && !seamOnly) { ctx.stroke(); strokes++; }
          ctx.beginPath(); pathVerbs = 0;
        }
      }
      for (let i = 0; i < nTouch; i++) vHead[touched[i]] = -1;

      if (pathVerbs > 0) {
        ctx.fill(); fills++;
        if (doStroke && !seamOnly) { ctx.stroke(); strokes++; }
      }

      if (seamOnly) {
        // Second path: seam edges only, chained into open polylines so each
        // costs about one vertex rather than the two a bare segment needs.
        for (let i = 0; i < nTouch; i++) vHead[touched[i]] = -1;
        nTouch = 0;
        let nS = 0;
        for (let e = 0; e < ne; e++) {
          if (!eSeam[e]) continue;
          const v = eFrom[e];
          if (vHead[v] === -1) touched[nTouch++] = v;
          eNext[e] = vHead[v]; vHead[v] = e; eUsed[e] = 0; nS++;
        }
        if (nS) {
          seamEdges += nS;
          ctx.beginPath();
          for (let e0 = 0; e0 < ne; e0++) {
            if (!eSeam[e0] || eUsed[e0]) continue;
            let e = e0, vc = 1;
            ctx.moveTo(sx[eFrom[e]], sy[eFrom[e]]);
            for (;;) {
              eUsed[e] = 1;
              const w2 = eTo[e];
              ctx.lineTo(sx[w2], sy[w2]); vc++;
              let nx = -1;
              for (let q = vHead[w2]; q !== -1; q = eNext[q]) {
                if (eUsed[q] === 0 && eSeam[q]) { nx = q; break; }
              }
              if (nx === -1) break;
              e = nx;
            }
            subpaths++; verts += vc;
          }
          ctx.stroke(); strokes++;
        }
        // vHead was rebuilt for the seam pass, so it has to be cleared again
        // or the next batch walks into this one's edges.
        for (let i = 0; i < nTouch; i++) vHead[touched[i]] = -1;
      }
    }
    this.fills = fills; this.subpaths = subpaths; this.verts = verts;
    this.strokes = strokes; this.maxPathVerbs = maxPathVerbs;
    this.seamEdges = seamEdges;
  }

  // -------------------------------------------------------------------------
  // How many vertices will emit() actually produce?  Every interior edge that
  // cancels removes one directed edge, and each directed edge contributes one
  // vertex.  So predicted = 3*nVis - cancelled, exactly, and it costs one
  // O(nVis) pass of array reads -- far cheaper than emitting and regretting it.
  // -------------------------------------------------------------------------
  predictVerts(s) {
    const adj = this.adjacency;
    if (!adj) return s.nVis * 3;
    const bHead = this.bHead, bNext = this.bNext, batchOf = this.batchOf, tag = this.tagBase;
    let cancelled = 0;
    for (let b = 0; b < this.batchCount; b++) {
      const tb = tag + b;
      for (let t = bHead[b]; t >= 0; t = bNext[t]) {
        const n0 = adj[3 * t], n1 = adj[3 * t + 1], n2 = adj[3 * t + 2];
        if (n0 >= 0 && batchOf[n0] === tb) cancelled++;
        if (n1 >= 0 && batchOf[n1] === tb) cancelled++;
        if (n2 >= 0 && batchOf[n2] === tb) cancelled++;
      }
    }
    return s.nVis * 3 - cancelled;
  }

  // The baseline, kept as a real code path so the fallback is one call away.
  emitPerTriangle(ctx, s) {
    const idx = this.indices, sx = s.sx, sy = s.sy, pal = this.palette;
    const order = s.order, colour = s.colour, n = s.nVis;
    const doStroke = this.strokeSeams;
    if (doStroke) ctx.lineWidth = this.strokeWidth;
    for (let i = 0; i < n; i++) {
      const t = order[i], a = idx[3 * t], q = idx[3 * t + 1], r = idx[3 * t + 2];
      const ax = sx[a], ay = sy[a];
      ctx.beginPath();
      ctx.moveTo(ax, ay); ctx.lineTo(sx[q], sy[q]); ctx.lineTo(sx[r], sy[r]);
      const col = pal[colour[t]];
      ctx.fillStyle = col;
      if (doStroke) { ctx.lineTo(ax, ay); ctx.strokeStyle = col; ctx.fill(); ctx.stroke(); }
      else ctx.fill();
    }
    this.fills = n; this.strokes = doStroke ? n : 0;
    this.subpaths = n; this.verts = n * (doStroke ? 4 : 3);
    this.maxPathVerbs = doStroke ? 5 : 4;
  }

  /**
   * batch + emit, with the content guard.  This is the only call a consumer
   * needs, on any engine.
   */
  draw(ctx, s) {
    this.batch(s);
    if (this.autoFallback && s.nVis > 0) {
      // Batching almost always pays once stroking is in the picture, because a
      // stroke is per PATH: even with zero edge cancellation, an unwelded mesh
      // still goes from 35 851 stroke calls to 835.  The guard is only for
      // genuinely degenerate content -- independent overlapping triangles with
      // random colours -- where neither the fill count nor the vertex count
      // moves enough to pay for leaving the engine's simple-primitive path.
      const verts = this.predictVerts(s);
      if (this.batchCount > s.nVis * this.fallbackFillRatio &&
          verts > s.nVis * 3 * this.fallbackVertRatio) {
        this.usedFallback = true;
        this.emitPerTriangle(ctx, s);
        return;
      }
    }
    this.usedFallback = false;
    this.emit(ctx, s);
  }
}
