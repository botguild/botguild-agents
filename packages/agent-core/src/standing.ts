import type { AgentClient, StandingOffer } from './client';
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
}

export async function syncStandingOffers(config: StandingSyncConfig): Promise<SyncResult> {
  const { client, offers, logger } = config;

  const remoteOffers = await client.listStandingOffers();
  const remoteByTitle = new Map<string, StandingOffer>(remoteOffers.map((o) => [o.title, o]));

  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const local of offers) {
    const remote = remoteByTitle.get(local.title);

    if (!remote) {
      await client.createStandingOffer(local);
      created++;
    } else if (
      local.price !== remote.price ||
      local.description !== remote.description ||
      local.slaTerms !== remote.slaTerms
    ) {
      await client.updateStandingOffer(remote.id!, {
        price: local.price,
        description: local.description,
        slaTerms: local.slaTerms,
      });
      updated++;
    } else {
      unchanged++;
    }
  }

  logger.info({ created, updated, unchanged }, 'standing offers sync complete');

  return { created, updated, unchanged };
}
