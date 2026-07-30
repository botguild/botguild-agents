// Golden-example schema validation + proposal-block formatting (templates PRD §1.4/§8/§12).
//
// `validateGoldenSet` is the single gate between "whatever the compiler/model produced" and
// a `GoldenSet` that `assertPlan.ts` is allowed to execute: it normalizes the PRD §8 single-
// action shorthand into canonical `{ steps, expect }` form, then enforces the full §1.4
// vocabulary (no unknown `do`/expectation keys, no stray properties, every testid bound to
// the template's `bindableTestids` surface, fixture references resolvable). `formatGoldenBlock`
// renders the validated set into the proposal markdown buyers see before accepting (§12).

import type {
  GoldenExample,
  GoldenExpectation,
  GoldenSet,
  GoldenStep,
  TemplateId,
} from './types.js';

/** Mirrors `TemplateDefinition.bindableTestids(slots)` (engine.ts) — kept as its own type
 *  here so this module has no dependency on the template engine. */
export interface BindableSurface {
  exact: string[];
  prefixes: string[];
}

export type ValidateGoldenSetResult =
  | { ok: true; set: GoldenSet }
  | { ok: false; errors: string[] };

const STEP_DO_VALUES = new Set(['load', 'fill', 'select', 'click', 'paste', 'upload']);

const EXPECTATION_VALUE_KEYS = [
  'equals',
  'contains',
  'count',
  'visible',
  'hidden',
  'hrefEquals',
  'hrefStartsWith',
  'attrEquals',
  'titleEquals',
  'metaEquals',
] as const;
type ExpectationValueKey = (typeof EXPECTATION_VALUE_KEYS)[number];

/** `titleEquals`/`metaEquals` are page-level: no `testid`/`nth`. */
const PAGE_LEVEL_KEYS = new Set<ExpectationValueKey>(['titleEquals', 'metaEquals']);
/** `count` has no `nth` in the GoldenExpectation union (a count is page-wide, not per-node). */
const NO_NTH_KEYS = new Set<ExpectationValueKey>(['count', 'titleEquals', 'metaEquals']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(obj).every((key) => allowedSet.has(key));
}

function isBindable(testid: string, bindable: BindableSurface): boolean {
  return (
    bindable.exact.includes(testid) || bindable.prefixes.some((prefix) => testid.startsWith(prefix))
  );
}

// ---- shorthand normalization (PRD §8) ----

interface NormalizedItem {
  titleRaw: unknown;
  stepsRaw: unknown;
  expectRaw: unknown;
}

/** Accepts either canonical `{ title?, steps, expect }` or PRD §8 shorthand
 *  `{ action, inputs?, testid?, text?, fixture?, title?, expect }` and returns a
 *  normalized-but-not-yet-validated `{ titleRaw, stepsRaw, expectRaw }`. Shorthand cannot
 *  express `select` — only the compiler emits canonical form, where `select` is available. */
function normalizeGoldenItem(
  item: unknown,
  index: number,
  errors: string[],
): NormalizedItem | null {
  if (!isPlainObject(item)) {
    errors.push(`goldens[${index}]: must be an object`);
    return null;
  }

  if ('steps' in item) {
    return { titleRaw: item.title, stepsRaw: item.steps, expectRaw: item.expect };
  }

  if ('action' in item) {
    const action = item.action;
    let stepsRaw: unknown[];
    switch (action) {
      case 'load':
        stepsRaw = [];
        break;
      case 'fill':
        stepsRaw = [{ do: 'fill', fields: item.inputs }];
        break;
      case 'click': {
        const step: Record<string, unknown> = { do: 'click', testid: item.testid };
        if (item.nth !== undefined) step.nth = item.nth;
        stepsRaw = [step];
        break;
      }
      case 'paste': {
        const step: Record<string, unknown> = { do: 'paste', testid: item.testid };
        if (item.text !== undefined) step.text = item.text;
        if (item.fixture !== undefined) step.fixture = item.fixture;
        stepsRaw = [step];
        break;
      }
      case 'upload':
        stepsRaw = [{ do: 'upload', testid: item.testid, fixture: item.fixture }];
        break;
      default:
        errors.push(`goldens[${index}]: unknown shorthand action ${JSON.stringify(action)}`);
        return null;
    }
    return { titleRaw: item.title, stepsRaw, expectRaw: item.expect };
  }

  errors.push(`goldens[${index}]: must have "steps" (canonical form) or "action" (shorthand form)`);
  return null;
}

