import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildValidationReport } from './report.js';
import { evaluateDiversity } from './diversity.js';
import { validateCsvAgainstTemplate, buildCsv } from './csv.js';
import { MODERATION_MODEL } from './moderation.js';
import type { AdBrief, VariantState } from '../types.js';

const brief: AdBrief = {
  brandVoiceGuide: 'warm',
  offer: 'sale',
  campaign: { campaignName: 'C', objective: 'OUTCOME_TRAFFIC', adSetName: 'A' },
  creative: { landingUrl: 'https://example.com', pageId: '1', imageRef: 'img' },
  platform: 'facebook-instagram-feed',
  variantCount: 2,
  angleCount: 3,
  policyConstraints: [],
};

function passedState(id: string, angle: string, headline: string): VariantState {
  return {
    variant: { id, angle, headline, primaryText: `${headline} body`, description: 'desc' },
    status: 'passed',
    regenAttempts: 1,
    evidence: {
      length: [
        {
          field: 'headline',
          graphemes: headline.length,
          limit: 40,
          marginApplied: false,
          pass: true,
        },
      ],
      checklist: { version: 'v1', pass: true, failures: [] },
      moderation: {
        vendor: 'openai',
        model: MODERATION_MODEL,
        flagged: false,
        response: { results: [{ flagged: false }] },
        checkedAt: '2026-07-06T00:00:00.000Z',
      },
      readability: { lib: 'text-readability', version: '1.1.1', fleschKincaidGrade: 4.2 },
    },
  };
}

test('report carries per-variant evidence and batch-level caps + template stamp', () => {
  const states = [
    passedState('v1', 'urgency', 'act before midnight tonight'),
    passedState('v2', 'value', 'more quality for less money'),
    {
      ...passedState('v3', 'social-proof', 'thousands already switched over'),
      status: 'failed' as const,
      failReason: 'length: over grapheme limit after regeneration caps',
    },
  ];
  const delivered = [states[0]?.variant, states[1]?.variant].filter((v) => v !== undefined);
  const diversity = evaluateDiversity(delivered, { threshold: 0.5, requiredAngles: 2 });
  const csv = validateCsvAgainstTemplate(buildCsv(delivered, brief));

  const report = buildValidationReport({
    jobKey: 'a'.repeat(64),
    contractId: 'contract-1',
    outcome: 'partial',
    variantCountRequested: 3,
    variantStates: states,
    deliveredIds: ['v1', 'v2'],
    diversity,
    priorCycle: null,
    csv,
    spendUsd: 0.123456789,
    spendCapUsd: 1.5,
    batchRounds: 1,
    batchRoundCap: 2,
    regenCapPerVariant: 3,
    now: () => new Date('2026-07-06T12:00:00Z'),
  });

  assert.equal(report.reportVersion, 1);
  assert.equal(report.generatedAt, '2026-07-06T12:00:00.000Z');
  assert.equal(report.idempotencyKey, 'a'.repeat(64));
  assert.equal(report.outcome, 'partial');
  assert.equal(report.variants.length, 3);

  const v1 = report.variants[0];
  assert.equal(v1?.status, 'delivered');
  assert.equal(v1?.regenerationAttempts, 1);
  assert.equal(v1?.graphemeCounts[0]?.field, 'headline');
  assert.equal((v1?.moderation as { model: string }).model, MODERATION_MODEL);
  assert.equal(v1?.readability?.advisory, true);
  assert.equal(v1?.readability?.lib, 'text-readability');
  assert.ok(v1 && v1.diversityPairScores.length > 0);

  const v3 = report.variants[2];
  assert.equal(v3?.status, 'failed');
  assert.equal(v3?.failReason, 'length: over grapheme limit after regeneration caps');

  assert.equal(report.batch.variantCountRequested, 3);
  assert.equal(report.batch.variantCountDelivered, 2);
  assert.equal(report.batch.diversity.thresholdStatus, 'provisional-pending-phase-2-calibration');
  assert.equal(report.batch.csv?.templateVersion, 'meta-bulk-import-v1');
  assert.equal(report.batch.csv?.goldenFileTestDate, 'PENDING-PHASE-1-GOLDEN-FILE-TEST');
  assert.equal(report.batch.capsConsumed.spendUsd, 0.123457); // rounded, real usage
  assert.equal(report.batch.capsConsumed.spendCapUsd, 1.5);
  assert.deepEqual(report.batch.shortfall, [
    { variantId: 'v3', reason: 'length: over grapheme limit after regeneration caps' },
  ]);

  // The whole artifact must be JSON-serializable as delivered.
  assert.equal(JSON.parse(JSON.stringify(report)).outcome, 'partial');
});
