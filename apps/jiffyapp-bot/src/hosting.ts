// Hosting lifecycle (Task 21): cycle jobs, the expiry/grace/suspend sweep, revival, and the
// month-end service report.
//
// A funded hosting-cycle contract (FR-13) drives exactly one `processCycleJob` invocation: it
// opens/re-affirms the calendar window (`hosting_cycles` — idempotent via `cycles.create`'s
// INSERT OR IGNORE), extends the tool's absolute `hosted_until` by another
// HOSTING_WINDOW_DAYS from whichever is later — the tool's current expiry, or now, so
// pre-funding a cycle before the previous one lapses COMPOUNDS rather than resets — and
// REVIVES a grace/suspended tool back to live (`tools.extendHosting` flips status
// unconditionally; Task 11 semantics). The cycle job itself never delivers a milestone: it
// just confirms the window in-thread and parks a minimal checkpoint so the row goes
// `in_progress`, which makes a redelivered claim on the same contract skip cleanly via
// JobStore's conflict policy (`decideOnConflict`). The month-end report — assembled from the
// edit log plus a live reachability spot-check — is what actually calls `deliverMilestone`,
// run daily by `deliverCycleReports` once `windowEnd` has passed.
//
// `sweepHostingExpiry` is the other half of FR-13: a tool whose `hosted_until` lapsed enters a
// GRACE_DAYS grace period (still serving; the buyer is nudged in-thread), then SUSPENDS if
// grace runs out with no re-fund — the dispatcher, not this bot, serves 410 off the status
// flip. A funded cycle landing on a grace/suspended tool revives it via `processCycleJob`
// above.

import { EDITS_PER_CYCLE, GRACE_DAYS, HOSTING_WINDOW_DAYS } from './config.js';
import { jobKeyFor, sha256Hex, type BuildCheckpoint } from './jobs.js';
import type { PipelineConfig } from './pipeline.js';
import type { SweepServices } from './sweeps.js';
import type { JobMessage } from './types.js';

const DAY_MS = 86_400_000;

function isoDate(value: string | null): string {
  return value ? value.slice(0, 10) : 'unknown';
}

// --- Copy --------------------------------------------------------------------

function cycleConfirmMessage(args: {
  windowStart: string;
  windowEnd: string;
  revived: boolean;
}): string {
  const lines = [
    `Hosting is confirmed for this cycle: ${isoDate(args.windowStart)} through ` +
      `${isoDate(args.windowEnd)}.`,
    '',
    'Need a change? Post an edit request in this thread starting with "edit:" — up to ' +
      `${EDITS_PER_CYCLE} are included this cycle.`,
  ];
  if (args.revived) {
    lines.push(
      '',
      'This tool had lapsed into grace/suspension for unpaid hosting — this funded cycle ' +
        'revives it, and it is live again now.',
    );
  }
  return lines.join('\n');
}

function toolMissingMessage(toolId: string | undefined): string {
  return (
    `We couldn't find a tool matching toolId ${toolId ?? '(none given)'} for this hosting gig, ` +
    'so we could not confirm this cycle. If you believe this is a mistake, reply here — a ' +
    'human operator can look into it.'
  );
}

function graceMessage(toolId: string): string {
  return (
    `Hosting for this tool lapsed. It has a ${GRACE_DAYS}-day grace period before its URL starts ` +
    'serving 410 Gone and the tool is ejected. Fund a new hosting gig to keep it live, and ' +
    `include this line so we match it back to the right tool:\n\n` +
    '```\n' +
    `toolId: ${toolId}\n` +
    '```\n'
  );
}

function suspendedMessage(toolId: string): string {
  return (
    `The ${GRACE_DAYS}-day grace period lapsed with no re-fund, so this tool is now suspended ` +
    'and its URL serves 410 Gone. Fund a new hosting gig to bring it back, and include this ' +
    `line so we match it back to the right tool:\n\n` +
    '```\n' +
    `toolId: ${toolId}\n` +
    '```\n'
  );
}

