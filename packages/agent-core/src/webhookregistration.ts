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
   * Whether a previously-persisted platform secret is available on disk.
   * Defaults to **true**. NOOP (keep an existing webhook, no POST) requires
   * BOTH hasStoredSecret AND a `knownWebhookId` that matches a listed
   * webhook with the current event set — otherwise we can't be sure we hold
   * the secret for the webhook we'd keep, so we register a fresh one.
   * Callers with no persisted secret should pass false to force a fresh
   * POST so the bot captures a secret it can verify HMAC signatures against.
   */
  hasStoredSecret?: boolean;
  /**
   * The id of the webhook this bot previously registered and holds the
   * secret for (persisted alongside the secret). Used to identify which of
   * possibly several listed webhooks is "ours" so we can keep it and delete
   * the rest — without relying on createdAt ordering, which is unreliable
   * (the platform returns created_at; the camelCase field is undefined, so
   * any time-based sort is a no-op).
   */
  knownWebhookId?: string;
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
    knownWebhookId,
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

  // Delete every listed webhook except the one whose id is `keepId`.
  // Best-effort: a failed delete leaves a straggler the next run retries.
  const deleteAllExcept = async (
    listed: WebhookRegistration[],
    keepId: string | undefined,
  ): Promise<void> => {
    const stale = listed.filter((r) => r.id !== keepId);
    if (stale.length === 0) return;
    const results = await Promise.all(stale.map((r) => tryDelete(client, r.id, logger)));
    logger.info(
      { webhookUrl, removed: results.filter(Boolean).length, attempted: stale.length },
      'cleaned up stale/duplicate webhooks',
    );
  };

  const all = await client.listWebhooks();
  const matches = all.filter((r: WebhookRegistration) => r.url === webhookUrl);

  // Identify the webhook we own and can verify against: the one we previously
  // registered (knownWebhookId) whose event list still matches. We do NOT
  // sort by createdAt — the platform returns created_at, so the camelCase
  // field is undefined and any time-based comparison is a no-op (which used
  // to make us keep the oldest, stale-event webhook and re-register forever).
  const keeper =
    knownWebhookId && hasStoredSecret
      ? matches.find((r) => r.id === knownWebhookId && eventsMatch(r.events, events))
      : undefined;

  if (keeper) {
    await deleteAllExcept(matches, keeper.id);
    logger.info(
      { webhookUrl, webhookId: keeper.id },
      'kept owned webhook with matching events, no re-registration',
    );
    return keeper;
  }

  // No usable existing webhook (none owned-and-matching, or no stored secret).
  // Register a fresh one, capture its secret, then delete every prior
  // registration for this URL so we converge on exactly one.
  const registration = await client.registerWebhook(webhookUrl, events, webhookSecret);
  captureIfPresent(registration);
  await deleteAllExcept(matches, registration.id);
  logger.info(
    { webhookUrl, webhookId: registration.id, replaced: matches.length },
    'registered fresh webhook and cleaned up prior registrations',
  );
  return registration;
}

function eventsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((e) => sa.has(e));
}
