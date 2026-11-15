import type { WorkMode } from "../core/schemas.ts";
import { normalizeLocation } from "../core/text.ts";

const INDIA_CITIES = [
  "bengaluru", "mumbai", "pune", "hyderabad", "chennai", "delhi", "gurugram", "noida", "kolkata", "ahmedabad",
  "kochi", "coimbatore", "jaipur", "chandigarh", "indore", "thiruvananthapuram", "mysuru", "mysore", "mangaluru", "navi mumbai", "thane",
];
const GLOBAL_REMOTE = /\b(anywhere|worldwide|global|apac|asia)\b/;
const FOREIGN_MARKERS = /\b(us|usa|united states|uk|united kingdom|canada|europe|emea|germany|france|australia|singapore|latam|mexico|brazil|japan|americas|north america|ireland|netherlands|poland|spain)\b/;

export interface LocationDecision {
  matches: boolean;
  reason: string;
}

/** True if the job location satisfies at least one preferred location. "Remote" only matches remote roles open to India. */
export function locationMatches(jobLocation: string, workMode: WorkMode | null, preferred: string[], excluded: string[] = []): LocationDecision {
  const loc = normalizeLocation(jobLocation);
  for (const ex of excluded) {
    const e = normalizeLocation(ex);
    if (e && loc.includes(e)) return { matches: false, reason: `location '${jobLocation}' is excluded (${ex})` };
  }
  const isRemote = workMode === "remote" || /\bremote\b/.test(loc);
  const mentionsIndia = /\bindia\b/.test(loc) || INDIA_CITIES.some((c) => loc.includes(c));
  for (const pref of preferred) {
    const p = normalizeLocation(pref);
    if (p === "remote") {
      if (isRemote && (mentionsIndia || GLOBAL_REMOTE.test(loc) || (!FOREIGN_MARKERS.test(loc) && loc.replace(/\bremote\b/, "").trim().length === 0))) {
        return { matches: true, reason: `remote role (${jobLocation})` };
      }
      continue;
    }
    if (p === "india" && mentionsIndia) return { matches: true, reason: `in India (${jobLocation})` };
    if (p && loc.includes(p)) return { matches: true, reason: `matches preferred location ${pref}` };
  }
  if (!loc || loc === "unspecified") return { matches: false, reason: "location not stated" };
  return { matches: false, reason: `location '${jobLocation}' not in preferences` };
}
