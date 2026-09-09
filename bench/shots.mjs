// node bench/shots.mjs -- decode the PNGs that shotpage.html posted into assets/
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, '..', 'assets');
mkdirSync(ASSETS, { recursive: true });
const tag = process.argv[2] || 'edge-shots';
const j = JSON.parse(readFileSync(join(__dirname, 'out', tag + '.json'), 'utf8'));
if (j.error) { console.error('page errored: ' + j.error); process.exit(1); }
for (const n of j.notes || []) {
  if (!n.png) continue;
  const b = Buffer.from(n.png.split(',')[1], 'base64');
  writeFileSync(join(ASSETS, n.case + '.png'), b);
  console.log('wrote assets/' + n.case + '.png  (' + b.length + ' bytes)');
}
