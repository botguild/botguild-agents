// ---------------------------------------------------------------------------
// Payer-side BotGuild client (demand-side counterpart to agent-core's
// AgentClient). The worker AgentClient only reads gigs and bids; this posts
// gigs and funds escrow on the payer's behalf.
//
// ⚠️ ENDPOINT PATHS ARE ASSUMPTIONS pending verification against the live payer
// API (the worker client's paths were likewise corrected during the platform
// revamp). They're isolated here so confirming them is a one-file change.
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';
import type { DraftGig } from './draft.js';

export interface PayerClientConfig {
  apiUrl: string;
  apiKey: string;
  logger: Logger;
}

export class PayerError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = 'PayerError';
  }
}

export interface CreatedGig {
  id: string;
  status?: string;
}

export interface GigSummary {
  id: string;
  title?: string;
  status?: string;
  budget?: number;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [500, 1500, 3000];

export class PayerClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly logger: Logger;

  constructor(config: PayerClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.logger = config.logger;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      'Content-Type': 'application/json',
    };

    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt < BACKOFF_MS.length) {
          await sleep(BACKOFF_MS[attempt]);
          continue;
        }
        throw new PayerError(0, `network error: ${(err as Error).message}`, path);
      }

      const durationMs = Date.now() - started;
      this.logger.debug({ method, path, status: response.status, durationMs }, 'payer api call');

      if (RETRYABLE.has(response.status) && attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new PayerError(response.status, text || response.statusText, path);
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
  }

  /** Create (post) a gig. ASSUMPTION: POST /gigs. */
  createGig(draft: DraftGig): Promise<CreatedGig> {
    return this.request<CreatedGig>('POST', '/gigs', {
      title: draft.title,
      description: draft.description ?? '',
      category: draft.category,
      budget: draft.budget,
      timeline: draft.timeline,
      acceptanceCriteria: draft.acceptanceCriteria,
      deliverables: draft.deliverables,
      warrantyRequired: draft.warrantyRequired ?? false,
    });
  }

  /** List gigs the authenticated payer has posted. ASSUMPTION: GET /gigs?mine=true. */
  listMyGigs(): Promise<GigSummary[]> {
    return this.request<GigSummary[]>('GET', '/gigs?mine=true');
  }

  /** Fetch one gig (proposals/contract status live under it). ASSUMPTION: GET /gigs/:id. */
  getGig(gigId: string): Promise<GigSummary> {
    return this.request<GigSummary>('GET', `/gigs/${encodeURIComponent(gigId)}`);
  }

  /** Fund a milestone's escrow — releases the bot to start that stage.
   *  ASSUMPTION: POST /contracts/:contractId/milestones/:milestoneId/fund. */
  fundMilestone(contractId: string, milestoneId: string): Promise<{ status?: string }> {
    return this.request(
      'POST',
      `/contracts/${encodeURIComponent(contractId)}/milestones/${encodeURIComponent(milestoneId)}/fund`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
