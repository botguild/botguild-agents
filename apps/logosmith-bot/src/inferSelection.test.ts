// The FR-9 Haiku selection fallback (Task 28).
//
// EVERY TEST HERE DOUBLES THE ANTHROPIC CLIENT EXPLICITLY, and that is not
// tidiness. The SDK issues its requests through the GLOBAL `fetch`, which an
// injected `fetchImpl` does NOT intercept — two harnesses in this app were
// silently dialling api.anthropic.com for exactly that reason, one of them
// presenting a 401 body to a buyer as a brief-validation failure. There is no
// path in this file that constructs an inferrer without a double.
//
// The other discipline on show: several fixtures assert INLINE that
// `parseSelection` really does return null for the reply under test. This
// module only ever runs on messages the strict parser refused, so a test whose
// fixture the parser CAN read is testing nothing — and this project has already
// watched three tests go vacuous through nothing but a parser tightening
// changing what their fixture strings parse to.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInferenceInput,
  createSelectionInferrer,
  MAX_SELECTION_INFERENCES_PER_CONTRACT,
  MAX_SELECTION_MESSAGE_CHARS,
  shownText,
  type SelectionInference,
} from './inferSelection.js';
import { HAIKU_MODEL_ID, HAIKU_PRICING_PER_MTOK, SEED_PRICE_USD } from './config.js';
import { parseSelection, type ThreadMessage } from './threads.js';

const DELIVERED = new Set([1, 2]);

const buyerMessage = (body: string, id = 'msg-1'): ThreadMessage => ({
  id,
  senderId: 'handler-buyer',
  body,
  createdAt: '2026-07-31T10:00:00.000Z',
});

/** A reply the strict parser genuinely cannot read — asserted, not assumed. */
const UNPARSEABLE_PICK = 'concept 2 works for us, thanks!';
assert.equal(
  parseSelection(UNPARSEABLE_PICK),
  null,
  'the fixture must be a reply the strict parser refuses, or this module would never see it',
);

interface Captured {
  model: string;
  temperature: number;
  max_tokens: number;
  system: unknown;
  messages: Array<{ role: string; content: string }>;
}

/** An Anthropic double shaped like the real `messages.create` response. */
function fakeAnthropic(
  text: string,
  usage: Record<string, number> = { input_tokens: 700, output_tokens: 25 },
): { anthropic: unknown; sent: Captured[] } {
  const sent: Captured[] = [];
  return {
    sent,
    anthropic: {
      messages: {
        create: async (body: Captured) => {
          sent.push(body);
          return { content: [{ type: 'text', text }], usage };
        },
      },
    },
  };
}

const throwingAnthropic = (err: unknown): unknown => ({
  messages: {
    create: async () => {
      throw err;
    },
  },
});

function inferrerOver(anthropic: unknown): {
  infer: (message: ThreadMessage, allowed?: Set<number>) => Promise<SelectionInference>;
  spend: number[];
  logged: unknown[];
} {
  const spend: number[] = [];
  const logged: unknown[] = [];
  const inferrer = createSelectionInferrer({
    anthropic: anthropic as never,
    recordSpend: (usd) => spend.push(usd),
    logError: (err) => logged.push(err),
  });
  return {
    spend,
    logged,
    infer: (message, allowed = DELIVERED) => inferrer.infer({ message, allowed }),
  };
}

const reply = (slot: unknown, quote: unknown): string => JSON.stringify({ slot, quote });

// ===============================================================================
// The input the model is shown — and the corpus a quote is grounded against
// ===============================================================================

describe('buildInferenceInput', () => {
  it('shows the delivered concepts and the buyer reply, and nothing else', () => {
    const input = buildInferenceInput(buyerMessage(UNPARSEABLE_PICK), DELIVERED);

    assert.match(input, /DELIVERED CONCEPTS[^\n]*1, 2/);
    assert.ok(input.includes(UNPARSEABLE_PICK), 'the reply itself');
    // No thread, no other messages, no contract metadata: one message in, one
    // decision out, which is what makes a quote have exactly one message it can
    // have come from.
    assert.ok(!input.includes('handler-buyer'), 'no sender identity');
    assert.ok(!input.includes('2026-07-31'), 'no timestamps');
  });

  it('lists the delivered set in slot order however the caller built it', () => {
    const input = buildInferenceInput(buyerMessage('x'), new Set([3, 1]));
    assert.match(input, /DELIVERED CONCEPTS[^\n]*1, 3/);
  });

  it('is pure — same message in, same string out, no network', () => {
    const message = buyerMessage(UNPARSEABLE_PICK);
    assert.equal(buildInferenceInput(message, DELIVERED), buildInferenceInput(message, DELIVERED));
  });
});

