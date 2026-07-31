import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentClient } from '@botguild/agent-core';
import { createConsoleLogger } from '@botguild/agent-core-workers';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import type { D1Like } from '@botguild/agent-core-workers';
import { MIN_SOURCE_PX } from './brief.js';
import {
  FREE_GIGS_PER_PAYER,
  FREE_GIG_WINDOW_DAYS,
  IMAGE_COST_USD,
  MAX_REGENS_PER_SLOT,
  MAX_SPEND_USD,
  SCOUT_MODEL_ID,
  SEED_PRICE_USD,
} from './config.js';
import {
  MAX_SOURCE_BYTES,
  checkFreeGigQuota,
  fetchSourceLogo,
  type SourceLogoResult,
} from './freeGigs.js';
import type { GenerateResult, Generator } from './generate.js';
import { readPngDimensions, type OcrGate, type OcrOutcome } from './gates/index.js';
import {
  buildJobKey,
  createConceptStore,
  createJobStore,
  createQuotaStore,
  createSelectionStore,
  type JobStore,
  type QuotaStore,
} from './jobs.js';
import type { ModerationClient } from './moderation.js';
import { renderSvgToPng } from './pack/render.js';
import { nodeWasmSources } from './pack/wasm.node.js';
import { FAVICON_ZIP_ENTRIES, unzipFiles } from './pack/zip.js';
import {
  processJobMessage,
  runConceptStage,
  runSingleStage,
  type DeliverableStore,
  type PipelineConfig,
} from './pipeline.js';
import { applyMigrations } from './testSupport.js';
import type { FetchLike, JobMessage, StyleAxis } from './types.js';

const logger = createConsoleLogger({ service: 'logosmith-test', level: 'silent' });
const sources = nodeWasmSources();

const SQUARE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
  '<path d="M10 10 H90 V90 H10 Z" fill="#0F3D3E"/>' +
  '<circle cx="50" cy="50" r="22" fill="#E8C39E"/></svg>';

/**
 * Three broadband marks, pairwise far apart under the FR-6 pHash gate. Flat
 * swatches (or the same mark twice) would be demoted by the distinctness gate
 * and turn the paid-stage fixture below into a `partial` — which is Task 4's
 * ruling, restated here because the FR-18 test depends on a `delivered` M1.
 */
const markSvg = (inner: string): string =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">' +
  `<rect width="256" height="256" fill="#ffffff"/>${inner}</svg>`;

const MARK_SVGS: Record<string, string> = {
  leftHalf: markSvg('<rect width="128" height="256" fill="#000"/>'),
  topHalf: markSvg('<rect width="256" height="128" fill="#000"/>'),
  checker: markSvg(
    Array.from({ length: 64 }, (_, i) => {
      const x = (i % 8) * 32;
      const y = Math.floor(i / 8) * 32;
      return ((i % 8) + Math.floor(i / 8)) % 2 === 0
        ? `<rect x="${x}" y="${y}" width="32" height="32" fill="#000"/>`
        : '';
    }).join(''),
  ),
};

const fixtures: Record<string, Uint8Array> = {};

before(async () => {
  fixtures['png512'] = await renderSvgToPng(SQUARE_SVG, 512, sources);
  fixtures['png256'] = await renderSvgToPng(SQUARE_SVG, 256, sources);
  for (const [name, svg] of Object.entries(MARK_SVGS)) {
    fixtures[name] = await renderSvgToPng(svg, 256, sources);
  }
});

// ---------------------------------------------------------------------------
// FR-14 — the free-gig quota
// ---------------------------------------------------------------------------

async function quotaStore(now: () => Date = () => new Date()): Promise<{
  quota: QuotaStore;
  db: D1Like;
}> {
  const db = createMemoryD1();
  await applyMigrations(db);
  return { quota: createQuotaStore(db, now), db };
}

