/** Minimal structured (JSON lines) logger. */
export type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function serialize(_k: string, v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Error) return { name: v.name, message: v.message };
  return v;
}

export function createLogger(
  level: Level = 'info',
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (l) => process.stdout.write(l + '\n'),
): Logger {
  const min = ORDER[level] ?? ORDER.info;
  const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...base, ...fields }, serialize));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger(level, { ...base, ...fields }, sink),
  };
}

export const silentLogger: Logger = createLogger('error', {}, () => {});
