// ---------------------------------------------------------------------------
// The dispute response path (PRD §10.9).
//
// A dispute response is read by someone deciding whether we were honest, so
// every claim in it has to be traceable to something recorded AT THE TIME:
//
//   1. EVERY VALUE IS READ BACK, NEVER RECOMPUTED. The readback verdicts come
//      out of the `concepts` table exactly as the OCR gate wrote them — score,
//      transcription, model and pass flag together. Re-deriving `pass` from
//      today's threshold would silently restate a months-old verdict under a
//      rule that did not exist when the image shipped, which is precisely the
//      thing a payer disputing a delivery is entitled to check.
//
//   2. A MISSING FACT IS NAMED, NOT DROPPED. `evidenceGaps` follows the same
//      rule report.ts's does: an evidence document that quietly omits an
//      inconvenient value is worse than one that admits it could not source it.
//      "0" and "unknown" are never the same value — a genuinely zero readback
//      score is a measurement and is reported as one.
//
//   3. NOTHING IS INVENTED TO FILL A HOLE. A stage that was never claimed, a
//      contract with no concepts, a job that aborted before selection: all of
//      those are legitimate recorded states and are reported as what they are.
//      The response never guesses at what "probably" happened — and where two
//      records could each be the right one, it names neither (`seedForConcept`).
//      A null in this document therefore never carries a CAUSE it cannot
//      prove: the prose says what could not be established, not why.
//
//   4. THE ANSWER IS FILED EXACTLY ONCE. `respond` claims the contract with a
//      unique-constraint INSERT into `dispute_responses` BEFORE it posts, so
//      concurrent webhook redeliveries collapse to one counter-statement. A
//      read-then-write guard would let every concurrent delivery pass the read
//      and file its own response.
//
// Injected deps only — no Workers bindings, no `env.*`. index.ts adapts them.
// ---------------------------------------------------------------------------

import type { AgentMcpClient } from '@botguild/agent-core';
import type { D1Like } from '@botguild/agent-core-workers';
import type { Logger } from 'pino';
import { SELECTION_GATE, SELECTION_INFERENCE_SELECTED } from './config.js';
import {
  buildJobKey,
  type ConceptRow,
  type ConceptStore,
  type GateAuditRow,
  type JobRow,
  type JobStore,
  type SelectionStore,
} from './jobs.js';
import {
  buildLicenseManifest,
  summarizeInputScreening,
  type LicenseManifest,
  type LicenseRow,
  type ReportInputScreening,
  type ReportOcrSnapshot,
} from './report.js';
import type { JobKind, JobOutcome, JobStage, JobStatus, SelectionSource } from './types.js';

// --- The evidence document ----------------------------------------------------

/** One stage's `jobs` row, as recorded. Absent fields are the row's own nulls. */
export interface DisputeJobRecord {
  status: JobStatus;
  outcome: JobOutcome | null;
  kind: JobKind | null;
  /** Vendor spend this stage booked. `0` is a measurement, not an unknown. */
  spentUsd: number;
  parkReason: string | null;
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
}

export interface DisputeStageRecord {
  stage: JobStage;
  /** The FR-15 claim key — always computable from the contract id, so it is
   *  quoted even for a stage that was never claimed and can be searched for. */
  jobKey: string;
  /** `null` when D1 holds no row under that key: the stage never ran. That is
   *  a recorded fact (a paid contract never claims `single`, and a contract
   *  disputed before selection never claims `vector`), not a missing record. */
  job: DisputeJobRecord | null;
}

