import fs from "node:fs";
import path from "node:path";
import { newLocalId } from "./lib/jsonFile.ts";

export const ACTIVITY_CATEGORIES = ["jobs", "applications", "questions", "human", "errors", "system"] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];
export type ActivityLevel = "info" | "success" | "warn" | "error";

/** One line of the live activity stream. Messages are already free of secrets (masked by the caller). */
export interface ActivityEvent {
  id: string;
  at: string;
  type: string;
  category: ActivityCategory;
  level: ActivityLevel;
  message: string;
  jobId: string | null;
  data: Record<string, unknown> | null;
}

/** Everything pushed to the browser over Server-Sent Events. */
export type ServerPush =
  | { kind: "activity"; event: ActivityEvent }
  | { kind: "state"; state: unknown }
  | { kind: "queue" }
  | { kind: "tasks" }
  | { kind: "notification"; notification: unknown }
  | { kind: "jobs" }
  | { kind: "applications" }
  | { kind: "answers" }
  | { kind: "memory" };

type Listener = (p: ServerPush) => void;

/**
 * Activity log + push channel. The last `cap` events stay in memory; every event is also appended to a JSONL file
 * so the stream survives restarts.
 */
export class EventBus {
  private readonly events: ActivityEvent[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly file: string | null,
    private readonly cap = 1000,
  ) {
    if (file && fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(-cap);
      for (const l of lines) {
        try {
          this.events.push(JSON.parse(l) as ActivityEvent);
        } catch {
          /* skip a torn line */
        }
      }
    }
  }

  emit(e: { type: string; category: ActivityCategory; level?: ActivityLevel; message: string; jobId?: string | null; data?: Record<string, unknown> | null }): ActivityEvent {
    const ev: ActivityEvent = { id: newLocalId("EVT"), at: new Date().toISOString(), type: e.type, category: e.category, level: e.level ?? "info", message: e.message, jobId: e.jobId ?? null, data: e.data ?? null };
    this.events.push(ev);
    if (this.events.length > this.cap) this.events.splice(0, this.events.length - this.cap);
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.appendFileSync(this.file, JSON.stringify(ev) + "\n");
      } catch {
        /* the stream must never crash the agent */
      }
    }
    this.push({ kind: "activity", event: ev });
    return ev;
  }

  push(p: ServerPush): void {
    for (const l of this.listeners) {
      try {
        l(p);
      } catch {
        /* a broken client connection is not our problem */
      }
    }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  recent(filter: { category?: ActivityCategory | null; jobId?: string | null; limit?: number } = {}): ActivityEvent[] {
    const out = this.events.filter((e) => (!filter.category || e.category === filter.category) && (!filter.jobId || e.jobId === filter.jobId));
    return out.slice(-(filter.limit ?? 200)).reverse();
  }

  clear(): void {
    this.events.length = 0;
    if (this.file && fs.existsSync(this.file)) fs.rmSync(this.file);
  }
}
