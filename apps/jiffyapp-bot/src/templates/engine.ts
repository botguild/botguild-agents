// Template engine: shared contracts + rendering primitives every template (Tasks 5-8),
// codegen, and the build pipeline depend on. Deterministic and Workers-globals-free where
// possible (buildToolWorkerScript emits code that *runs* under Workers globals, but this
// module itself is plain, node-testable TypeScript).

import type { FileSet, GoldenSet, JiffyBrief, SlotValues, TemplateId } from '../types.js';

export interface SlotSpec {
  name: string;
  kind: 'copy' | 'json' | 'function' | 'style';
  required: boolean;
  description: string; // codegen prompt fragment: what to write and its exact shape
  example: unknown; // shown to the model; also documents the shape
  validate?: (value: unknown) => string[];
}

export interface RenderContext {
  slug: string;
  toolUrl: string; // https://<slug>.<suffix>
  publicBaseUrl: string; // bot Worker origin
  relay?: { toolId: string; token: string } | null; // relay templates only
}

export interface TemplateDefinition {
  id: TemplateId;
  version: string; // semver; pinned per delivered tool
  priceUsd: number;
  matcherKeywords: string[]; // re-exported into brief.ts matcher table (single source: registry wires them)
  /** LOAD-TIME census: testids that must be present in the served DOM on a fresh page load
   *  (the FR-8 element-contract gate). Interaction-created nodes (calculator breakdown-*,
   *  csv rows) must NOT be listed here. */
  elementContract(slots: SlotValues): string[];
  /** GOLDEN-BINDING surface: what goldens may assert. Defaults to the census; templates with
   *  interaction-created testids widen it (exact ids and/or prefixes). validateGoldenSet and
   *  the goldens compiler use THIS; censusMissing uses elementContract. */
  bindableTestids(slots: SlotValues): { exact: string[]; prefixes: string[] };
  slots: SlotSpec[];
  briefErrors(brief: JiffyBrief): string[]; // template-specific completeness (beyond brief.ts basics)
  render(slots: SlotValues, ctx: RenderContext): FileSet; // deterministic; throws SlotError on bad slots
  goldenGuidance: string; // compiler prompt fragment: golden affordances for this template
  referenceBrief: JiffyBrief; // CI fixtures
  referenceSlots: SlotValues;
  referenceGoldens: GoldenSet;
}

export class SlotError extends Error {
  constructor(public errors: string[]) {
    super(errors.join('; '));
  }
}

const FUNCTION_DENY_TOKENS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'import',
  'require',
  'document.cookie',
  'localStorage',
  'sessionStorage',
  'eval',
  'new Function',
  'window.open',
  'location',
];

/** Escape a literal string for embedding in a RegExp source. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Per-token regex matching the token only as a standalone identifier/expression —
 * not as a substring of a longer identifier (e.g. "fetch" must not match "prefetch"
 * or "fetching"). Regex-special chars in the token are escaped so `document.cookie`
 * matches the literal dot; internal whitespace (as in `new Function`) matches `\s+`
 * so incidental formatting differences don't evade the check.
 */
