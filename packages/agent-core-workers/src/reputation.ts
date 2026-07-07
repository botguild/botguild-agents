import type { Logger } from 'pino';
import { createReputationMonitor } from '@botguild/agent-core';
import type { ReputationSnapshot, ReputationSource } from '@botguild/agent-core';

export interface RefreshReputationConfig {
  source: ReputationSource;
  logger: Logger;
}

/**
 * One awaitable reputation refresh for the cron sweep. No setInterval timer
 * survives between Worker invocations, so instead of
 * createReputationMonitor(...).start() the scheduled handler calls this and
 * caches the returned snapshot in D1 for /health to read.
 *
 * Reuses the monitor's refresh logic verbatim (reputation + earnings reads,
 * tolerant logging). Never throws; returns null when the read failed.
 */
export async function refreshReputationOnce(
  config: RefreshReputationConfig,
): Promise<ReputationSnapshot | null> {
  const monitor = createReputationMonitor({ source: config.source, logger: config.logger });
  await monitor.refresh();
  return monitor.snapshot();
}
