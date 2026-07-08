// Queue-consumer pipeline (§6.3–6.9): brief intake → brief moderation →
// generate → fit gate → policy gate → diversity gate → export → deliver.
//
// Failure discipline:
// - moderation vendor outage  → job PARKED in D1, re-enqueued by the 15-min
//   cron (FR-2); queue retries are reserved for genuine transient errors.
// - invalid brief             → field-level error posted to the thread, job
//   parked 'brief_invalid'; the cron polls the thread for a corrected brief.
// - unexpected throw          → bubbles to the queue handler → msg.retry()
//   (≤3, then DLQ). The D1 checkpoint makes the retry resume, not restart.
// - cap exhaustion            → §9 non-convergence outcome (≥80% partial with
//   batch gates intact, else abort + request payer cancellation).

import type { Logger } from 'pino';
import type { AgentClient, Contract } from '@botguild/agent-core';
import {
  DIVERSITY_THRESHOLD,
  MAX_BATCH_ROUNDS,
  MAX_REGENS_PER_VARIANT,
  MAX_SPEND_USD,
  MIN_ANGLES,
  MODERATION_ATTEMPTS_BEFORE_NOTICE,
  PARTIAL_DELIVERY_FLOOR,
  REFRESH_CYCLE_DAYS,
} from './config.js';
import { extractBriefId, formatBriefErrors, parseAdBrief, parseReadabilityBrief } from './brief.js';
import type { BriefStore } from './briefStore.js';
import type { JobRow, JobStore } from './jobs.js';
import type { ModerationClient } from './gates/moderation.js';
import type { CopyGenerator } from './generate.js';
import { checkVariantLength, lengthGatePasses } from './gates/length.js';
import { runChecklist } from './gates/checklist.js';
import { differsFromPriorCycle, evaluateDiversity } from './gates/diversity.js';
import type { DiversityResult, PriorCycleResult } from './gates/diversity.js';
import { buildCsv, validateCsvAgainstTemplate } from './gates/csv.js';
import { checkRewrite, scoreReadability } from './gates/readability.js';
import { buildValidationReport } from './gates/report.js';
import type {
  AdBrief,
  JobCheckpoint,
  JobMessage,
  JobOutcome,
  Variant,
  VariantState,
} from './types.js';

/** R2 seam kept structural so the pipeline stays free of Workers globals. */
export interface DeliverableStorage {
  put(key: string, value: string, contentType: string): Promise<void>;
}

export interface PipelineConfig {
  jobs: JobStore;
  briefs: BriefStore;
  client: AgentClient;
  moderation: ModerationClient;
  generator: CopyGenerator;
  deliverables: DeliverableStorage;
  /** Public base URL of this Worker — evidence links are Worker-served (FR-9). */
  publicBaseUrl: string;
  logger: Logger;
  now?: () => Date;
}

