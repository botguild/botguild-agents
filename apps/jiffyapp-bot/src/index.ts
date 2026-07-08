// ---------------------------------------------------------------------------
// JiffyApp Worker entry — the only module that touches Workers bindings.
//
//   fetch:     app.route('/botguild', shim) → POST /botguild/webhook (HMAC
//              verify → handlers), GET /botguild/health
//              GET  /health (root alias, same JSON as the shim's health)
//              GET  /deliverables/:token/:file (streams report/zip/screenshot from R2)
//              OPTIONS/POST /relay/:toolId (form-relay submission; CORS-gated, rate-capped)
//              GET  /relay/verify/:verifyToken (double opt-in confirmation link)
//              GET  /p/:token (public build-log page), /p/:token/events (SSE),
//                   /p/:token/log.json (poll-degrade fallback)
//              GET  /abuse + POST /abuse (report-a-tool form)
//              POST /admin/register (protected; runs registration once at deploy)
//   queue:     jiffyapp-jobs consumer — the full build pipeline (Tasks 17/18) + DLQ alerting.
//   scheduled: the daily cron runs runDailySweep; every other trigger runs a registration
//              backstop then runFifteenMinuteSweep (hosting expiry/grace/suspend, cycle reports,
//              relay re-sends, parked-job re-enqueue).
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import type { Logger } from 'pino';
import { EmailMessage } from 'cloudflare:email';
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
import { buildHandlers, wrapContractHandlers } from './handlers.js';
import { createCodegen } from './codegen.js';
import { createToolDeployer } from './deploy.js';
import { createPsiClient } from './psi.js';
import { createModerationClient } from './moderation.js';
import { createPlaywrightLauncher, createPlaywrightPageFactory } from './playwrightDriver.js';
import { processJobMessage, type PipelineConfig } from './pipeline.js';
import { processCycleJob } from './hosting.js';
import { runReferenceCheck } from './adminReference.js';
import { buildLogPageHtml, createLogEventStream, handleLogJson } from './buildlog.js';
import {
  buildRelayMime,
  createEmailRoutingClient,
  handleRelaySubmission,
  handleRelayVerification,
  relayCorsHeaders,
  type RelayDeps,
  type RelayMailer,
} from './relay.js';
import { createThreadReader } from './threads.js';
import { runDailySweep, runFifteenMinuteSweep, type SweepServices } from './sweeps.js';
import { TEMPLATE_IDS, type JobMessage, type TemplateId } from './types.js';

function isTemplateId(value: string): value is TemplateId {
  return (TEMPLATE_IDS as readonly string[]).includes(value);
}

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
  /** Second Cloudflare token, scoped to Email Routing destination addresses ONLY (Task 19). */
  CF_EMAIL_API_TOKEN: string;
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
  /** The full build/live-gate/deliver pipeline config for the queue consumer (Tasks 17/18). */
  pipeline: PipelineConfig;
  /** The cron sweep layer's services (Tasks 20/21/22). */
  sweeps: SweepServices;
  /** Shared deps for the public relay routes (Task 19) — same relay/usage/audit/mailer the
   *  pipeline uses, so live submissions and the build pipeline agree on one set of counters. */
  relayDeps: RelayDeps;
  /** Tears down the per-invocation Playwright browser after each queue message. */
  closeBrowser: () => Promise<void>;
  app: Hono;
}

/**
 * The real relay mailer (Task 19): builds a MIME message via mimetext and sends it through the
 * Cloudflare `send_email` binding. `cloudflare:email` is Worker-only, so this — and its
 * `EmailMessage` import — live here rather than in relay.ts, which stays Node-testable.
 */
