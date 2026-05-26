import {
  AgentClient,
  createGigPoller,
  createWebhookServer,
  createProposer,
  createMessenger,
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
  type Gig,
  type Contract,
} from '@botguild/agent-core';
import { botProfile, scorerConfig, pricingCalc } from './config.js';
import { createGigParser } from './parser.js';
import { createScheduler } from './scheduler.js';
import { createComms } from './comms.js';
import { loadStore, listJobs as listStoredJobs, getJob, setJob, type JobState } from './store.js';
import type { WatchJobConfig } from './parser.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

let logger = createLogger({ service: 'sentinel-bot' });

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
const port = parseInt(process.env['PORT'] ?? '3000', 10);
const telegramToken = process.env['TELEGRAM_BOT_TOKEN'];
const telegramChatId = process.env['TELEGRAM_CHAT_ID'];

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info('SentinelBot starting up');

  loadStore();

  // The platform generates the webhook secret server-side and ignores the one
  // we send in POST /webhooks. Our env-var BOTGUILD_WEBHOOK_SECRET never
  // matches the platform's signing secret, so inbound HMAC verification fails
  // every real delivery. Capture the platform-issued secret from the POST
  // response and persist it; the webhook server reads it via the getter.
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
  const webhookServer = createWebhookServer({
    port,
    secret: () => activeSecret,
    botId: botId || 'pending',
    logger,
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
  logger = createLogger({ service: 'sentinel-bot', botId: effectiveBotId });

  const alerter =
    telegramToken && telegramChatId
      ? createAlerter({ botToken: telegramToken, chatId: telegramChatId, logger })
      : null;

  // Build the API client
  const client = new AgentClient({ apiUrl, apiKey, botId: effectiveBotId, logger });
  const mcpClient = new AgentMcpClient({ apiUrl, apiKey, logger });

  // Ensure webhook registration. When the platform issues a fresh secret
  // (i.e. we hit POST /webhooks), capture and persist it so HMAC
  // verification of inbound deliveries can use the right key.
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
    logger,
  });

  // Build gig parser
  const parser = createGigParser({ apiKey: anthropicApiKey, logger });

  // Build messenger
  const messenger = createMessenger({ client, botId: effectiveBotId });

  // Build comms
  const comms = createComms(messenger);

  // Build scheduler
  const scheduler = createScheduler({ client, apiKey: anthropicApiKey, logger });

  // Persist a parsed plan in the store with lifecycle='awaiting_funding'. The
  // actual cron schedule + first check don't run until milestone.funded fires.
  function queueForFunding(gigId: string, contractId: string, config: WatchJobConfig): void {
    const existing = getJob(contractId);
    setJob(contractId, {
      ...(existing ?? ({} as Partial<JobState>)),
      gigId,
      contractId,
      status: existing?.status ?? 'unknown',
      lastCheckedAt: existing?.lastCheckedAt ?? new Date().toISOString(),
      watchConfig: config,
      lifecycle: 'awaiting_funding',
    } as JobState);
  }

  // Execute kickoff: schedule cron + run first check.
  // Idempotent: marks the job 'active' so repeated milestone.funded deliveries
  // don't double-execute.
  async function startWatchJob(contractId: string): Promise<void> {
    const job = getJob(contractId);
    if (!job || !job.watchConfig) {
      logger.info({ contractId }, 'milestone.funded with no queued plan, ignoring');
      return;
    }
    if (job.lifecycle === 'active') {
      logger.info({ contractId }, 'milestone.funded received but job already active');
      return;
    }

    // Flip lifecycle synchronously BEFORE any awaits so a concurrent
    // milestone.funded delivery for the same contract can't pass the guard
    // above and double-schedule the cron or double-run the first check.
    setJob(contractId, { ...job, lifecycle: 'active' });

    const config = job.watchConfig as WatchJobConfig;
    const log = withContext(logger, { gigId: job.gigId, contractId });

    try {
      await comms.setupConfirmed(contractId, config);
    } catch (err) {
      log.warn({ err }, 'failed to send setupConfirmed message');
    }

    scheduler.addJob(config);

    const firstCheckStart = Date.now();
    try {
      const summary = await scheduler.runOnce(config);
      log.info({ durationMs: Date.now() - firstCheckStart }, 'first check complete');
      await comms.firstCheckComplete(contractId, config, summary);
    } catch (err) {
      log.warn({ err, durationMs: Date.now() - firstCheckStart }, 'immediate first check failed');
    }
  }

  // Register webhook event handlers
  webhookServer.on('proposal.accepted', async (event) => {
    // The platform sends a flat ID payload, not nested entities. Fetch the
    // full gig + contract by id before doing anything that needs their fields.
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

    let parseResult;
    const parseStart = Date.now();
    try {
      parseResult = await parser.parse(gig, contract.id);
    } catch (err) {
      log.error(
        { err, durationMs: Date.now() - parseStart },
        'failed to parse gig on proposal.accepted',
      );
      return;
    }

    const { config, needsClarification, clarificationQuestion } = parseResult;

    if (needsClarification) {
      const question =
        clarificationQuestion ??
        'Could you provide more details about what you would like monitored?';
      try {
        await messenger.send(contract.id, question, 'clarification_request');
      } catch (err) {
        log.error({ err }, 'failed to send clarification request');
      }
      return;
    }

    queueForFunding(gig.id, contract.id, config);
    try {
      await comms.queuedAwaitingFunding(contract.id, config);
    } catch (err) {
      log.warn({ err }, 'failed to send queuedAwaitingFunding message');
    }
  });

  webhookServer.on('milestone.funded', async (event) => {
    const payload = event.payload as { contractId?: string };
    const contractId = payload.contractId;
    if (!contractId) {
      logger.warn({ payload }, 'milestone.funded missing contractId');
      return;
    }
    logger.info({ contractId }, 'milestone funded, kicking off work');
    await startWatchJob(contractId);
  });

  webhookServer.on('milestone.delivered', async (event) => {
    logger.info({ payload: event.payload }, 'milestone delivered');
  });

  webhookServer.on('milestone.accepted', async (event) => {
    logger.info({ payload: event.payload }, 'milestone accepted');
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
    if (newStatus === 'disputed') {
      await handleDisputedContract({
        serviceName: 'SentinelBot',
        contractId,
        reason,
        mcp: mcpClient,
        alerter,
        logger,
      });
      return;
    }
    if (newStatus === 'cancelled' || newStatus === 'completed') {
      scheduler.removeJob(contractId);
      logger.info({ contractId, status: newStatus }, 'job removed due to contract status change');
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

  // Restore cron schedules for any active watch contracts persisted from a
  // prior run, so a restart doesn't silently stop monitoring. Jobs still in
  // 'awaiting_funding' are deliberately skipped — they'll resume when the
  // pending milestone.funded webhook arrives.
  for (const persisted of listStoredJobs()) {
    if (!persisted.watchConfig) continue;
    if (persisted.lifecycle === 'awaiting_funding') {
      logger.info(
        { contractId: persisted.contractId },
        'persisted job still awaiting funding, skipping cron restore',
      );
      continue;
    }
    const cfg = persisted.watchConfig as WatchJobConfig;
    if (!cfg.contractId || !cfg.targets || cfg.targets.length === 0) continue;
    logger.info(
      { contractId: persisted.contractId },
      'restoring scheduled watch job from persisted store',
    );
    scheduler.addJob(cfg);
  }

  // All handlers + persisted-job restore are wired. Flip the webhook server
  // out of "not ready" mode so incoming deliveries dispatch to handlers
  // instead of getting a 503 placeholder.
  webhookServer.markReady();

  // Start gig poller (webhook server was bound at the top of main())
  poller.start();

  logger.info({ botId: effectiveBotId, port }, 'SentinelBot started');
  await alerter?.sendStartupAlert('SentinelBot', effectiveBotId);

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown signal received');
    poller.stop();
    await webhookServer.stop();
    logger.info('SentinelBot stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void alerter
      ?.sendFatalAlert('SentinelBot', effectiveBotId, err.message)
      .finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    logger.fatal({ reason }, 'unhandled rejection');
    void alerter
      ?.sendFatalAlert('SentinelBot', effectiveBotId, message)
      .finally(() => process.exit(1));
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'SentinelBot startup failed');
  process.exit(1);
});
