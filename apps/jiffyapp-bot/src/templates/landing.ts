// T1 "landing" — JiffyApp templates PRD T1, v1.0.0, $15.
//
// Recorded v1 narrowing vs the templates-PRD T1 spec (deliberate catalog decision,
// per §4 governance): feature entries are title+body only (no vendored icon set),
// and typography is a single bundled system font stack (no `fontStack` brand token).
// Rationale: the Foreman parent gate cares about a11y/perf, not art direction — a
// wider surface here would mean more slots to validate and more ways codegen can
// produce an inaccessible or off-brand page for no buyer-visible benefit at this
// price point. A future template version can widen this if demand shows up.

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

interface LandingFeature {
  title: string;
  body: string;
}

function isLandingFeature(value: unknown): value is LandingFeature {
  if (typeof value !== 'object' || value === null) return false;
  const { title, body } = value as Record<string, unknown>;
  return typeof title === 'string' && typeof body === 'string';
}

function validateCtaHref(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return HTTPS_OR_MAILTO_RE.test(value)
    ? []
    : ['ctaHref: must start with http:, https:, or mailto:'];
}

function validateOgImageUrl(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return HTTPS_URL_RE.test(value) ? [] : ['ogImageUrl: must be an https:// URL'];
}

function validateFeatures(value: unknown): string[] {
  if (!Array.isArray(value)) return ['features: must be an array'];
  const errors: string[] = [];
  if (value.length < 2 || value.length > 6) {
    errors.push('features: must have 2-6 entries');
  }
  value.forEach((item, i) => {
    if (!isLandingFeature(item)) {
      errors.push(`features[${i}]: must be an object with string "title" and "body"`);
      return;
    }
    if (item.title.trim().length === 0) errors.push(`features[${i}].title: required non-empty`);
    if (item.body.trim().length === 0) errors.push(`features[${i}].body: required non-empty`);
  });
  return errors;
}

const SLOTS: SlotSpec[] = [
  {
    name: 'headline',
    kind: 'copy',
    required: true,
    description: 'Hero headline. One short, punchy sentence or fragment.',
    example: 'Know your coffee numbers',
  },
  {
    name: 'subheadline',
    kind: 'copy',
    required: true,
    description: 'Hero subheadline. One sentence expanding on the headline.',
    example: 'Real-time analytics for specialty roasters.',
  },
  {
    name: 'ctaLabel',
    kind: 'copy',
    required: true,
    description: 'Call-to-action button label. Short imperative phrase.',
    example: 'Start free',
  },
  {
    name: 'ctaHref',
    kind: 'copy',
    required: true,
    description: 'Call-to-action destination URL. Must start with http:, https:, or mailto:.',
    example: 'https://example.com/signup',
    validate: validateCtaHref,
  },
  {
    name: 'features',
    kind: 'json',
    required: true,
    description:
      'Array of 2-6 feature entries, each `{ title: string; body: string }`. title is a short ' +
      'label, body is one sentence.',
    example: [{ title: 'Dashboards', body: 'See every metric in one place.' }],
    validate: validateFeatures,
  },
  {
    name: 'accentHex',
    kind: 'style',
    required: true,
    description: 'Brand accent color as a 6-digit hex code, e.g. #0F3D3E.',
    example: '#0F3D3E',
  },
  {
    name: 'ogTitle',
    kind: 'copy',
    required: true,
    description: 'Open Graph / <title> text shown in link previews and browser tabs.',
    example: 'Brew Metrics',
  },
  {
    name: 'ogDescription',
    kind: 'copy',
    required: true,
    description: 'Open Graph description shown in link previews.',
    example: 'Real-time analytics for specialty roasters.',
  },
  {
    name: 'ogImageUrl',
    kind: 'copy',
    required: false,
    description: 'Optional Open Graph image URL, must be https://.',
    example: 'https://example.com/og.png',
    validate: validateOgImageUrl,
  },
];

const LANDING_TESTIDS = [
  'hero-headline',
  'hero-sub',
  'cta',
  'feature',
  'feature-title',
  'feature-body',
  'footer',
];

function elementContract(_slots: SlotValues): string[] {
  return [...LANDING_TESTIDS];
}

function bindableTestids(slots: SlotValues): { exact: string[]; prefixes: string[] } {
  return { exact: elementContract(slots), prefixes: [] };
}

