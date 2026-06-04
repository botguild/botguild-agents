import type { BotConfig } from '@botguild/agent-core';
import type { ScorerConfig } from '@botguild/agent-core';
import type { Gig } from '@botguild/agent-core';
import type { RateCard, ResourceEstimate } from '@botguild/agent-core';

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
  categories: ['Testing & QA'],
  // Any gig near VerifierBot's QA description bids, even outside the exact category.
  keywords: [
    'test',
    'testing',
    'qa',
    'quality',
    'verify',
    'verification',
    'validation',
    'validate',
    'acceptance',
    'smoke',
    'regression',
    'audit',
    'contract',
    'schema',
    'pass/fail',
    'e2e',
    'end-to-end',
  ],
  keywordsForFullScore: 3,
  budgetMin: 50,
  budgetMax: 300,
  proposalThreshold: 40,
};

// ---------------------------------------------------------------------------
// Cost model — Claude estimates resource quantities, this rate card turns them
// into dollars, and the bid is 1.5× that cost. Browser-grade E2E checks use
// Playwright minutes; acceptance audits lean on Claude reasoning tokens.
// ---------------------------------------------------------------------------

export const rateCard: RateCard = {
  perClaudeCall: 0.6, // audits use Sonnet-grade reasoning
  perKToken: 0.3,
  perBrowserMinute: 1.5,
  perComputeMinute: 0.4,
  perRun: 2,
  fixedOverhead: 12,
};

// Typical single check-suite run with a report.
export const fallbackEstimate: ResourceEstimate = {
  claudeCalls: 5,
  claudeKTokens: 30,
  browserMinutes: 15,
  computeMinutes: 15,
  runs: 2,
};

// ---------------------------------------------------------------------------
// Pricing calculator
// ---------------------------------------------------------------------------

type CheckType = 'smoke' | 'dataQuality' | 'apiContract' | 'acceptanceAudit';

type MilestoneDraft = { title: string; duration: string; deliverables: string[] };

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

  const milestones: MilestoneDraft[] = [
    {
      title: 'Milestone 1 — Run Checks',
      duration: '1 business day',
      deliverables: [
        'Execute all configured checks against the target deliverable or environment. ' +
          'Covers automated test runs, schema validation, and structured audit evaluation ' +
          'depending on the check type. Raw results payload for review.',
      ],
    },
    {
      title: 'Milestone 2 — Deliver Report',
      duration: '1 business day',
      deliverables: [
        'Compile and deliver the final structured pass/fail report. ' +
          'Includes a summary of all check results, failure details with context, ' +
          'and recommendations for any items that did not meet acceptance criteria.',
      ],
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
  pricingCalc,
} satisfies {
  botProfile: BotConfig;
  verifierPricing: VerifierPricing;
  scorerConfig: ScorerConfig;
  pricingCalc: (gig: Gig) => { price: number; timeline: string; milestones: MilestoneDraft[] };
};

export default verifierConfig;
