import { beforeAll, describe, expect, it } from "vitest";
import { linkedInJobId, parseLinkedInResults } from "../../integrations/linkedin/LinkedInMcpSource.ts";
import { atsOf, linkedInJd } from "../../integrations/jd/PageJdProvider.ts";
import { linkedInSearches, searchProfile } from "../../agent/pipeline/sheetJobs.ts";
import { loadProfile } from "../../agent/profile/profile.ts";
import { makeTempRoot, testConfig } from "../helpers.ts";

const TOOL_TEXT = `Found 2 job(s) for "frontend developer" in "India":

1. Frontend Developer (SDE 1)
   Company: GIVA
   Location: Bengaluru, Karnataka, India
   Posted: 3 days ago
   Salary: Not specified
   Apply: https://in.linkedin.com/jobs/view/frontend-developer-sde-1-at-giva-4474117454?position=3&pageNum=0

2. Reactjs Developer
   Company: Tata Consultancy Services
   Location: Bengaluru, Karnataka, India
   Posted: 1 week ago
   Salary: ₹6,00,000/yr
   Apply: https://in.linkedin.com/jobs/view/reactjs-developer-at-tata-consultancy-services-4472494790?position=2
`;

describe("LinkedIn (MCP search_linkedin_jobs)", () => {
  it("parses the tool's text into jobs with a stable LinkedIn link", () => {
    const jobs = parseLinkedInResults(TOOL_TEXT, new Date("2026-10-04T00:00:00Z"));
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ source: "linkedin", externalJobId: "4474117454", companyName: "GIVA", jobTitle: "Frontend Developer (SDE 1)", location: "Bengaluru, Karnataka, India", postedDate: "2026-10-01", salary: null, applyUrl: "https://www.linkedin.com/jobs/view/4474117454/" });
    expect(jobs[1]).toMatchObject({ postedDate: "2026-09-27", salary: "₹6,00,000/yr" });
  });

  it("reads the job id from any LinkedIn job link", () => {
    expect(linkedInJobId("https://www.linkedin.com/jobs/view/4474117454/")).toBe("4474117454");
    expect(atsOf("https://in.linkedin.com/jobs/view/frontend-developer-at-giva-4474117454?position=3")).toEqual({ ats: "linkedin", id: "4474117454" });
  });

  it("extracts the JD and its criteria from LinkedIn's public job page", () => {
    const html = `<h2 class="top-card-layout__title font-sans">Frontend Developer (SDE 1)</h2>
      <section class="show-more-less-html"><div class="show-more-less-html__markup relative"><p><strong>About the role</strong></p><ul><li>React</li><li>TypeScript</li></ul>${"<p>Build things.</p>".repeat(30)}</div><button>Show more</button></section>
      <h3 class="description__job-criteria-subheader">Seniority level</h3><span class="description__job-criteria-text description__job-criteria-text--criteria">Entry level</span>`;
    const jd = linkedInJd(html);
    expect(jd.startsWith("Frontend Developer (SDE 1)")).toBe(true);
    expect(jd).toContain("About the role\n- React\n- TypeScript");
    expect(jd).toContain("Seniority level: Entry level");
    expect(jd).not.toMatch(/Show more/);
  });
});

describe("LinkedIn searches", () => {
  beforeAll(() => makeTempRoot());
  it("searches your own roles at levels that fit your experience", () => {
    const cfg = testConfig();
    const profile = searchProfile(cfg, loadProfile());
    const s = linkedInSearches({ ...cfg, sources: { ...cfg.sources, linkedin: { ...cfg.sources.linkedin, enabled: true, experienceLevels: ["entry level", "senior"], locations: ["India"], maxSearches: 50 } } }, profile);
    expect(new Set(s.map((x) => x.keyword))).toEqual(new Set(profile.preferences.targetRoles));
    expect(s.every((x) => x.experienceLevel === "entry level" && x.location === "India")).toBe(true); // "senior" dropped: too little experience
  });
});
