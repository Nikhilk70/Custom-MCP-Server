import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import type { ApplicationMode } from "../agent/core/env.ts";
import type { AppConfig } from "../agent/core/config.ts";
import { AgentError, errorMessage } from "../agent/core/errors.ts";
import type { Logger } from "../agent/core/logger.ts";
import type { JobRecord, JobStatus } from "../agent/core/schemas.ts";
import { normalizeCompany } from "../agent/core/text.ts";
import { processApplication, type ApplicationDeps, type ApplicationResult } from "../agent/application/applicationEngine.ts";
import type { HumanBridge, PendingQuestion, QuestionAnswer } from "../agent/application/humanBridge.ts";
import type { BaseContext } from "../agent/orchestration/container.ts";
import { finishRun, startRun } from "../agent/orchestration/runs.ts";
import { findJobs, PRE_RESUME, readyJob, searchProfile, syncSheet, type SheetDeps } from "../agent/pipeline/sheetJobs.ts";
import { generateResume, type ResumeDeps } from "../agent/resume/generator.ts";
import { loadQuestionBank, type QuestionRecord } from "../agent/questions/questionBank.ts";
import { loadProfile, type Profile } from "../agent/profile/profile.ts";
import { JobRepo } from "../agent/store/repositories.ts";
import { requeueJob } from "../agent/store/jobActions.ts";
import { transition } from "../agent/store/stateMachine.ts";
import type { Store } from "../agent/store/sheetStore.ts";
import { AnswerBank } from "./answerBank.ts";
import { EventBus } from "./events.ts";
import { HumanTaskCenter, type HumanTask, type HumanTaskType } from "./humanTasks.ts";
import { JsonFile, newLocalId } from "./lib/jsonFile.ts";
import { Notifications, type AppNotification } from "./notifications.ts";
import { AgentQueue, type QueueItem, type QueueOutcome } from "./queue.ts";
import { teeLogger } from "./teeLogger.ts";

export const AGENT_PHASES = ["IDLE", "SEARCHING", "SYNCING", "PREPARING", "OPENING", "FILLING", "WAITING_HUMAN", "WAITING_CAPTCHA", "WAITING_REVIEW", "SUBMITTING", "VERIFYING", "PAUSED", "STOPPING"] as const;
export type AgentPhase = (typeof AGENT_PHASES)[number];

export interface AgentSession {
  sessionId: string;
  kind: "AUTO_APPLY" | "SHEET_SYNC" | "FIND_JOBS";
  startedAt: string;
  endedAt: string | null;
  mode: ApplicationMode | null;
  dryRun: boolean;
  status: "RUNNING" | "COMPLETED" | "STOPPED" | "FAILED";
  runId: string | null;
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
  /** Sheet sync only. */
  sync: { imported: number; alreadyKnown: number; skippedRows: number; ready: number; failed: number } | null;
  /** Find jobs only. */
  find?: { companiesSearched: number; jobsFound: number; newJobs: number; goodFit: number; lowFit: number; jdFailed: number } | null;
  note: string | null;
}

export interface Settings {
  /** Seconds between two applications in one run (enforced). */
  delayBetweenApplicationsSec: number;
  /** Live submissions per calendar day (enforced; counts applications recorded as submitted today). */
  dailyLiveLimit: number;
  /** Upper bound per run (enforced). */
  maxApplicationsPerRun: number;
  /** Upload this PDF instead of the tailored resume for every application. */
  primaryResumeId: string | null;
  useUploadedResume: boolean;
  browserNotifications: boolean;
}

export interface AutoApplyRequest {
  jobIds?: string[];
  /** selected: jobIds · pending: every synced job not applied to yet · matched: every good-fit job Find jobs found · queued: just process what is queued. */
  scope: "selected" | "pending" | "matched" | "queued";
  live: boolean;
  /** Must be the word LIVE for a live run. */
  confirm?: string;
  requireReview: boolean;
  pauseForQuestions: boolean;
  pauseForHuman: boolean;
  maxApplications?: number;
  delaySeconds?: number;
  allowedCompanies?: string[];
  blockedCompanies?: string[];
  priority?: number;
}

export interface RuntimeHooks {
  /** Replaces LaTeX resume generation (demo mode). */
  prepareResume?: (deps: ResumeDeps, jobId: string) => Promise<void>;
  /** Replaces the application engine (tests). */
  apply?: (deps: ApplicationDeps, jobId: string) => Promise<ApplicationResult>;
  /** Extra safety settings (demo: the mock verification selector). */
  adjustConfig?: (cfg: AppConfig) => AppConfig;
}

export interface RuntimeOptions {
  base: BaseContext;
  openStore: () => Promise<Store>;
  stateDir: string;
  answersFile: string;
  questionsDir?: string;
  uploadsDir: string;
  demo: boolean;
  hooks?: RuntimeHooks;
}

type RunOpts = Required<Pick<AutoApplyRequest, "requireReview" | "pauseForQuestions" | "pauseForHuman">> & { live: boolean; mode: ApplicationMode; max: number; delayMs: number; allowed: string[]; blocked: string[] };

const DEFAULT_SETTINGS = (cfg: AppConfig): Settings => ({ delayBetweenApplicationsSec: 10, dailyLiveLimit: 10, maxApplicationsPerRun: cfg.application.maxApplicationsPerRun, primaryResumeId: null, useUploadedResume: false, browserNotifications: false });

/**
 * ApplyPilot's agent runtime: one long-lived process that owns the database connection, the browser, the application
 * queue and every human hand-off. It drives the same engine functions as the CLI; no business logic lives in the UI.
 *
 * Safety: runs are dry runs unless the user explicitly arms live mode (per server session) AND confirms each live run.
 * Pause/stop are honored at every checkpoint; a CAPTCHA is always completed by the user in the browser.
 */
export class AgentRuntime {
  readonly bus: EventBus;
  readonly tasks: HumanTaskCenter;
  readonly queue: AgentQueue;
  readonly notifications: Notifications;
  readonly answers: AnswerBank;
  readonly logger: Logger;
  private readonly sessionsFile: JsonFile<AgentSession[]>;
  private readonly settingsFile: JsonFile<Settings>;
  private sessions: AgentSession[];
  settings: Settings;
  store: Store | null = null;
  storeError: string | null = null;
  lastRefresh: string | null = null;
  profile: Profile;
  questions: QuestionRecord[];
  questionIssues: string[] = [];

  phase: AgentPhase = "IDLE";
  message = "Agent idle";
  operation: "find" | "sync" | "auto-apply" | null = null;
  paused = false;
  stopRequested = false;
  private skipCurrent = false;
  liveArmed = false;
  current: { itemId: string; jobId: string; company: string; role: string } | null = null;
  currentSession: AgentSession | null = null;
  page: Page | null = null;
  private runOpts: RunOpts | null = null;
  private resumeWaiters: Array<() => void> = [];
  private worker: Promise<void> | null = null;

