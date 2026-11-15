import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { paths } from "../core/paths.ts";
import { readJsonFile } from "../core/config.ts";
import { normalizeText, sha256 } from "../core/text.ts";
import type { SkillLevel } from "../core/schemas.ts";
import { noticeDays, readAnswersFile, yesNo } from "../questions/answersFile.ts";
import { detectSkills } from "../matching/skillCatalog.ts";

const nstr = z.string().nullable();

export const PersonalSchema = z.object({
  fullName: nstr,
  headline: nstr.optional().default(null),
  phone: nstr,
  email: nstr,
  city: nstr,
  state: nstr,
  country: nstr,
  linkedin: nstr,
  github: nstr,
  portfolio: nstr,
});

export const ProfessionalSchema = z.object({
  targetRoles: z.array(z.string()),
  summaryFacts: z.array(z.string()),
  softSkills: z.array(z.string()).default([]),
  /** Your own words on where you want your career to go (e.g. "Backend engineer at a product company within 2 years"). */
  careerGoals: z.array(z.string()).default([]),
  workPreferences: z.object({ locations: z.array(z.string()), remote: z.boolean().nullable(), hybrid: z.boolean().nullable(), onsite: z.boolean().nullable() }),
});

export const SKILL_CONTEXTS = ["listed", "professional", "internship", "project", "training"] as const;
const SkillSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  level: z.enum(["verified", "basic", "learning"]),
  contexts: z.array(z.enum(SKILL_CONTEXTS)),
  note: z.string().optional(),
});
export const SKILL_CATEGORIES = ["languages", "frontend", "backend", "frameworks", "databases", "ai", "devops", "tools", "other"] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];
export const SkillsSchema = z.object(Object.fromEntries(SKILL_CATEGORIES.map((c) => [c, z.array(SkillSchema).default([])])) as Record<SkillCategory, z.ZodDefault<z.ZodArray<typeof SkillSchema>>>);

export const ExperienceSchema = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      type: z.enum(["professional", "internship", "training"]),
      company: z.string(),
      role: z.string(),
      startDate: z.string().regex(/^\d{4}(-\d{2})?$/).nullable(),
      endDate: z.string().regex(/^\d{4}(-\d{2})?$/).nullable(),
      current: z.boolean(),
      location: nstr,
      verifiedResponsibilities: z.array(z.string()),
      verifiedTechnologies: z.array(z.string()),
    }),
  ),
});

export const ProjectsSchema = z.object({
  entries: z.array(
    z.object({ id: z.string(), name: z.string(), description: z.string(), technologies: z.array(z.string()), achievements: z.array(z.string()), links: z.array(z.string()) }),
  ),
});

export const EducationSchema = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      institution: z.string(),
      degree: z.string(),
      level: z.enum(["doctorate", "masters", "bachelors", "diploma", "higher_secondary", "secondary"]),
      startDate: nstr,
      endDate: nstr,
      cgpaOrPercentage: nstr,
      verified: z.boolean(),
    }),
  ),
});

export const CertificationsSchema = z.object({
  entries: z.array(z.object({ id: z.string(), name: z.string(), issuer: nstr, date: nstr, credentialUrl: nstr })),
  achievements: z.array(z.object({ id: z.string(), name: z.string(), context: z.string(), date: nstr })).default([]),
});

