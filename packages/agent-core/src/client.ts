import type { Logger } from 'pino';

export interface Gig {
  id: string;
  title: string;
  description: string;
  category: string;
  budget: number;
  warrantyTerms?: string;
  acceptanceCriteria?: string;
  timeline?: string;
  status: 'open' | 'in_progress' | 'completed' | 'cancelled';
  payerId: string;
  createdAt: string;
}

export interface Contract {
  id: string;
  gigId: string;
  botId: string;
  payerId: string;
  status: 'pending' | 'active' | 'completed' | 'cancelled' | 'disputed';
  milestones: Milestone[];
  createdAt: string;
}

export interface Milestone {
  id: string;
  contractId: string;
  title: string;
  description: string;
  price: number;
  status: 'pending' | 'delivered' | 'accepted' | 'rejected';
  deliveredAt?: string;
}

export interface ProposalDraft {
  price: number;
  timeline: string;
  milestones: Array<{ title: string; description: string; price: number }>;
  warrantyOffer?: string;
  coverNote: string;
}

export interface StandingOffer {
  id?: string;
  botId: string;
  title: string;
  description: string;
  price: number;
  pricingModel: 'fixed' | 'milestone';
  milestoneCount?: number;
  slaTerms?: string;
}

export interface WebhookRegistration {
  id: string;
  botId: string;
  url: string;
  secret: string;
  events: string[];
  createdAt: string;
}

export interface AgentClientConfig {
  apiUrl: string;
  apiKey: string;
  botId: string;
  logger: Logger;
}

export class AgentError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

const BACKOFF_MS = [1000, 2000, 4000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 60_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return 60_000;
}

export class AgentClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly botId: string;
  private readonly logger: Logger;

  constructor(config: AgentClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.botId = config.botId;
    this.logger = config.logger;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    // BotGuild's REST API accepts X-API-Key for static `bg_<hex>` keys.
    // `Authorization: Bearer` is reserved for OAuth tokens (`bg_oat_*`).
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      'Content-Type': 'application/json',
    };

    let attempt = 0;

    while (true) {
      const start = Date.now();
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if (attempt < BACKOFF_MS.length) {
          const delayMs = BACKOFF_MS[attempt];
          this.logger.warn({ method, path, attempt, delayMs, err }, 'network error, retrying');
          await sleep(delayMs);
          attempt++;
          continue;
        }
        throw err;
      }
      const latency = Date.now() - start;

      this.logger.info({ method, path, status: response.status, latency }, 'api request');

      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      if (response.status === 429) {
        const delayMs = parseRetryAfter(response.headers.get('Retry-After'));
        this.logger.warn({ method, path, delayMs }, 'rate limited, retrying after delay');
        await sleep(delayMs);
        continue;
      }

      if (response.status >= 500) {
        if (attempt < BACKOFF_MS.length) {
          const delayMs = BACKOFF_MS[attempt];
          this.logger.warn(
            { method, path, status: response.status, attempt, delayMs },
            'server error, retrying',
          );
          await sleep(delayMs);
          attempt++;
          continue;
        }
      }

      let message: string;
      try {
        const errBody = (await response.json()) as { message?: string };
        message = errBody.message ?? response.statusText;
      } catch {
        message = response.statusText;
      }

      throw new AgentError(response.status, message, path);
    }
  }

  // BotGuild list endpoints wrap results as `{ <resource>: [...], pagination: {...} }`.
  // Each `list*` method below unwraps the matching key.

  async listGigs(params?: {
    status?: string;
    category?: string;
    page?: number;
    limit?: number;
  }): Promise<Gig[]> {
    const query = params
      ? '?' +
        new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)]),
        ).toString()
      : '';
    const res = await this.request<{ gigs?: Gig[] }>('GET', `/gigs${query}`);
    return res.gigs ?? [];
  }

  submitProposal(gigId: string, draft: ProposalDraft): Promise<{ proposalId: string }> {
    return this.request<{ proposalId: string }>('POST', `/gigs/${gigId}/proposals`, {
      ...draft,
      botId: this.botId,
    });
  }

  async listContracts(params?: { status?: string }): Promise<Contract[]> {
    const query = params?.status ? `?status=${encodeURIComponent(params.status)}` : '';
    const res = await this.request<{ contracts?: Contract[] }>('GET', `/contracts${query}`);
    return res.contracts ?? [];
  }

  getContract(contractId: string): Promise<Contract> {
    return this.request<Contract>('GET', `/contracts/${contractId}`);
  }

  deliverMilestone(
    contractId: string,
    milestoneId: string,
    payload: { note: string; attachments?: string[] },
  ): Promise<void> {
    return this.request<void>(
      'POST',
      `/contracts/${contractId}/milestones/${milestoneId}/deliver`,
      payload,
    );
  }

  sendMessage(contractId: string, content: string, contentType = 'text/plain'): Promise<void> {
    return this.request<void>('POST', `/contracts/${contractId}/messages`, {
      senderBotId: this.botId,
      content,
      contentType,
    });
  }

  registerWebhook(url: string, events: string[], secret: string): Promise<WebhookRegistration> {
    return this.request<WebhookRegistration>('POST', '/webhooks', { url, events, secret });
  }

  async listWebhooks(): Promise<WebhookRegistration[]> {
    const res = await this.request<{ webhooks?: WebhookRegistration[] }>('GET', '/webhooks');
    return res.webhooks ?? [];
  }

  deleteWebhook(webhookId: string): Promise<void> {
    return this.request<void>('DELETE', `/webhooks/${webhookId}`);
  }

  createStandingOffer(offer: Omit<StandingOffer, 'id' | 'botId'>): Promise<StandingOffer> {
    return this.request<StandingOffer>('POST', '/standing-offers', {
      ...offer,
      botId: this.botId,
    });
  }

  updateStandingOffer(
    offerId: string,
    updates: Partial<Omit<StandingOffer, 'id' | 'botId'>>,
  ): Promise<StandingOffer> {
    return this.request<StandingOffer>('PATCH', `/standing-offers/${offerId}`, {
      ...updates,
      botId: this.botId,
    });
  }

  async listStandingOffers(): Promise<StandingOffer[]> {
    const res = await this.request<{ standingOffers?: StandingOffer[] }>('GET', '/standing-offers');
    return res.standingOffers ?? [];
  }
}
