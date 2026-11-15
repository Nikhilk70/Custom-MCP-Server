import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { AppConfig } from "../../agent/core/config.ts";
import { analyzeJd, headingKind } from "../../agent/matching/jdAnalyzer.ts";
import { decompileJd, JD_DECOMPILER_VERSION, type DecompiledJd, type DecompileInput, type Evidence } from "../../agent/matching/jdDecompiler.ts";
import { decompileStored, getIntelligence, matchJobs } from "../../agent/matching/matchService.ts";
import { loadProfile, type Profile } from "../../agent/profile/profile.ts";
import type { Store } from "../../agent/store/sheetStore.ts";
import { FIXTURES, logger, makeTempRoot, memStore, testConfig } from "../helpers.ts";

const jd = (f: string) => fs.readFileSync(path.join(FIXTURES, "jobs", f), "utf8");
const run = (jdText: string | null, over: Partial<DecompileInput> = {}): DecompiledJd => decompileJd({ jobTitle: "Software Engineer", companyName: "Acme", location: "Bengaluru, India", workMode: null, jdText, ...over });

/** Every JD quote must be an exact substring at its offset, and on its stated line. */
function allEvidence(d: DecompiledJd): Evidence[] {
  const fields = [d.role, d.company, d.location, d.workMode, d.experience, d.education, d.seniority, d.responsibilities, d.certifications, d.salary, d.batch, d.cgpa, d.percentage, d.branch, d.bond, d.noticePeriod, d.domain];
  return [...fields.flatMap((f) => f.evidence), ...d.skills.flatMap((s) => s.evidence), ...d.contradictions.flatMap((c) => c.evidence)];
}
function expectExactQuotes(d: DecompiledJd): void {
  const lines = d.text.split("\n");
  for (const e of allEvidence(d)) {
    if (e.source === "LISTING") {
      expect(e.field, e.quote).toBeTruthy();
      continue;
    }
    expect(e.offset, e.quote).not.toBeNull();
    expect(d.text.slice(e.offset ?? 0, (e.offset ?? 0) + e.quote.length)).toBe(e.quote);
    if (e.line !== null) expect(lines[e.line - 1], `line ${e.line}`).toContain(e.quote);
  }
}

describe("JD decompiler: Indian campus requirements", () => {
  const d = run(jd("jd-campus-india.txt"), { jobTitle: "Graduate Engineer Trainee" });

  it("extracts batch, CGPA, percentage, branches, bond, salary, notice and location — each quoted", () => {
    expect(d.batch).toMatchObject({ value: [2024, 2025], level: "HIGH" });
    expect(d.batch.evidence[0]?.quote).toBe("Batch: 2024 & 2025 pass-outs only");
    expect(d.cgpa).toMatchObject({ value: 7, confidence: 0.9 });
    expect(d.percentage.value).toEqual({ min: 60, appliesTo: ["10th", "12th/Diploma", "Graduation"] });
    expect(d.branch.value).toEqual({ branches: ["CS", "IT", "ECE", "EEE"], anyBranch: false, allowsRelated: false });
    expect(d.bond.value).toEqual({ required: true, months: 24, amount: "₹2,00,000" });
    expect(d.salary).toMatchObject({ value: { min: 4.5, max: 4.5, unit: "LPA" }, confidence: 0.9 });
    expect(d.noticePeriod.value).toEqual({ maxDays: 0, immediate: true });
    expect(d.location.value?.cities).toEqual(["Bengaluru", "Chennai"]);
    expect(d.workMode.value).toBe("onsite");
    expect(d.education.value?.degrees).toEqual(["BE/BTech"]);
    expect(d.seniority.value).toBe("ENTRY");
    expect(d.campusJd).toBe(true);
    expectExactQuotes(d);
  });

  it("reports what a campus JD leaves out, and finds no contradictions in a consistent JD", () => {
    expect(d.missing.map((m) => m.field)).toEqual(["experience"]);
    expect(d.contradictions).toEqual([]);
  });
});

