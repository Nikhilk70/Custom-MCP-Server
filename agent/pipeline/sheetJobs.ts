import type { AppConfig } from "../core/config.ts";
import type { CompanySource, JdProvider } from "../core/interfaces.ts";
import type { Logger } from "../core/logger.ts";
import type { JobStatus } from "../core/schemas.ts";
import { errorMessage, toAgentError } from "../core/errors.ts";
import { withRetry } from "../core/retry.ts";
import type { Profile } from "../profile/profile.ts";
import type { Store } from "../store/sheetStore.ts";
import { JobRepo, recordError } from "../store/repositories.ts";
import { patchJob, recordTimeline, transition } from "../store/stateMachine.ts";
import { jdHashOf, normalizeRawJob } from "../normalization/normalize.ts";
import { upsertJob } from "../normalization/dedupe.ts";
import { analyzeAndScore, saveIntelligence, saveMatch, saveRequirements } from "../matching/matchService.ts";
import { buildRelevanceFilter, ingestJobs, searchCompanies } from "../discovery/discoveryService.ts";
import type { LinkedInMcpSource, LinkedInSearch } from "../../integrations/linkedin/LinkedInMcpSource.ts";
import { professionalMonths } from "../profile/profile.ts";

/**
 * The whole job pipeline of the simplified app:
 *   a row you type into the Jobs tab (Company, Job Title, Apply Link)
 *   → a job with a Job ID (importSheetRows)
 *   → its JD read from the Apply Link and analysed (readyJob)
 *   → READY_FOR_RESUME: a tailored resume, then the application (server/runtime.ts).
 * There is no eligibility gate: every job you add is tailored for and applied to. The match score is kept as
 * information only (it decides which of your skills the tailored resume puts first).
 *
 * Find jobs (findJobs) searches the career boards in Companies/ for roles that fit your resume, reads each JD, scores
 * it and adds it to the sheet as MATCHED (good fit) or NOT_MATCHED (shown with the reason). You choose which to apply to.
 */

/**
 * Your profile as the search and the scoring see it: the target roles come from your resume (MY_DATA professional
 * roles) and JOB_KEYWORDS in .env, so the roles you are scored against are always your own.
 */
export function searchProfile(cfg: AppConfig, profile: Profile): Profile {
  const roles = [...new Set([...profile.professional.targetRoles, ...cfg.env.JOB_KEYWORDS].map((r) => r.trim()).filter(Boolean))];
  return roles.length ? { ...profile, preferences: { ...profile.preferences, targetRoles: roles } } : profile;
}

/** Bump when scoring changes, so Find jobs re-scores what it found earlier. v2: "React.js" counts as React. */
const SCORER_VERSION = "v2";
const scoreKey = (p: Profile) => `${p.hash}:${SCORER_VERSION}`;

export interface SheetDeps {
  cfg: AppConfig;
  store: Store;
  profile: Profile;
  jdProvider: JdProvider;
  runId: string | null;
}

export interface ImportResult {
  imported: Array<{ jobId: string; company: string; title: string; row: number }>;
  alreadyKnown: Array<{ jobId: string; row: number }>;
  skipped: Array<{ row: number; reason: string }>;
}

/** Company name from the link when the row has none (boards.greenhouse.io/acme → "Acme", careers.acme.com → "Acme"). */
export function companyFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const ats = /(?:greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com|recruitee\.com|bamboohr\.com)$/i.test(u.hostname);
    const token = ats ? u.pathname.split("/").filter(Boolean).find((p) => !/^(jobs?|embed|job_app|o|v\d)$/i.test(p)) : u.hostname.replace(/^(www|careers?|jobs?|apply)\./i, "").split(".")[0];
    const name = (token ?? u.hostname).replace(/[-_]+/g, " ").trim();
    return name.replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return "Unknown company";
  }
}

