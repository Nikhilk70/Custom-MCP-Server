import { canonicalUrl, normalizeCompany, normalizeLocation, normalizeTitle } from "../core/text.ts";
import type { Store } from "../store/sheetStore.ts";
import { recordTimeline, transition } from "../store/stateMachine.ts";
import { identityKeyOf, type NormalizedJob } from "./normalize.ts";

export type UpsertOutcome = "NEW" | "SEEN_AGAIN" | "DUPLICATE_CROSS_SOURCE";

export interface UpsertResult {
  jobId: string;
  outcome: UpsertOutcome;
  matchedBy: "external_id" | "apply_url" | "identity" | "jd_hash" | "adopted_sheet_row" | null;
}

export function formatJobId(n: number): string {
  return `JOB-${String(n).padStart(6, "0")}`;
}

export function sourceKeyOf(source: string, externalJobId: string | null, urlCanonical: string): string {
  return externalJobId ? `${source}|ext:${externalJobId}` : `${source}|url:${urlCanonical}`;
}

function jobSourcesOf(store: Store, jobId: string): Set<string> {
  return new Set(store.t.sources.filter((s) => s.jobId === jobId).map((s) => s.source));
}

/**
 * Finds the existing job this record refers to, using (in order):
 *  1. same source + external job id
 *  2. canonical apply/job URL seen from any source
 *  3. company + title + location fingerprint, but only across *different* sources
 *     (one source listing two reqs with the same title/location are two jobs)
 *  4. company + JD content hash, across different sources
 */
export function findExisting(store: Store, job: NormalizedJob): { jobId: string; matchedBy: NonNullable<UpsertResult["matchedBy"]> } | null {
  if (job.externalJobId) {
    const s = store.t.sources.get(sourceKeyOf(job.source, job.externalJobId, ""));
    if (s) return { jobId: s.jobId, matchedBy: "external_id" };
  }
  const urls = new Set([job.applyUrlCanonical, job.jobUrlCanonical]);
  const byUrl =
    store.t.jobs.find((j) => urls.has(canonicalUrl(j.applyUrl)) || (!!j.jobUrl && urls.has(canonicalUrl(j.jobUrl)))) ??
    store.t.sources.find((s) => urls.has(s.urlCanonical));
  if (byUrl) return { jobId: byUrl.jobId, matchedBy: "apply_url" };

  const byIdentity = store.t.jobs.find(
    (j) => identityKeyOf(normalizeCompany(j.companyName), normalizeTitle(j.jobTitle), normalizeLocation(j.location)) === job.identityKey && !jobSourcesOf(store, j.jobId).has(job.source),
  );
  if (byIdentity) return { jobId: byIdentity.jobId, matchedBy: "identity" };

  if (job.jdHash) {
    const byJd = store.t.jobs.find((j) => j.jdHash === job.jdHash && normalizeCompany(j.companyName) === job.companyNorm && !jobSourcesOf(store, j.jobId).has(job.source));
    if (byJd) return { jobId: byJd.jobId, matchedBy: "jd_hash" };
  }
  return null;
}

function addSource(store: Store, jobId: string, job: NormalizedJob, rawPath: string | null, now: string): boolean {
  const key = sourceKeyOf(job.source, job.externalJobId, job.applyUrlCanonical);
  const existing = store.t.sources.get(key);
  if (existing) {
    store.t.sources.update(key, { lastSeenAt: now, seenCount: existing.seenCount + 1 });
    return false;
  }
  store.t.sources.insert({ sourceKey: key, jobId, source: job.source, externalJobId: job.externalJobId, url: job.applyUrl || job.jobUrl, urlCanonical: job.applyUrlCanonical, rawPath, firstSeenAt: now, lastSeenAt: now, seenCount: 1 });
  const label = [...jobSourcesOf(store, jobId)].join(" + ");
  store.t.jobs.update(jobId, { sourcesLabel: label });
  return true;
}

function maxJobNumber(store: Store): number {
  let max = 0;
  for (const j of store.t.jobs.all()) {
    const n = Number(/^JOB-(\d+)$/.exec(j.jobId)?.[1] ?? 0);
    if (n > max) max = n;
  }
  return max;
}

