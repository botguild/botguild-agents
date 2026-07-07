// Integration test for handleOgPublish — the most complex paid path (HMAC
// verify → idempotency state machine → atomic cap → moderation budget →
// render/store → 200/202/dedupe/callback). Drives the real orchestration
// against in-memory D1 + fakes, and renders the actual og layout in Node for
// the happy path so the R2 read-back byte-equality gate is exercised end-to-end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { createConsoleLogger } from '@botguild/agent-core-workers';
import { applyMigrations } from './dbTestSupport.js';
import {
  createAuditStore,
  createIdempotencyStore,
  createOfferStore,
  createUsageStore,
} from './jobs.js';
import { handleOgPublish, type OgPublishConfig } from './ogSync.js';
import { hmacSha256Hex } from './cms.js';
import { deriveIdempotencyKey } from './idempotency.js';
import type { DeliverableStorage, RenderContext, UrlProbe } from './pipeline.js';
import type { Moderator, ModerationOutcome } from './moderation.js';
import { loadFontsNode } from './fonts/node.js';
import { nodeWasmSources } from './render/wasm.node.js';

const logger = createConsoleLogger({ service: 'test' });
const SECRET = 'offer-secret-abc';
const OFFER = 'offer-1';

// Fonts + wasm are shared across tests (isolate-singleton wasm init).
const render: RenderContext = { fonts: await loadFontsNode(), wasm: nodeWasmSources() };

const cleanModerator: Moderator = { moderate: async (): Promise<ModerationOutcome> => ({ status: 'clean' }) };
const okProbe: UrlProbe = { probe: async () => ({ status: 200, byteLength: 1, ok: true }) };

/** In-memory R2 double; `corrupt` flips a byte on write to fake a same-length corruption. */
function memStorage(corrupt = false): DeliverableStorage {
  const store = new Map<string, Uint8Array>();
  return {
    async put(key, bytes): Promise<void> {
      const copy = bytes.slice();
      if (corrupt && copy.length > 0) copy[0] = copy[0]! ^ 0xff;
      store.set(key, copy);
    },
    async getBytes(key): Promise<Uint8Array | null> {
      return store.get(key) ?? null;
    },
  };
}

interface Harness {
  cfg: OgPublishConfig;
  usage: ReturnType<typeof createUsageStore>;
  db: ReturnType<typeof createMemoryD1>;
}

async function harness(overrides: Partial<OgPublishConfig> = {}, cap = 100): Promise<Harness> {
  const db = createMemoryD1();
  await applyMigrations(db);
  const offers = createOfferStore(db);
  await offers.arm({ offerId: OFFER, secret: SECRET, contractId: 'c1', cap });
  const usage = createUsageStore(db);
  const cfg: OgPublishConfig = {
    offers,
    idempotency: createIdempotencyStore(db),
    usage,
    audit: createAuditStore(db),
    moderator: cleanModerator,
    render,
    storage: memStorage(),
    probe: okProbe,
    publicBaseUrl: 'https://tf.example.com',
    logger,
    ...overrides,
  };
  return { cfg, usage, db };
}

async function signedRequest(
  body: Record<string, unknown>,
  opts: { secret?: string; timestamp?: number } = {},
): Promise<{ raw: string; signature: string }> {
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const raw = JSON.stringify({ ...body, timestamp });
  const signature = `hmac-sha256=${await hmacSha256Hex(opts.secret ?? SECRET, `${timestamp}.${raw}`)}`;
  return { raw, signature };
}

const page = { page_url: 'https://example.com/post', title: 'Hello World' };

test('401 on a bad signature and on a stale timestamp', async () => {
  const { cfg } = await harness();
  const good = await signedRequest(page);
  assert.equal((await handleOgPublish(cfg, OFFER, good.raw, 'hmac-sha256=deadbeef')).status, 401);

  const stale = await signedRequest(page, { timestamp: Math.floor(Date.now() / 1000) - 10_000 });
  assert.equal((await handleOgPublish(cfg, OFFER, stale.raw, stale.signature)).status, 401);
});

test('422 when moderation flags the content, and the reserved cap slot is released', async () => {
  const flagged: Moderator = { moderate: async (): Promise<ModerationOutcome> => ({ status: 'flagged', reason: 'unsafe' }) };
  const { cfg, usage } = await harness({ moderator: flagged });
  const req = await signedRequest(page);
  const res = await handleOgPublish(cfg, OFFER, req.raw, req.signature);
  assert.equal(res.status, 422);
  assert.equal(await usage.getUsed(OFFER, monthKey()), 0, 'a flagged job never keeps a cap slot');
});

test('429 when the offer is at its monthly cap (held, never rendered)', async () => {
  const { cfg, usage } = await harness({}, 2);
  await usage.reserve(OFFER, monthKey(), 2);
  await usage.reserve(OFFER, monthKey(), 2); // cap now exhausted
  const req = await signedRequest(page);
  const res = await handleOgPublish(cfg, OFFER, req.raw, req.signature);
  assert.equal(res.status, 429);
  assert.equal((res.body as { held?: boolean }).held, true);
});

test('202 in-flight when a fresh pending claim from another invocation exists (r2_verified false)', async () => {
  const { cfg, db } = await harness();
  const idem = createIdempotencyStore(db);
  const key = await deriveIdempotencyKey(page.page_url, page.title, undefined);
  await idem.insertPending(key, OFFER, page.page_url); // simulate an in-flight sibling
  const req = await signedRequest(page);
  const res = await handleOgPublish(cfg, OFFER, req.raw, req.signature);
  assert.equal(res.status, 202);
  const reach = (res.body as { reachability: { r2_verified: boolean } }).reachability;
  assert.equal(reach.r2_verified, false, 'this invocation stored nothing → r2_verified must be false');
});

test('200 happy path renders, verifies the R2 read-back, and reports r2_verified true; dedupe returns without re-counting', async () => {
  const { cfg, usage } = await harness();
  const req = await signedRequest(page);
  const res = await handleOgPublish(cfg, OFFER, req.raw, req.signature);
  assert.equal(res.status, 200);
  const reach = (res.body as { reachability: { r2_verified: boolean; url_probe: string } }).reachability;
  assert.equal(reach.r2_verified, true);
  assert.equal(reach.url_probe, 'pending');
  if (res.after) await res.after(); // the post-response URL probe
  assert.equal(await usage.getUsed(OFFER, monthKey()), 1);

  // Re-fire the identical page version → dedupe return, no second cap unit.
  const again = await handleOgPublish(cfg, OFFER, req.raw, req.signature);
  assert.equal(again.status, 200);
  assert.equal((again.body as { deduped?: boolean }).deduped, true);
  assert.equal(await usage.getUsed(OFFER, monthKey()), 1, 'a duplicate delivery counts nothing');
});

test('a same-length R2 corruption is rejected by the byte-equality gate (not accepted as byte-verified)', async () => {
  const { cfg } = await harness({ storage: memStorage(true) });
  const req = await signedRequest(page);
  await assert.rejects(() => handleOgPublish(cfg, OFFER, req.raw, req.signature), /byte-equality failed/);
});

function monthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}
