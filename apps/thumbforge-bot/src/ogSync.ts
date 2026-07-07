// ---------------------------------------------------------------------------
// Synchronous OG publish path (§6, FR-2/3/14/15) — the core of /hooks/:offerId,
// factored out of index.ts so it stays free of Hono/Workers-binding specifics.
//
// Flow: look up the per-offer secret → verify HMAC + replay window → derive the
// content-hash idempotency key → FR-3 claim state machine → FR-15 cap → FR-14
// moderation with the 5s budget → render + §9 gates → R2 PUT + read-back → 200
// with the URL. Over budget or moderation-unavailable → 202 with the
// DETERMINISTIC URL (mintable from the key) and an optional signed callback; the
// async completion runs in the returned `after` continuation (ctx.waitUntil).
// The URL probe always runs in `after` (never inline — err-1042 self-fetch, §9).
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';
import { CMS_REPLAY_WINDOW_SECONDS, MODERATION_BUDGET_MS, OG_MONTHLY_CAP } from './config.js';
import { deterministicUrl, hmacSha256Hex, ogDeliverableKey, verifyCmsRequest } from './cms.js';
import { decideIdempotency, deriveIdempotencyKey } from './idempotency.js';
import { decideUsage, overCapMessage, usagePeriod } from './usage.js';
import { buildOgGraphic } from './brief.js';
import { bytesEqual, renderSpec, type DeliverableStorage, type RenderContext, type UrlProbe } from './pipeline.js';
import type { Moderator } from './moderation.js';
import type { AuditStore, IdempotencyStore, OfferStore, UsageStore } from './jobs.js';
import type { BrandKit } from './types.js';

export interface OgPublishConfig {
  offers: OfferStore;
  idempotency: IdempotencyStore;
  usage: UsageStore;
  audit: AuditStore;
  moderator: Moderator;
  render: RenderContext;
  storage: DeliverableStorage;
  probe: UrlProbe;
  publicBaseUrl: string;
  /** Injectable for tests — never call the live CMS from a test. */
  callbackFetch?: typeof fetch;
  logger: Logger;
  now?: () => Date;
  /** A default brand kit for the OG path when the offer supplies none inline. */
  defaultBrandKit?: BrandKit;
}

export interface CmsEnvelope {
  page_url?: string;
  title?: string;
  content_hash_fields?: Record<string, unknown>;
  timestamp?: number;
  signature?: string;
  callback_url?: string;
}

export interface OgResult {
  status: number;
  body: Record<string, unknown>;
  /** Post-response continuation: URL probe (always) + async render/callback. */
  after?: () => Promise<void>;
}

const DEFAULT_KIT: BrandKit = { palette: ['#0F1E3C', '#FF6B5E', '#F5C518'], swatchRegions: [] };

