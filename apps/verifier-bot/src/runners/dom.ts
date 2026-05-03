import { chromium } from 'playwright';
import type { Logger } from 'pino';
import type { CheckResult } from './http.ts';

export type DomCheckType = 'element-present' | 'text-match' | 'element-visible' | 'form-submit';

export interface DomCheck {
  criterionId: string;
  description: string;
  checkType: DomCheckType;
  selector: string;
  expectedText?: string;
  submitSelector?: string;
  expectedResponseText?: string;
}

export interface DomRunnerConfig {
  screenshotEnabled: boolean;
  timeoutMs?: number;
  logger: Logger;
}

export interface DomCheckGroupResult {
  results: CheckResult[];
  screenshotBase64?: string;
}

async function runSingleCheck(
  page: import('playwright').Page,
  check: DomCheck,
  timeoutMs: number,
): Promise<CheckResult> {
  const { criterionId, description, checkType, selector } = check;

  try {
    switch (checkType) {
      case 'element-present': {
        const count = await page.locator(selector).count();
        const passed = count > 0;
        return {
          criterionId,
          description,
          verdict: passed ? 'pass' : 'fail',
          actual: passed ? `element found (${count})` : 'element not found',
          expected: `element matching "${selector}" is present`,
          attempts: 1,
        };
      }

      case 'text-match': {
        const { expectedText = '' } = check;
        const text = await page.locator(selector).textContent({ timeout: timeoutMs });
        const actual = text ?? '';
        const passed = actual.toLowerCase().includes(expectedText.toLowerCase());
        return {
          criterionId,
          description,
          verdict: passed ? 'pass' : 'fail',
          actual: `text content: "${actual}"`,
          expected: `"${selector}" contains "${expectedText}"`,
          attempts: 1,
        };
      }

      case 'element-visible': {
        const visible = await page.locator(selector).isVisible();
        return {
          criterionId,
          description,
          verdict: visible ? 'pass' : 'fail',
          actual: visible ? 'element is visible' : 'element is not visible',
          expected: `element matching "${selector}" is visible`,
          attempts: 1,
        };
      }

      case 'form-submit': {
        const { submitSelector = selector, expectedResponseText = '' } = check;
        await page.locator(submitSelector).click();
        await page.waitForTimeout(2000);
        const bodyText = (await page.content()).toLowerCase();
        const passed = bodyText.includes(expectedResponseText.toLowerCase());
        return {
          criterionId,
          description,
          verdict: passed ? 'pass' : 'fail',
          actual: passed
            ? `page contains "${expectedResponseText}"`
            : `page does not contain "${expectedResponseText}"`,
          expected: `after clicking "${submitSelector}", page contains "${expectedResponseText}"`,
          attempts: 1,
        };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      criterionId,
      description,
      verdict: 'fail',
      actual: message,
      expected: `${checkType} check on "${selector}"`,
      attempts: 1,
    };
  }
}

export async function runDomChecks(
  url: string,
  checks: DomCheck[],
  config: DomRunnerConfig,
): Promise<DomCheckGroupResult> {
  const { screenshotEnabled, timeoutMs = 30_000, logger } = config;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);

    logger.info({ url }, 'navigating to URL for DOM checks');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    const results: CheckResult[] = [];
    for (const check of checks) {
      logger.info({ criterionId: check.criterionId, checkType: check.checkType }, 'running DOM check');
      const result = await runSingleCheck(page, check, timeoutMs);
      logger.info(
        { criterionId: result.criterionId, verdict: result.verdict, actual: result.actual },
        'DOM check complete',
      );
      results.push(result);
    }

    let screenshotBase64: string | undefined;
    if (screenshotEnabled) {
      logger.info({ url }, 'taking full-page screenshot');
      const buffer = await page.screenshot({ fullPage: true });
      screenshotBase64 = buffer.toString('base64');
    }

    return { results, screenshotBase64 };
  } finally {
    await browser.close();
  }
}
