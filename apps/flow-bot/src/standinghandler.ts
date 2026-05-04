import type { Gig } from '@botguild/agent-core';
import type { TransformJobConfig } from './parser.ts';
import { standingOffers } from './config.ts';

export type FlowStandingType = 'data-sync' | 'invoice-batch';

export interface FlowStandingMatch {
  offerTitle: string;
  standingType: FlowStandingType;
  milestoneCount: number;
}

export interface FlowStandingResult {
  isStandingOffer: boolean;
  config?: TransformJobConfig;
  milestoneLabels?: string[];
  milestoneDates?: string[];
}

const OFFER_RULES: Record<string, { standingType: FlowStandingType; milestoneCount: number }> = {
  'data sync package': { standingType: 'data-sync', milestoneCount: 4 },
  'invoice processing batch': { standingType: 'invoice-batch', milestoneCount: 1 },
};

export function detectFlowStandingOffer(gig: Gig): FlowStandingMatch | null {
  const standingOfferId = (gig as any).standingOfferId as string | undefined;

  if (standingOfferId) {
    for (const offer of standingOffers) {
      const titleKey = offer.title.toLowerCase();
      const rule = OFFER_RULES[titleKey];
      if (rule) {
        return { offerTitle: offer.title, ...rule };
      }
    }
  }

  const gigTitleLower = gig.title.toLowerCase();
  for (const offer of standingOffers) {
    const titleKey = offer.title.toLowerCase();
    const rule = OFFER_RULES[titleKey];
    if (rule && gigTitleLower.startsWith(titleKey)) {
      return { offerTitle: offer.title, ...rule };
    }
  }

  return null;
}

function detectInputTypeFromDescription(description: string): 'csv' | 'json' | 'api' | 'sheet' {
  const text = description.toLowerCase();
  if (text.includes('sheet') || text.includes('google sheet') || text.includes('airtable')) return 'sheet';
  if (text.includes('csv') || text.includes('spreadsheet') || text.includes('excel')) return 'csv';
  if (text.includes('json')) return 'json';
  if (text.includes('api') || text.includes('endpoint') || text.includes('rest')) return 'api';
  return 'api';
}

function detectOutputFormatFromDescription(description: string): 'csv' | 'json' {
  const text = description.toLowerCase();
  if (text.includes('json')) return 'json';
  return 'csv';
}

function extractFirstUrl(description: string): string | null {
  const match = description.match(/https?:\/\/[^\s,]+/);
  return match ? match[0] : null;
}

export function buildFlowStandingConfig(
  gig: Gig,
  contractId: string,
  match: FlowStandingMatch,
  milestoneIds: string[],
): TransformJobConfig {
  if (match.standingType === 'data-sync') {
    const rawInputType = detectInputTypeFromDescription(gig.description);
    const inputType = rawInputType === 'json' ? 'api' : rawInputType;
    const inputSource = extractFirstUrl(gig.description) ?? 'https://example.com/data';
    const outputFormat = detectOutputFormatFromDescription(gig.description);

    return {
      gigId: gig.id,
      contractId,
      inputType,
      inputSource,
      targetSchema: [],
      transformRules: { dedupKey: 'id' },
      outputFormat,
      milestoneIds,
      confidence: 1.0,
    };
  }

  const inputSource = extractFirstUrl(gig.description) ?? 'pending';

  return {
    gigId: gig.id,
    contractId,
    inputType: 'pdf',
    inputSource,
    targetSchema: [
      { name: 'vendor', type: 'string' },
      { name: 'amount', type: 'number' },
      { name: 'date', type: 'date' },
      { name: 'invoice_number', type: 'string' },
    ],
    transformRules: { dedupKey: 'invoice_number' },
    outputFormat: 'csv',
    milestoneIds: milestoneIds.slice(0, 1),
    confidence: 1.0,
  };
}

function buildMilestoneDates(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.now() + (i + 1) * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  );
}

function buildMilestoneLabels(standingType: FlowStandingType): string[] {
  if (standingType === 'data-sync') {
    return [
      'Week 1 — Sync Run',
      'Week 2 — Sync Run',
      'Week 3 — Sync Run',
      'Week 4 — Sync Run',
    ];
  }
  return ['Invoice Processing Complete'];
}

export function handleFlowStandingGig(
  gig: Gig,
  contractId: string,
  milestoneIds: string[],
): FlowStandingResult {
  const match = detectFlowStandingOffer(gig);

  if (!match) {
    return { isStandingOffer: false };
  }

  const config = buildFlowStandingConfig(gig, contractId, match, milestoneIds);
  const milestoneLabels = buildMilestoneLabels(match.standingType);
  const milestoneDates = buildMilestoneDates(match.milestoneCount);

  return { isStandingOffer: true, config, milestoneLabels, milestoneDates };
}
