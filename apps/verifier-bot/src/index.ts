import {
  AgentClient,
  createGigPoller,
  createWebhookServer,
  createProposer,
  registerBot,
  ensureWebhookRegistered,
  shouldPropose,
  createLogger,
  withContext,
  createAlerter,
  loadWebhookSecret,
  saveWebhookSecret,
  AgentMcpClient,
  handleDisputedContract,
  createReputationMonitor,
  createNegotiationMemory,
  createNegotiationPoller,
  createCostEstimator,
  logContractReview,
  type ReputationMonitor,
  type Gig,
  type Contract,
} from '@botguild/agent-core';
import { botProfile, scorerConfig, pricingCalc, rateCard, fallbackEstimate } from './config.js';
import { createGigParser } from './parser.js';
import { runHttpCheck } from './runners/http.js';
import { runDomChecks } from './runners/dom.js';
import { runDataQualityChecks } from './runners/data.js';
import { runAcceptanceAudit } from './runners/audit.js';
import { generateAndDeliverReport } from './report.js';
import { loadStore, setJob, getJob, listJobs } from './store.js';
import type { CheckResult } from './runners/http.js';
import type { AuditVerdict } from './runners/audit.js';
import {
  buildHttpConfigFromCriterion,
  buildDomCheckFromCriterion,
  buildDataQualityCriterion,
} from './criterion-mapping.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

let logger = createLogger({ service: 'verifier-bot' });

