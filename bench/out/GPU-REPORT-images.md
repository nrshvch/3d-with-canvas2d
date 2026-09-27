# GPU run of `imagepage.html`: sprites and image sources on a real GPU

Measured on 27 September 2026, 11:58–12:54 local time, on the MacBook Air that
§10.1 calls **M6**. All raw results are the `bench/out/*img*gpu*.json` files
next to this report. The tables below are generated from those files, and
every number in the answers is copied from them.

**The short version.**

- **Sprites:** `drawImage` is cheaper than pattern `fillRect` on every GPU path
  measured. The CPU ranking does not reverse. On Chromium (Skia Graphite on
  Metal) it widens, from 1.46–2.25× on the CPU to 5.9–7.2× unscaled and at
  least 15.9× rotated. SwiftShader's hint that the pattern wins does not hold on
  a real GPU.
- **Triangles:** §4.7's pattern recipe holds on Chromium, where the rows can
  be resolved, and holds by at least 16.7× on accelerated Firefox. It is **a tie
  on Safari**.
- **Source type:** on the GPU an `<img>` is no longer the slow steady-state
  source. What matters on Chromium is whether the source is a canvas. A
  pattern made from a canvas costs at most 10 ms, against 160–165 ms from an
  `<img>` or `ImageBitmap`.
- **First use:** on Chromium a 2048² `<img>` is still slow on its *second*
  draw (25.3–25.6 ms against 1.8–1.9 ms for an `ImageBitmap`), and
  `img.decode()` does nothing. `createImageBitmap` is still the only
  preparation that fixes the first draw on all three engines.
- **Two instrument problems**, both reported in full below:
  - Many A2 rows are pinned to the 100 Hz vsync. They are upper bounds, not
    costs.
  - The page's Firefox acceleration indicator cannot light on any machine,
    because its control canvas is 64×64, below Firefox's 128 px minimum for an
    accelerated canvas.

---

## Machine

Everything here was read on the day of the run. The same Mac with the same
browser builds is §10.1's M6.

| item | value |
|---|---|
| model | MacBook Air `Mac16,12` (fanless), Apple **M4** |
| CPU | 10 cores: 4 performance + 6 efficiency |
| GPU | Apple M4 integrated, 10 cores, Metal 4. Driver: Apple's Metal driver bundled with the OS (`chrome://gpu`: `DRIVER_VENDOR=Apple, DRIVER_VERSION=26.6.2`; no separate version) |
| RAM | 16 GB unified |
| OS | macOS 26.6.2 (25G83) |
| display | Dell S3422DW, external, the only active display: 3440×1440 at **100 Hz** (`chrome://gpu`: 99.98 Hz), `devicePixelRatio` **1** (Chrome `scale=1`; Firefox `graphicsDevicePixelRatios [1]`) |
| Node | 25.9.0 |
| **Chrome** (the `edge` target on macOS) | **Google Chrome 153.0.8010.54**. `chrome://gpu`: *Canvas: Hardware accelerated*; **Skia Backend: GraphiteDawnMetal** (Skia Graphite: Enabled), so this is **Graphite on Dawn/Metal**, not Ganesh; *2D graphics backend* Skia/153 `f8b66b7597c4`; `GL_RENDERER` ANGLE Metal Renderer: Apple M4; display type `ANGLE_METAL`. Read from a throwaway profile launched from the same binary |
| **Firefox** | **Firefox 156.0.1**, build 20260921121718. `about:support`, read through the Troubleshoot snapshot on a fresh profile: **ACCELERATED_CANVAS2D: available** (default); compositor WebRender; WebGL 1/2 renderer "Apple -- Apple M4", "4.1 Metal - 90.5"; Azure canvas backend `skia`. **No `gfx.canvas.accelerated.*` pref differs from its default** in a fresh profile. The bench profiles change these on purpose: `firefox-dbg` sets `gfx.canvas.accelerated.debug = true`, and `firefox-nonaccel` also sets `gfx.canvas.accelerated = false`. `gfx.canvas.accelerated.min-size` is **128** (default) |
| **Safari** | **Safari 26.6.2** (build 21624.5.1.11.3, WebKit 605.1.15), a tab in the user's own Safari. It has no acceleration indicator |

Conditions:

- The run started after the user quit their own Firefox (its GPU helper was
  at ~116 % CPU) and their own Chrome. Firefox's parent process stayed alive
  but idle, at 1–2 % CPU.
- `caffeinate -d -i` ran throughout.
- `pmset -g therm` recorded no thermal or performance warning.
- WebStorm was restarted at 12:35 and indexed at ~480 % CPU. That overlapped
  only the Safari attempt that hung. The Safari retry ran after it had
  settled, and no Chrome or Firefox run overlapped it.

## Runs

| # | command | JSON written | outcome |
|---|---|---|---|
| 1 | `PAGE=imagepage.html TAGSUFFIX=-img-gpu-r1 node bench/run.js edge firefox-dbg firefox-nonaccel` | `edge-img-gpu-r1.json`, `firefox-dbg-img-gpu-r1.json`, `firefox-nonaccel-img-gpu-r1.json` | all finished (12:00:17, 12:02:09, 12:04:01) |
| 2 | `PAGE=imagepage.html TAGSUFFIX=-img-gpu-r2 node bench/run.js edge firefox-dbg` | `edge-img-gpu-r2.json`, `firefox-dbg-img-gpu-r2.json` | finished (12:06:29, 12:08:21) |
| 3 | `PAGE=imagepage.html TAGSUFFIX=-img-gpu-r3 node bench/run.js edge firefox-dbg` | `edge-img-gpu-r3.json`, `firefox-dbg-img-gpu-r3.json` | finished (12:10:38, 12:12:46) |
| 4 | `PAGE=imagepage.html TAGSUFFIX=-imgF-gpu-r1 EXTRA=parts=F node bench/run.js edge firefox-dbg` | `edge-imgF-gpu-r1.json`, `firefox-dbg-imgF-gpu-r1.json` | finished (12:13:12, 12:13:23) |
| 5 | `PAGE=imagepage.html TAGSUFFIX=-imgF-gpu-r2 EXTRA=parts=F node bench/run.js edge firefox-dbg` | `edge-imgF-gpu-r2.json`, `firefox-dbg-imgF-gpu-r2.json` | finished (12:13:37, 12:13:43) |
| 6 | `PAGE=imagepage.html TAGSUFFIX=-img-gpu-r1 node bench/run.js safari` | none | **hung.** The tab sat open from ~12:14 to ~12:37 while its WebKit process stayed idle; the window was evidently not in front, so it got no animation frames. Ended with exit code 144 when Safari was restarted. |
| 7 | the same command, rerun once with the Safari window in front | `safari-img-gpu-r1.json` | finished (12:49:43) |
| 8 | `PAGE=imagepage.html TAGSUFFIX=-img-gpu-r4 node bench/run.js edge firefox-dbg`, **an extra repetition** not in the brief, to test whether Firefox r3 was an outlier | `edge-img-gpu-r4.json`, `firefox-dbg-img-gpu-r4.json` | finished (12:52:10, 12:54:05) |

There were also three **side checks with no timing in them**. None of them is
in `bench/`. They are described in the appendix:

- a dump of `chrome://gpu` over the DevTools protocol;
- Firefox's Troubleshoot snapshot (the data behind `about:support`), read over
  WebDriver BiDi;
- an **indicator probe** that reads Firefox's debug square on control canvases
  of several sizes.

## Sanity checks

| file | `error` | indicator | identity: channels differing vs img-png | S+T rows, min `frames` | rows at vsync (frames ≥ 340) | verdicts seen |
|---|---|---|---|---|--:|---|
| `edge-img-gpu-r1.json` | none | false | img-png 0, img-jpg 747026, bitmap 0, canvas 0 | 24, min 22 | 5 | - |
| `edge-img-gpu-r2.json` | none | false | img-png 0, img-jpg 747026, bitmap 0, canvas 0 | 24, min 22 | 7 | - |
| `edge-img-gpu-r3.json` | none | false | img-png 0, img-jpg 747026, bitmap 0, canvas 0 | 24, min 22 | 6 | - |
| `edge-img-gpu-r4.json` | none | false | img-png 0, img-jpg 747026, bitmap 0, canvas 0 | 24, min 22 | 7 | - |
| `edge-imgF-gpu-r1.json` | none | false | img-png 0, img-jpg 747026, bitmap 0, canvas 0 | none (part F only) | n/a | - |
| `edge-imgF-gpu-r2.json` | none | false | img-png 0, img-jpg 747026, bitmap 0, canvas 0 | none (part F only) | n/a | - |
| `firefox-dbg-img-gpu-r1.json` | none | false | img-png 0, img-jpg 723755, bitmap 0, canvas 0 | 24, min 6 | 8 | - |
| `firefox-dbg-img-gpu-r2.json` | none | false | img-png 0, img-jpg 723755, bitmap 0, canvas 0 | 24, min 7 | 8 | - |
| `firefox-dbg-img-gpu-r3.json` | none | false | img-png 0, img-jpg 723755, bitmap 0, canvas 0 | 24, min 4 | 8 | - |
| `firefox-dbg-img-gpu-r4.json` | none | false | img-png 0, img-jpg 723755, bitmap 0, canvas 0 | 24, min 5 | 8 | - |
| `firefox-dbg-imgF-gpu-r1.json` | none | false | img-png 0, img-jpg 723755, bitmap 0, canvas 0 | none (part F only) | n/a | - |
| `firefox-dbg-imgF-gpu-r2.json` | none | false | img-png 0, img-jpg 723755, bitmap 0, canvas 0 | none (part F only) | n/a | - |
| `firefox-nonaccel-img-gpu-r1.json` | none | false | img-png 0, img-jpg 723755, bitmap 0, canvas 0 | 24, min 30 | 0 | - |
| `safari-img-gpu-r1.json` | none | false | img-png 0, img-jpg 735597, bitmap 0, canvas 0 | 24, min 6 | 8 | - |

