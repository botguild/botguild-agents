import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentClient, Gig, WebhookEvent } from '@botguild/agent-core';
import { createConsoleLogger } from '@botguild/agent-core-workers';
import { createMemoryD1 } from '@botguild/agent-core-workers/testing';
import { PLATFORM_MAX_BID_USD, SEED_PRICE_USD, pricingCalc } from './config.js';
import { buildJobKey, createJobStore } from './jobs.js';
import { applyMigrations } from './testSupport.js';
import { createMilestoneFundedHandler, resolveDeliverable, stageForFundedGig } from './index.js';
import type { JobMessage } from './types.js';

describe('resolveDeliverable', () => {
  it('maps a whitelisted file to its R2 key and content type', () => {
    const token = 'a'.repeat(64);
    assert.deepEqual(resolveDeliverable(token, 'pack.zip'), {
      key: `${token}/pack.zip`,
      contentType: 'application/zip',
    });
    assert.equal(resolveDeliverable(token, 'report.json')?.contentType, 'application/json');
    assert.equal(resolveDeliverable(token, 'concept-1.png')?.contentType, 'image/png');
  });

  it('rejects a file that is not whitelisted', () => {
    assert.equal(resolveDeliverable('a'.repeat(64), 'secrets.env'), null);
    assert.equal(resolveDeliverable('a'.repeat(64), '../../etc/passwd'), null);
  });

  it('rejects a token that is not 64 hex characters', () => {
    assert.equal(resolveDeliverable('short', 'pack.zip'), null);
    assert.equal(resolveDeliverable('g'.repeat(64), 'pack.zip'), null);
  });

  it('accepts only the three concept slots', () => {
    const token = 'a'.repeat(64);
    assert.ok(resolveDeliverable(token, 'concept-3.png'));
    assert.equal(resolveDeliverable(token, 'concept-4.png'), null);
  });

  it('rejects Object.prototype-inherited property names, not just absent ones', () => {
    // DELIVERABLE_TYPES is a plain object literal used as a lookup map; a
    // bracket-access lookup returns a truthy inherited value for these names
    // instead of undefined, bypassing a falsy-check guard. None of these are
    // ever whitelisted files, so every one must resolve to null.
    const token = 'a'.repeat(64);
    const inheritedNames = [
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      'valueOf',
      'toLocaleString',
      'isPrototypeOf',
      'propertyIsEnumerable',
    ];
    for (const file of inheritedNames) {
      assert.equal(resolveDeliverable(token, file), null, `expected null for file=${file}`);
    }
  });
});

// ---------------------------------------------------------------------------
// milestone.funded routing
//
// A stage mis-route is invisible from inside either stage: both run perfectly
// well, just on the wrong contract. Before this seam existed, EVERY funded gig
// was claimed as `concepts` — so a $0 favicon or taster gig compiled Haiku axes
// and bought three Ideogram/Recraft images for a contract paying nothing, with
// the FR-14 quota never consulted. These tests assert what was actually
// CLAIMED and ENQUEUED, not what a pure helper returned, because only the
// former can catch a handler that computes the right stage and then claims the
// wrong one.
// ---------------------------------------------------------------------------

const CONTRACT_ID = 'contract-routing-1';
const fence = (brief: unknown): string => '```json\n' + JSON.stringify(brief) + '\n```';

const FAVICON_GIG = {
  id: 'gig-favicon',
  description: fence({ logoUrl: 'https://cdn.example.com/logo.png' }),
  budget: 0,
} as unknown as Gig;

const TASTER_GIG = {
  id: 'gig-taster',
  description: fence({ brandName: 'Harbor & Vine', industry: 'boutique inn' }),
  budget: 0,
} as unknown as Gig;

const PAID_GIG = {
  id: 'gig-paid',
  description: fence({ brandName: 'Harbor & Vine', industry: 'boutique inn' }),
  budget: SEED_PRICE_USD,
} as unknown as Gig;

/** A favicon gig someone listed with a budget. Free by BRIEF SHAPE, not by
 *  price — so this is the case a bare `budget === 0` test would miss. */
const FUNDED_FAVICON_GIG = {
  id: 'gig-favicon-funded',
  description: fence({ logoUrl: 'https://cdn.example.com/logo.png' }),
  budget: SEED_PRICE_USD,
} as unknown as Gig;

