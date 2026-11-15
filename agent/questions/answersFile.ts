import fs from "node:fs";
import { fromRoot } from "../core/paths.ts";
import { normalizeText } from "../core/text.ts";

/**
 * Application_Answers.txt — the user's own answers, one "Key : Value" per line (# comments allowed).
 *
 *  - A filled value is an explicit, user-verified answer: it overrides the question bank for application forms.
 *  - A blank value means "not provided": nothing is overridden; a required question with no other verified
 *    answer stops for the user. Nothing is ever guessed from it.
 *  - Keys not listed below become new questions (the key is the question text to match).
 *  - "<Skill> Experience" (Java Experience, SaaS Experience …) answers only questions about that subject — never
 *    total experience. "Willing to Relocate to <City>" answers only relocation questions naming that city.
 */
export const answersFilePath = () => fromRoot("Application_Answers.txt");

export interface AnswerEntry {
  key: string;
  value: string | null;
  line: number;
  canonicalKey: string;
  /** Patterns for keys that have no question-bank record yet. */
  patterns: string[];
  sensitivity: "normal" | "review" | "sensitive" | "legal";
}

type Spec = { canonicalKey: string; patterns?: string[]; sensitivity?: AnswerEntry["sensitivity"] };

/** Keys of the template, mapped onto question-bank keys (existing records) or new records with their patterns. */
const KNOWN: Record<string, Spec> = {
  "first name": { canonicalKey: "first_name" },
  "last name": { canonicalKey: "last_name" },
  "preferred name": { canonicalKey: "preferred_name", patterns: ["preferred name", "preferred first name", "nickname"] },
  "full name": { canonicalKey: "full_name" },
  email: { canonicalKey: "email" },
  "contact number": { canonicalKey: "phone" },
  extension: { canonicalKey: "phone_country_code", patterns: ["country code", "phone country code", "dialing code", "calling code", "extension"] },
  country: { canonicalKey: "country" },
  state: { canonicalKey: "current_state" },
  city: { canonicalKey: "current_city" },
  "postal code": { canonicalKey: "postal_code", patterns: ["postal code", "zip code", "zip", "pin code", "pincode", "postcode"] },
  linkedin: { canonicalKey: "linkedin_url" },
  github: { canonicalKey: "github_url" },
  portfolio: { canonicalKey: "portfolio_url" },
  "current company": { canonicalKey: "current_company" },
  "current job title": { canonicalKey: "current_title" },
  "total experience": { canonicalKey: "years_experience" },
  "current company location": { canonicalKey: "current_company_location", patterns: ["current company location", "company location", "current work location", "current office location"] },
  "highest education": { canonicalKey: "highest_degree" },
  "field of study": { canonicalKey: "field_of_study" },
  "university / college": { canonicalKey: "university" },
  "graduation year": { canonicalKey: "graduation_year" },
  "notice period": { canonicalKey: "notice_period" },
  "current ctc": { canonicalKey: "current_ctc" },
  "expected ctc": { canonicalKey: "expected_ctc" },
  "willing to relocate": { canonicalKey: "willing_to_relocate" },
  "remote work": { canonicalKey: "remote_work", patterns: ["remote work", "work remotely", "open to remote", "fully remote"], sensitivity: "review" },
  "hybrid work": { canonicalKey: "hybrid_work", patterns: ["hybrid work", "hybrid", "hybrid model"], sensitivity: "review" },
  "onsite work": { canonicalKey: "onsite_work", patterns: ["onsite work", "onsite", "on site", "work from office", "in office"], sensitivity: "review" },
  "willing to travel": { canonicalKey: "willing_to_travel", patterns: ["willing to travel", "travel required", "open to travel", "travel"], sensitivity: "review" },
  "night shift": { canonicalKey: "night_shift", patterns: ["night shift", "night shifts", "rotational shift", "rotational shifts"], sensitivity: "review" },
  "weekend work": { canonicalKey: "weekend_work", patterns: ["weekend work", "work on weekends", "weekends"], sensitivity: "review" },
  gender: { canonicalKey: "eeo_gender" },
  "demographic data consent": {
    canonicalKey: "demographic_data_consent",
    patterns: ["processing my responses to the demographic data surveys", "demographic data surveys", "demographic survey", "demographic data consent"],
    sensitivity: "legal",
  },
  "work authorization": { canonicalKey: "authorized_india" },
  "require sponsorship": { canonicalKey: "needs_sponsorship" },
  "visa status": { canonicalKey: "visa_status", patterns: ["visa status", "current visa", "work permit", "immigration status"], sensitivity: "legal" },
  "reason for leaving": { canonicalKey: "reason_for_leaving", patterns: ["reason for leaving", "why are you leaving", "reason for job change", "why do you want to leave"], sensitivity: "review" },
  "codeforces rating": { canonicalKey: "codeforces_rating", patterns: ["codeforces rating", "codeforces"] },
  "codechef rating": { canonicalKey: "codechef_rating", patterns: ["codechef rating", "codechef"] },
  "past internships": { canonicalKey: "past_internships", patterns: ["past internship", "past internships", "previous internship", "previous internships", "internship experience"], sensitivity: "review" },
};

