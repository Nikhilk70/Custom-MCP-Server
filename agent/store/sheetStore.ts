import os from "node:os";
import crypto from "node:crypto";
import type { CellUpdate, SheetProvider } from "../core/interfaces.ts";
import { AgentError } from "../core/errors.ts";
import { JOB_STATUSES, type JobRecord, type JobRequirements, type JobStatus, type MatchResult, type WorkMode } from "../core/schemas.ts";
import { c, Table, type FlushPlan } from "./table.ts";
import type { StoredJdIntelligence } from "../matching/jdDecompiler.ts";

/**
 * Google Sheets is the only database. The jobs table IS the user's dashboard tab (existing 14 columns kept
 * in place, system columns appended to the right); everything else lives in system tabs next to it.
 */
export const SYSTEM_TABS = {
  details: "Job Details",
  sources: "Job Sources",
  companies: "Companies",
  searches: "Company Searches",
  timeline: "Timeline",
  resumes: "Resume Versions",
  applications: "Applications",
  answers: "Answer Log",
  runs: "Runs",
  steps: "Run Steps",
  errors: "Errors",
  reports: "Daily Reports",
  meta: "Meta",
} as const;

export const USER_COLUMNS = ["Date Added", "Source", "Company", "Job Title", "Location", "Work Mode", "Experience Req", "Salary", "Skills", "Posted Date", "Apply Link", "Match Reason", "Match Score (%)", "Status"] as const;
export const SYSTEM_COLUMNS = ["Job ID", "External Job ID", "JD Hash", "Resume Version", "Resume File", "Application Attempts", "Last Attempt", "Applied Date", "Requires Human", "Block Reason", "Last Error", "Job URL", "Company ID", "Company Domain", "Created At", "Updated At"] as const;

// ---------- row types ----------
export type JobRow = Omit<JobRecord, "jdText" | "identityKey"> & { sourcesLabel: string; resumeFile: string; lastAttemptAt: string | null; appliedDate: string | null };
export interface JobDetailRow {
  jobId: string;
  jdText: string | null;
  jdSource: string | null;
  requirements: JobRequirements | null;
  requirementsJdHash: string | null;
  match: MatchResult | null;
  matchProfileHash: string | null;
  matchedAt: string | null;
  /** JD Decompiler output (agent/matching/jdDecompiler.ts), without the JD text it quotes. */
  intelligence?: StoredJdIntelligence | null;
}
export interface JobSourceRow {
  sourceKey: string;
  jobId: string;
  source: string;
  externalJobId: string | null;
  url: string;
  urlCanonical: string;
  rawPath: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
}
export interface CompanyRow {
  companyId: string;
  companyName: string;
  category: string | null;
  type: string | null;
  enabled: boolean;
  priority: string;
  careersUrl: string | null;
  atsType: string | null;
  atsToken: string | null;
  directory: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastSuccessfulSearch: string | null;
}
export interface CompanySearchRow {
  id: string;
  searchedAt: string;
  runId: string | null;
  companyId: string;
  source: string;
  status: string;
  jobsFound: number;
  relevant: number;
  newJobs: number;
  duplicates: number;
  error: string | null;
  durationMs: number;
}
export interface EventRow {
  id: string;
  at: string;
  jobId: string;
  runId: string | null;
  kind: "STATUS" | "TIMELINE";
  fromStatus: string | null;
  toStatus: string | null;
  timelineEvent: string | null;
  reason: string | null;
  detail: unknown;
}
export type ResumeStatus = "PLANNED" | "TEX_READY" | "COMPILE_BLOCKED" | "COMPILE_FAILED" | "VALIDATION_FAILED" | "GENERATED";
export interface ResumeVersionRow {
  resumeVersionId: string;
  jobId: string;
  generatedAt: string;
  status: ResumeStatus;
  outputDir: string;
  texPath: string;
  pdfPath: string | null;
  compiler: string | null;
  templateSha256: string;
  validation: unknown;
  error: string | null;
}
export interface ApplicationRow {
  jobId: string;
  applicationId: string;
  resumeVersionId: string | null;
  mode: string;
  status: string;
  attempts: number;
  url: string | null;
  startedAt: string | null;
  lastAttemptAt: string | null;
  submittedAt: string | null;
  verifiedAt: string | null;
  blockReason: string | null;
  screenshotPath: string | null;
  evidence: unknown;
  form: unknown;
}
export interface AnswerRow {
  id: string;
  at: string;
  jobId: string;
  runId: string | null;
  fieldLabel: string;
  fieldKind: string;
  classification: string;
  canonicalKey: string | null;
  answerPreview: string | null;
  trust: string;
  confidence: number;
  action: string;
}
export interface RunRow {
  runId: string;
  kind: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  dryRun: boolean;
  mode: string;
  currentStep: string | null;
  summary: unknown;
}
export interface RunStepRow {
  stepKey: string;
  runId: string;
  step: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  detail: unknown;
}
export interface ErrorRow {
  id: string;
  at: string;
  runId: string | null;
  jobId: string | null;
  companyId: string | null;
  module: string;
  code: string;
  message: string;
  detail: unknown;
}
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0: existence check only
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists but belongs to someone else
  }
}