describe('checkFreeGigQuota', () => {
  it('allows a payer with no history and counts down the remaining allowance', async () => {
    const { quota } = await quotaStore();
    assert.deepEqual(await checkFreeGigQuota(quota, 'payer-1'), {
      allowed: true,
      used: 0,
      remaining: FREE_GIGS_PER_PAYER,
    });

    await quota.record('payer-1', 'favicon', 'contract-a');
    assert.deepEqual(await checkFreeGigQuota(quota, 'payer-1'), {
      allowed: true,
      used: 1,
      remaining: FREE_GIGS_PER_PAYER - 1,
    });
  });

  it('refuses a payer at the cap with an actionable message, and again on the attempt after', async () => {
    const { quota } = await quotaStore();
    for (let i = 0; i < FREE_GIGS_PER_PAYER; i++) {
      await quota.record('payer-1', 'taster', `contract-${i}`);
    }
    // Precondition: the store really holds the cap, so a refusal below cannot
    // be an artefact of a store that recorded nothing.
    assert.equal(await quota.countRecent('payer-1', FREE_GIG_WINDOW_DAYS), FREE_GIGS_PER_PAYER);

    const atCap = await checkFreeGigQuota(quota, 'payer-1');
    assert.equal(atCap.allowed, false);
    assert.equal(atCap.used, FREE_GIGS_PER_PAYER);
    assert.ok(atCap.allowed === false);
    // Actionable: names the cap, the window, and the way forward.
    assert.match(atCap.message, new RegExp(String(FREE_GIGS_PER_PAYER)));
    assert.match(atCap.message, new RegExp(`${FREE_GIG_WINDOW_DAYS}-day`));
    assert.match(atCap.message, new RegExp(`\\$${SEED_PRICE_USD}`));
    assert.match(atCap.message, /nothing has been charged/i);

    // The 4th attempt inside the window is refused too — a refusal that does
    // not record anything must not decay into an allowance next time.
    const fourth = await checkFreeGigQuota(quota, 'payer-1');
    assert.equal(fourth.allowed, false);
    assert.equal(fourth.used, FREE_GIGS_PER_PAYER);
  });

  it('does not count usage older than the rolling window', async () => {
    const clock = { at: new Date('2026-01-01T00:00:00.000Z') };
    const { quota } = await quotaStore(() => clock.at);
    for (let i = 0; i < FREE_GIGS_PER_PAYER; i++) {
      await quota.record('payer-1', 'favicon', `contract-${i}`);
    }
    assert.equal((await checkFreeGigQuota(quota, 'payer-1')).allowed, false);

    // One second past the window: every row has aged out.
    clock.at = new Date(clock.at.getTime() + FREE_GIG_WINDOW_DAYS * 86_400_000 + 1000);
    assert.deepEqual(await checkFreeGigQuota(quota, 'payer-1'), {
      allowed: true,
      used: 0,
      remaining: FREE_GIGS_PER_PAYER,
    });

    // ...and one second INSIDE it does not, so the assertion above is about the
    // boundary rather than about any clock movement at all.
    clock.at = new Date('2026-01-01T00:00:00.000Z');
    clock.at = new Date(clock.at.getTime() + FREE_GIG_WINDOW_DAYS * 86_400_000 - 1000);
    assert.equal((await checkFreeGigQuota(quota, 'payer-1')).allowed, false);
  });

  it('counts each payer separately', async () => {
    const { quota } = await quotaStore();
    for (let i = 0; i < FREE_GIGS_PER_PAYER; i++) {
      await quota.record('payer-1', 'favicon', `contract-${i}`);
    }
    assert.equal((await checkFreeGigQuota(quota, 'payer-1')).allowed, false);
    assert.equal((await checkFreeGigQuota(quota, 'payer-2')).allowed, true);
  });
});

// ---------------------------------------------------------------------------
// §12 — the fetch-time logoUrl guards
// ---------------------------------------------------------------------------

const LOGO_URL = 'https://cdn.example.com/logo.png';

const respondWith =
  (bytes: Uint8Array, status = 200): FetchLike =>
  async () =>
    new Response(bytes as unknown as BodyInit, { status });

const reason = (result: SourceLogoResult): string => {
  assert.equal(result.ok, false, 'expected a refusal');
  return result.ok ? '' : result.reason;
};

