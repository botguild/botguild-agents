// Form-relay endpoint stack (FR-8/FR-12): the public POST target embedded in every
// relay-bearing tool (form/waitlist/quiz-with-relayResult). A visitor's browser never talks
// to the buyer's inbox directly — it POSTs here, and this module verifies the per-tool token,
// the double-opt-in recipient state, and the per-tool rate caps before emailing the buyer.
// Nothing but delivery METADATA (kind/status/messageId) is ever persisted (FR-12) — never the
// submitted field values.
//
// Node-testable by design: no Workers globals. The Cloudflare `send_email` binding and
// `cloudflare:email` types are Worker-only and live in index.ts, which builds a `RelayMailer`
// around them and passes it in here.

import type { Logger } from 'pino';
import { RELAY_PER_DAY_CAP, RELAY_PER_MINUTE_CAP } from './config.js';
import {
  dayPeriod,
  minutePeriod,
  type AuditStore,
  type RelayStore,
  type UsageStore,
} from './jobs.js';

// --- Mailer seam --------------------------------------------------------------

export interface OutboundEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
}

export interface RelayMailer {
  send(msg: OutboundEmail): Promise<{ messageId: string | null }>;
}

export interface RelayDeps {
  relay: RelayStore;
  usage: UsageStore;
  mailer: RelayMailer;
  audit: AuditStore;
  fromAddress: string;
  logger: Logger;
  now?: () => Date;
}

// --- Constants -----------------------------------------------------------------

const MAX_BODY_BYTES = 8 * 1024;
const SUBJECT_MAX_LENGTH = 100;
const VALUE_MAX_LENGTH = 2000;

// --- Timing-safe compare (WebCrypto-free; equal-length loop, no early exit) -------

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- Body validation -----------------------------------------------------------

interface ParsedRelayBody {
  fields: Record<string, string | boolean>;
  subject?: string;
  test?: boolean;
}

function bodyByteSize(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

/** `{ fields: Record<string, string|boolean> }` — subject/test are optional passthrough. */
function validateBody(body: unknown): { ok: true; parsed: ParsedRelayBody } | { ok: false } {
  if (typeof body !== 'object' || body === null) return { ok: false };
  const raw = body as Record<string, unknown>;
  const rawFields = raw.fields;
  if (typeof rawFields !== 'object' || rawFields === null || Array.isArray(rawFields)) {
    return { ok: false };
  }
  const fields: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(rawFields as Record<string, unknown>)) {
    if (typeof value !== 'string' && typeof value !== 'boolean') return { ok: false };
    fields[key] = value;
  }
  const subject = typeof raw.subject === 'string' ? raw.subject : undefined;
  const test = typeof raw.test === 'boolean' ? raw.test : undefined;
  return { ok: true, parsed: { fields, subject, test } };
}

function buildSubject(subject: string | undefined, toolId: string): string {
  if (subject && subject.length > 0) return subject.slice(0, SUBJECT_MAX_LENGTH);
  // RelayDeps carries no tool name (relay.ts is deliberately decoupled from ToolStore) — the
  // toolId is the only stable identifier available here for the default subject line.
  return `New submission — ${toolId}`;
}

function buildText(fields: Record<string, string | boolean>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}: ${String(value).slice(0, VALUE_MAX_LENGTH)}`)
    .join('\n');
}

// --- Submission handler ----------------------------------------------------------

export async function handleRelaySubmission(
  deps: RelayDeps,
  args: { toolId: string; token: string | null; body: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { toolId, token, body } = args;
  const now = deps.now ?? ((): Date => new Date());

  const record = await deps.relay.get(toolId);
  if (!record) return { status: 404, body: { error: 'unknown tool' } };

  if (!token || !timingSafeEqual(token, record.token)) {
    return { status: 403, body: { error: 'invalid token' } };
  }

  if (!record.verified) {
    return { status: 409, body: { error: 'recipient not verified' } };
  }

  if (bodyByteSize(body) > MAX_BODY_BYTES) {
    return { status: 400, body: { error: 'body too large' } };
  }
  const validated = validateBody(body);
  if (!validated.ok) {
    return { status: 400, body: { error: 'invalid body' } };
  }
  const { fields, subject: rawSubject, test } = validated.parsed;

  // Test mode (staging repair rounds; live golden re-runs): validate exactly like a live
  // submission (token/recipient/body already checked above), record a metadata-only event, and
  // SKIP both the mailer and the rate counters — golden runs never email the buyer or burn caps.
  if (test === true) {
    await deps.relay.recordEvent({ toolId, kind: 'test', status: 'validated' });
    return { status: 200, body: { ok: true, test: true } };
  }

  const minutePer = minutePeriod(now());
  const dayPer = dayPeriod(now());
  const minuteRes = await deps.usage.reserve(
    `relay-min:${toolId}`,
    minutePer,
    RELAY_PER_MINUTE_CAP,
  );
  if (!minuteRes.reserved) {
    await deps.audit.record({ scope: `relay:${toolId}`, gate: 'relay-rate', result: 'minute-cap' });
    return { status: 429, body: { held: true } };
  }
  const dayRes = await deps.usage.reserve(`relay-day:${toolId}`, dayPer, RELAY_PER_DAY_CAP);
  if (!dayRes.reserved) {
    // ThumbForge release pattern: give back the minute slot we just claimed so a caller retrying
    // next minute isn't also penalized for this rejected attempt.
    await deps.usage.release(`relay-min:${toolId}`, minutePer);
    await deps.audit.record({ scope: `relay:${toolId}`, gate: 'relay-rate', result: 'day-cap' });
    return { status: 429, body: { held: true } };
  }

  const subject = buildSubject(rawSubject, toolId);
  const text = buildText(fields);
  const sent = await deps.mailer.send({
    to: record.recipient,
    from: deps.fromAddress,
    subject,
    text,
  });
  await deps.relay.recordEvent({
    toolId,
    kind: 'submission',
    status: 'sent',
    messageId: sent.messageId ?? undefined,
  });

  return { status: 200, body: { ok: true } };
}

// --- CORS --------------------------------------------------------------------

/**
 * Tools live on `https://<slug>.<toolHostSuffix>` (staging slugs included, e.g. `stg-abc`); the
 * relay POST from that origin carries `content-type: application/json`, so the browser
 * preflights. Anything not matching that pattern gets no CORS grant at all.
 */