1. **Every JSON file exists and has no `error` field.** All 14 files pass.
2. **The decoded-pixel identity rows are present in every file.** `img-png`,
   `bitmap` and `canvas` have `channelsDiffering: 0` in all 14. `img-jpg`
   differs as a JPEG should: 747 026 channels on Chromium, 723 755 on Firefox,
   735 597 on Safari.
3. **Every sustained row has `frames >= 4`.** Pass. The minimum is 4
   (`firefox-dbg-img-gpu-r3`). The frame count does, however, expose a
   different problem, the **vsync floor**. In 5–7 Chromium rows per run, 8
   accelerated-Firefox rows per run and 8 Safari rows, the page ran at the
   display's full 100 Hz (≥ 340 frames in the ~3.5 s window, and reps × A2 =
   10.0 ms). In those rows the workload finished inside one frame, and A2 is
   10 ms ÷ reps: **an upper bound on the cost, not the cost.** They are marked
   † in every table. See Q6 and the Caveats for why the page does this on a
   GPU.
4. **Firefox acceleration indicator on the control canvas: `false`** in every
   Firefox file, under both profiles. Every per-case verdict is therefore
   `-`: **no case has a verdict, so no case is known to be `soft`.**
   - **This does not mean Firefox is unaccelerated here.** The page's control
     canvas is 64×64 (`imagepage.html`), below
     `gfx.canvas.accelerated.min-size` = 128.
   - The indicator probe (appendix) shows the square staying **off** at 64×64
     and 127×127 and lighting **on** at 128×128 and 1280×720, on-screen,
     off-screen and detached alike. It stays off at every size under the
     software profile.
   - So a 1280×720 case canvas *starts* accelerated under `firefox-dbg` on
     this machine. Whether each one *stayed* accelerated was **not
     measured**.
   - The Firefox accelerated timings below are therefore labelled
     *accelerated profile, verdict unmeasured*, not verified GPU numbers.
5. **Chromium A2 spread across the 4 repetitions** is in the `A2 min–max`
   column of every Chromium table.
   - Among rows that are not floored, the widest spreads are `drawImage` from
     a canvas, 1.375–1.55 ms (12.7 %), and `pattern fill` from `img-jpg`,
     1.352–1.49 ms (10.2 %).
   - Every other row is within 5.9 %.
   - The floored rows spread by 0.0–0.1 %, because they measure the display.
   - Differences under ~10 % are read as noise in the answers.

## Tables

- **A1** is record, **A2** sustained and **A3** raster (§8.1), all in ms per
  frame of the workload.
- **per rAF** is reps × A2, the wall time of one animation frame. It is
  derived from the JSON's `reps` and `sustMs`. At 100 Hz, 10.0 means the page
  was pinned to vsync. §8.1 asks for ≥ 50 ms of work per frame.
- **†** marks a row-repetition that ran at the display rate (`frames` ≥ 340).
  Its A2 is an upper bound.
- In repeated runs a cell lists r1 / r2 / r3 / r4 in that order.
- The Firefox rows have no verdict column: the indicator was `false` (sanity
  check 4), so the page recorded `-` for every case.
- Firefox and Safari report `performance.now()` at 1 ms resolution on this
  page. Their A1 of 0 or 0.333 is 0 or 1 tick over 3 iterations, and their F
  values are whole milliseconds.

### Chromium — Chrome 153, Skia Graphite on Dawn/Metal (`edge` target)

**Sprites (part S, S19).** `edge-img-gpu-r1.json`, `edge-img-gpu-r2.json`, `edge-img-gpu-r3.json`, `edge-img-gpu-r4.json` (values in a cell are r1 / r2 / r3 / r4). ms per frame of the workload.

| recipe | source | A1 record | A2 sustained | A2 min–max | A3 raster | per rAF (reps × A2) |
|---|---|--:|--:|--:|--:|--:|
| drawImage | img-png | 0.367 / 0.333 / 0.4 / 0.367 | 1.652 / 1.682 / 1.64 / 1.631 | 1.631–1.682 | 7.25 / 7.25 / 7.25 / 7.3 | 14.9 / 15.1 / 14.8 / 14.7 |
| drawImage | img-jpg | 0.4 / 0.367 / 0.367 / 0.367 | 1.645 / 1.734 / 1.654 / 1.641 | 1.641–1.734 | 7.4 / 7.45 / 7.25 / 7.35 | 14.8 / 15.6 / 14.9 / 14.8 |
| drawImage | bitmap | 0.5 / 0.467 / 0.5 / 0.5 | 1.768 / 1.813 / 1.79 / 1.775 | 1.768–1.813 | 4.25 / 4.25 / 4.15 / 4.25 | 26.5 / 27.2 / 26.9 / 26.6 |
| drawImage | canvas | 0.467 / 0.467 / 0.4 / 0.433 | 1.407 / 1.55 / 1.404 / 1.375 | 1.375–1.55 | 2.9 / 3.15 / 3.05 / 2.85 | 29.5 / 31 / 28.1 / 30.3 |
| pattern fillRect | img-png | 0.233 / 0.233 / 0.267 / 0.267 | 11.695 / 11.799 / 11.691 / 11.747 | 11.691–11.799 | 11.6 / 11.5 / 11.45 / 11.55 | 70.2 / 70.8 / 70.1 / 70.5 |
| pattern fillRect | img-jpg | 0.267 / 0.267 / 0.233 / 0.267 | 11.837 / 11.763 / 11.642 / 11.773 | 11.642–11.837 | 11.5 / 11.6 / 11.45 / 11.55 | 71 / 70.6 / 69.9 / 70.6 |
| pattern fillRect | bitmap | 0.233 / 0.233 / 0.267 / 0.233 | 10.782 / 10.848 / 10.777 / 10.866 | 10.777–10.866 | 10.55 / 10.6 / 10.6 / 10.65 | 64.7 / 65.1 / 64.7 / 65.2 |
| pattern fillRect | canvas | 0.3 / 0.233 / 0.233 / 0.233 | 10.002† / 10.004† / 10.002† / 10.002† | 10.002–10.004† | 724.8 / 747.95 / 755.45 / 742.05 | 10 / 10 / 10 / 10 |
| drawImage rot+1.5x | img-png | 0.5 / 0.533 / 0.5 / 0.533 | 10.002† / 10.005† / 10.003† / 10.002† | 10.002–10.005† | 72.25 / 72.3 / 71.95 / 73.15 | 10 / 10 / 10 / 10 |
| drawImage rot+1.5x | img-jpg | 0.5 / 0.533 / 0.533 / 0.533 | 9.999† / 10.004† / 9.993† / 10.005† | 9.993–10.005† | 72.55 / 72.35 / 71.8 / 72.75 | 10 / 10 / 10 / 10 |
| drawImage rot+1.5x | bitmap | 0.6 / 0.6 / 0.633 / 0.633 | 10.002† / 10.003† / 10.002† / 10.002† | 10.002–10.003† | 67.05 / 66.65 / 66.45 / 67.3 | 10 / 10 / 10 / 10 |
| drawImage rot+1.5x | canvas | 0.633 / 0.667 / 0.667 / 0.633 | 1.738 / 1.772 / 1.704 / 1.682 | 1.682–1.772 | 4.45 / 4.9 / 4.9 / 4.85 | 24.3 / 23 / 22.2 / 21.9 |
| pattern rot+1.5x | img-png | 0.3 / 0.267 / 0.3 / 0.3 | 164.309 / 162.559 / 162.368 / 164.718 | 162.368–164.718 | 159.05 / 160.05 / 158.95 / 161.05 | 164.3 / 162.6 / 162.4 / 164.7 |
| pattern rot+1.5x | img-jpg | 0.3 / 0.267 / 0.267 / 0.3 | 162.582 / 162.109 / 162.309 / 163.614 | 162.109–163.614 | 159.5 / 158.9 / 158.55 / 160.9 | 162.6 / 162.1 / 162.3 / 163.6 |
| pattern rot+1.5x | bitmap | 0.333 / 0.267 / 0.267 / 0.267 | 160.386 / 160.386 / 159.682 / 161.795 | 159.682–161.795 | 157 / 157.4 / 157 / 158.9 | 160.4 / 160.4 / 159.7 / 161.8 |
| pattern rot+1.5x | canvas | 0.3 / 0.267 / 0.3 / 0.267 | 10.06† / 10.059† / 10.061† / 10.06† | 10.059–10.061† | 909 / 908.2 / 907.9 / 916.25 | 10.1 / 10.1 / 10.1 / 10.1 |

