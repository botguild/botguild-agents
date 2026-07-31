// ---------------------------------------------------------------------------
// LogoSmith configuration — bot identity, gig scoring, pricing anchors, and the
// hard caps and gate thresholds from PRD FR-5/FR-6/FR-14/§9.
// ---------------------------------------------------------------------------

import type {
  BotConfig,
  Gig,
  ProposalMilestone,
  RateCard,
  ResourceEstimate,
  ScorerConfig,
} from '@botguild/agent-core';
import { parseFaviconBrief } from './brief.js';

// --- Bot profile (registerBot) ----------------------------------------------
export const botProfile: BotConfig = {
  handlerId: 'bot-logosmith',
  name: 'LogoSmith',
  category: 'Design / Brand Identity',
  bio:
    'AI logos that can actually spell your name: three stylistically distinct concepts whose ' +
    'lettering is OCR-verified to read back as your brand, then the winner delivered as a true ' +
    'vector pack — SVG with zero embedded rasters, colour and mono masters, a full favicon set ' +
    'with favicon.ico and webmanifest, extracted brand hex codes, and a license-clean font pairing.',
  workingStyle: 'checkpoints',
  valueChainPosition: 'originator',
  toolchain: ['ideogram-3.0', 'recraft-v3', 'llama-4-scout', 'claude-haiku-4-5', 'resvg-wasm'],
  // §9 wording: readback threshold, vector parse, byte-verified dimensions,
  // ZIP integrity. NEVER trademark, NEVER taste.
  warrantyTerms:
    'For 14 days after delivery: any delivered concept whose lettering fails the stated OCR ' +
    'readback threshold as delivered, a logo.svg that does not pass the true-vector parse, any ' +
    'artifact at the wrong pixel dimensions, or a broken or incomplete ZIP is re-run free of ' +
    'charge, plus one revision round on the selected mark. Trademark clearance is NOT performed ' +
    'and NOT warranted.',
};

// --- Gig scoring -------------------------------------------------------------
export const scorerConfig: ScorerConfig = {
  categories: ['Design / Brand Identity', 'Design', 'Brand Identity', 'Graphic Design'],
  keywords: [
    'logo',
    'brand',
    'branding',
    'favicon',
    'icon',
    'wordmark',
    'mark',
    'identity',
    'vector',
    'svg',
  ],
  keywordsForFullScore: 3,
  budgetMin: 5,
  budgetMax: 150,
  proposalThreshold: 40,
};

// --- Pricing -----------------------------------------------------------------
// Gig-listing anchors (PRD §11). The estimator may bid above these
// (max(1.5×cost, gig.budget)); pricingCalc supplies the deterministic baseline
// plus the timeline and the two milestone checkpoints.
export const SEED_PRICE_USD = 25;

export const rateCard: RateCard = {
  perClaudeCall: 0.05,
  perKToken: 0.01,
  perBrowserMinute: 0, // no browser in this bot
  perComputeMinute: 0.05,
  perRun: 0.5,
  fixedOverhead: 5,
};

export const fallbackEstimate: ResourceEstimate = {
  claudeCalls: 8,
  claudeKTokens: 15,
  browserMinutes: 0,
  computeMinutes: 6,
  runs: 1,
};

