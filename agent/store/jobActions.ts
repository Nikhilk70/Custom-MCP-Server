import { AgentError } from "../core/errors.ts";
import type { JobStatus } from "../core/schemas.ts";
import { JobRepo } from "./repositories.ts";
import type { Store } from "./sheetStore.ts";
import { recordTimeline, transition } from "./stateMachine.ts";

/**
 * Puts a stopped job back in line after the user fixed the cause: NEEDS_HUMAN/FAILED/BLOCKED/VALIDATION_FAILED with a
 * resume → READY_TO_APPLY, otherwise → READY_FOR_RESUME. READY_TO_APPLY is left alone.
 * Shared by the CLI (`npm run requeue`) and the ApplyPilot web app.
 */
export function requeueJob(store: Store, jobId: string, reason = "requeued by user"): { jobId: string; from: JobStatus; to: JobStatus; note?: string } {
  const job = new JobRepo(store).get(jobId);
  if (!job) throw new AgentError("NOT_FOUND", `job ${jobId} not found`);
  if (job.status === "READY_TO_APPLY") return { jobId, from: job.status, to: job.status, note: "already queued" };
  const to: JobStatus =
    job.resumeVersionId && ["NEEDS_HUMAN", "FAILED", "BLOCKED", "VALIDATION_FAILED"].includes(job.status) && job.blockReason !== "RESUME_COMPILER_NOT_CONFIGURED" ? "READY_TO_APPLY" : "READY_FOR_RESUME";
  transition(store, jobId, to, { reason, patch: { requiresHuman: false, blockReason: null } });
  return { jobId, from: job.status, to };
}

/** Records a submission the user made themselves, with their evidence (confirmation email subject, reference number). */
export function markApplied(store: Store, jobId: string, evidence: string): { jobId: string; status: "APPLIED"; evidence: string } {
  const text = evidence.trim();
  if (text.length < 10) throw new AgentError("VALIDATION_FAILED", "evidence is required (e.g. confirmation email subject or confirmation number)");
  const job = new JobRepo(store).get(jobId);
  if (!job) throw new AgentError("NOT_FOUND", `job ${jobId} not found`);
  const now = new Date().toISOString();
  transition(store, jobId, "APPLIED", { reason: "user confirmed manual submission", detail: { evidence: text }, patch: { requiresHuman: false, blockReason: null, appliedDate: now.slice(0, 10) } });
  recordTimeline(store, jobId, "SUBMISSION_VERIFIED", { detail: { by: "user", evidence: text } });
  const app = { status: "APPLIED", verifiedAt: now, evidence: { verdict: "VERIFIED_BY_USER", evidence: text } };
  if (store.t.applications.has(jobId)) store.t.applications.update(jobId, { ...app, submittedAt: store.t.applications.get(jobId)?.submittedAt ?? now });
  else
    store.t.applications.insert({ jobId, applicationId: `APP-${jobId}`, resumeVersionId: job.resumeVersionId, mode: "MANUAL", attempts: 0, url: job.applyUrl, startedAt: null, lastAttemptAt: null, submittedAt: now, blockReason: null, screenshotPath: null, form: null, ...app });
  return { jobId, status: "APPLIED", evidence: text };
}
