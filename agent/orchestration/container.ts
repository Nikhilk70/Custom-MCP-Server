import { loadConfig, type AppConfig } from "../core/config.ts";
import { secretValues, type ApplicationMode } from "../core/env.ts";
import { fetchHttpClient, type HttpClient } from "../core/http.ts";
import type { AIProvider, CompanySource, IntegrationStatus, JdProvider, ResumeProvider, SheetProvider } from "../core/interfaces.ts";
import { createLogger, SecretMasker, type Logger } from "../core/logger.ts";
import { fromRoot, paths } from "../core/paths.ts";
import { Store } from "../store/sheetStore.ts";
import { loadProfile, type Profile } from "../profile/profile.ts";
import { loadQuestionBank, type QuestionRecord } from "../questions/questionBank.ts";
import { FirecrawlClient } from "../../integrations/firecrawl/FirecrawlClient.ts";
import { AtsJdProvider, FallbackJdProvider, PageJdProvider } from "../../integrations/jd/PageJdProvider.ts";
import { CompanyCareerAdapter } from "../../integrations/companies/CompanyCareerAdapter.ts";
import { LinkedInMcpSource } from "../../integrations/linkedin/LinkedInMcpSource.ts";
import { LocalLatexProvider } from "../../integrations/latex/LocalLatexProvider.ts";
import { buildAIProvider } from "../../integrations/ai/providers.ts";
import { GoogleSheetsAdapter } from "../../integrations/google-sheets/GoogleSheetsAdapter.ts";
import { PlaywrightBrowserProvider } from "../../integrations/playwright/PlaywrightBrowserProvider.ts";

/** Everything except the database. Enough for preflight, profile checks and read-only tooling. */
export interface BaseContext {
  cfg: AppConfig;
  logger: Logger;
  masker: SecretMasker;
  profile: Profile;
  http: HttpClient;
  firecrawl: FirecrawlClient;
  /** Find jobs: lists open jobs on the career boards of the companies in Companies/. */
  companySource: CompanySource;
  /** Find jobs: LinkedIn search through the linkedin-jobs MCP server. */
  linkedin: LinkedInMcpSource;
  /** Reads a job description from its Apply Link: the page itself first, then Firecrawl for JavaScript-only pages. */
  jdProvider: JdProvider;
  compilers: ResumeProvider[];
  ai: AIProvider;
  sheet: SheetProvider;
  browser: PlaywrightBrowserProvider;
  questions: QuestionRecord[];
  questionIssues: string[];
  runId: string | null;
  close(): Promise<void>;
}

/** Full context: BaseContext + the Google Sheets store (the only database). */
export interface AgentContext extends BaseContext {
  store: Store;
}

export interface ContextOptions {
  dryRun?: boolean;
  mode?: ApplicationMode;
  /** MCP stdio servers must keep stdout clean. */
  logToStderr?: boolean;
  quiet?: boolean;
  /** Test hook: use this spreadsheet backend instead of Google Sheets. */
  sheetProvider?: SheetProvider;
}

export function createBaseContext(opts: ContextOptions = {}): BaseContext {
  const cfg = loadConfig({ ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}), ...(opts.mode ? { mode: opts.mode } : {}) });
  const masker = new SecretMasker(secretValues(cfg.env));
  const logger = createLogger({ level: cfg.env.LOG_LEVEL, dir: cfg.env.LOG_DIR ? fromRoot(cfg.env.LOG_DIR) : paths.logs(), console: !opts.quiet, stderr: opts.logToStderr ?? false, masker });
  const profile = loadProfile();
  const http = fetchHttpClient;
  const firecrawl = new FirecrawlClient(http, {
    apiKey: cfg.env.FIRECRAWL_API_KEY,
    baseUrl: cfg.sources.firecrawl.baseUrl,
    timeoutMs: cfg.sources.firecrawl.timeoutMs,
    maxScrapesPerRun: cfg.sources.firecrawl.maxScrapesPerRun,
    enabled: cfg.sources.firecrawl.enabled,
  });
  // Most exact first: hiring-platform API, the page's structured posting, Firecrawl (JavaScript pages), the raw page text.
  const companySource = new CompanyCareerAdapter({
    http,
    firecrawl,
    timeoutMs: cfg.sources.companyCareers.requestTimeoutMs,
    maxJobsPerCompany: cfg.sources.companyCareers.maxJobsPerCompany,
    useFirecrawlForUnknownCareerPages: cfg.sources.companyCareers.useFirecrawlForUnknownCareerPages,
  });
  const linkedin = new LinkedInMcpSource({ enabled: cfg.sources.linkedin.enabled, mcpServer: cfg.sources.linkedin.mcpServer });
  const jdProvider = new FallbackJdProvider([new AtsJdProvider(), new PageJdProvider({ mode: "posting" }), ...(cfg.sources.firecrawl.useForJdFetch ? [firecrawl] : []), new PageJdProvider({ mode: "text" })]);
  const compilers: ResumeProvider[] = [
    new LocalLatexProvider({ candidates: cfg.resume.compiler.localCommands, explicitCommand: cfg.env.LOCAL_LATEX_COMMAND, timeoutMs: cfg.resume.compiler.timeoutMs }),
  ];
  const ai = buildAIProvider(cfg.env, http);
  const sheet = opts.sheetProvider ?? new GoogleSheetsAdapter({ spreadsheetId: cfg.env.GOOGLE_SHEETS_SPREADSHEET_ID, credentialsPath: cfg.env.GOOGLE_SHEETS_CREDENTIALS_PATH, tokenPath: cfg.env.GOOGLE_SHEETS_TOKEN_PATH });
  const browser = new PlaywrightBrowserProvider({ profileDir: cfg.application.browser.profileDir, headless: cfg.application.browser.headless, slowMoMs: cfg.application.browser.slowMoMs, persistent: true, channel: cfg.env.BROWSER_CHANNEL });
  const qb = loadQuestionBank();
  const ctx: BaseContext = {
    cfg,
    logger,
    masker,
    profile,
    http,
    firecrawl,
    companySource,
    linkedin,
    jdProvider,
    compilers,
    ai,
    sheet,
    browser,
    questions: qb.records,
    questionIssues: qb.issues,
    runId: null,
    close: async () => {
      await browser.shutdown().catch(() => undefined);
    },
  };
  return ctx;
}

/**
 * Opens the Google Sheet as the database (one tab listing + one batched read). Fails with NOT_CONFIGURED
 * when credentials are missing — there is no local fallback database by design.
 */
export async function createContext(opts: ContextOptions = {}): Promise<AgentContext> {
  const base = createBaseContext(opts);
  const store = await Store.open(base.sheet, base.cfg.env.GOOGLE_SHEETS_TAB ? { jobsTab: base.cfg.env.GOOGLE_SHEETS_TAB } : {});
  for (const w of store.warnings) base.logger.warn({ module: "store", action: "load", status: "info", message: w });
  return {
    ...base,
    store,
    close: async () => {
      try {
        await store.flush();
        await store.releaseLock();
      } finally {
        await base.close();
      }
    },
  };
}

export function integrationStatuses(ctx: BaseContext): IntegrationStatus[] {
  return [ctx.sheet.status(), ctx.linkedin.status(), ctx.companySource.status(), ctx.jdProvider.status(), ctx.firecrawl.status(), ...ctx.compilers.map((c) => c.status()), ctx.ai.status(), ctx.browser.status()];
}
