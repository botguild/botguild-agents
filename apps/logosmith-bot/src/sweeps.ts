// ---------------------------------------------------------------------------
// Cron sweeps (§10.4/§12) — a Worker has no timers, so each Cron Trigger drives
// exactly one sweep per invocation:
//
//   */15  gig poll + propose, negotiation, the FR-9 selection poll, parked-job
//         re-enqueue (bounded by an age-based give-up), and the reputation
//         refresh into the D1 snapshot `GET /health` reads.
//   0 6   §12 stuck-claim recovery.
//
// Every step is awaited — nothing is fire-and-forget safe inside a scheduled
// handler, which is killed the moment its promise settles — and every step sits
// in its own try/catch, so one failing step (a transient platform outage, one
// bad row) never stops the rest. The reputation refresh in particular has to
// land even when gig discovery threw.
//
// Nothing here touches `env.*`: index.ts adapts the bindings into the
// structural seams below, so the whole module runs under plain Node tests.
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';
import type {
  AgentClient,
  CostEstimator,
  Gig,
  Proposer,
  ReputationSource,
} from '@botguild/agent-core';
import { shouldPropose } from '@botguild/agent-core';
import {
  refreshReputationOnce,
  runGigPollSweep,
  runNegotiationSweep,
  type D1Like,
  type D1NegotiationStore,
  type SeenStore,
} from '@botguild/agent-core-workers';
import {
  SELECTION_TIMEOUT_HOURS,
  STUCK_CLAIM_MINUTES,
  pricingCalc,
  scorerConfig,
} from './config.js';
import {
  buildJobKey,
  saveReputationSnapshot,
  type ConceptRow,
  type ConceptStore,
  type JobRow,
  type JobStore,
  type SelectionStore,
} from './jobs.js';
import { createThreadReader, findSelection } from './threads.js';
import type { FetchLike, JobMessage, SelectionSource } from './types.js';

/** Structural queue seam — env.JOBS (`Queue<JobMessage>`) satisfies this shape. */
export interface JobQueueLike {
  send(message: JobMessage): Promise<unknown>;
}

/**
 * The smaller deps shape `resolveSelectionForContract` needs — shared by the
 * cron selection poll and the `milestone.accepted`/`acceptance.auto_approved`
 * webhook handlers, which build this object directly rather than holding a
 * full `SweepServices`.
 */
export interface SelectionResolutionDeps {
  client: AgentClient;
  jobs: JobStore;
  concepts: ConceptStore;
  selection: SelectionStore;
  queue: JobQueueLike;
  apiUrl: string;
  apiKey: string;
  botId: string;
  logger: Logger;
  /**
   * Test seam. Absent in the production graph, where the Worker's own global
   * `fetch` is the correct client for a platform REST call — this is not an
   * `env.*` binding, so the "bindings only in index.ts" rule does not reach it.
   */
  fetchImpl?: FetchLike;
  /** Test seam for the FR-9 timeout arithmetic; defaults to the wall clock. */
  now?: () => Date;
}

export interface SweepServices extends SelectionResolutionDeps {
  db: D1Like;
  seen: SeenStore;
  negotiationStore: D1NegotiationStore;
  reputationSource: ReputationSource;
  proposer: Proposer;
  /** Estimator-free proposer for FREE gigs (favicon/taster) — see config.ts. */
  freeProposer: Proposer;
  costEstimator: CostEstimator;
}

const clockOf = (deps: { now?: () => Date }): (() => Date) => deps.now ?? ((): Date => new Date());

const SELECTION_TIMEOUT_MS = SELECTION_TIMEOUT_HOURS * 60 * 60 * 1000;

/** FR-17 gate name for every selection event written to the audit trail. */
const SELECTION_GATE = 'selection';
/** The `result` marking the one-time "you picked a concept we never sent" note. */
const UNSELECTABLE_RESULT = 'unselectable-pick';

