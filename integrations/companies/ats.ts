/**
 * Public ATS job-board APIs. Each endpoint was verified live on 2026-09-30:
 *   Greenhouse       GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
 *   Lever            GET https://api.lever.co/v0/postings/{company}?mode=json
 *   Ashby            GET https://api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true
 *   SmartRecruiters  GET https://api.smartrecruiters.com/v1/companies/{company}/postings[/{id}]
 * These are read-only listing APIs. They cannot submit applications.
 */
import { z } from "zod";
import type { AtsType, RawJob, WorkMode } from "../../agent/core/schemas.ts";
import { AgentError } from "../../agent/core/errors.ts";
import { htmlToText } from "../../agent/core/text.ts";
import type { HttpClient } from "../../agent/core/http.ts";

export const STRUCTURED_ATS: readonly AtsType[] = ["greenhouse", "lever", "ashby", "smartrecruiters"];

export function detectAtsFromUrl(url: string): { type: AtsType; boardToken: string | null } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const first = u.pathname.split("/").filter(Boolean)[0] ?? null;
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const q = u.searchParams.get("for");
    return { type: "greenhouse", boardToken: host.startsWith("boards-api") ? (u.pathname.split("/")[3] ?? null) : (q ?? (first === "embed" ? null : first)) };
  }
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") return { type: "lever", boardToken: first };
  if (host === "jobs.ashbyhq.com") return { type: "ashby", boardToken: first };
  if (host === "careers.smartrecruiters.com" || host === "jobs.smartrecruiters.com") return { type: "smartrecruiters", boardToken: first };
  if (host.endsWith("myworkdayjobs.com") || host.endsWith("myworkdaysite.com")) return { type: "workday", boardToken: null };
  if (host.includes("successfactors")) return { type: "successfactors", boardToken: null };
  if (host.endsWith("icims.com")) return { type: "icims", boardToken: null };
  return null;
}

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new AgentError("PARSER_FAILED", `${what}: unexpected response shape (${r.error.issues[0]?.path.join(".")}: ${r.error.issues[0]?.message})`, { retryable: false });
  return r.data;
}

// ---------- Greenhouse ----------
const GreenhouseSchema = z.object({
  jobs: z.array(
    z.object({
      id: z.number(),
      title: z.string(),
      absolute_url: z.string(),
      location: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
      updated_at: z.string().nullable().optional(),
      first_published: z.string().nullable().optional(),
      content: z.string().nullable().optional(),
      company_name: z.string().nullable().optional(),
    }),
  ),
});

export function parseGreenhouse(data: unknown, company: { companyName: string; companyId: string | null }): RawJob[] {
  const parsed = parseOrThrow(GreenhouseSchema, data, "greenhouse");
  return parsed.jobs.map((j) => ({
    source: "greenhouse",
    externalJobId: String(j.id),
    companyName: company.companyName,
    companyId: company.companyId,
    jobTitle: j.title,
    location: j.location?.name ?? "",
    workMode: null,
    experienceRequired: null,
    salary: null,
    postedDate: (j.first_published ?? j.updated_at ?? null)?.slice(0, 10) ?? null,
    applyUrl: j.absolute_url,
    jobUrl: j.absolute_url,
    jdText: j.content ? htmlToText(j.content) : null,
    companyDomain: safeHost(j.absolute_url),
    raw: j,
  }));
}

// ---------- Lever ----------
const LeverSchema = z.array(
  z.object({
    id: z.string(),
    text: z.string(),
    hostedUrl: z.string(),
    applyUrl: z.string().optional(),
    createdAt: z.number().optional(),
    workplaceType: z.string().optional(),
    categories: z.object({ location: z.string().optional(), commitment: z.string().optional(), allLocations: z.array(z.string()).optional() }).optional(),
    descriptionPlain: z.string().optional(),
    lists: z.array(z.object({ text: z.string(), content: z.string() })).optional(),
    additionalPlain: z.string().optional(),
    salaryRange: z.object({ min: z.number(), max: z.number(), currency: z.string(), interval: z.string() }).optional(),
  }),
);

