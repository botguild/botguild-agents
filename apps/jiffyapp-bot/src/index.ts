// ---------------------------------------------------------------------------
// JiffyApp Worker entry — the only module that touches Workers bindings.
//
//   fetch:     app.route('/botguild', shim) → POST /botguild/webhook (HMAC
//              verify → handlers), GET /botguild/health
//              GET  /health (root alias, same JSON as the shim's health)
//              GET  /deliverables/:token/:file (streams report/zip/screenshot from R2)
//              GET  /abuse + POST /abuse (report-a-tool form)
//              POST /admin/register (protected; runs registration once at deploy)
//   queue:     jiffyapp-jobs consumer — stub in this task (Tasks 17/18 wire the
//              build pipeline) + DLQ alerting, which IS wired now.
//   scheduled: registration backstop + sweep stub (Tasks 20/21 wire the sweeps).
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Logger } from 'pino';
import {
  AgentClient,
  AgentMcpClient,
  createCostEstimator,
  createProposer,
  type CostEstimator,
  type Proposer,
} from '@botguild/agent-core';
import {
  createConsoleLogger,
  createD1NegotiationStore,
  createD1WebhookSecretStore,
  createKVSeenStore,
  createWorkersWebhookApp,
  ensureRegisteredWorkers,
  withOwnershipFilter,
  type D1NegotiationStore,
  type D1WebhookSecretStore,
  type SeenStore,
} from '@botguild/agent-core-workers';
import { SERVICE, botProfile, fallbackEstimate, rateCard } from './config.js';
import {
  createAuditStore,
  createBuildLogStore,
  createCycleStore,
  createEditRequestStore,
  createJobStore,
  createRelayStore,
  createToolStore,
  createUsageStore,
  dlqDepth,
  loadReputationSnapshot,
  recordAbuse,
  recordDlqEvent,
  type AuditStore,
  type BuildLogStore,
  type CycleStore,
  type EditRequestStore,
  type JobStore,
  type RelayStore,
  type ToolStore,
  type UsageStore,
} from './jobs.js';
import { createGigStore, type GigStore } from './gigStore.js';
import { createGoldenCompiler, type GoldenCompiler } from './goldenCompiler.js';
import { createJiffyProposer, pricingCalcWithClassifier } from './proposer.js';
import { buildHandlers } from './handlers.js';
import type { JobMessage } from './types.js';

// @cloudflare/workers-types (pinned in package.json) already declares `SendEmail`
// as a global ambient type, so no local fallback interface is needed here.

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  DELIVERABLES: R2Bucket;
  JOBS: Queue<JobMessage>;
  AI: Ai;
  BROWSER: Fetcher;
  DISPATCH: DispatchNamespace;
  SEND_EMAIL: SendEmail;
  // wrangler.jsonc vars
  WEBHOOK_BASE_URL: string;
  TOOL_HOST_SUFFIX: string;
  CF_ACCOUNT_ID: string;
  DISPATCH_NAMESPACE: string;
  RELAY_FROM_ADDRESS: string;
  // wrangler secrets (.dev.vars locally)
  BOTGUILD_API_URL: string;
  BOTGUILD_API_KEY: string;
  BOTGUILD_BOT_ID: string;
  ANTHROPIC_API_KEY: string;
  MODERATION_API_KEY: string;
  CF_API_TOKEN: string;
  PSI_API_KEY: string;
  /** Protects POST /admin/register. Unset ⇒ the route is disabled. */
  ADMIN_TOKEN?: string;
}

const DAILY_CRON = '0 6 * * *'; // the */15 sweep is the default branch
/** Best-effort per-IP advisory window for the public abuse-report form. */
const ABUSE_RATE_LIMIT_SECONDS = 60;

interface Services {
  logger: Logger;
  client: AgentClient;
  mcpClient: AgentMcpClient;
  secretStore: D1WebhookSecretStore;
  jobs: JobStore;
  tools: ToolStore;
  cycles: CycleStore;
  usage: UsageStore;
  editRequests: EditRequestStore;
  relay: RelayStore;
  buildLog: BuildLogStore;
  audit: AuditStore;
  gigs: GigStore;
  goldenCompiler: GoldenCompiler;
  costEstimator: CostEstimator;
  proposer: Proposer;
  jiffyProposer: ReturnType<typeof createJiffyProposer>;
  seen: SeenStore;
  negotiationStore: D1NegotiationStore;
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
  const tools = createToolStore(env.DB);
  const cycles = createCycleStore(env.DB);
  const usage = createUsageStore(env.DB);
  const editRequests = createEditRequestStore(env.DB);
  const relay = createRelayStore(env.DB);
  const buildLog = createBuildLogStore(env.DB);
  const audit = createAuditStore(env.DB);
  const gigs = createGigStore(env.DB);

  const goldenCompiler = createGoldenCompiler({ apiKey: env.ANTHROPIC_API_KEY, logger });

