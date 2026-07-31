// ---------------------------------------------------------------------------
// Queue pipeline — both paid stages of the $25 gig:
//
//   stage 1 (`runConceptStage`): concepts → gates → capped regeneration → M1
//                                (PRD §6 steps 3-6)
//   stage 2 (`runVectorStage`):  winner → vector → pack → gates → report → M2
//                                (PRD §6 steps 8-10)
//
// (FR-1/FR-2/FR-3/FR-4/FR-5/FR-6/FR-8/FR-10/FR-11/FR-12/FR-13/FR-17.)
//
// Both stages are written against structural seams handed in by index.ts —
// `D1Like` stores, an R2 `DeliverableStore`, `FetchLike`, `AiLike` — so they run
// unchanged under plain Node tests. Nothing here touches `env.*`.
//
// Four properties this module exists to guarantee:
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
//      rather than paying for a replacement image. Stage 2 reads the winner
//      back out of R2 for the same reason.
//
//   3. SPEND IS DURABLE BEFORE ANYTHING THAT CAN THROW. Both stages write the
//      ledger to D1 the moment a vendor has been paid, not at the end of the
//      work the payment bought — a throw in between would otherwise lose the
//      dollars and let the queue retry buy the same thing twice.
//
//   4. WASM BUFFERS ARE FREED. Task 10 measured 129.5 MB against the 128 MB
//      isolate ceiling from unfreed resvg handles. Every rasterize/decode here
//      goes through `pack/render.ts`, whose `.free()`-in-`finally` discipline
//      (inner RenderedImage before outer Resvg) is the fix; this module never
//      constructs a `Resvg` of its own, so there is no second place to leak.
//      Both stages carry a pipeline-level guard asserting free-count ==
//      render-count, which is what catches a bare `new Resvg` reappearing here.
// ---------------------------------------------------------------------------

import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import type { AgentClient, Contract } from '@botguild/agent-core';
import { createAxisCompiler, type AxisCompiler } from './axes.js';
import {
  parseFaviconBrief,
  parseLogoBrief,
  resolveBrief as resolveGigBrief,
  type BriefResult,
} from './brief.js';
import {
  CONCEPT_COUNT,
  FREE_GIGS_PER_PAYER,
  FREE_GIG_WINDOW_DAYS,
  HAIKU_MODEL_ID,
  MAX_REGENS_PER_SLOT,
  MAX_SPEND_USD,
  MIN_PHASH_HAMMING,
  MODERATION_ATTEMPTS_BEFORE_NOTICE,
  OCR_SIMILARITY_THRESHOLD,
  SEED_PRICE_USD,
} from './config.js';
import { checkFreeGigQuota, fetchSourceLogo } from './freeGigs.js';
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
import {
  buildJobKey,
  type ConceptRow,
  type ConceptStore,
  type ConceptUpsert,
  type JobRow,
  type JobStore,
  type QuotaStore,
} from './jobs.js';
import type { SelectionStore } from './jobs.js';
import { createModerationClient, type ModerationClient } from './moderation.js';
import {
  buildFaviconPack,
  type FaviconPackGates,
  type FaviconPackInput,
  type FaviconPackResult,
} from './pack/faviconPack.js';
import { fetchFontPairing } from './pack/fonts.js';
import { buildPack, type PackGateReport } from './pack/index.js';
import { renderSvgToPixmap, renderSvgToPng } from './pack/render.js';
import type { WasmSources } from './pack/wasm.js';
import { createProseBriefExtractor, type ProseBriefExtractor } from './proseBrief.js';
import {
  buildLicenseManifest,
  buildValidationReport,
  type LicenseRow,
  type ReportImageModeration,
} from './report.js';
import { createVectorizer, type Vectorizer } from './vectorize.js';
import type {
  AiLike,
  ConceptState,
  FaviconBrief,
  FetchLike,
  JobCheckpoint,
  JobMessage,
  JobOutcome,
  JobStage,
  LogoBrief,
  OcrVerdict,
  Pixmap,
  SelectionSource,
  StyleAxis,
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
  vectorizer: Vectorizer;
  /**
   * The free favicon builder. A seam, unlike its four neighbours, because no
   * INPUT can make its gates fail: every PNG is letterboxed to exactly its
   * contracted size, the ICO is assembled from those same PNGs, and the ZIP
   * entry list is a constant — so the "gates failed, ship nothing" branch is
   * pure defence in depth and is unreachable from the outside. It still has to
   * be proven to block delivery, and this is the only way to prove it.
   */
  faviconPack: (input: FaviconPackInput) => Promise<FaviconPackResult>;
  /**
   * The prose-brief fallback (Task 27). Measured live: 0 of 78 open gigs carry
   * a fenced JSON block, so without this the funded pipeline rejects the very
   * gigs `maybePropose` just bid on — after the buyer's money is in escrow.
   *
   * Reached ONLY as the last resort in `resolveBrief` below: a stored
   * `brief_json` still wins, and a gig that carried a fenced block never pays
   * for it. Its output is validated by the same `parseLogoBrief` either way.
   */
  briefExtractor: ProseBriefExtractor;
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
 * PRD's "<= 2 regenerations per slot" allows exactly 3 attempts.
 *
 * `attempts` IS INCREMENTED ONLY BY A GENERATION THAT PRODUCED AN IMAGE. A
 * retryable vendor failure parks for the cron and consumes no attempt (Task 18
 * Ruling 1), so that a 45-minute outage cannot burn a paid job's regeneration
 * budget on 503s. An earlier version of this comment claimed the orchestrator
 * increments after EVERY call, pass or fail; it does not, and that mistake is
 * exactly what made the paragraph below false.
 *
 * Spend is checked FIRST and against the accumulated checkpoint total, so a job
 * resumed by a queue retry decides against the remaining budget rather than
 * starting a fresh one.
 *
 * NOTE ON `MAX_SPEND_USD`: it is a stop-AFTER threshold, not a ceiling. The
 * generation that crosses the line completes and is paid for — we only decline
 * to start the next one — so realized spend exceeds the cap by at most one
 * generation PER INVOCATION.
 *
 * THAT BOUND IS NOT SELF-EVIDENT AND WAS ONCE FALSE, so here is what makes it
 * hold. Because a retryable failure consumes no attempt, `attempts` cannot
 * bound the park → unpark → regenerate → park loop; `spendUsd` is the only
 * thing that can. So EVERY paid failure must reach this ledger: the vendor
 * adapters attach `costUsd` to failures that happened after the vendor was
 * billed (`GenerateResult`/`VectorizeResult`), the orchestrator credits and
 * PERSISTS it before it parks, and `sweepParkedJobs` gives up on a job whose
 * realized spend has passed the cap. Without all three, a dead asset CDN link
 * on an otherwise-healthy vendor bought one image every fifteen minutes for six
 * hours while this ledger reported $0.00.
 *
 * The delivery note quotes both the cap and the realized figure, so the buyer
 * sees the true number either way.
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
    vectorizer:
      overrides.vectorizer ??
      createVectorizer({
        fetchImpl: config.fetchImpl,
        vectorizerToken: config.secrets.vectorizerToken,
      }),
    faviconPack: overrides.faviconPack ?? buildFaviconPack,
    // Constructed lazily for exactly the reason `axisCompiler` is: the common
    // paths (a resumed job, a stored `brief_json`, a gig that carried a fenced
    // block) never reach it, and the Anthropic client wants a real key at
    // construction time. Spend is booked through the logger — a funded job does
    // have a D1 row, but this call precedes the checkpoint that would hold it
    // and is not image-generation spend, so it is not charged against
    // MAX_SPEND_USD (whose docstring in config.ts states exactly what that cap
    // governs). At ~$0.0005 it is ~0.05% of the $1 anchor.
    briefExtractor: overrides.briefExtractor ?? {
      extract: (gig) =>
        createProseBriefExtractor({
          anthropic: new Anthropic({ apiKey: config.secrets.anthropicApiKey }),
          recordSpend: (costUsd) =>
            config.logger.info({ costUsd, model: HAIKU_MODEL_ID }, 'prose brief extraction spend'),
        }).extract(gig),
    },
  };
}

/**
 * The FR-1 brief for this job.
 *
 * A stored `brief_json` is the brief as last validated — including any
 * correction the 15-min thread sweep applied post-funding — so it wins over the
 * gig description, AND over prose extraction. It is re-validated through the
 * SAME parser by re-fencing it, so a corrected brief cannot bypass the intake
 * rules (Latin script, required fields). A stored brief that no longer
 * validates falls back to the gig rather than failing the job outright — which
 * also covers the pathological case of a brand name containing a ``` fence.
 *
 * THE ORDER IS THE SECURITY PROPERTY, not a preference:
 *
 *   1. stored `brief_json`  — re-fenced through `parseLogoBrief`
 *   2. fenced block in the gig description — `parseLogoBrief`
 *   3. prose extraction (Task 27) — candidate validated by `parseLogoBrief`
 *
 * Every rung ends at the same parser, so no rung is a relaxation of the one
 * above it; the earlier ones are preferred because they are cheaper and
 * unambiguous, not because they are trusted more. Extraction being LAST is
 * also what makes a thread correction stick: a corrected brief is stored, so
 * it wins at (1) and the model is never consulted about a brief the buyer has
 * already restated. Without step 3 the pipeline rejected — after funding — the
 * ~all real gigs that carry no fenced block, including the ones `maybePropose`
 * had just bid on off the strength of the very same extraction.
 */