/**
 * How long a job may sit parked before LogoSmith gives up on it, tells the
 * buyer, and moves it to a terminal state.
 *
 * WHY THIS EXISTS. A retryable vendor failure parks WITHOUT consuming an FR-5
 * regeneration attempt (pipeline.ts) — correct, because a 45-minute outage must
 * not burn a paid job's regeneration budget on a 503 that generated nothing and
 * spent nothing. But that leaves parking itself unbounded: a permanently dead
 * vendor loops park → unpark → fail → park forever. No spend, but the job never
 * delivers, never refunds, and never tells the buyer. This is the independent
 * bound.
 *
 * WHY SIX HOURS. The milestone promises one business day. A job parked six
 * hours has burned a quarter of that with zero progress, after roughly
 * twenty-four automatic retries at the 15-minute cron cadence. Every transient
 * outage in this vendor set resolves well inside that window; past it a
 * permanent cause — a revoked key, a withdrawn model, a suspended account — is
 * far likelier than a recovering one, and continuing to wait in silence is
 * worse for the buyer than an honest stop. Six hours also leaves roughly
 * eighteen hours of the SLA for the buyer to cancel or re-brief INSIDE the
 * promised window, rather than discovering the failure after it was missed.
 */
const PARKED_GIVE_UP_HOURS = 6;

/**
 * Buyer-facing names for the vendor behind each park reason. An allow-list with
 * a generic fallback: an unrecognized reason yields a vague-but-true sentence,
 * never a leaked internal token. `Object.hasOwn` rather than a bare lookup —
 * this is a plain object literal, so `park_reason: '__proto__'` would otherwise
 * return an inherited value instead of missing (same idiom as index.ts's
 * deliverable whitelist).
 */
const PARK_REASON_VENDOR: Record<string, string> = {
  moderation_outage: 'the content-safety vendor that screens every brief before generation',
  vendor_outage: 'the image-generation vendor for this job',
  ocr_outage: 'the vision model that verifies your lettering reads back correctly',
  vectorizer_outage: 'the vectorization vendor that turns the chosen concept into a true vector',
};

const vendorFor = (reason: string | null): string =>
  reason !== null && Object.hasOwn(PARK_REASON_VENDOR, reason)
    ? PARK_REASON_VENDOR[reason]
    : 'a vendor LogoSmith depends on for this job';

// --- Gig discovery ------------------------------------------------------------

/**
 * Score a discovered gig and submit a Claude-written proposal when it clears
 * the bar. FREE gigs (the US-2 favicon repackage and the US-3 taster) go
 * through the estimator-free proposer, because the estimator's 1.5×-cost floor
 * would re-price a $0 anchor into a paid bid and destroy the funnel.
 *
 * "Is this free?" is asked as `pricingCalc(gig).price === 0` rather than by
 * re-deriving the favicon-brief / zero-budget test here. That is the same
 * question by construction — config.ts's calculator returns 0 for exactly the
 * free shapes and SEED_PRICE_USD otherwise — so the routing cannot drift away
 * from the pricing it is routing for.
 */
export async function maybePropose(s: SweepServices, gig: Gig): Promise<void> {
  const log = s.logger.child({ gigId: gig.id });
  if (!shouldPropose(gig, scorerConfig)) return;

  const free = pricingCalc(gig).price === 0;
  const draft = await (free ? s.freeProposer : s.proposer).generateProposal(gig);
  const { proposalId } = await s.client.submitProposal(gig.id, draft);
  log.info({ proposalId, free, price: draft.price }, 'proposal submitted');
}

// --- Selection (FR-9) ---------------------------------------------------------

