// ---------------------------------------------------------------------------
// LogoSmith Worker entry — the ONLY module that touches Workers bindings.
//
//   fetch:     POST /webhook               (shim app: HMAC verify → handlers)
//              GET  /health                (shim app + D1-cached reputation)
//              GET  /deliverables/:token/:file
//              GET  /p/:token  +  /p/:token/events   (progress page, FR-7)
//              POST /admin/register        (protected; run once at deploy)
//   queue:     logosmith-jobs consumer + DLQ alerting
//   scheduled: 15-min sweep and daily sweep, dispatched by cron expression
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';
import Anthropic from '@anthropic-ai/sdk';
import {
  AgentClient,
  AgentMcpClient,
  createCostEstimator,
  createProposer,
  logContractReview,
} from '@botguild/agent-core';
import type { CostEstimator, Gig, Proposer } from '@botguild/agent-core';
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
// Bundled wasm — assets.d.ts supplies the TypeScript module type for `.wasm`
// specifiers. Both wasm sources below are wired as LAZY (dynamic `import()`)
// callbacks, not top-level static imports, for two independently-verified
// reasons:
//
// 1. potrace: the original plan's `import potraceWasm from
//    'esm-potrace-wasm/dist/potrace.wasm'` does NOT exist — esm-potrace-wasm@0.5.0
//    embeds its compiled wasm inside dist/index.js as an inline byte-string
//    rather than shipping a separate `.wasm` file (`node_modules/esm-potrace-wasm/dist/`
//    contains only `index.js` + `index.d.ts` — confirmed independently by
//    Task 3, Task 10, and again here). `ensurePotraceReady` (pack/wasm.ts)
//    already documents that its `source` parameter is accepted only for
//    shape-symmetry with `ensureResvgReady` and is NEVER called — potrace is
//    initialized instead via a lazy `import('esm-potrace-wasm').then((mod) =>
//    mod.init())`, exactly as `wasm.node.ts`'s Node-only stub already does. So
//    the potrace source below is a never-called stub, not an import at all.
//
// 2. resvg: `@resvg/resvg-wasm/index_bg.wasm` IS a real file (unlike potrace's),
//    and wrangler's bundler compiles a reference to it into a CompiledWasm
//    module just fine. But this file is also the ONLY module `handlers.test.ts`
//    imports under plain Node (for `resolveDeliverable`) — and verified directly
//    (both under `tsx --test` and under bare `node`, no flags): a top-level
//    STATIC `import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'` makes
//    Node's own ESM loader try to resolve the wasm binary's *own* import
//    section (wasm-bindgen's "wbg" host-import namespace) as if it were an
//    npm package specifier, and fail with `ERR_MODULE_NOT_FOUND: Cannot find
//    package 'wbg'` — before any of our code runs, since ES module bodies are
//    fully evaluated top-to-bottom on import regardless of which export the
//    importer actually wants. That is a real Node/wasm-ESM semantics gap
//    (Node instantiates+import-links a statically-imported `.wasm`; wrangler's
//    bundler instead hands over an inert, uninstantiated `WebAssembly.Module`)
//    — not a tsx quirk and not fixable by a Node flag. A LAZY dynamic import,
//    called only from inside the `sources.resvg` callback below (which no
//    Node test invokes — it only runs inside the real service graph's pack
//    stage), sidesteps it: the import is never evaluated during a plain-Node
//    test run, while wrangler's bundler still statically discovers and inlines
//    the literal specifier exactly as it already does for potrace's own
//    dynamic `import('esm-potrace-wasm')` (confirmed in Task 10's bundle-size
//    experiment — dynamic imports get inlined into the single-file Workers
//    bundle) — reverified here by `wrangler deploy --dry-run` (see the task
//    report for the resulting bundle numbers).
import { HAIKU_MODEL_ID, botProfile, fallbackEstimate, pricingCalc, rateCard } from './config.js';
import { createDisputeResponder, type DisputeResponder } from './disputes.js';
import {
  buildJobKey,
  createConceptStore,
  createJobStore,
  createQuotaStore,
  createSelectionStore,
  loadReputationSnapshot,
  type ConceptStore,
  type JobStore,
  type QuotaStore,
  type SelectionStore,
} from './jobs.js';
import { renderProgressPage, renderProgressEvent } from './progress.js';
import { processJobMessage, type PipelineConfig } from './pipeline.js';
import { createProseBriefExtractor } from './proseBrief.js';
import {
  resolveSelectionForContract,
  runDailySweep,
  runFifteenMinuteSweep,
  type JobQueueLike,
  type SweepServices,
} from './sweeps.js';
import type { JobMessage, JobStage } from './types.js';

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  DELIVERABLES: R2Bucket;
  JOBS: Queue<JobMessage>;
  AI: Ai;
  // wrangler.jsonc vars
  WEBHOOK_BASE_URL: string;
  // wrangler secrets (.dev.vars locally)
  BOTGUILD_API_URL: string;
  BOTGUILD_API_KEY: string;
  BOTGUILD_BOT_ID: string;
  ANTHROPIC_API_KEY: string;
  MODERATION_API_KEY: string;
  IDEOGRAM_API_KEY: string;
  RECRAFT_API_KEY: string;
  VECTORIZER_AI_TOKEN: string;
  GOOGLE_FONTS_API_KEY: string;
  /** Protects POST /admin/register. Unset ⇒ the route is disabled. */
  ADMIN_TOKEN?: string;
}

