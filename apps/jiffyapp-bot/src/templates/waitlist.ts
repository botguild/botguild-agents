// T9 "waitlist" — JiffyApp templates PRD T9, v1.0.0, $10. Relay-bearing, like `form`:
// email signups post through `/relay/<toolId>?t=<token>` (Task 19), never directly to
// notifyEmail.
//
// The countdown target (`data-target="{launchIso}"`) is baked into the STATIC HTML so
// goldens can assert it with `attrEquals` — a ticking clock can never be a stable
// golden assertion. `/app.js` only ticks the *visible text* inside the countdown
// element (a `setInterval`, permitted for tool JS) and never touches the attribute.
// Like `form`, the relay URL is injected into a static app.js source via a
// marker-replace with a function replacer (see form.ts header for why: injected JSON
// can contain `$`-prefixed sequences that plain-string .replace would misinterpret).

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

function validateLaunchIso(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return Number.isFinite(Date.parse(value))
    ? []
    : ['launchIso: must be a valid ISO-8601 date-time string'];
}

const SLOTS: SlotSpec[] = [
  {
    name: 'headline',
    kind: 'copy',
    required: true,
    description: 'Hero headline. One short, punchy sentence or fragment.',
    example: 'Aurora launches soon',
  },
  {
    name: 'subheadline',
    kind: 'copy',
    required: true,
    description: 'Hero subheadline. One sentence expanding on the headline.',
    example: 'Be first to try the new way to plan your week.',
  },
  {
    name: 'launchIso',
    kind: 'copy',
    required: true,
    description: 'Launch date/time as an ISO-8601 string, e.g. "2026-09-01T09:00:00Z".',
    example: '2026-09-01T09:00:00Z',
    validate: validateLaunchIso,
  },
  {
    name: 'emailLabel',
    kind: 'copy',
    required: true,
    description: 'Label for the email capture input.',
    example: 'Email address',
  },
  {
    name: 'successCopy',
    kind: 'copy',
    required: true,
    description: 'Message shown after a successful signup.',
    example: "You're on the list — we'll email you at launch.",
  },
  {
    name: 'errorCopy',
    kind: 'copy',
    required: true,
    description: 'Message shown when the entered email fails validation or the relay errors.',
    example: 'Please enter a valid email address.',
  },
  {
    name: 'ogTitle',
    kind: 'copy',
    required: true,
    description: 'Open Graph / <title> text shown in link previews and browser tabs.',
    example: 'Aurora — launching soon',
  },
  {
    name: 'ogDescription',
    kind: 'copy',
    required: true,
    description: 'Open Graph description shown in link previews.',
    example: 'Join the waitlist for early access to Aurora.',
  },
  {
    name: 'accentHex',
    kind: 'style',
    required: true,
    description: 'Brand accent color as a 6-digit hex code, e.g. #0F3D3E.',
    example: '#0F3D3E',
  },
];

const WAITLIST_TESTIDS = [
  'headline',
  'countdown',
  'email-input',
  'join-submit',
  'success-msg',
  'error-msg',
  'footer',
];

function elementContract(_slots: SlotValues): string[] {
  return [...WAITLIST_TESTIDS];
}

function bindableTestids(slots: SlotValues): { exact: string[]; prefixes: string[] } {
  return { exact: elementContract(slots), prefixes: [] };
}

function briefErrors(brief: JiffyBrief): string[] {
  return briefErrorsForTemplate('waitlist', brief);
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
.waitlist { max-width: 640px; margin: 0 auto; padding: 4rem 1.5rem; text-align: center; }
h1 { font-size: clamp(2rem, 4vw, 3rem); margin: 0 0 1rem; }
.subheadline { font-size: 1.15rem; color: var(--muted); margin: 0 0 2rem; }
.countdown {
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  margin: 0 0 2rem;
}
form { display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; margin: 0 0 1rem; }
label { display: grid; gap: 0.4rem; font-weight: 600; text-align: left; }
input {
  font: inherit;
  padding: 0.6rem 0.75rem;
  border: 1px solid #8a969b;
  border-radius: 0.4rem;
  background: #fff;
  color: var(--text);
  min-width: 16rem;
}
button {
  font: inherit;
  font-weight: 600;
  padding: 0.7rem 1.4rem;
  border-radius: 0.5rem;
  border: none;
  cursor: pointer;
  background: var(--accent);
  color: #fff;
}
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
[data-testid="success-msg"], [data-testid="error-msg"] { margin: 0; font-size: 1rem; }
[data-testid="error-msg"] { color: #9b1c1c; }
.jiffy-footer { text-align: center; padding: 2rem 1.5rem; color: var(--muted); font-size: 0.85rem; }
.jiffy-footer a { color: var(--muted); }
`;
}

const APP_JS_TEMPLATE = `'use strict';
const RELAY_URL = /*__RELAY_URL__*/;
const LAUNCH_ISO = /*__LAUNCH_ISO__*/;
const TEST_MODE = new URLSearchParams(location.search).has('jiffytest');
const EMAIL_RE = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;

const countdownEl = document.querySelector('[data-testid="countdown"]');
const targetMs = new Date(LAUNCH_ISO).getTime();

function tick() {
  const diff = Math.max(0, targetMs - Date.now());
  const totalSeconds = Math.floor(diff / 1000);
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  countdownEl.textContent = d + 'd ' + h + 'h ' + m + 'm ' + s + 's';
}
tick();
setInterval(tick, 1000);

const form = document.getElementById('jiffy-waitlist');
const emailInput = document.querySelector('[data-testid="email-input"]');
const successEl = document.querySelector('[data-testid="success-msg"]');
const errorEl = document.querySelector('[data-testid="error-msg"]');

form.addEventListener('submit', (e) => {
  e.preventDefault();
  successEl.hidden = true;
  errorEl.hidden = true;

  const email = emailInput.value;
  if (!EMAIL_RE.test(email)) {
    errorEl.hidden = false;
    return;
  }

  fetch(RELAY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields: { email: email }, kind: 'waitlist', test: TEST_MODE }),
  })
    .then((res) => {
      if (res.ok) {
        successEl.hidden = false;
        errorEl.hidden = true;
      } else {
        errorEl.hidden = false;
      }
    })
    .catch(() => {
      errorEl.hidden = false;
    });
});
`;

function buildAppJs(relayUrl: string, launchIso: string): string {
  // Function replacers, not plain strings — see form.ts header for why.
  return APP_JS_TEMPLATE.replace('/*__RELAY_URL__*/', () => JSON.stringify(relayUrl)).replace(
    '/*__LAUNCH_ISO__*/',
    () => JSON.stringify(launchIso),
  );
}

function render(slots: SlotValues, ctx: RenderContext): FileSet {
  const errors = validateSlots(WAITLIST, slots);
  if (errors.length > 0) throw new SlotError(errors);
  if (ctx.relay == null) throw new SlotError(['relay context required']);

  const headline = slots.headline as string;
  const subheadline = slots.subheadline as string;
  const launchIso = slots.launchIso as string;
  const emailLabel = slots.emailLabel as string;
  const successCopy = slots.successCopy as string;
  const errorCopy = slots.errorCopy as string;
  const ogTitle = slots.ogTitle as string;
  const ogDescription = slots.ogDescription as string;
  const accentHex = slots.accentHex as string;

  const body = `<main class="waitlist">
  <h1 data-testid="headline">${esc(headline)}</h1>
  <p class="subheadline">${esc(subheadline)}</p>
  <p class="countdown" data-testid="countdown" data-target="${esc(launchIso)}"></p>
  <form id="jiffy-waitlist" novalidate>
    <label>${esc(emailLabel)}
      <input data-testid="email-input" name="email" type="email">
    </label>
    <button type="submit" data-testid="join-submit">Join waitlist</button>
  </form>
  <p data-testid="success-msg" hidden>${esc(successCopy)}</p>
  <p data-testid="error-msg" hidden>${esc(errorCopy)}</p>
