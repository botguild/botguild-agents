// STUB — replaced wholesale by Task 13 (progress and evidence page, FR-7).
// Exists only so Task 12's index.ts type-checks against the real functions it
// calls (`c.html(renderProgressPage(...))` and the SSE `renderProgressEvent`
// response body). Both exports throw; nothing is rendered yet.

import type { ConceptRow, JobRow } from './jobs.js';

export function renderProgressPage(_job: JobRow, _concepts: ConceptRow[]): string {
  throw new Error('not implemented');
}

export function renderProgressEvent(_job: JobRow, _concepts: ConceptRow[]): string {
  throw new Error('not implemented');
}
