// Assertion-plan executor (Task 9 brief, Step 1): PageDriver interface + runGoldens +
// censusMissing, exercised against a scripted fake driver (Task 15 supplies the real
// Playwright driver — this module has zero Workers/browser imports).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GoldenSet } from './types.js';
import { censusMissing, runGoldens, type PageDriver, type ScreenshotStore } from './assertPlan.js';

interface ElementState {
  text?: string;
  attrs?: Record<string, string>;
  visible?: boolean;
}

interface PageState {
  elements: Record<string, ElementState[]>;
  title: string;
  metas: Record<string, string>;
  log: string[];
  closeCount: number;
  hang?: Set<string>;
  onAction?: (action: { type: string; testid?: string; value?: unknown }) => void;
}

function newState(overrides: Partial<PageState> = {}): PageState {
  return { elements: {}, title: '', metas: {}, log: [], closeCount: 0, ...overrides };
}

/** Scripted fake PageDriver over a plain shared-state object. Each `openPage()` call may
 *  hand back a fresh wrapper (mimicking "fresh page"), but they all read/write the same
 *  `state` — good enough to assert call logs and per-golden isolation. */
function fakeDriver(state: PageState): PageDriver {
  const el = (testid: string, nth?: number): ElementState | undefined =>
    (state.elements[testid] ?? [])[nth ?? 0];

  return {
    async goto(url) {
      state.log.push(`goto ${url}`);
    },
    async fill(testid, value, nth) {
      state.log.push(`fill ${testid}=${value}`);
      state.onAction?.({ type: 'fill', testid, value });
      void nth;
    },
    async setChecked(testid, checked, nth) {
      state.log.push(`setChecked ${testid}=${checked}`);
      state.onAction?.({ type: 'setChecked', testid, value: checked });
      void nth;
    },
    async selectOption(testid, value, nth) {
      state.log.push(`selectOption ${testid}=${value}`);
      state.onAction?.({ type: 'selectOption', testid, value });
      void nth;
    },
    async click(testid, nth) {
      state.log.push(`click ${testid}`);
      state.onAction?.({ type: 'click', testid });
      void nth;
    },
    async uploadFile(testid, name, content) {
      state.log.push(`upload ${testid} ${name} ${content}`);
      state.onAction?.({ type: 'upload', testid, value: content });
    },
    async textContent(testid, nth) {
      if (state.hang?.has('textContent')) return new Promise<string | null>(() => {});
      return el(testid, nth)?.text ?? null;
    },
    async getAttribute(testid, attr, nth) {
      return el(testid, nth)?.attrs?.[attr] ?? null;
    },
    async count(testid) {
      return (state.elements[testid] ?? []).length;
    },
    async isVisible(testid, nth) {
      return el(testid, nth)?.visible ?? false;
    },
    async title() {
      return state.title;
    },
    async metaContent(property) {
      return state.metas[property] ?? null;
    },
    async screenshot() {
      return new Uint8Array([1, 2, 3]);
    },
    async close() {
      state.log.push('close');
      state.closeCount += 1;
    },
  };
}

function memoryStore(): ScreenshotStore & { data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    async put(key, bytes) {
      data.set(key, bytes);
    },
  };
}

test('happy path: goldens pass with per-check details and stored screenshots', async () => {
  const state = newState({
    elements: { result: [{ text: '$1,800.00', visible: true }] },
    title: 'Consulting Rate Estimator',
  });
  const store = memoryStore();
  const set: GoldenSet = {
    goldens: [
      {
        title: 'rush estimate',
        steps: [{ do: 'click', testid: 'calc-submit' }],
        expect: [{ testid: 'result', equals: '$1,800.00' }],
      },
      {
        title: 'headline renders',
        steps: [],
        expect: [{ titleEquals: 'Consulting Rate Estimator' }],
      },
    ],
  };

  const result = await runGoldens({
    url: 'https://reference.jiffyapp.dev',
    set,
    openPage: async () => fakeDriver(state),
    screenshots: { store, keyPrefix: 'pfx/' },
    timeoutMs: 1000,
  });

  assert.equal(result.pass, true);
  assert.equal(result.outcomes.length, 2);
  assert.deepEqual(result.outcomes[0].checks, [
    { description: 'result equals', pass: true, expected: '$1,800.00', actual: '$1,800.00' },
  ]);
  assert.deepEqual(result.outcomes[1].checks, [
    {
      description: 'page title equals',
      pass: true,
      expected: 'Consulting Rate Estimator',
      actual: 'Consulting Rate Estimator',
    },
  ]);
  assert.equal(result.outcomes[0].screenshotKey, 'shot-0.png');
  assert.equal(result.outcomes[1].screenshotKey, 'shot-1.png');
  assert.ok(store.data.has('pfx/shot-0.png'));
  assert.ok(store.data.has('pfx/shot-1.png'));
  assert.equal(state.closeCount, 2); // one page per golden, always closed
});

