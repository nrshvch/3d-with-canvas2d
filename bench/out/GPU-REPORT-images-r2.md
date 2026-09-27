# GPU run, round 2: the 3D texture case, the image-size sweep, and round 1 re-checked

Measured on 27 September 2026, 14:21–15:20 local time, on the same MacBook Air
as round 1 (§10.1's **M6**). **No browser version changed since round 1.**
All raw results are the `bench/out/*-img{M,M1,B,2,Mnoop}-gpu-r*.json` files
next to this report. The tables are generated from those files, and every
number in the answers is copied from them.

**The short version.**

- **3D recipe (part M, rep 4):** the answer depends on the engine.
  - Chrome: `pattern repeat` and `clip + pre-tiled` **tie**, at 0.43–0.64 ms.
  - Firefox: `pattern repeat` is **at least 39×** cheaper than either clip
    recipe.
  - Safari: `clip + pre-tiled` is cheapest, and the pattern is 1.11–1.40×
    dearer.
  - `clip + per tile` is the dearest everywhere: 8–11× on Chrome, 13–17× on
    Safari. At rep 1 it stops losing on Chrome and Safari.
- **Source for textures:** no source is much slower anywhere. On Safari, a
  `'repeat'` pattern from a PNG `<img>` is only 1.07–1.15× slower than from the
  small canvas at rep 4, and a bitmap is as fast as the canvas. The
  "Safari re-decodes a PNG pattern" claim is **not supported at rep 4**. At
  rep 1 there is a 1.46× gap, from one run.
- **Image size (part B):** on Chrome an `<img>` costs 2.75–4.11× its bitmap
  **from the smallest size tested, 256 px**, wherever the bitmap row is
  resolved. It never passes 1.5× on Firefox or Safari.
- **Round 1 re-checked:** every row round 1 left on the refresh floor is now
  measured, and **no ranking reverses**. The gaps grow instead. On Safari a
  pattern sprite is now 108–169× a `drawImage` sprite (round 1 could only say
  at least 16×).
- **GPU bleed:** Chrome and Safari bleed the same on the GPU as on the CPU.
  **Firefox's GPU canvas bleeds with both recipes**, where its CPU path did
  not.
- **The Firefox indicator works now, and it shows every Firefox canvas
  demoting during A2.** That includes a control run with no workload at all,
  so every Firefox A2 number is a mixed figure: accelerated at first, software
  by the end.

---

## Machine

Same as round 1 ([GPU-REPORT-images.md](GPU-REPORT-images.md)), re-read on
the day. **Unchanged:**

| item | value |
|---|---|
| hardware | MacBook Air `Mac16,12`, Apple M4 (4P + 6E CPU cores, 10-core GPU), 16 GB, fanless |
| OS | macOS 26.6.2 (25G83) |
| display | Dell S3422DW, 3440×1440 at 100 Hz, `devicePixelRatio` 1 |
| Chrome | **153.0.8010.54**. Graphite on Dawn/Metal (read in round 1) |
| Firefox | **156.0.1**, build 20260921121718 |
| Safari | **26.6.2** (21624.5.1.11.3) |
| Node | 25.9.0 |

Conditions:

- Your own Firefox was quit before the run (it exited at 14:20:50).
- Safari was launched at ~14:21 by a test of the focus watchdog, not by you.
  The watchdog runs `tell application "Safari" to activate` whenever a bench
  tab is open and Safari is not the front app.
- `caffeinate -d -i` ran throughout. `pmset -g therm` recorded no thermal
  warning.
- Several other Claude Code sessions were open on the machine.
  - A headless Firefox with remote debugging, not started by this run, was
    seen at 14:19 and had exited by 14:20.
  - When part B r1 and r2 started (14:33:26, 14:38:55), an unidentified
    `firefox` (19–32 % CPU) and its `plugin-container` (67–82 %) were running.
  - The server's log shows that no bench tag was posted twice, so that process
    never ran a bench page. Whether it overlapped Chrome's part B runs beyond
    their first second is **not measured**.
- **WebStorm** was relaunched at 14:52:15 and sat at **589.8 % CPU** when part
  D r2 started (14:52:51). You were using the Mac between 14:52 and 15:01.
  That triggered the reruns listed below.

## Runs

The brief's commands A–E ran verbatim, in order, from one script. It logged
timestamps and a `top` snapshot before each command.

| # | command (all `PAGE=imagepage.html … node bench/run.js`) | JSON written | outcome |
|---|---|---|---|
| A1 | `TAGSUFFIX=-imgM-gpu-r1 EXTRA="parts=M"` edge firefox-dbg safari | `edge-imgM-gpu-r1.json`, `firefox-dbg-imgM-gpu-r1.json`, `safari-imgM-gpu-r1.json` | finished 14:21:46–14:24:47 |
| A2 | `TAGSUFFIX=-imgM-gpu-r2 EXTRA="parts=M"` (same targets) | `*-imgM-gpu-r2.json` ×3 | finished 14:24:47–14:27:52; Safari brought to the front once (14:26:47) |
| A3 | `TAGSUFFIX=-imgM-gpu-r3 EXTRA="parts=M"` | `*-imgM-gpu-r3.json` ×3 | finished 14:27:52–14:30:58 |
| B | `TAGSUFFIX=-imgM1-gpu-r1 EXTRA="parts=M&rep=1"` | `*-imgM1-gpu-r1.json` ×3 | finished 14:30:58–14:33:26 |
| C1 | `TAGSUFFIX=-imgB-gpu-r1 EXTRA="parts=B"` | `*-imgB-gpu-r1.json` ×3 | finished 14:33:26–14:38:55 |
| C2 | `TAGSUFFIX=-imgB-gpu-r2 EXTRA="parts=B"` | `*-imgB-gpu-r2.json` ×3 | finished 14:38:55–14:44:31 |
| D1 | `TAGSUFFIX=-img2-gpu-r1 EXTRA="parts=X,S,T,F"` | `edge-`, `firefox-dbg-img2-gpu-r1.json`; Safari's set aside | finished 14:44:31–14:52:51. **Safari disturbed**: brought back to the front 4 times (14:52:32–48) |
| D2 | `TAGSUFFIX=-img2-gpu-r2 EXTRA="parts=X,S,T,F"` | all three set aside | finished 14:52:51–15:01:52. **All three disturbed**: WebStorm at 589.8 % CPU at the start; Safari brought back 16 times (14:59:14–15:01:40) |
| E | `TAGSUFFIX=-imgM-gpu-r1 EXTRA="parts=M,B"` firefox-nonaccel | `firefox-nonaccel-imgM-gpu-r1.json` | finished 15:01:52–15:03:38 |
| D1′ | **rerun** of D1 for safari | `safari-img2-gpu-r1.json` | finished 15:04:12–15:07:55; Safari brought to the front once (15:05:00, WebStorm had come forward) |
| D2′ | **rerun** of D2 for safari | `safari-img2-gpu-r2.json` | finished 15:07:55–15:11:34, no focus change |
| D2″ | **rerun** of D2 for edge firefox-dbg | `edge-img2-gpu-r2.json`, `firefox-dbg-img2-gpu-r2.json` | finished 15:14:06–15:18:58, machine quiet |
| X | **extra, not in the brief:** `TAGSUFFIX=-imgMnoop-gpu-r1 EXTRA="parts=M&noop=1"` firefox-dbg | `firefox-dbg-imgMnoop-gpu-r1.json` | finished 15:18:58–15:19:56. The page's own control for placing the A2 demotion |

**The four disturbed originals are kept** as `*-img2-gpu-r{1,2}-disturbed.json`.
Each disturbed command got its one rerun, and the tables use the reruns. How
far each original sits from its rerun:

| set-aside file | why | A2 ÷ rerun A2 over its 24 S and T rows: min–max, median | A3 ÷ rerun A3: min–max |
|---|---|--:|--:|
| `safari-img2-gpu-r1-disturbed.json` | Safari brought back to the front 4 times, 14:52:32–14:52:48 | 0.64–1.39, median 0.94 | 0.88–1.58 |
| `safari-img2-gpu-r2-disturbed.json` | Safari brought back to the front 16 times, 14:59:14–15:01:40 | 1.00–1.47, median 1.07 | 0.92–1.13 |
| `edge-img2-gpu-r2-disturbed.json` | WebStorm at 589.8 % CPU when the command started (14:52:51) | 1.05–2.86, median 1.60 | 1.00–2.25 |
| `firefox-dbg-img2-gpu-r2-disturbed.json` | the same command, right after the Chrome run | 0.92–1.76, median 0.99 | 0.68–1.75 |

Chrome's disturbed r2 is the clearly contaminated one. Its median row is 1.60×
the rerun, and its CPU-only A3 column is up to 2.25× too, which points at CPU
contention rather than the GPU.

## Sanity checks

| file | `error` | indicator | identity: channels differing vs img-png (img-png / img-jpg / bitmap / canvas) | M picture: pre-tiled RMSE, px16 · per tile RMSE, px16 | timed rows, min `frames` | `floored` rows | Firefox verdicts |
|---|---|---|---|---|---|--:|---|
| `edge-img2-gpu-r1.json` | none | false | 0 / 747026 / 0 / 0 | n/a (no part M) | 24, min 21 | 0 | - |
| `edge-img2-gpu-r2.json` | none | false | 0 / 747026 / 0 / 0 | n/a (no part M) | 24, min 22 | 0 | - |
| `edge-imgB-gpu-r1.json` | none | false | 0 / 747026 / 0 / 0 | n/a (no part M) | 15, min 6 | 2 | - |
| `edge-imgB-gpu-r2.json` | none | false | 0 / 747026 / 0 / 0 | n/a (no part M) | 15, min 5 | 3 | - |
| `edge-imgM-gpu-r1.json` | none | false | 0 / 747026 / 0 / 0 | 2.395, 6818 · 7.599, 56218 | 9, min 35 | 0 | - |
| `edge-imgM-gpu-r2.json` | none | false | 0 / 747026 / 0 / 0 | 2.395, 6818 · 7.599, 56218 | 9, min 35 | 0 | - |
| `edge-imgM-gpu-r3.json` | none | false | 0 / 747026 / 0 / 0 | 2.395, 6818 · 7.599, 56218 | 9, min 37 | 0 | - |
| `edge-imgM1-gpu-r1.json` | none | false | 0 / 747026 / 0 / 0 | 2.34, 6463 · 2.34, 6463 | 9, min 39 | 0 | - |
| `firefox-dbg-img2-gpu-r1.json` | none | true | 0 / 723755 / 0 / 0 | n/a (no part M) | 24, min 8 | 0 | ACCEL>ACCEL>soft ×24 |
| `firefox-dbg-img2-gpu-r2.json` | none | true | 0 / 723755 / 0 / 0 | n/a (no part M) | 24, min 6 | 0 | ACCEL>ACCEL>soft ×24 |
| `firefox-dbg-imgB-gpu-r1.json` | none | true | 0 / 723755 / 0 / 0 | n/a (no part M) | 15, min 4 | 0 | ACCEL>ACCEL>soft ×15 |
| `firefox-dbg-imgB-gpu-r2.json` | none | true | 0 / 723755 / 0 / 0 | n/a (no part M) | 15, min 4 | 0 | ACCEL>ACCEL>soft ×15 |
| `firefox-dbg-imgM-gpu-r1.json` | none | true | 0 / 723755 / 0 / 0 | 4.459, 21205 · 8.897, 69830 | 9, min 17 | 0 | ACCEL>ACCEL>soft ×9 |
| `firefox-dbg-imgM-gpu-r2.json` | none | true | 0 / 723755 / 0 / 0 | 4.459, 21205 · 8.897, 69830 | 9, min 14 | 0 | ACCEL>ACCEL>soft ×9 |
| `firefox-dbg-imgM-gpu-r3.json` | none | true | 0 / 723755 / 0 / 0 | 4.459, 21205 · 8.897, 69830 | 9, min 11 | 0 | ACCEL>ACCEL>soft ×9 |
| `firefox-dbg-imgM1-gpu-r1.json` | none | true | 0 / 723755 / 0 / 0 | 4.375, 21515 · 4.375, 21515 | 9, min 12 | 0 | ACCEL>ACCEL>soft ×9 |
| `firefox-nonaccel-imgM-gpu-r1.json` | none | false | 0 / 723755 / 0 / 0 | 4.332, 21073 · 8.136, 69443 | 24, min 36 | 0 | - ×24 |
| `safari-img2-gpu-r1.json` | none | false | 0 / 735597 / 0 / 0 | n/a (no part M) | 24, min 6 | 0 | - |
| `safari-img2-gpu-r2.json` | none | false | 0 / 735597 / 0 / 0 | n/a (no part M) | 24, min 6 | 0 | - |
| `safari-imgB-gpu-r1.json` | none | false | 0 / 735597 / 0 / 0 | n/a (no part M) | 15, min 6 | 3 | - |
| `safari-imgB-gpu-r2.json` | none | false | 0 / 735597 / 0 / 0 | n/a (no part M) | 15, min 6 | 3 | - |
| `safari-imgM-gpu-r1.json` | none | false | 0 / 735597 / 0 / 0 | 11.296 **>10**, 39431 · 17.412 **>10**, 98820 | 9, min 4 | 0 | - |
| `safari-imgM-gpu-r2.json` | none | false | 0 / 735597 / 0 / 0 | 11.296 **>10**, 39431 · 17.412 **>10**, 98820 | 9, min 4 | 0 | - |
| `safari-imgM-gpu-r3.json` | none | false | 0 / 735597 / 0 / 0 | 11.296 **>10**, 39431 · 17.412 **>10**, 98820 | 9, min 4 | 0 | - |
| `safari-imgM1-gpu-r1.json` | none | false | 0 / 735597 / 0 / 0 | 6.987, 27989 · 6.987, 27989 | 9, min 15 | 0 | - |

1. **Every JSON exists and has no `error` field.** All 25 files in the table
   pass. So do the 4 set-aside files and the `noop` control.
2. **Round 1's identity rows:** `img-png`, `bitmap` and `canvas` have
   `channelsDiffering: 0` in every file. `img-jpg` differs by 747 026 channels
   on Chrome, 723 755 on Firefox and 735 597 on Safari, as a JPEG should.
3. **Part M picture check** (RMSE, and pixels off by more than 16, against
   `pattern repeat`; the values are identical in every repetition of an
   engine):
   - Chrome: pre-tiled 2.395 / 6 818 px, per tile 7.599 / 56 218 px.
   - Firefox accelerated profile: 4.459 / 21 205 and 8.897 / 69 830.
   - Firefox software: 4.332 / 21 073 and 8.136 / 69 443.
   - **Safari: 11.296 / 39 431 and 17.412 / 98 820. Both are above 10,
     flagged.**
   - At rep 1, where pre-tiled and per tile draw the same thing, both rows
     read: Chrome 2.34 / 6 463, Firefox 4.375 / 21 515, Safari 6.987 / 27 989.
     All under 10.
4. **Floored rows.** 11 in all, **every one in part B**, and none in parts M,
   S or T:
   - Chrome's bitmap rows at 1024 and 2048 in both repetitions, and at 512 in
     r2;
   - Safari's canvas rows at 256 (r1), 512 and 1024 (both), and 2048 (r2).

   | file | part | recipe / size | source | A2 `sustMs` | reps | per rAF ms | frames |
   |---|---|---|---|--:|--:|--:|--:|
   | `edge-imgB-gpu-r1.json` | B | 1024 | bitmap | 0.909 | 11 | 10 | 351 |
   | `edge-imgB-gpu-r1.json` | B | 2048 | bitmap | 1 | 10 | 10 | 350 |
   | `edge-imgB-gpu-r2.json` | B | 512 | bitmap | 0.5 | 20 | 10 | 351 |
   | `edge-imgB-gpu-r2.json` | B | 1024 | bitmap | 0.556 | 18 | 10 | 350 |
   | `edge-imgB-gpu-r2.json` | B | 2048 | bitmap | 0.345 | 29 | 10 | 350 |
   | `safari-imgB-gpu-r1.json` | B | 256 | canvas | 0.588 | 17 | 10 | 351 |
   | `safari-imgB-gpu-r1.json` | B | 512 | canvas | 1 | 10 | 10 | 351 |
   | `safari-imgB-gpu-r1.json` | B | 1024 | canvas | 2.501 | 4 | 10 | 351 |
   | `safari-imgB-gpu-r2.json` | B | 512 | canvas | 1 | 10 | 10 | 350 |
   | `safari-imgB-gpu-r2.json` | B | 1024 | canvas | 2.501 | 4 | 10 | 350 |
   | `safari-imgB-gpu-r2.json` | B | 2048 | canvas | 5.001 | 2 | 10 | 350 |

   Each one ran at exactly 10 ms per frame (100 Hz) with 2–29 reps.
   - The calibration stopped early. It doubles reps until one 3-frame probe
     spans ≥ 50 ms, and in these rows the probe read ≥ 50 ms, but the steady
     state then ran at the refresh rate.
   - *Inferred, not measured:* a one-time cost inside the 3-frame probe (such
     as a first upload of a large bitmap) ends the doubling too soon.
   - Their A2 is an upper bound.
5. **Firefox verdicts.**
   - The indicator line reads **`true`** in all 8 accelerated-profile files
     and in the `noop` control. It reads `false` under the software profile,
     as it should.
   - **All 114 timed accelerated-profile rows end `soft`**, and every one goes
     `ACCEL > ACCEL > soft`: accelerated after its first presented frame,
     still accelerated after the A1 loop, and demoted by the end of A2. That
     covers 27 part M rep-4 rows, 9 rep-1 rows, 30 part B rows and 48 part D
     rows.
   - So the demotion happens **during A2**: the calibration passes plus the
     ≥ 3.5 s sustained loop.
   - Part F's first-use targets, which never run a sustained loop, all read
     `ACCEL`.
   - **The `noop` control demotes too.** With every workload replaced by
     nothing, all 9 canvases still go `ACCEL > ACCEL > soft` (table below). An
     empty workload calibrates to the 4 096-rep cap, so that is 4 096 of the
     0.996 clears per frame and nothing else.
   - So the sustained loop itself demotes Firefox's canvas on M6, whatever
     the image recipe. That is the result §4.13 records for M4's llvmpipe.
6. **Chromium A2 spread across repetitions** is the `A2 min–max` column of
   every Chrome table.
   - Part M (3 repetitions): 6 of 9 rows are within 6.9 %. The other three are
     pre-tiled from a canvas (20.1 %), per tile from a canvas (15.3 %) and
     pre-tiled from a bitmap (11.1 %).
   - Part D (2 repetitions): 12 of 24 rows spread more than 10 %. The widest
     are pattern fill from `img-jpg` (1.769–2.787, 57.5 %) and the rotated
     pattern from a canvas (2.568–3.943, 53.5 %). r1 ran at 14:44 and the r2
     rerun at 15:14, and r1 is the slower one in most of those rows.
   - Part B (2 repetitions): 12 of 15 rows spread more than 10 %. Their values
     are 0.011–0.025 ms per workload, where a 0.01 ms step is 100 %.
   - The answers below read no Chromium difference under ~10 %, and they flag
     where a spread is wider than the gap being read.

**The `noop` control:**

`firefox-dbg-imgMnoop-gpu-r1.json` (`parts=M&noop=1`: every workload replaced by nothing, so each rep is only the 0.996 clear). Indicator `true`.

| recipe (not drawn) | source | A2, clear only | reps | per rAF | verdict first>A1>A2 |
|---|---|--:|--:|--:|---|
| pattern repeat | img-png | 0.029 | 4096 | 117.9 | ACCEL>ACCEL>soft |
| pattern repeat | bitmap | 0.031 | 4096 | 127.64 | ACCEL>ACCEL>soft |
| pattern repeat | canvas | 0.031 | 4096 | 125.9 | ACCEL>ACCEL>soft |
| clip + pre-tiled | img-png | 0.031 | 4096 | 125.61 | ACCEL>ACCEL>soft |
| clip + pre-tiled | bitmap | 0.033 | 4096 | 136.54 | ACCEL>ACCEL>soft |
| clip + pre-tiled | canvas | 0.031 | 4096 | 128.75 | ACCEL>ACCEL>soft |
| clip + per tile | img-png | 0.031 | 4096 | 126.79 | ACCEL>ACCEL>soft |
| clip + per tile | bitmap | 0.031 | 4096 | 126.93 | ACCEL>ACCEL>soft |
| clip + per tile | canvas | 0.031 | 4096 | 128.68 | ACCEL>ACCEL>soft |

## Tables

- **A1** is record, **A2** sustained (the GPU-inclusive axis), **A3** raster,
  all in ms per frame of the workload.
- **per rAF** is the page's `perRafMs`, the wall time of one animation frame.
  **reps** is its repetitions per frame.
- **F** after an A2 value marks a row the page saved as `floored: true`.
- A Firefox verdict reads *after the first presented frame > after A1 > after
  A2*. `(all)` means every repetition read the same.
- Firefox and Safari report `performance.now()` at 1 ms resolution, so their
  A1 values are 0 or a few thirds of a millisecond.
- Part M's A2 is the whole scene: 336 quads, a mean of 4 475 px² each, 74.7 %
  of the canvas covered.
- Part B's A2 is 16 whole-image `drawImage` calls into 320×180 cells **plus
  the page's one 0.996 full-canvas clear per rep**, which every row pays.

### Part M, rep 4 (S22)

#### Chrome 153 (Graphite/Metal)

`edge-imgM-gpu-r1.json`, `edge-imgM-gpu-r2.json`, `edge-imgM-gpu-r3.json` — cells are r1 / r2 / r3.

| recipe | source | A1 | **A2** | A2 min–max | A3 | per rAF | reps |
|---|---|--:|--:|--:|--:|--:|--:|
| pattern repeat | img-png | 0.067 / 0.1 / 0.067 | 0.464 / 0.434 / 0.439 | 0.434–0.464 | 3.6 / 3.5 / 3.55 | 77.88 / 78.95 / 79.93 | 168 / 182 / 182 |
| pattern repeat | bitmap | 0.067 / 0.067 / 0.067 | 0.633 / 0.634 / 0.64 | 0.633–0.64 | 3.15 / 3.25 / 3.15 | 60.79 / 61.49 / 61.45 | 96 / 97 / 96 |
| pattern repeat | canvas | 0.067 / 0.1 / 0.067 | 0.524 / 0.528 / 0.501 | 0.501–0.528 | 74.75 / 81.95 / 75.75 | 102.16 / 102.46 / 96.18 | 195 / 194 / 192 |
| clip + pre-tiled | img-png | 0.233 / 0.2 / 0.2 | 0.443 / 0.456 / 0.442 | 0.442–0.456 | 1.6 / 1.5 / 1.45 | 62.07 / 61.07 / 61.42 | 140 / 134 / 139 |
| clip + pre-tiled | bitmap | 0.2 / 0.2 / 0.2 | 0.501 / 0.494 / 0.451 | 0.451–0.501 | 1.4 / 1.95 / 1.95 | 71.18 / 70.66 / 62.76 | 142 / 143 / 139 |
| clip + pre-tiled | canvas | 0.2 / 0.167 / 0.2 | 0.452 / 0.543 / 0.456 | 0.452–0.543 | 1.9 / 2.05 / 1.9 | 61.88 / 81.52 / 64.28 | 137 / 150 / 141 |
| clip + per tile | img-png | 3.4 / 3.333 / 3.433 | 4.611 / 4.516 / 4.588 | 4.516–4.611 | 9.7 / 7.95 / 8.7 | 64.55 / 63.22 / 64.23 | 14 / 14 / 14 |
| clip + per tile | bitmap | 4.033 / 3.833 / 3.967 | 5.032 / 5.005 / 5.046 | 5.005–5.046 | 10.05 / 9.85 / 10.2 | 65.42 / 65.06 / 60.55 | 13 / 13 / 12 |
| clip + per tile | canvas | 3.1 / 2.9 / 3.067 | 4.468 / 5.15 / 4.678 | 4.468–5.15 | 9 / 8.5 / 8.8 | 71.49 / 87.55 / 74.85 | 16 / 17 / 16 |

#### Firefox 156.0.1, accelerated profile (`firefox-dbg`)

`firefox-dbg-imgM-gpu-r1.json`, `firefox-dbg-imgM-gpu-r2.json`, `firefox-dbg-imgM-gpu-r3.json` — cells are r1 / r2 / r3.

| recipe | source | A1 | **A2** | A2 min–max | A3 | per rAF | reps | verdict first>A1>A2 |
|---|---|--:|--:|--:|--:|--:|--:|---|
| pattern repeat | img-png | 0 / 0 / 0 | 0.501 / 0.405 / 0.41 | 0.405–0.501 | 3 / 3 / 3 | 102.11 / 80.14 / 86.85 | 204 / 198 / 212 | ACCEL>ACCEL>soft (all) |
| pattern repeat | bitmap | 0 / 0 / 0 | 0.469 / 0.391 / 0.4 | 0.391–0.469 | 2.5 / 2.5 / 2.5 | 112.63 / 93.92 / 100.03 | 240 / 240 / 250 | ACCEL>ACCEL>soft (all) |
| pattern repeat | canvas | 0 / 0 / 0 | 0.484 / 0.392 / 0.407 | 0.392–0.484 | 3 / 3 / 2.5 | 98.78 / 77.65 / 101.77 | 204 / 198 / 250 | ACCEL>ACCEL>soft (all) |
| clip + pre-tiled | img-png | 0 / 0 / 0 | 21.582 / 20.473 / 24.531 | 20.473–24.531 | 5 / 4 / 4 | 215.82 / 266.14 / 318.91 | 10 / 13 / 13 | ACCEL>ACCEL>soft (all) |
| clip + pre-tiled | bitmap | 0 / 0 / 0 | 21.465 / 20.148 / 24.487 | 20.148–24.487 | 5.5 / 4 / 4 | 214.65 / 261.93 / 318.33 | 10 / 13 / 13 | ACCEL>ACCEL>soft (all) |
| clip + pre-tiled | canvas | 0 / 0 / 0 | 21.194 / 20.269 / 24.49 | 20.269–24.49 | 5 / 4 / 4 | 211.94 / 263.5 / 318.36 | 10 / 13 / 13 | ACCEL>ACCEL>soft (all) |
| clip + per tile | img-png | 0.667 / 0.667 / 0.333 | 21.348 / 19.783 / 24.133 | 19.783–24.133 | 12.5 / 11.5 / 11.5 | 85.39 / 98.92 / 120.67 | 4 / 5 / 5 | ACCEL>ACCEL>soft (all) |
| clip + per tile | bitmap | 0.333 / 0.333 / 0.333 | 21.065 / 19.944 / 24.007 | 19.944–24.007 | 12 / 11 / 11.5 | 105.32 / 99.72 / 120.03 | 5 / 5 / 5 | ACCEL>ACCEL>soft (all) |
| clip + per tile | canvas | 0.667 / 0.667 / 0.667 | 20.765 / 20.457 / 24.067 | 20.457–24.067 | 11.5 / 11.5 / 11.5 | 103.82 / 102.29 / 120.33 | 5 / 5 / 5 | ACCEL>ACCEL>soft (all) |

#### Safari 26.6.2

`safari-imgM-gpu-r1.json`, `safari-imgM-gpu-r2.json`, `safari-imgM-gpu-r3.json` — cells are r1 / r2 / r3.

| recipe | source | A1 | **A2** | A2 min–max | A3 | per rAF | reps |
|---|---|--:|--:|--:|--:|--:|--:|
| pattern repeat | img-png | 0 / 0 / 0 | 34.038 / 34.087 / 34.8 | 34.038–34.8 | 7.5 / 7 / 7.5 | 238.27 / 272.69 / 243.6 | 7 / 8 / 7 |
| pattern repeat | bitmap | 0 / 0 / 0 | 30.142 / 30.233 / 31.777 | 30.142–31.777 | 7 / 7 / 7.5 | 241.13 / 241.87 / 222.44 | 8 / 8 / 7 |
| pattern repeat | canvas | 0 / 0 / 0 | 30.375 / 30.277 / 31.875 | 30.277–31.875 | 7 / 7.5 / 7.5 | 243 / 211.94 / 223.13 | 8 / 7 / 7 |
| clip + pre-tiled | img-png | 0 / 0 / 0 | 24.887 / 27.403 / 27.023 | 24.887–27.403 | 74.5 / 75 / 77 | 74.66 / 82.21 / 81.07 | 3 / 3 / 3 |
| clip + pre-tiled | bitmap | 0 / 0 / 0 | 24.764 / 27.136 / 27.068 | 24.764–27.136 | 74.5 / 79 / 75 | 74.29 / 81.41 / 81.2 | 3 / 3 / 3 |
| clip + pre-tiled | canvas | 0 / 0 / 0 | 24.764 / 27.114 / 27.152 | 24.764–27.152 | 74 / 77.5 / 76 | 74.29 / 81.34 / 81.45 | 3 / 3 / 3 |
| clip + per tile | img-png | 2.333 / 2.667 / 3 | 386.063 / 422.063 / 421.938 | 386.063–422.063 | 15.5 / 15.5 / 16 | 1544.25 / 1688.25 / 1687.75 | 4 / 4 / 4 |
| clip + per tile | bitmap | 0.667 / 1.667 / 1.667 | 374.2 / 399.222 / 386.7 | 374.2–399.222 | 179.5 / 189 / 189.5 | 374.2 / 399.22 / 386.7 | 1 / 1 / 1 |
| clip + per tile | canvas | 1.333 / 1.667 / 2 | 367.2 / 395.556 / 397.222 | 367.2–397.222 | 178.5 / 188 / 188.5 | 367.2 / 395.56 / 397.22 | 1 / 1 / 1 |

#### Firefox 156.0.1, software (`firefox-nonaccel`)

`firefox-nonaccel-imgM-gpu-r1.json`.

| recipe | source | A1 | **A2** | A3 | per rAF | reps | verdict first>A1>A2 |
|---|---|--:|--:|--:|--:|--:|---|
| pattern repeat | img-png | 3 | 3.09 | 3 | 52.52 | 17 | - |
| pattern repeat | bitmap | 2.667 | 2.93 | 3 | 49.8 | 17 | - |
| pattern repeat | canvas | 2.333 | 2.778 | 2.5 | 55.56 | 20 | - |
| clip + pre-tiled | img-png | 4.667 | 4.305 | 4.5 | 47.35 | 11 | - |
| clip + pre-tiled | bitmap | 3.667 | 4.192 | 4 | 54.49 | 13 | - |
| clip + pre-tiled | canvas | 4 | 4.443 | 4.5 | 53.32 | 12 | - |
| clip + per tile | img-png | 12 | 12.291 | 12 | 61.46 | 5 | - |
| clip + per tile | bitmap | 11.667 | 17.038 | 11.5 | 85.19 | 5 | - |
| clip + per tile | canvas | 13 | 13.925 | 14.5 | 55.7 | 4 | - |

### Part M, rep 1 (S22, one texture per face)

#### Chrome 153 (Graphite/Metal)

`edge-imgM1-gpu-r1.json`.

| recipe | source | A1 | **A2** | A3 | per rAF | reps |
|---|---|--:|--:|--:|--:|--:|
| pattern repeat | img-png | 0.1 | 0.421 | 3.55 | 76.58 | 182 |
| pattern repeat | bitmap | 0.067 | 0.618 | 3.15 | 59.32 | 96 |
| pattern repeat | canvas | 0.067 | 0.45 | 76.35 | 90.02 | 200 |
| clip + pre-tiled | img-png | 0.233 | 0.443 | 1.2 | 61.56 | 139 |
| clip + pre-tiled | bitmap | 0.2 | 0.475 | 1.35 | 68.39 | 144 |
| clip + pre-tiled | canvas | 0.2 | 0.494 | 1.45 | 70.66 | 143 |
| clip + per tile | img-png | 0.2 | 0.496 | 1.45 | 64.01 | 129 |
| clip + per tile | bitmap | 0.233 | 0.513 | 1.3 | 65.67 | 128 |
| clip + per tile | canvas | 0.2 | 0.5 | 1.55 | 72.48 | 145 |

#### Firefox 156.0.1, accelerated profile (`firefox-dbg`)

`firefox-dbg-imgM1-gpu-r1.json`.

| recipe | source | A1 | **A2** | A3 | per rAF | reps | verdict first>A1>A2 |
|---|---|--:|--:|--:|--:|--:|---|
| pattern repeat | img-png | 0 | 0.472 | 3.5 | 84.9 | 180 | ACCEL>ACCEL>soft |
| pattern repeat | bitmap | 0 | 0.507 | 3 | 107.39 | 212 | ACCEL>ACCEL>soft |
| pattern repeat | canvas | 0 | 0.48 | 2.5 | 112.22 | 234 | ACCEL>ACCEL>soft |
| clip + pre-tiled | img-png | 0 | 24.276 | 4.5 | 291.31 | 12 | ACCEL>ACCEL>soft |
| clip + pre-tiled | bitmap | 0 | 24.173 | 4.5 | 290.08 | 12 | ACCEL>ACCEL>soft |
| clip + pre-tiled | canvas | 0 | 24.045 | 4 | 312.58 | 13 | ACCEL>ACCEL>soft |
| clip + per tile | img-png | 0 | 24.16 | 4.5 | 289.92 | 12 | ACCEL>ACCEL>soft |
| clip + per tile | bitmap | 0 | 24.154 | 4.5 | 289.85 | 12 | ACCEL>ACCEL>soft |
| clip + per tile | canvas | 0 | 24.346 | 4.5 | 292.15 | 12 | ACCEL>ACCEL>soft |

#### Safari 26.6.2

`safari-imgM1-gpu-r1.json`.

| recipe | source | A1 | **A2** | A3 | per rAF | reps |
|---|---|--:|--:|--:|--:|--:|
| pattern repeat | img-png | 0 | 48.547 | 10 | 242.73 | 5 |
| pattern repeat | bitmap | 0 | 43.918 | 12 | 219.59 | 5 |
| pattern repeat | canvas | 0 | 33.167 | 13 | 132.67 | 4 |
| clip + pre-tiled | img-png | 0 | 26.909 | 18 | 80.73 | 3 |
| clip + pre-tiled | bitmap | 0 | 26.909 | 18 | 80.73 | 3 |
| clip + pre-tiled | canvas | 0 | 26.992 | 18 | 80.98 | 3 |
| clip + per tile | img-png | 0 | 29.109 | 7 | 232.88 | 8 |
| clip + per tile | bitmap | 0 | 28.813 | 18.5 | 86.44 | 3 |
| clip + per tile | canvas | 0 | 29.008 | 19.5 | 87.02 | 3 |

#### Firefox 156.0.1, software (`firefox-nonaccel`)

_not measured_

### Part B, image size sweep (16 whole-image `drawImage` per frame)

#### Chrome 153 (Graphite/Metal)

`edge-imgB-gpu-r1.json`, `edge-imgB-gpu-r2.json` — cells are r1 / r2.

| size | source | A1 | **A2** | A2 min–max | A3 | per rAF | reps |
|---|---|--:|--:|--:|--:|--:|--:|
| 256 | img-png | 0 / 0 | 0.081 / 0.074 | 0.074–0.081 | 2.3 / 2.8 | 333.79 / 274.07 | 4096 / 3686 |
| 256 | bitmap | 0 / 0 | 0.025 / 0.018 | 0.018–0.025 | 7 / 5.45 | 33.66 / 28.67 | 1321 / 1609 |
| 256 | canvas | 0 / 0 | 0.021 / 0.016 | 0.016–0.021 | 0.5 / 0.4 | 67.07 / 64.2 | 3177 / 4096 |
| 512 | img-png | 0 / 0 | 0.078 / 0.067 | 0.067–0.078 | 3.85 / 2.8 | 196.88 / 254.67 | 2516 / 3812 |
| 512 | bitmap | 0 / 0 | 0.025 / 0.5 F | 0.025–0.5 F | 5.3 / 2.5 | 40.67 / 10 | 1622 / 20 |
| 512 | canvas | 0 / 0 | 0.021 / 0.012 | 0.012–0.021 | 0.55 / 0.75 | 63.76 / 50.35 | 3056 / 4096 |
| 1024 | img-png | 0 / 0 | 0.129 / 0.116 | 0.116–0.129 | 3.4 / 2.75 | 352 / 444.67 | 2723 / 3837 |
| 1024 | bitmap | 0 / 0 | 0.909 F / 0.556 F | 0.556–0.909 F | 4.95 / 2.9 | 10 / 10 | 11 / 18 |
| 1024 | canvas | 0 / 0 | 0.022 / 0.011 | 0.011–0.022 | 0.7 / 0.8 | 91.13 / 45.76 | 4096 / 4096 |
| 2048 | img-png | 0 / 0 | 0.407 / 0.369 | 0.369–0.407 | 3.45 / 1.95 | 609.7 / 743.68 | 1499 / 2016 |
| 2048 | bitmap | 0 / 0 | 1 F / 0.345 F | 0.345–1 F | 5.1 / 1.75 | 10 / 10 | 10 / 29 |
| 2048 | canvas | 0 / 0 | 0.022 / 0.011 | 0.011–0.022 | 0.75 / 0.7 | 90.16 / 46.63 | 4096 / 4096 |
| 4096 | img-png | 0.033 / 0.033 | 2.622 / 2.22 | 2.22–2.622 | 3.05 / 2.15 | 582.01 / 492.8 | 222 / 222 |
| 4096 | bitmap | 0.167 / 0.1 | 0.851 / 0.806 | 0.806–0.851 | 16.8 / 14.15 | 171.93 / 182.06 | 202 / 226 |
| 4096 | canvas | 0.033 / 0 | 1.44 / 1.424 | 1.424–1.44 | 1.4 / 1.25 | 277.98 / 259.14 | 193 / 182 |

Derived from the A2 column above, r1 / r2. A ratio in parentheses involves a floored row (its denominator or numerator is an upper bound).

| size | img-png ÷ bitmap (A2) | img-png ÷ canvas (A2) |
|---|--:|--:|
| 256 | 3.24 / 4.11 | 3.86 / 4.63 |
| 512 | 3.12 / (0.13) | 3.71 / 5.58 |
| 1024 | (0.14) / (0.21) | 5.86 / 10.55 |
| 2048 | (0.41) / (1.07) | 18.50 / 33.55 |
| 4096 | 3.08 / 2.75 | 1.82 / 1.56 |

#### Firefox 156.0.1, accelerated profile (`firefox-dbg`)

`firefox-dbg-imgB-gpu-r1.json`, `firefox-dbg-imgB-gpu-r2.json` — cells are r1 / r2.

| size | source | A1 | **A2** | A2 min–max | A3 | per rAF | reps | verdict first>A1>A2 |
|---|---|--:|--:|--:|--:|--:|--:|---|
| 256 | img-png | 0 / 0 | 0.131 / 0.131 | 0.131–0.131 | 1.5 / 2 | 421.78 / 454.25 | 3213 / 3478 | ACCEL>ACCEL>soft (all) |
| 256 | bitmap | 0 / 0 | 0.116 / 0.12 | 0.116–0.12 | 3 / 3 | 459.38 / 443.13 | 3960 / 3696 | ACCEL>ACCEL>soft (all) |
| 256 | canvas | 0 / 0 | 0.12 / 0.119 | 0.119–0.12 | 2.5 / 3 | 491.88 / 453.75 | 4096 / 3804 | ACCEL>ACCEL>soft (all) |
| 512 | img-png | 0 / 0 | 0.131 / 0.124 | 0.124–0.131 | 4.5 / 1.5 | 271.85 / 506.43 | 2077 / 4096 | ACCEL>ACCEL>soft (all) |
| 512 | bitmap | 0 / 0 | 0.131 / 0.126 | 0.126–0.131 | 3.5 / 2.5 | 257.79 / 517.14 | 1973 / 4096 | ACCEL>ACCEL>soft (all) |
| 512 | canvas | 0 / 0 | 0.119 / 0.124 | 0.119–0.124 | 2.5 / 2 | 407.56 / 507.57 | 3439 / 4096 | ACCEL>ACCEL>soft (all) |
| 1024 | img-png | 0 / 0 | 0.207 / 0.174 | 0.174–0.207 | 1 / 1.5 | 746.8 / 713.8 | 3600 / 4096 | ACCEL>ACCEL>soft (all) |
| 1024 | bitmap | 0 / 0 | 0.166 / 0.174 | 0.166–0.174 | 3.5 / 2 | 402.22 / 707.6 | 2418 / 4077 | ACCEL>ACCEL>soft (all) |
| 1024 | canvas | 0 / 0 | 0.193 / 0.175 | 0.175–0.193 | 2.5 / 2 | 791.2 / 716.4 | 4096 / 4096 | ACCEL>ACCEL>soft (all) |
| 2048 | img-png | 0 / 0 | 0.265 / 0.267 | 0.265–0.267 | 3 / 1.5 | 1005.5 / 1092.25 | 3799 / 4096 | ACCEL>ACCEL>soft (all) |
| 2048 | bitmap | 0 / 0 | 0.276 / 0.264 | 0.264–0.276 | 2 / 1.5 | 1129.5 / 1082.5 | 4096 / 4096 | ACCEL>ACCEL>soft (all) |
| 2048 | canvas | 0 / 0 | 0.286 / 0.265 | 0.265–0.286 | 2 / 2.5 | 1169.5 / 1083.5 | 4096 / 4091 | ACCEL>ACCEL>soft (all) |
| 4096 | img-png | 0 / 0 | 0.294 / 0.272 | 0.272–0.294 | 2.5 / 1.5 | 1205 / 1113 | 4096 / 4096 | ACCEL>ACCEL>soft (all) |
| 4096 | bitmap | 0 / 0 | 0.272 / 0.267 | 0.267–0.272 | 4.5 / 2.5 | 528.43 / 1094 | 1944 / 4096 | ACCEL>ACCEL>soft (all) |
| 4096 | canvas | 0 / 0 | 0.283 / 0.271 | 0.271–0.283 | 2 / 2 | 1158.5 / 1111.75 | 4096 / 4096 | ACCEL>ACCEL>soft (all) |

Derived from the A2 column above, r1 / r2. A ratio in parentheses involves a floored row (its denominator or numerator is an upper bound).

| size | img-png ÷ bitmap (A2) | img-png ÷ canvas (A2) |
|---|--:|--:|
| 256 | 1.13 / 1.09 | 1.09 / 1.10 |
| 512 | 1.00 / 0.98 | 1.10 / 1.00 |
| 1024 | 1.25 / 1.00 | 1.07 / 0.99 |
| 2048 | 0.96 / 1.01 | 0.93 / 1.01 |
| 4096 | 1.08 / 1.02 | 1.04 / 1.00 |

#### Safari 26.6.2

`safari-imgB-gpu-r1.json`, `safari-imgB-gpu-r2.json` — cells are r1 / r2.

| size | source | A1 | **A2** | A2 min–max | A3 | per rAF | reps |
|---|---|--:|--:|--:|--:|--:|--:|
| 256 | img-png | 0 / 0 | 0.058 / 0.04 | 0.04–0.058 | 1 / 1 | 237.73 / 165.82 | 4096 / 4096 |
| 256 | bitmap | 0 / 0 | 0.049 / 0.046 | 0.046–0.049 | 3.5 / 2.5 | 154.83 / 141.16 | 3147 / 3093 |
| 256 | canvas | 0 / 0 | 0.588 F / 0.045 | 0.045–0.588 F | 3 / 3.5 | 10 / 177.7 | 17 / 3968 |
| 512 | img-png | 0 / 0 | 0.057 / 0.046 | 0.046–0.057 | 1 / 2 | 233.69 / 187.05 | 4096 / 4096 |
| 512 | bitmap | 0 / 0 | 0.055 / 0.048 | 0.048–0.055 | 7 / 4.5 | 225.63 / 197.5 | 4096 / 4096 |
| 512 | canvas | 0 / 0 | 1 F / 1 F | 1–1 F | 5 / 5.5 | 10 / 10 | 10 / 10 |
| 1024 | img-png | 0 / 0 | 0.097 / 0.054 | 0.054–0.097 | 1 / 1 | 396 / 219.38 | 4096 / 4096 |
| 1024 | bitmap | 0 / 0 | 0.079 / 0.071 | 0.071–0.079 | 13 / 12.5 | 323.45 / 289.08 | 4096 / 4096 |
| 1024 | canvas | 0 / 0 | 2.501 F / 2.501 F | 2.501–2.501 F | 12.5 / 13 | 10 / 10 | 4 / 4 |
| 2048 | img-png | 0 / 0 | 0.104 / 0.089 | 0.089–0.104 | 0.5 / 0.5 | 374 / 333.09 | 3600 / 3725 |
| 2048 | bitmap | 0 / 0 | 0.134 / 0.118 | 0.118–0.134 | 45.5 / 41 | 364.1 / 315.17 | 2725 / 2682 |
| 2048 | canvas | 0 / 0 | 0.139 / 5.001 F | 0.139–5.001 F | 75 / 41.5 | 407.11 / 10 | 2936 / 2 |
| 4096 | img-png | 0 / 0 | 0.228 / 0.171 | 0.171–0.228 | 2 / 0.5 | 539.43 / 636.83 | 2364 / 3725 |
| 4096 | bitmap | 0 / 0 | 0.227 / 0.188 | 0.188–0.227 | 243.5 / 149.5 | 588.17 / 506.14 | 2592 / 2694 |
| 4096 | canvas | 0 / 0 | 0.232 / 0.201 | 0.201–0.232 | 213.5 / 156.5 | 380.3 / 268.21 | 1639 / 1332 |

Derived from the A2 column above, r1 / r2. A ratio in parentheses involves a floored row (its denominator or numerator is an upper bound).

| size | img-png ÷ bitmap (A2) | img-png ÷ canvas (A2) |
|---|--:|--:|
| 256 | 1.18 / 0.87 | (0.10) / 0.89 |
| 512 | 1.04 / 0.96 | (0.06) / (0.05) |
| 1024 | 1.23 / 0.76 | (0.04) / (0.02) |
| 2048 | 0.78 / 0.75 | 0.75 / (0.02) |
| 4096 | 1.00 / 0.91 | 0.98 / 0.85 |

#### Firefox 156.0.1, software (`firefox-nonaccel`)

`firefox-nonaccel-imgM-gpu-r1.json`.

| size | source | A1 | **A2** | A3 | per rAF | reps | verdict first>A1>A2 |
|---|---|--:|--:|--:|--:|--:|---|
| 256 | img-png | 2.667 | 2.352 | 2.5 | 44.68 | 19 | - |
| 256 | bitmap | 1.667 | 1.925 | 1.5 | 57.74 | 30 | - |
| 256 | canvas | 1.333 | 1.701 | 1.5 | 57.84 | 34 | - |
| 512 | img-png | 1 | 1.492 | 1 | 74.6 | 50 | - |
| 512 | bitmap | 1.333 | 1.494 | 1 | 56.77 | 38 | - |
| 512 | canvas | 1 | 1.343 | 1 | 67.17 | 50 | - |
| 1024 | img-png | 1.333 | 1.599 | 1.5 | 54.35 | 34 | - |
| 1024 | bitmap | 1.333 | 1.603 | 1.5 | 54.51 | 34 | - |
| 1024 | canvas | 1 | 1.39 | 1 | 69.49 | 50 | - |
| 2048 | img-png | 1.333 | 1.664 | 1 | 63.25 | 38 | - |
| 2048 | bitmap | 1.333 | 1.662 | 1.5 | 56.5 | 34 | - |
| 2048 | canvas | 1 | 1.462 | 1.5 | 99.44 | 68 | - |
| 4096 | img-png | 1.333 | 1.832 | 1.5 | 62.28 | 34 | - |
| 4096 | bitmap | 1.333 | 1.903 | 1.5 | 64.69 | 34 | - |
| 4096 | canvas | 1.333 | 2.684 | 1.5 | 91.26 | 34 | - |

Derived from the A2 column above, r1. A ratio in parentheses involves a floored row (its denominator or numerator is an upper bound).

| size | img-png ÷ bitmap (A2) | img-png ÷ canvas (A2) |
|---|--:|--:|
| 256 | 1.22 | 1.38 |
| 512 | 1.00 | 1.11 |
| 1024 | 1.00 | 1.15 |
| 2048 | 1.00 | 1.14 |
| 4096 | 0.96 | 0.68 |

### Part D, round 1's parts on the fixed page

#### Chrome 153 (Graphite/Metal)

**Sprites (S).** `edge-img2-gpu-r1.json`, `edge-img2-gpu-r2.json` — cells are r1 / r2.

| recipe | source | A1 | **A2** | A2 min–max | A3 | per rAF | reps |
|---|---|--:|--:|--:|--:|--:|--:|
| drawImage | img-png | 0.4 / 0.4 | 1.761 / 1.752 | 1.752–1.761 | 7.5 / 7.4 | 63.4 / 68.34 | 36 / 39 |
| drawImage | img-jpg | 0.4 / 0.367 | 1.736 / 1.72 | 1.72–1.736 | 7.5 / 7.4 | 60.76 / 63.64 | 35 / 37 |
| drawImage | bitmap | 0.5 / 0.5 | 1.835 / 1.75 | 1.75–1.835 | 4.35 / 4.3 | 60.56 / 61.26 | 33 / 35 |
| drawImage | canvas | 0.433 / 0.4 | 1.786 / 1.572 | 1.572–1.786 | 3.1 / 2.95 | 73.24 / 69.18 | 41 / 44 |
| pattern fillRect | img-png | 0.3 / 0.267 | 11.927 / 11.858 | 11.858–11.927 | 12.45 / 11.55 | 59.64 / 59.29 | 5 / 5 |
| pattern fillRect | img-jpg | 0.267 / 0.233 | 11.863 / 11.742 | 11.742–11.863 | 11.65 / 11.8 | 59.32 / 58.71 | 5 / 5 |
| pattern fillRect | bitmap | 0.267 / 0.267 | 10.921 / 10.884 | 10.884–10.921 | 10.8 / 10.7 | 54.6 / 54.42 | 5 / 5 |
| pattern fillRect | canvas | 0.233 / 0.233 | 2.451 / 2.262 | 2.262–2.451 | 732.85 / 767.95 | 90.7 / 81.45 | 37 / 36 |
| drawImage rot+1.5x | img-png | 0.5 / 0.533 | 2.374 / 2.336 | 2.336–2.374 | 72.3 / 72.65 | 73.59 / 77.08 | 31 / 33 |
| drawImage rot+1.5x | img-jpg | 0.633 / 0.6 | 3.045 / 2.559 | 2.559–3.045 | 87.3 / 72.5 | 76.11 / 81.9 | 25 / 32 |
| drawImage rot+1.5x | bitmap | 0.633 / 0.633 | 2.893 / 2.481 | 2.481–2.893 | 70.75 / 67.85 | 81 / 76.92 | 28 / 31 |
| drawImage rot+1.5x | canvas | 0.733 / 0.6 | 2.608 / 2.196 | 2.196–2.608 | 4.8 / 4.2 | 75.63 / 81.25 | 29 / 37 |
| pattern rot+1.5x | img-png | 0.3 / 0.267 | 170.462 / 161.577 | 161.577–170.462 | 171.35 / 160.15 | 170.46 / 161.58 | 1 / 1 |
| pattern rot+1.5x | img-jpg | 0.3 / 0.3 | 171.3 / 161.309 | 161.309–171.3 | 171.65 / 159.9 | 171.3 / 161.31 | 1 / 1 |
| pattern rot+1.5x | bitmap | 0.3 / 0.3 | 170.414 / 159.468 | 159.468–170.414 | 168.15 / 159.1 | 170.41 / 159.47 | 1 / 1 |
| pattern rot+1.5x | canvas | 0.267 / 0.267 | 3.943 / 2.568 | 2.568–3.943 | 896.5 / 934.1 | 98.56 / 77.05 | 25 / 30 |

**Triangles (T).** `edge-img2-gpu-r1.json`, `edge-img2-gpu-r2.json` — cells are r1 / r2.

| recipe | source | A1 | **A2** | A2 min–max | A3 | per rAF | reps |
|---|---|--:|--:|--:|--:|--:|--:|
| clip + drawImage | img-png | 1.433 / 0.667 | 2.347 / 2.063 | 2.063–2.347 | 24.4 / 12.6 | 75.1 / 103.17 | 32 / 50 |
| clip + drawImage | img-jpg | 0.767 / 0.6 | 2.866 / 2.299 | 2.299–2.866 | 13.35 / 10.1 | 143.3 / 137.93 | 50 / 60 |
| clip + drawImage | bitmap | 0.833 / 0.7 | 2.479 / 2.049 | 2.049–2.479 | 12.85 / 9.6 | 61.98 / 71.72 | 25 / 35 |
| clip + drawImage | canvas | 0.767 / 0.633 | 2.335 / 2.173 | 2.173–2.335 | 4.85 / 3.95 | 72.38 / 95.6 | 31 / 44 |
| pattern fill | img-png | 0.3 / 0.233 | 2.113 / 1.619 | 1.619–2.113 | 4.8 / 4 | 73.95 / 77.73 | 35 / 48 |
| pattern fill | img-jpg | 0.3 / 0.2 | 2.787 / 1.769 | 1.769–2.787 | 4.8 / 3.75 | 103.11 / 84.9 | 37 / 48 |
| pattern fill | bitmap | 0.367 / 0.2 | 2.345 / 1.656 | 1.656–2.345 | 4.2 / 2.8 | 70.34 / 77.84 | 30 / 47 |
| pattern fill | canvas | 0.267 / 0.2 | 1.826 / 1.526 | 1.526–1.826 | 3.1 / 2.7 | 91.3 / 85.45 | 50 / 56 |

**First use (F).** `edge-img2-gpu-r1.json`, `edge-img2-gpu-r2.json` — cells are r1 / r2. Median of 7 trials, ms.

| preparation | prep | block | **first** | second |
|---|--:|--:|--:|--:|
| img-png (onload only) | 1.4 / 1.3 | 0 / 0 | 32.5 / 28.7 | 29.3 / 25.4 |
| img-png + decode() | 28.3 / 26.4 | 0 / 0 | 30 / 28.3 | 27.5 / 25.5 |
| img-jpg (onload only) | 0.8 / 0.8 | 0 / 0 | 16.8 / 17 | 17.7 / 17.7 |
| img-jpg + decode() | 14.4 / 14.6 | 0 / 0 | 16.9 / 16.9 | 17.9 / 17.8 |
| img-png, 1:1 draw | 1.5 / 1.3 | 0 / 0 | 27.8 / 28.3 | 24 / 24 |
| img-png + decode(), 1:1 | 26.2 / 26.3 | 0 / 0 | 28.2 / 28.3 | 23.9 / 24.1 |
| bitmap (png blob) | 25 / 25.2 | 0 / 0 | 4 / 3.4 | 1.8 / 1.8 |
| bitmap (jpg blob) | 16.1 / 16.3 | 0 / 0 | 3.6 / 3.3 | 1.8 / 1.8 |
| bitmap (from decoded img) | 51.2 / 51.2 | 0 / 0 | 4.1 / 3.8 | 1.8 / 1.7 |
| canvas (img drawn in) | 28.7 / 28.7 | 27.4 / 27.4 | 1.6 / 1.5 | 2.4 / 2.4 |

**Bleed (X), CPU and GPU backends.** `edge-img2-gpu-r1.json`, `edge-img2-gpu-r2.json` — cells are r1 / r2; "(all)" = identical in every repetition. Pixels of 921 600 that change with the gutter colour.

| recipe | source | CPU px0 | CPU px16 | CPU maxD | **GPU/default px0** | GPU/default px16 | GPU/default maxD |
|---|---|--:|--:|--:|--:|--:|--:|
| drawImage | img-png | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| drawImage | bitmap | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| drawImage | canvas | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| pattern fillRect | img-png | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| pattern fillRect | bitmap | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| pattern fillRect | canvas | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| drawImage rot+1.5x | img-png | 45046 (all) | 35945 (all) | 124 (all) | 43728 (all) | 36215 (all) | 114 (all) |
| drawImage rot+1.5x | bitmap | 45046 (all) | 35945 (all) | 124 (all) | 43728 (all) | 36215 (all) | 114 (all) |
| drawImage rot+1.5x | canvas | 43728 (all) | 36215 (all) | 114 (all) | 43728 (all) | 36215 (all) | 114 (all) |
| pattern rot+1.5x | img-png | 46830 (all) | 37473 (all) | 119 (all) | 46830 (all) | 37473 (all) | 119 (all) |
| pattern rot+1.5x | bitmap | 46830 (all) | 37473 (all) | 119 (all) | 46830 (all) | 37473 (all) | 119 (all) |
| pattern rot+1.5x | canvas | 46830 (all) | 37473 (all) | 119 (all) | 43767 (all) | 36217 (all) | 114 (all) |

#### Firefox 156.0.1, accelerated profile (`firefox-dbg`)

**Sprites (S).** `firefox-dbg-img2-gpu-r1.json`, `firefox-dbg-img2-gpu-r2.json` — cells are r1 / r2.

| recipe | source | A1 | **A2** | A2 min–max | A3 | per rAF | reps | verdict first>A1>A2 |
|---|---|--:|--:|--:|--:|--:|--:|---|
| drawImage | img-png | 0 / 0 | 1.533 / 1.46 | 1.46–1.533 | 6.5 / 6.5 | 73.59 / 73 | 48 / 50 | ACCEL>ACCEL>soft (all) |
| drawImage | img-jpg | 0.333 / 0 | 2.418 / 1.447 | 1.447–2.418 | 6.5 / 4 | 77.37 / 83.95 | 32 / 58 | ACCEL>ACCEL>soft (all) |
| drawImage | bitmap | 0 / 0 | 2.102 / 1.666 | 1.666–2.102 | 9 / 6 | 88.28 / 89.95 | 42 / 54 | ACCEL>ACCEL>soft (all) |
| drawImage | canvas | 0.333 / 0.333 | 2.017 / 1.91 | 1.91–2.017 | 5.5 / 5 | 90.74 / 84.05 | 45 / 44 | ACCEL>ACCEL>soft (all) |
| pattern fillRect | img-png | 0 / 0 | 1.974 / 2.248 | 1.974–2.248 | 8.5 / 8.5 | 78.96 / 85.41 | 40 / 38 | ACCEL>ACCEL>soft (all) |
| pattern fillRect | img-jpg | 0 / 0.333 | 1.976 / 2.089 | 1.976–2.089 | 5.5 / 9.5 | 73.1 / 43.86 | 37 / 21 | ACCEL>ACCEL>soft (all) |
| pattern fillRect | bitmap | 0 / 0 | 2.233 / 2.102 | 2.102–2.233 | 9 / 8 | 80.39 / 98.78 | 36 / 47 | ACCEL>ACCEL>soft (all) |
| pattern fillRect | canvas | 0.333 / 0.333 | 2.227 / 2.037 | 2.037–2.227 | 6 / 6 | 84.64 / 85.56 | 38 / 42 | ACCEL>ACCEL>soft (all) |
| drawImage rot+1.5x | img-png | 0.333 / 0 | 2.596 / 2.869 | 2.596–2.869 | 68.5 / 73.5 | 109.03 / 134.85 | 42 / 47 | ACCEL>ACCEL>soft (all) |
| drawImage rot+1.5x | img-jpg | 0.333 / 0.333 | 2.481 / 2.848 | 2.481–2.848 | 68.5 / 72.5 | 104.21 / 142.4 | 42 / 50 | ACCEL>ACCEL>soft (all) |
| drawImage rot+1.5x | bitmap | 0 / 0 | 2.455 / 2.867 | 2.455–2.867 | 74 / 78.5 | 103.11 / 120.43 | 42 / 42 | ACCEL>ACCEL>soft (all) |
| drawImage rot+1.5x | canvas | 0.333 / 0 | 2.473 / 2.869 | 2.473–2.869 | 70 / 76 | 101.4 / 88.95 | 41 / 31 | ACCEL>ACCEL>soft (all) |
| pattern rot+1.5x | img-png | 0 / 0 | 2.538 / 2.933 | 2.538–2.933 | 73 / 80 | 106.61 / 140.8 | 42 / 48 | ACCEL>ACCEL>soft (all) |
| pattern rot+1.5x | img-jpg | 0 / 0 | 2.441 / 2.929 | 2.441–2.929 | 70 / 78 | 107.42 / 105.44 | 44 / 36 | ACCEL>ACCEL>soft (all) |
| pattern rot+1.5x | bitmap | 0 / 0 | 2.434 / 2.863 | 2.434–2.863 | 74 / 81.5 | 102.23 / 103.09 | 42 / 36 | ACCEL>ACCEL>soft (all) |
| pattern rot+1.5x | canvas | 0 / 0 | 2.421 / 2.874 | 2.421–2.874 | 70.5 / 77.5 | 106.55 / 103.47 | 44 / 36 | ACCEL>ACCEL>soft (all) |

**Triangles (T).** `firefox-dbg-img2-gpu-r1.json`, `firefox-dbg-img2-gpu-r2.json` — cells are r1 / r2.

| recipe | source | A1 | **A2** | A2 min–max | A3 | per rAF | reps | verdict first>A1>A2 |
|---|---|--:|--:|--:|--:|--:|--:|---|
| clip + drawImage | img-png | 1 / 1 | 70.596 / 88.55 | 70.596–88.55 | 13 / 15.5 | 282.38 / 354.2 | 4 / 4 | ACCEL>ACCEL>soft (all) |
| clip + drawImage | img-jpg | 0.333 / 0.333 | 69.661 / 88.452 | 69.661–88.452 | 8 / 8 | 487.63 / 619.17 | 7 / 7 | ACCEL>ACCEL>soft (all) |
| clip + drawImage | bitmap | 0.333 / 0.333 | 69.648 / 88.5 | 69.648–88.5 | 8.5 / 8.5 | 417.89 / 531 | 6 / 6 | ACCEL>ACCEL>soft (all) |
| clip + drawImage | canvas | 0.333 / 0.333 | 69.875 / 87.976 | 69.875–87.976 | 8 / 8.5 | 489.13 / 527.86 | 7 / 6 | ACCEL>ACCEL>soft (all) |
| pattern fill | img-png | 0 / 0 | 2.574 / 2.666 | 2.574–2.666 | 4.5 / 4 | 79.8 / 82.65 | 31 / 31 | ACCEL>ACCEL>soft (all) |
| pattern fill | img-jpg | 0 / 0 | 2.581 / 2.758 | 2.581–2.758 | 4 / 4 | 80 / 91.03 | 31 / 33 | ACCEL>ACCEL>soft (all) |
| pattern fill | bitmap | 0 / 0 | 2.609 / 2.663 | 2.609–2.663 | 4.5 / 4.5 | 80.89 / 79.89 | 31 / 30 | ACCEL>ACCEL>soft (all) |
| pattern fill | canvas | 0 / 0 | 2.583 / 2.657 | 2.583–2.657 | 3.5 / 3.5 | 80.07 / 82.37 | 31 / 31 | ACCEL>ACCEL>soft (all) |

**First use (F).** `firefox-dbg-img2-gpu-r1.json`, `firefox-dbg-img2-gpu-r2.json` — cells are r1 / r2. Median of 7 trials, ms.

| preparation | prep | block | **first** | second | verdict |
|---|--:|--:|--:|--:|---|
| img-png (onload only) | 1 / 1 | 0 / 0 | 32 / 34 | 2 / 1 | ACCEL (all) |
| img-png + decode() | 29 / 29 | 0 / 0 | 4 / 4 | 2 / 2 | ACCEL (all) |
| img-jpg (onload only) | 0 / 0 | 0 / 0 | 31 / 30 | 3 / 3 | ACCEL (all) |
| img-jpg + decode() | 28 / 27 | 0 / 0 | 4 / 4 | 1 / 1 | ACCEL (all) |
| img-png, 1:1 draw | 1 / 1 | 0 / 0 | 33 / 33 | 2 / 1 | ACCEL (all) |
| img-png + decode(), 1:1 | 30 / 29 | 0 / 0 | 4 / 4 | 1 / 1 | ACCEL (all) |
| bitmap (png blob) | 29 / 29 | 0 / 0 | 4 / 4 | 2 / 1 | ACCEL (all) |
| bitmap (jpg blob) | 26 / 27 | 0 / 0 | 4 / 5 | 2 / 1 | ACCEL (all) |
| bitmap (from decoded img) | 29 / 30 | 0 / 0 | 4 / 4 | 2 / 1 | ACCEL (all) |
| canvas (img drawn in) | 36 / 36 | 35 / 35 | 2 / 2 | 1 / 2 | ACCEL (all) |

**Bleed (X), CPU and GPU backends.** `firefox-dbg-img2-gpu-r1.json`, `firefox-dbg-img2-gpu-r2.json` — cells are r1 / r2; "(all)" = identical in every repetition. Pixels of 921 600 that change with the gutter colour.

| recipe | source | CPU px0 | CPU px16 | CPU maxD | **GPU/default px0** | GPU/default px16 | GPU/default maxD |
|---|---|--:|--:|--:|--:|--:|--:|
| drawImage | img-png | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| drawImage | bitmap | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| drawImage | canvas | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| pattern fillRect | img-png | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| pattern fillRect | bitmap | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| pattern fillRect | canvas | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| drawImage rot+1.5x | img-png | 0 (all) | 0 (all) | 0 (all) | 43766 (all) | 37679 (all) | 120 (all) |
| drawImage rot+1.5x | bitmap | 0 (all) | 0 (all) | 0 (all) | 43766 (all) | 37679 (all) | 120 (all) |
| drawImage rot+1.5x | canvas | 0 (all) | 0 (all) | 0 (all) | 43766 (all) | 37679 (all) | 120 (all) |
| pattern rot+1.5x | img-png | 0 (all) | 0 (all) | 0 (all) | 43763 (all) | 37679 (all) | 121 (all) |
| pattern rot+1.5x | bitmap | 0 (all) | 0 (all) | 0 (all) | 43763 (all) | 37679 (all) | 121 (all) |
| pattern rot+1.5x | canvas | 45063 (all) | 35953 (all) | 124 (all) | 43763 (all) | 37679 (all) | 121 (all) |

#### Safari 26.6.2

**Sprites (S).** `safari-img2-gpu-r1.json`, `safari-img2-gpu-r2.json` — cells are r1 / r2.

| recipe | source | A1 | **A2** | A2 min–max | A3 | per rAF | reps |
|---|---|--:|--:|--:|--:|--:|--:|
| drawImage | img-png | 0.333 / 0.333 | 1.072 / 1.039 | 1.039–1.072 | 66 / 66 | 81.5 / 74.81 | 76 / 72 |
| drawImage | img-jpg | 0.333 / 0.333 | 1.217 / 1.14 | 1.14–1.217 | 56.5 / 55 | 87.6 / 82.07 | 72 / 72 |
| drawImage | bitmap | 0 / 0 | 1.48 / 1.433 | 1.433–1.48 | 168 / 170 | 106.55 / 103.14 | 72 / 72 |
| drawImage | canvas | 0 / 0 | 1.52 / 1.471 | 1.471–1.52 | 169 / 170 | 109.42 / 105.94 | 72 / 72 |
| pattern fillRect | img-png | 0 / 0 | 175.65 / 166.81 | 166.81–175.65 | 73.5 / 74.5 | 175.65 / 166.81 | 1 / 1 |
| pattern fillRect | img-jpg | 0 / 0 | 162.909 / 167.952 | 162.909–167.952 | 69.5 / 70.5 | 162.91 / 167.95 | 1 / 1 |
| pattern fillRect | bitmap | 0 / 0.333 | 164.25 / 167.542 | 164.25–167.542 | 16.5 / 16.5 | 657 / 670.17 | 4 / 4 |
| pattern fillRect | canvas | 0 / 0.333 | 164.625 / 167.625 | 164.625–167.625 | 16 / 16.5 | 658.5 / 670.5 | 4 / 4 |
| drawImage rot+1.5x | img-png | 0.667 / 0.667 | 1.229 / 2.006 | 1.229–2.006 | 146 / 146 | 88.51 / 144.44 | 72 / 72 |
| drawImage rot+1.5x | img-jpg | 0.667 / 0.333 | 2.349 / 2.079 | 2.079–2.349 | 161.5 / 142 | 169.14 / 149.71 | 72 / 72 |
| drawImage rot+1.5x | bitmap | 0.333 / 0.333 | 2.726 / 2.198 | 2.198–2.726 | 273.5 / 275 | 196.28 / 158.26 | 72 / 72 |
| drawImage rot+1.5x | canvas | 0.333 / 0.333 | 2.877 / 2.321 | 2.321–2.877 | 274.5 / 273.5 | 207.18 / 167.14 | 72 / 72 |
| pattern rot+1.5x | img-png | 0.333 / 0.333 | 358.7 / 328 | 328–358.7 | 271.5 / 275.5 | 358.7 / 328 | 1 / 1 |
| pattern rot+1.5x | img-jpg | 0.333 / 0.333 | 340.091 / 315.083 | 315.083–340.091 | 282 / 261 | 340.09 / 315.08 | 1 / 1 |
| pattern rot+1.5x | bitmap | 0.333 / 0 | 256.071 / 240.4 | 240.4–256.071 | 195 / 184 | 256.07 / 240.4 | 1 / 1 |
| pattern rot+1.5x | canvas | 0.333 / 0.333 | 254.643 / 240.467 | 240.467–254.643 | 190.5 / 184.5 | 254.64 / 240.47 | 1 / 1 |

**Triangles (T).** `safari-img2-gpu-r1.json`, `safari-img2-gpu-r2.json` — cells are r1 / r2.

| recipe | source | A1 | **A2** | A2 min–max | A3 | per rAF | reps |
|---|---|--:|--:|--:|--:|--:|--:|
| clip + drawImage | img-png | 0.667 / 0.667 | 99.806 / 100.361 | 99.806–100.361 | 14 / 15 | 399.22 / 401.44 | 4 / 4 |
| clip + drawImage | img-jpg | 0.667 / 0.667 | 96.675 / 97 | 96.675–97 | 14 / 14 | 386.7 / 388 | 4 / 4 |
| clip + drawImage | bitmap | 0.333 / 0.333 | 95.135 / 96.459 | 95.135–96.459 | 91.5 / 92 | 95.14 / 96.46 | 1 / 1 |
| clip + drawImage | canvas | 0.333 / 0.333 | 95.351 / 95.378 | 95.351–95.378 | 95.5 / 92.5 | 95.35 / 95.38 | 1 / 1 |
| pattern fill | img-png | 0 / 0 | 102.528 / 101.611 | 101.611–102.528 | 17.5 / 18 | 307.58 / 304.83 | 3 / 3 |
| pattern fill | img-jpg | 0 / 0 | 102.083 / 101.306 | 101.306–102.083 | 18 / 18 | 306.25 / 303.92 | 3 / 3 |
| pattern fill | bitmap | 0 / 0 | 103.25 / 102.194 | 102.194–103.25 | 16.5 / 16.5 | 413 / 408.78 | 4 / 4 |
| pattern fill | canvas | 0 / 0 | 102.556 / 102.194 | 102.194–102.556 | 17 / 16.5 | 307.67 / 408.78 | 3 / 4 |

**First use (F).** `safari-img2-gpu-r1.json`, `safari-img2-gpu-r2.json` — cells are r1 / r2. Median of 7 trials, ms.

| preparation | prep | block | **first** | second |
|---|--:|--:|--:|--:|
| img-png (onload only) | 1 / 1 | 0 / 0 | 31 / 31 | 1 / 1 |
| img-png + decode() | 28 / 28 | 0 / 0 | 4 / 3 | 1 / 1 |
| img-jpg (onload only) | 1 / 0 | 0 / 0 | 22 / 22 | 1 / 1 |
| img-jpg + decode() | 23 / 23 | 0 / 0 | 3 / 3 | 1 / 1 |
| img-png, 1:1 draw | 1 / 1 | 0 / 0 | 31 / 31 | 1 / 1 |
| img-png + decode(), 1:1 | 28 / 27 | 0 / 0 | 4 / 3 | 1 / 1 |
| bitmap (png blob) | 25 / 26 | 0 / 0 | 7 / 7 | 1 / 1 |
| bitmap (jpg blob) | 21 / 21 | 0 / 0 | 2 / 2 | 1 / 1 |
| bitmap (from decoded img) | 30 / 29 | 0 / 0 | 2 / 3 | 1 / 1 |
| canvas (img drawn in) | 33 / 33 | 32 / 32 | 1 / 1 | 1 / 1 |

**Bleed (X), CPU and GPU backends.** `safari-img2-gpu-r1.json`, `safari-img2-gpu-r2.json` — cells are r1 / r2; "(all)" = identical in every repetition. Pixels of 921 600 that change with the gutter colour.

| recipe | source | CPU px0 | CPU px16 | CPU maxD | **GPU/default px0** | GPU/default px16 | GPU/default maxD |
|---|---|--:|--:|--:|--:|--:|--:|
| drawImage | img-png | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| drawImage | bitmap | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| drawImage | canvas | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| pattern fillRect | img-png | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| pattern fillRect | bitmap | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| pattern fillRect | canvas | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| drawImage rot+1.5x | img-png | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| drawImage rot+1.5x | bitmap | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| drawImage rot+1.5x | canvas | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) | 0 (all) |
| pattern rot+1.5x | img-png | 43634 (all) | 31426 (all) | 124 (all) | 45159 / 45158 | 35799 / 35798 | 146 (all) |
| pattern rot+1.5x | bitmap | 43633 (all) | 31425 (all) | 124 (all) | 45158 (all) | 35798 (all) | 146 (all) |
| pattern rot+1.5x | canvas | 43633 (all) | 31425 (all) | 124 (all) | 45158 (all) | 35798 (all) | 146 (all) |

