// ---------------------------------------------------------------------------
// Queue pipeline — stage 1: concepts → gates → capped regeneration → M1
// (PRD §6 steps 3-6; FR-1/FR-2/FR-3/FR-4/FR-5/FR-6/FR-8/FR-17).
//
// The whole stage is written against structural seams handed in by index.ts —
// `D1Like` stores, an R2 `DeliverableStore`, `FetchLike`, `AiLike` — so it runs
// unchanged under plain Node tests. Nothing here touches `env.*`.
//
// Three properties this module exists to guarantee:
//
//   1. CAPS SURVIVE REDELIVERY. Every cap decision is made by `decideSlotAction`
//      against the *persisted* checkpoint (`slots[].attempts`, `spendUsd`), not
//      an in-memory counter. A queue retry, a cron unpark, or a DLQ replay days
//      later resumes against the remaining budget; a slot that burned its
//      attempts stays burned.
//
//   2. PAID BYTES ARE NEVER LOST. Vendor asset URLs are ephemeral (Ideogram's
//      carry a 24 h signed `exp`, verified live 2026-07-30) and `generate.ts`
//      holds the fetched bytes only in memory. Every concept is PUT to R2
//      BEFORE any gate runs, and a resumed job re-gates those stored bytes
//      rather than paying for a replacement image.
//
//   3. WASM BUFFERS ARE FREED. Task 10 measured 129.5 MB against the 128 MB
//      isolate ceiling from unfreed resvg handles. Every rasterize/decode here
//      goes through `pack/render.ts`, whose `.free()`-in-`finally` discipline
//      (inner RenderedImage before outer Resvg) is the fix; this module never
//      constructs a `Resvg` of its own, so there is no second place to leak.
// ---------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import type { AgentClient, Contract } from '@botguild/agent-core';
import { createAxisCompiler, type AxisCompiler } from './axes.js';
import { parseLogoBrief, type BriefResult } from './brief.js';
import {
  CONCEPT_COUNT,
  MAX_REGENS_PER_SLOT,
  MAX_SPEND_USD,
  MIN_PHASH_HAMMING,
  MODERATION_ATTEMPTS_BEFORE_NOTICE,
  OCR_SIMILARITY_THRESHOLD,
} from './config.js';
import { createGenerator, type Generator } from './generate.js';
import {
  checkDistinctness,
  createOcrGate,
  perceptualHash,
  readPngDimensions,
  sanitizeSvg,
  toHex,
  type OcrGate,
} from './gates/index.js';
import type { ConceptStore, ConceptUpsert, JobRow, JobStore, QuotaStore } from './jobs.js';
import type { SelectionStore } from './jobs.js';
import { createModerationClient, type ModerationClient } from './moderation.js';
import { renderSvgToPixmap, renderSvgToPng } from './pack/render.js';
import type { WasmSources } from './pack/wasm.js';
import type {
  AiLike,
  ConceptState,
  FetchLike,
  JobCheckpoint,
  JobMessage,
  JobOutcome,
  JobStage,
  LogoBrief,
  Pixmap,
} from './types.js';

/** R2 seam for the deliverable bytes (put) and stage-2 artifact read-back (get). */
export interface DeliverableStore {
  put(key: string, value: Uint8Array, contentType: string): Promise<void>;
  /** Stage 2 reads the winner's stage-1 artifacts back (Task 21); null on a miss. */
  get(key: string): Promise<Uint8Array | null>;
}

/** Vendor API keys the pipeline needs (moderation, generation, vectorizer, fonts). */
export interface PipelineSecrets {
  moderationApiKey: string;
  anthropicApiKey: string;
  ideogramApiKey: string;
  recraftApiKey: string;
  vectorizerToken: string;
  googleFontsApiKey: string;
}

/**
 * The vendor-backed services the stage drives. Production never supplies these
 * — `resolveServices` builds them from `config.secrets`/`ai`/`fetchImpl`, so
 * `index.ts` keeps its single-responsibility job of adapting bindings. The
 * optional `PipelineConfig.services` field exists so Node tests can hand in
 * fakes without a live Ideogram key, a Workers AI binding, or an HTTP stub for
 * every vendor at once.
 */
export interface PipelineServices {
  generator: Generator;
  ocrGate: OcrGate;
  moderation: ModerationClient;
  axisCompiler: AxisCompiler;
}

