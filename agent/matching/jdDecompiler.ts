import type { JobRequirements, WorkMode } from "../core/schemas.ts";
import { sha256 } from "../core/text.ts";
import { analyzeJd, headingKind } from "./jdAnalyzer.ts";
import { catalogEntry, detectSkills } from "./skillCatalog.ts";

/**
 * JD Decompiler: raw job description → structured, quoted, confidence-scored intelligence.
 *
 * Rules it never breaks:
 *  - Every value is backed by evidence: an exact quote from the JD text (with its line number) or the job listing's
 *    own structured field. Nothing is inferred from the company name or guessed from the title alone (seniority from
 *    the title is labelled as such).
 *  - Absent information is reported as missing, never filled with a default.
 *  - Statements that disagree are reported as contradictions, not silently resolved.
 *  - Mandatory skills are exactly the matcher's required skills, so this view and the eligibility gate agree.
 */
export const JD_DECOMPILER_VERSION = "jd-decompiler/2";

export type SkillTier = "MANDATORY" | "PREFERRED" | "NICE_TO_HAVE";
export type Seniority = "INTERN" | "ENTRY" | "JUNIOR" | "MID" | "SENIOR" | "LEAD";
export type ExperienceBand = "FRESHER" | "0-1" | "1-2" | "2-5" | "5+";
export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface Evidence {
  /** Exact text: a substring of `DecompiledJd.text` (JD_TEXT) or the listing field value (LISTING). */
  quote: string;
  source: "JD_TEXT" | "LISTING";
  /** 1-based line in `DecompiledJd.text`; null when the JD had no line breaks or for listing fields. */
  line: number | null;
  /** Character offset of the quote in `DecompiledJd.text` (JD_TEXT only). */
  offset: number | null;
  /** Which listing field, for LISTING evidence ("location", "workMode", "salary", "title", "company"). */
  field?: string;
}

export interface Field<T> {
  value: T | null;
  /** 0–1, from the documented rule in CONFIDENCE_RULES. 0 when the value is missing. */
  confidence: number;
  level: ConfidenceLevel;
  evidence: Evidence[];
  /** How the value was obtained, in words. */
  method: string;
}

export interface SkillItem {
  skill: string;
  tier: SkillTier;
  confidence: number;
  evidence: Evidence[];
}

export interface Issue {
  field: string;
  detail: string;
  evidence: Evidence[];
}

export interface DecompiledJd {
  version: string;
  jdHash: string;
  decompiledAt: string;
  /** The JD text the quotes and line numbers refer to (HTML removed, line endings normalised). */
  text: string;
  role: Field<string>;
  company: Field<string>;
  location: Field<{ raw: string; cities: string[]; india: boolean; remote: boolean }>;
  workMode: Field<WorkMode>;
  experience: Field<{ min: number | null; max: number | null; band: ExperienceBand | null; fresherFriendly: boolean }>;
  education: Field<{ degrees: string[]; anyGraduate: boolean }>;
  seniority: Field<Seniority>;
  skills: SkillItem[];
  mandatorySkills: string[];
  preferredSkills: string[];
  niceToHaveSkills: string[];
  responsibilities: Field<string[]>;
  certifications: Field<Array<{ text: string; tier: SkillTier }>>;
  salary: Field<{ min: number | null; max: number | null; unit: "LPA" | "INR_PER_MONTH" | "UNKNOWN"; raw: string }>;
  batch: Field<number[]>;
  cgpa: Field<number>;
  percentage: Field<{ min: number; appliesTo: string[] }>;
  branch: Field<{ branches: string[]; anyBranch: boolean; allowsRelated: boolean }>;
  bond: Field<{ required: boolean; months: number | null; amount: string | null }>;
  noticePeriod: Field<{ maxDays: number | null; immediate: boolean }>;
  domain: Field<string[]>;
  missing: Array<{ field: string; impact: string }>;
  contradictions: Issue[];
  quality: { chars: number; lines: number; sectioned: boolean; malformed: boolean; warnings: string[]; overallConfidence: number };
  /** True when the JD reads like a campus / fresher hiring post (batch, freshers, graduate trainee …). */
  campusJd: boolean;
}

/** Shown next to every confidence in the UI. */
export const CONFIDENCE_RULES = [
  "0.95 — the job listing's own structured field (title, company).",
  "0.90 — the listing's location / work mode / salary field, or an explicitly labelled JD line (\"Experience: 2–4 years\", \"CGPA: 7.0\", \"Batch: 2025\").",
  "0.80 — a clear statement in a JD sentence (\"2+ years of experience in Java\", \"B.E/B.Tech in CS\").",
  "0.70 — found in a sentence without a label, or a skill in an unlabelled section.",
  "0.55 — derived from another field (seniority from years of experience; domain from one keyword).",
  "≤ 0.40 — the JD contradicts itself on this field.",
  "0 — not stated anywhere (listed under Missing).",
];

// ------------------------------------------------------------------ text preparation

interface Segment {
  text: string;
  offset: number;
  line: number | null;
}

const ENTITIES: Record<string, string> = { amp: "&", nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", bull: "•", hellip: "…", rupee: "₹" };

function prepare(raw: string): { text: string; segments: Segment[]; warnings: string[] } {
  const warnings: string[] = [];
  let text = raw.replace(/\r\n?/g, "\n");
  if (/<\/?(p|div|li|ul|ol|br|span|strong|b|em|h[1-6]|table|tr|td)\b[^>]*>/i.test(text)) {
    text = text
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*li[^>]*>/gi, "\n• ")
      .replace(/<\/\s*(p|div|li|h[1-6]|tr|ul|ol)\s*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
        if (e.startsWith("#x") || e.startsWith("#X")) return String.fromCodePoint(parseInt(e.slice(2), 16));
        if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
        return ENTITIES[e.toLowerCase()] ?? m;
      });
    warnings.push("HTML markup was removed; quotes and line numbers refer to the cleaned text");
  }
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  const segments: Segment[] = [];
  let cursor = 0;
  text.split("\n").forEach((rawLine, i) => {
    const start = text.indexOf(rawLine, cursor);
    cursor = start + rawLine.length;
    const t = rawLine.trim();
    if (!t) return;
    segments.push({ text: t, offset: start + rawLine.indexOf(t), line: i + 1 });
  });
  // A JD pasted as one long paragraph: split into bullets/sentences so quotes stay short and precise.
  if (segments.length < 4 && text.length > 300) {
    warnings.push("the JD has almost no line breaks; it was split into sentences (quotes carry character offsets, not line numbers)");
    const out: Segment[] = [];
    for (const s of segments) {
      const re = /[^•●▪·\n]+?(?:[.!?](?=\s+[A-Z(•●▪·]|\s*$)|(?=[•●▪·])|$)/g;
      for (const m of s.text.matchAll(re)) {
        const t = m[0].trim();
        if (t.length < 2) continue;
        out.push({ text: t, offset: s.offset + (m.index ?? 0) + m[0].indexOf(t), line: null });
      }
    }
    return { text, segments: out, warnings };
  }
  return { text, segments, warnings };
}