## Answers

### Q1. The 3D recipe (part M, rep 4): which is cheapest, and by how much?

**Chrome: `pattern repeat` and `clip + pre-tiled` tie. Firefox: `pattern
repeat`, by at least 39×. Safari: `clip + pre-tiled`, by 1.11–1.40×. `clip +
per tile` is the dearest everywhere at rep 4.** All figures are A2.

- **Chrome (Graphite).**
  - **The two cheap recipes tie.** From `img-png`: pattern 0.434–0.464 ms,
    pre-tiled 0.442–0.456 (ratio 0.95–1.05). From a canvas: 0.501–0.528
    against 0.452–0.543 (0.92–1.17).
  - From a bitmap, pre-tiled is 1.26–1.42× cheaper: pattern 0.633–0.64 against
    pre-tiled 0.451–0.501.
  - **`clip + per tile` costs 4.468–5.15 ms, 7.8–11.4× the other two.**
  - At rep 1 (one run), per tile stops losing: 0.496–0.513 against pre-tiled
    0.443–0.494 and pattern 0.421–0.618. Per source, the three recipes are
    within 1.3× of each other, and the pattern from a bitmap is the slowest
    cell.
- **Firefox, accelerated profile. Every row is `ACCEL>ACCEL>soft`, so these
  are mixed-regime figures.**
  - `pattern repeat` costs 0.391–0.501 ms. `clip + pre-tiled` costs
    20.148–24.531 and `clip + per tile` 19.783–24.133. The pattern is **at
    least 39.5× cheaper**, and the two clip recipes tie (0.81–1.19).
  - At rep 1 the pattern costs 0.472–0.507 against 24.045–24.346 for either
    clip recipe, 47.6–51.4×.
  - The clip rows cost more than the software profile's for the same recipe
    (below): pre-tiled 4.5–5.9× (software 4.192–4.443), per tile 1.2–2.0×
    (software 12.291–17.038). Which phase of the demoting loop the time went
    to is **not measured**.
