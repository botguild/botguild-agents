import type { AgentClient, WebhookRegistration } from './client.js';
import type { Logger } from 'pino';

export interface WebhookRegistrationConfig {
  client: AgentClient;
  webhookBaseUrl: string;
  webhookSecret: string;
  events: string[];
  logger: Logger;
}

// Best-effort delete. The platform's DELETE /webhooks/:id has been observed to
// 500 — when that happens, we log and proceed. Worst case we end up with an
// extra webhook in the list; we never block the bot's startup on it.
async function tryDelete(client: AgentClient, webhookId: string, logger: Logger): Promise<boolean> {
  try {
    await client.deleteWebhook(webhookId);
    return true;
  } catch (err) {
    logger.warn({ webhookId, err }, 'failed to delete old webhook, continuing');
    return false;
  }
}

export async function ensureWebhookRegistered(
  config: WebhookRegistrationConfig,
): Promise<WebhookRegistration> {
  const { client, webhookSecret, events, logger } = config;
  const webhookUrl = config.webhookBaseUrl.replace(/\/$/, '') + '/webhook';

  const all = await client.listWebhooks();
  const matches = all.filter((r: WebhookRegistration) => r.url === webhookUrl);

  if (matches.length === 0) {
    const registration = await client.registerWebhook(webhookUrl, events, webhookSecret);
    logger.info({ webhookUrl }, 'registered new webhook');
    return registration;
  }

  // The platform's GET /webhooks does NOT return the secret field — it's
  // omitted from the SELECT. So we can never verify the secret matches; the
  // only signal we have is the event list. If events match an existing
  // webhook, treat it as good and skip re-registration entirely. This was
  // previously a comparison against `existing.secret` (always undefined),
  // forcing every restart to delete+recreate — which crash-loops the bot when
  // the platform's DELETE endpoint is unhealthy.
  const sorted = [...matches].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const [newest, ...duplicates] = sorted;

  // Best-effort cleanup of duplicate webhooks. Failures are tolerated.
  if (duplicates.length > 0) {
    const results = await Promise.all(duplicates.map((r) => tryDelete(client, r.id, logger)));
    const removed = results.filter(Boolean).length;
    logger.info({ webhookUrl, removed, attempted: duplicates.length }, 'duplicate webhook cleanup');
  }

  if (eventsMatch(newest.events, events)) {
    logger.info(
      { webhookUrl, webhookId: newest.id },
      'webhook already registered with matching events, no action',
    );
    return newest;
  }

  // Event list differs — try to delete the stale registration, but tolerate
  // failure. If delete fails we'll end up with two webhooks (old + new), and
  // the next startup will try the duplicate-cleanup branch again.
  const deleted = await tryDelete(client, newest.id, logger);
  const registration = await client.registerWebhook(webhookUrl, events, webhookSecret);
  logger.info(
    { webhookUrl, webhookId: registration.id, oldDeleted: deleted },
    're-registered webhook with new event list',
  );
  return registration;
}

function eventsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((e) => sa.has(e));
}