/** Daily Reports tab columns, in funnel order (see agent/reporting/dailyReport.ts for the definitions). */
export const REPORT_METRICS = [
  "rawJobs", "duplicates", "uniqueJobs",
  "missingJd", "validJds",
  "pendingMatch", "roleIncompatible", "roleCompatible",
  "experienceIncompatible", "experienceCompatible",
  "notEligible", "fullyEligible",
  "resumeEligible", "resumesGenerated",
  "applicationsQueued", "needsHuman", "submitted", "submissionUnverified", "failedOrSkipped",
  "technicalMatches", "technicalMatchesRoleIncompatible",
] as const;
export type ReportMetric = (typeof REPORT_METRICS)[number];

export interface ReportRow {
  id: string;
  date: string;
  runId: string | null;
  counts: Record<string, number>;
  generatedAt: string;
}
export interface MetaRow {
  name: string;
  value: string;
  updatedAt: string;
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`.toUpperCase();
}

const WORK_MODES = new Set(["remote", "hybrid", "onsite"]);

function jobsTable(tab: string): Table<JobRow> {
  const blank = (): JobRow => ({
    jobId: "", source: "", sourcesLabel: "", externalJobId: null, companyId: null, companyName: "", jobTitle: "", location: "", workMode: null, experienceRequired: null, salary: null,
    skills: [], postedDate: null, applyUrl: "", jobUrl: "", jdHash: null, companyDomain: null, matchScore: null, matchReason: null, resumeVersionId: null, status: "DISCOVERED",
    applicationAttempts: 0, requiresHuman: false, blockReason: null, lastError: null, createdAt: "", updatedAt: "", resumeFile: "", lastAttemptAt: null, appliedDate: null,
  });
  return new Table<JobRow>(
    tab,
    "Job ID",
    [
      c.derived<JobRow>("Date Added", (r) => r.createdAt.slice(0, 10)),
      { name: "Source", get: (r) => r.sourcesLabel || r.source, set: (r, v) => { r.sourcesLabel = v; r.source = v.split("+")[0]?.trim() ?? ""; } },
      c.str<JobRow>("Company", "companyName"),
      c.str<JobRow>("Job Title", "jobTitle"),
      c.str<JobRow>("Location", "location"),
      { name: "Work Mode", get: (r) => r.workMode ?? "", set: (r, v) => { r.workMode = WORK_MODES.has(v.trim().toLowerCase()) ? (v.trim().toLowerCase() as WorkMode) : null; } },
      c.nstr<JobRow>("Experience Req", "experienceRequired"),
      c.nstr<JobRow>("Salary", "salary"),
      { name: "Skills", get: (r) => r.skills.join(", "), set: (r, v) => { r.skills = v.split(",").map((s) => s.trim()).filter(Boolean); } },
      c.nstr<JobRow>("Posted Date", "postedDate"),
      c.str<JobRow>("Apply Link", "applyUrl"),
      c.nstr<JobRow>("Match Reason", "matchReason"),
      c.nnum<JobRow>("Match Score (%)", "matchScore"),
      c.str<JobRow>("Status", "status"),
      c.str<JobRow>("Job ID", "jobId"),
      c.nstr<JobRow>("External Job ID", "externalJobId"),
      c.nstr<JobRow>("JD Hash", "jdHash"),
      c.nstr<JobRow>("Resume Version", "resumeVersionId"),
      c.str<JobRow>("Resume File", "resumeFile"),
      c.num<JobRow>("Application Attempts", "applicationAttempts"),
      c.nstr<JobRow>("Last Attempt", "lastAttemptAt"),
      c.nstr<JobRow>("Applied Date", "appliedDate"),
      c.bool<JobRow>("Requires Human", "requiresHuman"),
      c.nstr<JobRow>("Block Reason", "blockReason"),
      c.nstr<JobRow>("Last Error", "lastError"),
      c.str<JobRow>("Job URL", "jobUrl"),
      c.nstr<JobRow>("Company ID", "companyId"),
      c.nstr<JobRow>("Company Domain", "companyDomain"),
      c.str<JobRow>("Created At", "createdAt"),
      c.str<JobRow>("Updated At", "updatedAt"),
    ],
    (r) => r.jobId,
    blank,
  );
}

type Tables = ReturnType<typeof buildTables>;

function buildTables(jobsTab: string) {
  const T = SYSTEM_TABS;
  return {
    jobs: jobsTable(jobsTab),
    details: new Table<JobDetailRow>(T.details, "Job ID", [
      c.str<JobDetailRow>("Job ID", "jobId"), c.nstr<JobDetailRow>("JD Source", "jdSource"), c.nstr<JobDetailRow>("JD Text", "jdText"),
      c.json<JobDetailRow>("Requirements", "requirements"), c.nstr<JobDetailRow>("Requirements JD Hash", "requirementsJdHash"),
      c.json<JobDetailRow>("Match", "match"), c.nstr<JobDetailRow>("Match Profile Hash", "matchProfileHash"), c.nstr<JobDetailRow>("Matched At", "matchedAt"),
      c.json<JobDetailRow>("JD Intelligence", "intelligence"),
    ], (r) => r.jobId, () => ({ jobId: "", jdText: null, jdSource: null, requirements: null, requirementsJdHash: null, match: null, matchProfileHash: null, matchedAt: null, intelligence: null })),
    sources: new Table<JobSourceRow>(T.sources, "Source Key", [
      c.str<JobSourceRow>("Source Key", "sourceKey"), c.str<JobSourceRow>("Job ID", "jobId"), c.str<JobSourceRow>("Source", "source"), c.nstr<JobSourceRow>("External Job ID", "externalJobId"),
      c.str<JobSourceRow>("URL", "url"), c.str<JobSourceRow>("URL Canonical", "urlCanonical"), c.nstr<JobSourceRow>("Raw Path", "rawPath"),
      c.str<JobSourceRow>("First Seen", "firstSeenAt"), c.str<JobSourceRow>("Last Seen", "lastSeenAt"), c.num<JobSourceRow>("Seen Count", "seenCount"),
    ], (r) => r.sourceKey, () => ({ sourceKey: "", jobId: "", source: "", externalJobId: null, url: "", urlCanonical: "", rawPath: null, firstSeenAt: "", lastSeenAt: "", seenCount: 0 })),
    companies: new Table<CompanyRow>(T.companies, "Company ID", [
      c.str<CompanyRow>("Company ID", "companyId"), c.str<CompanyRow>("Company", "companyName"), c.nstr<CompanyRow>("Category", "category"), c.nstr<CompanyRow>("Type", "type"),
      c.bool<CompanyRow>("Enabled", "enabled"), c.str<CompanyRow>("Priority", "priority"), c.nstr<CompanyRow>("Careers URL", "careersUrl"), c.nstr<CompanyRow>("ATS", "atsType"),
      c.nstr<CompanyRow>("Board Token", "atsToken"), c.str<CompanyRow>("Directory", "directory"), c.str<CompanyRow>("First Seen", "firstSeenAt"), c.str<CompanyRow>("Last Seen", "lastSeenAt"),
      c.nstr<CompanyRow>("Last Successful Search", "lastSuccessfulSearch"),
    ], (r) => r.companyId, () => ({ companyId: "", companyName: "", category: null, type: null, enabled: true, priority: "P2", careersUrl: null, atsType: null, atsToken: null, directory: "", firstSeenAt: "", lastSeenAt: "", lastSuccessfulSearch: null })),
    searches: new Table<CompanySearchRow>(T.searches, "ID", [
      c.str<CompanySearchRow>("ID", "id"), c.str<CompanySearchRow>("Searched At", "searchedAt"), c.nstr<CompanySearchRow>("Run ID", "runId"), c.str<CompanySearchRow>("Company ID", "companyId"),
      c.str<CompanySearchRow>("Source", "source"), c.str<CompanySearchRow>("Status", "status"), c.num<CompanySearchRow>("Jobs Found", "jobsFound"), c.num<CompanySearchRow>("Relevant", "relevant"),
      c.num<CompanySearchRow>("New Jobs", "newJobs"), c.num<CompanySearchRow>("Duplicates", "duplicates"), c.nstr<CompanySearchRow>("Error", "error"), c.num<CompanySearchRow>("Duration ms", "durationMs"),
    ], (r) => r.id, () => ({ id: "", searchedAt: "", runId: null, companyId: "", source: "", status: "", jobsFound: 0, relevant: 0, newJobs: 0, duplicates: 0, error: null, durationMs: 0 })),
    timeline: new Table<EventRow>(T.timeline, "ID", [
      c.str<EventRow>("ID", "id"), c.str<EventRow>("At", "at"), c.str<EventRow>("Job ID", "jobId"), c.nstr<EventRow>("Run ID", "runId"), c.str<EventRow>("Kind", "kind"),
      c.nstr<EventRow>("From", "fromStatus"), c.nstr<EventRow>("To", "toStatus"), c.nstr<EventRow>("Event", "timelineEvent"), c.nstr<EventRow>("Reason", "reason"), c.json<EventRow>("Detail", "detail"),
    ], (r) => r.id, () => ({ id: "", at: "", jobId: "", runId: null, kind: "STATUS", fromStatus: null, toStatus: null, timelineEvent: null, reason: null, detail: null })),
    resumes: new Table<ResumeVersionRow>(T.resumes, "Resume Version ID", [
      c.str<ResumeVersionRow>("Resume Version ID", "resumeVersionId"), c.str<ResumeVersionRow>("Job ID", "jobId"), c.str<ResumeVersionRow>("Generated At", "generatedAt"), c.str<ResumeVersionRow>("Status", "status"),
      c.str<ResumeVersionRow>("Output Dir", "outputDir"), c.str<ResumeVersionRow>("TeX Path", "texPath"), c.nstr<ResumeVersionRow>("PDF Path", "pdfPath"), c.nstr<ResumeVersionRow>("Compiler", "compiler"),
      c.str<ResumeVersionRow>("Template SHA256", "templateSha256"), c.json<ResumeVersionRow>("Validation", "validation"), c.nstr<ResumeVersionRow>("Error", "error"),
    ], (r) => r.resumeVersionId, () => ({ resumeVersionId: "", jobId: "", generatedAt: "", status: "PLANNED", outputDir: "", texPath: "", pdfPath: null, compiler: null, templateSha256: "", validation: null, error: null })),
    applications: new Table<ApplicationRow>(T.applications, "Job ID", [
      c.str<ApplicationRow>("Job ID", "jobId"), c.str<ApplicationRow>("Application ID", "applicationId"), c.nstr<ApplicationRow>("Resume Version ID", "resumeVersionId"), c.str<ApplicationRow>("Mode", "mode"),
      c.str<ApplicationRow>("Status", "status"), c.num<ApplicationRow>("Attempts", "attempts"), c.nstr<ApplicationRow>("URL", "url"), c.nstr<ApplicationRow>("Started At", "startedAt"),
      c.nstr<ApplicationRow>("Last Attempt At", "lastAttemptAt"), c.nstr<ApplicationRow>("Submitted At", "submittedAt"), c.nstr<ApplicationRow>("Verified At", "verifiedAt"),
      c.nstr<ApplicationRow>("Block Reason", "blockReason"), c.nstr<ApplicationRow>("Screenshot", "screenshotPath"), c.json<ApplicationRow>("Evidence", "evidence"), c.json<ApplicationRow>("Form Report", "form"),
    ], (r) => r.jobId, () => ({ jobId: "", applicationId: "", resumeVersionId: null, mode: "", status: "", attempts: 0, url: null, startedAt: null, lastAttemptAt: null, submittedAt: null, verifiedAt: null, blockReason: null, screenshotPath: null, evidence: null, form: null })),
    answers: new Table<AnswerRow>(T.answers, "ID", [
      c.str<AnswerRow>("ID", "id"), c.str<AnswerRow>("At", "at"), c.str<AnswerRow>("Job ID", "jobId"), c.nstr<AnswerRow>("Run ID", "runId"), c.str<AnswerRow>("Field", "fieldLabel"),
      c.str<AnswerRow>("Kind", "fieldKind"), c.str<AnswerRow>("Classification", "classification"), c.nstr<AnswerRow>("Canonical Key", "canonicalKey"), c.nstr<AnswerRow>("Answer Preview", "answerPreview"),
      c.str<AnswerRow>("Trust", "trust"), c.num<AnswerRow>("Confidence", "confidence"), c.str<AnswerRow>("Action", "action"),
    ], (r) => r.id, () => ({ id: "", at: "", jobId: "", runId: null, fieldLabel: "", fieldKind: "", classification: "", canonicalKey: null, answerPreview: null, trust: "", confidence: 0, action: "" })),
    runs: new Table<RunRow>(T.runs, "Run ID", [
      c.str<RunRow>("Run ID", "runId"), c.str<RunRow>("Kind", "kind"), c.str<RunRow>("Started At", "startedAt"), c.nstr<RunRow>("Finished At", "finishedAt"), c.str<RunRow>("Status", "status"),
      c.bool<RunRow>("Dry Run", "dryRun"), c.str<RunRow>("Mode", "mode"), c.nstr<RunRow>("Current Step", "currentStep"), c.json<RunRow>("Summary", "summary"),
    ], (r) => r.runId, () => ({ runId: "", kind: "", startedAt: "", finishedAt: null, status: "", dryRun: false, mode: "", currentStep: null, summary: null })),
    steps: new Table<RunStepRow>(T.steps, "Step Key", [
      c.str<RunStepRow>("Step Key", "stepKey"), c.str<RunStepRow>("Run ID", "runId"), c.str<RunStepRow>("Step", "step"), c.str<RunStepRow>("Status", "status"),
      c.str<RunStepRow>("Started At", "startedAt"), c.nstr<RunStepRow>("Finished At", "finishedAt"), c.json<RunStepRow>("Detail", "detail"),
    ], (r) => r.stepKey, () => ({ stepKey: "", runId: "", step: "", status: "", startedAt: "", finishedAt: null, detail: null })),
    errors: new Table<ErrorRow>(T.errors, "ID", [
      c.str<ErrorRow>("ID", "id"), c.str<ErrorRow>("At", "at"), c.nstr<ErrorRow>("Run ID", "runId"), c.nstr<ErrorRow>("Job ID", "jobId"), c.nstr<ErrorRow>("Company ID", "companyId"),
      c.str<ErrorRow>("Module", "module"), c.str<ErrorRow>("Code", "code"), c.str<ErrorRow>("Message", "message"), c.json<ErrorRow>("Detail", "detail"),
    ], (r) => r.id, () => ({ id: "", at: "", runId: null, jobId: null, companyId: null, module: "", code: "", message: "", detail: null })),
    reports: new Table<ReportRow>(T.reports, "ID", [
      c.str<ReportRow>("ID", "id"), c.str<ReportRow>("Date", "date"), c.nstr<ReportRow>("Run", "runId"), c.str<ReportRow>("Generated At", "generatedAt"),
      ...REPORT_METRICS.map(
        (k): { name: string; get: (r: ReportRow) => string; set: (r: ReportRow, v: string) => void } => ({
          name: k.replace(/([A-Z])/g, " $1").replace(/^./, (x) => x.toUpperCase()),
          get: (r) => String(r.counts[k] ?? 0),
          set: (r, v) => { r.counts[k] = Number(v) || 0; },
        }),
      ),
    ], (r) => r.id, () => ({ id: "", date: "", runId: null, counts: {}, generatedAt: "" })),
    meta: new Table<MetaRow>(T.meta, "Name", [c.str<MetaRow>("Name", "name"), c.str<MetaRow>("Value", "value"), c.str<MetaRow>("Updated At", "updatedAt")], (r) => r.name, () => ({ name: "", value: "", updatedAt: "" })),
  };
}

export interface FlushStats {
  cellsWritten: number;
  rowsAppended: number;
  apiCalls: number;
  reappended: number;
}

export class Store {
  readonly warnings: string[] = [];
  private lockOwner: string | null = null;

  private constructor(
    private readonly provider: SheetProvider,
    readonly t: Tables,
    readonly jobsTab: string,
  ) {}

  /** Loads the whole database: one listTabs, (one addTabs if needed), one batched read. */
  static async open(provider: SheetProvider, opts: { jobsTab?: string } = {}): Promise<Store> {
    const st = provider.status();
    if (st.state !== "READY") throw new AgentError("NOT_CONFIGURED", `Google Sheets is the database and is not configured: ${st.detail}`);
    const existing = await provider.listTabs();
    const jobsTab = opts.jobsTab ?? existing.find((t) => !(Object.values(SYSTEM_TABS) as string[]).includes(t)) ?? "Jobs";
    if ((Object.values(SYSTEM_TABS) as string[]).includes(jobsTab)) throw new AgentError("CONFIG_INVALID", `jobs tab '${jobsTab}' collides with a system tab name`);
    const tables = buildTables(jobsTab);
    const all = Object.values(tables).map((x) => x.tab);
    const missing = all.filter((x) => !existing.includes(x));
    if (missing.length) await provider.addTabs(missing);
    const grids = await provider.readTabs(all);
    const store = new Store(provider, tables, jobsTab);
    tables.jobs.load(grids[jobsTab] ?? [], (r) => {
      if (!(JOB_STATUSES as readonly string[]).includes(r.status)) {
        store.warnings.push(`job ${r.jobId}: invalid Status '${r.status}' in sheet — treated as NEEDS_HUMAN`);
        r.blockReason = `invalid status '${r.status}' found in sheet`;
        r.status = "NEEDS_HUMAN";
        r.requiresHuman = true;
      }
    });
    for (const [k, table] of Object.entries(tables)) if (k !== "jobs") (table as Table<object>).load(grids[table.tab] ?? []);
    for (const table of Object.values(tables)) store.warnings.push(...table.warnings);
    return store;
  }

  isDirty(): boolean {
    return Object.values(this.t).some((x) => x.isDirty());
  }

  private flushChain: Promise<unknown> = Promise.resolve();
  private lastFlushAt = Date.now();

  /**
   * Writes all pending changes (serialized: one flush at a time). Rows being updated are re-located by key
   * first (one batched column read), so a user sorting or inserting rows between load and flush can't cause
   * wrong-row writes. On failure every planned change is restored and the error is re-thrown.
   */
  flush(): Promise<FlushStats> {
    const run = this.flushChain.then(() => this.flushNow());
    this.flushChain = run.catch(() => undefined);
    return run;
  }

  /** Flush if there are changes and the last flush is older than intervalMs (checkpoint inside long loops). */
  async maybeFlush(intervalMs = 30_000): Promise<void> {
    if (this.isDirty() && Date.now() - this.lastFlushAt >= intervalMs) await this.flush();
  }

  private async flushNow(): Promise<FlushStats> {
    const stats: FlushStats = { cellsWritten: 0, rowsAppended: 0, apiCalls: 0, reappended: 0 };
    const tables = Object.values(this.t) as Array<Table<object>>;
    const plans = tables.map((table) => ({ table, plan: table.planFlush() }));
    const active = plans.filter((p) => p.plan.header.length || p.plan.updates.length || p.plan.appends.length);
    this.lastFlushAt = Date.now();
    if (!active.length) return stats;
    const appended = new Set<object>();
    try {
      const needRelocate = active.filter((p) => p.plan.updates.length);
      const keyCols = needRelocate.length ? await this.provider.readColumns(needRelocate.map((p) => ({ tab: p.table.tab, col: p.table.keyColumnIndex() }))) : [];
      if (needRelocate.length) stats.apiCalls++;
      const cells: CellUpdate[] = [];
      const extraAppends = new Map<Table<object>, FlushPlan<object>["appends"]>();
      for (const p of active) cells.push(...p.plan.header);
      needRelocate.forEach((p, i) => {
        const col = keyCols[i] ?? [];
        const rowByKey = new Map<string, number>();
        col.forEach((v, idx) => {
          if (idx > 0 && v.trim() && !rowByKey.has(v.trim())) rowByKey.set(v.trim(), idx + 1);
        });
        for (const u of p.plan.updates) {
          // An adopted orphan is found by its row hint, but only while that row's key cell is still empty.
          const hint = u.entry.adoptedAt;
          const row = rowByKey.get(u.key) ?? (hint && !(col[hint - 1] ?? "").trim() ? hint : undefined);
          if (!row) {
            // The row vanished (user deleted it): re-append the whole record rather than write into someone else's row.
            const list = extraAppends.get(p.table) ?? [];
            list.push({ entry: u.entry, row: p.table.fullRow(u.entry), dirtyNames: u.dirtyNames });
            extraAppends.set(p.table, list);
            stats.reappended++;
            this.warnings.push(`${p.table.tab}: row for '${u.key}' was missing in the sheet and has been re-added`);
            continue;
          }
          u.entry.row = row;
          for (const cc of u.cols) cells.push({ tab: p.table.tab, row, col: cc.col, value: cc.value });
        }
      });
      if (cells.length) {
        await this.provider.writeCells(cells);
        stats.apiCalls++;
        stats.cellsWritten = cells.length;
      }
      for (const p of active) {
        const appends = [...p.plan.appends, ...(extraAppends.get(p.table) ?? [])];
        if (!appends.length) continue;
        const rows = await this.provider.appendRows(p.table.tab, appends.map((x) => x.row));
        stats.apiCalls++;
        appends.forEach((x, i) => {
          x.entry.row = rows[i] ?? null;
          appended.add(x.entry);
        });
        stats.rowsAppended += appends.length;
      }
    } catch (err) {
      // Nothing is lost: planned changes go back to dirty (appends that did land keep their row numbers).
      for (const p of plans) p.table.restore({ ...p.plan, appends: p.plan.appends.filter((x) => !appended.has(x.entry)) });
      for (const p of plans) for (const x of p.plan.appends) if (appended.has(x.entry)) x.entry.pending = false;
      throw err;
    }
    for (const p of plans) p.table.markFlushed(p.plan);
    return stats;
  }

  /** Monotonic counter in the Meta tab; never lower than `floor` (e.g. the highest existing JOB number). */
  nextSequence(name: string, floor = 0): number {
    const key = `seq:${name}`;
    const cur = Number(this.t.meta.get(key)?.value ?? 0);
    const next = Math.max(Number.isFinite(cur) ? cur : 0, floor) + 1;
    const row = { name: key, value: String(next), updatedAt: new Date().toISOString() };
    if (this.t.meta.has(key)) this.t.meta.update(key, row);
    else this.t.meta.insert(row);
    return next;
  }

  /**
   * Advisory write lock (Meta "lock") so a scheduled run and a manual/MCP run don't write concurrently.
   * A lock older than ttlMs is considered stale.
   */
  async acquireLock(purpose: string, ttlMs = 2 * 3600_000): Promise<void> {
    const owner = `${os.hostname()}:${process.pid}:${purpose}`;
    const cur = this.t.meta.get("lock");
    if (cur?.value) {
      const [holder, at] = cur.value.split("|");
      const age = Date.now() - Date.parse(at ?? "");
      // A holder on this machine whose process is gone (crashed, killed) can't release it; don't wait out the TTL.
      const [host, pid] = (holder ?? "").split(":");
      const deadHere = host === os.hostname() && !!pid && !processAlive(Number(pid));
      if (holder !== owner && !deadHere && Number.isFinite(age) && age < ttlMs) throw new AgentError("VALIDATION_FAILED", `another process holds the database lock (${holder}, since ${at}); retry later`);
      if (deadHere) this.warnings.push(`took over the database lock from ${holder}: that process no longer exists`);
    }
    const row = { name: "lock", value: `${owner}|${new Date().toISOString()}`, updatedAt: new Date().toISOString() };
    if (this.t.meta.has("lock")) this.t.meta.update("lock", row);
    else this.t.meta.insert(row);
    this.lockOwner = owner;
    await this.flush();
  }

  async releaseLock(): Promise<void> {
    if (!this.lockOwner) return;
    const cur = this.t.meta.get("lock");
    if (cur?.value.startsWith(`${this.lockOwner}|`)) this.t.meta.update("lock", { value: "", updatedAt: new Date().toISOString() });
    this.lockOwner = null;
    await this.flush();
  }
}

export type { JobStatus };