export interface PipelineConfig {
  jobs: JobStore;
  concepts: ConceptStore;
  selection: SelectionStore;
  quota: QuotaStore;
  client: AgentClient;
  ai: AiLike;
  deliverables: DeliverableStore;
  /** Once-per-isolate wasm sources for the pack stack (pack/wasm.ts memoizes init). */
  sources: WasmSources;
  secrets: PipelineSecrets;
  fetchImpl: FetchLike;
  /** Public base URL of this Worker — deliverable/progress-page URLs are Worker-served. */
  publicBaseUrl: string;
  logger: Logger;
  /** Test seam only (see `PipelineServices`); absent in the production graph. */
  services?: Partial<PipelineServices>;
}

export type SlotAction =
  | { action: 'generate' }
  | { action: 'regenerate' }
  | { action: 'stop'; reason: 'attempts-exhausted' | 'spend-cap' | 'already-passed' };

export type StageOutcome = { outcome: 'delivered' | 'partial' | 'aborted' | 'parked' };

/**
 * The FR-5 cap policy. `attempts` counts COMPLETED generation attempts for the
 * slot (0 = never generated), so regenerations used = attempts - 1, and the
 * PRD's "<= 2 regenerations per slot" allows exactly 3 attempts. The
 * orchestrator increments `attempts` after EVERY generation call, pass or fail.
 *
 * Spend is checked FIRST and against the accumulated checkpoint total, so a job
 * resumed by a queue retry decides against the remaining budget rather than
 * starting a fresh $2.50.
 *
 * NOTE ON `MAX_SPEND_USD`: it is a stop-AFTER threshold, not a ceiling. The
 * generation that crosses the line completes and is paid for — we only decline
 * to start the next one — so realized spend can exceed the cap by at most one
 * generation (worst case ~$3.00 against a $2.50 cap at the $0.50 fake-vendor
 * costs the tests use; ~$2.58 at real Recraft pricing). That is the intended
 * policy: a price is not knowable until the vendor has been called. The
 * overshoot is bounded by exactly one image, and the delivery note quotes both
 * the cap and the realized figure so the buyer sees the true number.
 */
export function decideSlotAction(state: ConceptState, spendUsd: number): SlotAction {
  if (spendUsd >= MAX_SPEND_USD) return { action: 'stop', reason: 'spend-cap' };
  if (state.status === 'passed') return { action: 'stop', reason: 'already-passed' };
  if (state.attempts === 0) return { action: 'generate' };
  if (state.attempts <= MAX_REGENS_PER_SLOT) return { action: 'regenerate' };
  return { action: 'stop', reason: 'attempts-exhausted' };
}

/**
 * M1 is the contract's first checkpoint, M2 its second (single price, one
 * escrow, milestones as progress checkpoints — §6/§10.6). The
 * `milestone.funded` payload carries no milestone id, so the id is read off the
 * contract via REST at delivery time (FR-8). Shared with stage 2 (Task 21).
 */
export function milestoneIdForStage(
  contract: Pick<Contract, 'milestones'>,
  stage: JobStage,
): string | null {
  const milestones = contract.milestones ?? [];
  if (milestones.length === 0) return null;
  const index = stage === 'vector' ? Math.min(1, milestones.length - 1) : 0;
  return milestones[index]?.id ?? null;
}

// --- Internals ---------------------------------------------------------------

/** Concepts are generated (and Recraft SVGs rasterized) at this edge, §8: ≥1024 px. */
const CONCEPT_PX = 1024;

/**
 * Edge the concept is decoded to for the pHash gate. The hash box-averages to
 * 32x32 regardless, and every concept travels the identical path, so the
 * pairwise distances the gate compares stay like-for-like — at a sixteenth of
 * the peak pixel buffer a full-size decode would hold.
 */
const PHASH_DECODE_PX = 256;

/** Keep the spend ledger free of float dust without rounding a $0.001 FLUX call to zero. */
const roundUsd = (value: number): number => Math.round(value * 1e6) / 1e6;

/** base64 for Workers (no Buffer): chunked to stay under the spread-arg limit. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Decode an encoded PNG to an RGBA pixmap for the pHash gate.
 *
 * Workers has no canvas or ImageBitmap, and `@cf-wasm/photon` is deliberately
 * NOT imported here — PRD §7 scopes photon to the favicon gig's raster path
 * (Task 23), and pulling it in early would put a third WASM module in the
 * bundle a task before the measurement that is supposed to catch it. resvg is
 * already in the bundle for the pack stage and decodes a `data:` raster inside
 * `<image>`, so wrapping the concept in a one-element SVG reuses it as the
 * decoder — including `pack/render.ts`'s `.free()`-in-`finally` discipline,
 * which is what keeps this loop off the 128 MB ceiling (Task 10).
 *
 * Returns null when the bytes are not a decodable PNG; the caller treats that
 * as a slot failure rather than an exception, because a malformed vendor asset
 * is a pipeline decision, not an infra fault.
 */