// ---- steps ----

function validateSteps(
  raw: unknown,
  goldenIndex: number,
  bindable: BindableSurface,
  fixtureKeys: Set<string>,
  errors: string[],
): GoldenStep[] | null {
  if (!Array.isArray(raw)) {
    errors.push(`goldens[${goldenIndex}].steps: must be an array`);
    return null;
  }

  let ok = true;
  const steps: GoldenStep[] = [];

  raw.forEach((rawStep, stepIndex) => {
    const label = `goldens[${goldenIndex}].steps[${stepIndex}]`;
    if (!isPlainObject(rawStep)) {
      errors.push(`${label}: must be an object`);
      ok = false;
      return;
    }

    const stepDo = rawStep.do;
    if (typeof stepDo !== 'string' || !STEP_DO_VALUES.has(stepDo)) {
      errors.push(`${label}.do: unknown value ${JSON.stringify(stepDo)}`);
      ok = false;
      return;
    }

    switch (stepDo) {
      case 'load': {
        if (!hasOnlyKeys(rawStep, ['do'])) {
          errors.push(`${label}: "load" accepts no other properties`);
          ok = false;
          return;
        }
        steps.push({ do: 'load' });
        return;
      }
      case 'fill':
      case 'select': {
        if (!hasOnlyKeys(rawStep, ['do', 'fields'])) {
          errors.push(`${label}: "${stepDo}" accepts only "fields"`);
          ok = false;
          return;
        }
        if (!isPlainObject(rawStep.fields)) {
          errors.push(`${label}.fields: must be an object`);
          ok = false;
          return;
        }
        let fieldsOk = true;
        const fields: Record<string, string | boolean> = {};
        for (const [testid, value] of Object.entries(rawStep.fields)) {
          const validType =
            stepDo === 'fill'
              ? typeof value === 'string' || typeof value === 'boolean'
              : typeof value === 'string';
          if (!validType) {
            errors.push(`${label}.fields.${testid}: invalid value type`);
            fieldsOk = false;
            continue;
          }
          if (!isBindable(testid, bindable)) {
            errors.push(`${label}.fields: testid "${testid}" is not bindable`);
            fieldsOk = false;
            continue;
          }
          fields[testid] = value as string | boolean;
        }
        if (!fieldsOk) {
          ok = false;
          return;
        }
        steps.push(
          stepDo === 'fill'
            ? { do: 'fill', fields }
            : { do: 'select', fields: fields as Record<string, string> },
        );
        return;
      }
      case 'click': {
        if (!hasOnlyKeys(rawStep, ['do', 'testid', 'nth'])) {
          errors.push(`${label}: "click" accepts only "testid" and "nth"`);
          ok = false;
          return;
        }
        const testid = rawStep.testid;
        if (typeof testid !== 'string') {
          errors.push(`${label}.testid: required string`);
          ok = false;
          return;
        }
        if (!isBindable(testid, bindable)) {
          errors.push(`${label}: testid "${testid}" is not bindable`);
          ok = false;
          return;
        }
        if ('nth' in rawStep) {
          if (!isNonNegativeInteger(rawStep.nth)) {
            errors.push(`${label}.nth: must be a non-negative integer`);
            ok = false;
            return;
          }
          steps.push({ do: 'click', testid, nth: rawStep.nth });
        } else {
          steps.push({ do: 'click', testid });
        }
        return;
      }
      case 'paste': {
        if (!hasOnlyKeys(rawStep, ['do', 'testid', 'text', 'fixture'])) {
          errors.push(`${label}: "paste" accepts only "testid", "text", and "fixture"`);
          ok = false;
          return;
        }
        const testid = rawStep.testid;
        if (typeof testid !== 'string') {
          errors.push(`${label}.testid: required string`);
          ok = false;
          return;
        }
        if (!isBindable(testid, bindable)) {
          errors.push(`${label}: testid "${testid}" is not bindable`);
          ok = false;
          return;
        }
        const hasText = 'text' in rawStep && rawStep.text !== undefined;
        const hasFixture = 'fixture' in rawStep && rawStep.fixture !== undefined;
        if (hasText === hasFixture) {
          errors.push(`${label}: "paste" requires exactly one of "text" or "fixture"`);
          ok = false;
          return;
        }
        if (hasText) {
          if (typeof rawStep.text !== 'string') {
            errors.push(`${label}.text: must be a string`);
            ok = false;
            return;
          }
          steps.push({ do: 'paste', testid, text: rawStep.text });
        } else {
          if (typeof rawStep.fixture !== 'string') {
            errors.push(`${label}.fixture: must be a string`);
            ok = false;
            return;
          }
          if (!fixtureKeys.has(rawStep.fixture)) {
            errors.push(`${label}.fixture: unknown fixture ${JSON.stringify(rawStep.fixture)}`);
            ok = false;
            return;
          }
          steps.push({ do: 'paste', testid, fixture: rawStep.fixture });
        }
        return;
      }
      case 'upload': {
        if (!hasOnlyKeys(rawStep, ['do', 'testid', 'fixture'])) {
          errors.push(`${label}: "upload" accepts only "testid" and "fixture"`);
          ok = false;
          return;
        }
        const testid = rawStep.testid;
        const fixture = rawStep.fixture;
        if (typeof testid !== 'string' || typeof fixture !== 'string') {
          errors.push(`${label}: "testid" and "fixture" are required strings`);
          ok = false;
          return;
        }
        if (!isBindable(testid, bindable)) {
          errors.push(`${label}: testid "${testid}" is not bindable`);
          ok = false;
          return;
        }
        if (!fixtureKeys.has(fixture)) {
          errors.push(`${label}.fixture: unknown fixture ${JSON.stringify(fixture)}`);
          ok = false;
          return;
        }
        steps.push({ do: 'upload', testid, fixture });
        return;
      }
    }
  });

  return ok ? steps : null;
}