/**
 * The default-selection rule: the highest lettering-readback score among the
 * concepts it is handed, ties broken by the lowest slot, or null when none of
 * them passed.
 *
 * Deliberately order-independent rather than "take the first row" —
 * `ConceptStore.listPassing` already sorts by `ocr_score DESC, slot ASC`, so a
 * positional implementation would be a test that passes because of the ORDER BY
 * in a different module and would go silently wrong the day that clause moves.
 *
 * A passing concept with a null score cannot occur through the pipeline (`pass`
 * is read off a verdict that always carries a score), but if one ever did it
 * ranks last and stays selectable instead of being dropped: "something passed"
 * must never resolve to null.
 */
export function decideDefaultSelection(concepts: ConceptRow[]): number | null {
  let winner: ConceptRow | null = null;
  for (const candidate of concepts) {
    if (!candidate.ocrPass) continue;
    if (winner === null) {
      winner = candidate;
      continue;
    }
    const score = candidate.ocrScore ?? -Infinity;
    const best = winner.ocrScore ?? -Infinity;
    if (score > best || (score === best && candidate.slot < winner.slot)) winner = candidate;
  }
  return winner === null ? null : winner.slot;
}

/**
 * The slots the buyer was actually shown at M1.
 *
 * NOT `concepts.listPassing()`. A slot demoted by the FR-6 distinctness gate
 * keeps `ocr_pass = 1` — correct for what that column means, since its
 * lettering did read back — so on a `partial` job `listPassing()` returns a
 * fully populated row (`r2_key`, `phash`, `ocr_score` all set) for a concept
 * that was never attached to the M1 delivery. Nothing about such a row looks
 * wrong to a query, which is exactly why it needs a second source.
 *
 * The stage-1 checkpoint is that source: `buildM1Note`'s concept list and
 * `deliverMilestone`'s attachment list are both built from precisely
 * `checkpoint.slots.filter(status === 'passed')` (pipeline.ts), and stage 1
 * marks itself delivered immediately afterwards, so the checkpoint is frozen
 * from that moment. An empty set therefore means "we cannot prove what was
 * delivered", and every caller below reads that as a refusal to select rather
 * than as permission.
 */
function deliveredSlots(stageOne: JobRow | null): Set<number> {
  return new Set(
    (stageOne?.checkpoint?.slots ?? [])
      .filter((slot) => slot.status === 'passed')
      .map((slot) => slot.slot),
  );
}

function buildUnselectablePickNote(picked: number, choices: number[]): string {
  const list = choices.map((slot) => `concept ${slot}`).join(' and ');
  return [
    `LogoSmith could not act on that selection.`,
    '',
    `You picked concept ${picked}, but concept ${picked} was not part of the Milestone 1 ` +
      `delivery for this contract — the concepts delivered were ${list}. Reply in this thread ` +
      `with one of those (for example \`concept ${choices[0]}\`) and the brand pack will be ` +
      `built from it.`,
    '',
    `If nothing further arrives, LogoSmith will default-select the delivered concept with the ` +
      `highest lettering-readback score once the ${SELECTION_TIMEOUT_HOURS}-hour selection ` +
      `window closes, exactly as the gig terms state.`,
  ].join('\n');
}

/**
 * Tell the buyer, exactly once, that the concept they named was never
 * delivered. The cron reaches this branch every fifteen minutes for as long as
 * the contract waits, so the FR-17 selection trail doubles as the "already
 * said" marker — no extra column, and the notice is evidence in its own right.
 *
 * Message first, marker second: a failed `sendMessage` leaves no marker and is
 * retried next sweep, where silently swallowing it would leave the buyer
 * permanently unanswered. The cost of the opposite failure is one duplicate
 * message.
 */