async function resolveBrief(
  config: PipelineConfig,
  job: JobRow,
  contract: Pick<Contract, 'gigId'>,
  extractor: ProseBriefExtractor,
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
  return resolveGigBrief(gig, extractor);
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

// --- Stage 2 notes -------------------------------------------------------------

/**
 * The one thread note a Vectorizer.ai outage earns. Posted on the FIRST park
 * only — the cron unparks and re-enqueues every 15 minutes, so a note per cycle
 * would be a message every quarter-hour for the length of the outage. Same
 * "tell them once" rule the FR-2 moderation notice follows.
 */
const VECTORIZER_OUTAGE_NOTE =
  'Status update: your chosen concept is being converted to a true vector, and the conversion ' +
  'service is currently unavailable. The job is queued and retries automatically — no action is ' +
  'needed from you, nothing extra is being charged, and your concept is safe. LogoSmith will not ' +
  'deliver a pack whose logo.svg is not a verified true vector, so it waits rather than ships ' +
  'something weaker.';

/** Buyer-facing one-liner per pack gate, used by both the M2 note and the abort note. */
function gateLines(gates: PackGateReport): string[] {
  const dimensionFails = gates.dimensions.filter((entry) => !entry.pass);
  return [
    `- True vector: ${gates.vector.pass ? 'PASS' : 'FAIL'} — ${gates.vector.census.path} path(s), ` +
      `${gates.vector.census.shape} shape(s), ${gates.vector.census.image} embedded raster(s)` +
      (gates.vector.pass ? '.' : ` — ${gates.vector.violations.join('; ')}.`),
    `- Pixel dimensions: ${gates.dimensions.length - dimensionFails.length}/${gates.dimensions.length} ` +
      `files match their contracted size exactly` +
      (dimensionFails.length === 0
        ? '.'
        : ` — mismatched: ${dimensionFails
            .map(
              (entry) =>
                `${entry.file} is ${entry.actual.width}x${entry.actual.height}, expected ` +
                `${entry.expected.width}x${entry.expected.height}`,
            )
            .join('; ')}.`),
    `- favicon.ico parse-back: ${gates.ico.pass ? `PASS — lists ${gates.ico.sizes.join(', ')}` : `FAIL — ${gates.ico.reason ?? 'unreadable'}`}.`,
    `- ZIP completeness: ${gates.zip.pass ? `PASS — ${gates.zip.present.length} entries` : `FAIL — ${gates.zip.reasons.join('; ')}`}.`,
  ];
}

interface M2NoteInput {
  brief: LogoBrief;
  winnerSlot: number;
  winnerAxisId: string;
  selectionSource: SelectionSource;
  vectorSource: 'recraft-native' | 'vectorizer';
  gates: PackGateReport;
  packUrl: string;
  reportUrl: string;
  licensesUrl: string;
  progressUrl: string;
}

/**
 * The M2 delivery note (§6 step 10). The platform posts the first ~500
 * characters verbatim into the thread, so the download link sits in the opening
 * lines — the same truncation rule that puts the selection instruction at the
 * top of the M1 note.
 */
function buildM2Note(input: M2NoteInput): string {
  const { brief, gates } = input;
  const chosen =
    input.selectionSource === 'buyer'
      ? 'you chose it in this thread'
      : 'the default-selection rule chose it — the best lettering-readback score of the set';
  return [
    `LogoSmith — Milestone 2: the true-vector brand pack for "${brief.brandName}".`,
    '',
    `DOWNLOAD: ${input.packUrl}`,
    '',
    `Built from concept ${input.winnerSlot} (${input.winnerAxisId}) — ${chosen}.`,
    '',
    'What is in the ZIP: logo.svg (true vector), logo-mono.svg, colour masters at 1024 and 2048 px, ' +
      'a 1024 px mono master, favicon.ico plus the 16/32/48/180/192/512 PNG set, site.webmanifest, ' +
      'a drop-in HTML snippet, and brand.json with the extracted hex codes and an advisory ' +
      'Google Fonts pairing.',
    '',
    'Machine-verified before delivery:',
    ...gateLines(gates),
    '',
    input.vectorSource === 'recraft-native'
      ? "The vector came straight from the generating vendor's own vector export and was re-checked " +
        'here — no raster-to-vector tracing step was involved.'
      : 'The winning concept was traced from raster to vector, then re-checked here.',
    '',
    `Full validation report: ${input.reportUrl}`,
    `Per-image license manifest: ${input.licensesUrl}`,
    `Evidence page: ${input.progressUrl}`,
    '',
    'Warranty (14 days): a logo.svg that does not pass the true-vector parse, any artifact at the ' +
      'wrong pixel dimensions, or a broken or incomplete ZIP is re-run free of charge, plus one ' +
      'revision round on this mark. The font pairing is advisory, not warranted. Trademark ' +
      'clearance is NOT performed and NOT warranted.',
  ].join('\n');
}

/**
 * The abort note for a winner that never cleared the lettering gate. Quotes the
 * concept's own recorded verdict, because that verdict is the reason the bot is
 * refusing — the buyer is entitled to see the number the refusal rests on.
 */
function buildWinnerGateNote(brief: LogoBrief, winner: ConceptRow, progressUrl: string): string {
  const measured =
    winner.ocrScore === null
      ? 'it has no recorded lettering-readback verdict at all'
      : `the pinned vision model read "${winner.ocrTranscription ?? ''}" at a normalized ` +
        `similarity of ${winner.ocrScore.toFixed(2)}, below the declared threshold of ` +
        `${OCR_SIMILARITY_THRESHOLD}`;
  return [
    `LogoSmith cannot deliver Milestone 2 for "${brief.brandName}".`,
    '',
    `Concept ${winner.slot} did not pass the lettering-readback gate — ${measured} — so it was ` +
      'never offered as a deliverable concept. Building the brand pack from it would put ' +
      '"machine-verified" on a mark this bot itself rejected, so nothing has been delivered and ' +
      'no work product is being claimed.',
    '',
    `Full per-concept evidence: ${progressUrl}`,
    'Reply in this thread naming one of the concepts that did pass and the pack will be built ' +
      'from that one instead.',
  ].join('\n');
}

/** The §9 pack-gate abort note: nothing is delivered and nothing is claimed. */
function buildPackFailureNote(
  brief: LogoBrief,
  gates: PackGateReport,
  progressUrl: string,
): string {
  return [
    `LogoSmith could not deliver Milestone 2 for "${brief.brandName}".`,
    '',
    'The assembled brand pack did not clear its own delivery gates, so nothing has been delivered ' +
      'and no work product is being claimed. Shipping a pack that fails these checks is exactly ' +
      'what the warranty exists to prevent, so it is not being shipped at all.',
    '',
    'Gate results:',
    ...gateLines(gates),
    '',
    `Evidence page: ${progressUrl}`,
    'Reply in this thread and the pack will be rebuilt from your chosen concept. LogoSmith cannot ' +
      'cancel or refund a contract itself — if you would rather stop here, please cancel from your ' +
      'side to release the escrow.',
  ].join('\n');
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
  const briefResult = await resolveBrief(config, job, contract, services.briefExtractor);
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
      // A fenced block is no longer REQUIRED — plain prose is read too (Task
      // 27) — so this must not keep telling the buyer to write JSON. What has
      // not changed is what a brief must CONTAIN, and that is what to ask for.
      `LogoSmith cannot start: the logo brief in this gig did not validate — ${briefResult.reason}. ` +
        'LogoSmith needs two things it could not find here: the brand name to set, written ' +
        'exactly as it should appear on the logo, and what the brand does. Plain prose is fine ' +
        '(for example: "a logo for Harbor & Vine, a seaside inn"); a fenced JSON block with ' +
        '`brandName` and `industry` also works and is read first. The brand name must be Latin ' +
        'script — other scripts are outside this version. Post that in this thread and the job ' +
        'will re-run; nothing has been generated and no work is being claimed.',
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
    // The vendor's RNG seed for THIS generation, carried to the audit row below
    // (the only place it is persisted — see types.ts's `Concept.seed`). Scoped
    // to the iteration, so a resumed slot that re-gates bytes generated in an
    // earlier invocation records no seed rather than an earlier slot's: the
    // value was never persisted, and an absent seed is honest where a borrowed
    // one would be a false reproducibility claim.
    let seed: number | undefined;
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
        // A FAILED CALL IS NOT NECESSARILY A FREE ONE. Anything that goes wrong
        // after the vendor returned 200 — no asset url, a dead CDN link, an
        // asset that is not a PNG — was BILLED, and the adapter says so via
        // `costUsd`. Credit it and PERSIST it here, before the park below:
        // parking is what hands this slot back to the cron, and because a
        // retryable failure consumes no FR-5 attempt, `spendUsd` is the only
        // thing bounding the loop it hands it to.
        const billedUsd = result.costUsd ?? 0;
        if (billedUsd > 0) {
          checkpoint.spendUsd = roundUsd(checkpoint.spendUsd + billedUsd);
          await jobs.saveCheckpoint(jobKey, checkpoint);
        }
        await jobs.recordGateAudit({
          jobKey,
          contractId,
          slot: slotNo,
          gate: 'generation',
          result: result.retryable ? 'unavailable' : 'error',
          detail: { vendor: pending.axis.vendor, error: result.error, costUsd: billedUsd },
        });
        if (result.retryable) {
          // The slot has still never generated, so this consumes no FR-5
          // attempt (Task 18 Ruling 1). Park for the cron rather than throwing
          // — the queue's 3 retries are reserved for infra faults raised
          // outside these handled paths (FR-2 pattern).
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
      seed = result.concept.seed;
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
      // The generation provenance rides with the verdict it produced: the
      // request id the vendor issued, and the seed the image can be regenerated
      // from. A vendor that returns no seed (Recraft, FLUX) leaves the key off
      // entirely — JSON.stringify drops `undefined` — which reads as the
      // absence it is rather than as a value.
      detail: { ...ocr.verdict, seed, vendorRequestId: pending.vendorRequestId },
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

// --- Stage 2 -----------------------------------------------------------------

/**
 * PRD §6 steps 8-10: the buyer's chosen concept becomes a true vector, the
 * vector becomes the full brand pack, the pack is gated, and M2 is delivered
 * with the JSON validation report and the license manifest beside it.
 *
 * Three properties this half of the pipeline exists to guarantee:
 *
 *   1. THE RECRAFT SHORT-CIRCUIT IS FREE MONEY, SO IT IS READ, NEVER
 *      RECOMPUTED. `concepts.native_svg_key` points at a sanitized vector
 *      stage 1 already paid for and stored; handing it to `toVector` skips
 *      Vectorizer.ai entirely (~$0.20 against a $1 anchor, the §13
 *      single-vendor mitigation).
 *
 *   2. THE VECTORIZER SPEND IS DURABLE THE MOMENT IT IS INCURRED. Everything
 *      after the conversion can throw — the pack renders ten rasters through
 *      wasm, then three R2 puts and a REST delivery — so the ledger is written
 *      before any of it. A queue retry must never re-buy a conversion the
 *      ledger forgot.
 *
 *   3. A FAILING GATE NEVER SHIPS. `buildPack` re-runs the true-vector gate on
 *      whatever it is handed (defence in depth: the SVG has already passed the
 *      identical check inside `toVector`), and a pack whose dimension, ICO, or
 *      ZIP gates fail takes the abort leg without calling `deliverMilestone`.
 *
 * NOTE ON `MAX_SPEND_USD`: the FR-5 cap governs concept GENERATION, and it is
 * checked per generation inside stage 1 against stage 1's own ledger. It is
 * deliberately NOT re-checked here. Stage 2 spends at most one ~$0.20
 * conversion, on a contract the buyer has already funded and already picked a
 * winner for; refusing to deliver the thing they paid for to save twenty cents
 * against a $25 escrow would be the wrong trade in every direction. The report
 * still shows both stages' spend summed, so the true figure is never hidden.
 */
export async function runVectorStage(
  config: PipelineConfig,
  message: JobMessage,
): Promise<StageOutcome> {
  const { jobs, concepts, selection, client, deliverables, logger } = config;
  const { jobKey, contractId } = message;
  const services = resolveServices(config);
  const log = logger.child({ jobKey, contractId, stage: 'vector' });

  const job = await jobs.get(jobKey);
  // As in stage 1: the claim INSERT creates this row before the Queue send, so
  // its absence is an infra fault rather than a pipeline decision.
  if (!job) throw new Error(`no job row for ${jobKey}`);
  if (job.status === 'delivered') {
    log.info({ outcome: job.outcome }, 'stage already delivered; redelivery is a no-op');
    return { outcome: toStageOutcome(job.outcome) };
  }
  const token = job.deliverableToken;
  if (!token) throw new Error(`job ${jobKey} has no deliverable token`);

  // Stage 1's row is read up front because two different things need it: it is
  // the brief of record (see `resolveBrief` below), and it owns the capability
  // token the concept PNGs were written under.
  const conceptsJobKey = await buildJobKey(contractId, 'concepts');
  const stageOne = await jobs.get(conceptsJobKey);

  // THE EVIDENCE PAGE IS STAGE 1'S, NOT THIS STAGE'S. `/p/:token` resolves the
  // job row *by* that token and renders
  // `<img src="/deliverables/<that same token>/concept-N.png">` (progress.ts) —
  // so handing the buyer stage 2's token renders three broken images. The
  // concept PNGs live under stage 1's token; the only objects ever written
  // under stage 2's are the pack, the report and the licenses. Falls back to
  // this stage's token only if stage 1's row has vanished, which also means
  // there are no concept images left to show.
  const progressUrl = `${config.publicBaseUrl}/p/${stageOne?.deliverableToken ?? token}`;
  const deliverableUrl = (file: string): string =>
    `${config.publicBaseUrl}/deliverables/${token}/${file}`;

  // The winner. Stage 2 is claimed by the selection resolver AFTER a winner is
  // recorded, so a missing selection is an ordering fault — throw and let the
  // queue's retries (then the DLQ alert) surface it, rather than inventing a
  // winner or silently no-opping a contract the buyer has paid for.
  const selectionRow = await selection.get(contractId);
  if (!selectionRow || selectionRow.winnerSlot === null || selectionRow.source === null) {
    throw new Error(`contract ${contractId} has no selected winner to build a pack from`);
  }
  const winnerSlot = selectionRow.winnerSlot;

  const conceptRows = await concepts.list(contractId);
  const winner = conceptRows.find((row) => row.slot === winnerSlot);
  if (!winner) {
    throw new Error(
      `contract ${contractId} has no concept row for the selected slot ${winnerSlot}`,
    );
  }

  const contract = await client.getContract(contractId);

  // Stage 1's row is also the brief of record: it holds the brief as last
  // validated, INCLUDING any thread correction the 15-minute sweep applied
  // before generation. Preferring it over the gig description means M2's brand
  // name is the one the concepts were actually generated from, even if the gig
  // text has since been edited. `resolveBrief` re-validates whatever it is
  // handed through the same parser, so nothing bypasses the intake rules.
  const briefResult = await resolveBrief(
    config,
    { ...job, briefJson: job.briefJson ?? stageOne?.briefJson ?? null },
    contract,
    services.briefExtractor,
  );
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
      'LogoSmith cannot build the brand pack: the logo brief for this contract no longer ' +
        `validates — ${briefResult.reason}. Post a corrected brief in this thread and the pack ` +
        'will be rebuilt from the concept you chose; nothing further has been generated and no ' +
        'additional work is being claimed.',
    );
    await jobs.markDelivered(jobKey, 'aborted');
    return { outcome: 'aborted' };
  }
  const brief = briefResult.brief;

  // --- The winner must have passed its own gates ------------------------------
  // The selection resolver only ever offers the buyer concepts that passed, so
  // in the current graph this is unreachable. It is checked anyway, because
  // THIS module is the one whose delivery note says "Machine-verified before
  // delivery": a claim has to be true at the point it is made, not conditional
  // on every present and future caller behaving. Without it, a slot whose
  // lettering readback failed — one the buyer was never even shown — can be
  // selected by slot number and shipped as a verified pack whose own
  // report.json records `ocr.pass: false`.
  if (!winner.ocrPass) {
    await jobs.recordGateAudit({
      jobKey,
      contractId,
      slot: winnerSlot,
      gate: 'winner-eligibility',
      result: 'fail',
      detail: {
        ocrPass: winner.ocrPass,
        ocrScore: winner.ocrScore,
        ocrTranscription: winner.ocrTranscription,
        attemptsUsed: winner.attemptsUsed,
      },
    });
    await client.sendMessage(contractId, buildWinnerGateNote(brief, winner, progressUrl));
    await jobs.markDelivered(jobKey, 'aborted');
    log.error(
      { winnerSlot, ocrScore: winner.ocrScore },
      'selected winner never passed the lettering gate; nothing delivered',
    );
    return { outcome: 'aborted' };
  }

  // "Has this stage run before?" — the same signal `decideOnConflict` reads.
  // Captured BEFORE the checkpoint below is written, and used for exactly one
  // thing: posting the vendor-outage note once instead of once per cron cycle.
  const firstRun = job.checkpoint === null;
  await jobs.setInProgress(jobKey, {
    kind: 'logo',
    gigId: contract.gigId,
    payerId: contract.payerId,
    briefJson: JSON.stringify(brief),
  });
  const checkpoint: JobCheckpoint = job.checkpoint ?? { slots: [], spendUsd: job.spentUsd };
  await jobs.saveCheckpoint(jobKey, checkpoint);

  // --- Step 8: vectorize (FR-10) ---------------------------------------------
  // Both artifacts are read back from R2 rather than regenerated: the bytes
  // were paid for once and the vendor URLs they came from expired long ago.
  const nativeSvgBytes = winner.nativeSvgKey ? await deliverables.get(winner.nativeSvgKey) : null;
  if (winner.nativeSvgKey && !nativeSvgBytes) {
    // Degrade, do not fail: the raster is still there, so this costs a
    // Vectorizer.ai call rather than the job.
    log.warn({ nativeSvgKey: winner.nativeSvgKey }, 'native SVG missing from R2; tracing instead');
  }
  const nativeSvg = nativeSvgBytes ? new TextDecoder().decode(nativeSvgBytes) : undefined;
  const png = winner.r2Key ? await deliverables.get(winner.r2Key) : null;
  if (!nativeSvg && !png) {
    await jobs.recordGateAudit({
      jobKey,
      contractId,
      slot: winnerSlot,
      gate: 'vectorize',
      result: 'missing-source',
      detail: { r2Key: winner.r2Key, nativeSvgKey: winner.nativeSvgKey },
    });
    await client.sendMessage(
      contractId,
      `LogoSmith cannot build the brand pack: the stored artwork for concept ${winnerSlot} is no ` +
        'longer retrievable, so there is nothing to vectorize. Nothing has been delivered and no ' +
        'additional work is being claimed. Reply in this thread and the concept round will be ' +
        're-run free of charge under the warranty.',
    );
    await jobs.markDelivered(jobKey, 'aborted');
    return { outcome: 'aborted' };
  }

  // `png` is only ever null when `nativeSvg` is present, and `toVector` hard
  // short-circuits on `nativeSvg` before it reads `png` at all — the empty
  // array is never looked at.
  const vector = await services.vectorizer.toVector({
    png: png ?? new Uint8Array(0),
    nativeSvg,
  });

  // A FAILED CONVERSION IS NOT NECESSARILY A FREE ONE: a 200 whose body cannot
  // be read, or whose SVG fails the true-vector self-check, was still billed
  // (`VectorizeResult.costUsd`). Credited on both branches so the retryable
  // one — which parks, and which the cron re-enqueues every fifteen minutes —
  // cannot spend invisibly.
  const vectorCostUsd = vector.costUsd ?? 0;
  if (vectorCostUsd > 0) {
    // FIRST, before the audit insert, the font call, ten wasm renders, three R2
    // puts and a REST delivery — every one of which can throw. The vendor has
    // been paid; the ledger records it before anything else is attempted.
    checkpoint.spendUsd = roundUsd(checkpoint.spendUsd + vectorCostUsd);
    await jobs.saveCheckpoint(jobKey, checkpoint);
  }

  await jobs.recordGateAudit({
    jobKey,
    contractId,
    slot: winnerSlot,
    gate: 'vectorize',
    result: vector.ok ? vector.source : vector.retryable ? 'unavailable' : 'error',
    detail: vector.ok
      ? { source: vector.source, costUsd: vector.costUsd }
      : { error: vector.error, retryable: vector.retryable, costUsd: vectorCostUsd },
  });

  if (!vector.ok) {
    if (vector.retryable) {
      await jobs.park(jobKey, 'vectorizer_outage');
      if (firstRun) await client.sendMessage(contractId, VECTORIZER_OUTAGE_NOTE);
      log.warn({ error: vector.error }, 'vectorization vendor unavailable; job parked');
      return { outcome: 'parked' };
    }
    // Non-retryable here means content-level: SVGO could not parse what came
    // back, or the result failed its own true-vector self-check. The identical
    // bytes produce the identical failure on every retry, so parking would loop
    // forever (see vectorize.ts's header) — this must abort.
    await client.sendMessage(
      contractId,
      'LogoSmith cannot deliver Milestone 2: converting your chosen concept to a true vector ' +
        `produced a file that does not pass the true-vector check — ${vector.error}. Rather than ` +
        'ship an "SVG" that wraps a raster, nothing has been delivered and no work product is ' +
        'being claimed. Reply in this thread to pick a different concept, or cancel from your ' +
        'side to release the escrow — LogoSmith cannot cancel or refund a contract itself.',
    );
    await jobs.markDelivered(jobKey, 'aborted');
    log.error({ error: vector.error }, 'vectorization failed permanently; leg aborted');
    return { outcome: 'aborted' };
  }

  // --- Step 8 (cont.): the pack ----------------------------------------------
  // Advisory and outage-proof by construction (FR-12): fetchFontPairing swallows
  // every failure into its pinned fallback pairing, so a Google Fonts outage
  // costs a recommendation, never the job.
  const fonts = await fetchFontPairing({
    fetchImpl: config.fetchImpl,
    apiKey: config.secrets.googleFontsApiKey,
  });

  // Throws only if the true-vector gate fails — which `toVector` has already
  // run on this exact string, so a throw here means a pure function disagreed
  // with itself. That is a broken invariant, not a pipeline decision: let it
  // reach the queue retry and the DLQ alert rather than swallowing it.
  const pack = await buildPack({
    svg: vector.svg,
    brandName: brief.brandName,
    sources: config.sources,
    fonts,
  });

  // --- Step 9: pack gates ------------------------------------------------------
  await jobs.recordGateAudit({
    jobKey,
    contractId,
    gate: 'pack',
    result: pack.gates.pass ? 'pass' : 'fail',
    detail: pack.gates,
  });
  if (!pack.gates.pass) {
    await client.sendMessage(contractId, buildPackFailureNote(brief, pack.gates, progressUrl));
    await jobs.markDelivered(jobKey, 'aborted');
    log.error({ gates: pack.gates }, 'pack gates failed; nothing delivered');
    return { outcome: 'aborted' };
  }

  // --- Step 9 (cont.): report + license manifest (§8, FR-17) -------------------
  // The unsafe-content flag is snapshotted per concept on stage 1's checkpoint
  // and nowhere else — the `concepts` table keeps the readback verdict but not
  // the safety flag — so the checkpoint is where §9's second moderation clause
  // is evidenced from.
  //
  // `null` — NOT an empty array — when stage 1's row is gone: in an evidence
  // document "no images were screened" and "the screening record could not be
  // found" are different facts, and collapsing them into `[]` would let a
  // missing record read as a clean one.
  const visionChecks: ReportImageModeration[] | null =
    stageOne === null
      ? null
      : (stageOne.checkpoint?.slots ?? []).flatMap((slot) =>
          slot.ocr
            ? [
                {
                  slot: slot.slot,
                  model: slot.ocr.model,
                  unsafe: slot.ocr.unsafe,
                  checkedAt: slot.ocr.checkedAt,
                },
              ]
            : [],
        );

  // FR-17: "the delivered JSON report ... is generated from these records".
  // The verbatim FR-2 screening verdict is copied out of the concepts stage's
  // audit trail into the report, because the buyer holding the report — and a
  // payer reading it during a dispute — cannot query D1 themselves.
  const moderationAudits = await jobs.listGateAudit(conceptsJobKey, 'moderation');

  const report = buildValidationReport({
    contractId,
    brandName: brief.brandName,
    generatedAt: new Date().toISOString(),
    concepts: conceptRows,
    visionChecks,
    moderationAudits,
    winner: { slot: winnerSlot, source: selectionRow.source },
    vectorization: {
      source: vector.source,
      vendor: vector.source === 'recraft-native' ? 'recraft' : 'vectorizer',
      costUsd: vector.costUsd,
    },
    gates: pack.gates,
    spend: {
      // Same rule as `visionChecks`: unknown is null, never zero.
      conceptStageUsd: stageOne === null ? null : stageOne.spentUsd,
      vectorStageUsd: checkpoint.spendUsd,
    },
    idempotencyKeys: { concepts: conceptsJobKey, vector: jobKey },
  });
  const licenses = buildLicenseManifest(licenseRows(conceptRows, vector.source));

  // --- Step 10: M2 delivery ----------------------------------------------------
  const encoder = new TextEncoder();
  await deliverables.put(`${token}/pack.zip`, pack.zip, 'application/zip');
  await deliverables.put(
    `${token}/report.json`,
    encoder.encode(JSON.stringify(report, null, 2)),
    'application/json',
  );
  await deliverables.put(
    `${token}/licenses.json`,
    encoder.encode(JSON.stringify(licenses, null, 2)),
    'application/json',
  );

  const milestoneId = milestoneIdForStage(contract, 'vector');
  if (!milestoneId) throw new Error(`contract ${contractId} exposes no milestone to deliver`);

  const packUrl = deliverableUrl('pack.zip');
  const reportUrl = deliverableUrl('report.json');
  const licensesUrl = deliverableUrl('licenses.json');
  await client.deliverMilestone(contractId, milestoneId, {
    note: buildM2Note({
      brief,
      winnerSlot,
      winnerAxisId: winner.axisId,
      selectionSource: selectionRow.source,
      vectorSource: vector.source,
      gates: pack.gates,
      packUrl,
      reportUrl,
      licensesUrl,
      progressUrl,
    }),
    attachments: [packUrl, reportUrl, licensesUrl, progressUrl],
  });
  await jobs.recordGateAudit({
    jobKey,
    contractId,
    gate: 'm2-delivery',
    result: 'delivered',
    detail: {
      milestoneId,
      winnerSlot,
      selectionSource: selectionRow.source,
      vectorSource: vector.source,
      spendUsd: checkpoint.spendUsd,
    },
  });
  await selection.markPackDelivered(contractId);
  await jobs.markDelivered(jobKey, 'delivered');
  log.info({ winnerSlot, vectorSource: vector.source }, 'brand pack delivered');
  return { outcome: 'delivered' };
}

/**
 * §8's "per generated/converted image" license rows: every concept the buyer
 * was shown (all of them were generated and paid for, not just the winner),
 * plus the one conversion that produced the delivered `logo.svg`. Derived
 * artifacts — the masters, the favicon set, the mono mark — are renders OF
 * `logo.svg` rather than separately vendor-sourced images, so they inherit its
 * provenance instead of getting duplicate rows.
 */
function licenseRows(
  conceptRows: ConceptRow[],
  vectorSource: 'recraft-native' | 'vectorizer',
): LicenseRow[] {
  return [
    ...conceptRows.map((row) => ({
      artifact: `concept-${row.slot}.png`,
      vendor: row.vendor,
      vendorRequestId: row.vendorRequestId,
    })),
    {
      artifact: 'logo.svg',
      vendor: vectorSource === 'recraft-native' ? 'recraft' : 'vectorizer',
      vendorRequestId: null,
    },
  ];
}

// --- The free funnel (stage `single`) ------------------------------------------
//
// One queue message, one delivery, no escrow. Two gigs share this stage because
// they share every property that matters to the code around it: $0, a single
// milestone, one deliverable, and a per-payer quota instead of a spend cap.
//
//   favicon (US-2) — the buyer's existing logo, refetched under the §12 guards
//                    and repackaged. ZERO image-generation spend: the whole
//                    path is in-Worker CPU.
//   taster  (US-3) — one concept on FLUX.2 [klein] with <=2 regenerations, its
//                    lettering readback attached as labelled, NON-BLOCKING
//                    evidence. A failed readback is delivered honestly.
//
// WHY THE BUYER-FACING COPY NEVER MENTIONS ESCROW. There is none. Every
// sentence here that would, on the paid path, ask the buyer to cancel and
// release the escrow instead tells them the truth: nothing was charged, and
// re-posting the gig is the entire remedy.

/** FR-17 gate name recording the free-gig allowance this job consumed. */
const FREE_GIG_USAGE_GATE = 'free-gig-usage';

/**
 * WHEN A FREE GIG CONSUMES ITS ALLOWANCE — the whole abuse guard turns on this.
 *
 * There are two questions and they have different authorities.
 *
 * IS THIS PAYER OVER THE CAP? Asked first, before the source fetch, before
 * moderation, before any vendor call, so a payer over the cap costs us a
 * `getContract` and nothing else. It is an ADVISORY read (`countRecent`): it
 * exists to refuse cheaply and to word the refusal, and it is never the thing
 * that enforces the cap.
 *
 * MAY THIS JOB HAVE AN ALLOWANCE? Asked at the point of no return by
 * `quota.consume`, which decides and records in ONE atomic statement. That is
 * what actually enforces the cap, at any concurrency — a read-then-write here
 * would let every job entering during the source fetch or the generation call
 * pass a check that was already stale (measured: 12 concurrent jobs, cap 3, all
 * 12 through).
 *
 * The point of no return is per gig, and NOT ONE STEP EARLIER:
 *
 *   favicon — once the buyer's logo has been fetched and accepted, immediately
 *             before the six renders that are this gig's entire cost.
 *   taster  — once the FIRST generation has actually come back, i.e. once the
 *             image vendor has been paid.
 *
 * So everything that can go wrong before those points costs the buyer nothing:
 * an unparseable brief, an unreachable/oversized/too-large/too-small logo, or
 * flagged content is refused with no allowance consumed; a moderation or
 * image-vendor outage parks with no allowance consumed, because it is our
 * failure, not theirs.
 *
 * ONCE A JOB HOLDS AN ALLOWANCE IT KEEPS IT. `quota.consume` is idempotent per
 * contract (its `NOT EXISTS` clause), and — this is the part a queue retry
 * depends on — `runSingleStage` skips the advisory check entirely for a job
 * that already holds one. Without that skip, a job whose image was generated
 * and PAID FOR, then parked on an OCR outage, comes back to find its own row
 * has pushed the payer to the cap and refuses itself: the buyer loses a
 * delivery we already bought, and is told "nothing has been generated and
 * nothing has been charged", which is false twice over.
 *
 * The FR-17 audit row is written after the fact as evidence, not as the marker
 * — the usage row itself is the marker, so there is no window between two
 * writes in which a paid job looks like one that never ran.
 */
async function consumeFreeGigQuota(
  config: PipelineConfig,
  args: { jobKey: string; contractId: string; payerId: string; kind: 'favicon' | 'taster' },
): Promise<boolean> {
  const alreadyHeld = await config.quota.holdsAllowance(args.contractId);
  const granted =
    alreadyHeld ||
    (await config.quota.consume(args.payerId, args.kind, args.contractId, {
      windowDays: FREE_GIG_WINDOW_DAYS,
      maxPerPayer: FREE_GIGS_PER_PAYER,
    }));
  if (granted && !alreadyHeld) {
    await config.jobs.recordGateAudit({
      jobKey: args.jobKey,
      contractId: args.contractId,
      gate: FREE_GIG_USAGE_GATE,
      result: 'consumed',
      detail: { payerId: args.payerId, kind: args.kind },
    });
  }
  return granted;
}

/**
 * The refusal a job gets when `quota.consume` declines it — i.e. when the payer
 * reached the cap between the advisory check and the point of no return, which
 * is exactly the concurrent-farming case.
 *
 * IT CANNOT REUSE `checkFreeGigQuota`'s MESSAGE. That message ends "Nothing has
 * been generated and nothing has been charged", which is true where it is used
 * — at the entry check, before any work — and FALSE here on the taster path,
 * which reaches this line immediately after paying for a klein generation.
 * Shipping the entry copy here would restore, inside the fix for that exact
 * class of bug, the same false sentence Task 22's give-up note was corrected
 * for. So the wording is built locally, and it says what actually happened.
 *
 * The count is re-read so the number quoted is the number that refused it.
 */
async function refuseAtPointOfNoReturn(
  config: PipelineConfig,
  args: {
    jobKey: string;
    contractId: string;
    payerId: string;
    /** What this job had already spent by the time it lost the race. */
    generatedImages: number;
  },
): Promise<StageOutcome> {
  const decision = await checkFreeGigQuota(config.quota, args.payerId);
  await config.jobs.recordGateAudit({
    jobKey: args.jobKey,
    contractId: args.contractId,
    gate: 'free-gig-quota',
    result: 'refused-at-consume',
    detail: {
      payerId: args.payerId,
      used: decision.used,
      generatedImages: args.generatedImages,
    },
  });
  const spent =
    args.generatedImages > 0
      ? `LogoSmith had already generated ${args.generatedImages === 1 ? 'a sample image' : `${args.generatedImages} sample images`} ` +
        'for this job by then, at LogoSmith’s own cost — you have not been charged for ' +
        'anything, and nothing is being delivered.'
      : 'Nothing has been generated and nothing has been charged.';
  await config.client.sendMessage(
    args.contractId,
    [
      'LogoSmith cannot complete this free job: your free-job allowance ran out while this one ' +
        'was already running — another of your free jobs claimed the last available slot.',
      '',
      spent,
      '',
      `Free jobs are capped at ${FREE_GIGS_PER_PAYER} per payer per rolling ` +
        `${FREE_GIG_WINDOW_DAYS} days (this account now has ${decision.used} on record). The ` +
        `allowance frees up as those jobs age out, or the $${SEED_PRICE_USD} brand-pack gig runs ` +
        'now with no such cap. Post either and LogoSmith will pick it up automatically.',
    ].join('\n'),
  );
  await config.jobs.markDelivered(args.jobKey, 'rejected');
  return { outcome: 'aborted' };
}

/** Buyer-facing one-liner per favicon-pack gate. Mirrors `gateLines` for the
 *  paid pack, minus the true-vector row: the free pack ships no SVG, so
 *  claiming a vector verdict it never ran would be the wrong kind of thorough. */
function faviconGateLines(gates: FaviconPackGates): string[] {
  const dimensionFails = gates.dimensions.filter((entry) => !entry.pass);
  return [
    `- Pixel dimensions: ${gates.dimensions.length - dimensionFails.length}/${gates.dimensions.length} ` +
      `icons match their contracted size exactly` +
      (dimensionFails.length === 0
        ? '.'
        : ` — mismatched: ${dimensionFails
            .map(
              (entry) =>
                `${entry.file} is ${entry.actual.width}x${entry.actual.height}, expected ` +
                `${entry.expected.width}x${entry.expected.height}`,
            )
            .join('; ')}.`),
    `- favicon.ico parse-back: ${gates.ico.pass ? `PASS — lists ${gates.ico.sizes.join(', ')}` : `FAIL — ${gates.ico.reason ?? 'unreadable'}`}.`,
    `- ZIP completeness: ${gates.zip.pass ? `PASS — ${gates.zip.present.length} entries` : `FAIL — ${gates.zip.reasons.join('; ')}`}.`,
  ];
}

/** The US-2 delivery note. The download link sits in the opening lines for the
 *  same reason the paid notes do: the platform posts only the first ~500
 *  characters into the thread. */
function buildFaviconNote(input: {
  siteName: string;
  sourceKind: 'svg' | 'raster';
  packUrl: string;
  gates: FaviconPackGates;
}): string {
  return [
    `LogoSmith — your favicon package for ${input.siteName}.`,
    '',
    `DOWNLOAD: ${input.packUrl}`,
    '',
    'What is in the ZIP: favicon.ico (16/32/48), PNGs at 16, 32, 48, 180 (apple-touch-icon), ' +
      '192 and 512 px, a valid site.webmanifest, and a drop-in HTML <head> snippet whose every ' +
      'href resolves to a file in the ZIP.',
    '',
    input.sourceKind === 'svg'
      ? 'Your logo is a vector, so every icon was rendered from it at its exact target size — ' +
        'no icon is a resized copy of a bigger one.'
      : 'Your logo is a raster, so every icon was produced by a high-quality downscale from ' +
        'your original. Nothing was upscaled: the largest icon is never bigger than the ' +
        'artwork you supplied.',
    '',
    'Machine-verified before delivery:',
    ...faviconGateLines(input.gates),
    '',
    `This job was free and nothing has been charged. If you want the mark itself rather than ` +
      `just its icons, the $${SEED_PRICE_USD} gig delivers three lettering-verified concepts and ` +
      `a true-vector brand pack — logo.svg with zero embedded rasters, colour and mono masters, ` +
      `extracted brand hex codes, and this same favicon set built from the vector.`,
  ].join('\n');
}

/** The US-3 taster delivery note. The OCR verdict is EVIDENCE here, not a gate:
 *  a failed readback ships with an honest explanation rather than being hidden
 *  or silently retried away. */
function buildTasterNote(input: {
  brief: LogoBrief;
  verdict: OcrVerdict;
  attempts: number;
  conceptUrl: string;
  progressUrl: string;
}): string {
  const { brief, verdict } = input;
  const lines = [
    `LogoSmith — your free sample concept for "${brief.brandName}".`,
    '',
    `DOWNLOAD: ${input.conceptUrl}`,
    '',
    `Lettering readback: ${verdict.pass ? 'PASS' : 'FAIL'} (${verdict.score.toFixed(2)}, ` +
      `threshold ${OCR_SIMILARITY_THRESHOLD}) — ${verdict.model} read "${verdict.transcription}".`,
    '',
  ];

  if (verdict.pass) {
    lines.push(
      'That verdict is attached as evidence, not marketing: the image above was transcribed by ' +
        'a vision model and the transcription matched your brand name above the stated threshold.',
    );
  } else {
    lines.push(
      'That is a FAIL and it is being delivered anyway, because a free sample that quietly hides ' +
        'its failures is not evidence of anything. This concept was generated on the free tier’s ' +
        `fast model across ${input.attempts} attempt${input.attempts === 1 ? '' : 's'}, and that ` +
        'model is not the lettering specialist. The $' +
        `${SEED_PRICE_USD} gig routes generation to the lettering-specialist model path and ` +
        'DELIVERS NOTHING that fails this same readback check — three concepts, each verified, ' +
        'or an honest non-delivery.',
    );
  }

  lines.push('');
  lines.push(
    `Next step: the $${SEED_PRICE_USD} gig delivers three stylistically distinct concepts, each ` +
      `one lettering-verified before you ever see it, then the winner as a true-vector brand ` +
      `pack — logo.svg with zero embedded rasters, colour and mono masters, the full favicon ` +
      `set with favicon.ico and webmanifest, and extracted brand hex codes.`,
  );
  lines.push('');
  lines.push(`Evidence page: ${input.progressUrl}`);
  lines.push(
    'This sample was free and nothing has been charged. Trademark clearance is NOT performed ' +
      'and NOT warranted.',
  );
  return lines.join('\n');
}

/**
 * The taster's single style axis.
 *
 * Deliberately NOT compiled by Haiku. FR-3's axis compiler exists to make THREE
 * concepts provably distinct from one another (FR-6 checks their ids), and one
 * concept has nothing to be distinct from — so paying an LLM call on a $0 gig
 * would buy a property this deliverable does not have. The paid gig's own
 * first axis is the lettering-forward wordmark; the taster shows that one.
 */
const tasterAxis = (brief: LogoBrief): StyleAxis => ({
  id: 'taster-wordmark',
  label: 'lettering-forward wordmark',
  vendor: 'flux',
  prompt:
    `A clean, professional lettering-forward logo wordmark reading exactly "${brief.brandName}", ` +
    `for a ${brief.industry} business. Flat vector-style mark on a plain white background, ` +
    `high contrast, generous letter spacing, no tagline, no border, no photographic elements. ` +
    `The text must read exactly "${brief.brandName}" and nothing else.` +
    (brief.brief ? ` Direction from the buyer: ${brief.brief}` : '') +
    (brief.avoid?.length ? ` Avoid: ${brief.avoid.join(', ')}.` : ''),
});

/** US-2: repackage the buyer's existing logo. Zero image-generation spend. */
async function runFaviconGig(
  config: PipelineConfig,
  args: {
    job: JobRow;
    message: JobMessage;
    contract: Pick<Contract, 'gigId' | 'payerId' | 'milestones'>;
    brief: FaviconBrief;
    token: string;
    services: PipelineServices;
    log: Logger;
  },
): Promise<StageOutcome> {
  const { jobs, client, deliverables } = config;
  const { job, contract, brief, token, services, log } = args;
  const { jobKey, contractId } = args.message;

  await jobs.setInProgress(jobKey, {
    kind: 'favicon',
    gigId: contract.gigId,
    payerId: contract.payerId,
    briefJson: JSON.stringify(brief),
  });

  const fetched = await fetchSourceLogo({ fetchImpl: config.fetchImpl, url: brief.logoUrl });
  await jobs.recordGateAudit({
    jobKey,
    contractId,
    gate: 'source-logo',
    result: fetched.ok ? fetched.source.kind : 'rejected',
    detail: fetched.ok
      ? fetched.source.kind === 'raster'
        ? { kind: 'raster', width: fetched.source.width, height: fetched.source.height }
        : { kind: 'svg', bytes: fetched.source.svg.length }
      : { reason: fetched.reason },
  });
  if (!fetched.ok) {
    // The buyer's input, not our failure — so no allowance is consumed and the
    // remedy is entirely in their hands.
    await client.sendMessage(
      contractId,
      `LogoSmith cannot build your favicon package: ${fetched.reason}. Nothing has been ` +
        'generated and nothing has been charged. Post a corrected gig with a direct link to ' +
        'the image file and LogoSmith will pick it up automatically — this free job has not ' +
        'been counted against your free-job allowance.',
    );
    await jobs.markDelivered(jobKey, 'rejected');
    log.info({ reason: fetched.reason }, 'source logo rejected; no allowance consumed');
    return { outcome: 'aborted' };
  }

  // The point of no return for this gig: the source is accepted and the six
  // renders below are its entire cost. Zero vendor spend by construction —
  // nothing past this line calls a paid image API, so the ledger this job
  // reports is the honest $0.00.
  const granted = await consumeFreeGigQuota(config, {
    jobKey,
    contractId,
    payerId: contract.payerId,
    kind: 'favicon',
  });
  if (!granted) {
    // The favicon gig calls no image vendor at all, so nothing was generated.
    return refuseAtPointOfNoReturn(config, {
      jobKey,
      contractId,
      payerId: contract.payerId,
      generatedImages: 0,
    });
  }
  const checkpoint: JobCheckpoint = job.checkpoint ?? { slots: [], spendUsd: 0 };
  await jobs.saveCheckpoint(jobKey, checkpoint);

  // The favicon brief carries no brandName, so the webmanifest is named for the
  // site the logo came from — the one piece of buyer identity the input has.
  const siteName = new URL(brief.logoUrl).hostname;
  const pack = await services.faviconPack({
    source: fetched.source,
    siteName,
    sources: config.sources,
  });
  await jobs.recordGateAudit({
    jobKey,
    contractId,
    gate: 'favicon-pack',
    result: pack.gates.pass ? 'pass' : 'fail',
    detail: pack.gates,
  });
  if (!pack.gates.pass) {
    await client.sendMessage(
      contractId,
      [
        `LogoSmith could not deliver your favicon package for ${siteName}.`,
        '',
        'The assembled package did not clear its own delivery gates, so nothing has been ' +
          'delivered. Shipping icons at the wrong size or a favicon.ico that will not parse ' +
          'is exactly what these checks exist to prevent.',
        '',
        'Gate results:',
        ...faviconGateLines(pack.gates),
        '',
        'Nothing has been charged — this was a free LogoSmith job, so there is no payment and ' +
          'nothing for you to cancel. Reply here with a different logo file and it will be ' +
          'rebuilt.',
      ].join('\n'),
    );
    await jobs.markDelivered(jobKey, 'aborted');
    log.error({ gates: pack.gates }, 'favicon pack gates failed; nothing delivered');
    return { outcome: 'aborted' };
  }

  await deliverables.put(`${token}/pack.zip`, pack.zip, 'application/zip');
  const milestoneId = milestoneIdForStage(contract, 'single');
  if (!milestoneId) throw new Error(`contract ${contractId} exposes no milestone to deliver`);

  const packUrl = `${config.publicBaseUrl}/deliverables/${token}/pack.zip`;
  await client.deliverMilestone(contractId, milestoneId, {
    note: buildFaviconNote({
      siteName,
      sourceKind: fetched.source.kind,
      packUrl,
      gates: pack.gates,
    }),
    attachments: [packUrl],
  });
  await jobs.recordGateAudit({
    jobKey,
    contractId,
    gate: 'free-delivery',
    result: 'delivered',
    detail: { milestoneId, kind: 'favicon', spendUsd: checkpoint.spendUsd },
  });
  await jobs.markDelivered(jobKey, 'delivered');
  log.info({ siteName, spendUsd: checkpoint.spendUsd }, 'favicon package delivered');
  return { outcome: 'delivered' };
}

/** US-3: one klein concept with its readback attached as non-blocking evidence. */
async function runTasterGig(
  config: PipelineConfig,
  args: {
    job: JobRow;
    message: JobMessage;
    contract: Pick<Contract, 'gigId' | 'payerId' | 'milestones'>;
    brief: LogoBrief;
    token: string;
    services: PipelineServices;
    log: Logger;
  },
): Promise<StageOutcome> {
  const { jobs, concepts, client, deliverables } = config;
  const { job, contract, brief, token, services, log } = args;
  const { jobKey, contractId } = args.message;

  await jobs.setInProgress(jobKey, {
    kind: 'taster',
    gigId: contract.gigId,
    payerId: contract.payerId,
    briefJson: JSON.stringify(brief),
  });

  // FR-2 applies in full: "never generate from an unscreened brief" has no free
  // tier. Fail-closed, and — like every outage below — before any allowance is
  // consumed, so a vendor's bad day never costs the buyer a free job.
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
    log.warn({ error: screening.error, attempts }, 'moderation unavailable; free job parked');
    if (attempts === MODERATION_ATTEMPTS_BEFORE_NOTICE) {
      await client.sendMessage(
        contractId,
        'Status update: LogoSmith screens every brief through a content-safety vendor before ' +
          'generating anything, and that vendor has been unavailable for ' +
          `${attempts} attempts. The job is queued and retries automatically — no action is ` +
          'needed from you, nothing has been generated, and this has not been counted against ' +
          'your free-job allowance.',
      );
    }
    return { outcome: 'parked' };
  }
  if (screening.status === 'flagged') {
    await client.sendMessage(
      contractId,
      'LogoSmith cannot take this job: the brand name and brief were flagged by the ' +
        'content-safety vendor that screens every brief before generation. Nothing has been ' +
        'generated, nothing has been charged, and this has not been counted against your ' +
        'free-job allowance. If you believe this is a misclassification, reply here with a ' +
        'rephrased brief.',
    );
    await jobs.markDelivered(jobKey, 'rejected');
    return { outcome: 'aborted' };
  }

  const checkpoint: JobCheckpoint = job.checkpoint ?? {
    slots: [{ slot: 1, axis: tasterAxis(brief), status: 'pending', attempts: 0 }],
    spendUsd: job.spentUsd,
  };
  await jobs.saveCheckpoint(jobKey, checkpoint);

  const slot = checkpoint.slots[0]!;
  const r2Key = `${token}/concept-1.png`;

  // Same FR-5 cap arithmetic as the paid stage — 1 initial attempt plus at most
  // MAX_REGENS_PER_SLOT regenerations (US-3/FR-14's "<=2 regenerations") —
  // read from the PERSISTED checkpoint, so a parked-and-resumed taster cannot
  // start its allowance over.
  for (;;) {
    const decision = decideSlotAction(slot, checkpoint.spendUsd);
    if (decision.action === 'stop') break;

    const result = await services.generator.generate(slot.axis, slot.axis.prompt);
    if (!result.ok) {
      // Credited and persisted before the park, exactly as the paid stage does
      // and for the same reason: a post-200 failure was billed, and a retryable
      // failure consumes no attempt, so `spendUsd` is the only bound on the
      // park loop this is about to enter.
      const billedUsd = result.costUsd ?? 0;
      if (billedUsd > 0) {
        checkpoint.spendUsd = roundUsd(checkpoint.spendUsd + billedUsd);
        await jobs.saveCheckpoint(jobKey, checkpoint);
      }
      await jobs.recordGateAudit({
        jobKey,
        contractId,
        slot: 1,
        gate: 'generation',
        result: result.retryable ? 'unavailable' : 'error',
        detail: { vendor: slot.axis.vendor, error: result.error, costUsd: billedUsd },
      });
      if (result.retryable) {
        slot.failReason = result.error;
        await jobs.saveCheckpoint(jobKey, checkpoint);
        await jobs.park(jobKey, 'vendor_outage');
        log.warn({ error: result.error }, 'klein unavailable; free job parked');
        return { outcome: 'parked' };
      }
      // The vendor refused this request, not this moment — the same prompt
      // draws the same 4xx, so burn the remaining attempts rather than buy two
      // more identical refusals.
      slot.failReason = result.error;
      slot.attempts = Math.max(slot.attempts + 1, MAX_REGENS_PER_SLOT + 1);
      await jobs.saveCheckpoint(jobKey, checkpoint);
      continue;
    }

    checkpoint.spendUsd = roundUsd(checkpoint.spendUsd + result.costUsd);
    slot.attempts += 1;
    // Durable before the gate below can throw, exactly as the paid stage does.
    await jobs.saveCheckpoint(jobKey, checkpoint);
    // THE POINT OF NO RETURN for this gig: the image vendor has now been paid.
    // Everything before it — the moderation screen, a klein 503 on the first
    // attempt — parks or refuses without touching the buyer's allowance. A
    // no-op after the first pass through here.
    const granted = await consumeFreeGigQuota(config, {
      jobKey,
      contractId,
      payerId: contract.payerId,
      kind: 'taster',
    });
    if (!granted) {
      // The vendor was already paid for `slot.attempts` image(s) above — say so.
      return refuseAtPointOfNoReturn(config, {
        jobKey,
        contractId,
        payerId: contract.payerId,
        generatedImages: slot.attempts,
      });
    }

    const png = result.concept.png;
    const ocr = await services.ocrGate.check(png, brief.brandName);
    if (ocr.status === 'unavailable') {
      // The gate could not see the image, so it refuses to verdict. Park; the
      // resume regenerates, which costs a tenth of a cent — the paid stage's
      // "PUT the bytes before the gate" rule exists because Ideogram's asset
      // URLs expire and its images cost real money, and neither is true of a
      // klein return that arrives inline.
      await jobs.recordGateAudit({
        jobKey,
        contractId,
        slot: 1,
        gate: 'ocr',
        result: 'unavailable',
        detail: { error: ocr.error },
      });
      await jobs.park(jobKey, 'ocr_outage');
      log.warn({ error: ocr.error }, 'lettering gate unavailable; free job parked');
      return { outcome: 'parked' };
    }

    // NON-BLOCKING (US-3 AC1). The verdict decides which attempt is delivered
    // and what the note says about it — never whether anything is delivered.
    // Keeping the BEST-scoring attempt (rather than the last) is why the PUT is
    // conditional: R2 always holds the candidate the note is written about, so
    // a resumed job reads its own best attempt back rather than the newest one.
    const previous = slot.ocr;
    if (!previous || ocr.verdict.score > previous.score) {
      await deliverables.put(r2Key, png, 'image/png');
      slot.r2Key = r2Key;
      slot.ocr = ocr.verdict;
      slot.vendorRequestId = result.concept.vendorRequestId;
    }
    slot.status = slot.ocr!.pass ? 'passed' : 'failed';
    slot.failReason = slot.ocr!.pass
      ? undefined
      : `readback similarity ${slot.ocr!.score.toFixed(2)} is below ${OCR_SIMILARITY_THRESHOLD} ` +
        `(model read "${slot.ocr!.transcription}")`;
    await jobs.recordGateAudit({
      jobKey,
      contractId,
      slot: 1,
      gate: 'ocr',
      result: ocr.verdict.pass ? 'pass' : 'fail',
      detail: { ...ocr.verdict, blocking: false, attempt: slot.attempts },
    });
    await concepts.upsert({
      contractId,
      slot: 1,
      axisId: slot.axis.id,
      vendor: slot.axis.vendor,
      vendorRequestId: slot.vendorRequestId,
      r2Key: slot.r2Key,
      attemptsUsed: slot.attempts,
      ocrModel: slot.ocr!.model,
      ocrTranscription: slot.ocr!.transcription,
      ocrScore: slot.ocr!.score,
      ocrPass: slot.ocr!.pass,
    });
    await jobs.saveCheckpoint(jobKey, checkpoint);
  }

  await jobs.saveCheckpoint(jobKey, checkpoint);

  const verdict = slot.ocr;
  if (!verdict || !slot.r2Key) {
    // Every attempt failed to produce an image at all — a vendor refusal, not a
    // failed readback. There is nothing to be honest ABOUT, so nothing ships.
    await client.sendMessage(
      contractId,
      'LogoSmith could not produce your free sample concept: the image model refused every ' +
        `attempt (${slot.failReason ?? 'no image was returned'}). Nothing has been delivered ` +
        'and nothing has been charged — this was a free LogoSmith job, so there is no payment ' +
        'and nothing for you to cancel. A shorter brand name generates far more reliably; ' +
        'post the gig again and LogoSmith will bid on it automatically.',
    );
    await jobs.recordGateAudit({
      jobKey,
      contractId,
      gate: 'free-delivery',
      result: 'aborted',
      detail: { kind: 'taster', attempts: slot.attempts, spendUsd: checkpoint.spendUsd },
    });
    await jobs.markDelivered(jobKey, 'aborted');
    log.error({ attempts: slot.attempts }, 'taster produced no image; nothing delivered');
    return { outcome: 'aborted' };
  }

  const milestoneId = milestoneIdForStage(contract, 'single');
  if (!milestoneId) throw new Error(`contract ${contractId} exposes no milestone to deliver`);

  const conceptUrl = `${config.publicBaseUrl}/deliverables/${token}/concept-1.png`;
  const progressUrl = `${config.publicBaseUrl}/p/${token}`;
  await client.deliverMilestone(contractId, milestoneId, {
    note: buildTasterNote({
      brief,
      verdict,
      attempts: slot.attempts,
      conceptUrl,
      progressUrl,
    }),
    attachments: [conceptUrl, progressUrl],
  });
  await jobs.recordGateAudit({
    jobKey,
    contractId,
    gate: 'free-delivery',
    result: 'delivered',
    detail: {
      milestoneId,
      kind: 'taster',
      ocrPass: verdict.pass,
      ocrScore: verdict.score,
      attempts: slot.attempts,
      spendUsd: checkpoint.spendUsd,
    },
  });
  // DELIVERED even when the readback failed: US-3 promises an honest sample,
  // and `aborted` would tell the platform we shipped nothing when we did.
  await jobs.markDelivered(jobKey, 'delivered');
  log.info({ ocrPass: verdict.pass, spendUsd: checkpoint.spendUsd }, 'free taster delivered');
  return { outcome: 'delivered' };
}

