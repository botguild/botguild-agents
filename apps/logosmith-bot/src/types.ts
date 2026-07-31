// Domain types shared across the pipeline. Kept free of Workers globals so
// every gate module and test can import them under plain Node.

/** The fenced-JSON logo brief embedded in a gig description (PRD §8). */
export interface LogoBrief {
  brandName: string;
  industry: string;
  brief?: string;
  palettePreference?: string[];
  avoid?: string[];
  script?: string;
}

/**
 * How to read every field of a `LogoBrief` as buyer-supplied free text.
 *
 * DECLARED AS A MAPPED TYPE OVER `keyof Required<LogoBrief>`, NOT AS A LIST OF
 * FIELD NAMES, and that is the whole point: adding a field to `LogoBrief` and
 * forgetting to classify it here is a COMPILE ERROR, not an unscreened input.
 *
 * WHY THAT MATTERS. `moderationText` (pipeline.ts) used to hand-enumerate four
 * of the five free-text fields, and the one it missed — `palettePreference` —
 * reached Ideogram's and Recraft's prompts under our API keys, and reached the
 * axis compiler's user message (axes.ts `JSON.stringify`s the WHOLE brief),
 * with no content check anywhere on the path. Meanwhile the refusal copy told
 * the buyer LogoSmith "screens every brief". An enumeration that can drift from
 * the type it enumerates is the recurring defect of this codebase; this is the
 * shape that cannot.
 *
 * EVERY field is free text here, including `script`, which no prompt builder
 * reads today: it is still buyer-authored, still `JSON.stringify`d into the
 * axis compiler's message, and "no current caller interpolates it" is not a
 * content guarantee.
 */
const LOGO_BRIEF_TEXT: {
  [K in keyof Required<LogoBrief>]: (brief: LogoBrief) => readonly string[];
} = {
  brandName: (brief) => [brief.brandName],
  industry: (brief) => [brief.industry],
  brief: (brief) => (brief.brief === undefined ? [] : [brief.brief]),
  palettePreference: (brief) => brief.palettePreference ?? [],
  avoid: (brief) => brief.avoid ?? [],
  script: (brief) => (brief.script === undefined ? [] : [brief.script]),
};

/**
 * Every buyer-supplied string in a brief, in declaration order — the input to
 * FR-2 moderation, and the honest answer to "what did the buyer actually
 * write?". Derived from `LOGO_BRIEF_TEXT`, so it cannot fall behind the type.
 */
export function logoBriefFreeText(brief: LogoBrief): string[] {
  return Object.values(LOGO_BRIEF_TEXT).flatMap((read) => [...read(brief)]);
}

/**
 * The NAMES of those fields, derived from the same exhaustive mapped type.
 *
 * Exists so a test can assert something about EVERY field individually rather
 * than about a hand-written list that drifts. `brief.test.ts` uses it to prove
 * each free-text field is length-bounded at intake — a check that was quietly
 * vacuous while it was written against a fully-oversized fixture, because one
 * bounded field was enough to refuse the whole brief and the other five went
 * untested.
 */
export const LOGO_BRIEF_FIELDS = Object.keys(LOGO_BRIEF_TEXT) as (keyof Required<LogoBrief>)[];

/** The FREE favicon gig's brief: one existing logo to repackage. */
export interface FaviconBrief {
  logoUrl: string;
}

export type JobKind = 'logo' | 'favicon' | 'taster';
export type JobStage = 'concepts' | 'vector' | 'single';
export type JobStatus = 'claimed' | 'parked' | 'in_progress' | 'delivered';
export type JobOutcome = 'delivered' | 'partial' | 'aborted' | 'rejected';
export type SelectionSource = 'buyer' | 'default';

/** A declared style axis compiled from the brief (FR-3). */
export interface StyleAxis {
  id: string;
  label: string;
  prompt: string;
  /** Which vendor this axis routes to (FR-4). */
  vendor: 'ideogram' | 'recraft' | 'flux';
}

/** Decoded RGBA raster. Width/height are the authoritative pixel dimensions. */
export interface Pixmap {
  width: number;
  height: number;
  data: Uint8Array;
}

/** One generated concept and its provenance. */
export interface Concept {
  slot: number;
  axisId: string;
  vendor: string;
  vendorRequestId?: string;
  png: Uint8Array;
  /** Vendor RNG seed when returned (Ideogram does) — makes a concept
   *  reproducible; recorded in the gate audit detail, not its own column. */
  seed?: number;
  /** Present when the vendor returned a native vector export (Recraft). */
  nativeSvg?: string;
}

/** The OCR readback verdict, snapshotted at delivery time (FR-5). */
export interface OcrVerdict {
  model: string;
  transcription: string;
  score: number;
  pass: boolean;
  unsafe: boolean;
  checkedAt: string;
}

export type ConceptStatus = 'pending' | 'passed' | 'failed';

/** Per-slot checkpoint entry persisted to D1 after every gate step. */
export interface ConceptState {
  slot: number;
  axis: StyleAxis;
  status: ConceptStatus;
  attempts: number;
  phash?: string;
  ocr?: OcrVerdict;
  r2Key?: string;
  /** R2 key of the sanitized vendor-native SVG, when the vendor returned one
   *  (Recraft). Lives on the checkpoint — not just the `concepts` row — because
   *  the resume path rewrites that row in full from this state: a pointer the
   *  checkpoint cannot hold is a pointer redelivery silently nulls, and losing
   *  it costs stage 2 a Vectorizer.ai call for a vector already in R2. */
  nativeSvgKey?: string;
  vendorRequestId?: string;
  failReason?: string;
}

/** The resumable job checkpoint (FR-5: caps survive queue retries). */
export interface JobCheckpoint {
  slots: ConceptState[];
  spendUsd: number;
}

export interface JobMessage {
  contractId: string;
  jobKey: string;
  stage: JobStage;
}

// --- Binding-shaped structural interfaces ------------------------------------
// Declared here, in the one module with no dependencies of its own, so that
// gates/* and pack/* stay leaf modules: a gate must never import from
// generate.ts just to name the type of a binding it was handed.

/** The subset of `fetch` every network-touching module consumes. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The subset of the Workers AI binding this app uses. */
export interface AiLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}
