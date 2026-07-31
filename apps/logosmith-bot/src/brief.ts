// Brief intake (FR-1). The platform has no structured-brief primitive, so the
// brief may ride as a fenced JSON block in the gig description — and when it
// does not (measured live: 0 of 78 open gigs did), `resolveBrief` falls back to
// prose extraction (proseBrief.ts), whose output is validated by the SAME
// `parseLogoBrief` below. Resolved at proposal time (the scorer skips gigs
// whose brief is missing, invalid, or non-Latin, so un-intakeable work is never
// won) and re-validated at milestone.funded.
//
// Every function here is pure and synchronous except `resolveBrief`, which is
// async only because the extractor it delegates to is: `checkLogoUrl` decides
// the URL *policy* and does NOT fetch. The size/type/timeout guards run at
// fetch time in the pipeline.

import type { FaviconBrief, LogoBrief } from './types.js';

export type BriefResult<T> =
  | { ok: true; brief: T }
  | {
      ok: false;
      /**
       * Buyer-facing, and it goes into the contract thread AND the `gate_audit`
       * evidence trail. NEVER put a third-party error body in here — see
       * `unavailable` below, and disputes.ts's `DisputeAuditRow.detail`, whose
       * docstring names the write-side rule this has to satisfy.
       */
      reason: string;
      /**
       * OUR failure, not the buyer's: the brief could not be READ, as opposed
       * to being wrong. Set only when a vendor this bot depends on was
       * unreachable or errored.
       *
       * THE CALLER MUST PARK RATHER THAN REJECT. Collapsing an outage into
       * "no brief" terminally rejects a FUNDED contract — `markDelivered`
       * puts it beyond the parked sweep's reach — so one bad minute at a
       * vendor permanently kills a paid job. The moderation path two steps
       * away already does this correctly: unavailable -> park -> cron retry ->
       * six-hour give-up with a note.
       *
       * ABSENT MEANS "THE BRIEF IS WRONG", which is the terminal answer. A new
       * failure mode that is really an outage must set this flag; if you are
       * adding one and hesitating, it is an outage.
       */
      unavailable?: true;
    };
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

/**
 * Bounds on the two `string[]` fields a brief may carry (`palettePreference`,
 * `avoid`).
 *
 * These are BUYER-CONTROLLED FREE TEXT that reaches the FR-2 moderation payload
 * and, via `buildAxisPrompt`, the image vendors' prompts under our API keys.
 * Unbounded, one gig can push an arbitrary payload through both. The numbers
 * are deliberately far past anything real — a palette is a handful of colours,
 * an avoid-list a handful of motifs — so they bound the abuse case without
 * costing a legitimate brief anything.
 */
const MAX_BRIEF_LIST_ENTRIES = 20;
const MAX_BRIEF_LIST_ENTRY_CHARS = 200;

/**
 * Bounds on the SCALAR free-text fields, and the reason is CPU, not tokens.
 *
 * `similarity()` (gates/ocr.ts) is a Levenshtein distance, O(transcription ×
 * brandName). Only the transcription is bounded — by the vision call's
 * `max_tokens: 256`. Nothing bounded `brandName`, and intake accepted 1,000,000
 * characters. Measured against a 1,000-char transcription:
 *
 *     200 chars ->     5.8 ms      10,000 ->    77 ms
 *  40,000 chars ->   655 ms       160,000 -> 2,739 ms
 *
 * and the readback gate runs up to 9× per job (3 slots × 3 attempts), so a
 * 160,000-character brand name is ~24.7 s against a 30 s Worker CPU budget.
 * This is the one input C4 reached without bounding.
 *
 * THE LIKELIER OUTCOME IS A LIE, NOT A TIMEOUT. An oversized brief also inflates
 * the FR-2 moderation payload, and `moderation.ts` maps EVERY `!response.ok` to
 * `unavailable` (verified) — so a vendor 4xx caused by our own payload tells the
 * buyer "that vendor has been unavailable for 3 attempts". False, and it is our
 * payload, not their outage: exactly the honesty class the brief-extraction
 * outage fix addresses two files away.
 *
 * Sized for what each field IS. A brand name is lettering on a logo and an
 * industry is a short noun phrase — 200 characters is already far past either.
 * `brief` is a style-direction paragraph, so it gets more room.
 */
