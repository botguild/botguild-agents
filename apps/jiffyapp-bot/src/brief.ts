// Brief intake + template matching (templates PRD §2/§3): the brief arrives as a
// fenced JSON block embedded in the gig description — there is no structured-brief
// channel. Extraction, validation, and matching are pure so the scorer wrapper, the
// queue consumer, and the thread-correction poller all share one implementation.
// Mirrors the VoiceWright `brief.ts` extraction pattern (fenced JSON first, then the
// largest inline `{...}` object, then give up).

import { TEMPLATE_IDS } from './types.js';
import type { JiffyBrief, TemplateId } from './types.js';

const FENCED_JSON_RE = /```json\s*([\s\S]*?)```/i;

/** Fenced ```json block first, else the first `{` through the last `}`. */
function extractJsonCandidate(description: string): string | undefined {
  const fenced = FENCED_JSON_RE.exec(description);
  if (fenced) return fenced[1].trim();

  const start = description.indexOf('{');
  const end = description.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return description.slice(start, end + 1);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Extract + shallow-validate the JiffyApp brief straight from a gig description. */
export function parseJiffyBrief(
  description: string,
): { ok: true; brief: JiffyBrief } | { ok: false; errors: string[] } {
  const candidate = extractJsonCandidate(description);
  if (candidate === undefined) {
    return { ok: false, errors: ['no JSON brief found'] };
  }

  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch (err) {
    return { ok: false, errors: [`invalid JSON: ${(err as Error).message}`] };
  }

  if (!isRecord(value)) {
    return { ok: false, errors: ['brief must be a JSON object'] };
  }

  const errors: string[] = [];
  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    errors.push('name: required non-empty string');
  }
  if (typeof value.description !== 'string' || value.description.trim().length === 0) {
    errors.push('description: required non-empty string');
  }
  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, brief: value as JiffyBrief };
}

/**
 * Recognize a cycle/edit gig by the `toolId` issued at first delivery. Accepts the
 * fenced-JSON form (`{"toolId": "..."}`) and a bare `toolId: <id>` line, since the
 * buyer pastes it from the delivery note (VoiceWright `extractBriefId` pattern).
 */
export function extractToolId(description: string): string | undefined {
  const candidate = extractJsonCandidate(description);
  if (candidate !== undefined) {
    try {
      const value = JSON.parse(candidate);
      if (isRecord(value) && typeof value.toolId === 'string' && value.toolId.trim().length > 0) {
        return value.toolId.trim();
      }
    } catch {
      // fall through to the bare-pattern match below
    }
  }
  // The `(?:^|[^A-Za-z0-9_])` guard requires `toolId` to be a standalone key, not a
  // suffix of a longer identifier (`extraToolId`, `myToolId`, `_toolId`) — a bare `\b`
  // wouldn't help here since there's no word-boundary between a lowercase letter and
  // an uppercase one (`a`|`T` in `extraToolId`).
  const match = /(?:^|[^A-Za-z0-9_])toolId\s*[:=]\s*["']?([A-Za-z0-9_-]{8,})["']?/i.exec(
    description,
  );
  return match ? match[1] : undefined;
}

// ---- Template matcher (templates PRD §2/§3) ----
// Qualifier parentheticals from the PRD are stripped since they never appear in gig
// text verbatim. NOTE: bare 'converter' belongs to transformer only — a
// numeric-converter brief must win via other calculator keywords, and that
// deliberate gap is why ties fall through to `null` rather than guessing.
export const MATCHER_KEYWORDS: Record<TemplateId, string[]> = {
  landing: ['landing page', 'launch page', 'homepage', 'one-pager', 'marketing site'],
  calculator: ['calculator', 'estimator', 'quote', 'pricing tool', 'estimate'],
  form: ['contact form', 'intake form', 'inquiry', 'get in touch', 'lead form'],
  'csv-dashboard': ['csv', 'dashboard', 'spreadsheet', 'data table', 'chart', 'report viewer'],
  widget: ['widget', 'embed', 'faq', 'accordion', 'countdown', 'testimonials'],
  'link-in-bio': ['link in bio', 'links page', 'linktree', 'profile page', 'socials page'],
  'pricing-table': ['pricing page', 'plans', 'tiers', 'compare plans', 'price list', 'menu'],
  quiz: ['quiz', 'assessment', 'personality test', 'scorecard', 'which x are you', 'lead magnet'],
  waitlist: [
    'waitlist',
    'coming soon',
    'pre-launch',
    'early access',
    'notify me',
    'launch countdown',
  ],
  transformer: [
    'formatter',
    'converter',
    'json',
    'slugify',
    'word count',
    'cleaner',
    'paste and convert',
  ],
};