export interface DisputeConcept {
  slot: number;
  axisId: string;
  vendor: string;
  /** The vendor's own request id for this exact generation, so the vendor can
   *  be asked to confirm provenance. `null` where the vendor issued none. */
  vendorRequestId: string | null;
  /**
   * Where the delivered bytes are stored, so a "that is not the image you
   * showed me" dispute resolves against the exact object. The key is prefixed
   * with the job's §12 capability token — already published to this payer in
   * the milestone delivery note, and the same token `evidenceUrls` links.
   */
  r2Key: string | null;
  /**
   * The vendor RNG seed the delivered image was generated from, recovered from
   * the gate audit row that recorded that image's verdict — the strongest
   * answer to "this is not what I asked for", because the image can be
   * regenerated from it.
   *
   * `null` means NO SEED COULD BE NAMED FROM THE RECORD, and this document
   * does not claim to know which of its causes applies: the vendor issued none
   * (only some do), the recorded attempts for this slot cannot be told apart so
   * naming one would be a guess, the slot was re-gated after a park (the seed
   * is not carried across invocations), or the audit row's stored detail no
   * longer parses. The last three ARE provenance being missing, so a null is
   * never a claim that provenance is complete — only that this field asserts
   * nothing.
   */
  seed: number | null;
  phash: string | null;
  attemptsUsed: number;
  /** The stored lettering-readback snapshot. `null` when the slot never
   *  reached the vision model — named in `evidenceGaps`, never inferred. */
  ocr: ReportOcrSnapshot | null;
}

/**
 * What was read, and out of which message, when the winner was INFERRED.
 *
 * THIS IS THE POINT OF THE `inferred` SOURCE. "I never chose that" is answered
 * by two different sentences depending on how the pick was made: with `buyer`,
 * the reply was recognized outright by a parser that only accepts whole-message
 * affirmative selections, and the record's claim is simply that they said it;
 * with `inferred`, a model read a pick out of a reply that parser could not
 * read, and the honest claim is narrower — THESE ARE THE WORDS IT READ IT OUT
 * OF. `quote` was verified to occur verbatim in that message before it was ever
 * recorded, so the payer can check it against their own thread.
 */
export interface DisputeInference {
  /** The contract-thread message the quote was taken from. */
  messageId: string;
  /** The buyer's own words the pick rests on, verbatim. */
  quote: string;
  /** The model that read them. */
  model: string;
  /** When it was read. */
  at: string;
}

export interface DisputeSelection {
  state: 'concepts_delivered' | 'winner_selected' | 'pack_delivered';
  /** `null` while the state is `concepts_delivered`: the state says why. */
  winnerSlot: number | null;
  /**
   * FR-9, and it is THREE facts: `buyer` (the strict whole-message parser
   * recognized their reply), `inferred` (it could not, and a model read a pick
   * out of one reply — see `inference`), or `default` (nobody replied readably
   * inside the selection window and the best lettering-readback score won).
   */
  selectionSource: SelectionSource | null;
  /**
   * Present only for an `inferred` winner, and `null` for every other source —
   * including `inferred` when the reading could not be recovered from the
   * trail, which is named in `evidenceGaps` rather than papered over. It is
   * never populated for `buyer` or `default`, because neither of those rests
   * on a reading and a quote beside them would imply one.
   */
  inference: DisputeInference | null;
  m1DeliveredAt: string;
}

export interface DisputeAuditRow {
  /** The autoincrement id. Also the ordering key — see `mergeAuditTrail`. */
  id: number;
  stage: JobStage;
  slot: number | null;
  gate: string;
  result: string;
  /**
   * Published VERBATIM, deliberately diverging from `summarizeInputScreening`,
   * which projects its verdict field by field so that an audit row carrying an
   * internal header or a debug blob cannot leak into a customer-facing
   * document. That projection is possible there because a verdict has one known
   * shape; a trail row does not — the details are pack gate reports,
   * distinctness pairs, spend counters, vendor errors — and a whitelist would
   * silently drop whichever field a future gate adds, which in an evidence
   * document is the more expensive failure. The rule that makes this safe is on
   * the WRITE side, and it is FR-17's own: `gate_audit` is the customer-facing
   * evidence trail, so nothing secret may be recorded into a gate detail. If
   * that ever stops holding, this is the field that ships it.
   */
  detail: unknown;
  createdAt: string;
}

export interface DisputeEvidence {
  version: 1;
  contractId: string;
  assembledAt: string;
  note: string;
  stages: DisputeStageRecord[];
  concepts: DisputeConcept[];
  licenses: LicenseManifest;
  selection: DisputeSelection | null;
  inputScreening: ReportInputScreening;
  gateAudit: DisputeAuditRow[];
  evidenceUrls: string[];
  /** Evidence this response could not source, named in the document rather
   *  than papered over. Empty when the record is complete. */
  evidenceGaps: string[];
}

