import type { JobStatus, TimelineEvent } from "../core/schemas.ts";
import { AgentError } from "../core/errors.ts";
import { newId, type JobRow, type Store } from "./sheetStore.ts";

/**
 * Allowed job status transitions. Anything not listed is rejected, so a bug
 * cannot, e.g., jump a job from DISCOVERED straight to APPLIED.
 * FAILED/BLOCKED/NEEDS_HUMAN/SKIPPED can be re-queued explicitly.
 * → APPLIED from queue/blocked states exists only for `mark-applied` (user-confirmed manual submission with evidence).
 */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  DISCOVERED: ["NORMALIZED", "DUPLICATE", "FAILED", "SKIPPED"],
  NORMALIZED: ["JD_FETCHED", "DUPLICATE", "FAILED", "SKIPPED", "NOT_MATCHED"],
  DUPLICATE: [],
  JD_FETCHED: ["MATCHED", "NOT_MATCHED", "FAILED", "SKIPPED", "JD_FETCHED"],
  MATCHED: ["READY_FOR_RESUME", "NOT_MATCHED", "SKIPPED", "JD_FETCHED", "FAILED"],
  NOT_MATCHED: ["JD_FETCHED", "MATCHED", "SKIPPED", "FAILED"],
  READY_FOR_RESUME: ["RESUME_GENERATING", "SKIPPED", "JD_FETCHED", "APPLIED", "NOT_MATCHED"],
  RESUME_GENERATING: ["RESUME_GENERATED", "READY_FOR_RESUME", "FAILED", "BLOCKED"],
  RESUME_GENERATED: ["READY_TO_APPLY", "READY_FOR_RESUME", "SKIPPED", "NOT_MATCHED"],
  READY_TO_APPLY: ["APPLYING", "SKIPPED", "READY_FOR_RESUME", "APPLIED", "NOT_MATCHED"],
  APPLYING: ["FORM_DETECTED", "NEEDS_HUMAN", "FAILED", "BLOCKED", "READY_TO_APPLY"],
  FORM_DETECTED: ["FORM_FILLED", "NEEDS_HUMAN", "VALIDATION_FAILED", "FAILED", "BLOCKED", "READY_TO_APPLY"],
  FORM_FILLED: ["SUBMITTING", "NEEDS_HUMAN", "VALIDATION_FAILED", "FAILED", "READY_TO_APPLY"],
  VALIDATION_FAILED: ["NEEDS_HUMAN", "READY_TO_APPLY", "FAILED"],
  NEEDS_HUMAN: ["READY_TO_APPLY", "APPLIED", "SKIPPED", "FAILED", "READY_FOR_RESUME", "NOT_MATCHED"],
  SUBMITTING: ["APPLIED", "SUBMISSION_UNVERIFIED", "FAILED", "NEEDS_HUMAN"],
  APPLIED: [],
  SUBMISSION_UNVERIFIED: ["APPLIED", "NEEDS_HUMAN", "FAILED"],
  FAILED: ["READY_TO_APPLY", "READY_FOR_RESUME", "JD_FETCHED", "NORMALIZED", "SKIPPED", "APPLIED", "NOT_MATCHED"],
  BLOCKED: ["READY_TO_APPLY", "READY_FOR_RESUME", "SKIPPED", "APPLIED", "NOT_MATCHED"],
  SKIPPED: ["NORMALIZED", "JD_FETCHED"],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export type JobPatch = Partial<Pick<JobRow, "requiresHuman" | "blockReason" | "lastError" | "matchScore" | "matchReason" | "resumeVersionId" | "applicationAttempts" | "resumeFile" | "lastAttemptAt" | "appliedDate">>;

export interface TransitionOptions {
  runId?: string | null;
  reason?: string;
  detail?: Record<string, unknown>;
  patch?: JobPatch;
}

/** Changes a job's status and appends a STATUS event to the Timeline tab. Throws INVALID_TRANSITION. */
export function transition(store: Store, jobId: string, to: JobStatus, opts: TransitionOptions = {}): JobStatus {
  const job = store.t.jobs.get(jobId);
  if (!job) throw new AgentError("NOT_FOUND", `job ${jobId} not found`);
  const from = job.status;
  if (from !== to && !canTransition(from, to)) throw new AgentError("INVALID_TRANSITION", `${jobId}: ${from} -> ${to} is not allowed`);
  const now = new Date().toISOString();
  store.t.jobs.update(jobId, { ...opts.patch, status: to, updatedAt: now });
  store.t.timeline.insert({ id: newId("EV"), at: now, jobId, runId: opts.runId ?? null, kind: "STATUS", fromStatus: from, toStatus: to, timelineEvent: null, reason: opts.reason ?? null, detail: opts.detail ?? null });
  return from;
}

/** Updates job fields without a status change. */
export function patchJob(store: Store, jobId: string, patch: JobPatch): void {
  store.t.jobs.update(jobId, { ...patch, updatedAt: new Date().toISOString() });
}

export function recordTimeline(store: Store, jobId: string, event: TimelineEvent, opts: { runId?: string | null; detail?: Record<string, unknown> } = {}): void {
  store.t.timeline.insert({ id: newId("EV"), at: new Date().toISOString(), jobId, runId: opts.runId ?? null, kind: "TIMELINE", fromStatus: null, toStatus: null, timelineEvent: event, reason: null, detail: opts.detail ?? null });
}

export interface TimelineEntry {
  at: string;
  kind: "STATUS" | "TIMELINE";
  event: string;
  from: string | null;
  reason: string | null;
  detail: unknown;
}

/** Events in the order they were recorded (sheet order = append order). */
export function getTimeline(store: Store, jobId: string): TimelineEntry[] {
  return store.t.timeline
    .filter((e) => e.jobId === jobId)
    .map((e) => ({ at: e.at, kind: e.kind, event: (e.kind === "STATUS" ? e.toStatus : e.timelineEvent) ?? "", from: e.fromStatus, reason: e.reason, detail: e.detail }));
}
