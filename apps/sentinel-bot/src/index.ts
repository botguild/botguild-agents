import pino from 'pino';
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
  type Gig,
  type Contract,
} from '@botguild/agent-core';
import {
  botProfile,
  scorerConfig,
  standingOffers,
  pricingCalc,
} from './config.js';
import { createGigParser } from './parser.js';
import { createScheduler } from './scheduler.js';
import { createComms } from './comms.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'sentinel-bot' });

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

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info('SentinelBot starting up');

  // Register / patch bot profile; resolves the live botId
  const resolvedBotId = await registerBot({
    apiUrl,
    apiKey,
    botConfig: botProfile,
    logger,
  });

  const effectiveBotId = botId || resolvedBotId;

  // Build the API client
  const client = new AgentClient({ apiUrl, apiKey, botId: effectiveBotId, logger });

  // Sync standing offers
  await syncStandingOffers({ client, offers: standingOffers, logger });

  // Ensure webhook registration
  await ensureWebhookRegistered({
    client,
    webhookBaseUrl,
    webhookSecret,
    events: ['gig.created', 'gig.updated', 'contract.created', 'contract.updated', 'message.created', 'proposal.accepted', 'milestone.accepted', 'message.clarification_request', 'contract.status.changed'],
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

    let parseResult;
    try {
      parseResult = await parser.parse(gig, contract.id);
    } catch (err) {
      logger.error({ err, gigId: gig.id, contractId: contract.id }, 'failed to parse gig on proposal.accepted');
      return;
    }

    const { config, needsClarification, clarificationQuestion } = parseResult;

    if (needsClarification) {
      const question = clarificationQuestion ?? 'Could you provide more details about what you would like monitored?';
      try {
        await messenger.send(contract.id, question, 'clarification_request');
      } catch (err) {
        logger.error({ err, contractId: contract.id }, 'failed to send clarification request');
      }
      return;
    }

    try {
      await comms.setupConfirmed(contract.id, config);
    } catch (err) {
      logger.warn({ err, contractId: contract.id }, 'failed to send setupConfirmed message');
    }

    scheduler.addJob(config);

    try {
      const summary = await scheduler.runOnce(config);
      await comms.firstCheckComplete(contract.id, config, summary);
    } catch (err) {
      logger.warn({ err, contractId: contract.id }, 'immediate first check failed');
    }
  });

  webhookServer.on('milestone.accepted', async (event) => {
    logger.info({ payload: event.payload }, 'milestone accepted');
  });

  webhookServer.on('message.clarification_request', async (event) => {
    logger.info({ payload: event.payload }, 'clarification request received, awaiting human response');
  });

  webhookServer.on('contract.status.changed', async (event) => {
    const { contract } = event.payload as { contract: Contract };
    if (contract.status === 'cancelled' || contract.status === 'completed') {
      scheduler.removeJob(contract.id);
      logger.info({ contractId: contract.id, status: contract.status }, 'job removed due to contract status change');
    }
  });

  // Build gig poller
  const poller = createGigPoller({
    client,
    category: scorerConfig.category,
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

  // Start services
  await webhookServer.start();
  poller.start();

  logger.info({ botId: effectiveBotId, port }, 'SentinelBot started');

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
}

main().catch((err) => {
  logger.fatal({ err }, 'SentinelBot startup failed');
  process.exit(1);
});
