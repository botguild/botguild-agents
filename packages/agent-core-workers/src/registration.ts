import type { Logger } from 'pino';
import { registerBot, ensureWebhookRegistered } from '@botguild/agent-core';
import type { AgentClient, RegistrationConfig } from '@botguild/agent-core';
import type { D1WebhookSecretStore } from './webhookSecretStore.js';

/** The 7 lifecycle events the platform actually dispatches to bot webhooks. */
export const DISPATCHED_WEBHOOK_EVENTS: readonly string[] = [
  'proposal.accepted',
  'milestone.funded',
  'milestone.delivered',
  'milestone.accepted',
  'contract.status.changed',
  'acceptance.auto_approved',
  'dispute.response_submitted',
];

export interface EnsureRegisteredWorkersConfig {
  client: AgentClient;
  /** Passed straight to agent-core's registerBot (idempotent create/update). */
  registration: RegistrationConfig;
  /** Public base URL of this Worker; '/webhook' is appended by agent-core. */
  webhookBaseUrl: string;
  /** Defaults to the 7 dispatched lifecycle events. */
  events?: string[];
  secretStore: D1WebhookSecretStore;
  /**
   * Sent in the POST /webhooks body but ignored server-side — the platform
   * issues its own secret in the response. Defaults to a random UUID.
   */
  webhookSecret?: string;
  logger: Logger;
}

export interface EnsureRegisteredWorkersResult {
  botId: string;
  webhookId: string;
  /** true when a freshly-issued secret was persisted on this call. */
  secretRotated: boolean;
}

/**
 * Workers registration flow: registerBot, then ensureWebhookRegistered, then
 * persist the platform-issued secret to D1 — from the RETURN VALUE, with an
 * awaited write and a read-back check, never via the sync onSecretCaptured
 * callback (a fire-and-forget write the Workers runtime may cancel at
 * invocation end, with its errors swallowed — and by then deleteAllExcept has
 * already removed the prior registrations, so a lost write means a lost
 * secret and silent delivery failure).
 *
 * Idempotent: with a stored secret whose webhookId still matches a listed
 * webhook with the current event set, ensureWebhookRegistered keeps it (no
 * POST, no secret in the return value) and nothing is rewritten. If a persist
 * ever fails after the old registrations were deleted, this call throws
 * loudly and the NEXT run finds the stored webhookId no longer listed, forces
 * a fresh POST, and captures a new secret — the flow converges.
 */
export async function ensureRegisteredWorkers(
  config: EnsureRegisteredWorkersConfig,
): Promise<EnsureRegisteredWorkersResult> {
  const { client, secretStore, logger } = config;
  const events = config.events ?? [...DISPATCHED_WEBHOOK_EVENTS];

  const botId = await registerBot(config.registration);

  const stored = await secretStore.loadWebhookSecret();
  const registration = await ensureWebhookRegistered({
    client,
    webhookBaseUrl: config.webhookBaseUrl,
    webhookSecret: config.webhookSecret ?? crypto.randomUUID(),
    events,
    logger,
    hasStoredSecret: stored !== null,
    knownWebhookId: stored?.webhookId,
    // Deliberately no onSecretCaptured — persistence happens below, awaited.
  });

  if (registration.secret && registration.secret.length > 0) {
    await secretStore.saveWebhookSecret(registration.secret, registration.id);
    const readBack = await secretStore.loadWebhookSecret();
    if (!readBack || readBack.secret !== registration.secret || readBack.webhookId !== registration.id) {
      throw new Error(
        `webhook secret persist read-back failed for webhook ${registration.id}; ` +
          'registration is NOT complete — without the stored secret, inbound deliveries cannot be verified',
      );
    }
    logger.info({ botId, webhookId: registration.id }, 'webhook secret persisted to D1 and read back');
    return { botId, webhookId: registration.id, secretRotated: true };
  }

  // No secret in the return value means ensureWebhookRegistered kept an
  // existing registration (GET /webhooks omits secrets). The keeper path
  // requires hasStoredSecret + a matching knownWebhookId, so the stored
  // secret must belong to exactly this webhook — verify rather than assume.
  if (!stored || stored.webhookId !== registration.id) {
    throw new Error(
      `webhook ${registration.id} was kept but no stored secret matches it; ` +
        'inbound deliveries cannot be verified',
    );
  }
  logger.info({ botId, webhookId: registration.id }, 'kept existing webhook and stored secret');
  return { botId, webhookId: registration.id, secretRotated: false };
}