function leverWorkMode(w: string | undefined): WorkMode | null {
  if (w === "remote") return "remote";
  if (w === "hybrid") return "hybrid";
  if (w === "onsite" || w === "on-site") return "onsite";
  return null;
}

export function parseLever(data: unknown, company: { companyName: string; companyId: string | null }): RawJob[] {
  return parseOrThrow(LeverSchema, data, "lever").map((j) => {
    const lists = (j.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join("\n\n");
    const jd = [j.descriptionPlain ?? "", lists, j.additionalPlain ?? ""].filter((s) => s.trim()).join("\n\n");
    const locations = j.categories?.allLocations?.length ? j.categories.allLocations.join("; ") : (j.categories?.location ?? "");
    return {
      source: "lever",
      externalJobId: j.id,
      companyName: company.companyName,
      companyId: company.companyId,
      jobTitle: j.text,
      location: locations,
      workMode: leverWorkMode(j.workplaceType),
      experienceRequired: null,
      salary: j.salaryRange ? `${j.salaryRange.currency} ${j.salaryRange.min}–${j.salaryRange.max} / ${j.salaryRange.interval}` : null,
      postedDate: j.createdAt ? new Date(j.createdAt).toISOString().slice(0, 10) : null,
      applyUrl: j.applyUrl ?? j.hostedUrl,
      jobUrl: j.hostedUrl,
      jdText: jd || null,
      companyDomain: null,
      raw: { ...j, lists: undefined },
    };
  });
}

// ---------- Ashby ----------
const AshbySchema = z.object({
  jobs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      location: z.string().nullable().optional(),
      secondaryLocations: z.array(z.object({ location: z.string() })).optional(),
      isRemote: z.boolean().nullable().optional(),
      workplaceType: z.string().nullable().optional(),
      publishedAt: z.string().nullable().optional(),
      jobUrl: z.string(),
      applyUrl: z.string().optional(),
      descriptionPlain: z.string().nullable().optional(),
      isListed: z.boolean().optional(),
      compensation: z.object({ compensationTierSummary: z.string().nullable().optional() }).nullable().optional(),
    }),
  ),
});

function ashbyWorkMode(w: string | null | undefined, isRemote: boolean | null | undefined): WorkMode | null {
  const s = (w ?? "").toLowerCase();
  if (s === "remote") return "remote";
  if (s === "hybrid") return "hybrid";
  if (s === "onsite" || s === "on-site") return "onsite";
  return isRemote ? "remote" : null;
}

export function parseAshby(data: unknown, company: { companyName: string; companyId: string | null }): RawJob[] {
  return parseOrThrow(AshbySchema, data, "ashby")
    .jobs.filter((j) => j.isListed !== false)
    .map((j) => ({
      source: "ashby",
      externalJobId: j.id,
      companyName: company.companyName,
      companyId: company.companyId,
      jobTitle: j.title,
      location: [j.location ?? "", ...(j.secondaryLocations ?? []).map((s) => s.location)].filter(Boolean).join("; "),
      workMode: ashbyWorkMode(j.workplaceType, j.isRemote),
      experienceRequired: null,
      salary: j.compensation?.compensationTierSummary ?? null,
      postedDate: j.publishedAt?.slice(0, 10) ?? null,
      applyUrl: j.applyUrl ?? j.jobUrl,
      jobUrl: j.jobUrl,
      jdText: j.descriptionPlain ?? null,
      companyDomain: null,
      raw: { ...j, descriptionPlain: undefined },
    }));
}

// ---------- SmartRecruiters ----------
const SrListSchema = z.object({
  totalFound: z.number(),
  content: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      releasedDate: z.string().nullable().optional(),
      location: z.object({ fullLocation: z.string().optional(), city: z.string().optional(), country: z.string().optional(), remote: z.boolean().optional(), hybrid: z.boolean().optional() }).optional(),
    }),
  ),
});
const SrDetailSchema = z.object({
  id: z.string(),
  postingUrl: z.string(),
  applyUrl: z.string().optional(),
  jobAd: z.object({ sections: z.record(z.string(), z.object({ title: z.string().optional(), text: z.string().optional() })) }).optional(),
  experienceLevel: z.object({ label: z.string() }).nullable().optional(),
});

