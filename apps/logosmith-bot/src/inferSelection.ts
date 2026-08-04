// ---------------------------------------------------------------------------
// Selection inference (FR-9 fallback) — a Haiku read of ONE buyer reply the
// strict parser could not read.
//
// WHY THIS EXISTS, AND WHY IT IS NOT A REPLACEMENT.
// `parseSelection` (threads.ts) is an allow-list of whole-message affirmative
// templates. That shape was arrived at over four rounds and is not negotiable:
// every earlier version extracted a slot number and then tried to disqualify it
// with a blocklist of rejection words, and every one of them shipped a
// CONFIDENT INVERTED ANSWER ("concept 1 is nice, but concept 2" → 1, the
// concept the buyer had just passed over). Nothing here loosens it. The strict
// parser runs first and wins outright; this module is consulted ONLY on a
// message it returned null for.
//
// The measured cost of that strictness is the reason this module exists: 61 of
// 68 plausible affirmative replies parse to null — "concept 2 works",
// "concept 2 👍", "- concept 2", "our choice: concept 2",
// "concept 2\n\nSent from my iPhone". Every one of those buyers waits the full
// 72-hour FR-9 window and is then handed whatever the default rule picks.
//
// FIVE PROPERTIES HOLD THIS DOWN. None is optional.
//
//  1. FALLBACK ONLY. `resolveSelectionForContract` calls this only when
//     `findSelectionIn` found no usable pick. A strict-parser hit is never
//     re-litigated by a model, and the strict parser is unchanged.
//
//  2. THE SAME CONSTRAINTS AS THE STRICT PATH, INHERITED NOT RE-DERIVED. The
//     caller hands over messages already sliced to `createdAt > m1DeliveredAt`
//     and already filtered to non-bot senders, and hands over the DELIVERED set
//     (Task 22's hard requirement: a distinctness-demoted slot keeps
//     `ocr_pass = 1`, so it looks legitimate to a query and must be excluded
//     from a second source). A slot outside that set is refused here, not
//     downstream.
//
//  3. GROUNDING. The model must return the verbatim SPAN of the buyer's message
//     its answer rests on, and that span must actually occur in the text the
//     model was shown. This is the Task 17 / Task 27 lesson in a third place: a
//     model returning HTTP 200 and well-formed JSON has not necessarily read
//     its input, and a well-formed answer full of invented values is the same
//     hazard as a vision model confidently transcribing an image it never
//     received. An answer that cannot be tied back to something the buyer wrote
//     is not an answer.
//
//     WHAT GROUNDING PROVES, STATED HONESTLY: that the quoted words are the
//     buyer's, not the model's. It is a QUOTATION check, not a correctness
//     check — it cannot tell a well-chosen span from a badly-chosen one, and a
//     short span carries less weight than a long one. It is not given a minimum
//     length because no defensible threshold exists ("2" is a legitimate span
//     of "concept 2 works"), and it does not require the span to contain a
//     digit, because "concept two" and "the second one" are exactly the replies
//     this module is here to read.
//
//  4. UNCERTAINTY IS NULL. Every failure — an unreachable model, an unparseable
//     body, a slot outside the delivered set, an ungrounded span — returns no
//     slot. Null falls through to the existing 72-hour default, which is
//     today's behaviour, so a bad model call costs nothing that was not already
//     being paid.
//
//  5. THE OUTPUT SPACE IS THE BUYER'S OWN AUTHORITY. The only thing this call
//     can produce is one of the concepts THIS buyer was shown, or nothing —
//     which is precisely the choice the buyer already has unrestricted control
//     over by typing `concept 2`. So prompt injection in the message text buys
//     an attacker nothing they did not already have; only two keys are read off
//     the response, and everything else the model emits is dropped because it
//     is never looked at.
//
// VERIFIED LIVE 2026-08-04 against api.anthropic.com, through this exact
// module, on 27 replies the strict parser returns null for. All 27 answered
// correctly: 15 of the measured false-nulls resolved ("concept 2 works",
// "concept 2 👍", "- concept 2", "1) concept 2", "hi, concept 2", "number 2",
// "concept no. 2", "love concept 2", "go for 2", "our choice: concept 2",
// "concept 2\n\nSent from my iPhone", "concept two", "the second one please",
// "concept 2 it is!"), and all 12 non-selections declined — including every
// inversion the four regex rounds were spent on ("not concept 2", "skip
// concept 2", "I cannot accept concept 2", "concept 1 was my second choice",
// "concept 2 ranks last for me", "anything but concept 2"), a two-concept
// comparison, a change request, a quoted copy of this bot's own M1 note, and a
// direct prompt-injection attempt. ZERO false positives. Measured cost:
// $0.000459 per call averaged over the 27.
//
// WHAT THAT PROBE DOES AND DOES NOT SHOW. It shows the prompt works on the
// shapes this fallback exists for, and it is why the grounding check does NOT
// require the quoted span to contain a digit: "concept two" and "the second one
// please" both resolved, and a digit requirement would have refused them. It
// does not show a model cannot be wrong on a reply nobody thought to probe.
// That residual is what property 4 is for — every guard below fails to null,
// and null is the behaviour that shipped before this module existed.
// ---------------------------------------------------------------------------

