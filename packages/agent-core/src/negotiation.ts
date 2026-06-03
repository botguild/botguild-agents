import type { Logger } from 'pino';
import type { AgentClient, Gig, Proposal, ProposalMilestone } from './client.js';

// Deterministic per-bot pricing: the same calculator the proposer uses. Its
// price is the firm floor we negotiate against — we never ask Claude to price.
export type PricingCalc = (gig: Gig) => {
  price: number;
  timeline: string;
  milestones: ProposalMilestone[];
};

// Remembers which proposals we've already countered, so "counter back once"
// converges instead of looping. File-backed in negotiationStore.ts; an
// in-memory Set works for tests.
export interface NegotiationMemory {
  hasCountered(proposalId: string): boolean;
  markCountered(proposalId: string): void;
  /** Drop the proposal from memory once the negotiation is resolved
   * (accepted/declined) so a future re-listed id doesn't read as stale. */
  clear(proposalId: string): void;
}

export type CounterDecision = 'accept' | 'counter' | 'decline';

// The policy, in one place and side-effect free so it's trivially testable:
//   • counter at/above our floor      → accept (take the deal)
//   • below floor, not yet countered  → counter back once at our firm price
//   • below floor, already countered  → decline (proposal stays on our terms)
export function decideCounter(input: {
  counterPrice: number;
  floorPrice: number;
  alreadyCountered: boolean;
}): CounterDecision {
  if (input.counterPrice >= input.floorPrice) return 'accept';
  if (!input.alreadyCountered) return 'counter';
  return 'decline';
}

export interface HandleCounterOffersConfig {
  client: Pick<
    AgentClient,
    'listProposals' | 'getGig' | 'acceptCounter' | 'counterProposal' | 'declineCounter'
  >;
  pricingCalc: PricingCalc;
  memory: NegotiationMemory;
  logger: Logger;
}

// True for a proposal that holds an open payer counter awaiting our response.
// counterBy==='handler' means it's the payer's turn (we made the last move), so
// we skip it — only the side that didn't make the open offer may respond.
function isOurTurn(p: Proposal): boolean {
  return (
    p.negotiationStatus === 'countered' &&
    p.counterBy === 'payer' &&
    typeof p.counterPrice === 'number'
  );
}

// One negotiation sweep: find open payer counters on our pending proposals and
// apply the policy to each. Tolerant per-proposal — one failure doesn't abort
// the sweep; the proposal is retried next cycle.
export async function handleCounterOffers(config: HandleCounterOffersConfig): Promise<void> {
  const { client, pricingCalc, memory, logger } = config;

  let proposals: Proposal[];
  try {
    proposals = await client.listProposals({ status: 'pending' });
  } catch (err) {
    logger.error({ err }, 'negotiation: listProposals failed, skipping cycle');
    return;
  }

  const open = proposals.filter(isOurTurn);
  for (const p of open) {
    const log = logger.child ? logger.child({ proposalId: p.id, gigId: p.gigId }) : logger;
    try {
      const gig = await client.getGig(p.gigId);
      const floor = pricingCalc(gig);
      const decision = decideCounter({
        counterPrice: p.counterPrice as number,
        floorPrice: floor.price,
        alreadyCountered: memory.hasCountered(p.id),
      });

      if (decision === 'accept') {
        const { contractId } = await client.acceptCounter(p.id);
        memory.clear(p.id);
        log.info(
          { counterPrice: p.counterPrice, floorPrice: floor.price, contractId },
          'accepted payer counter at/above floor',
        );
      } else if (decision === 'counter') {
        await client.counterProposal(p.id, {
          price: floor.price,
          timeline: floor.timeline,
          milestones: floor.milestones,
          note: 'Thanks for the offer. Our pricing reflects the scope and warranty — this is our firm rate.',
        });
        memory.markCountered(p.id);
        log.info(
          { counterPrice: p.counterPrice, floorPrice: floor.price },
          'countered back once at firm price',
        );
      } else {
        await client.declineCounter(p.id);
        memory.clear(p.id);
        log.info(
          { counterPrice: p.counterPrice, floorPrice: floor.price },
          'declined repeat counter below floor; proposal stays on original terms',
        );
      }
    } catch (err) {
      log.error({ err }, 'negotiation: failed to handle counter; will retry next cycle');
    }
  }
}

export interface NegotiationPollerConfig extends HandleCounterOffersConfig {
  /** Defaults to 10 min, matching the gig poller cadence. */
  intervalMs?: number;
}

export interface NegotiationPoller {
  start(): void;
  stop(): void;
}

// Periodically sweeps for counter-offers. Separate from the gig poller so the
// two cadences and failure modes stay independent.
export function createNegotiationPoller(config: NegotiationPollerConfig): NegotiationPoller {
  const intervalMs = config.intervalMs ?? 10 * 60 * 1000;
  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    start() {
      void handleCounterOffers(config);
      timer = setInterval(() => void handleCounterOffers(config), intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
