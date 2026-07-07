// T7 "pricing-table" — JiffyApp templates PRD T7, v1.0.0, $15. Fully static (no
// relay, no `/app.js`) — this template *displays* fixed plans (vs T2 `calculator`,
// which *computes*; see the templates-PRD disambiguation table).
//
// `featureMatrix[i].cells` maps plan NAME -> cell text; "every plan present in every
// row's cells" is a cross-slot invariant (`plans` + `featureMatrix` together, like
// csv-dashboard's `crossSlotErrors`) since each slot's own `validate` only sees its
// own value. `planSlug = normalizeSlug(plan.name)` drives both the `feature-<key>-
// <planSlug>` testid and collision-detection on plan names (two names that normalize
// to the same slug would collide on testids, so `validatePlans` dedupes by slug, not
// raw name).
//
// The highlighted plan's card still carries `data-testid="plan"` like every other
// card (an element can't carry two testids) — the badge is a separate nested element,
// `<span data-testid="highlight">`, present only on the highlighted card.

import { briefErrorsForTemplate, MATCHER_KEYWORDS } from '../brief.js';
import { normalizeSlug } from '../slug.js';
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
const FEATURE_KEY_RE = /^[a-z][a-z0-9-]*$/;

interface PricingPlan {
  name: string;
  price: string;
  period: string;
  ctaLabel: string;
  ctaHref: string;
  highlight: boolean;
}

interface FeatureRow {
  feature: string;
  key: string;
  cells: Record<string, string>;
}

function validatePlans(value: unknown): string[] {
  if (!Array.isArray(value)) return ['plans: must be an array'];
  const errors: string[] = [];
  if (value.length < 1 || value.length > 5) {
    errors.push('plans: must have 1-5 entries');
  }
  const seenSlugs = new Set<string>();
  let highlightCount = 0;
  value.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) {
      errors.push(`plans[${i}]: must be an object`);
      return;
    }
    const { name, price, period, ctaLabel, ctaHref, highlight } = item as Record<string, unknown>;
    if (typeof name !== 'string' || name.trim().length === 0) {
      errors.push(`plans[${i}].name: required non-empty string`);
    } else {
      const slug = normalizeSlug(name);
      if (seenSlugs.has(slug)) {
        errors.push(`plans[${i}].name: duplicate plan name "${name}"`);
      } else {
        seenSlugs.add(slug);
      }
    }
    if (typeof price !== 'string' || price.trim().length === 0) {
      errors.push(`plans[${i}].price: required non-empty string`);
    }
    if (typeof period !== 'string' || period.trim().length === 0) {
      errors.push(`plans[${i}].period: required non-empty string`);
    }
    if (typeof ctaLabel !== 'string' || ctaLabel.trim().length === 0) {
      errors.push(`plans[${i}].ctaLabel: required non-empty string`);
    }
    if (typeof ctaHref !== 'string' || !HTTPS_OR_MAILTO_RE.test(ctaHref)) {
      errors.push(`plans[${i}].ctaHref: must start with http:, https:, or mailto:`);
    }
    if (typeof highlight !== 'boolean') {
      errors.push(`plans[${i}].highlight: must be a boolean`);
    } else if (highlight) {
      highlightCount += 1;
    }
  });
  if (highlightCount > 1) {
    errors.push('plans: at most one plan may have highlight: true');
  }
  return errors;
}