describe('fetchSourceLogo — §12 refusals', () => {
  it('refuses a body over the 10 MB cap', async () => {
    // Prefixed with a real PNG signature so this proves the SIZE guard rather
    // than accidentally tripping the type sniff.
    const fetchImpl: FetchLike = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(fixtures['png512']!);
            for (let i = 0; i < 11; i++) controller.enqueue(new Uint8Array(1024 * 1024));
            controller.close();
          },
        }),
      );
    const result = await fetchSourceLogo({ fetchImpl, url: LOGO_URL });
    assert.match(reason(result), /larger than 10 MB/);
    assert.equal(MAX_SOURCE_BYTES, 10 * 1024 * 1024);
  });

  it('refuses a body whose magic bytes are not PNG, JPEG, or SVG', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.4\n%âãÏÓ');
    const result = await fetchSourceLogo({ fetchImpl: respondWith(pdf), url: LOGO_URL });
    assert.match(reason(result), /does not return a PNG, JPEG, or SVG/);
  });

  it('does not trust the content-type header over the bytes', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(new TextEncoder().encode('not an image at all') as unknown as BodyInit, {
        headers: { 'content-type': 'image/png' },
      });
    const result = await fetchSourceLogo({ fetchImpl, url: LOGO_URL });
    assert.match(reason(result), /does not return a PNG, JPEG, or SVG/);
  });

  it('refuses XML that declares itself but carries no <svg> element', async () => {
    const html = new TextEncoder().encode(
      '<!DOCTYPE html><html><body>404 — no svg here</body></html>',
    );
    const result = await fetchSourceLogo({ fetchImpl: respondWith(html), url: LOGO_URL });
    assert.match(reason(result), /contains no <svg> element/);
  });

  it('refuses a raster below MIN_SOURCE_PX and says what to do about it', async () => {
    // Precondition: the fixture really is under the minimum.
    assert.deepEqual(readPngDimensions(fixtures['png256']!), { width: 256, height: 256 });
    const result = await fetchSourceLogo({
      fetchImpl: respondWith(fixtures['png256']!),
      url: LOGO_URL,
    });
    const text = reason(result);
    assert.match(text, /256x256px/);
    assert.match(text, new RegExp(`at least ${MIN_SOURCE_PX}px`));
    assert.match(text, /will not upscale/);
  });

  it('refuses when the origin does not answer inside the timeout', async () => {
    // Exercises the real AbortSignal.timeout path, with the deadline shortened
    // by the documented test seam rather than the signal faked out.
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        assert.ok(signal, 'fetchSourceLogo must pass an abort signal');
        signal.addEventListener('abort', () => {
          reject((signal as AbortSignal & { reason: unknown }).reason);
        });
      });
    // `AbortSignal.timeout`'s internal timer is UNREF'd, so with a fetch that
    // never settles there would be nothing left to keep the loop alive and the
    // runner would tear the file down before the abort ever fired. One ref'd
    // timer holds the loop open for the 25 ms it takes.
    const keepAlive = setTimeout(() => undefined, 5_000);
    try {
      const result = await fetchSourceLogo({ fetchImpl, url: LOGO_URL, timeoutMs: 25 });
      assert.match(reason(result), /did not respond within/);
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it('refuses a redirect rather than following an unchecked hop', async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      assert.equal(init?.redirect, 'manual', 'redirects must not be followed');
      return new Response(null, { status: 302 });
    };
    const result = await fetchSourceLogo({ fetchImpl, url: LOGO_URL });
    assert.match(reason(result), /redirects \(HTTP 302\)/);
  });

  it('refuses a URL the §12 policy rejects before any request is made', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Response(fixtures['png512']! as unknown as BodyInit);
    };
    for (const url of [
      'http://cdn.example.com/logo.png',
      'https://169.254.169.254/logo.png',
      'https://localhost/logo.png',
    ]) {
      const result = await fetchSourceLogo({ fetchImpl, url });
      assert.equal(result.ok, false, url);
    }
    assert.equal(calls, 0, 'a policy refusal must not reach the network');
  });

  it('gives every refusal its own distinct reason', async () => {
    const html = new TextEncoder().encode('<!DOCTYPE html><html></html>');
    const reasons = [
      reason(await fetchSourceLogo({ fetchImpl: respondWith(fixtures['png256']!), url: LOGO_URL })),
      reason(
        await fetchSourceLogo({
          fetchImpl: respondWith(new TextEncoder().encode('%PDF-1.4')),
          url: LOGO_URL,
        }),
      ),
      reason(await fetchSourceLogo({ fetchImpl: respondWith(html), url: LOGO_URL })),
      reason(
        await fetchSourceLogo({
          fetchImpl: respondWith(new Uint8Array(0), 503),
          url: LOGO_URL,
        }),
      ),
    ];
    assert.equal(new Set(reasons).size, reasons.length, JSON.stringify(reasons));
  });
});

describe('fetchSourceLogo — accepted sources', () => {
  it('accepts a valid PNG and reports its true dimensions', async () => {
    const result = await fetchSourceLogo({
      fetchImpl: respondWith(fixtures['png512']!),
      url: LOGO_URL,
    });
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.deepEqual(
      {
        kind: result.source.kind,
        ...(result.source.kind === 'raster'
          ? { w: result.source.width, h: result.source.height }
          : {}),
      },
      { kind: 'raster', w: 512, h: 512 },
    );
  });

  it('accepts a valid SVG, waives the pixel minimum, and sanitizes it', async () => {
    const svg =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<script>fetch("https://evil.example.com")</script>' +
      '<path d="M1 1 H9 V9 H1 Z" onclick="alert(1)" fill="#000"/></svg>';
    const result = await fetchSourceLogo({
      fetchImpl: respondWith(new TextEncoder().encode(svg)),
      url: 'https://cdn.example.com/logo.svg',
    });
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.equal(result.source.kind, 'svg');
    assert.ok(result.source.kind === 'svg');
    assert.equal(result.source.svg.includes('<script'), false);
    assert.equal(result.source.svg.includes('onclick'), false);
    assert.ok(result.source.svg.includes('<path'), 'the artwork itself must survive');
  });
});

