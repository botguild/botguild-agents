import type { Logger } from 'pino';
import { mapKeysToCamel } from '@botguild/sdk';
import type {
  Gig,
  Contract,
  ContractMilestone,
  ProposalMilestone,
  Proposal,
  Testimonial,
} from '@botguild/sdk';

// SDK 0.3.0 models acceptanceCriteria as a discriminated union but doesn't
// export the element type. Derive it from Gig so it tracks the SDK exactly.
export type AcceptanceCriterion = Gig['acceptanceCriteria'][number];

// Entity shapes are owned by the platform SDK so they can't drift from the
// live API. Re-export them so bot code imports from '@botguild/agent-core'
// and never reaches into the SDK directly (keeps the SDK swappable). Types
// with no SDK equivalent (ProposalDraft, WebhookRegistration) stay defined
// here.
export type { Gig, Contract, ContractMilestone, ProposalMilestone, Proposal, Testimonial };

// Mirrors the platform's evidenceItemSchema (#238): a 'link' must be an
// http(s) URL; a 'file' must be a /files/ path returned by POST /uploads.
export interface EvidenceItem {
  type: 'file' | 'link';
  url: string;
  name?: string;
}

export interface UploadResult {
  key: string;
  url: string;
  size: number;
  type: string;
}

export interface ProposalDraft {
  price: number;
  timeline: string;
  milestones: ProposalMilestone[];
  warrantyOffer?: string;
  assumptions?: string[];
}

export interface WebhookRegistration {
  id: string;
  botId?: string;
  url: string;
  // Present only on the POST /webhooks create response; the platform omits it
  // from GET /webhooks listings (it's returned exactly once at create time).
  secret?: string;
  events: string[];
  // Optional: the platform sends snake_case `created_at`, so this camelCase
  // field is undefined at runtime through the hand-rolled client. Don't rely
  // on it for ordering — registration selection is by id + events instead.
  createdAt?: string;
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
const REQUEST_TIMEOUT_MS = 30_000;

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

// Coerce a value that should be a string[] into one. The gigs endpoint returns
// its array columns (acceptanceCriteria, deliverables, tags, dataConstraints)
// as STRINGIFIED JSON — it doesn't JSON.parse them server-side the way the
// webhooks endpoint parses `events`. mapKeysToCamel only fixes key casing, not
// stringified-JSON values, so these arrive as strings and break consumers that
// call .join/.map/.filter. Tolerant: already-array passes through; a JSON
// string is parsed; anything else (undefined/null/non-JSON) becomes [].
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === 'string' && value.length > 0) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// Render a structured acceptance criterion as a single human-readable line —
// for scoring (total text length), proposal prompts, and parser summaries that
// want a flat string view of what "done" means.
export function criterionText(c: AcceptanceCriterion): string {
  switch (c.kind) {
    case 'text':
      return c.text;
    case 'metric':
      return `${c.label} ${c.op} ${c.value}${c.unit ? ` ${c.unit}` : ''}`;
    case 'http':
      return `${c.url} → ${c.status}`;
    default:
      // Unknown criterion kind from a newer API — fall back to its JSON so the
      // text still contributes to scoring/prompts rather than vanishing.
      return JSON.stringify(c);
  }
}

// SDK 0.3.0 models acceptanceCriteria as structured AcceptanceCriterion objects
// rather than plain strings. The live gigs endpoint still hands us its array
// columns as STRINGIFIED JSON (it doesn't parse them server-side), so parse
// first, then coerce each element: a bare string becomes a `text` criterion
// (back-compat with older rows) and an object carrying a `kind` passes through.
function toAcceptanceCriteria(value: unknown): AcceptanceCriterion[] {
  let arr: unknown[] = [];
  if (Array.isArray(value)) {
    arr = value;
  } else if (typeof value === 'string' && value.length > 0) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      arr = [];
    }
  }
  const out: AcceptanceCriterion[] = [];
  for (const el of arr) {
    if (typeof el === 'string') {
      out.push({ kind: 'text', text: el });
    } else if (el && typeof el === 'object' && 'kind' in el) {
      out.push(el as AcceptanceCriterion);
    }
  }
  return out;
}

function normalizeGig(gig: Gig): Gig {
  return {
    ...gig,
    acceptanceCriteria: toAcceptanceCriteria(gig.acceptanceCriteria),
    deliverables: toStringArray(gig.deliverables),
    tags: toStringArray(gig.tags),
    dataConstraints: toStringArray(gig.dataConstraints),
  };
}

