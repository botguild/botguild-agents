// T6 "link-in-bio" — JiffyApp templates PRD T6, v1.0.0, $10. Fully static (no relay,
// no `/app.js`) — the highest-volume ask that is pure content.
//
// `avatarDataUrl` arrives already re-hosted as a `data:image/*;base64,...` URI (the
// pipeline's image-fetch stage fetches + moderates the buyer's avatar URL at build
// time and hands codegen the resulting data URL — see jiffyapp.md's pipeline task);
// this template only validates the prefix, never fetches anything itself.
//
// Social icons are a small in-template inline-SVG map (`SOCIAL_ICONS`), not a
// vendored icon font/library — same-origin, CSP-clean, zero extra files.

import { briefErrorsForTemplate, MATCHER_KEYWORDS } from '../brief.js';
import type { FileSet, GoldenSet, JiffyBrief, SlotValues } from '../types.js';
import {
  esc,
  pageShell,
  SlotError,
  validateSlots,
  type RenderContext,
  type SlotSpec,
  type TemplateDefinition,
} from './engine.js';

const HTTPS_OR_MAILTO_RE = /^(https?:|mailto:)/;
const HTTPS_URL_RE = /^https:\/\//;
const DATA_IMAGE_RE = /^data:image\//;

const SOCIAL_NETWORKS = ['x', 'github', 'instagram', 'linkedin', 'youtube', 'tiktok'] as const;
type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

const SOCIAL_LABELS: Record<SocialNetwork, string> = {
  x: 'X',
  github: 'GitHub',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  tiktok: 'TikTok',
};

// Small, simple, same-origin inline icons — decorative (aria-hidden); the anchor
// itself carries the accessible name via `aria-label`.
const SOCIAL_ICONS: Record<SocialNetwork, string> = {
  x: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 4l16 16M20 4L4 20" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
  github:
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.46-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.9-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z" fill="currentColor"/></svg>',
  instagram:
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor"/></svg>',
  linkedin:
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><path d="M8 11v7M12 11v7M12 14c0-2 4-2 4 0v4" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
  youtube:
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 9l6 3-6 3z" fill="currentColor"/></svg>',
  tiktok:
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M14 3v11.5a3.5 3.5 0 1 1-3-3.46" stroke="currentColor" stroke-width="2" fill="none"/><path d="M14 3c.5 3 2.5 5 5 5.3" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
};

interface BioLink {
  label: string;
  url: string;
}

interface BioSocial {
  network: SocialNetwork;
  url: string;
}

function isSocialNetwork(value: unknown): value is SocialNetwork {
  return typeof value === 'string' && (SOCIAL_NETWORKS as readonly string[]).includes(value);
}

function validateAvatarDataUrl(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return DATA_IMAGE_RE.test(value) ? [] : ['avatarDataUrl: must start with "data:image/"'];
}

function validateLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return ['links: must be an array'];
  const errors: string[] = [];
  if (value.length < 1 || value.length > 20) {
    errors.push('links: must have 1-20 entries');
  }
  value.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) {
      errors.push(`links[${i}]: must be an object`);
      return;
    }
    const { label, url } = item as Record<string, unknown>;
    if (typeof label !== 'string' || label.trim().length === 0) {
      errors.push(`links[${i}].label: required non-empty string`);
    }
    if (typeof url !== 'string' || !HTTPS_OR_MAILTO_RE.test(url)) {
      errors.push(`links[${i}].url: must start with http:, https:, or mailto:`);
    }
  });
  return errors;
}

function validateSocials(value: unknown): string[] {
  if (!Array.isArray(value)) return ['socials: must be an array'];
  const errors: string[] = [];
  if (value.length > 8) {
    errors.push('socials: must have at most 8 entries');
  }
  const seen = new Set<string>();
  value.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) {
      errors.push(`socials[${i}]: must be an object`);
      return;
    }
    const { network, url } = item as Record<string, unknown>;
    if (!isSocialNetwork(network)) {
      errors.push(`socials[${i}].network: must be one of ${SOCIAL_NETWORKS.join('|')}`);
    } else if (seen.has(network)) {
      errors.push(`socials[${i}].network: duplicate network "${network}"`);
    } else {
      seen.add(network);
    }
    if (typeof url !== 'string' || !HTTPS_URL_RE.test(url)) {
      errors.push(`socials[${i}].url: must be an https:// URL`);
    }
  });
  return errors;
}