async function routeFundedGig(
  gig: Gig,
  options: { getGigThrows?: string } = {},
): Promise<{ sent: JobMessage[]; stageInD1: string | null; claims: number }> {
  const db = createMemoryD1();
  await applyMigrations(db);
  const jobs = createJobStore(db);

  let claims = 0;
  const client = {
    getContract: async (id: string) => ({ id, gigId: gig.id }),
    getGig: async () => {
      if (options.getGigThrows) throw new Error(options.getGigThrows);
      return gig;
    },
  } as unknown as AgentClient;

  const sent: JobMessage[] = [];
  const handler = createMilestoneFundedHandler({
    client,
    jobs: {
      claim: async (jobKey, contractId, stage) => {
        claims += 1;
        return jobs.claim(jobKey, contractId, stage);
      },
    },
    queue: {
      send: async (message: JobMessage) => {
        sent.push(message);
      },
    },
    logger: createConsoleLogger({ service: 'logosmith-test', level: 'silent' }),
  });

  await handler({
    eventType: 'milestone.funded',
    payload: { contractId: CONTRACT_ID },
  } as unknown as WebhookEvent);

  const row = await db
    .prepare('SELECT stage FROM jobs WHERE contract_id = ?')
    .bind(CONTRACT_ID)
    .first<{ stage: string }>();
  return { sent, stageInD1: row?.stage ?? null, claims };
}

describe('stageForFundedGig', () => {
  it('routes every free gig shape to the single stage', () => {
    // Preconditions, asserted inline: these fixtures really are the $0 shapes.
    // Without this, the routing assertions below would pass just as happily
    // against gigs that were never free.
    assert.equal(pricingCalc(FAVICON_GIG).price, 0);
    assert.equal(pricingCalc(TASTER_GIG).price, 0);
    assert.equal(pricingCalc(FUNDED_FAVICON_GIG).price, 0);

    assert.equal(stageForFundedGig(FAVICON_GIG), 'single');
    assert.equal(stageForFundedGig(TASTER_GIG), 'single');
    assert.equal(stageForFundedGig(FUNDED_FAVICON_GIG), 'single');
  });

  it('routes the paid gig to the concepts stage', () => {
    // The paid baseline is the seed anchor bounded by the preview bid cap —
    // nonzero either way, which is all the stage routing keys on.
    assert.equal(pricingCalc(PAID_GIG).price, Math.min(SEED_PRICE_USD, PLATFORM_MAX_BID_USD));
    assert.equal(stageForFundedGig(PAID_GIG), 'concepts');
  });
});

describe('createMilestoneFundedHandler', () => {
  it('claims and enqueues stage `single` for a funded $0 gig', async () => {
    for (const gig of [FAVICON_GIG, TASTER_GIG, FUNDED_FAVICON_GIG]) {
      const routed = await routeFundedGig(gig);
      const expectedKey = await buildJobKey(CONTRACT_ID, 'single');
      assert.deepEqual(
        routed.sent,
        [{ contractId: CONTRACT_ID, jobKey: expectedKey, stage: 'single' }],
        `gig ${gig.id} must be worked as a free job`,
      );
      // The D1 claim and the queue message must agree: the consumer reads the
      // row the message points at, so a stage-suffixed key built for one stage
      // and claimed as another would run the wrong pipeline against it.
      assert.equal(routed.stageInD1, 'single', gig.id);
    }
  });

  it('claims and enqueues stage `concepts` for the funded $25 gig', async () => {
    const routed = await routeFundedGig(PAID_GIG);
    const expectedKey = await buildJobKey(CONTRACT_ID, 'concepts');
    assert.deepEqual(routed.sent, [
      { contractId: CONTRACT_ID, jobKey: expectedKey, stage: 'concepts' },
    ]);
    assert.equal(routed.stageInD1, 'concepts');
  });

  it('gives the two stages different claim keys for the same contract', async () => {
    // The stage suffix is what stops a free job and a paid job for one contract
    // colliding on the jobs primary key — and what makes the assertions above
    // about *which* key was claimed meaningful at all.
    assert.notEqual(
      await buildJobKey(CONTRACT_ID, 'single'),
      await buildJobKey(CONTRACT_ID, 'concepts'),
    );
  });

  it('throws without claiming anything when the gig cannot be read', async () => {
    // Fail closed: guessing a stage from an unreadable gig either buys paid
    // images for a free gig or burns a free allowance on a paid one. A throw
    // answers 500 and the platform redelivers against a clean slate.
    await assert.rejects(
      routeFundedGig(PAID_GIG, { getGigThrows: 'platform 503' }),
      /platform 503/,
    );
  });
});