function validateFeatureMatrix(value: unknown): string[] {
  if (!Array.isArray(value)) return ['featureMatrix: must be an array'];
  const errors: string[] = [];
  if (value.length > 15) {
    errors.push('featureMatrix: must have at most 15 entries');
  }
  const seenKeys = new Set<string>();
  value.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) {
      errors.push(`featureMatrix[${i}]: must be an object`);
      return;
    }
    const { feature, key, cells } = item as Record<string, unknown>;
    if (typeof feature !== 'string' || feature.trim().length === 0) {
      errors.push(`featureMatrix[${i}].feature: required non-empty string`);
    }
    if (typeof key !== 'string' || !FEATURE_KEY_RE.test(key)) {
      errors.push(`featureMatrix[${i}].key: must match ${FEATURE_KEY_RE.source}`);
    } else if (seenKeys.has(key)) {
      errors.push(`featureMatrix[${i}].key: duplicate key "${key}"`);
    } else {
      seenKeys.add(key);
    }
    if (typeof cells !== 'object' || cells === null || Array.isArray(cells)) {
      errors.push(`featureMatrix[${i}].cells: must be an object mapping plan name to cell text`);
    } else {
      for (const [cellKey, cellValue] of Object.entries(cells)) {
        if (typeof cellValue !== 'string') {
          errors.push(`featureMatrix[${i}].cells.${cellKey}: must be a string`);
        }
      }
    }
  });
  return errors;
}

const SLOTS: SlotSpec[] = [
  {
    name: 'headline',
    kind: 'copy',
    required: true,
    description: 'Page headline / title, e.g. "Simple, transparent pricing".',
    example: 'Simple, transparent pricing',
  },
  {
    name: 'plans',
    kind: 'json',
    required: true,
    description:
      'Array of 1-5 plans, each `{ name: string; price: string; period: string; ctaLabel: ' +
      'string; ctaHref: string; highlight: boolean }`. ctaHref must start with http:, https:, ' +
      'or mailto:. At most one plan may have highlight: true. Plan names must be unique.',
    example: [
      {
        name: 'Pro',
        price: '$19',
        period: 'month',
        ctaLabel: 'Start Pro',
        ctaHref: 'https://example.com/signup?plan=pro',
        highlight: true,
      },
    ],
    validate: validatePlans,
  },
  {
    name: 'featureMatrix',
    kind: 'json',
    required: true,
    description:
      'Array of 0-15 feature rows, each `{ feature: string; key: string; cells: Record<planName, ' +
      'string> }`. key must match /^[a-z][a-z0-9-]*$/ and be unique. cells must have an entry ' +
      'for every declared plan name (cell text like "✓", "—", or free text).',
    example: [{ feature: 'Seats', key: 'seats', cells: { Free: '1', Pro: '5' } }],
    validate: validateFeatureMatrix,
  },
  {
    name: 'accentHex',
    kind: 'style',
    required: true,
    description: 'Brand accent color as a 6-digit hex code, e.g. #0F3D3E.',
    example: '#0F3D3E',
  },
];

function plansFromSlots(slots: SlotValues): PricingPlan[] {
  const value = slots.plans;
  return Array.isArray(value) ? (value as PricingPlan[]) : [];
}

function featureMatrixFromSlots(slots: SlotValues): FeatureRow[] {
  const value = slots.featureMatrix;
  return Array.isArray(value) ? (value as FeatureRow[]) : [];
}

/**
 * Cross-slot validation: "every plan present in every row's cells" needs both
 * `plans` and `featureMatrix` together, which neither slot's own `validate` can see.
 */
function crossSlotErrors(slots: SlotValues): string[] {
  const errors: string[] = [];
  const plans = plansFromSlots(slots).filter((p) => typeof p?.name === 'string');
  const rows = featureMatrixFromSlots(slots);

  rows.forEach((row, i) => {
    if (typeof row !== 'object' || row === null) return; // already flagged by own validate
    const cells = row.cells;
    if (typeof cells !== 'object' || cells === null) return; // already flagged by own validate
    for (const plan of plans) {
      if (typeof cells[plan.name] !== 'string') {
        errors.push(`featureMatrix[${i}].cells: missing entry for plan "${plan.name}"`);
      }
    }
  });

  return errors;
}

