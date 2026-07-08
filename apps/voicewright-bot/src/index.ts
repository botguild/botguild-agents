// ---------------------------------------------------------------------------
// VoiceWright Worker entry — the only module that touches Workers bindings.
//
//   fetch:     POST /webhook (shim app: HMAC verify → handlers)
//              GET  /health  (shim app + D1-cached reputation)
//              GET  /deliverables/:jobKey/:file (streams CSV/report from R2)
//              POST /admin/register (protected; runs registration once at deploy)
//   queue:     voicewright-jobs consumer (the async pipeline) + DLQ alerting
//   scheduled: dispatch by cron expression — 15-min sweep and daily sweep
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';
import {
  AgentClient,
  AgentMcpClient,
  createCostEstimator,
  createProposer,
  logContractReview,
} from '@botguild/agent-core';
import type { CostEstimator, Proposer } from '@botguild/agent-core';
import {
  createConsoleLogger,
  createD1NegotiationStore,
  createD1WebhookSecretStore,
  createKVSeenStore,
  createWorkersWebhookApp,
  ensureRegisteredWorkers,
  withOwnershipFilter,
  type D1WebhookSecretStore,
  type WebhookHandler,
} from '@botguild/agent-core-workers';
import type { Hono } from 'hono';
import { botProfile, fallbackEstimate, pricingCalc, rateCard } from './config.js';
import { createJobStore, loadReputationSnapshot, sha256Hex, type JobStore } from './jobs.js';
import { createBriefStore, type BriefStore } from './briefStore.js';
import { createModerationClient } from './gates/moderation.js';
import { createCopyGenerator } from './generate.js';
import { createThreadReader } from './threads.js';
import { processJobMessage, type PipelineConfig } from './pipeline.js';
import { runDailySweep, runFifteenMinuteSweep, type SweepServices } from './sweeps.js';
import type { JobMessage } from './types.js';

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  DELIVERABLES: R2Bucket;
  JOBS: Queue<JobMessage>;
  // wrangler.jsonc vars
  WEBHOOK_BASE_URL: string;
  SERP_ENABLED: string; // "false" in v1 — FR-3's degraded path is the default path
  // wrangler secrets (.dev.vars locally)
  BOTGUILD_API_URL: string;
  BOTGUILD_API_KEY: string;
  BOTGUILD_BOT_ID: string;
  ANTHROPIC_API_KEY: string;
  MODERATION_API_KEY: string;
  /** Protects POST /admin/register. Unset ⇒ the route is disabled. */
  ADMIN_TOKEN?: string;
}

const SERVICE = 'voicewright-bot';
const DAILY_CRON = '0 6 * * *'; // the */15 sweep is the default branch

interface Services {
  logger: Logger;
  client: AgentClient;
  secretStore: D1WebhookSecretStore;
  jobs: JobStore;
  briefs: BriefStore;
  proposer: Proposer;
  freeProposer: Proposer;
  costEstimator: CostEstimator;
  pipeline: PipelineConfig;
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
  const jobs = createJobStore(env.DB);
  const briefs = createBriefStore(env.DB);
  const moderation = createModerationClient({ apiKey: env.MODERATION_API_KEY });
  const generator = createCopyGenerator({ apiKey: env.ANTHROPIC_API_KEY, logger });

  const costEstimator = createCostEstimator({
    apiKey: env.ANTHROPIC_API_KEY,
    botName: botProfile.name,
    botDescription: botProfile.bio,
    rateCard,
    fallbackEstimate,
    logger,
  });
  const proposerProfile = {
    name: botProfile.name,
    category: botProfile.category,
    capabilities: botProfile.toolchain,
    workingStyle: botProfile.workingStyle,
    warrantyTerms: botProfile.warrantyTerms,
  };
  const proposer = createProposer({
    apiKey: env.ANTHROPIC_API_KEY,
    botProfile: proposerProfile,
    pricingCalc,
    costEstimator,
    logger,
  });
  // No estimator: the FREE readability gig must bid its $0 anchor, and the
  // estimator would floor the bid at 1.5× cost.
  const freeProposer = createProposer({
    apiKey: env.ANTHROPIC_API_KEY,
    botProfile: proposerProfile,
    pricingCalc,
    logger,
  });