async function decodePngToPixmap(png: Uint8Array, sources: WasmSources): Promise<Pixmap | null> {
  const dimensions = readPngDimensions(png);
  if (!dimensions) return null;
  const { width, height } = dimensions;
  const wrapper =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<image width="${width}" height="${height}" href="data:image/png;base64,${toBase64(png)}"/>` +
    `</svg>`;
  return renderSvgToPixmap(wrapper, PHASH_DECODE_PX, sources);
}

function resolveServices(config: PipelineConfig): PipelineServices {
  const overrides = config.services ?? {};
  return {
    generator:
      overrides.generator ??
      createGenerator({
        fetchImpl: config.fetchImpl,
        ai: config.ai,
        ideogramApiKey: config.secrets.ideogramApiKey,
        recraftApiKey: config.secrets.recraftApiKey,
      }),
    ocrGate: overrides.ocrGate ?? createOcrGate({ ai: config.ai }),
    moderation:
      overrides.moderation ??
      createModerationClient({
        fetchImpl: config.fetchImpl,
        apiKey: config.secrets.moderationApiKey,
      }),
    // Constructed lazily: a job resumed from a checkpoint never compiles axes,
    // and the Anthropic client wants a real key at construction time.
    axisCompiler: overrides.axisCompiler ?? {
      compile: (brief) =>
        createAxisCompiler({
          anthropic: new Anthropic({ apiKey: config.secrets.anthropicApiKey }),
        }).compile(brief),
    },
  };
}

/**
 * The FR-1 brief for this job.
 *
 * A stored `brief_json` is the brief as last validated — including any
 * correction the 15-min thread sweep applied post-funding — so it wins over the
 * gig description. It is re-validated through the SAME parser by re-fencing it,
 * so a corrected brief cannot bypass the intake rules (Latin script, required
 * fields). A stored brief that no longer validates falls back to the gig
 * description rather than failing the job outright — which also covers the
 * pathological case of a brand name containing a ``` fence.
 */
async function resolveBrief(
  config: PipelineConfig,
  job: JobRow,
  contract: Pick<Contract, 'gigId'>,
): Promise<BriefResult<LogoBrief>> {
  if (job.briefJson) {
    const stored = parseLogoBrief(`\`\`\`json\n${job.briefJson}\n\`\`\``);
    if (stored.ok) return stored;
    config.logger.warn(
      { jobKey: job.jobKey, reason: stored.reason },
      'stored brief failed re-validation; falling back to the gig description',
    );
  }
  const gig = await config.client.getGig(contract.gigId);
  return parseLogoBrief(gig.description ?? '');
}

/** Everything buyer-supplied and free-text goes to the moderation vendor (FR-2). */
function moderationText(brief: LogoBrief): string {
  return [brief.brandName, brief.industry, brief.brief ?? '', ...(brief.avoid ?? [])]
    .filter((part) => part.trim().length > 0)
    .join('\n');
}

const toStageOutcome = (outcome: JobOutcome | null): StageOutcome['outcome'] =>
  outcome === 'delivered' || outcome === 'partial' ? outcome : 'aborted';

const readbackLine = (state: ConceptState): string => {
  if (!state.ocr) return 'Lettering readback: not reached.';
  const verdict = state.ocr.pass ? 'PASS' : 'FAIL';
  return (
    `Lettering readback: ${verdict} (${state.ocr.score.toFixed(2)}) — ` +
    `${state.ocr.model} read "${state.ocr.transcription}".`
  );
};

/** Why this slot stopped, in buyer-facing words (§9 shortfall itemization). */
function shortfallLine(state: ConceptState, spendUsd: number): string {
  const decision = decideSlotAction(state, spendUsd);
  const cause =
    decision.action === 'stop' && decision.reason === 'spend-cap'
      ? `the $${MAX_SPEND_USD.toFixed(2)} per-job image-generation cap was reached (spent $${spendUsd.toFixed(2)})`
      : `it used its ${state.attempts} generation attempts (1 initial + up to ${MAX_REGENS_PER_SLOT} regenerations)`;
  const reason = state.failReason ? ` Last result: ${state.failReason}` : '';
  return `- Concept ${state.slot} (${state.axis.label}): not delivered — ${cause}.${reason}`;
}

interface NoteInput {
  brief: LogoBrief;
  checkpoint: JobCheckpoint;
  outcome: 'delivered' | 'partial';
  conceptUrl: (slot: number) => string;
  progressUrl: string;
}

/**
 * The M1 delivery note (FR-8). The platform posts the first ~500 characters
 * verbatim into the contract thread as the delivery summary, so the selection
 * instruction sits in the opening lines where truncation cannot eat it.
 */
function buildM1Note(input: NoteInput): string {
  const { brief, checkpoint, outcome, conceptUrl, progressUrl } = input;
  const passing = checkpoint.slots.filter((slot) => slot.status === 'passed');
  const missing = checkpoint.slots.filter((slot) => slot.status !== 'passed');
  const choices = passing.map((slot) => slot.slot).join('|');

  const lines = [
    `LogoSmith — Milestone 1: ${passing.length} logo concept${passing.length === 1 ? '' : 's'} ` +
      `for "${brief.brandName}".`,
    '',
    `PICK YOUR WINNER — reply in this thread with \`concept ${choices}\`.`,
    '',
  ];

  for (const slot of passing) {
    lines.push(`Concept ${slot.slot} — ${slot.axis.label}`);
    lines.push(`  ${conceptUrl(slot.slot)}`);
    lines.push(`  ${readbackLine(slot)}`);
    lines.push('');
  }

  if (outcome === 'partial') {
    lines.push(`SHORTFALL — ${passing.length} of ${CONCEPT_COUNT} concepts delivered.`);
    for (const slot of missing) lines.push(shortfallLine(slot, checkpoint.spendUsd));
    lines.push(
      'You may accept this set — the 14-day warranty re-runs the missing concept free — or ' +
        'dispute the delivery. You are not being asked to pay extra either way.',
    );
    lines.push('');
  }

  lines.push(`Live progress and evidence: ${progressUrl}`);
  lines.push(
    `Every concept above was transcribed by the pinned vision model and matched against your ` +
      `brand name at a normalized similarity of at least ${OCR_SIMILARITY_THRESHOLD}, and every ` +
      `pair clears a perceptual-hash distance of at least ${MIN_PHASH_HAMMING} on distinct ` +
      `declared style axes. Trademark clearance is NOT performed and NOT warranted.`,
  );
  return lines.join('\n');
}

/**
 * The §9 non-convergence note: fewer than two concepts cleared the gates. The
 * bot delivers nothing, itemizes the evidence, and REQUESTS cancellation —
 * refunds are payer-only on the platform, so the wording never claims the bot
 * can issue one.
 */
function buildAbortNote(input: {
  brief: LogoBrief;
  checkpoint: JobCheckpoint;
  progressUrl: string;
}): string {
  const { brief, checkpoint, progressUrl } = input;
  const passing = checkpoint.slots.filter((slot) => slot.status === 'passed');
  const lines = [
    `LogoSmith could not deliver Milestone 1 for "${brief.brandName}".`,
    '',
    `Only ${passing.length} of ${CONCEPT_COUNT} concepts cleared the lettering-readback gate ` +
      `within the contracted caps, and the contract requires at least 2. Rather than ship ` +
      `logos whose lettering does not read back as your brand name, nothing has been ` +
      `delivered and no work product is being claimed.`,
    '',
    'What was attempted:',
  ];
  for (const slot of checkpoint.slots) {
    lines.push(shortfallLine(slot, checkpoint.spendUsd));
  }
  lines.push('');
  lines.push(`Full per-concept evidence: ${progressUrl}`);
  lines.push(
    'LogoSmith cannot cancel or refund a contract itself — please cancel this contract from ' +
      'your side to release the escrow. If you would rather retry with an adjusted brief ' +
      '(a shorter brand name reads back far more reliably), reply here and we will re-run it.',
  );
  return lines.join('\n');
}

// --- Stage 1 -----------------------------------------------------------------

/**
 * PRD §6 steps 3-6. Returns the contractual outcome; never throws for a
 * *handled* vendor condition (those park the job for the cron), so the queue's
 * three retries stay reserved for genuine infra faults.
 */
export async function runConceptStage(
  config: PipelineConfig,
  message: JobMessage,
): Promise<StageOutcome> {
  const { jobs, concepts, selection, client, deliverables, logger } = config;
  const { jobKey, contractId } = message;
  const services = resolveServices(config);
  const log = logger.child({ jobKey, contractId, stage: 'concepts' });

  const job = await jobs.get(jobKey);
  // The claim INSERT creates this row before the Queue send, so its absence is
  // an infra fault rather than a pipeline decision: throw, and let the queue
  // retry into the DLQ with the operator alert (§12).
  if (!job) throw new Error(`no job row for ${jobKey}`);
  if (job.status === 'delivered') {
    log.info({ outcome: job.outcome }, 'stage already delivered; redelivery is a no-op');
    return { outcome: toStageOutcome(job.outcome) };
  }
  const token = job.deliverableToken;
  if (!token) throw new Error(`job ${jobKey} has no deliverable token`);

  const conceptUrl = (slot: number): string =>
    `${config.publicBaseUrl}/deliverables/${token}/concept-${slot}.png`;
  const progressUrl = `${config.publicBaseUrl}/p/${token}`;

  const contract = await client.getContract(contractId);

  // --- Step 2: re-validate the brief (FR-1) ---------------------------------
  const briefResult = await resolveBrief(config, job, contract);
  if (!briefResult.ok) {
    await jobs.recordGateAudit({
      jobKey,
      contractId,
      gate: 'brief',
      result: 'invalid',
      detail: { reason: briefResult.reason },
    });
    await client.sendMessage(
      contractId,
      `LogoSmith cannot start: the logo brief in this gig did not validate — ${briefResult.reason}. ` +
        'The brief must be a fenced JSON block carrying at least a Latin-script `brandName` and ' +
        'an `industry`. Post a corrected brief in this thread and the job will re-run; nothing ' +
        'has been generated and no work is being claimed.',
    );
    await jobs.markDelivered(jobKey, 'rejected');
    return { outcome: 'aborted' };
  }
  const brief = briefResult.brief;
  await jobs.setInProgress(jobKey, {
    kind: 'logo',
    gigId: contract.gigId,
    payerId: contract.payerId,
    briefJson: JSON.stringify(brief),
  });

  // --- Step 3: input moderation (FR-2), fail-closed --------------------------
  // Re-screened on every run, including resumes: a thread correction can change
  // the brief between runs, and an outage must park rather than read as a pass.
  const screening = await services.moderation.screen(moderationText(brief));
  await jobs.recordGateAudit({
    jobKey,
    contractId,
    gate: 'moderation',
    result: screening.status,
    detail: screening.status === 'unavailable' ? { error: screening.error } : screening.verdict,
  });
  if (screening.status === 'unavailable') {
    await jobs.park(jobKey, 'moderation_outage');
    const attempts = await jobs.incrementModerationAttempts(jobKey);
    log.warn({ error: screening.error, attempts }, 'moderation unavailable; job parked');
    // Exactly once, at the Nth failure — the counter is monotonic, so `===`
    // tells the buyer without re-telling them on every cron cycle after.
    if (attempts === MODERATION_ATTEMPTS_BEFORE_NOTICE) {
      await client.sendMessage(
        contractId,
        'Status update: LogoSmith screens every brief through a content-safety vendor before ' +
          'generating anything, and that vendor has been unavailable for ' +
          `${attempts} attempts. The job is queued and retries automatically — no action is ` +
          'needed from you, and nothing has been generated or charged.',
      );
    }
    return { outcome: 'parked' };
  }
  if (screening.status === 'flagged') {
    await client.sendMessage(
      contractId,
      'LogoSmith cannot take this job: the brand name and brief were flagged by the ' +
        'content-safety vendor that screens every brief before generation. Nothing has been ' +
        'generated and no work is being claimed. If you believe this is a misclassification, ' +
        'reply here with a rephrased brief.',
    );
    await jobs.markDelivered(jobKey, 'rejected');
    return { outcome: 'aborted' };
  }

  // --- Step 1/3: the resumable checkpoint ------------------------------------
  // Seeded once. A resumed job reuses its persisted axes rather than paying
  // Haiku again — and, more importantly, rather than regenerating against a
  // different set of prompts than the concepts already in R2 came from.
  const checkpoint: JobCheckpoint = job.checkpoint ?? {
    slots: (await services.axisCompiler.compile(brief))
      .slice(0, CONCEPT_COUNT)
      .map((axis, index) => ({ slot: index + 1, axis, status: 'pending', attempts: 0 })),
    spendUsd: job.spentUsd,
  };
  await jobs.saveCheckpoint(jobKey, checkpoint);

  // --- Step 4: generate → gate → regenerate, under the FR-5 caps -------------
  for (;;) {
    // A slot with paid bytes in R2 but no verdict was interrupted between the
    // PUT and the gates (an OCR outage, a queue retry, a DLQ replay). Re-gate
    // the stored bytes — regenerating here would burn the cap and pay twice for
    // one image, which is the entire reason the PUT happens before the gates.
    const ungated = checkpoint.slots.find(
      (slot) => slot.status === 'pending' && slot.r2Key !== undefined && slot.ocr === undefined,
    );
    const pending =
      ungated ??
      checkpoint.slots.find(
        (slot) => decideSlotAction(slot, checkpoint.spendUsd).action !== 'stop',
      );
    if (!pending) break;

    const slotNo = pending.slot;
    const slotLog = log.child({ slot: slotNo, axisId: pending.axis.id });
    let png: Uint8Array;
    const row: ConceptUpsert = {
      contractId,
      slot: slotNo,
      axisId: pending.axis.id,
      vendor: pending.axis.vendor,
    };

    if (ungated) {
      const stored = await deliverables.get(pending.r2Key as string);
      if (!stored) {
        // The object vanished (lifecycle rule, wrong bucket, manual deletion).
        // Drop the reference so the next pass regenerates under the cap.
        slotLog.warn({ r2Key: pending.r2Key }, 'checkpointed concept missing from R2');
        pending.r2Key = undefined;
        await jobs.saveCheckpoint(jobKey, checkpoint);
        continue;
      }
      png = stored;
      // Every column the upsert below rewrites has to be restored from the
      // checkpoint, not just the ones the gates are about to fill: `upsert`
      // writes the WHOLE row (`ON CONFLICT DO UPDATE SET` every column, with
      // `?? null` for absent fields), so a field left off `row` here is not
      // preserved — it is nulled. `nativeSvgKey` is the expensive one: losing
      // that pointer costs stage 2 a Vectorizer.ai call (~$0.20 against a $1
      // anchor) for a vector already sitting in R2.
      row.r2Key = pending.r2Key;
      row.vendorRequestId = pending.vendorRequestId;
      row.attemptsUsed = pending.attempts;
      row.nativeSvgKey = pending.nativeSvgKey;
      slotLog.info('re-gating a checkpointed concept without regenerating');
    } else {
      const result = await services.generator.generate(pending.axis, pending.axis.prompt);
      if (!result.ok) {
        await jobs.recordGateAudit({
          jobKey,
          contractId,
          slot: slotNo,
          gate: 'generation',
          result: result.retryable ? 'unavailable' : 'error',
          detail: { vendor: pending.axis.vendor, error: result.error },
        });
        if (result.retryable) {
          // A vendor outage produced no image and cost nothing, so it consumes
          // no FR-5 attempt: the slot has still never generated. Park for the
          // cron rather than throwing — the queue's 3 retries are reserved for
          // infra faults raised outside these handled paths (FR-2 pattern).
          pending.failReason = result.error;
          await jobs.saveCheckpoint(jobKey, checkpoint);
          await jobs.park(jobKey, 'vendor_outage');
          slotLog.warn({ error: result.error }, 'image vendor unavailable; job parked');
          return { outcome: 'parked' };
        }
        // Non-retryable means the vendor refused this request, not this moment
        // — the same prompt draws the same 4xx. Burn the slot's remaining
        // attempts instead of paying for two more identical refusals.
        pending.status = 'failed';
        pending.failReason = result.error;
        pending.attempts = Math.max(pending.attempts + 1, MAX_REGENS_PER_SLOT + 1);
        await jobs.saveCheckpoint(jobKey, checkpoint);
        slotLog.error({ error: result.error }, 'vendor refused the request; slot exhausted');
        continue;
      }

      // The money is spent whether or not the image passes a gate, so it lands
      // in the ledger BEFORE the gates.
      checkpoint.spendUsd = roundUsd(checkpoint.spendUsd + result.costUsd);
      pending.attempts += 1;
      pending.status = 'pending';
      pending.vendorRequestId = result.concept.vendorRequestId;
      pending.ocr = undefined;
      pending.phash = undefined;
      pending.failReason = undefined;
      pending.nativeSvgKey = undefined;
      row.vendorRequestId = result.concept.vendorRequestId;
      row.attemptsUsed = pending.attempts;
      // ...and it is PERSISTED here, immediately, because everything below can
      // throw: resvg rejecting a malformed vendor SVG, either R2 put, the D1
      // upsert. Mutating the ledger in memory and saving it 40 lines later
      // means a throw in between loses both the dollars and the attempt, the
      // queue retries, and we pay the vendor a second time for the same slot.
      // The cap is only a cap if the spend that motivates it is durable before
      // the next thing that can fail.
      await jobs.saveCheckpoint(jobKey, checkpoint);

      // Recraft's vector-native return carries an EMPTY png and the SVG
      // instead. Rasterize it here — no gate does — and persist the sanitized
      // SVG so stage 2's Recraft short-circuit can fire instead of paying
      // Vectorizer.ai for a vector we were already handed.
      let bytes = result.concept.png;
      if (bytes.length === 0) {
        // Defensive only: generate.ts returns ok:false for bytes that are
        // neither PNG nor SVG, so no current adapter can reach this branch.
        if (!result.concept.nativeSvg) {
          pending.status = 'failed';
          pending.failReason = 'vendor returned neither raster nor vector bytes';
          await jobs.saveCheckpoint(jobKey, checkpoint);
          slotLog.error('vendor returned an empty concept');
          continue;
        }
        const svg = sanitizeSvg(result.concept.nativeSvg);
        bytes = await renderSvgToPng(svg, CONCEPT_PX, config.sources);
        const svgKey = `${token}/concept-${slotNo}.svg`;
        await deliverables.put(svgKey, new TextEncoder().encode(svg), 'image/svg+xml');
        pending.nativeSvgKey = svgKey;
        row.nativeSvgKey = svgKey;
      }

      // PUT BEFORE THE GATES. The vendor URL these bytes came from is already
      // expiring; from here on every consumer reads R2, never the vendor.
      const r2Key = `${token}/concept-${slotNo}.png`;
      await deliverables.put(r2Key, bytes, 'image/png');
      pending.r2Key = r2Key;
      row.r2Key = r2Key;
      png = bytes;

      await concepts.upsert(row);
      await jobs.saveCheckpoint(jobKey, checkpoint);
    }

    // Concept size is recorded as evidence, not gated: §8 asks for ≥1024 px at
    // M1 while §9's exact-dimension hard gate is a pack (FR-13) property, and
    // vendors return non-square lockups legitimately.
    const dimensions = readPngDimensions(png);
    await jobs.recordGateAudit({
      jobKey,
      contractId,
      slot: slotNo,
      gate: 'dimensions',
      result: dimensions ? 'recorded' : 'undecodable',
      detail: { dimensions, bytes: png.length },
    });

    // --- Lettering readback (FR-5) -------------------------------------------
    const ocr = await services.ocrGate.check(png, brief.brandName);
    if (ocr.status === 'unavailable') {
      // NOT a fail: the gate could not see the image, so it refuses to verdict.
      // Park with the bytes safe in R2; the resume path above re-gates them.
      await jobs.recordGateAudit({
        jobKey,
        contractId,
        slot: slotNo,
        gate: 'ocr',
        result: 'unavailable',
        detail: { error: ocr.error },
      });
      await jobs.saveCheckpoint(jobKey, checkpoint);
      await jobs.park(jobKey, 'ocr_outage');
      slotLog.warn({ error: ocr.error }, 'lettering gate unavailable; job parked');
      return { outcome: 'parked' };
    }
    pending.ocr = ocr.verdict;
    pending.status = ocr.verdict.pass ? 'passed' : 'failed';
    pending.failReason = ocr.verdict.pass
      ? undefined
      : ocr.verdict.unsafe
        ? 'the vision model flagged the image as unsafe'
        : `readback similarity ${ocr.verdict.score.toFixed(2)} is below ${OCR_SIMILARITY_THRESHOLD} ` +
          `(model read "${ocr.verdict.transcription}")`;
    row.ocrModel = ocr.verdict.model;
    row.ocrTranscription = ocr.verdict.transcription;
    row.ocrScore = ocr.verdict.score;
    row.ocrPass = ocr.verdict.pass;
    await jobs.recordGateAudit({
      jobKey,
      contractId,
      slot: slotNo,
      gate: 'ocr',
      result: ocr.verdict.pass ? 'pass' : 'fail',
      detail: { ...ocr.verdict, seed: undefined, vendorRequestId: pending.vendorRequestId },
    });

    // --- Perceptual hash ------------------------------------------------------
    const pixmap = await decodePngToPixmap(png, config.sources);
    if (pixmap) {
      pending.phash = toHex(perceptualHash(pixmap));
      row.phash = pending.phash;
    } else {
      pending.status = 'failed';
      pending.failReason = 'the returned asset could not be decoded as a PNG';
    }
    await jobs.recordGateAudit({
      jobKey,
      contractId,
      slot: slotNo,
      gate: 'phash',
      result: pixmap ? 'recorded' : 'undecodable',
      detail: { phash: pending.phash },
    });

    await concepts.upsert(row);
    await jobs.saveCheckpoint(jobKey, checkpoint);

    // --- Distinctness (FR-6) --------------------------------------------------
    // Evaluated after every slot so a collision is caught while regenerations
    // remain, rather than at the end when the cap may already be spent.
    const distinct = checkDistinctness(
      checkpoint.slots
        .filter((slot) => slot.status === 'passed' && slot.phash !== undefined)
        .map((slot) => ({ slot: slot.slot, phash: slot.phash as string, axisId: slot.axis.id })),
    );
    if (distinct.pairs.length > 0) {
      await jobs.recordGateAudit({
        jobKey,
        contractId,
        gate: 'distinctness',
        result: distinct.pass ? 'pass' : 'fail',
        detail: distinct.pairs,
      });
    }
    for (const pair of distinct.failing) {
      // The NEWER slot regenerates: the earlier one already cleared the gate
      // against everything before it, so demoting it would cascade.
      const newer = checkpoint.slots.find((slot) => slot.slot === Math.max(pair.a, pair.b));
      if (!newer || newer.status !== 'passed') continue;
      newer.status = 'failed';
      newer.failReason = pair.sameAxis
        ? `it shares a declared style axis with concept ${Math.min(pair.a, pair.b)}`
        : `it is too similar to concept ${Math.min(pair.a, pair.b)} ` +
          `(perceptual distance ${pair.distance}, minimum ${MIN_PHASH_HAMMING})`;
      slotLog.info({ demoted: newer.slot, distance: pair.distance }, 'distinctness demotion');
    }
    if (distinct.failing.length > 0) await jobs.saveCheckpoint(jobKey, checkpoint);
  }

  await jobs.saveCheckpoint(jobKey, checkpoint);

  // --- Step 5: the §9 contractual outcome ------------------------------------
  const passing = checkpoint.slots.filter((slot) => slot.status === 'passed');
  // Defence in depth: §9 allows the 2-concept fallback only when that pair is
  // itself distinct. The loop demotes colliding slots, so this should always
  // hold — assert it rather than trust it, because shipping two near-identical
  // marks as "two distinct concepts" is precisely the warranty claim.
  const finalDistinct = checkDistinctness(
    passing
      .filter((slot) => slot.phash !== undefined)
      .map((slot) => ({ slot: slot.slot, phash: slot.phash as string, axisId: slot.axis.id })),
  );
  const delivered = passing.length >= CONCEPT_COUNT;
  const outcome: StageOutcome['outcome'] =
    delivered && finalDistinct.pass
      ? 'delivered'
      : passing.length >= 2 && finalDistinct.pass
        ? 'partial'
        : 'aborted';

  log.info(
    { outcome, passing: passing.map((slot) => slot.slot), spendUsd: checkpoint.spendUsd },
    'concept gates settled',
  );

  // --- Step 6: M1 delivery (FR-8) --------------------------------------------
  if (outcome === 'aborted') {
    await client.sendMessage(contractId, buildAbortNote({ brief, checkpoint, progressUrl }));
    await jobs.recordGateAudit({
      jobKey,
      contractId,
      gate: 'm1-delivery',
      result: 'aborted',
      detail: { passing: passing.length, spendUsd: checkpoint.spendUsd },
    });
    await jobs.markDelivered(jobKey, 'aborted');
    return { outcome };
  }

  const milestoneId = milestoneIdForStage(contract, 'concepts');
  if (!milestoneId) throw new Error(`contract ${contractId} exposes no milestone to deliver`);

  await selection.open(contractId);
  // The PNGs are already in R2 from the loop — deliver the links, never re-PUT.
  await client.deliverMilestone(contractId, milestoneId, {
    note: buildM1Note({ brief, checkpoint, outcome, conceptUrl, progressUrl }),
    attachments: [...passing.map((slot) => conceptUrl(slot.slot)), progressUrl],
  });
  await jobs.recordGateAudit({
    jobKey,
    contractId,
    gate: 'm1-delivery',
    result: outcome,
    detail: {
      milestoneId,
      slots: passing.map((slot) => slot.slot),
      spendUsd: checkpoint.spendUsd,
    },
  });
  await jobs.markDelivered(jobKey, outcome);
  return { outcome };
}

/** Queue entry point — one stage per message (§7: pixmap work is memory-bound). */
export async function processJobMessage(
  config: PipelineConfig,
  message: JobMessage,
): Promise<void> {
  const startedAt = Date.now();
  switch (message.stage) {
    case 'concepts': {
      const result = await runConceptStage(config, message);
      config.logger.info(
        { ...message, ...result, durationMs: Date.now() - startedAt },
        'concept stage finished',
      );
      return;
    }
    case 'vector':
      throw new Error('the vector stage is not implemented yet (Task 21)');
    case 'single':
      throw new Error('the free-gig single stage is not implemented yet (Task 23)');
    default: {
      const unreachable: never = message.stage;
      throw new Error(`unknown job stage: ${String(unreachable)}`);
    }
  }
}
