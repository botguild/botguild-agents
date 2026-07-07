// ---------------------------------------------------------------------------
// thumbforge-probe — the URL-probe leg of the §9 reachability gate.
//
// POST { "url": "https://…" } → { status, byteLength, ok } (or { error }).
// Runs on its own workers.dev hostname so the fetch originates off the bot's
// custom-domain zone, avoiding the same-zone self-hostname fetch hazard (err
// 1042). A cache-buster query param defeats any edge/browser caching so the
// probe measures the freshly-published object, not a stale copy.
// ---------------------------------------------------------------------------

interface ProbeRequest {
  url: string;
}

interface ProbeResult {
  status: number;
  byteLength: number;
  ok: boolean;
}

function cacheBust(url: string): string {
  const u = new URL(url);
  u.searchParams.set('__tfprobe', Date.now().toString(36));
  return u.toString();
}

async function probe(url: string): Promise<ProbeResult> {
  const response = await fetch(cacheBust(url), {
    method: 'GET',
    // Never serve a cached hit — the probe must observe the real object.
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache' },
  });
  // Drain the body to measure the delivered byte length as evidence.
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { status: response.status, byteLength: bytes.byteLength, ok: response.ok };
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'POST { url } only' }, { status: 405 });
    }

    let body: ProbeRequest;
    try {
      body = (await request.json()) as ProbeRequest;
    } catch {
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    }

    if (typeof body.url !== 'string' || !/^https?:\/\//i.test(body.url)) {
      return Response.json({ error: 'body.url must be an http(s) URL' }, { status: 400 });
    }

    try {
      return Response.json(await probe(body.url));
    } catch (err) {
      return Response.json(
        { error: `probe fetch failed: ${(err as Error).message}` },
        { status: 502 },
      );
    }
  },
};
