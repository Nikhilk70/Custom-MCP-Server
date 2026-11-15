import type { CompanySearchOutcome, CompanySource, IntegrationStatus } from "../../agent/core/interfaces.ts";
import type { CompanyProfile, CompanySearchStatus, JobSearchQuery } from "../../agent/core/schemas.ts";
import { errorMessage, toAgentError, type ErrorCode } from "../../agent/core/errors.ts";
import type { HttpClient } from "../../agent/core/http.ts";
import { withRetry, type Sleep } from "../../agent/core/retry.ts";
import { fetchAtsJobs, STRUCTURED_ATS } from "./ats.ts";
import type { FirecrawlClient } from "../firecrawl/FirecrawlClient.ts";

function statusForError(code: ErrorCode): CompanySearchStatus {
  switch (code) {
    case "AUTH_REQUIRED":
    case "LOGIN_REQUIRED":
      return "AUTH_REQUIRED";
    case "PARSER_FAILED":
      return "PARSER_FAILED";
    case "NETWORK_ERROR":
    case "TIMEOUT":
    case "RATE_LIMITED":
      return "NETWORK_ERROR";
    case "UNSUPPORTED":
      return "UNSUPPORTED";
    case "NOT_CONFIGURED":
      return "NOT_CONFIGURED";
    default:
      return "SOURCE_UNAVAILABLE";
  }
}

/**
 * Searches a company's official career source:
 *  - structured ATS API when the company uses Greenhouse/Lever/Ashby/SmartRecruiters (verified listing = trustworthy "0 jobs")
 *  - otherwise the careersUrl via Firecrawl extraction, keeping only jobs evidenced on the page
 * A zero-job result is SUCCESS_NO_JOBS only when a structured API answered.
 */
export class CompanyCareerAdapter implements CompanySource {
  readonly id = "company-careers";

  constructor(
    private readonly deps: {
      http: HttpClient;
      firecrawl: FirecrawlClient | null;
      timeoutMs: number;
      maxJobsPerCompany: number;
      useFirecrawlForUnknownCareerPages: boolean;
      sleep?: Sleep;
    },
  ) {}

  status(): IntegrationStatus {
    return { id: this.id, state: "READY", detail: `structured ATS: ${STRUCTURED_ATS.join(", ")}; careers pages via Firecrawl: ${this.deps.firecrawl?.status().state ?? "NOT_CONFIGURED"}` };
  }

  async search(company: CompanyProfile, query: JobSearchQuery): Promise<CompanySearchOutcome> {
    const ref = { companyName: company.companyName, companyId: company.companyId };
    const ats = company.ats;

    if (ats && STRUCTURED_ATS.includes(ats.type)) {
      const source = ats.type;
      if (!ats.boardToken) return { status: "NOT_CONFIGURED", source, jobs: [], jobsFound: 0, error: `ats.type=${ats.type} but no boardToken and none could be derived from careersUrl` };
      try {
        const r = await withRetry(
          () =>
            fetchAtsJobs(ats.type, ats.boardToken ?? "", ref, {
              http: this.deps.http,
              timeoutMs: this.deps.timeoutMs,
              maxJobs: this.deps.maxJobsPerCompany,
              ...(ats.country ? { country: ats.country } : {}),
              ...(query.prefilter ? { prefilter: query.prefilter } : {}),
            }),
          this.deps.sleep ? { sleep: this.deps.sleep } : {},
        );
        return { status: r.jobsFound > 0 ? "SUCCESS_WITH_JOBS" : "SUCCESS_NO_JOBS", source, jobs: r.jobs.slice(0, this.deps.maxJobsPerCompany), jobsFound: r.jobsFound, error: null };
      } catch (err) {
        const e = toAgentError(err);
        return { status: statusForError(e.code), source, jobs: [], jobsFound: 0, error: e.message };
      }
    }

    if (ats && !STRUCTURED_ATS.includes(ats.type) && !company.careersUrl) {
      return { status: "UNSUPPORTED", source: ats.type, jobs: [], jobsFound: 0, error: `no listing adapter for ATS '${ats.type}' and no careersUrl` };
    }

    if (!company.careersUrl) {
      return { status: "NOT_CONFIGURED", source: "none", jobs: [], jobsFound: 0, error: "company has neither a supported ats nor a careersUrl" };
    }

    const fc = this.deps.firecrawl;
    if (!this.deps.useFirecrawlForUnknownCareerPages || !fc || fc.status().state !== "READY") {
      return { status: "NOT_CONFIGURED", source: "careers_page", jobs: [], jobsFound: 0, error: `careers page needs Firecrawl (${fc?.status().detail ?? "not configured"})` };
    }
    try {
      const r = await fc.extractJobsFromCareersPage(company.careersUrl, ref);
      if (r.jobs.length === 0) {
        // Page loaded, but an empty unstructured extraction is not proof of "no jobs".
        return { status: "PARSER_FAILED", source: "careers_page", jobs: [], jobsFound: 0, error: `page accessed (${r.pageChars} chars) but no job listing could be verified on it (${r.rejected} unverifiable candidates rejected)` };
      }
      return { status: "SUCCESS_WITH_JOBS", source: "careers_page", jobs: r.jobs, jobsFound: r.jobs.length, error: r.rejected ? `${r.rejected} unverifiable candidates rejected` : null };
    } catch (err) {
      const e = toAgentError(err);
      return { status: statusForError(e.code), source: "careers_page", jobs: [], jobsFound: 0, error: errorMessage(e) };
    }
  }
}
