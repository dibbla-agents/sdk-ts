/**
 * Minimal leveled logger for SDK internals.
 *
 * The level comes from SDK_LOG_LEVEL (debug, info, warn, error, silent) and
 * defaults to info. Not DIBBLA_*: the Dibbla platform reserves that prefix and
 * drops user variables that use it. Nothing logged at info or above contains payloads: those
 * carry end-user data, and a worker's logs are not the place for it.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function parseLevel(value: string | undefined): LogLevel | undefined {
  const v = value?.trim().toLowerCase();
  return v && v in ORDER ? (v as LogLevel) : undefined;
}

let current: LogLevel = parseLevel(process.env.SDK_LOG_LEVEL) ?? 'info';

export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function getLogLevel(): LogLevel {
  return current;
}

const enabled = (level: LogLevel) => ORDER[level] >= ORDER[current];

export const log = {
  debug(message: string): void {
    if (enabled('debug')) console.log(`[dibbla] ${message}`);
  },
  info(message: string): void {
    if (enabled('info')) console.log(`[dibbla] ${message}`);
  },
  warn(message: string): void {
    if (enabled('warn')) console.warn(`[dibbla] ${message}`);
  },
  error(message: string): void {
    if (enabled('error')) console.error(`[dibbla] ${message}`);
  },
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
