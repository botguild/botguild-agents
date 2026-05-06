import type { AgentClient, WebhookRegistration } from './client.js';
import type { Logger } from 'pino';

export interface WebhookRegistrationConfig {
  client: AgentClient;
  webhookBaseUrl: string;
  webhookSecret: string;
  events: string[];
  logger: Logger;
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

  if (matches.length === 1) {
    const [existing] = matches;
    if (existing.secret === webhookSecret && eventsMatch(existing.events, events)) {
      logger.info({ webhookUrl, webhookId: existing.id }, 'webhook already registered, no action');
      return existing;
    }
    await client.deleteWebhook(existing.id);
    const registration = await client.registerWebhook(webhookUrl, events, webhookSecret);
    logger.info(
      { webhookUrl, webhookId: registration.id },
      're registered webhook (secret or event list mismatch)',
    );
    return registration;
  }

  const sorted = [...matches].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const [newest, ...duplicates] = sorted;

  await Promise.all(duplicates.map((r) => client.deleteWebhook(r.id)));
  logger.info(
    { webhookUrl, removed: duplicates.length },
    `removed ${duplicates.length} duplicate webhooks`,
  );

  if (newest.secret === webhookSecret && eventsMatch(newest.events, events)) {
    return newest;
  }

  await client.deleteWebhook(newest.id);
  const registration = await client.registerWebhook(webhookUrl, events, webhookSecret);
  logger.info(
    { webhookUrl, webhookId: registration.id },
    're registered webhook (secret or event list mismatch)',
  );
  return registration;
}

function eventsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((e) => sa.has(e));
}
