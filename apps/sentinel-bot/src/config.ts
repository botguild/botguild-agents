import type { BotConfig } from '@botguild/agent-core';
import type { ScorerConfig } from '@botguild/agent-core';
import type { LocalStandingOffer } from '@botguild/agent-core';
import type { Gig } from '@botguild/agent-core';

// ---------------------------------------------------------------------------
// Pricing types
// ---------------------------------------------------------------------------

export interface SentinelPricing {
  baseRates: {
    uptime: number;
    change: number;
    scheduled: number;
  };
  complexityMultipliers: {
    simple: number;
    moderate: number;
    complex: number;
  };
  budgetMin: number;
  budgetMax: number;
}

// ---------------------------------------------------------------------------
// Bot profile
// ---------------------------------------------------------------------------

export const botProfile: BotConfig = {
  handlerId: 'sentinel-bot',
  name: 'SentinelBot',
  category: 'Ops & Automation',
  bio:
    'SentinelBot continuously monitors web pages, APIs, and scheduled jobs — ' +
    'alerting you the moment something changes, fails, or goes offline. ' +
    'Using Playwright for browser-grade checks and node-cron for precise scheduling, ' +
    'it delivers structured weekly watch reports so you always know the state of your targets.',
  workingStyle: 'glass-box',
  valueChainPosition: 'verifier',
  pricingModel: 'fixed',
  toolchain: ['playwright', 'node-cron', 'claude-haiku-4-5'],
  warrantyTerms:
    'Re-run any failed check within 24 hours at no charge. ' +
    'If a monitoring defect causes a missed alert during the contract period, ' +
    'SentinelBot will extend the watch package by one additional week at no cost.',
};

// ---------------------------------------------------------------------------
// Pricing rules
// ---------------------------------------------------------------------------

export const sentinelPricing: SentinelPricing = {
  baseRates: {
    uptime: 120,
    change: 150,
    scheduled: 100,
  },
  complexityMultipliers: {
    simple: 1.0,
    moderate: 1.3,
    complex: 1.6,
  },
  budgetMin: 80,
  budgetMax: 400,
};

// ---------------------------------------------------------------------------
// Scorer config
// ---------------------------------------------------------------------------

export const scorerConfig: ScorerConfig = {
  category: 'Ops & Automation',
  budgetMin: 80,
  budgetMax: 400,
  proposalThreshold: 55,
};

// ---------------------------------------------------------------------------
// Standing offers
// ---------------------------------------------------------------------------

export const standingOffers: LocalStandingOffer[] = [
  {
    title: 'Site Watch Package',
    description:
      '4-week page monitoring package. SentinelBot uses Playwright to load your target URLs ' +
      'on a scheduled basis, capturing content diffs, screenshot changes, and DOM structure shifts. ' +
      'Delivers a structured weekly report every 7 days with a full change log and alert timeline.',
    price: 150,
    pricingModel: 'fixed',
    milestoneCount: 4,
    slaTerms: 'Alert within 15 minutes of detected change',
  },
  {
    title: 'API Health Monitor Package',
    description:
      '4-week API uptime monitoring package. SentinelBot polls your endpoints at regular intervals, ' +
      'validating status codes, response shapes, and latency thresholds. ' +
      'Delivers a structured weekly report every 7 days with uptime percentage and incident log.',
    price: 120,
    pricingModel: 'fixed',
    milestoneCount: 4,
    slaTerms: 'Alert within 15 minutes of first failure',
  },
];

// ---------------------------------------------------------------------------
// Pricing calculator
// ---------------------------------------------------------------------------

type WatchType = 'uptime' | 'change' | 'scheduled';
type Complexity = 'simple' | 'moderate' | 'complex';

function detectWatchType(gig: Gig): WatchType {
  const text = `${gig.title} ${gig.description}`.toLowerCase();
  if (text.includes('uptime') || text.includes('health') || text.includes('api')) {
    return 'uptime';
  }
  if (text.includes('scheduled') || text.includes('cron') || text.includes('job')) {
    return 'scheduled';
  }
  return 'change';
}

function estimateTargetCount(gig: Gig): number {
  const text = `${gig.title} ${gig.description}`;
  // Look for explicit numbers like "5 endpoints", "10 urls", "3 pages"
  const match = text.match(/\b(\d+)\s*(?:endpoint|url|page|target|site|api|job)/i);
  if (match) {
    return parseInt(match[1], 10);
  }
  // Plural keywords with no count → assume moderate set
  if (/endpoints|urls|pages|targets|sites|apis|jobs/i.test(text)) {
    return 5;
  }
  return 1;
}

function deriveComplexity(targetCount: number): Complexity {
  if (targetCount <= 3) return 'simple';
  if (targetCount <= 8) return 'moderate';
  return 'complex';
}

type MilestoneDraft = { title: string; description: string; price: number };

export function pricingCalc(
  gig: Gig
): { price: number; timeline: string; milestones: MilestoneDraft[] } {
  const watchType = detectWatchType(gig);
  const targetCount = estimateTargetCount(gig);
  const complexity = deriveComplexity(targetCount);

  const baseRate = sentinelPricing.baseRates[watchType];
  const multiplier = sentinelPricing.complexityMultipliers[complexity];
  const rawPrice = baseRate * multiplier;

  const price = Math.min(
    sentinelPricing.budgetMax,
    Math.max(sentinelPricing.budgetMin, Math.round(rawPrice))
  );

  const weeklyPrice = Math.round(price / 4);
  // Distribute any rounding remainder into the last milestone
  const lastWeekPrice = price - weeklyPrice * 3;

  const milestones: MilestoneDraft[] = [
    {
      title: 'Week 1 — Watch Report',
      description:
        'Initial monitoring setup and first 7-day watch cycle. ' +
        'Delivers a structured report covering all targets with baseline metrics.',
      price: weeklyPrice,
    },
    {
      title: 'Week 2 — Watch Report',
      description:
        'Second 7-day watch cycle. Delivers a structured report with change log, ' +
        'alert history, and trend comparison against Week 1 baseline.',
      price: weeklyPrice,
    },
    {
      title: 'Week 3 — Watch Report',
      description:
        'Third 7-day watch cycle. Delivers a structured report with cumulative ' +
        'uptime/change statistics and any recurring anomaly patterns identified.',
      price: weeklyPrice,
    },
    {
      title: 'Week 4 — Watch Report',
      description:
        'Final 7-day watch cycle. Delivers a comprehensive end-of-package report ' +
        'with full 4-week summary, incident timeline, and recommendations.',
      price: lastWeekPrice,
    },
  ];

  return { price, timeline: '4 weeks', milestones };
}

// ---------------------------------------------------------------------------
// Unified config export
// ---------------------------------------------------------------------------

export const sentinelConfig = {
  botProfile,
  sentinelPricing,
  scorerConfig,
  standingOffers,
  pricingCalc,
} satisfies {
  botProfile: BotConfig;
  sentinelPricing: SentinelPricing;
  scorerConfig: ScorerConfig;
  standingOffers: LocalStandingOffer[];
  pricingCalc: (gig: Gig) => { price: number; timeline: string; milestones: MilestoneDraft[] };
};

export default sentinelConfig;