/** Turns every row you typed into the Jobs tab (no Job ID yet, but an Apply Link) into a job. */
export function importSheetRows(store: Store, runId: string | null): ImportResult {
  const out: ImportResult = { imported: [], alreadyKnown: [], skipped: [] };
  const jobs = store.t.jobs;
  for (const o of [...jobs.orphans]) {
    const cell = (c: string) => jobs.cell(o.cells, c).trim();
    const link = cell("Apply Link") || cell("Job URL");
    if (!/^https?:\/\//i.test(link)) {
      out.skipped.push({ row: o.row, reason: link ? `Apply Link is not a web address: ${link.slice(0, 60)}` : "no Apply Link" });
      continue;
    }
    const companyName = cell("Company") || companyFromUrl(link);
    const jobTitle = cell("Job Title") || "Job posting";
    const workMode = cell("Work Mode").toLowerCase();
    const job = normalizeRawJob({
      source: cell("Source") || "sheet",
      externalJobId: null,
      companyName,
      companyId: null,
      jobTitle,
      location: cell("Location"),
      workMode: workMode === "remote" || workMode === "hybrid" || workMode === "onsite" ? workMode : null,
      experienceRequired: cell("Experience Req") || null,
      salary: cell("Salary") || null,
      postedDate: cell("Posted Date") || null,
      applyUrl: link,
      jobUrl: link,
      jdText: null,
      companyDomain: null,
      raw: { sheetRow: o.row },
    });
    const r = upsertJob(store, job, { runId });
    if (r.outcome === "NEW") out.imported.push({ jobId: r.jobId, company: companyName, title: jobTitle, row: o.row });
    else out.alreadyKnown.push({ jobId: r.jobId, row: o.row });
  }
  return out;
}

/** Statuses a job passes through before its resume: readyJob moves any of them to READY_FOR_RESUME. */
export const PRE_RESUME: JobStatus[] = ["DISCOVERED", "NORMALIZED", "JD_FETCHED", "MATCHED", "NOT_MATCHED", "SKIPPED"];

/**
 * Reads the JD from the Apply Link (when the job has none), analyses it against your profile, and moves the job to
 * READY_FOR_RESUME. Returns the job's status afterwards; a JD that cannot be read leaves the job FAILED with the reason.
 */
export async function readyJob(deps: SheetDeps, jobId: string, opts: { stopAtScore?: boolean } = {}): Promise<JobStatus> {
  const repo = new JobRepo(deps.store);
  let job = repo.get(jobId);
  if (!job) throw toAgentError(new Error(`job ${jobId} not found`));
  if (!PRE_RESUME.includes(job.status)) return job.status;
  const step = (to: JobStatus, reason: string) => {
    if (repo.get(jobId)?.status !== to) transition(deps.store, jobId, to, { runId: deps.runId, reason });
  };
  if (job.status === "DISCOVERED") step("NORMALIZED", "imported from the sheet");
  if (job.status === "SKIPPED") step("JD_FETCHED", "picked again");

  if (!job.jdText) {
    const target = { source: job.source, jobUrl: job.applyUrl || job.jobUrl, externalJobId: job.externalJobId, companyId: job.companyId };
    try {
      const r = await withRetry(() => deps.jdProvider.fetchJd(target));
      repo.setJd(jobId, r.jdText, jdHashOf(r.jdText), r.method);
      recordTimeline(deps.store, jobId, "JD_FETCHED", { runId: deps.runId, detail: { method: r.method } });
    } catch (err) {
      const e = toAgentError(err);
      const msg = `Could not read the job description from the Apply Link: ${e.message}`;
      recordError(deps.store, { runId: deps.runId, jobId, module: "jd", code: e.code, message: e.message });
      if (repo.get(jobId)?.status !== "FAILED") transition(deps.store, jobId, "FAILED", { runId: deps.runId, reason: msg, patch: { lastError: msg } });
      return "FAILED";
    }
  }
  if (repo.get(jobId)?.status === "NORMALIZED") step("JD_FETCHED", "job description read");
  job = repo.get(jobId)!;

  try {
    const { requirements, match, intelligence } = analyzeAndScore(deps, job);
    saveRequirements(deps.store, jobId, requirements, job.jdHash ?? "");
    saveIntelligence(deps.store, jobId, intelligence);
    saveMatch(deps.store, jobId, match, scoreKey(deps.profile));
    repo.setSkills(jobId, [...requirements.requiredSkills, ...requirements.preferredSkills]);
    const patch = { matchScore: match.technicalMatchScore, matchReason: match.reason };
    if (opts.stopAtScore) {
      // Found by the job search: scored and shown to you; nothing is tailored or applied until you choose it.
      const to: JobStatus = match.eligible ? "MATCHED" : "NOT_MATCHED";
      if (repo.get(jobId)?.status === to) patchJob(deps.store, jobId, patch);
      else transition(deps.store, jobId, to, { runId: deps.runId, reason: match.eligible ? `good fit: ${match.technicalMatchScore}% skills match` : `${match.eligibilityReason ?? "low fit"}: ${match.reason}`, patch });
      return to;
    }
    step("MATCHED", `JD analysed; skills match ${match.technicalMatchScore}%`);
    transition(deps.store, jobId, "READY_FOR_RESUME", { runId: deps.runId, reason: "ready for a tailored resume", patch });
    return "READY_FOR_RESUME";
  } catch (err) {
    const msg = `Could not analyse the job description: ${errorMessage(err)}`;
    transition(deps.store, jobId, "FAILED", { runId: deps.runId, reason: msg, patch: { lastError: msg } });
    return "FAILED";
  }
}