const MAX_QUOTE = 240;

/** An exact substring of the JD around `at` (index within the segment), at most MAX_QUOTE characters. */
function ev(seg: Segment, at = 0, len = 0): Evidence {
  if (seg.text.length <= MAX_QUOTE) return { quote: seg.text, source: "JD_TEXT", line: seg.line, offset: seg.offset };
  const start = Math.max(0, Math.min(at - 60, seg.text.length - MAX_QUOTE));
  const end = Math.min(seg.text.length, Math.max(start + MAX_QUOTE, at + len));
  return { quote: seg.text.slice(start, end), source: "JD_TEXT", line: seg.line, offset: seg.offset + start };
}
const listing = (field: string, value: string): Evidence => ({ quote: value, source: "LISTING", line: null, offset: null, field });

const level = (c: number): ConfidenceLevel => (c >= 0.85 ? "HIGH" : c >= 0.6 ? "MEDIUM" : c > 0 ? "LOW" : "NONE");
function field<T>(value: T | null, confidence: number, evidence: Evidence[], method: string): Field<T> {
  const c = value === null ? 0 : confidence;
  return { value, confidence: Math.round(c * 100) / 100, level: level(c), evidence, method: value === null ? "not stated" : method };
}
const none = <T>(): Field<T> => field<T>(null, 0, [], "not stated");
const contradict = <T>(f: Field<T>): Field<T> => ({ ...f, confidence: Math.min(f.confidence, 0.4), level: level(Math.min(f.confidence, 0.4)) });

/** Segments matching `re`, each with the match position for precise quoting. */
function find(segs: Segment[], re: RegExp): Array<{ seg: Segment; m: RegExpExecArray }> {
  const out: Array<{ seg: Segment; m: RegExpExecArray }> = [];
  for (const seg of segs) {
    const r = new RegExp(re.source, re.flags.replace("g", ""));
    const m = r.exec(seg.text);
    if (m) out.push({ seg, m });
  }
  return out;
}
const at = (x: { seg: Segment; m: RegExpExecArray }) => ev(x.seg, x.m.index, x.m[0].length);

// ------------------------------------------------------------------ patterns

const NICE = /\b(nice[- ]to[- ]have|good[- ]to[- ]have|bonus|is a plus|a plus|added advantage|an advantage|would be great)\b/i;
const PREF = /\b(preferred|preferably|desirable|familiarity with|exposure to)\b/i;
const MUST = /\b(must|required|mandatory|strong|essential|minimum|should have|hands[- ]on)\b/i;
const LABEL = (name: string) => new RegExp(`^\\W*(?:${name})\\s*[:\\-–]`, "i");

