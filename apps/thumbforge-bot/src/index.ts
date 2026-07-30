// ---------------------------------------------------------------------------
// ThumbForge Worker entry — the ONLY module that touches Workers bindings.
//
//   fetch:     POST /botguild/webhook (shim: HMAC verify → ownership-filtered handlers)
//              POST /hooks/:offerId    (per-offer CMS HMAC + replay window → sync OG)
//              GET  /a/:key            (serve deliverables from R2 — never r2.dev)
//              GET  /health            (+ D1-cached reputation)
//              POST /admin/register    (protected; runs registration once at deploy)
//   queue:     RENDER_QUEUE consumer (plan fan-out → render → gates → R2 → probe →
//              deliverMilestone) + DLQ alerting.
//   scheduled: dispatch by cron — */10 poll/negotiation/reputation; daily rollover +
//              stuck-claim; monthly recurring re-post.
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Logger } from 'pino';
import {
  AgentClient,
  AgentMcpClient,
  createCostEstimator,
  createProposer,
} from '@botguild/agent-core';
import type { Proposer } from '@botguild/agent-core';
import {
  createConsoleLogger,
  createD1NegotiationStore,
  createD1WebhookSecretStore,
  createKVSeenStore,
  createWorkersWebhookApp,
  ensureRegisteredWorkers,
  withOwnershipFilter,
  type D1WebhookSecretStore,
} from '@botguild/agent-core-workers';
import { SERVICE, botProfile, fallbackEstimate, pricingCalc, rateCard } from './config.js';
import {
  createAuditStore,
  createIdempotencyStore,
  createOfferStore,
  createOutputStore,
  createRenderJobStore,
  createUsageStore,
  loadReputationSnapshot,
  type OfferStore,
  type RenderJobStore,
} from './jobs.js';
import { createModerator } from './moderation.js';
import { createYouTubeClient } from './youtube.js';
import { createWebhookHandlers } from './handlers.js';
import {
  processRenderMessage,
  type DeliverableStorage,
  type PipelineConfig,
  type RenderContext,
  type RenderMessage,
  type UrlProbe,
} from './pipeline.js';
import { handleOgPublish, type OgPublishConfig } from './ogSync.js';
import { runDailySweep, runMonthlySweep, runPollSweep, type SweepServices } from './sweeps.js';
import { workerFonts, workerWasmSources } from './renderAssets.js';

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS: R2Bucket;
  RENDER_QUEUE: Queue<RenderMessage>;
  PROBE: Fetcher;
  // wrangler.jsonc vars
  WEBHOOK_BASE_URL: string;
  // wrangler secrets (.dev.vars locally)
  BOTGUILD_API_URL: string;
  BOTGUILD_API_KEY: string;
  BOTGUILD_BOT_ID: string;
  ANTHROPIC_API_KEY: string;
  YOUTUBE_API_KEY: string;
  /** Protects POST /admin/register. Unset ⇒ the route is disabled. */
  ADMIN_TOKEN?: string;
}

// The */10 poll cron is the default branch; the daily/monthly crons dispatch by
// exact expression.
const DAILY_CRON = '0 4 * * *';
const MONTHLY_CRON = '0 3 1 * *';

interface Services {
  logger: Logger;
  client: AgentClient;
  secretStore: D1WebhookSecretStore;
  pipeline: PipelineConfig;
  og: OgPublishConfig;
  sweeps: SweepServices;
  app: Hono;
}

// One service graph per isolate — env bindings are stable for its lifetime.
let services: Services | undefined;

