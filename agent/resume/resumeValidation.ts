import fs from "node:fs";
import { fromRoot } from "../core/paths.ts";
import type { Profile } from "../profile/profile.ts";
import { allSkills, SkillIndex } from "../profile/profile.ts";
import { detectSkills } from "../matching/skillCatalog.ts";
import { markerContent, outsideMarkers, validateLatex } from "./latex.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Standalone phone numbers only: optional country code, then 10 digits (optionally split 5+5); never inside a URL/slug.
const PHONE_RE = /(?<![\w/.-])(?:\+\d{1,3}[\s-]?)?\d{5}[\s-]?\d{5}(?![\w-])/g;
const URL_RE = /(?:https?:\/\/|www\.)\S+|\b[\w.-]+\.(?:com|in|io|org|net|dev|app)\/\S*/gi;
const HANDLE_RE = /(linkedin\.com\/in\/[A-Za-z0-9_-]+|github\.com\/[A-Za-z0-9_-]+|leetcode\.com\/(?:u\/)?[A-Za-z0-9_-]+)/gi;

const digits = (s: string) => s.replace(/\D/g, "");

/** Identifiers of the person whose resume came with the uploaded template (Data_Resume/Source/template_owner_markers.json). */
export function loadTemplateOwnerMarkers(): string[] {
  const file = fromRoot("Data_Resume", "Source", "template_owner_markers.json");
  if (!fs.existsSync(file)) return [];
  return ((JSON.parse(fs.readFileSync(file, "utf8")) as { markers?: string[] }).markers ?? []).filter((m) => m.trim().length >= 4);
}

export function noTemplateOwnerData(text: string, markers = loadTemplateOwnerMarkers()): Check {
  const lower = text.toLowerCase();
  const hits = markers.filter((m) => lower.includes(m.toLowerCase()));
  return { name: "identity.no_template_owner_data", ok: hits.length === 0, detail: hits.length ? `template owner data present: ${hits.join(", ")}` : `none of ${markers.length} template-owner identifiers present` };
}

/** Identity checks: user's contact data present; nobody else's email/phone/handles present. */
export function identityChecks(text: string, profile: Profile): Check[] {
  const pr = profile.personal;
  const checks: Check[] = [];
  const flat = text.replace(/\s+/g, " ");
  if (pr.fullName) checks.push({ name: "identity.name", ok: flat.toLowerCase().includes(pr.fullName.toLowerCase()), detail: `expects '${pr.fullName}'` });
  if (pr.email) checks.push({ name: "identity.email", ok: flat.toLowerCase().includes(pr.email.toLowerCase()), detail: `expects ${pr.email}` });
  if (pr.phone) checks.push({ name: "identity.phone", ok: digits(flat).includes(digits(pr.phone)), detail: `expects ${pr.phone}` });

  const foreignEmails = [...new Set(flat.match(EMAIL_RE) ?? [])].filter((m) => m.toLowerCase() !== (pr.email ?? "").toLowerCase());
  checks.push({ name: "identity.no_foreign_email", ok: foreignEmails.length === 0, detail: foreignEmails.length ? `unexpected: ${foreignEmails.join(", ")}` : "none" });

  const myPhone = digits(pr.phone ?? "");
  const foreignPhones = [...new Set(flat.replace(URL_RE, " ").match(PHONE_RE) ?? [])].map(digits).filter((d) => !myPhone.endsWith(d.slice(-10)));
  checks.push({ name: "identity.no_foreign_phone", ok: foreignPhones.length === 0, detail: foreignPhones.length ? `unexpected numbers: ${foreignPhones.join(", ")}` : "none" });

  const allowedHandles = [pr.linkedin, pr.github, ...profile.projects.flatMap((p) => p.links)].filter(Boolean).map((u) => (u ?? "").toLowerCase());
  const foreignHandles = [...new Set((flat.match(HANDLE_RE) ?? []).map((h) => h.toLowerCase()))].filter((h) => !allowedHandles.some((a) => a.includes(h)));
  checks.push({ name: "identity.no_foreign_profiles", ok: foreignHandles.length === 0, detail: foreignHandles.length ? `unexpected: ${foreignHandles.join(", ")}` : "none" });
  return checks;
}