function briefErrors(brief: JiffyBrief): string[] {
  return briefErrorsForTemplate('landing', brief);
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
a { color: var(--accent); }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.landing { max-width: 960px; margin: 0 auto; padding: 0 1.5rem; }
.hero { padding: 4rem 0 3rem; text-align: center; }
.hero h1 { font-size: clamp(2rem, 4vw, 3rem); margin: 0 0 1rem; }
.hero p { font-size: 1.15rem; color: var(--muted); margin: 0 0 2rem; }
.cta {
  display: inline-block;
  background: var(--accent);
  color: #fff;
  padding: 0.85rem 1.75rem;
  border-radius: 0.5rem;
  text-decoration: none;
  font-weight: 600;
}
.cta:hover { opacity: 0.92; }
.features {
  display: grid;
  gap: 1.5rem;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  padding: 2rem 0 4rem;
}
.features article { background: var(--surface); border-radius: 0.75rem; padding: 1.5rem; }
.features h2 { font-size: 1.1rem; margin: 0 0 0.5rem; }
.features p { margin: 0; color: var(--muted); }
.jiffy-footer { text-align: center; padding: 2rem 1.5rem; color: var(--muted); font-size: 0.85rem; }
.jiffy-footer a { color: var(--muted); }
`;
}

function render(slots: SlotValues, ctx: RenderContext): FileSet {
  const errors = validateSlots(LANDING, slots);
  if (errors.length > 0) throw new SlotError(errors);

  const headline = slots.headline as string;
  const subheadline = slots.subheadline as string;
  const ctaLabel = slots.ctaLabel as string;
  const ctaHref = slots.ctaHref as string;
  const features = slots.features as LandingFeature[];
  const accentHex = slots.accentHex as string;
  const ogTitle = slots.ogTitle as string;
  const ogDescription = slots.ogDescription as string;
  const ogImageUrl = slots.ogImageUrl as string | undefined;

  const featuresHtml = features
    .map(
      (f) => `
    <article data-testid="feature">
      <h2 data-testid="feature-title">${esc(f.title)}</h2>
      <p data-testid="feature-body">${esc(f.body)}</p>
    </article>`,
    )
    .join('');

  const body = `<main class="landing">
  <section class="hero">
    <h1 data-testid="hero-headline">${esc(headline)}</h1>
    <p data-testid="hero-sub">${esc(subheadline)}</p>
    <a data-testid="cta" class="cta" href="${esc(ctaHref)}">${esc(ctaLabel)}</a>
  </section>
  <section class="features">${featuresHtml}
  </section>
</main>`;

  let metas = `<meta property="og:title" content="${esc(ogTitle)}"><meta property="og:description" content="${esc(ogDescription)}">`;
  if (ogImageUrl) {
    metas += `<meta property="og:image" content="${esc(ogImageUrl)}">`;
  }

  const html = pageShell({ title: ogTitle, metas, body, ctx });
  const css = buildStyles(accentHex);

  return {
    '/index.html': { content: html, contentType: 'text/html; charset=utf-8' },
    '/styles.css': { content: css, contentType: 'text/css; charset=utf-8' },
  };
}

const referenceBrief: JiffyBrief = {
  template: 'landing',
  name: 'LaunchPage for Brew Metrics',
  description:
    'Coffee analytics SaaS launch page: hero, three features (dashboards, alerts, exports), ' +
    'CTA to https://brewmetrics.example.com/signup',
  copy: { headline: 'Know your coffee numbers' },
  brand: { accentHex: '#0F3D3E' },
};

const referenceSlots: SlotValues = {
  headline: 'Know your coffee numbers',
  subheadline: 'Real-time analytics for specialty roasters.',
  ctaLabel: 'Start free',
  ctaHref: 'https://brewmetrics.example.com/signup',
  features: [
    { title: 'Dashboards', body: 'See every roast metric in one live dashboard.' },
    { title: 'Alerts', body: 'Get notified the moment a batch drifts off spec.' },
    { title: 'Exports', body: 'Export clean CSVs for your accountant in one click.' },
  ],
  accentHex: '#0F3D3E',
  ogTitle: 'Brew Metrics',
  ogDescription: 'Real-time analytics for specialty roasters.',
};

const referenceGoldens: GoldenSet = {
  goldens: [
    {
      title: 'Hero copy renders',
      steps: [],
      expect: [
        { testid: 'hero-headline', equals: 'Know your coffee numbers' },
        { testid: 'hero-sub', equals: 'Real-time analytics for specialty roasters.' },
      ],
    },
    {
      title: 'CTA links to signup',
      steps: [],
      expect: [{ testid: 'cta', hrefEquals: 'https://brewmetrics.example.com/signup' }],
    },
    {
      title: 'Three features present',
      steps: [],
      expect: [
        { testid: 'feature', count: 3 },
        { testid: 'feature-title', nth: 0, equals: 'Dashboards' },
      ],
    },
    {
      title: 'OG tags',
      steps: [],
      expect: [
        { titleEquals: 'Brew Metrics' },
        { metaEquals: { property: 'og:title', value: 'Brew Metrics' } },
      ],
    },
  ],
};

export const LANDING: TemplateDefinition = {
  id: 'landing',
  version: '1.0.0',
  priceUsd: 15,
  matcherKeywords: MATCHER_KEYWORDS.landing,
  elementContract,
  bindableTestids,
  slots: SLOTS,
  briefErrors,
  render,
  goldenGuidance:
    'load-only goldens: `equals` on hero-headline/hero-sub/feature-title (nth), `hrefEquals` on ' +
    'cta, `count` on feature, `titleEquals`, `metaEquals` on og:title/og:description (and ' +
    'og:image when provided). No interactions.',
  referenceBrief,
  referenceSlots,
  referenceGoldens,
};