  constructor(private readonly opts: RuntimeOptions) {
    const dir = opts.stateDir;
    fs.mkdirSync(dir, { recursive: true });
    this.bus = new EventBus(path.join(dir, "activity.jsonl"));
    this.tasks = new HumanTaskCenter(new JsonFile(path.join(dir, "human-tasks.json"), () => []), () => this.bus.push({ kind: "tasks" }));
    this.queue = new AgentQueue(new JsonFile(path.join(dir, "queue.json"), () => []));
    this.notifications = new Notifications(new JsonFile(path.join(dir, "notifications.json"), () => []), this.bus);
    this.answers = new AnswerBank(opts.answersFile, path.join(dir, "answer-backups"));
    this.sessionsFile = new JsonFile(path.join(dir, "sessions.json"), () => []);
    this.sessions = this.sessionsFile.read();
    this.settingsFile = new JsonFile(path.join(dir, "settings.json"), () => DEFAULT_SETTINGS(opts.base.cfg));
    this.settings = { ...DEFAULT_SETTINGS(opts.base.cfg), ...this.settingsFile.read() };
    this.logger = teeLogger(opts.base.logger, this.bus, opts.base.masker);
    this.profile = opts.base.profile;
    const qb = loadQuestionBank(opts.questionsDir, opts.answersFile);
    this.questions = qb.records;
    this.questionIssues = qb.issues;
    const interrupted = this.queue.recoverInterrupted();
    for (const s of this.sessions.filter((x) => x.status === "RUNNING")) Object.assign(s, { status: "STOPPED", endedAt: new Date().toISOString(), note: "ApplyPilot stopped during this run" });
    this.sessionsFile.write(this.sessions);
    if (interrupted) this.notify({ title: "An application was interrupted", body: `${interrupted} application(s) were in progress when ApplyPilot stopped. They are marked FAILED — check them before retrying.`, level: "warn", link: "#/agent" });
  }

  get base(): BaseContext {
    return this.opts.base;
  }
  /** Demo mode installs its hooks once the server port (and so the mock site URL) is known. */
  setHooks(hooks: RuntimeHooks): void {
    this.opts.hooks = hooks;
  }
  get demo(): boolean {
    return this.opts.demo;
  }
  get uploadsDir(): string {
    return this.opts.uploadsDir;
  }
  get answersFile(): string {
    return this.opts.answersFile;
  }

  // ---------------------------------------------------------------- database

  async connect(): Promise<void> {
    try {
      this.store = await this.opts.openStore();
      this.storeError = null;
      this.lastRefresh = new Date().toISOString();
      for (const w of this.store.warnings) this.bus.emit({ type: "store.warning", category: "system", level: "warn", message: w });
    } catch (err) {
      this.store = null;
      this.storeError = errorMessage(err);
      this.bus.emit({ type: "store.unavailable", category: "errors", level: "error", message: `Database unavailable: ${this.storeError}` });
    }
    this.pushState();
  }

  requireStore(): Store {
    if (!this.store) throw new AgentError("NOT_CONFIGURED", `The Google Sheets database is not available: ${this.storeError ?? "not connected"}. See Settings → Integrations.`);
    return this.store;
  }

  /** Re-reads the sheet (picks up CLI changes and your edits in Google Sheets). Only while the agent is idle. */
  async refresh(): Promise<void> {
    if (this.operation) throw new AgentError("VALIDATION_FAILED", "The agent is running; data refreshes automatically when it finishes.");
    await this.connect();
    this.reloadKnowledge();
    this.bus.push({ kind: "jobs" });
    this.bus.push({ kind: "applications" });
  }

  reloadKnowledge(): void {
    try {
      this.profile = loadProfile();
    } catch (err) {
      this.bus.emit({ type: "profile.invalid", category: "errors", level: "error", message: `MY_DATA could not be loaded: ${errorMessage(err)}` });
    }
    const qb = loadQuestionBank(this.opts.questionsDir, this.opts.answersFile, this.profile);
    this.questions = qb.records;
    this.questionIssues = qb.issues;
    this.bus.push({ kind: "answers" });
  }

  /** Every write operation: fresh data, the shared database lock, a Runs row, a flush, and the lock released. */
  private async withDb<T>(kind: string, fn: (store: Store, runId: string) => Promise<T>): Promise<T> {
    await this.connect();
    const store = this.requireStore();
    await store.acquireLock(`applypilot:${kind}`);
    // Small edits from the UI (requeue, mark applied) are not "runs"; they get no Runs row.
    const runId = kind === "ui" ? "UI" : startRun(store, kind, { dryRun: this.runOpts ? !this.runOpts.live : this.base.cfg.dryRun, mode: this.runOpts?.mode ?? this.base.cfg.application.mode, resume: false }).runId;
    try {
      const r = await fn(store, runId);
      if (kind !== "ui") finishRun(store, runId, "COMPLETED", summarize(r));
      return r;
    } catch (err) {
      if (kind !== "ui") finishRun(store, runId, "FAILED", { error: errorMessage(err) });
      throw err;
    } finally {
      await store.flush().catch((e: unknown) => this.bus.emit({ type: "store.flush_failed", category: "errors", level: "error", message: `Saving to Google Sheets failed: ${errorMessage(e)}` }));
      await store.releaseLock().catch(() => undefined);
      this.lastRefresh = new Date().toISOString();
    }
  }

  // ---------------------------------------------------------------- state

  state(): Record<string, unknown> {
    return {
      phase: this.phase,
      message: this.message,
      operation: this.operation,
      paused: this.paused,
      stopRequested: this.stopRequested,
      current: this.current,
      session: this.currentSession,
      runMode: this.runOpts ? { live: this.runOpts.live, mode: this.runOpts.mode, requireReview: this.runOpts.requireReview } : null,
      liveArmed: this.liveArmed,
      defaults: { dryRun: this.base.cfg.dryRun, mode: this.base.cfg.application.mode },
      demo: this.opts.demo,
      queue: { pending: this.queue.pending() },
      tasks: { pending: this.tasks.pendingCount() },
      notifications: { unread: this.notifications.unread() },
      database: this.store ? "READY" : "UNAVAILABLE",
      databaseDetail: this.storeError,
      lastRefresh: this.lastRefresh,
      browserOpen: !!this.page && !this.page.isClosed(),
    };
  }

  private setPhase(phase: AgentPhase, message: string): void {
    this.phase = phase;
    this.message = message;
    this.pushState();
  }

  pushState(): void {
    this.bus.push({ kind: "state", state: this.state() });
  }

  notify(n: { title: string; body: string; level?: AppNotification["level"]; link?: string | null }): void {
    this.notifications.add(n);
    this.pushState();
  }