const MAX_BRIEF_NAME_CHARS = 200;
const MAX_BRIEF_TEXT_CHARS = 2_000;

/**
 * A scalar free-text field within its bound, or a reason it was refused.
 *
 * REFUSED, NOT TRUNCATED — the same reason the lists are (below). Truncating a
 * `brandName` would be worse than truncating a list: that string is what gets
 * RENDERED as lettering and then OCR-compared against itself, so a silently
 * shortened one would generate a logo for a name the buyer did not ask for and
 * then "verify" it against the shortened form. The gate would pass. That is the
 * C4 failure shape wearing different clothes.
 */
function boundedText(
  value: string,
  field: string,
  max: number,
): { ok: true } | { ok: false; reason: string } {
  if (value.length <= max) return { ok: true };
  return {
    ok: false,
    reason: `${field} is ${value.length} characters and LogoSmith accepts at most ${max}`,
  };
}

/**
 * A bounded `string[]`, or a reason it was refused.
 *
 * REFUSED, NOT TRUNCATED. Silently dropping half a buyer's list would generate
 * from a brief they did not write and then report it back as theirs; naming
 * what is wrong is something they can act on.
 *
 * An absent/wrong-typed field is not an error — it is simply not carried, which
 * is the pre-existing behaviour for every optional field here.
 */
function boundedStringArray(
  value: unknown,
  field: string,
): { ok: true; value: string[] | undefined } | { ok: false; reason: string } {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    return { ok: true, value: undefined };
  }
  const entries = value as string[];
  if (entries.length > MAX_BRIEF_LIST_ENTRIES) {
    return {
      ok: false,
      reason:
        `${field} lists ${entries.length} entries and LogoSmith accepts at most ` +
        `${MAX_BRIEF_LIST_ENTRIES}`,
    };
  }
  const overlong = entries.find((entry) => entry.length > MAX_BRIEF_LIST_ENTRY_CHARS);
  if (overlong !== undefined) {
    return {
      ok: false,
      reason:
        `an entry in ${field} is ${overlong.length} characters and LogoSmith accepts at most ` +
        `${MAX_BRIEF_LIST_ENTRY_CHARS} per entry`,
    };
  }
  return { ok: true, value: entries };
}

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

/**
 * Does this brand name have anything an OCR readback could ever match?
 *
 * COUPLED TO `gates/ocr.ts`'s `normalizeForMatch`, WHICH THIS MODULE CANNOT
 * IMPORT (it would close a cycle through config.ts — see `MIN_SOURCE_PX`). The
 * relationship is asserted as a property in brief.test.ts rather than left to
 * this comment: every name `parseLogoBrief` accepts must have a non-empty
 * normalized form.
 *
 * WHY IT EXISTS. `isLatinScript` admits `\p{P}` and assorted symbols, so `&&&`
 * was a valid brand name. `normalizeForMatch` deletes all punctuation, so it
 * normalized to `""`; a vision model reporting no legible lettering also
 * transcribes to `""`; and the two empties scored a perfect 1. The headline
 * gate of this product returned PASS on an image nobody verified, and the M1
 * note, the progress page, `report.json` and the dispute document all repeated
 * that number as a machine verification. Refusing at intake is the cheap end of
 * the fix — a name with no letter or digit cannot be rendered as lettering and
 * then read back, so there is no job here to take.
 */