// ---------------------------------------------------------------------------
// runSingleStage — the free funnel end to end
// ---------------------------------------------------------------------------

const CONTRACT_ID = 'contract-free-1';
const PAYER_ID = 'payer-1';

const FAVICON_DESCRIPTION = '```json\n' + JSON.stringify({ logoUrl: LOGO_URL }) + '\n```';
const TASTER_DESCRIPTION =
  '```json\n' + JSON.stringify({ brandName: 'Harbor & Vine', industry: 'boutique inn' }) + '\n```';

interface MemoryR2 extends DeliverableStore {
  objects: Map<string, { bytes: Uint8Array; contentType: string }>;
}

function memoryR2(): MemoryR2 {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    objects,
    async put(key, value, contentType) {
      objects.set(key, { bytes: value, contentType });
    },
    async get(key) {
      return objects.get(key)?.bytes ?? null;
    },
  };
}

interface Delivery {
  milestoneId: string;
  note: string;
  attachments: string[];
}

const verdict = (pass: boolean, transcription = 'Harbor & Vine'): OcrOutcome => ({
  status: 'ok',
  verdict: {
    model: SCOUT_MODEL_ID,
    transcription,
    score: pass ? 0.97 : 0.41,
    pass,
    unsafe: false,
    checkedAt: '2026-07-30T12:00:00.000Z',
  },
});

const clearModeration: ModerationClient = {
  screen: async () => ({
    status: 'clear',
    verdict: {
      vendor: 'openai',
      model: 'omni-moderation',
      flagged: false,
      response: {},
      checkedAt: '2026-07-30T12:00:00.000Z',
    },
  }),
};

interface FreeHarness {
  config: PipelineConfig;
  jobKey: string;
  token: string;
  db: D1Like;
  jobs: JobStore;
  quota: QuotaStore;
  r2: MemoryR2;
  deliveries: Delivery[];
  messages: string[];
  fetches: string[];
  generated: number;
  message: JobMessage;
}

interface FreeOptions {
  description?: string;
  /** Response for the logoUrl fetch; defaults to the 512 px PNG fixture. */
  logoResponse?: () => Response;
  /** `attempt` is 1-based. */
  generate?: (attempt: number) => GenerateResult;
  ocr?: (attempt: number) => OcrOutcome;
  moderation?: ModerationClient;
  /** Free-gig rows to pre-seed for PAYER_ID before the stage runs. */
  priorFreeGigs?: number;
}