  sessionsList(): AgentSession[] {
    return [...this.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  private saveSession(s: AgentSession): void {
    const i = this.sessions.findIndex((x) => x.sessionId === s.sessionId);
    if (i >= 0) this.sessions[i] = s;
    else this.sessions.push(s);
    this.sessions = this.sessions.slice(-300);
    this.sessionsFile.write(this.sessions);
  }

  private newSession(kind: AgentSession["kind"], mode: ApplicationMode | null, dryRun: boolean): AgentSession {
    const s: AgentSession = { sessionId: newLocalId("SES"), kind, startedAt: new Date().toISOString(), endedAt: null, mode, dryRun, status: "RUNNING", runId: null, jobsQueued: 0, jobsProcessed: 0, submitted: 0, confirmed: 0, dryRunValidated: 0, skipped: 0, alreadyApplied: 0, needsReview: 0, failed: 0, humanInterventions: 0, answersLearned: 0, errors: [], sync: null, note: null };
    this.saveSession(s);
    return s;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.settings, ...patch };
    if (!Number.isFinite(next.delayBetweenApplicationsSec) || next.delayBetweenApplicationsSec < 0 || next.delayBetweenApplicationsSec > 3600) throw new AgentError("VALIDATION_FAILED", "delay must be 0–3600 seconds");
    if (!Number.isInteger(next.dailyLiveLimit) || next.dailyLiveLimit < 0 || next.dailyLiveLimit > 200) throw new AgentError("VALIDATION_FAILED", "daily limit must be 0–200");
    if (!Number.isInteger(next.maxApplicationsPerRun) || next.maxApplicationsPerRun < 1 || next.maxApplicationsPerRun > 100) throw new AgentError("VALIDATION_FAILED", "max per run must be 1–100");
    if (next.useUploadedResume && !this.primaryResumePath(next.primaryResumeId)) throw new AgentError("VALIDATION_FAILED", "choose an uploaded resume first");
    this.settings = next;
    this.settingsFile.write(next);
    this.pushState();
    return next;
  }

  primaryResumePath(id = this.settings.primaryResumeId): string | null {
    if (!id || !/^[\w.-]+\.pdf$/i.test(id)) return null;
    const p = path.join(this.opts.uploadsDir, id);
    return fs.existsSync(p) ? p : null;
  }

  /** Live mode stays off until the user arms it; arming lasts until ApplyPilot restarts. */
  armLive(armed: boolean, confirm?: string): void {
    if (armed && confirm !== "LIVE") throw new AgentError("VALIDATION_FAILED", "type LIVE to allow real applications to be submitted");
    this.liveArmed = armed;
    this.bus.emit({ type: armed ? "LIVE_ARMED" : "LIVE_DISARMED", category: "system", level: armed ? "warn" : "info", message: armed ? "Live application mode armed: runs you start in live mode may submit real applications" : "Live application mode disarmed: every run is a dry run" });
    this.pushState();
  }

  // ---------------------------------------------------------------- controls

  pause(): void {
    if (!this.operation) throw new AgentError("VALIDATION_FAILED", "the agent is not running");
    this.paused = true;
    this.bus.emit({ type: "QUEUE_PAUSED", category: "system", message: "Agent paused — it stops at the next safe point (before filling or submitting, or before the next job)" });
    this.setPhase(this.phase, "Pausing at the next safe point");
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const w = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const r of w) r();
    this.bus.emit({ type: "QUEUE_RESUMED", category: "system", message: "Agent resumed" });
    this.pushState();
  }

  /** STOP ALL: no new application starts; the current one stops at its next checkpoint; waiting hand-offs are released. */
  stopAll(): void {
    this.stopRequested = true;
    this.paused = false;
    for (const r of this.resumeWaiters.splice(0)) r();
    this.tasks.releaseAll("stopped by you (STOP ALL)");
    this.bus.emit({ type: "AGENT_STOPPED", category: "system", level: "warn", message: "STOP ALL: no further applications will start; the current one stops before submitting" });
    if (this.operation) this.setPhase("STOPPING", "Stopping safely…");
    else this.pushState();
  }

  /** Skip the job being processed now (it stops at the next checkpoint and nothing is submitted). */
  skipCurrentJob(): void {
    if (!this.current) throw new AgentError("VALIDATION_FAILED", "no application is in progress");
    this.skipCurrent = true;
    const jobId = this.current.jobId;
    this.tasks.releaseAll("job skipped by you", (t) => t.jobId === jobId);
    this.bus.emit({ type: "JOB_SKIP_REQUESTED", category: "applications", message: `Skipping ${this.current.company} — ${this.current.role} at the next safe point`, jobId });
  }

  bringBrowserToFront(): boolean {
    if (!this.page || this.page.isClosed()) return false;
    void this.page.bringToFront().catch(() => undefined);
    return true;
  }

  async previewJpeg(): Promise<Buffer | null> {
    if (!this.page || this.page.isClosed()) return null;
    return this.page.screenshot({ type: "jpeg", quality: 55, timeout: 4000 }).catch(() => null);
  }

  private async waitWhilePaused(): Promise<void> {
    if (!this.paused || this.stopRequested) return;
    const prev = { phase: this.phase, message: this.message };
    this.setPhase("PAUSED", "Paused — click Resume to continue");
    await new Promise<void>((r) => this.resumeWaiters.push(r));
    if (!this.stopRequested) this.setPhase(prev.phase === "PAUSED" ? "FILLING" : prev.phase, prev.message);
  }

