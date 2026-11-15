import fs from "node:fs";
import { z } from "zod";
import { paths } from "./paths.ts";
import { AgentError } from "./errors.ts";
import { APPLICATION_MODES, loadEnv, type Env } from "./env.ts";

/**
 * Job search (Find jobs: the company career boards in Companies/) and where job descriptions are read from (the
 * hiring platform's API, the job page itself, then Firecrawl for pages that need JavaScript).
 */
export const SourcesConfigSchema = z.object({
  companyCareers: z
    .object({
      enabled: z.boolean(),
      concurrency: z.number().int().min(1).max(10),
      requestTimeoutMs: z.number().int().positive(),
      maxJobsPerCompany: z.number().int().positive(),
      supportedAts: z.array(z.string()),
      useFirecrawlForUnknownCareerPages: z.boolean(),
    })
    .default({ enabled: true, concurrency: 3, requestTimeoutMs: 20000, maxJobsPerCompany: 500, supportedAts: ["greenhouse", "lever", "ashby", "smartrecruiters"], useFirecrawlForUnknownCareerPages: false }),
  /** LinkedIn search through the linkedin-jobs MCP server (config/mcp-servers.json). */
  linkedin: z
    .object({
      enabled: z.boolean(),
      mcpServer: z.string(),
      /** Where to search; empty = JOB_LOCATIONS from .env. "India" covers every Indian city. */
      locations: z.array(z.string()).default(["India"]),
      experienceLevels: z.array(z.enum(["internship", "entry level", "associate", "senior", "director", "executive"])).default(["entry level", "associate"]),
      dateSincePosted: z.enum(["past month", "past week", "24hr"]).default("past week"),
      resultsPerSearch: z.number().int().min(1).max(100).default(25),
      maxSearches: z.number().int().min(1).max(100).default(20),
    })
    .default({ enabled: false, mcpServer: "linkedin", locations: ["India"], experienceLevels: ["entry level", "associate"], dateSincePosted: "past week", resultsPerSearch: 25, maxSearches: 20 }),
  filters: z
    .object({ titleIncludeKeywords: z.array(z.string()), maxJobAgeDays: z.number().int().positive() })
    .default({ titleIncludeKeywords: ["developer", "engineer", "software", "sde", "programmer"], maxJobAgeDays: 30 }),
  firecrawl: z.object({
    enabled: z.boolean(),
    transport: z.literal("rest"),
    baseUrl: z.string().url(),
    timeoutMs: z.number().int().positive(),
    maxScrapesPerRun: z.number().int().min(0),
    useForJdFetch: z.boolean(),
  }),
});

export const MatchingConfigSchema = z.object({
  minimumMatchScore: z.number().min(0).max(100),
  weights: z.object({
    requiredSkills: z.number().min(0),
    preferredSkills: z.number().min(0),
    titleSimilarity: z.number().min(0),
    experience: z.number().min(0),
    location: z.number().min(0),
    workMode: z.number().min(0),
    education: z.number().min(0),
  }),
  proficiencyCredit: z.object({
    verified: z.number().min(0).max(1),
    basic: z.number().min(0).max(1),
    learning: z.number().min(0).max(1),
    unknown: z.number().min(0).max(1),
    missing: z.number().min(0).max(1),
  }),
  neutralScoreWhenUnknown: z.number().min(0).max(1),
  hardConstraints: z.object({
    rejectIfJdMissing: z.boolean(),
    maxRequiredYearsExperience: z.number().min(0),
    rejectExcludedTitleKeywords: z.boolean(),
    rejectExcludedCompanies: z.boolean(),
    rejectExcludedTechnologies: z.boolean(),
    requireLocationMatch: z.boolean(),
    minimumRequiredSkillCoverage: z.number().min(0).max(1),
  }),
});

export const SECTION_NAMES = ["HEADER", "SUMMARY", "SKILLS", "EXPERIENCE", "PROJECTS", "EDUCATION", "CERTIFICATIONS", "ADDITIONAL"] as const;
export type SectionName = (typeof SECTION_NAMES)[number];

export const ResumeConfigSchema = z.object({
  templatePath: z.string(),
  outputRoot: z.string(),
  allowedSections: z.array(z.enum(SECTION_NAMES)),
  profileRenderedSections: z.array(z.enum(SECTION_NAMES)),
  expectedSectionNames: z.array(z.string()),
  maxPages: z.number().int().positive(),
  filenamePattern: z.string(),
  compiler: z.object({
    provider: z.enum(["auto", "overleaf-mcp", "local", "none"]),
    order: z.array(z.enum(["overleaf-mcp", "local"])),
    localCommands: z.array(z.enum(["latexmk", "pdflatex", "tectonic"])),
    timeoutMs: z.number().int().positive(),
  }),
  generationRules: z.object({
    maxProjects: z.number().int().min(0),
    reorderSkills: z.boolean(),
    reorderExperienceBullets: z.boolean(),
    dropIrrelevantProjects: z.boolean(),
    allowAiSummaryRewrite: z.boolean(),
    includeLearningSkills: z.boolean(),
  }),
});