**Triangles (part T, S20).** `edge-img-gpu-r1.json`, `edge-img-gpu-r2.json`, `edge-img-gpu-r3.json`, `edge-img-gpu-r4.json` (values in a cell are r1 / r2 / r3 / r4). ms per frame of the workload.

| recipe | source | A1 record | A2 sustained | A2 min–max | A3 raster | per rAF (reps × A2) |
|---|---|--:|--:|--:|--:|--:|
| clip + drawImage | img-png | 0.633 / 0.667 / 0.667 / 0.667 | 1.64 / 1.669† / 1.605 / 1.677† | 1.605–1.677† | 9.85 / 10.2 / 9.85 / 10 | 11.5 / 10 / 11.2 / 10.1 |
| clip + drawImage | img-jpg | 0.633 / 0.633 / 0.633 / 0.6 | 1.648 / 1.692† / 1.677† / 1.67† | 1.648–1.692† | 9.8 / 10.35 / 10.4 / 10 | 11.5 / 10.2 / 10.1 / 10 |
| clip + drawImage | bitmap | 0.767 / 0.7 / 0.7 / 0.7 | 1.799 / 1.772 / 1.747 / 1.736 | 1.736–1.799 | 10.35 / 9.8 / 9.4 / 9.55 | 10.8 / 12.4 / 12.2 / 12.2 |
| clip + drawImage | canvas | 0.667 / 0.667 / 0.667 / 0.667 | 1.555 / 1.56 / 1.537 / 1.473 | 1.473–1.56 | 3.9 / 4.05 / 3.5 / 3.35 | 24.9 / 23.4 / 27.7 / 26.5 |
| pattern fill | img-png | 0.3 / 0.233 / 0.267 / 0.233 | 1.299 / 1.327 / 1.291 / 1.261 | 1.261–1.327 | 3.05 / 3.95 / 3.9 / 3.2 | 26 / 21.2 / 20.7 / 24 |
| pattern fill | img-jpg | 0.267 / 0.233 / 0.233 / 0.233 | 1.49 / 1.448 / 1.415 / 1.352 | 1.352–1.49 | 3.45 / 3.85 / 4.1 / 3.6 | 26.8 / 23.2 / 21.2 / 23 |
| pattern fill | bitmap | 0.233 / 0.233 / 0.233 / 0.233 | 1.362 / 1.413 / 1.391 / 1.351 | 1.351–1.413 | 2.75 / 2.95 / 2.8 / 2.85 | 30 / 29.7 / 30.6 / 29.7 |
| pattern fill | canvas | 0.267 / 0.233 / 0.233 / 0.233 | 1.165 / 1.157 / 1.155 / 1.175 | 1.155–1.175 | 2.75 / 2.85 / 2.75 / 2.6 | 25.6 / 25.5 / 25.4 / 28.2 |

**First use (part F, A10, S21).** `edge-img-gpu-r1.json`, `edge-img-gpu-r2.json`, `edge-img-gpu-r3.json`, `edge-img-gpu-r4.json`, `edge-imgF-gpu-r1.json`, `edge-imgF-gpu-r2.json`; values in a cell are r1 / r2 / r3 / r4 / F-r1 / F-r2. Median of 7 trials, ms. Source: PNG 5487772 B, JPEG 1926943 B.

| preparation | prep | block | **first** | second |
|---|--:|--:|--:|--:|
| img-png (onload only) | 1.8 / 1.4 / 1.5 / 1.4 / 2.1 / 2.9 | 0 / 0 / 0 / 0 / 0 / 0 | 28.5 / 28.7 / 28.8 / 28.5 / 39 / 68.5 | 25.3 / 25.4 / 25.5 / 25.6 / 33.6 / 66.5 |
| img-png + decode() | 26.6 / 26.2 / 26.3 / 26.3 / 41 / 67.4 | 0 / 0 / 0 / 0 / 0 / 0 | 29 / 28.4 / 28.5 / 28.4 / 45.2 / 69.2 | 25.8 / 25.4 / 25.4 / 25.7 / 40.8 / 67.1 |
| img-jpg (onload only) | 0.9 / 0.9 / 0.9 / 0.9 / 1.2 / 1.6 | 0 / 0 / 0 / 0 / 0 / 0 | 16.8 / 17 / 16.7 / 16.6 / 33.3 / 39.7 | 18.6 / 17.8 / 17.7 / 17.8 / 38.9 / 46.1 |
| img-jpg + decode() | 15 / 14.5 / 14.5 / 14.6 / 31.9 / 37.3 | 0 / 0 / 0 / 0 / 0 / 0 | 17.3 / 17.2 / 16.9 / 16.9 / 35 / 40 | 18.4 / 17.8 / 17.8 / 17.8 / 39.2 / 46.2 |
| img-png, 1:1 draw | 1.5 / 1.4 / 1.5 / 1.3 / 2.6 / 2.9 | 0 / 0 / 0 / 0 / 0 / 0 | 29 / 28.6 / 28.5 / 28.5 / 57.1 / 68.1 | 24.3 / 23.8 / 23.9 / 24 / 51.3 / 62.2 |
| img-png + decode(), 1:1 | 26.7 / 26.4 / 26.2 / 26.1 / 49.5 / 68.9 | 0 / 0 / 0 / 0 / 0 / 0 | 28.9 / 28.4 / 28.4 / 28.4 / 51.3 / 68.9 | 24.3 / 23.9 / 24 / 24 / 46.4 / 62.6 |
| bitmap (png blob) | 25.1 / 25.1 / 25.1 / 25 / 49 / 66.8 | 0 / 0 / 0 / 0 / 0 / 0 | 4.3 / 3.9 / 3.8 / 3.5 / 4.2 / 4.8 | 1.9 / 1.8 / 1.8 / 1.8 / 3.3 / 4.6 |
| bitmap (jpg blob) | 16.3 / 16.2 / 16.2 / 16.1 / 30.8 / 41.9 | 0 / 0 / 0 / 0 / 0 / 0 | 3.2 / 3 / 3.7 / 3.1 / 4.7 / 5 | 1.8 / 1.8 / 1.8 / 1.8 / 3.6 / 4.8 |
| bitmap (from decoded img) | 51.6 / 51.2 / 51.1 / 51 / 97.8 / 84.1 | 0 / 0 / 0 / 0 / 0 / 0 | 4 / 3.9 / 4 / 3.9 / 4.6 / 5.6 | 1.8 / 1.8 / 1.8 / 1.8 / 3.7 / 3.1 |
| canvas (img drawn in) | 29.4 / 29.1 / 28.9 / 28.9 / 56.1 / 35.7 | 27.8 / 27.6 / 27.5 / 27.5 / 54.1 / 33.1 | 1.4 / 1.4 / 1.4 / 1.7 / 2.9 / 2 | 2.4 / 2.5 / 2.5 / 2.6 / 3.6 / 2.4 |

**Bleed (part X).** `edge-img-gpu-r1.json`, `edge-img-gpu-r2.json`, `edge-img-gpu-r3.json`, `edge-img-gpu-r4.json` (r1 / r2 / r3 / r4; "(all)" = identical in every repetition).

| recipe | source | px0 (> 0) | px16 (> 16) | maxD |
|---|---|--:|--:|--:|
| drawImage | img-png | 0 (all) | 0 (all) | 0 (all) |
| drawImage | bitmap | 0 (all) | 0 (all) | 0 (all) |
| drawImage | canvas | 0 (all) | 0 (all) | 0 (all) |
| pattern fillRect | img-png | 0 (all) | 0 (all) | 0 (all) |
| pattern fillRect | bitmap | 0 (all) | 0 (all) | 0 (all) |
| pattern fillRect | canvas | 0 (all) | 0 (all) | 0 (all) |
| drawImage rot+1.5x | img-png | 45046 (all) | 35945 (all) | 124 (all) |
| drawImage rot+1.5x | bitmap | 45046 (all) | 35945 (all) | 124 (all) |
| drawImage rot+1.5x | canvas | 43728 (all) | 36215 (all) | 114 (all) |
| pattern rot+1.5x | img-png | 46830 (all) | 37473 (all) | 119 (all) |
| pattern rot+1.5x | bitmap | 46830 (all) | 37473 (all) | 119 (all) |
| pattern rot+1.5x | canvas | 46830 (all) | 37473 (all) | 119 (all) |