function serviceReportMarkdown(args: {
  windowStart: string;
  windowEnd: string;
  toolUrl: string;
  reachabilityStatus: number;
  edits: Array<{ instruction: string; status: string }>;
  toolStatus: string;
  toolId: string;
}): string {
  const lines: string[] = [
    `Month-end service report: ${isoDate(args.windowStart)} – ${isoDate(args.windowEnd)}`,
    '',
    `Tool URL: ${args.toolUrl} (reachability check: HTTP ${args.reachabilityStatus})`,
    '',
  ];
  if (args.edits.length === 0) {
    lines.push('Edits this cycle: none requested.');
  } else {
    lines.push('Edits this cycle:');
    for (const edit of args.edits) lines.push(`- ${edit.instruction} — ${edit.status}`);
  }
  lines.push('', `Hosting status: ${args.toolStatus}`);
  lines.push(
    '',
    'To keep this tool hosted for another cycle, fund a new hosting gig whose description ' +
      'includes this line, so we can match it back to the right tool:',
    '',
    '```',
    `toolId: ${args.toolId}`,
    '```',
  );
  return lines.join('\n');
}

// --- Cycle job -----------------------------------------------------------------

/**
 * Hosting-cycle job (FR-13): opens/re-affirms the calendar window, extends (and, if lapsed,
 * revives) the tool, and confirms the window in-thread. Delivering the milestone itself is
 * the month-end report's job (`deliverCycleReports`), NOT this function — the job row stays
 * `in_progress` with a lightweight checkpoint so a redelivered claim on the same contract
 * skips cleanly (JobStore's conflict policy).
 */
export async function processCycleJob(
  cfg: PipelineConfig,
  msg: JobMessage & { kind: 'cycle' },
): Promise<void> {
  const now = cfg.now ?? ((): Date => new Date());

  // ---- Load + guard (cycle jobs are lightweight — no repair loop, no checkpoint cap) --------
  const job = await cfg.jobs.get(msg.jobKey);
  if (!job) {
    cfg.logger.warn({ jobKey: msg.jobKey }, 'cycle job: no such job row; dropping');
    return;
  }
  if (job.status === 'delivered') {
    cfg.logger.info({ jobKey: msg.jobKey }, 'cycle job: already delivered; replay ignored');
    return;
  }
  if (job.status === 'parked') {
    cfg.logger.info({ jobKey: msg.jobKey }, 'cycle job: parked; the cron re-enqueues it');
    return;
  }

  const tool = msg.toolId ? await cfg.tools.get(msg.toolId) : null;
  if (!tool) {
    await cfg.client.sendMessage(msg.contractId, toolMissingMessage(msg.toolId));
    await cfg.audit.record({
      scope: msg.contractId,
      gate: 'cycle',
      result: 'tool-missing',
      detail: { toolId: msg.toolId ?? null },
    });
    await cfg.jobs.park(msg.jobKey, 'tool_missing');
    return;
  }

  const nowDate = now();
  const nowMs = nowDate.getTime();
  const windowStart = nowDate.toISOString();
  const windowEnd = new Date(nowMs + HOSTING_WINDOW_DAYS * DAY_MS).toISOString();
  await cfg.cycles.create({
    contractId: msg.contractId,
    toolId: tool.toolId,
    windowStart,
    windowEnd,
  });

  const revived = tool.status === 'grace' || tool.status === 'suspended';
  const existingMs = tool.hostedUntil ? new Date(tool.hostedUntil).getTime() : 0;
  const hostedUntil = new Date(
    Math.max(existingMs, nowMs) + HOSTING_WINDOW_DAYS * DAY_MS,
  ).toISOString();
  await cfg.tools.extendHosting(tool.toolId, {
    hostedUntil,
    hostingContractId: msg.contractId,
  });

  await cfg.client.sendMessage(
    msg.contractId,
    cycleConfirmMessage({ windowStart, windowEnd, revived }),
  );
  await cfg.buildLog.append(job.deliverableToken, 'cycle', 'hosting cycle window confirmed', {
    toolId: tool.toolId,
    windowStart,
    windowEnd,
    hostedUntil,
    revived,
  });
  await cfg.audit.record({
    scope: msg.contractId,
    gate: 'cycle',
    result: revived ? 'revived' : 'window-created',
    detail: { toolId: tool.toolId, hostedUntil },
  });

  // Stay in_progress with a minimal, windowEnd-free checkpoint (the cycle row already holds
  // windowEnd) so a redelivered claim on this contract skips via decideOnConflict's
  // 'in-progress' path. The month-end report (deliverCycleReports) marks this delivered.
  const checkpoint: BuildCheckpoint = {
    slotValues: null,
    round: 0,
    spendUsd: 0,
    activeMs: 0,
    staged: false,
    lastFailures: [],
    bankedRound: null,
  };
  await cfg.jobs.setInProgress(msg.jobKey, {});
  await cfg.jobs.saveCheckpoint(msg.jobKey, checkpoint);
}

