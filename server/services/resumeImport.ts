import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AgentError } from "../../agent/core/errors.ts";
import type { AIProvider } from "../../agent/core/interfaces.ts";
import { paths } from "../../agent/core/paths.ts";
import { CertificationsSchema, EducationSchema, ExperienceSchema, PersonalSchema, ProfessionalSchema, ProjectsSchema, SKILL_CATEGORIES, SKILL_CONTEXTS, SkillsSchema, professionalMonths, loadProfile } from "../../agent/profile/profile.ts";
import { parseAnswers } from "../../agent/questions/answersFile.ts";
import { AnswerBank } from "../answerBank.ts";
import type { AgentRuntime } from "../runtime.ts";
import { patternFields, pdfText } from "./resumeAutofill.ts";

/**
 * Makes an uploaded resume the source of truth: rewrites MY_DATA (everything except Preferences), Data_Resume/Source
 * and the resume-derived answers in Application_Answers.txt from what the resume says. Every file that is replaced is
 * backed up first, and an import can be undone. Your preferences and personal answers (CTC, notice, visa, work mode…)
 * are never touched — a resume does not state them.
 */
export interface ImportResult {
  importId: string;
  resumeId: string;
  importedAt: string;
  counts: { experience: number; projects: number; education: number; certifications: number; skills: number };
  answersUpdated: string[];
  name: string | null;
}

const MY_DATA_FILES = ["Personal/profile.json", "Professional/professional.json", "Skills/skills.json", "Experience/experience.json", "Projects/projects.json", "Education/education.json", "Certifications/certifications.json"];
const SOURCE_FILES = ["resume.pdf", "resume.txt", "resume.meta.json"];

const str = z.string().nullish().transform((v) => (v && v.trim() && !/^(null|n\/a|none)$/i.test(v.trim()) ? v.trim() : null));
const strs = z.array(z.string()).nullish().transform((v) => (v ?? []).map((s) => s.trim()).filter(Boolean));
const ym = str.transform((v) => {
  if (!v) return null;
  const m = v.match(/^(\d{4})(?:-(\d{1,2}))?/);
  return m ? (m[2] ? `${m[1]}-${m[2].padStart(2, "0")}` : m[1]!) : null;
});
const Extracted = z.object({
  personal: z.object({ fullName: str, headline: str, phone: str, email: str, city: str, state: str, country: str, linkedin: str, github: str, portfolio: str }).partial().nullish(),
  summaryFacts: strs,
  targetRoles: strs,
  softSkills: strs,
  skills: z.array(z.object({ name: z.string(), category: z.string().nullish(), level: z.string().nullish(), contexts: strs })).nullish(),
  experience: z.array(z.object({ type: str, company: z.string(), role: z.string(), startDate: ym, endDate: ym, current: z.boolean().nullish(), location: str, responsibilities: strs, technologies: strs })).nullish(),
  projects: z.array(z.object({ name: z.string(), description: str, technologies: strs, achievements: strs, links: strs })).nullish(),
  education: z.array(z.object({ institution: z.string(), degree: z.string(), level: str, startDate: ym, endDate: ym, score: str })).nullish(),
  certifications: z.array(z.object({ name: z.string(), issuer: str, date: str, url: str })).nullish(),
  achievements: z.array(z.object({ name: z.string(), context: str, date: str })).nullish(),
});
type Extracted = z.infer<typeof Extracted>;

