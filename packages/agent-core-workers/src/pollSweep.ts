import type { Logger } from 'pino';
import type { AgentClient, Gig } from '@botguild/agent-core';
import type { KVLike } from './bindings.js';

// Cron-driven replacement for agent-core's createGigPoller: no setInterval
// survives between Worker invocations, so each Cron Trigger runs exactly one
// poll→score→propose sweep. The poller's in-memory `seen` Set becomes a
// pluggable async SeenStore (KV-backed in production, in-memory in tests).

export interface SeenStore {
  has(gigId: string): Promise<boolean>;
  add(gigId: string): Promise<void>;
}

export interface GigPollSweepConfig {
  client: Pick<AgentClient, 'listGigs'>;
  seen: SeenStore;
  /** Score-and-propose callback, same contract as GigPollerConfig.onGig. */
  onGig: (gig: Gig) => Promise<void>;
  logger: Logger;
}

export interface GigPollSweepResult {
  listed: number;
  processed: number;
  skipped: number;
  failed: number;
}

/**
 * One poll sweep, mirroring poller.ts semantics: list every open gig, skip
 * ones already seen, run onGig with per-gig error isolation. A gig is marked
 * seen only after onGig succeeds, so a failed gig is retried next sweep.
 */
export async function runGigPollSweep(config: GigPollSweepConfig): Promise<GigPollSweepResult> {
  const { client, seen, onGig, logger } = config;

  let gigs: Gig[];
  try {
    // Pull every open gig and let the per-bot scorer decide fit — same
    // rationale as the poller: server-side category filtering is unreliable.
    gigs = await client.listGigs({ status: 'open' });
  } catch (err) {
    logger.error({ err }, 'gig poll sweep: listGigs failed, skipping sweep');
    return { listed: 0, processed: 0, skipped: 0, failed: 0 };
  }

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  for (const gig of gigs) {
    if (await seen.has(gig.id)) {
      skipped++;
      continue;
    }
    try {
      await onGig(gig);
      await seen.add(gig.id);
      processed++;
    } catch (err) {
      failed++;
      logger.error(
        { err, gigId: gig.id },
        'gig poll sweep: onGig callback failed; will retry next sweep',
      );
    }
  }

  const result = { listed: gigs.length, processed, skipped, failed };
  logger.info(result, 'gig poll sweep complete');
  return result;
}

export interface KVSeenStoreOptions {
  /** Key prefix in the namespace. Defaults to 'seen-gig:'. */
  prefix?: string;
  /**
   * Seconds before a seen-id expires. Defaults to 30 days — long past any
   * open gig's lifetime, while keeping the namespace from growing forever.
   * KV is eventually consistent, so this dedupe is best-effort by design;
   * anything correctness-critical (idempotency claims) belongs in D1.
   */
  ttlSeconds?: number;
}

const DEFAULT_SEEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export function createKVSeenStore(kv: KVLike, options: KVSeenStoreOptions = {}): SeenStore {
  const prefix = options.prefix ?? 'seen-gig:';
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_SEEN_TTL_SECONDS;

  return {
    async has(gigId: string): Promise<boolean> {
      return (await kv.get(prefix + gigId)) !== null;
    },
    async add(gigId: string): Promise<void> {
      await kv.put(prefix + gigId, '1', { expirationTtl: ttlSeconds });
    },
  };
}

/** In-memory SeenStore for tests (and single-invocation dry runs). */
export function createMemorySeenStore(): SeenStore & { size(): number } {
  const seen = new Set<string>();
  return {
    async has(gigId: string): Promise<boolean> {
      return seen.has(gigId);
    },
    async add(gigId: string): Promise<void> {
      seen.add(gigId);
    },
    size(): number {
      return seen.size;
    },
  };
}