function elementContract(slots: SlotValues): string[] {
  const plans = plansFromSlots(slots).filter((p) => typeof p?.name === 'string');
  const rows = featureMatrixFromSlots(slots).filter((r) => typeof r?.key === 'string');
  const base = ['plan', 'plan-name', 'plan-price', 'plan-cta', 'footer'];
  const cellIds: string[] = [];
  for (const row of rows) {
    for (const plan of plans) {
      cellIds.push(`feature-${row.key}-${normalizeSlug(plan.name)}`);
    }
  }
  const hasHighlight = plans.some((p) => p.highlight === true);
  return hasHighlight ? [...base, ...cellIds, 'highlight'] : [...base, ...cellIds];
}

function bindableTestids(slots: SlotValues): { exact: string[]; prefixes: string[] } {
  return { exact: elementContract(slots), prefixes: [] };
}

function briefErrors(brief: JiffyBrief): string[] {
  return briefErrorsForTemplate('pricing-table', brief);
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
.pricing { max-width: 960px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
h1 { font-size: clamp(1.5rem, 3vw, 2.25rem); margin: 0 0 2rem; text-align: center; }
.plans {
  display: grid;
  gap: 1.5rem;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  margin-bottom: 2.5rem;
}
.plan {
  position: relative;
  background: var(--surface);
  border-radius: 0.75rem;
  padding: 1.75rem 1.5rem;
  text-align: center;
}
.plan--highlight { outline: 2px solid var(--accent); background: #fff; }
.badge {
  display: inline-block;
  background: var(--accent);
  color: #fff;
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 0.25rem 0.6rem;
  border-radius: 999px;
  margin-bottom: 0.75rem;
}
.plan h2 { font-size: 1.1rem; margin: 0 0 0.5rem; }
.price { margin: 0 0 1.25rem; }
.price .amount { font-size: 2rem; font-weight: 700; }
.price .period { color: var(--muted); }
.cta {
  display: inline-block;
  background: var(--accent);
  color: #fff;
  padding: 0.7rem 1.4rem;
  border-radius: 0.5rem;
  text-decoration: none;
  font-weight: 600;
}
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--surface); }
thead th { color: var(--muted); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.03em; }
.jiffy-footer { text-align: center; padding: 2rem 1.5rem; color: var(--muted); font-size: 0.85rem; }
.jiffy-footer a { color: var(--muted); }
`;
}

function renderPlan(plan: PricingPlan): string {
  const badge = plan.highlight
    ? '<span data-testid="highlight" class="badge">Most popular</span>'
    : '';
  const cardClass = plan.highlight ? 'plan plan--highlight' : 'plan';
  return `
    <article class="${cardClass}" data-testid="plan">
      ${badge}
      <h2 data-testid="plan-name">${esc(plan.name)}</h2>
      <p class="price"><span class="amount" data-testid="plan-price">${esc(plan.price)}</span><span class="period">/${esc(plan.period)}</span></p>
      <a class="cta" data-testid="plan-cta" href="${esc(plan.ctaHref)}">${esc(plan.ctaLabel)}</a>
    </article>`;
}

function renderFeatureTable(plans: PricingPlan[], rows: FeatureRow[]): string {
  if (rows.length === 0) return '';
  const theadHtml = plans.map((p) => `<th scope="col">${esc(p.name)}</th>`).join('');
  const bodyHtml = rows
    .map((row) => {
      const cellsHtml = plans
        .map((plan) => {
          const slug = normalizeSlug(plan.name);
          const cellText = row.cells[plan.name] ?? '';
          return `<td data-testid="feature-${row.key}-${slug}">${esc(cellText)}</td>`;
        })
        .join('');
      return `<tr><th scope="row">${esc(row.feature)}</th>${cellsHtml}</tr>`;
    })
    .join('');
  return `<table>
    <thead><tr><th scope="col"></th>${theadHtml}</tr></thead>
    <tbody>${bodyHtml}</tbody>
  </table>`;
}

function render(slots: SlotValues, ctx: RenderContext): FileSet {
  const errors = [...validateSlots(PRICING_TABLE, slots), ...crossSlotErrors(slots)];
  if (errors.length > 0) throw new SlotError(errors);

  const headline = slots.headline as string;
  const plans = slots.plans as PricingPlan[];
  const featureMatrix = slots.featureMatrix as FeatureRow[];
  const accentHex = slots.accentHex as string;

  const plansHtml = plans.map(renderPlan).join('');
  const featureTableHtml = renderFeatureTable(plans, featureMatrix);

  const body = `<main class="pricing">
  <h1>${esc(headline)}</h1>
  <div class="plans">${plansHtml}
  </div>
  ${featureTableHtml}
</main>`;

  const html = pageShell({ title: headline, body, ctx });
  const css = buildStyles(accentHex);

  return {
    '/index.html': { content: html, contentType: 'text/html; charset=utf-8' },
    '/styles.css': { content: css, contentType: 'text/css; charset=utf-8' },
  };
}

const referenceBrief: JiffyBrief = {
  template: 'pricing-table',
  name: 'Pricing page for Northlight Studio',
  description:
    'Three-tier SaaS pricing page: Free, Pro (featured), and Team, comparing seat count and ' +
    'priority support.',
  copy: { headline: 'Simple, transparent pricing' },
  brand: { accentHex: '#0f4c81' },
};

const referenceSlots: SlotValues = {
  headline: 'Simple, transparent pricing',
  plans: [
    {
      name: 'Free',
      price: '$0',
      period: 'month',
      ctaLabel: 'Get started',
      ctaHref: 'https://example.com/signup?plan=free',
      highlight: false,
    },
    {
      name: 'Pro',
      price: '$19',
      period: 'month',
      ctaLabel: 'Start Pro',
      ctaHref: 'https://example.com/signup?plan=pro',
      highlight: true,
    },
    {
      name: 'Team',
      price: '$49',
      period: 'month',
      ctaLabel: 'Start Team',
      ctaHref: 'https://example.com/signup?plan=team',
      highlight: false,
    },
  ],
  featureMatrix: [
    { feature: 'Seats', key: 'seats', cells: { Free: '1', Pro: '5', Team: 'Unlimited' } },
    { feature: 'Priority support', key: 'support', cells: { Free: '—', Pro: '✓', Team: '✓' } },
  ],
  accentHex: '#0f4c81',
};

const referenceGoldens: GoldenSet = {
  goldens: [
    {
      title: 'Three plans render',
      steps: [],
      expect: [{ testid: 'plan', count: 3 }],
    },
    {
      title: 'Pro plan price is $19',
      steps: [],
      expect: [{ testid: 'plan-price', nth: 1, equals: '$19' }],
    },
    {
      title: 'Pro plan CTA links to the Pro signup',
      steps: [],
      expect: [{ testid: 'plan-cta', nth: 1, hrefEquals: 'https://example.com/signup?plan=pro' }],
    },
    {
      title: 'Pro seats feature cell shows 5',
      steps: [],
      expect: [{ testid: 'feature-seats-pro', equals: '5' }],
    },
    {
      title: 'Highlight badge is visible',
      steps: [],
      expect: [{ testid: 'highlight', visible: true }],
    },
  ],
};

export const PRICING_TABLE: TemplateDefinition = {
  id: 'pricing-table',
  version: '1.0.0',
  priceUsd: 15,
  matcherKeywords: MATCHER_KEYWORDS['pricing-table'],
  elementContract,
  bindableTestids,
  slots: SLOTS,
  briefErrors,
  render,
  goldenGuidance:
    'load-only goldens: `count(plan)`, `equals(plan-price, nth)` (exact string, no period ' +
    'suffix), `hrefEquals(plan-cta, nth)`, `equals(feature-<key>-<planSlug>, ...)` cell text, ' +
    '`visible(highlight)` when a plan is featured. No interactions — this template is fully ' +
    'static.',
  referenceBrief,
  referenceSlots,
  referenceGoldens,
};
