import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setProjectRoot } from "../agent/core/paths.ts";
import { loadConfig, type AppConfig } from "../agent/core/config.ts";
import { loadEnv } from "../agent/core/env.ts";
import { Store } from "../agent/store/sheetStore.ts";
import { InMemorySheetProvider } from "../integrations/google-sheets/InMemorySheetProvider.ts";
import { createMemoryLogger } from "../agent/core/logger.ts";
import type { RawJob } from "../agent/core/schemas.ts";

export const REAL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = path.join(REAL_ROOT, "tests", "fixtures");

function copy(rel: string, root: string): void {
  const src = path.join(REAL_ROOT, rel);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(root, rel), { recursive: true, filter: (s) => !s.includes(`${path.sep}.baseline`) });
}

/** Isolated project root: real config/MY_DATA/template/questions, fresh DB and output folders, no .env (no secrets). */
export function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aja-test-"));
  for (const rel of ["config", "Data_Resume/MY_DATA", "Data_Resume/Resume_Template/master.tex", "Data_Resume/Resume_Template/resume_rules.md", "Data_Resume/Source", "Application_Questions", "scripts"]) copy(rel, root);
  for (const d of ["Companies", "Jobs/Raw", "Jobs/Matched", "Applications/Logs", "Applications/Screenshots", "Applications/Reports", "Data_Resume/Generated"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  setProjectRoot(root);
  for (const k of Object.keys(process.env)) if (/^(DRY_RUN|APPLICATION_MODE|GOOGLE_|GEMINI|FIRECRAWL|OVERLEAF|LINKEDIN|PORTAL_|JOB_|MINIMUM_MATCH)/.test(k)) delete process.env[k];
  loadEnv({ reload: true });
  return root;
}

export function testConfig(overrides: { dryRun?: boolean } = {}): AppConfig {
  return loadConfig(overrides);
}

/** Fresh store on an in-memory spreadsheet (same code path as Google Sheets, no network). */
export async function memStore(initial?: Record<string, string[][]>): Promise<{ store: Store; sheet: InMemorySheetProvider }> {
  const sheet = new InMemorySheetProvider(initial);
  return { store: await Store.open(sheet), sheet };
}

export const logger = () => createMemoryLogger();

export function rawJob(over: Partial<RawJob> = {}): RawJob {
  return {
    source: "greenhouse",
    externalJobId: "1001",
    companyName: "Acme Payments",
    companyId: "acme",
    jobTitle: "Java Backend Developer",
    location: "Bengaluru, India",
    workMode: null,
    experienceRequired: null,
    salary: null,
    postedDate: new Date().toISOString().slice(0, 10),
    applyUrl: "https://boards.greenhouse.io/acme/jobs/1001",
    jobUrl: "https://boards.greenhouse.io/acme/jobs/1001",
    jdText: fs.readFileSync(path.join(FIXTURES, "jobs", "jd-java-backend.txt"), "utf8"),
    companyDomain: null,
    raw: {},
    ...over,
  };
}
