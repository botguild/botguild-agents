// Public per-token build-log page (FR-11): the glass-box view of a build in progress. The page
// is served from the bot origin, self-contained (inline CSS+JS, no external origins), and reads
// from BuildLogStore either via SSE (primary) or by polling `log.json` (degrade). No buyer PII is
// ever written to build_log by the pipeline — this module only ever renders what's already there.

import type { BuildLogEntry, BuildLogStore } from './jobs.js';

const TERMINAL_STAGES = new Set(['delivered', 'aborted']);

function isTerminalStage(stage: string): boolean {
  return TERMINAL_STAGES.has(stage);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Self-contained build-log page: EventSource primary, polling fallback, inline everything. */
export function buildLogPageHtml(token: string): string {
  const tokenJson = JSON.stringify(token);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Build log — JiffyApp</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1.5rem 4rem; color: #12181b; background: #ffffff; }
  h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
  .line { padding: 0.6rem 0; border-bottom: 1px solid #e2e6e8; }
  .stage { font-weight: 600; text-transform: uppercase; font-size: 0.75rem; color: #45535a; display: block; letter-spacing: 0.02em; }
  .msg { display: block; margin-top: 0.15rem; }
  img { max-width: 100%; border-radius: 0.4rem; margin-top: 0.6rem; display: block; border: 1px solid #e2e6e8; }
  #status { color: #45535a; font-size: 0.85rem; margin-top: 1.5rem; }
</style>
</head>
<body>
<h1>Build log</h1>
<div id="log"></div>
<div id="status">connecting…</div>
<script>
(function () {
  var token = ${tokenJson};
  var logEl = document.getElementById('log');
  var statusEl = document.getElementById('status');
  var lastSeq = 0;
  var done = false;

  function basename(key) {
    var idx = key.lastIndexOf('/');
    return idx === -1 ? key : key.slice(idx + 1);
  }

  function renderEvent(evt) {
    if (!evt || typeof evt.seq !== 'number' || evt.seq <= lastSeq) return;
    lastSeq = evt.seq;
    var line = document.createElement('div');
    line.className = 'line';
    var stage = document.createElement('span');
    stage.className = 'stage';
    stage.textContent = evt.stage;
    line.appendChild(stage);
    var msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = evt.message || '';
    line.appendChild(msg);
    if (evt.detail && evt.detail.screenshotKey) {
      var img = document.createElement('img');
      img.src = '/deliverables/' + token + '/' + basename(evt.detail.screenshotKey);
      img.alt = evt.stage + ' screenshot';
      line.appendChild(img);
    }
    logEl.appendChild(line);
    if (evt.stage === 'delivered' || evt.stage === 'aborted') {
      done = true;
      statusEl.textContent = evt.stage === 'delivered' ? 'Build delivered.' : 'Build aborted.';
    }
  }

  function poll() {
    if (done) return;
    fetch('/p/' + token + '/log.json?after=' + lastSeq)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        (data.events || []).forEach(renderEvent);
        if (data.done) done = true;
        if (!done) setTimeout(poll, 2000);
      })
      .catch(function () {
        if (!done) setTimeout(poll, 2000);
      });
  }

  if (typeof EventSource !== 'undefined') {
    var source = new EventSource('/p/' + token + '/events');
    source.onmessage = function (e) {
      try { renderEvent(JSON.parse(e.data)); } catch (err) { /* ignore malformed frame */ }
      if (done) source.close();
    };
    source.onerror = function () {
      source.close();
      statusEl.textContent = 'live updates unavailable; polling…';
      poll();
    };
  } else {
    poll();
  }
})();
</script>
</body>
</html>`;
}

/**
 * `{ events, done }` — `events` is everything after `afterSeq`; `done` is whether a terminal
 * stage ('delivered' | 'aborted') appears anywhere in that returned slice.
 */
export async function handleLogJson(
  store: BuildLogStore,
  token: string,
  afterSeq: number,
): Promise<{ status: number; body: { events: BuildLogEntry[]; done: boolean } }> {
  const events = await store.since(token, afterSeq);
  const done = events.some((e) => isTerminalStage(e.stage));
  return { status: 200, body: { events, done } };
}

/**
 * SSE frames `id: <seq>\ndata: <json>\n\n` from `store.since(token, lastEventId)` on a poll
 * loop. Closes after emitting a terminal-stage event, or once the loop's LOGICAL elapsed time
 * (accumulated in `pollMs` increments, never wall-clock) reaches `maxDurationMs` — this keeps the
 * cap meaningful under an injected no-op `sleep` in tests without ever depending on real time.
 */
export function createLogEventStream(args: {
  store: BuildLogStore;
  token: string;
  lastEventId: number;
  pollMs?: number;
  maxDurationMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): ReadableStream<Uint8Array> {
  const { store, token } = args;
  const pollMs = args.pollMs ?? 2000;
  const maxDurationMs = args.maxDurationMs ?? 55_000;
  const sleep = args.sleep ?? defaultSleep;
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      let lastId = args.lastEventId;
      let elapsedMs = 0;
      try {
        for (;;) {
          const events = await store.since(token, lastId);
          let terminal = false;
          for (const evt of events) {
            lastId = evt.seq;
            controller.enqueue(encoder.encode(`id: ${evt.seq}\ndata: ${JSON.stringify(evt)}\n\n`));
            if (isTerminalStage(evt.stage)) terminal = true;
          }
          if (terminal || elapsedMs >= maxDurationMs) break;
          await sleep(pollMs);
          elapsedMs += pollMs;
        }
      } finally {
        controller.close();
      }
    },
  });
}
