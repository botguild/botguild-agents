// ---------------------------------------------------------------------------
// Per-offer CMS webhook verification (FR-2) + deterministic-URL derivation (§8).
//
// Each OG offer has its own HMAC secret stored in D1 (wrangler secrets are
// per-deployment static and cannot be per-offer). The publish webhook is
// verified two ways before any render: (1) the HMAC signature over
// `${timestamp}.${rawBody}` matches, and (2) the timestamp is inside the replay
// window. Everything here is pure WebCrypto (Workers-safe, Node-testable) — the
// route supplies the raw body string and header values.
//
// The signed message is `${timestamp}.${rawBody}` (Stripe-style) with the
// signature carried in the `X-ThumbForge-Signature` header as `hmac-sha256=<hex>`;
// the drop-in CMS snippet signs exactly that. The envelope's own `signature`
// field (PRD §8) is accepted as a fallback source of the same value.
// ---------------------------------------------------------------------------

import { CMS_REPLAY_WINDOW_SECONDS } from './config.js';

const SIGNATURE_PREFIX = 'hmac-sha256=';

/** HMAC-SHA256 of `message` under `secret`, lowercase hex. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Strip the `hmac-sha256=` prefix (if present) and normalize to lowercase hex. */
export function normalizeSignature(value: string): string {
  const trimmed = value.trim();
  const hex = trimmed.startsWith(SIGNATURE_PREFIX) ? trimmed.slice(SIGNATURE_PREFIX.length) : trimmed;
  return hex.toLowerCase();
}

/** Length-safe constant-time hex comparison (avoids early-exit timing leaks). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when `timestamp` (unix seconds) is within ±window of `now` (unix seconds). */
export function withinReplayWindow(
  timestamp: number,
  nowSeconds: number,
  windowSeconds: number = CMS_REPLAY_WINDOW_SECONDS,
): boolean {
  if (!Number.isFinite(timestamp)) return false;
  return Math.abs(nowSeconds - timestamp) <= windowSeconds;
}

export type CmsVerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing-signature' | 'stale-timestamp' | 'bad-signature' };

export interface CmsVerifyInput {
  secret: string;
  /** Exact raw request body string (the bytes the signature was computed over). */
  rawBody: string;
  /** Signature from the `X-ThumbForge-Signature` header or the envelope. */
  providedSignature: string | null | undefined;
  /** Envelope `timestamp` (unix seconds). */
  timestamp: number;
  /** Current time (unix seconds). */
  nowSeconds: number;
  windowSeconds?: number;
}

/**
 * Verify a CMS publish webhook: replay window first (cheap, rejects stale/
 * spoofed timestamps), then the HMAC over `${timestamp}.${rawBody}`.
 */
export async function verifyCmsRequest(input: CmsVerifyInput): Promise<CmsVerifyResult> {
  if (!input.providedSignature || input.providedSignature.trim().length === 0) {
    return { ok: false, reason: 'missing-signature' };
  }
  if (!withinReplayWindow(input.timestamp, input.nowSeconds, input.windowSeconds)) {
    return { ok: false, reason: 'stale-timestamp' };
  }
  const expected = await hmacSha256Hex(input.secret, `${input.timestamp}.${input.rawBody}`);
  const provided = normalizeSignature(input.providedSignature);
  return timingSafeEqualHex(expected, provided)
    ? { ok: true }
    : { ok: false, reason: 'bad-signature' };
}

// --- Deterministic delivery URL (§8, FR-14) ---------------------------------
// The R2 key derives from the idempotency key alone, so the final URL is
// mintable before the render completes — the `202` body can carry it and the
// CMS embeds it immediately (it becomes reachable when the async render lands).

/** The R2 object key for an OG deliverable, derived purely from the claim key. */
export function ogDeliverableKey(idempotencyKey: string): string {
  return `og/${idempotencyKey}.png`;
}

/** The custom-domain deliverable URL for an idempotency key (served at /a/:key). */
export function deterministicUrl(publicBaseUrl: string, idempotencyKey: string): string {
  const base = publicBaseUrl.replace(/\/$/, '');
  return `${base}/a/${ogDeliverableKey(idempotencyKey)}`;
}
