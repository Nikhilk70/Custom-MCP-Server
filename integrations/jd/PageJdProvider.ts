import type { IntegrationStatus, JdFetchResult, JdProvider } from "../../agent/core/interfaces.ts";
import { AgentError, errorMessage } from "../../agent/core/errors.ts";

const MIN_JD_CHARS = 200;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const decodeEntities = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

/** HTML → readable text with line breaks at block boundaries and "- " for list items. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/ul|\/ol|\/section|\/tr)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n\n- /g, "\n- ")
    .trim();
}

/** The schema.org JobPosting most career sites embed for search engines. */
export function jobPostingFromHtml(html: string): { title: string | null; company: string | null; description: string } | null {
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]!.trim());
    } catch {
      continue;
    }
    const nodes: unknown[] = Array.isArray(data) ? data : [data, ...((data as { "@graph"?: unknown[] })["@graph"] ?? [])];
    for (const n of nodes) {
      const o = n as { "@type"?: string | string[]; description?: string; title?: string; hiringOrganization?: { name?: string } };
      const types = Array.isArray(o?.["@type"]) ? o["@type"] : [o?.["@type"]];
      if (!types.includes("JobPosting") || typeof o.description !== "string") continue;
      const description = htmlToText(decodeEntities(o.description));
      if (description.length >= MIN_JD_CHARS) return { title: o.title ?? null, company: o.hiringOrganization?.name ?? null, description };
    }
  }
  return null;
}

async function get(url: string, timeoutMs: number, accept = "text/html,application/xhtml+xml"): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { "user-agent": UA, accept }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new AgentError("NETWORK_ERROR", `could not open ${url}: ${errorMessage(err)}`);
  }
  if (!res.ok) throw new AgentError("SOURCE_UNAVAILABLE", `${new URL(url).host} returned HTTP ${res.status}`, { retryable: res.status >= 500 });
  return res.text();
}

/** Which hiring platform a link belongs to, and the ids its public API needs. */
export function atsOf(url: string): { ats: "greenhouse"; board: string | null; id: string } | { ats: "lever"; company: string; id: string } | { ats: "smartrecruiters"; company: string; id: string } | { ats: "ashby"; org: string; id: string } | { ats: "linkedin"; id: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const parts = u.pathname.split("/").filter(Boolean);
  const host = u.hostname.toLowerCase();
  if (host.endsWith("greenhouse.io")) {
    const token = u.searchParams.get("token") ?? u.searchParams.get("gh_jid");
    const i = parts.indexOf("jobs");
    if (i > 0 && parts[i + 1] && /^\d+$/.test(parts[i + 1]!)) return { ats: "greenhouse", board: parts[i - 1]!, id: parts[i + 1]! };
    if (token && /^\d+$/.test(token)) return { ats: "greenhouse", board: u.searchParams.get("for"), id: token };
  }
  const ghJid = u.searchParams.get("gh_jid");
  if (ghJid && /^\d+$/.test(ghJid)) return { ats: "greenhouse", board: null, id: ghJid };
  if (host === "jobs.lever.co" && parts[0] && parts[1]) return { ats: "lever", company: parts[0], id: parts[1] };
  if (host === "jobs.smartrecruiters.com" && parts[0] && parts[1]) {
    const id = /^(\d+)/.exec(parts[1])?.[1];
    if (id) return { ats: "smartrecruiters", company: parts[0], id };
  }
  if (host === "jobs.ashbyhq.com" && parts[0] && parts[1]) return { ats: "ashby", org: parts[0], id: parts[1] };
  if (host.endsWith("linkedin.com")) {
    const id = /\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/.exec(u.pathname)?.[1] ?? u.searchParams.get("currentJobId");
    if (id && /^\d+$/.test(id)) return { ats: "linkedin", id };
  }
  return null;
}

