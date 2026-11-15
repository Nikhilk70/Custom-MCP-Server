import fs from "node:fs";
import path from "node:path";
import { parseAnswers } from "../agent/questions/answersFile.ts";
import { loadQuestionBank, resolveAnswer, type QuestionRecord } from "../agent/questions/questionBank.ts";
import type { Profile } from "../agent/profile/profile.ts";
import { normalizeText } from "../agent/core/text.ts";

export const ANSWER_CATEGORIES = [
  "Personal",
  "Contact",
  "Location",
  "Education",
  "Experience",
  "Work Preferences",
  "Salary",
  "Relocation",
  "Authorization",
  "Technology",
  "Company-specific",
  "Custom Questions",
] as const;
export type AnswerCategory = (typeof ANSWER_CATEGORIES)[number];
export type AnswerSourceLabel = "USER" | "RESUME" | "PROFILE" | "COMPANY_SPECIFIC";

export interface AnswerItem {
  /** Stable id: the canonical key the matcher uses. */
  id: string;
  question: string;
  answer: string | null;
  category: AnswerCategory;
  scope: "GLOBAL" | "COMPANY";
  company: string | null;
  source: AnswerSourceLabel;
  editable: boolean;
  disabled: boolean;
  /** 1-based line in Application_Answers.txt (null for resume/profile-backed answers). */
  line: number | null;
  usageCount: number;
  lastUsed: string | null;
  note: string | null;
}

export interface UsageStat {
  count: number;
  last: string | null;
  history: Array<{ at: string; jobId: string; field: string }>;
}

const DISABLED = /^#\s*\[disabled\]\s*/i;