test('a failing equals reports expected vs actual; later goldens still run; overall pass is false', async () => {
  const state = newState({ elements: { result: [{ text: 'WRONG' }] }, title: 'X' });
  const set: GoldenSet = {
    goldens: [
      { title: 'fails', steps: [], expect: [{ testid: 'result', equals: '$1.00' }] },
      { title: 'still runs', steps: [], expect: [{ titleEquals: 'X' }] },
    ],
  };

  const result = await runGoldens({
    url: 'https://x.test',
    set,
    openPage: async () => fakeDriver(state),
    timeoutMs: 1000,
  });

  assert.equal(result.pass, false);
  assert.equal(result.outcomes[0].pass, false);
  assert.deepEqual(result.outcomes[0].checks[0], {
    description: 'result equals',
    pass: false,
    expected: '$1.00',
    actual: 'WRONG',
  });
  assert.equal(result.outcomes[1].pass, true);
});

test('a never-resolving textContent trips the per-golden timeout and the page is still closed', async () => {
  const state = newState({ hang: new Set(['textContent']) });
  const set: GoldenSet = {
    goldens: [{ title: 'hangs', steps: [], expect: [{ testid: 'result', equals: 'x' }] }],
  };

  const result = await runGoldens({
    url: 'https://x.test',
    set,
    openPage: async () => fakeDriver(state),
    timeoutMs: 50,
  });

  assert.equal(result.pass, false);
  assert.equal(result.outcomes[0].pass, false);
  assert.ok(result.outcomes[0].error);
  assert.equal(state.closeCount, 1);
});

test('censusMissing returns exactly the absent testids', async () => {
  const state = newState({ elements: { a: [{}], b: [] } });
  const missing = await censusMissing(fakeDriver(state), ['a', 'b', 'c']);
  assert.deepEqual(missing, ['b', 'c']);
});

test('upload steps pass fixture content through to uploadFile', async () => {
  const state = newState({ elements: { result: [{ text: 'ok' }] } });
  const set: GoldenSet = {
    goldens: [
      {
        title: 'upload',
        steps: [{ do: 'upload', testid: 'csv-input', fixture: 'sales.csv' }],
        expect: [{ testid: 'result', equals: 'ok' }],
      },
    ],
    fixtures: { 'sales.csv': 'month,revenue\nJan,1000\n' },
  };

  await runGoldens({
    url: 'https://x.test',
    set,
    openPage: async () => fakeDriver(state),
    timeoutMs: 1000,
  });

  assert.ok(state.log.includes('upload csv-input sales.csv month,revenue\nJan,1000\n'));
});

test('boolean fill values route to setChecked; string fill values route to fill', async () => {
  const state = newState({ elements: { result: [{ text: 'ok' }] } });
  const set: GoldenSet = {
    goldens: [
      {
        title: 'checkbox',
        steps: [{ do: 'fill', fields: { 'input-rush': true, 'input-hours': '5' } }],
        expect: [{ testid: 'result', equals: 'ok' }],
      },
    ],
  };

  await runGoldens({
    url: 'https://x.test',
    set,
    openPage: async () => fakeDriver(state),
    timeoutMs: 1000,
  });

  assert.ok(state.log.includes('setChecked input-rush=true'));
  assert.ok(state.log.includes('fill input-hours=5'));
});

test('paste with a fixture reference resolves the fixture content via fill', async () => {
  const state = newState({ elements: { output: [{ text: 'ok' }] } });
  const set: GoldenSet = {
    goldens: [
      {
        title: 'paste',
        steps: [{ do: 'paste', testid: 'input', fixture: 'data.json' }],
        expect: [{ testid: 'output', equals: 'ok' }],
      },
    ],
    fixtures: { 'data.json': '{"a":1}' },
  };

  await runGoldens({
    url: 'https://x.test',
    set,
    openPage: async () => fakeDriver(state),
    timeoutMs: 1000,
  });

  assert.ok(state.log.includes('fill input={"a":1}'));
});

test('screenshots are captured for failing goldens', async () => {
  const state = newState({
    elements: { result: [{ text: 'WRONG_VALUE', visible: true }] },
    title: 'Test Page',
  });
  const store = memoryStore();
  const set: GoldenSet = {
    goldens: [
      {
        title: 'failing check',
        steps: [],
        expect: [{ testid: 'result', equals: 'EXPECTED_VALUE' }],
      },
    ],
  };

  const result = await runGoldens({
    url: 'https://x.test',
    set,
    openPage: async () => fakeDriver(state),
    screenshots: { store, keyPrefix: 'pfx/' },
    timeoutMs: 1000,
  });

  assert.equal(result.pass, false);
  assert.equal(result.outcomes[0].pass, false);
  assert.equal(result.outcomes[0].screenshotKey, 'shot-0.png');
  assert.ok(store.data.has('pfx/shot-0.png'));
});

test('screenshots are captured for timed-out goldens', async () => {
  const state = newState({ hang: new Set(['textContent']) });
  const store = memoryStore();
  const set: GoldenSet = {
    goldens: [
      {
        title: 'timed out check',
        steps: [],
        expect: [{ testid: 'result', equals: 'x' }],
      },
    ],
  };

  const result = await runGoldens({
    url: 'https://x.test',
    set,
    openPage: async () => fakeDriver(state),
    screenshots: { store, keyPrefix: 'pfx/' },
    timeoutMs: 50,
  });

  assert.equal(result.pass, false);
  assert.equal(result.outcomes[0].pass, false);
  assert.ok(result.outcomes[0].error);
  assert.equal(result.outcomes[0].screenshotKey, 'shot-0.png');
  assert.ok(store.data.has('pfx/shot-0.png'));
});