async function setupFree(options: FreeOptions = {}): Promise<FreeHarness> {
  const db = createMemoryD1();
  await applyMigrations(db);
  const jobs = createJobStore(db);
  const quota = createQuotaStore(db);
  const jobKey = await buildJobKey(CONTRACT_ID, 'single');
  await jobs.claim(jobKey, CONTRACT_ID, 'single');
  const token = (await jobs.get(jobKey))!.deliverableToken!;

  for (let i = 0; i < (options.priorFreeGigs ?? 0); i++) {
    await quota.record(PAYER_ID, 'favicon', `earlier-contract-${i}`);
  }

  const deliveries: Delivery[] = [];
  const messages: string[] = [];
  const client = {
    getContract: async (id: string) => ({
      id,
      gigId: 'gig-free-1',
      payerId: PAYER_ID,
      milestones: [{ id: 'm1' }],
    }),
    getGig: async () => ({
      id: 'gig-free-1',
      description: options.description ?? FAVICON_DESCRIPTION,
    }),
    deliverMilestone: async (
      _contractId: string,
      milestoneId: string,
      payload: { note: string; attachments?: string[] },
    ) => {
      deliveries.push({ milestoneId, note: payload.note, attachments: payload.attachments ?? [] });
    },
    sendMessage: async (_contractId: string, content: string) => {
      messages.push(content);
    },
  } as unknown as AgentClient;

  const harness: Partial<FreeHarness> = { generated: 0 };
  const fetches: string[] = [];
  const generator: Generator = {
    async generate() {
      harness.generated = (harness.generated ?? 0) + 1;
      return (options.generate ?? ((): GenerateResult => okFlux()))(harness.generated);
    },
  };
  const ocrGate: OcrGate = {
    async check() {
      return (options.ocr ?? ((): OcrOutcome => verdict(true)))(harness.generated ?? 1);
    },
  };

  const config: PipelineConfig = {
    jobs,
    concepts: createConceptStore(db),
    selection: createSelectionStore(db),
    quota,
    client,
    ai: { run: async () => ({}) },
    deliverables: memoryR2(),
    sources,
    secrets: {
      moderationApiKey: 'test',
      anthropicApiKey: 'test',
      ideogramApiKey: 'test',
      recraftApiKey: 'test',
      vectorizerToken: 'test',
      googleFontsApiKey: 'test',
    },
    fetchImpl: async (url) => {
      fetches.push(url);
      if (url === LOGO_URL) {
        return (
          options.logoResponse ?? (() => new Response(fixtures['png512']! as unknown as BodyInit))
        )();
      }
      throw new Error(`no test may reach ${url}`);
    },
    publicBaseUrl: 'https://logosmith.example.com',
    logger,
    services: { generator, ocrGate, moderation: options.moderation ?? clearModeration },
  };

  Object.assign(harness, {
    config,
    jobKey,
    token,
    db,
    jobs,
    quota,
    r2: config.deliverables as MemoryR2,
    deliveries,
    messages,
    fetches,
    message: { contractId: CONTRACT_ID, jobKey, stage: 'single' as const },
  });
  return harness as FreeHarness;
}

const okFlux = (): GenerateResult => ({
  ok: true,
  costUsd: IMAGE_COST_USD.flux,
  concept: {
    axisId: 'taster-wordmark',
    vendor: 'flux',
    vendorRequestId: 'req-flux',
    png: fixtures['png512']!,
  },
});

const usage = (h: FreeHarness): Promise<number> =>
  h.quota.countRecent(PAYER_ID, FREE_GIG_WINDOW_DAYS);

describe('runSingleStage — the US-2 favicon gig', () => {
  it('delivers the favicon pack with ZERO vendor spend', async () => {
    const h = await setupFree();
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });

    const job = (await h.jobs.get(h.jobKey))!;
    assert.equal(job.kind, 'favicon');
    assert.equal(job.outcome, 'delivered');
    // AC3: the whole path is in-Worker CPU, so the ledger it wrote is $0.00 —
    // read from the persisted checkpoint, not from the absence of a mock call.
    assert.equal(job.checkpoint!.spendUsd, 0);
    assert.equal(job.spentUsd, 0);
    assert.equal(h.generated, 0, 'no image vendor may be called on the favicon gig');
    assert.deepEqual(h.fetches, [LOGO_URL], 'the only fetch is the buyer’s own logo');

    // The delivered link resolves to a real object, rather than merely matching
    // a string: the attachment is what the buyer clicks.
    assert.equal(h.deliveries.length, 1);
    const packUrl = h.deliveries[0]!.attachments[0]!;
    const key = packUrl.split('/deliverables/')[1]!;
    assert.equal(key, `${h.token}/pack.zip`);
    const stored = h.r2.objects.get(key)!;
    assert.equal(stored.contentType, 'application/zip');
    assert.deepEqual(Object.keys(unzipFiles(stored.bytes)).sort(), [...FAVICON_ZIP_ENTRIES].sort());

    assert.match(h.deliveries[0]!.note, new RegExp(`\\$${SEED_PRICE_USD}`));
    assert.equal(/escrow/i.test(h.deliveries[0]!.note), false, 'a $0 job has no escrow');
    assert.equal(await usage(h), 1, 'a delivered free job consumes exactly one allowance');
  });

  it('refuses over-quota payers before doing any work at all', async () => {
    const h = await setupFree({ priorFreeGigs: FREE_GIGS_PER_PAYER });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'aborted' });

    assert.deepEqual(h.fetches, [], 'the logo must not even be fetched');
    assert.equal(h.deliveries.length, 0);
    assert.equal(h.messages.length, 1);
    assert.match(h.messages[0]!, new RegExp(String(FREE_GIGS_PER_PAYER)));
    assert.equal((await h.jobs.get(h.jobKey))!.outcome, 'rejected');
    assert.equal(await usage(h), FREE_GIGS_PER_PAYER, 'a refusal records nothing');
  });

  it('does not consume an allowance when the buyer’s logo is refused', async () => {
    const h = await setupFree({
      logoResponse: () => new Response(fixtures['png256']! as unknown as BodyInit),
    });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'aborted' });
    assert.equal(await usage(h), 0, 'the buyer’s own bad input must not cost them a free job');
    assert.match(h.messages[0]!, new RegExp(`at least ${MIN_SOURCE_PX}px`));
    assert.match(h.messages[0]!, /not been counted against your free-job allowance/);
    assert.equal(h.deliveries.length, 0);
  });

  it('consumes exactly one allowance across a redelivered message', async () => {
    const h = await setupFree();
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });
    assert.equal(await usage(h), 1);

    // Queue redelivery / DLQ replay of the same message.
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });
    assert.equal(await usage(h), 1, 'redelivery must not re-charge the allowance');
    assert.equal(h.deliveries.length, 1, 'and must not deliver twice');
  });

  it('consumes exactly one allowance when a queue retry re-runs the whole stage', async () => {
    // The redelivery test above is satisfied by the already-delivered
    // short-circuit. THIS one is about the case that short-circuit cannot
    // reach: an infra fault after the allowance was recorded but before the job
    // reached a terminal state, which is precisely what the queue retries.
    let deliveries = 0;
    const h = await setupFree();
    const client = h.config.client as unknown as {
      deliverMilestone: (
        c: string,
        m: string,
        p: { note: string; attachments?: string[] },
      ) => Promise<void>;
    };
    const real = client.deliverMilestone.bind(client);
    client.deliverMilestone = async (c, m, p) => {
      deliveries += 1;
      if (deliveries === 1) throw new Error('platform 502');
      await real(c, m, p);
    };

    await assert.rejects(runSingleStage(h.config, h.message), /platform 502/);
    assert.equal(await usage(h), 1, 'the work was done, so the allowance is spent');
    assert.notEqual((await h.jobs.get(h.jobKey))!.status, 'delivered');

    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });
    assert.equal(await usage(h), 1, 'the retry must not re-charge the allowance');
  });

  it('rejects a gig whose brief validates as neither free shape', async () => {
    const h = await setupFree({ description: 'no fenced json here' });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'aborted' });
    assert.equal((await h.jobs.get(h.jobKey))!.outcome, 'rejected');
    assert.equal(await usage(h), 0);
    assert.match(h.messages[0]!, /logoUrl/);
    assert.match(h.messages[0]!, /brandName/);
  });
});