function getServices(env: Env): Services {
  if (services) return services;

  const botId = env.BOTGUILD_BOT_ID;
  const logger = createConsoleLogger({ service: SERVICE, botId });
  const client = new AgentClient({
    apiUrl: env.BOTGUILD_API_URL,
    apiKey: env.BOTGUILD_API_KEY,
    botId,
    logger,
  });
  const mcpClient = new AgentMcpClient({
    apiUrl: env.BOTGUILD_API_URL,
    apiKey: env.BOTGUILD_API_KEY,
    logger,
  });
  const secretStore = createD1WebhookSecretStore(env.DB);

  const renderJobs = createRenderJobStore(env.DB);
  const outputs = createOutputStore(env.DB);
  const offers = createOfferStore(env.DB);
  const idempotency = createIdempotencyStore(env.DB);
  const usage = createUsageStore(env.DB);
  const audit = createAuditStore(env.DB);

  const moderator = createModerator({ apiKey: env.ANTHROPIC_API_KEY, logger });
  const youtube = createYouTubeClient({ apiKey: env.YOUTUBE_API_KEY });

  const costEstimator = createCostEstimator({
    apiKey: env.ANTHROPIC_API_KEY,
    botName: botProfile.name,
    botDescription: botProfile.bio,
    rateCard,
    fallbackEstimate,
    logger,
  });
  const proposer: Proposer = createProposer({
    apiKey: env.ANTHROPIC_API_KEY,
    botProfile: {
      name: botProfile.name,
      category: botProfile.category,
      capabilities: botProfile.toolchain,
      workingStyle: botProfile.workingStyle,
      warrantyTerms: botProfile.warrantyTerms,
    },
    pricingCalc,
    costEstimator,
    logger,
  });

  const publicBaseUrl = env.WEBHOOK_BASE_URL.replace(/\/$/, '');
  const render: RenderContext = { fonts: workerFonts(), wasm: workerWasmSources() };

  const storage: DeliverableStorage = {
    async put(key, bytes, contentType): Promise<void> {
      await env.ASSETS.put(key, bytes, { httpMetadata: { contentType } });
    },
    async getBytes(key): Promise<Uint8Array | null> {
      const object = await env.ASSETS.get(key);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
  };

  const probe: UrlProbe = {
    async probe(url): Promise<{ status: number; byteLength: number; ok: boolean }> {
      // Invoke the probe Worker on its own hostname via the service binding —
      // the bot never fetches its own zone (err-1042 self-routing, §9).
      const response = await env.PROBE.fetch('https://thumbforge-probe.internal/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        status?: number;
        byteLength?: number;
        ok?: boolean;
        error?: string;
      };
      return {
        status: data.status ?? response.status,
        byteLength: data.byteLength ?? 0,
        ok: data.error === undefined && data.ok === true,
      };
    },
  };

  const pipeline: PipelineConfig = {
    renderJobs,
    outputs,
    audit,
    client,
    render,
    storage,
    probe,
    moderator,
    queue: env.RENDER_QUEUE,
    resolveHeadline: async (videoId) => (await youtube.fetchVideo(videoId))?.title ?? null,
    publicBaseUrl,
    logger,
  };

  const og: OgPublishConfig = {
    offers,
    idempotency,
    usage,
    audit,
    moderator,
    render,
    storage,
    probe,
    publicBaseUrl,
    logger,
  };

  const sweeps: SweepServices = {
    db: env.DB,
    client,
    renderJobs,
    offers,
    usage,
    idempotency,
    audit,
    seen: createKVSeenStore(env.CACHE),
    negotiationStore: createD1NegotiationStore(env.DB),
    reputationSource: mcpClient,
    proposer,
    costEstimator,
    queue: env.RENDER_QUEUE,
    logger,
  };

  const app = buildApp(env, {
    logger,
    client,
    secretStore,
    renderJobs,
    offers,
    publicBaseUrl,
    botId,
    og,
  });

  services = { logger, client, secretStore, pipeline, og, sweeps, app };
  return services;
}

// --- fetch ------------------------------------------------------------------

function buildApp(
  env: Env,
  deps: {
    logger: Logger;
    client: AgentClient;
    secretStore: D1WebhookSecretStore;
    renderJobs: RenderJobStore;
    offers: OfferStore;
    publicBaseUrl: string;
    botId: string;
    og: OgPublishConfig;
  },
): Hono {
  const { logger, client, secretStore, renderJobs, offers, publicBaseUrl, botId, og } = deps;

  const rawHandlers = createWebhookHandlers({
    client,
    renderJobs,
    offers,
    queue: env.RENDER_QUEUE,
    publicBaseUrl,
    logger,
  });
  const ownership = { client, botId, logger };
  // Contract-scoped handlers are ownership-filtered: sibling bots' events WILL
  // arrive here (handler-scoped webhooks, §10).
  const handlers = Object.fromEntries(
    Object.entries(rawHandlers).map(([event, handler]) => [
      event,
      withOwnershipFilter(handler, ownership),
    ]),
  );

  const shim = createWorkersWebhookApp({
    // Resolved from D1 on every delivery: the platform issues the secret at
    // runtime and a fresh registration must take effect without an isolate
    // restart. Empty/missing ⇒ 503 and the platform retries.
    secret: async () => (await secretStore.loadWebhookSecret())?.secret ?? '',
    botId,
    logger,
    handlers,
    healthExtra: async () => {
      const reputation = await loadReputationSnapshot(env.DB).catch(() => null);
      return reputation ? { reputation } : {};
    },
  });

  const app = new Hono();
  // Mount the shim's POST /webhook + GET /health under /botguild (§7).
  app.route('/botguild', shim);

  // Per-offer CMS publish webhook (FR-2/3/14/15). The raw body is the exact
  // bytes the HMAC was computed over.
  app.post('/hooks/:offerId', async (c) => {
    const offerId = c.req.param('offerId');
    const rawBody = await c.req.text();
    const signature = c.req.header('X-ThumbForge-Signature') ?? null;
    const result = await handleOgPublish(og, offerId, rawBody, signature);
    if (result.after) c.executionCtx.waitUntil(result.after());
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  // Deliverables are served ONLY through this route on the custom domain (never
  // r2.dev, FR-9/FR-11). The key contains a slash (og/<hash>.png or
  // <jobKey>/<graphicId>.png), so match a wildcard param.
  app.get('/a/:key{.+}', async (c) => {
    const key = c.req.param('key');
    const object = await env.ASSETS.get(key);
    if (!object) return c.json({ error: 'Not found' }, 404);
    return new Response(object.body as ReadableStream, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  });

  app.get('/health', async (c) => {
    const reputation = await loadReputationSnapshot(env.DB).catch(() => null);
    return c.json({ status: 'ok', service: SERVICE, botId, ...(reputation ? { reputation } : {}) });
  });

  // Registration runs from an explicit trigger (§10.2): this admin route once at
  // deploy, with a first-run cron branch as backstop. A failed secret persist
  // throws loudly — surfaced as a 500, never swallowed.
  app.post('/admin/register', async (c) => {
    if (!env.ADMIN_TOKEN) return c.json({ error: 'ADMIN_TOKEN is not configured' }, 503);
    const auth = c.req.header('Authorization') ?? '';
    if (auth !== `Bearer ${env.ADMIN_TOKEN}`) return c.json({ error: 'Unauthorized' }, 401);
    const result = await ensureRegisteredWorkers({
      client,
      registration: {
        apiUrl: env.BOTGUILD_API_URL,
        apiKey: env.BOTGUILD_API_KEY,
        botConfig: botProfile,
        logger,
      },
      webhookBaseUrl: `${publicBaseUrl}/botguild`,
      secretStore,
      logger,
    });
    return c.json(result);
  });

  return app;
}

// --- scheduled / queue ------------------------------------------------------

async function scheduled(
  controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const s = getServices(env);
  s.logger.info({ cron: controller.cron }, 'cron sweep starting');

  if (controller.cron === MONTHLY_CRON) {
    await runMonthlySweep(s.sweeps);
    return;
  }
  if (controller.cron === DAILY_CRON) {
    await runDailySweep(s.sweeps);
    return;
  }

  // The */10 poll cron (or a `wrangler dev --test-scheduled` invocation): run
  // the first-run registration backstop (§10.2) ahead of the poll sweep. A
  // failure throws — a bot that cannot verify webhooks must not look healthy.
  if ((await s.secretStore.loadWebhookSecret()) === null) {
    s.logger.warn('no stored webhook secret — running first-run registration from cron backstop');
    await ensureRegisteredWorkers({
      client: s.client,
      registration: {
        apiUrl: env.BOTGUILD_API_URL,
        apiKey: env.BOTGUILD_API_KEY,
        botConfig: botProfile,
        logger: s.logger,
      },
      webhookBaseUrl: `${env.WEBHOOK_BASE_URL.replace(/\/$/, '')}/botguild`,
      secretStore: s.secretStore,
      logger: s.logger,
    });
  }
  await runPollSweep(s.sweeps);
}

async function queue(
  batch: MessageBatch<RenderMessage>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const s = getServices(env);

  // DLQ consumer: messages here exhausted their retries. They do NOT auto-replay
  // — the operator re-enqueues to render-queue, where the idempotency claim +
  // per-graphic outputs make replay safe (§12 runbook).
  if (batch.queue.endsWith('-dlq')) {
    for (const message of batch.messages) {
      s.logger.error(
        {
          queue: batch.queue,
          body: message.body,
          messageId: message.id,
          attempts: message.attempts,
        },
        'DEAD-LETTERED RENDER MESSAGE — operator action required (see README runbook)',
      );
      message.ack();
    }
    return;
  }

  for (const message of batch.messages) {
    try {
      await processRenderMessage(s.pipeline, message.body);
      message.ack();
    } catch (err) {
      s.logger.error(
        { err, body: message.body, attempts: message.attempts },
        'render pipeline failed with a transient error; retrying via queue',
      );
      message.retry();
    }
  }
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> =>
    getServices(env).app.fetch(request, env, ctx),
  scheduled,
  queue,
};
