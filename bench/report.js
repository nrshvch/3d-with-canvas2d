// node bench/report.js [tags...] -- pretty-print collected results.
'use strict';
const fs = require('fs'), path = require('path');
const OUT = path.join(__dirname, 'out');
const tags = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(OUT).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));

const L = (s, n) => { s = String(s); while (s.length < n) s += ' '; return s; };
const Rp = (s, n) => { s = String(s); while (s.length < n) s = ' ' + s; return s; };

for (const tag of tags) {
  const p = path.join(OUT, tag + '.json');
  if (!fs.existsSync(p)) { console.log('missing ' + p); continue; }
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  console.log('\n\n##################  ' + tag + '  ##################');
  console.log((j.env && j.env.ua) || '(no ua)');
  for (const s of j.scenes || []) {
    console.log('\n=== ' + s.name + '   visible=' + s.nVis + '   geometry stage=' + s.sceneMs + 'ms');
    console.log(L('case', 29) + Rp('fills', 7) + Rp('subpath', 9) + Rp('verts', 8) +
      Rp('recMs', 8) + Rp('thruMs', 8) + Rp('x', 4) + Rp('rasterMs', 10) +
      '   ' + Rp('rmse', 6) + Rp('mae', 7) + Rp('>8%', 7) + Rp('>48%', 7) + Rp('vsBase%', 9));
    for (const r of s.rows) {
      const t = r.truth || {}, d = r.diff || {};
      console.log(L(r.case, 29) + Rp(r.fills, 7) + Rp(r.subpaths, 9) + Rp(r.verts, 8) +
        Rp(r.recMs, 8) + Rp(r.throttled ? 'thr' : r.thruMs, 8) + Rp(r.reps, 4) + Rp(r.rasterMs, 10) +
        '   ' + Rp(t.rmse, 6) + Rp(t.mae, 7) + Rp(t.gt8Pct, 7) + Rp(t.gt48Pct, 7) + Rp(d.anyPct, 9));
    }
    if (s.probeBaseline) {
      const f = a => (a || []).map(v => Math.round(v)).join(' ');
      console.log('  demotion probe, frame interval ms (fresh canvas, frame 1..N):');
      console.log('    baseline    : ' + f(s.probeBaseline.iv));
      console.log('    baseline cpu: ' + f(s.probeBaseline.cpuMs));
      console.log('    batched     : ' + f(s.probeBatched.iv));
      console.log('    batched cpu : ' + f(s.probeBatched.cpuMs));
    }
  }
  if ((j.micro || []).length) {
    console.log('\n--- MICRO ---');
    console.log(L('case', 46) + Rp('recMs', 10) + Rp('rasterMs', 11));
    for (const m of j.micro) console.log(L(m.name, 46) + Rp(m.recMs, 10) + Rp(m.rasterMs === null ? '-' : m.rasterMs, 11));
  }
}
