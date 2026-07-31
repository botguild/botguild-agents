import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { DEFAULT_AXES } from './axes.js';
import {
  CONCEPT_COUNT,
  FAVICON_SIZES,
  ICO_SIZES,
  IMAGE_COST_USD,
  MAX_REGENS_PER_SLOT,
  MAX_SPEND_USD,
  MIN_PHASH_HAMMING,
  OCR_SIMILARITY_THRESHOLD,
  SEED_PRICE_USD,
  botProfile,
  fallbackEstimate,
  pricingCalc,
  rateCard,
  scorerConfig,
} from './config.js';
import { applyMigrations } from './testSupport.js';

describe('config', () => {
  it('advertises the identity the PRD contracts for', () => {
    assert.equal(botProfile.handlerId, 'bot-logosmith');
    assert.equal(botProfile.valueChainPosition, 'originator');
    // §9: the warranty covers verifiable properties only.
    assert.match(botProfile.warrantyTerms ?? '', /Trademark clearance is NOT performed/);
  });

  it('scores logo-adjacent gigs outside an exact category match', () => {
    // Non-null assertions: ScorerConfig.keywords is optional in
    // @botguild/agent-core (keywords?: string[]), but config.ts always
    // populates it — see task-1-report.md "Concerns" for the typecheck note.
    assert.ok(scorerConfig.keywords!.includes('favicon'));
    assert.ok(scorerConfig.keywords!.includes('wordmark'));
    assert.equal(scorerConfig.proposalThreshold, 40);
  });

  it('prices the seed gig as one price with two checkpoints', () => {
    // Pinned directly (not just symbolically via quote.price below) so a
    // revert-to-$25 regression fails here rather than passing silently.
    assert.equal(SEED_PRICE_USD, 1);
    const quote = pricingCalc({ id: 'g1', description: '', budget: 1 } as never);
    assert.equal(quote.price, SEED_PRICE_USD);
    assert.equal(quote.milestones.length, 2);
    // Milestones are checkpoints, not payment slices — no per-milestone amount.
    assert.ok(!('amount' in quote.milestones[0]!));
  });

  it('recalibrates the budget-score window to the live market', () => {
    // Live sample: 78 open BotGuild gigs, budgets $0.08-$0.99 (median $0.44).
    // The PRD-era window (budgetMin 5, budgetMax 150) scored the Budget
    // factor 0 for every one of those — see config.ts for the full rationale.
    assert.equal(scorerConfig.budgetMin, 0.25);
    assert.equal(scorerConfig.budgetMax, 5);
  });

  it('anchors the free gigs at $0 with a single milestone', () => {
    const favicon = pricingCalc({
      id: 'g2',
      description: '```json\n{ "logoUrl": "https://example.com/logo.png" }\n```',
      budget: 0,
    } as never);
    assert.equal(favicon.price, 0);
    assert.equal(favicon.milestones.length, 1);

    const taster = pricingCalc({
      id: 'g3',
      description: '```json\n{ "brandName": "Acme", "industry": "tools" }\n```',
      budget: 0,
    } as never);
    assert.equal(taster.price, 0);
  });

  it('pins the FR-5/FR-6 caps and thresholds', () => {
    assert.equal(CONCEPT_COUNT, 3);
    assert.equal(MAX_REGENS_PER_SLOT, 2);
    assert.equal(MAX_SPEND_USD, 0.6);
    assert.equal(OCR_SIMILARITY_THRESHOLD, 0.85);
    assert.equal(MIN_PHASH_HAMMING, 10);
  });

  it('produces a bid floor at or below the live market, not the PRD anchor', () => {
    // cost = 8(perClaudeCall) + 15(perKToken) + 6(perComputeMinute)
    //      + 1(perRun) + fixedOverhead, then target = 1.5 x cost.
    const c = fallbackEstimate;
    const cost =
      c.claudeCalls * rateCard.perClaudeCall +
      c.claudeKTokens * rateCard.perKToken +
      c.browserMinutes * rateCard.perBrowserMinute +
      c.computeMinutes * rateCard.perComputeMinute +
      c.runs * rateCard.perRun +
      rateCard.fixedOverhead;
    const floor = 1.5 * cost;
    // Live gigs measured $0.08-$0.99 (median $0.44). A floor above ~$1 means
    // LogoSmith cannot win anything, whatever SEED_PRICE_USD says.
    assert.ok(floor < 1, `bid floor ${floor.toFixed(2)} exceeds the live market`);
    assert.ok(floor > 0.3, `bid floor ${floor.toFixed(2)} is below cost-to-serve`);
  });

  it('never lets a capped job cost more than it earns', () => {
    assert.ok(MAX_SPEND_USD < SEED_PRICE_USD, 'spend cap exceeds revenue');
  });

  it('keeps MAX_SPEND_USD at or above the worst-case FR-5 regeneration burn', () => {
    // Computed from the SAME constants and routing the pipeline actually uses
    // (CONCEPT_COUNT, MAX_REGENS_PER_SLOT, the real axis->vendor routing in
    // axes.ts, and IMAGE_COST_USD) rather than restated by hand, so a future
    // change to any of them is caught HERE, with a clear failing test name —
    // not discovered weeks later as "some jobs mysteriously deliver
    // `partial`" once the cap starts truncating regenerations that used to
    // complete.
    const attemptsPerSlot = MAX_REGENS_PER_SLOT + 1; // 1 initial + regens
    const axes = DEFAULT_AXES.slice(0, CONCEPT_COUNT);
    assert.equal(axes.length, CONCEPT_COUNT, 'fewer declared axes than concept slots');
    const worstCase = axes.reduce(
      (sum, axis) => sum + attemptsPerSlot * IMAGE_COST_USD[axis.vendor],
      0,
    );
    assert.ok(
      MAX_SPEND_USD >= worstCase,
      `cap $${MAX_SPEND_USD.toFixed(2)} is below the worst-case burn $${worstCase.toFixed(2)} ` +
        '— some jobs would be spend-capped short of their full FR-5 regeneration allowance',
    );
    // Today the margin is EXACTLY zero (a $0.6 cap against a $0.60 worst
    // case): every regeneration is affordable in the worst case, but there is
    // no headroom for a vendor price rise, an added concept slot, or a
    // costlier axis-vendor reassignment. If this ever fails because the
    // margin moved off zero, that is the prompt to make a DELIBERATE call on
    // whether MAX_SPEND_USD should carry headroom — see its comment in
    // config.ts — not a signal to loosen this assertion.
    const margin = MAX_SPEND_USD - worstCase;
    assert.ok(
      Math.abs(margin) < 1e-9,
      `margin is $${margin.toFixed(2)}, not zero — the note above needs updating either way`,
    );
  });

  it('declares the §8 pack size contract', () => {
    assert.deepEqual([...FAVICON_SIZES], [16, 32, 48, 180, 192, 512]);
    assert.deepEqual([...ICO_SIZES], [16, 32, 48]);
  });
});

describe('migrations', () => {
  it('creates every table the app and shim need', async () => {
    const db = createMemoryD1();
    await applyMigrations(db);
    for (const table of [
      'jobs',
      'concepts',
      'selection',
      'free_gig_usage',
      'license_manifest',
      'dispute_responses',
      'gate_audit',
      'reputation_snapshot',
      'webhook_secret',
      'negotiation_countered',
    ]) {
      const row = await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .bind(table)
        .first<{ name: string }>();
      assert.equal(row?.name, table, `missing table: ${table}`);
    }
  });

  it('enforces the stage CHECK constraint on jobs', async () => {
    const db = createMemoryD1();
    await applyMigrations(db);
    await assert.rejects(() =>
      db
        .prepare(
          'INSERT INTO jobs (job_key, contract_id, stage, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind('k', 'c', 'not-a-stage', 'claimed', 'now', 'now')
        .run(),
    );
  });
});
