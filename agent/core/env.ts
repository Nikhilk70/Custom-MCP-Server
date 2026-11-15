import fs from "node:fs";
import { parse as parseDotenv } from "dotenv";
import { z } from "zod";
import { fromRoot } from "./paths.ts";
import { AgentError } from "./errors.ts";

const csv = z
  .string()
  .optional()
  .transform((v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : /^(1|true|yes|on)$/i.test(v)));
const optStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));
const optInt = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v.trim() === "") return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: "custom", message: `not a number: ${v}` });
      return z.NEVER;
    }
    return n;
  });

export const APPLICATION_MODES = ["REVIEW_ONLY", "AUTO_FILL_REVIEW_SUBMIT", "FULL_AUTO"] as const;
export type ApplicationMode = (typeof APPLICATION_MODES)[number];

const EnvSchema = z.object({
  GOOGLE_SHEETS_SPREADSHEET_ID: optStr,
  GOOGLE_SHEETS_CREDENTIALS_PATH: optStr,
  GOOGLE_SHEETS_TOKEN_PATH: optStr,
  GOOGLE_SHEETS_TAB: optStr,
  AI_PROVIDER: z.enum(["gemini", "openai", "anthropic", "none"]).optional().default("none"),
  AI_MODEL: optStr,
  GEMINI_API_KEY: optStr,
  OPENAI_API_KEY: optStr,
  ANTHROPIC_API_KEY: optStr,
  OVERLEAF_SESSION: optStr,
  OVERLEAF_GIT_TOKEN: optStr,
  OVERLEAF_PROJECT_ID: optStr,
  FIRECRAWL_API_KEY: optStr,
  /** Optional: raises GitHub's API rate limit for evidence verification (read-only public data). */
  GITHUB_TOKEN: optStr,
  PLAYWRIGHT_HEADLESS: bool(false),
  BROWSER_PROFILE_DIR: optStr,
  /** "chrome" = your installed Google Chrome (needed for Google sign-in); empty = Playwright's bundled Chromium. */
  BROWSER_CHANNEL: optStr,
  /** Google account for "Sign in with Google" on career sites (default: MY_DATA personal.email). Never a password. */
  GOOGLE_SIGNIN_ACCOUNT: optStr,
  LINKEDIN_EMAIL: optStr,
  LINKEDIN_PASSWORD: optStr,
  LINKEDIN_LI_AT: optStr,
  LINKEDIN_AUTH_STATE_PATH: optStr,
  APPLICATION_MODE: z.enum(APPLICATION_MODES).optional(),
  DRY_RUN: bool(true),
  JOB_KEYWORDS: csv,
  JOB_LOCATIONS: csv,
  JOB_EXPERIENCE_LEVEL: optStr,
  JOB_DATE_SINCE_POSTED: optStr,
  JOB_LIMIT: optInt,
  MINIMUM_MATCH_SCORE: optInt,
  PORTAL_NAUKRI_ENABLED: bool(false),
  PORTAL_INDEED_ENABLED: bool(false),
  PORTAL_INTERNSHALA_ENABLED: bool(false),
  PORTAL_GLASSDOOR_ENABLED: bool(false),
  PORTAL_UNSTOP_ENABLED: bool(false),
  PORTAL_SHINE_ENABLED: bool(false),
  PORTAL_TIMESJOBS_ENABLED: bool(false),
  SCHEDULER_ENABLED: optStr,
  SCHEDULER_TIMEZONE: optStr,
  SCHEDULER_DAILY_TIME: optStr,
  LOCAL_LATEX_COMMAND: optStr,
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
  LOG_DIR: optStr,
});

export type Env = z.infer<typeof EnvSchema>;

/** Names whose values must never appear in logs, reports or MCP output. */
export const SECRET_ENV_KEYS = [
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OVERLEAF_SESSION",
  "OVERLEAF_GIT_TOKEN",
  "FIRECRAWL_API_KEY",
  "GITHUB_TOKEN",
  "LINKEDIN_PASSWORD",
  "LINKEDIN_LI_AT",
  "LINKEDIN_EMAIL",
] as const;

let cached: Env | undefined;

/**
 * Loads .env (without mutating process.env for keys already set) and validates it.
 * Values in process.env win over the file so CI/tests can override.
 */
export function loadEnv(opts: { reload?: boolean; file?: string } = {}): Env {
  if (cached && !opts.reload) return cached;
  const file = opts.file ?? fromRoot(".env");
  const fromFile = fs.existsSync(file) ? parseDotenv(fs.readFileSync(file)) : {};
  const merged: Record<string, string | undefined> = { ...fromFile };
  for (const key of Object.keys(EnvSchema.shape)) {
    const v = process.env[key];
    if (v !== undefined) merged[key] = v;
  }
  const parsed = EnvSchema.safeParse(merged);
  if (!parsed.success) {
    throw new AgentError("CONFIG_INVALID", `.env is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  cached = parsed.data;
  return cached;
}

export function secretValues(env: Env): string[] {
  return SECRET_ENV_KEYS.map((k) => env[k]).filter((v): v is string => typeof v === "string" && v.length >= 6);
}
