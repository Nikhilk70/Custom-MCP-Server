import type { AppConfig } from "../core/config.ts";
import type { JdProvider } from "../core/interfaces.ts";
import type { Logger } from "../core/logger.ts";
import type { JobRequirements, JobStatus, MatchResult } from "../core/schemas.ts";
import { toAgentError } from "../core/errors.ts";
import { withRetry } from "../core/retry.ts";
import type { Store } from "../store/sheetStore.ts";
import { JobRepo, recordError } from "../store/repositories.ts";
import { patchJob, recordTimeline, transition } from "../store/stateMachine.ts";
import type { Profile } from "../profile/profile.ts";
import { jdHashOf } from "../normalization/normalize.ts";
import { analyzeJd } from "./jdAnalyzer.ts";
import { matchJob } from "./matcher.ts";
import { decompileJd, JD_DECOMPILER_VERSION, toStored, type DecompiledJd, type StoredJdIntelligence } from "./jdDecompiler.ts";

export interface MatchDeps {
  cfg: AppConfig;
  store: Store;
  logger: Logger;
  profile: Profile;
  jdProviders: JdProvider[];
  runId: string | null;
}

/** NORMALIZED → JD_FETCHED. Uses JD from the source when present; otherwise a JD provider (Firecrawl). Never invents a JD. */
export async function fetchJds(deps: MatchDeps, limit = 200): Promise<{ fetched: number; alreadyPresent: number; failed: number }> {
  const repo = new JobRepo(deps.store);
  const stats = { fetched: 0, alreadyPresent: 0, failed: 0 };
  for (const job of repo.byStatus(["NORMALIZED"], limit)) {
    await deps.store.maybeFlush();
    if (job.jdText) {
      transition(deps.store, job.jobId, "JD_FETCHED", { runId: deps.runId, reason: `JD provided by ${job.source}` });
      recordTimeline(deps.store, job.jobId, "JD_FETCHED", { runId: deps.runId, detail: { method: `source:${job.source}` } });
      stats.alreadyPresent++;
      continue;
    }
    const provider = deps.jdProviders.find((p) => p.canFetch(job));
    if (!provider) {
      repo.setLastError(job.jobId, "JD not available from source and no JD provider configured");
      stats.failed++;
      continue;
    }
    try {
      const r = await withRetry(() => provider.fetchJd(job));
      repo.setJd(job.jobId, r.jdText, jdHashOf(r.jdText), r.method);
      transition(deps.store, job.jobId, "JD_FETCHED", { runId: deps.runId, reason: `JD fetched via ${r.method}` });
      recordTimeline(deps.store, job.jobId, "JD_FETCHED", { runId: deps.runId, detail: { method: r.method } });
      stats.fetched++;
    } catch (err) {
      const e = toAgentError(err);
      repo.setLastError(job.jobId, `JD fetch failed: ${e.message}`);
      recordError(deps.store, { runId: deps.runId, jobId: job.jobId, module: "matching", code: e.code, message: e.message });
      stats.failed++;
    }
  }
  return stats;
}

function ensureDetails(store: Store, jobId: string): void {
  if (!store.t.details.has(jobId)) store.t.details.insert({ jobId, jdText: null, jdSource: null, requirements: null, requirementsJdHash: null, match: null, matchProfileHash: null, matchedAt: null });
}

export function saveRequirements(store: Store, jobId: string, reqs: JobRequirements, jdHash: string): void {
  ensureDetails(store, jobId);
  store.t.details.update(jobId, { requirements: reqs, requirementsJdHash: jdHash });
}

export function saveMatch(store: Store, jobId: string, match: MatchResult, profileHash: string): void {
  ensureDetails(store, jobId);
  store.t.details.update(jobId, { match, matchProfileHash: profileHash, matchedAt: new Date().toISOString() });
}

export function saveIntelligence(store: Store, jobId: string, d: DecompiledJd): void {
  ensureDetails(store, jobId);
  store.t.details.update(jobId, { intelligence: toStored(d) });
}

/** Stored JD intelligence, or null when absent, from an older decompiler version, or unreadable (truncated cell). */
export function getIntelligence(store: Store, jobId: string): StoredJdIntelligence | null {
  // A cell over the Sheets size limit is stored as a truncation marker; treat it as absent.
  const v: (StoredJdIntelligence & { _truncated?: boolean }) | null | undefined = store.t.details.get(jobId)?.intelligence;
  return v && !v._truncated && v.version === JD_DECOMPILER_VERSION ? v : null;
}

export function getRequirements(store: Store, jobId: string): JobRequirements | null {
  return store.t.details.get(jobId)?.requirements ?? null;
}

export function getLatestMatch(store: Store, jobId: string): MatchResult | null {
  return store.t.details.get(jobId)?.match ?? null;
}

/** Analyze + score one job without changing its status (used by MCP analyze_job). */
export function analyzeAndScore(deps: Pick<MatchDeps, "cfg" | "profile">, job: { jobTitle: string; companyName: string; location: string; workMode: "remote" | "hybrid" | "onsite" | null; jdText: string | null; salary?: string | null }): { requirements: JobRequirements; match: MatchResult; intelligence: DecompiledJd } {
  const requirements = analyzeJd({ jdText: job.jdText ?? "", jobTitle: job.jobTitle, location: job.location, workMode: job.workMode });
  // Same requirements object, so the decompiler's mandatory skills are exactly the ones the gate checks.
  return { requirements, match: matchJob(job, requirements, deps.profile, deps.cfg.matching), intelligence: decompileJd(job, requirements) };
}

