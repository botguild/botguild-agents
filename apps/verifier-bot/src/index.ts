import cron from 'node-cron';
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
  loadWebhookSecret,
  saveWebhookSecret,
  type Gig,
  type Contract,
} from '@botguild/agent-core';
import { botProfile, scorerConfig, standingOffers, pricingCalc } from './config.js';
import { createGigParser } from './parser.js';
import { runHttpCheck } from './runners/http.js';
import { runDomChecks } from './runners/dom.js';
import { runDataQualityChecks } from './runners/data.js';
import { runAcceptanceAudit } from './runners/audit.js';
import { generateAndDeliverReport } from './report.js';
import { loadStore, setJob, getJob, listJobs as listStoredJobs } from './store.js';
import { handleVerifierStandingGig, VERIFIER_OFFER_RULES } from './standinghandler.js';
import type { CheckResult } from './runners/http.js';
import type { AuditVerdict } from './runners/audit.js';
import type { ScheduledTask } from 'node-cron';
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
// Nightly cron job registry
// ---------------------------------------------------------------------------

const nightlyJobs = new Map<string, { checkTask: ScheduledTask; milestoneTask: ScheduledTask }>();

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
  // If registerBot / syncStandingOffers / ensureWebhookRegistered hang or
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
  logger = createLogger({ service: 'verifier-bot', botId: effectiveBotId });

  const alerter =
    telegramToken && telegramChatId
      ? createAlerter({ botToken: telegramToken, chatId: telegramChatId, logger })
      : null;

  // Build the API client
  const client = new AgentClient({ apiUrl, apiKey, botId: effectiveBotId, logger });

  // Sync standing offers
  await syncStandingOffers({ client, offers: standingOffers, logger });

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

    // --- Standing offer detection ---
    const standingResult = handleVerifierStandingGig(gig, contractId, milestoneIds);

    if (standingResult.isStandingOffer && standingResult.needsClarification) {
      log.info('standing-offer gig has no target URL — requesting clarification');
      try {
        await client.sendMessage(
          contractId,
          standingResult.clarificationQuestion ?? 'Could you share the URL(s) to verify?',
          'clarification_request',
        );
      } catch (err) {
        log.error({ err }, 'failed to send clarification request for standing offer');
      }
      return;
    }

    if (standingResult.isStandingOffer && standingResult.plan && standingResult.standingType) {
      const { plan, standingType } = standingResult;

      log.info(
        { standingType, criteriaCount: plan.criteriaList.length },
        'standing offer gig detected',
      );

      await client.sendMessage(
        contractId,
        `Standing offer accepted: ${standingType}. Running ${plan.criteriaList.length} criteria.`,
        'progress_update',
      );

      setJob(contractId, {
        gigId: gig.id,
        contractId,
        checkType: plan.checkType,
        status: 'running',
        checkResults: [],
        updatedAt: new Date().toISOString(),
        standingType,
        standingPlan: plan,
        milestoneIndex: 0,
      });

      if (standingType === 'smoke-test') {
        registerSmokeTestCron(contractId, gig.id, plan, log);
      } else if (standingType === 'acceptance-review') {
        const allCheckResults: CheckResult[] = [];
        const allAuditVerdicts: AuditVerdict[] = [];

        const claudeCriteria = plan.criteriaList.filter((c) => c.checkMethod === 'claude');
        if (claudeCriteria.length > 0) {
          const deliverableContent = plan.targets[0] ?? '';
          const auditCriteria = claudeCriteria.map((c) => ({
            criterionId: c.id,
            description: c.description,
            expected: c.expected,
          }));
          const auditStart = Date.now();
          try {
            const auditResult = await runAcceptanceAudit(deliverableContent, auditCriteria, {
              apiKey: anthropicApiKey,
              logger: log,
            });
            allCheckResults.push(...auditResult.checkResults);
            allAuditVerdicts.push(...auditResult.auditVerdicts);
            log.info({ durationMs: Date.now() - auditStart }, 'acceptance audit complete');
          } catch (err) {
            log.error({ err, durationMs: Date.now() - auditStart }, 'acceptance audit failed');
          }
        }

        const passCount = allCheckResults.filter((r) => r.verdict === 'pass').length;
        const failCount = allCheckResults.filter((r) => r.verdict === 'fail').length;

        await client.sendMessage(
          contractId,
          `Acceptance audit complete. ${passCount} passed, ${failCount} failed. Generating report.`,
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

        const milestoneId = plan.milestoneIds[0] ?? '';
        const reportStart = Date.now();
        await generateAndDeliverReport(
          contractId,
          milestoneId,
          allCheckResults,
          allAuditVerdicts,
          [],
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
          'acceptance review pipeline complete',
        );
      }

      return;
    }

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
        await client.deliverMilestone(contractId, milestone1Id, {
          note: `Run Checks: starting ${plan.checkType} checks for ${plan.criteriaList.length} criteria.`,
        });
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
    const { contractId, newStatus } = event.payload as {
      contractId?: string;
      newStatus?: string;
    };
    if (!contractId) {
      logger.warn({ payload: event.payload }, 'contract.status.changed missing contractId');
      return;
    }
    logger.info({ contractId, status: newStatus }, 'contract status changed');
    if (newStatus === 'completed' || newStatus === 'cancelled') {
      const tasks = nightlyJobs.get(contractId);
      if (tasks) {
        tasks.checkTask.stop();
        tasks.milestoneTask.stop();
        nightlyJobs.delete(contractId);
        logger.info({ contractId }, 'stopped nightly cron tasks for ended contract');
      }
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

  // Restore nightly cron jobs for any in-flight smoke-test standing-offer
  // contracts persisted before this restart, so the bot resumes instead of
  // silently dropping coverage.
  for (const persisted of listStoredJobs()) {
    if (persisted.standingType !== 'smoke-test' || !persisted.standingPlan) continue;
    if (persisted.status === 'complete' || persisted.status === 'error') continue;
    const log = withContext(logger, { gigId: persisted.gigId, contractId: persisted.contractId });
    log.info('restoring nightly smoke-test cron from persisted store');
    registerSmokeTestCron(
      persisted.contractId,
      persisted.gigId,
      persisted.standingPlan as Parameters<typeof registerSmokeTestCron>[2],
      log,
    );
  }

  // All handlers + persisted-job restore are wired. Flip the webhook server
  // out of "not ready" mode so incoming deliveries dispatch to handlers
  // instead of getting a 503 placeholder.
  webhookServer.markReady();

  // Start gig poller (webhook server was bound at the top of main())
  poller.start();

  logger.info({ botId: effectiveBotId, port }, 'VerifierBot started');
  await alerter?.sendStartupAlert('VerifierBot', effectiveBotId);

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown signal received');
    poller.stop();
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

  function registerSmokeTestCron(
    contractId: string,
    gigId: string,
    plan: import('./parser.js').CheckPlan,
    log: ReturnType<typeof withContext>,
  ): void {
    const rule = VERIFIER_OFFER_RULES['nightly smoke test package'];
    const existing = nightlyJobs.get(contractId);
    if (existing) {
      existing.checkTask.stop();
      existing.milestoneTask.stop();
    }

    const checkTask = cron.schedule(rule.checkSchedule!, async () => {
      log.info('nightly smoke check firing');
      const nightlyResults: CheckResult[] = [];
      const smokeStart = Date.now();
      for (const criterion of plan.criteriaList) {
        const target = plan.targets[0] ?? '';
        try {
          const httpConfig = buildHttpConfigFromCriterion(criterion, { logger: log });
          const checkResult = await runHttpCheck(
            target,
            criterion.id,
            criterion.description,
            httpConfig,
          );
          nightlyResults.push(checkResult);
        } catch (err) {
          log.error({ err, criterionId: criterion.id }, 'nightly http check failed');
        }
      }

      const existingState = getJob(contractId);
      setJob(contractId, {
        gigId,
        contractId,
        checkType: plan.checkType,
        status: existingState?.status ?? 'running',
        checkResults: [...(existingState?.checkResults ?? []), ...nightlyResults],
        updatedAt: new Date().toISOString(),
        standingType: 'smoke-test',
        standingPlan: plan,
        milestoneIndex: existingState?.milestoneIndex ?? 0,
      });

      const failCount = nightlyResults.filter((r) => r.verdict === 'fail').length;
      log.info(
        { durationMs: Date.now() - smokeStart, failCount, total: nightlyResults.length },
        'nightly smoke run complete',
      );
      if (failCount > 0) {
        await client.sendMessage(
          contractId,
          `Nightly smoke run: ${failCount} failure(s) detected out of ${nightlyResults.length} checks.`,
          'alert',
        );
      }
    });

    const milestoneTask = cron.schedule(rule.milestoneSchedule!, async () => {
      log.info('weekly milestone report firing');
      const existingState = getJob(contractId);
      const accumulatedResults = existingState?.checkResults ?? [];
      const idx = existingState?.milestoneIndex ?? 0;

      if (idx >= plan.milestoneIds.length) {
        log.info('all weekly milestones already delivered, stopping cron');
        checkTask.stop();
        milestoneTask.stop();
        nightlyJobs.delete(contractId);
        return;
      }

      const nextMilestoneId = plan.milestoneIds[idx];

      const reportStart = Date.now();
      try {
        await generateAndDeliverReport(contractId, nextMilestoneId, accumulatedResults, [], [], {
          client,
          apiKey: anthropicApiKey,
          logger: log,
        });
        log.info(
          {
            durationMs: Date.now() - reportStart,
            milestoneId: nextMilestoneId,
            milestoneIndex: idx,
          },
          'weekly milestone report delivered',
        );

        const newIdx = idx + 1;
        // Reset accumulated results so next week's report doesn't double-count.
        setJob(contractId, {
          gigId,
          contractId,
          checkType: plan.checkType,
          status: newIdx >= plan.milestoneIds.length ? 'complete' : 'running',
          checkResults: [],
          updatedAt: new Date().toISOString(),
          standingType: 'smoke-test',
          standingPlan: plan,
          milestoneIndex: newIdx,
        });

        if (newIdx >= plan.milestoneIds.length) {
          log.info('final weekly milestone delivered, stopping cron tasks');
          checkTask.stop();
          milestoneTask.stop();
          nightlyJobs.delete(contractId);
        }
      } catch (err) {
        log.error(
          { err, durationMs: Date.now() - reportStart },
          'weekly milestone report delivery failed',
        );
      }
    });

    nightlyJobs.set(contractId, { checkTask, milestoneTask });
    log.info('nightly smoke cron jobs registered');
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'VerifierBot startup failed');
  process.exit(1);
});