describe('runSingleStage — the US-3 taster', () => {
  it('delivers honestly when the readback FAILS, and names the $25 gig', async () => {
    const h = await setupFree({
      description: TASTER_DESCRIPTION,
      ocr: () => verdict(false, 'HRBRVN'),
    });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });

    // Non-blocking: three attempts were spent trying for a pass, and the sample
    // shipped regardless.
    assert.equal(h.generated, 1 + MAX_REGENS_PER_SLOT);
    assert.equal(h.deliveries.length, 1);
    const note = h.deliveries[0]!.note;
    assert.match(note, /Lettering readback: FAIL/);
    assert.match(note, /HRBRVN/);
    assert.match(note, new RegExp(`\\$${SEED_PRICE_USD}`));
    assert.match(note, /lettering-specialist model path/);
    assert.equal(/escrow/i.test(note), false);

    const job = (await h.jobs.get(h.jobKey))!;
    assert.equal(job.kind, 'taster');
    assert.equal(job.outcome, 'delivered', 'a failed readback is still a delivery');
    assert.ok(h.r2.objects.has(`${h.token}/concept-1.png`), 'the sample itself must exist');
    assert.equal(await usage(h), 1);
  });

  it('stops as soon as the readback passes and delivers that concept', async () => {
    const h = await setupFree({
      description: TASTER_DESCRIPTION,
      ocr: (attempt) => verdict(attempt >= 2, attempt >= 2 ? 'Harbor & Vine' : 'HRBRVN'),
    });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });
    assert.equal(h.generated, 2, 'no regeneration after a pass');
    assert.match(h.deliveries[0]!.note, /Lettering readback: PASS/);
  });

  it('keeps the best-scoring attempt rather than the last one', async () => {
    const scores = [0.6, 0.2, 0.3];
    const h = await setupFree({
      description: TASTER_DESCRIPTION,
      ocr: (attempt) => ({
        status: 'ok',
        verdict: {
          model: SCOUT_MODEL_ID,
          transcription: `attempt-${attempt}`,
          score: scores[attempt - 1]!,
          pass: false,
          unsafe: false,
          checkedAt: '2026-07-30T12:00:00.000Z',
        },
      }),
    });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });
    assert.equal(h.generated, 3);
    assert.match(h.deliveries[0]!.note, /attempt-1/);
    assert.match(h.deliveries[0]!.note, /\(0\.60,/);
  });

  it('spends only klein money, well inside the FR-5 cap', async () => {
    const h = await setupFree({ description: TASTER_DESCRIPTION, ocr: () => verdict(false) });
    await runSingleStage(h.config, h.message);
    const spent = (await h.jobs.get(h.jobKey))!.checkpoint!.spendUsd;
    assert.equal(spent, IMAGE_COST_USD.flux * (1 + MAX_REGENS_PER_SLOT));
    assert.ok(spent < MAX_SPEND_USD);
  });

  it('parks on a moderation outage without consuming an allowance', async () => {
    const outage: ModerationClient = {
      screen: async () => ({ status: 'unavailable', error: 'connect ETIMEDOUT' }),
    };
    const h = await setupFree({ description: TASTER_DESCRIPTION, moderation: outage });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'parked' });
    assert.equal(h.generated, 0, 'never generate from an unscreened brief');
    assert.equal(await usage(h), 0, 'our vendor’s outage must not cost the buyer a free job');
    assert.equal((await h.jobs.get(h.jobKey))!.status, 'parked');
  });

  it('parks on a klein outage without consuming an allowance', async () => {
    const h = await setupFree({
      description: TASTER_DESCRIPTION,
      generate: () => ({ ok: false, retryable: true, error: 'workers ai returned 503' }),
    });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'parked' });
    assert.equal(await usage(h), 0);
    assert.equal((await h.jobs.get(h.jobKey))!.parkReason, 'vendor_outage');
  });

  it('resumes a parked taster against its remaining attempts, not a fresh set', async () => {
    // First run: one attempt, then the vision gate goes down mid-job.
    let ocrDown = true;
    const h = await setupFree({
      description: TASTER_DESCRIPTION,
      ocr: () => (ocrDown ? { status: 'unavailable', error: 'ai binding 500' } : verdict(false)),
    });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'parked' });
    assert.equal(h.generated, 1);
    assert.equal(await usage(h), 1, 'work had already started, so the allowance is spent');

    // The cron unparks and re-enqueues; the gate is back.
    ocrDown = false;
    await h.jobs.unpark(h.jobKey);
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'delivered' });
    assert.equal(h.generated, 1 + MAX_REGENS_PER_SLOT, 'the first attempt still counted');
    assert.equal(await usage(h), 1, 'and the resume does not re-charge the allowance');
  });

  it('delivers nothing when the vendor refuses every attempt', async () => {
    const h = await setupFree({
      description: TASTER_DESCRIPTION,
      generate: () => ({ ok: false, retryable: false, error: 'prompt rejected' }),
    });
    assert.deepEqual(await runSingleStage(h.config, h.message), { outcome: 'aborted' });
    assert.equal(h.deliveries.length, 0);
    assert.match(h.messages[0]!, /nothing for you to cancel/);
    assert.equal(/escrow/i.test(h.messages[0]!), false);
  });
});

