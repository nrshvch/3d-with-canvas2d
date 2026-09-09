# Working rules for this repository

This repo is a **measured document**. The deliverable *is* `README.md` — the
guide is the repo's front page, so GitHub renders it on arrival — and `bench/`
and `src/` exist to make its claims re-runnable. So the rules below are mostly
about not degrading the document's evidence, and they bind harder than normal
code-comment conventions.

There is no separate short README. If you find yourself wanting one, the place
for repo-level orientation is the **"The repository"** block at the top of
`README.md` and **§8.8** for what to run; do not start a second file that will
drift out of sync with the first.

The guide is openly LLM-assisted (see its header). That is exactly why the
discipline has to be written down: the failure mode of an LLM-assisted technical
document is not a compile error, it is a confident sentence with nothing behind
it. Every rule here exists to make that failure visible.

---

## 1. Version and date — bump them on every substantive change

The canonical version and date live on **line 3** of the guide:

```markdown
**Version 1.10 · circa September 2026**
```

**Update both on every substantive change, in the same edit as the change.**
Never leave the version stale "until the work is finished" — a half-updated
guide with an old version number is worse than no version number, because the
version is what tells a reader which engine versions and which measurements a
claim belongs to.

**Scheme** — `MAJOR.MINOR`, two decimal digits of minor:

| bump | when |
|---|---|
| **+0.01** | a correction, a clarification, an added measurement to an existing entry, a new figure, a rules or checklist edit |
| **+0.10** | a new numbered section or registry block, a new bench script, a new fixture (S-, C-, A- or M-id), or **any reversed conclusion** |
| **+1.00** | a restructure that moves section numbers, or a change of scope |

**The date is `circa <Month> <Year>`** — the month the change lands, not the
month the measurement was taken. "Circa" is deliberate: the measurements
accumulated over a period, and pretending to a single day would be a false
precision. If a change re-measures something on a *new* browser version, update
§10.1 and the header fixture line too.

**What counts as substantive:** anything a reader could act on differently.
Prose polish, typo fixes and reflowing do not need a bump. A changed number, a
changed recommendation, a new caveat, or a moved section do.