### Firefox 156.0.1, accelerated profile with the debug square (`firefox-dbg`)

**Sprites (part S, S19).** `firefox-dbg-img-gpu-r1.json`, `firefox-dbg-img-gpu-r2.json`, `firefox-dbg-img-gpu-r3.json`, `firefox-dbg-img-gpu-r4.json` (values in a cell are r1 / r2 / r3 / r4). ms per frame of the workload.

| recipe | source | A1 record | A2 sustained | A2 min–max | A3 raster | per rAF (reps × A2) |
|---|---|--:|--:|--:|--:|--:|
| drawImage | img-png | 0.333 / 0 / 0 / 0 | 1.472 / 1.513 / 1.5 / 1.483 | 1.472–1.513 | 7.5 / 6.5 / 6.5 / 6.5 | 11.8 / 15.1 / 15 / 14.8 |
| drawImage | img-jpg | 0 / 0 / 0 / 0 | 1.445 / 1.489 / 1.456 / 1.454 | 1.445–1.489 | 4 / 3.5 / 3.5 / 4 | 21.7 / 26.8 / 26.2 / 21.8 |
| drawImage | bitmap | 0 / 0 / 0 / 0 | 1.423 / 1.469 / 1.443 / 1.453 | 1.423–1.469 | 6 / 6.5 / 6.5 / 6 | 14.2 / 14.7 / 14.4 / 14.5 |
| drawImage | canvas | 0 / 0 / 0 / 0 | 1.432 / 1.49 / 1.476 / 1.459 | 1.432–1.49 | 4 / 4 / 4 / 4 | 21.5 / 22.4 / 22.1 / 21.9 |
| pattern fillRect | img-png | 0 / 0 / 0 / 0 | 1.498 / 1.553 / 1.483 / 1.479 | 1.479–1.553 | 6.5 / 6.5 / 6.5 / 6.5 | 15 / 15.5 / 14.8 / 14.8 |
| pattern fillRect | img-jpg | 0 / 0 / 0 / 0 | 1.691 / 1.733 / 1.743 / 1.648 | 1.648–1.743 | 4 / 4 / 4 / 4 | 25.4 / 26 / 26.1 / 24.7 |
| pattern fillRect | bitmap | 0 / 0 / 0 / 0 | 1.553 / 1.596 / 1.564 / 1.529 | 1.529–1.596 | 6 / 6.5 / 6 / 6.5 | 15.5 / 16 / 15.6 / 15.3 |
| pattern fillRect | canvas | 0 / 0 / 0 / 0 | 1.525 / 1.583 / 1.733 / 1.508 | 1.508–1.733 | 4.5 / 4.5 / 4 / 3.5 | 21.3 / 22.2 / 26 / 27.1 |
| drawImage rot+1.5x | img-png | 0 / 0 / 0 / 0 | 5.001† / 10† / 10† / 5.001† | 5.001–10† | 59 / 60 / 60.5 / 59.5 | 10 / 10 / 10 / 10 |
| drawImage rot+1.5x | img-jpg | 0.333 / 0 / 0 / 0 | 5.001† / 5† / 5† / 5.001† | 5–5.001† | 54 / 54.5 / 54.5 / 55 | 10 / 10 / 10 / 10 |
| drawImage rot+1.5x | bitmap | 0 / 0 / 0 / 0 | 5† / 5.001† / 5.001† / 5.001† | 5–5.001† | 58.5 / 58 / 58.5 / 59 | 10 / 10 / 10 / 10 |
| drawImage rot+1.5x | canvas | 0.333 / 0 / 0.333 / 0 | 5.001† / 4.999† / 5.001† / 5† | 4.999–5.001† | 54 / 54.5 / 54.5 / 54.5 | 10 / 10 / 10 / 10 |
| pattern rot+1.5x | img-png | 0.333 / 0 / 0 / 0 | 5.001† / 5† / 5.001† / 5.003† | 5–5.003† | 58 / 58.5 / 58.5 / 59 | 10 / 10 / 10 / 10 |
| pattern rot+1.5x | img-jpg | 0 / 0 / 0 / 0 | 5.001† / 5.001† / 5.001† / 5† | 5–5.001† | 54 / 54 / 55 / 54.5 | 10 / 10 / 10 / 10 |
| pattern rot+1.5x | bitmap | 0 / 0 / 0 / 0 | 5† / 5.001† / 5.001† / 5.004† | 5–5.004† | 58.5 / 58.5 / 58.5 / 59.5 | 10 / 10 / 10 / 10 |
| pattern rot+1.5x | canvas | 0 / 0 / 0 / 0 | 5.001† / 5† / 5† / 5.001† | 5–5.001† | 54 / 54 / 55 / 54.5 | 10 / 10 / 10 / 10 |

**Triangles (part T, S20).** `firefox-dbg-img-gpu-r1.json`, `firefox-dbg-img-gpu-r2.json`, `firefox-dbg-img-gpu-r3.json`, `firefox-dbg-img-gpu-r4.json` (values in a cell are r1 / r2 / r3 / r4). ms per frame of the workload.

| recipe | source | A1 record | A2 sustained | A2 min–max | A3 raster | per rAF (reps × A2) |
|---|---|--:|--:|--:|--:|--:|
| clip + drawImage | img-png | 0 / 0.333 / 0.333 / 0.333 | 71.107 / 71.5 / 72.694 / 86.792 | 71.107–86.792 | 8.5 / 8.5 / 9 / 8 | 568.9 / 572 / 508.9 / 694.3 |
| clip + drawImage | img-jpg | 0.333 / 0.333 / 0.333 / 0.333 | 72.786 / 71.054 / 160.656 / 87.525 | 71.054–160.656 | 8.5 / 8.5 / 8 / 8.5 | 582.3 / 568.4 / 1285.2 / 700.2 |
| clip + drawImage | bitmap | 0.333 / 0.333 / 0.333 / 0 | 71.964 / 71.714 / 169.143 / 86.667 | 71.714–169.143 | 8.5 / 8.5 / 9 / 8.5 | 575.7 / 573.7 / 1184 / 693.3 |
| clip + drawImage | canvas | 0.333 / 0.333 / 0.333 / 0.333 | 73.583 / 72.661 / 167.281 / 88.8 | 72.661–167.281 | 8 / 7.5 / 8.5 / 8 | 588.7 / 581.3 / 1338.2 / 710.4 |
| pattern fill | img-png | 0 / 0 / 0 / 0 | 2.612 / 2.626 / 4.042 / 2.682 | 2.612–4.042 | 4.5 / 4.5 / 5 / 4.5 | 36.6 / 36.8 / 48.5 / 37.5 |
| pattern fill | img-jpg | 0 / 0 / 0 / 0 | 2.593 / 2.616 / 4.168 / 2.672 | 2.593–4.168 | 4 / 4 / 5 / 3.5 | 38.9 / 39.2 / 50 / 48.1 |
| pattern fill | bitmap | 0 / 0 / 0 / 0 | 2.586 / 2.6 / 4.293 / 2.689 | 2.586–4.293 | 4 / 4.5 / 6 / 4.5 | 38.8 / 36.4 / 42.9 / 37.6 |
| pattern fill | canvas | 0 / 0 / 0 / 0 | 2.601 / 2.623 / 4.337 / 2.696 | 2.601–4.337 | 3.5 / 4 / 5 / 3.5 | 46.8 / 39.3 / 52 / 48.5 |

**First use (part F, A10, S21).** `firefox-dbg-img-gpu-r1.json`, `firefox-dbg-img-gpu-r2.json`, `firefox-dbg-img-gpu-r3.json`, `firefox-dbg-img-gpu-r4.json`, `firefox-dbg-imgF-gpu-r1.json`, `firefox-dbg-imgF-gpu-r2.json`; values in a cell are r1 / r2 / r3 / r4 / F-r1 / F-r2. Median of 7 trials, ms. Source: PNG 5415491 B, JPEG 3601293 B.

