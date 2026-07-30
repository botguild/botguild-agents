// Brief intake (FR-1/§8): the brief arrives as a fenced JSON block embedded in
// the gig description — there is no structured-brief channel. Extraction and
// validation are pure so the scorer wrapper, the queue consumer, and the
// thread-correction poller all share one implementation.

import type { AdBrief, ReadabilityBrief } from './types.js';

export interface FieldError {
  field: string;
  message: string;
}

export type BriefResult<T> = { ok: true; brief: T } | { ok: false; errors: FieldError[] };

const DEFAULT_VARIANT_COUNT = 10;
const DEFAULT_ANGLE_COUNT = 3;
const MAX_VARIANT_COUNT = 25;

/** Extract the first fenced JSON block (```json ... ``` or bare ``` ... ```). */
export function extractFencedJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const fences = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)];
  if (fences.length === 0) {
    return { ok: false, error: 'no fenced JSON block found' };
  }
  for (const fence of fences) {
    const body = (fence[1] as string).trim();
    if (!body.startsWith('{')) continue;
    try {
      return { ok: true, value: JSON.parse(body) };
    } catch (err) {
      return { ok: false, error: `fenced block is not valid JSON: ${(err as Error).message}` };
    }
  }
  return { ok: false, error: 'no fenced block contains a JSON object' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(
  obj: Record<string, unknown>,
  field: string,
  errors: FieldError[],
  prefix = '',
): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push({ field: `${prefix}${field}`, message: 'required non-empty string' });
    return '';
  }
  return value.trim();
}

/**
 * Hand-rolled typed validation of the ad-copy brief. Field-level errors feed
 * the FR-1 correction request posted to the contract thread. A brief missing
 * `campaign`/`creative` scaffolding is rejected outright — a copy-only CSV
 * cannot import as ads (§8).
 */
export function validateAdBrief(value: unknown): BriefResult<AdBrief> {
  if (!isRecord(value)) {
    return { ok: false, errors: [{ field: '(root)', message: 'brief must be a JSON object' }] };
  }
  const errors: FieldError[] = [];

  const brandVoiceGuide = requireString(value, 'brandVoiceGuide', errors);
  const offer = requireString(value, 'offer', errors);
  const platform = requireString(value, 'platform', errors);

  let campaign: AdBrief['campaign'] = { campaignName: '', objective: '', adSetName: '' };
  if (!isRecord(value['campaign'])) {
    errors.push({
      field: 'campaign',
      message: 'required object: { campaignName, objective, adSetName }',
    });
  } else {
    const c = value['campaign'];
    campaign = {
      campaignName: requireString(c, 'campaignName', errors, 'campaign.'),
      objective: requireString(c, 'objective', errors, 'campaign.'),
      adSetName: requireString(c, 'adSetName', errors, 'campaign.'),
    };
  }

  let creative: AdBrief['creative'] = { landingUrl: '', pageId: '', imageRef: '' };
  if (!isRecord(value['creative'])) {
    errors.push({
      field: 'creative',
      message: 'required object: { landingUrl, pageId, imageRef }',
    });
  } else {
    const c = value['creative'];
    creative = {
      landingUrl: requireString(c, 'landingUrl', errors, 'creative.'),
      pageId: requireString(c, 'pageId', errors, 'creative.'),
      imageRef: requireString(c, 'imageRef', errors, 'creative.'),
    };
    if (creative.landingUrl && !/^https?:\/\//i.test(creative.landingUrl)) {
      errors.push({ field: 'creative.landingUrl', message: 'must be an http(s) URL' });
    }
  }

  let variantCount = DEFAULT_VARIANT_COUNT;
  if (value['variantCount'] !== undefined) {
    const n = value['variantCount'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_VARIANT_COUNT) {
      errors.push({ field: 'variantCount', message: `must be an integer 1–${MAX_VARIANT_COUNT}` });
    } else {
      variantCount = n;
    }
  }

  let angleCount = DEFAULT_ANGLE_COUNT;
  if (value['angleCount'] !== undefined) {
    const n = value['angleCount'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 3 || n > 10) {
      errors.push({
        field: 'angleCount',
        message: 'must be an integer 3–10 (≥3 angles are contractual)',
      });
    } else {
      angleCount = n;
    }
  }
  if (angleCount > variantCount) {
    errors.push({ field: 'angleCount', message: 'cannot exceed variantCount' });
  }

  let policyConstraints: string[] = [];
  if (value['policyConstraints'] !== undefined) {
    const list = value['policyConstraints'];
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
      errors.push({ field: 'policyConstraints', message: 'must be an array of strings' });
    } else {
      policyConstraints = (list as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const brief: AdBrief = {
    brandVoiceGuide,
    offer,
    campaign,
    creative,
    platform,
    variantCount,
    angleCount,
    policyConstraints,
  };
  const briefId = value['briefId'];
  if (typeof briefId === 'string' && briefId.trim().length > 0) brief.briefId = briefId.trim();
  return { ok: true, brief };
}

/** Extract + validate the ad brief straight from a gig description. */
export function parseAdBrief(description: string): BriefResult<AdBrief> {
  const extracted = extractFencedJson(description);
  if (!extracted.ok) {
    return { ok: false, errors: [{ field: '(brief)', message: extracted.error }] };
  }
  return validateAdBrief(extracted.value);
}

/** The FREE readability gig's brief: `{ "paragraph": "..." }` (Story B). */
export function parseReadabilityBrief(description: string): BriefResult<ReadabilityBrief> {
  const extracted = extractFencedJson(description);
  if (!extracted.ok) {
    return { ok: false, errors: [{ field: '(brief)', message: extracted.error }] };
  }
  if (!isRecord(extracted.value) || typeof extracted.value['paragraph'] !== 'string') {
    return { ok: false, errors: [{ field: 'paragraph', message: 'required string' }] };
  }
  const paragraph = extracted.value['paragraph'].trim();
  if (paragraph.length === 0) {
    return { ok: false, errors: [{ field: 'paragraph', message: 'required non-empty string' }] };
  }
  // A full ad brief also carries strings — treat as readability only when the
  // description isn't an ad brief (paragraph is the discriminator field).
  return { ok: true, brief: { paragraph } };
}

/**
 * Recognize a refresh gig by the `briefId` issued at first delivery (FR-10).
 * Accepts the fenced-JSON form (`{"briefId": "..."}`) and a bare
 * `briefId: <id>` line, since the buyer pastes it from the delivery note.
 */
export function extractBriefId(description: string): string | undefined {
  const extracted = extractFencedJson(description);
  if (extracted.ok && isRecord(extracted.value)) {
    const briefId = extracted.value['briefId'];
    if (typeof briefId === 'string' && briefId.trim().length > 0) return briefId.trim();
  }
  const match = /briefId\s*[:=]\s*["']?([A-Za-z0-9_-]{8,})["']?/.exec(description);
  return match ? match[1] : undefined;
}

/** Render field errors as the FR-1 correction request posted to the thread. */
export function formatBriefErrors(errors: FieldError[]): string {
  const lines = errors.map((e) => `- \`${e.field}\`: ${e.message}`);
  return [
    'The brief in this gig could not be validated. Please post a corrected fenced JSON brief in this thread:',
    ...lines,
    '',
    'I re-check this thread every 15 minutes and will start work as soon as a valid brief arrives.',
  ].join('\n');
}
