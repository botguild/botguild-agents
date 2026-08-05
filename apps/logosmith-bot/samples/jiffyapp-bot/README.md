# Sample run — JiffyApp

A real end-to-end run of the shipped pipeline against the real vendors,
2026-08-04. Real money: **$0.40** (2 × Ideogram @ $0.06, 1 × Recraft @ $0.08,
1 × Vectorizer.ai @ $0.20). Nothing mocked, hand-picked or retouched.

Reproduce with the committed harness:

```bash
cd apps/logosmith-bot
set -a && . .dev.vars && . ../../.env.local && set +a
OUT_DIR=samples/jiffyapp-bot BRIEF=samples/briefs/jiffyapp.json npx tsx samples/run-live.ts
```

The concepts and the traced vector are both cached in `concepts/`, so a re-run
costs **$0.00** and rebuilds the identical pack. Delete
`concepts/vector-wordmark.svg` to buy a fresh trace on purpose — Vectorizer.ai
is not deterministic, and a re-trace quietly changes the artifact a re-run was
meant to hold constant.

Brief: [`../briefs/jiffyapp.json`](../briefs/jiffyapp.json) — written from
[JiffyApp's own README](../../../jiffyapp-bot/README.md).

## What the gates measured

| Gate                          | Result                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------- |
| Lettering readback            | **1.00 on all three** — `Jiffyapp`, `jiffyapp`, `JIFFYAPP`, threshold 0.85   |
| Distinctness (min Hamming 10) | **PASS** — 28 / 36 / 38 across the three pairs                               |
| True-vector                   | pass, zero violations                                                        |
| Pack                          | 15 files, ICO parses back at 16/32/48, 9/9 dimensions exact                  |
| Favicon source                | **mark crop** — the rocket, verified to carry no lettering (see below)       |
| Favicon ink                   | 262 144 opaque px in `icon-512.png`                                          |
| Palette                       | `#14262c` `#47bcba` `#dadcdd` `#a6adaf` `#657075`                            |
| Vectorisation                 | **`vectorizer`, $0.20** — the traced path, not the bypass                    |

## This run closes the gap the LogoSmith sample documented

The [LogoSmith run](../logosmith-bot/README.md) could not test Vectorizer.ai: its winner
arrived as a native Recraft vector, and the account had no credits. That left
the path **~2 of 3 buyers actually receive** — an Ideogram raster traced into
paths — verified for contract but never for output quality.

Here the wordmark won on merit, so the trace ran for real. The answer is
**better than expected**: compare `concepts/concept-wordmark.png` (the raster
Ideogram returned) against `pack/logo-color-1024.png` (that raster traced, then
re-rendered from the vector). The trace _improved_ the source — soft
anti-aliased type became crisp paths, and the raster's faint background vignette
flattened to a solid field. 23.2 KB of SVG, gate-clean, no tracing artefacts at
1024 px.

A traced deliverable is sellable. That question is now settled with an artifact
rather than an assumption.

## The favicon: fixed, and the fix is measured

**The first version of this sample shipped an illegible favicon.** Every icon in
`pack/` was the whole lockup — the wordmark "Jiffyapp" plus its rocket, bolt and
sparkles — scaled down. At 32 px that is grey mush; at 16 px it is worse. Every
gate passed, because every gate measured the wrong thing: the dimensions were
exact, the ICO parsed back, the ZIP was complete. Nothing asked whether the
image was legible.

A favicon needs a **mark**, not a shrunken logo. So `buildPack` now derives one:
it renders the winning vector once at 512 px, labels the connected components,
identifies the wordmark as the horizontal band that explains the most of them,
and square-crops the densest of what is left — sliding the window to the
position that admits the least neighbouring ink. Here that lands on the rocket:
a 35 × 35 window at (119, 198) of the 512 px analysis render, from 8 lettering
components and 12 mark candidates.

Then it is **verified rather than assumed**, on the delivered `icon-512.png`:

| Check                                                    | Before (whole logo) | After (mark crop) |
| -------------------------------------------------------- | ------------------- | ----------------- |
| Lettering readback, `@cf/meta/llama-4-scout-17b-16e`      | `"Jiffyapp"` — **1.00** similarity to the brand name | `""` — 0 characters, **0.00** |
| Non-background coverage @ 16 px                          | 31 / 256 — **12.1%** | 93 / 256 — **36.3%** |
| Non-background coverage @ 32 px                          | 95 / 1024 — **9.3%** | 338 / 1024 — **33.0%** |
| Non-background coverage @ 48 px                          | 196 / 2304 — 8.5%    | 715 / 2304 — 31.0%   |
| Opaque pixels (the Task 23 ink gate) @ 16 px             | 256 / 256           | 256 / 256         |

Two things in that table are worth saying plainly.

**The readback is the check that would have caught the original bug.** The same
pinned vision model §9 uses to prove a *concept* carries the brand name is
pointed at the *favicon* to prove the opposite. A favicon that reads back as the
brand name is a shrunken lockup, and it is now refuted by measurement rather
than hoped against. When it fires, the pack falls back to the old whole-logo
behaviour and the validation report **says so** — `report.json` carries
`favicon.source`, the crop, the component counts, the coverage, the ink and the
verbatim transcription.

**The ink gate did not move, and could not have.** `opaquePixels` counts alpha,
and this logo paints an opaque navy field behind everything, so it measures a
perfect 256/256 both before and after. It is still worth running — a crop that
landed off the artwork would measure 0, and blank icons have shipped from this
codebase three times — but on a logo like this one it proves the icon draws and
nothing more. The number that discriminates is coverage, which is why the report
carries both.

A **pure wordmark has no mark to find**, and gets the whole-logo fallback: the
old favicon, named as such in the report. Cropping the brand's initial letter
instead is the obvious next tier and is deliberately **not** built here — a
monogram is lettering, and shipping a tier that trips the no-text check on
purpose would mean loosening the one check most worth having.

## What it got wrong — and this is worse than the LogoSmith miss

The brief's `avoid` list was:

```json
["rocket ships", "lightning bolts", "sparkles", "generic robot faces", "gradients", "stopwatches"]
```

The delivered logo contains a **rocket ship**, a **lightning bolt**, and
**sparkles** — three of the six things it was explicitly told not to draw.

The LogoSmith sample recorded that no gate checks whether a mark is _the right
idea_. This is the sharper version of the same hole: nothing checks whether the
mark contains something the buyer **explicitly prohibited**. `avoid` reaches the
image prompt (and, since the final review, the moderation payload) and is then
simply hoped for. The vendor ignored it, every gate passed, and the pack shipped.

> An instruction that is only ever _sent_ and never _checked_ is a preference,
> not a constraint. Every other promise this bot makes is verified against the
> artifact — the lettering is read back, the paths are counted, the ICO is
> parsed, the dimensions are measured. `avoid` is the one input treated as a
> wish.

This is more tractable than a general "is it the right idea" gate, because it is
a closed list supplied by the buyer rather than an open-ended judgement. The
same Llama-4-Scout vision call that already reads the lettering could be asked
whether any listed item appears — one extra call per concept, on a model already
in the pipeline. Recorded as a candidate, not built: it would need calibration
against a golden set before it could gate a delivery, and a false positive
rejects a good logo.

The favicon fix makes this finding sharper, not weaker: the favicon is now a
**close-up of the rocket** — the single most prohibited element in the brief,
promoted to the buyer's browser tab. The mark derivation is doing its job
correctly; there is simply no gate standing between it and an `avoid` list.

## Contents

- `concepts/` — all three as generated, plus Recraft's native SVG and the cached
  Vectorizer.ai trace of the winner
- `pack/` — the 15 delivered files, unpacked for browsing
- `jiffyapp-brand-pack.zip` — the actual deliverable