async function noteUnselectablePick(
  deps: SelectionResolutionDeps,
  args: { contractId: string; conceptsJobKey: string; picked: number; delivered: Set<number> },
): Promise<void> {
  const { contractId, conceptsJobKey, picked, delivered } = args;
  const choices = [...delivered].sort((a, b) => a - b);
  const log = deps.logger.child({ contractId });

  if (choices.length === 0) {
    log.error({ picked }, 'buyer picked a slot but no delivered set is provable; no note sent');
    return;
  }

  const trail = await deps.jobs.listGateAudit(conceptsJobKey, SELECTION_GATE);
  if (trail.some((entry) => entry.result === UNSELECTABLE_RESULT)) return;

  await deps.client.sendMessage(contractId, buildUnselectablePickNote(picked, choices));
  await deps.jobs.recordGateAudit({
    jobKey: conceptsJobKey,
    contractId,
    slot: picked,
    gate: SELECTION_GATE,
    result: UNSELECTABLE_RESULT,
    detail: { picked, deliveredSlots: choices },
  });
  log.warn({ picked, deliveredSlots: choices }, 'buyer picked an undelivered concept; buyer told');
}

/**
 * Resolve one contract's concept selection and, when a winner exists, start
 * stage 2 (PRD FR-9, §6 step 7).
 *
 * Called from two places with one behaviour: the 15-minute cron selection poll,
 * and the `milestone.accepted` / `acceptance.auto_approved` webhook handlers
 * with `force: true` — a buyer who accepted M1 without ever posting a pick
 * should not then idle for the rest of the 72-hour window.
 *
 * The thread is read once. A parsed buyer reply for a concept that was actually
 * delivered selects immediately, at any age. Otherwise the default rule fires,
 * but only past `SELECTION_TIMEOUT_HOURS` or under `force`. Everything is a
 * no-op unless the selection row is at `concepts_delivered`.
 */
