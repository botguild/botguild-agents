// Per-job progress/evidence page (FR-7). Public and read-only at an unguessable
// URL, and deliberately PII-free: no payer, contract, or gig id ever reaches
// the page — the capability token is the only identifier a viewer sees.
//
// This page IS the launch demo artifact ("AI logos that can actually spell —
// proven on camera"), so the OCR verdict is shown next to every concept
// including the failures; a bot that hides its failed readbacks is not
// evidencing anything.

import type { ConceptRow, JobRow } from './jobs.js';

const SSE_RETRY_MS = 5000;

function escapeHtml(text: string): string {
  // Encode all five unsafe characters to prevent injection, even in attribute contexts.
  // & must be first to avoid corrupting the entity encodings.
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function conceptCard(concept: ConceptRow, token: string): string {
  const score = concept.ocrScore === null ? '—' : concept.ocrScore.toFixed(2);
  const verdict = concept.ocrPass ? 'PASS' : 'REGENERATING';
  const image = concept.r2Key
    ? `<img src="/deliverables/${token}/concept-${concept.slot}.png" alt="Concept ${concept.slot}" width="320">`
    : '<div class="pending">rendering…</div>';
  return [
    '<article>',
    `<h2>Concept ${concept.slot} — ${escapeHtml(concept.axisId)}</h2>`,
    image,
    `<p class="verdict ${concept.ocrPass ? 'pass' : 'fail'}">Lettering readback: <strong>${verdict}</strong> (${score})</p>`,
    `<p class="transcription">Model read: "${escapeHtml(concept.ocrTranscription ?? '')}"</p>`,
    '</article>',
  ].join('');
}

/** The full HTML page. */
export function renderProgressPage(job: JobRow, concepts: ConceptRow[]): string {
  const token = job.deliverableToken ?? '';
  const body =
    concepts.length === 0
      ? '<p class="pending">Generating concepts — this page updates automatically.</p>'
      : concepts.map((concept) => conceptCard(concept, token)).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>LogoSmith — build progress</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 60rem; padding: 2rem 1rem; }
  article { border: 1px solid color-mix(in srgb, currentColor 20%, transparent); border-radius: .75rem; margin-block: 1rem; padding: 1rem; }
  img { max-width: 100%; height: auto; border-radius: .5rem; }
  .verdict.pass { color: #157f3d; }
  .verdict.fail { color: #a8471b; }
  .transcription { font-style: italic; opacity: .8; }
  .pending { opacity: .7; }
</style>
</head>
<body>
<h1>Build progress</h1>
<p>Every concept below is checked by a vision model to confirm its lettering reads back as the brand name. Failing concepts are regenerated, never delivered.</p>
${body}
<script>
  // Each SSE connection delivers ONE snapshot frame then closes; the browser
  // reconnects on the retry interval. Reload only when the snapshot CHANGES —
  // reloading on every frame would loop the page forever, since the first
  // frame arrives immediately after every (re)connect.
  let last = null;
  const source = new EventSource(location.pathname.replace(/\\/$/, '') + '/events');
  source.onmessage = (event) => {
    if (last !== null && event.data !== last) location.reload();
    last = event.data;
  };
</script>
</body>
</html>`;
}

/** One SSE snapshot frame. The client reconnects on the retry interval, which
 *  degrades to plain polling wherever SSE is unavailable. */
export function renderProgressEvent(job: JobRow, concepts: ConceptRow[]): string {
  const payload = {
    status: job.status,
    updatedAt: job.updatedAt,
    concepts: concepts.map((concept) => ({
      slot: concept.slot,
      axisId: concept.axisId,
      score: concept.ocrScore,
      pass: concept.ocrPass,
    })),
  };
  return `retry: ${SSE_RETRY_MS}\ndata: ${JSON.stringify(payload)}\n\n`;
}
