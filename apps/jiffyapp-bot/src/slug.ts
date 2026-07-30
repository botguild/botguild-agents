// Slug policy (templates PRD §3): normalization + abuse/reservation checks for the
// buyer-facing `<slug>.jiffyapp.dev` hostname, plus the separate staging-URL scheme.
//
// Staging URLs are served publicly before a build is promoted, so `stagingSlug` is
// derived from the job's RANDOM deliverable token rather than a recomputable hash of
// the contractId — a `sha256(contractId)` slug would let anyone who knows the
// contractId browse an in-progress build. The token is persisted at claim time, so
// the staging slug stays stable across queue retries.

const MIN_SLUG_LENGTH = 3;
const MAX_SLUG_LENGTH = 40;

export const STAGING_PREFIX = 'stg-';
const STAGING_TOKEN_LENGTH = 24;

export const RESERVED = [
  'www',
  'api',
  'mail',
  'smtp',
  'stg',
  'staging',
  'dispatch',
  'jiffyapp',
  'abuse',
  'status',
  'docs',
  'app',
  'cdn',
  'assets',
  'admin',
  'dashboard',
];

export const PHISHING_FRAGMENTS = [
  'login',
  'signin',
  'sign-in',
  'verify',
  'account',
  'wallet',
  'password',
  'secure',
  'support',
];

export const BRAND_BLOCKLIST = [
  'paypal',
  'apple',
  'google',
  'microsoft',
  'meta',
  'facebook',
  'instagram',
  'whatsapp',
  'amazon',
  'netflix',
  'stripe',
  'coinbase',
  'binance',
  'venmo',
  'cashapp',
  'chase',
  'wellsfargo',
  'hsbc',
  'barclays',
  'irs',
];

/** Trims a trailing run of dashes left by a length cap or char-class strip. */
function trimTrailingDash(value: string): string {
  return value.replace(/-+$/, '');
}

/** Lowercase, replace anything outside `[a-z0-9-]` with `-`, collapse runs, trim edges, cap at 40. */
export function normalizeSlug(input: string): string {
  const lowered = input.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const collapsed = lowered.replace(/-+/g, '-').replace(/^-+/, '');
  return trimTrailingDash(collapsed.slice(0, MAX_SLUG_LENGTH));
}

/** Policy checks against an already-normalized slug. Empty array = allowed. */
export function slugPolicyErrors(slug: string): string[] {
  const errors: string[] = [];

  if (slug.length < MIN_SLUG_LENGTH) {
    errors.push(`too short: minimum ${MIN_SLUG_LENGTH} characters`);
  }
  if (slug.startsWith(STAGING_PREFIX)) {
    errors.push(`reserved staging prefix: slugs cannot start with "${STAGING_PREFIX}"`);
  }
  if (RESERVED.includes(slug)) {
    errors.push(`reserved word: "${slug}" is not available`);
  }
  for (const fragment of PHISHING_FRAGMENTS) {
    if (slug.includes(fragment)) {
      errors.push(`contains a phishing-risk fragment: "${fragment}"`);
    }
  }
  for (const brand of BRAND_BLOCKLIST) {
    if (slug.includes(brand)) {
      errors.push(`contains a blocked brand name: "${brand}"`);
    }
  }
  return errors;
}

/** Base slug (from preference, falling back to name) plus `-2`…`-9` suffix candidates. */
export function candidateSlugs(preference: string | undefined, name: string): string[] {
  const source = preference && preference.trim().length > 0 ? preference : name;
  const base = normalizeSlug(source);
  const candidates = [base];
  for (let n = 2; n <= 9; n++) {
    const suffix = `-${n}`;
    const maxBaseLength = MAX_SLUG_LENGTH - suffix.length;
    const truncatedBase =
      base.length > maxBaseLength ? trimTrailingDash(base.slice(0, maxBaseLength)) : base;
    candidates.push(`${truncatedBase}${suffix}`);
  }
  return candidates;
}

/**
 * Staging-URL slug for an in-progress build, derived from the job's random
 * deliverable token (not the contractId — see file header for why).
 */
export function stagingSlug(deliverableToken: string): string {
  return `${STAGING_PREFIX}${deliverableToken.slice(0, STAGING_TOKEN_LENGTH)}`;
}
