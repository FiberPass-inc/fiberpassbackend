import { env } from '../config/env.js';

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type LogLevel = keyof typeof levels;

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: env.NODE_ENV === 'production' ? undefined : value.stack };
  }
  return value;
}

function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (levels[level] < levels[env.LOG_LEVEL]) return;
  const payload = {
    level,
    event,
    service: 'fiberpass-api',
    at: new Date().toISOString(),
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, serialize(value)]))
  };
  const line = JSON.stringify(payload);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => log('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => log('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => log('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => log('error', event, fields)
};
