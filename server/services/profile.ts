import fs from "node:fs";
import path from "node:path";
import { AgentError } from "../../agent/core/errors.ts";
import { paths } from "../../agent/core/paths.ts";
import { parseAnswers } from "../../agent/questions/answersFile.ts";
import { loadQuestionBank, resolveAnswer } from "../../agent/questions/questionBank.ts";
import { PreferencesSchema } from "../../agent/profile/profile.ts";
import { AnswerBank } from "../answerBank.ts";
import type { AgentRuntime } from "../runtime.ts";

/**
 * Profile fields are "Key : Value" answers in Application_Answers.txt (the same file the agent reads), so editing the
 * profile here and editing the file are the same thing. A blank value falls back to your resume data where one exists.
 */
export const PROFILE_SECTIONS: Array<{ id: string; title: string; fields: Array<{ key: string; label?: string; hint?: string; multiline?: boolean }> }> = [
  { id: "identity", title: "Identity", fields: [{ key: "Full Name" }, { key: "First Name" }, { key: "Last Name" }, { key: "Preferred Name" }, { key: "Email" }, { key: "Contact Number", label: "Phone" }, { key: "Extension", label: "Country code" }, { key: "Country" }, { key: "State" }, { key: "City" }, { key: "Postal Code" }] },
  {
    id: "professional",
    title: "Professional",
    fields: [
      { key: "Current Company" },
      { key: "Current Job Title", label: "Current role" },
      { key: "Total Experience" },
      { key: "Java Experience", hint: "Answers only Java questions — never total experience" },
      { key: "Python Experience" },
      { key: "Frontend Experience" },
      { key: "Backend Experience" },
      { key: "SaaS Experience", hint: "Answers only SaaS questions" },
      { key: "Current Company Location" },
      { key: "Past Internships", multiline: true },
      { key: "Reason for Leaving", multiline: true },
    ],
  },
  { id: "education", title: "Education", fields: [{ key: "Highest Education" }, { key: "Field of Study" }, { key: "University / College" }, { key: "Graduation Year" }] },
  { id: "links", title: "Links", fields: [{ key: "LinkedIn" }, { key: "GitHub" }, { key: "Portfolio" }, { key: "Resume Link", hint: "A public link to your resume (e.g. Google Drive, shared as 'Anyone with the link'). Used when a form asks for a resume link instead of a file." }] },
  { id: "preferences", title: "Work preferences", fields: [{ key: "Remote Work" }, { key: "Hybrid Work" }, { key: "Onsite Work" }, { key: "Willing to Relocate" }, { key: "Willing to Relocate to Pune", hint: "City-specific relocation answers stay city-specific" }, { key: "Willing to Travel" }, { key: "Night Shift" }, { key: "Weekend Work" }] },
  { id: "compensation", title: "Compensation", fields: [{ key: "Current CTC" }, { key: "Expected CTC" }, { key: "Currency" }] },
  { id: "availability", title: "Availability", fields: [{ key: "Notice Period" }, { key: "Available From" }] },
  { id: "authorization", title: "Authorization", fields: [{ key: "Work Authorization" }, { key: "Require Sponsorship" }, { key: "Visa Status" }] },
];

export function profileView(rt: AgentRuntime): Record<string, unknown> {
  const text = rt.answers.text();
  const entries = new Map(parseAnswers(text).entries.map((e) => [e.canonicalKey, e]));
  const bank = loadQuestionBank(undefined, "__none__", null).records;
  const p = rt.profile;
  const sections = PROFILE_SECTIONS.map((s) => ({
    ...s,
    fields: s.fields.map((f) => {
      const id = AnswerBank.keyOf(f.key);
      const own = entries.get(id);
      const rec = bank.find((r) => r.canonicalKey === id);
      const fallback = rec ? resolveAnswer({ record: rec, confidence: 1, matchedPattern: "" }, p) : null;
      const value = own?.value ?? null;
      return {
        key: f.key,
        id,
        label: f.label ?? f.key,
        hint: f.hint ?? null,
        multiline: !!f.multiline,
        value,
        fallback: value === null && fallback?.value ? { value: fallback.value, source: rec?.answerRef?.startsWith("derived.") ? "RESUME" : "PROFILE", basis: fallback.basis } : null,
        inFile: !!own,
      };
    }),
  }));
  const conflicts = rt.questionIssues.filter((i) => i.startsWith("Application_Answers.txt"));
  return {
    sections,
    conflicts,
    myData: {
      personal: p.personal,
      experience: p.experience.map((e) => ({ company: e.company, role: e.role, type: e.type, startDate: e.startDate, endDate: e.endDate, current: e.current })),
      education: p.education.map((e) => ({ institution: e.institution, degree: e.degree, endDate: e.endDate })),
      projects: p.projects.map((x) => ({ name: x.name, technologies: x.technologies })),
      skills: Object.fromEntries(Object.entries(p.skills).map(([k, v]) => [k, v.map((s) => s.name)])),
      missing: p.missing,
    },
  };
}

export function saveProfile(rt: AgentRuntime, fields: Array<{ key: string; value: string }>): { saved: number; conflicts: string[] } {
  const allowed = new Set(PROFILE_SECTIONS.flatMap((s) => s.fields.map((f) => f.key)));
  let saved = 0;
  for (const f of fields) {
    if (!allowed.has(f.key)) throw new AgentError("VALIDATION_FAILED", `unknown profile field '${f.key}'`);
    if (typeof f.value !== "string" || f.value.length > 1000) throw new AgentError("VALIDATION_FAILED", `invalid value for '${f.key}'`);
    rt.answers.upsert(f.key, f.value);
    saved++;
  }
  rt.reloadKnowledge();
  return { saved, conflicts: rt.questionIssues.filter((i) => i.startsWith("Application_Answers.txt")) };
}

const PREFS = () => path.join(paths.myData(), "Preferences", "preferences.json");
const STRATEGY_KEYS = ["targetRoles", "targetRoleFamilies", "excludedRolePatterns", "preferredLocations", "excludedLocations", "experienceRange", "workModePreferences", "companyPreferences", "excludedJobTitleKeywords", "excludedTechnologies", "salaryPreferences", "willingToRelocate", "minMatchScore"] as const;

export function searchStrategy(rt: AgentRuntime): Record<string, unknown> {
  const prefs = rt.profile.preferences as unknown as Record<string, unknown>;
  return { ...Object.fromEntries(STRATEGY_KEYS.map((k) => [k, prefs[k] ?? null])), preferredTechnologies: [...new Set(Object.values(rt.profile.skills).flat().filter((s) => s.level === "verified").map((s) => s.name))] };
}

/** Writes the search strategy to MY_DATA/Preferences/preferences.json (validated; previous file kept as a backup). */
export function saveSearchStrategy(rt: AgentRuntime, patch: Record<string, unknown>, backupDir: string): Record<string, unknown> {
  const file = PREFS();
  const current = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  const next = { ...current };
  for (const k of STRATEGY_KEYS) if (k in patch) next[k] = patch[k];
  const { _help: _h, ...forSchema } = next;
  const parsed = PreferencesSchema.safeParse(forSchema);
  if (!parsed.success) throw new AgentError("VALIDATION_FAILED", `search strategy: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(file, path.join(backupDir, `preferences-${new Date().toISOString().replace(/[:.]/g, "-")}.json`));
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  rt.reloadKnowledge();
  return searchStrategy(rt);
}
