import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Persists the platform-issued webhook secret across restarts so HMAC
// verification of inbound deliveries can use the secret the platform is
// actually signing with — not the BOTGUILD_WEBHOOK_SECRET env var, which the
// platform ignores when creating a webhook registration.

interface StoredSecret {
  secret: string;
  webhookId?: string;
  capturedAt: string;
}

export interface WebhookSecretStoreConfig {
  /**
   * Directory the bot writes its persistent state into. Defaults to
   * `<cwd>/data`, matching the existing jobs.json convention. Fly.io mounts
   * this directory from a persistent volume on each bot app.
   */
  dataDir?: string;
}

function resolvePaths(config: WebhookSecretStoreConfig): { dir: string; file: string } {
  const dir = config.dataDir ?? join(process.cwd(), 'data');
  return { dir, file: join(dir, 'webhook-secret.json') };
}

export function loadWebhookSecret(config: WebhookSecretStoreConfig = {}): StoredSecret | null {
  const { file } = resolvePaths(config);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoredSecret>;
    if (typeof parsed.secret !== 'string' || parsed.secret.length === 0) return null;
    return {
      secret: parsed.secret,
      webhookId: parsed.webhookId,
      capturedAt: parsed.capturedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveWebhookSecret(
  secret: string,
  webhookId: string | undefined,
  config: WebhookSecretStoreConfig = {},
): void {
  const { dir, file } = resolvePaths(config);
  // Restrictive directory + file mode so the secret isn't world-readable.
  // The file holds the platform's HMAC signing key in plaintext; anyone with
  // it can forge signed webhooks against this bot.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload: StoredSecret = {
    secret,
    webhookId,
    capturedAt: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 });
}
