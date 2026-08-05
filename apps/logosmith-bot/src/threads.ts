// Contract-thread reading (PRD FR-9): the buyer's concept pick arrives as a
// thread reply after M1 delivery, and AgentClient only writes messages — so
// this module reads them directly off the platform REST API, with the same
// auth + casing conventions as voicewright-bot/jiffyapp-bot's threads.ts
// (X-API-Key, mapKeysToCamel). Consumed by Task 22's 15-min selection poll
// and by the milestone.accepted / acceptance.auto_approved webhook handlers
// — both resolve through resolveSelectionForContract, which reads the
// thread through this module.

import { mapKeysToCamel } from '@botguild/agent-core';
import type { FetchLike } from './types.js';

/** A contract-thread message, in the shape this module's callers need. */
export interface ThreadMessage {
  id: string;
  senderId: string;
  body: string;
  createdAt: string;
}

export interface ThreadReaderDeps {
  apiUrl: string;
  apiKey: string;
  fetchImpl: FetchLike;
}

export interface ThreadReader {
  /** Messages of the contract's thread, oldest first. [] when no thread yet. */
  listMessages(contractId: string): Promise<ThreadMessage[]>;
}

// The wire shape GET /threads/:id/messages actually returns (the platform's
// Message entity, mapKeysToCamel'd): the text lives in `content`, not
// `body`, and `senderId` is always the *handler* account that operates the
// sender — a bot-authored message is identified by `senderBotId`, which is
// null for anything a buyer posts. We fold both into ThreadMessage.senderId
// below (preferring senderBotId when present) so that findSelection's
// `message.senderId === botId` authorship check is correct for bot-authored
// messages. Get this mapping wrong and the bot's own M1 instruction becomes
// indistinguishable from a buyer reply again, just one layer removed from
// findSelection itself.
interface RawMessage {
  id: string;
  senderId: string;
  senderBotId?: string | null;
  content: string;
  createdAt: string;
}

