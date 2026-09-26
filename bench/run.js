// node bench/run.js [tags...]   -- launches real browsers, collects results.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const PORT = Number(process.env.PORT || 8123);
const OUT = path.join(__dirname, 'out');
const QS = (process.env.QUICK === '1' ? '&quick=1' : '') +
  (process.env.EXTRA ? '&' + process.env.EXTRA : '');   // e.g. EXTRA=parts=6
fs.mkdirSync(OUT, { recursive: true });

const WIN = process.platform === 'win32', MAC = process.platform === 'darwin';
// Executables: the Windows defaults are M1's, the macOS ones M6's (Google
// Chrome stands in for Edge: the same Chromium, the same Skia).  On any other
// machine point these at your own builds (M4, the Linux container, used
// EDGE_EXE=<playwright chromium> and FIREFOX_EXE=<conda-forge firefox 156>).
const EDGE = process.env.EDGE_EXE || (MAC ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
const FIREFOX = process.env.FIREFOX_EXE || (MAC ? '/Applications/Firefox.app/Contents/MacOS/firefox'
  : 'C:\\Program Files\\Mozilla Firefox\\firefox.exe');
// XVFB=1 runs each browser under xvfb-run (a headless Linux box has no
// display, and a headless browser throttles rAF differently from a real one).
const XVFB = process.env.XVFB === '1';
// FF_PREFS: extra user_pref lines appended to EVERY Firefox profile.  On a
// machine whose only GL is software (llvmpipe), Gecko blocklists accelerated
// canvas; M4 needed
//   gfx.canvas.accelerated.force-enabled, layers.acceleration.force-enabled,
//   layers.gpu-process.force-enabled, gfx.webrender.all
// to get DrawTargetWebgl at all.  Timings taken that way are NOT GPU timings
// (10.1); verdicts (A7) and tessellation counts are.
const FF_PREFS = process.env.FF_PREFS_FILE ? fs.readFileSync(process.env.FF_PREFS_FILE, 'utf8') : '';

const FF_PREFS_COMMON = `
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("app.update.auto", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("dom.disable_beforeunload", true);
`;

function ffProfile(name, extra) {
  const dir = path.join(os.tmpdir(), 'c2dbench-' + name + '-' + process.pid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'user.js'), FF_PREFS_COMMON + FF_PREFS + (extra || ''));
  return dir;
}