const PROMPT = `You convert the attached resume PDF into structured JSON. Use ONLY facts written in the resume — never infer, embellish or add skills.
Read the layout visually (columns, sections): each bullet belongs to the job or project it is printed under.
Write names, titles, companies, projects and institutions in normal capitalisation (e.g. "Frontend Developer", "Acme Traders LLP") even when the resume uses ALL CAPS; keep acronyms (LLP, API, UI) uppercase. Copy bullets verbatim.
Return ONLY a JSON object of this shape (omit nothing; use null or [] when absent):
{
 "personal": {"fullName","headline","phone" (with country code, e.g. "+91 9876543210"),"email","city","state","country","linkedin","github","portfolio" (full https URLs)},
 "summaryFacts": [short factual sentences from the summary/objective],
 "targetRoles": [job titles the resume says it targets, e.g. its headline],
 "softSkills": [soft skills listed explicitly],
 "skills": [{"name","category": one of ${JSON.stringify(SKILL_CATEGORIES)},"level": "verified" | "basic" (marked basics/beginner) | "learning" (marked learning),"contexts": subset of ${JSON.stringify(SKILL_CONTEXTS)} — "listed" if in a skills section, plus where it was used}] (include every technology named anywhere: summary, experience, projects),
 "experience": [{"type": "professional"|"internship"|"training","company","role","startDate": "YYYY-MM","endDate": "YYYY-MM" or null,"current": true if present/current,"location","responsibilities": [bullets verbatim],"technologies": [named in that role]}],
 "projects": [{"name","description","technologies","achievements": [bullets verbatim],"links"}],
 "education": [{"institution" (name only, no city),"degree","level": "doctorate"|"masters"|"bachelors"|"diploma"|"higher_secondary"|"secondary","startDate","endDate","score"}],
 "certifications": [{"name","issuer","date","url"}],
 "achievements": [{"name","context","date"}]
}`;

/** Reads resume text into the structured shape above (model for structure, patterns for exact contact details). */
export async function extractResume(ai: AIProvider, text: string, pdf?: Buffer): Promise<Extracted> {
  const prompt = pdf
    ? `${PROMPT}\n\nThe resume's raw text layer follows only so you can copy exact URLs and e-mail addresses (it may be out of order, with link targets glued to words):\n${text.slice(0, 20000)}`
    : `${PROMPT}\n\nRESUME:\n${text.slice(0, 30000)}`;
  const raw = await ai.generateText(prompt, { maxOutputTokens: 32768, temperature: 0, json: true, files: pdf ? [{ mimeType: "application/pdf", data: pdf }] : [] });
  let extracted: Extracted;
  try {
    // U+FFFD is an unreadable glyph (often an "fi"/"fl" ligature or a symbol) — never real resume content.
    extracted = Extracted.parse(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1).replace(/�/g, "")));
  } catch (e) {
    throw new AgentError("PARSER_FAILED", `the AI's reading of the resume was not usable (${e instanceof Error ? e.message.slice(0, 200) : String(e)}) — try again`);
  }
  const pat = patternFields(text);
  extracted.personal = { ...extracted.personal, ...(pat.Email ? { email: pat.Email } : {}), ...(pat.LinkedIn ? { linkedin: pat.LinkedIn } : {}), ...(pat.GitHub ? { github: pat.GitHub } : {}) };
  if (extracted.personal.fullName && extracted.personal.fullName === extracted.personal.fullName.toUpperCase() && pat["Full Name"]) extracted.personal.fullName = pat["Full Name"];
  if (!extracted.personal.fullName || !(extracted.experience?.length || extracted.education?.length)) throw new AgentError("VALIDATION_FAILED", "this does not look like a resume (no name, experience or education found)");
  return extracted;
}

const SMALL = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with", "my"]);
/** "ACME TRADERS LLP" → "Acme Traders LLP"; text with any lowercase letter is left as written. */
export function tidyCase(v: string): string {
  if (/[a-z]/.test(v) || !/[A-Z]{2}/.test(v)) return v;
  return v
    .split(/(\s+|[-/(),|])/)
    .map((w, i) => (!/^[A-Z]+$/.test(w) ? w : w.length <= 3 && !SMALL.has(w.toLowerCase()) ? w : i > 0 && SMALL.has(w.toLowerCase()) ? w.toLowerCase() : w[0] + w.slice(1).toLowerCase()))
    .join("");
}

/**
 * PDFs often lose "fi"/"fl"/"ff" ligatures in their text layer ("work�low", "Pro�icient"). The source text must match
 * MY_DATA word for word (verify-profile checks every fact against it), so each broken word is repaired with the
 * spelling found in the data read from the rendered PDF.
 */
