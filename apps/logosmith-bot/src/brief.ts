// Brief intake (FR-1). The platform has no structured-brief primitive, so the
// brief rides as a fenced JSON block in the gig description. Parsed at proposal
// time (the scorer skips gigs whose brief is missing, invalid, or non-Latin, so
// un-intakeable work is never won) and re-validated at milestone.funded.
//
// Every function here is pure: `checkLogoUrl` decides the URL *policy* and does
// NOT fetch. The size/type/timeout guards run at fetch time in the pipeline.

import type { FaviconBrief, LogoBrief } from './types.js';

export type BriefResult<T> = { ok: true; brief: T } | { ok: false; reason: string };
export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

const FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)\n?```/i;

/** Pull the first fenced block out of a gig description and JSON-parse it. */
function extractFencedJson(description: string): BriefResult<Record<string, unknown>> {
  const match = FENCE_RE.exec(description);
  if (!match?.[1]) return { ok: false, reason: 'no fenced json block in the gig description' };
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: 'fenced json did not parse to an object' };
    }
    return { ok: true, brief: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: 'could not parse the fenced json block' };
  }
}

const nonBlankString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const stringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : undefined;

/**
 * Latin-script check (v1 scope, PRD §13). Accepts Basic Latin plus Latin-1
 * Supplement / Extended-A letters, digits, whitespace, and common punctuation —
 * so "Café", "O'Brien-Smith" and "Harbor & Vine" pass while CJK, Arabic, and
 * Devanagari are skipped at intake rather than garbling generation and OCR.
 */
export function isLatinScript(text: string): boolean {
  if (text.trim().length === 0) return false;
  return /^[\p{Script=Latin}\p{Nd}\p{P}\p{Zs}\p{M}+&@#$%^*<>=|~`]+$/u.test(text);
}

/** Parse + completeness-check the paid logo gig's brief. */
export function parseLogoBrief(description: string): BriefResult<LogoBrief> {
  const fenced = extractFencedJson(description);
  if (!fenced.ok) return fenced;
  const raw = fenced.brief;

  if (!nonBlankString(raw['brandName'])) {
    return { ok: false, reason: 'brief is missing a non-blank brandName' };
  }
  if (!nonBlankString(raw['industry'])) {
    return { ok: false, reason: 'brief is missing a non-blank industry' };
  }
  const brandName = raw['brandName'].trim();
  if (!isLatinScript(brandName)) {
    return { ok: false, reason: 'brandName is not Latin script (out of v1 scope)' };
  }

  return {
    ok: true,
    brief: {
      brandName,
      industry: raw['industry'].trim(),
      ...(nonBlankString(raw['brief']) ? { brief: raw['brief'].trim() } : {}),
      ...(stringArray(raw['palettePreference'])
        ? { palettePreference: stringArray(raw['palettePreference']) }
        : {}),
      ...(stringArray(raw['avoid']) ? { avoid: stringArray(raw['avoid']) } : {}),
      ...(nonBlankString(raw['script']) ? { script: raw['script'].trim() } : {}),
    },
  };
}

/** Parse the FREE favicon gig's brief and apply the URL policy up front. */
export function parseFaviconBrief(description: string): BriefResult<FaviconBrief> {
  const fenced = extractFencedJson(description);
  if (!fenced.ok) return fenced;
  const raw = fenced.brief;
  if (!nonBlankString(raw['logoUrl'])) {
    return { ok: false, reason: 'brief is missing a non-blank logoUrl' };
  }
  const check = checkLogoUrl(raw['logoUrl']);
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, brief: { logoUrl: check.url.toString() } };
}

// Hostnames that must never be fetched: loopback, link-local (cloud metadata),
// and RFC1918 space. Checked as literals — DNS rebinding is out of scope for a
// buyer-supplied asset URL, but IP-literal SSRF is cheap to close (§12).
const BLOCKED_HOST_RE =
  /^(localhost|(\[)?::1(\])?|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+)$/i;

const IP_LITERAL_RE = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[[0-9a-f:]+\])$/i;

/**
 * The `logoUrl` policy decision (§12): HTTPS only, no IP literals, no loopback
 * or link-local hosts. Size (10 MB), magic-byte type sniff (PNG/JPEG/SVG),
 * 15 s timeout, and the ≥512 px minimum are enforced at fetch/decode time.
 */
export function checkLogoUrl(rawUrl: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'logoUrl is not a valid URL' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'logoUrl must use https' };
  }
  const host = url.hostname.replace(/\.$/, '');
  if (host.length === 0 || IP_LITERAL_RE.test(host) || BLOCKED_HOST_RE.test(host)) {
    return { ok: false, reason: 'logoUrl host is not permitted' };
  }
  return { ok: true, url };
}

/** The minimum source resolution the favicon gig accepts (US-2 AC1). Lives
 *  here, not in config.ts — config imports parseFaviconBrief from this module
 *  for the $0 pricing branch, so this file must stay import-free of config. */
export const MIN_SOURCE_PX = 512;
