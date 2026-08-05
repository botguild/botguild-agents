# Sample runs

Real end-to-end runs of the shipped pipeline against the real vendors — real
money, nothing mocked, hand-picked or retouched. The test suite proves the code
does what it was written to do; these show what the _product_ delivers,
including where it falls short.

| Run                                      | Winner came from                  | Spend | Notable                                                       |
| ---------------------------------------- | --------------------------------- | ----- | ------------------------------------------------------------- |
| [**LogoSmith**](logosmith-bot/README.md) | Recraft native vector, $0         | $0.28 | distinctness gate caught two near-identical Ideogram concepts |
| [**JiffyApp**](jiffyapp-bot/README.md)   | Ideogram raster **traced**, $0.20 | $0.40 | closes the traced-path gap; exposes the `avoid`-list hole     |

## Reproducing

```bash
cd apps/logosmith-bot
set -a && . .dev.vars && . ../../.env.local && set +a
OUT_DIR=samples/<name> BRIEF=samples/briefs/<name>.json npx tsx samples/run-live.ts
```

Harness: [`run-live.ts`](run-live.ts) — drives the shipped modules, not a
reimplementation. Briefs: [`briefs/`](briefs/). Concepts are cached to the
output directory by filename, so a re-run after a crash reuses what was already
paid for.

## What both runs establish

**The verification layer works.** Lettering readback scored 1.00 on all six
concepts across the two runs, with the spelling _proven_ rather than assumed.
Palettes came back matching their briefs. Every pack passed its dimension, ICO
parse-back and ZIP completeness gates. The distinctness gate caught a real
duplicate. The Recraft native-vector bypass saves the full conversion cost when
it fires, and — settled by the JiffyApp run — the traced path that serves the
other ~2 in 3 buyers produces output that is _cleaner_ than its source raster.

**Nothing verifies that the mark is the right one.** LogoSmith's delivered
emblem was off-brief; JiffyApp's contains three of the six things its brief
explicitly listed under `avoid`. Every promise this bot makes about an artifact
is checked against that artifact — the lettering is read back, the paths are
counted, the ICO is parsed, the dimensions are measured. The brief's creative
direction is the one input that is only ever _sent_.

The `avoid` list is the tractable half of that gap: a closed set supplied by the
buyer, checkable by the vision model already in the pipeline. See the
[JiffyApp run](jiffyapp-bot/README.md) for why it is a candidate rather than a
shipped gate.