// --- Deps ---------------------------------------------------------------------

export interface DisputeEvidenceDeps {
  jobs: Pick<JobStore, 'get' | 'listGateAudit'>;
  concepts: Pick<ConceptStore, 'list'>;
  selection: Pick<SelectionStore, 'get'>;
  /** Origin the deliverable and evidence-page URLs are built from. */
  publicBaseUrl: string;
  now?: () => Date;
}

export interface DisputeDeps extends DisputeEvidenceDeps {
  /** The `dispute_responses` claim is a raw INSERT: it is a one-row
   *  idempotency latch with no store of its own, and the whole point is that
   *  the DATABASE decides the winner. */
  db: D1Like;
  // AgentMcpClient has private fields, so a test fake must be typed against a
  // Pick view rather than the class itself.
  mcp: Pick<AgentMcpClient, 'respondToDispute'>;
  logger: Logger;
}

export interface DisputeResponder {
  respond(contractId: string): Promise<void>;
}

// --- Static copy --------------------------------------------------------------

const EVIDENCE_NOTE =
  'Assembled from LogoSmith’s own records for this contract, written while the work ran: ' +
  '`concepts` (one row per generated image, with the vendor request id and the lettering ' +
  'readback verdict as the gate recorded it, and the generation seed recovered from the audit ' +
  'row that recorded that verdict), `selection` (the winner and how it was chosen — see below), ' +
  '`jobs` (the per-stage idempotency claims and vendor spend), and `gate_audit` (the ' +
  'append-only gate decision trail, listed here in insert order across every stage). Nothing ' +
  'is recomputed at dispute time. A null `detail` on an audit row means either that no detail ' +
  'was recorded for that row or that the recorded detail no longer parses — a damaged row is ' +
  'degraded to null rather than dropped, so the row itself is always present. The licence ' +
  'section covers the generated concept images; the delivered licenses.json additionally covers ' +
  'the converted logo.svg, whose raster-to-vector conversion issues no per-request identifier. ' +
  'A null `vendorRequestId` on a concept means the vendor returned no per-request identifier. A ' +
  'null `seed` means no seed could be named from the record, and this document does not claim to ' +
  'know why: the vendor may have issued none, the recorded attempts for that slot may be ' +
  'indistinguishable so naming one would be a guess, the slot may have been re-gated after a ' +
  'pause, or that row’s stored detail may no longer parse. Some of those are provenance genuinely ' +
  'missing, so a null seed asserts nothing either way rather than confirming the record is ' +
  'complete. `selection.selectionSource` distinguishes THREE different facts and they should not ' +
  'be read as one: `buyer` means the reply was recognized outright by a strict parser that ' +
  'accepts only whole-message affirmative selections; `inferred` means it was NOT — the reply ' +
  'was not in a form that parser accepts, so a model was asked to read it, and ' +
  '`selection.inference` names the message and quotes the buyer’s own words the choice was read ' +
  'out of, verified to occur verbatim in that message before it was recorded; `default` means no ' +
  'readable reply arrived inside the selection window and the concept with the best ' +
  'lettering-readback score was chosen automatically, exactly as the gig terms state. ' +
  '`selection.inference` is null for the other two sources because neither rests on a reading. ' +
  'Anything this response could not source is named in `evidenceGaps`.';

/**
 * The gap sentences, as an allow-list of the things this module knows it can
 * fail to source. Each one explains a specific `null`/`[]` in the document
 * above it, so a reader never has to guess whether a missing value means
 * "nothing happened" or "the record could not be read".
 */
