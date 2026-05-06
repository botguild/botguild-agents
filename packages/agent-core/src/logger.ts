import pino from 'pino';

export interface LoggerOptions {
  service: string; // 'sentinel-bot' | 'flow-bot' | 'verifier-bot'
  botId?: string;
  level?: string; // defaults to process.env.LOG_LEVEL ?? 'info'
}

export function createLogger(options: LoggerOptions): pino.Logger {
  return pino({
    level: options.level ?? process.env['LOG_LEVEL'] ?? 'info',
    base: {
      service: options.service,
      botId: options.botId ?? 'unregistered',
    },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export function withContext(logger: pino.Logger, context: Record<string, unknown>): pino.Logger {
  return logger.child(context);
}
