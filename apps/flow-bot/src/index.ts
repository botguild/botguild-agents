import pino from 'pino';
import {
  AgentClient,
  createGigPoller,
  createWebhookServer,
  createProposer,
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
import { extractCsv } from './extractors/csv.js';
import { extractPdf } from './extractors/pdf.js';
import { extractApi } from './extractors/api.js';
import { normalizeRows } from './normalizer.js';
import { deliverOutput } from './delivery.js';
import { loadStore, setJob, getJob } from './store.js';
import { handleFlowStandingGig } from './standinghandler.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = pino({ name: 'flow-bot' });

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

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info('FlowBot starting up');

  loadStore();

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
    events: [
      'gig.created',
      'gig.updated',
      'contract.created',
      'contract.updated',
      'proposal.accepted',
      'milestone.accepted',
      'contract.status.changed',
    ],
    logger,
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
    logger,
  });

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
    const contractId = contract.id;
    const milestoneIds = contract.milestones.map((m) => m.id);
    const [m1Id, m2Id, m3Id] = milestoneIds;

    try {
      const standingResult = handleFlowStandingGig(gig, contractId, milestoneIds);

      if (standingResult.isStandingOffer && standingResult.config) {
        const standingConfig = standingResult.config;

        await client.sendMessage(
          contractId,
          `Standing offer package started: ${standingConfig.inputType} sync. ${standingResult.milestoneLabels?.length ?? 0} milestones scheduled.`,
          'progress_update',
        );

        setJob(contractId, {
          gigId: gig.id,
          contractId,
          inputType: standingConfig.inputType,
          status: 'fetching',
          currentMilestoneIndex: 0,
          updatedAt: new Date().toISOString(),
        });

        if (standingConfig.inputType !== 'pdf') {
          logger.info(
            { gigId: gig.id, contractId, inputType: standingConfig.inputType },
            'data-sync standing offer: scheduled sync pipeline will run weekly; executing first milestone ETL run now',
          );

          let extractedRows: Record<string, unknown>[];

          if (standingConfig.inputType === 'csv' || standingConfig.inputType === 'sheet') {
            const csvResult = await extractCsv(standingConfig.inputSource, { logger });
            extractedRows = csvResult.rows;
          } else {
            const apiResult = await extractApi({
              url: standingConfig.inputSource,
              paginationStyle: 'offset',
              logger,
            });
            extractedRows = apiResult.records;
          }

          const normalizeStats = normalizeRows(extractedRows, standingConfig.transformRules);
          const firstMilestoneId = standingConfig.milestoneIds[0];

          await deliverOutput(
            contractId,
            firstMilestoneId ?? '',
            normalizeStats.rows,
            standingConfig,
            normalizeStats,
            { client, apiKey: anthropicApiKey, logger },
          );

          setJob(contractId, {
            ...getJob(contractId)!,
            status: 'complete',
            updatedAt: new Date().toISOString(),
          });

          logger.info({ contractId, gigId: gig.id }, 'data-sync standing offer: first milestone ETL run complete');
        } else {
          const pdfResult = await extractPdf(standingConfig.inputSource, standingConfig.targetSchema, {
            apiKey: anthropicApiKey,
            logger,
          });

          const normalizeStats = normalizeRows(pdfResult.rows, standingConfig.transformRules);
          const firstMilestoneId = standingConfig.milestoneIds[0];

          await deliverOutput(
            contractId,
            firstMilestoneId ?? '',
            normalizeStats.rows,
            standingConfig,
            normalizeStats,
            { client, apiKey: anthropicApiKey, logger },
          );

          setJob(contractId, {
            ...getJob(contractId)!,
            status: 'complete',
            updatedAt: new Date().toISOString(),
          });

          logger.info({ contractId, gigId: gig.id }, 'invoice-batch standing offer: extraction pipeline complete');
        }

        return;
      }

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

      logger.info(
        { gigId: gig.id, contractId, inputType: config.inputType, milestoneIds: config.milestoneIds },
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

      if (config.inputType === 'csv' || config.inputType === 'sheet') {
        const csvResult = await extractCsv(config.inputSource, { logger });
        extractedRows = csvResult.rows;
        extractSummary = csvResult.summary;
      } else if (config.inputType === 'pdf') {
        const pdfResult = await extractPdf(config.inputSource, config.targetSchema, {
          apiKey: anthropicApiKey,
          logger,
        });
        extractedRows = pdfResult.rows;
        extractSummary = pdfResult.summary;
      } else {
        const apiResult = await extractApi({
          url: config.inputSource,
          paginationStyle: 'offset',
          logger,
        });
        extractedRows = apiResult.records;
        extractSummary = apiResult.summary;
      }

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
      const normalizeStats = normalizeRows(extractedRows, config.transformRules);

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
      const deliveryResult = await deliverOutput(
        contractId,
        m3Id ?? '',
        normalizeStats.rows,
        config,
        normalizeStats,
        { client, apiKey: anthropicApiKey, logger },
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

      logger.info({ contractId, gigId: gig.id }, 'ETL pipeline complete');
    } catch (err) {
      logger.error({ err, gigId: gig.id, contractId }, 'ETL pipeline failed');

      const existing = getJob(contractId);
      if (existing) {
        setJob(contractId, {
          ...existing,
          status: 'error',
          updatedAt: new Date().toISOString(),
        });
      }
    }
  });

  webhookServer.on('milestone.accepted', async (event) => {
    logger.info({ payload: event.payload }, 'milestone accepted');
  });

  webhookServer.on('contract.status.changed', async (event) => {
    const { contract } = event.payload as { contract: Contract };
    logger.info(
      { contractId: contract.id, status: contract.status },
      'contract status changed',
    );
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

  logger.info({ botId: effectiveBotId, port }, 'FlowBot started');

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown signal received');
    poller.stop();
    await webhookServer.stop();
    logger.info('FlowBot stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'FlowBot startup failed');
  process.exit(1);
});