  private async sleep(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until && !this.stopRequested) await new Promise((r) => setTimeout(r, Math.min(500, until - Date.now())));
  }

  // ---------------------------------------------------------------- sheet sync

  private sheetDeps(store: Store, runId: string | null): SheetDeps {
    return { cfg: this.cfg(), store, profile: searchProfile(this.base.cfg, this.profile), jdProvider: this.base.jdProvider, runId };
  }

  /** Searches the company career boards for jobs that fit your resume, reads and scores each JD, adds them to the sheet. */
  startFind(): { sessionId: string } {
    if (this.operation) throw new AgentError("VALIDATION_FAILED", `the agent is busy (${this.operation}); wait for it to finish or stop it`);
    const session = this.newSession("FIND_JOBS", null, true);
    this.operation = "find";
    this.stopRequested = false;
    this.currentSession = session;
    this.worker = this.runFind(session).finally(() => {
      this.operation = null;
      this.currentSession = null;
      this.stopRequested = false;
      this.setPhase("IDLE", "Agent idle");
    });
    return { sessionId: session.sessionId };
  }

  private async runFind(session: AgentSession): Promise<void> {
    this.setPhase("SEARCHING", "Searching for jobs that fit your resume…");
    this.bus.emit({ type: "FIND_STARTED", category: "jobs", message: "Started searching for jobs that fit your resume" });
    try {
      const r = await this.withDb("find", async (store, runId) => {
        session.runId = runId;
        return findJobs({ ...this.sheetDeps(store, runId), logger: this.logger, companySource: this.base.companySource, linkedin: this.base.linkedin }, (msg) => this.setPhase("SEARCHING", msg));
      });
      session.find = { companiesSearched: r.companiesSearched, jobsFound: r.jobsFound, newJobs: r.newJobs, goodFit: r.goodFit.length, lowFit: r.lowFit.length, jdFailed: r.jdFailed.length };
      Object.assign(session, { status: "COMPLETED", endedAt: new Date().toISOString(), errors: [...r.companiesFailed.map((c) => `${c.company}: ${c.error}`), ...r.jdFailed.map((f) => `${f.jobId}: ${f.reason}`)] });
      for (const e of r.linkedInErrors) this.bus.emit({ type: "LINKEDIN_SEARCH_FAILED", category: "errors", level: "warn", message: `LinkedIn: ${e}` });
      for (const c of r.companiesFailed) this.bus.emit({ type: "COMPANY_SEARCH_FAILED", category: "errors", level: "warn", message: `${c.company}: ${c.error}` });
      const where = [r.linkedInSearches ? `${r.linkedInSearches} LinkedIn searches` : "", r.companiesSearched ? `${r.companiesSearched} company boards` : ""].filter(Boolean).join(" + ");
      const msg = `${where || "nothing"} searched · ${r.newJobs} new job(s) added to your sheet · ${r.goodFit.length} good fit · ${r.lowFit.length} low fit${r.jdFailed.length ? ` · ${r.jdFailed.length} JD(s) unreadable` : ""}`;
      this.bus.emit({ type: "JOBS_FOUND", category: "jobs", level: "success", message: msg });
      this.notify({ title: r.newJobs ? `${r.newJobs} new job(s) found` : "Job search complete", body: msg, level: "success", link: "#/jobs" });
    } catch (err) {
      const msg = errorMessage(err);
      Object.assign(session, { status: "FAILED", endedAt: new Date().toISOString(), errors: [...session.errors, msg] });
      this.bus.emit({ type: "FIND_FAILED", category: "errors", level: "error", message: `Job search failed: ${msg}` });
      this.notify({ title: "Job search failed", body: msg, level: "error", link: "#/jobs" });
    } finally {
      this.saveSession(session);
      this.bus.push({ kind: "jobs" });
    }
  }

  /** Reads the rows you added to the Jobs tab, gives each a Job ID and reads its job description from the Apply Link. */
  startSync(): { sessionId: string } {
    if (this.operation) throw new AgentError("VALIDATION_FAILED", `the agent is busy (${this.operation}); wait for it to finish or stop it`);
    const session = this.newSession("SHEET_SYNC", null, true);
    this.operation = "sync";
    this.stopRequested = false;
    this.currentSession = session;
    this.worker = this.runSync(session).finally(() => {
      this.operation = null;
      this.currentSession = null;
      this.stopRequested = false;
      this.setPhase("IDLE", "Agent idle");
    });
    return { sessionId: session.sessionId };
  }

  private async runSync(session: AgentSession): Promise<void> {
    this.setPhase("SYNCING", "Reading new jobs from your sheet…");
    try {
      const r = await this.withDb("sync", async (store, runId) => {
        session.runId = runId;
        return syncSheet(this.sheetDeps(store, runId), (msg) => this.setPhase("SYNCING", msg));
      });
      session.sync = { imported: r.imported.length, alreadyKnown: r.alreadyKnown.length, skippedRows: r.skipped.length, ready: r.ready.length, failed: r.failed.length };
      Object.assign(session, { status: "COMPLETED", endedAt: new Date().toISOString(), errors: r.failed.map((f) => `${f.jobId}: ${f.reason}`) });
      for (const sk of r.skipped) this.bus.emit({ type: "SHEET_ROW_SKIPPED", category: "jobs", level: "warn", message: `Sheet row ${sk.row} skipped: ${sk.reason}` });
      for (const f of r.failed) this.bus.emit({ type: "JD_FAILED", category: "errors", level: "error", message: `${f.jobId}: ${f.reason}`, jobId: f.jobId });
      const msg = `${r.imported.length} new job(s) from the sheet · ${r.ready.length} ready to apply${r.failed.length ? ` · ${r.failed.length} job description(s) could not be read` : ""}${r.alreadyKnown.length ? ` · ${r.alreadyKnown.length} row(s) duplicate an existing job` : ""}`;
      this.bus.emit({ type: "SHEET_SYNCED", category: "jobs", level: r.failed.length ? "warn" : "success", message: msg });
      this.notify({ title: "Sheet synced", body: msg, level: r.failed.length ? "warn" : "success", link: "#/jobs" });
    } catch (err) {
      const msg = errorMessage(err);
      Object.assign(session, { status: "FAILED", endedAt: new Date().toISOString(), errors: [...session.errors, msg] });
      this.bus.emit({ type: "SYNC_FAILED", category: "errors", level: "error", message: `Sheet sync failed: ${msg}` });
      this.notify({ title: "Sheet sync failed", body: msg, level: "error", link: "#/jobs" });
    } finally {
      this.saveSession(session);
      this.bus.push({ kind: "jobs" });
    }
  }

  // ---------------------------------------------------------------- auto apply

  private cfg(): AppConfig {
    return this.opts.hooks?.adjustConfig ? this.opts.hooks.adjustConfig(this.base.cfg) : this.base.cfg;
  }

  todayLiveSubmissions(): number {
    const today = new Date().toISOString().slice(0, 10);
    return (this.store?.t.applications.all() ?? []).filter((a) => a.mode !== "MANUAL" && (a.submittedAt ?? "").startsWith(today) && (a.status === "APPLIED" || a.status === "SUBMISSION_UNVERIFIED")).length;
  }

  /**
   * Queues jobs and starts the worker. Dry run unless live is requested, armed and confirmed.
   * While a run is active, more jobs can be added only in the same mode.
   */
  async autoApply(req: AutoApplyRequest): Promise<{ added: QueueItem[]; skipped: Array<{ jobId: string; reason: string }>; sessionId: string | null; live: boolean }> {
    if (this.operation === "sync" || this.operation === "find") throw new AgentError("VALIDATION_FAILED", `${this.operation === "find" ? "the job search" : "the sheet sync"} is running; start applying when it finishes`);
    // Idle: re-read the database first, so jobs added or changed elsewhere (CLI, the sheet itself) are seen.
    if (!this.operation) await this.connect();
    const store = this.requireStore();
    if (req.live) {
      if (!this.liveArmed) throw new AgentError("VALIDATION_FAILED", "Live mode is not armed. Arm it in Settings → Application safety first.");
      if (req.confirm !== "LIVE") throw new AgentError("VALIDATION_FAILED", "type LIVE to confirm that real applications may be submitted");
    }
    const mode: ApplicationMode = !req.live ? "AUTO_FILL_REVIEW_SUBMIT" : req.requireReview ? "AUTO_FILL_REVIEW_SUBMIT" : "FULL_AUTO";
    if (this.operation === "auto-apply" && this.runOpts && (this.runOpts.live !== req.live || this.runOpts.mode !== mode)) {
      throw new AgentError("VALIDATION_FAILED", `the agent is already running a ${this.runOpts.live ? "LIVE" : "dry"} run; add jobs in the same mode or stop it first`);
    }
    const repo = new JobRepo(store);
    let jobs: JobRecord[] = [];
    if (req.scope === "pending") jobs = repo.all().filter((j) => PENDING.includes(j.status));
    else if (req.scope === "matched") jobs = repo.all().filter((j) => j.status === "MATCHED").sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
    else if (req.scope === "selected") jobs = (req.jobIds ?? []).map((id) => repo.get(id)).filter((j): j is JobRecord => !!j);
    if (req.scope !== "queued" && !jobs.length) throw new AgentError("VALIDATION_FAILED", req.scope === "pending" ? "no jobs are in To apply (those come from rows you add to the sheet) — to apply to jobs Find jobs found, choose 'Every good-fit job' or select jobs" : req.scope === "matched" ? "no good-fit jobs are waiting — click Find jobs first" : "select at least one job");
    if (req.scope === "queued" && !this.queue.pending()) throw new AgentError("VALIDATION_FAILED", "the queue is empty");
    const { added, skipped } = this.queue.enqueue(jobs.map((j) => ({ jobId: j.jobId, company: j.companyName, role: j.jobTitle })), req.priority ?? 0);
    for (const id of req.jobIds ?? []) if (!repo.get(id)) skipped.push({ jobId: id, reason: "job not found" });
    this.bus.push({ kind: "queue" });
    if (this.operation !== "auto-apply" && !this.queue.pending()) return { added, skipped, sessionId: null, live: req.live };
    if (this.operation === "auto-apply" && this.currentSession) {
      this.currentSession.jobsQueued += added.length;
      this.saveSession(this.currentSession);
      return { added, skipped, sessionId: this.currentSession.sessionId, live: req.live };
    }
    this.runOpts = {
      live: req.live,
      mode,
      requireReview: req.requireReview || !req.live,
      pauseForQuestions: req.pauseForQuestions,
      pauseForHuman: req.pauseForHuman,
      max: Math.min(req.maxApplications ?? this.settings.maxApplicationsPerRun, this.settings.maxApplicationsPerRun),
      delayMs: Math.round((req.delaySeconds ?? this.settings.delayBetweenApplicationsSec) * 1000),
      allowed: (req.allowedCompanies ?? []).map(normalizeCompany).filter(Boolean),
      blocked: (req.blockedCompanies ?? []).map(normalizeCompany).filter(Boolean),
    };
    const session = this.newSession("AUTO_APPLY", mode, !req.live);
    session.jobsQueued = this.queue.pending();
    this.saveSession(session);
    this.currentSession = session;
    this.operation = "auto-apply";
    this.stopRequested = false;
    this.paused = false;
    this.bus.emit({ type: "QUEUE_STARTED", category: "applications", level: req.live ? "warn" : "info", message: `${req.live ? "LIVE" : "Dry-run"} auto apply started: ${session.jobsQueued} job(s) queued${req.live ? (req.requireReview ? ", you approve each submission" : ", submitting automatically when every answer is verified") : ", nothing will be submitted"}` });
    this.notify({ title: "Auto Apply started", body: `${session.jobsQueued} job(s) · ${req.live ? "LIVE" : "dry run"}`, level: req.live ? "warn" : "info", link: "#/agent" });
    this.worker = this.runQueue(session).finally(() => {
      this.operation = null;
      this.currentSession = null;
      this.runOpts = null;
      this.current = null;
      this.page = null;
      this.stopRequested = false;
      this.paused = false;
      this.setPhase("IDLE", "Agent idle");
      this.bus.push({ kind: "queue" });
    });
    return { added, skipped, sessionId: session.sessionId, live: req.live };
  }

  /** For tests: resolves when the current worker finishes. */
  async idle(): Promise<void> {
    await this.worker;
  }

  private async runQueue(session: AgentSession): Promise<void> {
    const ro = this.runOpts;
    if (!ro) return;
    try {
      await this.withDb("apply", async (store, runId) => {
        session.runId = runId;
        let processed = 0;
        for (;;) {
          if (this.stopRequested) break;
          await this.waitWhilePaused();
          if (this.stopRequested) break;
          const item = this.queue.next();
          if (!item) break;
          if (processed >= ro.max) {
            session.note = `stopped after ${ro.max} applications (max per run); ${this.queue.pending()} still queued`;
            break;
          }
          if (ro.live && this.todayLiveSubmissions() >= this.settings.dailyLiveLimit) {
            session.note = `daily live limit reached (${this.settings.dailyLiveLimit}); ${this.queue.pending()} still queued`;
            this.notify({ title: "Daily limit reached", body: session.note, level: "warn", link: "#/settings" });
            break;
          }
          if (processed > 0 && ro.delayMs > 0) {
            this.setPhase("PREPARING", `Waiting ${Math.round(ro.delayMs / 1000)}s before the next application`);
            await this.sleep(ro.delayMs);
            if (this.stopRequested) break;
          }
          await this.processItem(store, item, session, runId, ro);
          processed++;
          session.jobsProcessed = processed;
          this.saveSession(session);
          await store.flush().catch((e: unknown) => session.errors.push(`save failed: ${errorMessage(e)}`));
          this.bus.push({ kind: "applications" });
          this.bus.push({ kind: "jobs" });
        }
      });
      session.status = this.stopRequested ? "STOPPED" : "COMPLETED";
    } catch (err) {
      session.status = "FAILED";
      session.errors.push(errorMessage(err));
      this.bus.emit({ type: "RUN_FAILED", category: "errors", level: "error", message: `Auto apply stopped: ${errorMessage(err)}` });
    } finally {
      session.endedAt = new Date().toISOString();
      this.saveSession(session);
      this.bus.emit({ type: "RUN_COMPLETE", category: "applications", level: session.status === "FAILED" ? "error" : "success", message: `Run ${session.status.toLowerCase()}: ${session.jobsProcessed} processed · ${session.confirmed} confirmed · ${session.submitted} submitted (unverified) · ${session.dryRunValidated} dry-run validated · ${session.needsReview} need you · ${session.skipped} skipped`, data: { sessionId: session.sessionId } });
      this.notify({ title: "Run complete", body: `${session.jobsProcessed} processed · ${session.confirmed} confirmed · ${session.needsReview} need you`, level: session.status === "FAILED" ? "error" : "success", link: "#/agent" });
    }
  }

  private finishItem(item: QueueItem, session: AgentSession, status: "DONE" | "HUMAN_REQUIRED" | "FAILED" | "SKIPPED", outcome: QueueOutcome, reason: string | null): void {
    this.queue.finish(item.id, status, outcome, reason);
    if (outcome === "CONFIRMED") session.confirmed++;
    else if (outcome === "SUBMITTED_UNVERIFIED") {
      session.submitted++;
      session.needsReview++;
    } else if (outcome === "DRY_RUN_VALIDATED") session.dryRunValidated++;
    else if (outcome === "NEEDS_ATTENTION") session.needsReview++;
    else if (outcome === "DUPLICATE") {
      session.alreadyApplied++;
      session.skipped++;
    } else if (outcome === "SKIPPED" || outcome === "NOT_ELIGIBLE" || outcome === "CANCELLED") session.skipped++;
    else if (outcome === "FAILED") session.failed++;
    this.bus.push({ kind: "queue" });
  }

  /** Duplicate protection and readiness. Returns null when the job can be applied to now. */
  private async prepare(store: Store, job: JobRecord, runId: string, ro: RunOpts): Promise<{ status: "SKIPPED" | "FAILED"; outcome: QueueOutcome; reason: string } | null> {
    if (job.status === "APPLIED") return { status: "SKIPPED", outcome: "DUPLICATE", reason: "already applied (verified)" };
    if (job.status === "SUBMISSION_UNVERIFIED" || job.status === "SUBMITTING") return { status: "SKIPPED", outcome: "DUPLICATE", reason: "a previous attempt may already have been submitted — check it and mark it applied, or retry it deliberately from its application page" };
    const twin = store.t.jobs.all().find((o) => o.jobId !== job.jobId && ["APPLIED", "SUBMISSION_UNVERIFIED"].includes(o.status) && (o.applyUrl === job.applyUrl || (normalizeCompany(o.companyName) === normalizeCompany(job.companyName) && o.jobTitle.trim().toLowerCase() === job.jobTitle.trim().toLowerCase() && o.location.trim().toLowerCase() === job.location.trim().toLowerCase())));
    if (twin) return { status: "SKIPPED", outcome: "DUPLICATE", reason: `same posting already applied to as ${twin.jobId}` };
    const company = normalizeCompany(job.companyName);
    if (ro.blocked.includes(company)) return { status: "SKIPPED", outcome: "SKIPPED", reason: "company is on this run's blocked list" };
    if (ro.allowed.length && !ro.allowed.includes(company)) return { status: "SKIPPED", outcome: "SKIPPED", reason: "company is not on this run's allowed list" };
    if (["APPLYING", "FORM_DETECTED", "FORM_FILLED"].includes(job.status)) return { status: "FAILED", outcome: "FAILED", reason: `an earlier attempt stopped mid-application (${job.status}); check it before retrying` };
    let status: JobStatus = job.status;
    // A job whose JD was never read (a new sheet row, or a failed read) starts from the JD step.
    if (status === "FAILED" && !job.jdText) status = transitionTo(store, job.jobId, "NORMALIZED", "retrying the job description");
    if (PRE_RESUME.includes(status)) {
      this.setPhase("PREPARING", `Reading the job description for ${job.companyName}`);
      status = await readyJob(this.sheetDeps(store, runId), job.jobId);
      if (status !== "READY_FOR_RESUME") return { status: "FAILED", outcome: "FAILED", reason: new JobRepo(store).get(job.jobId)?.lastError ?? `job is ${status}` };
    }
    if (["NEEDS_HUMAN", "FAILED", "BLOCKED", "VALIDATION_FAILED"].includes(status)) status = requeueJob(store, job.jobId, "retried from ApplyPilot").to;
    if (status === "READY_FOR_RESUME") {
      this.setPhase("PREPARING", `Preparing a tailored resume for ${job.companyName}`);
      const deps: ResumeDeps = { cfg: this.cfg(), store, logger: this.logger, profile: this.profile, compilers: this.base.compilers, ai: this.base.ai, runId };
      try {
        if (this.opts.hooks?.prepareResume) await this.opts.hooks.prepareResume(deps, job.jobId);
        else if (!this.settings.useUploadedResume) await generateResume(deps, job.jobId);
      } catch (err) {
        return { status: "FAILED", outcome: "FAILED", reason: `resume preparation failed: ${errorMessage(err)}` };
      }
      const after = new JobRepo(store).get(job.jobId);
      if (after?.status !== "READY_TO_APPLY") return { status: "FAILED", outcome: "FAILED", reason: `resume not ready (${after?.status ?? "?"}: ${after?.blockReason ?? after?.lastError ?? "see the job"})` };
      status = after.status;
    }
    if (status !== "READY_TO_APPLY") return { status: "SKIPPED", outcome: "SKIPPED", reason: `job is ${status}; nothing to apply to yet` };
    return null;
  }

  private async processItem(store: Store, item: QueueItem, session: AgentSession, runId: string, ro: RunOpts): Promise<void> {
    this.queue.start(item.id, session.sessionId);
    this.skipCurrent = false;
    this.current = { itemId: item.id, jobId: item.jobId, company: item.company, role: item.role };
    this.bus.push({ kind: "queue" });
    const job = new JobRepo(store).get(item.jobId);
    if (!job) {
      this.finishItem(item, session, "FAILED", "FAILED", "job not found in the database");
      return;
    }
    this.setPhase("PREPARING", `Preparing ${job.companyName} — ${job.jobTitle}`);
    this.bus.emit({ type: "APPLICATION_STARTED", category: "applications", message: `${ro.live ? "Applying to" : "Dry run:"} ${job.companyName} — ${job.jobTitle}`, jobId: job.jobId });
    const blocked = await this.prepare(store, job, runId, ro);
    if (blocked) {
      this.finishItem(item, session, blocked.status, blocked.outcome, blocked.reason);
      this.bus.emit({ type: blocked.outcome === "DUPLICATE" ? "DUPLICATE_APPLICATION" : "APPLICATION_SKIPPED", category: blocked.status === "FAILED" ? "errors" : "applications", level: blocked.status === "FAILED" ? "error" : "warn", message: `${job.companyName}: ${blocked.reason}`, jobId: job.jobId });
      this.current = null;
      return;
    }
    const base = this.cfg();
    const cfg: AppConfig = { ...base, dryRun: !ro.live, application: { ...base.application, mode: ro.mode, humanWait: { ...base.application.humanWait, enabled: ro.pauseForHuman && base.application.humanWait.enabled } } };
    const deps: ApplicationDeps = {
      cfg,
      store,
      logger: this.logger,
      profile: this.profile,
      browser: this.base.browser,
      questions: this.questions,
      runId,
      approve: ro.requireReview ? (summary) => this.requestReview(store, job, summary, session) : undefined,
      human: this.bridge(job, item, session, ro),
      resumeOverride: this.settings.useUploadedResume ? this.primaryResumePath() : null,
    };
    let result: ApplicationResult;
    try {
      result = await (this.opts.hooks?.apply ?? processApplication)(deps, job.jobId);
    } catch (err) {
      const msg = errorMessage(err);
      this.finishItem(item, session, "FAILED", "FAILED", msg);
      session.errors.push(`${job.jobId}: ${msg}`);
      this.bus.emit({ type: "APPLICATION_FAILED", category: "errors", level: "error", message: `${job.companyName}: ${msg}`, jobId: job.jobId });
      this.current = null;
      return;
    } finally {
      this.page = null;
    }
    this.handleResult(store, item, session, job, result);
    this.current = null;
  }

  private handleResult(store: Store, item: QueueItem, session: AgentSession, job: JobRecord, result: ApplicationResult): void {
    const who = `${job.companyName} — ${job.jobTitle}`;
    if (result.status === "APPLIED") {
      this.finishItem(item, session, "DONE", "CONFIRMED", null);
      this.bus.emit({ type: "CONFIRMATION_DETECTED", category: "applications", level: "success", message: `Application confirmed: ${who} (${result.evidence.signals.join("; ")})`, jobId: job.jobId });
      this.notify({ title: "Application confirmed", body: who, level: "success", link: `#/jobs/${job.jobId}` });
      return;
    }
    if (result.status === "SUBMISSION_UNVERIFIED") {
      this.finishItem(item, session, "HUMAN_REQUIRED", "SUBMITTED_UNVERIFIED", "submitted, but no confirmation was found");
      const task = this.tasks.create({ type: "OTHER", title: "Check whether this application went through", why: "The agent clicked Submit, but the site showed no confirmation. It never reports an application as confirmed without evidence.", whatToDo: "Check your email or the company's portal. If it went through, mark it applied with the evidence. It is never retried automatically.", whatNext: "Marking it applied records your evidence; the job will not be applied to again.", jobId: job.jobId, applicationId: `APP-${job.jobId}`, company: job.companyName, role: job.jobTitle, blocking: false, payload: { screenshot: result.screenshot, signals: result.evidence.signals } });
      this.queue.setHumanTask(item.id, task.id);
      this.bus.emit({ type: "APPLICATION_SUBMITTED", category: "applications", level: "warn", message: `Submitted ${who}, but no confirmation was found — check it`, jobId: job.jobId });
      this.notify({ title: "Submitted — confirmation not found", body: who, level: "warn", link: "#/needs-you" });
      return;
    }
    if (result.status === "READY_TO_APPLY") {
      this.finishItem(item, session, "DONE", "DRY_RUN_VALIDATED", "dry run: filled and validated, not submitted");
      this.bus.emit({ type: "DRY_RUN_VALIDATED", category: "applications", level: "success", message: `Dry run complete: ${who} — form filled and validated, nothing submitted`, jobId: job.jobId });
      return;
    }
    const reason = result.reason;
    if (/^stopped by you|skipped by you|: skipped by you/.test(reason) || this.skipCurrent) {
      this.finishItem(item, session, "SKIPPED", "SKIPPED", reason);
      this.bus.emit({ type: "APPLICATION_SKIPPED", category: "applications", level: "warn", message: `${who}: ${reason}`, jobId: job.jobId });
      return;
    }
    if (result.status === "NEEDS_HUMAN") {
      this.finishItem(item, session, "HUMAN_REQUIRED", "NEEDS_ATTENTION", reason);
      const payment = /PAYMENT_REQUESTED/.test(reason);
      const task = this.tasks.create({
        type: payment ? "OTHER" : "UNKNOWN_FORM",
        title: payment ? "The site asked for a payment — stopped" : "The agent stopped on this application",
        why: explainStop(reason),
        whatToDo: payment ? "Nothing was paid or entered. Decide yourself whether this employer is legitimate." : "Review the reason. Fix it (answer a question in the Answer Bank, finish a step on the site), then retry — or skip the job.",
        whatNext: "Retry puts the job back in the queue; the agent starts that application again from the beginning.",
        jobId: job.jobId,
        applicationId: `APP-${job.jobId}`,
        company: job.companyName,
        role: job.jobTitle,
        blocking: false,
        payload: { reason, screenshot: result.screenshot, gate: result.gate ?? null },
      });
      this.queue.setHumanTask(item.id, task.id);
      this.bus.emit({ type: "APPLICATION_NEEDS_HUMAN", category: "human", level: "warn", message: `${who}: ${reason.slice(0, 300)}`, jobId: job.jobId });
      this.notify({ title: "Human action required", body: `${who}: ${reason.slice(0, 160)}`, level: "warn", link: "#/needs-you" });
      return;
    }
    this.finishItem(item, session, "FAILED", "FAILED", reason);
    session.errors.push(`${job.jobId}: ${reason}`);
    this.bus.emit({ type: "APPLICATION_FAILED", category: "errors", level: "error", message: `${who}: ${reason}`, jobId: job.jobId });
  }

  private async requestReview(store: Store, job: JobRecord, summary: string, session: AgentSession): Promise<boolean> {
    const form = store.t.applications.get(job.jobId)?.form as { report?: { fields?: unknown[]; finalSubmit?: string | null } } | null;
    const task = this.tasks.create({
      type: "REVIEW_SUBMIT",
      title: "Review before submitting",
      why: "You asked to approve every submission. The form is filled and validated.",
      whatToDo: "Check the answers (and the browser window if you like). Submit, or cancel this application.",
      whatNext: "Submit: the agent clicks the site's submit button, waits for any verification you need to complete, and looks for a confirmation. Cancel: nothing is sent.",
      jobId: job.jobId,
      applicationId: `APP-${job.jobId}`,
      company: job.companyName,
      role: job.jobTitle,
      blocking: true,
      payload: { summary, fields: form?.report?.fields ?? [], finalSubmit: form?.report?.finalSubmit ?? null, resume: this.settings.useUploadedResume ? this.settings.primaryResumeId : job.resumeVersionId },
    });
    session.humanInterventions++;
    this.setPhase("WAITING_REVIEW", `Waiting for your approval to submit ${job.companyName}`);
    this.notify({ title: "Ready to submit — your approval needed", body: `${job.companyName} — ${job.jobTitle}`, level: "warn", link: "#/needs-you" });
    this.bringBrowserToFront();
    const r = await this.tasks.next(task.id);
    const ok = r.action === "approve" && !this.stopRequested && !this.skipCurrent;
    this.tasks.close(task.id, ok ? "RESOLVED" : "SKIPPED", ok ? "approved" : "cancelled");
    this.bus.emit({ type: ok ? "SUBMIT_APPROVED" : "SUBMIT_CANCELLED", category: "human", level: ok ? "success" : "warn", message: ok ? `You approved submitting ${job.companyName}` : `Submission cancelled for ${job.companyName}`, jobId: job.jobId });
    if (ok) this.setPhase("SUBMITTING", `Submitting ${job.companyName}`);
    return ok;
  }

  private bridge(job: JobRecord, item: QueueItem, session: AgentSession, ro: RunOpts): HumanBridge {
    let handoff: HumanTask | null = null;
    const base = { jobId: job.jobId, applicationId: `APP-${job.jobId}`, company: job.companyName, role: job.jobTitle };
    const b: HumanBridge = {
      pageOpened: (p) => {
        this.page = p;
        this.setPhase("OPENING", `Opening ${job.companyName}'s application page`);
      },
      event: (type, detail) => {
        const phaseFor: Record<string, AgentPhase> = { FORM_DETECTED: "FILLING", FIELDS_FILLED: "FILLING", APPLICATION_SUBMITTED: "VERIFYING" };
        const text: Record<string, string> = {
          FORM_DETECTED: `Detected the application form (${String(detail.fields)} fields)`,
          FIELDS_FILLED: `${String(detail.filled)} fields completed${Number(detail.failed) ? `, ${String(detail.failed)} could not be verified` : ""}`,
          QUESTION_REQUIRED: `${String(detail.count)} new required question(s) — waiting for your answer`,
          HUMAN_RESPONSE_RECEIVED: `Using your ${String(detail.answered)} answer(s); re-checking the form`,
          APPLICATION_SUBMITTED: "Submit clicked — verifying the result",
          CONFIRMATION_DETECTED: "Confirmation detected",
          HANDOFF_STILL_BLOCKED: "The verification is still showing — complete it in the browser, then click Continue",
        };
        const ph = phaseFor[type];
        if (ph) this.setPhase(ph, text[type] ?? type);
        this.bus.emit({ type, category: type.startsWith("QUESTION") || type.startsWith("HUMAN") || type.startsWith("HANDOFF") ? "human" : "applications", level: type === "HANDOFF_STILL_BLOCKED" ? "warn" : "info", message: `${job.companyName}: ${text[type] ?? type}`, jobId: job.jobId });
      },
      checkpoint: async (stage) => {
        await this.waitWhilePaused();
        if (this.stopRequested || this.skipCurrent) return "stop";
        this.setPhase(stage === "before-submit" ? "SUBMITTING" : "FILLING", stage === "before-submit" ? `Submitting ${job.companyName}` : `Filling ${job.companyName}'s form`);
        return "go";
      },
      handoffStarted: (h) => {
        const type: HumanTaskType = h.kind === "CAPTCHA" ? "CAPTCHA" : h.kind === "OTP" ? "VERIFICATION_CODE" : h.kind === "LOGIN" ? "LOGIN" : "SECURITY_CHECK";
        handoff = this.tasks.create({
          ...base,
          type,
          blocking: true,
          title: type === "CAPTCHA" ? "Human verification required" : type === "LOGIN" ? "Sign-in required" : type === "VERIFICATION_CODE" ? "Verification code required" : "Security check required",
          why: `${job.companyName}'s site is asking for a verification step (${h.what}). The agent never solves or bypasses these.`,
          whatToDo: "Open the browser window, complete the step yourself, then click Continue.",
          whatNext: "The agent re-checks the page. When the step is gone it continues this same application from where it is.",
          payload: { url: h.url, what: h.what },
        });
        this.queue.setHumanTask(item.id, handoff.id);
        session.humanInterventions++;
        this.saveSession(session);
        this.setPhase(type === "CAPTCHA" ? "WAITING_CAPTCHA" : "WAITING_HUMAN", `Waiting for you: ${h.what}`);
        this.bus.emit({ type: type === "CAPTCHA" ? "CAPTCHA_REQUIRED" : "HUMAN_REQUIRED", category: "human", level: "warn", message: `${job.companyName}: ${h.what} — waiting for you`, jobId: job.jobId });
        this.notify({ title: type === "CAPTCHA" ? "CAPTCHA requires attention" : "Human action required", body: `${job.companyName}: ${h.what}`, level: "warn", link: "#/needs-you" });
        this.bringBrowserToFront();
      },
      handoffSignal: () => {
        const t = handoff;
        if (!t) return new Promise(() => undefined);
        return this.tasks.next(t.id).then((r) => (r.action === "continue" ? "continue" : "skip"));
      },
      handoffEnded: (outcome) => {
        if (handoff) this.tasks.close(handoff.id, outcome === "cleared" ? "RESOLVED" : outcome === "skipped" ? "SKIPPED" : "EXPIRED", outcome);
        this.queue.setHumanTask(item.id, null);
        this.bus.emit({ type: outcome === "cleared" ? "HUMAN_RESPONSE_RECEIVED" : "HANDOFF_ENDED", category: "human", level: outcome === "cleared" ? "success" : "warn", message: `${job.companyName}: verification ${outcome === "cleared" ? "completed — continuing" : outcome}`, jobId: job.jobId });
        handoff = null;
        if (outcome === "cleared") this.setPhase("FILLING", `Continuing ${job.companyName}`);
      },
    };
    if (ro.pauseForQuestions) b.ask = (questions) => this.askQuestions(job, item, session, questions);
    return b;
  }

  private async askQuestions(job: JobRecord, item: QueueItem, session: AgentSession, questions: PendingQuestion[]): Promise<QuestionAnswer[] | "skip"> {
    const withSuggestions = questions.map((q) => ({ ...q, suggestions: [], sources: [] }));
    const task = this.tasks.create({
      type: "NEW_QUESTION",
      title: questions.length === 1 ? "New question" : `${questions.length} new questions`,
      why: "This form asks something the agent has no trusted answer for. It never guesses an answer.",
      whatToDo: "Answer each question. Tick 'Remember' to save an answer to your Answer Bank, or use it for this application only.",
      whatNext: "The agent fills your answers, re-checks the form and continues this same application.",
      jobId: job.jobId,
      applicationId: `APP-${job.jobId}`,
      company: job.companyName,
      role: job.jobTitle,
      blocking: true,
      payload: { questions: withSuggestions },
    });
    this.queue.setHumanTask(item.id, task.id);
    session.humanInterventions++;
    this.saveSession(session);
    this.setPhase("WAITING_HUMAN", `Waiting for your answer (${questions.length} question${questions.length > 1 ? "s" : ""})`);
    this.notify({ title: "Human answer required", body: `${job.companyName}: ${questions.map((q) => q.label).join(" · ").slice(0, 160)}`, level: "warn", link: "#/needs-you" });
    const r = await this.tasks.next(task.id);
    this.queue.setHumanTask(item.id, null);
    if (r.action !== "answer" || !r.answers || this.stopRequested || this.skipCurrent) {
      this.tasks.close(task.id, "SKIPPED", "skipped");
      return "skip";
    }
    const given = r.answers.filter((a) => a.answer.trim() && questions.some((q) => q.label === a.label));
    let learned = 0;
    for (const a of given.filter((x) => x.remember)) {
      try {
        this.answers.upsert(a.label, a.answer);
        learned++;
      } catch (err) {
        this.bus.emit({ type: "ANSWER_SAVE_FAILED", category: "errors", level: "error", message: `Could not save '${a.label}': ${errorMessage(err)}` });
      }
    }
    if (learned) {
      this.reloadKnowledge();
      session.answersLearned += learned;
      this.saveSession(session);
      this.bus.emit({ type: "ANSWER_LEARNED", category: "questions", level: "success", message: `Saved ${learned} answer(s) to your Answer Bank`, jobId: job.jobId });
    }
    // Answers are kept locally with the task (not in the activity stream, which never shows answer values).
    this.tasks.close(task.id, "RESOLVED", given.map((a) => ({ label: a.label, remember: a.remember, answer: a.answer })));
    return given;
  }

  // ---------------------------------------------------------------- task actions from the UI

  actOnTask(id: string, action: "continue" | "skip" | "approve" | "reject" | "answer" | "dismiss", answers?: QuestionAnswer[]): { delivered: boolean } {
    const task = this.tasks.get(id);
    if (!task) throw new AgentError("NOT_FOUND", `task ${id} not found`);
    if (task.status !== "PENDING") throw new AgentError("VALIDATION_FAILED", `this task is already ${task.status.toLowerCase()}`);
    if (!task.blocking) {
      if (action !== "dismiss" && action !== "skip") throw new AgentError("VALIDATION_FAILED", "the agent is no longer waiting on this task; use Retry or Dismiss");
      this.tasks.close(id, action === "skip" ? "SKIPPED" : "RESOLVED", action);
      return { delivered: true };
    }
    const allowed: Record<string, string[]> = { NEW_QUESTION: ["answer", "skip"], REVIEW_SUBMIT: ["approve", "reject"] };
    const ok = allowed[task.type] ?? ["continue", "skip"];
    if (!ok.includes(action)) throw new AgentError("VALIDATION_FAILED", `'${action}' is not an action for a ${task.type} task`);
    if (action === "answer" && !answers?.length) throw new AgentError("VALIDATION_FAILED", "provide at least one answer");
    const delivered = this.tasks.signal(id, answers ? { action, answers } : { action });
    if (!delivered) this.tasks.close(id, "EXPIRED", "the agent was no longer waiting");
    return { delivered };
  }

  async retryJob(jobId: string): Promise<void> {
    const store = this.requireStore();
    if (this.current?.jobId === jobId) throw new AgentError("VALIDATION_FAILED", "this job is being processed right now");
    const job = new JobRepo(store).get(jobId);
    if (!job) throw new AgentError("NOT_FOUND", `job ${jobId} not found`);
    if (job.status === "SUBMISSION_UNVERIFIED") throw new AgentError("VALIDATION_FAILED", "this application may already have been submitted; check it and mark it applied instead of retrying");
    for (const t of this.tasks.list().filter((x) => x.jobId === jobId && !x.blocking)) this.tasks.close(t.id, "RESOLVED", "retried");
    const q = this.queue.list().find((i) => i.jobId === jobId && !["QUEUED", "RUNNING"].includes(i.status));
    if (q) this.queue.retry(q.id);
    else this.queue.enqueue([{ jobId, company: job.companyName, role: job.jobTitle }], 1);
    this.bus.push({ kind: "queue" });
  }

  async withStore<T>(fn: (store: Store) => T | Promise<T>): Promise<T> {
    if (this.operation) {
      // While a run holds the lock the store is live in this process: change it in place; the run flushes it.
      return fn(this.requireStore());
    }
    return this.withDb("ui", async (store) => fn(store));
  }

  async shutdown(): Promise<void> {
    this.stopAll();
    await Promise.race([this.worker, new Promise((r) => setTimeout(r, 15_000))]);
    await this.base.close();
  }
}

