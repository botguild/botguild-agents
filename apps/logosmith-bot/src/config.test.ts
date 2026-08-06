import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { DEFAULT_AXES } from './axes.js';
import { parseRevisionRequest } from './threads.js';
import {
  CONCEPT_COUNT,
  FAVICON_SIZES,
  ICO_SIZES,
  IMAGE_COST_USD,
  MAX_CONTRACT_LIFETIME_SPEND_USD,
  MAX_REGENS_PER_SLOT,
  MAX_REVISIONS_PER_CONTRACT,
  MAX_SPEND_USD,
  MIN_PHASH_HAMMING,
  OCR_SIMILARITY_THRESHOLD,
  RECRAFT_CREDITS_PER_USD,
  REVISION_POLL_MAX_DAYS,
  PLATFORM_MAX_BID_USD,
  SEED_PRICE_USD,
  VECTORIZER_CREDITS_PER_USD,
  botProfile,
  fallbackEstimate,
  pricingCalc,
  rateCard,
  recraftCreditsToUsd,
  scorerConfig,
  vectorizerCreditsToUsd,
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
    // The paid baseline is the seed anchor bounded by the preview bid cap.
    assert.equal(quote.price, Math.min(SEED_PRICE_USD, PLATFORM_MAX_BID_USD));
    assert.equal(quote.milestones.length, 2);
    // Milestones are checkpoints, not payment slices — no per-milestone amount.
    assert.ok(!('amount' in quote.milestones[0]!));
  });

  it('caps every paid bid at the platform preview maximum', () => {
    // The marketplace preview only accepts bids in a $0.10–$0.20 band — a $1
    // bid is 403-rejected (observed live, gig 01KZ9YRD0Q48C2SRW3T6HCTVHK).
    assert.equal(PLATFORM_MAX_BID_USD, 0.2);
    const quote = pricingCalc({ id: 'g1', description: '', budget: 0.1 } as never);
    assert.ok(
      quote.price <= PLATFORM_MAX_BID_USD,
      `paid baseline ${quote.price} exceeds the platform cap`,
    );
  });

  it('the free shapes still price at exactly zero under the cap', () => {
    const taster = pricingCalc({ id: 'g2', description: 'logo please', budget: 0 } as never);
    assert.equal(taster.price, 0);
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

  it('keeps MAX_CONTRACT_LIFETIME_SPEND_USD at or above the worst legitimate contract', () => {
    // Computed from the SAME constants the pipeline spends against, not
    // restated by hand: stage 1's full FR-5 burn, plus stage 2's one
    // conversion, plus the one FR-18 rebuild's one conversion. A vendor
    // reprice or an added round fails HERE with a named test rather than
    // silently refusing a rebuild the warranty terms promise.
    //
    // The FR-18 rebuild adds exactly one conversion and no generation: it
    // re-packs a concept stage 1 already paid for. If that ever stops being
    // true, this arithmetic is the first thing that has to change.
    const worstCase = MAX_SPEND_USD + IMAGE_COST_USD.vectorizer + IMAGE_COST_USD.vectorizer;
    assert.ok(
      MAX_CONTRACT_LIFETIME_SPEND_USD >= worstCase,
      `lifetime cap $${MAX_CONTRACT_LIFETIME_SPEND_USD.toFixed(2)} is below the worst legitimate ` +
        `contract $${worstCase.toFixed(2)} — a buyer would be refused the rebuild they were promised`,
    );
    // It must also stay ABOVE the per-job cap, or the per-contract bound would
    // bite before the per-job one and make MAX_SPEND_USD unreachable.
    assert.ok(MAX_CONTRACT_LIFETIME_SPEND_USD > MAX_SPEND_USD);
  });

  it('grants exactly one warranty rebuild', () => {
    assert.equal(MAX_REVISIONS_PER_CONTRACT, 1);
    // The poll's SQL pre-filter must be looser than any plausible warranty
    // window, because the AUTHORITY is contract.warrantyExpires, not this.
    assert.ok(REVISION_POLL_MAX_DAYS >= 14);
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
    //
    // THIS IS A PLANNING INVARIANT, AND IT STAYS PROVABLE NOW THAT THE LEDGER
    // BILLS RECRAFT FROM THE VENDOR'S REPORTED `credits` RATHER THAN FROM
    // IMAGE_COST_USD. A cap has to be sized from figures known BEFORE any call
    // is made, which is exactly what IMAGE_COST_USD still is; what the live
    // reading changes is whether the ledger notices when reality diverges from
    // the plan. It can only tighten the cap, never loosen it — an undercharge
    // is credited as less, and an overcharge, previously invisible, now makes
    // `decideSlotAction` stop sooner instead of letting the job quietly overrun
    // by the unseen difference. (`MAX_SPEND_USD` was never a hard ceiling
    // anyway: it is checked BEFORE each generation, so the call that crosses it
    // completes — see its docstring in config.ts.)
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

  // The credits->USD ratio is DERIVED, not independently measured: Recraft
  // publishes the credit COUNT it charged (measured `credits: 80` on both live
  // probe calls, 2026-08-04) but not the credit PRICE, so the dollar half
  // comes from reconciling that 80 against the documented per-image price
  // already in IMAGE_COST_USD. This test IS that reconciliation — moving
  // either constant without the other fails here rather than silently
  // re-pricing every Recraft generation in the ledger.
  it('reconciles the measured Recraft credit charge with the planning constant', () => {
    assert.equal(RECRAFT_CREDITS_PER_USD, 1000);
    assert.equal(recraftCreditsToUsd(80), IMAGE_COST_USD.recraft);
  });

  it('refuses a Recraft credit count it cannot trust, rather than billing zero', () => {
    // Fails SAFE upward: the call site substitutes IMAGE_COST_USD.recraft for
    // every `undefined` here. Billing $0.00 for a call the vendor charged for
    // is what leaves the park -> unpark -> regenerate loop unbounded.
    for (const bad of [undefined, null, 0, -1, NaN, Infinity, '80', {}, []]) {
      assert.equal(recraftCreditsToUsd(bad), undefined, `credits=${JSON.stringify(bad)}`);
    }
    assert.equal(recraftCreditsToUsd(160), 0.16);
  });

  // Same derivation, same caveat, one vendor over: the three live probe calls
  // (2026-08-04, all free test-mode) reported `x-credits-calculated: 1.000000`
  // for one SVG conversion, so the QUANTITY is measured and the PRICE is not —
  // 1 credit ≈ $0.20 holds at the entry tier only. This test IS the
  // reconciliation against the per-conversion figure already in
  // IMAGE_COST_USD, so neither constant can move without the other.
  it('reconciles the measured Vectorizer.ai credit charge with the planning constant', () => {
    assert.equal(VECTORIZER_CREDITS_PER_USD, 5);
    assert.equal(vectorizerCreditsToUsd('1.000000'), IMAGE_COST_USD.vectorizer);
  });

  it('refuses a Vectorizer.ai charge header it cannot trust, rather than billing zero', () => {
    // Fails SAFE upward, exactly as Recraft's does: every `undefined` here
    // makes `vectorize.ts` substitute IMAGE_COST_USD.vectorizer. `'0.000000'`
    // is in this list ON PURPOSE and is not an oversight — it is the value a
    // FREE `mode=test` call really reports, and billing $0.00 for a call this
    // Worker only ever makes in paid mode is the direction that leaves the
    // park -> unpark loop unbounded.
    for (const bad of [
      null,
      undefined,
      '',
      '   ',
      '0',
      '0.000000',
      '-1',
      'NaN',
      'Infinity',
      '0x10', // Number('0x10') is 16 — a lenient parse would bill $3.20
      '1e0',
      '1.0abc',
      1, // the Recraft shape: a number, which a header can never be
      {},
      [],
    ]) {
      assert.equal(vectorizerCreditsToUsd(bad), undefined, `charged=${JSON.stringify(bad)}`);
    }
    assert.equal(vectorizerCreditsToUsd('2.000000'), 0.4);
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
      'registered_bot',
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

// ---------------------------------------------------------------------------
// THE WARRANTY MUST DESCRIBE WHAT THE BOT DOES.
//
// `warrantyTerms` is registered with the marketplace, and the delivery notes
// repeat it, so it is a commitment rather than copy. This guard has now caught
// the text being wrong in BOTH directions, which is why it is INVERTED here
// rather than deleted: it once promised a re-run and a revision round that
// nothing implemented, and it then denied a revision after Task 29 built one.
// A guard that only ever checks for over-promising cannot catch the second.
// ---------------------------------------------------------------------------
describe('botProfile.warrantyTerms promises only what is implemented', () => {
  const terms = botProfile.warrantyTerms ?? '';

  it('offers the one rebuild that IS implemented, in the words the parser reads', () => {
    // Not a string comparison: the instructed phrase has to be one
    // `parseRevisionRequest` actually recognizes, so the terms are checked by
    // running the parser over the instruction the terms give. Tightening the
    // parser without updating this sentence fails here.
    const instruction = /`(rebuild from concept [^`]+)`/.exec(terms)?.[1];
    assert.ok(instruction, 'the terms must quote the phrase a buyer should send');
    assert.equal(parseRevisionRequest(instruction.replace(/\bN\b/, '2')), 2);
    assert.match(terms, /one rebuild per contract/i);
    assert.match(terms, /warranty window/i);
  });

  it('still promises no re-run, no new concepts and no redesign', () => {
    // The half Task 29 deliberately did NOT build. A §9 abort delivers nothing,
    // so there is no artifact to warrant, and every abort leg reproduces its
    // failure on retry — see the `warrantyTerms` comment in config.ts.
    for (const unimplemented of [/re-run free of charge/i, /revision round/i, /free of charge/i]) {
      assert.doesNotMatch(terms, unimplemented);
    }
    // Stated positively too, so the absence above cannot be satisfied by an
    // empty or gutted string.
    assert.match(terms, /does not generate new concepts, redesign a mark/i);
  });

  it('names no fixed warranty duration, because the platform owns that window', () => {
    // A constant here would drift from `contract.warrantyExpires`, which is
    // what `withinWarrantyWindow` actually enforces.
    assert.doesNotMatch(terms, /\b\d+\s*(?:day|days|week|weeks|month|months)\b/i);
  });

  it('names the three things the bot actually does', () => {
    // Gates run BEFORE delivery and a failing artifact is not shipped
    // (pipeline.ts's abort legs); the evidence record stays available
    // (report.ts + the progress page); a dispute gets the full record filed
    // (disputes.ts's assembleDisputeEvidence).
    assert.match(terms, /BEFORE delivery/);
    assert.match(terms, /evidence page/i);
    assert.match(terms, /dispute/i);
    assert.match(terms, /Trademark clearance is NOT performed/);
  });
});