export async function handleOgPublish(
  cfg: OgPublishConfig,
  offerId: string,
  rawBody: string,
  signatureHeader: string | null,
): Promise<OgResult> {
  const now = cfg.now ?? ((): Date => new Date());
  const logger = cfg.logger.child({ offerId });

  const offer = await cfg.offers.get(offerId);
  if (!offer) return { status: 404, body: { error: 'unknown offer' } };

  let envelope: CmsEnvelope;
  try {
    envelope = JSON.parse(rawBody) as CmsEnvelope;
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }
  const pageUrl = envelope.page_url ?? '';
  const title = envelope.title ?? '';
  if (!pageUrl) return { status: 400, body: { error: 'page_url is required' } };

  // FR-2: HMAC + timestamp replay window. Reject spoofed/unsigned/stale.
  const verify = await verifyCmsRequest({
    secret: offer.secret,
    rawBody,
    providedSignature: signatureHeader ?? envelope.signature,
    timestamp: Number(envelope.timestamp),
    nowSeconds: Math.floor(now().getTime() / 1000),
    windowSeconds: CMS_REPLAY_WINDOW_SECONDS,
  });
  if (!verify.ok) {
    await cfg.audit.record({ scope: offerId, gate: 'cms-verify', result: verify.reason, detail: { pageUrl } });
    logger.warn({ reason: verify.reason }, 'CMS webhook verification failed');
    return { status: 401, body: { error: verify.reason } };
  }

  // FR-3: derive the content-hash key and run the claim state machine.
  const key = await deriveIdempotencyKey(pageUrl, title, envelope.content_hash_fields);
  const finalUrl = deterministicUrl(cfg.publicBaseUrl, key);

  const inserted = await cfg.idempotency.insertPending(key, offerId, pageUrl);
  if (!inserted) {
    const existing = await cfg.idempotency.get(key);
    const priorVersionDelivered = await cfg.idempotency.priorVersionDelivered(pageUrl, key);
    const decision = decideIdempotency(existing, { now: now().getTime(), priorVersionDelivered });
    await cfg.audit.record({ scope: key, gate: 'idempotency', result: decision.reason, detail: { pageUrl } });
    if (decision.action === 'return') {
      // Already delivered under this exact key: its R2 read-back ran at delivery.
      return { status: 200, body: reachabilityBody(decision.url, 'passed', true, { deduped: true }) };
    }
    if (decision.action === 'wait') {
      // A fresh attempt is in flight — hand back the deterministic URL, count
      // nothing, and report r2_verified:false (THIS invocation stored nothing).
      return { status: 202, body: reachabilityBody(finalUrl, 'pending', false, { inFlight: true }) };
    }
    // stale-pending-takeover → fall through and re-drive idempotently.
  }

  // FR-15: monthly cap as an ATOMIC reservation (§13). Claim the slot BEFORE the
  // render with a single conditional increment — never a read-decide-increment
  // that two concurrent publishes of different page versions could both pass.
  // Over cap → held (429), never rendered, never counted. Any failure after this
  // point releases the reservation (compensating decrement).
  const period = usagePeriod(now());
  const cap = offer.cap || OG_MONTHLY_CAP;
  const reservation = await cfg.usage.reserve(offerId, period, cap);
  if (!reservation.reserved) {
    await cfg.idempotency.removePending(key);
    const usage = decideUsage(reservation.used, cap);
    await cfg.audit.record({ scope: key, gate: 'usage-cap', result: 'hold', detail: usage });
    return { status: 429, body: { held: true, message: overCapMessage(usage), usage } };
  }

  const spec = buildOgGraphic(cfg.defaultBrandKit ?? DEFAULT_KIT, title || pageUrl, key);

  // FR-14: moderation with the 5s synchronous budget. Unavailable → 202 + async.
  const moderation = await cfg.moderator.moderate(
    [title, pageUrl].filter(Boolean).join(' — '),
    MODERATION_BUDGET_MS,
  );
  await cfg.audit.record({ scope: key, gate: 'moderation', result: moderation.status });

  if (moderation.status === 'flagged') {
    await cfg.idempotency.removePending(key);
    await cfg.usage.release(offerId, period); // never rendered → give the slot back
    return { status: 422, body: { error: 'content flagged by moderation', reason: moderation.reason } };
  }

  if (moderation.status === 'unavailable') {
    // Over budget: respond 202 with the deterministic URL and finish async. The
    // reservation is HELD across the async completion (which releases it on failure).
    logger.info({ detail: moderation.detail }, 'moderation over budget — 202 + async completion');
    return {
      status: 202,
      body: reachabilityBody(finalUrl, 'pending', false, { deferred: true }),
      after: () => completeAsync(cfg, { key, offerId, period, spec, envelope, secret: offer.secret, finalUrl }),
    };
  }

  // Clean + within budget: render synchronously, gate, store, deliver the URL.
  const rendered = await renderAndStore(cfg, key, spec);
  if (!rendered.ok) {
    await cfg.idempotency.removePending(key);
    await cfg.usage.release(offerId, period); // render failed a gate → release the slot
    return { status: 422, body: { error: 'render failed a blocking gate', detail: rendered.detail } };
  }

  // The slot was already reserved atomically above — do NOT increment again.
  await cfg.idempotency.markDelivered(key, rendered.url);
  await cfg.audit.record({ scope: key, gate: 'og-delivery', result: 'delivered', detail: { url: rendered.url, bytes: rendered.byteLength } });

  return {
    status: 200,
    // The in-process R2 write-then-read byte-equality ran (r2_verified: true);
    // url_probe is still pending until probeAfter lands.
    body: reachabilityBody(rendered.url, 'pending', true, { bytes: rendered.byteLength, format: rendered.format }),
    // §9: probe post-response from the probe Worker; failure alerts + re-delivers.
    after: () => probeAfter(cfg, key, rendered.url, envelope, offer.secret),
  };
}

// --- render + store (shared by sync + async completion) ----------------------

type RenderStoreResult =
  | { ok: true; url: string; byteLength: number; format: 'png' | 'jpeg' }
  | { ok: false; detail: unknown };

