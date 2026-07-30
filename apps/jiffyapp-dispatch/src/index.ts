import {
  resolveSlug,
  decideDispatch,
  isStagingSlug,
  GONE_PAGE_HTML,
  NOT_FOUND_PAGE_HTML,
} from './decide.js';

export interface Env {
  DB: D1Database;
  DISPATCH: DispatchNamespace;
  TOOL_HOST_SUFFIX: string;
}

const html = (body: string, status: number) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const slug = resolveSlug(new URL(request.url).hostname, env.TOOL_HOST_SUFFIX);
    if (!slug) return html(NOT_FOUND_PAGE_HTML, 404);

    // Read the tools row up front. Legit staging builds have NO tools row (rows always use the
    // real promoted slug, never `stg-`), so a `stg-` host with a real row is defense-in-depth
    // against a slug that slipped the bot's naming policy — it MUST be status-gated, not an
    // auth-free passthrough (else a `stg-` slug would defeat the FR-17 kill switch and the
    // hosting-expiry 410). Wrap the read (F5): a D1 blip serves an honest 404, never a 500
    // (matches the DISPATCH.get try/catch below). Staging traffic is low-volume (Browser
    // Rendering during builds only), so the extra read is negligible.
    let row: { status: string } | null;
    try {
      row = await env.DB.prepare('SELECT status FROM tools WHERE slug = ?')
        .bind(slug)
        .first<{ status: string }>();
    } catch {
      return html(NOT_FOUND_PAGE_HTML, 404);
    }

    // Staging builds (bot Task 17) are browser-reachable before promotion so Playwright
    // (Browser Rendering) can run goldens against them. A `stg-` slug with NO tools row is
    // served straight from the namespace, marked non-cacheable + noindex so a staging preview
    // never lands in a cache or a search index. A `stg-` slug WITH a row falls through to the
    // status gate below (never a passthrough).
    if (isStagingSlug(slug) && !row) {
      try {
        const staged = await env.DISPATCH.get(slug).fetch(request);
        const headers = new Headers(staged.headers);
        headers.set('Cache-Control', 'no-store');
        headers.set('X-Robots-Tag', 'noindex');
        return new Response(staged.body, {
          status: staged.status,
          statusText: staged.statusText,
          headers,
        });
      } catch {
        return html(NOT_FOUND_PAGE_HTML, 404);
      }
    }

    const decision = decideDispatch(row?.status ?? null);
    if (decision.kind === 'gone') return html(GONE_PAGE_HTML, 410);
    if (decision.kind === 'unknown') return html(NOT_FOUND_PAGE_HTML, 404);

    try {
      return await env.DISPATCH.get(slug).fetch(request);
    } catch {
      // Script missing despite a serving status (deploy race) — honest 404, never a 500 loop.
      return html(NOT_FOUND_PAGE_HTML, 404);
    }
  },
};