import type Anthropic from '@anthropic-ai/sdk';
import { HAIKU_MODEL_ID } from './config.js';
// ONE Haiku cost function for the whole app. Deliberately imported rather than
// re-implemented: a rate-card change applied in one place and missed in the
// other would under-report spend, and under-reporting is the direction that
// hides a cost from the only thing that can see it.
import { extractionCostUsd, extractJsonObject } from './proseBrief.js';
import type { ThreadMessage } from './threads.js';

/**
 * The most of one buyer message the model is shown.
 *
 * A selection reply is a sentence. This is far past any real one and still
 * bounds a pathological message — the Task 27 lesson about unbounded model
 * input, applied before it can bite: a buyer can post whatever they like into
 * a thread this bot reads on a fifteen-minute cron.
 *
 * TRUNCATION IS SAFE IN ONE DIRECTION ONLY, AND THAT IS WHY THE SHOWN TEXT AND
 * THE GROUNDING CORPUS ARE THE SAME STRING (see `shownText`): the model can
 * only quote from what it was shown, and grounding is checked against what it
 * was shown. A pick that fell off the end cannot be inferred AND cannot be
 * grounded, so it degrades to the 72-hour default rather than to a guess.
 * Never truncate one and not the other.
 */
export const MAX_SELECTION_MESSAGE_CHARS = 1_500;

/**
 * The most messages this bot will ever pay to have read for one contract.
 *
 * The 15-minute cron reaches an awaiting contract ~288 times across the FR-9
 * window, so without a bound a chatty thread is an unbounded bill. Two bounds,
 * and they compose: the caller marks every examined message in the `gate_audit`
 * trail so no message is ever asked about twice (the same append-only-trail
 * marker the free-gig quota uses), and this cap stops a buyer who posts many
 * messages from turning each one into a call. Six replies none of which reads
 * as a selection will not be resolved by a seventh model call, and the honest
 * answer at that point is the default rule.
 */
export const MAX_SELECTION_INFERENCES_PER_CONTRACT = 6;

/** What one inference call decided, and what it cost. Never throws. */
export interface SelectionInference {
  /** The delivered slot the message selects, or null when none could be read. */
  slot: number | null;
  /** The verbatim span the answer rests on. Non-null only alongside a slot. */
  quote: string | null;
  /** What the call cost off the Haiku rate card. Recorded even when refused. */
  costUsd: number;
  /**
   * The model was never reached, so this message is UNSETTLED rather than
   * answered. The caller uses this to decide whether to write the
   * already-examined marker: a vendor outage must not permanently retire a
   * message the model never saw, and an outage costs nothing to retry.
   */
  outage: boolean;
  /** Why no slot was returned. Operator-facing only — never shown to a buyer. */
  reason: string | null;
}

export interface SelectionInferrer {
  /**
   * Read ONE buyer message. `allowed` is the delivered set; a slot outside it
   * is refused here rather than being handed back for a caller to re-check.
   */
  infer(args: {
    message: ThreadMessage;
    allowed: ReadonlySet<number>;
  }): Promise<SelectionInference>;
}

