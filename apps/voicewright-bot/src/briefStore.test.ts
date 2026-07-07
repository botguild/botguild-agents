// Recurring-tier cycle numbering (FR-10 / Story C / §9 differs-from-prior gate).
//
// This encodes the contract the pipeline relies on: briefs.cycle is the
// LAST-DELIVERED cycle (adcopy = 1), and a refresh produces at stored.cycle + 1.
// The bug was that the refresh reused stored.cycle (1), which (a) made
// priorCycleVariants return nothing so the differs-from-prior gate passed
// vacuously, and (b) overwrote month-1's cycle_variants via the (brief_id,
// cycle, variant_id) primary key. These tests would fail under that behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { applyMigrations } from './testSupport.js';
import { createBriefStore } from './briefStore.js';
import { differsFromPriorCycle } from './gates/diversity.js';
import { DIVERSITY_THRESHOLD } from './config.js';
import type { AdBrief, Variant } from './types.js';

const brief: AdBrief = {
  brandVoiceGuide: 'bold, plain',
  offer: 'a widget',
  campaign: { campaignName: 'c', objective: 'OUTCOME_TRAFFIC', adSetName: 'a' },
  creative: { landingUrl: 'https://x.example', pageId: '1', imageRef: 'img' },
  platform: 'facebook-instagram-feed',
  variantCount: 2,
  angleCount: 2,
  policyConstraints: [],
};

const month1: Variant[] = [
  { id: 'v1', angle: 'value', headline: 'Save time every day', primaryText: 'Do more with less effort now', description: 'Learn more' },
  { id: 'v2', angle: 'trust', headline: 'Loved by thousands of teams', primaryText: 'Join the teams already winning', description: 'See why' },
];

test('a first refresh produces at stored.cycle+1: prior batch is visible and month-1 rows survive', async () => {
  const db = createMemoryD1();
  await applyMigrations(db);
  const briefs = createBriefStore(db, () => new Date('2026-07-07T00:00:00Z'));

  // adcopy delivery: create brief (cycle=1) + store month-1 under cycle 1.
  await briefs.create({ briefId: 'b1', originContractId: 'c1', brief, nextDueAt: new Date('2026-08-06T00:00:00Z') });
  await briefs.saveCycleVariants('b1', 1, month1);

  // First refresh: stored.cycle is 1, so the pipeline produces at cycle 2.
  const stored = await briefs.get('b1');
  assert.equal(stored?.cycle, 1, 'briefs.cycle is the last-delivered cycle');
  const producedCycle = (stored?.cycle ?? 0) + 1;

  // (a) priorCycleVariants(producedCycle) returns month-1 — the gate has
  //     something to compare against (it did NOT under the off-by-one bug).
  const prior = await briefs.priorCycleVariants('b1', producedCycle);
  assert.equal(prior.length, 2, 'the prior cycle must be visible to the differs gate');

  // (b) the differs-from-prior gate actually evaluates month-2 vs month-1: an
  //     identical month-2 batch is caught as a violation.
  const identical = differsFromPriorCycle(month1, prior, DIVERSITY_THRESHOLD);
  assert.equal(identical.pass, false, 'a re-served month-1 batch must fail the differs gate');
  assert.ok(identical.violations.length > 0);

  // Store a genuinely fresh month-2 batch and advance the cycle pointer.
  const month2: Variant[] = [
    { id: 'v1', angle: 'urgency', headline: 'Only a few spots left today', primaryText: 'Grab yours before they vanish', description: 'Act fast' },
    { id: 'v2', angle: 'proof', headline: 'Numbers that speak for themselves', primaryText: 'Results our customers can measure', description: 'View data' },
  ];
  await briefs.saveCycleVariants('b1', producedCycle, month2);
  await briefs.completeCycle('b1', producedCycle, new Date('2026-09-05T00:00:00Z'));

  // (c) month-1's rows still exist after the refresh (audit/dispute evidence).
  const { results } = await db
    .prepare('SELECT variant_id FROM cycle_variants WHERE brief_id = ? AND cycle = 1')
    .bind('b1')
    .all<{ variant_id: string }>();
  assert.deepEqual(results.map((r) => r.variant_id).sort(), ['v1', 'v2']);
  assert.equal((await briefs.get('b1'))?.cycle, 2, 'completeCycle records the produced cycle explicitly');

  // The next refresh (month-3) sees both prior cycles.
  const priorForMonth3 = await briefs.priorCycleVariants('b1', 3);
  assert.equal(priorForMonth3.length, 4);
});