const slug = (s: string) => normalizeText(s).replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

function specFor(key: string): Spec {
  const k = normalizeText(key);
  const known = KNOWN[k] ?? KNOWN[key.trim().toLowerCase()];
  if (known) return known;
  const exp = /^(.+?) experience$/.exec(k);
  if (exp?.[1] && exp[1] !== "total") {
    const x = exp[1];
    // Must end in _years: the matcher lets only "<subject>_years" records answer narrowed experience questions.
    return {
      canonicalKey: `${slug(x)}_experience_years`,
      patterns: [`${x} experience`, `experience in ${x}`, `experience with ${x}`, `experience with a ${x}`, `experience using ${x}`, `working with a ${x}`, `working with ${x}`, `${x} firm`, `${x} company`, `in ${x}`],
      sensitivity: "review",
    };
  }
  const reloc = /^willing to relocate to (.+)$/.exec(k);
  if (reloc?.[1]) {
    const c = reloc[1];
    // Longer, city-bearing phrasings so they outrank the general "open to relocating" record on the same question.
    return {
      canonicalKey: `relocate_to_${slug(c)}`,
      patterns: [`open to relocating to ${c}`, `willing to relocate to ${c}`, `open to relocation to ${c}`, `relocating to ${c}`, `relocate to ${c}`, `relocation to ${c}`, `move to ${c}`],
      sensitivity: "review",
    };
  }
  // A saved "How many years … with a SaaS firm?" answers exactly that question (the matcher only lets "_years"
  // records answer narrowed experience questions).
  const years = /\bhow (many|much|long)\b|\bnumber of\b|\byears?\b/i.test(k) && /\bexperience\b/i.test(k);
  return { canonicalKey: `answer_${slug(key)}${years ? "_years" : ""}`, patterns: [normalizeText(key)], sensitivity: "review" };
}

export function parseAnswers(text: string): { entries: AnswerEntry[]; issues: string[] } {
  const entries: AnswerEntry[] = [];
  const issues: string[] = [];
  const seen = new Map<string, number>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const at = line.indexOf(":");
    if (at <= 0) {
      issues.push(`line ${i + 1}: expected "Key : Value", got '${line.slice(0, 60)}'`);
      return;
    }
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    const spec = specFor(key);
    const prev = seen.get(spec.canonicalKey);
    if (prev !== undefined) issues.push(`line ${i + 1}: '${key}' repeats line ${prev} — the later value wins`);
    seen.set(spec.canonicalKey, i + 1);
    const entry: AnswerEntry = { key, value: value || null, line: i + 1, canonicalKey: spec.canonicalKey, patterns: spec.patterns ?? [], sensitivity: spec.sensitivity ?? "normal" };
    const idx = entries.findIndex((e) => e.canonicalKey === spec.canonicalKey);
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
  });
  return { entries, issues };
}

export function readAnswersFile(file = answersFilePath()): { entries: AnswerEntry[]; issues: string[]; text: string } | null {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  return { ...parseAnswers(text), text };
}

/** Yes/No answers for preferences used in matching; anything else stays unknown. */
export function yesNo(v: string | null): boolean | null {
  if (!v) return null;
  if (/^(yes|y|true|ok|sure|open)\b/i.test(v)) return true;
  if (/^(no|n|false|not)\b/i.test(v)) return false;
  return null;
}

/** "Immediate" → 0, "30 days" → 30, "2 months" → 60, "1 week" → 7; anything else → null (the text is still used on forms). */
export function noticeDays(v: string | null): number | null {
  if (!v) return null;
  if (/^(immediate|immediately|0)\b/i.test(v.trim())) return 0;
  const m = /^(\d+)\s*(day|days|d|week|weeks|month|months)\b/i.exec(v.trim());
  if (!m?.[1] || !m[2]) return null;
  const n = Number(m[1]);
  return /^w/i.test(m[2]) ? n * 7 : /^m/i.test(m[2]) ? n * 30 : n;
}
