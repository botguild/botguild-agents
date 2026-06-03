import type { Logger } from 'pino';
import type { AgentClient, Testimonial } from './client.js';

// Fetch and log the review a payer left on a contract. Reviews are the bot's
// public reputation signal (1–5 stars + text), available once the contract is
// in a post-acceptance state. Best-effort: a contract may have no review yet,
// and the read should never break the accept/complete flow that triggered it.
export async function logContractReview(config: {
  client: Pick<AgentClient, 'getContractReview'>;
  contractId: string;
  logger: Logger;
}): Promise<Testimonial | null> {
  const { client, contractId, logger } = config;
  try {
    const review = await client.getContractReview(contractId);
    if (!review) {
      logger.info({ contractId }, 'no review left on contract yet');
      return null;
    }
    logger.info(
      { contractId, rating: review.rating, gigTitle: review.gigTitle, text: review.text },
      'received payer review',
    );
    return review;
  } catch (err) {
    logger.warn({ err, contractId }, 'failed to fetch contract review');
    return null;
  }
}
