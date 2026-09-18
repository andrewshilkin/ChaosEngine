export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  child(scope: string): Logger;
}

export function createLogger(scope = 'chaos', level: LogLevel = 'info'): Logger {
  const min = ORDER[level];
  const emit = (lvl: LogLevel, msg: string, args: unknown[]) => {
    if (ORDER[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    if (lvl === 'error') console.error(line, ...args);
    else if (lvl === 'warn') console.warn(line, ...args);
    else console.log(line, ...args);
  };
  return {
    debug: (m, ...a) => emit('debug', m, a),
    info: (m, ...a) => emit('info', m, a),
    warn: (m, ...a) => emit('warn', m, a),
    error: (m, ...a) => emit('error', m, a),
    child: (s) => createLogger(`${scope}:${s}`, level),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silentLogger,
};
