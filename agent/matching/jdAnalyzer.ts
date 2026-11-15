import type { JobRequirements, WorkMode } from "../core/schemas.ts";
import { detectSkills } from "./skillCatalog.ts";

type SectionKind = "required" | "preferred" | "responsibilities" | "other";

const HEADING_RULES: Array<[RegExp, SectionKind]> = [
  [/\b(nice[- ]to[- ]have|preferred|bonus|good[- ]to[- ]have|plus|desirable|additional (skills|qualifications))\b/i, "preferred"],
  [/\b(requirements?|qualifications?|must[- ]have|what you('ll)? (need|bring)|who you are|skills|required|minimum|basic qualifications|you have|about you|what we('re)? looking for|eligibility)\b/i, "required"],
  [/\b(responsibilit(y|ies)|what you('ll)? do|the role|your role|day[- ]to[- ]day|duties|you will|key result)\b/i, "responsibilities"],
];

export function headingKind(line: string): SectionKind | null {
  const t = line.replace(/[#*:_\-–•]+/g, " ").trim();
  if (!t || t.length > 80 || /[.!?]$/.test(t)) return null; // headings are short and not sentences
  // "Minimum 5 years of experience", "Immediate joiners preferred", "CGPA 7.5 and above" are requirements, not headings.
  if (/[\d₹%]/.test(t) || /\b(joiners?|welcome|apply|eligible|candidates?)\b/i.test(t)) return null;
  for (const [re, kind] of HEADING_RULES) if (re.test(t)) return kind;
  return null;
}

/** Splits JD text into sections using heading-like lines. Unsectioned text is "other". */
export function sectionize(jd: string): Array<{ kind: SectionKind; lines: string[] }> {
  const out: Array<{ kind: SectionKind; lines: string[] }> = [{ kind: "other", lines: [] }];
  for (const raw of jd.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const kind = headingKind(line);
    if (kind) out.push({ kind, lines: [] });
    else out[out.length - 1]?.lines.push(line);
  }
  return out.filter((s) => s.lines.length > 0);
}

const YEARS_RE = /(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*(\d{1,2})\s*)?\+?\s*(?:years?|yrs?)(?:\s+of)?(?:\s+\w+){0,4}\s+(?:experience|exp\b)/gi;
const FRESHER_RE = /\b(fresher|freshers|entry[- ]level|new grad(uate)?s?|recent graduates?|0\s*(?:-|–|to)\s*\d\s*(?:years?|yrs?))\b/i;

export function extractExperience(jd: string): { min: number | null; max: number | null; text: string | null } {
  let best: { min: number; max: number | null; text: string } | null = null;
  for (const m of jd.matchAll(YEARS_RE)) {
    const min = Number(m[1]);
    const max = m[2] ? Number(m[2]) : null;
    if (min > 25) continue;
    // Choose the smallest stated minimum: JDs often list "5+ years" for a nice-to-have alongside the real bar.
    if (!best || min < best.min) best = { min, max, text: m[0].trim() };
  }
  if (best) return best;
  const fresher = FRESHER_RE.exec(jd);
  if (fresher) return { min: 0, max: null, text: fresher[0] };
  return { min: null, max: null, text: null };
}

const EDUCATION_RE = /\b(bachelor'?s?|b\.?\s?e\.?|b\.?\s?tech|b\.?\s?s\.?c?|master'?s?|m\.?\s?tech|m\.?\s?s\.?|mca|bca|ph\.?\s?d|degree)\b[^.\n]{0,120}/gi;

export function extractEducation(jd: string): string[] {
  const out = new Set<string>();
  for (const m of jd.matchAll(EDUCATION_RE)) {
    const snippet = m[0].trim();
    if (/\bdegree\b/i.test(snippet) || /bachelor|master|b\.?\s?tech|m\.?\s?tech|ph\.?\s?d|mca|bca/i.test(snippet)) out.add(snippet.slice(0, 140));
    if (out.size >= 5) break;
  }
  return [...out];
}

/**
 * Deterministic requirement extraction. Everything returned is traceable to a phrase in the JD text;
 * nothing is inferred from the job title alone except roleKeywords.
 */
export function analyzeJd(input: { jdText: string; jobTitle: string; location: string; workMode: WorkMode | null }): JobRequirements {
  const sections = sectionize(input.jdText);
  const required = new Set<string>();
  const preferred = new Set<string>();
  const responsibilities: string[] = [];

  for (const sec of sections) {
    for (const line of sec.lines) {
      const skills = detectSkills(line);
      const linePreferred = /\b(nice to have|preferred|is a plus|a plus|bonus|good to have|desirable|familiarity with)\b/i.test(line);
      if (sec.kind === "preferred" || linePreferred) skills.forEach((sk) => preferred.add(sk));
      else skills.forEach((sk) => required.add(sk));
      if (sec.kind === "responsibilities" && responsibilities.length < 15) responsibilities.push(line.replace(/^[•*\-–]\s*/, ""));
    }
  }
  for (const sk of required) preferred.delete(sk);
  const exp = extractExperience(input.jdText);
  const roleKeywords = [...new Set(input.jobTitle.toLowerCase().split(/[^a-z0-9+#.]+/).filter((t) => t.length > 1))];

  return {
    requiredSkills: [...required],
    preferredSkills: [...preferred],
    responsibilities,
    roleKeywords,
    minYearsExperience: exp.min,
    maxYearsExperience: exp.max,
    experienceText: exp.text,
    educationRequirements: extractEducation(input.jdText),
    location: input.location,
    workMode: input.workMode,
    extractionMethod: "deterministic",
  };
}