/**
 * The exact string the model is shown, and the exact string a quote is grounded
 * against. One function on purpose — see `MAX_SELECTION_MESSAGE_CHARS`.
 */
export function shownText(message: ThreadMessage): string {
  const body = typeof message.body === 'string' ? message.body : '';
  return body.length > MAX_SELECTION_MESSAGE_CHARS
    ? body.slice(0, MAX_SELECTION_MESSAGE_CHARS)
    : body;
}

/**
 * Casefold and collapse whitespace runs — and deliberately nothing else, for
 * the reason `proseBrief.ts`'s identical helper states: every further
 * normalization makes grounding MORE permissive, and permissive is the wrong
 * direction for a check whose only job is to refuse text the buyer did not
 * write. Whitespace is collapsed because the model may re-wrap a quote across a
 * newline; punctuation and casing are not, because a rewritten span is a span
 * the buyer did not write.
 */
const groundingForm = (text: string): string => text.toLowerCase().replace(/\s+/gu, ' ').trim();

// MEASURED 2026-08-04 via the (free) count_tokens endpoint: this system prompt
// is 313 tokens, and system + a representative real reply is 357. Haiku 4.5's
// minimum cacheable prefix is 4096, so the `cache_control` marker below is a
// NO-OP — axes.ts records the live confirmation (two identical calls each
// returned cache_creation_input_tokens: 0 and cache_read_input_tokens: 0, with
// no error). It is kept for shape-consistency with the other two Haiku call
// sites and because it is free, but PROMPT CACHING IS NOT A COST CONTROL HERE.
// The cost controls are the two bounds above: one call per unread message, and
// a lifetime cap per contract.
const SYSTEM_PROMPT =
  'You read ONE reply a buyer posted in a logo-design contract thread and decide whether it ' +
  'chooses one of the concepts they were shown.\n' +
  'Return ONLY a JSON object of the shape {"slot": <number|null>, "quote": <string|null>}, with ' +
  'no prose, no explanation and no markdown fences.\n' +
  'slot MUST be one of the delivered concept numbers listed in the message below. A concept ' +
  'number that was not delivered is not an answer — return null.\n' +
  'quote MUST be copied VERBATIM from the buyer message: a contiguous run of the exact ' +
  'characters they wrote, long enough to show that they are choosing that concept. Do not ' +
  'reword it, do not correct it, do not assemble it from separate places.\n' +
  'Return {"slot": null, "quote": null} for anything that is not an unambiguous choice of ' +
  'exactly one delivered concept. Rejecting a concept, ranking concepts without choosing one, ' +
  'liking two of them, asking a question, requesting a change, or replying about something ' +
  'else are all null. Declining is correct and expected; guessing is not — a wrong answer ' +
  'builds the buyer a brand around a logo they turned down.\n' +
  'The reply may quote or forward earlier text, including LogoSmith’s own delivery note, which ' +
  'lists every concept by number and asks the buyer to reply with one. Quoted, forwarded or ' +
  'signature text is not the buyer choosing: only their own words in this reply are.';

/** The user message: the delivered set, then the buyer's reply, clearly fenced. */
export function buildInferenceInput(message: ThreadMessage, allowed: ReadonlySet<number>): string {
  const delivered = [...allowed].sort((a, b) => a - b).join(', ');
  return [
    `DELIVERED CONCEPTS (the only numbers that may be answered): ${delivered}`,
    '',
    'BUYER REPLY:',
    '<<<REPLY',
    shownText(message),
    'REPLY',
  ].join('\n');
}