export function smartRecruitersJd(detail: unknown): { jdText: string; postingUrl: string; applyUrl: string; experience: string | null } {
  const d = parseOrThrow(SrDetailSchema, detail, "smartrecruiters detail");
  const sections = Object.values(d.jobAd?.sections ?? {})
    .map((s) => `${s.title ?? ""}\n${htmlToText(s.text ?? "")}`.trim())
    .filter(Boolean);
  return { jdText: sections.join("\n\n"), postingUrl: d.postingUrl, applyUrl: d.applyUrl ?? d.postingUrl, experience: d.experienceLevel?.label ?? null };
}

// ---------- Fetchers ----------
export interface AtsFetchOptions {
  http: HttpClient;
  timeoutMs: number;
  maxJobs: number;
  /** Server-side country filter (SmartRecruiters only); other ATS APIs return every posting. */
  country?: string;
  prefilter?: (title: string, location: string) => boolean;
}

export async function fetchAtsJobs(
  type: AtsType,
  token: string,
  company: { companyName: string; companyId: string | null },
  opts: AtsFetchOptions,
): Promise<{ jobs: RawJob[]; jobsFound: number }> {
  const t = encodeURIComponent(token);
  switch (type) {
    case "greenhouse": {
      const jobs = parseGreenhouse(await opts.http.getJson(`https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`, { timeoutMs: opts.timeoutMs }), company);
      return { jobs, jobsFound: jobs.length };
    }
    case "lever": {
      const jobs = parseLever(await opts.http.getJson(`https://api.lever.co/v0/postings/${t}?mode=json`, { timeoutMs: opts.timeoutMs }), company);
      return { jobs, jobsFound: jobs.length };
    }
    case "ashby": {
      const jobs = parseAshby(await opts.http.getJson(`https://api.ashbyhq.com/posting-api/job-board/${t}?includeCompensation=true`, { timeoutMs: opts.timeoutMs }), company);
      return { jobs, jobsFound: jobs.length };
    }
    case "smartrecruiters": {
      const listed: z.infer<typeof SrListSchema>["content"] = [];
      let total = 0;
      for (let offset = 0; offset < opts.maxJobs; offset += 100) {
        const page = parseOrThrow(SrListSchema, await opts.http.getJson(`https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=100&offset=${offset}${opts.country ? `&country=${encodeURIComponent(opts.country)}` : ""}`, { timeoutMs: opts.timeoutMs }), "smartrecruiters");
        total = page.totalFound;
        listed.push(...page.content);
        if (page.content.length < 100 || listed.length >= total) break;
      }
      const jobs: RawJob[] = [];
      for (const j of listed) {
        const location = j.location?.fullLocation ?? [j.location?.city, j.location?.country].filter(Boolean).join(", ");
        if (opts.prefilter && !opts.prefilter(j.name, location)) continue;
        const detail = smartRecruitersJd(await opts.http.getJson(`https://api.smartrecruiters.com/v1/companies/${t}/postings/${encodeURIComponent(j.id)}`, { timeoutMs: opts.timeoutMs }));
        jobs.push({
          source: "smartrecruiters",
          externalJobId: j.id,
          companyName: company.companyName,
          companyId: company.companyId,
          jobTitle: j.name,
          location,
          workMode: j.location?.remote ? "remote" : j.location?.hybrid ? "hybrid" : null,
          experienceRequired: detail.experience,
          salary: null,
          postedDate: j.releasedDate?.slice(0, 10) ?? null,
          applyUrl: detail.applyUrl,
          jobUrl: detail.postingUrl,
          jdText: detail.jdText || null,
          companyDomain: null,
          raw: j,
        });
      }
      return { jobs, jobsFound: total };
    }
    default:
      throw new AgentError("UNSUPPORTED", `ATS '${type}' has no structured listing adapter`);
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
