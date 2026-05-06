import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@botguild/agent-core';
import type { WatchJobConfig } from './parser.js';
import { checkUptime } from './runners/uptime.js';
import { checkDiff } from './runners/diff.js';
import { getJob, setJob } from './store.js';
import type { CheckRecord } from './store.js';
import type { Logger } from 'pino';

export interface SchedulerConfig {
  client: AgentClient;
  apiKey: string;
  logger: Logger;
}

export interface Scheduler {
  addJob(job: WatchJobConfig): void;
  removeJob(contractId: string): void;
  pauseJob(contractId: string): void;
  resumeJob(contractId: string): void;
  listJobs(): string[];
  runOnce(job: WatchJobConfig): Promise<string>;
}

interface JobEntry {
  task: cron.ScheduledTask;
  milestoneTask?: cron.ScheduledTask;
  job: WatchJobConfig;
  milestoneIndex: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createScheduler(config: SchedulerConfig): Scheduler {
  const { client, apiKey, logger } = config;
  const jobs = new Map<string, JobEntry>();
  const anthropic = new Anthropic({ apiKey });

  async function runChecks(job: WatchJobConfig): Promise<string> {
    if (job.watchType === 'uptime' || job.watchType === 'scheduled') {
      const results = await Promise.all(
        job.targets.map((target) =>
          checkUptime(target, job.contractId, { logger }),
        ),
      );

      const summary = results
        .map((r) => `${r.target}: ${r.status}${r.error ? ` (${r.error})` : ''} — ${r.responseMs}ms`)
        .join('; ');

      return `Uptime check for contract ${job.contractId}. Targets: ${job.targets.join(', ')}. Results: ${summary}`;
    }

    const results = await Promise.all(
      job.targets.map((target) =>
        checkDiff(
          target,
          job.contractId,
          {
            requiresJs: job.requiresJs,
            selectors: job.selectors,
            screenshot: job.screenshot,
          },
          { apiKey, logger },
        ),
      ),
    );

    const summary = results
      .map((r) =>
        r.changed
          ? `${r.target}: changed — ${r.diffSummary ?? 'no summary'}`
          : `${r.target}: no change`,
      )
      .join('; ');

    return `Diff check (${job.watchType}) for contract ${job.contractId}. Targets: ${job.targets.join(', ')}. Results: ${summary}`;
  }

  async function generateReport(checkSummary: string): Promise<string> {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: `Generate a concise monitoring report based on the following check results. Describe what was checked, the current status, and any changes or issues detected.\n\n${checkSummary}`,
        },
      ],
    });

    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === 'text',
    );

    return textBlock?.text ?? checkSummary;
  }

  async function generateWeeklySummary(
    job: WatchJobConfig,
    records: CheckRecord[],
  ): Promise<string> {
    const weekOf = new Date().toISOString().slice(0, 10);
    const checkCount = records.length;

    if (job.watchType === 'uptime') {
      const upCount = records.filter((r) => r.status === 'up').length;
      const incidentCount = records.filter((r) => r.status === 'down').length;
      const uptimePercent =
        checkCount > 0 ? ((upCount / checkCount) * 100).toFixed(1) : '0.0';
      return `Week of ${weekOf}: ${uptimePercent}% uptime. ${incidentCount} incidents. Total checks: ${checkCount}.`;
    }

    const changeCount = records.filter((r) => r.status === 'changed').length;
    const diffSummaries = records
      .filter((r) => r.status === 'changed' && r.detail)
      .map((r) => r.detail as string);

    const changesText =
      diffSummaries.length > 0 ? diffSummaries.join(' | ') : 'No changes detected.';

    return `Week of ${weekOf}: ${changeCount} changes detected across ${checkCount} checks. ${changesText}`;
  }

  async function attemptDelivery(
    contractId: string,
    milestoneId: string,
    reportSummary: string,
  ): Promise<void> {
    await client.deliverMilestone(contractId, milestoneId, { note: reportSummary });
  }

  function buildAccumulatingCheckHandler(contractId: string): () => Promise<void> {
    return async () => {
      const entry = jobs.get(contractId);
      if (!entry) return;

      const { job } = entry;

      let checkSummary: string;
      try {
        checkSummary = await runChecks(job);
      } catch (err) {
        logger.error({ err, contractId }, 'check failed during scheduled run');

        const state = getJob(contractId);
        if (state) {
          const record: CheckRecord = {
            timestamp: new Date().toISOString(),
            status: 'down',
            detail: String(err),
          };
          setJob(contractId, {
            ...state,
            accumulatedResults: [...(state.accumulatedResults ?? []), record],
          });
        }
        return;
      }

      const isUptime = job.watchType === 'uptime';
      const isDown = checkSummary.includes(': down');
      const isChanged = checkSummary.includes(': changed');

      const record: CheckRecord = {
        timestamp: new Date().toISOString(),
        status: isUptime
          ? isDown
            ? 'down'
            : 'up'
          : isChanged
            ? 'changed'
            : 'unchanged',
        detail: checkSummary,
      };

      const state = getJob(contractId);
      if (state) {
        setJob(contractId, {
          ...state,
          accumulatedResults: [...(state.accumulatedResults ?? []), record],
        });
      }

      if (isChanged || isDown) {
        try {
          await client.sendMessage(contractId, checkSummary);
        } catch (err) {
          logger.warn({ err, contractId }, 'alert thread message failed');
        }
      }

      logger.info({ contractId, status: record.status }, 'check recorded');
    };
  }

  function buildMilestoneDeliveryHandler(contractId: string): () => Promise<void> {
    return async () => {
      const entry = jobs.get(contractId);
      if (!entry) return;

      const { job } = entry;

      if (entry.milestoneIndex >= job.milestoneIds.length) {
        entry.milestoneTask?.stop();
        entry.task.stop();
        logger.info({ contractId }, 'all milestones delivered, cron jobs stopped');
        return;
      }

      const state = getJob(contractId);
      const records = state?.accumulatedResults ?? [];

      const weeklySummary = await generateWeeklySummary(job, records);

      let reportSummary: string;
      try {
        reportSummary = await generateReport(weeklySummary);
      } catch (err) {
        logger.error({ err, contractId }, 'weekly report generation failed');
        reportSummary = weeklySummary;
      }

      try {
        await client.sendMessage(contractId, `Weekly report ready: ${reportSummary}`);
      } catch (err) {
        logger.warn({ err, contractId }, 'weekly milestone message failed');
      }

      const milestoneId = job.milestoneIds[entry.milestoneIndex];

      try {
        await attemptDelivery(contractId, milestoneId, reportSummary);
        entry.milestoneIndex++;
        logger.info({ contractId, milestoneId, nextIndex: entry.milestoneIndex }, 'weekly milestone delivered');

        const fresh = getJob(contractId);
        if (fresh) {
          setJob(contractId, { ...fresh, accumulatedResults: [], milestoneIndex: entry.milestoneIndex });
        }

        if (entry.milestoneIndex >= job.milestoneIds.length) {
          entry.milestoneTask?.stop();
          entry.task.stop();
          logger.info({ contractId }, 'all milestones delivered, cron jobs stopped');
        }
      } catch (firstErr) {
        logger.warn({ err: firstErr, contractId, milestoneId }, 'weekly milestone delivery failed, retrying in 60s');

        await sleep(60_000);

        try {
          await attemptDelivery(contractId, milestoneId, reportSummary);
          entry.milestoneIndex++;
          logger.info({ contractId, milestoneId }, 'weekly milestone delivered on retry');

          const fresh = getJob(contractId);
          if (fresh) {
            setJob(contractId, { ...fresh, accumulatedResults: [], milestoneIndex: entry.milestoneIndex });
          }

          if (entry.milestoneIndex >= job.milestoneIds.length) {
            entry.milestoneTask?.stop();
            entry.task.stop();
            logger.info({ contractId }, 'all milestones delivered, cron jobs stopped');
          }
        } catch (secondErr) {
          logger.fatal({ err: secondErr, contractId, milestoneId }, 'weekly milestone delivery failed after retry, pausing job');
          pauseJob(contractId);
        }
      }
    };
  }

  function buildHandler(contractId: string): () => Promise<void> {
    return async () => {
      const entry = jobs.get(contractId);
      if (!entry) return;

      const { job } = entry;

      if (entry.milestoneIndex >= job.milestoneIds.length) {
        entry.task.stop();
        logger.info({ contractId }, 'all milestones delivered, cron job stopped');
        return;
      }

      let checkSummary: string;
      try {
        checkSummary = await runChecks(job);
      } catch (err) {
        logger.error({ err, contractId }, 'check failed during scheduled run');
        return;
      }

      let reportSummary: string;
      try {
        reportSummary = await generateReport(checkSummary);
      } catch (err) {
        logger.error({ err, contractId }, 'report generation failed');
        reportSummary = checkSummary;
      }

      const milestoneId = job.milestoneIds[entry.milestoneIndex];

      try {
        await client.sendMessage(contractId, reportSummary);
      } catch (err) {
        logger.warn({ err, contractId }, 'inline progress update failed, continuing with milestone delivery');
      }

      try {
        await attemptDelivery(contractId, milestoneId, reportSummary);
        entry.milestoneIndex++;
        logger.info({ contractId, milestoneId, nextIndex: entry.milestoneIndex }, 'milestone delivered');

        if (entry.milestoneIndex >= job.milestoneIds.length) {
          entry.task.stop();
          logger.info({ contractId }, 'all milestones delivered, cron job stopped');
        }
      } catch (firstErr) {
        logger.warn({ err: firstErr, contractId, milestoneId }, 'milestone delivery failed, retrying in 60s');

        await sleep(60_000);

        try {
          await attemptDelivery(contractId, milestoneId, reportSummary);
          entry.milestoneIndex++;
          logger.info({ contractId, milestoneId }, 'milestone delivered on retry');

          if (entry.milestoneIndex >= job.milestoneIds.length) {
            entry.task.stop();
            logger.info({ contractId }, 'all milestones delivered, cron job stopped');
          }
        } catch (secondErr) {
          logger.fatal({ err: secondErr, contractId, milestoneId }, 'milestone delivery failed after retry, pausing job');
          pauseJob(contractId);
        }
      }
    };
  }

  function addJob(job: WatchJobConfig): void {
    const isDualSchedule = !!(job.checkSchedule && job.milestoneSchedule);

    const checkExpr = isDualSchedule ? job.checkSchedule! : job.schedule;
    const milestoneExpr = isDualSchedule ? job.milestoneSchedule! : undefined;

    if (!cron.validate(checkExpr)) {
      logger.error({ contractId: job.contractId, schedule: checkExpr }, 'invalid cron expression, skipping job');
      return;
    }

    if (milestoneExpr && !cron.validate(milestoneExpr)) {
      logger.error({ contractId: job.contractId, milestoneSchedule: milestoneExpr }, 'invalid milestone cron expression, skipping job');
      return;
    }

    if (jobs.has(job.contractId)) {
      const existing = jobs.get(job.contractId)!;
      existing.task.stop();
      existing.milestoneTask?.stop();
    }

    // Persist a JobState for this contract so check handlers can accumulate
    // results — without this, weekly milestone summaries find no records.
    const persisted = getJob(job.contractId);
    setJob(job.contractId, {
      gigId: job.gigId,
      contractId: job.contractId,
      status: persisted?.status ?? 'unknown',
      lastCheckedAt: persisted?.lastCheckedAt ?? new Date().toISOString(),
      accumulatedResults: persisted?.accumulatedResults ?? [],
      checkSchedule: checkExpr,
      milestoneSchedule: milestoneExpr,
      watchConfig: job,
      milestoneIndex: persisted?.milestoneIndex ?? 0,
      ...(persisted?.snapshotHash !== undefined ? { snapshotHash: persisted.snapshotHash } : {}),
      ...(persisted?.snapshotExcerpt !== undefined ? { snapshotExcerpt: persisted.snapshotExcerpt } : {}),
    });

    const milestoneIndex = jobs.get(job.contractId)?.milestoneIndex ?? persisted?.milestoneIndex ?? 0;

    if (isDualSchedule) {
      const task = cron.schedule(checkExpr, buildAccumulatingCheckHandler(job.contractId));
      const milestoneTask = cron.schedule(milestoneExpr!, buildMilestoneDeliveryHandler(job.contractId));
      jobs.set(job.contractId, { task, milestoneTask, job, milestoneIndex });
      logger.info(
        { contractId: job.contractId, checkSchedule: checkExpr, milestoneSchedule: milestoneExpr },
        'dual-schedule job registered',
      );
    } else {
      const task = cron.schedule(checkExpr, buildHandler(job.contractId));
      jobs.set(job.contractId, { task, job, milestoneIndex });
      logger.info({ contractId: job.contractId, schedule: checkExpr }, 'job scheduled');
    }
  }

  function removeJob(contractId: string): void {
    const entry = jobs.get(contractId);
    if (!entry) return;
    entry.task.stop();
    entry.milestoneTask?.stop();
    jobs.delete(contractId);
    logger.info({ contractId }, 'job removed');
  }

  function pauseJob(contractId: string): void {
    const entry = jobs.get(contractId);
    if (!entry) return;
    entry.task.stop();
    entry.milestoneTask?.stop();
    logger.info({ contractId }, 'job paused');
  }

  function resumeJob(contractId: string): void {
    const entry = jobs.get(contractId);
    if (!entry) return;

    const { job } = entry;
    const isDualSchedule = !!(job.checkSchedule && job.milestoneSchedule);
    const checkExpr = isDualSchedule ? job.checkSchedule! : job.schedule;
    const milestoneExpr = isDualSchedule ? job.milestoneSchedule! : undefined;

    if (!cron.validate(checkExpr)) {
      logger.error({ contractId, schedule: checkExpr }, 'invalid cron expression on resume, skipping');
      return;
    }

    entry.task.stop();
    entry.milestoneTask?.stop();

    if (isDualSchedule) {
      const task = cron.schedule(checkExpr, buildAccumulatingCheckHandler(contractId));
      const milestoneTask = cron.schedule(milestoneExpr!, buildMilestoneDeliveryHandler(contractId));
      entry.task = task;
      entry.milestoneTask = milestoneTask;
    } else {
      const task = cron.schedule(checkExpr, buildHandler(contractId));
      entry.task = task;
    }

    logger.info({ contractId }, 'job resumed');
  }

  function listJobs(): string[] {
    return Array.from(jobs.keys());
  }

  return { addJob, removeJob, pauseJob, resumeJob, listJobs, runOnce: runChecks };
}