const GAP = {
  noJobRows:
    'D1 holds no job row for any stage of this contract, so this response can say nothing ' +
    'about what was claimed, spent or delivered. Each stage’s idempotency key is quoted ' +
    'above so the record can still be searched for directly.',
  noConcepts:
    'No concept row exists for this contract, so no per-image provenance, no lettering ' +
    'readback and no perceptual hash could be sourced. A concept row is written as each image ' +
    'is generated, so their absence means no image was recorded at all — the gate audit trail ' +
    'above shows where the job stopped.',
  noSelection:
    'No selection record exists for this contract, so this response cannot say which concept ' +
    'was chosen or how. A selection record is created when Milestone 1 is delivered, so its ' +
    'absence is consistent with a job that never reached concept delivery.',
  unreadableInference:
    'The winning concept was chosen by INFERENCE — the buyer’s reply was not in a form ' +
    'LogoSmith’s strict selection parser accepts, so a model was asked to read it — but the ' +
    'reading itself could not be recovered from the gate audit trail: no `inference-selected` ' +
    'row naming that concept is present, its stored detail is damaged, or two rows disagree. ' +
    'This response therefore does not quote the words the choice was read out of. It does not ' +
    'assert that no such reply existed; only that this record cannot show it.',
  noScreening:
    'No cleared pre-generation content screening is on record for this contract, so the ' +
    'vendor’s verbatim screening verdict could not be quoted. `inputScreening` still ' +
    'reports the vendor and model this bot pins, and how many screening attempts failed on a ' +
    'vendor outage.',
  // Damaged is not absent. Saying "no screening is on record" while the trail
  // printed above shows a `moderation` row with result `clear` would have this
  // document contradicting itself on the same page — and would understate what
  // actually happened, since the screening did run and did clear.
  unreadableScreening:
    'A cleared pre-generation content screening IS on record for this contract — the ' +
    '`moderation` row is in the trail above, with result `clear` — but its stored verdict could ' +
    'not be read back: the recorded detail is absent, damaged, or not in the shape a verdict ' +
    'takes. The screening ran and cleared; only the vendor’s verbatim body is unquotable here.',
  noAuditTrail:
    'The gate audit trail for this contract is empty, so no gate decision, cap counter or ' +
    'selection event could be sourced. The trail is append-only and written as each gate runs, ' +
    'so an empty trail means nothing was recorded under any of the stage keys quoted above.',
} as const;

/** Named per slot, because WHICH concept lacks a verdict is the whole point. */
const missingVerdictGap = (slots: number[]): string =>
  `The lettering-readback verdict could not be sourced for these concept slots: ` +
  `${slots.join(', ')}. Their recorded model, transcription and score are all null, so no ` +
  `verdict is reported for them rather than one being inferred.`;

const RESPONSE_PREAMBLE =
  'Everything below is read back from the records this bot wrote while the work ran, not ' +
  'reconstructed now: the per-image provenance and lettering-readback verdicts it stored as ' +
  'each concept was generated, the winner and how it was chosen, the per-stage spend, and the ' +
  'append-only gate decision trail. Where evidence could not be sourced it is named in ' +
  '`evidenceGaps` rather than left out.';

// --- Assembly -----------------------------------------------------------------

/**
 * Every stage whose records are evidence, as a `Record` keyed by `JobStage` so
 * the COMPILER enforces completeness: adding a stage to `JobStage` without
 * adding it here fails the build, rather than silently dropping that stage's
 * audit trail out of every future dispute response.
 */
const STAGE_INCLUDED: Record<JobStage, true> = { concepts: true, vector: true, single: true };
const STAGES = Object.keys(STAGE_INCLUDED) as JobStage[];

const toJobRecord = (row: JobRow): DisputeJobRecord => ({
  status: row.status,
  outcome: row.outcome,
  kind: row.kind,
  spentUsd: row.spentUsd,
  parkReason: row.parkReason,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  deliveredAt: row.deliveredAt,
});

/** The gate whose detail carries per-image generation provenance (pipeline.ts). */
const OCR_GATE = 'ocr';

/** The gate stage 1 records its FR-2 input screening under (pipeline.ts). */
const MODERATION_GATE = 'moderation';

