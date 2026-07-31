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
//      The response never guesses at what "probably" happened.
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
   * The vendor RNG seed this image was generated from, recovered from the gate
   * audit row that recorded its verdict — the strongest answer to "this is not
   * what I asked for", because the image can be regenerated from it. `null`
   * means the vendor returned no seed (only Ideogram does), not that
   * provenance is missing — the same reading as a null `vendorRequestId`.
   */
  seed: number | null;
  phash: string | null;
  attemptsUsed: number;
  /** The stored lettering-readback snapshot. `null` when the slot never
   *  reached the vision model — named in `evidenceGaps`, never inferred. */
  ocr: ReportOcrSnapshot | null;
}

export interface DisputeSelection {
  state: 'concepts_delivered' | 'winner_selected' | 'pack_delivered';
  /** `null` while the state is `concepts_delivered`: the state says why. */
  winnerSlot: number | null;
  /** FR-9: a buyer thread reply, or the default-selection rule firing. */
  selectionSource: SelectionSource | null;
  m1DeliveredAt: string;
}

export interface DisputeAuditRow {
  /** The autoincrement id. Also the ordering key — see `mergeAuditTrail`. */
  id: number;
  stage: JobStage;
  slot: number | null;
  gate: string;
  result: string;
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
  'row that recorded that verdict), `selection` (the winner and how it was chosen), ' +
  '`jobs` (the per-stage idempotency claims and vendor spend), and `gate_audit` (the ' +
  'append-only gate decision trail, listed here in insert order across every stage). Nothing ' +
  'is recomputed at dispute time. A null `detail` on an audit row means either that no detail ' +
  'was recorded for that row or that the recorded detail no longer parses — a damaged row is ' +
  'degraded to null rather than dropped, so the row itself is always present. The licence ' +
  'section covers the generated concept images; the delivered licenses.json additionally covers ' +
  'the converted logo.svg, whose raster-to-vector conversion issues no per-request identifier. ' +
  'A null `seed` or `vendorRequestId` on a concept means the vendor returned none — only some ' +
  'image vendors issue either — not that provenance is missing. ' +
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
  noScreening:
    'No cleared pre-generation content screening is on record for this contract, so the ' +
    'vendor’s verbatim screening verdict could not be quoted. `inputScreening` still ' +
    'reports the vendor and model this bot pins, and how many screening attempts failed on a ' +
    'vendor outage.',
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

/**
 * The seed the image a concept row HOLDS was generated from.
 *
 * The join is on the STORED VERDICT — model, transcription and score together
 * — not on "the newest `ocr` row for this slot". A slot can be gated several
 * times (each regeneration writes its own row with its own seed), and the free
 * taster keeps its BEST-scoring attempt rather than its last, so the newest row
 * is not always the one for the image that was kept. Reporting that row's seed
 * would name a seed the delivered image was not generated from — a fabricated
 * reproducibility claim, which is worse than none.
 *
 * Fails closed twice over. The detail is `unknown` by construction, so the
 * shape is checked field by field with `Object.hasOwn` (the report.ts idiom: a
 * bare read or `in` would walk the prototype chain and admit an inherited
 * `seed`). And if two matching rows disagree on the seed, none is reported.
 */
function seedForConcept(row: ConceptRow, trail: GateAuditRow[]): number | null {
  const seeds = new Set<number>();
  for (const audit of trail) {
    if (audit.gate !== OCR_GATE || audit.slot !== row.slot) continue;
    const detail = audit.detail;
    if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) continue;
    const candidate = detail as Record<string, unknown>;
    if (!Object.hasOwn(candidate, 'seed') || typeof candidate.seed !== 'number') continue;
    if (
      candidate.model !== row.ocrModel ||
      candidate.transcription !== row.ocrTranscription ||
      candidate.score !== row.ocrScore
    ) {
      continue;
    }
    seeds.add(candidate.seed);
  }
  return seeds.size === 1 ? [...seeds][0]! : null;
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
  if (inputScreening.verdict === null) evidenceGaps.push(GAP.noScreening);
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
