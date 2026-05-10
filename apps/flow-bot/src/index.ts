import {
  AgentClient,
  createGigPoller,
  createWebhookServer,
  createProposer,
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
import { extractCsv } from './extractors/csv.js';
import { extractPdf } from './extractors/pdf.js';
import { extractApi } from './extractors/api.js';
import { normalizeRows } from './normalizer.js';
import { deliverOutput } from './delivery.js';
import { loadStore, setJob, getJob, listJobs } from './store.js';
import { handleFlowStandingGig } from './standinghandler.js';
import cron from 'node-cron';

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

// Active weekly cron tasks for data-sync standing offers, keyed by contractId.
const weeklyTasks = new Map<string, ReturnType<typeof cron.schedule>>();

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
  logger = createLogger({ service: 'flow-bot', botId: effectiveBotId });

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
      'proposal.accepted',
      'milestone.accepted',
      'contract.status.changed',
      'message.created',
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
    const log = withContext(logger, { gigId: gig.id, contractId });
    const milestoneIds = contract.milestones.map((m) => m.id);
    const [m1Id, m2Id, m3Id] = milestoneIds;

    try {
      const standingResult = handleFlowStandingGig(gig, contractId, milestoneIds);

      if (standingResult.isStandingOffer && standingResult.config) {
        const standingConfig = standingResult.config;
        const isDataSync = standingResult.config.inputType !== 'pdf';

        // Invoice batch with no input URL — wait for thread message instead of running on example.com.
        if (!isDataSync && standingConfig.inputSource === 'pending') {
          setJob(contractId, {
            gigId: gig.id,
            contractId,
            inputType: standingConfig.inputType,
            status: 'awaiting_input',
            currentMilestoneIndex: 0,
            updatedAt: new Date().toISOString(),
            standing: {
              standingType: 'invoice-batch',
              inputSource: 'pending',
              outputFormat: standingConfig.outputFormat as 'csv' | 'json' | 'airtable',
              targetSchema: standingConfig.targetSchema,
              transformRules: standingConfig.transformRules as Record<string, unknown>,
              remainingMilestoneIds: standingConfig.milestoneIds,
            },
          });
          await client.sendMessage(
            contractId,
            'Invoice batch ready. Please share the link to the PDF folder or upload the invoices to this thread, and I will start processing.',
            'clarification_request',
          );
          return;
        }

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
          log.info(
            { inputType: standingConfig.inputType },
            'data-sync standing offer: scheduled sync pipeline will run weekly; executing first milestone ETL run now',
          );

          let extractedRows: Record<string, unknown>[];

          if (standingConfig.inputType === 'csv' || standingConfig.inputType === 'sheet') {
            const csvResult = await extractCsv(standingConfig.inputSource, { logger: log });
            extractedRows = csvResult.rows;
          } else {
            const apiResult = await extractApi({
              url: standingConfig.inputSource,
              paginationStyle: 'offset',
              logger: log,
            });
            extractedRows = apiResult.records;
          }

          const normalizeStats = normalizeRows(extractedRows, standingConfig.transformRules);
          const [firstMilestoneId, ...rest] = standingConfig.milestoneIds;

          const deliverStart = Date.now();
          await deliverOutput(
            contractId,
            firstMilestoneId ?? '',
            normalizeStats.rows,
            standingConfig,
            normalizeStats,
            { client, apiKey: anthropicApiKey, logger: log },
          );

          if (rest.length > 0) {
            setJob(contractId, {
              gigId: gig.id,
              contractId,
              inputType: standingConfig.inputType,
              status: 'recurring',
              currentMilestoneIndex: 1,
              updatedAt: new Date().toISOString(),
              standing: {
                standingType: 'data-sync',
                inputSource: standingConfig.inputSource,
                outputFormat: standingConfig.outputFormat as 'csv' | 'json' | 'airtable',
                targetSchema: standingConfig.targetSchema,
                transformRules: standingConfig.transformRules as Record<string, unknown>,
                remainingMilestoneIds: rest,
              },
            });
            scheduleWeeklyDataSync(contractId, gig.id, client, log);
            log.info(
              { durationMs: Date.now() - deliverStart, remaining: rest.length },
              'data-sync standing offer: first milestone delivered, weekly cron scheduled',
            );
          } else {
            setJob(contractId, {
              ...getJob(contractId)!,
              status: 'complete',
              updatedAt: new Date().toISOString(),
            });
            log.info(
              { durationMs: Date.now() - deliverStart },
              'data-sync standing offer: complete',
            );
          }
        } else {
          const pdfResult = await extractPdf(
            standingConfig.inputSource,
            standingConfig.targetSchema,
            {
              apiKey: anthropicApiKey,
              logger: log,
            },
          );

          const normalizeStats = normalizeRows(pdfResult.rows, standingConfig.transformRules);
          const firstMilestoneId = standingConfig.milestoneIds[0];

          const deliverStart = Date.now();
          await deliverOutput(
            contractId,
            firstMilestoneId ?? '',
            normalizeStats.rows,
            standingConfig,
            normalizeStats,
            { client, apiKey: anthropicApiKey, logger: log },
          );

          setJob(contractId, {
            ...getJob(contractId)!,
            status: 'complete',
            updatedAt: new Date().toISOString(),
          });

          log.info(
            { durationMs: Date.now() - deliverStart },
            'invoice-batch standing offer: extraction pipeline complete',
          );
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
  });

  webhookServer.on('milestone.accepted', async (event) => {
    logger.info({ payload: event.payload }, 'milestone accepted');
  });

  webhookServer.on('contract.status.changed', async (event) => {
    const { contract } = event.payload as { contract: Contract };
    logger.info({ contractId: contract.id, status: contract.status }, 'contract status changed');
    if (contract.status === 'completed' || contract.status === 'cancelled') {
      const task = weeklyTasks.get(contract.id);
      if (task) {
        task.stop();
        weeklyTasks.delete(contract.id);
        logger.info({ contractId: contract.id }, 'stopped weekly cron for ended contract');
      }
    }
  });

  // Pick up source URLs that arrive via the contract thread (e.g. invoice batch attachments).
  webhookServer.on('message.created', async (event) => {
    const { contractId, content } = event.payload as { contractId: string; content: string };
    const job = getJob(contractId);
    if (!job || job.status !== 'awaiting_input' || !job.standing) return;
    const url = extractFirstUrl(content);
    if (!url) return;

    const log = withContext(logger, { gigId: job.gigId, contractId });
    log.info({ url }, 'received input URL via message.created, resuming invoice batch');

    setJob(contractId, { ...job, status: 'fetching', updatedAt: new Date().toISOString() });
    try {
      const pdfResult = await extractPdf(url, job.standing.targetSchema, {
        apiKey: anthropicApiKey,
        logger: log,
      });
      const normalizeStats = normalizeRows(pdfResult.rows, job.standing.transformRules as never);
      const milestoneId = job.standing.remainingMilestoneIds[0] ?? '';
      await deliverOutput(
        contractId,
        milestoneId,
        normalizeStats.rows,
        {
          gigId: job.gigId,
          contractId,
          inputType: 'pdf',
          inputSource: url,
          targetSchema: job.standing.targetSchema as never,
          transformRules: job.standing.transformRules as never,
          outputFormat: job.standing.outputFormat,
          milestoneIds: job.standing.remainingMilestoneIds,
          confidence: 1,
        },
        normalizeStats,
        { client, apiKey: anthropicApiKey, logger: log },
      );
      setJob(contractId, {
        ...getJob(contractId)!,
        status: 'complete',
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      log.error({ err }, 'failed to process input URL from message');
      setJob(contractId, { ...job, status: 'error', updatedAt: new Date().toISOString() });
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

  // Resume weekly cron jobs for any data-sync standing-offer contracts
  // that were mid-run before this restart.
  for (const job of listJobs()) {
    if (
      job.status === 'recurring' &&
      job.standing?.standingType === 'data-sync' &&
      job.standing.remainingMilestoneIds.length > 0
    ) {
      const log = withContext(logger, { gigId: job.gigId, contractId: job.contractId });
      log.info(
        { remaining: job.standing.remainingMilestoneIds.length },
        'restoring weekly data-sync cron from persisted store',
      );
      scheduleWeeklyDataSync(job.contractId, job.gigId, client, log);
    }
  }

  // Start services
  await webhookServer.start();
  poller.start();

  logger.info({ botId: effectiveBotId, port }, 'FlowBot started');
  await alerter?.sendStartupAlert('FlowBot', effectiveBotId);

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

function extractFirstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s,)]+/);
  return m ? m[0] : null;
}

function scheduleWeeklyDataSync(
  contractId: string,
  gigId: string,
  client: AgentClient,
  log: ReturnType<typeof withContext>,
): void {
  const existing = weeklyTasks.get(contractId);
  if (existing) existing.stop();

  const task = cron.schedule('0 9 * * 1', async () => {
    const job = getJob(contractId);
    if (!job?.standing || job.status !== 'recurring') return;
    const remaining = job.standing.remainingMilestoneIds;
    if (remaining.length === 0) {
      task.stop();
      weeklyTasks.delete(contractId);
      return;
    }

    const [milestoneId, ...rest] = remaining;
    log.info({ milestoneId, remainingAfter: rest.length }, 'data-sync weekly run starting');
    try {
      const inputType = job.inputType as 'csv' | 'sheet' | 'api' | 'json' | 'pdf';
      let extractedRows: Record<string, unknown>[];
      if (inputType === 'csv' || inputType === 'sheet') {
        const r = await extractCsv(job.standing.inputSource, { logger: log });
        extractedRows = r.rows;
      } else {
        const r = await extractApi({
          url: job.standing.inputSource,
          paginationStyle: 'offset',
          logger: log,
        });
        extractedRows = r.records;
      }
      const normalizeStats = normalizeRows(extractedRows, job.standing.transformRules as never);
      await deliverOutput(
        contractId,
        milestoneId,
        normalizeStats.rows,
        {
          gigId,
          contractId,
          inputType: inputType === 'json' ? 'api' : inputType,
          inputSource: job.standing.inputSource,
          targetSchema: job.standing.targetSchema as never,
          transformRules: job.standing.transformRules as never,
          outputFormat: job.standing.outputFormat,
          milestoneIds: remaining,
          confidence: 1,
        },
        normalizeStats,
        { client, apiKey: anthropicApiKey, logger: log },
      );

      const updated: typeof job = {
        ...job,
        status: rest.length === 0 ? 'complete' : 'recurring',
        currentMilestoneIndex: job.currentMilestoneIndex + 1,
        updatedAt: new Date().toISOString(),
        standing: { ...job.standing, remainingMilestoneIds: rest },
      };
      setJob(contractId, updated);

      if (rest.length === 0) {
        task.stop();
        weeklyTasks.delete(contractId);
        log.info('data-sync standing offer: all milestones delivered, cron stopped');
      }
    } catch (err) {
      log.error({ err }, 'data-sync weekly run failed; will retry next week');
    }
  });

  weeklyTasks.set(contractId, task);
}

main().catch((err) => {
  logger.fatal({ err }, 'FlowBot startup failed');
  process.exit(1);
});
