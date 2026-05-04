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
import { runHttpCheck } from './runners/http.js';
import { runDomChecks } from './runners/dom.js';
import { runDataQualityChecks } from './runners/data.js';
import { runAcceptanceAudit } from './runners/audit.js';
import { generateAndDeliverReport } from './report.js';
import { loadStore, setJob, getJob } from './store.js';
import { handleVerifierStandingGig, VERIFIER_OFFER_RULES } from './standinghandler.js';
import type { CheckResult } from './runners/http.js';
import type { AuditVerdict } from './runners/audit.js';
import type { ScheduledTask } from 'node-cron';

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

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info('VerifierBot starting up');

  loadStore();

  // Register / patch bot profile; resolves the live botId
  const resolvedBotId = await registerBot({
    apiUrl,
    apiKey,
    botConfig: botProfile,
    logger,
  });

  const effectiveBotId = botId || resolvedBotId;
  logger = createLogger({ service: 'verifier-bot', botId: effectiveBotId });

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
    const log = withContext(logger, { gigId: gig.id, contractId });
    const milestoneIds = contract.milestones.map((m: { id: string }) => m.id);

    // --- Standing offer detection ---
    const standingResult = handleVerifierStandingGig(gig, contractId, milestoneIds);

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
      });

      if (standingType === 'smoke-test') {
        const rule = VERIFIER_OFFER_RULES['nightly smoke test package'];

        const checkTask = cron.schedule(rule.checkSchedule!, async () => {
          log.info('nightly smoke check firing');
          const nightlyResults: CheckResult[] = [];
          const smokeStart = Date.now();
          for (const criterion of plan.criteriaList) {
            const target = plan.targets[0] ?? '';
            try {
              const checkResult = await runHttpCheck(target, criterion.id, criterion.description, { logger: log });
              nightlyResults.push(checkResult);
            } catch (err) {
              log.error({ err, criterionId: criterion.id }, 'nightly http check failed');
            }
          }

          const existing = getJob(contractId);
          setJob(contractId, {
            gigId: gig.id,
            contractId,
            checkType: plan.checkType,
            status: 'running',
            checkResults: [...(existing?.checkResults ?? []), ...nightlyResults],
            updatedAt: new Date().toISOString(),
          });

          const failCount = nightlyResults.filter((r) => r.verdict === 'fail').length;
          log.info({ durationMs: Date.now() - smokeStart, failCount, total: nightlyResults.length }, 'nightly smoke run complete');
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
          const existing = getJob(contractId);
          const accumulatedResults = existing?.checkResults ?? [];
          const nextMilestoneId = plan.milestoneIds.find((id) => {
            return id;
          }) ?? plan.milestoneIds[0] ?? '';

          const reportStart = Date.now();
          try {
            await generateAndDeliverReport(
              contractId,
              nextMilestoneId,
              accumulatedResults,
              [],
              [],
              { client, apiKey: anthropicApiKey, logger: log },
            );
            log.info({ durationMs: Date.now() - reportStart }, 'weekly milestone report delivered');
          } catch (err) {
            log.error({ err, durationMs: Date.now() - reportStart }, 'weekly milestone report delivery failed');
          }
        });

        nightlyJobs.set(contractId, { checkTask, milestoneTask });
        log.info('nightly smoke cron jobs registered');
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

        log.info({ passCount, failCount, durationMs: Date.now() - reportStart }, 'acceptance review pipeline complete');
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
        const checkResult = await runHttpCheck(target, criterion.id, criterion.description, {
          logger: log,
        });
        allCheckResults.push(checkResult);
      }

      for (const target of plan.targets) {
        if (domCriteria.length === 0) break;
        const domChecks = domCriteria.map((c) => ({
          criterionId: c.id,
          description: c.description,
          checkType: 'element-present' as const,
          selector: c.expected,
        }));
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
        const dataQualityCriteria = dataCriteria.map((c) => ({
          criterionId: c.id,
          description: c.description,
          field: c.id,
          check: 'null-rate' as const,
        }));
        const dataResult = await runDataQualityChecks(dataSource, dataQualityCriteria, { logger: log });
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

      log.info({ passCount, failCount, durationMs: Date.now() - reportStart }, 'verification pipeline complete');
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

  logger.info({ botId: effectiveBotId, port }, 'VerifierBot started');

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
}

main().catch((err) => {
  logger.fatal({ err }, 'VerifierBot startup failed');
  process.exit(1);
});