describe("JD decompiler: fresher JDs", () => {
  it("reads 0–1 years as fresher-friendly, any-graduate eligibility and the CTC after training", () => {
    const d = run(jd("jd-fresher-trainee.txt"), { jobTitle: "Trainee Software Developer", location: "Pune, India" });
    expect(d.experience.value).toEqual({ min: 0, max: 1, band: "FRESHER", fresherFriendly: true });
    expect(d.seniority).toMatchObject({ value: "ENTRY", method: "level word in the job title" });
    expect(d.education.value).toMatchObject({ anyGraduate: true });
    expect(d.branch.value).toEqual({ branches: [], anyBranch: true, allowsRelated: true });
    expect(d.salary.value).toMatchObject({ min: 3.6, unit: "LPA" });
    expect(d.mandatorySkills).toEqual(expect.arrayContaining(["Java", "MySQL", "Spring Boot"]));
    expect(d.campusJd).toBe(true);
    expect(d.missing.map((m) => m.field)).toEqual(expect.arrayContaining(["workMode", "batch", "cgpa"]));
    expectExactQuotes(d);
  });

  it("a monthly stipend alone is reported per month, not as an annual CTC", () => {
    const d = run("Internship\nRequirements\n- Java and SQL\n- Final-year students only\nStipend: ₹20,000 per month for 6 months", { jobTitle: "Software Intern" });
    expect(d.salary.value).toMatchObject({ min: 20000, max: 20000, unit: "INR_PER_MONTH" });
    expect(d.seniority.value).toBe("INTERN");
  });
});

describe("JD decompiler: experienced JDs", () => {
  const d = run(jd("jd-experienced-sde2.txt"), { jobTitle: "Software Development Engineer 2", location: "Hyderabad, India", workMode: "hybrid" });

  it("separates mandatory, preferred and nice-to-have skills with their source lines", () => {
    expect(d.mandatorySkills).toEqual(expect.arrayContaining(["Java", "Spring Boot", "Microservices", "AWS"]));
    expect(d.preferredSkills).toEqual(["Kafka"]);
    expect(d.niceToHaveSkills).toEqual(["Kubernetes"]);
    const java = d.skills.find((s) => s.skill === "Java");
    expect(java).toMatchObject({ tier: "MANDATORY", confidence: 0.9 });
    expect(java?.evidence[0]?.quote).toBe("- Strong hands-on experience with Java, Spring Boot and Microservices");
    expectExactQuotes(d);
  });

  it("experience, derived seniority (labelled LOW), hybrid work mode, domain; campus fields are not 'missing'", () => {
    expect(d.experience.value).toEqual({ min: 3, max: 5, band: "2-5", fresherFriendly: false });
    expect(d.seniority).toMatchObject({ value: "MID", confidence: 0.55, level: "LOW" });
    expect(d.workMode).toMatchObject({ value: "hybrid", confidence: 0.9 });
    expect(d.domain.value).toEqual(["Fintech / BFSI"]);
    expect(d.campusJd).toBe(false);
    expect(d.missing.map((m) => m.field)).toEqual(["salary"]);
    expect(d.responsibilities.value).toHaveLength(3);
  });

  it("mandatory skills are exactly the matcher's required skills", () => {
    for (const [f, title] of [["jd-experienced-sde2.txt", "SDE 2"], ["jd-campus-india.txt", "Graduate Engineer Trainee"], ["jd-java-backend.txt", "Java Backend Developer"], ["jd-fresher-trainee.txt", "Trainee"]] as const) {
      const text = jd(f);
      const reqs = analyzeJd({ jdText: text, jobTitle: title, location: "Bengaluru", workMode: null });
      expect(run(text, { jobTitle: title }).mandatorySkills.sort(), f).toEqual([...reqs.requiredSkills].sort());
    }
  });
});

