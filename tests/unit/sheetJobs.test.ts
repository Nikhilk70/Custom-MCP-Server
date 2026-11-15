import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { JdProvider } from "../../agent/core/interfaces.ts";
import type { AppConfig } from "../../agent/core/config.ts";
import { loadProfile, type Profile } from "../../agent/profile/profile.ts";
import { companyFromUrl, findJobs, importSheetRows, readyJob, searchProfile, syncSheet } from "../../agent/pipeline/sheetJobs.ts";
import { buildRelevanceFilter } from "../../agent/discovery/discoveryService.ts";
import type { CompanySource } from "../../agent/core/interfaces.ts";

import { projectRoot } from "../../agent/core/paths.ts";
import { JobRepo } from "../../agent/store/repositories.ts";
import { atsOf, htmlToText, jobPostingFromHtml } from "../../integrations/jd/PageJdProvider.ts";
import { FIXTURES, logger, makeTempRoot, memStore, rawJob, testConfig } from "../helpers.ts";

const JD = fs.readFileSync(path.join(FIXTURES, "jobs", "jd-java-backend.txt"), "utf8");
const HEADER = ["Job ID", "Company", "Job Title", "Location", "Apply Link"];

function provider(text: string | Error): JdProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: "jd:fake",
    calls,
    status: () => ({ id: "jd:fake", state: "READY", detail: "" }),
    canFetch: () => true,
    fetchJd: async (job) => {
      calls.push(job.jobUrl);
      if (text instanceof Error) throw text;
      return { jdText: text, method: "fake" };
    },
  };
}

let cfg: AppConfig;
let profile: Profile;
beforeAll(() => {
  makeTempRoot();
  cfg = testConfig();
  profile = loadProfile();
});

describe("jobs you add to the sheet", () => {
  it("a typed row (no Job ID) becomes a job with an ID; a repeated Apply Link is not imported twice", async () => {
    const { store } = await memStore({
      Jobs: [HEADER, ["", "Acme", "Java Developer", "Bengaluru", "https://boards.greenhouse.io/acme/jobs/1"], ["", "", "", "", "https://boards.greenhouse.io/acme/jobs/1"], ["", "Nope", "No link", "", ""]],
    });
    const r = importSheetRows(store, null);
    expect(r.imported).toEqual([{ jobId: "JOB-000001", company: "Acme", title: "Java Developer", row: 2 }]);
    expect(r.alreadyKnown).toEqual([{ jobId: "JOB-000001", row: 3 }]);
    expect(r.skipped).toEqual([{ row: 4, reason: "no Apply Link" }]);
    // The new job keeps its sheet row (row 2), so the Job ID is written next to what you typed.
    await store.flush();
    expect(store.t.jobs.get("JOB-000001")).toMatchObject({ companyName: "Acme", applyUrl: "https://boards.greenhouse.io/acme/jobs/1", status: "NORMALIZED" });
  });

  it("names the company from the link when the Company cell is empty", () => {
    expect(companyFromUrl("https://boards.greenhouse.io/acme-labs/jobs/123")).toBe("Acme Labs");
    expect(companyFromUrl("https://jobs.lever.co/stripe/abc")).toBe("Stripe");
    expect(companyFromUrl("https://careers.mongodb.com/job/123")).toBe("Mongodb");
  });

  it("sync reads the JD from the Apply Link and makes every job ready for a tailored resume — no eligibility gate", async () => {
    const { store } = await memStore({ Jobs: [HEADER, ["", "Acme", "Data Entry Operator", "Pune", "https://example.com/jobs/1"]] });
    const jd = provider(JD);
    const r = await syncSheet({ cfg, store, profile, jdProvider: jd, runId: null });
    expect(jd.calls).toEqual(["https://example.com/jobs/1"]);
    expect(r.ready).toEqual(["JOB-000001"]);
    const job = new JobRepo(store).get("JOB-000001");
    expect(job?.status).toBe("READY_FOR_RESUME");
    expect(job?.jdText?.trim()).toBe(JD.trim());
    expect(store.t.details.get("JOB-000001")?.match).not.toBeNull(); // kept: it orders the skills on the tailored resume
  });

  it("a JD that cannot be read leaves the job FAILED with the reason, and a retry reads it again", async () => {
    const { store } = await memStore({ Jobs: [HEADER, ["", "Acme", "Java Developer", "", "https://example.com/jobs/2"]] });
    importSheetRows(store, null);
    const broken = provider(new Error("HTTP 404"));
    expect(await readyJob({ cfg, store, profile, jdProvider: broken, runId: null }, "JOB-000001")).toBe("FAILED");
    expect(new JobRepo(store).get("JOB-000001")?.lastError).toMatch(/Could not read the job description from the Apply Link/);
  });
});

