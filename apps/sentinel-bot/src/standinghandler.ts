import type { Gig } from '@botguild/agent-core';
import type { WatchJobConfig } from './parser.js';
import { standingOffers } from './config.js';

export interface StandingOfferMatch {
  offerTitle: string;
  watchType: 'uptime' | 'change';
  checkSchedule: string;
  milestoneSchedule: string;
  screenshot: boolean;
}

export interface StandingGigResult {
  isStandingOffer: boolean;
  config?: WatchJobConfig;
  milestoneDates?: string[];
  milestoneLabels?: string[];
  // Set when we matched a standing offer but couldn't infer a target URL —
  // caller should request clarification rather than start a watch.
  needsClarification?: boolean;
  clarificationQuestion?: string;
}

export const OFFER_RULES: Record<
  string,
  {
    watchType: 'uptime' | 'change';
    checkSchedule: string;
    milestoneSchedule: string;
    screenshot: boolean;
  }
> = {
  'site watch package': {
    watchType: 'change',
    checkSchedule: '0 9 * * *',
    milestoneSchedule: '0 9 * * 1',
    screenshot: true,
  },
  'api health monitor package': {
    watchType: 'uptime',
    checkSchedule: '*/15 * * * *',
    milestoneSchedule: '0 9 * * 1',
    screenshot: false,
  },
};

export function detectStandingOffer(gig: Gig): StandingOfferMatch | null {
  // Disambiguate by gig title — `standingOfferId` only confirms it's a
  // standing-offer hire, not which offer was hired. The platform copies the
  // offer's title onto the gig.
  const gigTitleLower = gig.title.toLowerCase();
  for (const offer of standingOffers) {
    const titleKey = offer.title.toLowerCase();
    const rule = OFFER_RULES[titleKey];
    if (rule && (gigTitleLower.startsWith(titleKey) || gigTitleLower.includes(titleKey))) {
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
): WatchJobConfig | null {
  const urlMatches = gig.description.match(/https?:\/\/[^\s,]+/g);
  if (!urlMatches || urlMatches.length === 0) {
    return null;
  }
  const targets = urlMatches;

  return {
    gigId: gig.id,
    contractId,
    targets,
    watchType: match.watchType,
    schedule: match.checkSchedule,
    requiresJs: false,
    screenshot: match.screenshot,
    reportFormat: 'summary',
    milestoneIds,
    confidence: 1.0,
    checkSchedule: match.checkSchedule,
    milestoneSchedule: match.milestoneSchedule,
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

  if (!config) {
    return {
      isStandingOffer: true,
      milestoneDates,
      milestoneLabels,
      needsClarification: true,
      clarificationQuestion:
        match.watchType === 'uptime'
          ? 'Which API endpoint(s) should I monitor for uptime? Please paste the full URL(s).'
          : 'Which page(s) should I watch for changes? Please paste the full URL(s).',
    };
  }

  return { isStandingOffer: true, config, milestoneDates, milestoneLabels };
}
