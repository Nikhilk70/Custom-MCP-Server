import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogEvent {
  module: string;
  action: string;
  status: "start" | "success" | "failure" | "skipped" | "info" | "blocked";
  message?: string;
  runId?: string;
  jobId?: string;
  companyId?: string;
  durationMs?: number;
  errorCode?: string;
  data?: Record<string, unknown>;
}

export interface Logger {
  log(level: LogLevel, event: LogEvent): void;
  debug(event: LogEvent): void;
  info(event: LogEvent): void;
  warn(event: LogEvent): void;
  error(event: LogEvent): void;
  child(bindings: Partial<LogEvent>): Logger;
  /** Measure an async action and log success/failure with durationMs. Re-throws on failure. */
  time<T>(event: Omit<LogEvent, "status">, fn: () => Promise<T>): Promise<T>;
}

const SECRET_KEY_PATTERN = /(pass(word)?|secret|token|api[_-]?key|session|cookie|li_at|authorization|credential)/i;

/** Replaces known secret values and secret-looking keys. Applied to every log line. */
export class SecretMasker {
  private readonly secrets: string[];
  constructor(secrets: string[]) {
    this.secrets = [...new Set(secrets.filter((s) => s.length >= 6))].sort((a, b) => b.length - a.length);
  }
  maskString(s: string): string {
    let out = s;
    for (const secret of this.secrets) out = out.split(secret).join("***");
    return out;
  }
  maskValue(value: unknown, depth = 0): unknown {
    if (depth > 8) return "[depth]";
    if (typeof value === "string") return this.maskString(value);
    if (Array.isArray(value)) return value.map((v) => this.maskValue(v, depth + 1));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = SECRET_KEY_PATTERN.test(k) && typeof v === "string" && v ? "***" : this.maskValue(v, depth + 1);
      }
      return out;
    }
    return value;
  }
}

export interface LoggerOptions {
  level?: LogLevel;
  dir?: string;
  console?: boolean;
  /** Write to stderr instead of stdout (required inside an MCP stdio server). */
  stderr?: boolean;
  masker?: SecretMasker;
}

class JsonlLogger implements Logger {
  constructor(
    private readonly opts: Required<Omit<LoggerOptions, "dir">> & { dir: string | undefined },
    private readonly bindings: Partial<LogEvent> = {},
  ) {}

  log(level: LogLevel, event: LogEvent): void {
    if (LEVELS[level] < LEVELS[this.opts.level]) return;
    const record = this.opts.masker.maskValue({ timestamp: new Date().toISOString(), level, ...this.bindings, ...event }) as Record<string, unknown>;
    const line = JSON.stringify(record);
    if (this.opts.dir) {
      try {
        fs.mkdirSync(this.opts.dir, { recursive: true });
        fs.appendFileSync(path.join(this.opts.dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), line + "\n");
      } catch {
        // Logging must never crash the run; fall through to console.
      }
    }
    if (this.opts.console) {
      const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v));
      const human = `[${level.toUpperCase()}] ${str(record.module)}.${str(record.action)} ${str(record.status)}${record.jobId ? ` job=${str(record.jobId)}` : ""}${record.message ? ` — ${str(record.message)}` : ""}${record.durationMs !== undefined ? ` (${str(record.durationMs)}ms)` : ""}`;
      (this.opts.stderr || level === "error" ? process.stderr : process.stdout).write(human + "\n");
    }
  }
  debug(e: LogEvent) { this.log("debug", e); }
  info(e: LogEvent) { this.log("info", e); }
  warn(e: LogEvent) { this.log("warn", e); }
  error(e: LogEvent) { this.log("error", e); }
  child(bindings: Partial<LogEvent>): Logger {
    return new JsonlLogger(this.opts, { ...this.bindings, ...bindings });
  }
  async time<T>(event: Omit<LogEvent, "status">, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      this.info({ ...event, status: "success", durationMs: Date.now() - started });
      return result;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      this.error({
        ...event,
        status: "failure",
        durationMs: Date.now() - started,
        errorCode: typeof code === "string" ? code : "INTERNAL",
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  return new JsonlLogger({
    level: opts.level ?? "info",
    dir: opts.dir ?? paths.logs(),
    console: opts.console ?? true,
    stderr: opts.stderr ?? false,
    masker: opts.masker ?? new SecretMasker([]),
  });
}

/** Logger that records events in memory; used by tests. */
export function createMemoryLogger(): Logger & { events: Array<LogEvent & { level: LogLevel }> } {
  const events: Array<LogEvent & { level: LogLevel }> = [];
  const make = (bindings: Partial<LogEvent>): Logger & { events: typeof events } => {
    const logger: Logger & { events: typeof events } = {
      events,
      log: (level, e) => { events.push({ level, ...bindings, ...e }); },
      debug: (e) => logger.log("debug", e),
      info: (e) => logger.log("info", e),
      warn: (e) => logger.log("warn", e),
      error: (e) => logger.log("error", e),
      child: (b) => make({ ...bindings, ...b }),
      time: async (e, fn) => {
        const t = Date.now();
        try {
          const r = await fn();
          logger.info({ ...e, status: "success", durationMs: Date.now() - t });
          return r;
        } catch (err) {
          logger.error({ ...e, status: "failure", durationMs: Date.now() - t, message: String(err) });
          throw err;
        }
      },
    };
    return logger;
  };
  return make({});
}