- **Firefox software (control, one run).** `pattern repeat` 2.778–3.09 ms,
  pre-tiled 4.192–4.443 (**1.39–1.60×**), per tile 12.291–17.038
  (**3.98–5.82×**). Not measured at rep 1.
- **Safari.** **`clip + pre-tiled` is cheapest**, at 24.764–27.403 ms.
  - `pattern repeat` costs 30.142–34.8, **1.11–1.40× dearer**.
  - `clip + per tile` costs 367.2–422.063, **13.5–17.0×**.
  - *These recipes draw measurably different pictures on Safari* (RMSE 11.3
    and 17.4, sanity check 3).
  - At rep 1 (one run), pre-tiled costs 26.909–26.992. Per tile ties with it
    (28.813–29.109, 1.07–1.08×). The pattern is 1.23–1.80× dearer
    (33.167–48.547), most from `img-png`.

**Does the answer change at rep 1?** Only for `clip + per tile`. It stops
losing on Chrome and Safari, because at rep 1 it is one `drawImage` per face.
The ranking of the other two stays put on all three engines.

### Q2. The source for textures (part M)

**No source is far behind on any engine. The Safari claim, that a PNG pattern
is re-decoded and a small canvas fixes it, is not supported at rep 4:** the
`<img>` pattern is at most 1.15× the small canvas, and a bitmap made from the
same PNG is as fast as the canvas.

