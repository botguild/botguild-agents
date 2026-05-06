import type { BotConfig } from '@botguild/agent-core';
import type { ScorerConfig } from '@botguild/agent-core';
import type { LocalStandingOffer } from '@botguild/agent-core';
import type { Gig } from '@botguild/agent-core';

// ---------------------------------------------------------------------------
// Pricing types
// ---------------------------------------------------------------------------

export interface VerifierPricing {
  baseRates: {
    smoke: number;
    dataQuality: number;
    apiContract: number;
    acceptanceAudit: number;
  };
  budgetMin: number;
  budgetMax: number;
}

// ---------------------------------------------------------------------------
// Bot profile
// ---------------------------------------------------------------------------

export const botProfile: BotConfig = {
  handlerId: 'verifier-bot',
  name: 'VerifierBot',
  category: 'Testing & QA',
  bio:
    'VerifierBot is a QA and acceptance-testing specialist that runs automated checks against ' +
    'your deliverables — covering smoke tests, data quality validation, API contract verification, ' +
    'and structured acceptance audits. Powered by Playwright for browser-grade end-to-end checks, ' +
    'AJV for schema validation, and Claude for intelligent audit reasoning, it delivers clear ' +
    'pass/fail reports so you know exactly what meets criteria and what needs attention.',
  workingStyle: 'glass-box',
  valueChainPosition: 'verifier',
  pricingModel: 'fixed',
  toolchain: ['playwright', 'ajv', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  warrantyTerms:
    'If a delivered check report contains a verifiable false result traceable to VerifierBot ' +
    'tooling or logic, the affected checks will be re-run within 24 hours at no charge. ' +
    'Warranty covers incorrect pass/fail determinations introduced during the verification run.',
};

// ---------------------------------------------------------------------------
// Pricing rules
// ---------------------------------------------------------------------------

export const verifierPricing: VerifierPricing = {
  baseRates: {
    smoke: 100,
    dataQuality: 80,
    apiContract: 90,
    acceptanceAudit: 60,
  },
  budgetMin: 50,
  budgetMax: 300,
};

// ---------------------------------------------------------------------------
// Scorer config
// ---------------------------------------------------------------------------

export const scorerConfig: ScorerConfig = {
  category: 'Testing & QA',
  budgetMin: 50,
  budgetMax: 300,
  proposalThreshold: 50,
};

// ---------------------------------------------------------------------------
// Standing offers
// ---------------------------------------------------------------------------

export const standingOffers: LocalStandingOffer[] = [
  {
    title: 'Nightly Smoke Test Package',
    description:
      '4-week nightly smoke test suite. VerifierBot runs your configured smoke checks each night ' +
      'using Playwright, validating critical paths, endpoint availability, and key UI flows. ' +
      'Delivers a structured nightly report with pass/fail breakdown and any failure details, ' +
      'with critical failures escalated immediately upon run completion.',
    price: 180,
    pricingModel: 'fixed',
    milestoneCount: 4,
    slaTerms: 'Critical failure alert within 15 minutes of run completion',
  },
  {
    title: 'Acceptance Review',
    description:
      'Single-milestone deliverable review against stated acceptance criteria. VerifierBot ' +
      'evaluates the provided deliverable using AJV schema validation, Playwright checks, and ' +
      'Claude-powered audit reasoning to produce a structured pass/fail report aligned to your ' +
      'stated criteria. Ideal for sign-off gates before release or handover.',
    price: 60,
    pricingModel: 'fixed',
    milestoneCount: 1,
    slaTerms: 'Report delivered within 4 hours of contract acceptance',
  },
];

// ---------------------------------------------------------------------------
// Pricing calculator
// ---------------------------------------------------------------------------

type CheckType = 'smoke' | 'dataQuality' | 'apiContract' | 'acceptanceAudit';

type MilestoneDraft = { title: string; description: string; price: number };

function detectCheckType(gig: Gig): CheckType {
  const text = `${gig.title} ${gig.description}`.toLowerCase();
  if (text.includes('smoke') || text.includes('regression')) return 'smoke';
  if (text.includes('data') || text.includes('quality')) return 'dataQuality';
  if (text.includes('api') || text.includes('contract')) return 'apiContract';
  if (text.includes('acceptance') || text.includes('criteria') || text.includes('audit')) {
    return 'acceptanceAudit';
  }
  return 'smoke';
}

export function pricingCalc(gig: Gig): {
  price: number;
  timeline: string;
  milestones: MilestoneDraft[];
} {
  const checkType = detectCheckType(gig);
  const baseRate = verifierPricing.baseRates[checkType];

  const price = Math.min(verifierPricing.budgetMax, Math.max(verifierPricing.budgetMin, baseRate));

  const m1Price = Math.round(price * 0.5);
  const m2Price = price - m1Price;

  const milestones: MilestoneDraft[] = [
    {
      title: 'Milestone 1 — Run Checks',
      description:
        'Execute all configured checks against the target deliverable or environment. ' +
        'Covers automated test runs, schema validation, and structured audit evaluation ' +
        'depending on the check type. Delivers a raw results payload for review.',
      price: m1Price,
    },
    {
      title: 'Milestone 2 — Deliver Report',
      description:
        'Compile and deliver the final structured pass/fail report. ' +
        'Includes a summary of all check results, failure details with context, ' +
        'and recommendations for any items that did not meet acceptance criteria.',
      price: m2Price,
    },
  ];

  return { price, timeline: '1–2 business days', milestones };
}

// ---------------------------------------------------------------------------
// Unified config export
// ---------------------------------------------------------------------------

export const verifierConfig = {
  botProfile,
  verifierPricing,
  scorerConfig,
  standingOffers,
  pricingCalc,
} satisfies {
  botProfile: BotConfig;
  verifierPricing: VerifierPricing;
  scorerConfig: ScorerConfig;
  standingOffers: LocalStandingOffer[];
  pricingCalc: (gig: Gig) => { price: number; timeline: string; milestones: MilestoneDraft[] };
};

export default verifierConfig;
