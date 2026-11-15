import fs from "node:fs";
import path from "node:path";
import { paths } from "../core/paths.ts";
import type { Profile } from "./profile.ts";
import { allSkills, stripVersion } from "./profile.ts";

export interface ProfileVerification {
  sourceFile: string;
  checked: number;
  verified: number;
  unverified: Array<{ field: string; value: string }>;
  missing: string[];
}

/** Collapse text for tolerant substring checks: drop whitespace/punctuation variance and PDF bullet artifacts. */
function squash(s: string): string {
  return s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/https?:\/\/(www\.)?/g, "")
    .replace(/[–—‒–—]/g, "-")
    .replace(/[^a-z0-9%+#]/g, "");
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function dateForms(ym: string): string[] {
  const [y, m] = ym.split("-");
  if (!m) return [y!];
  const name = MONTHS[Number(m) - 1] ?? "";
  return [ym, `${name} ${y}`, `${name.slice(0, 3)} ${y}`, `${m}/${y}`, `${Number(m)}/${y}`];
}

/**
 * Proves MY_DATA was not fabricated: every factual string must appear in the extracted resume text
 * (Data_Resume/Source/resume.txt) or its hyperlink list. Values with an explicit `_derived` note
 * (country, target roles, preferences) are reported separately, not silently accepted.
 */
export function verifyProfileAgainstSource(profile: Profile, sourceDir = paths.resumeSource()): ProfileVerification {
  const txtFile = path.join(sourceDir, "resume.txt");
  const metaFile = path.join(sourceDir, "resume.meta.json");
  if (!fs.existsSync(txtFile)) throw new Error(`Missing ${txtFile}. Run: python scripts/extract_resume_text.py <resume.pdf> Data_Resume/Source`);
  const text = fs.readFileSync(txtFile, "utf8");
  const links = fs.existsSync(metaFile) ? ((JSON.parse(fs.readFileSync(metaFile, "utf8")) as { links?: string[] }).links ?? []) : [];
  const haystack = squash(text + "\n" + links.join("\n"));

  const facts: Array<{ field: string; value: string }> = [];
  const add = (field: string, value: string | null | undefined) => {
    if (value) facts.push({ field, value });
  };
  const p = profile.personal;
  add("personal.fullName", p.fullName);
  add("personal.headline", p.headline);
  add("personal.phone", p.phone);
  add("personal.email", p.email);
  add("personal.city", p.city);
  add("personal.state", p.state);
  add("personal.linkedin", p.linkedin);
  add("personal.github", p.github);
  add("personal.portfolio", p.portfolio);
  profile.professional.summaryFacts.forEach((s, i) => add(`professional.summaryFacts[${i}]`, s));
  profile.professional.softSkills.forEach((s, i) => add(`professional.softSkills[${i}]`, s));
  for (const e of profile.experience) {
    add(`experience.${e.id}.company`, e.company);
    add(`experience.${e.id}.role`, e.role.replace(/\s*\(.*\)$/, ""));
    add(`experience.${e.id}.location`, e.location);
    e.verifiedResponsibilities.forEach((r, i) => add(`experience.${e.id}.responsibilities[${i}]`, r));
  }
  for (const pr of profile.projects) {
    add(`projects.${pr.id}.name`, pr.name);
    pr.achievements.forEach((a, i) => add(`projects.${pr.id}.achievements[${i}]`, a));
    pr.links.forEach((l, i) => add(`projects.${pr.id}.links[${i}]`, l.replace(/\.git$/, "")));
  }
  for (const ed of profile.education) {
    add(`education.${ed.id}.institution`, ed.institution);
    add(`education.${ed.id}.degree`, ed.degree);
    add(`education.${ed.id}.cgpaOrPercentage`, ed.cgpaOrPercentage);
    add(`education.${ed.id}.dates`, ed.startDate && ed.endDate ? `${ed.startDate}-${ed.endDate}` : null);
  }
  for (const c of profile.certifications.entries) {
    add(`certifications.${c.id}.name`, c.name);
    add(`certifications.${c.id}.issuer`, c.issuer);
    add(`certifications.${c.id}.date`, c.date);
    add(`certifications.${c.id}.credentialUrl`, c.credentialUrl);
  }
  for (const a of profile.certifications.achievements) add(`achievements.${a.id}`, `${a.name}`);
  for (const s of allSkills(profile)) {
    // A skill is verified if its name, an alias, or its un-versioned name appears in the source.
    const candidates = [s.name, stripVersion(s.name), ...s.aliases];
    const hit = candidates.find((c) => haystack.includes(squash(c)));
    facts.push({ field: `skills.${s.category}.${s.name}`, value: hit ?? s.name });
  }

  // "2019-06-2022-09" is verified when each end appears in any common written form ("June 2019", "Jun 2019", "06/2019").
  const dateFound = (v: string) => {
    const ends = v.match(/^(\d{4}(?:-\d{2})?)-(\d{4}(?:-\d{2})?)$/);
    return !!ends && [ends[1]!, ends[2]!].every((d) => dateForms(d).some((f) => haystack.includes(squash(f))));
  };
  const unverified = facts.filter((f) => !haystack.includes(squash(f.value)) && !(f.field.endsWith(".dates") && dateFound(f.value)));
  return { sourceFile: txtFile, checked: facts.length, verified: facts.length - unverified.length, unverified, missing: profile.missing };
}