/**
 * The seed the image a concept row HOLDS was generated from — or `null`
 * whenever the record cannot name one without guessing.
 *
 * WHY THIS IS AN ELECTION AND NOT A LOOKUP. A slot is gated once per attempt
 * and every regeneration writes its own `ocr` row, so the trail holds several
 * rows for one slot and only ONE of them describes the image that was kept.
 * Taking the newest is wrong (the free taster keeps its BEST-scoring attempt,
 * not its last). Taking any row that "looks like" the stored verdict is wrong
 * too, and this is the trap worth naming: `ocrModel` is the pinned
 * `SCOUT_MODEL_ID` constant, `ocrScore` is a pure function of the transcription
 * and the brand name (gates/ocr.ts), and `ocrPass` is a function of that score
 * — so matching those four is really matching the TRANSCRIPTION alone, and two
 * attempts at the same brand name reading back identically is the normal case,
 * not a contrivance.
 *
 * `vendorRequestId` is the one recorded field that genuinely differs per
 * attempt, so it is the actual discriminator. The other four are kept because
 * they cost nothing and reject a row that was never this concept's at all;
 * where the vendor issues no request id they contribute nothing, and the
 * election below is what keeps that case honest rather than lucky.
 *
 * EVERY CANDIDATE VOTES — INCLUDING THE SILENT ONES. A matching row that
 * records no seed votes `null` instead of being skipped. Skipping it is what
 * let a vendor that returned a seed on attempt 1 and none on attempt 3 read as
 * unanimous for attempt 1's seed, naming a seed for an image we discarded; it
 * also quietly undid the resume path's deliberate silence (pipeline.ts records
 * no seed when re-gating bytes from an earlier invocation, precisely so none
 * can be borrowed). A row whose detail cannot be read votes `null` too, before
 * any field of it is examined: a readable row can be ruled out as another
 * attempt's, an unreadable one cannot.
 *
 * One distinct value wins; anything else — disagreement, a silent vote, an
 * unreadable row — is `null`. A seed that might belong to a discarded attempt
 * is worse than no seed at all, because the entire claim this field makes is
 * that the delivered image can be regenerated from it.
 */
function seedForConcept(row: ConceptRow, trail: GateAuditRow[]): number | null {
  const candidates = new Set<number | null>();
  for (const audit of trail) {
    if (audit.gate !== OCR_GATE || audit.slot !== row.slot) continue;
    const detail = audit.detail;
    if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) {
      candidates.add(null);
      continue;
    }
    // `Object.hasOwn` on every read, the report.ts idiom: a bare property read
    // walks the prototype chain, so an inherited `seed` or `transcription`
    // would otherwise be admitted as this row's own.
    const own = (key: string): unknown =>
      Object.hasOwn(detail as object, key) ? (detail as Record<string, unknown>)[key] : undefined;
    if (
      own('model') !== row.ocrModel ||
      own('transcription') !== row.ocrTranscription ||
      own('score') !== row.ocrScore ||
      own('pass') !== row.ocrPass ||
      (own('vendorRequestId') ?? null) !== row.vendorRequestId
    ) {
      continue;
    }
    const seed = own('seed');
    candidates.add(typeof seed === 'number' ? seed : null);
  }
  const votes = [...candidates];
  // One distinct vote wins — and that vote can itself BE `null` (the single
  // candidate recorded no seed), which is the whole point of typing the set
  // `number | null`: an unopposed silence has to lose rather than win by
  // default. No `typeof` guard here on purpose; it would be unreachable, and
  // an unreachable guard reads as a check that is doing work.
  return votes.length === 1 ? votes[0] : null;
}

/**
 * Same null-discipline as report.ts's `toReportConcept`: the three OCR columns
 * are written together by one gate, so a verdict is reported only when all
 * three are present. Checked against `null` and NOT for falsiness — a genuinely
 * zero score and an empty transcription are both real verdicts a failing
 * readback produces, and a falsy check would report them as no verdict at all.
 */