describe('shownText — the bound on model input', () => {
  it('truncates an oversized message to the documented cap', () => {
    const long = 'a'.repeat(MAX_SELECTION_MESSAGE_CHARS + 500);
    assert.equal(shownText(buyerMessage(long)).length, MAX_SELECTION_MESSAGE_CHARS);
  });

  it('leaves a real-sized reply untouched', () => {
    assert.equal(shownText(buyerMessage(UNPARSEABLE_PICK)), UNPARSEABLE_PICK);
  });

  it('survives a body that is not a string, as a soft-deleted message can be', () => {
    assert.equal(shownText({ ...buyerMessage('x'), body: null as never }), '');
  });
});

// ===============================================================================
// The happy path
// ===============================================================================

describe('createSelectionInferrer — reading a reply the strict parser refuses', () => {
  it('reads the pick and returns the buyer’s own words behind it', async () => {
    const { anthropic } = fakeAnthropic(reply(2, 'concept 2 works for us'));
    const { infer } = inferrerOver(anthropic);

    const result = await infer(buyerMessage(UNPARSEABLE_PICK));

    assert.equal(result.slot, 2);
    assert.equal(result.quote, 'concept 2 works for us');
    assert.equal(result.outage, false);
    assert.equal(result.reason, null);
    // The quote is the buyer's, not the model's: it occurs in their message.
    assert.ok(UNPARSEABLE_PICK.includes(result.quote!));
  });

  it('sends the pinned Haiku model at temperature 0, with the reply as the user turn', async () => {
    const { anthropic, sent } = fakeAnthropic(reply(1, 'go for 1'));
    const { infer } = inferrerOver(anthropic);

    await infer(buyerMessage('go for 1'));

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.model, HAIKU_MODEL_ID);
    assert.equal(sent[0]!.temperature, 0, 'a quote must come back byte-identical');
    assert.equal(sent[0]!.messages.length, 1);
    assert.ok(sent[0]!.messages[0]!.content.includes('go for 1'));
  });

  it('grounds a quote the model re-wrapped across a newline', async () => {
    // Casefold + whitespace-collapse and NOTHING else: a model that folded the
    // quote onto one line still quoted the buyer, so this must pass.
    const body = 'our choice:\n  concept 2';
    assert.equal(parseSelection(body), null, 'fixture precondition: strict parser refuses it');
    const { anthropic } = fakeAnthropic(reply(2, 'Our choice: concept 2'));
    const { infer } = inferrerOver(anthropic);

    assert.equal((await infer(buyerMessage(body))).slot, 2);
  });

  it('reads a JSON object out of a fenced or chatty response', async () => {
    const { anthropic } = fakeAnthropic('```json\n' + reply(2, 'concept 2 works for us') + '\n```');
    const { infer } = inferrerOver(anthropic);
    assert.equal((await infer(buyerMessage(UNPARSEABLE_PICK))).slot, 2);
  });
});

// ===============================================================================
// GROUNDING — an answer that cannot be tied to the buyer's words is no answer
// ===============================================================================