export async function processJobMessage(cfg: PipelineConfig, msg: JobMessage): Promise<void> {
  const logger = cfg.logger.child({ contractId: msg.contractId, jobKey: msg.jobKey });
  const job = await cfg.jobs.get(msg.jobKey);
  if (!job) {
    logger.warn('queue message for unknown job key, dropping');
    return;
  }
  if (job.status === 'delivered') {
    logger.info({ outcome: job.outcome }, 'job already delivered, acking replay');
    return;
  }

  const contract = await cfg.client.getContract(msg.contractId);
  const gig = await cfg.client.getGig(contract.gigId);

  // --- Brief intake (FR-1): re-validate at milestone.funded ------------------
  // A thread-posted correction (stored on the job row by the cron sweep)
  // takes precedence over the original gig description.
  const briefSource = job.briefJson ?? gig.description ?? '';

  const briefId = extractBriefId(gig.description ?? '');
  if (briefId) {
    const stored = await cfg.briefs.get(briefId);
    if (!stored) {
      await cfg.client.sendMessage(
        msg.contractId,
        `This refresh gig references briefId \`${briefId}\`, but I have no stored brief under that id. ` +
          'Please double-check the id from your original delivery note and post the correct one in this thread.',
      );
      await cfg.jobs.park(msg.jobKey, 'brief_invalid');
      return;
    }
    await cfg.jobs.setInProgress(msg.jobKey, {
      kind: 'refresh',
      gigId: gig.id,
      briefJson: JSON.stringify(stored.brief),
    });
    const ok = await moderateBriefOrPark(cfg, logger, msg, briefText(stored.brief));
    if (!ok) return;
    // briefs.cycle is the LAST-DELIVERED cycle (adcopy delivery = 1), so this
    // refresh produces cycle stored.cycle + 1. That makes priorCycleVariants
    // return every prior batch (WHERE cycle < producedCycle) and stores the new
    // batch under a fresh cycle number, so the §9 differs-from-prior gate really
    // runs against month-1 and month-1's evidence is never overwritten.
    await runAdCopyJob(
      cfg,
      logger,
      msg,
      contract,
      { ...stored.brief, briefId },
      'refresh',
      stored.cycle + 1,
    );
    return;
  }

  const readability = parseReadabilityBrief(briefSource);
  if (readability.ok) {
    await cfg.jobs.setInProgress(msg.jobKey, {
      kind: 'readability',
      gigId: gig.id,
      briefJson: JSON.stringify(readability.brief),
    });
    const ok = await moderateBriefOrPark(cfg, logger, msg, readability.brief.paragraph);
    if (!ok) return;
    await runReadabilityJob(cfg, logger, msg, contract, readability.brief.paragraph, job);
    return;
  }

  const parsed = parseAdBrief(briefSource);
  if (!parsed.ok) {
    logger.info({ errors: parsed.errors }, 'brief failed post-funding validation, parking');
    await cfg.client.sendMessage(msg.contractId, formatBriefErrors(parsed.errors));
    await cfg.jobs.park(msg.jobKey, 'brief_invalid');
    await cfg.jobs.recordGateAudit({
      jobKey: msg.jobKey,
      gate: 'brief-intake',
      result: 'invalid',
      detail: parsed.errors,
    });
    return;
  }

  await cfg.jobs.setInProgress(msg.jobKey, {
    kind: 'adcopy',
    gigId: gig.id,
    briefJson: JSON.stringify(parsed.brief),
  });
  const ok = await moderateBriefOrPark(cfg, logger, msg, briefText(parsed.brief));
  if (!ok) return;
  await runAdCopyJob(cfg, logger, msg, contract, parsed.brief, 'adcopy');
}

function briefText(brief: AdBrief): string {
  return [brief.brandVoiceGuide, brief.offer, ...brief.policyConstraints].join('\n');
}

/**
 * Brief moderation (FR-2): screen the inbound brief before any generation.
 * Returns false when the pipeline must stop (outage parking or rejection).
 */
async function moderateBriefOrPark(
  cfg: PipelineConfig,
  logger: Logger,
  msg: JobMessage,
  text: string,
): Promise<boolean> {
  const outcome = await cfg.moderation.moderate(text);
  if (!outcome.ok) {
    const attempts = await cfg.jobs.incrementModerationAttempts(msg.jobKey);
    await cfg.jobs.park(msg.jobKey, 'moderation_outage');
    await cfg.jobs.recordGateAudit({
      jobKey: msg.jobKey,
      gate: 'brief-moderation',
      result: 'outage',
      detail: { attempts, detail: outcome.detail },
    });
    logger.warn(
      { attempts, detail: outcome.detail },
      'moderation vendor unavailable, job parked (fail closed)',
    );
    if (attempts === MODERATION_ATTEMPTS_BEFORE_NOTICE) {
      await cfg.client.sendMessage(
        msg.contractId,
        'Status: my moderation provider is currently unavailable. Your job is safely queued and will ' +
          'run automatically as soon as the provider recovers — no action needed on your side.',
      );
    }
    return false;
  }

  await cfg.jobs.recordGateAudit({
    jobKey: msg.jobKey,
    gate: 'brief-moderation',
    result: outcome.verdict.flagged ? 'flagged' : 'pass',
    detail: outcome.verdict,
  });

  if (outcome.verdict.flagged) {
    // A failing brief is rejected, not processed — and since no work will be
    // delivered, the §9 abort wording applies: request payer cancellation
    // (cancellation/refund is payer-only on this platform).
    await cfg.client.sendMessage(
      msg.contractId,
      'I cannot work on this brief: it was flagged by my moderation provider ' +
        `(${outcome.verdict.vendor} ${outcome.verdict.model}) and I never generate copy from an unscreened or ` +
        'flagged brief. Nothing will be delivered against this contract. Please cancel the contract from your ' +
        'side to release the escrow — cancellation is one click for the payer, and I fully support the refund.',
    );
    await cfg.jobs.markDelivered(msg.jobKey, 'rejected');
    logger.warn('brief flagged by moderation vendor, job rejected');
    return false;
  }
  return true;
}

