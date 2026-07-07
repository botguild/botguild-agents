// T3 "form" — JiffyApp templates PRD T3, v1.0.0, $15. Relay-bearing: the buyer's
// visitors submit through `/relay/<toolId>?t=<token>` (Task 19), never directly to
// notifyEmail — the page never sees the buyer's inbox.
//
// `subjectTemplate` is a copy slot that may reference `{name}` placeholders for any
// declared field; it is resolved client-side (in app.js, from the submitted field
// values) into a `subject` string sent in the relay POST body alongside `fields` and
// `test`. The page <title> is the brief `headline`, independent of the subject line.
// Like calculator's app.js, the relay URL and per-field validation spec are injected
// into a static app.js source by string-replacing comment markers via a function
// replacer (never via inline <script>, since `script-src 'self'` forbids that, and
// never via plain-string .replace, since injected JSON can contain `$`-prefixed
// sequences that String.replace would otherwise interpret specially).

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

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const FIELD_TYPES = new Set(['text', 'email', 'textarea']);

type FormFieldType = 'text' | 'email' | 'textarea';

interface FormField {
  name: string;
  label: string;
  type: FormFieldType;
  required: boolean;
  validationMessage: string;
}

function validateFields(value: unknown): string[] {
  if (!Array.isArray(value)) return ['fields: must be an array'];
  const errors: string[] = [];
  if (value.length < 1 || value.length > 8) {
    errors.push('fields: must have 1-8 entries');
  }
  const seen = new Set<string>();
  value.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) {
      errors.push(`fields[${i}]: must be an object`);
      return;
    }
    const { name, label, type, required, validationMessage } = item as Record<string, unknown>;
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      errors.push(`fields[${i}].name: must match ${NAME_RE.source}`);
    } else if (seen.has(name)) {
      errors.push(`fields[${i}].name: duplicate name "${name}"`);
    } else {
      seen.add(name);
    }
    if (typeof label !== 'string' || label.trim().length === 0) {
      errors.push(`fields[${i}].label: required non-empty string`);
    }
    if (typeof type !== 'string' || !FIELD_TYPES.has(type)) {
      errors.push(`fields[${i}].type: must be one of text|email|textarea`);
    }
    if (typeof required !== 'boolean') {
      errors.push(`fields[${i}].required: must be a boolean`);
    }
    if (typeof validationMessage !== 'string' || validationMessage.trim().length === 0) {
      errors.push(`fields[${i}].validationMessage: required non-empty string`);
    }
  });
  return errors;
}

const SLOTS: SlotSpec[] = [
  {
    name: 'headline',
    kind: 'copy',
    required: true,
    description: 'Page headline, also used as the <title>. One short sentence or fragment.',
    example: 'Get in touch',
  },
  {
    name: 'fields',
    kind: 'json',
    required: true,
    description:
      'Array of 1-8 field specs, each `{ name: string; label: string; type: "text" | "email" | ' +
      '"textarea"; required: boolean; validationMessage: string }`. name must match ' +
      '/^[a-z][a-z0-9-]*$/ and be unique. validationMessage is shown when a required field is ' +
      'submitted empty.',
    example: [
      {
        name: 'email',
        label: 'Email',
        type: 'email',
        required: true,
        validationMessage: 'Please enter your email.',
      },
    ],
    validate: validateFields,
  },
  {
    name: 'successCopy',
    kind: 'copy',
    required: true,
    description: 'Message shown after a successful submission.',
    example: "Thanks — we'll be in touch soon.",
  },
  {
    name: 'errorCopy',
    kind: 'copy',
    required: true,
    description: 'Message shown when submission fails (client validation or relay error).',
    example: 'Something went wrong. Please try again.',
  },
  {
    name: 'subjectTemplate',
    kind: 'copy',
    required: true,
    description:
      'Subject line for the notification email, sent to the relay. May reference declared ' +
      'field names as `{name}` placeholders, resolved from the submitted values.',
    example: 'New inquiry from {name}',
  },
  {
    name: 'accentHex',
    kind: 'style',
    required: true,
    description: 'Brand accent color as a 6-digit hex code, e.g. #0F3D3E.',
    example: '#0F3D3E',
  },
];

function fieldsFromSlots(slots: SlotValues): FormField[] {
  const value = slots.fields;
  return Array.isArray(value) ? (value as FormField[]) : [];
}