const toDisputeConcept = (row: ConceptRow, trail: GateAuditRow[]): DisputeConcept => {
  const hasOcr = row.ocrModel !== null && row.ocrTranscription !== null && row.ocrScore !== null;
  return {
    slot: row.slot,
    axisId: row.axisId,
    vendor: row.vendor,
    vendorRequestId: row.vendorRequestId,
    r2Key: row.r2Key,
    seed: seedForConcept(row, trail),
    phash: row.phash,
    attemptsUsed: row.attemptsUsed,
    ocr: hasOcr
      ? {
          model: row.ocrModel as string,
          transcription: row.ocrTranscription as string,
          score: row.ocrScore as number,
          pass: row.ocrPass,
        }
      : null,
  };
};

/**
 * The license rows for the images `concepts` actually recorded, resolved to
 * terms by the SAME function that produced the delivered `licenses.json` — so
 * the manifest a dispute reader sees cannot drift from the one the buyer holds.
 * `logo.svg` is deliberately not synthesized here: its vendor is recorded in
 * the `vectorize` audit row rather than in `concepts`, and inventing a row for
 * it would mean asserting provenance this table does not hold.
 */
const licenseRowsFor = (concepts: ConceptRow[]): LicenseRow[] =>
  concepts.map((row) => ({
    artifact: `concept-${row.slot}.png`,
    vendor: row.vendor,
    vendorRequestId: row.vendorRequestId,
  }));

/**
 * One trail out of every stage's trail, ordered by the autoincrement id.
 *
 * NOT by `created_at`: `touch()` has one-second resolution and several rows
 * land in the same tick, so a timestamp sort ties and reorders. NOT by
 * concatenating one stage after another either — stage 2's rows are written
 * after stage 1's but a concatenation would still be wrong the moment any
 * interleaving exists, and "chronological" is the property a dispute reader
 * relies on when following what happened in what order.
 */
function mergeAuditTrail(trails: Array<{ stage: JobStage; rows: GateAuditRow[] }>): {
  merged: DisputeAuditRow[];
  raw: GateAuditRow[];
} {
  const tagged = trails.flatMap(({ stage, rows }) => rows.map((row) => ({ stage, row })));
  tagged.sort((a, b) => a.row.id - b.row.id);
  return {
    merged: tagged.map(({ stage, row }) => ({
      id: row.id,
      stage,
      slot: row.slot,
      gate: row.gate,
      result: row.result,
      detail: row.detail ?? null,
      createdAt: row.createdAt,
    })),
    raw: tagged.map(({ row }) => row),
  };
}

/**
 * Recover the reading behind an `inferred` winner from the FR-17 trail.
 *
 * Read from the trail rather than stored on the `selection` row on purpose: the
 * trail is where `sweeps.ts` records it, it is append-only, and it is already
 * published verbatim in this same document — so the summary here and the raw
 * row a reader can check it against cannot diverge.
 *
 * FAIL-CLOSED, and in the shape Task 25's seed election settled. The row must
 * name the SAME slot the selection row holds, so a reading that lost a race to
 * another writer cannot be presented as the reason for a winner it did not
 * choose. Every field is checked before it is copied — `detail` is `unknown` by
 * construction — and TWO rows that disagree report NOTHING: naming one of them
 * would be a guess, and a quote attributed to the wrong message is worse in a
 * dispute than no quote at all.
 */
function inferenceFor(trail: GateAuditRow[], winnerSlot: number | null): DisputeInference | null {
  if (winnerSlot === null) return null;

  const readings: DisputeInference[] = [];
  for (const row of trail) {
    if (row.gate !== SELECTION_GATE || row.result !== SELECTION_INFERENCE_SELECTED) continue;
    const detail = row.detail;
    if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) continue;
    const record = detail as Record<string, unknown>;
    if (record['slot'] !== winnerSlot) continue;
    const messageId = record['messageId'];
    const quote = record['quote'];
    const model = record['model'];
    if (typeof messageId !== 'string' || typeof quote !== 'string' || typeof model !== 'string') {
      continue;
    }
    readings.push({ messageId, quote, model, at: row.createdAt });
  }

  if (readings.length === 0) return null;
  const [first] = readings;
  const unanimous = readings.every(
    (reading) => reading.messageId === first.messageId && reading.quote === first.quote,
  );
  return unanimous ? first : null;
}