/**
 * Decompiles stored JDs that have no (current) intelligence yet — jobs matched before the decompiler existed, or
 * after a decompiler version change. Uses the saved requirements so the mandatory skills match the stored eligibility.
 */
export function decompileStored(store: Store, opts: { force?: boolean; limit?: number } = {}): { decompiled: number; skipped: number; contradictions: number; thin: number } {
  const repo = new JobRepo(store);
  const out = { decompiled: 0, skipped: 0, contradictions: 0, thin: 0 };
  for (const job of repo.all()) {
    if (out.decompiled >= (opts.limit ?? Infinity)) break;
    if (job.status === "DUPLICATE" || !job.jdText || (!opts.force && getIntelligence(store, job.jobId))) {
      out.skipped++;
      continue;
    }
    const d = store.t.details.get(job.jobId);
    const reqs = d?.requirements && d.requirementsJdHash === (job.jdHash ?? "") ? d.requirements : undefined;
    const intel = decompileJd(job, reqs);
    saveIntelligence(store, job.jobId, intel);
    out.decompiled++;
    if (intel.contradictions.length) out.contradictions++;
    if (intel.quality.malformed) out.thin++;
  }
  return out;
}

/** Statuses before any resume work: eligibility moves them forward to READY_FOR_RESUME. */
const PRE_RESUME = new Set<JobStatus>(["JD_FETCHED", "NOT_MATCHED", "MATCHED"]);
/** Statuses --rematch re-evaluates: everything not submitted or in flight. An ineligible job leaves the queue. */
const REMATCHABLE: JobStatus[] = ["JD_FETCHED", "NOT_MATCHED", "MATCHED", "READY_FOR_RESUME", "RESUME_GENERATED", "READY_TO_APPLY", "NEEDS_HUMAN", "BLOCKED", "FAILED"];

export interface MatchOutcome {
  jobId: string;
  score: number;
  eligible: boolean;
  eligibilityReason: MatchResult["eligibilityReason"];
  jobFamily: string;
  reason: string;
}

/**
 * JD_FETCHED → MATCHED → READY_FOR_RESUME when every gate passes, else NOT_MATCHED with the first failing gate
 * as the reason (ROLE_FAMILY_INCOMPATIBLE, EXPERIENCE_INCOMPATIBLE, …). Resume generation and applying only ever
 * see ELIGIBLE jobs.
 */
export async function matchJobs(deps: MatchDeps, opts: { limit?: number; rematch?: boolean } = {}): Promise<{ matched: number; notMatched: number; results: MatchOutcome[] }> {
  const repo = new JobRepo(deps.store);
  const statuses = opts.rematch ? REMATCHABLE : (["JD_FETCHED"] as JobStatus[]);
  const out = { matched: 0, notMatched: 0, results: [] as MatchOutcome[] };
  for (const job of repo.byStatus(statuses, opts.limit ?? 1000)) {
    if (!job.jdText) continue; // FAILED/BLOCKED jobs without a JD stay where they are
    try {
      const { requirements, match, intelligence } = analyzeAndScore(deps, job);
      saveRequirements(deps.store, job.jobId, requirements, job.jdHash ?? "");
      saveIntelligence(deps.store, job.jobId, intelligence);
      saveMatch(deps.store, job.jobId, match, deps.profile.hash);
      repo.setSkills(job.jobId, [...requirements.requiredSkills, ...requirements.preferredSkills]);
      const patch = { matchScore: match.technicalMatchScore, matchReason: match.reason };
      const why = match.eligibilityReason ? `${match.eligibilityReason}: ${[...match.gates.role, ...match.gates.experience, ...match.gates.mandatory, ...match.gates.technical][0] ?? ""}` : "";
      if (!match.eligible) {
        if (job.status !== "NOT_MATCHED") transition(deps.store, job.jobId, "NOT_MATCHED", { runId: deps.runId, reason: why, patch });
        else patchJob(deps.store, job.jobId, patch);
      } else if (PRE_RESUME.has(job.status)) {
        if (job.status !== "MATCHED") transition(deps.store, job.jobId, "MATCHED", { runId: deps.runId, reason: `eligible; technical score ${match.technicalMatchScore}`, patch });
        transition(deps.store, job.jobId, "READY_FOR_RESUME", { runId: deps.runId, reason: "eligible for tailored resume" });
      } else {
        patchJob(deps.store, job.jobId, patch); // already past matching and still eligible: keep its place
      }
      recordTimeline(deps.store, job.jobId, "MATCHED", {
        runId: deps.runId,
        detail: { technicalMatchScore: match.technicalMatchScore, jobFamily: match.role.jobFamily, roleCompatibility: match.roleCompatibility, experienceCompatibility: match.experienceCompatibility, eligibilityStatus: match.eligibilityStatus, eligibilityReason: match.eligibilityReason },
      });
      if (match.eligible) out.matched++;
      else out.notMatched++;
      out.results.push({ jobId: job.jobId, score: match.technicalMatchScore, eligible: match.eligible, eligibilityReason: match.eligibilityReason, jobFamily: match.role.jobFamily, reason: match.reason });
    } catch (err) {
      const e = toAgentError(err);
      recordError(deps.store, { runId: deps.runId, jobId: job.jobId, module: "matching", code: e.code, message: e.message });
      deps.logger.error({ module: "matching", action: "match_job", status: "failure", jobId: job.jobId, errorCode: e.code, message: e.message });
    }
  }
  return out;
}
