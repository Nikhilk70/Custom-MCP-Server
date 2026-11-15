import fs from "node:fs";
import path from "node:path";
import { AgentError } from "../../agent/core/errors.ts";
import type { AgentRuntime } from "../runtime.ts";
import { PROFILE_SECTIONS } from "./profile.ts";
import { listResumes } from "./resumes.ts";

/**
 * Reads an uploaded resume PDF and proposes values for the Edit profile form. Nothing is saved here: the proposals are
 * shown as unsaved edits that you review, change and save yourself. Values are only taken when the resume states them
 * (Gemini when configured, otherwise simple pattern matching for contact details, links and education).
 */
export interface ResumeAutofill {
  resumeId: string;
  label: string;
  source: "AI" | "PATTERNS";
  extractedAt: string;
  fields: Record<string, string>;
  /** Why AI was not used, when it was not. */
  note: string | null;
}

const CACHE = (dir: string) => path.join(dir, "autofill.json");
const readCache = (dir: string): Record<string, ResumeAutofill & { mtime?: string }> => {
  try {
    return JSON.parse(fs.readFileSync(CACHE(dir), "utf8")) as Record<string, ResumeAutofill>;
  } catch {
    return {};
  }
};

const PROFILE_KEYS = PROFILE_SECTIONS.flatMap((s) => s.fields.map((f) => f.key));

export async function pdfText(file: string): Promise<string> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true });
  const doc = await task.promise;
  let out = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    out += content.items.map((x) => ("str" in x ? x.str + (x.hasEOL ? "\n" : "") : "")).join("") + "\n";
  }
  await task.destroy();
  return out.replace(/[ \t]+/g, " ").trim();
}

/** Contact details, links and education that can be read reliably without a model. */
export function patternFields(raw: string): Record<string, string> {
  const f: Record<string, string> = {};
  // PDF link annotations are often glued onto the visible text ("…@gmail.comhttps://github.com/…").
  const text = raw.replace(/(?<=\S)(https?:\/\/)/g, " $1");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const email = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  if (email) f.Email = email[0].replace(/(\.(?:com|net|org|edu|gov|in|io|co|ai|dev|me|info|uk|us))[a-z0-9].*$/i, "$1");
  const phone = text.match(/(\+\d{1,3})?[\s-]?\(?\d{3,5}\)?[\s-]?\d{3,5}[\s-]?\d{0,5}/g)?.find((p) => p.replace(/\D/g, "").length >= 10 && p.replace(/\D/g, "").length <= 13);
  if (phone) {
    const cc = phone.match(/^\s*(\+\d{1,3})/);
    if (cc?.[1]) f.Extension = cc[1];
    f["Contact Number"] = phone.replace(/^\s*\+\d{1,3}/, "").replace(/\D/g, "");
  }
  const link = (re: RegExp) => text.match(re)?.[0].replace(/[.,;)]+$/, "");
  const li = link(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w%-]+\/?/i);
  if (li) f.LinkedIn = li.startsWith("http") ? li : `https://${li}`;
  // Your profile link (github.com/you), not a repository link that may belong to someone else.
  const ghUsers = [...text.matchAll(/github\.com\/([\w-]+)(\/[\w.-]+)?/gi)];
  const ghUser = ghUsers.find((m) => !m[2])?.[1] ?? null;
  if (ghUser) f.GitHub = `https://github.com/${ghUser}`;
  const pf = link(/(?:https?:\/\/)?[\w-]+\.(?:github\.io|vercel\.app|netlify\.app)(?:\/[\w./-]*)?/i);
  if (pf) f.Portfolio = pf.startsWith("http") ? pf : `https://${pf}`;
  const first = lines[0];
  if (first && /^[A-Za-z][A-Za-z .'-]{2,50}$/.test(first) && first.split(/\s+/).length >= 2 && first.split(/\s+/).length <= 5) {
    const name = first.replace(/\s+/g, " ").replace(/\b([A-Za-z])([A-Za-z]*)\b/g, (_m, a: string, b: string) => (b.length ? a.toUpperCase() + b.toLowerCase() : a.toUpperCase()));
    const parts = name.split(" ");
    f["Full Name"] = name;
    f["First Name"] = parts[0] ?? "";
    f["Last Name"] = parts.slice(1).join(" ");
  }
  const uni = lines.find((l) => /\b(university|college|institute|iit|nit|school of)\b/i.test(l) && !/\b(training|internship|intern|course|certif\w*|bootcamp|workshop)\b/i.test(l) && l.length < 140);
  if (uni) f["University / College"] = uni.replace(/\s*[|,–-]?\s*\b(19|20)\d{2}\b.*$/, "").trim();
  const deg = text.match(/\b(B\.?\s?E\.?|B\.?\s?Tech|M\.?\s?Tech|B\.?\s?Sc|M\.?\s?Sc|BCA|MCA|MBA|Bachelor of [A-Za-z ]+|Master of [A-Za-z ]+)\b(?:\s*(?:in|,|-|–)\s*([A-Za-z &]+?))?(?=[\n,|(]|\s{2}|\s(?:19|20)\d{2}|$)/i);
  if (deg?.[1]) {
    f["Highest Education"] = deg[1].trim();
    if (deg[2]) f["Field of Study"] = deg[2].trim();
  }
  if (uni || deg) {
    const anchor = text.indexOf(uni ?? deg?.[0] ?? "");
    const years = text.slice(Math.max(0, anchor - 200), anchor + 300).match(/\b(19|20)\d{2}\b/g);
    if (years?.length) f["Graduation Year"] = String(Math.max(...years.map(Number)));
  }
  return f;
}

async function aiFields(rt: AgentRuntime, text: string): Promise<Record<string, string>> {
  const prompt = [
    "Extract job-application profile fields from the resume below.",
    `Return ONLY a JSON object with exactly these keys: ${JSON.stringify(PROFILE_KEYS)}.`,
    "Rules: use a value only when the resume states it explicitly; otherwise use null. Never guess salary, notice period, visa, sponsorship, work-mode or relocation preferences.",
    "Phone: digits only without country code in 'Contact Number', country code like +91 in 'Extension'. Links as full https URLs.",
    "'Current Company' / 'Current Job Title' only for a role marked present/current. Experience values like '1 year 6 months' only when dates make them unambiguous.",
    "'Past Internships': one line per internship, 'Role at Company (Start – End)'.",
    "",
    "RESUME:",
    text.slice(0, 20000),
  ].join("\n");
  const raw = await rt.base.ai.generateText(prompt, { maxOutputTokens: 8192, temperature: 0, json: true });
  const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of PROFILE_KEYS) {
    const v = parsed[k];
    if (typeof v === "string" && v.trim() && !/^(null|n\/a|not (?:provided|mentioned|specified))$/i.test(v.trim())) out[k] = v.trim().slice(0, 1000);
    else if (typeof v === "number") out[k] = String(v);
  }
  return out;
}

