import type { Logger } from 'pino';
import { handleCounterOffers } from '@botguild/agent-core';
import type {
  CostEstimator,
  HandleCounterOffersConfig,
  NegotiationMemory,
  PricingCalc,
} from '@botguild/agent-core';
import type { D1Like } from './bindings.js';

// D1 replacement for agent-core's flat-file negotiation.json memory — NOT a
// 1:1 port. NegotiationMemory is synchronous (hasCountered/markCountered
// return inline) and D1 is async-only, so the adapter hydrates the countered
// set from D1 into an in-memory Set before a sweep, runs handleCounterOffers
// against it synchronously, and writes mutations back with awaited D1 writes
// before the scheduled handler returns — never fire-and-forget inside a cron
// invocation.

export interface HydratedNegotiationMemory {
  /** Synchronous memory backed by the hydrated in-memory Set. */
  memory: NegotiationMemory;
  /**
   * Write the sweep's mutations back to D1, awaited. Idempotent: the mutation
   * journal is cleared on success, so a second flush is a no-op.
   */
  flush(): Promise<void>;
}

export interface D1NegotiationStore {
  loadCounteredSet(): Promise<Set<string>>;
  hydrate(): Promise<HydratedNegotiationMemory>;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS negotiation_countered (
  proposal_id TEXT PRIMARY KEY,
  countered_at TEXT NOT NULL
)`;

export function createD1NegotiationStore(db: D1Like): D1NegotiationStore {
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

  async function loadCounteredSet(): Promise<Set<string>> {
    await ensureSchema();
    const { results } = await db
      .prepare('SELECT proposal_id FROM negotiation_countered')
      .all<{ proposal_id: string }>();
    return new Set(results.map((row) => row.proposal_id));
  }

  return {
    loadCounteredSet,

    async hydrate(): Promise<HydratedNegotiationMemory> {
      const countered = await loadCounteredSet();
      const added = new Set<string>();
      const removed = new Set<string>();

      const memory: NegotiationMemory = {
        hasCountered(proposalId: string): boolean {
          return countered.has(proposalId);
        },
        markCountered(proposalId: string): void {
          if (countered.has(proposalId)) return;
          countered.add(proposalId);
          added.add(proposalId);
          removed.delete(proposalId);
        },
        clear(proposalId: string): void {
          if (!countered.delete(proposalId)) return;
          removed.add(proposalId);
          added.delete(proposalId);
        },
      };

      return {
        memory,
        async flush(): Promise<void> {
          for (const proposalId of added) {
            await db
              .prepare(
                'INSERT OR IGNORE INTO negotiation_countered (proposal_id, countered_at) VALUES (?, ?)',
              )
              .bind(proposalId, new Date().toISOString())
              .run();
          }
          for (const proposalId of removed) {
            await db
              .prepare('DELETE FROM negotiation_countered WHERE proposal_id = ?')
              .bind(proposalId)
              .run();
          }
          added.clear();
          removed.clear();
        },
      };
    },
  };
}

export interface NegotiationSweepConfig {
  client: HandleCounterOffersConfig['client'];
  pricingCalc: PricingCalc;
  costEstimator?: CostEstimator;
  store: D1NegotiationStore;
  logger: Logger;
}

/**
 * One cron-driven negotiation sweep: hydrate the counter-once memory from D1,
 * run agent-core's handleCounterOffers against it, and flush mutations back
 * with awaited writes. The flush runs even if the sweep throws — any counters
 * already sent must be remembered, or the next sweep would re-counter them.
 */
export async function runNegotiationSweep(config: NegotiationSweepConfig): Promise<void> {
  const { memory, flush } = await config.store.hydrate();
  try {
    await handleCounterOffers({
      client: config.client,
      pricingCalc: config.pricingCalc,
      costEstimator: config.costEstimator,
      memory,
      logger: config.logger,
    });
  } finally {
    await flush();
  }
}