- **Chrome, `pattern repeat`.** Ranking: `img-png` 0.434–0.464 < canvas
  0.501–0.528 < bitmap 0.633–0.64. The bitmap is **1.36–1.47× the `<img>`**,
  and at rep 1, 0.618 against 0.421.
  - `clip + pre-tiled` shows no ranking (0.442–0.543), as expected: every
    source draws a pre-tiled *canvas*, and the source is used only at load.
  - `clip + per tile` puts the bitmap 1.09–1.12× dearer, which is noise level.
- **Firefox, accelerated profile (`ACCEL>ACCEL>soft`).** No ranking. The
  pattern costs 0.391–0.501 from every source, and the clip recipes sit within
  1–2 % across sources in each repetition.
- **Firefox software.** Pattern: `img-png` 3.09 ms, bitmap 2.93, canvas 2.778,
  so the `<img>` is 1.11× the canvas. Per tile: bitmap 17.038 against
  12.291–13.925 for the others.
- **Safari, the claim under test.**
  - At **rep 4**, `pattern repeat` costs 34.038–34.8 ms from `img-png`,
    **30.277–31.875 from the small canvas** and 30.142–31.777 from a bitmap.
    The `<img>` is **1.07–1.15×** the canvas, and the bitmap is level with it.
  - At **rep 1** (one run), the gap is larger: `img-png` 48.547, bitmap
    43.918, canvas 33.167, so **1.46×** and 1.32×.
  - A small pre-rendered canvas is never slower, but "much slower from a PNG"
    appears only at rep 1, in a single run.
  - Nothing here measures a decode, so "re-decodes" is **not measured** either
    way.
  - Pre-tiled ties across sources (24.764–27.403 ms). Per tile puts the
    `<img>` at 1.0–1.15×.