// File extension + upload Content-Type for the mime types bots attach.
// POST /uploads allows a fixed list (images, pdf, text/plain, text/markdown,
// json, zip) — CSV is not on it, so CSV content is uploaded as text/plain
// (the .csv filename keeps it usable on download).
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/zip': 'zip',
};

function extensionForMime(mime: string): string {
  return MIME_EXTENSIONS[mime] ?? 'bin';
}

function uploadContentType(mime: string): string {
  return mime === 'text/csv' ? 'text/plain' : mime;
}

function parseDataUrl(value: string): { mime: string; bytes: Buffer } | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(value);
  if (!match) return null;
  try {
    return { mime: match[1] as string, bytes: Buffer.from(match[2] as string, 'base64') };
  } catch {
    return null;
  }
}

export class AgentClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly botId: string;
  private readonly logger: Logger;
  private readonly threadIdCache = new Map<string, string>();

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
    // For FormData bodies (POST /uploads) fetch sets the multipart
    // Content-Type + boundary itself — forcing application/json would break it.
    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
    const headers: Record<string, string> = {
      'X-API-Key': this.apiKey,
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    };

    let attempt = 0;

    while (true) {
      const start = Date.now();
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? (isFormData ? (body as FormData) : JSON.stringify(body)) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
        if (!text) return undefined as T;
        // Normalize snake_case keys → camelCase (recursively) so responses
        // match the SDK entity types. The platform returns snake_case fields
        // (created_at, failure_count, value_chain_position, ...) that our types
        // declare camelCase; without this they'd be undefined at runtime —
        // the root cause of the webhook-churn and scoring bugs. This is the
        // same normalizer BotGuildREST applies internally (mapKeysToCamel).
        return mapKeysToCamel(JSON.parse(text)) as T;
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
    return (res.gigs ?? []).map(normalizeGig);
  }

  async submitProposal(gigId: string, draft: ProposalDraft): Promise<{ proposalId: string }> {
    const res = await this.request<{ proposal: { id: string } }>('POST', '/proposals', {
      gigId,
      botId: this.botId,
      ...draft,
    });
    return { proposalId: res.proposal.id };
  }

  // List this bot's proposals. Scoped to our own botId server-side; pass a
  // status to narrow (e.g. 'pending' to surface open counter-offers). Used by
  // the negotiation poller — counter-offers have no webhook event, so they're
  // discovered by polling pending proposals for negotiationStatus==='countered'.
  async listProposals(params?: { status?: string; gigId?: string }): Promise<Proposal[]> {
    const query = new URLSearchParams({ botId: this.botId });
    if (params?.status) query.set('status', params.status);
    if (params?.gigId) query.set('gigId', params.gigId);
    const res = await this.request<{ proposals?: Proposal[] }>(
      'GET',
      `/proposals?${query.toString()}`,
    );
    return res.proposals ?? [];
  }

  // Respond to a payer's open counter-offer. Turn-based: only the side that did
  // NOT make the open offer may act. counter() makes a fresh counter-offer back
  // (flips the turn to the payer); accept() takes the payer's terms and creates
  // a draft contract; decline() clears the counter and leaves the original
  // proposal pending.
  counterProposal(
    proposalId: string,
    data: { price?: number; timeline?: string; milestones?: ProposalMilestone[]; note?: string },
  ): Promise<{ proposal: Proposal }> {
    return this.request<{ proposal: Proposal }>('POST', `/proposals/${proposalId}/counter`, data);
  }

  async acceptCounter(proposalId: string): Promise<{ contractId: string }> {
    const res = await this.request<{ contractId: string }>(
      'POST',
      `/proposals/${proposalId}/counter/accept`,
      {},
    );
    return { contractId: res.contractId };
  }

  declineCounter(proposalId: string): Promise<void> {
    return this.request<void>('POST', `/proposals/${proposalId}/counter/decline`, {});
  }

  // Read the review a payer left on a contract (1–5 stars + text), once the
  // contract reaches a post-acceptance state. Returns null when no review has
  // been left yet. Payers WRITE reviews via the concierge (payer-side); bots
  // only read the reputation signal they received.
  async getContractReview(contractId: string): Promise<Testimonial | null> {
    const res = await this.request<{ review?: Testimonial | null }>(
      'GET',
      `/contracts/${contractId}/review`,
    );
    return res.review ?? null;
  }

  async listContracts(params?: { status?: string }): Promise<Contract[]> {
    const query = params?.status ? `?status=${encodeURIComponent(params.status)}` : '';
    const res = await this.request<{ contracts?: Contract[] }>('GET', `/contracts${query}`);
    return res.contracts ?? [];
  }

  async getGig(gigId: string): Promise<Gig> {
    const res = await this.request<{ gig: Gig }>('GET', `/gigs/${gigId}`);
    return normalizeGig(res.gig);
  }

  async getContract(contractId: string): Promise<Contract> {
    // GET /contracts/:id wraps the record as { contract: {...} } (with
    // milestones + events joined in). Unwrap it.
    const res = await this.request<{ contract: Contract }>('GET', `/contracts/${contractId}`);
    return res.contract;
  }

  /** Upload a file to the platform (R2-backed). Returns the `/files/<key>`
   * url usable as 'file' evidence on a milestone delivery. */
  async uploadFile(
    filename: string,
    content: string | Uint8Array,
    contentType: string,
  ): Promise<UploadResult> {
    // Copy byte content into a fresh ArrayBuffer: Buffer views can sit on a
    // shared pool (ArrayBufferLike), which BlobPart's typing rejects.
    const part: BlobPart =
      typeof content === 'string' ? content : (new Uint8Array(content).buffer as ArrayBuffer);
    const form = new FormData();
    form.append('file', new File([part], filename, { type: contentType }));
    return this.request<UploadResult>('POST', '/uploads', form);
  }

  /**
   * Deliver a milestone. The platform's deliver contract (#238) is
   * `{ summary, evidence[] }`, where evidence requires at least one item and
   * each item must be an uploaded `/files/` path or an http(s) link — a bare
   * `{ note, attachments }` body is rejected with a 400. To satisfy that, the
   * full note is uploaded as a markdown artifact (so evidence is never empty),
   * `data:` URL attachments are decoded and uploaded as files, and http(s)
   * attachments pass through as link evidence. A failed attachment upload is
   * logged and skipped — it must not block an otherwise-valid delivery.
   */
  async deliverMilestone(
    contractId: string,
    milestoneId: string,
    payload: { note: string; attachments?: string[] },
  ): Promise<void> {
    const evidence: EvidenceItem[] = [];

    const noteUpload = await this.uploadFile(
      `delivery-${milestoneId}.md`,
      payload.note,
      'text/markdown',
    );
    evidence.push({ type: 'file', url: noteUpload.url, name: 'Delivery note' });

    const attachments = payload.attachments ?? [];
    for (const [index, attachment] of attachments.entries()) {
      if (/^https?:\/\//i.test(attachment)) {
        evidence.push({ type: 'link', url: attachment });
        continue;
      }
      const parsed = parseDataUrl(attachment);
      if (!parsed) {
        this.logger.warn(
          { contractId, milestoneId, index },
          'attachment is neither an http(s) url nor a data: url, skipping',
        );
        continue;
      }
      try {
        const upload = await this.uploadFile(
          `attachment-${index + 1}.${extensionForMime(parsed.mime)}`,
          parsed.bytes,
          uploadContentType(parsed.mime),
        );
        evidence.push({ type: 'file', url: upload.url, name: `Attachment ${index + 1}` });
      } catch (err) {
        this.logger.warn(
          { err, contractId, milestoneId, index },
          'attachment upload failed, delivering without it',
        );
      }
    }

    // The summary is persisted as a thread message visible to the payer; keep
    // it short and leave the full detail to the uploaded note artifact.
    const summary =
      payload.note.length > 500 ? `${payload.note.slice(0, 500)}…` : payload.note;

    return this.request<void>(
      'POST',
      `/contracts/${contractId}/milestones/${milestoneId}/deliver`,
      { summary, evidence },
    );
  }

  async sendMessage(contractId: string, content: string, contentType = 'text'): Promise<void> {
    const threadId = await this.resolveContractThreadId(contractId);
    if (!threadId) {
      this.logger.warn({ contractId }, 'no contract thread found, dropping message');
      return;
    }
    await this.request<{ message: unknown }>('POST', `/threads/${threadId}/messages`, {
      content,
      contentType,
      botId: this.botId,
    });
  }

  private async resolveContractThreadId(contractId: string): Promise<string | null> {
    const cached = this.threadIdCache.get(contractId);
    if (cached) return cached;

    const query = new URLSearchParams({ scope: 'contract', scopeId: contractId, limit: '1' });
    const res = await this.request<{ threads?: Array<{ id: string }> }>(
      'GET',
      `/threads?${query.toString()}`,
    );
    const threadId = res.threads?.[0]?.id;
    if (!threadId) return null;

    this.threadIdCache.set(contractId, threadId);
    return threadId;
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
}
