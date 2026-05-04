import type { Gig } from '@botguild/agent-core';
import type { CheckPlan, CheckType, Criterion, EvidenceRequirement } from './parser.ts';
import { standingOffers } from './config.ts';

export type VerifierStandingType = 'smoke-test' | 'acceptance-review';

export interface VerifierStandingMatch {
  offerTitle: string;
  standingType: VerifierStandingType;
  checkSchedule: string | null;
  milestoneSchedule: string | null;
  milestoneCount: number;
}

export interface VerifierStandingResult {
  isStandingOffer: boolean;
  plan?: CheckPlan;
  milestoneLabels?: string[];
  milestoneDates?: string[];
  standingType?: VerifierStandingType;
}

export const VERIFIER_OFFER_RULES: Record<
  string,
  {
    standingType: VerifierStandingType;
    checkSchedule: string | null;
    milestoneSchedule: string | null;
    milestoneCount: number;
  }
> = {
  'nightly smoke test package': {
    standingType: 'smoke-test' as const,
    checkSchedule: '0 2 * * *',
    milestoneSchedule: '0 9 * * 1',
    milestoneCount: 4,
  },
  'acceptance review': {
    standingType: 'acceptance-review' as const,
    checkSchedule: null,
    milestoneSchedule: null,
    milestoneCount: 1,
  },
};

export function detectVerifierStandingOffer(gig: Gig): VerifierStandingMatch | null {
  const standingOfferId = (gig as unknown as Record<string, unknown>).standingOfferId as string | undefined;

  if (standingOfferId) {
    for (const offer of standingOffers) {
      const titleKey = offer.title.toLowerCase();
      const rule = VERIFIER_OFFER_RULES[titleKey];
      if (rule) {
        return { offerTitle: offer.title, ...rule };
      }
    }
  }

  const gigTitleLower = gig.title.toLowerCase();
  for (const offer of standingOffers) {
    const titleKey = offer.title.toLowerCase();
    const rule = VERIFIER_OFFER_RULES[titleKey];
    if (rule && gigTitleLower.startsWith(titleKey)) {
      return { offerTitle: offer.title, ...rule };
    }
  }

  return null;
}

function extractUrls(description: string): string[] {
  const matches = description.match(/https?:\/\/[^\s,]+/g);
  return matches && matches.length > 0 ? matches : [];
}

function buildSmokeCheckPlan(
  gig: Gig,
  contractId: string,
  milestoneIds: string[],
): CheckPlan {
  const urls = extractUrls(gig.description);
  const targets = urls.length > 0 ? urls : ['https://example.com'];

  const criteriaList: Criterion[] = [
    {
      id: 'homepage-loads',
      description: 'Homepage loads successfully',
      expected: 'HTTP 200',
      checkMethod: 'http',
    },
    {
      id: 'response-time',
      description: 'Response time under 3 seconds',
      expected: 'latency ≤ 3000ms',
      checkMethod: 'http',
    },
    {
      id: 'no-error-page',
      description: 'No error page displayed',
      expected: 'No 4xx/5xx status',
      checkMethod: 'http',
    },
  ];

  const evidenceRequired: EvidenceRequirement = {
    screenshot: false,
    responseLog: true,
    sampleRows: false,
  };

  return {
    gigId: gig.id,
    contractId,
    checkType: 'smoke' as CheckType,
    targets,
    criteriaList,
    evidenceRequired,
    milestoneIds,
    confidence: 1.0,
  };
}

function extractCriteriaFromDescription(description: string): Criterion[] {
  const lines = description.split('\n');
  const criterionLines = lines.filter((line) => /^\s*([-*]|\d+\.)\s+/.test(line));

  if (criterionLines.length === 0) {
    return [
      {
        id: 'general-quality',
        description: 'Deliverable meets stated requirements',
        expected: 'Pass',
        checkMethod: 'claude',
      },
    ];
  }

  return criterionLines.map((line, i) => {
    const text = line.replace(/^\s*([-*]|\d+\.)\s+/, '').trim();
    const id = `criterion-${i + 1}`;
    return {
      id,
      description: text,
      expected: 'Pass',
      checkMethod: 'claude' as const,
    };
  });
}

function buildAcceptanceReviewCheckPlan(
  gig: Gig,
  contractId: string,
  milestoneIds: string[],
): CheckPlan {
  const urls = extractUrls(gig.description);

  const criteriaList = extractCriteriaFromDescription(gig.description);

  const evidenceRequired: EvidenceRequirement = {
    screenshot: false,
    responseLog: false,
    sampleRows: false,
  };

  return {
    gigId: gig.id,
    contractId,
    checkType: 'acceptance-audit' as CheckType,
    targets: urls,
    criteriaList,
    evidenceRequired,
    milestoneIds: milestoneIds.slice(0, 1),
    confidence: 1.0,
  };
}

function buildMilestoneDates(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.now() + (i + 1) * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  );
}

function buildMilestoneLabels(standingType: VerifierStandingType): string[] {
  if (standingType === 'smoke-test') {
    return [
      'Week 1 — Nightly Smoke Report',
      'Week 2 — Nightly Smoke Report',
      'Week 3 — Nightly Smoke Report',
      'Week 4 — Nightly Smoke Report',
    ];
  }
  return ['Acceptance Review Complete'];
}

export function handleVerifierStandingGig(
  gig: Gig,
  contractId: string,
  milestoneIds: string[],
): VerifierStandingResult {
  const match = detectVerifierStandingOffer(gig);

  if (!match) {
    return { isStandingOffer: false };
  }

  const plan =
    match.standingType === 'smoke-test'
      ? buildSmokeCheckPlan(gig, contractId, milestoneIds)
      : buildAcceptanceReviewCheckPlan(gig, contractId, milestoneIds);

  const milestoneLabels = buildMilestoneLabels(match.standingType);
  const milestoneDates = buildMilestoneDates(match.milestoneCount);

  return {
    isStandingOffer: true,
    plan,
    milestoneLabels,
    milestoneDates,
    standingType: match.standingType,
  };
}
