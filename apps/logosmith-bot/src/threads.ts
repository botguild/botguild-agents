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

// "concept N" / "option N" / "#N", case-insensitive, matched anywhere in the
// text. Reused across calls: String#matchAll clones the regex internally, so
// a shared `g`-flagged pattern does not carry stateful `lastIndex` across
// invocations the way `.exec()`/`.test()` would.
const SLOT_PATTERN = /\b(?:concept|option)\s*#?\s*(\d+)\b|#(\d+)\b/gi;

/**
 * Parses free text into a 1-based concept slot (1-3), or null when the text
 * names none, an out-of-range slot, or more than one distinct slot.
 *
 * Accepted forms: "concept N", "option N", "#N" — substring-matched
 * anywhere in the message, so natural phrasing like "I'll take concept 1
 * please" still parses — and a bare "N" only when the *entire* message is
 * just the digit, so a stray number inside an ordinary sentence ("give me 3
 * more") is not mistaken for a pick.
 *
 * Two distinct slots named in one message is an unresolved ambiguity, not a
 * choice — "I like concept 1 and concept 2" must not silently collapse to
 * 1 (or 2). A wrong-but-confident answer is worse than null here: null falls
 * through to the FR-9 default-selection timeout, a safe outcome; guessing
 * does not.
 */
export function parseSelection(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const slots = new Set<number>();
  for (const match of trimmed.matchAll(SLOT_PATTERN)) {
    const n = Number(match[1] ?? match[2]);
    if (n >= 1 && n <= 3) slots.add(n);
  }

  // Bare "N": only fires when nothing else matched AND the whole trimmed
  // message is nothing but the digit — deliberately narrower than the
  // keyword forms above, which match as a substring.
  if (slots.size === 0 && /^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (n >= 1 && n <= 3) slots.add(n);
  }

  const [onlySlot] = slots;
  return slots.size === 1 && onlySlot !== undefined ? onlySlot : null;
}

/**
 * The buyer's concept pick: the first (not last) message in `messages` that
 * both (a) was not sent by `botId` and (b) parses unambiguously via
 * `parseSelection`. `messages` is assumed oldest-first, per `ThreadReader`.
 *
 * Two choices worth being explicit about:
 *
 * 1. Bot messages are excluded *before* parsing, not filtered out of the
 *    result afterwards. The M1 delivery message itself ends with "reply
 *    with 'concept 1|2|3'" (PRD FR-8), which — read on its own —
 *    parses to slot 1 through the exact same "concept N" rule a real buyer
 *    reply uses; `parseSelection` has no way to know it is quoting itself.
 *    Excluding bot messages by sender first means that text is never even
 *    offered to the parser, regardless of parseSelection's pattern set now
 *    or later.
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
 * scan continues. The ambiguity check happens once per message, inside
 * `parseSelection`, never across messages — an unclear reply must not block
 * a clearer reply the buyer sends afterward, and a clear reply elsewhere in
 * the thread must never be used to "resolve" a different, ambiguous one.
 */
export function findSelection(messages: ThreadMessage[], botId: string): number | null {
  for (const message of messages) {
    if (message.senderId === botId) continue;
    const slot = parseSelection(message.body);
    if (slot !== null) return slot;
  }
  return null;
}
