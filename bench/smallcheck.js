// node bench/smallcheck.js
// Does the exact sub-tile path preserve the painter order BETTER or WORSE than
// the conservative centroid fallback?  Fill count alone cannot tell you: a
// batcher that detects fewer conflicts always produces fewer batches, and is
// simply wrong more often.  So count the actual order violations, exactly.
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const sb = { performance: { now: () => Number(process.hrtime.bigint()) / 1e6 }, console, Math, Date, Map };
vm.createContext(sb);
for (const f of ['mesh.js', 'scene.js', 'render.js'])
  vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), sb, { filename: f });
const { makeTorusKnot, Scene, Renderer, Stats } = sb;

const TA = new Float64Array(6), TB = new Float64Array(6);
function loadTri(s, t, d) {
  const idx = s.m.idx;
  for (let k = 0; k < 3; k++) { const v = idx[3 * t + k]; d[k * 2] = s.sx[v]; d[k * 2 + 1] = s.sy[v]; }
}
function sep(P, Q) {
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    const nx = -(P[j * 2 + 1] - P[i * 2 + 1]), ny = (P[j * 2] - P[i * 2]);
    let p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const a = nx * P[k * 2] + ny * P[k * 2 + 1]; if (a < p0) p0 = a; if (a > p1) p1 = a;
      const b = nx * Q[k * 2] + ny * Q[k * 2 + 1]; if (b < q0) q0 = b; if (b > q1) q1 = b;
    }
    if (p1 <= q0 || q1 <= p0) return true;
  }
  return false;
}
function overlap(s, a, b) {
  if (s.bx1[a] <= s.bx0[b] || s.bx1[b] <= s.bx0[a]) return false;
  if (s.by1[a] <= s.by0[b] || s.by1[b] <= s.by0[a]) return false;
  loadTri(s, a, TA); loadTri(s, b, TB);
  return !sep(TA, TB) && !sep(TB, TA);
}

function violations(R) {
  const s = R.s, n = s.nVis, order = s.order, col = s.col;
  const pos = new Int32Array(s.m.nt).fill(-1);
  let p = 0;
  for (let b = 0; b < R.nB; b++) for (let t = R.bHead[b]; t >= 0; t = R.bNext[t]) pos[t] = p++;
  const depth = new Int32Array(s.m.nt).fill(-1);
  for (let i = 0; i < n; i++) depth[order[i]] = i;
  const CS = 16, gw = Math.ceil(s.W / CS) + 2, gh = Math.ceil(s.H / CS) + 2;
  const buckets = new Array(gw * gh);
  for (let i = 0; i < n; i++) {
    const t = order[i];
    const x0 = Math.max(0, Math.floor(s.bx0[t] / CS)), x1 = Math.min(gw - 1, Math.floor(s.bx1[t] / CS));
    const y0 = Math.max(0, Math.floor(s.by0[t] / CS)), y1 = Math.min(gh - 1, Math.floor(s.by1[t] / CS));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const k = y * gw + x; (buckets[k] || (buckets[k] = [])).push(t);
    }
  }
  let bad = 0, checked = 0;
  const seen = new Set();
  for (let k = 0; k < buckets.length; k++) {
    const B = buckets[k]; if (!B) continue;
    for (let a = 0; a < B.length; a++) for (let b = a + 1; b < B.length; b++) {
      const t1 = B[a], t2 = B[b];
      if (col[t1] === col[t2]) continue;
      const key = t1 < t2 ? t1 * 1e7 + t2 : t2 * 1e7 + t1;
      if (seen.has(key)) continue; seen.add(key);
      if (!overlap(s, t1, t2)) continue;
      checked++;
      const first = depth[t1] < depth[t2] ? t1 : t2, second = first === t1 ? t2 : t1;
      if (pos[first] > pos[second]) bad++;
    }
  }
  return { bad, checked };
}

function Count() { this.fills = 0; }
Count.prototype.beginPath = function () { };
Count.prototype.moveTo = function () { };
Count.prototype.lineTo = function () { };
Count.prototype.closePath = function () { };
Count.prototype.fill = function () { this.fills++; };
Count.prototype.stroke = function () { };
Object.defineProperty(Count.prototype, 'fillStyle', { set() { } });
Object.defineProperty(Count.prototype, 'strokeStyle', { set() { } });

const mesh = makeTorusKnot(320, 48, 3, 7, 8);
const s = new Scene(mesh, 1280, 720, 24, 8);
const R = new Renderer(s, 1);

console.log('tile = 1 throughout; "violations" are exact SAT order breaks\n');
console.log('scale triArea  mode        fills  violations / overlapping pairs   %');
for (const scale of [160, 80, 40]) {
  s.build(0.4, 0.9, 0.13, 3.1, scale);
  let area = 0;
  for (let i = 0; i < s.nVis; i++) {
    const t = s.order[i];
    area += (s.bx1[t] - s.bx0[t]) * (s.by1[t] - s.by0[t]) * 0.5;
  }
  area /= s.nVis;
  for (const [label, exact, walk] of
       [['centroid', false, 0], ['exact w=16', true, 16], ['exact w=4', true, 4], ['exact w=1', true, 1]]) {
    s.build(0.4, 0.9, 0.13, 3.1, scale);
    R.exactSmall = exact; R.smallWalk = walk; R.setTile(1);
    R.batchGridExact();
    const c = new Count(); R.emitBoundary(c, new Stats(), true, 0);
    const v = violations(R);
    console.log(String(scale).padStart(5) + area.toFixed(2).padStart(8) + '  ' + label.padEnd(12) +
      String(c.fills).padStart(6) + String(v.bad).padStart(9) + ' / ' + String(v.checked).padStart(8) +
      (100 * v.bad / Math.max(1, v.checked)).toFixed(3).padStart(9) + '%');
  }
  console.log('');
}
