import { newLocalId, type JsonFile } from "./lib/jsonFile.ts";

export const QUEUE_STATUSES = ["QUEUED", "RUNNING", "DONE", "HUMAN_REQUIRED", "FAILED", "SKIPPED", "CANCELLED"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

/** Terminal outcome of one processed item, in the application tracker's words. */
export type QueueOutcome = "CONFIRMED" | "SUBMITTED_UNVERIFIED" | "DRY_RUN_VALIDATED" | "NEEDS_ATTENTION" | "SKIPPED" | "FAILED" | "DUPLICATE" | "NOT_ELIGIBLE" | "CANCELLED";

export interface QueueItem {
  id: string;
  jobId: string;
  company: string;
  role: string;
  priority: number;
  status: QueueStatus;
  attemptCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  humanTaskId: string | null;
  outcome: QueueOutcome | null;
  sessionId: string | null;
}

const ACTIVE: QueueStatus[] = ["QUEUED", "RUNNING"];

/**
 * Persistent, strictly sequential application queue. One job at a time; a job can be in the active part of the
 * queue only once (no accidental double application). An item that was RUNNING when the process died is never
 * retried automatically: the application may already have been submitted.
 */
export class AgentQueue {
  private items: QueueItem[];

  constructor(private readonly store: JsonFile<QueueItem[]>) {
    this.items = store.read();
  }

  private save(): void {
    this.store.write(this.items);
  }

  list(): QueueItem[] {
    return [...this.items].sort((a, b) => rank(a) - rank(b) || b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): QueueItem | null {
    return this.items.find((i) => i.id === id) ?? null;
  }

  activeFor(jobId: string): QueueItem | null {
    return this.items.find((i) => i.jobId === jobId && ACTIVE.includes(i.status)) ?? null;
  }

  enqueue(jobs: Array<{ jobId: string; company: string; role: string }>, priority = 0): { added: QueueItem[]; skipped: Array<{ jobId: string; reason: string }> } {
    const added: QueueItem[] = [];
    const skipped: Array<{ jobId: string; reason: string }> = [];
    for (const j of jobs) {
      if (this.activeFor(j.jobId)) {
        skipped.push({ jobId: j.jobId, reason: "already in the queue" });
        continue;
      }
      const item: QueueItem = { id: newLocalId("Q"), jobId: j.jobId, company: j.company, role: j.role, priority, status: "QUEUED", attemptCount: 0, createdAt: new Date().toISOString(), startedAt: null, completedAt: null, failureReason: null, humanTaskId: null, outcome: null, sessionId: null };
      this.items.push(item);
      added.push(item);
    }
    this.save();
    return { added, skipped };
  }

  /** Highest priority first, then oldest. */
  next(): QueueItem | null {
    return this.items.filter((i) => i.status === "QUEUED").sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))[0] ?? null;
  }

  pending(): number {
    return this.items.filter((i) => i.status === "QUEUED").length;
  }

  start(id: string, sessionId: string): QueueItem {
    const item = this.must(id);
    if (item.status !== "QUEUED") throw new Error(`queue item ${id} is ${item.status}, not QUEUED`);
    Object.assign(item, { status: "RUNNING", startedAt: new Date().toISOString(), attemptCount: item.attemptCount + 1, sessionId, completedAt: null, failureReason: null, outcome: null });
    this.save();
    return item;
  }

  finish(id: string, status: Exclude<QueueStatus, "QUEUED" | "RUNNING">, outcome: QueueOutcome, reason: string | null = null): QueueItem {
    const item = this.must(id);
    Object.assign(item, { status, outcome, failureReason: reason, completedAt: new Date().toISOString() });
    this.save();
    return item;
  }

  setHumanTask(id: string, taskId: string | null): void {
    const item = this.get(id);
    if (!item) return;
    item.humanTaskId = taskId;
    this.save();
  }

  /** Skip a waiting item. The running item is skipped through the runtime (it must stop the browser work first). */
  skip(id: string): QueueItem {
    const item = this.must(id);
    if (item.status !== "QUEUED") throw new Error(`only a queued item can be skipped here (it is ${item.status})`);
    return this.finish(id, "SKIPPED", "SKIPPED", "skipped by you");
  }

  /** Puts a finished item back in the queue. Never used automatically. */
  retry(id: string): QueueItem {
    const item = this.must(id);
    if (ACTIVE.includes(item.status)) throw new Error(`item is ${item.status}; nothing to retry`);
    if (this.activeFor(item.jobId)) throw new Error(`${item.jobId} is already queued`);
    Object.assign(item, { status: "QUEUED", completedAt: null, failureReason: null, outcome: null, humanTaskId: null });
    this.save();
    return item;
  }

  cancelAll(): number {
    let n = 0;
    for (const i of this.items) {
      if (i.status === "QUEUED") {
        Object.assign(i, { status: "CANCELLED", outcome: "CANCELLED", completedAt: new Date().toISOString(), failureReason: "queue cancelled by you" });
        n++;
      }
    }
    this.save();
    return n;
  }

  clearFinished(): number {
    const before = this.items.length;
    this.items = this.items.filter((i) => ACTIVE.includes(i.status));
    this.save();
    return before - this.items.length;
  }

  /** After a restart: an item that was RUNNING is marked FAILED for review, never re-run blindly. */
  recoverInterrupted(): number {
    let n = 0;
    for (const i of this.items) {
      if (i.status === "RUNNING") {
        Object.assign(i, { status: "FAILED", outcome: "FAILED", completedAt: new Date().toISOString(), failureReason: "interrupted: ApplyPilot stopped while this application was in progress. Check the job's application status before retrying — it may already have been submitted." });
        n++;
      }
    }
    if (n) this.save();
    return n;
  }

  private must(id: string): QueueItem {
    const item = this.get(id);
    if (!item) throw new Error(`queue item ${id} not found`);
    return item;
  }
}

function rank(i: QueueItem): number {
  return i.status === "RUNNING" ? 0 : i.status === "QUEUED" ? 1 : 2;
}