  const publicBaseUrl = env.WEBHOOK_BASE_URL.replace(/\/$/, '');
  const pipeline: PipelineConfig = {
    jobs,
    briefs,
    client,
    moderation,
    generator,
    deliverables: {
      put: async (key, value, contentType) => {
        await env.DELIVERABLES.put(key, value, { httpMetadata: { contentType } });
      },
    },
    publicBaseUrl,
    logger,
  };

  const sweeps: SweepServices = {
    db: env.DB,
    client,
    jobs,
    briefs,
    seen: createKVSeenStore(env.CACHE),
    negotiationStore: createD1NegotiationStore(env.DB),
    reputationSource: mcpClient,
    proposer,
    freeProposer,
    costEstimator,
    threadReader: createThreadReader({
      apiUrl: env.BOTGUILD_API_URL,
      apiKey: env.BOTGUILD_API_KEY,
    }),
    queue: env.JOBS,
    botId,
    logger,
  };

  const app = buildApp(env, {
    logger,
    client,
    secretStore,
    jobs,
    botId,
  });

  services = {
    logger,
    client,
    secretStore,
    jobs,
    briefs,
    proposer,
    freeProposer,
    costEstimator,
    pipeline,
    sweeps,
    app,
  };
  return services;
}

// --- fetch ------------------------------------------------------------------

const DELIVERABLE_FILES: Record<string, string> = {
  'copy.csv': 'text/csv; charset=utf-8',
  'report.json': 'application/json',
};