// --- FREE readability gig (Story B / FR-10 funnel) ---------------------------

async function runReadabilityJob(
  cfg: PipelineConfig,
  logger: Logger,
  msg: JobMessage,
  contract: Contract,
  paragraph: string,
  job: JobRow,
): Promise<void> {
  const inputScore = scoreReadability(paragraph);
  let spendUsd = job.spentUsd;
  let rewrite = '';
  let attempts = 0;
  let check = null as ReturnType<typeof checkRewrite> | null;

  while (attempts < MAX_REGENS_PER_VARIANT && spendUsd < MAX_SPEND_USD) {
    attempts++;
    const feedback =
      check && !check.pass
        ? `Flesch-Kincaid grade ${check.rewriteGrade} was above the input's ${check.inputGrade}`
        : undefined;
    const result = await cfg.generator.rewritePlainLanguage(paragraph, feedback);
    spendUsd += result.costUsd;
    // Persist spend so a resumed/duplicated run resumes against the remaining
    // FR-5 budget instead of restarting Claude spend from 0.
    await cfg.jobs.saveCheckpoint(msg.jobKey, { variants: [], batchRounds: 0, spendUsd });
    rewrite = result.rewrite;
    check = checkRewrite(paragraph, rewrite);
    await cfg.jobs.recordGateAudit({
      jobKey: msg.jobKey,
      gate: 'readability-rewrite',
      result: check.pass ? 'pass' : 'fail',
      detail: { ...check, attempts },
    });
    if (check.pass) break;
  }

  if (!check || !check.pass) {
    await abortJob(cfg, msg, [
      `The plain-language rewrite could not reach a grade at or below the input's within the retry caps ` +
        `(${attempts} attempts, $${spendUsd.toFixed(2)} spend).`,
    ]);
    return;
  }

  // Story B: the rewrite passes the moderation gate before it is returned;
  // a vendor outage fails closed (park + cron re-enqueue, no delivery).
  const moderated = await cfg.moderation.moderate(rewrite);
  if (!moderated.ok) {
    await cfg.jobs.incrementModerationAttempts(msg.jobKey);
    await cfg.jobs.park(msg.jobKey, 'moderation_outage');
    logger.warn(
      { detail: moderated.detail },
      'rewrite moderation unavailable, parked (fail closed)',
    );
    return;
  }
  await cfg.jobs.recordGateAudit({
    jobKey: msg.jobKey,
    gate: 'rewrite-moderation',
    result: moderated.verdict.flagged ? 'flagged' : 'pass',
    detail: moderated.verdict,
  });
  if (moderated.verdict.flagged) {
    await abortJob(cfg, msg, ['The rewritten paragraph was flagged by the moderation vendor.']);
    return;
  }

  const milestone = findFundedMilestone(contract);
  const floorNote = check.atFloor
    ? `\n\nNote: the input is already at the plain-language floor (grade ≤ 5), so the rewrite simply does not raise the grade.`
    : '';
  const note =
    `## Readability report\n\n` +
    `- Flesch-Kincaid grade (input): **${check.inputGrade}**\n` +
    `- Flesch-Kincaid grade (rewrite): **${check.rewriteGrade}**\n` +
    `- Computed by \`${inputScore.lib}\` v${inputScore.version} (pinned)\n` +
    `- Moderation: pass (${moderated.verdict.vendor} ${moderated.verdict.model})${floorNote}\n\n` +
    `## Plain-language rewrite\n\n${rewrite}`;
  await cfg.client.deliverMilestone(msg.contractId, milestone.id, { note });
  await cfg.jobs.markDelivered(msg.jobKey, 'delivered');
  logger.info(
    { inputGrade: check.inputGrade, rewriteGrade: check.rewriteGrade },
    'readability gig delivered',
  );
}