export async function resolveSelectionForContract(
  deps: SelectionResolutionDeps,
  contractId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const { jobs, concepts, selection, queue, botId } = deps;
  const log = deps.logger.child({ contractId });
  const now = clockOf(deps)();

  const row = await selection.get(contractId);
  if (!row || row.state !== 'concepts_delivered') {
    // `milestone.accepted` and `acceptance.auto_approved` fire for M2 as well
    // as M1 and both force, so this state guard — not the caller — is what
    // stops an M2 acceptance from re-running selection on a finished contract.
    log.debug({ state: row?.state ?? null }, 'selection resolution skipped: not awaiting a pick');
    return;
  }

  const conceptsJobKey = await buildJobKey(contractId, 'concepts');
  const delivered = deliveredSlots(await jobs.get(conceptsJobKey));

  const reader = createThreadReader({
    apiUrl: deps.apiUrl,
    apiKey: deps.apiKey,
    fetchImpl: deps.fetchImpl ?? ((url, init): Promise<Response> => fetch(url, init)),
  });
  const messages = await reader.listMessages(contractId);

  // THE SLICE IS LOAD-BEARING. `findSelection` has no time awareness: it
  // returns the first parseable non-bot message in whatever array it is handed,
  // and a bare "2" the buyer typed BEFORE M1 — answering some earlier question
  // in the thread — parses exactly like a concept pick and, being first, would
  // win. `selection.open()` writes `m1_delivered_at` immediately before
  // `deliverMilestone`, so a message strictly after it is one the M1 delivery
  // could plausibly have caused, and a message before it cannot be a reply to
  // a delivery that had not been posted yet.
  //
  // Strictly after, not at-or-after: a message sharing a millisecond with the
  // row's own creation is far likelier to be pre-M1 chatter. An unparseable
  // `createdAt` yields NaN and every NaN comparison is false, so a message with
  // no usable timestamp is excluded rather than trusted.
  const m1At = Date.parse(row.m1DeliveredAt);
  const picked = findSelection(
    messages.filter((message) => Date.parse(message.createdAt) > m1At),
    botId,
  );

  let winner: number;
  let source: SelectionSource;

  if (picked !== null && delivered.has(picked)) {
    winner = picked;
    source = 'buyer';
  } else {
    // A parsed pick naming a concept M1 never carried is the same hazard as the
    // default rule's, arriving through the buyer's door: a distinctness-demoted
    // slot keeps `ocr_pass = 1`, so stage 2's own `winner.ocrPass` guard would
    // wave it straight through and ship a pack built from a concept the buyer
    // was never shown. Refuse it, tell them once, and let the default rule
    // decide at the timeout.
    if (picked !== null) {
      await noteUnselectablePick(deps, { contractId, conceptsJobKey, picked, delivered });
    }

    const timedOut = Number.isFinite(m1At) && now.getTime() - m1At >= SELECTION_TIMEOUT_MS;
    if (opts.force !== true && !timedOut) {
      log.debug({ picked }, 'no usable buyer pick yet and still inside the selection window');
      return;
    }

    // Both sources, intersected. `listPassing()` alone can return a concept
    // that was demoted for distinctness and never delivered; the checkpoint set
    // alone has no scores to rank by.
    const passing = (await concepts.listPassing(contractId)).filter((concept) =>
      delivered.has(concept.slot),
    );
    const chosen = decideDefaultSelection(passing);
    if (chosen === null) {
      // Unreachable through the pipeline: M1 aborts rather than delivering when
      // fewer than two concepts pass, and `selection.open()` is only called on
      // the delivery leg. Refuse rather than invent a winner — a contract stuck
      // visibly at `concepts_delivered` with this line in the log is recoverable;
      // a pack built from a concept nobody can prove was delivered is not.
      log.error(
        { forced: opts.force === true, deliveredSlots: [...delivered] },
        'default selection found no delivered passing concept; leaving the contract awaiting',
      );
      return;
    }
    winner = chosen;
    source = 'default';
  }

  await selection.select(contractId, winner, source);

  // Read back what the store HOLDS rather than trusting what we asked it to
  // write. `select` is first-write-wins (its UPDATE is conditioned on
  // `state = 'concepts_delivered'`), so a webhook racing this sweep may already
  // have recorded a different winner — and stage 2 must be claimed for the
  // persisted one, not ours.
  const persisted = await selection.get(contractId);
  if (!persisted || persisted.state !== 'winner_selected' || persisted.winnerSlot === null) {
    log.error(
      { attempted: winner, state: persisted?.state ?? null },
      'selection write did not take; contract left awaiting selection',
    );
    return;
  }

  await jobs.recordGateAudit({
    jobKey: conceptsJobKey,
    contractId,
    slot: persisted.winnerSlot,
    gate: SELECTION_GATE,
    result: persisted.source ?? 'unknown',
    detail: {
      winnerSlot: persisted.winnerSlot,
      source: persisted.source,
      forced: opts.force === true,
      buyerReply: picked,
      deliveredSlots: [...delivered].sort((a, b) => a - b),
      m1DeliveredAt: row.m1DeliveredAt,
    },
  });

  const vectorJobKey = await buildJobKey(contractId, 'vector');
  const decision = await jobs.claim(vectorJobKey, contractId, 'vector');
  log.info(
    { winnerSlot: persisted.winnerSlot, source: persisted.source, ...decision },
    'winner selected; stage 2 claim decision',
  );
  if (decision.action === 'enqueue') {
    await queue.send({ contractId, jobKey: vectorJobKey, stage: 'vector' });
  }
}

/** The 15-minute selection poll: every contract still waiting on a pick. */
async function pollSelections(s: SweepServices): Promise<void> {
  // `listAwaitingSelection(now)` is every row still at `concepts_delivered` —
  // the cutoff is the wall clock, not the timeout, because a buyer reply
  // selects at any age. Whether the 72-hour default rule may fire is
  // `resolveSelectionForContract`'s decision, per contract.
  for (const row of await s.selection.listAwaitingSelection(clockOf(s)())) {
    try {
      await resolveSelectionForContract(s, row.contractId);
    } catch (err) {
      s.logger.warn(
        { err, contractId: row.contractId },
        'selection poll failed for this contract; retrying next sweep',
      );
    }
  }
}

// --- Parked jobs --------------------------------------------------------------