describe('processJobMessage — the free stage is routed, not refused', () => {
  it('routes a single message into the free-gig stage', async () => {
    const h = await setupFree();
    await processJobMessage(h.config, h.message);
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.deliveries[0]!.milestoneId, 'm1');
  });
});

// ---------------------------------------------------------------------------
// FR-18 — the warranty revision round
// ---------------------------------------------------------------------------

describe('the warranty revision round (FR-18)', () => {
  const AXES: StyleAxis[] = [
    { id: 'wordmark', label: 'wordmark', prompt: 'p1', vendor: 'ideogram' },
    { id: 'lockup', label: 'lockup', prompt: 'p2', vendor: 'ideogram' },
    { id: 'emblem', label: 'emblem', prompt: 'p3', vendor: 'recraft' },
  ];

  /**
   * A paid concept-stage harness whose quota store EXPLODES if anything writes
   * to it. The FR-18 requirement "does not consume the buyer's free-gig quota"
   * is a claim about the paid pipeline, and the only way to prove a call never
   * happens is to make it fail loudly if it does.
   */
  async function setupPaid(contractKey: string): Promise<{
    config: PipelineConfig;
    jobKey: string;
    jobs: JobStore;
    quota: QuotaStore;
    generated: () => number;
    db: D1Like;
  }> {
    const db = createMemoryD1();
    await applyMigrations(db);
    return withDb(db, contractKey);
  }

  async function withDb(
    db: D1Like,
    contractKey: string,
  ): Promise<{
    config: PipelineConfig;
    jobKey: string;
    jobs: JobStore;
    quota: QuotaStore;
    generated: () => number;
    db: D1Like;
  }> {
    const jobs = createJobStore(db);
    const realQuota = createQuotaStore(db);
    const quota: QuotaStore = {
      countRecent: (payerId, days) => realQuota.countRecent(payerId, days),
      record: () => {
        throw new Error('the paid pipeline must never consume a free-gig allowance');
      },
    };
    const jobKey = await buildJobKey(contractKey, 'concepts');
    await jobs.claim(jobKey, CONTRACT_ID, 'concepts');

    let generated = 0;
    const marks = [fixtures['leftHalf']!, fixtures['topHalf']!, fixtures['checker']!];
    const config: PipelineConfig = {
      jobs,
      concepts: createConceptStore(db),
      selection: createSelectionStore(db),
      quota,
      client: {
        getContract: async (id: string) => ({
          id,
          gigId: 'gig-paid-1',
          payerId: PAYER_ID,
          milestones: [{ id: 'm1' }, { id: 'm2' }],
        }),
        getGig: async () => ({ id: 'gig-paid-1', description: TASTER_DESCRIPTION }),
        deliverMilestone: async () => undefined,
        sendMessage: async () => undefined,
      } as unknown as AgentClient,
      ai: { run: async () => ({}) },
      deliverables: memoryR2(),
      sources,
      secrets: {
        moderationApiKey: 'test',
        anthropicApiKey: 'test',
        ideogramApiKey: 'test',
        recraftApiKey: 'test',
        vectorizerToken: 'test',
        googleFontsApiKey: 'test',
      },
      fetchImpl: async () => {
        throw new Error('no test may reach the network');
      },
      publicBaseUrl: 'https://logosmith.example.com',
      logger,
      services: {
        generator: {
          async generate(axis) {
            generated += 1;
            return {
              ok: true,
              costUsd: IMAGE_COST_USD.ideogram,
              concept: {
                axisId: axis.id,
                vendor: axis.vendor,
                vendorRequestId: `req-${axis.id}`,
                png: marks[AXES.findIndex((a) => a.id === axis.id)]!,
              },
            };
          },
        },
        ocrGate: { check: async () => verdict(true) },
        moderation: clearModeration,
        axisCompiler: { compile: async () => AXES.map((a) => ({ ...a })) },
      },
    };
    return { config, jobKey, jobs, quota, generated: () => generated, db };
  }

  it('re-runs generation under a fresh FR-5 cap and consumes no free-gig allowance', async () => {
    const first = await setupPaid(CONTRACT_ID);
    await runConceptStage(first.config, {
      contractId: CONTRACT_ID,
      jobKey: first.jobKey,
      stage: 'concepts',
    });
    const firstJob = (await first.jobs.get(first.jobKey))!;
    // Precondition: the original round really did spend, so "fresh" below is a
    // statement about a budget that had something to inherit.
    assert.equal(firstJob.outcome, 'delivered');
    assert.ok(firstJob.checkpoint!.spendUsd > 0, 'the original round must have spent something');

    // The warranty re-run is a NEW claim against the same contract — a fresh
    // job row, so a fresh checkpoint, so the FR-5 caps restart at full rather
    // than resuming a budget the buyer already exhausted (FR-18: "under a fresh
    // FR-5-sized cap, free").
    const revision = await withDb(first.db, `${CONTRACT_ID}#revision-1`);
    assert.notEqual(revision.jobKey, first.jobKey);
    const revisionRow = (await revision.jobs.get(revision.jobKey))!;
    assert.equal(revisionRow.checkpoint, null);
    assert.equal(revisionRow.spentUsd, 0, 'the re-run starts from a fresh cap');

    await runConceptStage(revision.config, {
      contractId: CONTRACT_ID,
      jobKey: revision.jobKey,
      stage: 'concepts',
    });
    const revisionJob = (await revision.jobs.get(revision.jobKey))!;
    assert.equal(revisionJob.outcome, 'delivered');
    assert.equal(
      revisionJob.checkpoint!.spendUsd,
      firstJob.checkpoint!.spendUsd,
      'the re-run got the same full budget the original had',
    );
    assert.equal(revision.generated(), 3, 'and generated a full fresh set');

    // The whole point: a free warranty re-run is free to the BUYER without
    // being charged against the free-gig funnel's abuse guard. The throwing
    // `record` above proves nothing wrote; this proves nothing was counted.
    assert.equal(await revision.quota.countRecent(PAYER_ID, FREE_GIG_WINDOW_DAYS), 0);
  });
});
