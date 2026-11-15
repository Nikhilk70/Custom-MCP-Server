import type { JobRecord, JobStatus } from "../core/schemas.ts";
import { normalizeCompany, normalizeLocation, normalizeTitle } from "../core/text.ts";
import { identityKeyOf } from "../normalization/normalize.ts";
import { newId, type JobRow, type Store } from "./sheetStore.ts";

export function toJobRecord(store: Store, r: JobRow): JobRecord {
  const { sourcesLabel: _s, resumeFile: _f, lastAttemptAt: _l, appliedDate: _a, ...rest } = r;
  return {
    ...rest,
    jdText: store.t.details.get(r.jobId)?.jdText ?? null,
    identityKey: identityKeyOf(normalizeCompany(r.companyName), normalizeTitle(r.jobTitle), normalizeLocation(r.location)),
  };
}

export class JobRepo {
  constructor(private readonly store: Store) {}

  get(jobId: string): JobRecord | null {
    const r = this.store.t.jobs.get(jobId);
    return r ? toJobRecord(this.store, r) : null;
  }

  /** Best match first, then oldest first. */
  byStatus(statuses: JobStatus[], limit = 1000): JobRecord[] {
    return this.store.t.jobs
      .filter((j) => statuses.includes(j.status))
      .sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1) || a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map((r) => toJobRecord(this.store, r));
  }

  all(limit = 100_000): JobRecord[] {
    return this.store.t.jobs
      .all()
      .sort((a, b) => a.jobId.localeCompare(b.jobId))
      .slice(0, limit)
      .map((r) => toJobRecord(this.store, r));
  }

  sources(jobId: string): Array<{ source: string; externalJobId: string | null; url: string; firstSeenAt: string; lastSeenAt: string; seenCount: number }> {
    return this.store.t.sources
      .filter((s) => s.jobId === jobId)
      .map((s) => ({ source: s.source, externalJobId: s.externalJobId, url: s.url, firstSeenAt: s.firstSeenAt, lastSeenAt: s.lastSeenAt, seenCount: s.seenCount }));
  }

  setJd(jobId: string, jdText: string, jdHash: string | null, jdSource: string): void {
    const d = this.store.t.details;
    if (d.has(jobId)) d.update(jobId, { jdText, jdSource });
    else d.insert({ jobId, jdText, jdSource, requirements: null, requirementsJdHash: null, match: null, matchProfileHash: null, matchedAt: null });
    this.store.t.jobs.update(jobId, { jdHash, updatedAt: new Date().toISOString() });
  }

  setSkills(jobId: string, skills: string[]): void {
    this.store.t.jobs.update(jobId, { skills, updatedAt: new Date().toISOString() });
  }

  setLastError(jobId: string, message: string | null): void {
    this.store.t.jobs.update(jobId, { lastError: message, updatedAt: new Date().toISOString() });
  }
}

export function recordError(store: Store, e: { runId?: string | null; jobId?: string | null; companyId?: string | null; module: string; code: string; message: string; detail?: unknown }): void {
  store.t.errors.insert({ id: newId("ERR"), at: new Date().toISOString(), runId: e.runId ?? null, jobId: e.jobId ?? null, companyId: e.companyId ?? null, module: e.module, code: e.code, message: e.message.slice(0, 2000), detail: e.detail ?? null });
}
