export type Phase = "IDLE" | "SEARCHING" | "SYNCING" | "PREPARING" | "OPENING" | "FILLING" | "WAITING_HUMAN" | "WAITING_CAPTCHA" | "WAITING_REVIEW" | "SUBMITTING" | "VERIFYING" | "PAUSED" | "STOPPING";

export interface AgentState {
  phase: Phase;
  message: string;
  operation: "find" | "sync" | "auto-apply" | null;
  paused: boolean;
  stopRequested: boolean;
  current: { itemId: string; jobId: string; company: string; role: string } | null;
  session: Session | null;
  runMode: { live: boolean; mode: string; requireReview: boolean } | null;
  liveArmed: boolean;
  defaults: { dryRun: boolean; mode: string };
  demo: boolean;
  queue: { pending: number };
  tasks: { pending: number };
  notifications: { unread: number };
  database: "READY" | "UNAVAILABLE";
  databaseDetail: string | null;
  lastRefresh: string | null;
  browserOpen: boolean;
}

export interface Session {
  sessionId: string;
  kind: "AUTO_APPLY" | "SHEET_SYNC" | "FIND_JOBS";
  startedAt: string;
  endedAt: string | null;
  mode: string | null;
  dryRun: boolean;
  status: "RUNNING" | "COMPLETED" | "STOPPED" | "FAILED";
  jobsQueued: number;
  jobsProcessed: number;
  submitted: number;
  confirmed: number;
  dryRunValidated: number;
  skipped: number;
  alreadyApplied: number;
  needsReview: number;
  failed: number;
  humanInterventions: number;
  answersLearned: number;
  errors: string[];
  sync: { imported: number; alreadyKnown: number; skippedRows: number; ready: number; failed: number } | null;
  note: string | null;
}

export interface ActivityEvent {
  id: string;
  at: string;
  type: string;
  category: "jobs" | "applications" | "questions" | "human" | "errors" | "system";
  level: "info" | "success" | "warn" | "error";
  message: string;
  jobId: string | null;
}

export interface JobItem {
  jobId: string;
  company: string;
  role: string;
  location: string;
  workMode: string | null;
  experience: string | null;
  salary: string | null;
  match: number | null;
  eligible: boolean | null;
  eligibilityReason: string | null;
  jobFamily: string | null;
  source: string;
  status: string;
  discoveredAt: string;
  postedDate: string | null;
  applyUrl: string;
  skills: string[];
  saved?: boolean;
  queued?: boolean;
  /** Readiness decision from the career engine (APPLY_NOW, BUILD_PROOF_FIRST, …). */
  decision?: string | null;
  /** Up to 3 mandatory skills the JD asks for that you have no (or only weak) evidence for. */
  missingSkills?: string[];
  /** How many postings of this same opening exist (duplicates merged). */
  postings?: number;
  duplicateIds?: string[];
}

export interface Explanation {
  eligible: boolean | null;
  headline: string;
  signals: Array<{ label: string; ok: boolean | null; detail: string }>;
  matchedSkills: Array<{ skill: string; level: string }>;
  unknownSkills: string[];
  concerns: string[];
  components: Array<{ name: string; score: number; weight: number; detail: string }>;
}

export interface TimelineEntry {
  at: string;
  kind: "STATUS" | "TIMELINE";
  event: string;
  from: string | null;
  reason: string | null;
  detail: unknown;
}

export interface QueueItem {
  id: string;
  jobId: string;
  company: string;
  role: string;
  priority: number;
  status: "QUEUED" | "RUNNING" | "DONE" | "HUMAN_REQUIRED" | "FAILED" | "SKIPPED" | "CANCELLED";
  attemptCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  humanTaskId: string | null;
  outcome: string | null;
  sessionId: string | null;
}

export interface Citation {
  chunkId: string;
  title: string;
  source: string;
  snippet: string;
}

export interface Suggestion {
  answer: string;
  method: "ANSWER_BANK" | "PAST_APPLICATION" | "AI_GROUNDED";
  confidence: number;
  citations: Citation[];
  note: string;
}

export interface PendingQuestion {
  label: string;
  kind: string;
  options: string[];
  required: boolean;
  reason: string;
  /** RAG suggestions from the user's own records — used only if the user picks one. */
  suggestions?: Suggestion[];
  sources?: Citation[];
}

export interface HumanTask {
  id: string;
  type: string;
  title: string;
  why: string;
  whatToDo: string;
  whatNext: string;
  jobId: string | null;
  company: string | null;
  role: string | null;
  blocking: boolean;
  status: "PENDING" | "RESOLVED" | "SKIPPED" | "EXPIRED";
  createdAt: string;
  resolvedAt: string | null;
  payload: Record<string, unknown>;
  answer: unknown;
}

export interface FieldRow {
  label: string;
  kind: string;
  required: boolean;
  classification: string;
  action: string;
  trust: string;
  confidence: number;
  answerPreview: string | null;
  reason: string;
  source: string | null;
}

export interface ApplicationItem {
  applicationId: string | null;
  jobId: string;
  company: string;
  role: string;
  location: string;
  source: string;
  status: string;
  rawStatus: string;
  jobStatus: string | null;
  mode: string | null;
  attempts: number;
  lastActivity: string | null;
  submittedAt: string | null;
  verifiedAt: string | null;
  blockReason: string | null;
  screenshot: string | null;
  evidence: { verdict?: string; signals?: string[]; confirmationText?: string | null; confirmationId?: string | null; evidence?: string } | null;
  url: string | null;
  fields: FieldRow[];
  finalSubmit: string | null;
}

export interface AnswerItem {
  id: string;
  question: string;
  answer: string | null;
  category: string;
  scope: "GLOBAL" | "COMPANY";
  company: string | null;
  source: "USER" | "RESUME" | "PROFILE" | "COMPANY_SPECIFIC";
  editable: boolean;
  disabled: boolean;
  line: number | null;
  usageCount: number;
  lastUsed: string | null;
  note: string | null;
}

export interface HealthItem {
  id: string;
  name: string;
  state: "HEALTHY" | "DEGRADED" | "DOWN" | "DISABLED" | "NOT_CONFIGURED" | "UNSUPPORTED";
  detail: string;
  diagnostics: string[];
}

export interface AppNotification {
  id: string;
  at: string;
  title: string;
  body: string;
  level: "info" | "success" | "warn" | "error";
  link: string | null;
  read: boolean;
}