export function createThreadReader(deps: ThreadReaderDeps): ThreadReader {
  const apiUrl = deps.apiUrl.replace(/\/$/, '');

  async function getJson<T>(path: string): Promise<T> {
    const response = await deps.fetchImpl(`${apiUrl}${path}`, {
      headers: { 'X-API-Key': deps.apiKey },
    });
    if (!response.ok) {
      throw new Error(`GET ${path} responded ${response.status}`);
    }
    return mapKeysToCamel(await response.json()) as T;
  }

  return {
    async listMessages(contractId: string): Promise<ThreadMessage[]> {
      const query = new URLSearchParams({ scope: 'contract', scopeId: contractId, limit: '1' });
      const threads = await getJson<{ threads?: Array<{ id: string }> }>(
        `/threads?${query.toString()}`,
      );
      const threadId = threads.threads?.[0]?.id;
      if (!threadId) return [];
      const res = await getJson<{ messages?: RawMessage[] }>(`/threads/${threadId}/messages`);
      return (res.messages ?? []).map((message) => ({
        id: message.id,
        senderId: message.senderBotId ?? message.senderId,
        body: message.content,
        createdAt: message.createdAt,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Selection parsing — whole-message affirmative templates.
//
// THE SHAPE OF THIS PARSER IS THE POINT. Read this before changing anything
// below it.
//
// Every earlier version of this module extracted a *positive* signal (a slot
// number, substring-matched anywhere in the message) and then tried to
// disqualify it with a blocklist of *negative* markers: first a per-match
// negation lookbehind window, then a whole-message negation-cue list. Both
// fail OPEN. English rejection vocabulary is unbounded — skip, veto, nope,
// hard pass, decline, "ranks last", "bottom choice", "no-go", "cannot
// accept", "never in a million years" — so every unlisted way of saying "not
// that one" produced a CONFIDENT WRONG SLOT, which is the one outcome this
// module exists to prevent. Three rounds of extending the list each bought
// exactly the strings that round enumerated and left the same hole.
//
// So the parser is inverted: it recognizes only affirmative *selection
// shapes*, and the ENTIRE trimmed message must be one of them. There is no
// rejection list at all, because there is nothing to reject — anything the
// templates do not recognize, in any position, is null by construction. The
// set of ways to reject a concept is infinite and not ours to enumerate; the
// set of ways to affirmatively pick one is small and is defined right here.
//
// The lists that remain (LEAD_IN, POLITE, AFFIRM) are still enumerations, but
// they fail CLOSED: an unlisted lead-in or an unlisted surrounding word yields
// null, never a guess. That asymmetry is the whole reason an allow-list is
// safe where a deny-list is not. Adding to them is fine; the rule for doing
// so is at the bottom of parseSelection's doc comment.
//
// The two structural guards earlier rounds got right are preserved, in
// stronger form:
//   - '#N' gating (was: an allow-list of the single preceding word). Now
//     '#N' is only recognized when the whole message is a template, so both
//     what precedes it AND what follows it are constrained. Every reference
//     number — "invoice #2", "PO #2", "SKU #2", "the meeting is #2 on the
//     agenda" — is denied without naming a single reference noun.
//   - Multi-slot ambiguity ("I like concept 1 and concept 2" is not a
//     choice). No longer a counting step, because a second slot mention
//     cannot survive the anchors: the text between two mentions is never a
//     lead-in or a politeness word, so the template simply does not match.
//     The behaviour is unchanged and still tested; only the mechanism is.
// ---------------------------------------------------------------------------

// Whitespace and decoration that may TRAIL a selection without being part of
// it. Excludes every letter and digit, so no content word can ever hide in
// here, and two deliberate omissions found by the round-5 adversarial pass:
//   - '(' ')' '[' ']', which turn emoticons into decoration: "concept 2 :("
//     parsed as a confident 2 while the buyer was visibly unhappy about it.
//     Sentiment is not something this parser can read, so a message carrying
//     any is not a clean selection. ":)" fails closed for the same reason —
//     that is the correct direction to be wrong in.
//   - no emoji or symbols of any kind, so "concept 2 👎" is null.
const SEP = String.raw`[\s.,;:!?'"\`\-–—…]`;

// Decoration that may LEAD a selection: the same set MINUS the dash family,
// and — like SEP — containing no '>'. Both omissions matter only here, since
// this is the only class that can sit in FRONT of a slot reference:
//   - a trailing dash is punctuation, but a leading one is a minus sign or a
//     negating bullet, and "-2" must not read as slot 2. The cost is that
//     "- concept 2" (a bulleted single-line reply) is null too.
//   - '>' is the email/chat quote marker, so it only ever appears at the head
//     of a quoted line. Keeping it out is what stops a buyer quoting the
//     bot's own "reply with `concept 1|2|3`" back at it from parsing as a
//     pick — "> concept 2" is null.
const LEAD_SEP = String.raw`[\s.,;:!?'"\`…]`;

// The only words allowed to sit beside a selection without being part of it:
// politeness, nothing else. 'best' is included because the locked test
// "we like #2 best" needs it; it is harmless because it can only appear
// where a message has already matched a selection shape.
//
// Note what is NOT here and therefore fails closed: "concept 2 for sure",
// "concept 2 it is", "concept 2, thanks so much". Those return null. Adding
// more politeness is a safe change (it can only turn nulls into picks, never
// change which slot a pick resolves to) — adding anything that is not purely
// phatic is not.
const POLITE = String.raw`(?:please|pls|thanks|thank\s+you|thx|best)`;

// Bare affirmation, allowed only in FRONT of a selection ("yes, concept 2",
// "ok #3 please"), because that is the only place it is said. These are
// affirmative markers, so admitting them can only ever confirm a pick, never
// invert one — "definitely not concept 2" and "yes but skip concept 2" still
// fail, because the negating word sits between the affirmation and the slot
// and nothing may be skipped over.
const AFFIRM = String.raw`(?:yes|yeah|yep|yup|ok|okay|sure|definitely)`;

/** Phatic words allowed to precede a selection, in any order or repetition. */
const LEADING_FILLER = String.raw`(?:${AFFIRM}|${POLITE})`;

// A reference to a slot: "concept N", "option N", "#N", or a bare "N".
// Separators between the noun and the number are permissive ("concept 2",
// "concept-2", "concept #2", "concept: 2") because they carry no meaning.
//
// (?!\.\d) rejects decimals: "concept 2.5" must not silently truncate to
// slot 2. The whole-message anchor would catch it anyway (".5" is not a
// legal trailer), but the lookahead states the intent locally and survives
// any future loosening of the trailer.
const SLOT_REFERENCE = String.raw`(?:(?:concept|option)\s*[-–—:]?\s*(?:#\s*)?|#\s*)?(\d+)(?!\.\d)`;

// Affirmative lead-ins. Each is a COMPLETE phrase that must be followed
// immediately by the slot reference — there is no wildcard between the two,
// which is what makes composition safe: "I don't like concept 2", "I cannot
// accept concept 2", "I'd rather have concept 2 than concept 1" and "my
// least favorite is concept 2" all fail, because the inserted word is not
// part of any lead-in and nothing may be skipped over.
const SUBJECT = String.raw`(?:i|we)(?:'ll|'d|'m|'re|\s+will|\s+would|\s+am|\s+are)?`;
const CHOICE_VERB = String.raw`(?:take|pick|choose|like|love|prefer|want|vote\s+for|vote|go\s+with|going\s+with)`;
const LEAD_IN = String.raw`(?:${SUBJECT}\s+${CHOICE_VERB}|let'?s\s+(?:do|use|try|pick|choose|go\s+with|make\s+it)|go\s+with|going\s+with|make\s+it|give\s+me|use|pick|choose|my\s+(?:pick|choice|vote|favou?rite)\s+is)`;

// The one pattern the whole parser runs on, anchored at both ends. No 'g'
// flag on purpose: this is a module-level regex reused across calls, and
// only a 'g'/'y' pattern carries a stateful lastIndex into the next
// .exec()/.test().
const SELECTION_TEMPLATE = new RegExp(
  `^${LEAD_SEP}*(?:${LEADING_FILLER}${LEAD_SEP}+)*(?:${LEAD_IN}\\s+)?${SLOT_REFERENCE}(?:${SEP}*${POLITE})*${SEP}*$`,
  'i',
);

/**
 * Parses free text into a 1-based concept slot (1-3), or null when the text
 * is not a string, or is not — in its entirety — a recognized affirmative
 * selection. Never throws, for any input: it is a public export, and a field
 * typed `string` (e.g. `ThreadMessage.body`) can carry whatever an unsafe
 * upstream cast actually put there, not what the type promises.
 *
 * The rule is a single sentence: THE WHOLE MESSAGE MUST BE A SELECTION.
 * There is no rejection list, no negation check, no "which mention did the
 * buyer mean" heuristic. A message is a pick only when, after trimming and
 * whitespace/apostrophe normalization, it consists of nothing but:
 *
 *     [politeness] [affirmative lead-in] <slot reference> [politeness]
 *
 * where
 *   - <slot reference> is "concept N", "option N", "#N", or a bare "N"
 *     (see SLOT_REFERENCE);
 *   - [affirmative lead-in] is one of a small closed set — "I'll take",
 *     "we like", "I prefer", "I'm going with", "go with", "make it",
 *     "let's do", "pick", "choose", "use", "give me", "my choice is", and
 *     their close variants (see LEAD_IN);
 *   - [politeness] is "please"/"thanks"/"thank you"/"best" and punctuation
 *     (see POLITE, SEP).
 *
 * Anything else — one unrecognized word, in front or behind — is null.
 *
 * WHY THIS SHAPE. Rejections do not have to be recognized as rejections,
 * which is the property that ends the confident-wrong-answer bug class:
 *   - "skip concept 2", "veto concept 1", "pass on concept 1", "declining
 *     concept 2, moving on", "I cannot accept concept 2" — the lead-in is
 *     not recognized.
 *   - "concept 1 was my second choice", "concept 3 is my bottom choice",
 *     "concept 2 ranks last for me", "concept 2 is a no-go for me",
 *     "concept 2, never in a million years", "concept 2? nope, love 3" —
 *     the trailing content is not recognized.
 * None of those words ("skip", "veto", "nope", "no-go", "bottom", "ranks
 * last", "cannot") appears anywhere in this module, and none needs to. They
 * fail because they were never affirmatively recognized. An unbounded
 * vocabulary is exactly what an allow-list does not have to enumerate.
 *
 * THE ACCEPTED COST, stated plainly so nobody "fixes" it. Verbose but
 * perfectly clear picks now return null:
 *
 *     "concept 2 looks perfect, let's go with that"   -> null
 *     "concept 2 is the winner"                       -> null
 *     "concept 2 it is!"                              -> null
 *     "concept 2 for sure"                            -> null
 *     "we love concept 2, ship it"                    -> null
 *     "concept 2, but can you make it blue?"          -> null
 *     "no problem, concept 2"                         -> null
 *     "concept two" (spelled-out numerals)            -> null
 *
 * That is the trade, and it is the right way round. A buyer who gets no
 * response follows up, and FR-9's 72-hour default-selection timeout catches
 * the ones who don't; a buyer who gets the wrong logo has already been
 * failed. Every attempt so far to buy those nulls back has been an attempt
 * to reason about text *around* a slot number, and every one of them shipped
 * a confidently inverted answer instead ("concept 1 is nice, but concept 2"
 * returning 1 — the rejected concept).
 *
 * THE RULE FOR EXTENDING THIS. Adding an affirmative lead-in or a politeness
 * word is a safe, expected change; adding one can only turn a null into a
 * pick, never change which slot an existing pick resolves to. Two conditions:
 * (1) the addition must be a complete phrase that is followed IMMEDIATELY by
 * the slot reference, with no wildcard in between — that adjacency is what
 * keeps "I don't like concept 2" and "my least favorite is concept 2" out;
 * (2) there must be no natural sentence that begins with the new phrase and
 * continues directly into a slot reference while meaning the opposite. What
 * is NOT a safe change is relaxing either anchor to let unrecognized text
 * sit beside a match. That is the change that has been made and reverted
 * three times.
 */
export function parseSelection(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  // Curly apostrophes (every phone keyboard produces them) must not defeat
  // "I'll"/"let's"; internal runs of whitespace and newlines are collapsed so
  // a two-line "concept 2\n\nthanks!" reads the same as the one-line form.
  const normalized = text.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const match = SELECTION_TEMPLATE.exec(normalized);
  if (!match) return null;

  // The template constrains the shape, not the range: "concept 4", "concept
  // 0" and "concept 12" are all well-formed selections of a concept that was
  // never delivered. There are exactly three.
  const slot = Number(match[1]);
  return slot >= 1 && slot <= 3 ? slot : null;
}

/**
 * The buyer's concept pick: the first (not last) message in `messages` that
 * both (a) was not sent by `botId` and (b) parses unambiguously via
 * `parseSelection`. `messages` is assumed oldest-first, per `ThreadReader`.
 *
 * Two choices worth being explicit about:
 *
 * 1. Bot messages are excluded *before* parsing, not filtered out of the
 *    result afterwards. `parseSelection` is sender-blind by construction —
 *    it sees text, never authorship — so any text the bot posts that happens
 *    to be a recognized selection shape parses exactly like a buyer's reply
 *    would. That is not hypothetical: the bot writes "concept N" into the M1
 *    delivery note, the gate-failure notes ("it is too similar to concept
 *    1"), and any confirmation echoing the pick back. Whether any *current*
 *    bot message parses is beside the point and must not be relied on — the
 *    template set is expected to grow. Deciding authorship first means bot
 *    text is never offered to the parser at all, which is a guarantee that
 *    holds for whatever the parser recognizes next year.
 *
 * 2. The first parseable buyer reply wins, not the most recent one.
 *    `SelectionStore.select` is itself first-write-wins (its UPDATE is
 *    conditioned on `state = 'concepts_delivered'`, so a second call after
 *    the first success is a no-op) — a buyer who posts "concept 1" and,
 *    after stage 2 has already claimed and started work on slot 1, adds
 *    "actually concept 3" cannot silently re-point a job already in
 *    flight. Taking the first reply keeps this function's answer
 *    consistent with what the store will actually persist.
 *
 * A message that itself parses ambiguously is treated exactly like a
 * message that does not mention a concept at all: it is skipped, and the
 * scan continues. Parsing is per-message and pure — `parseSelection` sees
 * one string and nothing else, never the thread — so an unclear reply
 * cannot block a clearer reply the buyer sends afterward, and a clear reply
 * elsewhere in the thread can never be used to "resolve" a different,
 * ambiguous one.
 */
export function findSelection(messages: ThreadMessage[], botId: string): number | null {
  for (const message of messages) {
    if (message.senderId === botId) continue;
    // `body` is typed as a plain string, but a soft-deleted message
    // (`Message.deletedAt` set) is a realistic platform state whose content
    // can come back null/missing over the wire — mapKeysToCamel gives no
    // runtime guarantee the type-level cast promised. Same guard as
    // voicewright-bot/src/threads.ts's `parse(message.content ?? '')`.
    const slot = parseSelection(message.body ?? '');
    if (slot !== null) return slot;
  }
  return null;
}

/** What a scoped scan of a thread found. See `findSelectionIn`. */
export interface ScopedSelection {
  /** The first parseable buyer reply naming a concept in `allowed`, else null. */
  selected: number | null;
  /**
   * The first parseable buyer reply naming a concept NOT in `allowed`, else
   * null. Reported so the caller can tell the buyer their pick cannot be built;
   * it is never a winner.
   */
  unavailable: number | null;
}

/**
 * `findSelection`, scoped to the concepts that were actually delivered.
 *
 * WHY THIS EXISTS. `findSelection` returns the first parseable buyer reply
 * whatever slot it names, and a caller that then refuses an undelivered slot is
 * stuck on it forever: every later sweep re-reads the same first reply and
 * never reaches the correction. On a `partial` Milestone 1 that is an ordinary
 * sequence, not an exotic one — the delivery note names the missing slot by
 * number and the progress page renders a card for it — so a buyer told "reply
 * with one of these" would type a correction that could never take effect.
 * This function scans past a pick that cannot be built and keeps looking.
 *
 * THIS DOES NOT WEAKEN THE FIRST-WINS RULE. `findSelection` takes the first
 * reply to stay consistent with `SelectionStore.select`, which is itself
 * first-write-wins, so that a buyer cannot re-point a job already in flight. A
 * pick outside `allowed` is REFUSED — it writes nothing, starts nothing, and
 * changes no persisted state — so skipping it cannot re-point anything. Two
 * replies that both name delivered concepts still resolve to the first, exactly
 * as before.
 *
 * `allowed` empty means nothing is selectable, and every reply is reported as
 * `unavailable`. Bot-authored messages are excluded before parsing, for the
 * reasons in `findSelection`'s doc comment.
 */
export function findSelectionIn(
  messages: ThreadMessage[],
  botId: string,
  allowed: ReadonlySet<number>,
): ScopedSelection {
  let unavailable: number | null = null;
  for (const message of messages) {
    if (message.senderId === botId) continue;
    const slot = parseSelection(message.body ?? '');
    if (slot === null) continue;
    if (allowed.has(slot)) return { selected: slot, unavailable };
    unavailable ??= slot;
  }
  return { selected: null, unavailable };
}

// --- FR-18 revision requests ---------------------------------------------------

// A rebuild command with the marker in FRONT: "rebuild from concept 2",
// "switch to concept 3", "swap to 1". The optional object ("it", "the pack",
// "this pack") sits between the verb and the preposition, where it cannot
// separate the marker from the slot reference.
const REBUILD_OBJECT = String.raw`(?:it|this|that|the\s+pack|this\s+pack|the\s+logo)`;
const REBUILD_VERB = String.raw`(?:re-?build|re-?do|re-?make|re-?generate\s+the\s+pack)`;
const SWAP_VERB = String.raw`(?:switch|change|swap)`;
const REBUILD_LEAD = String.raw`(?:${REBUILD_VERB}(?:\s+${REBUILD_OBJECT})?(?:\s+(?:from|with|using))?|${SWAP_VERB}(?:\s+${REBUILD_OBJECT})?\s+to)`;

// A rebuild command with the marker BEHIND: "use concept 2 instead",
// "go with concept 3 instead". The trailing `instead` is what makes these
// rebuild commands rather than ordinary selections, so it is REQUIRED — the
// same words without it are exactly `parseSelection`'s vocabulary and must not
// reach this parser (see the doc comment).
const INSTEAD_LEAD = String.raw`(?:use|go\s+with|going\s+with|make\s+it|build\s+(?:it\s+)?(?:from|with))`;

const REVISION_LEADING_TEMPLATE = new RegExp(
  `^${LEAD_SEP}*(?:${POLITE}${LEAD_SEP}+)*${REBUILD_LEAD}\\s+${SLOT_REFERENCE}(?:${SEP}*${POLITE})*${SEP}*$`,
  'i',
);

const REVISION_INSTEAD_TEMPLATE = new RegExp(
  `^${LEAD_SEP}*(?:${POLITE}${LEAD_SEP}+)*${INSTEAD_LEAD}\\s+${SLOT_REFERENCE}\\s+instead(?:${SEP}*${POLITE})*${SEP}*$`,
  'i',
);

/**
 * Parses free text into the concept slot an FR-18 revision should rebuild
 * from, or null when the text is not — in its entirety — a recognized rebuild
 * command. Never throws, for any input, for the reasons in `parseSelection`.
 *
 * SAME SHAPE AS `parseSelection`, AND DELIBERATELY A SEPARATE VOCABULARY.
 * The whole trimmed message must match; there is no rejection list and no
 * heuristic about which mention the buyer meant. What differs is that a bare
 * slot reference is NEVER enough — an explicit rebuild marker is required,
 * either leading ("rebuild from concept 2", "switch to 3") or as the fixed
 * trailing word `instead` ("use concept 2 instead").
 *
 * WHY THE MARKER IS MANDATORY, and it is the whole safety argument here. This
 * parser runs on messages posted AFTER a pack was delivered, where the ordinary
 * thing a buyer writes is approval. `parseSelection` would read "concept 2" or
 * "we love concept 2" as a pick — correct before delivery, catastrophic after
 * it: LogoSmith would spend a conversion and re-deliver a pack nobody asked to
 * change, then tell the buyer it had acted on a request they never made. So
 * every accepted form here carries a word that means *change what you built*,
 * and the vocabularies do not overlap: `use concept 2` is a selection and NOT a
 * revision, while `use concept 2 instead` is a revision. A test asserts that
 * every `parseSelection` fixture returns null here.
 *
 * NO MODEL FALLBACK, unlike FR-9's. The asymmetry runs the other way after
 * delivery. A missed request costs a support message and the buyer can restate
 * it; a false positive spends real money, overwrites a delivered pack and puts
 * a claim in the record — "you asked us to rebuild" — that the buyer's own
 * words do not support. `inferSelection.ts` exists because 61 of 68 plausible
 * picks returned null and every one of those buyers waited 72 hours; there is
 * no equivalent standing cost here, because nothing is blocked on the buyer
 * answering.
 *
 * THE RULE FOR EXTENDING THIS is `parseSelection`'s, plus one: the addition
 * must contain a word that means *change what was delivered*. Adding a phrase
 * that is merely affirmative re-opens the exact hazard above.
 */
export function parseRevisionRequest(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const normalized = text.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const match =
    REVISION_LEADING_TEMPLATE.exec(normalized) ?? REVISION_INSTEAD_TEMPLATE.exec(normalized);
  if (!match) return null;

  // As in `parseSelection`: the template constrains the shape, not the range.
  const slot = Number(match[1]);
  return slot >= 1 && slot <= 3 ? slot : null;
}

/** What a scoped scan for a rebuild command found. See `findRevisionRequestIn`. */
export interface ScopedRevisionRequest {
  /** The first parseable rebuild command naming a concept in `allowed`, else null. */
  requested: number | null;
  /** The first parseable rebuild command naming a concept NOT in `allowed`, else null. */
  unavailable: number | null;
}

/**
 * `findSelectionIn` for rebuild commands: the first buyer message that parses
 * as a revision request naming a delivered concept, scanning past one that
 * names a concept that cannot be built.
 *
 * First-wins, for `findSelectionIn`'s reason — `claimRevision` is itself
 * first-write-wins, so a second command after the first has been acted on
 * changes no persisted state, and taking the first keeps this function's answer
 * consistent with what the store will actually hold. Bot messages are excluded
 * before parsing: this bot writes the literal phrase `rebuild from concept N`
 * into its own M2 note, so a sender-blind scan would read our instruction back
 * as the buyer's request.
 */
export function findRevisionRequestIn(
  messages: ThreadMessage[],
  botId: string,
  allowed: ReadonlySet<number>,
): ScopedRevisionRequest {
  let unavailable: number | null = null;
  for (const message of messages) {
    if (message.senderId === botId) continue;
    const slot = parseRevisionRequest(message.body ?? '');
    if (slot === null) continue;
    if (allowed.has(slot)) return { requested: slot, unavailable };
    unavailable ??= slot;
  }
  return { requested: null, unavailable };
}