export function pricingCalc(gig: Gig): {
  price: number;
  timeline: string;
  milestones: ProposalMilestone[];
} {
  const description = gig.description ?? '';
  // Free-funnel gigs anchor at $0 (US-2/US-3) and go through the estimator-free
  // proposer — otherwise the 1.5x-cost floor would re-price them. A favicon gig
  // is recognised by its brief shape; the taster shares the paid brief shape
  // and is recognised by its $0 budget.
  const isFavicon = parseFaviconBrief(description).ok;
  if (isFavicon || (gig.budget ?? 0) === 0) {
    return {
      price: 0,
      timeline: '1 business day',
      milestones: [
        {
          title: isFavicon
            ? 'Milestone 1 — Favicon package from your logo'
            : 'Milestone 1 — One free concept with its OCR verdict',
          duration: '1 business day',
          deliverables: isFavicon
            ? [
                'ZIP: favicon.ico (16/32/48, parse-back verified), PNGs at 16/32/48/180/192/512, site.webmanifest, HTML snippet.',
              ]
            : [
                'One 1024px logo concept with its lettering-readback verdict attached as labelled, non-blocking evidence.',
              ],
        },
      ],
    };
  }

  return {
    price: SEED_PRICE_USD,
    timeline: '2 business days',
    milestones: [
      {
        title: 'Milestone 1 — Three OCR-passing concepts',
        duration: '1 business day',
        deliverables: [
          'Three 1024px logo concepts on three distinct declared style axes.',
          'An OCR readback verdict per concept (model id, transcription, similarity score).',
          'A live progress page showing each concept and its verdict as it lands.',
        ],
      },
      {
        title: 'Milestone 2 — True-vector brand pack',
        duration: '1 business day',
        deliverables: [
          'logo.svg — parse-verified true vector, zero embedded rasters, outlined paths.',
          'Colour and mono PNG masters at 1024px and 2048px.',
          'Favicon set: 16/32/48/180/192/512 plus favicon.ico, site.webmanifest, HTML snippet.',
          'brand.json — extracted hex codes and a license-clean Google Fonts pairing.',
          'JSON validation report and per-image license manifest.',
        ],
      },
    ],
  };
}

// --- Hard caps (FR-5, FR-14) --------------------------------------------------
export const CONCEPT_COUNT = 3;
export const MAX_REGENS_PER_SLOT = 2;
export const MAX_SPEND_USD = 2.5;
export const FREE_GIGS_PER_PAYER = 3;
export const FREE_GIG_WINDOW_DAYS = 30;

/** Failed moderation attempts before the buyer gets a thread status message (FR-2). */
export const MODERATION_ATTEMPTS_BEFORE_NOTICE = 3;

/** `claimed` jobs older than this with no checkpoint are re-enqueued (§12). */
export const STUCK_CLAIM_MINUTES = 30;

/**
 * How long a job may sit parked before LogoSmith gives up on it, tells the
 * buyer, and moves it to a terminal state.
 *
 * WHY THIS EXISTS. A retryable vendor failure parks WITHOUT consuming an FR-5
 * regeneration attempt, so that a 45-minute outage cannot burn a paid job's
 * regeneration budget on a 503 that generated nothing. That leaves parking
 * itself unbounded: a permanently dead vendor would loop park → unpark → fail →
 * park forever — no spend, but the job never delivers, never refunds, and never
 * tells the buyer. This is the independent bound.
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
 *
 * Measured against `jobs.parked_since` — the start of the current failing
 * spell. See migrations/0002_parked_since.sql for why no other column works.
 */
export const PARKED_GIVE_UP_HOURS = 6;

/** Hours after M1 delivery before the default-selection rule fires (FR-9). */
export const SELECTION_TIMEOUT_HOURS = 72;

// --- Gate thresholds (§9) -----------------------------------------------------
// PROVISIONAL until the Phase 2 calibration freezes them against the ≥30-name
// golden set. Do NOT loosen these to make a job pass — §15 tracks regen burn
// precisely so drift triggers prompt tuning, never silent gate-loosening.
export const OCR_SIMILARITY_THRESHOLD = 0.85; // PROVISIONAL
export const MIN_PHASH_HAMMING = 10; // PROVISIONAL

// --- Models -------------------------------------------------------------------
export const HAIKU_MODEL_ID = 'claude-haiku-4-5';
export const SCOUT_MODEL_ID = '@cf/meta/llama-4-scout-17b-16e-instruct';
export const FLUX_MODEL_ID = '@cf/black-forest-labs/flux-2-klein';

/** Haiku 4.5 list pricing, USD per million tokens — spend accounting. */
export const HAIKU_PRICING_PER_MTOK = {
  input: 1.0,
  output: 5.0,
  cacheWrite: 1.25,
  cacheRead: 0.1,
} as const;

/** Conservative flat per-image vendor costs for the FR-5 spend ledger (§11). */
export const IMAGE_COST_USD = {
  ideogram: 0.06,
  recraft: 0.08,
  flux: 0.001,
  vectorizer: 0.2,
} as const;

// --- Pack contract (§8) --------------------------------------------------------
export const FAVICON_SIZES = [16, 32, 48, 180, 192, 512] as const;
export const ICO_SIZES = [16, 32, 48] as const;
export const MASTER_SIZES = [1024, 2048] as const;