/** Synced jobs not applied to yet ("Apply to all"). Old jobs that were never synced are left alone. */
export const PENDING: JobStatus[] = ["READY_FOR_RESUME", "RESUME_GENERATED", "READY_TO_APPLY", "NEEDS_HUMAN", "FAILED", "BLOCKED", "VALIDATION_FAILED"];

function transitionTo(store: Store, jobId: string, to: JobStatus, reason: string): JobStatus {
  transition(store, jobId, to, { reason });
  return to;
}

function summarize(r: unknown): unknown {
  const s = JSON.stringify(r ?? null);
  return s.length <= 8000 ? r : { truncated: true, preview: s.slice(0, 2000) };
}

/** "Why did the agent stop?" in plain words, from the engine's reason text. */
export function explainStop(reason: string): string {
  if (/PAYMENT_REQUESTED/.test(reason)) return "The site asked for a payment. ApplyPilot stops immediately on any payment request and never enters payment details.";
  if (/no question-bank match|no verified answer|without an explicit verified answer|matches none of/.test(reason)) return `A required question has no trusted answer, and the agent never guesses one. Details: ${reason}`;
  if (/CAPTCHA|verification|OTP|security/i.test(reason)) return `A verification step was not completed. Details: ${reason}`;
  if (/login/i.test(reason)) return `The site requires signing in. Details: ${reason}`;
  if (/no application form found|unsupported flow/.test(reason)) return `The agent could not find a supported application form on the page (unexpected form). Details: ${reason}`;
  if (/could not be verified/.test(reason)) return `A value was typed but the site did not keep it, so the agent stopped rather than submit a wrong answer. Details: ${reason}`;
  if (/submission rejected/.test(reason)) return `The site rejected the submission. Details: ${reason}`;
  return reason;
}