// ---- expectations ----

function validateExpectations(
  raw: unknown,
  goldenIndex: number,
  bindable: BindableSurface,
  errors: string[],
): GoldenExpectation[] | null {
  if (!Array.isArray(raw)) {
    errors.push(`goldens[${goldenIndex}].expect: must be an array`);
    return null;
  }

  let ok = true;
  const expectations: GoldenExpectation[] = [];

  raw.forEach((rawExp, expIndex) => {
    const label = `goldens[${goldenIndex}].expect[${expIndex}]`;
    if (!isPlainObject(rawExp)) {
      errors.push(`${label}: must be an object`);
      ok = false;
      return;
    }

    const valueKeys = EXPECTATION_VALUE_KEYS.filter((key) => key in rawExp);
    if (valueKeys.length !== 1) {
      errors.push(`${label}: must have exactly one of ${EXPECTATION_VALUE_KEYS.join('|')}`);
      ok = false;
      return;
    }
    const kind = valueKeys[0];
    const pageLevel = PAGE_LEVEL_KEYS.has(kind);
    const allowsNth = !NO_NTH_KEYS.has(kind);
    const allowedKeys = pageLevel ? [kind] : allowsNth ? ['testid', 'nth', kind] : ['testid', kind];

    if (!hasOnlyKeys(rawExp, allowedKeys)) {
      errors.push(`${label}: unexpected properties for "${kind}" expectation`);
      ok = false;
      return;
    }

    let testid: string | undefined;
    if (!pageLevel) {
      if (typeof rawExp.testid !== 'string') {
        errors.push(`${label}.testid: required string`);
        ok = false;
        return;
      }
      if (!isBindable(rawExp.testid, bindable)) {
        errors.push(`${label}: testid "${rawExp.testid}" is not bindable`);
        ok = false;
        return;
      }
      testid = rawExp.testid;
    }

    let nth: number | undefined;
    if (allowsNth && 'nth' in rawExp) {
      if (!isNonNegativeInteger(rawExp.nth)) {
        errors.push(`${label}.nth: must be a non-negative integer`);
        ok = false;
        return;
      }
      nth = rawExp.nth;
    }

    const value = rawExp[kind];
    const built = buildExpectation(kind, testid, nth, value, label, errors);
    if (!built) {
      ok = false;
      return;
    }
    expectations.push(built);
  });

  return ok ? expectations : null;
}