/** Every technology mentioned in the tailorable sections must exist in MY_DATA. */
export function noFabricatedSkills(tex: string, profile: Profile, sections: string[]): Check {
  const index = new SkillIndex(profile);
  // Links are not skill claims: "github.com/you/shop.git" must not read as the skill "Git". Drop them first.
  let text = sections
    .map((s) => markerContent(tex, s))
    .join("\n")
    .replace(/\\href\{[^}]*\}/g, " ")
    .replace(/(?:https?:\/\/|www\.)[^\s}]+/gi, " ")
    .replace(/\\[a-zA-Z]+\*?/g, " ");
  // Remove the user's own skill names first ("Git Bash", "Android Studio", "ChromaDB") so only foreign technologies remain.
  const own = allSkills(profile)
    .flatMap((s) => [s.name, ...s.aliases])
    .filter((n) => n.length > 1)
    .sort((a, b) => b.length - a.length);
  for (const name of own) text = text.split(name).join(" ");
  const unsupported = detectSkills(text).filter((s) => !index.has(s));
  return { name: "facts.no_unsupported_skills", ok: unsupported.length === 0, detail: unsupported.length ? `not in MY_DATA: ${unsupported.join(", ")}` : "all detected technologies are in MY_DATA" };
}

export function texChecks(masterTex: string, generatedTex: string, profile: Profile, tailorable: string[]): Check[] {
  const v = validateLatex(generatedTex);
  const checks: Check[] = [{ name: "latex.structure", ok: v.ok, detail: v.ok ? `sections: ${v.sections.join(" | ")}` : v.errors.join("; ") }];
  const same = outsideMarkers(masterTex) === outsideMarkers(generatedTex);
  checks.push({ name: "template.only_marker_regions_changed", ok: same, detail: same ? "text outside AUTO markers identical to master.tex" : "content outside AUTO markers differs from master.tex" });
  checks.push(noFabricatedSkills(generatedTex, profile, tailorable));
  checks.push(noTemplateOwnerData(generatedTex));
  return checks;
}

export interface PdfInspection {
  ok: boolean;
  pageCount: number | null;
  text: string;
  error: string | null;
}

/** Page count and text (one line per PDF text line) of the compiled resume, read with pdf.js — no Python needed. */
export async function inspectPdf(pdfPath: string): Promise<PdfInspection> {
  if (!fs.existsSync(pdfPath)) return { ok: false, pageCount: null, text: "", error: "PDF file does not exist" };
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  if (Buffer.from(data.subarray(0, 5)).toString("latin1") !== "%PDF-") return { ok: false, pageCount: null, text: "", error: "not a PDF (missing %PDF- header)" };
  try {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({ data, useSystemFonts: true });
    const doc = await task.promise;
    let text = "";
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      text += content.items.map((x) => ("str" in x ? x.str + (x.hasEOL ? "\n" : "") : "")).join("") + "\n";
    }
    const pageCount = doc.numPages;
    await task.destroy();
    return { ok: true, pageCount, text, error: null };
  } catch (err) {
    return { ok: false, pageCount: null, text: "", error: `the PDF could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function pdfChecks(pdfPath: string, profile: Profile, maxPages: number, expectedSections: string[]): Promise<Check[]> {
  const pdf = await inspectPdf(pdfPath);
  const checks: Check[] = [{ name: "pdf.exists_and_parses", ok: pdf.ok, detail: pdf.error ?? `${pdf.pageCount ?? "?"} pages` }];
  if (!pdf.ok) return checks;
  checks.push({ name: "pdf.page_count", ok: pdf.pageCount !== null && pdf.pageCount <= maxPages, detail: `${pdf.pageCount ?? "?"} pages (max ${maxPages})` });
  checks.push(...identityChecks(pdf.text, profile));
  checks.push(noTemplateOwnerData(pdf.text));
  const lower = pdf.text.toLowerCase();
  const missing = expectedSections.filter((s) => !lower.includes(s.toLowerCase()));
  checks.push({ name: "pdf.expected_sections", ok: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : "all present" });
  // A heading is a whole line equal to the section name; words inside bullets don't count.
  const lines = pdf.text.split(/\r?\n/).map((l) => l.trim().toLowerCase());
  const counts = expectedSections.map((s) => ({ s, n: lines.filter((l) => l === s.toLowerCase()).length }));
  const dup = counts.filter((c) => c.n > 1);
  checks.push({ name: "pdf.no_duplicate_sections", ok: dup.length === 0, detail: dup.length ? dup.map((d) => `${d.s}×${d.n}`).join(", ") : "none" });
  return checks;
}