  const costEstimator = createCostEstimator({
    apiKey: env.ANTHROPIC_API_KEY,
    botName: botProfile.name,
    botDescription: botProfile.bio,
    rateCard,
    fallbackEstimate,
    logger,
  });
  const proposer = createProposer({
    apiKey: env.ANTHROPIC_API_KEY,
    botProfile: {
      name: botProfile.name,
      category: botProfile.category,
      capabilities: botProfile.toolchain,
      workingStyle: botProfile.workingStyle,
      warrantyTerms: botProfile.warrantyTerms,
    },
    pricingCalc: pricingCalcWithClassifier,
    costEstimator,
    logger,
  });
  const jiffyProposer = createJiffyProposer({
    base: proposer,
    compiler: goldenCompiler,
    gigs,
    logger,
  });

  const seen = createKVSeenStore(env.CACHE);
  const negotiationStore = createD1NegotiationStore(env.DB);

  const publicBaseUrl = env.WEBHOOK_BASE_URL.replace(/\/$/, '');
  const app = buildApp(env, {
    logger,
    client,
    mcpClient,
    secretStore,
    jobs,
    tools,
    cycles,
    gigs,
    botId,
    publicBaseUrl,
  });

  services = {
    logger,
    client,
    mcpClient,
    secretStore,
    jobs,
    tools,
    cycles,
    usage,
    editRequests,
    relay,
    buildLog,
    audit,
    gigs,
    goldenCompiler,
    costEstimator,
    proposer,
    jiffyProposer,
    seen,
    negotiationStore,
    app,
  };
  return services;
}

// --- fetch ------------------------------------------------------------------