const hasReadableLettering = (text: string): boolean => /[\p{L}\p{Nd}]/u.test(text);

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
  if (!hasReadableLettering(brandName)) {
    return {
      ok: false,
      reason:
        'brandName contains no letters or digits, so there is nothing for the lettering-readback ' +
        'gate to verify',
    };
  }

  const industry = raw['industry'].trim();
  const styleDirection = nonBlankString(raw['brief']) ? raw['brief'].trim() : undefined;
  const script = nonBlankString(raw['script']) ? raw['script'].trim() : undefined;

  // Every scalar the brief can carry, checked by the same helper — the drift
  // shape this codebase keeps paying for is a list that falls behind its type,
  // so these are the four `LOGO_BRIEF_TEXT` classifies as scalars, and
  // brief.test.ts asserts that no accepted brief exceeds the bound on any of
  // them rather than trusting this call site to be complete.
  for (const [value, field, max] of [
    [brandName, 'brandName', MAX_BRIEF_NAME_CHARS],
    [industry, 'industry', MAX_BRIEF_NAME_CHARS],
    [styleDirection ?? '', 'brief', MAX_BRIEF_TEXT_CHARS],
    [script ?? '', 'script', MAX_BRIEF_NAME_CHARS],
  ] as const) {
    const bounded = boundedText(value, field, max);
    if (!bounded.ok) return bounded;
  }

  const palette = boundedStringArray(raw['palettePreference'], 'palettePreference');
  if (!palette.ok) return palette;
  const avoid = boundedStringArray(raw['avoid'], 'avoid');
  if (!avoid.ok) return avoid;

  return {
    ok: true,
    brief: {
      brandName,
      industry,
      ...(styleDirection !== undefined ? { brief: styleDirection } : {}),
      ...(palette.value ? { palettePreference: palette.value } : {}),
      ...(avoid.value ? { avoid: avoid.value } : {}),
      ...(script !== undefined ? { script } : {}),
    },
  };
}

/**
 * The prose-extraction seam (implemented by `createProseBriefExtractor` in
 * proseBrief.ts).
 *
 * Declared structurally HERE, generic over the gig shape, rather than importing
 * the extractor's concrete type: config.ts imports this module for the $0
 * pricing branch, so brief.ts must stay a leaf whose only import is ./types.js
 * (see MIN_SOURCE_PX below for the same constraint stated from the other side).
 * Importing proseBrief.ts — which imports config.ts — would close that cycle.
 */
export interface LogoBriefExtractorLike<G> {
  extract(gig: G): Promise<BriefResult<LogoBrief>>;
}

/**
 * The combined brief resolver: fenced JSON first, prose extraction second.
 *
 * The fenced path stays free — the extractor is a paid model call and is only
 * reached when there is no valid fenced brief to find, so a gig that carries
 * one never pays for extraction.
 *
 * Extraction is NOT a relaxation. It cannot rescue a brief the fenced path
 * deliberately rejected (a non-Latin brand name, a blank field), because the
 * extractor re-validates its own candidate through this module's
 * `parseLogoBrief` before returning it. The fenced block is preferred not
 * because it is trusted more but because it is cheaper and unambiguous.
 *
 * Both reasons are reported on failure: "no fenced block" and "the prose named
 * no brand" are different problems for the buyer to fix.
 */
export async function resolveBrief<G extends { description?: string | null }>(
  gig: G,
  extractor: LogoBriefExtractorLike<G>,
): Promise<BriefResult<LogoBrief>> {
  const fenced = parseLogoBrief(gig.description ?? '');
  if (fenced.ok) return fenced;

  const extracted = await extractor.extract(gig);
  if (extracted.ok) return extracted;
  // An OUTAGE PROPAGATES UNCHANGED and is not merged with the fenced-path
  // reason. "This gig has no fenced block" is true but irrelevant when the
  // reason we cannot read the prose is that a vendor is down — and blending
  // the two produces a message that reads as the buyer's fault, attached to a
  // decision (park, not reject) that is ours.
  if (extracted.unavailable) return extracted;
  return {
    ok: false,
    reason: `${fenced.reason}; prose extraction also failed: ${extracted.reason}`,
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
