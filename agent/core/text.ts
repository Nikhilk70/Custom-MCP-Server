import crypto from "node:crypto";

export function sha256(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/** Lowercase, strip accents/punctuation, collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const COMPANY_SUFFIXES = /\b(inc|incorporated|llc|llp|ltd|limited|pvt|private|corp|corporation|co|company|gmbh|plc|technologies|technology|solutions|software|labs|india)\b\.?/g;

export function normalizeCompany(name: string): string {
  return normalizeText(name).replace(/\./g, " ").replace(COMPANY_SUFFIXES, " ").replace(/\s+/g, " ").trim();
}

const TITLE_SYNONYMS: Array<[RegExp, string]> = [
  [/\bsr\.?\b/g, "senior"],
  [/\bjr\.?\b/g, "junior"],
  [/\bsde\b/g, "software development engineer"],
  [/\bswe\b/g, "software engineer"],
  [/\bfull[\s-]?stack\b/g, "fullstack"],
  [/\bback[\s-]?end\b/g, "backend"],
  [/\bfront[\s-]?end\b/g, "frontend"],
  [/\bdev\b/g, "developer"],
  [/\b(i{1,3}|iv|[1-4])\b$/g, ""],
];

export function normalizeTitle(title: string): string {
  let t = normalizeText(title).replace(/[.]/g, " ");
  for (const [re, rep] of TITLE_SYNONYMS) t = t.replace(re, rep);
  return t.replace(/\s+/g, " ").trim();
}

const CITY_ALIASES: Record<string, string> = {
  bangalore: "bengaluru",
  bengaluru: "bengaluru",
  bombay: "mumbai",
  gurgaon: "gurugram",
  "new delhi": "delhi",
  madras: "chennai",
  calcutta: "kolkata",
};

export function normalizeLocation(loc: string): string {
  let l = normalizeText(loc).replace(/[.]/g, " ");
  for (const [alias, canonical] of Object.entries(CITY_ALIASES)) l = l.replace(new RegExp(`\\b${alias}\\b`, "g"), canonical);
  return l.replace(/\s+/g, " ").trim();
}

/** Canonicalize a URL for identity: lowercase host, drop tracking params, fragments and trailing slashes. */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    const drop = [/^utm_/i, /^ref$/i, /^source$/i, /^trk/i, /^gclid$/i, /^fbclid$/i, /^lever-source/i, /^src$/i];
    for (const key of [...u.searchParams.keys()]) if (drop.some((re) => re.test(key))) u.searchParams.delete(key);
    u.searchParams.sort();
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    const s = u.toString();
    return s.endsWith("/") ? s.slice(0, -1) : s;
  } catch {
    return raw.trim();
  }
}

export function sanitizeFilenamePart(s: string, max = 60): string {
  const cleaned = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (cleaned || "unknown").slice(0, max);
}

/** Minimal HTML → text for JD content. Strips tags, decodes common entities, keeps line breaks. */
export function htmlToText(html: string): string {
  const decoded = decodeEntities(html);
  return decodeEntities(
    decoded
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\n• ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

export function tokenSet(s: string): Set<string> {
  return new Set(normalizeText(s).split(" ").filter((t) => t.length > 1 && !STOPWORDS.has(t)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "at", "by", "from", "is", "are", "be", "your", "you",
  "what", "which", "please", "do", "does", "have", "has", "we", "our", "this", "that", "it", "as", "if", "any", "will",
]);

export function todayIso(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