/** Sync from the sheet: import new rows, then read the JD of every job not yet past that stage. */
export async function syncSheet(deps: SheetDeps, onProgress?: (msg: string) => void): Promise<ImportResult & { ready: string[]; failed: Array<{ jobId: string; reason: string }> }> {
  const imported = importSheetRows(deps.store, deps.runId);
  const ready: string[] = [];
  const failed: Array<{ jobId: string; reason: string }> = [];
  const repo = new JobRepo(deps.store);
  const todo = repo.all().filter((j) => ["DISCOVERED", "NORMALIZED", "JD_FETCHED", "MATCHED"].includes(j.status));
  for (const [i, j] of todo.entries()) {
    onProgress?.(`Reading job description ${i + 1} of ${todo.length}: ${j.companyName} — ${j.jobTitle}`);
    const s = await readyJob(deps, j.jobId);
    if (s === "READY_FOR_RESUME") ready.push(j.jobId);
    else failed.push({ jobId: j.jobId, reason: repo.get(j.jobId)?.lastError ?? s });
    await deps.store.maybeFlush();
  }
  return { ...imported, ready, failed };
}

export interface FindDeps extends SheetDeps {
  logger: Logger;
  companySource: CompanySource;
  linkedin?: LinkedInMcpSource;
}

/** One LinkedIn search per (experience level × your target role × location), capped at maxSearches. */
export function linkedInSearches(cfg: AppConfig, profile: Profile): LinkedInSearch[] {
  const li = cfg.sources.linkedin;
  const uniq = (xs: string[]) => [...new Map(xs.map((x) => [x.trim().toLowerCase(), x.trim()])).values()].filter(Boolean);
  const roles = uniq(profile.preferences.targetRoles);
  const locations = uniq(li.locations.length ? li.locations : cfg.env.JOB_LOCATIONS.length ? cfg.env.JOB_LOCATIONS : ["India"]);
  // Levels above your experience are never searched (about two years or less: entry level and associate).
  const years = professionalMonths(profile).months / 12;
  const levels = li.experienceLevels.filter((l) => years >= 5 || !["senior", "director", "executive"].includes(l));
  const out: LinkedInSearch[] = [];
  for (const experienceLevel of levels.length ? levels : ["entry level" as const])
    for (const keyword of roles) for (const location of locations) out.push({ keyword, location, experienceLevel, dateSincePosted: li.dateSincePosted, limit: li.resultsPerSearch });
  return out.slice(0, li.maxSearches);
}

