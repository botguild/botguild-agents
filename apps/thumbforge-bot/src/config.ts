// ---------------------------------------------------------------------------
// ThumbForge configuration — bot identity, gig scoring, pricing anchors, the
// §9 gate thresholds (calibration defaults, frozen after Phase 2), and the
// recurring/cap constants from §10–§11. Everything else is generic plumbing.
// ---------------------------------------------------------------------------

import type {
  BotConfig,
  Gig,
  ProposalMilestone,
  RateCard,
  ResourceEstimate,
  ScorerConfig,
} from '@botguild/agent-core';

export const SERVICE = 'thumbforge-bot';

// --- Bot profile (registerBot) ----------------------------------------------
export const botProfile: BotConfig = {
  handlerId: 'bot-thumbforge',
  name: 'ThumbForge',
  category: 'Design / Illustration',
  bio:
    'Spec-locked thumbnails, OG/share images, and social packs rendered on publish — Satori + resvg ' +
    'inside a Cloudflare Worker, no design vendor on the money path. Every image is byte-verified: exact ' +
    'pixel dimensions, sub-2MB with a quality floor, brand color within ΔE, headline at or above a minimum ' +
    'font size (rejected, never silently shrunk), logo present and un-occluded, and A/B variants that clear ' +
    'a perceptual-diff + layout-difference threshold. Delivered from the bot\'s own custom-domain route with ' +
    'an editable Satori template artifact.',
  workingStyle: 'glass-box',
  valueChainPosition: 'transformer',
  toolchain: ['satori', 'resvg-wasm', 'mozjpeg-wasm', 'claude-haiku-4-5', 'youtube-data-api'],
  // §9 wording: dimensions / file size / ΔE / min-font-px / logo similarity /
  // pHash + layout-diff only — never "pixel-perfect brand match", never
  // "guaranteed CMS approval".
  warrantyTerms:
    'For 14 days after delivery: any delivered image that fails a declared blocking gate — wrong dimensions, ' +
    'over 2MB, sub-floor JPEG quality, brand color beyond the stated ΔE at a declared swatch region, or a ' +
    'missing/occluded logo — is re-rendered free, plus one variant swap per thumbnail.',
};

// --- Gig scoring -------------------------------------------------------------
export const scorerConfig: ScorerConfig = {
  categories: ['Design / Illustration', 'Design', 'Graphic Design', 'Illustration'],
  keywords: [
    'thumbnail',
    'og image',
    'open graph',
    'social pack',
    'youtube',
    'banner',
    'brand kit',
    'social media graphics',
    'share image',
  ],
  keywordsForFullScore: 3,
  budgetMin: 5,
  budgetMax: 150,
  proposalThreshold: 40,
};

// --- Pricing anchors (PRD §11) ----------------------------------------------
// One-off listing anchors; the estimator may bid above these (max(1.5×cost,
// gig.budget)). Recurring columns are fixed-price monthly REPEAT gigs with hard
// render caps (§10) — never subscriptions, never metered.
export const SOCIAL_PACK_PRICE_USD = 15;
export const YOUTUBE_AB_PRICE_USD = 8;
export const OG_SETUP_PRICE_USD = 25;

export const SOCIAL_PACK_MONTHLY_USD = 45;
export const YOUTUBE_AB_MONTHLY_USD = 40;
export const OG_MONTHLY_USD = 25;

/** Contracted monthly render caps per recurring line (PRD §11). */
export const SOCIAL_PACK_MONTHLY_CAP = 20;
export const YOUTUBE_AB_MONTHLY_CAP = 10;
export const OG_MONTHLY_CAP = 100;

// Near-zero cost to serve: in-Worker Satori render + sub-cent Claude tokens.
export const rateCard: RateCard = {
  perClaudeCall: 0.05,
  perKToken: 0.01,
  perBrowserMinute: 0, // no browser in this bot
  perComputeMinute: 0.02,
  perRun: 0.1,
  fixedOverhead: 5,
};

export const fallbackEstimate: ResourceEstimate = {
  claudeCalls: 3,
  claudeKTokens: 6,
  browserMinutes: 0,
  computeMinutes: 3,
  runs: 1,
};

/** Which seed line a gig maps to, inferred from its description keywords. */
export type GigKind = 'social_pack' | 'thumbnail' | 'og';

export function classifyGig(gig: Gig): GigKind {
  const text = `${gig.title} ${gig.description ?? ''}`.toLowerCase();
  if (/\bog\b|open graph|share image|share preview/.test(text)) return 'og';
  if (/thumbnail|youtube|a\/b|video/.test(text)) return 'thumbnail';
  return 'social_pack';
}

export function pricingCalc(gig: Gig): {
  price: number;
  timeline: string;
  milestones: ProposalMilestone[];
} {
  const kind = classifyGig(gig);
  const price =
    kind === 'og'
      ? OG_SETUP_PRICE_USD
      : kind === 'thumbnail'
        ? YOUTUBE_AB_PRICE_USD
        : SOCIAL_PACK_PRICE_USD;

  const deliverables =
    kind === 'og'
      ? [
          'A signed CMS publish webhook that renders one 1200x630 OG image per published page version.',
          'Per-offer HMAC secret + drop-in signing snippet; images served from the bot custom-domain route.',
        ]
      : kind === 'thumbnail'
        ? [
            'Two layout-distinct 1280x720 thumbnail variants (<2MB each), headline auto-filled from video metadata.',
            'Variants clear the declared pHash distance + composition-difference threshold; editable template included.',
          ]
        : [
            'The contracted count of on-brand graphics across feed (1080x1080) and story (1080x1920) sizes, <2MB each.',
            'Brand color within ΔE at declared swatch regions; the editable Satori template artifact.',
          ];

  return {
    price,
    timeline: '1 business day',
    milestones: [
      {
        title:
          kind === 'social_pack'
            ? 'Milestone 1 — Template + graphics delivered'
            : 'Milestone 1 — Spec-locked images delivered',
        duration: '1 business day',
        deliverables,
      },
    ],
  };
}

// --- §9 gate thresholds (calibration defaults; frozen after Phase 2) ---------
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const JPEG_QUALITY_FLOOR = 70;
export const MAX_DELTA_E = 4;
export const LOGO_MIN_SIMILARITY = 0.9;
export const AB_MIN_PHASH_DISTANCE = 10;

// --- CMS webhook + idempotency (§8, FR-2/FR-3) -------------------------------
/** Timestamp replay window for CMS publish webhooks (FR-2). */
export const CMS_REPLAY_WINDOW_SECONDS = 300;
/** A `pending` idempotency claim older than this may be taken over (FR-3). */
export const PENDING_TAKEOVER_MS = 2 * 60 * 1000;
/** Synchronous moderation budget on the OG path; over-budget → 202 (FR-14). */
export const MODERATION_BUDGET_MS = 5000;
/** Async (queue) moderation budget — no sync CMS window to respect (FR-14). */
export const ASYNC_MODERATION_BUDGET_MS = 30_000;

// --- Recurring / sweeps (§10) ------------------------------------------------
/** `claimed` render jobs older than this with no progress are re-enqueued (§8). */
export const STUCK_CLAIM_MINUTES = 30;
/** Gate-audit rows older than this are pruned by the daily sweep (bounded retention). */
export const AUDIT_RETENTION_DAYS = 90;

// --- Generation --------------------------------------------------------------
export const HAIKU_MODEL_ID = 'claude-haiku-4-5';