describe("JD decompiler: contradictions and missing information", () => {
  const d = run(jd("jd-contradictory.txt"), { jobTitle: "Senior Software Engineer", location: "Pune, India" });

  it("reports every contradiction with the clashing quotes, and lowers confidence on those fields", () => {
    const by = Object.fromEntries(d.contradictions.map((c) => [c.field, c]));
    expect(Object.keys(by).sort()).toEqual(["batch", "cgpa", "experience", "location", "workMode"]);
    expect(by.experience?.detail).toMatch(/invites freshers but also asks for 5\+ years/);
    expect(by.experience?.evidence.map((e) => e.quote)).toEqual(expect.arrayContaining(["Freshers are welcome to apply for this position.", "- Minimum 5 years of experience in Java development"]));
    expect(by.batch?.detail).toMatch(/2023 vs 2025/);
    expect(by.cgpa?.detail).toMatch(/7\.5 and 8/);
    expect(by.location?.detail).toMatch(/listing says Pune but the JD names Bengaluru/);
    for (const k of ["experience", "batch", "cgpa", "location"] as const) expect(d[k].confidence, k).toBeLessThanOrEqual(0.4);
    expect(d.cgpa.value).toBe(8); // the binding (highest) minimum is shown
    expectExactQuotes(d);
  });

  it("skill-specific years vs overall years: says which number the eligibility check used", () => {
    const x = run("Requirements\n- 8 to 10 years of overall software development experience\n- 4+ years of Workday Extend experience\n- Java");
    expect(x.contradictions[0]?.detail).toMatch(/overall requirement is 8\+ years.*eligibility check uses 4 years.*real bar is likely 8\+/);
  });

  it("says so when the eligibility check could not read the experience wording at all (real Okta JD)", () => {
    const x = run("Requirements\n• 8 to 10 years of overall IT/software development experience.\n• 4+ years of hands-on Workday Extend experience.\n• Java");
    expect(analyzeJd({ jdText: x.text, jobTitle: "Engineer", location: "", workMode: null }).minYearsExperience).toBeNull();
    expect(x.experience.value?.min).toBe(4);
    expect(x.experience.method).toMatch(/eligibility check did not recognise this wording/);
    expect(x.contradictions[0]?.detail).toMatch(/did not recognise either statement, so the real bar is likely 8\+/);
  });

  it("a listing/JD work-mode mismatch is a contradiction; a policy line listing options is not", () => {
    expect(run("Requirements\n- Java\n#LI-Onsite", { workMode: "hybrid" }).contradictions.map((c) => c.field)).toEqual(["workMode"]);
    expect(run("Requirements\n- Java\nWork personas (flexible, remote, or required in office) are set per role.", { workMode: "hybrid" }).contradictions).toEqual([]);
  });

  it("title vs experience: a 'Senior' role asking for 0–1 years is flagged", () => {
    const x = run("Requirements\n- 0-1 years of experience\n- Java and SQL", { jobTitle: "Senior Java Developer" });
    expect(x.contradictions.map((c) => c.field)).toContain("seniority");
  });

  it("lists absent fields with their consequence instead of inventing defaults", () => {
    const x = run("Requirements\n- Java\n- Spring Boot\n- REST APIs");
    const missing = Object.fromEntries(x.missing.map((m) => [m.field, m.impact]));
    expect(missing.experience).toMatch(/eligibility check treats it as unknown/);
    expect(missing.salary).toBeDefined();
    expect(missing.workMode).toBeDefined();
    expect(x.experience).toEqual({ value: null, confidence: 0, level: "NONE", evidence: [], method: "not stated" });
  });
});

describe("JD decompiler: malformed JDs", () => {
  it("empty / null JD: no crash, everything missing, flagged, confidence 0", () => {
    for (const text of [null, "", "   \n  "]) {
      const d = run(text);
      expect(d.quality.malformed).toBe(true);
      expect(d.quality.overallConfidence).toBe(0);
      expect(d.missing[0]?.field).toBe("jdText");
      expect(d.skills).toEqual([]);
    }
  });

  it("placeholder / very short JD is flagged as thin", () => {
    const d = run("TBD - details to follow");
    expect(d.quality.malformed).toBe(true);
    expect(d.quality.warnings.join(" ")).toMatch(/thin or malformed/);
  });

  it("HTML JD: markup removed, entities decoded, quotes exact against the cleaned text", () => {
    const d = run("<h2>Requirements</h2><ul><li>2+ years of experience with <b>Java</b> &amp; Spring Boot</li><li>B.Tech in CSE</li></ul><p>Location: Pune &ndash; hybrid</p>");
    expect(d.quality.warnings[0]).toMatch(/HTML markup was removed/);
    expect(d.text).not.toMatch(/<[a-z]/i);
    expect(d.text).toContain("Java & Spring Boot");
    expect(d.experience.value?.min).toBe(2);
    expect(d.mandatorySkills).toEqual(expect.arrayContaining(["Java", "Spring Boot"]));
    expect(d.workMode.value).toBe("hybrid");
    expectExactQuotes(d);
  });

  it("one-paragraph JD without line breaks is split into sentences; quotes carry offsets", () => {
    const wall = `${"We are a fast-growing SaaS company building tools for developers across India. ".repeat(4)}You will build REST APIs in Java and Spring Boot. You need 2+ years of experience in backend development. A B.E/B.Tech in Computer Science is required. CGPA 7 and above. This is a hybrid role based in Bengaluru. Kubernetes is a plus.`;
    const d = run(wall);
    expect(d.quality.warnings.join(" ")).toMatch(/no line breaks/);
    expect(d.experience.value?.min).toBe(2);
    expect(d.cgpa.value).toBe(7);
    expect(d.experience.evidence[0]).toMatchObject({ line: null });
    expect(d.experience.evidence[0]?.quote).toBe("You need 2+ years of experience in backend development.");
    expectExactQuotes(d);
  });

  it("garbage input and missing listing fields never throw", () => {
    const bad = [String.fromCharCode(0, 1, 2) + "%%%%", "₹₹₹ LPA LPA lakh", "CGPA CGPA % % batch batch", "a".repeat(50_000)];
    for (const t of bad) expect(() => run(t)).not.toThrow();
    expect(() => decompileJd({ jobTitle: undefined, companyName: undefined, location: undefined, workMode: null, jdText: "Requirements\n- Java" } as unknown as DecompileInput)).not.toThrow();
    // Long lines are quoted as an exact window, never more than 240 characters.
    const long = run(`Requirements\n- ${"lorem ipsum ".repeat(60)}Java ${"dolor sit ".repeat(60)}`);
    const q = long.skills.find((s) => s.skill === "Java")?.evidence[0]?.quote ?? "";
    expect(q.length).toBeLessThanOrEqual(240);
    expect(q).toContain("Java");
    expectExactQuotes(long);
  });

  it("requirement lines that look short are not mistaken for headings", () => {
    expect(headingKind("Minimum 5 years of experience")).toBeNull();
    expect(headingKind("Immediate joiners preferred")).toBeNull();
    expect(headingKind("CGPA 7.5 and above")).toBeNull();
    expect(headingKind("Requirements")).toBe("required");
    expect(headingKind("Nice to have")).toBe("preferred");
  });
});

