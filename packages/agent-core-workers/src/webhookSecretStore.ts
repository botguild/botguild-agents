import type { D1Like } from './bindings.js';

// D1 replacement for agent-core's flat-file webhook-secret.json store. The
// platform issues the webhook signing secret exactly once, at POST /webhooks
// time; losing it silently stops event delivery. It lives in D1 because it is
// platform-issued at runtime — a Worker cannot write its own deploy-time
// wrangler secrets from inside an invocation — and D1 survives redeploys.

export interface StoredWebhookSecret {
  secret: string;
  webhookId?: string;
  capturedAt: string;
}

export interface D1WebhookSecretStore {
  loadWebhookSecret(): Promise<StoredWebhookSecret | null>;
  saveWebhookSecret(secret: string, webhookId?: string): Promise<void>;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS webhook_secret (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  secret TEXT NOT NULL,
  webhook_id TEXT,
  captured_at TEXT NOT NULL
)`;

interface SecretRow {
  secret: string;
  webhook_id: string | null;
  captured_at: string;
}

export function createD1WebhookSecretStore(db: D1Like): D1WebhookSecretStore {
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
    async loadWebhookSecret(): Promise<StoredWebhookSecret | null> {
      await ensureSchema();
      const row = await db
        .prepare('SELECT secret, webhook_id, captured_at FROM webhook_secret WHERE id = 1')
        .first<SecretRow>();
      if (!row || typeof row.secret !== 'string' || row.secret.length === 0) return null;
      return {
        secret: row.secret,
        webhookId: row.webhook_id ?? undefined,
        capturedAt: row.captured_at,
      };
    },

    async saveWebhookSecret(secret: string, webhookId?: string): Promise<void> {
      await ensureSchema();
      await db
        .prepare(
          `INSERT INTO webhook_secret (id, secret, webhook_id, captured_at) VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             secret = excluded.secret,
             webhook_id = excluded.webhook_id,
             captured_at = excluded.captured_at`,
        )
        .bind(secret, webhookId ?? null, new Date().toISOString())
        .run();
    },
  };
}