const SERVICE = 'logosmith-bot';
const DAILY_CRON = '0 6 * * *'; // the */15 sweep is the default branch

// --- Pure policy (unit-tested; no bindings) ---------------------------------

const DELIVERABLE_TYPES: Record<string, string> = {
  'pack.zip': 'application/zip',
  'report.json': 'application/json',
  'licenses.json': 'application/json',
  'concept-1.png': 'image/png',
  'concept-2.png': 'image/png',
  'concept-3.png': 'image/png',
};

/**
 * Resolve a deliverables request to an R2 key. The path segment is the per-job
 * unguessable capability token (§12) — never the recomputable job key — and
 * file names are whitelisted, so the R2 namespace is neither enumerable nor
 * derivable from a known contract id.
 *
 * Two distinct guards after the token check, asking two different questions:
 * `Object.hasOwn` asks "is this key in the map?" — `DELIVERABLE_TYPES` is a
 * plain object literal, so a bare `[file]` lookup would return a truthy
 * inherited value (not `undefined`) for names like
 * `__proto__`/`constructor`/`toString`/etc., sailing past a falsy check
 * instead of being rejected (same idiom as agent-core-workers' webhookApp.ts
 * uses for its handlers map). The subsequent falsy check on `contentType`
 * asks "is the value usable?" — today every entry is a non-empty literal, so
 * this can't currently fire through this function's public inputs, but it's
 * kept as defence-in-depth against a future entry added with an empty-string
 * value (a plausible typo), which `Object.hasOwn` alone would not catch.
 */
export function resolveDeliverable(
  token: string,
  file: string,
): { key: string; contentType: string } | null {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  if (!Object.hasOwn(DELIVERABLE_TYPES, file)) return null;
  const contentType = DELIVERABLE_TYPES[file];
  if (!contentType) return null;
  return { key: `${token}/${file}`, contentType };
}

/**
 * Which stage 1 a funded contract actually is.
 *
 * Funding starts stage 1 only — stage 2 (`vector`) is claimed by the selection
 * sweep, because the payload carries no milestone id and M2 begins when a
 * winner exists, not when escrow is funded (FR-15). But WHICH stage 1 depends
 * on the gig: a FREE gig (the US-2 favicon repackage, the US-3 taster) runs the
 * `single` stage. Routing a $0 gig into `concepts` would compile Haiku axes and
 * buy three Ideogram/Recraft images for a contract that pays nothing, and would
 * never consult the FR-14 quota on the way — precisely the "unlimited free
 * image generation billed to us" the free funnel exists to prevent.
 *
 * "Is this free?" is asked as `pricingCalc(gig).price === 0` rather than by
 * re-deriving the favicon-brief / zero-budget test here — the same question,
 * asked the same way, that `maybePropose` (sweeps.ts) asks to route the
 * PROPOSAL. So the stage a gig is worked as cannot drift from the price it was
 * bid at: config.ts's calculator returns 0 for exactly the free shapes.
 */
export function stageForFundedGig(gig: Gig): JobStage {
  return pricingCalc(gig).price === 0 ? 'single' : 'concepts';
}

export interface MilestoneFundedDeps {
  client: Pick<AgentClient, 'getContract' | 'getGig'>;
  jobs: Pick<JobStore, 'claim'>;
  /** The same structural queue seam the sweeps consume, so a Node test can hand
   *  in a recorder without a Workers `Queue` binding. */
  queue: JobQueueLike;
  logger: Logger;
}

export interface DisputeHandlerDeps {
  disputes: DisputeResponder;
  logger: Logger;
}

