# JiffyApp

## Vendored dependencies

`src/templates/vendor/` pins two build-time-only devDependencies as generated string exports (no runtime fetch, no CDN): Papa Parse `5.5.3` (MIT) and Chart.js `4.5.1` (MIT), served from each tool's own `/vendor/*.js` under `script-src 'self'`. Regenerate after a version bump with `pnpm add -D -E papaparse@<version> chart.js@<version>` followed by the codegen one-liners in `src/templates/vendor/papaparse.ts` / `chartjs.ts`'s header comments (Task 24 fleshes this out further).

## Pinned dependencies

| Package | Version | Why exact-pinned |
| --- | --- | --- |
| `@cloudflare/playwright` | `1.3.0` | Browser-automation surface (`src/playwrightDriver.ts`); exact-pinned per the fleet's playwright-pairing lesson — a minor/patch bump can silently change locator/selector semantics against the live Browser Rendering binding, so upgrades are a deliberate `pnpm add -E @cloudflare/playwright@<version>` + a Phase-2 live-check pass, never a floating range. |

Its own `.d.ts` files use extension-less relative specifiers (`from './types/types'`) that this workspace's `moduleResolution: NodeNext` can't follow, so `Browser`/`Page` aren't resolvable as named type imports here — `playwrightDriver.ts` derives them structurally off `launch`'s return type instead (see that file's header comment). This only affects compile-time typing inside that one file; it is not unit-tested locally and is exercised by the Phase-2 live reference checks instead.
