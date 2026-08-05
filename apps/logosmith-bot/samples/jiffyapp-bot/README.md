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

Brief: [`../briefs/jiffyapp.json`](../briefs/jiffyapp.json) — written from
[JiffyApp's own README](../../../jiffyapp-bot/README.md).

## What the gates measured

| Gate                          | Result                                                                     |
| ----------------------------- | -------------------------------------------------------------------------- |
| Lettering readback            | **1.00 on all three** — `Jiffyapp`, `jiffyapp`, `JIFFYAPP`, threshold 0.85 |
| Distinctness (min Hamming 10) | **PASS** — 28 / 36 / 38 across the three pairs                             |
| True-vector                   | pass, zero violations                                                      |
| Pack                          | 15 files, ICO parses back at 16/32/48, 9/9 dimensions exact                |
| Palette                       | `#14262c` `#47bcba` `#dadcdd` `#a6adaf` `#657075`                          |
| Vectorisation                 | **`vectorizer`, $0.20** — the traced path, not the bypass                  |

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
flattened to a solid field. 23.1 KB of SVG, gate-clean, no tracing artefacts at
1024 px.

A traced deliverable is sellable. That question is now settled with an artifact
rather than an assumption.

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

## Contents

- `concepts/` — all three as generated, plus Recraft's native SVG
- `pack/` — the 15 delivered files, unpacked for browsing
- `jiffyapp-brand-pack.zip` — the actual deliverable
