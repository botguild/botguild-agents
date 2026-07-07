// ---------------------------------------------------------------------------
// VoiceWright configuration — bot identity, gig scoring, pricing anchors, and
// the hard caps from PRD FR-5/§9. Everything else is generic plumbing.
// ---------------------------------------------------------------------------

import type {
  BotConfig,
  Gig,
  ProposalMilestone,
  RateCard,
  ResourceEstimate,
  ScorerConfig,
} from '@botguild/agent-core';
import { extractBriefId, parseReadabilityBrief } from './brief.js';

// --- Bot profile (registerBot) ----------------------------------------------
export const botProfile: BotConfig = {
  handlerId: 'bot-voicewright',
  name: 'VoiceWright',
  category: 'Content Creation / Copywriting',
  bio:
    'On-brand Meta ad copy from headline to CTA: 10 variants across 3+ distinct angles, ' +
    'grapheme-validated against Meta length limits, screened by OpenAI Moderation plus a ' +
    'versioned ad-policy checklist, delivered as a CSV on the validated Meta bulk-import template ' +
    'with a JSON validation report evidencing every gate.',
  workingStyle: 'checkpoints',
  valueChainPosition: 'transformer',
  toolchain: ['claude-haiku-4-5', 'openai-moderation', 'intl-segmenter', 'text-readability'],
  // §9 wording: graphemes + checklist version only — never pixels, never
  // "Meta approval guaranteed", never "100% clean import".
  warrantyTerms:
    'For 21 days after delivery: any delivered copy that exceeds the stated grapheme limits, ' +
    'fails the delivered ad-policy checklist version, or is rejected by Meta review is revised free of charge.',
};

// --- Gig scoring -------------------------------------------------------------
export const scorerConfig: ScorerConfig = {
  categories: ['Content Creation / Copywriting', 'Copywriting', 'Content Creation'],
  keywords: ['ad copy', 'copywriting', 'facebook', 'instagram', 'meta ads', 'headline', 'ad variants', 'creative'],
  keywordsForFullScore: 3,
  budgetMin: 5,
  budgetMax: 150,
  proposalThreshold: 40,
};

// --- Pricing -----------------------------------------------------------------
// The gig-listing anchors (PRD §11). The estimator may bid above these
// (max(1.5×cost, gig.budget)); pricingCalc supplies the deterministic baseline
// and the timeline + milestone checkpoints.
export const SEED_PRICE_USD = 15;
export const REFRESH_PRICE_USD = 50;

export const rateCard: RateCard = {
  perClaudeCall: 0.05,
  perKToken: 0.01,
  perBrowserMinute: 0, // no browser in this bot
  perComputeMinute: 0.05,
  perRun: 0.5,
  fixedOverhead: 5,
};

export const fallbackEstimate: ResourceEstimate = {
  claudeCalls: 15,
  claudeKTokens: 30,
  browserMinutes: 0,
  computeMinutes: 5,
  runs: 1,
};

export function pricingCalc(gig: Gig): {
  price: number;
  timeline: string;
  milestones: ProposalMilestone[];
} {
  const description = gig.description ?? '';
  const isRefresh = extractBriefId(description) !== undefined;
  const isReadability = parseReadabilityBrief(description).ok;
  const price = isReadability ? 0 : isRefresh ? REFRESH_PRICE_USD : SEED_PRICE_USD;

  const deliverables = isReadability
    ? ['Flesch-Kincaid readability score (pinned lib + version) and a plain-language rewrite of the submitted paragraph.']
    : [
        'CSV on the validated Meta bulk-import template — one ad row per variant, exact headers, UTF-8, ≤2 MB.',
        'JSON validation report: grapheme counts, angle diversity scores, moderation verdict snapshots, checklist results, advisory readability.',
      ];

  return {
    price,
    timeline: '1 business day',
    milestones: [
      {
        title: 'Milestone 1 — Validated ad copy delivered',
        duration: '1 business day',
        deliverables,
      },
    ],
  };
}

// --- Hard caps (FR-5) ----------------------------------------------------------
export const MAX_REGENS_PER_VARIANT = 3;
export const MAX_BATCH_ROUNDS = 2;
export const MAX_SPEND_USD = 1.5;

/** ≥80% of variantCount must pass for the §9 partial-delivery leg. */
export const PARTIAL_DELIVERY_FLOOR = 0.8;

/** Failed moderation attempts before the buyer gets a thread status message (FR-2). */
export const MODERATION_ATTEMPTS_BEFORE_NOTICE = 3;

/** `claimed` jobs older than this with no checkpoint are re-enqueued (§8). */
export const STUCK_CLAIM_MINUTES = 30;

// --- Diversity gate (§9) -------------------------------------------------------
// PROVISIONAL until calibrated against real Haiku batches in Phase 2; finalized
// per gig-terms version at Phase 3 listing and fixed thereafter.
export const DIVERSITY_THRESHOLD = 0.5;
export const MIN_ANGLES = 3;

// --- Generation ----------------------------------------------------------------
export const HAIKU_MODEL_ID = 'claude-haiku-4-5';

/** Haiku 4.5 list pricing, USD per million tokens — FR-5 spend accounting. */
export const HAIKU_PRICING_PER_MTOK = {
  input: 1.0,
  output: 5.0,
  cacheWrite: 1.25,
  cacheRead: 0.1,
} as const;

// --- Recurring refresh (FR-10) ---------------------------------------------------
export const REFRESH_CYCLE_DAYS = 30;
