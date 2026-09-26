// node bench/wgr/build.mjs        -- rebuilds bench/wgr/wgr.wasm (committed)
// ---------------------------------------------------------------------------
// Firefox's accelerated canvas2d does not rasterise a path. It hands it to
// WGR (wpf-gpu-raster, a Rust port of WPF's GPU rasteriser), which turns it
// into an antialiased TRIANGLE LIST on the CPU, and DrawTargetWebgl uploads
// that list into one shared path vertex buffer (gpu-path-size, 4 MB) and
// draws it (3.2). So "what does this path cost Firefox while it is still
// accelerated" is a question about WGR's output, and WGR is deterministic,
// MIT-licensed and small. This script builds the exact source Firefox 156
// ships into a 48 KB wasm module that bench/wgr.mjs loads in plain Node.
//
// Also builds aa-stroke, Firefox's stroke tessellator, which writes into the
// same path vertex buffer as WGR (DrawTargetWebgl::DrawWGRPath).
//
// Needs: cargo + `rustup target add wasm32-unknown-unknown`, and network
// access to raw.githubusercontent.com the first time (the source is fetched
// into bench/wgr/vendor/, which is not committed).
//
// The ONLY change to Firefox's source is two counters (wgr_stats.rs): how
// many simple trapezoids and how many per-scanline "complex scans" the
// rasteriser emitted. They count; they do not change a single output vertex.
// ---------------------------------------------------------------------------
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TAG = 'FIREFOX_156_0_RELEASE';
const RAW = `https://raw.githubusercontent.com/mozilla-firefox/firefox/${TAG}/third_party/rust`;
const V = join(HERE, 'vendor');
const WGR_FILES = ['lib.rs', 'hwrasterizer.rs', 'hwvertexbuffer.rs', 'aacoverage.rs', 'aarasterizer.rs',
  'geometry_sink.rs', 'fix.rs', 'helpers.rs', 'matrix.rs', 'nullable_ref.rs', 'real.rs', 'types.rs',
  'bezier.rs', 'c_bindings.rs', 'tri_rasterize.rs'];

async function fetchTo(url, file) {
  if (existsSync(file)) return;
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url);
    if (r.ok) { writeFileSync(file, Buffer.from(await r.arrayBuffer())); return; }
    if (r.status !== 429) throw new Error(url + ' -> ' + r.status);
    await new Promise(res => setTimeout(res, 5000 * (attempt + 1)));   // GitHub rate limit
  }
  throw new Error(url + ' -> still rate-limited');
}

mkdirSync(join(V, 'wpf-gpu-raster/src'), { recursive: true });
mkdirSync(join(V, 'typed-arena-nomut/src'), { recursive: true });
for (const f of WGR_FILES) await fetchTo(`${RAW}/wpf-gpu-raster/src/${f}`, join(V, 'wpf-gpu-raster/src', f));
await fetchTo(`${RAW}/wpf-gpu-raster/LICENSE`, join(V, 'wpf-gpu-raster/LICENSE'));
await fetchTo(`${RAW}/typed-arena-nomut/src/lib.rs`, join(V, 'typed-arena-nomut/src/lib.rs'));
// aa-stroke: how DrawTargetWebgl tessellates a solid, opaque stroke (A9's
// stroke half).  Its one dependency, euclid, is replaced by ./euclid-lite.
mkdirSync(join(V, 'aa-stroke/src'), { recursive: true });
for (const f of ['lib.rs', 'bezierflattener.rs', 'tri_rasterize.rs', 'c_bindings.rs'])
  await fetchTo(`${RAW}/aa-stroke/src/${f}`, join(V, 'aa-stroke/src', f));
writeFileSync(join(V, 'aa-stroke/Cargo.toml'),
  '[package]\nedition = "2021"\nname = "aa-stroke"\nversion = "0.1.0"\nlicense = "MIT"\n' +
  '[lib]\nname = "aa_stroke"\npath = "src/lib.rs"\n[features]\nc_bindings = []\ndefault = []\n' +
  '[dependencies]\neuclid = { path = "../../euclid-lite" }\n');

// Minimal manifests: the vendored ones carry dev-dependencies (usvg, png,
// criterion) that would need crates.io for nothing we use.
writeFileSync(join(V, 'typed-arena-nomut/Cargo.toml'),
  '[package]\nname = "typed-arena-nomut"\nversion = "0.1.0"\nedition = "2015"\nlicense = "MIT"\n' +
  '[lib]\nname = "typed_arena_nomut"\npath = "src/lib.rs"\n[features]\ndefault = ["std"]\nstd = []\n');
writeFileSync(join(V, 'wpf-gpu-raster/Cargo.toml'),
  '[package]\nedition = "2021"\nname = "wpf-gpu-raster"\nversion = "0.1.0"\nlicense = "MIT"\n' +
  '[lib]\nname = "wpf_gpu_raster"\npath = "src/lib.rs"\n[features]\nc_bindings = []\ndefault = []\n' +
  '[dependencies]\ntyped-arena-nomut = { path = "../typed-arena-nomut" }\n');

// --- the instrumentation: two counters, nothing else -----------------------
writeFileSync(join(V, 'wpf-gpu-raster/src/wgr_stats.rs'), `// Added by bench/wgr/build.mjs. Counts; never changes output.
use std::sync::atomic::{AtomicU32, Ordering::Relaxed};
static TRAPS: AtomicU32 = AtomicU32::new(0);
static SCANS: AtomicU32 = AtomicU32::new(0);
pub fn reset() { TRAPS.store(0, Relaxed); SCANS.store(0, Relaxed); }
pub fn bump_trap() { TRAPS.fetch_add(1, Relaxed); }
pub fn bump_scan() { SCANS.fetch_add(1, Relaxed); }
pub fn traps() -> u32 { TRAPS.load(Relaxed) }
pub fn scans() -> u32 { SCANS.load(Relaxed) }
`);
const libPath = join(V, 'wpf-gpu-raster/src/lib.rs');
let lib = readFileSync(libPath, 'utf8');
if (!lib.includes('pub mod wgr_stats;')) {
  lib = lib.replace('mod nullable_ref;\n', 'mod nullable_ref;\n\npub mod wgr_stats;\n');
  writeFileSync(libPath, lib);
}
const hvbPath = join(V, 'wpf-gpu-raster/src/hwvertexbuffer.rs');
let h = readFileSync(hvbPath, 'utf8');
if (!h.includes('wgr_stats::bump_trap')) {
  const impl = h.indexOf('impl IGeometrySink for CHwVertexBufferBuilder');
  let j = h.indexOf('fn AddTrapezoid(&mut self,', impl);
  let k = h.indexOf('let hr = S_OK;', j);
  h = h.slice(0, k) + 'crate::wgr_stats::bump_trap();\n        ' + h.slice(k);
  j = h.indexOf('fn AddComplexScan(&mut self,', impl);
  k = h.indexOf('let hr: HRESULT = S_OK;', j);
  h = h.slice(0, k) + 'crate::wgr_stats::bump_scan();\n    ' + h.slice(k);
  writeFileSync(hvbPath, h);
}

execFileSync('cargo', ['build', '--release', '--offline', '--target', 'wasm32-unknown-unknown'],
  { cwd: HERE, stdio: 'inherit' });
copyFileSync(join(HERE, 'target/wasm32-unknown-unknown/release/wgr_shim.wasm'), join(HERE, 'wgr.wasm'));
console.log('wrote bench/wgr/wgr.wasm  (source: Firefox ' + TAG + ', third_party/rust/{wpf-gpu-raster,aa-stroke})');
