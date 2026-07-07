// Domain types shared across the pipeline. Kept free of Workers globals so
// every gate module and test can import them under plain Node.

/** The fenced-JSON ad-copy brief embedded in a gig description (PRD §8). */
export interface AdBrief {
  brandVoiceGuide: string;
  offer: string;
  campaign: {
    campaignName: string;
    objective: string;
    adSetName: string;
  };
  creative: {
    landingUrl: string;
    pageId: string;
    imageRef: string;
  };
  platform: string;
  variantCount: number;
  angleCount: number;
  policyConstraints: string[];
  /** Present when the brief was joined from D1 via a refresh gig's briefId. */
  briefId?: string;
}

/** The FREE readability gig's brief: one paragraph to score and rewrite. */
export interface ReadabilityBrief {
  paragraph: string;
}

/** One generated ad variant (angle-structured Haiku output). */
export interface Variant {
  id: string;
  angle: string;
  headline: string;
  primaryText: string;
  description: string;
}

export type VariantStatus = 'pending' | 'passed' | 'failed';

/** Snapshot of the moderation vendor's full verdict for one input (§9). */
export interface ModerationVerdict {
  vendor: string;
  model: string;
  flagged: boolean;
  /** The vendor's full response body, retained verbatim for dispute evidence. */
  response: unknown;
  checkedAt: string;
}

export interface LengthCheck {
  field: 'headline' | 'primaryText';
  graphemes: number;
  limit: number;
  marginApplied: boolean;
  pass: boolean;
}

export interface ChecklistResult {
  version: string;
  pass: boolean;
  failures: Array<{ ruleId: string; description: string }>;
}

export interface ReadabilityScore {
  lib: string;
  version: string;
  fleschKincaidGrade: number;
}

/** Per-variant gate evidence accumulated in the D1 checkpoint and report. */
export interface VariantEvidence {
  length?: LengthCheck[];
  checklist?: ChecklistResult;
  moderation?: ModerationVerdict;
  readability?: ReadabilityScore;
}

/** Per-variant checkpoint entry persisted to D1 after every gate step. */
export interface VariantState {
  variant: Variant;
  status: VariantStatus;
  regenAttempts: number;
  evidence: VariantEvidence;
  failReason?: string;
}

/** The resumable job checkpoint (FR-5: caps survive queue retries). */
export interface JobCheckpoint {
  variants: VariantState[];
  batchRounds: number;
  spendUsd: number;
}

export type JobKind = 'adcopy' | 'refresh' | 'readability';

export type JobStatus = 'claimed' | 'parked' | 'in_progress' | 'delivered';

export type JobOutcome = 'delivered' | 'partial' | 'aborted' | 'rejected';

export interface JobMessage {
  contractId: string;
  jobKey: string;
}
