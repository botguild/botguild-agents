import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createThreadReader, findSelection, parseSelection } from './threads.js';
import type { FetchLike } from './types.js';

describe('parseSelection', () => {
  it('reads the instructed form', () => {
    assert.equal(parseSelection('concept 2'), 2);
    assert.equal(parseSelection('Concept 3'), 3);
  });

  it('reads natural phrasings a buyer actually types', () => {
    assert.equal(parseSelection("I'll take concept 1 please"), 1);
    assert.equal(parseSelection('we like #2 best'), 2);
    assert.equal(parseSelection('option 3'), 3);
    assert.equal(parseSelection('3'), 3);
  });

  it('returns null for out-of-range and ambiguous replies', () => {
    assert.equal(parseSelection('concept 4'), null);
    assert.equal(parseSelection('concept 0'), null);
    assert.equal(parseSelection('I like concept 1 and concept 2'), null);
    assert.equal(parseSelection('thanks, looks great!'), null);
    assert.equal(parseSelection(''), null);
  });

  // The exact tail of the bot's own M1 delivery message (PRD FR-8: "reply
  // with `concept 1|2|3`"). It parses the same as any buyer reply would —
  // parseSelection has no notion of who sent a message — which is exactly
  // why findSelection must exclude bot-authored messages by sender *before*
  // parsing, rather than filtering the result afterward. See findSelection.
  it('parses the M1 instruction text like any other message, which is why sender filtering has to happen before parsing', () => {
    assert.equal(parseSelection("reply with 'concept 1|2|3'"), 1);
  });
});

describe('findSelection', () => {
  const buyer = (body: string) => ({
    id: 'm',
    senderId: 'payer-1',
    body,
    createdAt: '2026-07-30T00:00:00Z',
  });
  const bot = (body: string) => ({
    id: 'm',
    senderId: 'bot-logosmith',
    body,
    createdAt: '2026-07-30T00:00:00Z',
  });

  it("ignores the bot's own instruction message", () => {
    const messages = [bot("reply with 'concept 1|2|3'"), buyer('concept 2')];
    assert.equal(findSelection(messages, 'bot-logosmith'), 2);
  });

  it('takes the FIRST buyer selection, not the last', () => {
    const messages = [buyer('concept 1'), buyer('actually concept 3')];
    assert.equal(findSelection(messages, 'bot-logosmith'), 1);
  });

  it('returns null when no buyer message parses', () => {
    assert.equal(findSelection([bot('concept 2'), buyer('looks good')], 'bot-logosmith'), null);
  });

  // Explicit per the task brief: a thread that is nothing but the bot's own
  // M1 instruction — no buyer reply has arrived at all yet — must yield
  // null, not the instruction text's own "concept 1". This is the whole
  // reason findSelection takes botId instead of just scanning for the first
  // parseable message.
  it("yields null for a thread containing only the bot's M1 instruction", () => {
    const messages = [bot("reply with 'concept 1|2|3'")];
    assert.equal(findSelection(messages, 'bot-logosmith'), null);
  });

  // Ambiguity is checked per-message (inside parseSelection), never across
  // messages. An unclear early reply must not block a clear reply the buyer
  // sends afterward — it is simply skipped, exactly like any other message
  // that fails to parse — and it must not be "resolved" using a slot
  // mentioned in some other message either.
  it('skips an ambiguous buyer message and resolves from a later, unambiguous one', () => {
    const messages = [buyer('I like concept 1 and concept 2'), buyer('concept 3')];
    assert.equal(findSelection(messages, 'bot-logosmith'), 3);
  });
});

describe('createThreadReader', () => {
  function fetchStub(
    handlers: Record<string, (url: string, init?: RequestInit) => Promise<Response> | Response>,
  ): FetchLike {
    return async (url, init) => {
      for (const [fragment, handler] of Object.entries(handlers)) {
        if (url.includes(fragment)) return handler(url, init);
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
  }

  it("reads a contract thread's messages, mapping the wire shape to ThreadMessage", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = fetchStub({
      // Query-then-messages, matching apps/voicewright-bot/src/threads.ts's
      // endpoint shape. Fragments are mutually exclusive (only the list call
      // URL contains '?'), so handler registration order doesn't matter.
      '/threads?': (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ threads: [{ id: 'th_1' }] }), { status: 200 });
      },
      '/messages': (url, init) => {
        calls.push({ url, init });
        // Raw snake_case, as the real D1-backed `SELECT *` returns it —
        // exercises mapKeysToCamel for real instead of assuming it away.
        return new Response(
          JSON.stringify({
            messages: [
              {
                id: 'm1',
                sender_id: 'handler-1',
                sender_bot_id: null,
                content: 'concept 2',
                created_at: '2026-07-30T00:00:00Z',
              },
              {
                id: 'm2',
                sender_id: 'handler-9',
                sender_bot_id: 'bot-logosmith',
                content: "reply with 'concept 1|2|3'",
                created_at: '2026-07-29T23:00:00Z',
              },
            ],
          }),
          { status: 200 },
        );
      },
    });
    const reader = createThreadReader({
      apiUrl: 'https://api.example.com',
      apiKey: 'key-123',
      fetchImpl,
    });

    const messages = await reader.listMessages('contract-42');

    assert.deepEqual(messages, [
      { id: 'm1', senderId: 'handler-1', body: 'concept 2', createdAt: '2026-07-30T00:00:00Z' },
      {
        id: 'm2',
        senderId: 'bot-logosmith',
        body: "reply with 'concept 1|2|3'",
        createdAt: '2026-07-29T23:00:00Z',
      },
    ]);
    // The platform's `sender_id` on a bot-authored message is the *handler*
    // account, not the bot — only `sender_bot_id` names the bot. This is
    // the real point of the mapping above: prove findSelection still
    // correctly excludes m2 once the message has round-tripped through the
    // actual wire shape, not just the test's own local fixtures.
    assert.equal(findSelection(messages, 'bot-logosmith'), 2);

    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/threads\?scope=contract&scopeId=contract-42&limit=1$/);
    assert.match(calls[1].url, /\/threads\/th_1\/messages$/);
    for (const call of calls) {
      const headers = call.init?.headers as Record<string, string> | undefined;
      assert.equal(headers?.['X-API-Key'], 'key-123');
    }
  });

  it('returns [] without requesting messages when the contract has no thread yet', async () => {
    const fetchImpl = fetchStub({
      '/threads?': () => new Response(JSON.stringify({ threads: [] }), { status: 200 }),
      // No '/messages' handler: if listMessages requested it anyway,
      // fetchStub's catch-all throws and fails this test.
    });
    const reader = createThreadReader({
      apiUrl: 'https://api.example.com',
      apiKey: 'k',
      fetchImpl,
    });

    assert.deepEqual(await reader.listMessages('contract-42'), []);
  });

  it('throws when the platform responds with a non-2xx status', async () => {
    const fetchImpl = fetchStub({
      '/threads?': () => new Response('nope', { status: 500 }),
    });
    const reader = createThreadReader({
      apiUrl: 'https://api.example.com',
      apiKey: 'k',
      fetchImpl,
    });

    await assert.rejects(() => reader.listMessages('contract-42'));
  });
});
