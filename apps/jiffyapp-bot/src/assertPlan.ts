// Assertion-plan executor: runs a validated `GoldenSet` against a `PageDriver` and turns
// each golden into an `AssertionOutcome`. Pure policy + a driver interface — zero
// Workers/browser imports. Task 15 supplies the real Playwright-backed `PageDriver`; tests
// here (assertPlan.test.ts) use a scripted fake.

import type { GoldenExample, GoldenExpectation, GoldenSet, GoldenStep } from './types.js';

export interface AssertionOutcome {
  goldenTitle: string;
  pass: boolean;
  checks: Array<{ description: string; pass: boolean; expected: string; actual: string }>;
  /** BASENAME only (e.g. 'shot-0.png') — stored at `${keyPrefix}${basename}`; consumers
   *  (evidence report, build-log page) compose /deliverables/<token>/<basename>. */
  screenshotKey?: string;
  error?: string; // driver/timeout error
}

export interface PageDriver {
  goto(url: string): Promise<void>;
  fill(testid: string, value: string, nth?: number): Promise<void>;
  setChecked(testid: string, checked: boolean, nth?: number): Promise<void>;
  selectOption(testid: string, value: string, nth?: number): Promise<void>;
  click(testid: string, nth?: number): Promise<void>;
  uploadFile(testid: string, name: string, content: string): Promise<void>;
  textContent(testid: string, nth?: number): Promise<string | null>;
  getAttribute(testid: string, attr: string, nth?: number): Promise<string | null>;
  count(testid: string): Promise<number>;
  isVisible(testid: string, nth?: number): Promise<boolean>;
  title(): Promise<string>;
  metaContent(property: string): Promise<string | null>;
  screenshot(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface ScreenshotStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
}

type Check = { description: string; pass: boolean; expected: string; actual: string };

/** Executes a golden's steps against a fresh page. `fill` iterates `fields`: boolean values
 *  route to `setChecked`, everything else to `fill`. `paste` resolves `text` or
 *  `fixtures[fixture]` and calls `fill`. `upload` resolves `fixtures[fixture]` and calls
 *  `uploadFile`. */
async function executeStep(
  driver: PageDriver,
  step: GoldenStep,
  fixtures: Record<string, string>,
): Promise<void> {
  switch (step.do) {
    case 'load':
      return; // goto() already happened before the first step
    case 'fill':
      for (const [testid, value] of Object.entries(step.fields)) {
        if (typeof value === 'boolean') {
          await driver.setChecked(testid, value);
        } else {
          await driver.fill(testid, value);
        }
      }
      return;
    case 'select':
      for (const [testid, value] of Object.entries(step.fields)) {
        await driver.selectOption(testid, value);
      }
      return;
    case 'click':
      await driver.click(step.testid, step.nth);
      return;
    case 'paste': {
      const value =
        step.text ?? (step.fixture !== undefined ? fixtures[step.fixture] : undefined) ?? '';
      await driver.fill(step.testid, value);
      return;
    }
    case 'upload': {
      const content = fixtures[step.fixture] ?? '';
      await driver.uploadFile(step.testid, step.fixture, content);
      return;
    }
  }
}

/** Evaluates a single expectation. Text comparisons trim whitespace; `contains` is a
 *  substring check on the trimmed text; href/attr comparisons read attributes raw. */
async function evaluateExpectation(
  driver: PageDriver,
  expectation: GoldenExpectation,
): Promise<Check> {
  if ('titleEquals' in expectation) {
    const actual = await driver.title();
    return {
      description: 'page title equals',
      expected: expectation.titleEquals,
      actual,
      pass: actual === expectation.titleEquals,
    };
  }
  if ('metaEquals' in expectation) {
    const { property, value } = expectation.metaEquals;
    const raw = await driver.metaContent(property);
    const actual = raw ?? '';
    return {
      description: `meta[${property}] equals`,
      expected: value,
      actual,
      pass: actual === value,
    };
  }

  const testid = expectation.testid;
  const nth = 'nth' in expectation ? expectation.nth : undefined;

  if ('equals' in expectation) {
    const raw = await driver.textContent(testid, nth);
    const actual = (raw ?? '').trim();
    return {
      description: `${testid} equals`,
      expected: expectation.equals,
      actual,
      pass: actual === expectation.equals,
    };
  }
  if ('contains' in expectation) {
    const raw = await driver.textContent(testid, nth);
    const actual = (raw ?? '').trim();
    return {
      description: `${testid} contains`,
      expected: expectation.contains,
      actual,
      pass: actual.includes(expectation.contains),
    };
  }
  if ('count' in expectation) {
    const actual = await driver.count(testid);
    return {
      description: `${testid} count`,
      expected: String(expectation.count),
      actual: String(actual),
      pass: actual === expectation.count,
    };
  }
  if ('visible' in expectation) {
    const actual = await driver.isVisible(testid, nth);
    return {
      description: `${testid} visible`,
      expected: 'true',
      actual: String(actual),
      pass: actual === true,
    };
  }
  if ('hidden' in expectation) {
    const actual = await driver.isVisible(testid, nth);
    return {
      description: `${testid} hidden`,
      expected: 'false',
      actual: String(actual),
      pass: actual === false,
    };
  }
  if ('hrefEquals' in expectation) {
    const raw = await driver.getAttribute(testid, 'href', nth);
    const actual = raw ?? '';
    return {
      description: `${testid} href equals`,
      expected: expectation.hrefEquals,
      actual,
      pass: actual === expectation.hrefEquals,
    };
  }
  if ('hrefStartsWith' in expectation) {
    const raw = await driver.getAttribute(testid, 'href', nth);
    const actual = raw ?? '';
    return {
      description: `${testid} href starts with`,
      expected: expectation.hrefStartsWith,
      actual,
      pass: actual.startsWith(expectation.hrefStartsWith),
    };
  }
  const { attr, value } = expectation.attrEquals;
  const raw = await driver.getAttribute(testid, attr, nth);
  const actual = raw ?? '';
  return {
    description: `${testid}[${attr}] equals`,
    expected: value,
    actual,
    pass: actual === value,
  };
}

/** Races `fn()` against `timeoutMs`, rejecting with a timeout error if it doesn't win. The
 *  loser (a hung `fn()`) is left to resolve/reject on its own — it is not cancelled. */
function raceWithTimeout(fn: () => Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`golden timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    fn().then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

async function runOneGolden(params: {
  url: string;
  golden: GoldenExample;
  index: number;
  fixtures: Record<string, string>;
  openPage: () => Promise<PageDriver>;
  screenshots?: { store: ScreenshotStore; keyPrefix: string };
  timeoutMs: number;
}): Promise<AssertionOutcome> {
  const { url, golden, index, fixtures, openPage, screenshots, timeoutMs } = params;

  let driver: PageDriver | undefined;
  let checks: Check[] = [];
  let error: string | undefined;

  try {
    driver = await openPage();
    const activeDriver = driver;
    await raceWithTimeout(async () => {
      await activeDriver.goto(url);
      for (const step of golden.steps) {
        await executeStep(activeDriver, step, fixtures);
      }
      const collected: Check[] = [];
      for (const expectation of golden.expect) {
        collected.push(await evaluateExpectation(activeDriver, expectation));
      }
      checks = collected;
    }, timeoutMs);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  let screenshotKey: string | undefined;
  if (screenshots && driver) {
    try {
      const bytes = await driver.screenshot();
      const basename = `shot-${index}.png`;
      await screenshots.store.put(`${screenshots.keyPrefix}${basename}`, bytes);
      screenshotKey = basename;
    } catch (err) {
      if (error === undefined) error = err instanceof Error ? err.message : String(err);
    }
  }

  if (driver) {
    try {
      await driver.close();
    } catch {
      // best-effort cleanup; a close failure doesn't change the outcome
    }
  }

  const pass = error === undefined && checks.every((check) => check.pass);
  const outcome: AssertionOutcome = { goldenTitle: golden.title, pass, checks };
  if (screenshotKey !== undefined) outcome.screenshotKey = screenshotKey;
  if (error !== undefined) outcome.error = error;
  return outcome;
}

/** Runs every golden in `set`, in order, each against a fresh page (`openPage()` per
 *  golden). A per-golden timeout (`Promise.race`) marks the golden failed with `error` set
 *  and moves on to the next one — one hung/broken golden never blocks the rest. A
 *  screenshot is always taken (pass or fail) when `screenshots` is given, and the page is
 *  always closed. */
export async function runGoldens(args: {
  url: string;
  set: GoldenSet;
  openPage: () => Promise<PageDriver>; // one page per golden run (fresh state per golden)
  screenshots?: { store: ScreenshotStore; keyPrefix: string }; // key = `${prefix}shot-<i>.png`
  timeoutMs: number; // per-golden budget, enforced with Promise.race
  now?: () => Date;
}): Promise<{ pass: boolean; outcomes: AssertionOutcome[]; elementCensus?: never }> {
  const { url, set, openPage, screenshots, timeoutMs } = args;
  const fixtures = set.fixtures ?? {};
  const outcomes: AssertionOutcome[] = [];

  for (let index = 0; index < set.goldens.length; index++) {
    const golden = set.goldens[index];
    const outcome = await runOneGolden({
      url,
      golden,
      index,
      fixtures,
      openPage,
      screenshots,
      timeoutMs,
    });
    outcomes.push(outcome);
  }

  return { pass: outcomes.every((outcome) => outcome.pass), outcomes };
}

/** The FR-8 element-contract gate: for each testid in `contract`, `count() === 0` means it's
 *  missing from the loaded page. Caller is responsible for loading the page first. */
export async function censusMissing(driver: PageDriver, contract: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const testid of contract) {
    const n = await driver.count(testid);
    if (n === 0) missing.push(testid);
  }
  return missing;
}