const PAGE = process.env.PAGE || '';
// EDGE_ARGS: extra command-line flags for the Chromium targets, space-separated
// (M4: '--no-sandbox --use-angle=swiftshader --enable-unsafe-swiftshader').
const EDGE_ARGS = (process.env.EDGE_ARGS || '').split(' ').filter(Boolean);   // '' = index.html, 'sustained.html'
const TS = process.env.TAGSUFFIX || '';
const TARGETS = {
  edge: () => ({
    exe: EDGE,
    args: ['--user-data-dir=' + path.join(os.tmpdir(), 'c2dbench-edge-' + process.pid),
           '--no-first-run', '--no-default-browser-check', '--disable-sync',
           '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
           '--window-size=1500,950', ...EDGE_ARGS,
           `--app=http://localhost:${PORT}/${PAGE}?tag=edge${TS}${QS}`]
  }),
  'edge-swiftshader': () => ({
    exe: EDGE,
    args: ['--user-data-dir=' + path.join(os.tmpdir(), 'c2dbench-edgesw-' + process.pid),
           '--no-first-run', '--no-default-browser-check', '--disable-gpu',
           '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
           '--window-size=1500,950', ...EDGE_ARGS,
           `--app=http://localhost:${PORT}/${PAGE}?tag=edge-swiftshader${TS}${QS}`]
  }),
  firefox: () => ({
    exe: FIREFOX,
    args: ['-no-remote', '-profile', ffProfile('ff', ''),
           `http://localhost:${PORT}/${PAGE}?tag=firefox${TS}${QS}`]
  }),
  'firefox-nonaccel': () => ({
    exe: FIREFOX,
    args: ['-no-remote', '-profile',
           // debug on too: the control canvas must then show NO green square,
           // which confirms the software regime instead of assuming it
           ffProfile('ffsw', 'user_pref("gfx.canvas.accelerated", false);\n' +
                             'user_pref("gfx.canvas.accelerated.debug", true);\n'),
           `http://localhost:${PORT}/${PAGE}?tag=firefox-nonaccel${TS}${QS}`]
  }),
  // gfx.canvas.accelerated.debug makes DrawTargetWebgl::EndFrame draw a 16x16
  // green rect in the top-right corner of every canvas that is STILL
  // accelerated.  That turns "is this canvas demoted?" from an inference about
  // a step in a timing trace into a pixel you can read.
  'firefox-dbg': () => ({
    exe: FIREFOX,
    args: ['-no-remote', '-profile',
           ffProfile('ffdbg', 'user_pref("gfx.canvas.accelerated.debug", true);\n'),
           `http://localhost:${PORT}/${PAGE}?tag=firefox-dbg${TS}${QS}`]
  }),
  // profile-frames = 0 short-circuits UsageProfile::RequiresRefresh(), so the
  // canvas is NEVER demoted however badly it scores.  Running the same page
  // under this and under plain firefox separates "my paths are slow" from
  // "I got demoted" -- which no single run can tell you.
  'firefox-nodemote': () => ({
    exe: FIREFOX,
    args: ['-no-remote', '-profile',
           ffProfile('ffnd', 'user_pref("gfx.canvas.accelerated.profile-frames", 0);\n' +
                             'user_pref("gfx.canvas.accelerated.debug", true);\n'),
           `http://localhost:${PORT}/${PAGE}?tag=firefox-nodemote${TS}${QS}`]
  }),
  // Two more instruments, for bisecting WHY a canvas demoted.
  // cache-miss-ratio > 1 makes the ratio test unsatisfiable, so the only way
  // left to fail a frame is mFallbacks > 0 -- a real software fallback.
  'firefox-noratio': () => ({
    exe: FIREFOX,
    args: ['-no-remote', '-profile',
           ffProfile('ffnr', 'user_pref("gfx.canvas.accelerated.profile-cache-miss-ratio", 1.1);\n' +
                             'user_pref("gfx.canvas.accelerated.debug", true);\n'),
           `http://localhost:${PORT}/${PAGE}?tag=firefox-noratio${TS}${QS}`]
  }),
  // a 16x path vertex buffer and no complexity cap: if big merged paths are
  // what breaks the path cache, this is the profile where they stop.
  'firefox-bigpath': () => ({
    exe: FIREFOX,
    args: ['-no-remote', '-profile',
           ffProfile('ffbp', 'user_pref("gfx.canvas.accelerated.gpu-path-size", 64);\n' +
                             'user_pref("gfx.canvas.accelerated.gpu-path-complexity", 1000000);\n' +
                             'user_pref("gfx.canvas.accelerated.debug", true);\n'),
           `http://localhost:${PORT}/${PAGE}?tag=firefox-bigpath${TS}${QS}`]
  }),
  // ... and the two halves of firefox-bigpath, separately, because they are
  // different mechanisms: one is a bump allocator that orphans every cached
  // tessellation when it wraps, the other is a per-path verb ceiling.
  'firefox-bigbuf': () => ({
    exe: FIREFOX,
    args: ['-no-remote', '-profile',
           ffProfile('ffbb', 'user_pref("gfx.canvas.accelerated.gpu-path-size", 64);\n' +
                             'user_pref("gfx.canvas.accelerated.debug", true);\n'),
           `http://localhost:${PORT}/${PAGE}?tag=firefox-bigbuf${TS}${QS}`]
  }),
  // 8 MB: the value a user reported raising gpu-path-size to (4.12); keeps
  // twice the tessellated output per frame before the buffer wraps.
  'firefox-bigbuf8': () => ({
    exe: FIREFOX,
    args: ['-no-remote', '-profile',
           ffProfile('ffb8', 'user_pref("gfx.canvas.accelerated.gpu-path-size", 8);\n' +
                             'user_pref("gfx.canvas.accelerated.debug", true);\n'),
           `http://localhost:${PORT}/${PAGE}?tag=firefox-bigbuf8${TS}${QS}`]
  }),
  'firefox-nocap': () => ({
    exe: FIREFOX,
    args: ['-no-remote', '-profile',
           ffProfile('ffnc', 'user_pref("gfx.canvas.accelerated.gpu-path-complexity", 1000000);\n' +
                             'user_pref("gfx.canvas.accelerated.debug", true);\n'),
           `http://localhost:${PORT}/${PAGE}?tag=firefox-nocap${TS}${QS}`]
  }),
  // Safari takes no profile or flags from a command line: the page opens as a
  // tab in the user's own Safari, and close() shuts only that tab.
  safari: () => ({
    exe: '/usr/bin/open',
    args: ['-a', 'Safari', `http://localhost:${PORT}/${PAGE}?tag=safari${TS}${QS}`],
    close: () => spawn('osascript', ['-e',
      `tell application "Safari" to close (every tab of every window whose URL contains "tag=safari${TS}")`],
      { stdio: 'ignore' })
  }),
  // the opposite control: demote after one profiled frame, so anything that
  // depends on staying accelerated shows its worst case immediately.
  'firefox-fastdemote': () => ({
    exe: FIREFOX,
    args: ['-no-remote', '-profile',
           ffProfile('fffd', 'user_pref("gfx.canvas.accelerated.profile-frames", 1);\n' +
                             'user_pref("gfx.canvas.accelerated.debug", true);\n'),
           `http://localhost:${PORT}/${PAGE}?tag=firefox-fastdemote${TS}${QS}`]
  })
};

