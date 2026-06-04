import type { BotConfig } from '@botguild/agent-core';
import type { ScorerConfig } from '@botguild/agent-core';
import type { Gig } from '@botguild/agent-core';
import type { RateCard, ResourceEstimate } from '@botguild/agent-core';

// ---------------------------------------------------------------------------
// Pricing types
// ---------------------------------------------------------------------------

export interface FlowPricing {
  baseRates: {
    csv: number;
    pdf: number;
    api: number;
    sheet: number;
    multi: number;
  };
  complexityMultipliers: {
    small: number;
    medium: number;
    large: number;
  };
  budgetMin: number;
  budgetMax: number;
}

// ---------------------------------------------------------------------------
// Bot profile
// ---------------------------------------------------------------------------

export const botProfile: BotConfig = {
  handlerId: 'flow-bot',
  name: 'FlowBot',
  category: 'Ops & Automation',
  bio:
    'FlowBot is a data ETL specialist that ingests raw CSV files, PDFs, spreadsheets, and API ' +
    'feeds — cleaning, transforming, and delivering structured outputs your systems can act on. ' +
    'Powered by PapaParse and pdf-parse for extraction and Claude for intelligent normalization, ' +
    'it handles everything from one-off batch jobs to recurring data sync pipelines.',
  workingStyle: 'checkpoints',
  valueChainPosition: 'transformer',
  toolchain: ['papaparse', 'pdf-parse', 'claude-haiku-4-5', 'claude-sonnet-4-6'],
  warrantyTerms:
    'If a delivered output contains data transformation errors traceable to FlowBot processing, ' +
    'a corrected output will be re-delivered within 24 hours at no charge. ' +
    'Warranty covers schema mismatches, dropped rows, and encoding errors introduced during transformation.',
};

// ---------------------------------------------------------------------------
// Pricing rules
// ---------------------------------------------------------------------------

export const flowPricing: FlowPricing = {
  baseRates: {
    csv: 75,
    pdf: 90,
    api: 120,
    sheet: 100,
    multi: 150,
  },
  complexityMultipliers: {
    small: 1.0,
    medium: 1.3,
    large: 1.6,
  },
  budgetMin: 60,
  budgetMax: 350,
};

// ---------------------------------------------------------------------------
// Scorer config
// ---------------------------------------------------------------------------

export const scorerConfig: ScorerConfig = {
  categories: ['Ops & Automation'],
  // Any gig near FlowBot's ETL description bids, even outside the exact category.
  keywords: [
    'data',
    'etl',
    'transform',
    'csv',
    'excel',
    'spreadsheet',
    'pdf',
    'invoice',
    'api feed',
    'json feed',
    'ingest',
    'clean',
    'normalize',
    'parse',
    'pipeline',
    'sync',
    'extract',
    'migrate',
  ],
  keywordsForFullScore: 3,
  budgetMin: 60,
  budgetMax: 350,
  proposalThreshold: 40,
};

// ---------------------------------------------------------------------------
// Cost model — Claude estimates resource quantities, this rate card turns them
// into dollars, and the bid is 1.5× that cost. FlowBot does no browser work, so
// perBrowserMinute is effectively unused (estimates report 0 browserMinutes).
// ---------------------------------------------------------------------------

export const rateCard: RateCard = {
  perClaudeCall: 0.5,
  perKToken: 0.3, // normalization leans on Claude tokens
  perBrowserMinute: 1.5,
  perComputeMinute: 0.5, // parsing/transform compute is the main cost driver
  perRun: 2,
  fixedOverhead: 15,
};

// Typical single-format, medium-row batch transform.
export const fallbackEstimate: ResourceEstimate = {
  claudeCalls: 6,
  claudeKTokens: 50,
  browserMinutes: 0,
  computeMinutes: 30,
  runs: 1,
};

// ---------------------------------------------------------------------------
// Pricing calculator
// ---------------------------------------------------------------------------

type InputType = 'csv' | 'pdf' | 'api' | 'sheet' | 'multi';
type RowSize = 'small' | 'medium' | 'large';

type MilestoneDraft = { title: string; duration: string; deliverables: string[] };

function detectInputType(gig: Gig): InputType {
  const text = `${gig.title} ${gig.description}`.toLowerCase();
  const hasCsv = text.includes('csv') || text.includes('spreadsheet') || text.includes('excel');
  const hasPdf = text.includes('pdf') || text.includes('invoice') || text.includes('document');
  const hasApi =
    text.includes('api') ||
    text.includes('endpoint') ||
    text.includes('rest') ||
    text.includes('json feed');
  const hasSheet =
    text.includes('sheet') || text.includes('google sheet') || text.includes('airtable');

  const matchCount = [hasCsv, hasPdf, hasApi, hasSheet].filter(Boolean).length;
  if (matchCount > 1) return 'multi';
  if (hasApi) return 'api';
  if (hasSheet) return 'sheet';
  if (hasPdf) return 'pdf';
  return 'csv';
}

function detectRowSize(gig: Gig): RowSize {
  const text = `${gig.title} ${gig.description}`;
  const match = text.match(/\b(\d[\d,]*)\s*(?:row|record|line|entry|entries)/i);
  if (match) {
    const count = parseInt(match[1].replace(/,/g, ''), 10);
    if (count < 1000) return 'small';
    if (count <= 10000) return 'medium';
    return 'large';
  }
  if (/large|bulk|massive|million|hundred.thousand/i.test(text)) return 'large';
  if (/medium|moderate|thousand/i.test(text)) return 'medium';
  return 'small';
}

export function pricingCalc(gig: Gig): {
  price: number;
  timeline: string;
  milestones: MilestoneDraft[];
} {
  const inputType = detectInputType(gig);
  const rowSize = detectRowSize(gig);

  const baseRate = flowPricing.baseRates[inputType];
  const multiplier = flowPricing.complexityMultipliers[rowSize];
  const rawPrice = baseRate * multiplier;

  const price = Math.min(
    flowPricing.budgetMax,
    Math.max(flowPricing.budgetMin, Math.round(rawPrice)),
  );

  const milestones: MilestoneDraft[] = [
    {
      title: 'Milestone 1 — Fetch & Validate',
      duration: '1 business day',
      deliverables: [
        'Ingest source data from the provided input (CSV, PDF, API, or sheet). ' +
          'Validate schema, check for missing fields, encoding issues, and structural anomalies. ' +
          'Validation report summarising row counts, detected issues, and a proposed schema map.',
      ],
    },
    {
      title: 'Milestone 2 — Transform',
      duration: '2 business days',
      deliverables: [
        'Apply all configured transformations: field normalization, type coercion, deduplication, ' +
          'and any enrichment or filtering rules. ' +
          'Transformed staging output for client review before final delivery.',
      ],
    },
    {
      title: 'Milestone 3 — Deliver',
      duration: '1 business day',
      deliverables: [
        'Finalize and deliver the clean output in the agreed format (CSV, JSON, or API payload). ' +
          'Includes a transformation summary log and any edge-case handling notes.',
      ],
    },
  ];

  return { price, timeline: '3–5 business days', milestones };
}

// ---------------------------------------------------------------------------
// Unified config export
// ---------------------------------------------------------------------------

export const flowConfig = {
  botProfile,
  flowPricing,
  scorerConfig,
  pricingCalc,
} satisfies {
  botProfile: BotConfig;
  flowPricing: FlowPricing;
  scorerConfig: ScorerConfig;
  pricingCalc: (gig: Gig) => { price: number; timeline: string; milestones: MilestoneDraft[] };
};

export default flowConfig;