describe("reading a JD from a job page", () => {
  it("uses the page's JobPosting data when present", () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", title: "Backend Engineer", hiringOrganization: { name: "Acme" }, description: `<p>We build APIs.</p><ul><li>Java</li><li>Spring Boot</li></ul><p>${"Details. ".repeat(40)}</p>` })}</script></head><body>menu menu</body></html>`;
    const p = jobPostingFromHtml(html);
    expect(p).toMatchObject({ title: "Backend Engineer", company: "Acme" });
    expect(p?.description).toContain("We build APIs.\n- Java\n- Spring Boot");
  });
  it("turns HTML into readable text", () => {
    expect(htmlToText("<div>Hello&nbsp;<b>world</b></div><script>x()</script><p>Line&amp;two</p>")).toBe("Hello world\nLine&two");
  });
});

describe("hiring-platform links", () => {
  it("recognises Greenhouse, Lever, SmartRecruiters and Ashby links, including company-site ?gh_jid= links", () => {
    expect(atsOf("https://job-boards.greenhouse.io/hackerrank/jobs/8229735")).toEqual({ ats: "greenhouse", board: "hackerrank", id: "8229735" });
    expect(atsOf("https://careers.toasttab.com/jobs?gh_jid=8232478")).toEqual({ ats: "greenhouse", board: null, id: "8232478" });
    expect(atsOf("https://jobs.lever.co/mindtickle/b6e024c2-42c2/apply")).toEqual({ ats: "lever", company: "mindtickle", id: "b6e024c2-42c2" });
    expect(atsOf("https://jobs.smartrecruiters.com/BoschGroup/744000153224614-eclipse-developer?oga=true")).toEqual({ ats: "smartrecruiters", company: "BoschGroup", id: "744000153224614" });
    expect(atsOf("https://jobs.ashbyhq.com/cursor/166c3951/application")).toEqual({ ats: "ashby", org: "cursor", id: "166c3951" });
    expect(atsOf("https://example.com/careers/123")).toBeNull();
  });
});

describe("Find jobs", () => {
  it("searches with the roles from your resume and keeps senior titles out (Sr, Sr., Senior)", () => {
    const p = searchProfile(cfg, profile);
    expect(p.preferences.targetRoles).toEqual(expect.arrayContaining(profile.professional.targetRoles));
    const keep = buildRelevanceFilter(cfg, p, ["India", "Bengaluru"]);
    expect(keep("Frontend Developer", "Bengaluru, India")).toBe(true);
    expect(keep("Sr Software Engineer", "Bengaluru, India")).toBe(false);
    expect(keep("Sr. Software Engineer", "Bengaluru, India")).toBe(false);
    expect(keep("Senior Frontend Developer", "Bengaluru, India")).toBe(false);
    expect(keep("Sales Executive", "Bengaluru, India")).toBe(false);
  });

  it("adds what it finds to the sheet with a score, and applies to nothing", async () => {
    const dir = path.join(projectRoot(), "Companies", "Product", "Acme");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "company.json"), JSON.stringify({ companyName: "Acme", careersUrl: "https://boards.greenhouse.io/acme" }));
    const { store } = await memStore({ Jobs: [HEADER] });
    const source: CompanySource = {
      id: "fake-careers",
      status: () => ({ id: "fake-careers", state: "READY", detail: "" }),
      search: async (c) => ({
        status: "SUCCESS_WITH_JOBS",
        source: "greenhouse",
        jobsFound: 2,
        error: null,
        jobs: [
          rawJob({ companyName: c.companyName, companyId: c.companyId, jobTitle: "Frontend Developer", location: "Bengaluru, India", applyUrl: `https://example.com/${c.companyId}/1`, jobUrl: `https://example.com/${c.companyId}/1`, externalJobId: `${c.companyId}-1`, jdText: JD }),
          rawJob({ companyName: c.companyName, companyId: c.companyId, jobTitle: "Senior Staff Engineer", location: "Bengaluru, India", applyUrl: `https://example.com/${c.companyId}/2`, jobUrl: `https://example.com/${c.companyId}/2`, externalJobId: `${c.companyId}-2`, jdText: JD }),
        ],
      }),
    };
    const boards = { ...cfg, sources: { ...cfg.sources, companyCareers: { ...cfg.sources.companyCareers, enabled: true }, linkedin: { ...cfg.sources.linkedin, enabled: false } } };
    const r = await findJobs({ cfg: boards, store, profile, jdProvider: provider(new Error("not needed: the board gave the JD")), runId: null, logger: logger(), companySource: source });
    expect(r.newJobs).toBeGreaterThan(0);
    const jobs = new JobRepo(store).all();
    expect(jobs.every((j) => j.jobTitle === "Frontend Developer")).toBe(true); // the senior title was filtered out
    expect(jobs.every((j) => ["MATCHED", "NOT_MATCHED"].includes(j.status) && j.matchScore !== null)).toBe(true);
    expect(r.goodFit.length + r.lowFit.length).toBe(jobs.length);
  });
});