function buildGiveUpNote(job: JobRow): string {
  const vendor = vendorFor(job.parkReason);
  const outage =
    `${vendor.charAt(0).toUpperCase()}${vendor.slice(1)} has been unavailable continuously ` +
    `for more than ${PARKED_GIVE_UP_HOURS} hours, across automatic retries every fifteen ` +
    `minutes. Rather than hold this contract open past its delivery window without a word, ` +
    `LogoSmith is stopping here.`;

  if (job.stage === 'vector') {
    return [
      'LogoSmith could not build the brand pack for this contract.',
      '',
      outage,
      '',
      'Your Milestone 1 concepts and their lettering-readback evidence are unaffected and ' +
        'remain delivered — only the Milestone 2 vector pack could not be produced. Nothing ' +
        'further has been generated and no additional work is being claimed.',
      '',
      'LogoSmith cannot cancel or refund a contract itself. If you would rather stop here, ' +
        'please cancel this contract from your side to release the escrow, or raise a dispute ' +
        'if you would prefer the platform to adjudicate what was delivered.',
    ].join('\n');
  }

  return [
    'LogoSmith could not deliver this contract.',
    '',
    outage,
    '',
    'Nothing has been delivered and no work product is being claimed.',
    '',
    'LogoSmith cannot cancel or refund a contract itself — please cancel this contract from ' +
      'your side to release the escrow. Once the vendor recovers, posting the gig again is ' +
      'all it takes: LogoSmith bids on matching gigs automatically.',
  ].join('\n');
}

/**
 * The give-up leg: tell the buyer, record the FR-17 evidence, then move the job
 * to its terminal state.
 *
 * ORDER IS FAIL-SAFE, NOT ARBITRARY. `markDelivered` is last because it is the
 * step that removes the job from `listParked()` and therefore from this sweep's
 * reach. Doing it first would mean a failed `sendMessage` — much the likelier
 * of the two, being a remote call against a local D1 UPDATE — leaves a job that
 * is dead and never told anyone. As written, a failure at any point leaves the
 * job parked and retried next sweep; the worst case is one duplicate message.
 */
async function giveUpOnParkedJob(s: SweepServices, job: JobRow): Promise<void> {
  await s.client.sendMessage(job.contractId, buildGiveUpNote(job));
  await s.jobs.recordGateAudit({
    jobKey: job.jobKey,
    contractId: job.contractId,
    gate: 'parked-give-up',
    result: 'aborted',
    detail: {
      parkReason: job.parkReason,
      stage: job.stage,
      claimedAt: job.createdAt,
      giveUpAfterHours: PARKED_GIVE_UP_HOURS,
      spentUsd: job.spentUsd,
    },
  });
  await s.jobs.markDelivered(job.jobKey, 'aborted');
  s.logger.error(
    {
      jobKey: job.jobKey,
      contractId: job.contractId,
      stage: job.stage,
      parkReason: job.parkReason,
      claimedAt: job.createdAt,
    },
    'parked job exceeded the give-up bound; buyer notified and job aborted',
  );
}

/**
 * Re-enqueue every parked job, except the ones that have been failing long
 * enough to give up on.
 *
 * THE AGE IS MEASURED FROM `created_at`, NOT `updated_at`, AND THE DIFFERENCE
 * IS THE WHOLE POINT. `park()` touches `updated_at` — but so does `unpark()`,
 * and this loop unparks every job it re-enqueues. On a job looping
 * park → unpark → fail → park, `updated_at` therefore measures time since the
 * LAST failure, caps at roughly one cron interval, and never accumulates: it
 * cannot bound the loop it would exist to bound. `created_at` is written once
 * by `claim()`'s INSERT and appears in no UPDATE in jobs.ts, so it is the one
 * stable clock available. Because `job_key` is per `(contractId, stage)`, stage
 * 2's clock correctly starts at selection rather than at funding.
 *
 * The predicate is therefore "currently parked AND claimed more than
 * PARKED_GIVE_UP_HOURS ago" — a job that has failed to complete for that long
 * and is failing right now.
 */