function categoryOf(key: string, canonicalKey: string, companies: string[]): { category: AnswerCategory; company: string | null } {
  const k = `${normalizeText(key)} ${canonicalKey}`;
  const company = companies.find((c) => c.length > 2 && new RegExp(`\\b${normalizeText(c).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(normalizeText(key)));
  if (company) return { category: "Company-specific", company };
  if (/ctc|salary|compensation|pay\b/.test(k)) return { category: "Salary", company: null };
  if (/relocat/.test(k)) return { category: "Relocation", company: null };
  if (/authori[sz]|sponsor|visa|citizen|work permit/.test(k)) return { category: "Authorization", company: null };
  if (/experience_years|_experience|experience/.test(k)) return { category: /total|years_experience/.test(k) ? "Experience" : "Technology", company: null };
  if (/remote|hybrid|onsite|travel|shift|weekend|notice|available/.test(k)) return { category: "Work Preferences", company: null };
  if (/linkedin|github|portfolio|email|phone|extension|contact/.test(k)) return { category: "Contact", company: null };
  if (/city|state|country|postal|pin code|zip|location/.test(k)) return { category: "Location", company: null };
  if (/degree|education|field of study|university|college|graduation|cgpa/.test(k)) return { category: "Education", company: null };
  if (/name|gender|pronoun|demographic/.test(k)) return { category: "Personal", company: null };
  if (/current company|current job title|current_title|current_company|internship|reason for leaving/.test(k)) return { category: "Experience", company: null };
  return { category: "Custom Questions", company: null };
}

function cleanKey(s: string): string {
  return s.replace(/[\r\n]+/g, " ").replace(/:/g, " ").replace(/\s+/g, " ").trim().replace(/\?+$/, "");
}
function cleanValue(s: string): string {
  return s.replace(/[\r\n]+/g, " ").trim();
}

/**
 * The Answer Bank's storage is Application_Answers.txt ("Key : Value" per line), exactly as the CLI reads it.
 * Comments, blank lines and order are preserved. Every change keeps a timestamped backup of the previous file.
 * Disabling comments a line out ("# [disabled] Key : Value") so the agent ignores it but nothing is lost.
 */
export class AnswerBank {
  constructor(
    readonly file: string,
    private readonly backupDir: string,
  ) {}

  private lines(): string[] {
    return fs.existsSync(this.file) ? fs.readFileSync(this.file, "utf8").split(/\r?\n/) : [];
  }

  private write(lines: string[]): void {
    if (fs.existsSync(this.file)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
      fs.copyFileSync(this.file, path.join(this.backupDir, `Application_Answers-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`));
      const backups = fs.readdirSync(this.backupDir).sort();
      for (const old of backups.slice(0, Math.max(0, backups.length - 50))) fs.rmSync(path.join(this.backupDir, old));
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, lines.join("\n").replace(/\n*$/, "\n"));
    fs.renameSync(tmp, this.file);
  }

  text(): string {
    return this.lines().join("\n");
  }

  /** Canonical key the agent will use for a question text (same mapping as the CLI). */
  static keyOf(question: string): string {
    return parseAnswers(`${cleanKey(question)} : x`).entries[0]?.canonicalKey ?? "";
  }

  private locate(id: string): { index: number; key: string; value: string; disabled: boolean } | null {
    const lines = this.lines();
    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = lines[i] ?? "";
      const disabled = DISABLED.test(raw);
      const body = disabled ? raw.replace(DISABLED, "") : raw;
      if (!disabled && body.trim().startsWith("#")) continue;
      const at = body.indexOf(":");
      if (at <= 0) continue;
      const key = body.slice(0, at).trim();
      if (AnswerBank.keyOf(key) === id) return { index: i, key, value: body.slice(at + 1).trim(), disabled };
    }
    return null;
  }

  /** Adds a new answer or changes an existing one (by the question's canonical key). Re-enables a disabled line. */
  upsert(question: string, answer: string): { id: string; created: boolean } {
    const key = cleanKey(question);
    if (!key) throw new Error("question text is required");
    const id = AnswerBank.keyOf(key);
    const lines = this.lines();
    const found = this.locate(id);
    const line = `${found?.key ?? key} : ${cleanValue(answer)}`;
    if (found) {
      lines[found.index] = line;
      this.write(lines);
      return { id, created: false };
    }
    while (lines.length && !(lines[lines.length - 1] ?? "").trim()) lines.pop();
    if (!lines.some((l) => l.startsWith("# Learned in ApplyPilot"))) lines.push("", "# Learned in ApplyPilot (questions you answered during applications)");
    lines.push(line);
    this.write(lines);
    return { id, created: true };
  }

  setDisabled(id: string, disabled: boolean): void {
    const found = this.locate(id);
    if (!found) throw new Error(`answer ${id} not found in ${path.basename(this.file)}`);
    const lines = this.lines();
    lines[found.index] = `${disabled ? "# [disabled] " : ""}${found.key} : ${found.value}`;
    this.write(lines);
  }

  remove(id: string): void {
    const found = this.locate(id);
    if (!found) throw new Error(`answer ${id} not found in ${path.basename(this.file)}`);
    const lines = this.lines();
    lines.splice(found.index, 1);
    this.write(lines);
  }

  /**
   * Every answer the agent can use: your written answers (USER) and the ones derived from your resume data
   * (RESUME/PROFILE, read-only here — they change when MY_DATA changes).
   */
  list(opts: { profile: Profile; companies: string[]; usage: Map<string, UsageStat>; questionsDir?: string }): AnswerItem[] {
    const out: AnswerItem[] = [];
    const lines = this.lines();
    const seen = new Set<string>();
    lines.forEach((raw, i) => {
      const disabled = DISABLED.test(raw);
      const body = disabled ? raw.replace(DISABLED, "") : raw;
      if (!body.trim() || (!disabled && body.trim().startsWith("#"))) return;
      const at = body.indexOf(":");
      if (at <= 0) return;
      const key = body.slice(0, at).trim();
      const value = body.slice(at + 1).trim() || null;
      const id = AnswerBank.keyOf(key);
      seen.add(id);
      const cat = categoryOf(key, id, opts.companies);
      const u = opts.usage.get(id);
      out.push({ id, question: key, answer: value, category: cat.category, scope: cat.company ? "COMPANY" : "GLOBAL", company: cat.company, source: cat.company ? "COMPANY_SPECIFIC" : "USER", editable: true, disabled, line: i + 1, usageCount: u?.count ?? 0, lastUsed: u?.last ?? null, note: value === null ? "blank — never guessed; falls back to your resume data where one exists" : null });
    });
    // Resume/profile-backed answers the question bank derives from MY_DATA.
    const bank: QuestionRecord[] = loadQuestionBank(opts.questionsDir, "__none__", null).records;
    for (const r of bank) {
      if (seen.has(r.canonicalKey) || !r.answerRef) continue;
      const v = resolveAnswer({ record: r, confidence: 1, matchedPattern: "" }, opts.profile).value;
      if (v === null) continue;
      const cat = categoryOf(r.patterns[0] ?? r.canonicalKey, r.canonicalKey, []);
      const u = opts.usage.get(r.canonicalKey);
      out.push({ id: r.canonicalKey, question: r.patterns[0] ?? r.canonicalKey, answer: v, category: cat.category, scope: "GLOBAL", company: null, source: r.answerRef.startsWith("derived.") ? "RESUME" : "PROFILE", editable: false, disabled: false, line: null, usageCount: u?.count ?? 0, lastUsed: u?.last ?? null, note: `from your resume data (${r.answerRef}); write your own answer to override it` });
    }
    return out;
  }
}