| preparation | prep | block | **first** | second |
|---|--:|--:|--:|--:|
| img-png (onload only) | 1 / 1 / 1 / 1 / 2 / 1 | 0 / 0 / 0 / 0 / 0 / 0 | 33 / 33 / 42 / 34 / 78 / 34 | 1 / 1 / 5 / 1 / 2 / 1 |
| img-png + decode() | 30 / 30 / 33 / 29 / 77 / 31 | 0 / 0 / 0 / 0 / 0 / 0 | 4 / 4 / 8 / 4 / 7 / 4 | 2 / 2 / 5 / 2 / 3 / 1 |
| img-jpg (onload only) | 1 / 1 / 1 / 1 / 1 / 1 | 0 / 0 / 0 / 0 / 0 / 0 | 33 / 31 / 38 / 31 / 70 / 33 | 2 / 2 / 5 / 3 / 4 / 2 |
| img-jpg + decode() | 28 / 27 / 29 / 27 / 61 / 28 | 0 / 0 / 0 / 0 / 0 / 0 | 4 / 5 / 8 / 4 / 7 / 4 | 1 / 1 / 4 / 2 / 4 / 1 |
| img-png, 1:1 draw | 1 / 1 / 1 / 1 / 2 / 1 | 0 / 0 / 0 / 0 / 0 / 0 | 33 / 32 / 41 / 33 / 75 / 32 | 1 / 1 / 3 / 2 / 3 / 1 |
| img-png + decode(), 1:1 | 30 / 30 / 34 / 29 / 66 / 31 | 0 / 0 / 0 / 0 / 0 / 0 | 4 / 4 / 9 / 3 / 8 / 4 | 2 / 2 / 5 / 1 / 3 / 1 |
| bitmap (png blob) | 29 / 29 / 35 / 29 / 65 / 29 | 0 / 0 / 0 / 0 / 0 / 0 | 4 / 4 / 8 / 4 / 7 / 5 | 2 / 2 / 4 / 1 / 3 / 2 |
| bitmap (jpg blob) | 27 / 27 / 32 / 27 / 61 / 27 | 0 / 0 / 0 / 0 / 0 / 0 | 5 / 4 / 8 / 4 / 6 / 4 | 1 / 1 / 5 / 1 / 3 / 2 |
| bitmap (from decoded img) | 30 / 29 / 36 / 29 / 69 / 29 | 0 / 0 / 0 / 0 / 0 / 0 | 3 / 5 / 7 / 3 / 7 / 4 | 2 / 2 / 4 / 1 / 3 / 2 |
| canvas (img drawn in) | 36 / 36 / 51 / 34 / 79 / 36 | 35 / 35 / 50 / 33 / 77 / 35 | 2 / 2 / 4 / 2 / 5 / 3 | 2 / 2 / 3 / 2 / 3 / 1 |

**Bleed (part X).** `firefox-dbg-img-gpu-r1.json`, `firefox-dbg-img-gpu-r2.json`, `firefox-dbg-img-gpu-r3.json`, `firefox-dbg-img-gpu-r4.json` (r1 / r2 / r3 / r4; "(all)" = identical in every repetition).

| recipe | source | px0 (> 0) | px16 (> 16) | maxD |
|---|---|--:|--:|--:|
| drawImage | img-png | 0 (all) | 0 (all) | 0 (all) |
| drawImage | bitmap | 0 (all) | 0 (all) | 0 (all) |
| drawImage | canvas | 0 (all) | 0 (all) | 0 (all) |
| pattern fillRect | img-png | 0 (all) | 0 (all) | 0 (all) |
| pattern fillRect | bitmap | 0 (all) | 0 (all) | 0 (all) |
| pattern fillRect | canvas | 0 (all) | 0 (all) | 0 (all) |
| drawImage rot+1.5x | img-png | 0 (all) | 0 (all) | 0 (all) |
| drawImage rot+1.5x | bitmap | 0 (all) | 0 (all) | 0 (all) |
| drawImage rot+1.5x | canvas | 0 (all) | 0 (all) | 0 (all) |
| pattern rot+1.5x | img-png | 0 (all) | 0 (all) | 0 (all) |
| pattern rot+1.5x | bitmap | 0 (all) | 0 (all) | 0 (all) |
| pattern rot+1.5x | canvas | 45063 (all) | 35953 (all) | 124 (all) |

### Firefox 156.0.1, software (`firefox-nonaccel`)

**Sprites (part S, S19).** `firefox-nonaccel-img-gpu-r1.json`. ms per frame of the workload.

| recipe | source | A1 record | A2 sustained | A3 raster | per rAF (reps × A2) |
|---|---|--:|--:|--:|--:|
| drawImage | img-png | 6.667 | 6.687 | 7 | 60.2 |
| drawImage | img-jpg | 4 | 4.305 | 4 | 64.6 |
| drawImage | bitmap | 6.333 | 6.535 | 6 | 65.3 |
| drawImage | canvas | 4 | 4.067 | 3.5 | 61 |
| pattern fillRect | img-png | 6 | 6.713 | 6 | 67.1 |
| pattern fillRect | img-jpg | 4 | 4.38 | 4 | 65.7 |
| pattern fillRect | bitmap | 6 | 6.64 | 6.5 | 66.4 |
| pattern fillRect | canvas | 3.667 | 4.042 | 3.5 | 68.7 |
| drawImage rot+1.5x | img-png | 58.667 | 58.933 | 59 | 117.9 |
| drawImage rot+1.5x | img-jpg | 54.333 | 54.719 | 54 | 109.4 |
| drawImage rot+1.5x | bitmap | 58.333 | 59 | 58.5 | 118 |
| drawImage rot+1.5x | canvas | 53.667 | 54.606 | 54 | 109.2 |
| pattern rot+1.5x | img-png | 58 | 59.033 | 58.5 | 118.1 |
| pattern rot+1.5x | img-jpg | 54.333 | 54.781 | 54 | 109.6 |
| pattern rot+1.5x | bitmap | 58.333 | 59.033 | 58 | 118.1 |
| pattern rot+1.5x | canvas | 53.667 | 54.682 | 53.5 | 109.4 |

**Triangles (part T, S20).** `firefox-nonaccel-img-gpu-r1.json`. ms per frame of the workload.

| recipe | source | A1 record | A2 sustained | A3 raster | per rAF (reps × A2) |
|---|---|--:|--:|--:|--:|
| clip + drawImage | img-png | 8 | 8.457 | 8 | 67.7 |
| clip + drawImage | img-jpg | 8 | 8.366 | 8 | 66.9 |
| clip + drawImage | bitmap | 8.333 | 8.577 | 8 | 68.6 |
| clip + drawImage | canvas | 7.667 | 8.123 | 8 | 65 |
| pattern fill | img-png | 4.333 | 4.464 | 4 | 62.5 |
| pattern fill | img-jpg | 3.667 | 4.061 | 4 | 60.9 |
| pattern fill | bitmap | 4 | 4.457 | 4.5 | 62.4 |
| pattern fill | canvas | 3.667 | 3.929 | 3.5 | 66.8 |

**First use (part F, A10, S21).** `firefox-nonaccel-img-gpu-r1.json`; values in a cell are r1. Median of 7 trials, ms. Source: PNG 5415491 B, JPEG 3601293 B.

| preparation | prep | block | **first** | second |
|---|--:|--:|--:|--:|
| img-png (onload only) | 1 | 0 | 30 | 2 |
| img-png + decode() | 29 | 0 | 1 | 2 |
| img-jpg (onload only) | 0 | 0 | 27 | 1 |
| img-jpg + decode() | 27 | 0 | 1 | 1 |
| img-png, 1:1 draw | 1 | 0 | 29 | 0 |
| img-png + decode(), 1:1 | 29 | 0 | 0 | 0 |
| bitmap (png blob) | 28 | 0 | 1 | 2 |
| bitmap (jpg blob) | 27 | 0 | 2 | 1 |
| bitmap (from decoded img) | 30 | 0 | 2 | 1 |
| canvas (img drawn in) | 32 | 31 | 1 | 1 |

**Bleed (part X).** `firefox-nonaccel-img-gpu-r1.json`.

| recipe | source | px0 (> 0) | px16 (> 16) | maxD |
|---|---|--:|--:|--:|
| drawImage | img-png | 0 | 0 | 0 |
| drawImage | bitmap | 0 | 0 | 0 |
| drawImage | canvas | 0 | 0 | 0 |
| pattern fillRect | img-png | 0 | 0 | 0 |
| pattern fillRect | bitmap | 0 | 0 | 0 |
| pattern fillRect | canvas | 0 | 0 | 0 |
| drawImage rot+1.5x | img-png | 0 | 0 | 0 |
| drawImage rot+1.5x | bitmap | 0 | 0 | 0 |
| drawImage rot+1.5x | canvas | 0 | 0 | 0 |
| pattern rot+1.5x | img-png | 0 | 0 | 0 |
| pattern rot+1.5x | bitmap | 0 | 0 | 0 |
| pattern rot+1.5x | canvas | 45063 | 35953 | 124 |

### Safari 26.6.2 (`safari`)