describe("JD decompiler in the job pipeline", () => {
  let cfg: AppConfig;
  let profile: Profile;
  beforeAll(() => {
    makeTempRoot();
    profile = loadProfile();
    cfg = testConfig();
  });
  const seed = (store: Store, jobId: string, text: string, status: "JD_FETCHED" | "MATCHED" = "JD_FETCHED") => {
    const now = new Date().toISOString();
    store.t.jobs.insert({
      jobId, source: "test", sourcesLabel: "test", externalJobId: null, companyId: null, companyName: "Acme", jobTitle: "Java Backend Developer", location: "Bengaluru, India", workMode: null, experienceRequired: null,
      salary: null, skills: [], postedDate: null, applyUrl: `https://acme.example/${jobId}`, jobUrl: `https://acme.example/${jobId}`, jdHash: "h", companyDomain: null, matchScore: null, matchReason: null,
      resumeVersionId: null, status, applicationAttempts: 0, requiresHuman: false, blockReason: null, lastError: null, createdAt: now, updatedAt: now, resumeFile: "", lastAttemptAt: null, appliedDate: null,
    });
    store.t.details.insert({ jobId, jdText: text, jdSource: "test", requirements: null, requirementsJdHash: null, match: null, matchProfileHash: null, matchedAt: null });
  };

  it("matching a job stores its JD intelligence next to the match, in a size the Sheet accepts", async () => {
    const { store, sheet } = await memStore();
    seed(store, "JOB-000001", jd("jd-java-backend.txt"));
    await matchJobs({ cfg, store, logger: logger(), profile, jdProviders: [], runId: null });
    await store.flush();
    const intel = getIntelligence(store, "JOB-000001");
    expect(intel).toMatchObject({ version: JD_DECOMPILER_VERSION });
    expect(intel?.mandatorySkills).toEqual(store.t.details.get("JOB-000001")?.requirements?.requiredSkills);
    expect(intel).not.toHaveProperty("text"); // the JD text is already in its own column
    const cell = JSON.stringify(intel);
    expect(cell.length).toBeLessThan(49_000);
    // Round-trips through the spreadsheet (new "JD Intelligence" column).
    const { Store: StoreClass } = await import("../../agent/store/sheetStore.ts");
    const reopened = await StoreClass.open(sheet);
    expect(getIntelligence(reopened, "JOB-000001")?.experience.value?.min).toBe(0);
  });

  it("backfills jobs matched before the decompiler existed; re-runs only when forced or outdated", async () => {
    const { store } = await memStore();
    seed(store, "JOB-000002", jd("jd-campus-india.txt"), "MATCHED");
    seed(store, "JOB-000003", jd("jd-experienced-sde2.txt"), "MATCHED");
    expect(decompileStored(store)).toMatchObject({ decompiled: 2, skipped: 0 });
    expect(decompileStored(store)).toMatchObject({ decompiled: 0, skipped: 2 });
    expect(decompileStored(store, { force: true })).toMatchObject({ decompiled: 2 });
    const stale = store.t.details.get("JOB-000002")?.intelligence;
    if (stale) store.t.details.update("JOB-000002", { intelligence: { ...stale, version: "jd-decompiler/0" } });
    expect(getIntelligence(store, "JOB-000002")).toBeNull();
    expect(decompileStored(store)).toMatchObject({ decompiled: 1 });
  });

});