/**
 * The two dispute-flow webhooks (§10.9), as a factory for the same reason
 * `createMilestoneFundedHandler` is one: the ROUTING decision is the part that
 * can silently be wrong. A handler that answered every status change would file
 * a counter-statement on a completed contract; one that answered none would
 * leave the platform's dispute unanswered, and neither is visible from inside
 * `disputes.respond`.
 *
 * Both log first and act second, so the log-only behaviour every other status
 * change had is unchanged. A payload without a contract id is logged and
 * dropped rather than guessed at.
 *
 * A `respond` failure is allowed to THROW: the webhook app answers 500 and the
 * platform redelivers, which is the only automatic retry a dispute response
 * gets (`respond` releases its one-shot claim on failure precisely so that
 * redelivery can succeed). Swallowing it here would convert one transient MCP
 * error into a permanently unanswered dispute.
 */
export function createDisputeHandlers(deps: DisputeHandlerDeps): {
  onContractStatusChanged: WebhookHandler;
  onDisputeResponseSubmitted: WebhookHandler;
} {
  const { disputes, logger } = deps;
  return {
    onContractStatusChanged: async (event) => {
      const { contractId, newStatus } = event.payload as {
        contractId?: string;
        newStatus?: string;
      };
      logger.info(
        { eventType: 'contract.status.changed', payload: event.payload },
        'lifecycle event received',
      );
      if (newStatus !== 'disputed' || !contractId) return;
      await disputes.respond(contractId);
    },

    // Unconditional: this fires when a response is filed on the contract —
    // including ours. The one-shot D1 claim is what makes answering our own
    // event a no-op, so this handler does not have to guess whose it was.
    onDisputeResponseSubmitted: async (event) => {
      const { contractId } = event.payload as { contractId?: string };
      logger.info(
        { eventType: 'dispute.response_submitted', payload: event.payload },
        'lifecycle event received',
      );
      if (!contractId) return;
      await disputes.respond(contractId);
    },
  };
}

/**
 * The FR-15 fast ack: resolve the stage, D1 idempotency claim, Queue send, 200.
 *
 * A factory rather than an inline closure so the routing decision is reachable
 * from a plain Node test with fakes. That matters more here than anywhere else
 * in this file: a stage mis-route is invisible from inside either stage — both
 * would run perfectly well, just on the wrong contract — so the only place it
 * can be caught is at this seam.
 *
 * A `getContract`/`getGig` failure THROWS, so the app answers 500 and the
 * platform redelivers. Guessing a stage from a gig we could not read is the one
 * outcome worse than a retry: guess `concepts` and a free gig buys paid images;
 * guess `single` and a paid contract burns one of the buyer's free allowances.
 * Nothing is claimed before the stage is known, so a redelivery starts clean.
 */
export function createMilestoneFundedHandler(deps: MilestoneFundedDeps): WebhookHandler {
  const { client, jobs, queue, logger } = deps;
  return async (event) => {
    const { contractId } = event.payload as { contractId: string };
    const contract = await client.getContract(contractId);
    const gig = await client.getGig(contract.gigId);
    const stage = stageForFundedGig(gig);
    const jobKey = await buildJobKey(contractId, stage);
    const decision = await jobs.claim(jobKey, contractId, stage);
    logger.info({ contractId, jobKey, stage, ...decision }, 'milestone.funded claim decision');
    if (decision.action === 'enqueue') {
      await queue.send({ contractId, jobKey, stage });
    }
  };
}

// --- Service graph ----------------------------------------------------------

interface Services {
  logger: Logger;
  client: AgentClient;
  secretStore: D1WebhookSecretStore;
  jobs: JobStore;
  concepts: ConceptStore;
  selection: SelectionStore;
  quota: QuotaStore;
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
  const concepts = createConceptStore(env.DB);
  const selection = createSelectionStore(env.DB);
  const quota = createQuotaStore(env.DB);

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
  // No estimator: the FREE gigs must bid their $0 anchor, and the estimator
  // would floor the bid at 1.5x cost.
  const freeProposer = createProposer({
    apiKey: env.ANTHROPIC_API_KEY,
    botProfile: proposerProfile,
    pricingCalc,
    logger,
  });

  const publicBaseUrl = env.WEBHOOK_BASE_URL.replace(/\/$/, '');

