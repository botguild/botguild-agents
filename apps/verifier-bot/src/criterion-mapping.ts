import type { Criterion } from './parser.js';
import type { HttpCheckConfig } from './runners/http.js';
import type { DomCheck, DomCheckType } from './runners/dom.js';
import type { DataQualityCriterion } from './runners/data.js';

// Pull HTTP expectations out of a criterion's free-text `expected` string so
// the runner actually checks what was requested instead of defaulting to "200".
export function buildHttpConfigFromCriterion(
  criterion: Criterion,
  baseConfig: { logger: HttpCheckConfig['logger'] },
): HttpCheckConfig {
  const expected = criterion.expected ?? '';
  const out: HttpCheckConfig = { ...baseConfig };

  const statusMatch = expected.match(/status\s*(?:code\s*)?(\d{3})/i)
    ?? expected.match(/\bHTTP\s*(\d{3})\b/i)
    ?? expected.match(/\b(\d{3})\b/);
  if (statusMatch) out.expectedStatusCode = Number(statusMatch[1]);

  const latencyMs = parseLatencyMs(expected);
  if (latencyMs !== null) out.maxLatencyMs = latencyMs;

  const headerMatches = [...expected.matchAll(/header[s]?[:\s]+([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*)/gi)];
  if (headerMatches.length > 0) {
    out.requiredHeaders = headerMatches
      .flatMap((m) => m[1].split(/\s*,\s*/))
      .map((h) => h.trim())
      .filter((h) => h.length > 0);
  }

  return out;
}

function parseLatencyMs(text: string): number | null {
  // "≤ 3000ms", "<= 3 seconds", "under 3s", "within 500 ms"
  const ms = text.match(/(?:≤|<=|<|under|within|less than)\s*(\d+(?:\.\d+)?)\s*(ms|millisecond)/i);
  if (ms) return Math.round(Number(ms[1]));
  const sec = text.match(/(?:≤|<=|<|under|within|less than)\s*(\d+(?:\.\d+)?)\s*(s\b|sec|second)/i);
  if (sec) return Math.round(Number(sec[1]) * 1000);
  return null;
}

const CSS_SELECTOR_RE = /([#.][A-Za-z][\w-]*|\[[^\]]+\]|[A-Za-z][\w-]*\s*[#.\[][^\s'"]+)/;

export function buildDomCheckFromCriterion(criterion: Criterion): DomCheck {
  const expected = criterion.expected ?? '';

  const selectorMatch = expected.match(CSS_SELECTOR_RE);
  const selector = selectorMatch ? selectorMatch[0] : 'body';

  let checkType: DomCheckType = 'element-present';
  if (/visible|displayed|shown/i.test(expected)) checkType = 'element-visible';
  // text-match if the expectation quotes literal text to find on the page
  const quoted = expected.match(/["']([^"']{2,})["']/);
  if (quoted) {
    return {
      criterionId: criterion.id,
      description: criterion.description,
      checkType: 'text-match',
      selector,
      expectedText: quoted[1],
    };
  }

  return {
    criterionId: criterion.id,
    description: criterion.description,
    checkType,
    selector,
  };
}

export function buildDataQualityCriterion(criterion: Criterion): DataQualityCriterion {
  const expected = (criterion.expected ?? '').toLowerCase();
  const desc = (criterion.description ?? '').toLowerCase();
  const text = `${desc} ${expected}`;

  const fieldMatch =
    expected.match(/field\s+["']?([A-Za-z_][\w-]*)["']?/i)
    ?? expected.match(/column\s+["']?([A-Za-z_][\w-]*)["']?/i)
    ?? criterion.description.match(/["']([A-Za-z_][\w-]*)["']/);
  const field = fieldMatch ? fieldMatch[1] : criterion.id;

  const base = {
    criterionId: criterion.id,
    description: criterion.description,
    field,
  };

  if (/uniq/.test(text)) {
    const pct = expected.match(/(\d+(?:\.\d+)?)\s*%/);
    return {
      ...base,
      check: 'uniqueness',
      threshold: pct ? Number(pct[1]) / 100 : 1,
    };
  }
  if (/type|integer|number|string|boolean|date/.test(text) && /correct|is\s+a\s+|must\s+be/.test(text)) {
    const typeMatch = expected.match(/\b(string|number|integer|float|boolean|date)\b/i);
    return {
      ...base,
      check: 'type-correctness',
      expectedType: typeMatch ? typeMatch[1].toLowerCase() : 'string',
    };
  }
  if (/range|between|min|max/.test(text)) {
    const min = expected.match(/(?:>=|≥|min(?:imum)?|at\s+least)\s*(-?\d+(?:\.\d+)?)/);
    const max = expected.match(/(?:<=|≤|max(?:imum)?|at\s+most)\s*(-?\d+(?:\.\d+)?)/);
    const between = expected.match(/between\s+(-?\d+(?:\.\d+)?)\s+and\s+(-?\d+(?:\.\d+)?)/);
    const minValue = between ? Number(between[1]) : min ? Number(min[1]) : undefined;
    const maxValue = between ? Number(between[2]) : max ? Number(max[1]) : undefined;
    return {
      ...base,
      check: 'value-range',
      minValue,
      maxValue,
    };
  }
  if (/pattern|regex|format|match/.test(text)) {
    const pat = expected.match(/\/(.+)\/[a-z]*$/);
    return {
      ...base,
      check: 'pattern-match',
      pattern: pat ? pat[1] : '.*',
    };
  }
  // Default to null-rate, but parse a threshold if provided.
  const pct = expected.match(/(\d+(?:\.\d+)?)\s*%/);
  return {
    ...base,
    check: 'null-rate',
    threshold: pct ? Number(pct[1]) / 100 : 0,
  };
}
