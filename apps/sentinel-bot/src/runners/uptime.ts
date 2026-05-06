import type { Logger } from 'pino';
import { getJob, setJob, type JobState } from '../store.js';

export interface UptimeCheckResult {
  target: string;
  status: 'up' | 'down';
  statusCode?: number;
  responseMs: number;
  error?: string;
  stateChanged: boolean;
  previousStatus?: 'up' | 'down' | 'unknown';
}

export interface UptimeRunnerConfig {
  timeoutMs?: number;
  logger: Logger;
}

export async function checkUptime(
  target: string,
  contractId: string,
  config: UptimeRunnerConfig,
): Promise<UptimeCheckResult> {
  const { timeoutMs = 10_000, logger } = config;
  const storeKey = `${contractId}:${target}`;

  const prior = getJob(storeKey);
  const previousStatus = prior?.status;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let status: 'up' | 'down' = 'down';
  let statusCode: number | undefined;
  let responseMs = 0;
  let error: string | undefined;

  const start = Date.now();

  try {
    const response = await fetch(target, { signal: controller.signal });
    responseMs = Date.now() - start;
    statusCode = response.status;

    if (response.status >= 200 && response.status < 300) {
      status = 'up';
    } else {
      status = 'down';
      error = `HTTP ${response.status}`;
    }
  } catch (err) {
    responseMs = Date.now() - start;
    status = 'down';

    if (err instanceof Error) {
      if (err.name === 'AbortError') {
        error = `Timeout after ${timeoutMs}ms`;
      } else {
        error = err.message;
      }
    } else {
      error = String(err);
    }
  } finally {
    clearTimeout(timeoutId);
  }

  const stateChanged = previousStatus === undefined
    ? false
    : previousStatus !== 'unknown' && previousStatus !== status;

  const updatedState: JobState = {
    gigId: prior?.gigId ?? '',
    contractId,
    status,
    lastCheckedAt: new Date().toISOString(),
    lastStatusCode: statusCode,
    lastResponseMs: responseMs,
    lastError: error,
    snapshotHash: prior?.snapshotHash,
    snapshotExcerpt: prior?.snapshotExcerpt,
  };

  setJob(storeKey, updatedState);

  logger.info(
    { target, contractId, status, statusCode, responseMs, stateChanged, error },
    'uptime check complete',
  );

  return {
    target,
    status,
    statusCode,
    responseMs,
    error,
    stateChanged,
    previousStatus,
  };
}
