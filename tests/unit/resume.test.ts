import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { findMarkers, latexEscape, outsideMarkers, patchMarkers, validateLatex } from "../../agent/resume/latex.ts";
import { approveTemplate, assertTemplateApproved } from "../../agent/resume/templateGuard.ts";
import { renderAll } from "../../agent/resume/renderer.ts";
import { buildResumePlan } from "../../agent/resume/planner.ts";
import { noTemplateOwnerData, texChecks } from "../../agent/resume/resumeValidation.ts";
import { validateAiSummary } from "../../agent/resume/generator.ts";
import { analyzeJd } from "../../agent/matching/jdAnalyzer.ts";
import { matchJob } from "../../agent/matching/matcher.ts";
import { loadProfile } from "../../agent/profile/profile.ts";
import { AgentError } from "../../agent/core/errors.ts";
import { FIXTURES, makeTempRoot, testConfig } from "../helpers.ts";

let root: string;
beforeEach(() => {
  root = makeTempRoot();
});
const template = () => fs.readFileSync(path.join(root, "Data_Resume/Resume_Template/master.tex"), "utf8");

describe("LaTeX primitives", () => {
  it("escapes special characters", () => {
    expect(latexEscape("R&D 100% $5 #1 a_b {x} ~^\\")).toBe("R\\&D 100\\% \\$5 \\#1 a\\_b \\{x\\} \\textasciitilde{}\\textasciicircum{}\\textbackslash{}");
  });
  it("master template is structurally valid and contains no personal data", () => {
    const t = template();
    expect(validateLatex(t)).toMatchObject({ ok: true });
    expect(findMarkers(t).map((m) => m.name)).toEqual(["HEADER", "SUMMARY", "SKILLS", "EXPERIENCE", "PROJECTS", "EDUCATION", "CERTIFICATIONS"]);
    expect(t).not.toMatch(/@[a-z0-9-]+\.(com|in)|\+91|linkedin\.com\/in|github\.com\//i);
    expect(noTemplateOwnerData(t).ok).toBe(true);
  });
  it("patching changes only marker regions", () => {
    const t = template();
    const out = patchMarkers(t, { SUMMARY: "Hello \\& world" });
    expect(outsideMarkers(out)).toBe(outsideMarkers(t));
    expect(out).toContain("Hello \\& world");
  });
  it("detects broken LaTeX", () => {
    expect(validateLatex("\\documentclass{article}\\begin{document}{\\end{document}").ok).toBe(false);
    expect(() => patchMarkers("% === AUTO: X START ===\n", { X: "y" })).toThrowError(AgentError);
  });
});

describe("template protection", () => {
  it("records a baseline, then refuses a modified template until approved", () => {
    const file = path.join(root, "Data_Resume/Resume_Template/master.tex");
    assertTemplateApproved(file);
    fs.appendFileSync(file, "\n% edited\n");
    expect(() => assertTemplateApproved(file)).toThrowError(/changed since it was approved/);
    approveTemplate(file, "test");
    expect(() => assertTemplateApproved(file)).not.toThrow();
  });
});

describe("tailored resume", () => {
  const build = () => {
    const cfg = testConfig();
    const profile = loadProfile();
    const jd = fs.readFileSync(path.join(FIXTURES, "jobs", "jd-java-backend.txt"), "utf8");
    const reqs = analyzeJd({ jdText: jd, jobTitle: "Java Backend Developer", location: "Bengaluru", workMode: null });
    const match = matchJob({ jobTitle: "Java Backend Developer", companyName: "Acme", location: "Bengaluru", workMode: null, jdText: jd }, reqs, profile, cfg.matching, new Date("2026-09-30"));
    const plan = buildResumePlan({ jobId: "JOB-000001", jobTitle: "Java Backend Developer", companyName: "Acme" }, reqs, match, profile, cfg.resume.generationRules);
    const tex = patchMarkers(template(), renderAll(profile, plan, cfg.resume));
    return { cfg, profile, plan, tex };
  };

  it("passes all tex checks and contains the user's identity", () => {
    const { cfg, profile, tex } = build();
    const checks = texChecks(template(), tex, profile, cfg.resume.allowedSections);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(tex).toContain("ASHA RAO");
    expect(tex).toContain("candidate@example.com");
    expect(tex).toContain("\\resumeSubheading");
  });

  it("does not add JD skills that are missing from MY_DATA", () => {
    const { plan, tex } = build();
    expect(plan.skillsNotSupported).toEqual(expect.arrayContaining(["Kubernetes", "Kafka"]));
    expect(tex).not.toMatch(/Kubernetes|Kafka/);
  });

  it("keeps basic/learning labels and internship labels", () => {
    const { tex } = build();
    expect(tex).toContain("Python (Basics)");
    expect(tex).toContain("Microservices (Learning)");
    expect(tex).toContain("Java Full Stack Intern");
  });

  it("puts JD-relevant skills first", () => {
    const { plan } = build();
    expect(plan.skillsToEmphasize.slice(0, 5)).toEqual(expect.arrayContaining(["Core Java 21", "Spring Boot"]));
  });

  it("fails validation if a template owner's data or a fabricated skill appears", () => {
    const { cfg, profile, tex } = build();
    const leaked = patchMarkers(tex, { SUMMARY: "Built with Kubernetes. Contact MADHUSUDHAN." });
    const failed = texChecks(template(), leaked, profile, cfg.resume.allowedSections).filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(expect.arrayContaining(["facts.no_unsupported_skills", "identity.no_template_owner_data"]));
  });

  it("rejects AI summaries that add technologies, numbers or seniority", () => {
    const p = loadProfile();
    expect(validateAiSummary("Full Stack Developer with Kubernetes and 5 years of experience.", p).ok).toBe(false);
    expect(validateAiSummary("Full Stack Developer building production applications with Java, Spring Boot and React.", p).ok).toBe(true);
  });
});