// A previous aborted run can leave a detached browser alive, still
// benchmarking in the background and stealing CPU/GPU from the next run.
function reapOrphans() {
  if (!WIN) return new Promise(r => {
    const ps = spawn('pkill', ['-9', '-f', 'c2dbench-'], { stdio: 'ignore' });
    ps.on('exit', () => setTimeout(r, 1200));
    ps.on('error', r);
  });
  return new Promise(r => {
    const ps = spawn('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='firefox.exe' OR Name='msedge.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*c2dbench*' } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
      { stdio: 'ignore' });
    ps.on('exit', () => setTimeout(r, 1200));
    ps.on('error', r);
  });
}

function waitFor(file, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      if (fs.existsSync(file)) {
        try {
          const j = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (j.error) return resolve({ done: true, error: j.error });
          const nMicro = (j.micro || []).length;
          if (nMicro > 0) return resolve({ done: true });
        } catch (e) { /* partial write */ }
      }
      if (Date.now() - t0 > timeoutMs) return reject(new Error('timeout waiting for ' + file));
      setTimeout(poll, 1000);
    })();
  });
}

(async function () {
  const tags = process.argv.slice(2).filter(a => TARGETS[a]);
  const list = tags.length ? tags : ['edge', 'firefox'];
  await reapOrphans();
  for (const tag of list) {
    const file = path.join(OUT, tag + TS + '.json');
    try { fs.unlinkSync(file); } catch (e) { }
    const spec = TARGETS[tag]();
    if (!fs.existsSync(spec.exe)) { console.log('[run] SKIP ' + tag + ' (missing ' + spec.exe + ')'); continue; }
    // clear any stale single-instance lease from a previous aborted run
    await new Promise(r => {
      const req = require('http').request(
        { host: 'localhost', port: PORT, path: '/release?tag=' + encodeURIComponent(tag + TS) },
        res => { res.resume(); res.on('end', r); });
      req.on('error', r); req.end();
    });
    console.log('[run] launching ' + tag);
    const exe = XVFB ? 'xvfb-run' : spec.exe;
    const args = XVFB ? ['-a', '-s', '-screen 0 1600x1000x24', spec.exe, ...spec.args] : spec.args;
    const p = spawn(exe, args, { detached: true, stdio: 'ignore' });
    p.unref();
    try {
      // 30 min: a Firefox part-T run of tesspage is ~13 min on M6
      const r = await waitFor(file, 30 * 60 * 1000);
      console.log('[run] ' + tag + ' finished' + (r.error ? ' WITH ERROR: ' + r.error : ''));
    } catch (e) {
      console.log('[run] ' + tag + ' FAILED: ' + e.message);
    }
    // close ONLY the process tree we spawned (never /IM -- that would kill
    // the user's own browser windows)
    if (spec.close) { const k = spec.close(); await new Promise(r => { k.on('exit', r); k.on('error', r); }); continue; }
    await new Promise(r => {
      if (!WIN) {                                  // detached => own process group
        try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { }
        return setTimeout(r, 2000);
      }
      const k = spawn('taskkill', ['/F', '/PID', String(p.pid), '/T'], { stdio: 'ignore' });
      k.on('exit', () => setTimeout(r, 2000));
    });
  }
  console.log('[run] all done');
  process.exit(0);
})();