function buildApp(
  env: Env,
  deps: {
    logger: Logger;
    client: AgentClient;
    secretStore: D1WebhookSecretStore;
    jobs: JobStore;
    botId: string;
  },
): Hono {
  const { logger, client, secretStore, jobs, botId } = deps;

  // Webhook flow (§6.2): HMAC verify (shim) → isOwnContract filter → D1 claim
  // (hash(contractId) — the payload has no milestoneId) → enqueue → 200 fast.
  const onMilestoneFunded: WebhookHandler = async (event) => {
    const { contractId } = event.payload as { contractId: string };
    const jobKey = await sha256Hex(contractId);
    const decision = await jobs.claim(jobKey, contractId);
    logger.info({ contractId, jobKey, ...decision }, 'milestone.funded claim decision');
    if (decision.action === 'enqueue') {
      await env.JOBS.send({ contractId, jobKey });
    }
  };

  const onProposalAccepted: WebhookHandler = async (event) => {
    const { contractId } = event.payload as { contractId: string };
    await client.sendMessage(
      contractId,
      'Proposal accepted — work begins as soon as escrow is funded.',
    );
  };

  const onMilestoneAccepted: WebhookHandler = async (event) => {
    const { contractId } = event.payload as { contractId: string };
    await logContractReview({ client, contractId, logger });
  };

  const logOnly =
    (eventType: string): WebhookHandler =>
    async (event) => {
      logger.info({ eventType, payload: event.payload }, 'lifecycle event received');
    };

  const ownership = { client, botId, logger };
  const app = createWorkersWebhookApp({
    // Resolved from D1 on every delivery by design: the platform issues the
    // secret at runtime and a fresh registration must take effect without an
    // isolate restart. Empty/missing secret ⇒ 503 and the platform retries.
    secret: async () => (await secretStore.loadWebhookSecret())?.secret ?? '',
    botId,
    logger,
    handlers: {
      // Contract-scoped handlers are ownership-filtered: webhooks are
      // handler-scoped and sibling bots' events WILL arrive here (FR-12).
      'milestone.funded': withOwnershipFilter(onMilestoneFunded, ownership),
      'proposal.accepted': withOwnershipFilter(onProposalAccepted, ownership),
      'milestone.accepted': withOwnershipFilter(onMilestoneAccepted, ownership),
      'milestone.delivered': logOnly('milestone.delivered'),
      'acceptance.auto_approved': logOnly('acceptance.auto_approved'),
      'contract.status.changed': logOnly('contract.status.changed'),
      'dispute.response_submitted': logOnly('dispute.response_submitted'),
    },
    healthExtra: async () => {
      const reputation = await loadReputationSnapshot(env.DB).catch(() => null);
      return reputation ? { reputation } : {};
    },
  });

  // Deliverables are served ONLY through this route (never r2.dev, FR-9). The
  // path segment is the per-job unguessable capability token (§12) — a random
  // 64-hex secret stored on the job row, NOT the recomputable sha256(contractId)
  // job key — and file names are whitelisted, so the R2 namespace is neither
  // enumerable nor derivable from a known contract id.
  app.get('/deliverables/:token/:file', async (c) => {
    const token = c.req.param('token');
    const file = c.req.param('file');
    const contentType = DELIVERABLE_FILES[file];
    if (!contentType || !/^[0-9a-f]{64}$/.test(token)) {
      return c.json({ error: 'Not found' }, 404);
    }
    const object = await env.DELIVERABLES.get(`${token}/${file}`);
    if (!object) return c.json({ error: 'Not found' }, 404);
    return new Response(object.body as ReadableStream, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="voicewright-${file}"`,
      },
    });
  });

  // Registration runs from an explicit trigger (§10.2): this admin route once
  // at deploy, with a first-run branch of the cron sweep as backstop. A failed
  // secret persist throws loudly — surfaced as a 500, never swallowed.
  app.post('/admin/register', async (c) => {
    if (!env.ADMIN_TOKEN) {
      return c.json({ error: 'ADMIN_TOKEN is not configured' }, 503);
    }
    const auth = c.req.header('Authorization') ?? '';
    if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const result = await ensureRegisteredWorkers({
      client,
      registration: {
        apiUrl: env.BOTGUILD_API_URL,
        apiKey: env.BOTGUILD_API_KEY,
        botConfig: botProfile,
        logger,
      },
      webhookBaseUrl: env.WEBHOOK_BASE_URL,
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

  if (controller.cron === DAILY_CRON) {
    await runDailySweep(s.sweeps);
    return;
  }

  // Any other trigger (the */15 cron, or a `wrangler dev --test-scheduled`
  // invocation with no cron) runs the 15-minute sweep, with the first-run
  // registration backstop (§10.2) ahead of it: if registration never ran (no
  // stored secret), run it before sweeping — and let a failure throw; a bot
  // that cannot verify webhooks must not look healthy.
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
      webhookBaseUrl: env.WEBHOOK_BASE_URL,
      secretStore: s.secretStore,
      logger: s.logger,
    });
  }
  await runFifteenMinuteSweep(s.sweeps);
}

async function queue(
  batch: MessageBatch<JobMessage>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const s = getServices(env);

  // DLQ consumer: messages here exhausted their retries. They do NOT
  // auto-replay — the operator re-enqueues them to voicewright-jobs, where
  // the idempotency claim + checkpoints make replay safe (§12 runbook).
  if (batch.queue.endsWith('-dlq')) {
    for (const message of batch.messages) {
      s.logger.error(
        {
          queue: batch.queue,
          body: message.body,
          messageId: message.id,
          attempts: message.attempts,
        },
        'DEAD-LETTERED JOB — operator action required (see README runbook)',
      );
      message.ack();
    }
    return;
  }

  // max_batch_size is pinned to 1, but iterate defensively. Transient errors
  // retry (≤3 then DLQ); parking/aborts are handled inside the pipeline and ack.
  for (const message of batch.messages) {
    try {
      await processJobMessage(s.pipeline, message.body);
      message.ack();
    } catch (err) {
      s.logger.error(
        {
          err,
          contractId: message.body.contractId,
          jobKey: message.body.jobKey,
          attempts: message.attempts,
        },
        'pipeline failed with a transient error; retrying via queue',
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