**Sprites (part S, S19).** `safari-img-gpu-r1.json`. ms per frame of the workload.

| recipe | source | A1 record | A2 sustained | A3 raster | per rAF (reps × A2) |
|---|---|--:|--:|--:|--:|
| drawImage | img-png | 0.333 | 10.003† | 62.5 | 10 |
| drawImage | img-jpg | 0.333 | 5.001† | 55 | 10 |
| drawImage | bitmap | 0 | 10.003† | 162.5 | 10 |
| drawImage | canvas | 0 | 10.003† | 163 | 10 |
| pattern fillRect | img-png | 0 | 163.682 | 75 | 163.7 |
| pattern fillRect | img-jpg | 0 | 163.955 | 73 | 164 |
| pattern fillRect | bitmap | 0 | 165.333 | 16.5 | 661.3 |
| pattern fillRect | canvas | 0.333 | 165.417 | 16 | 661.7 |
| drawImage rot+1.5x | img-png | 0.333 | 10.003† | 145.5 | 10 |
| drawImage rot+1.5x | img-jpg | 0.333 | 10.003† | 145.5 | 10 |
| drawImage rot+1.5x | bitmap | 0.333 | 10.003† | 274.5 | 10 |
| drawImage rot+1.5x | canvas | 0.333 | 10.003† | 276 | 10 |
| pattern rot+1.5x | img-png | 0.333 | 324 | 271 | 324 |
| pattern rot+1.5x | img-jpg | 0.333 | 312.667 | 258.5 | 312.7 |
| pattern rot+1.5x | bitmap | 0 | 239.867 | 184 | 239.9 |
| pattern rot+1.5x | canvas | 0.333 | 240.067 | 184 | 240.1 |

**Triangles (part T, S20).** `safari-img-gpu-r1.json`. ms per frame of the workload.

| recipe | source | A1 record | A2 sustained | A3 raster | per rAF (reps × A2) |
|---|---|--:|--:|--:|--:|
| clip + drawImage | img-png | 0.333 | 97.25 | 14 | 486.3 |
| clip + drawImage | img-jpg | 0.333 | 98.025 | 13.5 | 490.1 |
| clip + drawImage | bitmap | 0.333 | 93.237 | 90 | 93.2 |
| clip + drawImage | canvas | 0.333 | 94.395 | 89.5 | 94.4 |
| pattern fill | img-png | 0 | 100.611 | 15 | 402.4 |
| pattern fill | img-jpg | 0 | 100.639 | 15.5 | 402.6 |
| pattern fill | bitmap | 0 | 100.971 | 14.5 | 504.9 |
| pattern fill | canvas | 0 | 100.743 | 14.5 | 503.7 |

**First use (part F, A10, S21).** `safari-img-gpu-r1.json`; values in a cell are r1. Median of 7 trials, ms. Source: PNG 5621399 B, JPEG 2687741 B.

| preparation | prep | block | **first** | second |
|---|--:|--:|--:|--:|
| img-png (onload only) | 1 | 0 | 29 | 1 |
| img-png + decode() | 27 | 0 | 3 | 1 |
| img-jpg (onload only) | 1 | 0 | 22 | 1 |
| img-jpg + decode() | 22 | 0 | 3 | 1 |
| img-png, 1:1 draw | 1 | 0 | 30 | 0 |
| img-png + decode(), 1:1 | 27 | 0 | 3 | 1 |
| bitmap (png blob) | 25 | 0 | 7 | 1 |
| bitmap (jpg blob) | 21 | 0 | 2 | 1 |
| bitmap (from decoded img) | 29 | 0 | 2 | 1 |
| canvas (img drawn in) | 33 | 32 | 1 | 1 |

**Bleed (part X).** `safari-img-gpu-r1.json`.

| recipe | source | px0 (> 0) | px16 (> 16) | maxD |
|---|---|--:|--:|--:|
| drawImage | img-png | 0 | 0 | 0 |
| drawImage | bitmap | 0 | 0 | 0 |
| drawImage | canvas | 0 | 0 | 0 |
| pattern fillRect | img-png | 0 | 0 | 0 |
| pattern fillRect | bitmap | 0 | 0 | 0 |
| pattern fillRect | canvas | 0 | 0 | 0 |
| drawImage rot+1.5x | img-png | 0 | 0 | 0 |
| drawImage rot+1.5x | bitmap | 0 | 0 | 0 |
| drawImage rot+1.5x | canvas | 0 | 0 | 0 |
| pattern rot+1.5x | img-png | 43634 | 31426 | 124 |
| pattern rot+1.5x | bitmap | 43633 | 31425 | 124 |
| pattern rot+1.5x | canvas | 43633 | 31425 | 124 |

## Answers

### Q1. Sprites: is `drawImage` or pattern `fillRect` cheaper on the GPU?

**`drawImage`, on every GPU path measured. The CPU ranking does not reverse;
on Chromium it grows several-fold.**

- **Chromium, Graphite/Metal, A2.**
  - **Unscaled:** `drawImage` costs 1.631–1.813 ms and pattern `fillRect`
    10.777–11.837 ms, from `img-png`, `img-jpg` and `bitmap`. The pattern is
    **5.94–7.23× dearer**.
  - **Rotated 1.5×:** `drawImage` from those three sources is floored at
    ≤ 10.005 ms, while the pattern costs 159.682–164.718 ms. The pattern is
    **at least 15.96× dearer**.
  - **Canvas source:** `drawImage` costs 1.375–1.55 ms unscaled and
    1.682–1.772 ms rotated. The pattern is floored at ≤ 10.004 and ≤ 10.061,
    so this pair is **not ranked**.
  - **Against the CPU (M4, §4.13):** Chromium CPU favoured `drawImage` by
    1.46–2.25×. The GPU favours it by 5.94–7.23× unscaled and at least 15.96×
    rotated.
  - **Against SwiftShader:** its hint that pattern sprites are 3–5× cheaper
    **does not hold on a real GPU.**
- **Firefox, accelerated profile (verdict unmeasured, see sanity check 4),
  A2.**
  - **Unscaled: a tie.** `drawImage` costs 1.423–1.513 ms and the pattern
    1.479–1.743 ms. Per source the pattern/`drawImage` ratio is 0.98–1.06
    (`img-png`), 1.04–1.12 (`bitmap`), 1.01–1.21 (`canvas`) and 1.11–1.21
    (`img-jpg`).
  - **Rotated: not ranked.** All 32 row-repetitions of both recipes are
    floored (≤ 5.0 ms at 2 reps, ≤ 10.0 at 1 rep). Taking each row's tightest
    bound (≤ 5.004 ms), both are still at least 10.9× cheaper than the same
    rows on the software profile (54.606–59.033 ms).
- **Firefox software (control), A2: a tie**, as on M4. The pattern/`drawImage`
  ratio is 0.99–1.02 unscaled and 1.00 rotated.
- **Safari (one run, acceleration state unknown), A2.**
  - **Unscaled:** `drawImage` is floored at ≤ 10.003 ms (≤ 5.001 for
    `img-jpg`), while pattern `fillRect` costs 163.682–165.417 ms from every
    source, **at least 16.3×** more.
  - **Rotated:** `drawImage` ≤ 10.003 ms against 239.867–324.0 ms, **at least
    23.9×**.

### Q2. Triangles: does `pattern fill` still beat `clip + drawImage` (§4.7)?

**Yes on Chromium, where it can be resolved. Yes, by at least 16.7×, on
accelerated Firefox. On Safari it does not: the two recipes tie.**

- **Chromium, A2.**
  - **Resolved rows:** from a canvas the pattern costs 1.155–1.175 ms and
    clip 1.473–1.56 ms, **1.25–1.35×**. From a bitmap the pattern costs
    1.351–1.413 ms and clip 1.736–1.799 ms, **1.23–1.33×**.
  - **Not resolved:** from `img-png` and `img-jpg` the clip rows sit at or
    just above the floor. 5 of their 8 row-repetitions ran at 100 Hz, and the
    other 3 at 11.2–11.5 ms per frame. So the clip figure of ≤ 1.605–1.692 ms
    is an upper bound, set against a pattern figure of 1.261–1.49 ms.
- **Firefox, accelerated profile (verdict unmeasured), A2.** The pattern costs
  2.586–4.337 ms and clip 71.054–169.143 ms. The pattern is **at least 16.7×
  cheaper** from every source. No row is floored.
- **Firefox software, A2.** The pattern costs 3.929–4.464 ms and clip
  8.123–8.577 ms, **1.89–2.07×** (M4: 1.59–1.80×).
- **Safari, A2: a tie.** Clip costs 93.237–98.025 ms and the pattern
  100.611–100.971 ms, so clip is 1.03–1.08× *cheaper*, inside the 10 % noise
  line. §4.7's recipe buys nothing on Safari.

