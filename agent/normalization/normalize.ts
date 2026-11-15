import type { RawJob, WorkMode } from "../core/schemas.ts";
import { canonicalUrl, normalizeCompany, normalizeLocation, normalizeText, normalizeTitle, sha256 } from "../core/text.ts";

export interface NormalizedJob extends RawJob {
  companyNorm: string;
  titleNorm: string;
  locationNorm: string;
  applyUrlCanonical: string;
  jobUrlCanonical: string;
  identityKey: string;
  jdHash: string | null;
}

const MIN_JD_CHARS_FOR_HASH = 80;

export function jdHashOf(jdText: string | null): string | null {
  if (!jdText) return null;
  const norm = normalizeText(jdText);
  return norm.length >= MIN_JD_CHARS_FOR_HASH ? sha256(norm) : null;
}

export function inferWorkMode(location: string, jdText: string | null, explicit: WorkMode | null): WorkMode | null {
  if (explicit) return explicit;
  const loc = location.toLowerCase();
  if (/\bhybrid\b/.test(loc)) return "hybrid";
  if (/\bremote\b|work from home|\bwfh\b/.test(loc)) return "remote";
  if (/\bon[- ]?site\b|in[- ]office/.test(loc)) return "onsite";
  const jd = (jdText ?? "").toLowerCase().slice(0, 4000);
  if (/\bhybrid (role|work|model|position)\b/.test(jd)) return "hybrid";
  if (/\b(fully|100%) remote\b|\bthis (role|position) is remote\b/.test(jd)) return "remote";
  return null;
}

export function identityKeyOf(companyNorm: string, titleNorm: string, locationNorm: string): string {
  return sha256(`${companyNorm}|${titleNorm}|${locationNorm}`);
}

/** Pure transformation: no facts are added, only canonical keys derived from what the source returned. */
export function normalizeRawJob(raw: RawJob): NormalizedJob {
  const companyName = raw.companyName.trim();
  const jobTitle = raw.jobTitle.replace(/\s+/g, " ").trim();
  const location = raw.location.replace(/\s+/g, " ").trim() || "Unspecified";
  const jdText = raw.jdText?.trim() ? raw.jdText.trim() : null;
  const companyNorm = normalizeCompany(companyName);
  const titleNorm = normalizeTitle(jobTitle);
  const locationNorm = normalizeLocation(location);
  const applyUrlCanonical = canonicalUrl(raw.applyUrl || raw.jobUrl);
  return {
    ...raw,
    companyName,
    jobTitle,
    location,
    jdText,
    workMode: inferWorkMode(location, jdText, raw.workMode),
    companyNorm,
    titleNorm,
    locationNorm,
    applyUrlCanonical,
    jobUrlCanonical: canonicalUrl(raw.jobUrl || raw.applyUrl),
    identityKey: identityKeyOf(companyNorm, titleNorm, locationNorm),
    jdHash: jdHashOf(jdText),
  };
}
