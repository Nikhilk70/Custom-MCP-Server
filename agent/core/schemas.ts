import { z } from "zod";

export const JOB_STATUSES = [
  "DISCOVERED",
  "NORMALIZED",
  "DUPLICATE",
  "JD_FETCHED",
  "MATCHED",
  "NOT_MATCHED",
  "READY_FOR_RESUME",
  "RESUME_GENERATING",
  "RESUME_GENERATED",
  "READY_TO_APPLY",
  "APPLYING",
  "FORM_DETECTED",
  "FORM_FILLED",
  "VALIDATION_FAILED",
  "NEEDS_HUMAN",
  "SUBMITTING",
  "APPLIED",
  "SUBMISSION_UNVERIFIED",
  "FAILED",
  "BLOCKED",
  "SKIPPED",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Timeline milestones (section 29). Stored in application_events alongside status transitions. */
export const TIMELINE_EVENTS = [
  "DISCOVERED",
  "JD_FETCHED",
  "MATCHED",
  "RESUME_GENERATED",
  "APPLICATION_STARTED",
  "FORM_DETECTED",
  "FORM_FILLED",
  "RESUME_UPLOADED",
  "HUMAN_WAIT_STARTED",
  "GOOGLE_SIGNIN_STARTED",
  "GOOGLE_SIGNIN_VERIFIED",
  "HUMAN_WAIT_COMPLETED",
  "PAYMENT_REQUESTED",
  "VALIDATION_PASSED",
  "SUBMITTED",
  "SUBMISSION_VERIFIED",
] as const;
export type TimelineEvent = (typeof TIMELINE_EVENTS)[number];

export const COMPANY_SEARCH_STATUSES = [
  "SUCCESS_NO_JOBS",
  "SUCCESS_WITH_JOBS",
  "SOURCE_UNAVAILABLE",
  "AUTH_REQUIRED",
  "PARSER_FAILED",
  "NETWORK_ERROR",
  "UNSUPPORTED",
  "NOT_CONFIGURED",
] as const;
export type CompanySearchStatus = (typeof COMPANY_SEARCH_STATUSES)[number];

export const ATS_TYPES = ["greenhouse", "lever", "ashby", "smartrecruiters", "workday", "successfactors", "icims", "custom"] as const;
export type AtsType = (typeof ATS_TYPES)[number];

export const CompanyProfileSchema = z.object({
  companyId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "companyId must be lowercase letters, digits and dashes").optional(),
  companyName: z.string().min(1),
  category: z.enum(["MNC", "Product", "Service", "Startup"]).optional(),
  type: z.enum(["Product", "Service"]).optional(),
  enabled: z.boolean().default(true),
  priority: z.enum(["P1", "P2", "P3"]).default("P2"),
  careersUrl: z.string().url().nullable().optional(),
  domains: z.array(z.string()).default([]),
  ats: z
    .object({
      type: z.enum(ATS_TYPES),
      boardToken: z.string().min(1).nullable().optional(),
      /** ISO 3166 alpha-2; server-side country filter where the ATS supports one (SmartRecruiters). */
      country: z.string().regex(/^[a-z]{2}$/i, "country must be a 2-letter ISO code").optional(),
    })
    .nullable()
    .optional(),
  locations: z.array(z.string()).default([]),
  notes: z.string().default(""),
});
export type CompanyProfileInput = z.input<typeof CompanyProfileSchema>;

export interface CompanyProfile {
  companyId: string;
  companyName: string;
  category: "MNC" | "Product" | "Service" | "Startup" | null;
  type: "Product" | "Service" | null;
  enabled: boolean;
  priority: "P1" | "P2" | "P3";
  careersUrl: string | null;
  domains: string[];
  ats: { type: AtsType; boardToken: string | null; country?: string } | null;
  locations: string[];
  notes: string;
  /** Directory relative to Companies/, e.g. "MNCs/Product/Acme". */
  directory: string;
  filePath: string;
}