// --- Paid ad-copy pipeline (adcopy + refresh) --------------------------------

type BatchGateState = {
  diversity: DiversityResult;
  prior: PriorCycleResult | null;
};

async function runAdCopyJob(
  cfg: PipelineConfig,
  logger: Logger,
  msg: JobMessage,
  contract: Contract,
  brief: AdBrief,
  kind: 'adcopy' | 'refresh',
  cycle = 1,
): Promise<void> {
  const job = await cfg.jobs.get(msg.jobKey);
  // Deliverables are served under the unguessable per-job token (§12), not the
  // recomputable sha256(contractId) job key. Fall back to the job key only for
  // rows predating the token column.
  const deliverableToken = job?.deliverableToken ?? msg.jobKey;
  const checkpoint: JobCheckpoint = job?.checkpoint ?? {
    variants: [],
    batchRounds: 0,
    spendUsd: job?.spentUsd ?? 0,
  };
  const save = (): Promise<void> => cfg.jobs.saveCheckpoint(msg.jobKey, checkpoint);
  const capReached = (): boolean => checkpoint.spendUsd >= MAX_SPEND_USD;
  const requiredAngles = Math.max(MIN_ANGLES, brief.angleCount);
  const priorVariants =
    kind === 'refresh' ? await cfg.briefs.priorCycleVariants(brief.briefId as string, cycle) : [];

  let idCounter = checkpoint.variants.length;
  const nextVariantId = (): string => `v${++idCounter}`;

  const addDrafts = async (count: number, avoidAngles: string[]): Promise<boolean> => {
    if (capReached()) return false;
    const batch = await cfg.generator.generateBatch(brief, count, avoidAngles);
    checkpoint.spendUsd += batch.costUsd;
    for (const draft of batch.variants.slice(0, count)) {
      checkpoint.variants.push({
        variant: { ...draft, id: nextVariantId() },
        status: 'pending',
        regenAttempts: 0,
        evidence: {},
      });
    }
    await save();
    return true;
  };

  if (checkpoint.variants.length === 0) {
    await addDrafts(brief.variantCount, []);
  }

  const batchGates = (variants: Variant[]): BatchGateState => ({
    diversity: evaluateDiversity(variants, { threshold: DIVERSITY_THRESHOLD, requiredAngles }),
    prior:
      kind === 'refresh'
        ? differsFromPriorCycle(variants, priorVariants, DIVERSITY_THRESHOLD)
        : null,
  });

  // Per-variant gates, then batch gates, with up to MAX_BATCH_ROUNDS top-up
  // rounds replacing batch-gate offenders. Every step checkpoints, so a queue
  // retry after a wall-clock overrun resumes against the remaining budget.
  let gates: BatchGateState;
  for (;;) {
    for (const state of checkpoint.variants) {
      if (state.status !== 'pending') continue;
      const outcome = await runVariantGates(cfg, msg, brief, checkpoint, state);
      await save();
      if (outcome === 'parked') return; // moderation outage: cron resumes us
    }

    const passed = passedVariants(checkpoint);
    gates = batchGates(passed);
    await cfg.jobs.recordGateAudit({
      jobKey: msg.jobKey,
      gate: 'diversity',
      result: gates.diversity.pass && (gates.prior?.pass ?? true) ? 'pass' : 'fail',
      detail: gates,
    });
    if (gates.diversity.pass && (gates.prior?.pass ?? true)) break;
    if (checkpoint.batchRounds >= MAX_BATCH_ROUNDS || capReached()) break;

    // Fail the offenders (deterministically: most violations first) and top
    // the batch back up with fresh drafts steered away from existing angles.
    const offenders = rankOffenders(gates);
    for (const id of offenders) {
      const state = checkpoint.variants.find((s) => s.variant.id === id);
      if (state && state.status === 'passed') {
        state.status = 'failed';
        state.failReason = 'diversity: too similar to another delivered variant';
      }
    }
    checkpoint.batchRounds++;
    const passedNow = passedVariants(checkpoint);
    const missing = brief.variantCount - passedNow.length;
    await save();
    if (missing > 0) {
      const generated = await addDrafts(missing, [...new Set(passedNow.map((v) => v.angle))]);
      if (!generated) break;
    }
  }

  // --- §9 outcome decision ---------------------------------------------------
  // The delivered subset must itself satisfy every batch-level hard gate, so
  // greedily drop violation participants until the remaining set is clean.
  const passed = passedVariants(checkpoint);
  const deliverable = selectDeliverableSubset(passed, batchGates);
  const finalGates = batchGates(deliverable);
  const partialFloor = Math.ceil(PARTIAL_DELIVERY_FLOOR * brief.variantCount);
  const batchGatesIntact = finalGates.diversity.pass && (finalGates.prior?.pass ?? true);

  const outcome: JobOutcome | 'abort' =
    batchGatesIntact && deliverable.length >= brief.variantCount
      ? 'delivered'
      : batchGatesIntact && deliverable.length >= partialFloor
        ? 'partial'
        : 'abort';

  if (outcome === 'abort') {
    const shortfall = checkpoint.variants
      .filter((s) => !deliverable.some((v) => v.id === s.variant.id))
      .map((s) => `- ${s.variant.id} (${s.variant.angle}): ${s.failReason ?? s.status}`);
    await abortJob(cfg, msg, [
      `Only ${deliverable.length} of ${brief.variantCount} variants cleared every hard gate within the ` +
        `contractual caps (${MAX_REGENS_PER_VARIANT} regenerations/variant, ${MAX_BATCH_ROUNDS} batch rounds, ` +
        `$${MAX_SPEND_USD.toFixed(2)} generation spend — $${checkpoint.spendUsd.toFixed(2)} consumed)` +
        (batchGatesIntact
          ? '.'
          : ', and the passing subset does not satisfy the batch-level diversity gates.'),
      'Itemized shortfall:',
      ...shortfall,
    ]);
    return;
  }

  // --- Export (FR-8) + delivery (FR-9) ---------------------------------------
  const csv = buildCsv(deliverable, brief);
  const validation = validateCsvAgainstTemplate(csv);
  if (!validation.valid) {
    // Our own output failing our own schema is a bug, not a job state — throw
    // so the queue retries and, if persistent, the DLQ alerts the operator.
    throw new Error(`generated CSV failed template validation: ${validation.errors.join('; ')}`);
  }

  const report = buildValidationReport({
    jobKey: msg.jobKey,
    contractId: msg.contractId,
    outcome: outcome,
    variantCountRequested: brief.variantCount,
    variantStates: checkpoint.variants,
    deliveredIds: deliverable.map((v) => v.id),
    diversity: finalGates.diversity,
    priorCycle: finalGates.prior,
    csv: validation,
    spendUsd: checkpoint.spendUsd,
    spendCapUsd: MAX_SPEND_USD,
    batchRounds: checkpoint.batchRounds,
    batchRoundCap: MAX_BATCH_ROUNDS,
    regenCapPerVariant: MAX_REGENS_PER_VARIANT,
    now: cfg.now,
  });

  await cfg.deliverables.put(`${deliverableToken}/copy.csv`, csv, 'text/csv; charset=utf-8');
  await cfg.deliverables.put(
    `${deliverableToken}/report.json`,
    JSON.stringify(report, null, 2),
    'application/json',
  );
  const csvUrl = `${cfg.publicBaseUrl}/deliverables/${deliverableToken}/copy.csv`;
  const reportUrl = `${cfg.publicBaseUrl}/deliverables/${deliverableToken}/report.json`;

  // FR-10: issue the briefId at first delivery; refresh cycles advance it.
  let briefId = brief.briefId;
  if (kind === 'adcopy') {
    briefId = crypto.randomUUID();
    const nextDue = addDays(cfg.now?.() ?? new Date(), REFRESH_CYCLE_DAYS);
    await cfg.briefs.create({
      briefId,
      originContractId: msg.contractId,
      brief,
      nextDueAt: nextDue,
    });
    await cfg.briefs.saveCycleVariants(briefId, 1, deliverable);
  } else {
    await cfg.briefs.saveCycleVariants(briefId as string, cycle, deliverable);
    await cfg.briefs.completeCycle(
      briefId as string,
      cycle,
      addDays(cfg.now?.() ?? new Date(), REFRESH_CYCLE_DAYS),
    );
  }

  const shortfallNote =
    outcome === 'partial'
      ? `\n\n**Shortfall (§ non-convergence):** ${brief.variantCount - deliverable.length} of ${brief.variantCount} ` +
        `variants did not clear every hard gate within the contractual caps; the itemized list is in the report. ` +
        `The warranty covers completing the shortfall.`
      : '';
  const note =
    `## VoiceWright delivery — ${deliverable.length} ad variants across ${finalGates.diversity.distinctAngles} angles\n\n` +
    `- CSV (Meta bulk-import template ${validation.templateVersion}, golden-file test: ${validation.goldenFileTestDate}): ${csvUrl}\n` +
    `- JSON validation report (grapheme counts, diversity scores, moderation verdict snapshots, checklist results, advisory readability): ${reportUrl}\n\n` +
    `Every delivered headline is ≤40 graphemes and every primary text ≤125 (10% margin applied where emoji/non-Latin ` +
    `text is present); every variant passed OpenAI Moderation (pinned model) plus ad-policy checklist v1.${shortfallNote}\n\n` +
    `**Monthly refresh:** to get a fresh batch from this stored brief next month, post a $50 refresh gig whose ` +
    `description includes \`briefId: ${briefId}\` — I detect it, re-run your stored brief, and deterministically ` +
    `verify the new batch differs from this one.`;

  const milestone = findFundedMilestone(contract);
  await cfg.client.deliverMilestone(msg.contractId, milestone.id, {
    note,
    attachments: [csvUrl, reportUrl],
  });
  await cfg.jobs.recordGateAudit({
    jobKey: msg.jobKey,
    gate: 'delivery',
    result: outcome,
    detail: { csvUrl, reportUrl, delivered: deliverable.length, requested: brief.variantCount },
  });
  await cfg.jobs.markDelivered(msg.jobKey, outcome);
  logger.info(
    { outcome, delivered: deliverable.length, spendUsd: checkpoint.spendUsd },
    'ad copy job delivered',
  );
}