  // Bindings are adapted to the structural interfaces the pipeline consumes, so
  // every module below this line stays Node-testable.
  const pipeline: PipelineConfig = {
    jobs,
    concepts,
    selection,
    quota,
    client,
    ai: env.AI,
    deliverables: {
      put: async (key, value, contentType) => {
        await env.DELIVERABLES.put(key, value, { httpMetadata: { contentType } });
      },
      // Stage 2 reads the winner's artifacts back (Task 21); null on a miss.
      get: async (key) => {
        const object = await env.DELIVERABLES.get(key);
        return object ? new Uint8Array(await object.arrayBuffer()) : null;
      },
    },
    // Once-per-isolate wasm sources for the pack stack (pack/wasm.ts memoizes
    // the init promises, so this dynamic import only ever runs once per
    // isolate too). Lazy on purpose — see the header comment above: a bare
    // Node import of this module (handlers.test.ts, for resolveDeliverable)
    // must never evaluate this specifier, and wrangler's bundler still
    // statically discovers and inlines it as a CompiledWasm module because
    // the specifier is a literal string.
    sources: {
      resvg: () => import('@resvg/resvg-wasm/index_bg.wasm').then((mod) => mod.default),
      // esm-potrace-wasm has no separate `.wasm` file to import (see the
      // header comment above) — ensurePotraceReady() never calls this
      // source, so it exists only to satisfy the WasmSources shape and fails
      // loudly if that assumption ever changes. Mirrors nodeWasmSources()'s
      // identical stub in pack/wasm.node.ts.
      potrace: () => {
        throw new Error(
          'esm-potrace-wasm embeds its wasm bytes — there is no potrace.wasm file to import, ' +
            'and ensurePotraceReady() never calls this source.',
        );
      },
    },
    secrets: {
      moderationApiKey: env.MODERATION_API_KEY,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      ideogramApiKey: env.IDEOGRAM_API_KEY,
      recraftApiKey: env.RECRAFT_API_KEY,
      vectorizerToken: env.VECTORIZER_AI_TOKEN,
      googleFontsApiKey: env.GOOGLE_FONTS_API_KEY,
    },
    fetchImpl: (url, init) => fetch(url, init),
    publicBaseUrl,
    logger,
  };

  const sweeps: SweepServices = {
    db: env.DB,
    client,
    jobs,
    concepts,
    selection,
    seen: createKVSeenStore(env.CACHE),
    negotiationStore: createD1NegotiationStore(env.DB),
    reputationSource: mcpClient,
    proposer,
    freeProposer,
    costEstimator,
    // Gig discovery runs before any contract exists, so there is no D1 job row
    // to book this against — the structured log line IS the ledger entry, and
    // `recordSpend` is required by the extractor's own type so it cannot be
    // constructed without one. Fires on every extraction, refused ones
    // included: a refusal still burned tokens.
    briefExtractor: createProseBriefExtractor({
      anthropic: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
      recordSpend: (costUsd) =>
        logger.info({ costUsd, model: HAIKU_MODEL_ID }, 'prose brief extraction spend'),
      // The vendor's own error, operator-side only. The buyer-facing reason
      // deliberately carries nothing from it.
      logError: (err) =>
        logger.warn({ err, model: HAIKU_MODEL_ID }, 'prose brief extraction failed'),
    }),
    queue: env.JOBS,
    apiUrl: env.BOTGUILD_API_URL,
    apiKey: env.BOTGUILD_API_KEY,
    botId,
    logger,
  };

  const app = buildApp(env, {
    logger,
    client,
    mcpClient,
    secretStore,
    jobs,
    concepts,
    selection,
    publicBaseUrl,
    botId,
  });
  services = {
    logger,
    client,
    secretStore,
    jobs,
    concepts,
    selection,
    quota,
    proposer,
    freeProposer,
    costEstimator,
    pipeline,
    sweeps,
    app,
  };
  return services;
}

