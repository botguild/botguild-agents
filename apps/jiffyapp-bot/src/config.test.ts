import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { applyMigrations } from './testSupport.js';
import {
  pricingCalc,
  TEMPLATE_PRICE_USD,
  HOSTING_PRICE_USD,
  scorerConfig,
  botProfile,
  MAX_REPAIR_ROUNDS,
  MAX_SPEND_USD,
  JOB_WALL_CLOCK_MINUTES,
} from './config.js';
import { TEMPLATE_IDS } from './types.js';
import type { Gig } from '@botguild/agent-core';

const gig = { id: 'g1', title: 't', description: 'd', budget: 20 } as unknown as Gig;

test('migrations apply cleanly to a fresh in-memory D1', async () => {
  const db = createMemoryD1();
  await applyMigrations(db);
  await db
    .prepare(
      "INSERT INTO jobs (job_key, contract_id, kind, deliverable_token, created_at, updated_at) VALUES ('k:build', 'c1', 'build', 'tok', 'now', 'now')",
    )
    .run();
  const row = await db
    .prepare('SELECT status FROM jobs WHERE job_key = ?')
    .bind('k:build')
    .first<{ status: string }>();
  assert.equal(row?.status, 'claimed');
});

test('every template has a price anchor', () => {
  for (const id of TEMPLATE_IDS) assert.ok(TEMPLATE_PRICE_USD[id] > 0, id);
});

test('pricingCalc: hosting cycles are $5 with a month-end milestone; builds use the anchor', () => {
  const cycle = pricingCalc(gig, () => ({ kind: 'cycle' }));
  assert.equal(cycle.price, HOSTING_PRICE_USD);
  assert.match(cycle.milestones[0].title, /service report/i);
  const build = pricingCalc(gig, () => ({ kind: 'build', template: 'calculator' }));
  assert.equal(build.price, 25);
  assert.equal(build.milestones.length, 1); // single-price escrow: one checkpoint milestone
});

test('caps and scorer invariants match the PRD', () => {
  assert.equal(MAX_REPAIR_ROUNDS, 3);
  assert.equal(MAX_SPEND_USD, 0.5);
  assert.equal(JOB_WALL_CLOCK_MINUTES, 25);
  assert.equal(scorerConfig.proposalThreshold, 40);
  assert.ok((scorerConfig.keywords ?? []).includes('landing page'));
  assert.equal(botProfile.handlerId, 'bot-jiffyapp');
});
