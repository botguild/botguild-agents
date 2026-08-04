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
import { parseFaviconBrief, resolveBrief } from './brief.js';
import {
  BRIEF_OUTAGE_PARK_REASON,
  HAIKU_MODEL_ID,
  MAX_SPEND_USD,
  PARKED_GIVE_UP_HOURS,
  SELECTION_GATE,
  SELECTION_INFERENCE_SELECTED,
  SELECTION_TIMEOUT_HOURS,
  STUCK_CLAIM_MINUTES,
  pricingCalc,
  scorerConfig,
} from './config.js';
import type { ProseBriefExtractor } from './proseBrief.js';
import {
  buildJobKey,
  saveReputationSnapshot,
  type ConceptRow,
  type ConceptStore,
  type JobRow,
  type JobStore,
  type SelectionStore,
} from './jobs.js';
import { MAX_SELECTION_INFERENCES_PER_CONTRACT, type SelectionInferrer } from './inferSelection.js';
import { createThreadReader, findSelectionIn, type ThreadMessage } from './threads.js';
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
  /**
   * The FR-9 Haiku fallback, consulted ONLY for messages the strict parser
   * returned null for (see `inferSelectionFromThread`).
   *
   * REQUIRED, NOT OPTIONAL, for two reasons. An optional dependency defaults to
   * "no fallback", which is a silent regression to the 72-hour wait on whichever
   * call site forgot it — and this object is built by hand in index.ts for the
   * `milestone.accepted` / `acceptance.auto_approved` handlers as well as by the
   * cron, so "forgot it" is a live possibility rather than a hypothetical.
   * Second, the Anthropic SDK issues its requests through the GLOBAL `fetch`,
   * which a harness's injected `fetchImpl` does NOT intercept: two test
   * harnesses in this app were silently dialling api.anthropic.com for exactly
   * that reason. A required field makes an absent double a compile error rather
   * than a live HTTPS call.
   */
  selectionInferrer: SelectionInferrer;
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
  /**
   * Prose-brief fallback for the ~all real gigs that carry no fenced JSON.
   * Required, not optional: an optional extractor would default to "resolve
   * nothing", which reads as "skip every prose gig" — a silent fail-open on the
   * one decision this seam exists to make.
   */
  briefExtractor: ProseBriefExtractor;
}

const clockOf = (deps: { now?: () => Date }): (() => Date) => deps.now ?? ((): Date => new Date());

const SELECTION_TIMEOUT_MS = SELECTION_TIMEOUT_HOURS * 60 * 60 * 1000;

/** The `result` marking the one-time "you picked a concept we never sent" note. */
const UNSELECTABLE_RESULT = 'unselectable-pick';
/** The `result` marking the one-time "we cannot tell what M1 delivered" note. */
const UNRESOLVABLE_RESULT = 'no-selectable-concept';
/**
 * The `result` marking a message the Haiku fallback read a pick out of. Shared
 * with `disputes.ts` through config.ts, which is why it is not declared here.
 */
const INFERENCE_SELECTED_RESULT = SELECTION_INFERENCE_SELECTED;
/** The `result` marking a message the Haiku fallback read and found no pick in. */
const INFERENCE_DECLINED_RESULT = 'inference-declined';
/**
 * The two markers together: "this bot has already paid to have this message
 * read". The trail is the marker for the same reason the FR-14 free-gig quota
 * uses it — it is append-only, it is already the customer-facing evidence
 * record, and it needs no new column.
 */
const INFERENCE_RESULTS: ReadonlySet<string> = new Set([
  INFERENCE_SELECTED_RESULT,
  INFERENCE_DECLINED_RESULT,
]);

/**
 * The message id a recorded inference row names, or null when the row's detail
 * is absent, damaged, or not the shape this module writes.
 *
 * `GateAuditRow.detail` is `unknown` by construction — the column holds
 * whatever the writing call passed it — so it is checked rather than cast. A
 * row that cannot be read yields null and is simply not counted as a marker,
 * which costs at most one repeated model call. `Object.hasOwn` is not needed
 * here because a bare read of `messageId` off `Object.prototype` cannot produce
 * a string; the `typeof` test is what makes the read safe.
 */