/** Run length → checklist → moderation → advisory readability on one variant. */
async function runVariantGates(
  cfg: PipelineConfig,
  msg: JobMessage,
  brief: AdBrief,
  checkpoint: JobCheckpoint,
  state: VariantState,
): Promise<'done' | 'parked'> {
  const audit = (gate: string, result: string, detail: unknown): Promise<void> =>
    cfg.jobs.recordGateAudit({
      jobKey: msg.jobKey,
      variantId: state.variant.id,
      gate,
      result,
      detail,
    });

  const canRegen = (): boolean =>
    state.regenAttempts < MAX_REGENS_PER_VARIANT && checkpoint.spendUsd < MAX_SPEND_USD;

  const regenerate = async (failures: string[]): Promise<boolean> => {
    if (!canRegen()) return false;
    state.regenAttempts++;
    const result = await cfg.generator.regenerateVariant(brief, state.variant, failures);
    checkpoint.spendUsd += result.costUsd;
    state.variant = { ...result.variant, id: state.variant.id };
    state.evidence = {};
    return true;
  };

  for (;;) {
    // Fit gate (FR-5): regenerate over-limit lines, never truncate.
    const lengthChecks = checkVariantLength(state.variant);
    state.evidence.length = lengthChecks;
    await audit('length', lengthGatePasses(lengthChecks) ? 'pass' : 'fail', lengthChecks);
    if (!lengthGatePasses(lengthChecks)) {
      const failures = lengthChecks
        .filter((c) => !c.pass)
        .map(
          (c) =>
            `${c.field} is ${c.graphemes} graphemes — hard limit ${c.limit}. Write it shorter.`,
        );
      if (await regenerate(failures)) continue;
      state.status = 'failed';
      state.failReason = 'length: over grapheme limit after regeneration caps';
      return 'done';
    }

    // Policy gate, local half (FR-7): versioned checklist.
    const checklist = runChecklist(state.variant, brief);
    state.evidence.checklist = checklist;
    await audit('checklist', checklist.pass ? 'pass' : 'fail', checklist);
    if (!checklist.pass) {
      const failures = checklist.failures.map(
        (f) => `ad-policy checklist ${checklist.version} rule "${f.ruleId}": ${f.description}`,
      );
      if (await regenerate(failures)) continue;
      state.status = 'failed';
      state.failReason = `checklist: ${checklist.failures.map((f) => f.ruleId).join(', ')}`;
      return 'done';
    }

    // Policy gate, vendor half (FR-7): pinned moderation, fail closed (FR-2).
    const copy = `${state.variant.headline}\n${state.variant.primaryText}\n${state.variant.description}`;
    const moderated = await cfg.moderation.moderate(copy);
    if (!moderated.ok) {
      const attempts = await cfg.jobs.incrementModerationAttempts(msg.jobKey);
      await cfg.jobs.park(msg.jobKey, 'moderation_outage');
      await audit('moderation', 'outage', { attempts, detail: moderated.detail });
      if (attempts === MODERATION_ATTEMPTS_BEFORE_NOTICE) {
        await cfg.client.sendMessage(
          msg.contractId,
          'Status: my moderation provider is currently unavailable mid-batch. Progress is checkpointed and the ' +
            'job resumes automatically when the provider recovers.',
        );
      }
      return 'parked';
    }
    state.evidence.moderation = moderated.verdict;
    await audit('moderation', moderated.verdict.flagged ? 'flagged' : 'pass', moderated.verdict);
    if (moderated.verdict.flagged) {
      if (
        await regenerate([
          'the copy was flagged by the moderation vendor; rewrite it to be unambiguously safe',
        ])
      ) {
        continue;
      }
      state.status = 'failed';
      state.failReason = 'moderation: flagged after regeneration caps';
      return 'done';
    }

    // Advisory readability (FR-6) — reported, never blocking.
    state.evidence.readability = scoreReadability(`${state.variant.primaryText}`);
    state.status = 'passed';
    return 'done';
  }
}