export const PreferencesSchema = z.object({
  targetRoles: z.array(z.string()),
  /** Optional override of the role families derived from targetRoles (see agent/matching/roleClassifier.ts). */
  targetRoleFamilies: z.array(z.string()).nullable().default(null),
  /** Regexes (case-insensitive) on the job title; a match makes the role incompatible. */
  excludedRolePatterns: z.array(z.string()).default([]),
  preferredLocations: z.array(z.string()),
  excludedLocations: z.array(z.string()),
  minMatchScore: z.number().nullable(),
  fresherAllowed: z.boolean().nullable(),
  experienceLevel: nstr,
  experienceRange: z.object({ minYears: z.number().nullable(), maxYears: z.number().nullable() }),
  salaryPreferences: z.object({ currency: nstr, expectedAnnual: z.number().nullable(), minimumAnnual: z.number().nullable(), negotiable: z.boolean().nullable() }),
  noticePeriodDays: z.number().nullable(),
  willingToRelocate: z.boolean().nullable(),
  companyPreferences: z.object({ excludedCompanies: z.array(z.string()), preferredCompanies: z.array(z.string()) }),
  excludedJobTitleKeywords: z.array(z.string()),
  excludedTechnologies: z.array(z.string()),
  workModePreferences: z.object({ remote: z.boolean().nullable(), hybrid: z.boolean().nullable(), onsite: z.boolean().nullable() }),
});

export type Skill = z.infer<typeof SkillSchema> & { category: SkillCategory };

export interface Profile {
  personal: z.infer<typeof PersonalSchema>;
  professional: z.infer<typeof ProfessionalSchema>;
  skills: Record<SkillCategory, Skill[]>;
  experience: z.infer<typeof ExperienceSchema>["entries"];
  projects: z.infer<typeof ProjectsSchema>["entries"];
  education: z.infer<typeof EducationSchema>["entries"];
  certifications: z.infer<typeof CertificationsSchema>;
  preferences: z.infer<typeof PreferencesSchema>;
  /** Hash of all MY_DATA content — stored with every match so stale scores are detectable. */
  hash: string;
  missing: string[];
}

const FILES = {
  personal: ["Personal", "profile.json"],
  professional: ["Professional", "professional.json"],
  skills: ["Skills", "skills.json"],
  experience: ["Experience", "experience.json"],
  projects: ["Projects", "projects.json"],
  education: ["Education", "education.json"],
  certifications: ["Certifications", "certifications.json"],
  preferences: ["Preferences", "preferences.json"],
} as const;

export function loadProfile(dir = paths.myData()): Profile {
  const f = (k: keyof typeof FILES) => path.join(dir, ...FILES[k]);
  const personal = readJsonFile(f("personal"), PersonalSchema);
  const professional = readJsonFile(f("professional"), ProfessionalSchema);
  const skillsRaw = readJsonFile(f("skills"), SkillsSchema);
  const experience = readJsonFile(f("experience"), ExperienceSchema).entries;
  const projects = readJsonFile(f("projects"), ProjectsSchema).entries;
  const education = readJsonFile(f("education"), EducationSchema).entries;
  const certifications = readJsonFile(f("certifications"), CertificationsSchema);
  const preferences = readJsonFile(f("preferences"), PreferencesSchema);

  const skills = Object.fromEntries(SKILL_CATEGORIES.map((c) => [c, skillsRaw[c].map((s) => ({ ...s, category: c }))])) as Record<SkillCategory, Skill[]>;
  // The user's Application_Answers.txt also states preferences that matching uses (work modes, relocation, notice).
  const answers = dir === paths.myData() ? readAnswersFile() : null;
  const said = (k: string) => answers?.entries.find((e) => e.canonicalKey === k)?.value ?? null;
  for (const [key, mode] of [["remote_work", "remote"], ["hybrid_work", "hybrid"], ["onsite_work", "onsite"]] as const) {
    const v = yesNo(said(key));
    if (v !== null) preferences.workModePreferences[mode] = v;
  }
  const relocate = yesNo(said("willing_to_relocate"));
  if (relocate !== null) preferences.willingToRelocate = relocate;
  const notice = noticeDays(said("notice_period"));
  if (notice !== null) preferences.noticePeriodDays = notice;
  const hash = sha256(Object.keys(FILES).map((k) => fs.readFileSync(f(k as keyof typeof FILES), "utf8")).join("\n") + (answers?.text ?? ""));

  const missing: string[] = [];
  for (const [k, v] of Object.entries(personal)) if (v === null) missing.push(`personal.${k}`);
  for (const e of experience) {
    if (!e.location) missing.push(`experience.${e.id}.location`);
    if (!e.startDate) missing.push(`experience.${e.id}.startDate`);
  }
  for (const [k, v] of Object.entries(preferences.workModePreferences)) if (v === null) missing.push(`preferences.workModePreferences.${k}`);
  if (preferences.salaryPreferences.expectedAnnual === null && !said("expected_ctc")) missing.push("preferences.salaryPreferences.expectedAnnual");
  if (preferences.noticePeriodDays === null) missing.push("preferences.noticePeriodDays");
  if (preferences.willingToRelocate === null) missing.push("preferences.willingToRelocate");

  return { personal, professional, skills, experience, projects, education, certifications, preferences, hash, missing };
}