### Q3. Image size (part B)

**On Chrome an `<img>` costs more than 1.5× its bitmap from the smallest size
tested, 256 px, wherever the bitmap row is resolved. On Firefox and Safari it
never does.** A2, 16 whole-image draws per rep:

- **Chrome.**

  | size | `<img>` ÷ bitmap |
  |---|---|
  | 256 | 3.24 / 4.11 |
  | 512 | 3.12 (r1; r2's bitmap row is floored) |
  | 1024 | not resolved: the bitmap is floored in both repetitions |
  | 2048 | not resolved: the bitmap is floored in both repetitions |
  | 4096 | 3.08 / 2.75 |

  - At 1024 and 2048 the `<img>` is **5.86 / 10.55×** and **18.50 / 33.55×**
    the canvas.
  - The `<img>` grows from 0.067–0.081 ms at 256–512 to 0.116–0.129 (1024),
    0.369–0.407 (2048) and 2.22–2.622 (4096).
  - The canvas stays at 0.011–0.022 up to 2048, then costs 1.424–1.44 at
    4096, which is *more* than the bitmap's 0.806–0.851 there.
- **Firefox, accelerated profile (`ACCEL>ACCEL>soft` in all 30 rows).**
  `<img>` ÷ bitmap is 0.96–1.25 at every size. All sources cost 0.116–0.294
  ms.
- **Safari.** `<img>` ÷ bitmap is 0.75–1.23 at every size. At 2048 the
  `<img>` is the cheaper source (0.089–0.104 against 0.118–0.134).
- **Firefox software.** 0.96–1.22.

### Q4. Round 1 re-checked (part D)

**Every row round 1 left on the refresh floor is now measured. No round-1
ranking reverses; several gaps turn out much larger than round 1's bounds.**
A2, r1–r2.

| engine | row round 1 left floored | round 1 | now |
|---|---|--:|--:|
| Chrome | pattern `fillRect`, canvas | ≤ 10.0 | **2.262–2.451** |
| Chrome | `drawImage` rotated, `img-png` / `img-jpg` / bitmap | ≤ 10.0 | **2.336–2.374 / 2.559–3.045 / 2.481–2.893** |
| Chrome | pattern rotated, canvas | ≤ 10.06 | **2.568–3.943** |
| Chrome | `clip + drawImage`, `img-png` / `img-jpg` (partly floored) | ≤ 1.605–1.692 | **2.063–2.347 / 2.299–2.866** |
| Firefox (`ACCEL>ACCEL>soft`) | `drawImage` rotated, all four sources | ≤ 5.0 or ≤ 10.0 | **2.455–2.869** |
| Firefox (`ACCEL>ACCEL>soft`) | pattern rotated, all four sources | ≤ 5.0 | **2.421–2.933** |
| Safari | `drawImage` 1:1, `img-png` / `img-jpg` / bitmap / canvas | ≤ 10.0 / ≤ 5.0 / ≤ 10.0 / ≤ 10.0 | **1.039–1.072 / 1.14–1.217 / 1.433–1.48 / 1.471–1.52** |
| Safari | `drawImage` rotated, all four sources | ≤ 10.0 | **1.229–2.877** |

**Rankings:**

- **Chrome, sprites:** `drawImage` is still cheaper.
  - Unscaled, the pattern costs 5.93–6.90× from `<img>` and bitmap. From a
    canvas it now resolves to **1.27–1.56×**.
  - Rotated, the pattern costs **52.98–72.97×** from `<img>` and bitmap
    (round 1's bound was at least 15.96×). From a canvas it is 0.98–1.80×.
- **Chrome, triangles:** the pattern is still cheaper. Per repetition,
  clip ÷ pattern is 1.11 / 1.27 (`img-png`), 1.03 / 1.30 (`img-jpg`),
  1.06 / 1.24 (bitmap) and 1.28 / 1.42 (canvas). r1's `<img>` and bitmap
  pairs are inside the 10 % noise.
- **Chrome, source:** a pattern from a canvas stays the exception.
  - Unscaled, it costs 2.262–2.451 against 10.884–11.927 from `<img>` or
    bitmap, **4.4–5.3×** cheaper.
  - Rotated, 2.568–3.943 against 159.468–171.3, **at least 40×**.
- **Firefox, accelerated profile:** the rotated recipes tie (pattern ÷
  `drawImage` 0.84–1.18). Unscaled, the pattern is 0.82–1.54× `drawImage`,
  leaning towards `drawImage`, as round 1's tie did. Triangles: clip costs
  **26.70–33.23×** the pattern, per repetition.
- **Safari:** `drawImage` wins by far more than round 1 could show.
  - Unscaled, the pattern is **108.31–169.06×**; rotated, **83.58–291.86×**.
    Round 1's bounds were at least 16.3× and 23.9×.
  - Triangles still tie: clip ÷ pattern is 0.92–0.99.
  - **One source ranking is new: on Safari the `<img>` is the cheapest
    `drawImage` source**, 1.039–1.072 ms unscaled, against 1.433–1.52 for a
    bitmap or canvas. That makes the canvas 1.37–1.46× dearer.
- **First use (F)** is unchanged on every engine.
  - Chrome's `<img>` second draw costs 23.9–29.3 ms, against 1.7–1.8 for a
    bitmap.
  - `decode()` still does nothing on Chrome (first draw 28.3–30).
  - Firefox's first-use targets read `ACCEL` throughout.

**GPU bleed against CPU bleed** (part X, pixels of 921 600 that change with
the gutter colour; identical in both repetitions except where shown):

| engine | recipe, rotated 1.5× | CPU canvas | **GPU / default canvas** |
|---|---|--:|--:|
| Chrome | `drawImage`, `<img>` / bitmap / canvas | 45 046 / 45 046 / 43 728 | **43 728** all three (maxD 114) |
| Chrome | pattern, `<img>` / bitmap / canvas | 46 830 all three | **46 830 / 46 830 / 43 767** |
| Firefox | `drawImage`, any source | 0 | **43 766** (px16 37 679, maxD 120) |
| Firefox | pattern, `<img>` / bitmap / canvas | 0 / 0 / 45 063 | **43 763** all three (maxD 121) |
| Safari | `drawImage`, any source | 0 | **0** |
| Safari | pattern, any source | 43 633–43 634 | **45 158–45 159** (maxD 146) |

At 1:1, every engine and backend reads 0.

- **Chrome's GPU sampler bleeds like its CPU one.**
- **Firefox's GPU canvas bleeds with both recipes**, while its CPU path keeps
  a transformed sprite inside the cell (except a pattern made from a canvas).
  The figure is close to §4.13's llvmpipe WebGL-backend figure (43 785 /
  43 787).
- **Safari's `drawImage` stays inside the cell on both canvases.**
- The page records no verdict for part X's canvases. That the default canvas
  was on the GPU is *inferred*: it samples differently from the CPU canvas on
  Chrome and Firefox. For Safari it is not verified.

### Q5. Surprises, and what contradicts §4.13 or §4.7

1. **Firefox demotes every canvas during A2, even with nothing drawn.**
   - All 114 timed accelerated-profile rows, and all 9 `noop` rows, are
     `ACCEL>ACCEL>soft`.
   - §4.13 reads M6's round-1 Firefox A2 as "evidence that those canvases
     were accelerated". They were at the start, but not by the end of A2, so
     every Firefox A2 on this page is a mixed figure.
   - The `noop` control ran at the 4 096-clears-per-frame cap. So what it
     shows is that the loop's clears alone are enough to demote. The real
     cases ran 4–250 reps per frame.
2. **Chrome: an `<img>` costs 3–4× its bitmap per whole-image, scaled draw,
   from 256 px up (part B).** This qualifies §4.13's "the `<img>` is not [the
   slow source]" and "the 512² atlas … does not pay it". The atlas does not
   pay it for 1:1 sub-rect sprites: part D's `drawImage` from `img-png` is
   1.752–1.761 ms against a bitmap's 1.75–1.835. It does pay it for whole,
   scaled draws. *Mechanism unmeasured.*
