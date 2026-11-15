import fs from "node:fs";
import path from "node:path";
import { CompanyProfileSchema, type CompanyProfile } from "../core/schemas.ts";
import { paths } from "../core/paths.ts";
import { detectAtsFromUrl } from "../../integrations/companies/ats.ts";
import type { Store } from "../store/sheetStore.ts";

export interface ScanIssue {
  file: string;
  error: string;
}

export interface ScanResult {
  companies: CompanyProfile[];
  issues: ScanIssue[];
}

const CATEGORY_BY_TOP_DIR: Record<string, CompanyProfile["category"]> = {
  mncs: "MNC",
  product: "Product",
  service: "Service",
  startups: "Startup",
};

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "company";
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue; // _TEMPLATE etc. are ignored
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.toLowerCase() === "company.json") out.push(full);
  }
}

/**
 * Discovers Companies/**\/company.json. Invalid files are reported, never fatal.
 * category/type default from the folder path (e.g. MNCs/Product/Acme → MNC/Product).
 */
export function scanCompanies(root = paths.companies()): ScanResult {
  const files: string[] = [];
  if (fs.existsSync(root)) walk(root, files);
  const companies: CompanyProfile[] = [];
  const issues: ScanIssue[] = [];
  const seenIds = new Map<string, string>();

  for (const file of files.sort()) {
    const rel = path.relative(root, path.dirname(file)).split(path.sep);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      issues.push({ file, error: `invalid JSON: ${(err as Error).message}` });
      continue;
    }
    const parsed = CompanyProfileSchema.safeParse(raw);
    if (!parsed.success) {
      issues.push({ file, error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") });
      continue;
    }
    const p = parsed.data;
    const top = (rel[0] ?? "").toLowerCase();
    const sub = rel.length >= 3 ? rel[1] : undefined;
    const companyId = p.companyId ?? slugify(p.companyName);
    if (seenIds.has(companyId)) {
      issues.push({ file, error: `duplicate companyId '${companyId}' (also in ${seenIds.get(companyId)})` });
      continue;
    }
    seenIds.set(companyId, file);

    const detected = p.careersUrl ? detectAtsFromUrl(p.careersUrl) : null;
    const ats = p.ats
      ? { type: p.ats.type, boardToken: p.ats.boardToken ?? detected?.boardToken ?? null, ...(p.ats.country ? { country: p.ats.country.toLowerCase() } : {}) }
      : detected;

    companies.push({
      companyId,
      companyName: p.companyName,
      category: p.category ?? CATEGORY_BY_TOP_DIR[top] ?? null,
      type: p.type ?? (sub === "Product" || sub === "Service" ? sub : null),
      enabled: p.enabled,
      priority: p.priority,
      careersUrl: p.careersUrl ?? null,
      domains: p.domains,
      ats,
      locations: p.locations,
      notes: p.notes,
      directory: rel.join("/"),
      filePath: file,
    });
  }
  return { companies, issues };
}

/** Mirrors scanned companies into the "Companies" tab so searches and reports can reference them. */
export function syncCompaniesToStore(store: Store, companies: CompanyProfile[]): void {
  const now = new Date().toISOString();
  for (const c of companies) {
    const row = {
      companyId: c.companyId,
      companyName: c.companyName,
      category: c.category,
      type: c.type,
      enabled: c.enabled,
      priority: c.priority,
      careersUrl: c.careersUrl,
      atsType: c.ats?.type ?? null,
      atsToken: c.ats?.boardToken ?? null,
      directory: c.directory,
      lastSeenAt: now,
    };
    const existing = store.t.companies.get(c.companyId);
    if (existing) store.t.companies.update(c.companyId, { ...row, lastSeenAt: existing.lastSeenAt.slice(0, 10) === now.slice(0, 10) ? existing.lastSeenAt : now });
    else store.t.companies.insert({ ...row, firstSeenAt: now, lastSuccessfulSearch: null });
  }
}