function elementContract(slots: SlotValues): string[] {
  const fieldIds = fieldsFromSlots(slots)
    .filter((f) => f && typeof f.name === 'string')
    .map((f) => `field-${f.name}`);
  return [...fieldIds, 'submit', 'success-msg', 'error-msg', 'footer'];
}

function bindableTestids(slots: SlotValues): { exact: string[]; prefixes: string[] } {
  return { exact: elementContract(slots), prefixes: [] };
}

function briefErrors(brief: JiffyBrief): string[] {
  return briefErrorsForTemplate('form', brief);
}

function renderField(field: FormField): string {
  const testid = `field-${field.name}`;
  const requiredAttr = field.required ? ' required' : '';
  const control =
    field.type === 'textarea'
      ? `<textarea data-testid="${testid}" name="${esc(field.name)}"${requiredAttr}></textarea>`
      : `<input data-testid="${testid}" name="${esc(field.name)}" type="${field.type}"${requiredAttr}>`;
  return `
      <label>${esc(field.label)}
        ${control}
      </label>`;
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
.form-page { max-width: 640px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
h1 { font-size: clamp(1.5rem, 3vw, 2.25rem); margin: 0 0 1.5rem; }
form { display: grid; gap: 1.25rem; background: var(--surface); border-radius: 0.75rem; padding: 1.5rem; }
label { display: grid; gap: 0.4rem; font-weight: 600; }
input, textarea {
  font: inherit;
  padding: 0.6rem 0.75rem;
  border: 1px solid #8a969b;
  border-radius: 0.4rem;
  background: #fff;
  color: var(--text);
}
textarea { min-height: 6rem; resize: vertical; }
button { font: inherit; font-weight: 600; padding: 0.7rem 1.4rem; border-radius: 0.5rem; border: none; cursor: pointer; }
button[type="submit"] { background: var(--accent); color: #fff; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
[data-testid="success-msg"], [data-testid="error-msg"] { margin-top: 1.25rem; font-size: 1rem; }
[data-testid="error-msg"] { color: #9b1c1c; }
.jiffy-footer { text-align: center; padding: 2rem 1.5rem; color: var(--muted); font-size: 0.85rem; }
.jiffy-footer a { color: var(--muted); }
`;
}

const APP_JS_TEMPLATE = `'use strict';
const RELAY_URL = /*__RELAY_URL__*/;
const FIELDS = /*__FIELDS__*/;
const SUBJECT_TEMPLATE = /*__SUBJECT_TEMPLATE__*/;
const TEST_MODE = new URLSearchParams(location.search).has('jiffytest');

function resolveSubject(template, values) {
  return template.replace(/\\{([a-z][a-z0-9-]*)\\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  );
}

const form = document.getElementById('jiffy-form');
const successEl = document.querySelector('[data-testid="success-msg"]');
const errorEl = document.querySelector('[data-testid="error-msg"]');

form.addEventListener('submit', (e) => {
  e.preventDefault();
  successEl.hidden = true;
  errorEl.hidden = true;

  const values = {};
  for (const spec of FIELDS) {
    const el = document.querySelector('[data-testid="field-' + spec.name + '"]');
    values[spec.name] = el.value;
  }
  for (const spec of FIELDS) {
    if (spec.required && values[spec.name].trim() === '') {
      errorEl.textContent = spec.validationMessage;
      errorEl.hidden = false;
      return;
    }
  }

  const subject = resolveSubject(SUBJECT_TEMPLATE, values);

  fetch(RELAY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields: values, subject: subject, test: TEST_MODE }),
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

function buildAppJs(relayUrl: string, fields: FormField[], subjectTemplate: string): string {
  const fieldsSpec = fields.map((f) => ({
    name: f.name,
    required: f.required,
    validationMessage: f.validationMessage,
  }));
  // Function replacers (not plain strings) so `$`-prefixed sequences inside injected
  // JSON (subjectTemplate copy, validation messages) are inserted verbatim instead of
  // being interpreted as String.replace's special `$&`/`$'`/`` $` ``/`$n` patterns.
  return APP_JS_TEMPLATE.replace('/*__RELAY_URL__*/', () => JSON.stringify(relayUrl))
    .replace('/*__FIELDS__*/', () => JSON.stringify(fieldsSpec))
    .replace('/*__SUBJECT_TEMPLATE__*/', () => JSON.stringify(subjectTemplate));
}

function render(slots: SlotValues, ctx: RenderContext): FileSet {
  const errors = validateSlots(FORM, slots);
  if (errors.length > 0) throw new SlotError(errors);
  if (ctx.relay == null) throw new SlotError(['relay context required']);

  const headline = slots.headline as string;
  const fields = slots.fields as FormField[];
  const successCopy = slots.successCopy as string;
  const errorCopy = slots.errorCopy as string;
  const subjectTemplate = slots.subjectTemplate as string;
  const accentHex = slots.accentHex as string;

  const fieldsHtml = fields.map(renderField).join('');

  const body = `<main class="form-page">
  <h1>${esc(headline)}</h1>
  <form id="jiffy-form" novalidate>${fieldsHtml}
    <button type="submit" data-testid="submit">Submit</button>
  </form>
  <p data-testid="success-msg" hidden>${esc(successCopy)}</p>
  <p data-testid="error-msg" hidden>${esc(errorCopy)}</p>
</main>`;

  const html = pageShell({ title: headline, body, ctx });
  const css = buildStyles(accentHex);
  const relayUrl = `${ctx.publicBaseUrl}/relay/${ctx.relay.toolId}?t=${ctx.relay.token}`;
  const appJs = buildAppJs(relayUrl, fields, subjectTemplate);

  return {
    '/index.html': { content: html, contentType: 'text/html; charset=utf-8' },
    '/styles.css': { content: css, contentType: 'text/css; charset=utf-8' },
    '/app.js': { content: appJs, contentType: 'text/javascript; charset=utf-8' },
  };
}

const referenceBrief: JiffyBrief = {
  template: 'form',
  name: 'Contact form for Northlight Studio',
  description:
    'Studio contact form for inbound client inquiries: name, email, and project message ' +
    'fields, emailed straight to the studio owner.',
  copy: { headline: 'Get in touch' },
  brand: { accentHex: '#1f2933' },
  notifyEmail: 'owner@example.com',
};

const referenceSlots: SlotValues = {
  headline: 'Get in touch',
  fields: [
    {
      name: 'name',
      label: 'Name',
      type: 'text',
      required: true,
      validationMessage: 'Please enter your name.',
    },
    {
      name: 'email',
      label: 'Email',
      type: 'email',
      required: true,
      validationMessage: 'Please enter a valid email address.',
    },
    {
      name: 'message',
      label: 'Message',
      type: 'textarea',
      required: true,
      validationMessage: 'Please tell us a bit about your project.',
    },
  ],
  successCopy: "Thanks — we'll get back to you soon.",
  errorCopy: 'Something went wrong. Please try again.',
  subjectTemplate: 'New inquiry from {name}',
  accentHex: '#1f2933',
};

const referenceGoldens: GoldenSet = {
  goldens: [
    {
      title: 'Filled submission succeeds',
      steps: [
        {
          do: 'fill',
          fields: {
            'field-name': 'Ada Lovelace',
            'field-email': 'ada@example.com',
            'field-message': 'Would love a quote for a new brand site.',
          },
        },
        { do: 'click', testid: 'submit' },
      ],
      expect: [{ testid: 'success-msg', visible: true }],
    },
    {
      title: 'Empty submission is rejected client-side',
      steps: [{ do: 'click', testid: 'submit' }],
      expect: [{ testid: 'error-msg', visible: true }],
    },
    {
      title: 'Page loads with headline title and success hidden',
      steps: [],
      expect: [{ titleEquals: 'Get in touch' }, { testid: 'success-msg', hidden: true }],
    },
  ],
};

export const FORM: TemplateDefinition = {
  id: 'form',
  version: '1.0.0',
  priceUsd: 15,
  matcherKeywords: MATCHER_KEYWORDS.form,
  elementContract,
  bindableTestids,
  slots: SLOTS,
  briefErrors,
  render,
  goldenGuidance:
    'fill required fields via `field-<name>`, click `submit` ⇒ `visible(success-msg)` (relay ' +
    'endpoint accepts in staging via test mode); empty-required golden ⇒ `visible(error-msg)`. ' +
    'The live relay-delivery proof (message-id) is a pipeline hard gate, not a Playwright ' +
    'assertion. One load-only golden asserting `titleEquals` and `hidden(success-msg)` is ' +
    'allowed.',
  referenceBrief,
  referenceSlots,
  referenceGoldens,
};