const SLOTS: SlotSpec[] = [
  {
    name: 'displayName',
    kind: 'copy',
    required: true,
    description: 'Profile display name shown as the page heading.',
    example: 'Jordan Lane',
  },
  {
    name: 'bio',
    kind: 'copy',
    required: true,
    description: 'One or two sentences of profile bio copy.',
    example: 'Product designer building small tools on the side.',
  },
  {
    name: 'avatarDataUrl',
    kind: 'copy',
    required: false,
    description:
      'Optional avatar image as a re-hosted `data:image/*;base64,...` URI (supplied by the ' +
      "pipeline's image-fetch stage from the buyer's avatar URL, not typed by codegen).",
    example: 'data:image/png;base64,iVBORw0KGgo=',
    validate: validateAvatarDataUrl,
  },
  {
    name: 'links',
    kind: 'json',
    required: true,
    description:
      'Array of 1-20 links, each `{ label: string; url: string }`. url must start with http:, ' +
      'https:, or mailto:.',
    example: [{ label: 'Portfolio', url: 'https://example.com' }],
    validate: validateLinks,
  },
  {
    name: 'socials',
    kind: 'json',
    required: false,
    description:
      'Optional array of 0-8 social links, each `{ network: "x" | "github" | "instagram" | ' +
      '"linkedin" | "youtube" | "tiktok"; url: string }`. url must be an https:// URL. Networks ' +
      'must be unique.',
    example: [{ network: 'github', url: 'https://github.com/example' }],
    validate: validateSocials,
  },
  {
    name: 'ogTitle',
    kind: 'copy',
    required: true,
    description: 'Open Graph / <title> text shown in link previews and browser tabs.',
    example: 'Jordan Lane — links',
  },
  {
    name: 'ogDescription',
    kind: 'copy',
    required: true,
    description: 'Open Graph description shown in link previews.',
    example: "All of Jordan Lane's links in one place.",
  },
  {
    name: 'accentHex',
    kind: 'style',
    required: true,
    description: 'Brand accent color as a 6-digit hex code, e.g. #0F3D3E.',
    example: '#0F3D3E',
  },
];

function socialsFromSlots(slots: SlotValues): BioSocial[] {
  const value = slots.socials;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is BioSocial =>
      typeof v === 'object' && v !== null && isSocialNetwork((v as BioSocial).network),
  );
}

function elementContract(slots: SlotValues): string[] {
  const base = ['display-name', 'bio', 'link', 'footer'];
  const withAvatar = slots.avatarDataUrl ? [...base, 'avatar'] : base;
  const socialIds = socialsFromSlots(slots).map((s) => `social-${s.network}`);
  return [...withAvatar, ...socialIds];
}

function bindableTestids(slots: SlotValues): { exact: string[]; prefixes: string[] } {
  return { exact: elementContract(slots), prefixes: [] };
}

function briefErrors(brief: JiffyBrief): string[] {
  return briefErrorsForTemplate('link-in-bio', brief);
}

function buildStyles(accentHex: string): string {
  return `:root {
  --accent: ${accentHex};
  --text: #12181b;
  --muted: #45535a;
  --bg: #ffffff;
  --surface: #f4f6f5;
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--text);
  background: var(--bg);
  line-height: 1.5;
}
.bio { max-width: 480px; margin: 0 auto; padding: 3rem 1.5rem 4rem; text-align: center; }
.avatar { width: 6rem; height: 6rem; border-radius: 50%; object-fit: cover; margin: 0 0 1.25rem; }
h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
.bio-text { color: var(--muted); margin: 0 0 2rem; }
.links { list-style: none; margin: 0 0 2rem; padding: 0; display: grid; gap: 0.75rem; }
.links a {
  display: block;
  padding: 0.85rem 1rem;
  border-radius: 0.6rem;
  background: var(--surface);
  color: var(--text);
  text-decoration: none;
  font-weight: 600;
}
.links a:hover { background: var(--accent); color: #fff; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.socials { display: flex; justify-content: center; gap: 0.75rem; }
.socials a { color: var(--muted); display: inline-flex; }
.socials a:hover { color: var(--accent); }
.jiffy-footer { text-align: center; padding: 2rem 1.5rem; color: var(--muted); font-size: 0.85rem; }
.jiffy-footer a { color: var(--muted); }
`;
}