export const ApplicationConfigSchema = z.object({
  mode: z.enum(APPLICATION_MODES),
  retryLimit: z.number().int().min(0).max(5),
  maxApplicationsPerRun: z.number().int().min(0),
  waitTimeouts: z.object({
    navigationMs: z.number().int().positive(),
    stabilizeMs: z.number().int().min(0),
    elementMs: z.number().int().positive(),
    postSubmitMs: z.number().int().positive(),
  }),
  browser: z.object({ profileDir: z.string(), headless: z.boolean(), slowMoMs: z.number().int().min(0) }),
  /**
   * CAPTCHA / OTP / login / security check with a visible browser: wait in place for the user to complete it, then
   * continue the same application from the current page. Headless (or disabled): stop as NEEDS_HUMAN instead.
   */
  humanWait: z.object({ enabled: z.boolean(), timeoutMs: z.number().int().positive(), pollMs: z.number().int().positive() }).default({ enabled: true, timeoutMs: 900_000, pollMs: 2000 }),
  highConfidenceThreshold: z.number().min(0).max(1),
  allowAiSuggestedAnswers: z.boolean(),
  humanReviewRules: z.object({
    stopOnUnknownRequiredField: z.boolean(),
    stopOnUnknownOptionalField: z.boolean(),
    stopOnLoginWall: z.boolean(),
    stopOnMultiStepForm: z.boolean(),
  }),
  confirmationPatterns: z.array(z.string()),
  maxFormSteps: z.number().int().min(1).max(10).default(5),
});

export const SafetyConfigSchema = z.object({
  requireHumanForCaptcha: z.literal(true),
  requireHumanForOTP: z.literal(true),
  requireHumanForUnknownQuestions: z.boolean(),
  requireHumanForLegalQuestions: z.boolean(),
  requireHumanForUnverifiedSubmission: z.boolean(),
  requireHumanForLogin: z.boolean(),
  neverSubmitWhenDryRun: z.literal(true),
  legalOrEligibilityPatterns: z.array(z.string()),
  sensitivePatterns: z.array(z.string()),
  captchaSelectors: z.array(z.string()),
  captchaTextPatterns: z.array(z.string()),
  otpPatterns: z.array(z.string()),
  loginPatterns: z.array(z.string()),
  securityCheckPatterns: z.array(z.string()),
  /** Payment is a hard stop, never waited out: text on the page, labels of fields, and visible gateway frames. */
  paymentTextPatterns: z.array(z.string()).min(1),
  paymentFieldPatterns: z.array(z.string()).min(1),
  paymentFrameSelectors: z.array(z.string()).min(1),
});

export type SourcesConfig = z.infer<typeof SourcesConfigSchema>;
export type MatchingConfig = z.infer<typeof MatchingConfigSchema>;
export type ResumeConfig = z.infer<typeof ResumeConfigSchema>;
export type ApplicationConfig = z.infer<typeof ApplicationConfigSchema>;
export type SafetyConfig = z.infer<typeof SafetyConfigSchema>;

export interface AppConfig {
  env: Env;
  sources: SourcesConfig;
  matching: MatchingConfig;
  resume: ResumeConfig;
  application: ApplicationConfig;
  safety: SafetyConfig;
  dryRun: boolean;
}

export function readJsonFile<T>(file: string, schema: z.ZodType<T>): T {
  if (!fs.existsSync(file)) throw new AgentError("CONFIG_INVALID", `Missing file: ${file}`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new AgentError("CONFIG_INVALID", `Invalid JSON in ${file}: ${(err as Error).message}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentError("CONFIG_INVALID", `${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/**
 * Loads every config file and applies .env overrides.
 * Precedence (highest first): CLI flags > .env > config/*.json.
 */
export function loadConfig(overrides: { dryRun?: boolean; mode?: AppConfig["application"]["mode"] } = {}): AppConfig {
  const env = loadEnv();
  const sources = readJsonFile(paths.config("sources.json"), SourcesConfigSchema);
  const matching = readJsonFile(paths.config("matching.json"), MatchingConfigSchema);
  const resume = readJsonFile(paths.config("resume.json"), ResumeConfigSchema);
  const application = readJsonFile(paths.config("application.json"), ApplicationConfigSchema);
  const safety = readJsonFile(paths.config("safety.json"), SafetyConfigSchema);

  if (env.MINIMUM_MATCH_SCORE !== undefined) matching.minimumMatchScore = env.MINIMUM_MATCH_SCORE;
  if (env.APPLICATION_MODE) application.mode = env.APPLICATION_MODE;
  if (overrides.mode) application.mode = overrides.mode;
  application.browser.headless = env.PLAYWRIGHT_HEADLESS;
  if (env.BROWSER_PROFILE_DIR) application.browser.profileDir = env.BROWSER_PROFILE_DIR;

  const dryRun = overrides.dryRun ?? env.DRY_RUN;
  return { env, sources, matching, resume, application, safety, dryRun };
}
