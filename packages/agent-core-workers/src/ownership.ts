import type { Logger } from 'pino';
import { isOwnContract } from '@botguild/agent-core';
import type { AgentClient, WebhookEvent, WebhookHandler } from '@botguild/agent-core';

// Webhooks are registered per handler, not per bot, so sibling bots' contract
// events arrive at this endpoint too (see agent-core's ownership.ts for the
// incident that motivated the check). Every contract-scoped handler must
// confirm ownership before doing any work.

export interface OwnershipFilterConfig {
  client: Pick<AgentClient, 'getContract'>;
  /** The bot's resolved id — the same value used for proposals and /health. */
  botId: string;
  logger: Logger;
  /**
   * Extracts the contract id from the event. Defaults to reading
   * `payload.contractId`, which every dispatched lifecycle event carries.
   */
  contractIdOf?: (event: WebhookEvent) => string | undefined;
}

function defaultContractIdOf(event: WebhookEvent): string | undefined {
  const payload = event.payload as { contractId?: unknown } | null | undefined;
  const contractId = payload?.contractId;
  return typeof contractId === 'string' && contractId.length > 0 ? contractId : undefined;
}

/**
 * Wrap a webhook handler so it only runs for contracts assigned to this bot.
 *
 * - Not ours → logged and dropped (the delivery still acks 200; it was
 *   correctly delivered, just addressed to a sibling).
 * - No contract id extractable → logged and dropped; ownership can't be
 *   confirmed, and acting on an unowned contract is the failure mode this
 *   filter exists to prevent.
 * - getContract failure → rethrown, so the app responds 500 and the platform
 *   redelivers when ownership can actually be checked.
 */
export function withOwnershipFilter(
  handler: WebhookHandler,
  config: OwnershipFilterConfig,
): WebhookHandler {
  const { client, botId, logger } = config;
  const contractIdOf = config.contractIdOf ?? defaultContractIdOf;

  return async (event: WebhookEvent): Promise<void> => {
    const contractId = contractIdOf(event);
    if (!contractId) {
      logger.warn(
        { eventType: event.eventType, deliveryId: event.deliveryId },
        'webhook event carries no contract id; cannot confirm ownership, dropping',
      );
      return;
    }

    const contract = await client.getContract(contractId);
    if (!isOwnContract(contract, botId)) {
      logger.info(
        { eventType: event.eventType, contractId, botId },
        "sibling bot's contract event, ignoring (webhooks are handler-scoped)",
      );
      return;
    }

    await handler(event);
  };
}
