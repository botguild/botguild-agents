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
