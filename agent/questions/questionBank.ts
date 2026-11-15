import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { paths } from "../core/paths.ts";
import { jaccard, normalizeText, tokenSet } from "../core/text.ts";
import { loadProfile, professionalMonths, SkillIndex, type Profile } from "../profile/profile.ts";
import { answersFilePath, readAnswersFile, type AnswerEntry } from "./answersFile.ts";

function safeProfile(): Profile | null {
  try {
    return loadProfile();
  } catch {
    return null;
  }
}

export const TRUST_LEVELS = ["VERIFIED_USER_DATA", "DETERMINISTIC_DERIVED", "AI_SUGGESTED", "UNKNOWN"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const QuestionRecordSchema = z.object({
  questionId: z.string(),
  canonicalKey: z.string().regex(/^[a-z0-9_]+$/),
  patterns: z.array(z.string()).min(1),
  answerType: z.enum(["text", "number", "boolean", "select", "date"]),
  answer: z.union([z.string(), z.number(), z.boolean()]).nullable(),
  answerRef: z.string().nullable().default(null),
  source: z.enum(["user_verified", "derived", "generated"]),
  verified: z.boolean(),
  sensitivity: z.enum(["normal", "review", "sensitive", "legal"]).default("normal"),
  note: z.string().optional(),
});
export type QuestionRecord = z.infer<typeof QuestionRecordSchema> & { category: string; file: string };

export interface ResolvedAnswer {
  value: string | null;
  trust: TrustLevel;
  basis: string;
}

export interface QuestionMatch {
  record: QuestionRecord;
  confidence: number;
  matchedPattern: string;
  /** For skill_experience: the skill the question asks about. */
  subject?: string;
}

export function loadQuestionBank(
  dir = paths.questions(),
  answersFile = answersFilePath(),
  profileForConflicts: Profile | null = safeProfile(),
): { records: QuestionRecord[]; issues: string[] } {
  const records: QuestionRecord[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  if (!fs.existsSync(dir)) return { records, issues: [`${dir} missing`] };
  for (const category of fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of fs.readdirSync(path.join(dir, category.name)).filter((x) => x.endsWith(".json"))) {
      const file = path.join(dir, category.name, f);
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (err) {
        issues.push(`${file}: invalid JSON (${(err as Error).message})`);
        continue;
      }
      const parsed = z.array(QuestionRecordSchema).safeParse(raw);
      if (!parsed.success) {
        issues.push(`${file}: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
        continue;
      }
      for (const r of parsed.data) {
        if (seen.has(r.canonicalKey)) {
          issues.push(`${file}: duplicate canonicalKey ${r.canonicalKey}`);
          continue;
        }
        seen.add(r.canonicalKey);
        records.push({ ...r, category: category.name, file: path.relative(dir, file) });
      }
    }
  }
  const answers = readAnswersFile(answersFile);
  if (answers) applyAnswers(records, answers.entries, issues, profileForConflicts);
  if (answers) issues.push(...answers.issues.map((i) => `Application_Answers.txt ${i}`));
  return { records, issues };
}

const same = (a: string, b: string) => {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const d = (s: string) => s.replace(/\D+/g, "");
  if (d(a).length >= 7 && d(b).length >= 7) return d(a).endsWith(d(b)) || d(b).endsWith(d(a)); // phone numbers, with or without +91
  return n(a) === n(b);
};

/**
 * Application_Answers.txt values become explicit, user-verified answers. A value that contradicts verified MY_DATA
 * (the resume-backed facts: name, email, phone, education, current job) is not used — forms must agree with the
 * resume — and is reported so the user fixes one of the two.
 */
function applyAnswers(records: QuestionRecord[], entries: AnswerEntry[], issues: string[], profile: Profile | null): void {
  for (const e of entries) {
    const r = records.find((x) => x.canonicalKey === e.canonicalKey);
    if (r) {
      if (e.value === null) continue; // blank: fall back to MY_DATA / leave unknown
      // Only resume-backed facts are protected. Preferences (notice period, relocation, salary) are the user's to state here.
      if (r.answerRef && !r.answerRef.startsWith("preferences.") && profile) {
        const mine = resolveAnswer({ record: r, confidence: 1, matchedPattern: "" }, profile).value;
        if (r.canonicalKey === "years_experience" && mine !== null) {
          const range = /^(\d+(?:\.\d+)?)\s*(?:-|to)\s*(\d+(?:\.\d+)?)/.exec(e.value) ?? /^(\d+(?:\.\d+)?)()/.exec(e.value);
          const v = Number(mine);
          const ok = range ? (range[2] ? v >= Number(range[1]) && v <= Number(range[2]) : Math.abs(Number(range[1]) - v) < 0.5) : false;
          if (!ok) issues.push(`Application_Answers.txt line ${e.line}: '${e.key} : ${e.value}' does not match your verified professional experience (${mine} years); the verified value is used`);
          continue; // forms get the exact verified number
        }
        if (mine !== null && !same(mine, e.value)) {
          issues.push(`Application_Answers.txt line ${e.line}: '${e.key} : ${e.value}' contradicts MY_DATA (${mine}); the MY_DATA value is used — correct one of them`);
          continue;
        }
      }
      Object.assign(r, { answer: e.value, answerRef: null, source: "user_verified" as const, verified: true, note: `Application_Answers.txt line ${e.line}` });
    } else {
      records.push({
        questionId: `Q-ANS-${String(e.line).padStart(3, "0")}`,
        canonicalKey: e.canonicalKey,
        patterns: e.patterns.length ? e.patterns : [e.key.toLowerCase()],
        answerType: "text",
        answer: e.value,
        answerRef: null,
        source: "user_verified",
        verified: e.value !== null,
        sensitivity: e.sensitivity,
        note: e.value === null ? `blank in Application_Answers.txt line ${e.line}` : `Application_Answers.txt line ${e.line}`,
        category: "Application_Answers",
        file: "Application_Answers.txt",
      });
    }
  }
}

/** Where an answer comes from, for the field-source view ("SaaS Experience — 0 years — Application answers"). */
export type AnswerSource = "APPLICATION_ANSWERS" | "HUMAN_ANSWER" | "PROFILE" | "RESUME" | "QUESTION_BANK" | "AI_SUGGESTED";

export function answerSourceOf(r: QuestionRecord): AnswerSource {
  if (r.file === HUMAN_FILE) return "HUMAN_ANSWER";
  if (r.file === "Application_Answers.txt" || (r.note ?? "").startsWith("Application_Answers.txt")) return "APPLICATION_ANSWERS";
  if (r.source === "generated") return "AI_SUGGESTED";
  if (r.answerRef?.startsWith("derived.")) return "RESUME";
  if (r.answerRef) return "PROFILE";
  return "QUESTION_BANK";
}

const HUMAN_FILE = "(answered during application)";

/** "How many years of experience … with a SaaS firm?" — only "<subject>_years" records may answer these. */
export function asksQualifiedYears(label: string): boolean {
  return /\bhow (many|much|long)\b|\bnumber of\b|\byears?\b/i.test(label) && QUALIFIED_EXPERIENCE.test(label);
}

/**
 * Records for answers the user typed for this application's own questions. The exact question text is the pattern,
 * so the answer matches its question with confidence 1 and nothing broader.
 */
export function humanAnswerRecords(answers: Array<{ label: string; answer: string }>): QuestionRecord[] {
  return answers
    .filter((a) => a.answer.trim())
    .map((a, i) => {
      const slug = normalizeText(a.label).replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60) || `q${i}`;
      return {
        questionId: `Q-HUMAN-${String(i + 1).padStart(3, "0")}`,
        canonicalKey: `human_${slug}${asksQualifiedYears(a.label) ? "_years" : ""}`,
        patterns: [normalizeText(a.label)],
        answerType: "text" as const,
        answer: a.answer.trim(),
        answerRef: null,
        source: "user_verified" as const,
        verified: true,
        sensitivity: "review" as const,
        note: "answered by you during this application",
        category: "Human",
        file: HUMAN_FILE,
      };
    });
}

/** Maps HTML autocomplete tokens to canonical keys; a strong, standard signal. */
const AUTOCOMPLETE_KEYS: Record<string, string> = {
  name: "full_name",
  "given-name": "first_name",
  "family-name": "last_name",
  email: "email",
  tel: "phone",
  "tel-national": "phone",
  "address-level2": "current_city",
  "address-level1": "current_state",
  "country-name": "country",
  country: "country",
  url: "portfolio_url",
  organization: "current_company",
  "organization-title": "current_title",
};

/** Experience narrowed to a skill, company type, domain or role ("… working with a SaaS firm", "… in Java"). */
const QUALIFIED_EXPERIENCE = /\bexperience\b.*\b(?:with|in|using|on|at|as|within|working|worked|building|managing|leading)\b\s+(?!total\b|overall\b|all\b)\S/i;

const SKILL_Q = /(?:experience (?:with|in|using)|proficient (?:in|with)|worked (?:with|on)|hands[- ]on (?:experience )?(?:in|with)|knowledge of)\s+([a-z0-9+#. \-/]{1,40}?)\??$/i;

/**
 * Best question-bank match for a form label. Confidence:
 *  1.0 exact pattern, 0.95 autocomplete token, 0.9 pattern contained in label (word-bounded), else token overlap.
 */
export function matchQuestion(records: QuestionRecord[], field: { label: string; name?: string | null; autocomplete?: string | null }): QuestionMatch | null {
  const label = normalizeText(field.label);
  const ac = (field.autocomplete ?? "").toLowerCase().split(/\s+/).pop() ?? "";
  const byKey = new Map(records.map((r) => [r.canonicalKey, r]));
  const acKey = AUTOCOMPLETE_KEYS[ac];
  if (acKey && byKey.has(acKey)) return { record: byKey.get(acKey) as QuestionRecord, confidence: 0.95, matchedPattern: `autocomplete=${ac}` };

  // "How many years … with/in/at X" asks for a number about X: neither total experience nor a Yes/No skill
  // answer is true for it, so it has no bank answer and goes to a human.
  // Only a bank record written for that exact subject (canonicalKey "<subject>_years", e.g. saas_experience_years) may answer it.
  const asksAmount = /\bhow (many|much|long)\b|\bnumber of\b|\byears?\b/i.test(field.label);
  if (asksAmount && QUALIFIED_EXPERIENCE.test(field.label)) {
    for (const r of records) {
      if (!r.canonicalKey.endsWith("_years")) continue;
      const p = r.patterns.find((x) => new RegExp(`(^|\\s)${normalizeText(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(label));
      if (p) return { record: r, confidence: 0.9, matchedPattern: p };
    }
    return null;
  }

  const skillQ = SKILL_Q.exec(field.label.trim());
  const skillRec = byKey.get("skill_experience");
  if (skillQ?.[1] && skillRec) return { record: skillRec, confidence: 0.9, matchedPattern: skillQ[0], subject: skillQ[1].trim() };

  let best: QuestionMatch | null = null;
  const labelTokens = tokenSet(`${field.label} ${field.name ?? ""}`);
  for (const r of records) {
    if (r.canonicalKey === "skill_experience") continue;
    for (const p of r.patterns) {
      const np = normalizeText(p);
      let c: number;
      const contained = np !== label && new RegExp(`(^|\\s)${np.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(label);
      if (np === label) c = 1;
      // A multi-word phrase the user wrote for this exact question in Application_Answers.txt is as specific as it gets,
      // however long the site's label is (consent checkboxes run to 150+ characters).
      else if (contained && (r.file === "Application_Answers.txt" || (r.note ?? "").startsWith("Application_Answers.txt")) && np.split(" ").length >= 3) c = 0.9;
      else if (contained) c = 0.9 - Math.max(0, (label.length - np.length) / 400);
      else c = jaccard(labelTokens, tokenSet(p)) * 0.85;
      // Ties go to the longer, more specific phrase ("open to relocating to pune" over "open to relocating").
      const rc = Math.round(c * 100) / 100;
      if (!best || rc > best.confidence || (rc === best.confidence && np.length > normalizeText(best.matchedPattern).length)) best = { record: r, confidence: rc, matchedPattern: p };
    }
  }
  return best && best.confidence >= 0.5 ? best : null;
}

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** Resolves an answer. Returns UNKNOWN (value null) whenever the data isn't in MY_DATA — never guesses. */
export function resolveAnswer(match: QuestionMatch, profile: Profile, asOf = new Date()): ResolvedAnswer {
  const r = match.record;
  if (!r.answerRef) {
    if (r.answer === null || !r.verified) return { value: null, trust: "UNKNOWN", basis: `no verified answer for '${r.canonicalKey}' (${r.file})` };
    return { value: String(r.answer), trust: r.source === "generated" ? "AI_SUGGESTED" : "VERIFIED_USER_DATA", basis: `${r.file}:${r.questionId}` };
  }
  const [ns, ...rest] = r.answerRef.split(".");
  const key = rest.join(".");
  if (ns === "personal" || ns === "preferences") {
    const v = getPath(ns === "personal" ? profile.personal : profile.preferences, key);
    if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) return { value: null, trust: "UNKNOWN", basis: `MY_DATA ${r.answerRef} is not set` };
    if (Array.isArray(v)) return { value: v.map(String).join(", "), trust: "VERIFIED_USER_DATA", basis: `MY_DATA ${r.answerRef}` };
    if (typeof v === "boolean") return { value: v ? "Yes" : "No", trust: "VERIFIED_USER_DATA", basis: `MY_DATA ${r.answerRef}` };
    if (typeof v === "string" || typeof v === "number") return { value: String(v), trust: "VERIFIED_USER_DATA", basis: `MY_DATA ${r.answerRef}` };
    return { value: null, trust: "UNKNOWN", basis: `MY_DATA ${r.answerRef} is not a simple value` };
  }
  if (ns !== "derived") return { value: null, trust: "UNKNOWN", basis: `unknown answerRef namespace '${ns}'` };

  const bachelors = profile.education.find((e) => e.level === "bachelors") ?? profile.education[0];
  const current = profile.experience.find((e) => e.current && e.type === "professional");
  const name = (profile.personal.fullName ?? "").trim().split(/\s+/);
  const derived = (value: string | null, basis: string): ResolvedAnswer => (value ? { value, trust: "DETERMINISTIC_DERIVED", basis } : { value: null, trust: "UNKNOWN", basis: `cannot derive: ${basis}` });
  switch (key) {
    case "firstName":
      return derived(name.length >= 2 ? (name[0] ?? null) : null, "first word of personal.fullName");
    case "lastName":
      return derived(name.length >= 2 ? name.slice(1).join(" ") : null, "words after the first in personal.fullName");
    case "highestDegree":
      return derived(bachelors?.degree ?? null, "education (bachelors)");
    case "highestInstitution":
      return derived(bachelors?.institution ?? null, "education (bachelors)");
    case "graduationYear":
      return derived(bachelors?.endDate?.slice(0, 4) ?? null, "education (bachelors).endDate");
    case "highestGrade":
      return derived(bachelors?.cgpaOrPercentage?.replace(/\s*CGPA$/i, "") ?? null, "education (bachelors).cgpaOrPercentage");
    case "fieldOfStudy":
      return derived(bachelors ? (/\bin\s+(.+)$/.exec(bachelors.degree)?.[1] ?? null) : null, "text after 'in' in bachelors degree");
    case "currentCompany":
      return derived(current?.company ?? null, "current professional experience");
    case "currentTitle":
      return derived(current?.role ?? null, "current professional experience");
    case "professionalYears": {
      const m = professionalMonths(profile, asOf);
      return derived(m.months > 0 ? (m.months / 12).toFixed(1) : null, `verified dates: ${m.basis.join("; ") || "none"}`);
    }
    case "skillExperience": {
      const subject = match.subject ?? "";
      const hit = new SkillIndex(profile).lookup(subject);
      if (!hit) return { value: null, trust: "UNKNOWN", basis: `'${subject}' not in MY_DATA — not answering No or Yes automatically` };
      if (hit.level !== "verified") return { value: null, trust: "UNKNOWN", basis: `'${subject}' is only '${hit.level}' in MY_DATA` };
      return { value: "Yes", trust: "DETERMINISTIC_DERIVED", basis: `MY_DATA skill '${hit.skill.name}' (${hit.skill.contexts.join("/")})` };
    }
    default:
      return { value: null, trust: "UNKNOWN", basis: `no derivation for ${r.answerRef}` };
  }
}

/** Picks the option that corresponds to an answer. Null when no option clearly matches (→ human). */
export function chooseOption(options: string[], answer: string): string | null {
  const a = normalizeText(answer);
  if (!a) return null;
  const exact = options.find((o) => normalizeText(o) === a);
  if (exact) return exact;
  // "India +91", "Bengaluru, Karnataka, India", "India (IN)": the part before the qualifier is the name.
  const lead = options.filter((o) => normalizeText(o.split(/,|\s\(|\s\+|\s-\s/)[0] ?? "") === a);
  if (lead.length === 1) return lead[0] ?? null;
  const yes = /^(yes|true)$/.test(a);
  const no = /^(no|false)$/.test(a);
  if (yes || no) return options.find((o) => new RegExp(`^${yes ? "yes" : "no"}\\b`).test(normalizeText(o))) ?? null;
  const contains = options.filter((o) => normalizeText(o).includes(a) || a.includes(normalizeText(o)));
  return contains.length === 1 ? (contains[0] ?? null) : null;
}