async function sweepParkedJobs(s: SweepServices): Promise<void> {
  const giveUpBefore = clockOf(s)().getTime() - PARKED_GIVE_UP_HOURS * 60 * 60 * 1000;

  for (const job of await s.jobs.listParked()) {
    const log = s.logger.child({
      jobKey: job.jobKey,
      contractId: job.contractId,
      parkReason: job.parkReason,
    });
    try {
      const claimedAt = Date.parse(job.createdAt);
      if (Number.isFinite(claimedAt) && claimedAt < giveUpBefore) {
        await giveUpOnParkedJob(s, job);
        continue;
      }
      await s.jobs.unpark(job.jobKey);
      await s.queue.send({ contractId: job.contractId, jobKey: job.jobKey, stage: job.stage });
      log.info({ stage: job.stage }, 'parked job re-enqueued');
    } catch (err) {
      log.warn({ err }, 'parked-job sweep failed for this job; retrying next sweep');
    }
  }
}

// --- The sweeps ---------------------------------------------------------------

/**
 * The 15-minute cron sweep. Each step is awaited and isolated: a failure in one
 * is logged and the rest still run — the reputation refresh in particular must
 * land even when gig discovery blew up, because `GET /health` reads its D1
 * snapshot.
 */
export async function runFifteenMinuteSweep(s: SweepServices): Promise<void> {
  try {
    await runGigPollSweep({
      client: s.client,
      seen: s.seen,
      onGig: (gig) => maybePropose(s, gig),
      logger: s.logger,
    });
  } catch (err) {
    s.logger.error({ err }, 'sweep: gig poll/propose step failed; continuing');
  }

  try {
    // The firm floor is the estimator's 1.5×-cost target (cached per gig, so
    // this reuses the proposal's own estimate); `decideCounter` holds it, and
    // the D1 store makes "counter back once" survive across invocations.
    await runNegotiationSweep({
      client: s.client,
      pricingCalc,
      costEstimator: s.costEstimator,
      store: s.negotiationStore,
      logger: s.logger,
    });
  } catch (err) {
    s.logger.error({ err }, 'sweep: negotiation step failed; continuing');
  }

  try {
    await pollSelections(s);
  } catch (err) {
    s.logger.error({ err }, 'sweep: selection poll step failed; continuing');
  }

  try {
    await sweepParkedJobs(s);
  } catch (err) {
    s.logger.error({ err }, 'sweep: parked-job step failed; continuing');
  }

  try {
    const snapshot = await refreshReputationOnce({ source: s.reputationSource, logger: s.logger });
    if (snapshot) await saveReputationSnapshot(s.db, snapshot, clockOf(s)());
  } catch (err) {
    s.logger.error({ err }, 'sweep: reputation-refresh step failed; continuing');
  }
}

/**
 * The daily (06:00 UTC) sweep: §12 stuck-claim recovery. A job still `claimed`
 * with no checkpoint won its D1 claim but never reached the consumer — the
 * Queue send was lost — so nothing but this sweep will ever move it.
 */
export async function runDailySweep(s: SweepServices): Promise<void> {
  try {
    const cutoff = new Date(clockOf(s)().getTime() - STUCK_CLAIM_MINUTES * 60 * 1000);
    for (const job of await s.jobs.listStuckClaims(cutoff)) {
      await s.queue.send({ contractId: job.contractId, jobKey: job.jobKey, stage: job.stage });
      s.logger.warn(
        { jobKey: job.jobKey, contractId: job.contractId, stage: job.stage },
        'daily sweep: stuck claim re-enqueued',
      );
    }
  } catch (err) {
    s.logger.error({ err }, 'daily sweep: stuck-claim recovery step failed; continuing');
  }
}
