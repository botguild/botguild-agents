import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createThreadReader, findSelection, parseSelection } from './threads.js';
import type { ThreadMessage } from './threads.js';
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

  // Negation/contrast: a cue word immediately before a matched slot makes
  // that specific match unreliable. Reviewer-found: "not concept 2" was
  // returning 2 (the buyer meant anything BUT 2), and "anything but concept
  // 1" was returning 1 — both confident and wrong.
  it('refuses to guess a slot that is negated or set up as a contrast', () => {
    assert.equal(parseSelection('not concept 2'), null);
    assert.equal(parseSelection('anything but concept 1'), null);
  });

  // Round 3: this now nulls out — an accepted cost, not a bug. The scoped
  // lookbehind that used to protect this exact case (a cue only counted if
  // it preceded the match within a window) is the same design that let
  // "concept 1 is nice, but concept 2" confidently return 1, the concept
  // the buyer had just rejected (next test below). A cue anywhere in the
  // message now nulls the whole thing, with no attempt to work out which
  // mention it modifies — a buyer who gets no response here simply follows
  // up; shipping the wrong logo is the worse failure this trades away.
  it('nulls a message with a cue anywhere, even one that only qualifies a harmless follow-up request', () => {
    assert.equal(parseSelection('concept 2, but can you make it blue?'), null);
  });

  // Adversarial-review-found: both of these used to confidently return the
  // concept the buyer explicitly DE-PRIORITIZED, because the cue sat just
  // outside the scoped lookbehind window around the surviving mention. This
  // is exactly the failure mode this module's own contract calls worse
  // than null — the reason the window was deleted in favor of a
  // whole-message check.
  it('does not confidently return the de-prioritized concept in a negated or comparative sentence', () => {
    assert.equal(parseSelection('concept 1 is nice, but concept 2'), null);
    assert.equal(parseSelection("I'd rather have concept 2 than concept 1"), null);
  });

  // The scoped lookbehind was also non-monotonic — the tell that it was
  // wrong in principle, not just missing a case: this longer, more hedged
  // sentence already nulled correctly under it (via the multi-slot
  // ambiguity rule, since both mentions still matched), while the shorter,
  // more natural phrasing above did not. A whole-message cue check makes
  // both null for the same reason, regardless of how much text separates
  // the cue from a mention.
  it('is not sensitive to how much text sits between the cue and a mention', () => {
    assert.equal(
      parseSelection('concept 1 is a nice color choice overall but I think I prefer concept 2'),
      null,
    );
  });

  it('recognizes go with N, make it N, and lets do N as selections', () => {
    assert.equal(parseSelection('go with 3'), 3);
    assert.equal(parseSelection('make it 1'), 1);
    assert.equal(parseSelection("let's do 2"), 2);
    assert.equal(parseSelection('lets do 2'), 2);
  });

  // Named for exactly what it checks: recognizing "go with N" turns this
  // one sentence into a two-slot ambiguity instead of a stale first match
  // on "concept 2" — not a claim that contrast-and-correction sentences in
  // general resolve this way (they don't all; see the negation-cue tests
  // above, which cover sentences with no second recognized form to surface).
  it('the go-with form surfaces a second slot in "concept 2 is terrible, go with 3", turning it into an ambiguity rather than a stale first match', () => {
    assert.equal(parseSelection('concept 2 is terrible, go with 3'), null);
  });

  // Widening the match surface to catch the above risks catching phrases
  // where the number is a quantity, not a pick — both guarded here: "2x"
  // has no word boundary between digit and letter, and the "go with N"
  // family only matches when N is the last thing in the message.
  it('does not read a quantity after go-with or make-it as a selection', () => {
    assert.equal(parseSelection('go with 3 colors'), null);
    assert.equal(parseSelection('make it 2x bigger'), null);
  });

  // '#N' is gated by an ALLOW-list of recognized selection words (or
  // starting the message), not a deny-list of reference nouns — a deny-list
  // only ever covers nouns someone thought of. Named for what it actually
  // checks: an unrecognized preceding word denies '#N', full stop, whether
  // or not that word happens to look like a reference-number noun. These
  // twelve are samples, not an enumerated category the code recognizes —
  // three round-2 found (invoice/order/room) and nine adversarial review
  // added (PO/SKU/lot/bay/gate/aisle/badge/case/batch).
  it('denies "#N" whenever the preceding word is not a recognized selection word', () => {
    assert.equal(parseSelection('see invoice #2 for details'), null);
    assert.equal(parseSelection('order #2 shipped'), null);
    assert.equal(parseSelection('room #2, second floor'), null);
    assert.equal(parseSelection('PO #2'), null);
    assert.equal(parseSelection('SKU #2'), null);
    assert.equal(parseSelection('lot #2'), null);
    assert.equal(parseSelection('bay #2'), null);
    assert.equal(parseSelection('gate #2'), null);
    assert.equal(parseSelection('aisle #2'), null);
    assert.equal(parseSelection('badge #2'), null);
    assert.equal(parseSelection('case #2'), null);
    assert.equal(parseSelection('batch #2'), null);
    // 'no' sat in both round-2 lists (a negation cue AND a denied noun, for
    // "item no. 2") — under the allow-list it needs no special case, since
    // 'no' was never a recognized selection word either way.
    assert.equal(parseSelection('No, #2 is my favorite'), null);
  });

  // The allow-list's positive side: '#N' is a pick when it opens the
  // message, or a recognized selection word (not just 'like', from the
  // locked test above) immediately precedes it.
  it('accepts "#N" at the start of a message or after a recognized selection word', () => {
    assert.equal(parseSelection('#2 please'), 2);
    assert.equal(parseSelection('I prefer #1'), 1);
  });

  // A digit immediately followed by '.' and another digit is a decimal, not
  // an integer slot with a fractional tail — truncating "2.5" to 2 is
  // exactly the confident-wrong-answer failure mode this module exists to
  // avoid.
  it('does not truncate a decimal into a slot number', () => {
    assert.equal(parseSelection('concept 2.5'), null);
    assert.equal(parseSelection('#2.5'), null);
  });

  // parseSelection(undefined | null | 2 | {}) all used to throw on
  // .trim() — a public export must not throw for any input, since a field
  // typed `string` (ThreadMessage.body) can carry whatever an unsafe
  // upstream cast actually put there.
  it('returns null instead of throwing for non-string input', () => {
    assert.equal(parseSelection(undefined), null);
    assert.equal(parseSelection(null), null);
    assert.equal(parseSelection(2), null);
    assert.equal(parseSelection({}), null);
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

  // Reviewer-found: a soft-deleted message (Message.deletedAt set) is a
  // realistic platform state whose content can come back null or missing
  // over the wire, despite ThreadMessage.body's string type — findSelection
  // must survive that, not throw out of parseSelection's .trim().
  it('does not throw on a null or missing body, and keeps scanning past it', () => {
    const nullBody: ThreadMessage = {
      id: 'm',
      senderId: 'payer-1',
      body: null as unknown as string,
      createdAt: '2026-07-30T00:00:00Z',
    };
    const missingBody = {
      id: 'm',
      senderId: 'payer-1',
      createdAt: '2026-07-30T00:00:00Z',
    } as unknown as ThreadMessage;

    assert.doesNotThrow(() => findSelection([nullBody, missingBody], 'bot-logosmith'));
    assert.equal(findSelection([nullBody, missingBody], 'bot-logosmith'), null);
    assert.equal(findSelection([nullBody, missingBody, buyer('concept 2')], 'bot-logosmith'), 2);
  });

  // The gap `?? ''` alone cannot close: it only substitutes for null and
  // undefined, so a non-nullish, non-string body (a malformed payload where
  // `content` came back as a number or object, say) would still have
  // reached parseSelection's .trim() directly. Closed one layer down, by
  // parseSelection's own typeof guard, not by findSelection's `?? ''`.
  it('does not throw when body is a non-nullish, non-string value either', () => {
    const weirdBody = {
      id: 'm',
      senderId: 'payer-1',
      body: 2,
      createdAt: '2026-07-30T00:00:00Z',
    } as unknown as ThreadMessage;

    assert.doesNotThrow(() => findSelection([weirdBody], 'bot-logosmith'));
    assert.equal(findSelection([weirdBody], 'bot-logosmith'), null);
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

  // Reviewer-found reproduction: a soft-deleted message can carry `content:
  // null` over the wire. listMessages must not throw mapping it, and the
  // null body must survive downstream into findSelection (covered directly
  // in the findSelection suite above) rather than crash the caller.
  it('maps a soft-deleted message (null content) without throwing', async () => {
    const fetchImpl = fetchStub({
      '/threads?': () =>
        new Response(JSON.stringify({ threads: [{ id: 'th_1' }] }), { status: 200 }),
      '/messages': () =>
        new Response(
          JSON.stringify({
            messages: [
              {
                id: 'm1',
                sender_id: 'handler-1',
                sender_bot_id: null,
                content: null,
                created_at: '2026-07-30T00:00:00Z',
              },
              {
                id: 'm2',
                sender_id: 'handler-1',
                sender_bot_id: null,
                content: 'concept 2',
                created_at: '2026-07-30T00:01:00Z',
              },
            ],
          }),
          { status: 200 },
        ),
    });
    const reader = createThreadReader({
      apiUrl: 'https://api.example.com',
      apiKey: 'k',
      fetchImpl,
    });

    const messages = await reader.listMessages('contract-42');

    assert.equal(messages[0]?.body, null);
    assert.equal(findSelection(messages, 'bot-logosmith'), 2);
  });
});