const YEARS = /(\d{1,2}(?:\.\d)?)\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*(\d{1,2}(?:\.\d)?)\s*)?\+?\s*(?:years?|yrs?)(?:\s+of)?(?:\s+[\w/&.+#-]+){0,5}?\s+(?:experience|exp\b)/i;
const YEARS_LABELLED = /\b(?:experience|exp\.?)\s*(?:required)?\s*[:\-–]\s*(\d{1,2}(?:\.\d)?)\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*(\d{1,2}(?:\.\d)?))?\s*\+?\s*(?:years?|yrs?)/i;
const FRESHER = /\b(freshers?|entry[- ]level|new grad(?:uate)?s?|recent graduates?|no (?:prior )?experience required|0\s*(?:-|–|to)\s*\d\s*(?:years?|yrs?))\b/i;

const CITIES: Array<[RegExp, string]> = [
  [/\b(bengaluru|bangalore)\b/i, "Bengaluru"],
  [/\bhyderabad\b/i, "Hyderabad"],
  [/\bchennai\b/i, "Chennai"],
  [/\bpune\b/i, "Pune"],
  [/\b(navi mumbai|mumbai|bombay|thane)\b/i, "Mumbai"],
  [/\b(gurugram|gurgaon)\b/i, "Gurugram"],
  [/\bnoida\b/i, "Noida"],
  [/\b(new delhi|delhi|ncr)\b/i, "Delhi NCR"],
  [/\b(kochi|cochin)\b/i, "Kochi"],
  [/\bcoimbatore\b/i, "Coimbatore"],
  [/\b(mysuru|mysore)\b/i, "Mysuru"],
  [/\bahmedabad\b/i, "Ahmedabad"],
  [/\b(kolkata|calcutta)\b/i, "Kolkata"],
  [/\bjaipur\b/i, "Jaipur"],
  [/\bchandigarh\b/i, "Chandigarh"],
  [/\b(thiruvananthapuram|trivandrum)\b/i, "Thiruvananthapuram"],
  [/\bindore\b/i, "Indore"],
  [/\b(mangaluru|mangalore)\b/i, "Mangaluru"],
  [/\b(visakhapatnam|vizag)\b/i, "Visakhapatnam"],
  [/\bbhubaneswar\b/i, "Bhubaneswar"],
  [/\bnagpur\b/i, "Nagpur"],
];
const citiesIn = (s: string) => [...new Set(CITIES.filter(([re]) => re.test(s)).map(([, c]) => c))];

const DOMAINS: Array<[RegExp, string]> = [
  [/\b(fintech|payments?|banking|lending|trading|financial services|insurance|wealth management)\b/gi, "Fintech / BFSI"],
  [/\b(e-?commerce|retail|marketplace|d2c)\b/gi, "E-commerce / Retail"],
  [/\b(health ?care|healthtech|hospital|clinical|pharma)\b/gi, "Healthcare"],
  [/\b(edtech|education technology|learning platform)\b/gi, "Edtech"],
  [/\b(saas|b2b software|enterprise software)\b/gi, "SaaS"],
  [/\b(cyber ?security|security operations|threat intelligence)\b/gi, "Cybersecurity"],
  [/\b(automotive|vehicle|mobility|autonomous driving)\b/gi, "Automotive / Mobility"],
  [/\b(telecom|5g|networking equipment)\b/gi, "Telecom"],
  [/\b(logistics|supply chain|last[- ]mile)\b/gi, "Logistics"],
  [/\b(gaming|game studio)\b/gi, "Gaming"],
  [/\b(adtech|advertising|martech)\b/gi, "Adtech / Martech"],
  [/\b(machine learning|artificial intelligence|genai|generative ai|llms?)\b/gi, "AI / ML"],
  [/\b(semiconductor|embedded systems|firmware)\b/gi, "Semiconductors / Embedded"],
];

// ------------------------------------------------------------------ main

export interface DecompileInput {
  jobTitle: string;
  companyName: string;
  location: string;
  workMode: WorkMode | null;
  jdText: string | null;
  salary?: string | null;
}

export function decompileJd(input: DecompileInput, reqs?: JobRequirements, now = new Date()): DecompiledJd {
  // Malformed listings arrive with missing fields; treat anything absent as empty rather than failing.
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const job: DecompileInput = { jobTitle: str(input.jobTitle), companyName: str(input.companyName), location: str(input.location), workMode: input.workMode ?? null, jdText: str(input.jdText), salary: typeof input.salary === "string" ? input.salary : null };
  const raw = job.jdText ?? "";
  const { text, segments: segs, warnings } = prepare(raw);
  // The matcher's requirements, computed on the same (cleaned) text, are the authority on mandatory vs preferred.
  const requirements = reqs ?? analyzeJd({ jdText: text, jobTitle: job.jobTitle, location: job.location, workMode: job.workMode });
  const contradictions: Issue[] = [];

  // ---- headings: which section each segment sits in
  const sectionOf = new Map<Segment, "req" | "pref" | "nice" | "resp" | "other">();
  let sec: "req" | "pref" | "nice" | "resp" | "other" = "other";
  let sectioned = false;
  const body: Segment[] = [];
  for (const s of segs) {
    // "Job Description" / "Role Overview" headings (common on Indian ATS pages) introduce the duties.
    const k = /^\W*(job|role|position) (description|summary|overview|details)\W*$/i.test(s.text) ? "responsibilities" : headingKind(s.text);
    if (k) {
      sectioned = true;
      // "About the role/company" introduces the job; it is not a list of duties.
      sec = NICE.test(s.text) ? "nice" : k === "preferred" ? "pref" : k === "required" ? "req" : k === "responsibilities" && !/^\W*about\b/i.test(s.text) ? "resp" : "other";
      continue;
    }
    sectionOf.set(s, sec);
    body.push(s);
  }
  const lineTier = (s: Segment): SkillTier => (NICE.test(s.text) ? "NICE_TO_HAVE" : PREF.test(s.text) || sectionOf.get(s) === "pref" || sectionOf.get(s) === "nice" ? "PREFERRED" : "MANDATORY");
  const softLine = (s: Segment) => NICE.test(s.text) || PREF.test(s.text) || sectionOf.get(s) === "nice" || sectionOf.get(s) === "pref";

  // ---- role & company: listing fields
  const role = job.jobTitle.trim() ? field(job.jobTitle.trim(), 0.95, [listing("title", job.jobTitle.trim())], "job listing title") : none<string>();
  const company = job.companyName.trim() ? field(job.companyName.trim(), 0.95, [listing("company", job.companyName.trim())], "job listing company") : none<string>();

  // ---- location
  const locLines = find(body, /\b(?:job )?location\s*[:\-–]|\bbased (?:in|out of)\b|\bwork(?:ing)? (?:from|out of) our .{0,30}office\b/i);
  const listCities = citiesIn(job.location);
  const jdCities = [...new Set(locLines.flatMap((x) => citiesIn(x.seg.text)))];
  const cities = [...new Set([...listCities, ...jdCities])];
  const remoteLoc = job.workMode === "remote" || /\bremote\b/i.test(job.location);
  let location: Field<{ raw: string; cities: string[]; india: boolean; remote: boolean }> = none();
  if (job.location.trim() || jdCities.length) {
    const evs = [...(job.location.trim() ? [listing("location", job.location.trim())] : []), ...locLines.map(at)];
    location = field({ raw: job.location.trim() || jdCities.join(", "), cities, india: cities.length > 0 || /\bindia\b/i.test(job.location + locLines.map((x) => x.seg.text).join(" ")), remote: remoteLoc }, job.location.trim() ? 0.9 : 0.8, evs, job.location.trim() ? "listing location field, cross-checked with JD location lines" : "JD location line");
    if (listCities.length && jdCities.length && !jdCities.some((c) => listCities.includes(c))) {
      contradictions.push({ field: "location", detail: `the listing says ${listCities.join("/")} but the JD names ${jdCities.join("/")}`, evidence: evs });
      location = contradict(location);
    }
  }

  // ---- work mode
  const REMOTE = /\b(fully remote|remote[- ]first|100% remote|work from home|wfh|remote (?:role|position|job|opportunity|work))\b/i;
  const ONSITE = /(#li-onsite\b|\bon[- ]?site (?:role|position|job)\b|\bwork(?:ing)? from (?:the )?office\b|\bwfo\b|\b(?:5|five) days? (?:a|per) week (?:in|from|at) (?:the )?office\b|\bfully (?:office[- ]based|on[- ]?site)\b)/i;
  // A line naming several arrangements ("flexible, remote, or required in office") describes company policy, not this role.
  const policy = (seg: Segment) => [/\bremote\b/i, /\b(office|on[- ]?site)\b/i, /\b(hybrid|flexible)\b/i].filter((re) => re.test(seg.text)).length >= 2;
  const sig = {
    remote: find(body, REMOTE).filter((x) => !policy(x.seg)),
    hybrid: find(body, /\bhybrid\b|#li-hybrid\b/i),
    onsite: find(body, ONSITE).filter((x) => !policy(x.seg) || /#li-onsite/i.test(x.seg.text)),
  };
  const jdModes = (["remote", "hybrid", "onsite"] as const).filter((m) => sig[m].length);
  const jdMode: WorkMode | null = jdModes.includes("hybrid") ? "hybrid" : jdModes.length === 1 ? (jdModes[0] ?? null) : null;
  const modeEvs = [...sig.remote, ...sig.hybrid, ...sig.onsite].map(at);
  let workMode: Field<WorkMode> = none();
  if (job.workMode) workMode = field(job.workMode, 0.9, [listing("workMode", job.workMode), ...modeEvs], "listing work-mode field");
  else if (jdMode) workMode = field(jdMode, jdModes.includes("hybrid") && jdModes.includes("onsite") ? 0.8 : 0.75, modeEvs, "work-mode wording in the JD");
  if (jdModes.includes("remote") && jdModes.includes("onsite") && !jdModes.includes("hybrid")) {
    contradictions.push({ field: "workMode", detail: "the JD describes the role as remote and also as office-based", evidence: modeEvs });
    workMode = contradict(workMode);
  } else if (job.workMode && jdMode && job.workMode !== jdMode) {
    contradictions.push({ field: "workMode", detail: `the listing says ${job.workMode} but the JD reads as ${jdMode}`, evidence: [listing("workMode", job.workMode), ...modeEvs] });
    workMode = contradict(workMode);
  }

  // ---- experience
  const yearHits = [...find(body, YEARS_LABELLED).map((x) => ({ ...x, labelled: true })), ...find(body, YEARS).map((x) => ({ ...x, labelled: false }))].filter((x, i, a) => a.findIndex((y) => y.seg === x.seg) === i);
  const stated = yearHits
    .map((x) => ({ min: Number(x.m[1]), max: x.m[2] ? Number(x.m[2]) : null, seg: x.seg, labelled: x.labelled, ev: at(x) }))
    .filter((x) => x.min <= 25);
  const fresherHit = find(body, FRESHER)[0] ?? null;
  const fresherTitle = /\b(fresher|trainee|graduate engineer|intern|entry[- ]level|campus)\b/i.test(job.jobTitle);
  let experience: Field<DecompiledJd["experience"] extends Field<infer T> ? T : never> = none();
  const hard = stated.filter((s) => !softLine(s.seg));
  // The eligibility gate's own reading wins when it found one; otherwise the JD's statements are still reported,
  // and the method says plainly that the gate did not see them.
  const gateSaw = requirements.minYearsExperience !== null;
  const own = stated.find((s) => s.labelled) ?? [...hard].sort((a, b) => a.min - b.min)[0] ?? null;
  const minVal = gateSaw ? requirements.minYearsExperience : (own?.min ?? null);
  const maxVal = gateSaw ? requirements.maxYearsExperience : (own?.max ?? null);
  if (minVal !== null) {
    const ev0 = stated.find((s) => s.min === minVal) ?? stated[0];
    experience = field(
      { min: minVal, max: maxVal, band: band(minVal), fresherFriendly: minVal === 0 },
      ev0?.labelled ? 0.9 : ev0 ? 0.8 : 0.7,
      [...stated.map((s) => s.ev), ...(fresherHit ? [at(fresherHit)] : [])].filter((e, i, a) => a.findIndex((y) => y.offset === e.offset) === i),
      gateSaw
        ? "years-of-experience statement in the JD (the smallest stated minimum, as the eligibility check uses)"
        : "years-of-experience statement in the JD — note: the eligibility check did not recognise this wording and treats experience as unknown",
    );
  }
  const mins = [...new Set(hard.map((s) => s.min))].sort((a, b) => a - b);
  if (mins.length >= 2 && (mins.at(-1) ?? 0) - (mins[0] ?? 0) >= 3) {
    const OVERALL = /\b(overall|total|professional|industry|it\/software|software (?:development|engineering)|relevant)\b/i;
    const overall = hard.filter((s) => OVERALL.test(s.seg.text)).sort((a, b) => b.min - a.min)[0];
    const lo = mins[0] ?? 0;
    const detail =
      overall && overall.min > lo
        ? `the overall requirement is ${overall.min}+ years, while ${lo}+ years is asked for one specific skill — ${gateSaw ? `the eligibility check uses ${requirements.minYearsExperience ?? lo} years` : "the eligibility check did not recognise either statement"}, so the real bar is likely ${overall.min}+`
        : `the JD states both ${lo} and ${mins.at(-1)}+ years as requirements`;
    contradictions.push({ field: "experience", detail, evidence: hard.map((s) => s.ev) });
    experience = contradict(experience);
  }
  if (fresherHit && hard.some((s) => s.min >= 2)) {
    contradictions.push({ field: "experience", detail: `the JD invites freshers but also asks for ${Math.max(...hard.map((s) => s.min))}+ years`, evidence: [at(fresherHit), ...hard.filter((s) => s.min >= 2).map((s) => s.ev)] });
    experience = contradict(experience);
  }
  for (const s of stated) if (s.max !== null && s.max < s.min) contradictions.push({ field: "experience", detail: `range ${s.min}–${s.max} years has its maximum below its minimum`, evidence: [s.ev] });

  // ---- seniority
  const t = job.jobTitle.toLowerCase();
  const titleLevel: Seniority | null = /\bintern(ship)?\b/.test(t)
    ? "INTERN"
    : /\b(trainee|graduate engineer|get\b|fresher|entry[- ]level|new grad|associate software engineer)\b/.test(t)
      ? "ENTRY"
      : /\b(principal|staff|architect|head|director|manager|lead)\b/.test(t)
        ? "LEAD"
        : /\b(senior|sr\.?)\b/.test(t)
          ? "SENIOR"
          : /\b(junior|jr\.?)\b/.test(t)
            ? "JUNIOR"
            : null;
  let seniority: Field<Seniority> = titleLevel
    ? field(titleLevel, 0.85, [listing("title", job.jobTitle)], "level word in the job title")
    : minVal !== null
      ? field<Seniority>(minVal <= 0 ? "ENTRY" : minVal <= 2 ? "JUNIOR" : minVal <= 5 ? "MID" : "SENIOR", 0.55, experience.evidence.slice(0, 1), `derived from the ${minVal}+ years requirement`)
      : fresherHit
        ? field<Seniority>("ENTRY", 0.6, [at(fresherHit)], "fresher wording in the JD")
        : none();
  if (titleLevel && ["SENIOR", "LEAD"].includes(titleLevel) && minVal !== null && minVal <= 1) {
    contradictions.push({ field: "seniority", detail: `the title says ${titleLevel.toLowerCase()} but the JD asks for only ${minVal} years`, evidence: [listing("title", job.jobTitle), ...experience.evidence.slice(0, 1)] });
    seniority = contradict(seniority);
  }
  if (titleLevel && ["INTERN", "ENTRY"].includes(titleLevel) && minVal !== null && minVal >= 3) {
    contradictions.push({ field: "seniority", detail: `the title reads as ${titleLevel.toLowerCase()} but the JD asks for ${minVal}+ years`, evidence: [listing("title", job.jobTitle), ...experience.evidence.slice(0, 1)] });
    seniority = contradict(seniority);
  }

  // ---- education
  const DEG: Array<[RegExp, string]> = [
    [/\bb\.?\s?e\b\.?|\bb\.?\s?tech\b|\bbachelor'?s? (?:of|in) engineering\b/i, "BE/BTech"],
    [/\bm\.?\s?e\b\.?(?=\s|\/|,|$)|\bm\.?\s?tech\b/i, "ME/MTech"],
    [/\bmca\b/i, "MCA"],
    [/\bbca\b/i, "BCA"],
    [/\bb\.?\s?sc\b/i, "BSc"],
    [/\bm\.?\s?sc\b/i, "MSc"],
    [/\bmba\b/i, "MBA"],
    [/\bdiploma\b/i, "Diploma"],
    [/\bph\.?\s?d\b/i, "PhD"],
    [/\bbachelor'?s?\b/i, "Bachelor's (any)"],
    [/\bmaster'?s?\b/i, "Master's (any)"],
  ];
  const eduLines = find(body, /\b(b\.?\s?e\b|b\.?\s?tech|m\.?\s?tech|mca|bca|b\.?\s?sc|m\.?\s?sc|mba|diploma|ph\.?\s?d|bachelor'?s?|master'?s?|degree|graduat(?:e|ion) in|any graduate)\b/i).filter((x) => !/\bdegree of (ownership|autonomy|freedom)\b/i.test(x.seg.text));
  const degrees = [...new Set(eduLines.flatMap((x) => DEG.filter(([re]) => re.test(x.seg.text)).map(([, d]) => d)))];
  const specific = degrees.filter((d) => !d.endsWith("(any)"));
  const anyGraduate = eduLines.some((x) => /\b(any graduate|any degree|graduation in any|any discipline|any stream)\b/i.test(x.seg.text));
  const education = eduLines.length ? field({ degrees: specific.length ? [...specific, ...degrees.filter((d) => d.endsWith("(any)") && !specific.length)] : degrees, anyGraduate }, degrees.length ? 0.8 : 0.6, eduLines.map(at), "degree wording in the JD") : none<{ degrees: string[]; anyGraduate: boolean }>();

  // ---- skills (tiers)
  const tierOf = new Map<string, { tier: SkillTier; conf: number; ev: Evidence }>();
  const rank: Record<SkillTier, number> = { MANDATORY: 3, PREFERRED: 2, NICE_TO_HAVE: 1 };
  for (const s of body) {
    const found = detectSkills(s.text);
    if (!found.length) continue;
    const secn = sectionOf.get(s);
    const tier: SkillTier = NICE.test(s.text) || secn === "nice" ? "NICE_TO_HAVE" : PREF.test(s.text) || secn === "pref" ? "PREFERRED" : "MANDATORY";
    const conf = tier === "MANDATORY" ? (secn === "req" || MUST.test(s.text) ? 0.9 : 0.7) : NICE.test(s.text) || PREF.test(s.text) ? 0.9 : 0.8;
    for (const sk of found) {
      const cur = tierOf.get(sk);
      // Strongest tier wins; within a tier, the clearest statement (e.g. under "Requirements") is the evidence.
      // Quote the window around the skill itself, so long lines still show the mention.
      const pos = catalogEntry(sk)?.pattern.exec(s.text)?.index ?? 0;
      if (!cur || rank[tier] > rank[cur.tier] || (rank[tier] === rank[cur.tier] && conf > cur.conf)) tierOf.set(sk, { tier, conf, ev: ev(s, pos, sk.length) });
    }
  }
  const skills: SkillItem[] = [
    ...requirements.requiredSkills.map((sk): SkillItem => ({ skill: sk, tier: "MANDATORY", confidence: tierOf.get(sk)?.tier === "MANDATORY" ? (tierOf.get(sk)?.conf ?? 0.7) : 0.7, evidence: tierOf.get(sk) ? [tierOf.get(sk)?.ev as Evidence] : [] })),
    ...requirements.preferredSkills.map((sk): SkillItem => {
      const x = tierOf.get(sk);
      return { skill: sk, tier: x?.tier === "NICE_TO_HAVE" ? "NICE_TO_HAVE" : "PREFERRED", confidence: x?.conf ?? 0.7, evidence: x ? [x.ev] : [] };
    }),
  ];

  // ---- responsibilities
  const respSegs = body.filter((s) => sectionOf.get(s) === "resp");
  const respList = (respSegs.length ? respSegs : requirements.responsibilities.map((r) => body.find((s) => s.text.includes(r))).filter((s): s is Segment => !!s)).slice(0, 15);
  const responsibilities = respList.length ? field(respList.map((s) => s.text.replace(/^[•●▪·*\-–]\s*/, "")), respSegs.length ? 0.85 : 0.7, respList.map((s) => ev(s)), respSegs.length ? "lines under a responsibilities heading" : "responsibility-like lines") : none<string[]>();

  // ---- certifications
  const certHits = find(body, /\bcertif(?:ied|ication|icate)s?\b/i).filter((x) => !/\bcertificate of (employment|experience)\b/i.test(x.seg.text));
  const certifications = certHits.length ? field(certHits.map((x) => ({ text: x.seg.text.slice(0, MAX_QUOTE), tier: lineTier(x.seg) })), 0.8, certHits.map(at), "certification wording in the JD") : none<Array<{ text: string; tier: SkillTier }>>();

  // ---- salary
  let salary: DecompiledJd["salary"] = none();
  const SAL_LABEL = LABEL("ctc|salary|compensation|package|stipend|pay");
  const lpaRange = find(body, /(?:₹|rs\.?|inr)?\s*(\d{1,2}(?:\.\d{1,2})?)\s*(?:-|–|to)\s*(\d{1,2}(?:\.\d{1,2})?)\s*(?:lpa|lakhs?(?:\s*per\s*annum)?\b|l\.?p\.?a\.?)/i)[0];
  const lpaOne = find(body, /(?:₹|rs\.?|inr)?\s*(\d{1,2}(?:\.\d{1,2})?)\s*(?:lpa|lakhs?\s*per\s*annum|l\.?p\.?a\.?)/i)[0];
  const inr = find(body, /(?:₹|rs\.?\s?|inr\s?)([\d,]{4,})(?:\s*(?:-|–|to)\s*(?:₹|rs\.?\s?|inr\s?)?([\d,]{4,}))?\s*(per month|\/\s?month|p\.?m\.?|monthly|per annum|p\.?a\.?|\/\s?year|per year|annually)?/i)[0];
  if (job.salary?.trim()) salary = field({ min: null, max: null, unit: "UNKNOWN", raw: job.salary.trim() }, 0.9, [listing("salary", job.salary.trim())], "listing salary field (not parsed)");
  else if (lpaRange) salary = field({ min: Number(lpaRange.m[1]), max: Number(lpaRange.m[2]), unit: "LPA", raw: lpaRange.m[0].trim() }, SAL_LABEL.test(lpaRange.seg.text) ? 0.9 : 0.85, [at(lpaRange)], "salary range in the JD");
  else if (lpaOne) salary = field({ min: Number(lpaOne.m[1]), max: Number(lpaOne.m[1]), unit: "LPA", raw: lpaOne.m[0].trim() }, SAL_LABEL.test(lpaOne.seg.text) ? 0.9 : 0.8, [at(lpaOne)], "salary figure in the JD");
  else if (inr) {
    const a = Number((inr.m[1] ?? "").replace(/,/g, ""));
    const b = inr.m[2] ? Number(inr.m[2].replace(/,/g, "")) : a;
    const monthly = /month|p\.?m|monthly/i.test(inr.m[3] ?? "") || /\bstipend\b/i.test(inr.seg.text);
    salary = monthly
      ? field({ min: a, max: b, unit: "INR_PER_MONTH", raw: inr.m[0].trim() }, 0.8, [at(inr)], "monthly amount (stipend/salary) in the JD")
      : a >= 100000
        ? field({ min: Math.round((a / 100000) * 100) / 100, max: Math.round((b / 100000) * 100) / 100, unit: "LPA", raw: inr.m[0].trim() }, 0.75, [at(inr)], "annual rupee amount in the JD, converted to LPA")
        : field({ min: a, max: b, unit: "UNKNOWN", raw: inr.m[0].trim() }, 0.5, [at(inr)], "rupee amount without a period");
  }

  // ---- India campus filters
  const batchHits = find(body, /\b(batch|pass(?:ed)?[- ]?outs?|passing out|year of passing|yop|graduating (?:in|class)|graduates? of|class of)\b/i).filter((x) => /\b20[1-3]\d\b/.test(x.seg.text));
  const yearsOf = (s: string) => {
    const ys = new Set<number>();
    for (const m of s.matchAll(/\b(20[1-3]\d)\s*(?:-|–|to)\s*(20[1-3]\d)\b/g)) for (let y = Number(m[1]); y <= Number(m[2]) && y - Number(m[1]) < 8; y++) ys.add(y);
    for (const m of s.matchAll(/\b(20[1-3]\d)\b/g)) ys.add(Number(m[1]));
    return [...ys].sort();
  };
  let batch: Field<number[]> = none();
  if (batchHits.length) {
    const all = [...new Set(batchHits.flatMap((x) => yearsOf(x.seg.text)))].sort();
    batch = field(all, batchHits.some((x) => LABEL("batch|yop|year of passing|eligible batch(?:es)?").test(x.seg.text)) ? 0.9 : 0.8, batchHits.map(at), "batch / year-of-passing statement");
    const sets = batchHits.map((x) => yearsOf(x.seg.text));
    if (sets.length >= 2 && sets.some((a, i) => sets.some((b, j) => j > i && !a.some((y) => b.includes(y))))) {
      contradictions.push({ field: "batch", detail: `different eligible batches are stated: ${sets.map((s) => s.join("/")).join(" vs ")}`, evidence: batchHits.map(at) });
      batch = contradict(batch);
    }
  }

  const cgpaHits = [...find(body, /\b(?:cgpa|cpi|gpa)\b\s*(?:of|:|-|–|>=|≥|>|above|minimum|min\.?|at least|atleast)?\s*(?:of\s*)?(\d{1,2}(?:\.\d{1,2})?)(?!\s*%)/i), ...find(body, /(\d{1,2}(?:\.\d{1,2})?)\s*(?:\/\s*10\s*)?(?:\+|and above|or above)?\s*(?:cgpa|cpi|gpa)\b/i)].filter((x) => Number(x.m[1]) > 0 && Number(x.m[1]) <= 10);
  let cgpa: Field<number> = none();
  if (cgpaHits.length) {
    const vals = [...new Set(cgpaHits.map((x) => Number(x.m[1])))];
    cgpa = field(Math.max(...vals), cgpaHits.some((x) => LABEL("cgpa|cpi|gpa|minimum cgpa").test(x.seg.text)) ? 0.9 : 0.8, cgpaHits.map(at), vals.length > 1 ? "highest of the stated CGPA minimums" : "CGPA minimum in the JD");
    if (vals.length > 1) {
      contradictions.push({ field: "cgpa", detail: `different CGPA minimums are stated: ${vals.join(" and ")}`, evidence: cgpaHits.map(at) });
      cgpa = contradict(cgpa);
    }
  }

  const ACADEMIC = /\b(marks|percentage|aggregate|academics?|10th|12th|x\b|xii|ssc|hsc|puc|sslc|class (?:x|xii|10|12)|graduation|ug\b|pg\b|throughout|degree|diploma|criteria|eligibility)\b/i;
  const pctHits = find(body, /(\d{2}(?:\.\d{1,2})?)\s*%/).filter((x) => ACADEMIC.test(x.seg.text) && !/\b(remote|travel|hike|increment|bonus|equity|discount|uptime|coverage|test)\b/i.test(x.seg.text) && Number(x.m[1]) >= 35 && Number(x.m[1]) <= 100);
  let percentage: DecompiledJd["percentage"] = none();
  if (pctHits.length) {
    const first = pctHits[0];
    const s = first?.seg.text ?? "";
    const applies = [
      ...(/\b(10th|ssc|sslc|class (?:x|10)|x\b)/i.test(s) ? ["10th"] : []),
      ...(/\b(12th|hsc|puc|xii|class (?:xii|12)|diploma)\b/i.test(s) ? ["12th/Diploma"] : []),
      ...(/\b(graduation|ug\b|degree|b\.?\s?e|b\.?\s?tech)\b/i.test(s) ? ["Graduation"] : []),
      ...(/\bpg\b|post[- ]?graduation/i.test(s) ? ["Post-graduation"] : []),
    ];
    const all = /\bthroughout\b|\ball (?:academics|semesters|levels)\b/i.test(s) ? ["10th", "12th/Diploma", "Graduation"] : applies;
    percentage = field({ min: Number(first?.m[1]), appliesTo: all.length ? [...new Set(all)] : ["unspecified"] }, 0.8, pctHits.map(at), "academic percentage requirement");
    const vals = [...new Set(pctHits.map((x) => Number(x.m[1])))];
    if (vals.length > 1 && pctHits.every((x) => /\bthroughout\b/i.test(x.seg.text) || !/(10th|12th|graduation|ssc|hsc|puc)/i.test(x.seg.text))) {
      contradictions.push({ field: "percentage", detail: `different overall percentage minimums are stated: ${vals.join("% and ")}%`, evidence: pctHits.map(at) });
      percentage = contradict(percentage);
    }
  }

  const branchHits = find(body, /\b(branch(?:es)?|stream|discipline|b\.?\s?e|b\.?\s?tech|m\.?\s?tech|mca|degree|graduat\w+)\b/i).filter((x) => /\b(computer|cse|\bcs\b|information|\bit\b|ise|electronics|ece|e\s?&\s?c|entc|electrical|eee|eie|instrumentation|mechanical|civil|chemical|mca|circuit|any branch|all branches|any (?:discipline|stream))\b/i.test(x.seg.text));
  let branch: DecompiledJd["branch"] = none();
  if (branchHits.length) {
    const s = branchHits.map((x) => x.seg.text).join(" ");
    const b = new Set<string>();
    if (/\b(computer science|cse|\bcs\b|computer engineering|computer)\b/i.test(s)) b.add("CS");
    if (/\b(information technology|\bit\b|information science|ise)\b/i.test(s)) b.add("IT");
    if (/\b(electronics|ece|e\s?&\s?c|entc|telecommunication)\b/i.test(s)) b.add("ECE");
    if (/\b(electrical|eee)\b/i.test(s)) b.add("EEE");
    if (/\b(eie|instrumentation)\b/i.test(s)) b.add("EIE");
    if (/\bmechanical\b/i.test(s)) b.add("Mechanical");
    if (/\bcivil\b/i.test(s)) b.add("Civil");
    if (/\bchemical\b/i.test(s)) b.add("Chemical");
    if (/\bcircuit branch(?:es)?\b/i.test(s)) ["CS", "IT", "ECE", "EEE", "EIE"].forEach((x) => b.add(x));
    const anyBranch = /\b(any branch|all branches|any (?:discipline|stream)|any graduate)\b/i.test(s);
    branch = field({ branches: anyBranch ? [] : [...b], anyBranch, allowsRelated: anyBranch || /\b(related|equivalent|allied|similar)\b/i.test(s) }, 0.8, branchHits.map(at), "branch / discipline wording");
  }

  const bondHits = find(body, /\b(bond|service agreement|service commitment|minimum service period|lock[- ]in)\b/i);
  let bond: DecompiledJd["bond"] = none();
  if (bondHits.length) {
    const s = bondHits.map((x) => x.seg.text).join(" ");
    const no = /\bno (?:service )?bond\b|\bwithout (?:any )?bond\b/i.test(s);
    const dur = /(\d+(?:\.\d)?)\s*(years?|yrs?|months?)/i.exec(s);
    const months = dur ? Math.round(Number(dur[1]) * (/^m/i.test(dur[2] ?? "") ? 1 : 12)) : null;
    const amount = /(?:₹|rs\.?\s?|inr\s?)\s*([\d,.]+\s*(?:lakhs?|l\b|lpa)?)/i.exec(s)?.[0].trim() ?? null;
    bond = field({ required: !no, months: no ? null : months, amount: no ? null : amount }, 0.85, bondHits.map(at), no ? "explicit no-bond statement" : "bond / service agreement wording");
  }

  const noticeHits = find(body, /\b(immediate joiners?|join immediately|immediate joining|notice period|serving notice|can join within)\b/i);
  let noticePeriod: DecompiledJd["noticePeriod"] = none();
  if (noticeHits.length) {
    const s = noticeHits.map((x) => x.seg.text).join(" ");
    const immediate = /\bimmediate\b|join immediately/i.test(s);
    const d = /(?:up to|upto|maximum|max\.?|less than|within|of|<=?)\s*(\d{1,3})\s*(days?|weeks?|months?)/i.exec(s) ?? /(\d{1,3})\s*(days?|weeks?|months?)\s*(?:notice|or less|max)/i.exec(s);
    const days = d ? Number(d[1]) * (/^w/i.test(d[2] ?? "") ? 7 : /^m/i.test(d[2] ?? "") ? 30 : 1) : immediate ? 0 : null;
    noticePeriod = field({ maxDays: days, immediate }, d || immediate ? 0.85 : 0.6, noticeHits.map(at), "notice-period / joining wording");
  }

  // ---- domain
  const hits = DOMAINS.map(([re, name]) => ({ name, n: [...text.matchAll(re)].length, ev: find(body, new RegExp(re.source, "i")).slice(0, 2).map(at) })).filter((d) => d.n > 0).sort((a, b) => b.n - a.n);
  const domain = hits.length ? field(hits.slice(0, 3).map((d) => d.name), (hits[0]?.n ?? 0) >= 2 ? 0.7 : 0.55, hits.slice(0, 3).flatMap((d) => d.ev), "industry keywords in the JD (keyword count)") : none<string[]>();

  // ---- campus JD?
  const fresherWords = find(body, /\b(freshers?|entry[- ]level|new grad(?:uate)?s?|recent graduates?|no (?:prior )?experience required)\b/i).length > 0;
  const campusJd = fresherWords || fresherTitle || batch.value !== null || cgpa.value !== null || /\b(campus|off[- ]campus|on[- ]campus|graduate (?:trainee|engineer)|freshers? hiring)\b/i.test(text);

  // ---- missing information
  const missing: DecompiledJd["missing"] = [];
  const miss = (name: string, f: { value: unknown }, impact: string) => {
    if (f.value === null || (Array.isArray(f.value) && f.value.length === 0)) missing.push({ field: name, impact });
  };
  if (!text.trim()) missing.push({ field: "jdText", impact: "No job description at all — nothing can be checked. The eligibility gate treats this job as unassessable." });
  miss("experience", experience, "Experience not stated — the eligibility check treats it as unknown (neutral), so confirm before applying.");
  miss("education", education, "Education not stated — degree requirements are unknown.");
  miss("location", location, "Location not stated — the location preference can't be checked.");
  miss("workMode", workMode, "Work mode not stated — remote/hybrid/onsite is unknown.");
  miss("salary", salary, "Salary not stated (common in India) — expected-CTC questions may come up on the form.");
  if (!skills.some((s) => s.tier === "MANDATORY")) missing.push({ field: "mandatorySkills", impact: "No recognisable mandatory skills — the technical match is low-confidence." });
  miss("responsibilities", responsibilities, "Responsibilities not described — role scope is unclear.");
  miss("seniority", seniority, "Seniority can't be determined from the title or the experience requirement.");
  if (campusJd) {
    miss("batch", batch, "Campus-style JD without an eligible batch — check the company page before assuming you qualify.");
    miss("cgpa", cgpa, "No CGPA cut-off stated — assume none, but campus drives often apply one.");
    miss("branch", branch, "Eligible branches not stated.");
  }

  // ---- quality
  const thin: string[] = [];
  if (body.length < 3) thin.push("fewer than 3 lines of content");
  if (!skills.length && !responsibilities.value) thin.push("no recognisable skills and no responsibilities");
  const malformed = text.trim().length < 200 || thin.length > 0;
  if (thin.length && text.trim()) warnings.push(`thin or malformed JD: ${thin.join("; ")} — treat every field here as low-confidence and read the original posting`);
  if (!text.trim()) warnings.push("no JD text");
  else if (text.trim().length < 200) warnings.push(`very short JD (${text.trim().length} characters) — likely a truncated or placeholder description`);
  if (!sectioned && text.length > 300) warnings.push("no section headings found — mandatory vs preferred is less certain");
  const core = [experience, education, location, workMode, seniority, responsibilities].filter((f) => f.value !== null).map((f) => f.confidence);
  const skillConf = skills.length ? skills.reduce((a, s) => a + s.confidence, 0) / skills.length : 0;
  const parts = [...core, ...(skills.length ? [skillConf] : [])];
  // Without JD text there is nothing to be confident about, whatever the listing says.
  const overall = parts.length && text.trim() ?(parts.reduce((a, b) => a + b, 0) / parts.length) * (malformed ? 0.6 : 1) * (contradictions.length ? 0.85 : 1) : 0;

  return {
    version: JD_DECOMPILER_VERSION,
    jdHash: sha256(text).slice(0, 16),
    decompiledAt: now.toISOString(),
    text,
    role,
    company,
    location,
    workMode,
    experience,
    education,
    seniority,
    skills,
    mandatorySkills: skills.filter((s) => s.tier === "MANDATORY").map((s) => s.skill),
    preferredSkills: skills.filter((s) => s.tier === "PREFERRED").map((s) => s.skill),
    niceToHaveSkills: skills.filter((s) => s.tier === "NICE_TO_HAVE").map((s) => s.skill),
    responsibilities,
    certifications,
    salary,
    batch,
    cgpa,
    percentage,
    branch,
    bond,
    noticePeriod,
    domain,
    missing,
    contradictions,
    quality: { chars: text.length, lines: segs.length, sectioned, malformed, warnings, overallConfidence: Math.round(overall * 100) / 100 },
    campusJd,
  };
}

export function band(min: number): ExperienceBand {
  if (min < 1) return min === 0 ? "FRESHER" : "0-1";
  if (min < 2) return "1-2";
  if (min < 5) return "2-5";
  return "5+";
}

/**
 * The stored form: the JD text is already in the Job Details tab, so it is dropped here (quotes and offsets still
 * point into it). Keeps the Sheets cell well under its size limit.
 */
export type StoredJdIntelligence = Omit<DecompiledJd, "text">;
export function toStored(d: DecompiledJd): StoredJdIntelligence {
  const { text: _text, ...rest } = d;
  return rest;
}