describe('createSelectionInferrer — grounding', () => {
  it('refuses a well-formed answer whose quote is not in the message', async () => {
    // The hazard this exists for, in its purest form: HTTP 200, valid JSON, a
    // slot inside the delivered set — and a span the buyer never wrote. Exactly
    // the Task 17 vision model confidently transcribing an image it never got.
    const { anthropic } = fakeAnthropic(reply(2, 'I choose concept 2'));
    const { infer } = inferrerOver(anthropic);

    const result = await infer(buyerMessage(UNPARSEABLE_PICK));

    assert.equal(result.slot, null);
    assert.equal(result.quote, null);
    assert.equal(result.reason, 'quote is not in the message');
  });

  it('refuses a PARAPHRASE of what the buyer wrote', async () => {
    const { anthropic } = fakeAnthropic(reply(2, 'concept 2 is fine for us'));
    const { infer } = inferrerOver(anthropic);
    assert.equal((await infer(buyerMessage(UNPARSEABLE_PICK))).slot, null);
  });

  it('refuses a quote from beyond the truncation point of an oversized message', async () => {
    // The model is shown exactly the string grounding is checked against, so a
    // pick that fell off the end can be neither extracted nor grounded — it
    // degrades to the 72-hour default rather than to a guess.
    const hidden = 'concept 2 please';
    const body = 'x'.repeat(MAX_SELECTION_MESSAGE_CHARS) + hidden;
    const { anthropic, sent } = fakeAnthropic(reply(2, hidden));
    const { infer } = inferrerOver(anthropic);

    const result = await infer(buyerMessage(body));

    assert.ok(!sent[0]!.messages[0]!.content.includes(hidden), 'the model never saw it');
    assert.equal(result.slot, null, 'and could not have grounded it if it had guessed');
  });

  it('refuses a missing, non-string or blank quote', async () => {
    for (const quote of [undefined, null, 42, '', '   ']) {
      const { anthropic } = fakeAnthropic(reply(2, quote));
      const { infer } = inferrerOver(anthropic);
      const result = await infer(buyerMessage(UNPARSEABLE_PICK));
      assert.equal(result.slot, null, `quote ${JSON.stringify(quote)} must not select`);
    }
  });
});

// ===============================================================================
// The same constraints as the strict path
// ===============================================================================

describe('createSelectionInferrer — the delivered-set intersection', () => {
  it('refuses a perfectly grounded pick for a concept that was never delivered', async () => {
    // A distinctness-demoted slot keeps `ocr_pass = 1`, so nothing about its row
    // looks wrong to a query — the delivered set is the only thing that knows.
    // The quote here IS in the message, so the intersection is the only guard
    // that can be doing the work.
    const body = 'concept 3 works for us';
    assert.equal(parseSelection(body), null, 'fixture precondition');
    const { anthropic } = fakeAnthropic(reply(3, 'concept 3 works for us'));
    const { infer } = inferrerOver(anthropic);

    const result = await infer(buyerMessage(body));

    assert.equal(result.slot, null);
    assert.equal(result.reason, 'slot 3 was not delivered');
  });

  it('never calls the model at all when nothing was delivered', async () => {
    const { anthropic, sent } = fakeAnthropic(reply(1, 'concept 1'));
    const { infer, spend } = inferrerOver(anthropic);

    const result = await infer(buyerMessage('concept 1 works'), new Set());

    assert.equal(result.slot, null);
    assert.deepEqual(sent, [], 'paying for a foregone conclusion is still paying');
    assert.deepEqual(spend, [0]);
  });

  it('never calls the model for an empty or whitespace-only message', async () => {
    for (const body of ['', '   \n\t ']) {
      const { anthropic, sent } = fakeAnthropic(reply(1, 'x'));
      const { infer } = inferrerOver(anthropic);
      assert.equal((await infer(buyerMessage(body))).slot, null);
      assert.deepEqual(sent, []);
    }
  });
});

// ===============================================================================
// Uncertainty resolves to null, always
// ===============================================================================