const MIN_KEYWORD_HITS = 2;

function isValidTemplateId(value: string): value is TemplateId {
  return (TEMPLATE_IDS as readonly string[]).includes(value);
}

/**
 * Count distinct keyword-phrase hits for one template's keyword list against the
 * (already-lowercased) gig text. A matched keyword that is itself a substring of a
 * *different* matched keyword from the same list is the same signal under two names
 * (e.g. `'plans'` inside `'compare plans'` — issue: intra-list subsumption let one
 * real signal masquerade as two "distinct" hits and defeat `MIN_KEYWORD_HITS`), so it
 * is deduped down to the more specific (longer) phrase rather than counted twice.
 */
function countDistinctHits(keywords: readonly string[], text: string): number {
  const matched = keywords.filter((keyword) => text.includes(keyword));
  const distinct = matched.filter(
    (keyword) => !matched.some((other) => other !== keyword && other.includes(keyword)),
  );
  return distinct.length;
}

/**
 * Resolve a template for a gig. An explicit `brief.template` must be a valid
 * `TemplateId`, or the match fails outright — an explicit ask is never overridden
 * by a keyword guess. Absent that, distinct keyword-phrase hits (see
 * `countDistinctHits`) are counted per template over the lowercased gig text; the
 * winner needs at least `MIN_KEYWORD_HITS` hits and strictly more than the
 * runner-up, otherwise `null` (the caller logs the gig as off-catalog and skips it).
 */
export function matchTemplate(
  brief: JiffyBrief | null | undefined,
  gigText: string,
): { templateId: TemplateId; via: 'explicit' | 'keywords' } | null {
  if (brief?.template) {
    return isValidTemplateId(brief.template)
      ? { templateId: brief.template, via: 'explicit' }
      : null;
  }

  const text = gigText.toLowerCase();
  const scored = TEMPLATE_IDS.map((templateId) => ({
    templateId,
    hits: countDistinctHits(MATCHER_KEYWORDS[templateId], text),
  })).sort((a, b) => b.hits - a.hits);

  const [best, runnerUp] = scored;
  if (best.hits >= MIN_KEYWORD_HITS && (runnerUp === undefined || best.hits > runnerUp.hits)) {
    return { templateId: best.templateId, via: 'keywords' };
  }
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Per-template required-brief fields. Everything beyond `name`/`description` and
 * the notifyEmail rules below is codegen's job — goldens pin behavior at sign-off.
 */
export function briefErrorsForTemplate(templateId: TemplateId, brief: JiffyBrief): string[] {
  const errors: string[] = [];

  if (typeof brief.name !== 'string' || brief.name.trim().length === 0) {
    errors.push('name: required non-empty string');
  }
  if (typeof brief.description !== 'string' || brief.description.trim().length === 0) {
    errors.push('description: required non-empty string');
  }

  const requiresNotifyEmail =
    templateId === 'form' ||
    templateId === 'waitlist' ||
    (templateId === 'quiz' && brief.relayResult === true);
  if (requiresNotifyEmail) {
    if (typeof brief.notifyEmail !== 'string' || !EMAIL_RE.test(brief.notifyEmail)) {
      errors.push(`notifyEmail: required for the ${templateId} template (a valid email address)`);
    }
  }

  return errors;
}

/** Render field errors as a short correction request suitable for the contract thread. */
export function formatBriefErrors(errors: string[]): string {
  const lines = errors.map((e) => `- ${e}`);
  return [
    'The brief in this gig could not be validated:',
    ...lines,
    '',
    'Please reply in this thread with a corrected fenced ```json brief.',
  ].join('\n');
}
