import type { AgentClient, StandingOffer } from './client.js';
import type { Logger } from 'pino';

export type LocalStandingOffer = Omit<StandingOffer, 'id' | 'botId'>;

export interface StandingSyncConfig {
  client: AgentClient;
  offers: LocalStandingOffer[];
  logger: Logger;
}

export interface SyncResult {
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
}

// NOTE: As of 2026-05-06 the BotGuild standing-offers API uses a
// subscription-style schema (`pricingType: flat-monthly | per-use | tiered`,
// `basePrice`, `billingCycle`) which doesn't match this project's upfront
// multi-milestone package model (E5). Sync is best-effort: individual
// create/update failures are logged and skipped so they don't crash startup.
// Resolving the schema mismatch is tracked as a follow-up.
export async function syncStandingOffers(config: StandingSyncConfig): Promise<SyncResult> {
  const { client, offers, logger } = config;

  let remoteOffers: StandingOffer[];
  try {
    remoteOffers = await client.listStandingOffers();
  } catch (err) {
    logger.warn({ err }, 'standing offers sync: list failed, skipping sync');
    return { created: 0, updated: 0, unchanged: 0, failed: offers.length };
  }
  const remoteByTitle = new Map<string, StandingOffer>(remoteOffers.map((o) => [o.title, o]));

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const local of offers) {
    const remote = remoteByTitle.get(local.title);

    try {
      if (!remote) {
        await client.createStandingOffer(local);
        created++;
      } else if (
        local.price !== remote.price ||
        local.description !== remote.description ||
        local.slaTerms !== remote.slaTerms ||
        local.pricingModel !== remote.pricingModel ||
        local.milestoneCount !== remote.milestoneCount
      ) {
        await client.updateStandingOffer(remote.id!, {
          price: local.price,
          description: local.description,
          slaTerms: local.slaTerms,
          pricingModel: local.pricingModel,
          milestoneCount: local.milestoneCount,
        });
        updated++;
      } else {
        unchanged++;
      }
    } catch (err) {
      logger.warn({ err, offerTitle: local.title }, 'standing offer sync failed for one offer');
      failed++;
    }
  }

  logger.info({ created, updated, unchanged, failed }, 'standing offers sync complete');

  return { created, updated, unchanged, failed };
}