export function allSkills(p: Profile): Skill[] {
  return SKILL_CATEGORIES.flatMap((c) => p.skills[c]);
}

export interface SkillEvidence {
  skill: Skill;
  level: Exclude<SkillLevel, "unknown" | "missing">;
}

/** Lookup of normalized skill names/aliases → the profile skill that evidences it. */
export class SkillIndex {
  private readonly map = new Map<string, Skill>();
  constructor(profile: Profile) {
    for (const s of allSkills(profile)) {
      for (const key of [s.name, ...s.aliases, stripVersion(s.name)]) {
        const k = normalizeSkillKey(key);
        if (k && !this.map.has(k)) this.map.set(k, s);
      }
    }
    // Job descriptions are read with the skill catalog's standard names ("React", "REST APIs"); your resume may say
    // "React.js" or "Django REST Framework". Register each of your skills under the standard name(s) it implies too.
    // The closest name wins: "React.js" stands for React before "React Router" does.
    const base = (n: string) => normalizeSkillKey(n).replace(/js$/, "");
    const implied = allSkills(profile).flatMap((s) => [s.name, ...s.aliases].flatMap((n) => detectSkills(n).map((canonical) => ({ s, canonical, exact: base(n) === base(canonical) }))));
    for (const { s, canonical } of [...implied.filter((x) => x.exact), ...implied.filter((x) => !x.exact)]) {
      const k = normalizeSkillKey(canonical);
      if (k && !this.map.has(k)) this.map.set(k, s);
    }
  }
  lookup(name: string): SkillEvidence | null {
    const k = normalizeSkillKey(name);
    const s = this.map.get(k) ?? this.map.get(normalizeSkillKey(stripVersion(name)));
    return s ? { skill: s, level: s.level } : null;
  }
  has(name: string): boolean {
    return this.lookup(name) !== null;
  }
}

export function stripVersion(s: string): string {
  return s.replace(/\s+\d+(\.\d+)*\s*$/, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
}

export function normalizeSkillKey(s: string): string {
  return normalizeText(s).replace(/\s*\.\s*js\b/g, "js").replace(/\bjs\b/g, "js").replace(/[\s.]+/g, "");
}

/** Total months of *professional* (non-internship, non-training) experience from verified dates only. */
export function professionalMonths(p: Profile, asOf = new Date()): { months: number; basis: string[] } {
  const basis: string[] = [];
  let months = 0;
  for (const e of p.experience) {
    if (e.type !== "professional" || !e.startDate) continue;
    const [sy, sm] = e.startDate.split("-").map(Number);
    const end = e.current ? { y: asOf.getUTCFullYear(), m: asOf.getUTCMonth() + 1 } : e.endDate ? { y: Number(e.endDate.split("-")[0]), m: Number(e.endDate.split("-")[1] ?? 12) } : null;
    if (!end || !sy) continue;
    const m = (end.y - sy) * 12 + (end.m - (sm ?? 1)) + 1;
    if (m > 0) {
      months += m;
      basis.push(`${e.company} ${e.startDate}–${e.current ? "present" : e.endDate}: ${m} months`);
    }
  }
  return { months, basis };
}