/**
 * PRD §6's free-funnel path: the US-2 favicon repackage and the US-3 taster,
 * both $0, both capped per payer (FR-14).
 *
 * WHICH GIG THIS IS, IS READ OFF THE BRIEF — the same question `pricingCalc`
 * asks to decide the $0 anchor, asked the same way. A description carrying a
 * `logoUrl` is the favicon gig; one carrying a `brandName` + `industry` is the
 * taster. Re-deriving it here rather than trusting a field on the message means
 * a redelivered or replayed message cannot talk this stage into running the
 * other gig's pipeline.
 */
export async function runSingleStage(
  config: PipelineConfig,
  message: JobMessage,
): Promise<StageOutcome> {
  const { jobs, client, logger } = config;
  const { jobKey, contractId } = message;
  const services = resolveServices(config);
  const log = logger.child({ jobKey, contractId, stage: 'single' });

  const job = await jobs.get(jobKey);
  // As in both paid stages: the claim INSERT creates this row before the Queue
  // send, so its absence is an infra fault rather than a pipeline decision.
  if (!job) throw new Error(`no job row for ${jobKey}`);
  if (job.status === 'delivered') {
    log.info({ outcome: job.outcome }, 'stage already delivered; redelivery is a no-op');
    return { outcome: toStageOutcome(job.outcome) };
  }
  const token = job.deliverableToken;
  if (!token) throw new Error(`job ${jobKey} has no deliverable token`);

  const contract = await client.getContract(contractId);
  const gig = await client.getGig(contract.gigId);
  const description = gig.description ?? '';

  // FR-14 BEFORE ANYTHING ELSE — but ONLY for a job that does not already hold
  // an allowance. The payer id comes off the contract, never off the webhook
  // payload: the count is only an abuse guard if the identity it counts against
  // is the platform's, not the caller's.
  //
  // THE SKIP IS NOT AN OPTIMIZATION, IT IS THE FIX FOR A LOST DELIVERY. A job
  // that generated (and paid for) an image, then parked on an OCR outage, comes
  // back with its OWN usage row already counted against its payer. Re-asking
  // "is this payer under the cap?" then answers no — for a payer whose last
  // free slot is the one THIS job is holding — and the job destroys itself,
  // telling the buyer "nothing has been generated and nothing has been charged"
  // when both clauses are false. The allowance belongs to the job once taken.
  if (!(await config.quota.holdsAllowance(contractId))) {
    const quota = await checkFreeGigQuota(config.quota, contract.payerId);
    await jobs.recordGateAudit({
      jobKey,
      contractId,
      gate: 'free-gig-quota',
      result: quota.allowed ? 'allowed' : 'refused',
      detail: { payerId: contract.payerId, used: quota.used },
    });
    if (!quota.allowed) {
      await client.sendMessage(contractId, quota.message);
      await jobs.markDelivered(jobKey, 'rejected');
      log.warn({ used: quota.used }, 'free-gig quota exhausted; job refused before any work');
      return { outcome: 'aborted' };
    }
  }

  const faviconBrief = parseFaviconBrief(description);
  if (faviconBrief.ok) {
    return runFaviconGig(config, {
      job,
      message,
      contract,
      brief: faviconBrief.brief,
      token,
      services,
      log,
    });
  }

  // Prose is accepted here for the same reason it is on the paid path (Task 27):
  // 0 of 78 live gigs carried a fenced block, and `maybePropose` already bids on
  // a prose taster off this very extraction — so resolving it any less capably
  // here would bid on a buyer's gig and then refuse it.
  //
  // REACHED ONLY FOR NON-FAVICON GIGS: `parseFaviconBrief` above returns early,
  // so a favicon gig never pays for a brand-name extraction it has no use for.
  // The favicon brief is deliberately NOT extended to prose — its `logoUrl` is
  // fetched, and `checkLogoUrl`'s https/no-IP-literal/no-loopback policy (§12)
  // is what stands between a buyer string and an SSRF. A URL guessed out of
  // prose by a model is not a URL the buyer wrote.
  //
  // QUOTA SEQUENCING IS UNCHANGED AND LOAD-BEARING. This whole block sits
  // upstream of `consumeFreeGigQuota`, which is called only inside
  // `runFaviconGig` (after the source fetch) and `runTasterGig` (after the first
  // image is paid for) — see its docstring, which names "an unparseable brief"
  // as a thing that must cost the buyer nothing. This change moves WHICH briefs
  // validate, never WHERE the rejection sits, so a refused brief still consumes
  // no allowance.
  const logoBrief = await resolveGigBrief(gig, services.briefExtractor);
  if (logoBrief.ok) {
    return runTasterGig(config, {
      job,
      message,
      contract,
      brief: logoBrief.brief,
      token,
      services,
      log,
    });
  }

  await jobs.recordGateAudit({
    jobKey,
    contractId,
    gate: 'brief',
    result: 'invalid',
    detail: { favicon: faviconBrief.reason, logo: logoBrief.reason },
  });
  await client.sendMessage(
    contractId,
    // The two free jobs need DIFFERENT things, and only one of them changed.
    // The sample concept takes plain prose now, so it must stop demanding JSON;
    // the favicon pack genuinely still needs a fenced `logoUrl`, because that
    // string is fetched and `checkLogoUrl` is what guards it. Saying so plainly
    // beats one blurred sentence that is half-stale.
    'LogoSmith cannot start this free job: the brief in this gig did not validate. ' +
      'There are two free jobs and they need different things. A favicon pack needs a fenced ' +
      'JSON block carrying an https `logoUrl` that points at the logo you already have ' +
      `(${faviconBrief.reason}). A free sample concept needs the brand name to set, written ` +
      'exactly as it should appear on the logo, plus what the brand does — plain prose is ' +
      'fine, for example "a logo for Harbor & Vine, a seaside inn", and the brand name must ' +
      `be Latin script (${logoBrief.reason}). Nothing has been generated, nothing has been ` +
      'charged, and this has not been counted against your free-job allowance — post a ' +
      'corrected gig and LogoSmith will pick it up automatically.',
  );
  await jobs.markDelivered(jobKey, 'rejected');
  return { outcome: 'aborted' };
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
    case 'vector': {
      const result = await runVectorStage(config, message);
      config.logger.info(
        { ...message, ...result, durationMs: Date.now() - startedAt },
        'vector stage finished',
      );
      return;
    }
    case 'single': {
      const result = await runSingleStage(config, message);
      config.logger.info(
        { ...message, ...result, durationMs: Date.now() - startedAt },
        'free-gig stage finished',
      );
      return;
    }
    default: {
      const unreachable: never = message.stage;
      throw new Error(`unknown job stage: ${String(unreachable)}`);
    }
  }
}