export function relayCorsHeaders(
  origin: string | null,
  toolHostSuffix: string,
): Record<string, string> {
  if (!origin) return {};
  const escapedSuffix = toolHostSuffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const originRe = new RegExp(`^https://[a-z0-9-]+\\.${escapedSuffix}$`);
  if (!originRe.test(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    vary: 'Origin',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}

// --- Verification ----------------------------------------------------------------

const VERIFIED_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Verified — JiffyApp</title></head>
<body>
<h1>verified — your form can now go live</h1>
<p>This confirmation is complete. If your build was waiting on it, it resumes automatically.</p>
</body>
</html>`;

const VERIFY_NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Not found — JiffyApp</title></head>
<body>
<h1>Not found</h1>
<p>This verification link is invalid or has already been used.</p>
</body>
</html>`;

/** Single-use: `relay.verifyByToken` clears/rotates the verify token, so a second click 404s. */
export async function handleRelayVerification(
  deps: RelayDeps,
  verifyToken: string,
): Promise<{ status: number; html: string }> {
  const result = await deps.relay.verifyByToken(verifyToken);
  if (!result) return { status: 404, html: VERIFY_NOT_FOUND_HTML };
  await deps.relay.recordEvent({
    toolId: result.toolId,
    kind: 'verification',
    status: 'confirmed',
  });
  return { status: 200, html: VERIFIED_HTML };
}

export function buildVerificationEmail(args: {
  recipient: string;
  from: string;
  toolName: string;
  verifyUrl: string;
}): OutboundEmail {
  return {
    to: args.recipient,
    from: args.from,
    subject: `Confirm form delivery for ${args.toolName}`,
    text:
      `Confirm this address to start receiving form submissions from your JiffyApp tool.\n\n` +
      `Verify: ${args.verifyUrl}\n`,
  };
}

// --- Cloudflare Email Routing client -----------------------------------------------

export interface EmailRoutingClient {
  ensureDestination(email: string): Promise<void>;
  isDestinationVerified(email: string): Promise<boolean>;
}

export interface EmailRoutingClientConfig {
  accountId: string;
  apiToken: string;
  /** Injectable for tests — never call the live Cloudflare API from a test. */
  fetchImpl?: typeof fetch;
  logger: Logger;
}

/** CF error-body shape when an already-registered destination is re-POSTed. */
function isAlreadyExistsBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const errors = (body as { errors?: Array<{ message?: string }> }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((e) => typeof e.message === 'string' && /already exists/i.test(e.message));
}

export function createEmailRoutingClient(config: EmailRoutingClientConfig): EmailRoutingClient {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const { accountId, apiToken, logger } = config;
  const addressesUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/routing/addresses`;

  return {
    async ensureDestination(email): Promise<void> {
      const response = await fetchImpl(addressesUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({ email }),
      });
      if (response.ok) return;

      let parsedBody: unknown;
      try {
        parsedBody = await response.json();
      } catch {
        parsedBody = undefined;
      }
      if (response.status === 409 || isAlreadyExistsBody(parsedBody)) {
        logger.info({ email }, 'emailRouting: destination already registered');
        return;
      }
      throw new Error(
        `emailRouting.ensureDestination: ${response.status} ${JSON.stringify(parsedBody)}`,
      );
    },

    async isDestinationVerified(email): Promise<boolean> {
      try {
        const response = await fetchImpl(`${addressesUrl}?per_page=50`, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        if (!response.ok) {
          logger.warn({ email, status: response.status }, 'emailRouting: list destinations failed');
          return false;
        }
        const body = (await response.json()) as {
          result?: Array<{ email?: string; verified?: unknown }>;
        };
        const entry = body.result?.find((r) => r.email === email);
        // `verified` is a confirmation TIMESTAMP string when confirmed, null/undefined otherwise —
        // Boolean() correctly treats either falsy shape as unverified.
        return Boolean(entry?.verified);
      } catch (err) {
        // Never throw: a false here just keeps a relay tool parked awaiting_verification, which
        // is the safe failure mode. Throwing would abort an otherwise-healthy build.
        logger.warn({ err, email }, 'emailRouting: verified check failed');
        return false;
      }
    },
  };
}