/** Idempotent insert-or-merge. Never creates a second job row for the same posting. */
export function upsertJob(store: Store, job: NormalizedJob, opts: { runId?: string | null; rawPath?: string | null } = {}): UpsertResult {
  const now = new Date().toISOString();
  const existing = findExisting(store, job);
  if (existing) {
    const added = addSource(store, existing.jobId, job, opts.rawPath ?? null, now);
    // Fill a missing JD from a richer source; never overwrite an existing JD silently.
    if (job.jdText && !store.t.details.get(existing.jobId)?.jdText) {
      const d = store.t.details;
      if (d.has(existing.jobId)) d.update(existing.jobId, { jdText: job.jdText, jdSource: `source:${job.source}` });
      else d.insert({ jobId: existing.jobId, jdText: job.jdText, jdSource: `source:${job.source}`, requirements: null, requirementsJdHash: null, match: null, matchProfileHash: null, matchedAt: null });
      store.t.jobs.update(existing.jobId, { jdHash: job.jdHash, updatedAt: now });
    }
    return { jobId: existing.jobId, outcome: added ? "DUPLICATE_CROSS_SOURCE" : "SEEN_AGAIN", matchedBy: existing.matchedBy };
  }

  const jobId = formatJobId(store.nextSequence("job", maxJobNumber(store)));
  // Link to the company directory only when that company is actually registered there.
  const companyId = job.companyId && store.t.companies.has(job.companyId) ? job.companyId : null;
  const row = {
    jobId,
    source: job.source,
    sourcesLabel: job.source,
    externalJobId: job.externalJobId,
    companyId,
    companyName: job.companyName,
    jobTitle: job.jobTitle,
    location: job.location,
    workMode: job.workMode,
    experienceRequired: job.experienceRequired,
    salary: job.salary,
    skills: [],
    postedDate: job.postedDate,
    applyUrl: job.applyUrl || job.jobUrl,
    jobUrl: job.jobUrl || job.applyUrl,
    jdHash: job.jdHash,
    companyDomain: job.companyDomain,
    matchScore: null,
    matchReason: null,
    resumeVersionId: null,
    status: "DISCOVERED" as const,
    applicationAttempts: 0,
    requiresHuman: false,
    blockReason: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    resumeFile: "",
    lastAttemptAt: null,
    appliedDate: null,
  };
  // A row the user typed into the dashboard with the same Apply Link (and no Job ID) is claimed, not duplicated.
  const adoptRow = findOrphanByLink(store, job);
  if (adoptRow !== null) store.t.jobs.adopt(adoptRow, row);
  else store.t.jobs.insert(row);
  store.t.sources.insert({ sourceKey: sourceKeyOf(job.source, job.externalJobId, job.applyUrlCanonical), jobId, source: job.source, externalJobId: job.externalJobId, url: job.applyUrl || job.jobUrl, urlCanonical: job.applyUrlCanonical, rawPath: opts.rawPath ?? null, firstSeenAt: now, lastSeenAt: now, seenCount: 1 });
  if (job.jdText) store.t.details.insert({ jobId, jdText: job.jdText, jdSource: `source:${job.source}`, requirements: null, requirementsJdHash: null, match: null, matchProfileHash: null, matchedAt: null });
  store.t.timeline.insert({ id: `EV-${jobId}-0`, at: now, jobId, runId: opts.runId ?? null, kind: "STATUS", fromStatus: null, toStatus: "DISCOVERED", timelineEvent: null, reason: `discovered via ${job.source}`, detail: null });
  recordTimeline(store, jobId, "DISCOVERED", { runId: opts.runId ?? null, detail: { source: job.source } });
  transition(store, jobId, "NORMALIZED", { runId: opts.runId ?? null, reason: "canonical identity computed" });
  return { jobId, outcome: "NEW", matchedBy: adoptRow !== null ? "adopted_sheet_row" : null };
}

function findOrphanByLink(store: Store, job: NormalizedJob): number | null {
  for (const o of store.t.jobs.orphans) {
    const link = store.t.jobs.cell(o.cells, "Apply Link").trim();
    if (link && (canonicalUrl(link) === job.applyUrlCanonical || canonicalUrl(link) === job.jobUrlCanonical)) return o.row;
  }
  return null;
}
