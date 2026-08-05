# Sample run — LogoSmith's own logo

A real end-to-end run of the shipped pipeline against the real vendors, on
2026-08-04. Real money: **$0.28** (2 × Ideogram @ $0.06, 1 × Recraft @ $0.08).
Nothing here is mocked, hand-picked or retouched.

Kept in the repo because a passing test suite proves the code does what it was
written to do; this proves what the *product* actually delivers — including
where it falls short.

## The brief

```jsonc
{
  "brandName": "LogoSmith",
  "industry": "an autonomous AI agent that generates and machine-verifies brand logo packs",
  "brief": "A precise, technical mark for a bot that proves its own work. Suggests craft and
            verification rather than generic AI sparkle. Reads clearly at 16px favicon size.",
  "palettePreference": ["deep indigo", "warm brass"],
  "avoid": ["sparkles", "magic wands", "generic robot faces", "gradients"]
}
```

## What the gates measured

| Gate | Result |
|---|---|
| Lettering readback (Llama-4-Scout vision) | **1.00 on all three** — `Logosmith`, `Logosmith`, `LOGOSMITH`, threshold 0.85 |
| Distinctness (pHash, min Hamming 10) | **FAIL** — wordmark vs lockup measured **0** |
| True-vector | pass, zero violations |
| Pack | 15 files, ICO parses back at 16/32/48, 9/9 dimensions exact |
| Palette extraction | `#0c2242` `#b78f46` `#c5a569` `#818a94` `#bbbebd` |
| Vectorisation | `recraft-native`, **$0** — the bypass fired |

## What it got right

The verification layer did its whole job. Lettering is correctly spelled in
every concept and the readback proves it rather than assuming it. The extracted
palette is **deep indigo and warm brass** — exactly what the brief asked for.
The winning concept arrived as a native vector, so stage 2 cost nothing instead
of the ~$0.20 Vectorizer.ai conversion.

And the distinctness gate earned its place: `concepts/concept-wordmark.png` and
`concepts/concept-lockup.png` are near-identical — same typeface, same layout,
same background, differing only in cream vs white lettering and a single brass
dot on the `i`. A Hamming distance of **0** is the correct reading. In the real
pipeline this demotes the newer slot and regenerates it.

## What it got wrong — and what no gate can catch

**The `lockup` axis produced no lockup.** It was prompted for icon + wordmark
and Ideogram returned a second wordmark. Axis diversification failed at the
vendor, not in the compiler.

**The delivered emblem is off-brief.** `pack/logo-color-1024.png` is a vintage
photographer with a camera. The brief described an AI agent that machine-verifies
logo packs and explicitly excluded generic robot faces; Recraft appears to have
read *"Smith"* as *tradesman*. The lettering is flawless, the vector is clean,
the palette is right — and the idea is wrong.

That is the honest limit of this bot, and it is structural rather than a bug:

> **Every gate checks whether the artifact is well-made. None checks whether it
> is the right idea.** There is no semantic-fit gate, and adding one would mean
> scoring a logo against a prose brief — a judgement the current design
> deliberately never makes, because it cannot be verified the way a readback,
> a dimension or a path count can.

The `§15` regen-burn tracking exists so drift like the duplicate wordmarks
triggers prompt tuning. Nothing equivalent exists for "wrong concept", and a
buyer's remedy is the selection step: they choose among three, and if none fit,
they do not select.

## Untested here

`logo.svg` came from Recraft's native vector export. **Two of the three axes
route to Ideogram**, whose rasters can only reach a vector through Vectorizer.ai
— and that path has been verified for contract (auth, response shape, gate-clean
output, DOCTYPE stripping) but **never for output quality**, because the account
had no credits at run time. Tracing a soft-edged AI raster into paths is a
different quality proposition from a native vector, and it is what ~2 of 3
buyers would receive.

## Contents

- `concepts/` — all three concepts as generated, plus Recraft's native SVG
- `pack/` — the 15 delivered files, unpacked for browsing
- `logosmith-brand-pack.zip` — the actual deliverable
