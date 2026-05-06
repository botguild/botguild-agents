import Ajv from 'ajv';
import type { Logger } from 'pino';

export type CheckVerdict = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  criterionId: string;
  description: string;
  verdict: CheckVerdict;
  actual: string;
  expected: string;
  latencyMs?: number;
  error?: string;
  attempts: number;
}

export interface HttpCheckConfig {
  timeoutMs?: number;
  auth?: {
    style: 'bearer' | 'api-key-header' | 'basic';
    token?: string;
    headerName?: string;
    username?: string;
  };
  expectedStatusCode?: number;
  maxLatencyMs?: number;
  responseSchema?: object;
  requiredHeaders?: string[];
  logger: Logger;
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

function buildAuthHeaders(auth: NonNullable<HttpCheckConfig['auth']>): Record<string, string> {
  switch (auth.style) {
    case 'bearer':
      return { Authorization: `Bearer ${auth.token}` };
    case 'api-key-header':
      return { [auth.headerName!]: auth.token! };
    case 'basic': {
      const encoded = btoa(`${auth.username}:${auth.token}`);
      return { Authorization: `Basic ${encoded}` };
    }
  }
}

interface AttemptFailure {
  actual: string;
  expected: string;
  error?: string;
}

async function runAttempt(
  target: string,
  config: HttpCheckConfig,
): Promise<{ latencyMs: number } | AttemptFailure> {
  const {
    timeoutMs = 10_000,
    auth,
    expectedStatusCode = 200,
    maxLatencyMs,
    responseSchema,
    requiredHeaders,
  } = config;

  const headers: Record<string, string> = auth ? buildAuthHeaders(auth) : {};
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const start = Date.now();
  let latencyMs: number;

  try {
    const response = await fetch(target, { headers, signal: controller.signal });
    latencyMs = Date.now() - start;
    clearTimeout(timeoutId);

    if (response.status !== expectedStatusCode) {
      return {
        actual: `status ${response.status}`,
        expected: `status ${expectedStatusCode}`,
      };
    }

    if (maxLatencyMs !== undefined && latencyMs > maxLatencyMs) {
      return {
        actual: `latency ${latencyMs}ms`,
        expected: `latency ≤ ${maxLatencyMs}ms`,
      };
    }

    if (requiredHeaders && requiredHeaders.length > 0) {
      for (const headerName of requiredHeaders) {
        if (!response.headers.has(headerName)) {
          return {
            actual: `missing header ${headerName}`,
            expected: `header ${headerName} present`,
          };
        }
      }
    }

    if (responseSchema) {
      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        return {
          actual: 'response body is not valid JSON',
          expected: 'valid JSON matching schema',
          error: err instanceof Error ? err.message : String(err),
        };
      }

      const ajv = new Ajv();
      const valid = ajv.validate(responseSchema, body);
      if (!valid) {
        const errorText = ajv.errorsText();
        return {
          actual: `schema validation failed: ${errorText}`,
          expected: 'response body matching JSON schema',
        };
      }
    }

    return { latencyMs };
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof Error && err.name === 'AbortError') {
      return {
        actual: `timeout after ${timeoutMs}ms`,
        expected: `response within ${timeoutMs}ms`,
        error: `Timeout after ${timeoutMs}ms`,
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    return {
      actual: `fetch error: ${message}`,
      expected: `status ${expectedStatusCode}`,
      error: message,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runHttpCheck(
  target: string,
  criterionId: string,
  description: string,
  config: HttpCheckConfig,
): Promise<CheckResult> {
  const { logger } = config;

  let lastFailure: AttemptFailure | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    logger.info({ target, criterionId, attempt }, 'running HTTP check attempt');

    const result = await runAttempt(target, config);

    if ('latencyMs' in result) {
      logger.info(
        { target, criterionId, attempt, latencyMs: result.latencyMs },
        'HTTP check passed',
      );
      return {
        criterionId,
        description,
        verdict: 'pass',
        actual: buildActualDescription(config, result.latencyMs),
        expected: buildExpectedDescription(config),
        latencyMs: result.latencyMs,
        attempts: attempt,
      };
    }

    lastFailure = result;

    logger.warn(
      {
        target,
        criterionId,
        attempt,
        actual: result.actual,
        expected: result.expected,
        error: result.error,
      },
      'HTTP check attempt failed',
    );

    if (attempt < MAX_ATTEMPTS) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  logger.error(
    { target, criterionId, actual: lastFailure!.actual, expected: lastFailure!.expected },
    'HTTP check failed after all attempts',
  );

  return {
    criterionId,
    description,
    verdict: 'fail',
    actual: lastFailure!.actual,
    expected: lastFailure!.expected,
    error: lastFailure!.error,
    attempts: MAX_ATTEMPTS,
  };
}

function buildExpectedDescription(config: HttpCheckConfig): string {
  const { expectedStatusCode = 200, maxLatencyMs, requiredHeaders, responseSchema } = config;
  const parts: string[] = [`status ${expectedStatusCode}`];
  if (maxLatencyMs !== undefined) parts.push(`latency ≤ ${maxLatencyMs}ms`);
  if (requiredHeaders && requiredHeaders.length > 0)
    parts.push(`headers: ${requiredHeaders.join(', ')}`);
  if (responseSchema) parts.push('valid schema');
  return parts.join(', ');
}

function buildActualDescription(config: HttpCheckConfig, latencyMs: number): string {
  const { expectedStatusCode = 200, maxLatencyMs, requiredHeaders, responseSchema } = config;
  // The runner only reaches this path when status, latency, headers, and schema all checked out,
  // so the *actual* measured values match the expected — but reporting the measurement (real
  // status code and real latency) is what the report is supposed to show.
  const parts: string[] = [`status ${expectedStatusCode}`, `latency ${latencyMs}ms`];
  if (maxLatencyMs !== undefined) parts.push(`(≤ ${maxLatencyMs}ms)`);
  if (requiredHeaders && requiredHeaders.length > 0)
    parts.push(`headers: ${requiredHeaders.join(', ')} present`);
  if (responseSchema) parts.push('schema valid');
  return parts.join(', ');
}
