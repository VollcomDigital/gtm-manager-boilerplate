export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface CreateLoggerOptions {
  /**
   * Minimum level to emit.
   */
  level?: LogLevel;

  /**
   * Output format.
   */
  format?: "pretty" | "json";
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function shouldLog(min: LogLevel, lvl: LogLevel): boolean {
  return LEVEL_ORDER[lvl] >= LEVEL_ORDER[min];
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "\"<unstringifiable>\"";
  }
}

/**
 * Creates a minimal logger implementation suitable for CLI + CI usage.
 *
 * Defaults:
 * - level: "info"
 * - format: "pretty"
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const format = options.format ?? "pretty";

  const emit = (lvl: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (!shouldLog(level, lvl)) return;

    const payload = fields ?? {};
    if (format === "json") {
      const line = {
        ts: new Date().toISOString(),
        level: lvl,
        msg: message,
        ...payload
      };
      const out = JSON.stringify(line);
      if (lvl === "warn" || lvl === "error") {
        console.error(out);
      } else {
        console.log(out);
      }
      return;
    }

    const suffix = Object.keys(payload).length ? ` ${safeStringify(payload)}` : "";
    const out = `[${lvl}] ${message}${suffix}`;
    if (lvl === "warn" || lvl === "error") {
      console.error(out);
    } else {
      console.log(out);
    }
  };

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f)
  };
}