const FUNCTION_DENY_TOKEN_PATTERNS: ReadonlyArray<{ token: string; re: RegExp }> =
  FUNCTION_DENY_TOKENS.map((token) => {
    const escaped = escapeRegExp(token).replace(/\s+/g, '\\s+');
    return { token, re: new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`) };
  });

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function isJsonValue(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/**
 * Validate slot values against a template's `SlotSpec[]`. Required+absent (undefined/null)
 * errors; present values are checked by kind (copy/json/style/function); each spec's own
 * `validate` is appended. All errors are collected (never stops at the first). Slot names
 * present in `slots` but not declared on the template are also flagged — codegen may not
 * invent slots.
 */
export function validateSlots(def: TemplateDefinition, slots: SlotValues): string[] {
  const errors: string[] = [];
  const known = new Set(def.slots.map((spec) => spec.name));

  for (const spec of def.slots) {
    const value = slots[spec.name];
    const absent = value === undefined || value === null;

    if (absent) {
      if (spec.required) errors.push(`${spec.name}: required`);
      continue;
    }

    switch (spec.kind) {
      case 'copy':
        if (typeof value !== 'string') errors.push(`${spec.name}: must be a string`);
        break;
      case 'json':
        if (!isJsonValue(value)) errors.push(`${spec.name}: must be a JSON object or array`);
        break;
      case 'style':
        if (typeof value !== 'string') {
          errors.push(`${spec.name}: must be a string`);
        } else if (spec.name.endsWith('Hex') && !HEX_COLOR_RE.test(value)) {
          errors.push(`${spec.name}: must be a 6-digit hex color (e.g. #a1b2c3)`);
        }
        break;
      case 'function':
        if (typeof value !== 'string') {
          errors.push(`${spec.name}: must be a string`);
        } else {
          const trimmed = value.trim();
          if (!(trimmed.startsWith('function') || trimmed.startsWith('('))) {
            errors.push(
              `${spec.name}: must be a function expression (starting with "function" or "(")`,
            );
          }
          for (const { token, re } of FUNCTION_DENY_TOKEN_PATTERNS) {
            if (re.test(value)) {
              errors.push(`${spec.name}: must not contain "${token}"`);
            }
          }
        }
        break;
    }

    if (spec.validate) {
      errors.push(...spec.validate(value));
    }
  }

  for (const name of Object.keys(slots)) {
    if (!known.has(name)) {
      errors.push(`${name}: unknown slot`);
    }
  }

  return errors;
}

/** Escape for embedding user copy into HTML text nodes/attributes. */
export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Footer appended by pageShell — data-testid="footer", attribution + report-abuse link. */
export function footerHtml(ctx: RenderContext): string {
  return `<footer data-testid="footer" class="jiffy-footer">Built by <a href="https://jiffyapp.dev" rel="noopener">JiffyApp</a> · <a href="${ctx.publicBaseUrl}/abuse?slug=${ctx.slug}" rel="noopener">Report abuse</a></footer>`;
}

/** Standard page chrome: doctype, meta, <style> from styles.css link, footer. Every template uses it. */
export function pageShell(opts: {
  title: string;
  metas?: string;
  body: string;
  ctx: RenderContext;
}): string {
  const { title, metas, body, ctx } = opts;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${metas ?? ''}<link rel="stylesheet" href="/styles.css"></head><body>${body}${footerHtml(ctx)}</body></html>`;
}

/** Content-Security-Policy for a tool page. relayOrigin added only for relay templates. */
export function cspFor(ctx: RenderContext, opts?: { frameable?: boolean }): string {
  const relayOrigin = ctx.relay ? new URL(ctx.publicBaseUrl).origin : undefined;
  const connectSrc = relayOrigin ? `'self' ${relayOrigin}` : "'self'";
  const formAction = relayOrigin ? `'self' ${relayOrigin}` : "'self'";
  const frameAncestors = opts?.frameable ? '*' : "'none'";
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src ${connectSrc}`,
    `form-action ${formAction}`,
    "base-uri 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ');
}

/** Wrap a FileSet into a single-module user Worker script for the dispatch namespace. */
export function buildToolWorkerScript(files: FileSet, csp: string): string {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  return `// Generated by JiffyApp — do not edit in place; see the eject ZIP README.
const FILES = ${JSON.stringify(sorted)};
const CSP = ${JSON.stringify(csp)};
function bytes(entry) {
  if (entry.encoding === 'base64') {
    const bin = atob(entry.content);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return entry.content;
}
export default {
  async fetch(request) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path === '/' || path === '') path = '/index.html';
    const entry = FILES[path];
    if (!entry) return new Response('not found', { status: 404 });
    const headers = {
      'content-type': entry.contentType,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    };
    if (entry.contentType.startsWith('text/html')) headers['content-security-policy'] = CSP;
    return new Response(bytes(entry), { headers });
  },
};
`;
}