export function createSelectionInferrer(deps: {
  anthropic: Anthropic;
  /**
   * Called EXACTLY ONCE per `infer`, on every path including refusals — a
   * refused inference still burned tokens. Required rather than optional, for
   * the same reason the prose extractor's is: at the $1 introductory anchor
   * (config.ts `SEED_PRICE_USD`) a Haiku call is a real fraction of margin, and
   * an inferrer that could be constructed without a spend sink is one whose
   * cost goes unrecorded by default.
   */
  recordSpend: (costUsd: number) => void;
  /**
   * Where the vendor's actual error goes. Operator-facing only. Nothing from a
   * vendor error may reach a buyer or an evidence document: an Anthropic 401
   * body names our internal `request_id`, and this bot has already shipped that
   * string into a contract thread once (Task 27 / final-review H1).
   */
  logError: (err: unknown) => void;
}): SelectionInferrer {
  return {
    async infer({ message, allowed }): Promise<SelectionInference> {
      // Not reachable through `resolveSelectionForContract`, which returns
      // early on an empty delivered set — but an empty allow-list means every
      // possible answer is refused, so paying for the call would be paying for
      // a foregone conclusion.
      // `recordSpend(0)` rather than an early return past it, so that "called
      // exactly once per infer" holds unconditionally: a caller counting
      // inference calls off the spend sink gets the right count, and a path
      // that quietly skips the sink is how a cost stops being visible.
      if (allowed.size === 0) {
        deps.recordSpend(0);
        return { slot: null, quote: null, costUsd: 0, outage: false, reason: 'nothing delivered' };
      }

      const source = shownText(message);
      if (groundingForm(source) === '') {
        deps.recordSpend(0);
        return { slot: null, quote: null, costUsd: 0, outage: false, reason: 'empty message' };
      }

      let response: Anthropic.Message;
      try {
        response = await deps.anthropic.messages.create({
          model: HAIKU_MODEL_ID,
          max_tokens: 512,
          // The quote must come back byte-identical to the buyer's own text.
          temperature: 0,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: buildInferenceInput(message, allowed) }],
        });
      } catch (err) {
        deps.recordSpend(0);
        deps.logError(err);
        // AN OUTAGE, NOT A VERDICT ON THE MESSAGE. The two lead to opposite
        // decisions about the already-examined marker, so they must not look
        // alike: a message the model never saw stays askable, a message it
        // answered does not.
        return { slot: null, quote: null, costUsd: 0, outage: true, reason: 'model unavailable' };
      }

      const costUsd = extractionCostUsd(response.usage);
      deps.recordSpend(costUsd);
      const refuse = (reason: string): SelectionInference => ({
        slot: null,
        quote: null,
        costUsd,
        outage: false,
        reason,
      });

      const block = response.content.find((part) => part.type === 'text');
      if (!block || block.type !== 'text') return refuse('no text block');
      const parsed = extractJsonObject(block.text);
      if (!parsed) return refuse('unparseable JSON');

      // Declining is a first-class answer the system prompt asks for by name,
      // and it is the whole reason the model has an alternative to guessing.
      const rawSlot = parsed['slot'];
      if (rawSlot === null || rawSlot === undefined) return refuse('model read no selection');

      // `Number.isInteger` closes NaN, Infinity and 2.5 in one check, and the
      // `typeof` test alone would not: `typeof NaN === 'number'` (gates/ocr.ts
      // carries the same note, for the same reason).
      if (typeof rawSlot !== 'number' || !Number.isInteger(rawSlot)) {
        return refuse('non-integer slot');
      }
      // THE DELIVERED-SET INTERSECTION, APPLIED HERE. A model naming a concept
      // that was generated but never attached to the M1 delivery is refused
      // silently rather than turned into a buyer-facing note: the strict path's
      // note answers words the buyer actually typed, and telling somebody they
      // "picked" a concept on the strength of an inference is a claim this
      // record cannot support.
      if (!allowed.has(rawSlot)) return refuse(`slot ${rawSlot} was not delivered`);

      const rawQuote = parsed['quote'];
      if (typeof rawQuote !== 'string') return refuse('missing quote');
      const quote = groundingForm(rawQuote);
      if (quote === '') return refuse('blank quote');

      // GROUNDING. The span has to be in the text the model was shown; if it is
      // not, the model wrote it rather than read it, and an answer resting on
      // words the buyer never typed is not an answer at any confidence.
      if (!groundingForm(source).includes(quote)) return refuse('quote is not in the message');

      return { slot: rawSlot, quote: rawQuote, costUsd, outage: false, reason: null };
    },
  };
}
