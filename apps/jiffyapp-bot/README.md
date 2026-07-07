# JiffyApp

## Vendored dependencies

`src/templates/vendor/` pins two build-time-only devDependencies as generated string exports (no runtime fetch, no CDN): Papa Parse `5.5.3` (MIT) and Chart.js `4.5.1` (MIT), served from each tool's own `/vendor/*.js` under `script-src 'self'`. Regenerate after a version bump with `pnpm add -D -E papaparse@<version> chart.js@<version>` followed by the codegen one-liners in `src/templates/vendor/papaparse.ts` / `chartjs.ts`'s header comments (Task 24 fleshes this out further).
