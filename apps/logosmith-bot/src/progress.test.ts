import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConceptRow, JobRow } from './jobs.js';
import { renderProgressEvent, renderProgressPage } from './progress.js';

const job = {
  jobKey: 'k:concepts',
  contractId: 'c1',
  stage: 'concepts',
  deliverableToken: 'a'.repeat(64),
  status: 'in_progress',
  outcome: null,
  kind: 'logo',
  gigId: 'g1',
  payerId: 'p1',
  briefJson: '{"brandName":"Harbor & Vine"}',
  parkReason: null,
  moderationAttempts: 0,
  checkpoint: null,
  spentUsd: 0.12,
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:01:00.000Z',
  deliveredAt: null,
} as JobRow;

const concepts: ConceptRow[] = [
  {
    contractId: 'c1',
    slot: 1,
    axisId: 'wordmark',
    vendor: 'ideogram',
    vendorRequestId: 'req-1',
    r2Key: `${'a'.repeat(64)}/concept-1.png`,
    nativeSvgKey: null,
    phash: '0f0f0f0f0f0f0f0f',
    ocrTranscription: 'Harbor & Vine',
    ocrScore: 0.97,
    ocrModel: 'scout',
    ocrPass: true,
    attemptsUsed: 0,
  },
  {
    contractId: 'c1',
    slot: 2,
    axisId: 'lockup',
    vendor: 'recraft',
    vendorRequestId: 'req-2',
    r2Key: null,
    nativeSvgKey: null,
    phash: null,
    ocrTranscription: 'Harbcr & Vlne',
    ocrScore: 0.71,
    ocrModel: 'scout',
    ocrPass: false,
    attemptsUsed: 1,
  },
];

describe('renderProgressPage', () => {
  it('shows each concept with its OCR verdict', () => {
    const html = renderProgressPage(job, concepts);
    assert.match(html, /Harbor &amp; Vine/);
    assert.match(html, /0\.97/);
    assert.match(html, /0\.71/);
    assert.match(html, /wordmark/);
  });

  it('links delivered concepts through the token route, never r2.dev', () => {
    const html = renderProgressPage(job, concepts);
    assert.match(html, new RegExp(`/deliverables/${'a'.repeat(64)}/concept-1\\.png`));
    assert.ok(!/r2\.dev/.test(html));
  });

  it('leaks no PII — no payer id, no contract id, no gig id', () => {
    const html = renderProgressPage(job, concepts);
    assert.ok(!html.includes('p1'), 'payer id leaked');
    assert.ok(!html.includes('c1'), 'contract id leaked');
    assert.ok(!html.includes('g1'), 'gig id leaked');
  });

  it('escapes concept text so a transcription cannot inject markup', () => {
    const hostile = [
      { ...concepts[0]!, r2Key: null, ocrTranscription: '<img src=x onerror=alert(1)>' },
    ];
    const html = renderProgressPage(job, hostile);
    assert.ok(!/<img/i.test(html));
    assert.match(html, /&lt;img/);
  });

  it('encodes apostrophes in concept text to prevent attribute breakout', () => {
    const apostrophed = [
      {
        ...concepts[0]!,
        r2Key: null,
        axisId: "designer's logo",
        ocrTranscription: "it's a brand",
      },
    ];
    const html = renderProgressPage(job, apostrophed);
    assert.match(html, /designer&#39;s logo/);
    assert.match(html, /it&#39;s a brand/);
  });

  it('renders a waiting state when no concept has landed yet', () => {
    const html = renderProgressPage(job, []);
    assert.match(html, /generating|waiting|in progress/i);
  });
});

describe('renderProgressEvent', () => {
  it('emits a well-formed SSE frame with a retry hint', () => {
    const frame = renderProgressEvent(job, concepts);
    assert.match(frame, /^retry: \d+$/m);
    assert.match(frame, /^data: /m);
    assert.ok(frame.endsWith('\n\n'));
  });

  it('carries the concept verdicts as JSON', () => {
    const frame = renderProgressEvent(job, concepts);
    const line = frame.split('\n').find((l) => l.startsWith('data: '))!;
    const payload = JSON.parse(line.slice(6)) as {
      concepts: Array<{ slot: number; score: number | null }>;
    };
    assert.equal(payload.concepts.length, 2);
    assert.equal(payload.concepts[0]!.slot, 1);
  });
});