### Q3. Source type, steady state (A2)

**On the GPU an `<img>` is no longer the slow source. On Chromium the source
that matters is a canvas; on accelerated Firefox nothing matters. Opacity
matters only on Firefox software.**

- **Chromium, `drawImage` unscaled.**
  - Ranking: canvas 1.375–1.55 < `img-png` 1.631–1.682 ≈ `img-jpg`
    1.641–1.734 < `bitmap` 1.768–1.813.
  - The canvas is cheapest. The bitmap is dearest, at 1.14–1.32× the canvas.
  - On the CPU, M4 had the `<img>` 1.60× dearer than a bitmap or canvas. That
    gap is gone.
- **Chromium, pattern `fillRect`.** `img-png` costs 11.691–11.799 ms, `img-jpg`
  11.642–11.837 and `bitmap` 10.777–10.866: `<img>` is 1.07–1.10× dearer than
  bitmap, borderline noise. The canvas row is floored at ≤ 10.004.
- **Chromium, rotated pattern: the largest source effect in the run.**
  `<img>` and `bitmap` cost 159.682–164.718 ms, within 3.2 % of each other,
  against ≤ 10.061 from a canvas. **A pattern made from a canvas is at least
  15.8× cheaper.** (Rotated `drawImage` from `<img>` or bitmap is floored, so
  it cannot rank the sources.)
- **Chromium, triangles.** The canvas is cheapest in both recipes: pattern
  1.155–1.175 ms against 1.261–1.49 for the others, and clip 1.473–1.56
  against 1.605–1.799.
- **Chromium, opacity has no effect.** `img-jpg` matches `img-png` within 6 %
  in every unfloored sprite row, and in triangle pattern fill the JPEG is
  7–15 % *dearer* (1.352–1.49 ms against 1.261–1.327). A bitmap made from the
  same opaque PNG is not faster either. The `alpha: false` canvas wins because it is a canvas: the JPEG,
  also opaque, gains nothing.
- **Firefox, accelerated profile (verdict unmeasured): no source ranking.**
  - `drawImage` costs 1.423–1.513 ms from all four sources.
  - Pattern `fillRect` costs 1.479–1.743 ms. `img-jpg` is the slowest at
    1.648–1.743, which is at most 1.18× the fastest.
  - Triangle pattern fill costs 2.586–2.696 ms from every source in r1, r2 and
    r4.
  - Opacity does not help: the JPEG is, if anything, the slowest pattern
    source.
- **Firefox software (control): opacity matters, as §4.13 found on M4.**
  - `drawImage` from `img-jpg` costs 4.305 ms and from a canvas 4.067 ms,
    against 6.687 from `img-png` and 6.535 from a bitmap: **1.52–1.64×**.
  - Pattern `fillRect`: 4.042–4.38 against 6.64–6.713.
  - Rotated, the gap shrinks to 1.08× (54.606–54.781 against 58.933–59.033).
- **Safari.**
  - Unscaled `drawImage` is floored for every source.
  - Pattern `fillRect` ties across sources (163.682–165.417 ms).
  - The rotated pattern favours bitmap and canvas (239.867–240.067 ms) over
    `<img>` (312.667–324.0 ms) by 1.30–1.35×.
  - Triangles are within 5.1 % across sources.

### Q4. First use (A10, table `first`)

The full-page runs are r1–r4. The fresh-browser, part-F-only runs are F-r1 and
F-r2. **The in-page values are the reliable ones**: the F-only runs started
within ~20 s of the browser launching and read up to 2.7× higher (see Caveats).

- **Is an `<img>`'s second draw still slow on the GPU? On Chromium, yes. On
  Firefox and Safari, no.**
  - **Chromium, PNG `<img>` (`onload` only):** first draw 28.5–28.8 ms,
    **second draw 25.3–25.6 ms**, against 1.8–1.9 ms for a bitmap's second
    draw, **13–14×**. In the F-only runs the second draw was 33.6 / 66.5 ms.
    - JPEG `<img>`: first 16.6–17.0 ms, second 17.7–18.6 ms.
    - 1:1 draw: first 28.5–29.0 ms, second 23.8–24.3 ms.
    - SwiftShader had shown 75 against 3.8 ms. The effect is real on the GPU,
      about a third of that size.
  - **Firefox accelerated profile:** first draw of a plain `<img>` 31–42 ms,
    second 1–5 ms.
  - **Firefox software:** first 27–30 ms, second 0–2 ms.
  - **Safari:** first 22–30 ms, second 0–1 ms.
- **Does `img.decode()` help on Chromium? No, not at all.**
  - PNG: first draw 28.4–29.0 ms with `decode()` against 28.5–28.8 without;
    second draw 25.4–25.8.
  - JPEG: first 16.9–17.3 against 16.6–17.0.
  - PNG at 1:1: first 28.4–28.9 against 28.5–29.0.
  - On the CPU (M4), `decode()` had at least helped a JPEG, 38.7 ms against
    107.0. On Graphite it does not.
  - Elsewhere it does fix the first draw: Firefox accelerated 3–9 ms, Firefox
    software 0–1 ms, Safari 3 ms.
- **Is `createImageBitmap` still the best preparation? Yes. It is the only one
  that fixes the first draw on all three engines without blocking the main
  thread.**
  - **Chromium:** first draw 3.5–4.3 ms (PNG blob), 3.0–3.7 ms (JPEG blob),
    3.9–4.0 ms (from a decoded `<img>`); second draw 1.8–1.9 ms. F-only runs
    4.2–5.6 ms. Preparation 25.0–25.1 ms of wall time for the PNG blob, off
    the frame.
  - **Firefox accelerated:** first draw 3–8 ms.
  - **Firefox software:** 1–2 ms.
  - **Safari:** 2–7 ms (7 ms for the PNG blob).
  - **The canvas copy** has the cheapest first draw on Chromium (1.4–1.7 ms),
    but it blocks the main thread at creation: 27.5–27.8 ms on Chromium
    (33.1–54.1 in F-only runs), 33–77 ms on Firefox accelerated, 31 ms on
    Firefox software, 32 ms on Safari.

### Q5. Bleed (table `fidelity`)

**Chromium gives almost the same numbers as the CPU run. But part X never
touches the GPU on any engine, so this is not a GPU answer.** Part X renders
into `willReadFrequently: true` canvases (the `render` helper in `fidelity()`),
and §8.1 records that such a canvas is forced onto the CPU backend. Numbers
(px0 = pixels that differ at all, px16 = by more than 16 levels, maxD = the
largest difference):

- **Chromium, identical in all 4 repetitions.**
  - Unscaled: 0 px for both recipes and all sources.
  - Rotated `drawImage`: 45 046 px from `img-png` and `bitmap` (35 945
    > 16, maxD 124) and 43 728 px from a canvas (36 215 > 16, maxD 114).
  - Rotated pattern: **46 830 px** (37 473 > 16, maxD 119) from every source.
  - Against M4's CPU run: the pattern numbers are identical, down to the
    pixel. `drawImage` bleeds 2.4–6.6 % fewer pixels than M4's 46 137–46 820.
    So both recipes still bleed under rotation and neither bleeds at 1:1.
- **Firefox, both profiles, identical.** 0 px everywhere except the rotated
  pattern from a canvas: 45 063 px (35 953 > 16, maxD 124). M4 had 46 833.
- **Safari (new).** `drawImage` bleeds **0 px even rotated**. The rotated
  pattern bleeds from **every** source: 43 633–43 634 px (31 425–31 426 > 16,
  maxD 124).

### Q6. Surprises and contradictions with §4.13

1. **The page's A2 is pinned to vsync for many GPU rows.** See sanity check 3
   for the counts.
   - **The mechanism is the page's rep sizing.** `sustained()` sizes reps
     from max(A1, A3), and on a GPU the CPU raster A3 is far above the real
     cost. Examples: rotated `drawImage` A3 is 66.45–73.15 ms on Chromium,
     giving 1 rep; a canvas-sourced pattern's A3 is 724.8–916.25 ms, also
     1 rep. One rep of the workload then fits inside one 10 ms frame.
   - **These rows cannot be ranked on this page until reps are sized from A2
     itself**, for example from a calibration pass. Nothing was changed here.
2. **The Firefox indicator cannot light on `imagepage.html` on any machine.**
   Its 64×64 control canvas is below `gfx.canvas.accelerated.min-size` (128);
   see the indicator probe.
   - §4.13 reports that M4's forced-accelerated Firefox "never lit the
     acceleration indicator, even on its control canvas". The same 64×64
     control would produce that result on any machine, so that statement may
     be this artifact too. *Inferred, not re-tested on M4.*
