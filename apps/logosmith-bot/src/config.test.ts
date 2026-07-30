import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import {
  CONCEPT_COUNT,
  FAVICON_SIZES,
  ICO_SIZES,
  MAX_REGENS_PER_SLOT,
  MAX_SPEND_USD,
  MIN_PHASH_HAMMING,
  OCR_SIMILARITY_THRESHOLD,
  SEED_PRICE_USD,
  botProfile,
  pricingCalc,
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
    const quote = pricingCalc({ id: 'g1', description: '', budget: 25 } as never);
    assert.equal(quote.price, SEED_PRICE_USD);
    assert.equal(quote.milestones.length, 2);
    // Milestones are checkpoints, not payment slices — no per-milestone amount.
    assert.ok(!('amount' in quote.milestones[0]!));
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
    assert.equal(MAX_SPEND_USD, 2.5);
    assert.equal(OCR_SIMILARITY_THRESHOLD, 0.85);
    assert.equal(MIN_PHASH_HAMMING, 10);
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