/** Extracts (or returns the cached extraction of) an uploaded resume's profile fields. */
export async function resumeAutofill(rt: AgentRuntime, id: string | null, opts: { refresh?: boolean } = {}): Promise<ResumeAutofill | null> {
  const dir = rt.uploadsDir;
  let resumeId = id;
  if (!resumeId) {
    if (!fs.existsSync(dir)) return null;
    const pdfs = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"));
    resumeId = pdfs.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs)[0] ?? null;
    if (!resumeId) return null;
  }
  const file = rt.primaryResumePath(resumeId);
  if (!file) throw new AgentError("NOT_FOUND", "resume not found");
  const cache = readCache(dir);
  const mtime = fs.statSync(file).mtime.toISOString();
  const hit = cache[resumeId];
  if (hit && !opts.refresh && hit.mtime === mtime) {
    const { mtime: _m, ...cached } = hit;
    return cached;
  }

  const text = await pdfText(file);
  if (text.length < 40) throw new AgentError("VALIDATION_FAILED", "could not read text from that PDF (is it a scanned image?)");
  const fromPatterns = patternFields(text);
  let fields = fromPatterns;
  let source: ResumeAutofill["source"] = "PATTERNS";
  let note: string | null = null;
  if (rt.base.ai.status().state === "READY") {
    try {
      // Patterns are exact for contact details; the model fills everything else.
      fields = { ...(await aiFields(rt, text)), ...pickContact(fromPatterns) };
      // Resumes often print the name in capitals; prefer the title-cased reading.
      for (const k of ["Full Name", "First Name", "Last Name"]) if (fields[k] && fields[k] === fields[k].toUpperCase() && fromPatterns[k]) fields[k] = fromPatterns[k];
      source = "AI";
    } catch (e) {
      note = `AI extraction failed (${e instanceof Error ? e.message : String(e)}); used pattern matching`;
    }
  } else note = "AI is not configured; only contact details, links and education were read";

  const label = listResumes(rt).find((r) => r.id === resumeId)?.label ?? resumeId;
  const result: ResumeAutofill = { resumeId, label, source, extractedAt: new Date().toISOString(), fields, note };
  cache[resumeId] = { ...result, mtime };
  fs.writeFileSync(CACHE(dir), JSON.stringify(cache, null, 2));
  return result;
}

const pickContact = (f: Record<string, string>) => Object.fromEntries(Object.entries(f).filter(([k]) => ["Email", "Contact Number", "Extension", "LinkedIn", "GitHub"].includes(k)));

export function forgetAutofill(rt: AgentRuntime, id: string): void {
  const cache = readCache(rt.uploadsDir);
  if (!(id in cache)) return;
  delete cache[id];
  fs.writeFileSync(CACHE(rt.uploadsDir), JSON.stringify(cache, null, 2));
}