function createBindingMailer(sendEmail: SendEmail, logger: Logger): RelayMailer {
  return {
    async send(msg): Promise<{ messageId: string | null }> {
      const { raw, messageId } = buildRelayMime(msg);
      try {
        await sendEmail.send(new EmailMessage(msg.from, msg.to, raw));
      } catch (err) {
        logger.warn({ err, to: msg.to }, 'mailer: send_email binding failed');
        throw err;
      }
      return { messageId };
    },
  };
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

  // --- Build/live-gate/deliver pipeline (Tasks 17/18) -----------------------
  const codegen = createCodegen({ ai: env.AI, anthropicApiKey: env.ANTHROPIC_API_KEY, logger });
  const deployer = createToolDeployer({
    accountId: env.CF_ACCOUNT_ID,
    namespace: env.DISPATCH_NAMESPACE,
    apiToken: env.CF_API_TOKEN,
    dispatch: env.DISPATCH,
    logger,
  });
  const pageFactory = createPlaywrightPageFactory(createPlaywrightLauncher(env.BROWSER));
  const psi = createPsiClient({ apiKey: env.PSI_API_KEY, logger });
  const moderation = createModerationClient({ apiKey: env.MODERATION_API_KEY });

  // The real Cloudflare Email Sending binding + Email Routing client (Task 19).
  const mailer: RelayMailer = createBindingMailer(env.SEND_EMAIL, logger);
  const emailRouting = createEmailRoutingClient({
    accountId: env.CF_ACCOUNT_ID,
    apiToken: env.CF_EMAIL_API_TOKEN,
    logger,
  });

  const deliverables = {
    put: async (key: string, value: string | Uint8Array, contentType: string): Promise<void> => {
      await env.DELIVERABLES.put(key, value, { httpMetadata: { contentType } });
    },
  };

  const pipeline: PipelineConfig = {
    jobs,
    tools,
    gigs,
    cycles,
    usage,
    edits: editRequests,
    relay,
    buildLog,
    audit,
    client,
    codegen,
    deployer,
    compiler: goldenCompiler,
    emailRouting,
    openPage: pageFactory.openPage,
    closeBrowser: pageFactory.closeAll,
    psi,
    moderation,
    mailer,
    deliverables,
    queue: env.JOBS,
    fetchImpl: globalThis.fetch,
    publicBaseUrl,
    toolHostSuffix: env.TOOL_HOST_SUFFIX,
    relayFromAddress: env.RELAY_FROM_ADDRESS,
    logger,
  };

  // Shared with the public relay routes (Task 19) — same stores as the pipeline, so a live form
  // submission and a build-time relay test agree on one set of rate counters and event history.
  const relayDeps: RelayDeps = {
    relay,
    usage,
    mailer,
    audit,
    fromAddress: env.RELAY_FROM_ADDRESS,
    logger,
  };

  // --- Cron sweep layer (Tasks 20/21/22) --------------------------------------
  const sweeps: SweepServices = {
    db: env.DB,
    client,
    jobs,
    tools,
    cycles,
    gigs,
    edits: editRequests,
    usage,
    relay,
    buildLog,
    audit,
    seen,
    negotiationStore,
    // AgentMcpClient satisfies ReputationSource (getMyReputation/getMyEarnings).
    reputationSource: mcpClient,
    proposer: jiffyProposer,
    costEstimator,
    threadReader: createThreadReader({
      apiUrl: env.BOTGUILD_API_URL,
      apiKey: env.BOTGUILD_API_KEY,
    }),
    queue: env.JOBS,
    emailRouting,
    fetchImpl: globalThis.fetch,
    botId,
    publicBaseUrl,
    toolHostSuffix: env.TOOL_HOST_SUFFIX,
    logger,
  };

  const app = buildApp(env, {
    logger,
    client,
    mcpClient,
    secretStore,
    jobs,
    tools,
    cycles,
    gigs,
    audit,
    botId,
    publicBaseUrl,
    relayDeps,
    buildLog,
    pipeline,
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
    pipeline,
    sweeps,
    relayDeps,
    closeBrowser: pageFactory.closeAll,
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
    audit: AuditStore;
    botId: string;
    publicBaseUrl: string;
    relayDeps: RelayDeps;
    buildLog: BuildLogStore;
    pipeline: PipelineConfig;
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
    audit,
    botId,
    publicBaseUrl,
    relayDeps,
    buildLog,
    pipeline,
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
  // Only the three contract-acting handlers are ownership-filtered: milestone.funded
  // self-filters inline (it needs the contract anyway), and log-only handlers must
  // pass through unwrapped to avoid pointless getContract calls and 500s on benign
  // sibling-bot events.
  const handlers = wrapContractHandlers(rawHandlers, (h) => withOwnershipFilter(h, ownership));

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

  // --- Form relay (Task 19; FR-8/FR-12) ---------------------------------------
  // The tool's own page is the cross-origin caller here (its origin is
  // `https://<slug>.<TOOL_HOST_SUFFIX>`, this route is on the bot origin), and its POST carries
  // `content-type: application/json`, so the browser preflights with OPTIONS. CORS headers are
  // attached to every POST response (including errors) so a rejected submission still resolves
  // client-side instead of failing as an opaque CORS error.
  app.options('/relay/:toolId', (c) => {
    const origin = c.req.header('origin') ?? null;
    return new Response(null, {
      status: 204,
      headers: relayCorsHeaders(origin, env.TOOL_HOST_SUFFIX),
    });
  });

  app.post('/relay/:toolId', async (c) => {
    const origin = c.req.header('origin') ?? null;
    const corsHeaders = relayCorsHeaders(origin, env.TOOL_HOST_SUFFIX);
    const toolId = c.req.param('toolId');
    const token = c.req.query('t') ?? c.req.header('x-relay-token') ?? null;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'invalid JSON body' }), {
        status: 400,
        headers: { 'content-type': 'application/json', ...corsHeaders },
      });
    }

    const result = await handleRelaySubmission(relayDeps, { toolId, token, body });
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json', ...corsHeaders },
    });
  });

  // Double opt-in confirmation link (FR-8): single-use — a second click 404s.
  app.get('/relay/verify/:verifyToken', async (c) => {
    const verifyToken = c.req.param('verifyToken');
    const result = await handleRelayVerification(relayDeps, verifyToken);
    return new Response(result.html, {
      status: result.status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  });

  // --- Public build-log page (Task 19; FR-11) ---------------------------------
  app.get('/p/:token', (c) => {
    const token = c.req.param('token');
    if (!DELIVERABLE_TOKEN_RE.test(token)) return c.json({ error: 'Not found' }, 404);
    return c.html(buildLogPageHtml(token));
  });

  app.get('/p/:token/events', (c) => {
    const token = c.req.param('token');
    if (!DELIVERABLE_TOKEN_RE.test(token)) return c.json({ error: 'Not found' }, 404);
    const lastEventIdHeader = c.req.header('last-event-id');
    const lastEventId = lastEventIdHeader ? Number(lastEventIdHeader) || 0 : 0;
    const stream = createLogEventStream({ store: buildLog, token, lastEventId });
    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  });

  app.get('/p/:token/log.json', async (c) => {
    const token = c.req.param('token');
    if (!DELIVERABLE_TOKEN_RE.test(token)) return c.json({ error: 'Not found' }, 404);
    const after = Number(c.req.query('after') ?? '0') || 0;
    const result = await handleLogJson(buildLog, token, after);
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
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

  // The three protected admin routes below share the same Bearer guard as /admin/register:
  // 503 when ADMIN_TOKEN is unset (route disabled), 401 on a missing/wrong token.

  // FR-17 kill switch: flip a tool to `killed` so the dispatcher serves 410 immediately (no
  // deploy action needed — the status read is the gate). Idempotent from the operator's view.
  app.post('/admin/suspend/:slug', async (c) => {
    if (!env.ADMIN_TOKEN) return c.json({ error: 'ADMIN_TOKEN is not configured' }, 503);
    if ((c.req.header('Authorization') ?? '') !== `Bearer ${env.ADMIN_TOKEN}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const slug = c.req.param('slug');
    const tool = await tools.getBySlug(slug);
    if (!tool) return c.json({ error: `unknown slug: ${slug}` }, 404);
    await tools.setStatus(tool.toolId, 'killed');
    await audit.record({
      scope: `tool:${tool.toolId}`,
      gate: 'kill-switch',
      result: 'killed',
      detail: { slug },
    });
    return c.json({ slug, toolId: tool.toolId, status: 'killed' });
  });

  // Reverse a kill switch — only from `killed` (a 409 otherwise, so this never resurrects a
  // suspended/grace tool and bypasses the hosting lifecycle).
  app.post('/admin/unsuspend/:slug', async (c) => {
    if (!env.ADMIN_TOKEN) return c.json({ error: 'ADMIN_TOKEN is not configured' }, 503);
    if ((c.req.header('Authorization') ?? '') !== `Bearer ${env.ADMIN_TOKEN}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const slug = c.req.param('slug');
    const tool = await tools.getBySlug(slug);
    if (!tool) return c.json({ error: `unknown slug: ${slug}` }, 404);
    if (tool.status !== 'killed') {
      return c.json({ error: `tool is ${tool.status}, not killed`, status: tool.status }, 409);
    }
    await tools.setStatus(tool.toolId, 'live');
    await audit.record({
      scope: `tool:${tool.toolId}`,
      gate: 'kill-switch',
      result: 'unsuspended',
      detail: { slug },
    });
    return c.json({ slug, toolId: tool.toolId, status: 'live' });
  });

  // Phase-2 calibration probe: run ONE template's live reference check (render → stage → goldens
  // → PSI → teardown) and return the full JSON. A thrown probe (e.g. a deploy failure) surfaces
  // as a 500 with the error message; the staging script is torn down either way.
  app.post('/admin/reference/:templateId', async (c) => {
    if (!env.ADMIN_TOKEN) return c.json({ error: 'ADMIN_TOKEN is not configured' }, 503);
    if ((c.req.header('Authorization') ?? '') !== `Bearer ${env.ADMIN_TOKEN}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const templateId = c.req.param('templateId');
    if (!isTemplateId(templateId)) {
      return c.json({ error: `unknown templateId: ${templateId}` }, 400);
    }
    try {
      const result = await runReferenceCheck(pipeline, templateId);
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, templateId }, 'admin reference check failed');
      return c.json({ error: message }, 500);
    }
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
  await runFifteenMinuteSweep(s.sweeps);
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
      s.logger.error(
        {
          queue: batch.queue,
          body: message.body,
          messageId: message.id,
          attempts: message.attempts,
        },
        'DEAD-LETTERED JOB — operator action required (see README runbook)',
      );
      await recordDlqEvent(env.DB, batch.queue, message.body);
      message.ack();
    }
    return;
  }

  // Build/cycle/edit jobs. A controlled exit inside the pipeline (park,
  // re-enqueue continuation, hand-off to promote/abort) resolves cleanly and we
  // ack; a THROWN error is a transient failure — retry so the queue redelivers,
  // where the idempotency claim + checkpoints (incl. the banked-round + staged
  // short-circuit) make the retry cheap and non-double-spending. The per-job
  // Playwright browser is torn down after every message, success or failure.
  // Cycle jobs are routed straight to hosting.processCycleJob (Task 21) rather than
  // through processJobMessage, to avoid a runtime import cycle between pipeline.ts and
  // hosting.ts.
  for (const message of batch.messages) {
    try {
      if (message.body.kind === 'cycle') {
        await processCycleJob(s.pipeline, message.body as JobMessage & { kind: 'cycle' });
      } else {
        await processJobMessage(s.pipeline, message.body);
      }
      message.ack();
    } catch (err) {
      s.logger.error({ err, body: message.body, messageId: message.id }, 'job failed — retrying');
      message.retry();
    } finally {
      await s.closeBrowser().catch(() => {});
    }
  }
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> =>
    getServices(env).app.fetch(request, env, ctx),
  scheduled,
  queue,
};