function buildApp(
  env: Env,
  deps: {
    logger: Logger;
    client: AgentClient;
    mcpClient: AgentMcpClient;
    secretStore: D1WebhookSecretStore;
    jobs: JobStore;
    concepts: ConceptStore;
    selection: SelectionStore;
    publicBaseUrl: string;
    botId: string;
  },
): Hono {
  const { logger, client, mcpClient, secretStore, jobs, concepts, selection, botId } = deps;
  const { publicBaseUrl } = deps;

  const onMilestoneFunded = createMilestoneFundedHandler({
    client,
    jobs,
    queue: env.JOBS,
    logger,
  });

  const onProposalAccepted: WebhookHandler = async (event) => {
    const { contractId } = event.payload as { contractId: string };
    await client.sendMessage(
      contractId,
      'Proposal accepted — concept generation begins as soon as escrow is funded.',
    );
  };

  // M1 acceptance and auto-accept are FR-9 selection triggers: a buyer who
  // accepted the concepts without ever posting a selection gets the thread read
  // once more, then the default rule — instead of idling until the 72 h cron
  // timeout. The helper no-ops unless the selection row is at
  // `concepts_delivered`, so M2-side events fall through harmlessly.
  const selectionDeps = () => ({
    client,
    jobs,
    concepts,
    selection,
    queue: env.JOBS,
    apiUrl: env.BOTGUILD_API_URL,
    apiKey: env.BOTGUILD_API_KEY,
    botId,
    logger,
  });

  const onMilestoneAccepted: WebhookHandler = async (event) => {
    const { contractId } = event.payload as { contractId: string };
    await logContractReview({ client, contractId, logger });
    await resolveSelectionForContract(selectionDeps(), contractId, { force: true });
  };

  const onAutoApproved: WebhookHandler = async (event) => {
    const { contractId } = event.payload as { contractId: string };
    await resolveSelectionForContract(selectionDeps(), contractId, { force: true });
  };

  const logOnly =
    (eventType: string): WebhookHandler =>
    async (event) => {
      logger.info({ eventType, payload: event.payload }, 'lifecycle event received');
    };

  // §10.9: a disputed contract is answered from the D1 records this bot wrote
  // while the work ran — the readback verdict snapshots, the per-image vendor
  // request ids, the winner and how it was chosen, and the gate audit trail.
  const { onContractStatusChanged, onDisputeResponseSubmitted } = createDisputeHandlers({
    disputes: createDisputeResponder({
      db: env.DB,
      jobs,
      concepts,
      selection,
      mcp: mcpClient,
      publicBaseUrl,
      logger,
    }),
    logger,
  });

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
      // handler-scoped and sibling bots' events WILL arrive here (FR-16).
      'milestone.funded': withOwnershipFilter(onMilestoneFunded, ownership),
      'proposal.accepted': withOwnershipFilter(onProposalAccepted, ownership),
      'milestone.accepted': withOwnershipFilter(onMilestoneAccepted, ownership),
      'milestone.delivered': logOnly('milestone.delivered'),
      'acceptance.auto_approved': withOwnershipFilter(onAutoApproved, ownership),
      'contract.status.changed': withOwnershipFilter(onContractStatusChanged, ownership),
      'dispute.response_submitted': withOwnershipFilter(onDisputeResponseSubmitted, ownership),
    },
    healthExtra: async () => {
      const reputation = await loadReputationSnapshot(env.DB).catch(() => null);
      return reputation ? { reputation } : {};
    },
  });

  app.get('/deliverables/:token/:file', async (c) => {
    const resolved = resolveDeliverable(c.req.param('token'), c.req.param('file'));
    if (!resolved) return c.json({ error: 'Not found' }, 404);
    const object = await env.DELIVERABLES.get(resolved.key);
    if (!object) return c.json({ error: 'Not found' }, 404);
    return new Response(object.body as ReadableStream, {
      headers: {
        'Content-Type': resolved.contentType,
        'Content-Disposition': `attachment; filename="logosmith-${c.req.param('file')}"`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  // Progress/evidence page (FR-7): public, unguessable, read-only, no PII.
  app.get('/p/:token', async (c) => {
    const job = await jobs.getByToken(c.req.param('token'));
    if (!job) return c.text('Not found', 404);
    const rows = await concepts.list(job.contractId);
    return c.html(renderProgressPage(job, rows));
  });

  app.get('/p/:token/events', async (c) => {
    const job = await jobs.getByToken(c.req.param('token'));
    if (!job) return c.text('Not found', 404);
    const rows = await concepts.list(job.contractId);
    // A single snapshot frame then close: the client reconnects on the SSE
    // retry interval, which degrades to plain polling if SSE is unavailable.
    return new Response(renderProgressEvent(job, rows), {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      },
    });
  });

  // Registration runs from an explicit trigger (§10.2): this admin route once
  // at deploy, with a first-run branch of the cron sweep as backstop.
  app.post('/admin/register', async (c) => {
    if (!env.ADMIN_TOKEN) return c.json({ error: 'ADMIN_TOKEN is not configured' }, 503);
    if ((c.req.header('Authorization') ?? '') !== `Bearer ${env.ADMIN_TOKEN}`) {
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

  // First-run registration backstop: if registration never ran (no stored
  // secret), run it before sweeping — and let a failure throw. A bot that
  // cannot verify webhooks must not look healthy.
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

  // DLQ consumer: these exhausted their retries. They do NOT auto-replay — the
  // operator re-enqueues to logosmith-jobs, where the stage claims and
  // checkpoints make replay safe (§12 runbook).
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
          stage: message.body.stage,
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
