import type { LogEvent, Logger, LogLevel, SecretMasker } from "../agent/core/logger.ts";
import type { ActivityCategory, ActivityLevel, EventBus } from "./events.ts";

const CATEGORY: Record<string, ActivityCategory> = {
  discovery: "jobs",
  matching: "jobs",
  jd: "jobs",
  normalization: "jobs",
  resume: "applications",
  application: "applications",
  questions: "questions",
  store: "system",
  scheduler: "system",
};

/** Actions too chatty for the activity stream (they stay in the JSONL log). */
const QUIET = new Set(["flush", "maybe_flush", "http", "fetch_page"]);

/**
 * Wraps the engine's logger: everything is still written to the JSONL log exactly as before, and info/warn/error
 * events also appear in ApplyPilot's live activity stream (masked for secrets first).
 */
export function teeLogger(base: Logger, bus: EventBus, masker: SecretMasker): Logger {
  const forward = (level: LogLevel, e: LogEvent): void => {
    if (level === "debug" || QUIET.has(e.action)) return;
    const m = masker.maskValue(e) as LogEvent;
    const category: ActivityCategory = level === "error" ? "errors" : m.action === "human_wait" || m.action === "google_signin" || m.status === "blocked" ? "human" : (CATEGORY[m.module] ?? "system");
    const lvl: ActivityLevel = level === "error" ? "error" : level === "warn" ? "warn" : m.status === "success" ? "success" : "info";
    bus.emit({ type: `${m.module}.${m.action}`, category, level: lvl, message: m.message ?? `${m.module} ${m.action} ${m.status}`, jobId: m.jobId ?? null, data: m.companyId ? { companyId: m.companyId } : null });
  };
  const wrap = (inner: Logger): Logger => ({
    log: (level, e) => {
      inner.log(level, e);
      forward(level, e);
    },
    debug: (e) => inner.debug(e),
    info: (e) => {
      inner.info(e);
      forward("info", e);
    },
    warn: (e) => {
      inner.warn(e);
      forward("warn", e);
    },
    error: (e) => {
      inner.error(e);
      forward("error", e);
    },
    child: (b) => wrap(inner.child(b)),
    time: async (e, fn) => {
      const started = Date.now();
      try {
        const r = await inner.time(e, fn);
        forward("info", { ...e, status: "success", durationMs: Date.now() - started });
        return r;
      } catch (err) {
        forward("error", { ...e, status: "failure", message: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
  });
  return wrap(base);
}