export interface FindResult {
  linkedInSearches: number;
  linkedInErrors: string[];
  companiesSearched: number;
  companiesFailed: Array<{ company: string; error: string }>;
  jobsFound: number;
  newJobs: number;
  goodFit: string[];
  lowFit: string[];
  jdFailed: Array<{ jobId: string; reason: string }>;
}

/**
 * Find jobs: searches the career boards of the companies in Companies/ for titles that fit your target roles and
 * locations (senior/lead titles above your experience are left out), adds the new ones to the sheet, reads each JD
 * and scores it against your resume. Nothing is applied to.
 */
export async function findJobs(deps: FindDeps, onProgress?: (msg: string) => void): Promise<FindResult> {
  const profile = searchProfile(deps.cfg, deps.profile);
  // LinkedIn (through the MCP server): your roles × levels that fit your experience, filtered like every other source.
  let li = { searches: 0, errors: [] as string[], found: 0, newJobs: 0 };
  if (deps.cfg.sources.linkedin.enabled && deps.linkedin) {
    const searches = linkedInSearches(deps.cfg, profile);
    const r = await deps.linkedin.search(searches, (s, i) => onProgress?.(`LinkedIn search ${i + 1} of ${searches.length}: "${s.keyword}" in ${s.location} (${s.experienceLevel})`));
    const keep = buildRelevanceFilter(deps.cfg, profile, [...deps.cfg.sources.linkedin.locations, ...deps.cfg.env.JOB_LOCATIONS, "India"]);
    const relevant = r.jobs.filter((j) => keep(j.jobTitle, j.location));
    const stats = ingestJobs(deps.store, relevant, { runId: deps.runId, rawPath: null });
    li = { searches: r.searches, errors: r.errors, found: relevant.length, newJobs: stats.newJobs };
    await deps.store.maybeFlush();
  }
  if (deps.cfg.sources.companyCareers.enabled) onProgress?.("Searching company career boards for jobs that fit your resume…");
  const search = deps.cfg.sources.companyCareers.enabled
    ? await searchCompanies({ cfg: deps.cfg, store: deps.store, logger: deps.logger, profile, companySource: deps.companySource, runId: deps.runId })
    : { results: [] as Awaited<ReturnType<typeof searchCompanies>>["results"] };
  await deps.store.maybeFlush();
  const repo = new JobRepo(deps.store);
  // New jobs, plus earlier finds whose score was computed from older resume data (re-scored so every score is current).
  const stale = (id: string) => deps.store.t.details.get(id)?.matchProfileHash !== scoreKey(profile);
  const todo = repo.all().filter((j) => j.status === "NORMALIZED" || j.status === "DISCOVERED" || ((j.status === "MATCHED" || j.status === "NOT_MATCHED") && stale(j.jobId)));
  const out: FindResult = {
    linkedInSearches: li.searches,
    linkedInErrors: li.errors,
    companiesSearched: search.results.length,
    companiesFailed: search.results.filter((r) => r.error).map((r) => ({ company: r.companyName, error: r.error ?? "" })),
    jobsFound: li.found + search.results.reduce((a, r) => a + r.relevant, 0),
    newJobs: li.newJobs + search.results.reduce((a, r) => a + r.newJobs, 0),
    goodFit: [],
    lowFit: [],
    jdFailed: [],
  };
  for (const [i, j] of todo.entries()) {
    onProgress?.(`Scoring job ${i + 1} of ${todo.length}: ${j.companyName} — ${j.jobTitle}`);
    const s = await readyJob({ ...deps, profile }, j.jobId, { stopAtScore: true });
    if (s === "MATCHED") out.goodFit.push(j.jobId);
    else if (s === "NOT_MATCHED") out.lowFit.push(j.jobId);
    else out.jdFailed.push({ jobId: j.jobId, reason: repo.get(j.jobId)?.lastError ?? s });
    await deps.store.maybeFlush();
  }
  return out;
}
