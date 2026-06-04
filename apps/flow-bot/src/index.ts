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
import { extractCsv } from './extractors/csv.js';
import { extractPdf } from './extractors/pdf.js';
import { extractApi } from './extractors/api.js';
import { normalizeRows } from './normalizer.js';
import { deliverOutput } from './delivery.js';
import { loadStore, setJob, getJob } from './store.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

let logger = createLogger({ service: 'flow-bot' });

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
const port = parseInt(process.env['PORT'] ?? '3001', 10);
const telegramToken = process.env['TELEGRAM_BOT_TOKEN'];
const telegramChatId = process.env['TELEGRAM_CHAT_ID'];

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info('FlowBot starting up');

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
  logger = createLogger({ service: 'flow-bot', botId: effectiveBotId });

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

  // The full ETL kickoff pipeline. Called by milestone.funded once escrow is
  // funded — never directly from proposal.accepted (which only stashes the
  // gig+contract so the bot doesn't burn unpaid Claude/Playwright work on a
  // draft contract that may never be funded).
  async function executeAcceptedFlow(gig: Gig, contract: Contract): Promise<void> {
    const contractId = contract.id;
    const log = withContext(logger, { gigId: gig.id, contractId });
    const milestoneIds = contract.milestones.map((m) => m.id);
    const [m1Id, m2Id, m3Id] = milestoneIds;

    try {
      const result = await parser.parse(gig, contractId, milestoneIds);

      if (result.needsClarification) {
        await client.sendMessage(
          contractId,
          result.clarificationQuestion ?? 'Could you clarify the job requirements?',
          'clarification_request',
        );
        return;
      }

      const config = result.config;

      setJob(contractId, {
        gigId: gig.id,
        contractId,
        inputType: config.inputType,
        status: 'fetching',
        currentMilestoneIndex: 0,
        updatedAt: new Date().toISOString(),
      });

      log.info(
        { inputType: config.inputType, milestoneIds: config.milestoneIds },
        'job configured',
      );

      await client.sendMessage(
        contractId,
        'Job configured. Starting fetch & validation (Milestone 1).',
        'progress_update',
      );

      // --- Extract ---
      let extractedRows: Record<string, unknown>[];
      let extractSummary: string;

      const extractStart = Date.now();
      if (config.inputType === 'csv' || config.inputType === 'sheet') {
        const csvResult = await extractCsv(config.inputSource, { logger: log });
        extractedRows = csvResult.rows;
        extractSummary = csvResult.summary;
      } else if (config.inputType === 'pdf') {
        const pdfResult = await extractPdf(config.inputSource, config.targetSchema, {
          apiKey: anthropicApiKey,
          logger: log,
        });
        extractedRows = pdfResult.rows;
        extractSummary = pdfResult.summary;
      } else {
        const apiResult = await extractApi({
          url: config.inputSource,
          paginationStyle: 'offset',
          logger: log,
        });
        extractedRows = apiResult.records;
        extractSummary = apiResult.summary;
      }
      log.info({ durationMs: Date.now() - extractStart }, 'extract phase complete');

      await client.sendMessage(
        contractId,
        `Fetch complete. ${extractSummary} Starting transform (Milestone 2).`,
        'progress_update',
      );

      // Deliver Milestone 1 — fetch + validate
      if (m1Id) {
        await client.deliverMilestone(contractId, m1Id, { note: extractSummary });
      }

      setJob(contractId, {
        ...getJob(contractId)!,
        status: 'transforming',
        currentMilestoneIndex: 1,
        updatedAt: new Date().toISOString(),
      });

      // --- Normalize ---
      const normalizeStart = Date.now();
      const normalizeStats = normalizeRows(extractedRows, config.transformRules);
      log.info({ durationMs: Date.now() - normalizeStart }, 'transform phase complete');

      await client.sendMessage(
        contractId,
        `Transform complete. ${normalizeStats.summary} Preparing delivery (Milestone 3).`,
        'progress_update',
      );

      // Deliver Milestone 2 — transform
      if (m2Id) {
        await client.deliverMilestone(contractId, m2Id, { note: normalizeStats.summary });
      }

      setJob(contractId, {
        ...getJob(contractId)!,
        status: 'delivering',
        currentMilestoneIndex: 2,
        updatedAt: new Date().toISOString(),
      });

      // --- Deliver output (Milestone 3) ---
      const deliverStart = Date.now();
      const deliveryResult = await deliverOutput(
        contractId,
        m3Id ?? '',
        normalizeStats.rows,
        config,
        normalizeStats,
        { client, apiKey: anthropicApiKey, logger: log },
      );

      if (!deliveryResult.delivered) {
        await client.sendMessage(
          contractId,
          'The transform produced zero output rows. Could you clarify the expected data or check the source? I can re-run once the issue is identified.',
          'clarification_request',
        );

        setJob(contractId, {
          ...getJob(contractId)!,
          status: 'error',
          updatedAt: new Date().toISOString(),
        });
        return;
      }

      setJob(contractId, {
        ...getJob(contractId)!,
        status: 'complete',
        updatedAt: new Date().toISOString(),
      });

      log.info({ durationMs: Date.now() - deliverStart }, 'ETL pipeline complete');
    } catch (err) {
      log.error({ err }, 'ETL pipeline failed');

      const existing = getJob(contractId);
      if (existing) {
        setJob(contractId, {
          ...existing,
          status: 'error',
          updatedAt: new Date().toISOString(),
        });
      }
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

    // Stash the gig + contract; do not run the ETL pipeline until escrow is
    // funded. milestone.funded picks this up and calls executeAcceptedFlow.
    setJob(contractId, {
      gigId,
      contractId,
      inputType: 'unknown',
      status: 'awaiting_funding',
      currentMilestoneIndex: 0,
      updatedAt: new Date().toISOString(),
      pendingAcceptance: { gig, contract },
    });

    try {
      await client.sendMessage(
        contractId,
        'Proposal accepted. Work will begin as soon as escrow is funded.',
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
    setJob(contractId, { ...job, status: 'fetching', updatedAt: new Date().toISOString() });
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
        serviceName: 'FlowBot',
        contractId,
        reason,
        mcp: mcpClient,
        alerter,
        logger,
      });
      return;
    }
  });

  // NOTE: the prior `message.created` handler for invoice-batch URL ingestion
  // is removed in story 1.5. Platform does not dispatch message.* events as
  // webhooks (Group B: in-app/Telegram only). Reintroducing this needs a
  // polling pull from /threads/:id/messages or a different ingestion path
  // (e.g. require the URL in the gig description). Tracked outside this epic.

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

  // All handlers are wired. Flip the webhook server out of "not ready" mode so
  // incoming deliveries dispatch to handlers instead of getting a 503 placeholder.
  webhookServer.markReady();

  // Start gig poller (webhook server was bound at the top of main())
  poller.start();
  negotiationPoller.start();
  repMonitor.start();

  logger.info({ botId: effectiveBotId, port }, 'FlowBot started');
  await alerter?.sendStartupAlert('FlowBot', effectiveBotId);

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown signal received');
    poller.stop();
    negotiationPoller.stop();
    repMonitor?.stop();
    await webhookServer.stop();
    logger.info('FlowBot stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void alerter
      ?.sendFatalAlert('FlowBot', effectiveBotId, err.message)
      .finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    logger.fatal({ reason }, 'unhandled rejection');
    void alerter?.sendFatalAlert('FlowBot', effectiveBotId, message).finally(() => process.exit(1));
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'FlowBot startup failed');
  process.exit(1);
});
