// ---------------------------------------------------------------------------
// Platform webhook handlers — the 7 dispatched lifecycle events.
//
// milestone.funded self-filters INLINE: it needs the contract anyway to
// classify the gig (build vs. hosting-cycle renewal), so wrapping it in
// withOwnershipFilter would just cost a duplicate getContract round-trip.
// Every other contract-scoped handler is wrapped in withOwnershipFilter by
// index.ts when it builds the handler map.
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';
import {
  DEFAULT_DISPUTE_RESPONSE,
  isOwnContract,
  logContractReview,
  type AgentClient,
  type AgentMcpClient,
} from '@botguild/agent-core';
import type { WebhookHandler } from '@botguild/agent-core-workers';
import type { GigStore } from './gigStore.js';
import { jobKeyFor, sha256Hex, type CycleStore, type JobStore, type ToolStore } from './jobs.js';
import type { JobKind, JobMessage } from './types.js';

export type QueueLike = { send(msg: JobMessage): Promise<unknown> };

export const OWNERSHIP_FILTERED_EVENTS = [
  'proposal.accepted',
  'milestone.accepted',
  'contract.status.changed',
] as const;

export interface HandlerDeps {
  // getContractReview is needed by milestone.accepted's logContractReview call.
  client: Pick<AgentClient, 'getContract' | 'getGig' | 'sendMessage' | 'getContractReview'>;
  // AgentMcpClient has private fields, so a plain fake object used in tests must
  // be typed against a Pick view rather than the class itself.
  mcp: Pick<AgentMcpClient, 'respondToDispute'>;
  gigs: GigStore;
  jobs: JobStore;
  cycles: CycleStore;
  tools: ToolStore;
  queue: QueueLike;
  botId: string;
  publicBaseUrl: string;
  logger: Logger;
  now?: () => Date;
}

function evidenceSummary(jobKey: string): string {
  return (
    `Evidence for this delivery: the golden-assertion report and public build log for job ` +
    `${jobKey} are linked below. Every acceptance criterion signed off in the accepted proposal ` +
    `is recorded there with per-assertion pass/fail status, screenshots, and the Lighthouse (PSI) ` +
    `report used to gate the build.`
  );
}

export function buildHandlers(deps: HandlerDeps): Record<string, WebhookHandler> {
  const { client, mcp, gigs, jobs, queue, botId, publicBaseUrl, logger } = deps;

  const onMilestoneFunded: WebhookHandler = async (event) => {
    const { contractId } = event.payload as { contractId?: string };
    if (!contractId) return;
    const contract = await client.getContract(contractId); // throws ⇒ 500 ⇒ platform redelivers
    if (!isOwnContract(contract, botId)) return;

    const known = await gigs.get(contract.gigId);
    const hash = await sha256Hex(contractId);
    let kind: JobKind;
    let msg: JobMessage;
    if (known?.kind === 'cycle' && known.toolId) {
      kind = 'cycle';
      msg = { kind, contractId, jobKey: jobKeyFor(hash, 'cycle'), toolId: known.toolId };
    } else {
      // Unknown gig (poller lost the row / deleted gig) is still a build attempt: the
      // consumer re-parses the brief from the gig/contract and parks with a thread
      // message if unusable.
      kind = 'build';
      msg = { kind, contractId, jobKey: jobKeyFor(hash, 'build') };
    }

    const decision = await jobs.claim({
      jobKey: msg.jobKey,
      contractId,
      kind,
      toolId: msg.toolId,
      gigId: contract.gigId,
    });
    logger.info({ contractId, jobKey: msg.jobKey, ...decision }, 'milestone.funded claim decision');
    if (decision.action === 'enqueue') await queue.send(msg);
  };

  const onProposalAccepted: WebhookHandler = async (event) => {
    const { contractId } = event.payload as { contractId: string };
    await client.sendMessage(
      contractId,
      'Proposal accepted — work begins as soon as escrow is funded. The golden examples in the ' +
        'proposal are the acceptance criteria.',
    );
  };

  const onMilestoneAccepted: WebhookHandler = async (event) => {
    const { contractId } = event.payload as { contractId: string };
    await logContractReview({ client, contractId, logger });
  };

  const onContractStatusChanged: WebhookHandler = async (event) => {
    const { contractId, newStatus } = event.payload as { contractId: string; newStatus?: string };
    if (newStatus !== 'disputed') return;

    // JobStore has no by-contract lookup (Task 11), but a job key is always
    // sha256(contractId) + ':' + stage, and stage is one of exactly two values
    // at dispute time (edit disputes are out of scope for this fleet) — try both.
    const hash = await sha256Hex(contractId);
    const row =
      (await jobs.get(jobKeyFor(hash, 'build'))) ?? (await jobs.get(jobKeyFor(hash, 'cycle')));

    try {
      if (row) {
        const base = publicBaseUrl.replace(/\/$/, '');
        const token = row.deliverableToken;
        await mcp.respondToDispute({
          contractId,
          response: evidenceSummary(row.jobKey),
          evidenceUrls: [`${base}/deliverables/${token}/report.json`, `${base}/p/${token}`],
          evidenceType: 'artifacts',
        });
      } else {
        await mcp.respondToDispute({ contractId, response: DEFAULT_DISPUTE_RESPONSE });
      }
    } catch (err) {
      // Best-effort: never let a dispute counter-statement failure 500 a status webhook.
      logger.warn({ err, contractId }, 'respondToDispute failed; relying on human follow-up');
    }
  };

  const logOnly =
    (eventType: string): WebhookHandler =>
    async (event) => {
      logger.info({ eventType, payload: event.payload }, 'lifecycle event received');
    };

  return {
    'milestone.funded': onMilestoneFunded,
    'proposal.accepted': onProposalAccepted,
    'milestone.accepted': onMilestoneAccepted,
    'contract.status.changed': onContractStatusChanged,
    'milestone.delivered': logOnly('milestone.delivered'),
    'acceptance.auto_approved': logOnly('acceptance.auto_approved'),
    'dispute.response_submitted': logOnly('dispute.response_submitted'),
  };
}

/**
 * Wraps exactly the contract-acting webhook handlers (those that modify contract state)
 * with an ownership filter, leaving log-only handlers and others untouched.
 * This prevents benign sibling-bot webhook events from being filtered unnecessarily.
 */
export function wrapContractHandlers(
  handlers: Record<string, WebhookHandler>,
  wrap: (h: WebhookHandler) => WebhookHandler,
): Record<string, WebhookHandler> {
  return Object.fromEntries(
    Object.entries(handlers).map(([eventType, handler]) => [
      eventType,
      (OWNERSHIP_FILTERED_EVENTS as readonly string[]).includes(eventType)
        ? wrap(handler)
        : handler,
    ]),
  );
}
