import type { Contract, Gig } from './client.js';

/**
 * Webhooks (and the negotiation/recovery paths) are registered per **handler**,
 * not per bot. Because the reference bots share one handler account, every
 * contract event for that handler is delivered to *all* of the handler's bots.
 * A bot must therefore confirm a contract is actually assigned to it before
 * stashing or executing any work — otherwise FlowBot runs VerifierBot's
 * contract (and vice-versa), delivering the wrong runner's output against
 * someone else's milestone (observed on contract 01KTEPBN: a FlowBot
 * "Fetched N records" note delivered against VerifierBot's smoke-test gig).
 *
 * `botId` is the bot's resolved id (the same value used for proposals and the
 * `/health` botId). A contract with no `botId` is treated as not ours.
 */
export function isOwnContract(contract: Pick<Contract, 'botId'>, botId: string): boolean {
  return Boolean(botId) && contract.botId === botId;
}

/**
 * Reconstruct a minimal {@link Gig} from a {@link Contract} when the original
 * gig can no longer be fetched (deleted by the payer, or otherwise 404s).
 *
 * Startup recovery used to `Promise.all([getGig, getContract])` and abandon the
 * job if *either* call failed — so a deleted gig stranded an otherwise-active,
 * funded contract forever (the pipeline never re-ran, the milestone never
 * delivered, escrow never released). The contract still carries everything the
 * check/work planner actually needs: the title, the acceptance criteria, the
 * payer, the amount, and the per-milestone deliverables. Rebuild a gig from
 * those so the pipeline can finish.
 *
 * `gigAcceptanceCriteria` is present on the live `GET /contracts/:id` response
 * (a JSON-encoded string) but is not in the SDK's `Contract` type, so it is
 * read defensively and tolerated when absent or unparseable.
 */
export function gigFromContract(contract: Contract): Gig {
  const rawCriteria = (contract as { gigAcceptanceCriteria?: unknown }).gigAcceptanceCriteria;
  let acceptanceCriteria: Gig['acceptanceCriteria'] = [];
  if (typeof rawCriteria === 'string' && rawCriteria.trim()) {
    try {
      const parsed: unknown = JSON.parse(rawCriteria);
      if (Array.isArray(parsed)) {
        acceptanceCriteria = parsed as Gig['acceptanceCriteria'];
      }
    } catch {
      // Leave criteria empty; the planner falls back to deliverables/title.
    }
  }

  const deliverables = contract.milestones.flatMap((m) => m.deliverables ?? []);

  return {
    id: contract.gigId,
    title: contract.gigTitle,
    description: deliverables.join('\n\n') || contract.gigTitle,
    payerId: contract.payerId,
    payerName: contract.payerName,
    payerAvatar: '',
    category: '',
    subcategory: '',
    deliverables,
    acceptanceCriteria,
    budget: contract.totalAmount,
    timeline: '',
    urgency: 'low',
    warrantyRequired: false,
    warrantyMinDuration: '',
    dataConstraints: [],
    status: 'in-progress',
    proposalCount: 0,
    postedDate: contract.startDate ?? '',
    tags: [],
  };
}
