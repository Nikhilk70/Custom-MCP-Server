/**
 * Firecrawl REST v1 client (READ / EXTRACT only — Firecrawl never submits applications).
 * No Firecrawl MCP is configured on this machine, so this talks to the documented REST API
 * (https://api.firecrawl.dev/v1/scrape) using FIRECRAWL_API_KEY. Key verified 2026-09-30.
 */
import { z } from "zod";
import { AgentError } from "../../agent/core/errors.ts";
import type { HttpClient } from "../../agent/core/http.ts";
import type { IntegrationStatus, JdFetchResult, JdProvider } from "../../agent/core/interfaces.ts";
import type { RawJob } from "../../agent/core/schemas.ts";
import { canonicalUrl, normalizeText } from "../../agent/core/text.ts";

const ScrapeResponse = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  data: z
    .object({
      markdown: z.string().optional(),
      links: z.array(z.string()).optional(),
      json: z.unknown().optional(),
      metadata: z.object({ statusCode: z.number().optional(), sourceURL: z.string().optional(), url: z.string().optional(), title: z.string().optional() }).passthrough().optional(),
    })
    .optional(),
});

const ExtractedJobs = z.object({
  jobs: z.array(z.object({ title: z.string(), location: z.string().nullable().optional(), url: z.string().nullable().optional() })),
});

export interface ScrapeResult {
  markdown: string;
  links: string[];
  json: unknown;
  statusCode: number | null;
  finalUrl: string | null;
}

export class FirecrawlClient implements JdProvider {
  readonly id = "firecrawl";
  private scrapesUsed = 0;

  constructor(
    private readonly http: HttpClient,
    private readonly opts: { apiKey: string | undefined; baseUrl: string; timeoutMs: number; maxScrapesPerRun: number; enabled: boolean },
  ) {}

  status(): IntegrationStatus {
    if (!this.opts.enabled) return { id: this.id, state: "DISABLED", detail: "disabled in config/sources.json" };
    if (!this.opts.apiKey) return { id: this.id, state: "NOT_CONFIGURED", detail: "FIRECRAWL_API_KEY missing" };
    return { id: this.id, state: "READY", detail: `REST ${this.opts.baseUrl} (not MCP); ${this.scrapesUsed}/${this.opts.maxScrapesPerRun} scrapes used this run` };
  }

  /** Cheap authenticated call (no credits) to prove the key works. */
  async verify(): Promise<{ remainingCredits: number | null }> {
    this.requireReady();
    const res = z
      .object({ success: z.boolean(), data: z.object({ remaining_credits: z.number().optional() }).passthrough().optional() })
      .parse(await this.http.getJson(`${this.opts.baseUrl}/team/credit-usage`, { headers: this.authHeaders(), timeoutMs: 20000 }));
    return { remainingCredits: res.data?.remaining_credits ?? null };
  }

  async scrape(url: string, formats: Array<"markdown" | "links" | "json">, jsonSchema?: Record<string, unknown>, prompt?: string): Promise<ScrapeResult> {
    this.requireReady();
    if (this.scrapesUsed >= this.opts.maxScrapesPerRun) {
      throw new AgentError("RATE_LIMITED", `Firecrawl per-run budget (${this.opts.maxScrapesPerRun}) exhausted`, { retryable: false });
    }
    this.scrapesUsed++;
    const body: Record<string, unknown> = { url, formats, onlyMainContent: true, timeout: this.opts.timeoutMs };
    if (formats.includes("json")) body.jsonOptions = { schema: jsonSchema, prompt };
    const parsed = ScrapeResponse.safeParse(await this.http.postJson(`${this.opts.baseUrl}/scrape`, body, { headers: this.authHeaders(), timeoutMs: this.opts.timeoutMs + 15000 }));
    if (!parsed.success) throw new AgentError("PARSER_FAILED", "Firecrawl: unexpected response shape", { retryable: false });
    if (!parsed.data.success || !parsed.data.data) throw new AgentError("SOURCE_UNAVAILABLE", `Firecrawl scrape failed: ${parsed.data.error ?? "no data"}`);
    const d = parsed.data.data;
    const statusCode = d.metadata?.statusCode ?? null;
    if (statusCode !== null && statusCode >= 400) {
      throw new AgentError(statusCode === 401 || statusCode === 403 ? "AUTH_REQUIRED" : "SOURCE_UNAVAILABLE", `Target page returned HTTP ${statusCode}`);
    }
    return { markdown: d.markdown ?? "", links: d.links ?? [], json: d.json ?? null, statusCode, finalUrl: d.metadata?.url ?? d.metadata?.sourceURL ?? null };
  }

  canFetch(job: { jobUrl: string }): boolean {
    return this.status().state === "READY" && /^https?:\/\//.test(job.jobUrl);
  }

  async fetchJd(job: { jobUrl: string }): Promise<JdFetchResult> {
    const r = await this.scrape(job.jobUrl, ["markdown"]);
    const text = r.markdown.trim();
    if (text.length < 200) throw new AgentError("PARSER_FAILED", `Firecrawl returned too little content (${text.length} chars) for ${job.jobUrl}`, { retryable: false });
    return { jdText: text, method: "firecrawl:markdown" };
  }

  /**
   * Extracts job listings from an arbitrary careers page. The LLM output is untrusted:
   * a job is kept only if its title appears in the scraped page text AND its URL is one of the page's links.
   */
  async extractJobsFromCareersPage(url: string, company: { companyName: string; companyId: string | null }): Promise<{ jobs: RawJob[]; rejected: number; pageChars: number }> {
    const schema = {
      type: "object",
      properties: {
        jobs: { type: "array", items: { type: "object", properties: { title: { type: "string" }, location: { type: "string" }, url: { type: "string" } }, required: ["title"] } },
      },
      required: ["jobs"],
    };
    const r = await this.scrape(url, ["markdown", "links", "json"], schema, "List every job opening shown on this page exactly as written: title, location, and the link to that job's detail page. Return an empty list if none are shown. Do not invent jobs.");
    const extracted = ExtractedJobs.safeParse(r.json);
    if (!extracted.success) throw new AgentError("PARSER_FAILED", "Firecrawl JSON extraction did not match the expected schema", { retryable: false });
    const pageText = normalizeText(r.markdown);
    const links = new Set(r.links.map(canonicalUrl));
    const jobs: RawJob[] = [];
    let rejected = 0;
    for (const j of extracted.data.jobs) {
      const title = j.title.trim();
      const jobUrl = j.url ? absolutize(j.url, r.finalUrl ?? url) : null;
      const titleOnPage = title.length > 2 && pageText.includes(normalizeText(title));
      const urlOnPage = jobUrl !== null && links.has(canonicalUrl(jobUrl));
      if (!titleOnPage || !urlOnPage || !jobUrl) {
        rejected++;
        continue;
      }
      jobs.push({
        source: "careers_page",
        externalJobId: null,
        companyName: company.companyName,
        companyId: company.companyId,
        jobTitle: title,
        location: j.location?.trim() ?? "",
        workMode: null,
        experienceRequired: null,
        salary: null,
        postedDate: null,
        applyUrl: jobUrl,
        jobUrl,
        jdText: null,
        companyDomain: null,
        raw: { extractedFrom: url, item: j },
      });
    }
    return { jobs, rejected, pageChars: r.markdown.length };
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.opts.apiKey ?? ""}` };
  }

  private requireReady(): void {
    const s = this.status();
    if (s.state !== "READY") throw new AgentError("NOT_CONFIGURED", `Firecrawl: ${s.detail}`);
  }
}

function absolutize(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