/** The job description on LinkedIn's public job page: title, the criteria list (seniority, type) and the full text. */
export function linkedInJd(html: string): string {
  const start = html.indexOf("show-more-less-html__markup");
  if (start < 0) throw new AgentError("PARSER_FAILED", "LinkedIn returned no job description (the posting may be closed)", { retryable: false });
  const body = html.slice(html.indexOf(">", start) + 1, html.indexOf("</section>", start));
  const text = htmlToText(body).replace(/^\s*Show (more|less)\s*$/gim, "").trim();
  const title = /<h2[^>]*top-card-layout__title[^>]*>\s*([^<]+?)\s*</.exec(html)?.[1];
  const labels = [...html.matchAll(/description__job-criteria-subheader">\s*([^<]+?)\s*</g)].map((m) => m[1]!);
  const values = [...html.matchAll(/description__job-criteria-text[^"]*">\s*([^<]+?)\s*</g)].map((m) => m[1]!);
  const criteria = labels.map((l, i) => `${l}: ${values[i] ?? ""}`).join("\n");
  return join(title ? decodeEntities(title) : undefined, [text, criteria]);
}

const join = (title: string | undefined, sections: Array<string | undefined | null>) => [title, ...sections].filter((x): x is string => !!x && !!x.trim()).join("\n\n").trim();

/**
 * Exact job descriptions from the public APIs of the hiring platforms most companies use (Greenhouse, Lever,
 * SmartRecruiters, Ashby). Free, no API key, and no page chrome — the best source whenever the link is one of these.
 */
export class AtsJdProvider implements JdProvider {
  readonly id = "jd:ats-api";
  constructor(private readonly opts: { timeoutMs: number } = { timeoutMs: 20000 }) {}

  status(): IntegrationStatus {
    return { id: this.id, state: "READY", detail: "Greenhouse, Lever, SmartRecruiters, Ashby public job APIs; LinkedIn public job pages" };
  }

  canFetch(job: { jobUrl: string }): boolean {
    return atsOf(job.jobUrl) !== null;
  }

  async fetchJd(job: { jobUrl: string }): Promise<JdFetchResult> {
    const a = atsOf(job.jobUrl);
    if (!a) throw new AgentError("PARSER_FAILED", "not a supported hiring-platform link", { retryable: false });
    const t = this.opts.timeoutMs;
    const json = async <T>(url: string) => JSON.parse(await get(url, t, "application/json")) as T;
    if (a.ats === "greenhouse") {
      // A company-site link (?gh_jid=…) does not name the Greenhouse board; Greenhouse's own embed page does.
      const board = a.board ?? /"urlToken":"([\w-]+)"/.exec(await get(`https://boards.greenhouse.io/embed/job_app?token=${a.id}`, t))?.[1];
      if (!board) throw new AgentError("PARSER_FAILED", "could not find the Greenhouse board for this job", { retryable: false });
      const j = await json<{ title?: string; content?: string; location?: { name?: string } }>(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${a.id}`);
      return { jdText: join(j.title, [j.location?.name, htmlToText(decodeEntities(j.content ?? ""))]), method: "api:greenhouse" };
    }
    if (a.ats === "lever") {
      const j = await json<{ text?: string; descriptionPlain?: string; lists?: Array<{ text?: string; content?: string }>; additionalPlain?: string; categories?: { location?: string } }>(`https://api.lever.co/v0/postings/${a.company}/${a.id}`);
      return { jdText: join(j.text, [j.categories?.location, j.descriptionPlain, ...(j.lists ?? []).map((l) => `${l.text ?? ""}\n${htmlToText(l.content ?? "")}`), j.additionalPlain]), method: "api:lever" };
    }
    if (a.ats === "smartrecruiters") {
      const j = await json<{ name?: string; location?: { fullLocation?: string }; jobAd?: { sections?: Record<string, { title?: string; text?: string }> } }>(`https://api.smartrecruiters.com/v1/companies/${a.company}/postings/${a.id}`);
      const s = j.jobAd?.sections ?? {};
      return { jdText: join(j.name, [j.location?.fullLocation, ...["companyDescription", "jobDescription", "qualifications", "additionalInformation"].map((k) => (s[k]?.text ? `${s[k]?.title ?? ""}\n${htmlToText(s[k].text)}` : null))]), method: "api:smartrecruiters" };
    }
    if (a.ats === "linkedin") return { jdText: linkedInJd(await get(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${a.id}`, t)), method: "linkedin:public" };
    const board = await json<{ jobs?: Array<{ id: string; title?: string; location?: string; descriptionPlain?: string; descriptionHtml?: string }> }>(`https://api.ashbyhq.com/posting-api/job-board/${a.org}`);
    const j = board.jobs?.find((x) => x.id === a.id);
    if (!j) throw new AgentError("SOURCE_UNAVAILABLE", "the job is no longer on the company's Ashby job board", { retryable: false });
    return { jdText: join(j.title, [j.location, j.descriptionPlain ?? htmlToText(j.descriptionHtml ?? "")]), method: "api:ashby" };
  }
}

/**
 * Reads a job description straight from the posting page. "posting" mode accepts only the page's embedded JobPosting
 * data (exact JD); "text" mode falls back to the page's visible text (last resort: it may include site navigation).
 */
export class PageJdProvider implements JdProvider {
  readonly id: string;
  constructor(private readonly opts: { mode: "posting" | "text"; timeoutMs?: number } = { mode: "posting" }) {
    this.id = `jd:page-${opts.mode}`;
  }

  status(): IntegrationStatus {
    return { id: this.id, state: "READY", detail: this.opts.mode === "posting" ? "the posting's structured data" : "the page's visible text" };
  }

  canFetch(job: { jobUrl: string }): boolean {
    return /^https?:\/\//.test(job.jobUrl);
  }

  async fetchJd(job: { jobUrl: string }): Promise<JdFetchResult> {
    const html = await get(job.jobUrl, this.opts.timeoutMs ?? 20000);
    const posting = jobPostingFromHtml(html);
    if (posting) return { jdText: posting.description, method: "page:jobposting" };
    if (this.opts.mode === "posting") throw new AgentError("PARSER_FAILED", "the page has no structured job posting", { retryable: false });
    const body = /<main[\s\S]*?<\/main>/i.exec(html)?.[0] ?? /<body[\s\S]*<\/body>/i.exec(html)?.[0] ?? html;
    const text = htmlToText(body);
    if (text.length < 600) throw new AgentError("PARSER_FAILED", `the job page has too little readable text (${text.length} chars); it probably needs JavaScript`, { retryable: false });
    return { jdText: text.slice(0, 20000), method: "page:text" };
  }
}

/** Tries each provider in order and returns the first JD; reports every failure when none works. */
export class FallbackJdProvider implements JdProvider {
  readonly id = "jd:fallback";
  constructor(private readonly providers: JdProvider[]) {}

  status(): IntegrationStatus {
    const ready = this.providers.filter((p) => p.status().state === "READY").map((p) => p.id);
    return { id: this.id, state: ready.length ? "READY" : "NOT_CONFIGURED", detail: ready.join(" → ") || "no JD source" };
  }

  canFetch(job: { source: string; jobUrl: string }): boolean {
    return this.providers.some((p) => p.canFetch(job));
  }

  async fetchJd(job: { source: string; jobUrl: string; externalJobId: string | null; companyId: string | null }): Promise<JdFetchResult> {
    const errors: string[] = [];
    for (const p of this.providers) {
      if (!p.canFetch(job)) continue;
      try {
        const r = await p.fetchJd(job);
        if (r.jdText.trim().length >= MIN_JD_CHARS) return r;
        errors.push(`${p.id}: too little text`);
      } catch (err) {
        errors.push(`${p.id}: ${errorMessage(err)}`);
      }
    }
    throw new AgentError("PARSER_FAILED", `no job description found at ${job.jobUrl} (${errors.join("; ")})`, { retryable: false });
  }
}