export interface JobSearchQuery {
  roles: string[];
  locations: string[];
  limit: number;
  postedWithinDays?: number;
  /** Cheap title/location relevance check so adapters can skip expensive per-job detail calls. */
  prefilter?: (title: string, location: string) => boolean;
}

/** What a source adapter returns: raw facts exactly as the source provided them. */
export interface RawJob {
  source: string;
  externalJobId: string | null;
  companyName: string;
  companyId: string | null;
  jobTitle: string;
  location: string;
  workMode: WorkMode | null;
  experienceRequired: string | null;
  salary: string | null;
  postedDate: string | null;
  applyUrl: string;
  jobUrl: string;
  jdText: string | null;
  companyDomain: string | null;
  raw: unknown;
}

export type WorkMode = "remote" | "hybrid" | "onsite";

export interface JobRecord {
  jobId: string;
  source: string;
  externalJobId: string | null;
  companyId: string | null;
  companyName: string;
  jobTitle: string;
  location: string;
  workMode: WorkMode | null;
  experienceRequired: string | null;
  salary: string | null;
  skills: string[];
  postedDate: string | null;
  applyUrl: string;
  jobUrl: string;
  jdText: string | null;
  jdHash: string | null;
  companyDomain: string | null;
  matchScore: number | null;
  matchReason: string | null;
  resumeVersionId: string | null;
  status: JobStatus;
  applicationAttempts: number;
  requiresHuman: boolean;
  blockReason: string | null;
  lastError: string | null;
  identityKey: string;
  createdAt: string;
  updatedAt: string;
}

export type SkillLevel = "verified" | "basic" | "learning" | "unknown" | "missing";

export const ELIGIBILITY_CODES = ["ROLE_FAMILY_INCOMPATIBLE", "ROLE_EXCLUDED_PATTERN", "EXPERIENCE_INCOMPATIBLE", "MANDATORY_REQUIREMENT_FAILED", "BELOW_TECHNICAL_THRESHOLD"] as const;
export type EligibilityCode = (typeof ELIGIBILITY_CODES)[number];

/**
 * Gates run in this order and are all evaluated (for reporting); the first failing one is the reason:
 * role → experience → mandatory requirements → technical score.
 */
export interface MatchResult {
  /** Same as technicalMatchScore; kept for existing readers. */
  score: number;
  /** Weighted skill/title/experience/location/education score. Never makes an ineligible job eligible. */
  technicalMatchScore: number;
  role: { jobFamily: string; targetRoleCompatible: boolean; reason: string; confidence: number; evidence: string[] };
  roleCompatibility: "COMPATIBLE" | "INCOMPATIBLE";
  experienceCompatibility: "COMPATIBLE" | "INCOMPATIBLE";
  gates: { role: string[]; experience: string[]; mandatory: string[]; technical: string[] };
  eligibilityStatus: "ELIGIBLE" | "NOT_ELIGIBLE";
  /** First failing gate, null when eligible. */
  eligibilityReason: EligibilityCode | null;
  reason: string;
  matchedSkills: Array<{ skill: string; level: SkillLevel; profileSkill: string; contexts: string[] }>;
  missingSkills: string[];
  supportingEvidence: string[];
  riskFlags: string[];
  components: Record<string, { weight: number; score: number; detail: string }>;
  /** All gate failures (role, experience, mandatory), for existing readers. */
  hardConstraintFailures: string[];
  /** eligibilityStatus === "ELIGIBLE". */
  eligible: boolean;
}

export interface JobRequirements {
  requiredSkills: string[];
  preferredSkills: string[];
  responsibilities: string[];
  roleKeywords: string[];
  minYearsExperience: number | null;
  maxYearsExperience: number | null;
  experienceText: string | null;
  educationRequirements: string[];
  location: string;
  workMode: WorkMode | null;
  extractionMethod: "deterministic" | "deterministic+ai";
}
