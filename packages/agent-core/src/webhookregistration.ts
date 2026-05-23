import type { AgentClient, WebhookRegistration } from './client.js';
import type { Logger } from 'pino';

export interface WebhookRegistrationConfig {
  client: AgentClient;
  webhookBaseUrl: string;
  webhookSecret: string;
  events: string[];
  logger: Logger;
  /**
   * Fires when a fresh POST /webhooks succeeds and the platform returned a
   * non-empty `secret`. Use this to persist the platform-issued secret
   * locally — that's the secret the platform actually signs outbound
   * webhooks with. The body-level `secret` we send is ignored server-side.
   */
  onSecretCaptured?: (secret: string, webhookId: string) => void;
  /**
   * Whether a previously-persisted platform secret is already available on
   * disk. Defaults to **true** (preserves the historical "events match →
   * NOOP" behavior). Callers that have NO persisted secret should pass
   * false to force a fresh POST /webhooks even when events already match,
   * so the bot can capture a secret it can verify HMAC signatures against.
   */
  hasStoredSecret?: boolean;
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
  const {
    client,
    webhookSecret,
    events,
    logger,
    onSecretCaptured,
    hasStoredSecret = true,
  } = config;
  const webhookUrl = config.webhookBaseUrl.replace(/\/$/, '') + '/webhook';

  const captureIfPresent = (registration: WebhookRegistration): void => {
    if (!registration.secret || registration.secret.length === 0) return;
    if (!onSecretCaptured) return;
    // Best-effort: the callback typically persists to disk. If that fails
    // (volume full, permission denied, etc.) we don't want it to crash the
    // bot — webhook registration itself already succeeded.
    try {
      onSecretCaptured(registration.secret, registration.id);
    } catch (err) {
      logger.error(
        { err, webhookId: registration.id },
        'onSecretCaptured callback threw; secret not persisted but registration succeeded',
      );
    }
  };

  const all = await client.listWebhooks();
  const matches = all.filter((r: WebhookRegistration) => r.url === webhookUrl);

  if (matches.length === 0) {
    const registration = await client.registerWebhook(webhookUrl, events, webhookSecret);
    logger.info({ webhookUrl }, 'registered new webhook');
    captureIfPresent(registration);
    return registration;
  }

  // The platform's GET /webhooks does NOT return the secret field — it's
  // omitted from the SELECT. So we can never verify the secret matches from
  // listings. Two signals drive whether we re-register: the event list (must
  // match) and whether we have a locally-persisted secret (without one we
  // can't verify HMAC, so we force a fresh POST to capture one).
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

  const eventsAlreadyMatch = eventsMatch(newest.events, events);

  if (eventsAlreadyMatch && hasStoredSecret) {
    logger.info(
      { webhookUrl, webhookId: newest.id },
      'webhook already registered with matching events and stored secret, no action',
    );
    return newest;
  }

  // Either the event list differs OR we have no stored secret yet — register
  // a fresh webhook so we can capture the platform-issued secret. Try to
  // delete the stale registration first but tolerate failure (the platform's
  // DELETE endpoint has been seen to 500; the next startup will retry).
  const reason = eventsAlreadyMatch
    ? 'no stored secret, forcing re-registration to capture platform secret'
    : 'event list differs, re-registering';
  logger.info({ webhookUrl, webhookId: newest.id, reason }, reason);

  const deleted = await tryDelete(client, newest.id, logger);
  const registration = await client.registerWebhook(webhookUrl, events, webhookSecret);
  logger.info(
    { webhookUrl, webhookId: registration.id, oldDeleted: deleted },
    're-registered webhook',
  );
  captureIfPresent(registration);
  return registration;
}

function eventsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((e) => sa.has(e));
}