function buildExpectation(
  kind: ExpectationValueKey,
  testid: string | undefined,
  nth: number | undefined,
  value: unknown,
  label: string,
  errors: string[],
): GoldenExpectation | null {
  const tid = testid as string; // defined for every kind below except titleEquals/metaEquals

  switch (kind) {
    case 'equals': {
      if (typeof value !== 'string') {
        errors.push(`${label}.equals: must be a string`);
        return null;
      }
      return nth === undefined
        ? { testid: tid, equals: value }
        : { testid: tid, nth, equals: value };
    }
    case 'contains': {
      if (typeof value !== 'string') {
        errors.push(`${label}.contains: must be a string`);
        return null;
      }
      return nth === undefined
        ? { testid: tid, contains: value }
        : { testid: tid, nth, contains: value };
    }
    case 'hrefEquals': {
      if (typeof value !== 'string') {
        errors.push(`${label}.hrefEquals: must be a string`);
        return null;
      }
      return nth === undefined
        ? { testid: tid, hrefEquals: value }
        : { testid: tid, nth, hrefEquals: value };
    }
    case 'hrefStartsWith': {
      if (typeof value !== 'string') {
        errors.push(`${label}.hrefStartsWith: must be a string`);
        return null;
      }
      return nth === undefined
        ? { testid: tid, hrefStartsWith: value }
        : { testid: tid, nth, hrefStartsWith: value };
    }
    case 'titleEquals': {
      if (typeof value !== 'string') {
        errors.push(`${label}.titleEquals: must be a string`);
        return null;
      }
      return { titleEquals: value };
    }
    case 'count': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${label}.count: must be a number`);
        return null;
      }
      return { testid: tid, count: value };
    }
    case 'visible': {
      if (value !== true) {
        errors.push(`${label}.visible: must be true`);
        return null;
      }
      return nth === undefined
        ? { testid: tid, visible: true }
        : { testid: tid, nth, visible: true };
    }
    case 'hidden': {
      if (value !== true) {
        errors.push(`${label}.hidden: must be true`);
        return null;
      }
      return nth === undefined ? { testid: tid, hidden: true } : { testid: tid, nth, hidden: true };
    }
    case 'attrEquals': {
      if (
        !isPlainObject(value) ||
        !hasOnlyKeys(value, ['attr', 'value']) ||
        typeof value.attr !== 'string' ||
        typeof value.value !== 'string'
      ) {
        errors.push(`${label}.attrEquals: must be { attr: string; value: string }`);
        return null;
      }
      const attrEquals = { attr: value.attr, value: value.value };
      return nth === undefined ? { testid: tid, attrEquals } : { testid: tid, nth, attrEquals };
    }
    case 'metaEquals': {
      if (
        !isPlainObject(value) ||
        !hasOnlyKeys(value, ['property', 'value']) ||
        typeof value.property !== 'string' ||
        typeof value.value !== 'string'
      ) {
        errors.push(`${label}.metaEquals: must be { property: string; value: string }`);
        return null;
      }
      return { metaEquals: { property: value.property, value: value.value } };
    }
  }
}

// ---- top-level validation ----

export function validateGoldenSet(
  raw: unknown,
  bindable: BindableSurface,
): ValidateGoldenSetResult {
  const errors: string[] = [];

  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['golden set must be an object'] };
  }

  for (const key of Object.keys(raw)) {
    if (key !== 'goldens' && key !== 'fixtures') {
      errors.push(`unknown top-level key "${key}"`);
    }
  }

  const fixturesRaw = raw.fixtures;
  let fixtures: Record<string, string> | undefined;
  if (fixturesRaw !== undefined) {
    if (!isPlainObject(fixturesRaw)) {
      errors.push('fixtures: must be an object mapping names to string content');
    } else {
      fixtures = {};
      for (const [name, content] of Object.entries(fixturesRaw)) {
        if (typeof content !== 'string') {
          errors.push(`fixtures.${name}: must be a string`);
        } else {
          fixtures[name] = content;
        }
      }
    }
  }
  const fixtureKeys = new Set(Object.keys(fixtures ?? {}));

  const rawGoldens = raw.goldens;
  if (!Array.isArray(rawGoldens)) {
    errors.push('goldens: must be an array');
    return { ok: false, errors };
  }

  if (rawGoldens.length < 3 || rawGoldens.length > 7) {
    errors.push(`goldens: must contain 3-7 entries, got ${rawGoldens.length}`);
  }

  const built: GoldenExample[] = [];

  rawGoldens.forEach((item, index) => {
    const normalized = normalizeGoldenItem(item, index, errors);
    if (!normalized) return;

    const steps = validateSteps(normalized.stepsRaw, index, bindable, fixtureKeys, errors);
    const expect = validateExpectations(normalized.expectRaw, index, bindable, errors);

    let title: string;
    if (normalized.titleRaw === undefined) {
      title = `Example ${index + 1}`;
    } else if (typeof normalized.titleRaw === 'string' && normalized.titleRaw.trim().length > 0) {
      title = normalized.titleRaw;
    } else {
      errors.push(`goldens[${index}].title: must be a non-empty string`);
      return;
    }

    if (steps !== null && expect !== null) {
      built.push({ title, steps, expect });
    }
  });

  const seenTitles = new Set<string>();
  for (const golden of built) {
    if (seenTitles.has(golden.title)) {
      errors.push(`duplicate golden title "${golden.title}"`);
    }
    seenTitles.add(golden.title);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const set: GoldenSet = fixtures !== undefined ? { goldens: built, fixtures } : { goldens: built };
  return { ok: true, set };
}

// ---- proposal formatting (§12) ----

function describeStep(step: GoldenStep): string {
  switch (step.do) {
    case 'load':
      return 'load page';
    case 'fill':
      return `fill ${Object.entries(step.fields)
        .map(([testid, value]) => `${testid}=${String(value)}`)
        .join(', ')}`;
    case 'select':
      return `select ${Object.entries(step.fields)
        .map(([testid, value]) => `${testid}=${value}`)
        .join(', ')}`;
    case 'click':
      return `click ${step.testid}`;
    case 'paste':
      return step.fixture !== undefined
        ? `paste ${step.testid} (fixture: ${step.fixture})`
        : `paste ${step.testid}`;
    case 'upload':
      return `upload ${step.testid} (fixture: ${step.fixture})`;
  }
}

function describeExpectation(expectation: GoldenExpectation): string {
  if ('titleEquals' in expectation) return `page title equals "${expectation.titleEquals}"`;
  if ('metaEquals' in expectation) {
    return `meta[${expectation.metaEquals.property}] equals "${expectation.metaEquals.value}"`;
  }
  if ('equals' in expectation) return `${expectation.testid} equals "${expectation.equals}"`;
  if ('contains' in expectation) return `${expectation.testid} contains "${expectation.contains}"`;
  if ('count' in expectation) return `${expectation.testid} count = ${expectation.count}`;
  if ('visible' in expectation) return `${expectation.testid} is visible`;
  if ('hidden' in expectation) return `${expectation.testid} is hidden`;
  if ('hrefEquals' in expectation)
    return `${expectation.testid} href equals "${expectation.hrefEquals}"`;
  if ('hrefStartsWith' in expectation) {
    return `${expectation.testid} href starts with "${expectation.hrefStartsWith}"`;
  }
  return `${expectation.testid} ${expectation.attrEquals.attr} equals "${expectation.attrEquals.value}"`;
}

/** Renders the proposal markdown block a buyer sees before accepting: which template
 *  matched, the plain-language statement that these are the (only) acceptance criteria,
 *  the warranty-scope disclaimer, the §12 rights attestation, a human-readable summary
 *  table, and the canonical GoldenSet as fenced JSON (the exact payload Task 15 executes). */
export function formatGoldenBlock(args: {
  templateId: TemplateId;
  templateVersion: string;
  set: GoldenSet;
}): string {
  const { templateId, templateVersion, set } = args;

  const rows = set.goldens.map((golden, index) => {
    const steps = golden.steps.map(describeStep).join('; ') || '(page load only)';
    const expected = golden.expect.map(describeExpectation).join('; ');
    return `| ${index + 1} | ${steps} | ${expected} |`;
  });

  const table = ['| # | Steps | Expected |', '| --- | --- | --- |', ...rows].join('\n');

  return [
    `Matched template: \`${templateId}\` v${templateVersion}.`,
    '',
    'These exact assertions run in a real browser against the live tool URL, and they ARE the ' +
      'acceptance criteria for this delivery — the build is accepted if, and only if, every one ' +
      'of them passes.',
    '',
    'Features beyond these assertions are excluded from the warranty scope.',
    '',
    'By accepting, you confirm you hold the rights to all copy, branding, and imagery supplied ' +
      'in the brief.',
    '',
    table,
    '',
    '```json',
    JSON.stringify(set, null, 2),
    '```',
    '',
  ].join('\n');
}
