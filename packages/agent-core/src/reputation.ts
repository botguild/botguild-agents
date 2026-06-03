import type { Logger } from 'pino';
import type { MyReputation, MyEarnings } from './mcp.js';

// Minimal surface the monitor needs — AgentMcpClient satisfies it. Kept narrow
// so tests can inject a stub without constructing a full MCP client.
export interface ReputationSource {
  getMyReputation(): Promise<MyReputation>;
  getMyEarnings(args?: { limit?: number }): Promise<MyEarnings>;
}

// The compact reputation view surfaced on GET /health. Earnings are NOT exposed
// here (balance/funded are operator-only) — they go to logs via refresh().
export interface ReputationSnapshot {
  reputationScore: number;
  disputeRate: number;
  updatedAt: string;
}

export interface ReputationMonitorConfig {
  source: ReputationSource;
  logger: Logger;
  /** Refresh cadence. Defaults to 15 min — reputation moves slowly and the
   * MCP read shouldn't be on the 30s Fly health-check path. */
  intervalMs?: number;
}

export interface ReputationMonitor {
  /** Latest reputation view for /health, or null until the first successful
   * refresh. Never throws. */
  snapshot(): ReputationSnapshot | null;
  /** Pull reputation + earnings once. Tolerant: logs and keeps the prior
   * snapshot on failure. Returned for callers that want an eager first read. */
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
}

export function createReputationMonitor(config: ReputationMonitorConfig): ReputationMonitor {
  const { source, logger } = config;
  const intervalMs = config.intervalMs ?? 15 * 60 * 1000;
  let current: ReputationSnapshot | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh(): Promise<void> {
    try {
      const rep = await source.getMyReputation();
      current = {
        reputationScore: rep.handler.reputationScore,
        disputeRate: rep.handler.disputeRate,
        updatedAt: new Date().toISOString(),
      };
      logger.info(
        { reputationScore: rep.handler.reputationScore, disputeRate: rep.handler.disputeRate },
        'reputation refreshed',
      );
    } catch (err) {
      // Keep the last good snapshot; reputation is best-effort observability.
      logger.warn({ err }, 'reputation refresh failed; keeping previous snapshot');
    }

    try {
      const earnings = await source.getMyEarnings();
      logger.info({ earnings: earnings.summary }, 'earnings refreshed');
    } catch (err) {
      logger.warn({ err }, 'earnings refresh failed');
    }
  }

  return {
    snapshot() {
      return current;
    },
    refresh,
    start() {
      void refresh();
      timer = setInterval(() => void refresh(), intervalMs);
      // Don't let the refresh timer keep the process alive on its own.
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