async function renderAndStore(
  cfg: OgPublishConfig,
  key: string,
  spec: ReturnType<typeof buildOgGraphic>,
): Promise<RenderStoreResult> {
  const rendered = await renderSpec(cfg.render, spec);
  if (!rendered.gates.pass) {
    return {
      ok: false,
      detail: {
        headline: rendered.gates.headline,
        color: rendered.gates.color.pass,
        dimensions: rendered.gates.dimensions.pass,
      },
    };
  }

  const r2Key = ogDeliverableKey(key);
  await cfg.storage.put(r2Key, rendered.bytes, rendered.format === 'png' ? 'image/png' : 'image/jpeg');
  const readBack = await cfg.storage.getBytes(r2Key);
  // §9(a): full byte-equality, not just length — a corrupted-but-same-length R2
  // object must not pass the pre-delivery reachability gate (matches the queue path).
  if (!readBack || !bytesEqual(readBack, rendered.bytes)) {
    throw new Error(`R2 read-back byte-equality failed for ${r2Key}`);
  }
  const url = `${cfg.publicBaseUrl.replace(/\/$/, '')}/a/${r2Key}`;
  return { ok: true, url, byteLength: rendered.bytes.byteLength, format: rendered.format };
}

async function completeAsync(
  cfg: OgPublishConfig,
  args: {
    key: string;
    offerId: string;
    period: string;
    spec: ReturnType<typeof buildOgGraphic>;
    envelope: CmsEnvelope;
    secret: string;
    finalUrl: string;
  },
): Promise<void> {
  // Re-moderate without the tight budget; still fail-closed.
  const moderation = await cfg.moderator.moderate(
    [args.envelope.title, args.envelope.page_url].filter(Boolean).join(' — '),
    30_000,
  );
  if (moderation.status !== 'clean') {
    await cfg.idempotency.removePending(args.key);
    await cfg.usage.release(args.offerId, args.period); // reservation held at 202 → release
    await cfg.audit.record({ scope: args.key, gate: 'moderation-async', result: moderation.status });
    await postCallback(cfg, args.envelope.callback_url, args.secret, { status: 'failed', reason: 'moderation', key: args.key });
    return;
  }

  const rendered = await renderAndStore(cfg, args.key, args.spec);
  if (!rendered.ok) {
    await cfg.idempotency.removePending(args.key);
    await cfg.usage.release(args.offerId, args.period); // reservation held at 202 → release
    await postCallback(cfg, args.envelope.callback_url, args.secret, { status: 'failed', reason: 'gate', key: args.key });
    return;
  }

  // The slot was reserved atomically before the 202 — do NOT increment again.
  await cfg.idempotency.markDelivered(args.key, rendered.url);
  await cfg.audit.record({ scope: args.key, gate: 'og-delivery-async', result: 'delivered', detail: { url: rendered.url } });

  const probe = await cfg.probe.probe(rendered.url).catch(() => ({ ok: false, status: 0, byteLength: 0 }));
  await cfg.audit.record({ scope: args.key, gate: 'url-probe', result: probe.ok ? 'pass' : 'fail', detail: probe });
  await postCallback(cfg, args.envelope.callback_url, args.secret, {
    status: 'completed',
    url: rendered.url,
    key: args.key,
  });
}

async function probeAfter(
  cfg: OgPublishConfig,
  key: string,
  url: string,
  envelope: CmsEnvelope,
  secret: string,
): Promise<void> {
  const probe = await cfg.probe.probe(url).catch((err: unknown) => ({ ok: false, status: 0, byteLength: 0, err }));
  await cfg.audit.record({ scope: key, gate: 'url-probe', result: probe.ok ? 'pass' : 'fail', detail: probe });
  if (!probe.ok) {
    cfg.logger.error({ key, url, probe }, 'URL probe failed post-delivery — re-delivering (operator alert)');
    await postCallback(cfg, envelope.callback_url, secret, { status: 'failed', reason: 'probe', key });
  }
}

async function postCallback(
  cfg: OgPublishConfig,
  callbackUrl: string | undefined,
  secret: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!callbackUrl) return;
  const body = JSON.stringify(payload);
  const timestamp = Math.floor((cfg.now?.() ?? new Date()).getTime() / 1000);
  const signature = `hmac-sha256=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
  const fetchImpl = cfg.callbackFetch ?? fetch;
  try {
    await fetchImpl(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ThumbForge-Signature': signature,
        'X-ThumbForge-Timestamp': String(timestamp),
      },
      body,
    });
  } catch (err) {
    cfg.logger.warn({ err, callbackUrl }, 'signed CMS callback POST failed');
  }
}

function reachabilityBody(
  url: string,
  urlProbe: 'pending' | 'passed' | 'failed',
  r2Verified: boolean,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  // §8: r2_verified reflects whether THIS invocation completed the in-process R2
  // write-then-read. It is passed explicitly (true only on the sync-delivered and
  // deduped paths); the 202 in-flight/deferred branches stored nothing → false.
  return { url, reachability: { r2_verified: r2Verified, url_probe: urlProbe }, ...extra };
}
