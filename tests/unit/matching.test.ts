import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeJd } from "../../agent/matching/jdAnalyzer.ts";
import { matchJob } from "../../agent/matching/matcher.ts";
import { detectSkills } from "../../agent/matching/skillCatalog.ts";
import { locationMatches } from "../../agent/matching/location.ts";
import { classifyRole, targetFamilies } from "../../agent/matching/roleClassifier.ts";
import { matchJobs } from "../../agent/matching/matchService.ts";
import { JobRepo } from "../../agent/store/repositories.ts";
import { loadProfile, type Profile } from "../../agent/profile/profile.ts";
import type { AppConfig } from "../../agent/core/config.ts";
import { FIXTURES, logger, makeTempRoot, memStore, testConfig } from "../helpers.ts";

let profile: Profile;
let cfg: AppConfig;
beforeAll(() => {
  makeTempRoot();
  profile = loadProfile();
  cfg = testConfig();
});
const jd = (f: string) => fs.readFileSync(path.join(FIXTURES, "jobs", f), "utf8");
const asOf = new Date("2026-09-30T00:00:00Z");

describe("skill detection", () => {
  it("does not confuse Java with JavaScript or 'rest' with REST", () => {
    expect(detectSkills("We use JavaScript only")).not.toContain("Java");
    expect(detectSkills("the rest of the team")).not.toContain("REST APIs");
    expect(detectSkills("RESTful services in Java")).toEqual(expect.arrayContaining(["Java", "REST APIs"]));
  });
  it("does not read domain names as .NET (regression: live Firecrawl cookie banner)", () => {
    expect(detectSkills("doubleclick.net sets this cookie")).not.toContain("C#");
    expect(detectSkills("Experience with C# and .NET Core")).toContain("C#");
    expect(detectSkills("ASP.NET MVC")).toContain("C#");
  });
});

describe("JD analysis", () => {
  it("separates required and preferred skills and reads experience", () => {
    const r = analyzeJd({ jdText: jd("jd-java-backend.txt"), jobTitle: "Java Backend Developer", location: "Bengaluru", workMode: null });
    expect(r.requiredSkills).toEqual(expect.arrayContaining(["Java", "Spring Boot", "Hibernate", "SQL", "REST APIs"]));
    expect(r.preferredSkills).toEqual(expect.arrayContaining(["Docker", "Kubernetes", "Kafka"]));
    expect(r.requiredSkills).not.toContain("Kubernetes");
    expect(r.minYearsExperience).toBe(0);
  });
});

describe("matcher", () => {
  it("scores a fitting job as eligible with explainable components", () => {
    const text = jd("jd-java-backend.txt");
    const reqs = analyzeJd({ jdText: text, jobTitle: "Java Backend Developer", location: "Bengaluru, India", workMode: null });
    const m = matchJob({ jobTitle: "Java Backend Developer", companyName: "Acme", location: "Bengaluru, India", workMode: null, jdText: text }, reqs, profile, cfg.matching, asOf);
    expect(m.eligible).toBe(true);
    expect(m.score).toBeGreaterThanOrEqual(60);
    expect(Object.keys(m.components)).toEqual(expect.arrayContaining(["requiredSkills", "titleSimilarity", "experience", "location"]));
    expect(m.reason).toMatch(/%/);
  });

  it("never credits skills missing from MY_DATA", () => {
    const text = jd("jd-java-backend.txt");
    const reqs = analyzeJd({ jdText: text, jobTitle: "Java Backend Developer", location: "Bengaluru", workMode: null });
    const m = matchJob({ jobTitle: "Java Backend Developer", companyName: "Acme", location: "Bengaluru", workMode: null, jdText: text }, reqs, profile, cfg.matching, asOf);
    expect(m.missingSkills).toEqual(expect.arrayContaining(["Kubernetes", "Kafka"]));
    expect(m.matchedSkills.map((s) => s.skill)).not.toContain("Kubernetes");
  });

  it("gives partial credit for basic/learning skills and flags them", () => {
    const reqs = { ...analyzeJd({ jdText: "Requirements\n- Python\n- Microservices", jobTitle: "Backend Developer", location: "Pune", workMode: null }) };
    const m = matchJob({ jobTitle: "Backend Developer", companyName: "Acme", location: "Pune", workMode: null, jdText: "x" }, reqs, profile, cfg.matching, asOf);
    expect(m.components.requiredSkills?.score).toBeCloseTo((0.5 + 0.2) / 2);
    expect(m.riskFlags.join(" ")).toMatch(/Python is only 'basic'/);
    expect(m.riskFlags.join(" ")).toMatch(/Microservices is only 'learning'/);
  });

  it("hard constraints override the score (seniority, years, location)", () => {
    const text = jd("jd-senior-devops.txt");
    const reqs = analyzeJd({ jdText: text, jobTitle: "Senior Platform Engineer", location: "Remote - US", workMode: "remote" });
    const m = matchJob({ jobTitle: "Senior Platform Engineer", companyName: "Acme", location: "Remote - US", workMode: "remote", jdText: text }, reqs, profile, cfg.matching, asOf);
    expect(m.eligible).toBe(false);
    expect(m.hardConstraintFailures.join(" ")).toMatch(/senior/);
    expect(m.hardConstraintFailures.join(" ")).toMatch(/7\+ years/);
    expect(m.hardConstraintFailures.join(" ")).toMatch(/not in preferences/);
  });

  it("unknown work-mode preference is neutral, not 'yes'", () => {
    const reqs = analyzeJd({ jdText: "Requirements\n- Java", jobTitle: "Software Engineer", location: "Mumbai", workMode: "hybrid" });
    const m = matchJob({ jobTitle: "Software Engineer", companyName: "Acme", location: "Mumbai", workMode: "hybrid", jdText: "x" }, reqs, profile, cfg.matching, asOf);
    expect(m.components.workMode?.score).toBe(cfg.matching.neutralScoreWhenUnknown);
    expect(m.components.workMode?.detail).toMatch(/unknown/);
  });
});

