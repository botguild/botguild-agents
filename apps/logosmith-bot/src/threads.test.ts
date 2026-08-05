import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createThreadReader,
  findRevisionRequestIn,
  findSelection,
  findSelectionIn,
  parseRevisionRequest,
  parseSelection,
} from './threads.js';
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

  // parseSelection is sender-blind by construction: it sees text, never
  // authorship. Under the round-5 template parser this particular string —
  // the tail of the bot's own M1 delivery note (PRD FR-8: "reply with
  // `concept 1|2|3`") — happens not to be a recognized selection shape, so
  // it is null. That is INCIDENTAL and must not be leaned on. The guarantee
  // is findSelection's sender filter: the bot also writes plain "concept N"
  // into its delivery and gate-failure notes, and any such text parses
  // exactly like a buyer's reply would (second assertion). Authorship is
  // therefore decided before parsing, not after. See findSelection.
  it('is sender-blind: nothing in the parser distinguishes bot-authored text from a buyer reply', () => {
    assert.equal(parseSelection("reply with 'concept 1|2|3'"), null);
    assert.equal(parseSelection('concept 1'), 1);
  });

  // ==== The class this module kept reopening: a confident WRONG slot ====
  //
  // Rounds 1-3 each extracted a slot number by substring match and then
  // tried to disqualify it with a list of negation cues. Every unlisted way
  // of saying "not that one" leaked a confident wrong answer, and English
  // rejection vocabulary has no bottom. Round 5 inverted the parser: the
  // WHOLE message must be a recognized affirmative shape, so these are null
  // because they were never affirmatively recognized — not because anyone
  // enumerated "skip", "veto", "nope", "hard pass" or "no-go". Grep the
  // module: none of those words appears in it, and none needs to.
  //
  // These fifteen are the exact strings the round-4 review found still
  // leaking through the previous design.
  it('returns null for every rejection phrasing, without recognizing rejection vocabulary', () => {
    // Unrecognized lead-in.
    assert.equal(parseSelection('skip concept 2'), null);
    assert.equal(parseSelection('pass on concept 1'), null);
    assert.equal(parseSelection('veto concept 1'), null);
    assert.equal(parseSelection('declining concept 2, moving on'), null);
    assert.equal(parseSelection('give me anything other than concept 2'), null);
    assert.equal(parseSelection('I cannot accept concept 2'), null);
    // Unrecognized trailing content.
    assert.equal(parseSelection('concept 2 is a hard pass'), null);
    assert.equal(parseSelection('concept 2 is out'), null);
    assert.equal(parseSelection('concept 1 was my second choice'), null);
    assert.equal(parseSelection('concept 1 is my least favorite'), null);
    assert.equal(parseSelection('concept 3 is my bottom choice'), null);
    assert.equal(parseSelection('concept 2 ranks last for me'), null);
    assert.equal(parseSelection('concept 2 is a no-go for me'), null);
    assert.equal(parseSelection('concept 2, never in a million years'), null);
    assert.equal(parseSelection('concept 2? nope, love 3'), null);
  });

  // The same property, checked against vocabulary that appears in no review,
  // no report and no test before this one — the point being that novelty is
  // irrelevant to a parser that only recognizes affirmatives.
  it('returns null for rejection vocabulary nobody has ever listed', () => {
    for (const text of [
      'nix concept 2',
      'ditch concept 1',
      'scrap concept 3',
      'shelve concept 2 please',
      'I would sooner eat glass than ship concept 2',
      'concept 2 over my dead body',
      'concept 2 is dead last',
      'concept 2 gets a no from me',
      'thumbs down on #2',
      'concept 2 is the one to cut',
      'we are ruling out concept 2',
      'steer clear of concept 2, thanks',
    ]) {
      assert.equal(parseSelection(text), null, text);
    }
  });

  // Also null, and for the same one reason. Grouped here because these are
  // the cases where the previous designs did their worst: they returned the
  // concept the buyer had just REJECTED (an inverted answer), not merely a
  // wrong one. Round 2's scoped lookbehind vetoed the wrong mention; round
  // 3's whole-message cue list caught these two but not the fifteen above.
  it('never returns the de-prioritized concept from a contrast or comparison', () => {
    assert.equal(parseSelection('not concept 2'), null);
    assert.equal(parseSelection('anything but concept 1'), null);
    assert.equal(parseSelection('concept 1 is nice, but concept 2'), null);
    assert.equal(parseSelection("I'd rather have concept 2 than concept 1"), null);
    assert.equal(
      parseSelection('concept 1 is a nice color choice overall but I think I prefer concept 2'),
      null,
    );
    assert.equal(parseSelection('concept 2 is terrible, go with 3'), null);
  });

  // ==== The accepted cost, locked so it is never "fixed" ====
  //
  // Read this before changing anything above. Each of these is a buyer
  // plainly picking a concept, and each returns null. That is the price of
  // requiring the whole message to be a recognized shape, and it is
  // deliberate. The only way to make them parse is to let unrecognized text
  // sit beside a slot number — which is exactly what rounds 1-3 did, and
  // exactly what produced "concept 1 is nice, but concept 2" -> 1, an
  // inverted answer shipped with confidence. A buyer who gets no response
  // follows up, and FR-9's 72-hour default-selection timeout catches the
  // ones who don't; a buyer who gets the wrong logo has already been failed.
  //
  // If you want one of these to parse, add an affirmative LEAD_IN or POLITE
  // entry for its exact shape (safe: it can only turn a null into a pick).
  // Do NOT relax the anchors.
  it('accepts a null for a verbose but perfectly clear pick rather than relax the anchors', () => {
    assert.equal(parseSelection("concept 2 looks perfect, let's go with that"), null);
    assert.equal(parseSelection('concept 2 is the winner'), null);
    assert.equal(parseSelection('concept 2 it is!'), null);
    assert.equal(parseSelection('concept 2 for sure'), null);
    assert.equal(parseSelection('we love concept 2, ship it'), null);
    assert.equal(parseSelection('concept two'), null); // spelled-out numerals
    // Round 2 explicitly REQUIRED this one to return 2, via the scoped
    // lookbehind that then produced the inverted answers above; round 3
    // reversed it on explicit review instruction ("Drop the protection;
    // keep the safety"). It stays null here for the stronger reason: the
    // trailing clause is not a recognized part of any selection shape.
    assert.equal(parseSelection('concept 2, but can you make it blue?'), null);
    // Idioms that only ever nulled by accident of the old cue list, and now
    // null structurally.
    assert.equal(parseSelection('no problem, concept 2'), null);
    assert.equal(parseSelection('no rush — go with 2'), null);
  });

  it('recognizes the affirmative lead-in forms', () => {
    assert.equal(parseSelection('go with 3'), 3);
    assert.equal(parseSelection('make it 1'), 1);
    assert.equal(parseSelection("let's do 2"), 2);
    assert.equal(parseSelection('lets do 2'), 2);
    assert.equal(parseSelection('go with concept 2'), 2);
    assert.equal(parseSelection("Let's go with concept 2!"), 2);
    assert.equal(parseSelection("We'll take concept 3, thank you!"), 3);
    assert.equal(parseSelection("I'm going with 2"), 2);
    assert.equal(parseSelection('I choose concept 2'), 2);
    assert.equal(parseSelection('my pick is concept 2'), 2);
    assert.equal(parseSelection('please go with 2'), 2);
    assert.equal(parseSelection('yes, concept 2'), 2);
    assert.equal(parseSelection('thanks, concept 2'), 2);
    // Curly apostrophes (every phone keyboard emits them) must not defeat
    // the "I'll"/"let's" forms.
    assert.equal(parseSelection('I’ll take concept 1 please'), 1);
    assert.equal(parseSelection('let’s do 2'), 2);
    // Whitespace and casing normalization, including the multi-line reply.
    assert.equal(parseSelection('CONCEPT 2'), 2);
    assert.equal(parseSelection('concept\t2'), 2);
    assert.equal(parseSelection('concept 2\n\nthanks!'), 2);
    assert.equal(parseSelection('concept-2'), 2);
    assert.equal(parseSelection('concept #2'), 2);
  });

  // The mirror image of the lead-in list: a lead-in only counts when the
  // slot reference follows it IMMEDIATELY. That adjacency is what makes
  // enumerating affirmative lead-ins safe — no rejection can be built by
  // slipping a negating word in behind one, because nothing may be skipped
  // over. Each of these begins with a recognized lead-in and still nulls.
  it('does not let a recognized lead-in carry unrecognized text into a pick', () => {
    assert.equal(parseSelection("I don't like concept 2"), null);
    assert.equal(parseSelection('I like concept 2 the least'), null);
    assert.equal(parseSelection('we like #2 least'), null);
    assert.equal(parseSelection('I want concept 2 removed'), null);
    assert.equal(parseSelection('use concept 2 as an example of what not to do'), null);
    assert.equal(parseSelection('my least favorite is concept 2'), null);
    assert.equal(parseSelection('my choice is not concept 2'), null);
    assert.equal(parseSelection('definitely not concept 2'), null);
    assert.equal(parseSelection('go with anything but 2'), null);
  });

  // Quantities: the same digit answering a different question. The trailing
  // anchor is what separates them from a pick.
  it('does not read a quantity as a selection', () => {
    assert.equal(parseSelection('go with 3 colors'), null);
    assert.equal(parseSelection('make it 2x bigger'), null);
    assert.equal(parseSelection("I'll take 2 weeks"), null);
    assert.equal(parseSelection('give me 3 more'), null);
    assert.equal(parseSelection('I want 2 revisions'), null);
    assert.equal(parseSelection('can we get 2 more concepts'), null);
  });

  // '#N' used to be gated by an allow-list of the single word before it.
  // Round 5 subsumes that: '#N' is recognized only when the WHOLE message
  // is a selection shape, so what follows it is constrained too. The twelve
  // reference nouns below (three found in round 2, nine by adversarial
  // review) are samples, not a category the code knows about — and the
  // seven cases after them are the ones the round-4 review found the
  // allow-list alone could not stop, because in every one the allow-listed
  // word really did precede the '#N'.
  it('denies "#N" unless the whole message is a recognized selection shape', () => {
    for (const text of [
      'see invoice #2 for details',
      'order #2 shipped',
      'room #2, second floor',
      'PO #2',
      'SKU #2',
      'lot #2',
      'bay #2',
      'gate #2',
      'aisle #2',
      'badge #2',
      'case #2',
      'batch #2',
      'No, #2 is my favorite',
    ]) {
      assert.equal(parseSelection(text), null, text);
    }
    // Allow-listed word before '#N', unrecognized text after it.
    for (const text of [
      'the meeting is #2 on the agenda',
      'I want #2 more days to decide',
      'keep the best #2 elements from the design',
      "let's go with #2 friends to the meeting",
      "I'll take #2 minutes to reply",
      'Our office is #2 on Main Street',
      'can we go #2 in the lineup',
    ]) {
      assert.equal(parseSelection(text), null, text);
    }
  });

  // The positive side: '#N' is a pick when the whole message is a shape.
  it('accepts "#N" when the whole message is a selection shape', () => {
    assert.equal(parseSelection('#2 please'), 2);
    assert.equal(parseSelection('I prefer #1'), 1);
    assert.equal(parseSelection('my choice is #3'), 3);
  });

  // Ambiguity ("two concepts named, so no choice was made") is no longer a
  // counting step — it falls out of the anchors, because whatever sits
  // between two slot mentions is never a lead-in or a politeness word. The
  // BEHAVIOUR is what matters and it is unchanged; this test exists so a
  // future refactor that reintroduces substring matching fails loudly.
  it('treats a message naming two slots as no selection at all', () => {
    assert.equal(parseSelection('I like concept 1 and concept 2'), null);
    assert.equal(parseSelection('concept 1 concept 2'), null);
    assert.equal(parseSelection('go with 1 or 2'), null);
    assert.equal(parseSelection('#1 #2'), null);
    assert.equal(parseSelection("I'll take concept 1 and concept 3 please"), null);
    assert.equal(parseSelection('1 or 2'), null);
  });

  // Decoration carries meaning this parser cannot read, so it is not
  // swallowed. A leading '-' is a minus sign or a negating bullet ("-2" is
  // not slot 2); an emoticon or emoji is sentiment. All fail closed, which
  // costs "concept 2 :)" and "- concept 2" their pick — the safe direction.
  it('does not swallow decoration that could carry meaning', () => {
    assert.equal(parseSelection('-2'), null);
    assert.equal(parseSelection('concept 2 :('), null);
    assert.equal(parseSelection('concept 2 \u{1F44E}'), null);
    assert.equal(parseSelection('> concept 2'), null);
    assert.equal(parseSelection('concept 1|2|3'), null);
    // Plain sentence punctuation and quoting still decorate a clean pick.
    assert.equal(parseSelection('concept 2!'), 2);
    assert.equal(parseSelection('concept 2, thanks!'), 2);
    assert.equal(parseSelection('"concept 2"'), 2);
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

  // The test above no longer exercises the sender filter on its own: under
  // the round-5 template parser the M1 instruction tail is not a recognized
  // shape, so it would be skipped even without the filter. This one does
  // exercise it, and is the case that actually matters — the bot writes
  // plain "concept N" into its delivery and gate-failure notes, and a
  // first-wins scan without the sender filter would hand back the bot's own
  // number instead of the buyer's. Delete the filter and this test fails
  // with 1 instead of 3.
  it('excludes a bot message that would otherwise win the first-wins race', () => {
    const messages = [bot('concept 1'), buyer('concept 3')];
    assert.equal(findSelection(messages, 'bot-logosmith'), 3);
  });

  it('takes the FIRST buyer selection, not the last', () => {
    const messages = [buyer('concept 1'), buyer('actually concept 3')];
    assert.equal(findSelection(messages, 'bot-logosmith'), 1);

    // BOTH messages below must parse on their own, and that is the entire
    // point of this second assertion — do not "simplify" it back to one
    // case, and do not swap either string for a more natural-sounding one
    // without checking parseSelection returns a number for it.
    //
    // The locked fixture above stopped discriminating between first-wins
    // and last-wins the moment round 5 tightened parseSelection: 'actually
    // concept 3' used to parse to 3, so ordering was observable; now it is
    // null, so the assertion holds under BOTH orderings and the test's name
    // became a claim nothing checked. A mutation to
    // `for (const message of [...messages].reverse())` passed the whole
    // suite. This pair discriminates — first-wins gives 1, last-wins gives
    // 3 — and it keeps discriminating only while both strings still parse.
    //
    // The ordering guarantee itself is not cosmetic: SelectionStore.select
    // is first-write-wins (its UPDATE is conditioned on state =
    // 'concepts_delivered'), so a buyer who picks 1, waits for stage 2 to
    // claim slot 1, then says 'concept 3' cannot re-point a job already in
    // flight. findSelection answering 3 there would disagree with what the
    // store can actually persist.
    const bothParse = [buyer('concept 1'), buyer('concept 3')];
    assert.equal(parseSelection('concept 1'), 1);
    assert.equal(parseSelection('concept 3'), 3);
    assert.equal(findSelection(bothParse, 'bot-logosmith'), 1);
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

// ---------------------------------------------------------------------------
// findSelectionIn — the delivered-scoped scan (Task 22)
// ---------------------------------------------------------------------------

describe('findSelectionIn', () => {
  const buyer = (id: string, body: string): ThreadMessage => ({
    id,
    senderId: 'handler-buyer',
    body,
    createdAt: '2026-07-30T00:00:00Z',
  });

  it('scans PAST a pick that cannot be built and takes the next usable one', () => {
    // The defect this exists to fix: on a partial M1 the buyer names the
    // undelivered slot, is told to correct it, and corrects it. Returning the
    // first parseable reply regardless would fixate on the refused one forever.
    const messages = [buyer('m1', 'concept 3'), buyer('m2', 'concept 2')];
    // Fixture preconditions: both parse, and the unusable one is FIRST.
    assert.equal(parseSelection('concept 3'), 3);
    assert.equal(parseSelection('concept 2'), 2);
    assert.equal(findSelection(messages, 'bot-logosmith'), 3);

    assert.deepEqual(findSelectionIn(messages, 'bot-logosmith', new Set([1, 2])), {
      selected: 2,
      unavailable: 3,
    });
  });

  it('still takes the FIRST reply when both picks are deliverable', () => {
    // First-wins is unchanged for anything that could actually be built — it is
    // what keeps a buyer from re-pointing a job already in flight.
    const messages = [buyer('m1', 'concept 1'), buyer('m2', 'concept 3')];
    assert.deepEqual(findSelectionIn(messages, 'bot-logosmith', new Set([1, 2, 3])), {
      selected: 1,
      unavailable: null,
    });
  });

  it('reports the FIRST unusable pick, not the last', () => {
    const messages = [buyer('m1', 'concept 3'), buyer('m2', 'concept 4'), buyer('m3', '2')];
    // 'concept 4' is out of range and never parses at all, so it is invisible
    // here — the reported one is the first that PARSED but was undeliverable.
    assert.equal(parseSelection('concept 4'), null);
    assert.deepEqual(findSelectionIn(messages, 'bot-logosmith', new Set([1, 2])), {
      selected: 2,
      unavailable: 3,
    });
  });

  it('selects nothing when the allowed set is empty', () => {
    const messages = [buyer('m1', 'concept 2')];
    assert.deepEqual(findSelectionIn(messages, 'bot-logosmith', new Set()), {
      selected: null,
      unavailable: 2,
    });
  });

  it('never reads the bot’s own message as a pick', () => {
    const messages: ThreadMessage[] = [
      { id: 'm1', senderId: 'bot-logosmith', body: 'concept 1', createdAt: '2026-07-30T00:00:00Z' },
      buyer('m2', 'concept 2'),
    ];
    // Fixture precondition: the bot's text WOULD parse — authorship is the only
    // thing excluding it.
    assert.equal(parseSelection('concept 1'), 1);
    assert.deepEqual(findSelectionIn(messages, 'bot-logosmith', new Set([1, 2])), {
      selected: 2,
      unavailable: null,
    });
  });

  it('reports nothing for a thread with no parseable reply', () => {
    assert.deepEqual(
      findSelectionIn([buyer('m1', 'looks great, thanks!')], 'bot-logosmith', new Set([1, 2])),
      { selected: null, unavailable: null },
    );
  });
});

// ---------------------------------------------------------------------------
// FR-18 — `parseRevisionRequest` (Task 29)
//
// A SECOND allow-list with a DIFFERENT vocabulary, and the separation is the
// safety property. This parser runs on messages posted AFTER a pack was
// delivered, where the ordinary thing a buyer writes is approval — so if it
// accepted anything `parseSelection` accepts, "concept 2" or "we love concept
// 2" would buy a conversion and re-deliver a pack nobody asked to change.
// ---------------------------------------------------------------------------

describe('parseRevisionRequest', () => {
  it('reads the instructed form and its close variants', () => {
    for (const [text, expected] of [
      ['rebuild from concept 2', 2],
      ['Rebuild from concept 3', 3],
      ['rebuild from #1', 1],
      ['rebuild concept 3', 3],
      ['re-build from concept 2', 2],
      ['rebuild it from concept 1', 1],
      ['rebuild the pack from concept 2', 2],
      ['rebuild with concept 3', 3],
      ['rebuild using concept 2', 2],
      ['redo from concept 1', 1],
      ['switch to concept 2', 2],
      ['change to concept 3', 3],
      ['swap to 1', 1],
      ['use concept 2 instead', 2],
      ['go with concept 3 instead', 3],
      ['please rebuild from concept 2', 2],
      ['rebuild from concept 2, thanks', 2],
    ] as const) {
      assert.equal(parseRevisionRequest(text), expected, text);
    }
  });

  it('NEVER reads an ordinary approval or selection as a rebuild request', () => {
    // THE LOAD-BEARING TEST. Every one of these is something a satisfied buyer
    // plausibly writes after delivery, and several of them are exactly what
    // `parseSelection` is built to accept.
    for (const text of [
      'concept 2',
      '#2',
      '2',
      'we love concept 2',
      "I'll take concept 2",
      'go with concept 2',
      'use concept 2',
      'make it concept 2',
      'my choice is concept 2',
      'yes, concept 2 please',
      'concept 2, thanks',
      'perfect, thank you',
      'looks great',
    ]) {
      assert.equal(parseRevisionRequest(text), null, text);
    }
  });

  it('accepts NOTHING that `parseSelection` accepts — the vocabularies cannot overlap', () => {
    // Driven off `parseSelection` itself rather than a hand-written list, so a
    // future widening of the SELECTION parser cannot silently start triggering
    // paid rebuilds. Any string both parsers read is a defect by construction.
    const probes = [
      'concept 1',
      'concept 2',
      'concept 3',
      '#3',
      '1',
      'yes, concept 2',
      "we'll take concept 3",
      'let’s go with concept 1',
      'my pick is concept 2',
      'give me concept 3 please',
      'pick 2',
      'choose concept 1',
      'use concept 2',
      'make it 3',
    ];
    const overlap = probes.filter(
      (text) => parseSelection(text) !== null && parseRevisionRequest(text) !== null,
    );
    assert.deepEqual(overlap, [], 'a string both parsers read would rebuild on an approval');
    // Non-vacuity: the probe list really is full of things the selection
    // parser reads, so the empty overlap above means something.
    assert.ok(
      probes.filter((text) => parseSelection(text) !== null).length >= 12,
      'the probe list must actually be selectable, or the overlap check is vacuous',
    );
  });

  it('rejects a rebuild request wrapped in anything it does not recognize', () => {
    for (const text of [
      "don't rebuild from concept 2",
      'no need to rebuild from concept 2',
      'should I rebuild from concept 2?',
      'rebuild from concept 2 but make it blue',
      'can you rebuild from concept 2 and change the font',
      'why did you rebuild from concept 2',
      '> rebuild from concept 2',
      'rebuild from concept 2 or concept 3',
      'use concept 2', // the `instead` marker is what makes it a rebuild
      'rebuild',
      'rebuild from concept 4',
      'rebuild from concept 0',
    ]) {
      assert.equal(parseRevisionRequest(text), null, text);
    }
  });

  it('never throws, whatever it is handed', () => {
    for (const value of [null, undefined, 42, {}, [], Symbol('x'), 'rebuild from concept 2']) {
      assert.doesNotThrow(() => parseRevisionRequest(value as unknown));
    }
  });
});

describe('findRevisionRequestIn', () => {
  const msg = (id: string, senderId: string, body: string): ThreadMessage => ({
    id,
    senderId,
    body,
    createdAt: '2026-08-01T00:00:00.000Z',
  });
  const ALL = new Set([1, 2, 3]);

  it('excludes the bot’s own messages, whatever they happen to say', () => {
    // THE FIXTURE MUST PARSE, or this test proves nothing. The first version of
    // it used the bot's real note wording ("Reply with `rebuild from concept
    // 2`..."), which `parseRevisionRequest` correctly returns null for on its
    // own — so deleting the sender filter entirely left the test green. That is
    // the vacuous-test failure this project keeps finding, and it was caught
    // here by mutation, not by reading.
    //
    // Asserted inline: the body really is a rebuild command, so the sender
    // filter is the ONLY thing that can be suppressing it.
    assert.equal(parseRevisionRequest('rebuild from concept 2'), 2);
    const found = findRevisionRequestIn(
      [msg('m0', 'bot-1', 'rebuild from concept 2')],
      'bot-1',
      ALL,
    );
    assert.deepEqual(found, { requested: null, unavailable: null });
    // Positive control: the identical body from the BUYER is read.
    assert.equal(
      findRevisionRequestIn([msg('m0', 'buyer', 'rebuild from concept 2')], 'bot-1', ALL).requested,
      2,
    );
  });

  it('scans past a request naming an undelivered concept and reports it separately', () => {
    const found = findRevisionRequestIn(
      [msg('m1', 'buyer', 'rebuild from concept 3'), msg('m2', 'buyer', 'rebuild from concept 2')],
      'bot-1',
      new Set([1, 2]),
    );
    assert.deepEqual(found, { requested: 2, unavailable: 3 });
  });

  it('takes the FIRST usable request, matching claimRevision’s first-write-wins', () => {
    const found = findRevisionRequestIn(
      [msg('m1', 'buyer', 'rebuild from concept 3'), msg('m2', 'buyer', 'rebuild from concept 2')],
      'bot-1',
      ALL,
    );
    // Inline, so a parser change that drained either fixture fails loudly here
    // rather than turning this into a tautology.
    assert.equal(parseRevisionRequest('rebuild from concept 3'), 3);
    assert.equal(parseRevisionRequest('rebuild from concept 2'), 2);
    assert.equal(found.requested, 3);
  });
});