const DELIVERABLE_TOKEN_RE = /^[0-9a-f]{64}$/;
// Live report/source/PSI files, plus staging-round screenshots
// (`stg-r<N>-shot-<n>.png`) and live post-promotion screenshots (`shot-<n>.png`).
const DELIVERABLE_FILE_RE = /^(report\.json|source\.zip|psi\.json|(?:stg-r\d+-)?shot-\d+\.png)$/;
const DELIVERABLE_CONTENT_TYPES: Record<string, string> = {
  json: 'application/json',
  zip: 'application/zip',
  png: 'image/png',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function abuseFormHtml(slug: string): string {
  const safeSlug = escapeHtml(slug);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Report a tool — JiffyApp</title></head>
<body>
<h1>Report a tool</h1>
<form method="post" action="/abuse">
  <label>Tool slug<br><input type="text" name="slug" value="${safeSlug}" required></label><br><br>
  <label>What's wrong?<br><textarea name="detail" rows="5" cols="48"></textarea></label><br><br>
  <button type="submit">Submit report</button>
</form>
</body>
</html>`;
}

function abuseThanksHtml(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Report received — JiffyApp</title></head>
<body>
<h1>Thanks — your report was received.</h1>
<p>A human operator reviews every report.</p>
</body>
</html>`;
}

function buildApp(
  env: Env,
  deps: {
    logger: Logger;
    client: AgentClient;
    mcpClient: AgentMcpClient;
    secretStore: D1WebhookSecretStore;
    jobs: JobStore;
    tools: ToolStore;
    cycles: CycleStore;
    gigs: GigStore;
    botId: string;
    publicBaseUrl: string;
  },
): Hono {
  const {
    logger,
    client,
    mcpClient,
    secretStore,
    jobs,
    tools,
    cycles,
    gigs,
    botId,
    publicBaseUrl,
  } = deps;

  const rawHandlers = buildHandlers({
    client,
    mcp: mcpClient,
    gigs,
    jobs,
    cycles,
    tools,
    queue: env.JOBS,
    botId,
    publicBaseUrl,
    logger,
  });
  const ownership = { client, botId, logger };
  // Every handler except milestone.funded is ownership-filtered here: webhooks
  // are handler-scoped, so sibling bots' contract events WILL arrive at this
  // endpoint. milestone.funded self-filters inline (it needs the contract
  // anyway to classify the gig), so wrapping it too would just duplicate the
  // getContract call.
  const handlers = Object.fromEntries(
    Object.entries(rawHandlers).map(([eventType, handler]) =>
      eventType === 'milestone.funded'
        ? [eventType, handler]
        : [eventType, withOwnershipFilter(handler, ownership)],
    ),
  );

  const healthExtra = async (): Promise<Record<string, unknown>> => {
    const reputation = await loadReputationSnapshot(env.DB).catch(() => null);
    const toolCounts = await tools.countByStatus();
    const dlq = await dlqDepth(env.DB);
    return { ...(reputation ? { reputation } : {}), tools: toolCounts, dlqDepth: dlq };
  };

  const shim = createWorkersWebhookApp({
    // Resolved from D1 on every delivery by design: the platform issues the
    // secret at runtime and a fresh registration must take effect without an
    // isolate restart. Empty/missing secret ⇒ 503 and the platform retries.
    secret: async () => (await secretStore.loadWebhookSecret())?.secret ?? '',
    botId,
    logger,
    handlers,
    healthExtra,
  });

  const app = new Hono();
  // Mounts the shim's POST /webhook + GET /health at /botguild/* (platform URL
  // is `<WEBHOOK_BASE_URL>/botguild/webhook`; see ensureRegisteredWorkers below).
  app.route('/botguild', shim);

  // Root alias returning the exact same JSON the shim serves at /botguild/health.
  app.get('/health', async (c) => {
    const extra = await healthExtra().catch(() => ({}));
    return c.json({ ...extra, status: 'ok', botId });
  });

  // Deliverables are served ONLY through this route (never r2.dev): the path
  // segment is the per-job unguessable capability token (a random 64-hex
  // secret stored on the job row, NOT the recomputable sha256(contractId) job
  // key), and file names are whitelisted, so the R2 namespace is neither
  // enumerable nor derivable from a known contract id.
  app.get('/deliverables/:token/:file', async (c) => {
    const token = c.req.param('token');
    const file = c.req.param('file');
    if (!DELIVERABLE_TOKEN_RE.test(token) || !DELIVERABLE_FILE_RE.test(file)) {
      return c.json({ error: 'Not found' }, 404);
    }
    const object = await env.DELIVERABLES.get(`${token}/${file}`);
    if (!object) return c.json({ error: 'Not found' }, 404);

    const ext = file.slice(file.lastIndexOf('.') + 1);
    const headers: Record<string, string> = {
      'Content-Type': DELIVERABLE_CONTENT_TYPES[ext] ?? 'application/octet-stream',
    };
    if (file === 'source.zip') {
      headers['Content-Disposition'] = 'attachment; filename="source.zip"';
    }
    return new Response(object.body as ReadableStream, { headers });
  });

  // Report-a-tool form (public, no auth — abuse reports are inherently
  // anonymous). Best-effort per-IP advisory rate limit: skipped entirely when
  // the platform doesn't hand us cf-connecting-ip (local dev), and a KV
  // read/write failure never blocks a legitimate report from being recorded.
  app.get('/abuse', (c) => {
    const slug = c.req.query('slug') ?? '';
    return c.html(abuseFormHtml(slug));
  });

  app.post('/abuse', async (c) => {
    const form = await c.req.parseBody();
    const slug = typeof form.slug === 'string' ? form.slug.trim() : '';
    const detail = typeof form.detail === 'string' ? form.detail.trim() : '';
    if (!slug) return c.html(abuseFormHtml(''), 400);

    let rateLimited = false;
    const ip = c.req.header('cf-connecting-ip');
    if (ip) {
      const key = `abuse-rl:${ip}`;
      try {
        const recent = await env.CACHE.get(key);
        if (recent) {
          rateLimited = true;
        } else {
          await env.CACHE.put(key, '1', { expirationTtl: ABUSE_RATE_LIMIT_SECONDS });
        }
      } catch (err) {
        logger.warn({ err }, 'abuse rate-limit KV check failed; recording the report anyway');
      }
    }

    if (!rateLimited) {
      await recordAbuse(env.DB, slug, detail);
    }
    return c.html(abuseThanksHtml());
  });

  // Registration runs from an explicit trigger: this admin route once at
  // deploy, with a first-run branch of the cron sweep as backstop. A failed
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

  if (controller.cron === DAILY_CRON) {
    s.logger.info({ cron: controller.cron }, 'sweeps not yet wired (Task 20/21)');
    return;
  }

  // Any other trigger (the */15 cron, or a `wrangler dev --test-scheduled`
  // invocation with no cron) runs the first-run registration backstop ahead of
  // the sweep: if registration never ran (no stored secret), run it now, and
  // let a failure throw — a bot that cannot verify webhooks must not look healthy.
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
  s.logger.info({ cron: controller.cron }, 'sweeps not yet wired (Task 20/21)');
}

async function queue(
  batch: MessageBatch<JobMessage>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const s = getServices(env);

  // DLQ consumer: messages here exhausted their retries. They do NOT
  // auto-replay — the operator re-enqueues them to jiffyapp-jobs, where the
  // idempotency claim + checkpoints make replay safe.
  if (batch.queue.endsWith('-dlq')) {
    for (const message of batch.messages) {
      await recordDlqEvent(env.DB, batch.queue, message.body);
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

  // The build pipeline consumer isn't wired yet (Tasks 17/18). Ack rather than
  // retry — the job stays `claimed` in D1 with no checkpoint, so once the
  // pipeline lands, the next milestone.funded redelivery (or a cron re-enqueue)
  // safely re-sends it; retrying here would just loop until it dead-lettered
  // anyway, with no consumer ever having run.
  for (const message of batch.messages) {
    s.logger.warn(
      { queue: batch.queue, body: message.body, messageId: message.id },
      'pipeline not yet wired (Task 17/18); acking without processing',
    );
    message.ack();
  }
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> =>
    getServices(env).app.fetch(request, env, ctx),
  scheduled,
  queue,
};