/**
 * The URLs a dispute reader can open.
 *
 * Only URLs the record PROVES resolve are listed. The per-stage evidence page
 * (`/p/:token`, FR-7) renders from D1 for any job row that exists, so every
 * stage with a token gets one — and for the free stages that page is also
 * where the delivered concept image is shown. The pack, report and licence
 * artifacts are listed only for a `vector` stage whose outcome is `delivered`,
 * because that outcome is recorded only after all three objects have been
 * written to R2. An artifact URL that 404s would be a claim this record does
 * not support.
 */
function evidenceUrlsFor(
  base: string,
  stages: Array<{ stage: JobStage; row: JobRow | null }>,
): string[] {
  const urls: string[] = [];
  for (const { stage, row } of stages) {
    const token = row?.deliverableToken;
    if (!token) continue;
    urls.push(`${base}/p/${token}`);
    if (stage === 'vector' && row?.outcome === 'delivered') {
      for (const file of ['pack.zip', 'report.json', 'licenses.json']) {
        urls.push(`${base}/deliverables/${token}/${file}`);
      }
    }
  }
  return urls;
}

/**
 * Read the D1 records and assemble the evidence document. Read-only: it writes
 * nothing and mutates nothing, so it is safe to call for logging, for a dry
 * run, or twice.
 *
 * A failed read THROWS rather than degrading into an `evidenceGaps` entry.
 * "The table holds no concept rows" and "the concepts table could not be read"
 * are different facts, and only the first is one this document may assert — so
 * a transient D1 error becomes a retry (the caller releases its claim), never a
 * response that quietly reports an outage as an empty record.
 */
export async function assembleDisputeEvidence(
  deps: DisputeEvidenceDeps,
  contractId: string,
): Promise<DisputeEvidence> {
  const now = deps.now ?? ((): Date => new Date());
  const base = deps.publicBaseUrl.replace(/\/$/, '');

  const jobKeys = await Promise.all(
    STAGES.map(async (stage) => ({ stage, jobKey: await buildJobKey(contractId, stage) })),
  );
  const stageRows = await Promise.all(
    jobKeys.map(async ({ stage, jobKey }) => ({
      stage,
      jobKey,
      row: await deps.jobs.get(jobKey),
    })),
  );
  const trails = await Promise.all(
    jobKeys.map(async ({ stage, jobKey }) => ({
      stage,
      rows: await deps.jobs.listGateAudit(jobKey),
    })),
  );
  const [conceptRows, selectionRow] = await Promise.all([
    deps.concepts.list(contractId),
    deps.selection.get(contractId),
  ]);

  const { merged, raw } = mergeAuditTrail(trails);
  const inputScreening = summarizeInputScreening(raw);
  const concepts = conceptRows.map((row) => toDisputeConcept(row, raw));
  const slotsWithoutVerdict = concepts.filter((c) => c.ocr === null).map((c) => c.slot);

  const evidenceGaps: string[] = [];
  if (stageRows.every(({ row }) => row === null)) evidenceGaps.push(GAP.noJobRows);
  if (concepts.length === 0) evidenceGaps.push(GAP.noConcepts);
  if (slotsWithoutVerdict.length > 0) evidenceGaps.push(missingVerdictGap(slotsWithoutVerdict));
  if (selectionRow === null) evidenceGaps.push(GAP.noSelection);

  // The reading behind an inferred winner is sourced ONLY when the winner was
  // inferred: a quote beside a `buyer` or `default` source would imply a
  // reading that did not happen. An inferred winner whose reading cannot be
  // recovered says so, because "a model read your reply" without the words it
  // read is exactly the unevidenced assertion this document may not make.
  const inference =
    selectionRow?.source === 'inferred' ? inferenceFor(raw, selectionRow.winnerSlot) : null;
  if (selectionRow?.source === 'inferred' && inference === null) {
    evidenceGaps.push(GAP.unreadableInference);
  }
  if (inputScreening.verdict === null) {
    // `summarizeInputScreening` returns null for two different facts — no
    // cleared screening was ever recorded, and one was recorded but its stored
    // verdict is unreadable — so the trail is asked which one this is.
    const cleared = raw.some((audit) => audit.gate === MODERATION_GATE && audit.result === 'clear');
    evidenceGaps.push(cleared ? GAP.unreadableScreening : GAP.noScreening);
  }
  if (merged.length === 0) evidenceGaps.push(GAP.noAuditTrail);

  return {
    version: 1,
    contractId,
    assembledAt: now().toISOString(),
    note: EVIDENCE_NOTE,
    stages: stageRows.map(({ stage, jobKey, row }) => ({
      stage,
      jobKey,
      job: row === null ? null : toJobRecord(row),
    })),
    concepts,
    licenses: buildLicenseManifest(licenseRowsFor(conceptRows)),
    selection:
      selectionRow === null
        ? null
        : {
            state: selectionRow.state,
            winnerSlot: selectionRow.winnerSlot,
            selectionSource: selectionRow.source,
            inference: inference,
            m1DeliveredAt: selectionRow.m1DeliveredAt,
          },
    inputScreening,
    gateAudit: merged,
    evidenceUrls: evidenceUrlsFor(base, stageRows),
    evidenceGaps,
  };
}

