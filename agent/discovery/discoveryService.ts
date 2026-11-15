import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../core/config.ts";
import type { CompanySearchOutcome, CompanySource } from "../core/interfaces.ts";
import type { Logger } from "../core/logger.ts";
import { paths } from "../core/paths.ts";
import type { CompanyProfile, JobSearchQuery, RawJob } from "../core/schemas.ts";
import { sanitizeFilenamePart, todayIso } from "../core/text.ts";
import { errorMessage, toAgentError } from "../core/errors.ts";
import { newId, type Store } from "../store/sheetStore.ts";
import { recordError } from "../store/repositories.ts";
import type { Profile } from "../profile/profile.ts";
import { locationMatches } from "../matching/location.ts";
import { inferWorkMode, normalizeRawJob } from "../normalization/normalize.ts";
import { upsertJob } from "../normalization/dedupe.ts";
import { scanCompanies, syncCompaniesToStore, type ScanIssue } from "./companyScanner.ts";

export interface RelevanceFilter {
  (title: string, location: string): boolean;
}

export function buildQuery(cfg: AppConfig, profile: Profile): JobSearchQuery {
  const roles = cfg.env.JOB_KEYWORDS.length ? cfg.env.JOB_KEYWORDS : profile.preferences.targetRoles;
  const locations = cfg.env.JOB_LOCATIONS.length ? cfg.env.JOB_LOCATIONS : profile.preferences.preferredLocations;
  return { roles, locations, limit: cfg.env.JOB_LIMIT ?? 50, postedWithinDays: cfg.sources.filters.maxJobAgeDays, prefilter: buildRelevanceFilter(cfg, profile, locations) };
}

/** Title must look like a target role, must not contain excluded seniority keywords, and location must fit preferences. */
export function buildRelevanceFilter(cfg: AppConfig, profile: Profile, locations: string[]): RelevanceFilter {
  const include = cfg.sources.filters.titleIncludeKeywords.map((k) => k.toLowerCase());
  const exclude = profile.preferences.excludedJobTitleKeywords.map((k) => k.toLowerCase());
  // "Sr Engineer", "Sr. Engineer" and "Engineer, Sr." are the same exclusion: compare words without trailing dots.
  const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").replace(/\.(?=\s|$)/g, "").trim()} `;
  return (title, location) => {
    const t = words(title);
    if (!include.some((k) => t.includes(` ${k} `) || t.includes(` ${k}`))) return false;
    if (exclude.some((k) => t.includes(words(k)))) return false;
    return locationMatches(location, inferWorkMode(location, null, null), locations, profile.preferences.excludedLocations).matches;
  };
}

function isRecent(postedDate: string | null, maxAgeDays: number, now: Date): boolean {
  if (!postedDate) return true; // unknown age is kept; it is not evidence of staleness
  const t = Date.parse(postedDate);
  return Number.isNaN(t) || now.getTime() - t <= maxAgeDays * 86400000;
}

