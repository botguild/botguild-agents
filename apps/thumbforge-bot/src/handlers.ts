// ---------------------------------------------------------------------------
// Platform webhook handlers (§10) — the 7 dispatched lifecycle events. Kept out
// of index.ts (which imports the Worker-only render assets) so the handler
// logic is unit-testable against the shim's in-memory D1/KV fakes.
//
// milestone.funded is the fork (§10.5): an OG gig ARMS the per-offer CMS route
// (generate + store a per-offer HMAC secret, hand the buyer the signing
// snippet); a social-pack / thumbnail gig CLAIMS the render job and enqueues a
// plan message. Every contract-scoped handler is ownership-filtered in index.ts.
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';
import { logContractReview, type AgentClient } from '@botguild/agent-core';
import type { WebhookHandler } from '@botguild/agent-core-workers';
import { OG_MONTHLY_CAP, classifyGig } from './config.js';
import { sha256Hex, type OfferStore, type RenderJobStore } from './jobs.js';
import type { RenderQueueLike } from './pipeline.js';

export interface HandlerDeps {
  client: AgentClient;
  renderJobs: RenderJobStore;
  offers: OfferStore;
  queue: RenderQueueLike;
  /** Public base URL of this Worker (the CMS webhook base, FR-11). */
  publicBaseUrl: string;
  logger: Logger;
  /** Injectable for tests — never generate a real secret in a test. */
  randomSecret?: () => string;
}

/** 32 random bytes as hex — the per-offer CMS signing secret. */
function defaultRandomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function armSnippetMessage(offerId: string, secret: string, publicBaseUrl: string): string {
  const base = publicBaseUrl.replace(/\/$/, '');
  return (
    `Your OG automation route is armed. Point your CMS publish webhook at:\n\n` +
    `  POST ${base}/hooks/${offerId}\n\n` +
    `Sign every request with this per-offer secret (keep it private):\n\n` +
    `  ${secret}\n\n` +
    `Body: {"page_url","title","content_hash_fields","timestamp","signature","callback_url"?}. ` +
    `Set header \`X-ThumbForge-Signature: hmac-sha256=<hex>\` where <hex> = HMAC-SHA256(secret, "<timestamp>.<rawBody>"), ` +
    `and \`timestamp\` is unix seconds within ±5 minutes. I render one 1200x630 image per published page version and ` +
    `return its custom-domain URL synchronously (or a 202 + deterministic URL when moderation needs longer).`
  );
}

export function createWebhookHandlers(deps: HandlerDeps): Record<string, WebhookHandler> {
  const { client, renderJobs, offers, queue, publicBaseUrl, logger } = deps;
  const randomSecret = deps.randomSecret ?? defaultRandomSecret;

  const onMilestoneFunded: WebhookHandler = async (event) => {
    const { contractId } = event.payload as { contractId: string };
    const contract = await client.getContract(contractId);
    const gig = await client.getGig(contract.gigId);
    const kind = classifyGig(gig);

    if (kind === 'og') {
      // §10.5: arm the per-offer CMS webhook route (idempotent — re-funding a
      // still-armed offer keeps its secret).
      const offerId = contractId;
      if (await offers.get(offerId)) {
        logger.info({ contractId, offerId }, 'og offer already armed, skipping');
        return;
      }
      const secret = randomSecret();
      await offers.arm({ offerId, secret, contractId, cap: OG_MONTHLY_CAP });
      await client.sendMessage(contractId, armSnippetMessage(offerId, secret, publicBaseUrl));
      logger.info({ contractId, offerId }, 'og route armed');
      return;
    }

    // Async render gig: claim the job (idempotent) and enqueue a plan message.
    const jobKey = await sha256Hex(contractId);
    const decision = await renderJobs.claim(jobKey, contractId);
    logger.info(
      { contractId, jobKey, kind, ...decision },
      'milestone.funded render claim decision',
    );
    if (decision.action === 'enqueue') {
      await queue.send({ kind: 'plan', contractId, jobKey });
    }
  };

  const onProposalAccepted: WebhookHandler = async (event) => {
    const { contractId } = event.payload as { contractId: string };
    await client.sendMessage(
      contractId,
      'Proposal accepted — rendering begins as soon as the milestone escrow is funded.',
    );
  };

  const onMilestoneAccepted: WebhookHandler = async (event) => {
    const { contractId } = event.payload as { contractId: string };
    await logContractReview({ client, contractId, logger });
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
    'milestone.delivered': logOnly('milestone.delivered'),
    'acceptance.auto_approved': logOnly('acceptance.auto_approved'),
    'contract.status.changed': logOnly('contract.status.changed'),
    'dispute.response_submitted': logOnly('dispute.response_submitted'),
  };
}
