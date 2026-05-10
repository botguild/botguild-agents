import type { AgentClient, Gig } from './client.js';
import type { Logger } from 'pino';

export interface GigPollerConfig {
  client: AgentClient;
  intervalMs?: number;
  logger: Logger;
  onGig: (gig: Gig) => Promise<void>;
}

export interface GigPoller {
  start(): void;
  stop(): void;
}

export function createGigPoller(config: GigPollerConfig): GigPoller {
  const { client, logger, onGig } = config;
  const intervalMs = config.intervalMs ?? 10 * 60 * 1000;
  const seen = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  async function poll(): Promise<void> {
    let gigs: Gig[];
    try {
      // Pull every open gig and let the per-bot scorer decide fit. Server-side
      // category filtering is unreliable because the platform has no shared
      // category vocabulary between buyers and bots.
      gigs = await client.listGigs({ status: 'open' });
    } catch (err) {
      logger.error({ err }, 'gig poller: listGigs failed, skipping cycle');
      return;
    }

    for (const gig of gigs) {
      if (seen.has(gig.id)) continue;
      try {
        await onGig(gig);
        seen.add(gig.id);
      } catch (err) {
        logger.error(
          { err, gigId: gig.id },
          'gig poller: onGig callback failed; will retry on next cycle',
        );
      }
    }
  }

  return {
    start() {
      void poll();
      timer = setInterval(() => void poll(), intervalMs);
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