export function inferenceMessageId(detail: unknown): string | null {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return null;
  const value = (detail as Record<string, unknown>)['messageId'];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * An ISO-8601 instant as epoch millis, or NaN for anything else.
 *
 * `Date.parse` alone is far too lenient for a security-shaped comparison: it
 * reads the bare string `'12345'` as the YEAR 12345, so a pre-M1 reply carrying
 * a digits-only timestamp would sort AFTER the M1 delivery and be selected —
 * inverting the exact guard the slice below exists to provide. Requiring a
 * literal `T` keeps epoch-millis and year-only forms out. Not reachable against
 * today's platform, which sends ISO strings, but the failure mode is silent and
 * the cost of the check is nothing.
 */
function parseInstant(value: unknown): number {
  if (typeof value !== 'string' || !value.includes('T')) return NaN;
  return Date.parse(value);
}

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
  [BRIEF_OUTAGE_PARK_REASON]: 'the service that reads the brand brief out of your gig text',
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
 *
 * A gig whose brief cannot be resolved at all is skipped rather than bid on:
 * the pipeline would reject it after funding, and a rejected funded contract
 * costs reputation that a silent non-bid does not.
 */
export async function maybePropose(s: SweepServices, gig: Gig): Promise<void> {
  const log = s.logger.child({ gigId: gig.id });
  if (!shouldPropose(gig, scorerConfig)) return;

  // THE ORDERING BELOW IS THE COST CONTROL, AND IT IS DELIBERATE. Prose
  // extraction is a Haiku call — MEASURED at 412 input tokens for a
  // representative gig, so ~$0.0005 a call against a $1 anchor — and it runs
  // strictly AFTER `shouldPropose`: on the relevance-cleared candidates only,
  // never on every gig the 15-minute poll lists. The poll's SeenStore bounds it
  // further to once per gig id. Hoisting it above the score would turn a
  // per-candidate cost into ~$0.0005 × every open gig on the marketplace, every
  // fifteen minutes, forever.
  //
  // The favicon gig is exempt because it carries no LogoBrief at all — its
  // brief is a `logoUrl` (US-2), which `parseFaviconBrief` validates on its
  // own, and running a brand-name extraction against it would only ever refuse
  // it. Asked here rather than reused from `pricingCalc(gig).price === 0`
  // because that value is 0 for BOTH free shapes and the other one (the $0
  // taster) does need a LogoBrief — this is the intake question, not the
  // pricing question.
  const description = gig.description ?? '';
  if (!parseFaviconBrief(description).ok) {
    const brief = await resolveBrief(gig, s.briefExtractor);
    if (!brief.ok) {
      log.info({ reason: brief.reason }, 'no intakeable logo brief; not bidding on this gig');
      return;
    }
  }

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
  // Non-empty by the caller's invariant: `resolveSelectionForContract` returns
  // early on an empty delivered set (via noteSelectionUnresolvable), so there
  // is always at least one concept to name here.
  const choices = [...delivered].sort((a, b) => a - b);
  const log = deps.logger.child({ contractId });

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
 * Tell the buyer, exactly once, that LogoSmith cannot determine which concepts
 * Milestone 1 delivered and therefore cannot resolve a winner on its own.
 *
 * The alternative — the shape this replaced — was to log an error and return,
 * which leaves a FUNDED contract sitting at `concepts_delivered` forever with
 * the buyer never hearing anything at all. Refusing to select is right; going
 * silent is not. Deduped through the same FR-17 selection trail as the
 * unselectable-pick note, since the cron reaches this branch every fifteen
 * minutes for as long as the contract waits.
 */
async function noteSelectionUnresolvable(
  deps: SelectionResolutionDeps,
  args: { contractId: string; conceptsJobKey: string },
): Promise<void> {
  const { contractId, conceptsJobKey } = args;
  const trail = await deps.jobs.listGateAudit(conceptsJobKey, SELECTION_GATE);
  if (trail.some((entry) => entry.result === UNRESOLVABLE_RESULT)) return;

  await deps.client.sendMessage(
    contractId,
    [
      'LogoSmith needs a hand with this contract.',
      '',
      'The record of which concepts were delivered for Milestone 1 is incomplete on our side, ' +
        'so LogoSmith will not pick a winner by itself — choosing one it cannot prove you were ' +
        'shown is not something it is willing to do with your logo.',
      '',
      'Reply in this thread naming the concept you want (for example `concept 1`) and the brand ' +
        'pack will be built from it. If you would rather not continue, LogoSmith cannot cancel ' +
        'or refund a contract itself — please cancel from your side to release the escrow.',
    ].join('\n'),
  );
  await deps.jobs.recordGateAudit({
    jobKey: conceptsJobKey,
    contractId,
    gate: SELECTION_GATE,
    result: UNRESOLVABLE_RESULT,
  });
}

/** A pick the Haiku fallback read, and the buyer's own words behind it. */
interface InferredPick {
  slot: number;
  /** The verbatim span of the buyer's message the answer rests on. */
  quote: string;
  /** Which message it came from — the evidence trail names it. */
  messageId: string;
}

/**
 * THE FALLBACK, AND ONLY THE FALLBACK. Ask Haiku to read the buyer replies the
 * strict parser could not, oldest first, and stop at the first that yields a
 * pick inside the delivered set.
 *
 * The caller reaches this ONLY when `findSelectionIn` found no usable pick, so
 * a message the strict parser reads is never sent to a model and nothing here
 * can override a literal reading of the buyer's words. `parseSelection` is
 * unchanged and untouched: see threads.ts's header for why loosening it is the
 * one change that has been made and reverted three times.
 *
 * WHY OLDEST FIRST, ONE MESSAGE AT A TIME. It reproduces FR-9 first-wins
 * structurally rather than asking a model to compare replies: `SelectionStore.
 * select` is itself first-write-wins, so the first reply that reads as a pick
 * is the one whose answer the store will actually keep. It also makes grounding
 * trivial — a quote has exactly one message it can belong to — and it means a
 * long thread costs one call per unread message rather than one call over a
 * transcript nobody can audit afterwards.
 *
 * THE BOUND IS THE TRAIL. The 15-minute cron reaches an awaiting contract
 * roughly 288 times across the FR-9 window, so an unbounded fallback would
 * re-ask about the same message forever. Every message the model ANSWERS is
 * marked in the FR-17 selection trail and never asked about again, and
 * `MAX_SELECTION_INFERENCES_PER_CONTRACT` caps the lifetime total so a buyer
 * posting many replies cannot turn each one into a call. Together those bound
 * the spend for one contract at that many calls, ever.
 *
 * A MESSAGE THE MODEL NEVER SAW STAYS ASKABLE. A transport failure returns
 * `outage` and writes no marker, because retiring a message on our vendor's bad
 * minute would silently cost the buyer their pick — the exact shape of the
 * final review's H1. An outage also stops this sweep's loop: the next message
 * would fail the same way, and the next cron is fifteen minutes away.
 *
 * THE SUCCESS ROW IS NOT WRITTEN HERE. A `inference-selected` marker written
 * before `selection.select` succeeded would retire the message that carries the
 * buyer's pick if the write then failed, losing it permanently; written after,
 * a failed write costs one repeated call and recovers. That is the opposite
 * ordering to the free-gig quota's marker, and deliberately so — there,
 * over-counting errs toward refusing, which is right for an abuse guard; here,
 * over-asking errs toward honouring what the buyer wrote, which is right for a
 * selection.
 */
async function inferSelectionFromThread(
  deps: SelectionResolutionDeps,
  args: {
    contractId: string;
    conceptsJobKey: string;
    messages: ThreadMessage[];
    delivered: Set<number>;
  },
): Promise<InferredPick | null> {
  const { contractId, conceptsJobKey, messages, delivered } = args;
  const log = deps.logger.child({ contractId });

  const trail = await deps.jobs.listGateAudit(conceptsJobKey, SELECTION_GATE);
  const examined = new Set<string>();
  for (const entry of trail) {
    if (!INFERENCE_RESULTS.has(entry.result)) continue;
    const id = inferenceMessageId(entry.detail);
    if (id !== null) examined.add(id);
  }

  let budget = MAX_SELECTION_INFERENCES_PER_CONTRACT - examined.size;
  if (budget <= 0) {
    log.info(
      { examined: examined.size, cap: MAX_SELECTION_INFERENCES_PER_CONTRACT },
      'selection inference budget for this contract is spent; leaving it to the default rule',
    );
    return null;
  }

  for (const message of messages) {
    if (budget <= 0) break;
    // Bot-authored text is excluded BEFORE the model sees it, for the reason
    // findSelection excludes it before parsing: this bot writes "concept N"
    // into the M1 delivery note, the gate-failure notes and the unselectable-
    // pick note, and a model shown its own instruction to "reply with
    // `concept 1|2|3`" has every reason to read a selection out of it.
    if (message.senderId === deps.botId) continue;
    if (examined.has(message.id)) continue;

    const result = await deps.selectionInferrer.infer({ message, allowed: delivered });
    if (result.outage) {
      log.warn(
        { messageId: message.id },
        'selection inference is unavailable; message left unread and retried next sweep',
      );
      return null;
    }
    budget -= 1;

    // THE DELIVERED-SET INTERSECTION, RE-CHECKED AT THE POINT OF DECISION.
    // `SelectionInferrer` enforces it too, and today's implementation does so
    // correctly — but this is where a winner is actually chosen, and `slot` is
    // typed `number | null` by an interface anything can implement. Task 21
    // settled the principle on the same shape of question: the module that
    // makes the claim is the module that verifies it, rather than resting on a
    // caller elsewhere behaving. An out-of-set answer is treated as a decline,
    // not as a buyer error — the buyer typed nothing this module could read, so
    // there is nothing to tell them they got wrong.
    const usable = result.slot !== null && delivered.has(result.slot) ? result.slot : null;

    if (usable === null || result.quote === null) {
      await deps.jobs.recordGateAudit({
        jobKey: conceptsJobKey,
        contractId,
        gate: SELECTION_GATE,
        result: INFERENCE_DECLINED_RESULT,
        detail: {
          messageId: message.id,
          model: HAIKU_MODEL_ID,
          costUsd: result.costUsd,
          reason:
            result.slot !== null && usable === null
              ? `slot ${result.slot} was not delivered`
              : result.reason,
        },
      });
      continue;
    }

    log.info(
      { messageId: message.id, slot: usable, costUsd: result.costUsd },
      'selection inferred from a reply the strict parser could not read',
    );
    return { slot: usable, quote: result.quote, messageId: message.id };
  }
  return null;
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
 * delivered selects immediately, at any age. Failing that — and only failing
 * that — the Haiku fallback is asked to read the replies the strict parser
 * could not, which also selects at any age. Otherwise the default rule fires,
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

  // Nothing is provably deliverable, so no pick can be honoured and the default
  // rule has nothing to rank. Refusing to select is right — but going silent on
  // a funded contract is not, and this branch would otherwise stall it forever
  // with only a log line. Tell the buyer once and leave the row awaiting.
  if (delivered.size === 0) {
    log.error('no delivered concept set is provable for this contract; selection cannot resolve');
    await noteSelectionUnresolvable(deps, { contractId, conceptsJobKey });
    return;
  }

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
  // row's own creation is far likelier to be pre-M1 chatter. An untimestamped
  // or non-ISO `createdAt` yields NaN and every NaN comparison is false, so a
  // message with no usable timestamp is excluded rather than trusted.
  const m1At = parseInstant(row.m1DeliveredAt);
  const scoped = messages.filter((message) => parseInstant(message.createdAt) > m1At);

  // Scoped to the delivered set, so a pick that CANNOT be built is stepped over
  // rather than fixated on. Taking the first parseable reply regardless would
  // mean a buyer who names an undelivered concept, is told to correct it, and
  // does exactly that gets their correction ignored forever — every later sweep
  // re-reads the refused reply and never reaches the correction. Two replies
  // that both name DELIVERED concepts still resolve to the first (findSelectionIn).
  const { selected: picked, unavailable } = findSelectionIn(scoped, botId, delivered);

  // A parsed pick naming a concept M1 never carried is the same hazard as the
  // default rule's, arriving through the buyer's door: a distinctness-demoted
  // slot keeps `ocr_pass = 1`, so stage 2's own `winner.ocrPass` guard would
  // wave it straight through and ship a pack built from a concept the buyer was
  // never shown. It is refused — and explained.
  //
  // Explained even when a LATER reply was usable: a buyer whose first message
  // did nothing at all is owed the reason, and skipping the note whenever the
  // scan happened to recover would make the explanation depend on cron timing.
  // The dedupe keeps it to one message either way.
  if (unavailable !== null) {
    await noteUnselectablePick(deps, {
      contractId,
      conceptsJobKey,
      picked: unavailable,
      delivered,
    });
  }

  // THE FALLBACK RUNS ONLY WHEN THE STRICT PARSER FOUND NOTHING. A reply
  // `parseSelection` recognized is never re-read by a model, so an inference can
  // never override a literal reading of the buyer's own words.
  //
  // It runs BEFORE the timeout check, which is the entire point: a buyer who
  // wrote "concept 2 works" has answered, and making them wait out the 72-hour
  // window for an auto-pick because a regex could not read a perfectly clear
  // sentence is the cost this exists to stop paying.
  const inferred =
    picked === null
      ? await inferSelectionFromThread(deps, {
          contractId,
          conceptsJobKey,
          messages: scoped,
          delivered,
        })
      : null;

  let winner: number;
  let source: SelectionSource;

  if (picked !== null) {
    winner = picked;
    source = 'buyer';
  } else if (inferred !== null) {
    winner = inferred.slot;
    source = 'inferred';
  } else {
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
      // The delivered set is non-empty but no concept row backs it — the rows
      // were lost or never written. Refuse rather than invent a winner, and
      // tell the buyer, for the same reason as the empty-set branch above: a
      // funded contract that goes quiet forever is the worse failure.
      log.error(
        { forced: opts.force === true, deliveredSlots: [...delivered] },
        'default selection found no delivered passing concept; leaving the contract awaiting',
      );
      await noteSelectionUnresolvable(deps, { contractId, conceptsJobKey });
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

  // THE EVIDENCE FOR AN INFERRED PICK, written only once the store actually
  // holds it. Two conditions, both load-bearing: the persisted source must be
  // ours, and the persisted winner must be the slot we inferred — a webhook
  // racing this sweep can have already written a different winner by a
  // different route, and a row claiming we inferred THAT one would be a false
  // statement in the record a dispute is answered from.
  //
  // Written after the select rather than before it so that a failed write costs
  // one repeated model call instead of permanently retiring the message that
  // carries the buyer's pick (see `inferSelectionFromThread`).
  if (
    inferred !== null &&
    persisted.source === 'inferred' &&
    persisted.winnerSlot === inferred.slot
  ) {
    await jobs.recordGateAudit({
      jobKey: conceptsJobKey,
      contractId,
      slot: inferred.slot,
      gate: SELECTION_GATE,
      result: INFERENCE_SELECTED_RESULT,
      // `quote` is the buyer's own words, verified to occur in their message
      // before it got here. It is in this trail because the dispute response
      // has to be able to show WHAT WAS READ, not merely assert that something
      // was: "we inferred it" without the words is not evidence.
      detail: {
        messageId: inferred.messageId,
        slot: inferred.slot,
        quote: inferred.quote,
        model: HAIKU_MODEL_ID,
      },
    });
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
      inferredFrom: inferred === null ? null : inferred.messageId,
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

/**
 * Why a parked job is being given up on. Two independent bounds, and the note
 * has to say which one fired because they are different facts about the job.
 */
export type GiveUpReason =
  /** `parked_since` is older than PARKED_GIVE_UP_HOURS. */
  | { kind: 'age'; blockedSinceMs: number }
  /** Realized vendor spend has passed MAX_SPEND_USD (see `sweepParkedJobs`). */
  | { kind: 'spend' };

/**
 * The give-up note.
 *
 * EVERY CLAIM HERE IS SUBSTANTIATED BY A PERSISTED COLUMN, and no more than
 * that. The age branch says work has been blocked since a recorded instant
 * (`parked_since`) and that the job is blocked on a named vendor RIGHT NOW
 * (`park_reason`); it does NOT claim that vendor was continuously unavailable
 * for the whole span — the row cannot prove that, and an earlier draft asserted
 * it anyway. The spend branch quotes `spent_usd` and the cap, both real
 * numbers, and claims nothing about duration.
 *
 * The closing paragraph is per stage, because the remedy differs: M2 leaves the
 * buyer holding delivered concepts, and a free-funnel job (`single`, PRD
 * US-2/US-3) has no escrow to release, so telling those buyers to cancel to
 * release one would be nonsense.
 */
function buildGiveUpNote(job: JobRow, reason: GiveUpReason, nowMs: number): string {
  const vendor = vendorFor(job.parkReason);
  const blocked =
    reason.kind === 'age'
      ? `Work on this contract has been blocked since ` +
        `${new Date(reason.blockedSinceMs).toISOString()} — over ` +
        `${Math.floor((nowMs - reason.blockedSinceMs) / (60 * 60 * 1000))} hours — and LogoSmith ` +
        `has been retrying automatically every fifteen minutes that whole time. It is currently ` +
        `waiting on ${vendor}, which is still not responding. Rather than hold this contract ` +
        `open past its delivery window without a word, LogoSmith is stopping here.`
      : `Work on this contract has failed and been retried repeatedly, and those retries have ` +
        `now cost LogoSmith $${job.spentUsd.toFixed(2)} of its own vendor budget against a ` +
        `$${MAX_SPEND_USD.toFixed(2)} per-job cap — without producing anything deliverable. It ` +
        `is currently blocked on ${vendor}. Rather than keep buying attempts for a job that is ` +
        `not converging, LogoSmith is stopping here. You have not been charged for any of it.`;

  if (job.stage === 'vector') {
    return [
      'LogoSmith could not build the brand pack for this contract.',
      '',
      blocked,
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

  if (job.stage === 'single') {
    return [
      'LogoSmith could not deliver this free job.',
      '',
      blocked,
      '',
      'Nothing has been delivered, and nothing has been charged — this was a free LogoSmith ' +
        'job, so there is no payment and nothing for you to cancel. Once the vendor recovers, ' +
        'posting the gig again is all it takes: LogoSmith bids on matching gigs automatically.',
    ].join('\n');
  }

  return [
    'LogoSmith could not deliver this contract.',
    '',
    blocked,
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
async function giveUpOnParkedJob(
  s: SweepServices,
  job: JobRow,
  reason: GiveUpReason,
): Promise<void> {
  const nowMs = clockOf(s)().getTime();
  await s.client.sendMessage(job.contractId, buildGiveUpNote(job, reason, nowMs));
  await s.jobs.recordGateAudit({
    jobKey: job.jobKey,
    contractId: job.contractId,
    gate: 'parked-give-up',
    result: 'aborted',
    detail: {
      bound: reason.kind,
      parkReason: job.parkReason,
      stage: job.stage,
      parkedSince: job.parkedSince,
      blockedHours:
        reason.kind === 'age' ? (nowMs - reason.blockedSinceMs) / (60 * 60 * 1000) : null,
      giveUpAfterHours: PARKED_GIVE_UP_HOURS,
      spentUsd: job.spentUsd,
      maxSpendUsd: MAX_SPEND_USD,
    },
  });
  await s.jobs.markDelivered(job.jobKey, 'aborted');
  s.logger.error(
    {
      jobKey: job.jobKey,
      contractId: job.contractId,
      stage: job.stage,
      bound: reason.kind,
      parkReason: job.parkReason,
      parkedSince: job.parkedSince,
      spentUsd: job.spentUsd,
    },
    'parked job exceeded a give-up bound; buyer notified and job aborted',
  );
}

/**
 * Re-enqueue every parked job, except the ones that have been failing long
 * enough to give up on.
 *
 * THE CLOCK IS `parked_since`, AND NEITHER OF THE OBVIOUS ALTERNATIVES WORKS.
 * `updated_at` is touched by `park()` — but also by `unpark()`, and this loop
 * unparks every job it re-enqueues, so on a park → unpark → fail → park loop it
 * measures time since the LAST failure, caps at roughly one cron interval, and
 * never accumulates. `created_at` is stable, but it measures age-since-CLAIM: a
 * job whose Queue send was lost sits idle for a day, is recovered by the daily
 * sweep, parks once on a transient blip — and would be aborted on the very next
 * sweep with a note claiming a six-hour outage that never happened. That turns
 * a recoverable blip into an abort AND lies about why.
 *
 * `parked_since` is set at the first park of a failing spell and cleared only
 * on a terminal state, so it measures exactly "how long has this job been
 * unable to finish". A parked row without one predates the column: it is
 * re-enqueued as normal and acquires one at its next park, so the bound
 * self-heals rather than guessing.
 *
 * THE CLOCK IS NOT THE ONLY BOUND, BECAUSE MONEY IS THE OTHER AXIS. A retryable
 * vendor failure consumes no FR-5 attempt (Task 18 Ruling 1), so `attempts`
 * cannot stop this loop — and a failure that happened AFTER the vendor billed
 * us (a dead asset link, an unreadable 200) spends real money every cycle.
 * Six hours at the fifteen-minute cadence is twenty-four of those. So a job
 * whose REALIZED spend has passed `MAX_SPEND_USD` is given up on immediately,
 * whatever the clock says.
 *
 * `>` NOT `>=`, AND THAT IS LOAD-BEARING. `decideSlotAction` stops at
 * `>= MAX_SPEND_USD`, and today's worst legitimate stage-1 burn lands EXACTLY
 * on the cap (config.ts's MAX_SPEND_USD comment: zero slack by design). A `>=`
 * here would abort a job that had merely used its full, contracted
 * regeneration allowance and then hit one transient OCR outage — a job with
 * paid bytes safe in R2 that the very next sweep would have re-gated for free
 * and delivered. `>` fires only once a park loop has actually spent PAST the
 * cap, which nothing but a billed failure can do, and it bounds that overshoot
 * at one generation because the paid-failure path parks and returns
 * immediately.
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
      const parkedSince = parseInstant(job.parkedSince);
      if (Number.isFinite(parkedSince) && parkedSince < giveUpBefore) {
        await giveUpOnParkedJob(s, job, { kind: 'age', blockedSinceMs: parkedSince });
        continue;
      }
      if (job.spentUsd > MAX_SPEND_USD) {
        await giveUpOnParkedJob(s, job, { kind: 'spend' });
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
      // Per job, not per step: this sweep runs once a DAY, so one failing send
      // must not cost every remaining stuck claim another twenty-four hours.
      try {
        await s.queue.send({ contractId: job.contractId, jobKey: job.jobKey, stage: job.stage });
        s.logger.warn(
          { jobKey: job.jobKey, contractId: job.contractId, stage: job.stage },
          'daily sweep: stuck claim re-enqueued',
        );
      } catch (err) {
        s.logger.error(
          { err, jobKey: job.jobKey, contractId: job.contractId },
          'daily sweep: re-enqueue failed for this stuck claim; retrying tomorrow',
        );
      }
    }
  } catch (err) {
    s.logger.error({ err }, 'daily sweep: stuck-claim recovery step failed; continuing');
  }
}