describe('createSelectionInferrer — every uncertain answer is null', () => {
  it('accepts the declined answer as a first-class result', async () => {
    const { anthropic } = fakeAnthropic(reply(null, null));
    const { infer, spend } = inferrerOver(anthropic);

    const result = await infer(buyerMessage('when can we see more options?'));

    assert.equal(result.slot, null);
    assert.equal(result.reason, 'model read no selection');
    assert.equal(result.outage, false, 'a decline is an ANSWER — the message is settled');
    assert.equal(spend.length, 1, 'and it still burned tokens');
  });

  it('refuses a slot that is not a whole number, NaN included', async () => {
    // `typeof NaN === 'number'`, which is why the guard is Number.isInteger and
    // not a typeof test — the same note gates/ocr.ts carries.
    for (const slot of ['2', 2.5, true, [2], { slot: 2 }, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { anthropic } = fakeAnthropic(reply(slot, 'concept 2 works for us'));
      const { infer } = inferrerOver(anthropic);
      const result = await infer(buyerMessage(UNPARSEABLE_PICK));
      assert.equal(result.slot, null, `slot ${JSON.stringify(slot)} must not select`);
    }
  });

  it('refuses an unparseable body, and a response with no text block', async () => {
    const cases: Array<[unknown, string]> = [
      [fakeAnthropic('not json at all').anthropic, 'unparseable JSON'],
      [fakeAnthropic('{"slot": 2, ').anthropic, 'unparseable JSON'],
      [fakeAnthropic('[1,2,3]').anthropic, 'unparseable JSON'],
      [
        { messages: { create: async () => ({ content: [], usage: { input_tokens: 10 } }) } },
        'no text block',
      ],
    ];
    for (const [anthropic, reason] of cases) {
      const { infer, spend } = inferrerOver(anthropic);
      const result = await infer(buyerMessage(UNPARSEABLE_PICK));
      assert.equal(result.slot, null);
      assert.equal(result.reason, reason);
      assert.equal(spend.length, 1, 'a refused call still burned tokens');
    }
  });
});

// ===============================================================================
// An outage is not a verdict
// ===============================================================================

describe('createSelectionInferrer — the model was never reached', () => {
  it('reports an outage, costs nothing, and keeps the vendor error out of the result', async () => {
    const vendorError = new Error('401 {"request_id":"req_internal_abc"}');
    const { infer, spend, logged } = inferrerOver(throwingAnthropic(vendorError));

    const result = await infer(buyerMessage(UNPARSEABLE_PICK));

    assert.equal(result.slot, null);
    assert.equal(result.outage, true, 'UNSETTLED, not answered — the caller must not retire it');
    assert.equal(result.costUsd, 0);
    assert.deepEqual(spend, [0]);
    assert.deepEqual(logged, [vendorError], 'the real error goes operator-side, and only there');
    // This bot has already shipped an Anthropic request_id into a buyer's
    // thread once. Nothing structured here may carry one.
    assert.ok(!JSON.stringify(result).includes('req_internal_abc'));
  });

  it('distinguishes an outage from a decline, because they lead to opposite decisions', async () => {
    const declined = await inferrerOver(fakeAnthropic(reply(null, null)).anthropic).infer(
      buyerMessage('hello there'),
    );
    const down = await inferrerOver(throwingAnthropic(new Error('503'))).infer(
      buyerMessage('hello there'),
    );

    assert.equal(declined.slot, down.slot, 'both refuse to select');
    assert.notEqual(declined.outage, down.outage, 'and they must not look alike');
  });
});

// ===============================================================================
// The bill
// ===============================================================================

describe('createSelectionInferrer — spend', () => {
  it('books the call off the shipped Haiku rate card, on every path', async () => {
    const { anthropic } = fakeAnthropic(reply(2, 'concept 2 works for us'), {
      input_tokens: 700,
      output_tokens: 25,
    });
    const { infer, spend } = inferrerOver(anthropic);

    const result = await infer(buyerMessage(UNPARSEABLE_PICK));

    const expected =
      (700 * HAIKU_PRICING_PER_MTOK.input + 25 * HAIKU_PRICING_PER_MTOK.output) / 1_000_000;
    assert.equal(result.costUsd, expected);
    assert.deepEqual(spend, [expected]);
  });

  it('stays a rounding error against the $1 anchor, even at the message cap', async () => {
    // The bound that matters is not one call, it is the total a contract can
    // ever be charged: the cap on messages read × the worst realistic call.
    // MAX_SELECTION_MESSAGE_CHARS is 1,500 characters, well under 512 input
    // tokens once the ~220-token system prompt is added; 512 in + 512 out (the
    // max_tokens ceiling) is a pessimistic upper bound on one call.
    const worstCall =
      (512 * HAIKU_PRICING_PER_MTOK.input + 512 * HAIKU_PRICING_PER_MTOK.output) / 1_000_000;
    const worstContract = worstCall * MAX_SELECTION_INFERENCES_PER_CONTRACT;

    assert.ok(
      worstContract < SEED_PRICE_USD * 0.03,
      `the lifetime fallback bill for one contract ($${worstContract.toFixed(4)}) must stay ` +
        `under 3% of the $${SEED_PRICE_USD.toFixed(2)} anchor`,
    );
  });

  it('records exactly one spend entry per call, whatever the answer', async () => {
    for (const text of [reply(2, 'concept 2 works for us'), reply(null, null), 'garbage']) {
      const { infer, spend } = inferrerOver(fakeAnthropic(text).anthropic);
      await infer(buyerMessage(UNPARSEABLE_PICK));
      assert.equal(spend.length, 1);
    }
  });
});
