// PLACEHOLDER — do not extend. This file is fully specified by
// `.superpowers/sdd/2026-07-30-logosmith/task-2-brief.md` ("Task 2: Brief
// intake — parsing, validation, and the `logoUrl` guard policy") and will be
// replaced verbatim, in full, when that task runs.
//
// It exists here, one task early, ONLY because `src/config.ts` (Task 1,
// written verbatim per task-1-brief.md Step 6) imports `parseFaviconBrief`
// from `./brief.js` for its $0-pricing branch, and Task 1's own acceptance
// bar (task-1-brief.md Step 10) requires `pnpm build` / `typecheck` / `test`
// to pass for the whole app. See task-1-report.md, "Concerns", for the full
// explanation of this plan-sequencing gap.
//
// Deliberately inert: always reports "no favicon brief" so it can never be
// mistaken for real brief-parsing logic. Task 2's `parseLogoBrief`,
// `isLatinScript`, `checkLogoUrl`, and the real `parseFaviconBrief` (fenced-
// JSON extraction + the logoUrl SSRF/scheme guard) are NOT implemented here.

import type { FaviconBrief } from './types.js';

export type BriefResult<T> = { ok: true; brief: T } | { ok: false; reason: string };

/** Stub only — see file header. Task 2 replaces this with real parsing. */
export function parseFaviconBrief(_description: string): BriefResult<FaviconBrief> {
  return { ok: false, reason: 'not implemented until Task 2 (brief.ts)' };
}