export function repairLigatures(text: string, known: string): string {
  const vocab = new Set(known.toLowerCase().match(/[a-z]+/g) ?? []);
  return text.replace(/([A-Za-z]*)�([A-Za-z]*)/g, (_m, a: string, b: string) => {
    for (const lig of ["f", "fi", "fl", "ff", "ffi", "ffl"]) if (vocab.has(`${a}${lig}${b}`.toLowerCase())) return `${a}${lig}${b}`;
    return `${a}f${b}`;
  });
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "x";
const uniqueIds = <T>(items: T[], prefix: string, key: (t: T) => string): Array<T & { id: string }> => {
  const seen = new Set<string>();
  return items.map((t) => {
    let id = `${prefix}-${slug(key(t))}`;
    for (let i = 2; seen.has(id); i++) id = `${prefix}-${slug(key(t))}${i}`;
    seen.add(id);
    return { ...t, id };
  });
};
const LEVELS = ["doctorate", "masters", "bachelors", "diploma", "higher_secondary", "secondary"] as const;
const guessLevel = (degree: string): (typeof LEVELS)[number] =>
  /ph\.?d|doctor/i.test(degree) ? "doctorate" : /master|m\.?tech|m\.?sc|mca|mba|m\.?e\b/i.test(degree) ? "masters" : /bachelor|b\.?tech|b\.?e\b|b\.?sc|bca|bba|b\.?com/i.test(degree) ? "bachelors" : /diploma/i.test(degree) ? "diploma" : /higher secondary|12th|puc|hsc|vhse|intermediate/i.test(degree) ? "higher_secondary" : "secondary";

const guessCategory = (t: string): (typeof SKILL_CATEGORIES)[number] =>
  /sql|mongo|redis|oracle|sqlite|dynamo|firebase|supabase|cassandra|maria/i.test(t)
    ? "databases"
    : /react|angular|vue|next|svelte|html|css|bootstrap|tailwind|jquery|redux|font awesome|router|context api|local storage/i.test(t)
      ? "frontend"
      : /django|flask|fastapi|express|spring|node|drf|rest|graphql|servlet|jsp|hibernate|laravel/i.test(t)
        ? "backend"
        : /docker|aws|azure|gcp|kubernetes|jenkins|vercel|netlify|heroku|pythonanywhere|nginx|ci\/cd/i.test(t)
          ? "devops"
          : /git|figma|postman|jira|vs ?code|eclipse/i.test(t)
            ? "tools"
            : /tensorflow|keras|pytorch|llm|gpt|gemini|rag|openai|ml\b|nlp/i.test(t)
              ? "ai"
              : /^(java|javascript|typescript|python|c\+\+|c#|c|go|rust|kotlin|php|ruby|swift)$/i.test(t)
                ? "languages"
                : "other";

/** Turns the model's output into MY_DATA files, each validated against the same schema the agent loads. */
export function toMyData(x: Extracted, prev: { professional: Record<string, unknown> | null }, source: { file: string; at: string }) {
  const meta = { _source: { file: source.file, extractedAt: source.at.slice(0, 10) } };
  const p = x.personal ?? {};
  const personal = PersonalSchema.parse({ fullName: p.fullName ?? null, headline: p.headline ?? null, phone: p.phone ?? null, email: p.email ?? null, city: p.city ?? null, state: p.state ?? null, country: p.country ?? null, linkedin: p.linkedin ?? null, github: p.github ?? null, portfolio: p.portfolio ?? null });
  const prevPro = (prev.professional ?? {}) as { careerGoals?: string[]; workPreferences?: unknown };
  const professional = ProfessionalSchema.parse({
    targetRoles: x.targetRoles.length ? x.targetRoles : p.headline ? [p.headline] : [],
    summaryFacts: x.summaryFacts,
    softSkills: [] as string[],
    careerGoals: prevPro.careerGoals ?? [],
    workPreferences: prevPro.workPreferences ?? { locations: [], remote: null, hybrid: null, onsite: null },
  });
  const skills: Record<string, unknown[]> = Object.fromEntries(SKILL_CATEGORIES.map((c) => [c, []]));
  const seen = new Set<string>();
  for (const s of x.skills ?? []) {
    const name = s.name.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const cat = (SKILL_CATEGORIES as readonly string[]).includes(s.category ?? "") ? s.category! : "other";
    const level = s.level === "basic" || s.level === "learning" ? s.level : "verified";
    const contexts = s.contexts.filter((c): c is (typeof SKILL_CONTEXTS)[number] => (SKILL_CONTEXTS as readonly string[]).includes(c));
    skills[cat]!.push({ name, aliases: [], level, contexts: contexts.length ? contexts : ["listed"] });
  }
  // Technologies you used in a job or project are evidenced skills too, even when the skills section omits them.
  const used: Array<[string, (typeof SKILL_CONTEXTS)[number]]> = [
    ...(x.experience ?? []).flatMap((e) => e.technologies.map((t) => [t, e.type === "internship" ? "internship" : e.type === "training" ? "training" : "professional"] as [string, (typeof SKILL_CONTEXTS)[number]])),
    ...(x.projects ?? []).flatMap((e) => e.technologies.map((t) => [t, "project"] as [string, (typeof SKILL_CONTEXTS)[number]])),
  ];
  for (const [t, ctx] of used) {
    const name = t.trim();
    if (!name || name.length > 40) continue;
    const existing = Object.values(skills).flat().find((s) => (s as { name: string }).name.toLowerCase() === name.toLowerCase()) as { contexts: string[] } | undefined;
    if (existing) {
      if (!existing.contexts.includes(ctx)) existing.contexts.push(ctx);
      continue;
    }
    skills[guessCategory(name)]!.push({ name, aliases: [], level: "verified", contexts: [ctx] });
  }
  const technical = new Set(Object.values(skills).flat().map((s) => (s as { name: string }).name.toLowerCase()));
  const experience = ExperienceSchema.parse({
    entries: uniqueIds(x.experience ?? [], "exp", (e) => e.company).map((e) => ({
      id: e.id,
      type: e.type === "internship" || e.type === "training" ? e.type : /intern/i.test(e.role) ? "internship" : "professional",
      company: tidyCase(e.company.trim()),
      role: tidyCase(e.role.trim()),
      startDate: e.startDate,
      endDate: e.current ? null : e.endDate,
      current: !!e.current,
      location: e.location,
      verifiedResponsibilities: e.responsibilities,
      verifiedTechnologies: e.technologies,
    })),
  });
  const projects = ProjectsSchema.parse({ entries: uniqueIds(x.projects ?? [], "proj", (e) => e.name).map((e) => ({ id: e.id, name: tidyCase(e.name.trim()), description: e.description ?? "", technologies: e.technologies, achievements: e.achievements, links: e.links })) });
  const education = EducationSchema.parse({
    entries: uniqueIds(x.education ?? [], "edu", (e) => e.degree).map((e) => ({ id: e.id, institution: tidyCase(e.institution.trim()), degree: tidyCase(e.degree.trim()), level: (LEVELS as readonly string[]).includes(e.level ?? "") ? e.level : guessLevel(e.degree), startDate: e.startDate, endDate: e.endDate, cgpaOrPercentage: e.score, verified: true })),
  });
  const certifications = CertificationsSchema.parse({
    entries: uniqueIds(x.certifications ?? [], "cert", (e) => e.name).map((e) => ({ id: e.id, name: tidyCase(e.name.trim()), issuer: e.issuer, date: e.date, credentialUrl: e.url })),
    achievements: uniqueIds(x.achievements ?? [], "ach", (e) => e.name).map((e) => ({ id: e.id, name: e.name.trim(), context: e.context ?? "", date: e.date })),
  });
  // Some resumes list technologies under "soft skills"; keep only the genuinely soft ones.
  professional.softSkills = x.softSkills.filter((s) => !technical.has(s.toLowerCase()));
  SkillsSchema.parse(skills);
  return {
    "Personal/profile.json": { ...meta, ...personal },
    "Professional/professional.json": { ...meta, ...professional },
    "Skills/skills.json": { ...meta, _levels: "verified = listed without qualifier or used in experience/projects", ...skills },
    "Experience/experience.json": { ...meta, ...experience },
    "Projects/projects.json": { ...meta, ...projects },
    "Education/education.json": { ...meta, ...education },
    "Certifications/certifications.json": { ...meta, ...certifications },
  } as Record<string, unknown>;
}

const fmtMonth = (d: string | null) => {
  if (!d) return "?";
  const [y, m] = d.split("-");
  return m ? `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]} ${y}` : y!;
};

/** Answers a resume states; everything else in Application_Answers.txt is left exactly as it is. */
export function resumeAnswers(): Record<string, string> {
  const p = loadProfile();
  const a: Record<string, string> = {};
  const set = (k: string, v: string | null | undefined) => {
    if (v && v.trim()) a[k] = v.trim();
  };
  const name = p.personal.fullName?.replace(/\s+/g, " ");
  set("Full Name", name);
  set("Preferred Name", name);
  if (name) {
    const parts = name.split(" ");
    set("First Name", parts[0]);
    set("Last Name", parts.slice(1).join(" "));
  }
  set("Email", p.personal.email);
  const phone = p.personal.phone?.match(/^\s*(\+\d{1,3})?[\s-]*(.*)$/);
  if (phone) {
    set("Extension", phone[1]);
    set("Contact Number", phone[2]?.replace(/\D/g, ""));
  }
  set("City", p.personal.city);
  set("State", p.personal.state);
  set("Country", p.personal.country);
  set("LinkedIn", p.personal.linkedin);
  set("GitHub", p.personal.github);
  set("Portfolio", p.personal.portfolio);
  const current = p.experience.find((e) => e.current && e.type === "professional") ?? p.experience.find((e) => e.current);
  set("Current Company", current?.company);
  set("Current Job Title", current?.role);
  set("Current Company Location", current?.location);
  const months = professionalMonths(p).months;
  if (p.experience.some((e) => e.type === "professional")) set("Total Experience", months >= 12 ? `${Math.floor(months / 12)} year${months >= 24 ? "s" : ""}${months % 12 ? ` ${months % 12} month${months % 12 === 1 ? "" : "s"}` : ""}` : `${months} month${months === 1 ? "" : "s"}`);
  const interns = p.experience.filter((e) => e.type === "internship");
  if (interns.length) set("Past Internships", interns.map((e) => `${e.role} — ${e.company} (${fmtMonth(e.startDate)} – ${e.current ? "Present" : fmtMonth(e.endDate)})`).join("; "));
  const order = ["doctorate", "masters", "bachelors", "diploma", "higher_secondary", "secondary"];
  const top = [...p.education].sort((x, y) => order.indexOf(x.level) - order.indexOf(y.level))[0];
  if (top) {
    set("Highest Education", top.degree);
    set("Field of Study", top.degree.match(/\b(?:in|of)\s+(.+)$/i)?.[1]);
    set("University / College", top.institution);
    set("Graduation Year", top.endDate?.slice(0, 4));
  }
  return a;
}

export async function importResume(rt: AgentRuntime, resumeId: string, backupRoot: string): Promise<ImportResult> {
  const file = rt.primaryResumePath(resumeId);
  if (!file) throw new AgentError("NOT_FOUND", "resume not found");
  if (rt.base.ai.status().state !== "READY") throw new AgentError("NOT_CONFIGURED", "AI is not configured (GEMINI_API_KEY / AI_MODEL) — it is needed to read experience, projects and skills");
  const text = await pdfText(file);
  if (text.length < 200) throw new AgentError("VALIDATION_FAILED", "could not read enough text from that PDF (is it a scanned image?)");

  const extracted = await extractResume(rt.base.ai, text, fs.readFileSync(file));
  const myData = paths.myData();
  const source = paths.resumeSource();
  const readJson = (f: string) => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const at = new Date().toISOString();
  const files = toMyData(extracted, { professional: readJson(path.join(myData, "Professional", "professional.json")) }, { file: "Data_Resume/Source/resume.pdf", at });

  // Back up everything this import replaces.
  const importId = `import-${at.replace(/[:.]/g, "-")}`;
  const backup = path.join(backupRoot, importId);
  for (const f of MY_DATA_FILES) if (fs.existsSync(path.join(myData, f))) copy(path.join(myData, f), path.join(backup, "MY_DATA", f));
  for (const f of SOURCE_FILES) if (fs.existsSync(path.join(source, f))) copy(path.join(source, f), path.join(backup, "Source", f));
  if (fs.existsSync(rt.answers.file)) copy(rt.answers.file, path.join(backup, "Application_Answers.txt"));

  try {
    for (const [f, data] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(myData, f)), { recursive: true });
      fs.writeFileSync(path.join(myData, f), JSON.stringify(data, null, 2) + "\n");
    }
    loadProfile(); // throws if anything written does not load
    fs.mkdirSync(source, { recursive: true });
    const pdf = fs.readFileSync(file);
    fs.writeFileSync(path.join(source, "resume.pdf"), pdf);
    fs.writeFileSync(path.join(source, "resume.txt"), repairLigatures(text, JSON.stringify(files)) + "\n");
    const links = [...new Set(text.replace(/(?<=\S)(https?:\/\/)/g, " $1").match(/(?:https?:\/\/|www\.)[^\s|,)]+|\b(?:linkedin\.com|github\.com)\/[^\s|,)]+/gi) ?? [])];
    fs.writeFileSync(path.join(source, "resume.meta.json"), JSON.stringify({ sourceFile: resumeId, importedAt: at, sha256: crypto.createHash("sha256").update(pdf).digest("hex"), links }, null, 2) + "\n");
  } catch (e) {
    restore(rt, backup);
    throw new AgentError("VALIDATION_FAILED", `resume data was not changed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const answers = resumeAnswers();
  const before = new Map(parseAnswers(rt.answers.text()).entries.map((e) => [e.canonicalKey, e.value]));
  const answersUpdated: string[] = [];
  for (const [k, v] of Object.entries(answers)) {
    if (before.get(AnswerBank.keyOf(k)) === v) continue;
    rt.answers.upsert(k, v);
    answersUpdated.push(k);
  }
  fs.writeFileSync(path.join(backup, "import.json"), JSON.stringify({ importId, resumeId, importedAt: at, answersUpdated }, null, 2));
  rt.reloadKnowledge();
  const p = rt.profile;
  return {
    importId,
    resumeId,
    importedAt: at,
    counts: { experience: p.experience.length, projects: p.projects.length, education: p.education.length, certifications: p.certifications.entries.length, skills: Object.values(p.skills).flat().length },
    answersUpdated,
    name: p.personal.fullName,
  };
}

function copy(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function restore(rt: AgentRuntime, backup: string): void {
  for (const f of MY_DATA_FILES) if (fs.existsSync(path.join(backup, "MY_DATA", f))) copy(path.join(backup, "MY_DATA", f), path.join(paths.myData(), f));
  for (const f of SOURCE_FILES) if (fs.existsSync(path.join(backup, "Source", f))) copy(path.join(backup, "Source", f), path.join(paths.resumeSource(), f));
  if (fs.existsSync(path.join(backup, "Application_Answers.txt"))) copy(path.join(backup, "Application_Answers.txt"), rt.answers.file);
}

/** Puts back the resume data, source files and answers exactly as they were before an import. */
export function undoImport(rt: AgentRuntime, importId: string, backupRoot: string): { restored: string } {
  if (!/^import-[\w-]+$/.test(importId)) throw new AgentError("VALIDATION_FAILED", "bad import id");
  const backup = path.join(backupRoot, importId);
  if (!fs.existsSync(backup)) throw new AgentError("NOT_FOUND", "that import has no backup");
  restore(rt, backup);
  rt.reloadKnowledge();
  return { restored: importId };
}