function render(slots: SlotValues, ctx: RenderContext): FileSet {
  const errors = validateSlots(LINK_IN_BIO, slots);
  if (errors.length > 0) throw new SlotError(errors);

  const displayName = slots.displayName as string;
  const bio = slots.bio as string;
  const avatarDataUrl = slots.avatarDataUrl as string | undefined;
  const links = slots.links as BioLink[];
  const socials = socialsFromSlots(slots);
  const ogTitle = slots.ogTitle as string;
  const ogDescription = slots.ogDescription as string;
  const accentHex = slots.accentHex as string;

  const avatarHtml = avatarDataUrl
    ? `<img class="avatar" data-testid="avatar" src="${esc(avatarDataUrl)}" alt="">`
    : '';

  const linksHtml = links
    .map((l) => `<li><a data-testid="link" href="${esc(l.url)}">${esc(l.label)}</a></li>`)
    .join('');

  const socialsHtml =
    socials.length > 0
      ? `<div class="socials">${socials
          .map(
            (s) =>
              `<a data-testid="social-${s.network}" href="${esc(s.url)}" aria-label="${esc(SOCIAL_LABELS[s.network])}">${SOCIAL_ICONS[s.network]}</a>`,
          )
          .join('')}</div>`
      : '';

  const body = `<main class="bio">
  ${avatarHtml}
  <h1 data-testid="display-name">${esc(displayName)}</h1>
  <p class="bio-text" data-testid="bio">${esc(bio)}</p>
  <ul class="links">${linksHtml}</ul>
  ${socialsHtml}
</main>`;

  const metas = `<meta property="og:title" content="${esc(ogTitle)}"><meta property="og:description" content="${esc(ogDescription)}">`;

  const html = pageShell({ title: ogTitle, metas, body, ctx });
  const css = buildStyles(accentHex);

  return {
    '/index.html': { content: html, contentType: 'text/html; charset=utf-8' },
    '/styles.css': { content: css, contentType: 'text/css; charset=utf-8' },
  };
}

const referenceBrief: JiffyBrief = {
  template: 'link-in-bio',
  name: 'Link-in-bio for Jordan Lane',
  description:
    'Link-in-bio profile page for a product designer: portfolio, newsletter, and booking ' +
    'links, plus GitHub and X social links.',
  copy: { headline: 'Jordan Lane' },
  brand: { accentHex: '#0F3D3E' },
};

const referenceSlots: SlotValues = {
  displayName: 'Jordan Lane',
  bio: 'Product designer building small tools on the side.',
  links: [
    { label: 'Portfolio', url: 'https://jordanlane.example.com' },
    { label: 'Newsletter', url: 'https://jordanlane.example.com/newsletter' },
    { label: 'Book a call', url: 'mailto:jordan@example.com' },
  ],
  socials: [
    { network: 'github', url: 'https://github.com/jordanlane' },
    { network: 'x', url: 'https://x.com/jordanlane' },
  ],
  ogTitle: 'Jordan Lane — links',
  ogDescription: "All of Jordan Lane's links in one place.",
  accentHex: '#0F3D3E',
};

const referenceGoldens: GoldenSet = {
  goldens: [
    {
      title: 'Display name renders',
      steps: [],
      expect: [{ testid: 'display-name', equals: 'Jordan Lane' }],
    },
    {
      title: 'Three links render',
      steps: [],
      expect: [{ testid: 'link', count: 3 }],
    },
    {
      title: 'First link points to the portfolio',
      steps: [],
      expect: [{ testid: 'link', nth: 0, hrefEquals: 'https://jordanlane.example.com' }],
    },
    {
      title: 'GitHub social starts with the profile base URL',
      steps: [],
      expect: [{ testid: 'social-github', hrefStartsWith: 'https://github.com/' }],
    },
    {
      title: 'OG title matches',
      steps: [],
      expect: [{ metaEquals: { property: 'og:title', value: 'Jordan Lane — links' } }],
    },
  ],
};

export const LINK_IN_BIO: TemplateDefinition = {
  id: 'link-in-bio',
  version: '1.0.0',
  priceUsd: 10,
  matcherKeywords: MATCHER_KEYWORDS['link-in-bio'],
  elementContract,
  bindableTestids,
  slots: SLOTS,
  briefErrors,
  render,
  goldenGuidance:
    'load-only goldens: `equals(display-name)`, `equals(bio)`, `count(link)`, `hrefEquals(link, ' +
    'nth)`, `hrefStartsWith(social-<network>, ...)`, `metaEquals` on og:title/og:description. No ' +
    'interactions — this template is fully static.',
  referenceBrief,
  referenceSlots,
  referenceGoldens,
};