/** The covering statement, then the evidence itself as parseable JSON. */
export function formatDisputeResponse(evidence: DisputeEvidence): string {
  return [
    `LogoSmith response on contract ${evidence.contractId}, assembled ${evidence.assembledAt}.`,
    '',
    RESPONSE_PREAMBLE,
    '',
    JSON.stringify(evidence, null, 2),
  ].join('\n');
}

// --- Responding ----------------------------------------------------------------

/**
 * Local rather than imported from jobs.ts, which keeps its own copy private:
 * this module must not widen another module's surface just to borrow a
 * one-line predicate, and both copies describe the same SQLite error text.
 */
const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Error && /UNIQUE constraint failed/i.test(err.message);

export function createDisputeResponder(deps: DisputeDeps): DisputeResponder {
  const { db, mcp, logger } = deps;
  const now = deps.now ?? ((): Date => new Date());

  /** True when THIS call took the one-shot claim for the contract. */
  async function claim(contractId: string): Promise<boolean> {
    try {
      await db
        .prepare('INSERT INTO dispute_responses (contract_id, responded_at) VALUES (?, ?)')
        .bind(contractId, now().toISOString())
        .run();
      return true;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return false;
    }
  }

  /**
   * Hand the claim back when nothing was filed under it.
   *
   * A claim that outlives a FAILED post would silence this bot on that contract
   * permanently: no redelivery would ever try again, and a single transient MCP
   * 503 would cost us the entire counter-statement. Releasing costs the
   * narrow case where the platform recorded a response we never saw
   * acknowledged — a duplicate statement — which is strictly the cheaper
   * failure. Concurrency is unaffected: only the claim holder ever posts.
   */
  async function release(contractId: string): Promise<void> {
    await db.prepare('DELETE FROM dispute_responses WHERE contract_id = ?').bind(contractId).run();
  }

  return {
    async respond(contractId) {
      if (!(await claim(contractId))) {
        logger.info({ contractId }, 'dispute response already filed for this contract; skipping');
        return;
      }
      try {
        const evidence = await assembleDisputeEvidence(deps, contractId);
        const { responseId } = await mcp.respondToDispute({
          contractId,
          response: formatDisputeResponse(evidence),
          evidenceUrls: evidence.evidenceUrls,
          // The body IS the recorded decision trail; the artifacts it links are
          // named inside it.
          evidenceType: 'logs',
        });
        logger.info(
          {
            contractId,
            responseId,
            concepts: evidence.concepts.length,
            auditRows: evidence.gateAudit.length,
            evidenceGaps: evidence.evidenceGaps.length,
          },
          'filed dispute response with D1-sourced evidence',
        );
      } catch (err) {
        await release(contractId).catch((releaseErr: unknown) => {
          logger.error(
            { err: releaseErr, contractId },
            'could not release the dispute-response claim; this contract will not be retried',
          );
        });
        throw err;
      }
    },
  };
}