function persistRaw(source: string, key: string, jobs: RawJob[]): string | null {
  if (jobs.length === 0) return null;
  const dir = path.join(paths.jobs("Raw"), todayIso(), sanitizeFilenamePart(source));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sanitizeFilenamePart(key)}.json`);
  fs.writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), source, count: jobs.length, jobs }, null, 1));
  return path.relative(paths.jobs("Raw"), file);
}

export interface IngestStats {
  relevant: number;
  newJobs: number;
  duplicates: number;
  newJobIds: string[];
}

export function ingestJobs(store: Store, jobs: RawJob[], opts: { runId: string | null; rawPath: string | null }): IngestStats {
  const stats: IngestStats = { relevant: jobs.length, newJobs: 0, duplicates: 0, newJobIds: [] };
  for (const raw of jobs) {
    const r = upsertJob(store, normalizeRawJob(raw), { runId: opts.runId, rawPath: opts.rawPath });
    if (r.outcome === "NEW") {
      stats.newJobs++;
      stats.newJobIds.push(r.jobId);
    } else stats.duplicates++;
  }
  return stats;
}

export interface CompanySearchSummary {
  companyId: string;
  companyName: string;
  source: string;
  status: CompanySearchOutcome["status"];
  jobsFound: number;
  relevant: number;
  newJobs: number;
  duplicates: number;
  error: string | null;
  lastSuccessfulSearch: string | null;
  durationMs: number;
}

export interface DiscoveryDeps {
  cfg: AppConfig;
  store: Store;
  logger: Logger;
  profile: Profile;
  companySource: CompanySource;
  runId: string | null;
  now?: Date;
}

export async function searchCompanies(deps: DiscoveryDeps, filter?: { companyIds?: string[] }): Promise<{ results: CompanySearchSummary[]; issues: ScanIssue[]; scanned: number }> {
  const { cfg, store, logger } = deps;
  const scan = scanCompanies();
  syncCompaniesToStore(store, scan.companies);
  for (const issue of scan.issues) {
    logger.warn({ module: "discovery", action: "scan_company", status: "failure", message: `${issue.file}: ${issue.error}` });
    recordError(store, { runId: deps.runId, module: "discovery", code: "CONFIG_INVALID", message: `${issue.file}: ${issue.error}` });
  }
  let targets = scan.companies.filter((c) => c.enabled);
  if (filter?.companyIds?.length) targets = targets.filter((c) => filter.companyIds?.includes(c.companyId));
  if (!cfg.sources.companyCareers.enabled) {
    logger.info({ module: "discovery", action: "search_companies", status: "skipped", message: "companyCareers disabled in config/sources.json" });
    return { results: [], issues: scan.issues, scanned: scan.companies.length };
  }
  const query = buildQuery(cfg, deps.profile);
  const results: CompanySearchSummary[] = [];
  const queue = [...targets].sort((a, b) => a.priority.localeCompare(b.priority));
  const workers = Array.from({ length: Math.min(cfg.sources.companyCareers.concurrency, queue.length) }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      results.push(await searchOneCompany(deps, c, query));
      await deps.store.maybeFlush();
    }
  });
  await Promise.all(workers);
  return { results, issues: scan.issues, scanned: scan.companies.length };
}

export async function searchOneCompany(deps: DiscoveryDeps, company: CompanyProfile, query: JobSearchQuery): Promise<CompanySearchSummary> {
  const { store, logger, cfg } = deps;
  const started = Date.now();
  const now = deps.now ?? new Date();
  let outcome: CompanySearchOutcome;
  try {
    outcome = await deps.companySource.search(company, query);
  } catch (err) {
    const e = toAgentError(err);
    outcome = { status: "SOURCE_UNAVAILABLE", source: "unknown", jobs: [], jobsFound: 0, error: e.message };
  }
  const prefilter = query.prefilter;
  const relevant = outcome.jobs.filter((j) => (!prefilter || prefilter(j.jobTitle, j.location)) && isRecent(j.postedDate, cfg.sources.filters.maxJobAgeDays, now));
  let stats: IngestStats = { relevant: 0, newJobs: 0, duplicates: 0, newJobIds: [] };
  try {
    const rawPath = persistRaw(outcome.source, company.companyId, relevant);
    stats = ingestJobs(store, relevant, { runId: deps.runId, rawPath });
  } catch (err) {
    outcome = { ...outcome, status: "PARSER_FAILED", error: `ingest failed: ${errorMessage(err)}` };
  }
  const searchedAt = new Date().toISOString();
  const success = outcome.status === "SUCCESS_WITH_JOBS" || outcome.status === "SUCCESS_NO_JOBS";
  store.t.searches.insert({
    id: newId("CS"),
    searchedAt,
    runId: deps.runId,
    companyId: company.companyId,
    source: outcome.source,
    status: outcome.status,
    jobsFound: outcome.jobsFound,
    relevant: stats.relevant,
    newJobs: stats.newJobs,
    duplicates: stats.duplicates,
    error: outcome.error,
    durationMs: Date.now() - started,
  });
  if (success && store.t.companies.has(company.companyId)) store.t.companies.update(company.companyId, { lastSuccessfulSearch: searchedAt });
  else if (!success) recordError(store, { runId: deps.runId, companyId: company.companyId, module: "discovery", code: outcome.status, message: outcome.error ?? outcome.status });
  const last = { last_successful_search: store.t.companies.get(company.companyId)?.lastSuccessfulSearch ?? null };
  const summary: CompanySearchSummary = {
    companyId: company.companyId,
    companyName: company.companyName,
    source: outcome.source,
    status: outcome.status,
    jobsFound: outcome.jobsFound,
    relevant: stats.relevant,
    newJobs: stats.newJobs,
    duplicates: stats.duplicates,
    error: outcome.error,
    lastSuccessfulSearch: last?.last_successful_search ?? null,
    durationMs: Date.now() - started,
  };
  logger.log(success ? "info" : "warn", {
    module: "discovery",
    action: "search_company",
    status: success ? "success" : "failure",
    companyId: company.companyId,
    durationMs: summary.durationMs,
    ...(success ? {} : { errorCode: outcome.status }),
    message: `${company.companyName} via ${outcome.source}: ${outcome.status}, found ${outcome.jobsFound}, relevant ${stats.relevant}, new ${stats.newJobs}, dup ${stats.duplicates}${outcome.error ? ` — ${outcome.error}` : ""}`,
  });
  return summary;
}