// ---------------------------------------------------------------------------
// Env vars
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    logger.fatal({ envVar: name }, `missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const apiUrl = requireEnv('BOTGUILD_API_URL');
const apiKey = requireEnv('BOTGUILD_API_KEY');
const botId = process.env['BOTGUILD_BOT_ID'] ?? '';
const webhookSecret = requireEnv('BOTGUILD_WEBHOOK_SECRET');
const anthropicApiKey = requireEnv('ANTHROPIC_API_KEY');
const webhookBaseUrl = requireEnv('WEBHOOK_BASE_URL');
const port = parseInt(process.env['PORT'] ?? '3002', 10);
const telegramToken = process.env['TELEGRAM_BOT_TOKEN'];
const telegramChatId = process.env['TELEGRAM_CHAT_ID'];

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info('VerifierBot starting up');

  loadStore();

  // The platform generates the webhook secret server-side and ignores the one
  // we send in POST /webhooks. Capture the platform-issued secret from the
  // POST response and persist it; the webhook server reads it via the getter.
  const persisted = loadWebhookSecret();
  let activeSecret = persisted?.secret ?? webhookSecret;
  if (persisted) {
    logger.info(
      { webhookId: persisted.webhookId, capturedAt: persisted.capturedAt },
      'loaded persisted webhook secret',
    );
  } else {
    logger.info('no persisted webhook secret on disk, will capture from next POST /webhooks');
  }

  // Bind the webhook server (and /health) BEFORE any external API calls.
  // If registerBot / ensureWebhookRegistered hang or
  // throw, Fly's 10s health-check grace period would otherwise expire and
  // the machine never becomes reachable. Handlers are registered later;
  // until webhookServer.markReady() is called (after handler registration),
  // /webhook returns 503 so the platform retries any in-flight deliveries
  // instead of recording them as successfully delivered to an unprepared bot.
  // Reputation is surfaced on /health once the monitor is wired (after the MCP
  // client exists). healthExtra is resolved per-request, so this getter reads
  // whatever the monitor has cached — null until the first refresh.
  let repMonitor: ReputationMonitor | null = null;
  const webhookServer = createWebhookServer({
    port,
    secret: () => activeSecret,
    botId: botId || 'pending',
    logger,
    healthExtra: () => {
      const snap = repMonitor?.snapshot();
      return snap ? { reputation: snap } : {};
    },
  });
  await webhookServer.start();

  // Register / patch bot profile; resolves the live botId
  const resolvedBotId = await registerBot({
    apiUrl,
    apiKey,
    botConfig: botProfile,
    logger,
  });

  const effectiveBotId = botId || resolvedBotId;
  logger = createLogger({ service: 'verifier-bot', botId: effectiveBotId });

  const alerter =
    telegramToken && telegramChatId
      ? createAlerter({ botToken: telegramToken, chatId: telegramChatId, logger })
      : null;

  // Build the API client
  const client = new AgentClient({ apiUrl, apiKey, botId: effectiveBotId, logger });
  const mcpClient = new AgentMcpClient({ apiUrl, apiKey, logger });

  // Periodically pull handler reputation/earnings; reputation feeds /health,
  // earnings go to logs. Reputation (70+) is a launch success target.
  repMonitor = createReputationMonitor({ source: mcpClient, logger });

  // Hybrid pricing: Claude estimates the compute/resource quantities a gig needs,
  // the rate card turns those into a cost, and we bid 1.5× that. Estimates are
  // cached per gig so the proposer and negotiation agree on one number.
  const costEstimator = createCostEstimator({
    apiKey: anthropicApiKey,
    botName: botProfile.name,
    botDescription: botProfile.bio,
    rateCard,
    fallbackEstimate,
    logger,
  });

  // Counter-offers have no webhook event, so poll pending proposals and respond
  // per policy: accept at/above our firm floor (the same 1.5×-cost price we bid),
  // else counter back once at that price, else decline. The memory file makes
  // "counter once" stick across restarts.
  const negotiationPoller = createNegotiationPoller({
    client,
    pricingCalc,
    costEstimator,
    memory: createNegotiationMemory(),
    logger,
  });

  // Ensure webhook registration. When the platform issues a fresh secret
  // (i.e. we hit POST /webhooks), capture and persist it.
  await ensureWebhookRegistered({
    client,
    webhookBaseUrl,
    webhookSecret,
    events: [
      'proposal.accepted',
      'milestone.funded',
      'milestone.delivered',
      'milestone.accepted',
      'contract.status.changed',
      'acceptance.auto_approved',
      'dispute.response_submitted',
    ],
    logger,
    hasStoredSecret: persisted !== null,
    knownWebhookId: persisted?.webhookId,
    onSecretCaptured: (secret, webhookId) => {
      activeSecret = secret;
      saveWebhookSecret(secret, webhookId);
      logger.info({ webhookId }, 'captured + persisted platform-issued webhook secret');
    },
  });

  // Build gig parser
  const parser = createGigParser({ apiKey: anthropicApiKey, logger });

  // Build proposer
  const proposer = createProposer({
    apiKey: anthropicApiKey,
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

  // The full check + report kickoff pipeline. Called by milestone.funded once
  // escrow is funded — never directly from proposal.accepted (which only
  // stashes the gig+contract so the bot doesn't burn unpaid
  // Claude/Playwright work on a draft contract that may never be funded).
  async function executeAcceptedFlow(gig: Gig, contract: Contract): Promise<void> {
    const contractId = contract.id;
    const log = withContext(logger, { gigId: gig.id, contractId });
    const milestoneIds = contract.milestones.map((m: { id: string }) => m.id);

    try {
      const result = await parser.parse(gig, contractId, milestoneIds);

      if (result.needsClarification) {
        await client.sendMessage(
          contractId,
          result.clarificationQuestion ?? 'Could you clarify the acceptance criteria?',
          'clarification_request',
        );
        return;
      }

      const { plan } = result;

      log.info(
        {
          checkType: plan.checkType,
          criteriaCount: plan.criteriaList.length,
          milestoneIds: plan.milestoneIds,
        },
        'check plan ready',
      );

      await client.sendMessage(
        contractId,
        `Check plan ready. Running ${plan.checkType} checks (${plan.criteriaList.length} criteria).`,
        'progress_update',
      );

      setJob(contractId, {
        gigId: gig.id,
        contractId,
        checkType: plan.checkType,
        status: 'running',
        checkResults: [],
        updatedAt: new Date().toISOString(),
      });

      const milestone1Id = plan.milestoneIds[0];
      if (milestone1Id) {
        // Checkpoint delivery — non-fatal. On a recovery re-run the milestone
        // may already be delivered (the platform 404s a re-delivery); that
        // must not abort the checks themselves.
        try {
          await client.deliverMilestone(contractId, milestone1Id, {
            note: `Run Checks: starting ${plan.checkType} checks for ${plan.criteriaList.length} criteria.`,
          });
        } catch (err) {
          log.warn({ err, milestoneId: milestone1Id }, 'milestone 1 checkpoint delivery failed');
        }
      }

      const allCheckResults: CheckResult[] = [];
      const allAuditVerdicts: AuditVerdict[] = [];
      const screenshotBase64s: string[] = [];

      const httpCriteria = plan.criteriaList.filter((c) => c.checkMethod === 'http');
      const domCriteria = plan.criteriaList.filter((c) => c.checkMethod === 'dom');
      const dataCriteria = plan.criteriaList.filter((c) => c.checkMethod === 'data');
      const claudeCriteria = plan.criteriaList.filter((c) => c.checkMethod === 'claude');

      const checksStart = Date.now();
      for (const criterion of httpCriteria) {
        const target = plan.targets[0] ?? '';
        const httpConfig = buildHttpConfigFromCriterion(criterion, { logger: log });
        const checkResult = await runHttpCheck(
          target,
          criterion.id,
          criterion.description,
          httpConfig,
        );
        allCheckResults.push(checkResult);
      }

      for (const target of plan.targets) {
        if (domCriteria.length === 0) break;
        const domChecks = domCriteria.map((c) => buildDomCheckFromCriterion(c));
        const domResult = await runDomChecks(target, domChecks, {
          screenshotEnabled: plan.evidenceRequired.screenshot,
          logger: log,
        });
        allCheckResults.push(...domResult.results);
        if (domResult.screenshotBase64) {
          screenshotBase64s.push(domResult.screenshotBase64);
        }
      }

      if (dataCriteria.length > 0) {
        const dataSource = plan.targets[0] ?? '';
        const dataQualityCriteria = dataCriteria.map((c) => buildDataQualityCriterion(c));
        const dataResult = await runDataQualityChecks(dataSource, dataQualityCriteria, {
          logger: log,
        });
        allCheckResults.push(...dataResult.checkResults);
      }

      if (claudeCriteria.length > 0) {
        const deliverableContent = plan.targets[0] ?? '';
        const auditCriteria = claudeCriteria.map((c) => ({
          criterionId: c.id,
          description: c.description,
          expected: c.expected,
        }));
        const auditResult = await runAcceptanceAudit(deliverableContent, auditCriteria, {
          apiKey: anthropicApiKey,
          logger: log,
        });
        allCheckResults.push(...auditResult.checkResults);
        allAuditVerdicts.push(...auditResult.auditVerdicts);
      }

      const passCount = allCheckResults.filter((r) => r.verdict === 'pass').length;
      const failCount = allCheckResults.filter((r) => r.verdict === 'fail').length;
      log.info({ durationMs: Date.now() - checksStart, passCount, failCount }, 'checks complete');

      await client.sendMessage(
        contractId,
        `Checks complete. ${passCount} passed, ${failCount} failed. Generating report.`,
        'progress_update',
      );

      setJob(contractId, {
        gigId: gig.id,
        contractId,
        checkType: plan.checkType,
        status: 'delivering',
        checkResults: allCheckResults,
        updatedAt: new Date().toISOString(),
      });

      const milestone2Id = plan.milestoneIds[1] ?? plan.milestoneIds[0] ?? '';
      const reportStart = Date.now();
      await generateAndDeliverReport(
        contractId,
        milestone2Id,
        allCheckResults,
        allAuditVerdicts,
        screenshotBase64s,
        { client, apiKey: anthropicApiKey, logger: log },
      );

      setJob(contractId, {
        gigId: gig.id,
        contractId,
        checkType: plan.checkType,
        status: 'complete',
        checkResults: allCheckResults,
        updatedAt: new Date().toISOString(),
      });

      log.info(
        { passCount, failCount, durationMs: Date.now() - reportStart },
        'verification pipeline complete',
      );
    } catch (err) {
      log.error({ err }, 'verification pipeline failed');

      const existing = getJob(contractId);
      setJob(contractId, {
        gigId: gig.id,
        contractId,
        checkType: existing?.checkType ?? 'unknown',
        status: 'error',
        checkResults: existing?.checkResults ?? [],
        updatedAt: new Date().toISOString(),
      });
    }
  }

  // Register webhook event handlers
  webhookServer.on('proposal.accepted', async (event) => {
    // The platform sends a flat ID payload, not nested entities. Fetch the
    // full gig + contract by id so they can be stashed for the funded run.
    const { gigId, contractId } = event.payload as { gigId?: string; contractId?: string };
    if (!gigId || !contractId) {
      logger.warn({ payload: event.payload }, 'proposal.accepted missing gigId/contractId');
      return;
    }
    const log = withContext(logger, { gigId, contractId });

    let gig: Gig;
    let contract: Contract;
    try {
      [gig, contract] = await Promise.all([client.getGig(gigId), client.getContract(contractId)]);
    } catch (err) {
      log.error({ err }, 'failed to fetch gig/contract on proposal.accepted');
      return;
    }

    // Stash the gig + contract; do not run any checks until escrow is funded.
    setJob(contractId, {
      gigId,
      contractId,
      checkType: 'pending',
      status: 'awaiting_funding',
      checkResults: [],
      updatedAt: new Date().toISOString(),
      pendingAcceptance: { gig, contract },
    });

    try {
      await client.sendMessage(
        contractId,
        'Proposal accepted. Verification will begin as soon as escrow is funded.',
        'progress_update',
      );
    } catch (err) {
      log.warn({ err }, 'failed to send awaiting-funding message');
    }
  });

  webhookServer.on('milestone.funded', async (event) => {
    const payload = event.payload as { contractId?: string };
    const contractId = payload.contractId;
    if (!contractId) {
      logger.warn({ payload }, 'milestone.funded missing contractId');
      return;
    }
    const job = getJob(contractId);
    if (!job?.pendingAcceptance) {
      logger.info({ contractId }, 'milestone.funded with no pending acceptance, ignoring');
      return;
    }
    if (job.status !== 'awaiting_funding') {
      logger.info(
        { contractId, status: job.status },
        'milestone.funded received but job already past awaiting_funding',
      );
      return;
    }
    // Flip status synchronously BEFORE the first await so a concurrent
    // milestone.funded delivery for the same contract can't pass the guard
    // and double-trigger the pipeline.
    setJob(contractId, { ...job, status: 'running', updatedAt: new Date().toISOString() });
    logger.info({ contractId }, 'milestone funded, executing accepted flow');
    await executeAcceptedFlow(
      job.pendingAcceptance.gig as Gig,
      job.pendingAcceptance.contract as Contract,
    );
  });

  webhookServer.on('milestone.delivered', async (event) => {
    logger.info({ payload: event.payload }, 'milestone delivered');
  });

  webhookServer.on('milestone.accepted', async (event) => {
    const { contractId } = event.payload as { contractId?: string };
    logger.info({ payload: event.payload }, 'milestone accepted');
    // A payer may leave a review once the contract reaches acceptance. Log the
    // reputation signal we received (read-only; payers write reviews). Fire and
    // forget — it's best-effort observability and never throws, so don't hold
    // the webhook response open on a REST round-trip.
    if (contractId) {
      void logContractReview({ client, contractId, logger });
    }
  });

  webhookServer.on('acceptance.auto_approved', async (event) => {
    logger.info({ payload: event.payload }, 'milestone auto-approved by acceptance window');
  });

  webhookServer.on('dispute.response_submitted', async (event) => {
    // Full counter-statement flow lives in story 2.4 (MCP respond_to_dispute).
    logger.warn({ payload: event.payload }, 'dispute response submitted on this contract');
  });

  webhookServer.on('contract.status.changed', async (event) => {
    const { contractId, newStatus, reason } = event.payload as {
      contractId?: string;
      newStatus?: string;
      reason?: string;
    };
    if (!contractId) {
      logger.warn({ payload: event.payload }, 'contract.status.changed missing contractId');
      return;
    }
    logger.info({ contractId, status: newStatus }, 'contract status changed');
    if (newStatus === 'disputed') {
      await handleDisputedContract({
        serviceName: 'VerifierBot',
        contractId,
        reason,
        mcp: mcpClient,
        alerter,
        logger,
      });
      return;
    }
  });

  // Build gig poller
  const poller = createGigPoller({
    client,
    logger,
    async onGig(gig) {
      const score = shouldPropose(gig, scorerConfig);
      if (!score) {
        logger.info({ gigId: gig.id, title: gig.title }, 'gig below proposal threshold, skipping');
        return;
      }

      logger.info({ gigId: gig.id, title: gig.title }, 'generating proposal');

      try {
        const proposal = await proposer.generateProposal(gig);
        const { proposalId } = await client.submitProposal(gig.id, proposal);
        logger.info({ gigId: gig.id, proposalId }, 'proposal submitted successfully');
      } catch (err) {
        logger.error({ err, gigId: gig.id }, 'failed to submit proposal');
      }
    },
  });

  // Recover in-flight contracts persisted from a prior run. A restart between
  // milestone.funded and delivery (deploy, crash, OOM) used to strand the job:
  // nothing re-runs the pipeline, and the funded-handler guard ignores webhook
  // replays once the job is past 'awaiting_funding' (platform #301's
  // execution-side twin). Re-fetch each contract and re-run the pipeline if
  // the platform still expects work. This happens BEFORE markReady() — the
  // platform 503-retries webhooks meanwhile — so a concurrent delivery can't
  // race the recovery scan; the pipelines themselves start after markReady().
  // 'error' jobs are retried too: while the contract is still active the
  // platform expects work, and a transient failure (Claude hiccup, network)
  // shouldn't strand the contract any more than a crash would. Permanent
  // failures just re-error — bounded at one retry per restart.
  const recoveries: Array<() => Promise<void>> = [];
  for (const job of listJobs()) {
    if (!['awaiting_funding', 'running', 'delivering', 'error'].includes(job.status)) continue;
    const log = withContext(logger, { gigId: job.gigId, contractId: job.contractId });

    let gig: Gig;
    let contract: Contract;
    try {
      [gig, contract] = await Promise.all([
        client.getGig(job.gigId),
        client.getContract(job.contractId),
      ]);
    } catch (err) {
      log.warn({ err }, 'failed to fetch contract during startup recovery, leaving job as-is');
      continue;
    }

    if (contract.status === 'draft' || contract.status === 'funded') {
      // Still awaiting funding/activation; milestone.funded will kick it off.
      log.info({ contractStatus: contract.status }, 'recovered job still awaits activation');
      continue;
    }
    if (contract.status !== 'active') {
      // The contract moved on without us (delivered/completed/cancelled/...).
      log.info({ contractStatus: contract.status }, 'contract no longer active, closing job');
      setJob(job.contractId, {
        ...job,
        status:
          contract.status === 'cancelled' ||
          contract.status === 'refunded' ||
          contract.status === 'disputed'
            ? 'error'
            : 'complete',
        pendingAcceptance: undefined,
        updatedAt: new Date().toISOString(),
      });
      continue;
    }

    // Flip the job synchronously so a milestone.funded replay after
    // markReady() hits the past-awaiting_funding guard and can't double-run.
    setJob(job.contractId, {
      ...job,
      status: 'running',
      pendingAcceptance: undefined,
      updatedAt: new Date().toISOString(),
    });
    log.info({ priorStatus: job.status }, 'recovering in-flight contract, re-running pipeline');
    recoveries.push(() => executeAcceptedFlow(gig, contract));
  }

  // All handlers are wired. Flip the webhook server
  // out of "not ready" mode so incoming deliveries dispatch to handlers
  // instead of getting a 503 placeholder.
  webhookServer.markReady();

  // Kick recovered pipelines off in the background; they can take minutes and
  // must not block startup. executeAcceptedFlow handles its own errors.
  for (const run of recoveries) void run();

  // Start gig poller (webhook server was bound at the top of main())
  poller.start();
  negotiationPoller.start();
  repMonitor.start();

  logger.info({ botId: effectiveBotId, port }, 'VerifierBot started');
  await alerter?.sendStartupAlert('VerifierBot', effectiveBotId);

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown signal received');
    poller.stop();
    negotiationPoller.stop();
    repMonitor?.stop();
    await webhookServer.stop();
    logger.info('VerifierBot stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void alerter
      ?.sendFatalAlert('VerifierBot', effectiveBotId, err.message)
      .finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    logger.fatal({ reason }, 'unhandled rejection');
    void alerter
      ?.sendFatalAlert('VerifierBot', effectiveBotId, message)
      .finally(() => process.exit(1));
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'VerifierBot startup failed');
  process.exit(1);
});
