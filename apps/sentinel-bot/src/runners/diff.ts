import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from 'pino';
import { getJob, setJob, type JobState } from '../store.js';

export interface DiffCheckResult {
  target: string;
  changed: boolean;
  currentHash: string;
  previousHash?: string;
  diffSummary?: string;
  currentExcerpt: string;
  screenshotBase64?: string;
}

export interface DiffRunnerConfig {
  apiKey: string;
  timeoutMs?: number;
  logger: Logger;
}

export async function checkDiff(
  target: string,
  contractId: string,
  options: {
    requiresJs: boolean;
    selectors?: string[];
    screenshot: boolean;
  },
  config: DiffRunnerConfig,
): Promise<DiffCheckResult> {
  const { apiKey, timeoutMs = 30_000, logger } = config;
  const storeKey = `${contractId}:${target}`;

  const prior = getJob(storeKey);
  const previousHash = prior?.snapshotHash;

  const browser = await chromium.launch({ headless: true });

  let content: string;
  let screenshotBase64: string | undefined;

  try {
    const context = await browser.newContext({
      javaScriptEnabled: options.requiresJs,
    });
    const page = await context.newPage();

    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    if (options.selectors && options.selectors.length > 0) {
      const parts: string[] = [];
      for (const sel of options.selectors) {
        const text = await page.locator(sel).textContent();
        parts.push(text ?? '');
      }
      content = parts.join('\n');
    } else {
      content = await page.evaluate(() => document.body.innerText);
    }

    if (options.screenshot) {
      const buf = await page.screenshot({ fullPage: true, type: 'png' });
      screenshotBase64 = buf.toString('base64');
    }
  } finally {
    await browser.close();
  }

  const currentHash = createHash('sha256').update(content).digest('hex');
  const currentExcerpt = content.slice(0, 500);
  // First-ever run has no previous baseline — record the snapshot but don't
  // claim the page changed against itself.
  const isFirstRun = previousHash === undefined;
  const changed = !isFirstRun && previousHash !== currentHash;

  let diffSummary: string | undefined;

  if (changed) {
    const client = new Anthropic({ apiKey });
    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 150,
        messages: [
          {
            role: 'user',
            content: `Previous content excerpt:\n${prior?.snapshotExcerpt ?? '(none)'}\n\nCurrent content excerpt:\n${currentExcerpt}\n\nIn 2-3 sentences, summarize what changed: which section changed and what the new content says.`,
          },
        ],
      });

      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === 'text',
      );
      diffSummary = textBlock?.text ?? 'Content changed (summary unavailable)';
    } catch {
      diffSummary = 'Content changed (summary unavailable)';
    }
  }

  const updatedState: JobState = {
    gigId: prior?.gigId ?? '',
    contractId,
    status: prior?.status ?? 'unknown',
    lastCheckedAt: new Date().toISOString(),
    lastStatusCode: prior?.lastStatusCode,
    lastResponseMs: prior?.lastResponseMs,
    lastError: prior?.lastError,
    snapshotHash: currentHash,
    snapshotExcerpt: currentExcerpt,
  };

  setJob(storeKey, updatedState);

  if (isFirstRun) {
    logger.info({ target, contractId, currentHash }, 'diff check: baseline established');
  } else if (changed) {
    logger.info({ target, contractId, currentHash, previousHash }, 'diff check: content changed');
  } else {
    logger.info({ target, contractId, currentHash }, 'diff check: no change');
  }

  return {
    target,
    changed,
    currentHash,
    previousHash,
    diffSummary,
    currentExcerpt,
    screenshotBase64,
  };
}
