import cron from 'node-cron';
import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@botguild/agent-core';
import type { WatchJobConfig } from './parser.ts';
import { checkUptime } from './runners/uptime.ts';
import { checkDiff } from './runners/diff.ts';
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
}

interface JobEntry {
  task: cron.ScheduledTask;
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

  async function attemptDelivery(
    contractId: string,
    milestoneId: string,
    reportSummary: string,
  ): Promise<void> {
    await client.deliverMilestone(contractId, milestoneId, { note: reportSummary });
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
    if (!cron.validate(job.schedule)) {
      logger.error({ contractId: job.contractId, schedule: job.schedule }, 'invalid cron expression, skipping job');
      return;
    }

    if (jobs.has(job.contractId)) {
      const existing = jobs.get(job.contractId)!;
      existing.task.stop();
    }

    const milestoneIndex = jobs.get(job.contractId)?.milestoneIndex ?? 0;
    const task = cron.schedule(job.schedule, buildHandler(job.contractId));

    jobs.set(job.contractId, { task, job, milestoneIndex });
    logger.info({ contractId: job.contractId, schedule: job.schedule }, 'job scheduled');
  }

  function removeJob(contractId: string): void {
    const entry = jobs.get(contractId);
    if (!entry) return;
    entry.task.stop();
    jobs.delete(contractId);
    logger.info({ contractId }, 'job removed');
  }

  function pauseJob(contractId: string): void {
    const entry = jobs.get(contractId);
    if (!entry) return;
    entry.task.stop();
    logger.info({ contractId }, 'job paused');
  }

  function resumeJob(contractId: string): void {
    const entry = jobs.get(contractId);
    if (!entry) return;

    const { job } = entry;

    if (!cron.validate(job.schedule)) {
      logger.error({ contractId, schedule: job.schedule }, 'invalid cron expression on resume, skipping');
      return;
    }

    entry.task.stop();
    const task = cron.schedule(job.schedule, buildHandler(contractId));
    entry.task = task;

    logger.info({ contractId }, 'job resumed');
  }

  function listJobs(): string[] {
    return Array.from(jobs.keys());
  }

  return { addJob, removeJob, pauseJob, resumeJob, listJobs };
}