</main>`;

  const metas = `<meta property="og:title" content="${esc(ogTitle)}"><meta property="og:description" content="${esc(ogDescription)}">`;

  const html = pageShell({ title: ogTitle, metas, body, ctx });
  const css = buildStyles(accentHex);
  const relayUrl = `${ctx.publicBaseUrl}/relay/${ctx.relay.toolId}?t=${ctx.relay.token}`;
  const appJs = buildAppJs(relayUrl, launchIso);

  return {
    '/index.html': { content: html, contentType: 'text/html; charset=utf-8' },
    '/styles.css': { content: css, contentType: 'text/css; charset=utf-8' },
    '/app.js': { content: appJs, contentType: 'text/javascript; charset=utf-8' },
  };
}

const referenceBrief: JiffyBrief = {
  template: 'waitlist',
  name: 'Waitlist for Aurora',
  description:
    'Product pre-launch waitlist page for Aurora: countdown to launch, email capture, notify ' +
    'the owner of every signup.',
  copy: { headline: 'Aurora launches soon' },
  brand: { accentHex: '#3730a3' },
  notifyEmail: 'owner@example.com',
};

const referenceSlots: SlotValues = {
  headline: 'Aurora launches soon',
  subheadline: 'Be first to try the new way to plan your week.',
  launchIso: '2026-09-01T09:00:00Z',
  emailLabel: 'Email address',
  successCopy: "You're on the list — we'll email you at launch.",
  errorCopy: 'Please enter a valid email address.',
  ogTitle: 'Aurora — launching soon',
  ogDescription: 'Join the waitlist for early access to Aurora.',
  accentHex: '#3730a3',
};

const referenceGoldens: GoldenSet = {
  goldens: [
    {
      title: 'Page loads with headline, countdown target, and OG tags',
      steps: [],
      expect: [
        { testid: 'headline', equals: 'Aurora launches soon' },
        {
          testid: 'countdown',
          attrEquals: { attr: 'data-target', value: '2026-09-01T09:00:00Z' },
        },
        { metaEquals: { property: 'og:title', value: 'Aurora — launching soon' } },
      ],
    },
    {
      title: 'Valid email joins the waitlist',
      steps: [
        { do: 'fill', fields: { 'email-input': 'buyer@example.com' } },
        { do: 'click', testid: 'join-submit' },
      ],
      expect: [{ testid: 'success-msg', visible: true }],
    },
    {
      title: 'Invalid email is rejected client-side',
      steps: [
        { do: 'fill', fields: { 'email-input': 'not-an-email' } },
        { do: 'click', testid: 'join-submit' },
      ],
      expect: [{ testid: 'error-msg', visible: true }],
    },
  ],
};

export const WAITLIST: TemplateDefinition = {
  id: 'waitlist',
  version: '1.0.0',
  priceUsd: 10,
  matcherKeywords: MATCHER_KEYWORDS.waitlist,
  elementContract,
  bindableTestids,
  slots: SLOTS,
  briefErrors,
  render,
  goldenGuidance:
    "load-only golden: `equals` on headline, `attrEquals` on countdown's data-target (never " +
    'assert the ticking text). Fill `email-input`, click `join-submit` ⇒ `visible(success-msg)` ' +
    'for a valid email, `visible(error-msg)` for an invalid one. `metaEquals` on og:title/' +
    'og:description.',
  referenceBrief,
  referenceSlots,
  referenceGoldens,
};
