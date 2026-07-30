// PageSpeed Insights v5 client (§9 gate). Returns raw scores only — the caller applies the
// config thresholds (PSI_PERFORMANCE_MIN / PSI_ACCESSIBILITY_MIN in config.ts); this module
// never judges pass/fail, only whether the API call itself succeeded. Retries ONCE on a
// network throw or a 5xx response (1s backoff, injectable via `sleep` so tests never
// actually wait), mirroring deploy.ts's retry shape; a 4xx or a parse failure is treated as
// permanent and returned immediately with no retry. Never throws.

import type { Logger } from 'pino';

export interface PsiResult {
  ok: boolean; // the API call succeeded (NOT a threshold pass)
  performance?: number; // 0–100
  accessibility?: number; // 0–100
  raw?: unknown; // full lighthouseResult JSON, retained for evidence
  error?: string;
}

export interface PsiClientConfig {
  apiKey: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable backoff sleep — tests pass a no-op so the single retry doesn't wait. */
  sleep?: (ms: number) => Promise<void>;
  logger: Logger;
}

export interface PsiClient {
  run(url: string): Promise<PsiResult>;
}

interface LighthouseCategory {
  score?: number;
}

interface PsiResponseBody {
  lighthouseResult?: {
    categories?: {
      performance?: LighthouseCategory;
      accessibility?: LighthouseCategory;
    };
  };
}

const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const RETRY_BACKOFF_MS = 1000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(pageUrl: string, apiKey: string): string {
  const params = new URLSearchParams();
  params.set('url', pageUrl);
  params.set('key', apiKey);
  params.append('category', 'PERFORMANCE');
  params.append('category', 'ACCESSIBILITY');
  params.set('strategy', 'mobile');
  return `${PSI_ENDPOINT}?${params.toString()}`;
}

export function createPsiClient(config: PsiClientConfig): PsiClient {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const sleep = config.sleep ?? defaultSleep;
  const { apiKey, logger } = config;

  async function attempt(url: string): Promise<{ response?: Response; thrown?: unknown }> {
    try {
      return { response: await fetchImpl(url) };
    } catch (err) {
      return { thrown: err };
    }
  }

  return {
    async run(pageUrl: string): Promise<PsiResult> {
      const url = buildUrl(pageUrl, apiKey);
      let { response, thrown } = await attempt(url);

      if (!response || response.status >= 500) {
        logger.warn(
          { url: pageUrl, status: response?.status, err: thrown },
          'psi: retrying after failed request',
        );
        await sleep(RETRY_BACKOFF_MS);
        ({ response, thrown } = await attempt(url));
      }

      if (!response) {
        const detail = thrown instanceof Error ? thrown.message : String(thrown);
        return { ok: false, error: `network error: ${detail}` };
      }
      if (!response.ok) {
        return { ok: false, error: `PSI API responded ${response.status}` };
      }

      let body: PsiResponseBody;
      try {
        body = (await response.json()) as PsiResponseBody;
      } catch {
        return { ok: false, error: 'PSI API returned unparseable JSON' };
      }

      const categories = body.lighthouseResult?.categories;
      const performance = categories?.performance?.score;
      const accessibility = categories?.accessibility?.score;
      if (typeof performance !== 'number' || typeof accessibility !== 'number') {
        return { ok: false, error: 'PSI response missing performance/accessibility category' };
      }

      return {
        ok: true,
        performance: Math.round(performance * 100),
        accessibility: Math.round(accessibility * 100),
        raw: body.lighthouseResult,
      };
    },
  };
}
