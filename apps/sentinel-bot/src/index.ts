import {
  AgentClient,
  createGigPoller,
  createWebhookServer,
  createProposer,
  createMessenger,
  registerBot,
  syncStandingOffers,
  ensureWebhookRegistered,
  shouldPropose,
  createLogger,
  withContext,
  createAlerter,
  type Gig,
  type Contract,
} from '@botguild/agent-core';
import { botProfile, scorerConfig, standingOffers, pricingCalc } from './config.js';
import { createGigParser } from './parser.js';
import { createScheduler } from './scheduler.js';
import { createComms } from './comms.js';
import { handleStandingOfferGig } from './standinghandler.js';
import { loadStore, listJobs as listStoredJobs } from './store.js';
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

  // Sync standing offers
  await syncStandingOffers({ client, offers: standingOffers, logger });

  // Ensure webhook registration
  await ensureWebhookRegistered({
    client,
    webhookBaseUrl,
    webhookSecret,
    events: [
      'gig.created',
      'gig.updated',
      'contract.created',
      'contract.updated',
      'message.created',
      'proposal.accepted',
      'milestone.accepted',
      'message.clarification_request',
      'contract.status.changed',
    ],
    logger,
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

  // Build webhook server
  const webhookServer = createWebhookServer({
    port,
    secret: webhookSecret,
    botId: effectiveBotId,
    logger,
  });

  // Register webhook event handlers
  webhookServer.on('proposal.accepted', async (event) => {
    const { gig, contract } = event.payload as { gig: Gig; contract: Contract };
    const log = withContext(logger, { gigId: gig.id, contractId: contract.id });

    const milestoneIds = contract.milestones.map((m: { id: string }) => m.id);
    const standingResult = handleStandingOfferGig(gig, contract.id, milestoneIds);

    if (standingResult.isStandingOffer && standingResult.needsClarification) {
      log.info('standing offer gig has no target URL — requesting clarification');
      try {
        await messenger.send(
          contract.id,
          standingResult.clarificationQuestion ?? 'Could you share the URL to monitor?',
          'clarification_request',
        );
      } catch (err) {
        log.error({ err }, 'failed to send clarification request for standing offer');
      }
      return;
    }

    if (standingResult.isStandingOffer && standingResult.config && standingResult.milestoneDates) {
      log.info('standing offer gig detected, skipping parser');

      try {
        await comms.packageStarted(
          contract.id,
          standingResult.config,
          standingResult.milestoneDates,
        );
      } catch (err) {
        log.warn({ err }, 'failed to send packageStarted message');
      }

      scheduler.addJob(standingResult.config);
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

    try {
      await comms.setupConfirmed(contract.id, config);
    } catch (err) {
      log.warn({ err }, 'failed to send setupConfirmed message');
    }

    scheduler.addJob(config);

    const firstCheckStart = Date.now();
    try {
      const summary = await scheduler.runOnce(config);
      log.info({ durationMs: Date.now() - firstCheckStart }, 'first check complete');
      await comms.firstCheckComplete(contract.id, config, summary);
    } catch (err) {
      log.warn({ err, durationMs: Date.now() - firstCheckStart }, 'immediate first check failed');
    }
  });

  webhookServer.on('milestone.accepted', async (event) => {
    logger.info({ payload: event.payload }, 'milestone accepted');
  });

  webhookServer.on('message.clarification_request', async (event) => {
    logger.info(
      { payload: event.payload },
      'clarification request received, awaiting human response',
    );
  });

  webhookServer.on('contract.status.changed', async (event) => {
    const { contract } = event.payload as { contract: Contract };
    if (contract.status === 'cancelled' || contract.status === 'completed') {
      scheduler.removeJob(contract.id);
      logger.info(
        { contractId: contract.id, status: contract.status },
        'job removed due to contract status change',
      );
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
  // prior run, so a restart doesn't silently stop monitoring.
  for (const persisted of listStoredJobs()) {
    if (!persisted.watchConfig) continue;
    const cfg = persisted.watchConfig as WatchJobConfig;
    if (!cfg.contractId || !cfg.targets || cfg.targets.length === 0) continue;
    logger.info(
      { contractId: persisted.contractId },
      'restoring scheduled watch job from persisted store',
    );
    scheduler.addJob(cfg);
  }

  // Start services
  await webhookServer.start();
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
