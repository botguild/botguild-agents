import type { Logger } from 'pino';

// pino doesn't run on Workers (it writes to process.stdout via sonic-boom), but
// every agent-core API takes a pino `Logger`. This module provides a structural
// stand-in: one JSON object per line through `console`, which Workers Logs
// collects, with the same field contract as agent-core's createLogger
// (`service`, `botId` base fields; `gigId`/`contractId` arrive via child()
// bindings or per-call objects).

const LEVEL_VALUES: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Infinity,
};

// Workers Logs derives the log level from which console method emitted the
// line, so route each pino level to its closest console equivalent.
const CONSOLE_METHODS: Record<string, 'debug' | 'info' | 'warn' | 'error'> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
};

export interface ConsoleLoggerOptions {
  service: string;
  botId?: string;
  /** Minimum level emitted: 'trace'…'fatal', or 'silent'. Defaults to 'info'. */
  level?: string;
}

/** pino-style call shapes: `log({ gigId }, 'msg')` or `log('msg')`. */
type LogFn = (objOrMsg?: unknown, msg?: string) => void;

export interface WorkersLogger {
  level: string;
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  child(bindings: Record<string, unknown>, options?: { level?: string }): WorkersLogger;
}

// Errors don't JSON.stringify (their properties are non-enumerable), so any
// top-level Error value — the pino `{ err }` idiom — is expanded explicitly.
function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function toEntry(objOrMsg: unknown, msg?: string): { data: Record<string, unknown>; msg?: string } {
  if (typeof objOrMsg === 'string') return { data: {}, msg: objOrMsg };
  if (objOrMsg !== null && typeof objOrMsg === 'object') {
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(objOrMsg)) {
      data[key] = serializeValue(value);
    }
    return { data, msg };
  }
  return { data: {}, msg: objOrMsg === undefined ? msg : String(objOrMsg) };
}

function makeLogger(base: Record<string, unknown>, level: string): WorkersLogger {
  const threshold = LEVEL_VALUES[level];
  if (threshold === undefined) {
    throw new Error(`unknown log level: ${level}`);
  }

  const log =
    (levelLabel: string): LogFn =>
    (objOrMsg?: unknown, msg?: string): void => {
      if (LEVEL_VALUES[levelLabel]! < threshold) return;
      const entry = toEntry(objOrMsg, msg);
      const line: Record<string, unknown> = {
        level: levelLabel,
        time: new Date().toISOString(),
        ...base,
        ...entry.data,
      };
      if (entry.msg !== undefined) line['msg'] = entry.msg;
      let serialized: string;
      try {
        serialized = JSON.stringify(line);
      } catch {
        // Circular payload — never let observability throw into bot logic.
        serialized = JSON.stringify({
          level: levelLabel,
          ...base,
          msg: entry.msg ?? '[unserializable log entry]',
        });
      }
      console[CONSOLE_METHODS[levelLabel]!](serialized);
    };

  return {
    level,
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    fatal: log('fatal'),
    child(bindings: Record<string, unknown>, options?: { level?: string }): WorkersLogger {
      return makeLogger({ ...base, ...bindings }, options?.level ?? level);
    },
  };
}

/**
 * A structural pino-compatible logger for Workers: one-line JSON to `console`,
 * same base-field contract as agent-core's `createLogger` (`service`, `botId`).
 *
 * The return type is pino's `Logger` so it can be passed straight into every
 * agent-core API. The cast below is the ONE deliberate lie in this package:
 * agent-core only ever calls the six level methods and `child()` (all
 * implemented here with pino's call shapes); pino's remaining surface
 * (bindings(), flush(), isLevelEnabled(), the EventEmitter methods, …) is not
 * implemented and would throw if something reached for it.
 */
export function createConsoleLogger(options: ConsoleLoggerOptions): Logger {
  const logger = makeLogger(
    { service: options.service, botId: options.botId ?? 'unregistered' },
    options.level ?? 'info',
  );
  return logger as unknown as Logger;
}
