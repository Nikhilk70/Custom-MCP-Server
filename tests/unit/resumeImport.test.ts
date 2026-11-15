import { describe, expect, it } from "vitest";
import { patternFields } from "../../server/services/resumeAutofill.ts";
import { repairLigatures, tidyCase, toMyData } from "../../server/services/resumeImport.ts";

describe("resume pattern fields", () => {
  // Two-column PDFs glue link targets onto the visible text.
  const glued = [
    "ASHA RAO",
    "LINKhtthttps://github.com/someone-else/BookMyVenue.git",
    "Mobile : +91 9123456780",
    "Email : asha.rao@example.comasha.rao@example.comhttps://github.com/asharaohttps://www.linkedin.com/in/asha-rao-123/",
  ].join("\n");

  it("separates an e-mail from text glued after it", () => {
    expect(patternFields(glued).Email).toBe("asha.rao@example.com");
  });
  it("takes your GitHub profile, not someone else's repository link", () => {
    expect(patternFields(glued).GitHub).toBe("https://github.com/asharao");
  });
  it("splits the phone into country code and number", () => {
    const f = patternFields(glued);
    expect(f.Extension).toBe("+91");
    expect(f["Contact Number"]).toBe("9123456780");
  });
  it("title-cases an all-caps name", () => {
    expect(patternFields(glued)["Full Name"]).toBe("Asha Rao");
  });
});

describe("tidyCase", () => {
  it("title-cases ALL CAPS but keeps short acronyms", () => {
    expect(tidyCase("ACME TRADERS LLP")).toBe("Acme Traders LLP");
    expect(tidyCase("FRONTEND DEVELOPER (INTERNSHIP)")).toBe("Frontend Developer (Internship)");
  });
  it("leaves text that already has lowercase letters alone", () => {
    expect(tidyCase("Acme Traders LLP")).toBe("Acme Traders LLP");
  });
});

describe("toMyData", () => {
  const files = toMyData(
    {
      personal: { fullName: "Asha Rao", email: "a@b.com" },
      summaryFacts: ["Builds web apps."],
      targetRoles: [],
      softSkills: ["Teamwork", "JavaScript"],
      skills: [{ name: "JavaScript", category: "languages", level: "verified", contexts: ["listed"] }],
      experience: [{ type: "professional", company: "ACME CORP", role: "FRONTEND DEVELOPER", startDate: "2025-06", endDate: null, current: true, location: null, responsibilities: ["Did things"], technologies: ["React.js", "JavaScript"] }],
      projects: [{ name: "Shop", description: null, technologies: ["Django", "PostgreSQL"], achievements: [], links: [] }],
      education: [{ institution: "East West College", degree: "Bachelor of Business Administration", level: null, startDate: "2019-06", endDate: "2022-09", score: null }],
      certifications: [],
      achievements: [],
    },
    { professional: { careerGoals: ["Lead a frontend team"] } },
    { file: "Data_Resume/Source/resume.pdf", at: "2026-10-02T00:00:00Z" },
  );
  type SkillRow = { name: string; contexts: string[] };
  const skills = files["Skills/skills.json"] as Record<string, SkillRow[]>;
  const all: SkillRow[] = Object.values(skills).flatMap((v) => (Array.isArray(v) ? v : []));

  it("adds technologies used in jobs and projects as evidenced skills", () => {
    expect(all.find((s) => s.name === "PostgreSQL")?.contexts).toEqual(["project"]);
    expect(all.find((s) => s.name === "JavaScript")?.contexts).toEqual(["listed", "professional"]);
    expect(skills.databases?.map((s) => s.name)).toContain("PostgreSQL");
  });
  it("drops technical items listed as soft skills and keeps your career goals", () => {
    const pro = files["Professional/professional.json"] as { softSkills: string[]; careerGoals: string[] };
    expect(pro.softSkills).toEqual(["Teamwork"]);
    expect(pro.careerGoals).toEqual(["Lead a frontend team"]);
  });
  it("normalises capitals and infers the education level", () => {
    const exp = (files["Experience/experience.json"] as { entries: Array<{ company: string; role: string; current: boolean }> }).entries[0];
    expect(exp).toMatchObject({ company: "Acme Corp", role: "Frontend Developer", current: true });
    expect((files["Education/education.json"] as { entries: Array<{ level: string }> }).entries[0]?.level).toBe("bachelors");
  });
});

describe("repairLigatures", () => {
  it("restores letters a PDF text layer lost, using the spelling read from the rendered resume", () => {
    const broken = "work�low automation, Pro�icient, e�cient, �ltering";
    expect(repairLigatures(broken, "workflow proficient efficient filtering")).toBe("workflow automation, Proficient, efficient, filtering");
  });
});

describe("tailored resume skill check", () => {
  it("does not read a project's .git link as the skill Git", async () => {
    const { noFabricatedSkills } = await import("../../agent/resume/resumeValidation.ts");
    const { loadProfile } = await import("../../agent/profile/profile.ts");
    const { makeTempRoot } = await import("../helpers.ts");
    makeTempRoot();
    const tex = "% === AUTO: PROJECTS START ===\n{\\href{https://github.com/someone/BookMyVenue.git}{\\underline{Source Code}}}\n% === AUTO: PROJECTS END ===";
    const c = noFabricatedSkills(tex, loadProfile(), ["PROJECTS"]);
    expect(c.detail).not.toMatch(/\bGit\b/);
  });
});
