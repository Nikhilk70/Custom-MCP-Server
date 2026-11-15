import type { QuestionAnswer } from "../agent/application/humanBridge.ts";
import { newLocalId, type JsonFile } from "./lib/jsonFile.ts";

export const HUMAN_TASK_TYPES = [
  "CAPTCHA",
  "NEW_QUESTION",
  "REVIEW_SUBMIT",
  "LOGIN",
  "VERIFICATION_CODE",
  "SECURITY_CHECK",
  "CONSENT",
  "EMAIL_VERIFICATION",
  "PHONE_VERIFICATION",
  "UNKNOWN_FORM",
  "OTHER",
] as const;
export type HumanTaskType = (typeof HUMAN_TASK_TYPES)[number];
export type HumanTaskStatus = "PENDING" | "RESOLVED" | "SKIPPED" | "EXPIRED";

/** A decision or action only the user can take. Every task says why it exists, what to do, and what happens next. */
export interface HumanTask {
  id: string;
  type: HumanTaskType;
  title: string;
  why: string;
  whatToDo: string;
  whatNext: string;
  jobId: string | null;
  applicationId: string | null;
  company: string | null;
  role: string | null;
  /** True while the agent is actively waiting on this task (the application is paused on it). */
  blocking: boolean;
  status: HumanTaskStatus;
  createdAt: string;
  resolvedAt: string | null;
  /** Type-specific data: pending questions, review summary, page URL. */
  payload: Record<string, unknown>;
  /** What the user decided. */
  answer: unknown;
}

export type TaskAction = "continue" | "skip" | "approve" | "reject" | "answer" | "dismiss";
export interface TaskResolution {
  action: TaskAction;
  answers?: QuestionAnswer[];
}

/**
 * Pending human tasks. Blocking tasks have waiters: the application engine awaits the user's action.
 * A signal ("continue" on a CAPTCHA) may arrive several times before the task is closed.
 */
export class HumanTaskCenter {
  private tasks: HumanTask[];
  private readonly waiters = new Map<string, Array<(r: TaskResolution) => void>>();

  constructor(
    private readonly store: JsonFile<HumanTask[]>,
    private readonly onChange: () => void = () => undefined,
  ) {
    this.tasks = store.read();
    // Waiters don't survive a restart: a task that was blocking an application can no longer be answered.
    let changed = false;
    for (const t of this.tasks) {
      if (t.status === "PENDING" && t.blocking) {
        Object.assign(t, { status: "EXPIRED", blocking: false, resolvedAt: new Date().toISOString(), answer: "ApplyPilot restarted while the agent was waiting" });
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private save(): void {
    this.store.write(this.tasks.slice(0, 500));
    this.onChange();
  }

  create(t: Omit<HumanTask, "id" | "status" | "createdAt" | "resolvedAt" | "answer" | "payload"> & { payload?: Record<string, unknown> }): HumanTask {
    const task: HumanTask = { ...t, payload: t.payload ?? {}, id: newLocalId("TASK"), status: "PENDING", createdAt: new Date().toISOString(), resolvedAt: null, answer: null };
    this.tasks.unshift(task);
    this.save();
    return task;
  }

  get(id: string): HumanTask | null {
    return this.tasks.find((t) => t.id === id) ?? null;
  }

  list(filter: { status?: HumanTaskStatus | "ALL" } = {}): HumanTask[] {
    const s = filter.status ?? "PENDING";
    return this.tasks.filter((t) => s === "ALL" || t.status === s);
  }

  pendingCount(): number {
    return this.tasks.filter((t) => t.status === "PENDING").length;
  }

  /** Resolves when the user acts on the task (each call waits for the next action). */
  next(id: string): Promise<TaskResolution> {
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
    });
  }

  /** The user acted. Wakes the agent if it is waiting; returns false when nobody was waiting on it. */
  signal(id: string, r: TaskResolution): boolean {
    const task = this.get(id);
    if (!task) throw new Error(`task ${id} not found`);
    if (task.status !== "PENDING") throw new Error(`task ${id} is already ${task.status}`);
    const list = this.waiters.get(id) ?? [];
    this.waiters.delete(id);
    for (const w of list) w(r);
    return list.length > 0;
  }

  close(id: string, status: Exclude<HumanTaskStatus, "PENDING">, answer: unknown = null): void {
    const task = this.get(id);
    if (!task || task.status !== "PENDING") return;
    Object.assign(task, { status, answer, blocking: false, resolvedAt: new Date().toISOString() });
    this.save();
  }

  /** STOP ALL / skip: every waiter is released with a negative answer so nothing hangs. */
  releaseAll(reason: string, filter: (t: HumanTask) => boolean = () => true): void {
    for (const t of this.tasks.filter((x) => x.status === "PENDING" && x.blocking && filter(x))) {
      const list = this.waiters.get(t.id) ?? [];
      this.waiters.delete(t.id);
      const negative: TaskResolution = { action: t.type === "REVIEW_SUBMIT" ? "reject" : "skip" };
      for (const w of list) w(negative);
      Object.assign(t, { status: "SKIPPED", blocking: false, resolvedAt: new Date().toISOString(), answer: reason });
    }
    this.save();
  }

  clear(): void {
    this.tasks = this.tasks.filter((t) => t.status === "PENDING" && t.blocking);
    this.save();
  }
}