3. **Chrome: §4.13's "a pattern from an `<img>` or bitmap runs at CPU raster
   cost" does not hold for small repeating textures.**
   - In part M, `pattern repeat` from an `<img>` or bitmap costs 0.434–0.64
     ms against an A3 of 3.15–3.6, so A2 is 12–20 % of A3.
   - Part D re-confirms the effect for the 512² no-repeat sprite pattern
     (10.884–11.927 against an A3 of 10.7–12.45).
   - Size, `'repeat'`, or `fill()` against `fillRect()` could separate the
     two. **Unmeasured.**
4. **Chrome: in part M the pattern's slowest source is a bitmap**
   (1.36–1.47× an `<img>`). That goes against §4.13's "draw from a canvas"
   only mildly; the canvas sits between the two.
5. **Safari: the canvas is not "the one source that is never slower".**
   - For `drawImage` sprites the `<img>` is the cheapest source by 1.37–1.46×
     (part D).
   - At 2048 in part B, the `<img>` beats the bitmap in both repetitions,
     and the canvas in r1 (r2's canvas row is floored).
   - This contradicts §4.13's steady-state heading for Safari.
6. **§4.7's pattern recipe does not carry to the tiled 3D case on Chrome or
   Safari.**
   - Chrome: `pattern repeat` ties with `clip + pre-tiled`.
   - Safari: `clip + pre-tiled` is 1.11–1.40× *cheaper* than the pattern,
     though with the RMSE caveat.
   - Only Firefox, where clip is catastrophic on the accelerated profile
     (≥ 39×), and Firefox software (1.39–1.60×) keep §4.7's ranking.
   - Triangles (part D) are unchanged: the pattern wins on Chrome and Firefox
     and ties on Safari.
7. **On Safari a pattern costs far more on the displayed canvas than on the
   `willReadFrequently` canvas.** Part M: A2 30.142–34.8 against A3 7–7.5,
   4.0–5.0×. Part D sprites: A2 162.909–175.65 against A3 16–74.5, 2.2–10.5×.
   So on Safari the A3 axis ranks patterns far too kindly.
8. **Calibrated A2 is higher than round 1's unfloored A2 on Chrome.**
   - Sprite `drawImage` from `img-png`: 1.752–1.761 now (per rAF 63.4–68.34
     ms), against 1.631–1.682 in round 1 (per rAF 14.7–15.1 ms).
   - Triangle pattern fill from a canvas: 1.526–1.826 against 1.155–1.175.
   - Bigger frames cost more per workload, by 4–58 % in these rows. So round
     1's absolute Chrome numbers are low, not only its floored ones.
     *Mechanism unmeasured.*
9. **The calibration can still floor a row** (sanity check 4). All 11 cases
   are cheap, large-image draws in part B.

## Caveats

- **Firefox A2 is mixed-regime everywhere** (Q5.1). No Firefox number here is
  a steady accelerated cost or a steady software one. The software profile
  (E) is the clean software control.
- **11 floored rows in part B** (sanity check 4). Chrome's `<img>`-against-bitmap
  question at 1024 and 2048 is unresolved because of them.
- **Safari's part M picture check is above 10**, so its recipe comparison is
  between pictures that differ by RMSE 11.3 (pre-tiled) and 17.4 (per tile).
- **Chromium spread is wider than round 1's.**
  - Part D: 12 of 24 rows over 10 %, up to 57.5 %. r1 and the r2 rerun ran
    30 min apart, and r1 is the slower one in most of those rows.
  - Part B: 12 of 15 rows over 10 %, on values of 0.011–0.025 ms.
  - Part M: 3 of 9 rows over 10 %, up to 20.1 %.
  - Treat any Chrome gap under ~1.3× in part D or B as unresolved.
- **Part B includes the page's full-canvas 0.996 clear in every row.** That
  compresses every ratio towards 1 by the same amount, and nothing here
  measures the clear alone on Chrome or Safari. On Firefox the `noop` control
  measured it at 0.029–0.033 ms per clear.
- **Disturbances:** WebStorm's relaunch (589.8 % CPU), and your use of the Mac
  from 14:52 to 15:01. The four affected runs were rerun once. The originals
  are kept as `*-disturbed.json` and not used in any table. Safari's r1 rerun
  still had one ≤ 5 s focus change (15:05:00).
- **Background processes:** other Claude Code sessions, a headless Firefox
  seen at 14:19, and an unidentified `firefox` at the start of both part B
  runs (see Machine).
- **The software control ran once, and rep 1 ran once on each engine.** Their
  ratios have no spread.
- **Timer resolution:** Firefox and Safari report `performance.now()` at 1 ms,
  so A1 is uninformative there.
- **Part X's GPU backend** is inferred on Chrome and Firefox and unverified on
  Safari. Part X records no verdict.
- **Graphite, not Ganesh:** none of the Chrome numbers carries to M1.
