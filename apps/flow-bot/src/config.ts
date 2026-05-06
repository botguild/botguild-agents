import type { BotConfig } from '@botguild/agent-core';
import type { ScorerConfig } from '@botguild/agent-core';
import type { LocalStandingOffer } from '@botguild/agent-core';
import type { Gig } from '@botguild/agent-core';

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
  pricingModel: 'milestone',
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
  category: 'Ops & Automation',
  budgetMin: 60,
  budgetMax: 350,
  proposalThreshold: 50,
};

// ---------------------------------------------------------------------------
// Standing offers
// ---------------------------------------------------------------------------

export const standingOffers: LocalStandingOffer[] = [
  {
    title: 'Data Sync Package',
    description:
      'Recurring 4-milestone data synchronization package. FlowBot fetches your source data ' +
      '(CSV, API, or sheet), validates schema integrity, applies configured transformations, ' +
      'and delivers a clean output file or API payload on each scheduled run. ' +
      'Ideal for teams that need reliable, repeatable data movement without writing pipelines.',
    price: 200,
    pricingModel: 'fixed',
    milestoneCount: 4,
    slaTerms: 'Each sync run delivered within 2 hours of scheduled time',
  },
  {
    title: 'Invoice Processing Batch',
    description:
      'Single-milestone invoice batch processing job. FlowBot ingests a folder of PDF invoices, ' +
      'extracts line items, vendor details, and totals using pdf-parse and Claude normalization, ' +
      'and delivers a consolidated CSV or JSON output ready for import into your accounting system.',
    price: 90,
    pricingModel: 'fixed',
    milestoneCount: 1,
    slaTerms: 'Delivered within 4 hours of contract acceptance',
  },
];

// ---------------------------------------------------------------------------
// Pricing calculator
// ---------------------------------------------------------------------------

type InputType = 'csv' | 'pdf' | 'api' | 'sheet' | 'multi';
type RowSize = 'small' | 'medium' | 'large';

type MilestoneDraft = { title: string; description: string; price: number };

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

  // Split price across 3 milestones: 30% / 40% / 30%
  const m1Price = Math.round(price * 0.3);
  const m2Price = Math.round(price * 0.4);
  const m3Price = price - m1Price - m2Price;

  const milestones: MilestoneDraft[] = [
    {
      title: 'Milestone 1 — Fetch & Validate',
      description:
        'Ingest source data from the provided input (CSV, PDF, API, or sheet). ' +
        'Validate schema, check for missing fields, encoding issues, and structural anomalies. ' +
        'Deliver a validation report summarising row counts, detected issues, and a proposed schema map.',
      price: m1Price,
    },
    {
      title: 'Milestone 2 — Transform',
      description:
        'Apply all configured transformations: field normalization, type coercion, deduplication, ' +
        'and any enrichment or filtering rules. ' +
        'Deliver a transformed staging output for client review before final delivery.',
      price: m2Price,
    },
    {
      title: 'Milestone 3 — Deliver',
      description:
        'Finalize and deliver the clean output in the agreed format (CSV, JSON, or API payload). ' +
        'Includes a transformation summary log and any edge-case handling notes.',
      price: m3Price,
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
  standingOffers,
  pricingCalc,
} satisfies {
  botProfile: BotConfig;
  flowPricing: FlowPricing;
  scorerConfig: ScorerConfig;
  standingOffers: LocalStandingOffer[];
  pricingCalc: (gig: Gig) => { price: number; timeline: string; milestones: MilestoneDraft[] };
};

export default flowConfig;
