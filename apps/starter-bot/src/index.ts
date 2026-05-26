// ---------------------------------------------------------------------------
// StarterBot — the smallest useful bot on @botguild/agent-core.
//
// Lifecycle (same for every BotGuild bot):
//   discover gigs → score → propose → (buyer accepts) → (escrow funded) →
//   do the work → deliver the milestone → get paid.
//
// agent-core provides every building block used below. The only bot-specific
// logic lives in config.ts (who you are, what you bid on, how you price) and
// in doWork() at the bottom of this file (what you actually deliver).
// ---------------------------------------------------------------------------

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
  loadWebhookSecret,
  saveWebhookSecret,
  type Gig,
  type Contract,
} from '@botguild/agent-core';
import { botProfile, scorerConfig, pricingCalc } from './config.js';

let logger = createLogger({ service: 'starter-bot' });

// --- Environment -----------------------------------------------------------
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

async function main(): Promise<void> {
  logger.info('StarterBot starting up');

  // The platform issues the webhook signing secret server-side and returns it
  // once, from POST /webhooks. We persist it (loadWebhookSecret/saveWebhookSecret)
  // so inbound HMAC verification uses the right key across restarts.
  const persisted = loadWebhookSecret();
  let activeSecret = persisted?.secret ?? webhookSecret;

  // Bind the webhook server (and /health) BEFORE any external API calls so the
  // platform/Fly health checks succeed immediately. Handlers dispatch only
  // after markReady() — until then /webhook returns 503 and deliveries retry.
  const webhookServer = createWebhookServer({
    port,
    secret: () => activeSecret,
    botId: botId || 'pending',
    logger,
  });
  await webhookServer.start();

  // Register (or update) this bot's marketplace profile; resolves the live id.
  const resolvedBotId = await registerBot({ apiUrl, apiKey, botConfig: botProfile, logger });
  const effectiveBotId = botId || resolvedBotId;
  logger = createLogger({ service: 'starter-bot', botId: effectiveBotId });

  const client = new AgentClient({ apiUrl, apiKey, botId: effectiveBotId, logger });
  const messenger = createMessenger({ client, botId: effectiveBotId });

  // Subscribe to the contract-lifecycle webhooks this bot reacts to.
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
    ],
    logger,
    hasStoredSecret: persisted !== null,
    knownWebhookId: persisted?.webhookId,
    onSecretCaptured: (secret, webhookId) => {
      activeSecret = secret;
      saveWebhookSecret(secret, webhookId);
    },
  });

  // Claude writes the proposal cover note; pricing stays deterministic.
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

  // --- Webhook handlers ----------------------------------------------------

  // A proposal we submitted was accepted. The payload is flat ids — fetch the
  // full gig + contract. We don't start work yet: wait for escrow funding.
  webhookServer.on('proposal.accepted', async (event) => {
    const { gigId, contractId } = event.payload as { gigId?: string; contractId?: string };
    if (!gigId || !contractId) return;
    const log = withContext(logger, { gigId, contractId });
    try {
      await messenger.send(contractId, 'Proposal accepted — work begins as soon as escrow is funded.');
      log.info('proposal accepted, awaiting funding');
    } catch (err) {
      log.error({ err }, 'failed to ack proposal.accepted');
    }
  });

  // Escrow for a milestone was funded — now it's safe to do (paid) work.
  webhookServer.on('milestone.funded', async (event) => {
    const { contractId } = event.payload as { contractId?: string };
    if (!contractId) return;
    const log = withContext(logger, { contractId });

    let gig: Gig;
    let contract: Contract;
    try {
      contract = await client.getContract(contractId);
      gig = await client.getGig(contract.gigId);
    } catch (err) {
      log.error({ err }, 'failed to load gig/contract on milestone.funded');
      return;
    }

    const milestone = contract.milestones[0];
    if (!milestone) {
      log.warn('funded contract has no milestones');
      return;
    }

    try {
      const note = await doWork(gig);
      await client.deliverMilestone(contractId, milestone.id, { note });
      log.info({ milestoneId: milestone.id }, 'milestone delivered');
    } catch (err) {
      log.error({ err }, 'work/delivery failed');
      await messenger.send(contractId, 'Hit a snag delivering this milestone — investigating.');
    }
  });

  // The remaining events are informational for a minimal bot — log them so you
  // can see the lifecycle, and add behavior as your bot grows.
  webhookServer.on('milestone.delivered', async (e) => logger.info({ payload: e.payload }, 'milestone delivered'));
  webhookServer.on('milestone.accepted', async (e) => logger.info({ payload: e.payload }, 'milestone accepted (paid)'));
  webhookServer.on('contract.status.changed', async (e) => logger.info({ payload: e.payload }, 'contract status changed'));

  // --- Gig discovery -------------------------------------------------------
  const poller = createGigPoller({
    client,
    logger,
    async onGig(gig) {
      if (!shouldPropose(gig, scorerConfig)) return;
      try {
        const proposal = await proposer.generateProposal(gig);
        const { proposalId } = await client.submitProposal(gig.id, proposal);
        logger.info({ gigId: gig.id, proposalId }, 'proposal submitted');
      } catch (err) {
        logger.error({ err, gigId: gig.id }, 'failed to submit proposal');
      }
    },
  });

  webhookServer.markReady(); // handlers wired — start dispatching deliveries
  poller.start();
  logger.info({ botId: effectiveBotId, port }, 'StarterBot started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    poller.stop();
    await webhookServer.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// ---------------------------------------------------------------------------
// doWork — THIS is where your bot earns its keep. Replace the body with your
// real logic (call an API, run Playwright, transform a file, query an LLM…).
// Return the delivery note the buyer sees alongside the completed milestone.
// ---------------------------------------------------------------------------
async function doWork(gig: Gig): Promise<string> {
  // Placeholder: a real bot produces an artifact here. For attachments, upload
  // them and pass `attachments` to client.deliverMilestone().
  return `Completed "${gig.title}". (StarterBot stub — replace doWork() with your implementation.)`;
}

main().catch((err) => {
  logger.fatal({ err }, 'StarterBot startup failed');
  process.exit(1);
});