**No changelog file.** Superseded measurements are recorded *inside their own
registry entry* — T29 is the worked example ("Supersedes two earlier versions of
this entry", with what each got wrong and which conclusion survived). That
convention keeps the correction next to the number it corrects, where someone
extrapolating will actually see it. Follow it instead of writing a changelog.

---

## 2. Never add a number without a fixture

A number in this guide must be traceable to something re-runnable. Concretely,
when you add or change a measurement:

1. **Add or amend a `T` entry in §10.5.** Next free number: check
   `grep -o 'T[0-9]*' README.md | sort -u -V | tail -1`. The entry names
   *subject* (what varied), *fixture* (S-/C-/M-ids from §10.1–§10.3), *axis*
   (A-id from §10.4), *numbers* (the §ref where they live) and **reads as** —
   the extrapolation scope, which is the part that matters.
2. **Point the section at it** with `*Registry: Tnn — fixture and extrapolation
   scope in §10.5.*` under the heading.
3. **If the fixture is new, define it first** — a scene gets an `S` id in §10.2
   with its measured tris / verts / shared-edge % / visible count / mean
   triangle px², a configuration gets a `C` id in §10.3, an axis gets an `A` id
   in §10.4 **and a definition in §8.1**.
4. **Say which axis it is.** A record-stage number, a counts-only number and a
   sustained frame-time number are not comparable, and mixing them is the most
   damaging error available in this document.

**If you cannot measure it, mark it.** The vocabulary the guide already uses,
and which must be preserved: *unmeasured*, *inferred*, *extrapolated*,
*field-reported*, *not measured in a browser*, *no fixture, no T number*. An
unmarked claim reads as measured, and §4.10's early-out #3 sat here unmeasured
until it was tested and turned out **backwards** — that is what the marking is
for.

---

## 3. Measurement discipline

- **Do not put a CPU timer around real draw calls.** `ctx.fill()` does not
  rasterise; deferred GPU work hides inside the timer and can rank strategies
  backwards (§2, §5.7). Use the sustained axis (A2) for anything end-to-end.
- **A CPU timer is legitimate only with an inert context** — the A8 upstream
  axis, where no canvas call happens at all (§8.1).
- **Report the axis and the engine with the number**, always. A Firefox number
  is a *software* number unless the entry says it measured the accelerated
  window (§10.1).
- **Do not read a Chromium ranking inside ~10 %.** The spread is documented; T29
  carries the worked warning.
- **Min, not mean, for deterministic CPU work; sustained wall-clock for frames.**
- **Verify exactness rather than arguing it.** Where a change claims to be
  pixel-exact, diff it against a supersampled reference and report the sample
  count (§8.5, and T56 as the pattern). "It is exact by construction" is a
  hypothesis until the diff says zero.
- **Restate an invariant when the inputs change.** §8.3's area invariant
  compares the emitted area against *the faces handed to the batcher* — which
  stops being the visible set the moment anything culls or filters. A harness
  that fires on every frame teaches you nothing.

---

## 4. Keeping the document consistent

A change to one section usually owes edits elsewhere. Check all of these:

- [ ] **Version + circa date** on line 3 (rule 1).
- [ ] **Contents** — the `## Contents` list carries every `##`/`###` heading with
      a GitHub-style anchor. A new subsection needs a line there.
- [ ] **Registry** — a `T` entry, and any new `S`/`C`/`A`/`M` fixture.
- [ ] **Rules sections** — §1.4–§1.11 are the actionable distillate. A new
      finding that changes what someone should *do* belongs there too, not only
      in §4.
- [ ] **§7 checklist** — the per-frame and setup lists.
- [ ] **§0 short version** — only for a finding big enough to be one of the
      numbered headline rules.
- [ ] **Cross-references** — if a new result corrects an older section, edit the
      older section to say so. Do not leave two sections disagreeing silently;
      the reader will find the wrong one first.
- [ ] **The "The repository" block** at the top, if a file or a directory
      changed, and **§8.8**, if you added or renamed a bench script — that list
      is the only place the commands are written down.
- [ ] **Traps** — a result of the form "the obvious thing is worse than doing
      nothing" belongs in §6 as well, because that is where people look.

Sanity checks worth running after a structural edit:

```bash
grep -n "^#\{2,3\} " README.md   # heading order
grep -o "T[0-9][0-9]*" README.md | sort -u -V | tail -5
```

Also verify: every `![](assets/...)` path exists, every `](#anchor)` resolves to
a heading, and no markdown table has a ragged row.

---

## 5. Figures

**Generated, not drawn.** Every SVG in `assets/` is written by a script in
`bench/`, and the script computes the substance — tile states, emitted
boundaries, vertex placements — by running the real predicate over the content,
so a figure cannot drift from the algorithm it illustrates.

- `bench/optdiagrams.mjs` → `assets/seam-options.svg`
- `bench/optfigs.mjs` → the two vertex-placement figures
- `bench/prepdiagrams.mjs` → `assets/prep-predicate.svg`,
  `prep-contiguity.svg`, `prep-backdrop.svg`
- `bench/shots.mjs` + `bench/shotpage.html` → the rendered contact sheets

One script per figure family, so re-running one cannot overwrite another. Keep
the palette in `C` (it has to read on a light or a dark page), keep text as SVG
`<text>`, and check the declared `height` against the largest `y` used — a
clipped last line is the standard failure.

---

## 6. Code conventions

`src/` is the reference implementation; `bench/` is the harness. Both are read
as part of the argument, so they are written to be read.

- **Zero allocation on the per-frame path.** Typed arrays, preallocated in the
  constructor. No strings built in a loop.
- **Epoch-tagged scratch instead of clearing.** And when you add a new tagged
  array, add it to the epoch reset — the `batchOf` / `stamp` bug in §4.9 is the
  standing example of what forgetting costs.
- **The header comment carries the *why*.** Every module in `src/` opens with
  the idea, the trick, why it pays in canvas2d specifically, and what it costs,
  with §refs into the guide. Match that density; it is why the files are
  quotable.
- **Constructor options document their own defaults and the measurement that
  chose them** (see `src/occluder.js`). A default without a reason is a bug
  waiting to be re-litigated.
- **A guard for every optimisation that can fail.** Measure your own rate and
  back off — `autoSkip`, `autoFallback`. And guard on the metric that actually
  moves: §4.11 has the case where face count and vertex count disagree
  completely, so one threshold gets one of them wrong.
- **Bench scripts are runnable with no arguments** and print a table with the
  fixture in the header. Node only, no browser, unless the measurement needs
  one.

---

## 7. Tone

Match the guide's voice, which is doing real work:

- Lead with the answer, then the evidence.
- State magnitudes, not directions. "1.68× worse" beats "slower".
- Name the trap and the mechanism. A finding without a mechanism is an anecdote.
- Record negative results — the keeper finding nothing (T55) is as useful as the
  win, and cheaper to read than rediscovering it.
- Do not hedge a measured number, and do not un-hedge an unmeasured one.
