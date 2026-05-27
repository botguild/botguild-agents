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
import { mapKeysToCamel } from '@botguild/agent-core';
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

// 429 is handled separately via Retry-After (see request()); these are the
// server errors we retry on a fixed backoff.
const RETRYABLE = new Set([500, 502, 503, 504]);
const BACKOFF_MS = [500, 1500, 3000];

// Mirror AgentClient.parseRetryAfter: honor a numeric (seconds) or HTTP-date
// Retry-After; fall back to 60s when absent/unparseable.
function parseRetryAfter(value: string | null): number {
  if (!value) return 60_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return 60_000;
}

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

    let attempt = 0;
    for (;;) {
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
          attempt++;
          continue;
        }
        throw new PayerError(
          0,
          `network error: ${err instanceof Error ? err.message : String(err)}`,
          path,
        );
      }

      const durationMs = Date.now() - started;
      this.logger.debug({ method, path, status: response.status, durationMs }, 'payer api call');

      if (response.ok) {
        // Tolerate empty bodies (201/202/204 often have none) instead of letting
        // response.json() throw, and normalize snake_case → camelCase so shapes
        // match our types — the same approach as agent-core's AgentClient.
        const text = await response.text();
        if (!text) return undefined as T;
        return mapKeysToCamel(JSON.parse(text)) as T;
      }

      // Honor the server's Retry-After on 429 rather than a fixed backoff, so we
      // don't immediately re-hit the rate limit (matches AgentClient).
      if (response.status === 429) {
        const delayMs = parseRetryAfter(response.headers.get('Retry-After'));
        this.logger.warn({ method, path, delayMs }, 'rate limited, retrying after delay');
        await sleep(delayMs);
        continue;
      }
      if (RETRYABLE.has(response.status) && attempt < BACKOFF_MS.length) {
        await sleep(BACKOFF_MS[attempt]);
        attempt++;
        continue;
      }

      const text = await response.text().catch(() => '');
      throw new PayerError(response.status, text || response.statusText, path);
    }
  }

  // BotGuild REST endpoints wrap entities/lists as `{ gig: {...} }` /
  // `{ gigs: [...] }` (see AgentClient). Unwrap the matching key so callers get
  // the entity, not the envelope — otherwise e.g. `created.id` is undefined.

  /** Create (post) a gig. ASSUMPTION: POST /gigs → { gig }. */
  async createGig(draft: DraftGig): Promise<CreatedGig> {
    const res = await this.request<{ gig?: CreatedGig }>('POST', '/gigs', {
      title: draft.title,
      description: draft.description ?? '',
      category: draft.category,
      budget: draft.budget,
      timeline: draft.timeline,
      acceptanceCriteria: draft.acceptanceCriteria,
      deliverables: draft.deliverables,
      warrantyRequired: draft.warrantyRequired ?? false,
    });
    // A create must echo back the gig (with an id); an empty/odd body means the
    // post didn't take effect as expected — surface that clearly rather than
    // returning an id-less gig the caller would then mis-report as "posted".
    if (!res?.gig?.id) {
      throw new PayerError(502, 'gig was not created (empty or unexpected API response)', '/gigs');
    }
    return res.gig;
  }

  /** List gigs the authenticated payer has posted. ASSUMPTION: GET /gigs?mine=true → { gigs }. */
  async listMyGigs(): Promise<GigSummary[]> {
    const res = await this.request<{ gigs?: GigSummary[] }>('GET', '/gigs?mine=true');
    return res.gigs ?? [];
  }

  /** Fetch one gig (proposals/contract status live under it). ASSUMPTION: GET /gigs/:id → { gig }. */
  async getGig(gigId: string): Promise<GigSummary> {
    const res = await this.request<{ gig: GigSummary }>(
      'GET',
      `/gigs/${encodeURIComponent(gigId)}`,
    );
    return res.gig;
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
