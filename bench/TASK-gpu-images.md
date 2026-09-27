# Task, round 2: measure the 3D-engine texture case on the GPU

You are a local coding agent on the **same MacBook Air as round 1** (M6:
Apple M4, Chrome 153, Firefox 156.0.1, Safari 26.6.2). If any browser version
changed since round 1, **say so at the top of the report**. Your job is to
**measure only**. Do not edit `README.md`, `CLAUDE.md`, `src/` or anything in
`bench/` except `bench/out/`. If the page itself looks broken, stop and
report it instead of fixing it.

## Why this round exists

Round 1 (`bench/out/GPU-REPORT-images.md`) measured 2D sprites and one
non-repeating atlas. That is not how a canvas2d 3D engine textures a face. An
engine uses small per-material textures that **tile** across each face, and
fills them with a `'repeat'` pattern, or with `clip` + `drawImage` of a
pre-tiled canvas. Round 1 also had three instrument problems that are now
fixed in `bench/imagepage.html`:

1. **Repetitions per frame are calibrated on the frame interval.** Rows should
   no longer sit at the 100 Hz floor, and any row that still does is printed
   and saved as `VSYNC-FLOORED` / `floored: true`.
2. **The Firefox acceleration control is 256 px** (it was 64, below Gecko's
   128 px minimum). Every case now records its verdict three times:
   `verdictFirst`, `verdictAfterA1` and `verdict` (after A2).
3. **Part X (bleed) renders on a displayed default canvas** (`backend:
   'default'`, the GPU) as well as a CPU one (`backend: 'cpu'`).

The two new parts answer the 3D questions:

- **Part M, fixture S22:** a perspective floor and two walls of 336 textured
  quads, eight 128×128 materials, each quad tiling its material `rep × rep`
  times. It prices three recipes:
  - `pattern repeat`: one repeating `CanvasPattern` per material;
  - `clip + pre-tiled`: clip, then `drawImage` of a canvas the material was
    tiled into at load;
  - `clip + per tile`: clip, then one `drawImage` per repetition.

  Each recipe runs from three sources: `img-png`, `bitmap`, and a small
  128×128 `canvas`. The page first checks that the three recipes draw the same
  picture (`micro` rows `M picture vs pattern repeat: …`). On M4 the RMSE was
  4.3 for pre-tiled and 7.9 for per-tile, the rest being edge antialiasing and
  tile seams.
- **Part B:** the image **size** sweep, 256–4096 px, `img-png` against
  `bitmap` against `canvas`, 16 whole-image `drawImage` calls per frame. It
  asks where an `<img>` starts costing more per draw than its bitmap. Round 1
  found 13–14× at 2048 on Chrome, and nothing at 512.

## 1. Setup

```bash
git fetch origin claude/upbeat-pasteur-mzuq8c
git checkout claude/upbeat-pasteur-mzuq8c
git pull
```

Same conditions as round 1:

- window in front and uncovered;
- `caffeinate -d -i` running;
- other heavy applications closed, including your own Chrome and Firefox;
- no indexers running.

## 2. Runs

Terminal 1: `node bench/server.js`. Terminal 2:

```bash
# A. the 3D case, rep = 4 (default): 3 repetitions on each engine
for r in 1 2 3; do
  PAGE=imagepage.html TAGSUFFIX=-imgM-gpu-r$r EXTRA="parts=M" node bench/run.js edge firefox-dbg safari
done
# B. the same with rep = 1: one texture per face, no tiling
PAGE=imagepage.html TAGSUFFIX=-imgM1-gpu-r1 EXTRA="parts=M&rep=1" node bench/run.js edge firefox-dbg safari
# C. the size sweep: 2 repetitions
for r in 1 2; do
  PAGE=imagepage.html TAGSUFFIX=-imgB-gpu-r$r EXTRA="parts=B" node bench/run.js edge firefox-dbg safari
done
# D. round 1's parts again, with the fixed page: 2 repetitions
for r in 1 2; do
  PAGE=imagepage.html TAGSUFFIX=-img2-gpu-r$r EXTRA="parts=X,S,T,F" node bench/run.js edge firefox-dbg safari
done
# E. software control, once
PAGE=imagepage.html TAGSUFFIX=-imgM-gpu-r1 EXTRA="parts=M,B" node bench/run.js firefox-nonaccel
```

**Safari:** it opens as a tab in your own Safari. Bring that window to the
front as soon as it opens, because a background tab gets no animation frames
and hangs (that is what happened in round 1). If one Safari run hangs, rerun
it once, then record the result.

## 3. Sanity checks (report each one)

1. Every JSON exists and has no `error` field.
2. Round 1's identity rows: `img-png`, `bitmap` and `canvas` have
   `channelsDiffering: 0`.
3. Part M's picture check: give the RMSE and `px16` of both rows. Flag any
   RMSE above 10.
4. **Floored rows:** list every row with `floored: true`. There should be few
   or none.
5. **Firefox verdicts:** the indicator line must say `true`. For every case,
   give `verdictFirst > verdictAfterA1 > verdict`, and count how many end
   `soft`. If they are demoted, say at which phase.
6. The Chromium A2 min–max across repetitions. Treat anything under ~10 % as
   noise.

## 4. Questions the report must answer

Answer each one with numbers, the axis (A2 `sustMs` is the GPU-inclusive one),
and the engine. On Firefox, give the verdict with every number.

- **Q1, the 3D recipe (part M, rep 4).** Per engine, which is cheapest:
  `pattern repeat`, `clip + pre-tiled` or `clip + per tile`, and by how much?
  Does the answer change at rep 1?
- **Q2, the source for textures (part M).** Per engine and recipe, how do
  `img-png`, `bitmap` and the small `canvas` rank? In particular, on
  **Safari**: is `pattern repeat` from `img-png` much slower than from the
  small `canvas` (the claim under test: Safari re-decodes a PNG pattern, and
  a small pre-rendered canvas fixes it)?
- **Q3, image size (part B).** Per engine, the `sustMs` of `img-png`,
  `bitmap` and `canvas` at each size. At what size, if any, does `img-png`
  become more than 1.5× its bitmap?
- **Q4, round 1 re-checked (part D).** With the calibration, give the rows
  that were floored in round 1, now unfloored. Does any round-1 ranking
  change? Give GPU bleed (`backend: 'default'`) against CPU bleed for each
  engine.
- **Q5.** Anything surprising, or anything that contradicts §4.13 or §4.7,
  stated plainly with the rows behind it.

## 5. Deliverables

1. All JSON files stay in `bench/out/`.
2. Write **`bench/out/GPU-REPORT-images-r2.md`** with these sections:
   - Machine, noting any change since round 1;
   - Runs;
   - Sanity checks;
   - Tables: part M per engine at rep 4 and at rep 1; part B per engine;
     part D;
   - Answers Q1–Q5, each leading with the answer and then the evidence;
   - Caveats.

   Copy numbers from the JSON; do not retype them.
3. Commit only the new JSON files and the report, then push:

   ```bash
   git add bench/out/*gpu*.json bench/out/GPU-REPORT-images-r2.md
   git commit -m "GPU run, round 2: 3D texture case, size sweep, re-check"
   git push origin claude/upbeat-pasteur-mzuq8c
   ```

## Rules

- Report **measured numbers only**. Write "not measured" where nothing was
  measured. Never estimate.
- Never add your own `performance.now()` timings. Use the page's columns.
- A run that fails or hangs gets one rerun, then its failure is recorded.
