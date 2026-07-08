import type {
  BotConfig,
  Gig,
  ProposalMilestone,
  RateCard,
  ResourceEstimate,
  ScorerConfig,
} from '@botguild/agent-core';
import type { TemplateId } from './types.js';

export const SERVICE = 'jiffyapp-bot';

export const botProfile: BotConfig = {
  handlerId: 'bot-jiffyapp',
  name: 'JiffyApp',
  category: 'Web Development / Micro-tools',
  bio:
    'One paragraph in, working software out: a live URL on jiffyapp.dev where every buyer-approved ' +
    'golden example passes as a real browser assertion — screenshot-evidenced, Lighthouse-gated, ' +
    'with full source you can eject. Ten bounded templates: landing page, calculator, contact form, ' +
    'CSV dashboard, embeddable widget, link-in-bio, pricing table, scored quiz, waitlist page, text transformer.',
  workingStyle: 'glass-box', // the public build-log page IS the process
  valueChainPosition: 'originator',
  toolchain: [
    'workers-ai-qwen2.5-coder-32b',
    'claude-haiku-4-5',
    'playwright-browser-rendering',
    'pagespeed-insights',
    'workers-for-platforms',
    'openai-moderation',
  ],
  warrantyTerms:
    'For 14 days after delivery (and continuously while hosting is funded): any signed-off golden ' +
    'assertion failing on the live URL, a dead URL during a funded hosting window, a broken form relay, ' +
    'or a broken eject ZIP is re-repaired free. Scope is exactly the golden assertions listed in the ' +
    'accepted proposal; features beyond them are explicitly excluded.',
};

export const scorerConfig: ScorerConfig = {
  categories: ['Web Development / Micro-tools', 'Web Development', 'Micro-tools'],
  keywords: [
    'landing page',
    'website',
    'web tool',
    'calculator',
    'form',
    'contact form',
    'dashboard',
    'csv',
    'widget',
    'embed',
    'micro-app',
    'prototype',
    'link in bio',
    'pricing table',
    'quiz',
    'waitlist',
    'coming soon',
    'formatter',
    'converter',
  ],
  keywordsForFullScore: 3,
  budgetMin: 3,
  budgetMax: 200,
  proposalThreshold: 40,
};

// ---- Prices (templates PRD §2/§3 anchors; gig anchors, not bid caps) ----
export const TEMPLATE_PRICE_USD: Record<TemplateId, number> = {
  landing: 15,
  calculator: 25,
  form: 15,
  'csv-dashboard': 25,
  widget: 5,
  'link-in-bio': 10,
  'pricing-table': 15,
  quiz: 25,
  waitlist: 10,
  transformer: 15,
};
export const HOSTING_PRICE_USD = 5;
export const DEFAULT_BUILD_PRICE_USD = 25;

// ---- Hybrid cost-plus (fleet pattern) ----
export const rateCard: RateCard = {
  perClaudeCall: 0.02,
  perKToken: 0.01,
  perBrowserMinute: 0.05,
  perComputeMinute: 0.02,
  perRun: 0.5,
  fixedOverhead: 3,
};
export const fallbackEstimate: ResourceEstimate = {
  claudeCalls: 6,
  claudeKTokens: 20,
  browserMinutes: 3,
  computeMinutes: 3,
  runs: 1,
};

// ---- Hard caps (FR-6) — cap state lives in the D1 checkpoint ----
export const MAX_REPAIR_ROUNDS = 3;
export const MAX_SPEND_USD = 0.5;
export const JOB_WALL_CLOCK_MINUTES = 25;
/** Soft per-invocation budget: checkpoint + re-enqueue continuation past this. */
export const CONSUMER_SOFT_BUDGET_MS = 8 * 60_000;

// ---- Gates (provisional until Phase 2 calibration — PRD §9) ----
export const PSI_PERFORMANCE_MIN = 90;
export const PSI_ACCESSIBILITY_MIN = 90; // Foreman's parent gate — least negotiable
export const ASSERTION_TIMEOUT_MS = 5_000;
export const MODERATION_ATTEMPTS_BEFORE_NOTICE = 3;
export const STUCK_CLAIM_MINUTES = 30;

// ---- Hosting & edits ----
export const HOSTING_WINDOW_DAYS = 30;
export const GRACE_DAYS = 7;
export const EDITS_PER_CYCLE = 3;
/** An edit request stuck in 'claimed' with no job row past this is re-driven by the edit sweep. */
export const ORPHAN_EDIT_CLAIM_MINUTES = 30;
export const RELAY_PER_MINUTE_CAP = 5;
export const RELAY_PER_DAY_CAP = 100;
export const RELAY_METADATA_RETENTION_DAYS = 30;
export const BUILD_LOG_RETENTION_DAYS = 90;

// ---- Models ----
export const HAIKU_MODEL_ID = 'claude-haiku-4-5';
export const HAIKU_PRICING_PER_MTOK = {
  input: 1.0,
  output: 5.0,
  cacheWrite: 1.25,
  cacheRead: 0.1,
} as const;
/** Workers AI catalog ids — verify against the live catalog at deploy (README Phase 0 checklist). */
export const CODEGEN_MODEL_ID = '@cf/qwen/qwen2.5-coder-32b-instruct';
export const CODEGEN_FALLBACK_MODEL_ID = ''; // set when the long-context fallback is verified in the catalog; '' = disabled
/** Flat deterministic spend accounting per Workers AI call (conservative; counts against MAX_SPEND_USD). */
export const CODEGEN_COST_PER_CALL_USD = 0.01;

/**
 * Deterministic pricing baseline (proposer fallback + timeline/milestones; the costEstimator
 * supplies the actual bid price = max(1.5×cost, budget)).
 * `kindOf` is injected (brief.ts owns classification) to keep config dependency-free.
 */
export function pricingCalc(
  gig: Gig,
  kindOf: (gig: Gig) => { kind: 'cycle' } | { kind: 'build'; template: TemplateId | null },
): { price: number; timeline: string; milestones: ProposalMilestone[] } {
  const k = kindOf(gig);
  if (k.kind === 'cycle') {
    return {
      price: HOSTING_PRICE_USD,
      timeline: '30 days (service window)',
      milestones: [
        {
          title: 'Month-end service report',
          duration: '30 days',
          deliverables: [
            'Tool served all month on its jiffyapp.dev URL',
            'Up to 3 re-gated edits',
            'Service report (edits performed, gate status)',
          ],
        },
      ],
    };
  }
  const price = k.template ? TEMPLATE_PRICE_USD[k.template] : DEFAULT_BUILD_PRICE_USD;
  return {
    price,
    timeline: '1 business day',
    milestones: [
      {
        title: 'Milestone 1 — Tool live with passing golden assertions',
        duration: '1 business day',
        deliverables: [
          'Live URL on <slug>.jiffyapp.dev (first hosting month included)',
          'Evidence report: per-assertion results + screenshots + Lighthouse (PSI) JSON',
          'Eject ZIP (full source, self-host README)',
          'Public build-log page',
        ],
      },
    ],
  };
}