// --- Month-end report sweep ------------------------------------------------------------------

/**
 * Daily: for every hosting cycle whose window has ended and whose report hasn't gone out yet,
 * spot-check reachability, summarize the cycle's edits, and deliver the funded milestone with a
 * service-report note. Tolerates per-cycle failures (logged; retried next daily sweep) so one
 * bad row never blocks the rest.
 */
export async function deliverCycleReports(s: SweepServices): Promise<void> {
  const now = s.now ?? ((): Date => new Date());
  const due = await s.cycles.listReportDue(now());

  for (const cycle of due) {
    try {
      const tool = await s.tools.get(cycle.toolId);
      if (!tool) {
        s.logger.warn(
          { contractId: cycle.contractId, toolId: cycle.toolId },
          'deliverCycleReports: cycle references a missing tool; skipping (retry next daily)',
        );
        continue;
      }

      const toolUrl = `https://${tool.slug}.${s.toolHostSuffix}`;
      let reachabilityStatus: number;
      try {
        const res = await s.fetchImpl(toolUrl);
        reachabilityStatus = res.status;
      } catch {
        reachabilityStatus = 0;
      }

      const edits = await s.edits.listByTool(cycle.toolId, cycle.windowStart);
      const report = serviceReportMarkdown({
        windowStart: cycle.windowStart,
        windowEnd: cycle.windowEnd,
        toolUrl,
        reachabilityStatus,
        edits,
        toolStatus: tool.status,
        toolId: tool.toolId,
      });

      const contract = await s.client.getContract(cycle.contractId);
      const funded = contract.milestones.find((m) => m.status === 'funded');
      if (!funded) {
        const already = contract.milestones.find(
          (m) => m.status === 'delivered' || m.status === 'accepted',
        );
        if (already) {
          await s.cycles.markReported(cycle.contractId);
          const hash = await sha256Hex(cycle.contractId);
          await s.jobs.markDelivered(jobKeyFor(hash, 'cycle'), 'delivered');
        } else {
          s.logger.warn(
            { contractId: cycle.contractId },
            'deliverCycleReports: no funded milestone yet; retrying next daily sweep',
          );
        }
        continue;
      }

      await s.client.deliverMilestone(cycle.contractId, funded.id, { note: report });
      await s.cycles.markReported(cycle.contractId);
      const hash = await sha256Hex(cycle.contractId);
      await s.jobs.markDelivered(jobKeyFor(hash, 'cycle'), 'delivered');
    } catch (err) {
      s.logger.error(
        { err, contractId: cycle.contractId },
        'deliverCycleReports: cycle report failed; retrying next daily sweep',
      );
    }
  }
}

// --- Hosting expiry / grace / suspend sweep --------------------------------------------------

/**
 * Daily: a live tool whose `hosted_until` has lapsed enters a GRACE_DAYS grace period (still
 * serving; the buyer is nudged in-thread on the latest hosting contract, or the original build
 * contract if none). A grace tool older than GRACE_DAYS with no re-fund suspends (the
 * dispatcher serves 410 off the status flip — no deploy action needed here). Per-tool
 * try/catch so one bad row never blocks the rest.
 */
export async function sweepHostingExpiry(s: SweepServices): Promise<void> {
  const now = s.now ?? ((): Date => new Date());
  const nowDate = now();

  const expired = await s.tools.listExpired(nowDate);
  for (const tool of expired) {
    try {
      await s.tools.markGrace(tool.toolId, nowDate);
      const contractId = tool.latestHostingContractId ?? tool.buildContractId;
      await s.client.sendMessage(contractId, graceMessage(tool.toolId));
    } catch (err) {
      s.logger.error(
        { err, toolId: tool.toolId },
        'sweepHostingExpiry: grace transition failed; retrying next daily sweep',
      );
    }
  }

  const graceElapsed = await s.tools.listGraceElapsed(nowDate, GRACE_DAYS);
  for (const tool of graceElapsed) {
    try {
      await s.tools.setStatus(tool.toolId, 'suspended');
      const contractId = tool.latestHostingContractId ?? tool.buildContractId;
      await s.client.sendMessage(contractId, suspendedMessage(tool.toolId));
    } catch (err) {
      s.logger.error(
        { err, toolId: tool.toolId },
        'sweepHostingExpiry: suspend transition failed; retrying next daily sweep',
      );
    }
  }
}