3. **On Chromium's GPU canvas, a pattern from an `<img>` or `ImageBitmap`
   costs exactly what the CPU raster costs.**
   - A2 ÷ A3 = 1.004–1.036 for pattern `fillRect` and rotated pattern, across
     all 24 row-repetitions from `img-png`, `img-jpg` and `bitmap`.
   - A pattern from a canvas stays at ≤ 10 ms.
   - *Mechanism unmeasured.* A2 ≈ A3 fits a pattern image that is not
     resident on the GPU being filled on the CPU.
4. **The readback trap is confirmed on a real GPU.**
   - A GPU canvas used as the *pattern* source for a `willReadFrequently`
     canvas costs 724.8–755.45 ms per A3 frame unscaled and 907.9–916.25 ms
     rotated. §4.13 reports the same mechanism from SwiftShader (3 299 ms).
   - `drawImage` from that same canvas into the same CPU canvas costs only
     2.85–3.15 ms (4.45–4.9 ms rotated). Only the pattern path pays.
5. **On the accelerated profile, Firefox's `clip + drawImage` is 8.3–20.8×
   slower than its own software path.** It costs 71.054–169.143 ms against
   8.123–8.577 ms. Because the per-case verdicts are missing, whether those
   canvases stayed accelerated is unknown.
6. **Safari, previously unmeasured in §4.13, is the most extreme case for the
   sprite rule.**
   - The pattern costs at least 16× what `drawImage` does.
   - §4.7's triangle recipe is a tie there, not a win.
   - Safari's `drawImage` is the only one here that keeps a rotated sprite
     inside its cell (0 px).
7. **Contradiction with §4.13's steady-state rule** that an `<img>` is the
   slow source.
   - On Graphite it is not. The bitmap is marginally the slowest `drawImage`
     source (1.768–1.813 ms against 1.631–1.682 for `img-png`).
   - The "draw it into a canvas" advice still holds, and holds more strongly
     for patterns.
8. **Chromium's slow second draw depends on the image.** A 2048² `<img>` is
   slow on its second draw, 25.3–25.6 ms. Yet the 512² `<img>` atlas in the
   steady-state loop costs 1.631–1.682 ms per 2 000 sprites, so the cost is
   not paid on every draw of every `<img>`. *Mechanism unmeasured.* The
   variable could be the size, or the number of draws before the image
   becomes resident.

## Caveats

- **The vsync floor** (Q6.1). † rows are upper bounds.
  - Apart from Chromium's pattern rows and accelerated Firefox's triangle
    rows, the unfloored rows ran at 10.8–31 ms per frame, below §8.1's 50 ms
    target.
  - Their spread across repetitions is small (sanity check 5). But a row
    within about 1.5 frames of the floor may still be partly floored. Examples
    are Chromium's `clip + drawImage` from `<img>` and bitmap, at 10.0–12.4 ms
    per frame.
- **No Firefox per-case verdict** (sanity check 4). The accelerated-profile
  timings are *accelerated profile, verdict unmeasured*.
  - The evidence that the targets were accelerated is inferred. The probe
    shows a 1280×720 canvas starts accelerated. And the profile's A2 differs
    sharply from the software profile's: unscaled sprites cost 1.423–1.743 ms
    against 4.042–6.713, and `clip + drawImage` 71–169 ms against 8.1–8.6.
- **Firefox accelerated r3 is an outlier.**
  - `clip + drawImage` from `img-jpg`, `bitmap` and `canvas` cost
    160.656–169.143 ms, against 71.054–73.583 in r1–r2 and 86.667–88.8 in r4.
  - Pattern fill cost 4.042–4.337 ms, against 2.586–2.696 in r1, r2 and r4.
    That is close to the software profile's 3.929–4.464.
  - Its first-use rows are also higher (first draws of 7–9 ms against 3–5).
  - No thermal warning was recorded. The machine is fanless, and r3 closed a
    ~15 min continuous stretch. The cause was not identified. The extra r4
    agrees with r1 and r2 on pattern fill.
- **The fresh-browser F runs are slow and noisy.** Each page ran within ~20 s
  of its browser launching (`edge-imgF-gpu-r1.json` was written at 12:13:12,
  about 20 s after launch). Many rows read up to 2.7× the in-page values;
  for example, Chromium's PNG `<img>` second draw was 33.6 / 66.5 against
  25.3–25.6. Others matched them: Firefox F-r2 is within 1 ms of r1. So running F on a fresh browser did **not** give a cleaner
  number here. *Start-up contention is inferred, not measured.*
- **Timer resolution:** Firefox and Safari give 1 ms, so their A1 values and
  all their F values are coarse.
- **Safari:** one run only, after the first attempt hung. No acceleration
  indicator. Its A3 column is whatever WebKit does with `willReadFrequently`,
  and was not verified to be the CPU.
- **Part X** runs on CPU canvases in every engine (Q5).
- **Graphite, not Ganesh.** Every Chromium number here is Skia Graphite on
  Dawn/Metal. §10.1 warns against carrying a Chromium GPU ratio to M1's
  Ganesh.
- **Chrome stands in for Edge**, as `run.js`'s macOS default: the same Blink
  and Skia.

## Appendix: the side checks (no timings)

**`chrome://gpu`** was read by launching the same Chrome binary on a
throwaway profile with `--remote-debugging-port`, navigating to `chrome://gpu`
and collecting the page's text, shadow DOM included, through
`Runtime.evaluate`.

**Firefox `about:support`.** WebDriver BiDi refuses to navigate to
`about:support`. So the same data was read by launching Firefox with
`--remote-debugging-port --remote-allow-system-access` on a fresh profile and
evaluating the following in the chrome context:

```js
const { Troubleshoot } = ChromeUtils.importESModule('resource://gre/modules/Troubleshoot.sys.mjs');
const snap = await Troubleshoot.snapshot();   // snap.graphics, snap.modifiedPreferences
```

**Indicator probe.** Two throwaway Firefox 156.0.1 profiles:

- `debug = true`;
- `debug = true` plus `accelerated = false`, as the control.

On each, the prefs were read through `Services.prefs`, and then this ran in an
`about:blank` tab over BiDi. `accelFraction()` is copied verbatim from
`imagepage.html`: it copies the canvas's top-right 16×16 into a 32×32
`willReadFrequently` probe and counts green pixels.

```js
const cases = [   // [name, width, height, css (null = never attached), fills, rAFs]
  ['64x64 off-screen [imagepage.html]', 64, 64, 'position:fixed;left:-500px', 1, 2],
  ['64x64 on-screen', 64, 64, 'position:fixed;left:10px;top:10px', 1, 2],
  ['127x127 on-screen', 127, 127, 'position:fixed;left:10px;top:100px', 3, 3],
  ['128x128 on-screen', 128, 128, 'position:fixed;left:150px;top:100px', 3, 3],
  ['128x128 off-screen', 128, 128, 'position:fixed;left:-500px', 1, 2],
  ['1280x720 off-screen', 1280, 720, 'position:fixed;left:-2000px', 1, 2],
  ['1280x720 shown at 320x180 [imagepage target]', 1280, 720, 'position:fixed;right:4px;bottom:4px;width:320px;height:180px', 3, 3],
  ['1280x720 not attached [tesspage.html]', 1280, 720, null, 3, 3],
];
for (const [name, w, h, css, fills, frames] of cases) {
  const t = mk(w, h);                                   // getContext('2d', { alpha: false })
  if (css) { t.c.style.cssText = css; document.body.appendChild(t.c); }
  for (let i = 0; i < Math.max(fills, frames); i++) {
    if (i < fills) { t.ctx.fillStyle = '#123'; t.ctx.fillRect(0, 0, w, h); }
    if (i < frames) await nextFrame();
  }
  report(name, accelFraction(t.c));                     // > 0.8 = the square is lit
  t.c.remove();
}
```

Result (green fraction; 1 = lit):

| control canvas | `debug = true` | `debug = true`, `accelerated = false` |
|---|--:|--:|
| 64×64 off-screen, 1 fill, 2 rAF (**`imagepage.html`'s control**) | 0 | 0 |
| 64×64 on-screen, 1 fill, 2 rAF | 0 | 0 |
| 127×127 on-screen, 3 fills, 3 rAF | 0 | 0 |
| 128×128 on-screen, 3 fills, 3 rAF | **1** | 0 |
| 128×128 off-screen, 1 fill, 2 rAF | **1** | 0 |
| 1280×720 off-screen, 1 fill, 2 rAF | **1** | 0 |
| 1280×720 shown at 320×180, 3 fills, 3 rAF (an `imagepage.html` target) | **1** | 0 |
| 1280×720 never attached, 3 fills, 3 rAF (`tesspage.html`'s control) | **1** | 0 |

Prefs read on both profiles: `gfx.canvas.accelerated.min-size = 128`
(default), `gfx.canvas.accelerated.max-size = 8192` (default).