describe("role-family gate", () => {
  const javaJd = () => jd("jd-java-backend.txt");
  it("classifies titles by what the job is (titles seen in the live run)", () => {
    const fam = (t: string) => classifyRole({ jobTitle: t, jdText: null }, profile.preferences).jobFamily;
    expect(fam("IN_RBAI_Engineer/Maintenance Engineer")).toBe("MECHANICAL");
    expect(fam("IN_RBIN_Senior Engineer - Fire Safety Officer_NaP/HSE")).toBe("MECHANICAL");
    expect(fam("SW developer :Java")).toBe("BACKEND");
    expect(fam("Java Full Stack Developer")).toBe("FULLSTACK");
    expect(fam("Software Engineer")).toBe("SOFTWARE_ENGINEERING");
    expect(fam("ServiceNow Platform & ITSM Developer")).toBe("ENTERPRISE_PLATFORM");
    expect(fam("2026_Embedded_Application_SW_Developer_COB_EBG2")).toBe("EMBEDDED");
    expect(fam("2026 EGM Ethernet Validation Engineer for SDV project in Braking System")).toBe("HARDWARE");
    expect(fam("QA Test Developer")).toBe("QA");
    expect(fam("Director, Site Reliability Engineering")).toBe("DEVOPS");
    expect(fam("Customer Experience Engineer, L2")).toBe("SUPPORT");
    expect(fam("AI Engineer - FDE (Forward Deployed Engineer)")).toBe("AI_ML");
    // corrections after reviewing the first live rematch
    expect(fam("2026_Java_Eclipse Development_COB")).toBe("BACKEND");
    expect(fam("2026/03: HW Developer (PS-DC Projects)")).toBe("HARDWARE");
    expect(fam("VM Brakes BSW Developer Indian OEM")).toBe("EMBEDDED");
    expect(fam("Application SW Developer (Model-based) for Steering Platform")).toBe("EMBEDDED");
    expect(fam("Software Development Engineer in Test II")).toBe("QA");
    expect(fam("Analyst - Software Lifecycle Requirements management")).toBe("PRODUCT");
    expect(fam("Technical Services Engineer")).toBe("SUPPORT");
    expect(fam("AI Product Engineer")).toBe("SOFTWARE_ENGINEERING");
    // corrections after the first dry run
    expect(fam("Java Full Stack Developer with DevOps experience")).toBe("FULLSTACK");
    expect(fam("Full Stack Software Developer with AI expertise")).toBe("FULLSTACK");
  });

  it("derives accepted families from preferences.targetRoles, not from code", () => {
    expect([...targetFamilies(profile.preferences)].sort()).toEqual(["BACKEND", "FRONTEND", "FULLSTACK", "SOFTWARE_ENGINEERING"]);
    expect([...targetFamilies({ targetRoles: ["Data Engineer"] })]).toEqual(["DATA"]);
    expect([...targetFamilies({ targetRoles: ["Software Engineer"], targetRoleFamilies: ["QA"] })]).toEqual(["QA"]);
  });

  it("a maintenance role is NOT eligible even when its JD scores high on Java keywords", () => {
    const text = javaJd();
    const title = "IN_RBAI_Engineer/Maintenance Engineer";
    const reqs = analyzeJd({ jdText: text, jobTitle: title, location: "Bengaluru, India", workMode: null });
    const m = matchJob({ jobTitle: title, companyName: "Bosch", location: "Bengaluru, India", workMode: null, jdText: text }, reqs, profile, cfg.matching, asOf);
    expect(m.technicalMatchScore).toBeGreaterThanOrEqual(60); // the technical score is preserved…
    expect(m.role.jobFamily).toBe("MECHANICAL");
    expect(m.roleCompatibility).toBe("INCOMPATIBLE");
    expect(m.eligibilityStatus).toBe("NOT_ELIGIBLE"); // …and cannot override the role gate
    expect(m.eligibilityReason).toBe("ROLE_FAMILY_INCOMPATIBLE");
    expect(m.eligible).toBe(false);
  });

  it("a generic software title with an embedded-systems JD is classified by the JD", () => {
    const text = "Develop flash bootloader (FBL) software for automotive ECUs. Embedded C, AUTOSAR, MISRA, UDS diagnostics, CAN bus, microcontroller bring-up, CANoe and CANalyzer.";
    const r = classifyRole({ jobTitle: "EBB_SW_Engineer_3LH", jdText: text }, profile.preferences);
    expect(r.jobFamily).toBe("EMBEDDED");
    expect(r.targetRoleCompatible).toBe(false);
    expect(r.confidence).toBeLessThan(0.9);
  });

  it("excludedRolePatterns reject by title with their own code", () => {
    const prefs = { ...profile.preferences, excludedRolePatterns: ["\\bintern\\b"] };
    const reqs = analyzeJd({ jdText: javaJd(), jobTitle: "Software Engineer, Intern", location: "Bengaluru", workMode: null });
    const m = matchJob({ jobTitle: "Software Engineer, Intern", companyName: "Acme", location: "Bengaluru", workMode: null, jdText: javaJd() }, reqs, { ...profile, preferences: prefs }, cfg.matching, asOf);
    expect(m.eligibilityReason).toBe("ROLE_EXCLUDED_PATTERN");
  });

  it("gates are ordered: role, then experience, then mandatory, then technical", () => {
    const text = jd("jd-senior-devops.txt");
    const reqs = analyzeJd({ jdText: text, jobTitle: "Senior Platform Engineer", location: "Remote - US", workMode: "remote" });
    const m = matchJob({ jobTitle: "Senior Platform Engineer", companyName: "Acme", location: "Remote - US", workMode: "remote", jdText: text }, reqs, profile, cfg.matching, asOf);
    expect(m.eligibilityReason).toBe("ROLE_FAMILY_INCOMPATIBLE");
    expect(m.gates.experience.join(" ")).toMatch(/senior/);
    expect(m.gates.mandatory.join(" ")).toMatch(/not in preferences/);
  });

  it("rematch moves an ineligible job out of the resume queue with the gate code", async () => {
    const { store } = await memStore();
    const now = new Date().toISOString();
    for (const [jobId, title, status] of [["JOB-000001", "IN_RBAI_Engineer/Maintenance Engineer", "READY_FOR_RESUME"], ["JOB-000002", "Java Backend Developer", "JD_FETCHED"]] as const) {
      store.t.jobs.insert({
        jobId, source: "test", sourcesLabel: "test", externalJobId: null, companyId: null, companyName: "Acme", jobTitle: title, location: "Bengaluru, India", workMode: null, experienceRequired: null,
        salary: null, skills: [], postedDate: null, applyUrl: `https://acme.example/${jobId}`, jobUrl: `https://acme.example/${jobId}`, jdHash: "h", companyDomain: null, matchScore: 74, matchReason: null,
        resumeVersionId: null, status, applicationAttempts: 0, requiresHuman: false, blockReason: null, lastError: null, createdAt: now, updatedAt: now, resumeFile: "", lastAttemptAt: null, appliedDate: null,
      });
      store.t.details.insert({ jobId, jdText: javaJd(), jdSource: "test", requirements: null, requirementsJdHash: null, match: null, matchProfileHash: null, matchedAt: null });
    }
    const r = await matchJobs({ cfg, store, logger: logger(), profile, jdProviders: [], runId: null }, { rematch: true });
    const repo = new JobRepo(store);
    expect(repo.get("JOB-000001")?.status).toBe("NOT_MATCHED");
    expect(repo.get("JOB-000001")?.matchReason).toMatch(/^ROLE_FAMILY_INCOMPATIBLE \| role MECHANICAL/);
    expect(repo.get("JOB-000002")?.status).toBe("READY_FOR_RESUME");
    expect(r.results.find((x) => x.jobId === "JOB-000001")).toMatchObject({ eligible: false, eligibilityReason: "ROLE_FAMILY_INCOMPATIBLE", jobFamily: "MECHANICAL" });
  });
});

describe("location", () => {
  it("handles aliases and remote scope", () => {
    const prefs = ["India", "Remote", "Bangalore"];
    expect(locationMatches("Bengaluru, Karnataka", null, prefs).matches).toBe(true);
    expect(locationMatches("Remote - India", "remote", prefs).matches).toBe(true);
    expect(locationMatches("Remote - United States", "remote", prefs).matches).toBe(false);
    expect(locationMatches("London, UK", null, prefs).matches).toBe(false);
  });
});
