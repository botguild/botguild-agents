import type { D1Like } from './bindings.js';

// D1 store for the PLATFORM-ASSIGNED bot id. registerBot returns it at
// registration time, and it is the only id the platform accepts proposals
// under — submitting with anything else 403s ("You can only submit proposals
// for your own bots", observed live 2026-08-06). Like the webhook secret it
// is platform-issued at runtime, so it lives in D1 and survives redeploys;
// the BOTGUILD_BOT_ID env secret is only the bootstrap fallback used before
// the first registration has run.

export interface StoredRegisteredBot {
  botId: string;
  capturedAt: string;
}

export interface D1RegisteredBotStore {
  load(): Promise<StoredRegisteredBot | null>;
  save(botId: string): Promise<void>;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS registered_bot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bot_id TEXT NOT NULL,
  captured_at TEXT NOT NULL
)`;

interface BotRow {
  bot_id: string;
  captured_at: string;
}

export function createD1RegisteredBotStore(db: D1Like): D1RegisteredBotStore {
  // Lazy, memoized schema creation so callers don't need a migration step for
  // a single-row table. A failed attempt clears the memo and is retried.
  let schemaReady: Promise<void> | undefined;
  const ensureSchema = (): Promise<void> =>
    (schemaReady ??= db
      .prepare(SCHEMA)
      .run()
      .then(() => undefined)
      .catch((err: unknown) => {
        schemaReady = undefined;
        throw err;
      }));

  return {
    async load(): Promise<StoredRegisteredBot | null> {
      await ensureSchema();
      const row = await db
        .prepare('SELECT bot_id, captured_at FROM registered_bot WHERE id = 1')
        .first<BotRow>();
      if (!row || typeof row.bot_id !== 'string' || row.bot_id.length === 0) return null;
      return { botId: row.bot_id, capturedAt: row.captured_at };
    },

    async save(botId: string): Promise<void> {
      await ensureSchema();
      await db
        .prepare(
          `INSERT INTO registered_bot (id, bot_id, captured_at) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET bot_id = excluded.bot_id, captured_at = excluded.captured_at`,
        )
        .bind(botId, new Date().toISOString())
        .run();
    },
  };
}

/**
 * The id the client must act as: the stored platform-assigned id when a
 * registration has recorded one, else the env bootstrap fallback. A broken
 * store degrades to the fallback rather than failing boot — the fallback may
 * still be right, and if it isn't, the 403s are loud in /health's lastSweep.
 */
export async function resolveRegisteredBotId(
  store: D1RegisteredBotStore,
  fallbackBotId: string,
): Promise<string> {
  const stored = await store.load().catch(() => null);
  return stored?.botId ?? fallbackBotId;
}
