// Pure routing policy for *.jiffyapp.dev. No bindings — fully node-testable.

export type DispatchDecision = { kind: 'serve' } | { kind: 'gone' } | { kind: 'unknown' };

/** One label directly under the suffix, else null (apex, www, nested, foreign hosts). */
export function resolveSlug(hostname: string, hostSuffix: string): string | null {
  const host = hostname.toLowerCase();
  const suffix = `.${hostSuffix.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (label === '' || label === 'www' || label.includes('.')) return null;
  return label;
}

/** tools.status → routing outcome. live|grace serve; suspended|killed are 410; anything else 404. */
export function decideDispatch(status: string | null): DispatchDecision {
  if (status === 'live' || status === 'grace') return { kind: 'serve' };
  if (status === 'suspended' || status === 'killed') return { kind: 'gone' };
  return { kind: 'unknown' };
}

/**
 * Staging build slugs (bot Task 17) are served BEFORE promotion — a build has no `tools` row
 * yet, so `index.ts` must recognize these and route them straight through the dispatch
 * namespace, before the D1 status read. They carry the `stg-` prefix (the bot's slug.ts
 * `STAGING_PREFIX`), derived from the job's random deliverable token, so they're unguessable
 * while exposed; the response is served `no-store` + `noindex` and the script is torn down at
 * teardown. `decideDispatch`'s signature is untouched — this is a separate pre-check.
 */
export function isStagingSlug(slug: string): boolean {
  return slug.startsWith('stg-');
}

export const GONE_PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Tool suspended — JiffyApp</title>
<style>body{font-family:system-ui,sans-serif;max-width:38rem;margin:4rem auto;padding:0 1rem;color:#222}</style></head>
<body><h1>410 — this tool is suspended</h1>
<p>Hosting for this tool has lapsed. It is served while a monthly hosting gig is funded, with a 7-day grace period.</p>
<p><strong>Owner?</strong> Fund a new $5/mo JiffyApp hosting gig referencing your toolId to revive this URL,
or use the eject ZIP from your delivery to self-host — the source is yours.</p>
<p>Built by <a href="https://jiffyapp.dev">JiffyApp</a>.</p></body></html>`;

export const NOT_FOUND_PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Not found — JiffyApp</title></head><body><h1>404 — no tool here</h1>
<p>Built by <a href="https://jiffyapp.dev">JiffyApp</a>.</p></body></html>`;
