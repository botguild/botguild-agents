import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createModerationClient } from './moderation.js';

const respond =
  (body: unknown, status = 200): (() => Promise<Response>) =>
  async () =>
    new Response(JSON.stringify(body), { status });

describe('moderation', () => {
  it('returns clear for an unflagged brief and snapshots the verdict', async () => {
    const client = createModerationClient({
      fetchImpl: respond({ results: [{ flagged: false, categories: {} }] }),
      apiKey: 'k',
    });
    const outcome = await client.screen('Harbor & Vine, a boutique inn');
    assert.equal(outcome.status, 'clear');
    assert.ok(outcome.status === 'clear' && outcome.verdict.model.length > 0);
    assert.ok(outcome.status === 'clear' && outcome.verdict.checkedAt.length > 0);
  });

  it('returns flagged when the vendor flags the input', async () => {
    const client = createModerationClient({
      fetchImpl: respond({ results: [{ flagged: true, categories: { violence: true } }] }),
      apiKey: 'k',
    });
    assert.equal((await client.screen('bad')).status, 'flagged');
  });

  it('fails CLOSED on a vendor error — never a pass', async () => {
    const client = createModerationClient({ fetchImpl: respond({}, 500), apiKey: 'k' });
    const outcome = await client.screen('anything');
    assert.equal(outcome.status, 'unavailable');
  });

  it('fails CLOSED on a network throw', async () => {
    const client = createModerationClient({
      fetchImpl: async () => {
        throw new Error('socket hang up');
      },
      apiKey: 'k',
    });
    assert.equal((await client.screen('anything')).status, 'unavailable');
  });

  it('fails CLOSED on a malformed response body', async () => {
    const client = createModerationClient({ fetchImpl: respond({ nope: true }), apiKey: 'k' });
    assert.equal((await client.screen('anything')).status, 'unavailable');
  });

  it('retains the vendor response verbatim for dispute evidence', async () => {
    const raw = { results: [{ flagged: false, categories: { harassment: false } }] };
    const client = createModerationClient({ fetchImpl: respond(raw), apiKey: 'k' });
    const outcome = await client.screen('x');
    assert.ok(outcome.status === 'clear');
    assert.deepEqual(outcome.verdict.response, raw);
  });
});
