import type { Gig } from '@botguild/agent-core';
import type { WatchJobConfig } from './parser.ts';
import { standingOffers } from './config.ts';

export interface StandingOfferMatch {
  offerTitle: string;
  watchType: 'uptime' | 'change';
  schedule: string;
}

export interface StandingGigResult {
  isStandingOffer: boolean;
  config?: WatchJobConfig;
  milestoneDates?: string[];
  milestoneLabels?: string[];
}

const OFFER_RULES: Record<string, { watchType: 'uptime' | 'change'; schedule: string }> = {
  'site watch package': { watchType: 'change', schedule: '0 9 * * *' },
  'api health monitor package': { watchType: 'uptime', schedule: '*/15 * * * *' },
};

export function detectStandingOffer(gig: Gig): StandingOfferMatch | null {
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

export function buildStandingJobConfig(
  gig: Gig,
  contractId: string,
  match: StandingOfferMatch,
  milestoneIds: string[],
): WatchJobConfig {
  const urlMatches = gig.description.match(/https?:\/\/[^\s,]+/g);
  const targets = urlMatches && urlMatches.length > 0 ? urlMatches : ['https://example.com'];

  return {
    gigId: gig.id,
    contractId,
    targets,
    watchType: match.watchType,
    schedule: match.schedule,
    requiresJs: false,
    screenshot: false,
    reportFormat: 'summary',
    milestoneIds,
    confidence: 1.0,
  };
}

function buildMilestoneDates(): string[] {
  return [1, 2, 3, 4].map((n) =>
    new Date(Date.now() + n * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  );
}

function buildMilestoneLabels(watchType: 'uptime' | 'change'): string[] {
  const reportLabel = watchType === 'uptime' ? 'Uptime Report' : 'Change Report';
  return [1, 2, 3, 4].map((n) => `Week ${n} — ${reportLabel}`);
}

export function handleStandingOfferGig(
  gig: Gig,
  contractId: string,
  milestoneIds: string[],
): StandingGigResult {
  const match = detectStandingOffer(gig);

  if (!match) {
    return { isStandingOffer: false };
  }

  const config = buildStandingJobConfig(gig, contractId, match, milestoneIds);
  const milestoneDates = buildMilestoneDates();
  const milestoneLabels = buildMilestoneLabels(match.watchType);

  return { isStandingOffer: true, config, milestoneDates, milestoneLabels };
}