function passedVariants(checkpoint: JobCheckpoint): Variant[] {
  return checkpoint.variants.filter((s) => s.status === 'passed').map((s) => s.variant);
}

/** Variant ids ranked by how many batch-gate violations they participate in. */
function rankOffenders(gates: BatchGateState): string[] {
  const counts = new Map<string, number>();
  const bump = (id: string): void => {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  };
  // For cross-group violations penalize the later variant (bId keeps batches
  // stable); prior-cycle violations penalize the new variant (aId).
  for (const v of gates.diversity.violations) bump(v.bId);
  for (const v of gates.prior?.violations ?? []) bump(v.aId);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** Greedily drop violation participants until the subset passes batch gates. */
function selectDeliverableSubset(
  passed: Variant[],
  batchGates: (variants: Variant[]) => BatchGateState,
): Variant[] {
  let subset = [...passed];
  for (;;) {
    const gates = batchGates(subset);
    if (gates.diversity.violations.length === 0 && (gates.prior?.violations.length ?? 0) === 0) {
      return subset;
    }
    const worst = rankOffenders(gates)[0];
    if (!worst) return subset;
    subset = subset.filter((v) => v.id !== worst);
  }
}

/** §9 abort leg: deliver nothing, post evidence, request payer cancellation. */
async function abortJob(
  cfg: PipelineConfig,
  msg: JobMessage,
  explanation: string[],
): Promise<void> {
  await cfg.client.sendMessage(
    msg.contractId,
    [
      'I am stopping work on this contract without delivering: the batch could not converge on copy that passes ' +
        'every contractual hard gate.',
      ...explanation,
      '',
      'Because cancellation and refund are payer-side actions on this platform, I formally request that you cancel ' +
        'this contract — it is one click on your side and releases the full escrow back to you. I fully support the ' +
        'refund. If you prefer, you can open a dispute instead; my complete gate-by-gate audit log is retained as evidence.',
    ].join('\n'),
  );
  await cfg.jobs.recordGateAudit({
    jobKey: msg.jobKey,
    gate: 'non-convergence',
    result: 'abort',
    detail: explanation,
  });
  await cfg.jobs.markDelivered(msg.jobKey, 'aborted');
}

function findFundedMilestone(contract: Contract): { id: string } {
  const milestone = contract.milestones.find((m) => m.status === 'funded');
  if (!milestone) {
    // Retry-able: the contract read may have raced the funding event.
    throw new Error(`contract ${contract.id} has no funded milestone`);
  }
  return milestone;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
