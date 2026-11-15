import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import type { AppConfig } from "../core/config.ts";
import type { Logger } from "../core/logger.ts";
import { fromRoot, paths } from "../core/paths.ts";
import type { JobRecord } from "../core/schemas.ts";
import { normalizeCompany, normalizeText, todayIso, tokenSet } from "../core/text.ts";
import { AgentError, toAgentError } from "../core/errors.ts";
import { newId, type ApplicationRow, type Store } from "../store/sheetStore.ts";
import { JobRepo, recordError } from "../store/repositories.ts";
import { recordTimeline, transition } from "../store/stateMachine.ts";
import type { Profile } from "../profile/profile.ts";
import type { QuestionRecord } from "../questions/questionBank.ts";
import type { BrowserProvider } from "../../integrations/playwright/PlaywrightBrowserProvider.ts";
import { classifyButton, findFinalSubmit, type ClassifiedButton } from "../validation/buttonClassifier.ts";
import { evaluateGate, type GateDecision } from "../validation/submissionGate.ts";
import { evaluateSubmissionEvidence, type SubmissionEvidence } from "../validation/submissionEvidence.ts";
import { planForm, type FieldPlan } from "./fieldClassifier.ts";
import type { PageSignals } from "./fieldTypes.ts";
import { googleSignIn } from "./googleSignIn.ts";
import type { HumanBridge, PendingQuestion } from "./humanBridge.ts";
import { isLinkedInJobPage, resolveLinkedInApply } from "./linkedinApply.ts";
import { humanAnswerRecords } from "../questions/questionBank.ts";
import { emptyRequiredFields, scanPage, selectApplicationForm, type PageScan } from "./formDetector.ts";
import { fillForm, type FillOutcome } from "./formFiller.ts";

export interface ApplicationDeps {
  cfg: AppConfig;
  store: Store;
  logger: Logger;
  profile: Profile;
  browser: BrowserProvider;
  questions: QuestionRecord[];
  runId: string | null;
  /** AUTO_FILL_REVIEW_SUBMIT: asked once the form is valid. Absent → treated as "not approved". */
  approve?: (summary: string) => Promise<boolean>;
  /** Tests only: what counts as Google's sign-in pages (default accounts.google.com). */
  googleUrl?: RegExp;
  /** Interactive controller (web app): hand-offs, new questions, pause/stop, live page, progress events. */
  human?: HumanBridge;
  /** Upload this PDF instead of the job's tailored resume (the user's chosen primary resume). */
  resumeOverride?: string | null;
}

export interface InspectionReport {
  url: string;
  applicationFormFound?: boolean;
  title: string;
  blockers: { captcha: string | null; otp: boolean; login: boolean };
  fields: Array<{ label: string; kind: string; required: boolean; classification: string; canonicalKey: string | null; action: string; trust: string; confidence: number; answerPreview: string | null; reason: string; source: string | null }>;
  buttons: Array<{ text: string; kind: string; confidence: number; reason: string }>;
  finalSubmit: string | null;
  jobConfirmed: boolean | null;
}

export type ApplicationResult =
  | { status: "APPLIED"; evidence: SubmissionEvidence; screenshot: string | null }
  | { status: "SUBMISSION_UNVERIFIED"; evidence: SubmissionEvidence; screenshot: string | null }
  | { status: "NEEDS_HUMAN" | "READY_TO_APPLY" | "FAILED" | "BLOCKED"; reason: string; screenshot: string | null; gate?: GateDecision };

function preview(p: FieldPlan): string | null {
  if (p.answer === null) return null;
  return p.classification === "SENSITIVE" || p.classification === "LEGAL_OR_ELIGIBILITY" ? "***" : p.answer.slice(0, 80);
}

async function screenshot(page: Page, jobId: string, stage: string): Promise<string | null> {
  try {
    const dir = path.join(paths.screenshots(), todayIso());
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${jobId}-${stage}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return path.relative(fromRoot(), file);
  } catch {
    return null;
  }
}

async function settle(page: Page, ms: number): Promise<void> {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: Math.max(ms, 1000) }).catch(() => undefined);
  await page.waitForTimeout(Math.min(ms, 1500));
}

/** The page must mention the job's company and most of its title before anything is filled or submitted. */
export function confirmJobOnPage(job: Pick<JobRecord, "companyName" | "jobTitle">, scan: Pick<PageScan, "signals">): boolean {
  const hay = normalizeText(`${scan.signals.title} ${scan.signals.bodyText}`);
  const title = [...tokenSet(job.jobTitle)].filter((t) => t.length > 2);
  const titleHits = title.filter((t) => hay.includes(t)).length;
  const company = normalizeCompany(job.companyName);
  const companyOk = company.length > 1 && hay.includes(company.split(" ")[0] ?? company);
  return companyOk && (title.length === 0 || titleHits / title.length >= 0.6);
}

function buildReport(scan: PageScan, plans: FieldPlan[], buttons: ClassifiedButton[], final: ClassifiedButton | null, jobConfirmed: boolean | null): InspectionReport {
  return {
    url: scan.signals.url,
    title: scan.signals.title,
    blockers: { captcha: scan.signals.captchaEvidence, otp: scan.signals.otpDetected, login: scan.signals.loginDetected },
    fields: plans.map((p) => ({ label: p.field.label, kind: p.field.kind, required: p.field.required, classification: p.classification, canonicalKey: p.canonicalKey, action: p.action, trust: p.trust, confidence: p.confidence, answerPreview: preview(p), reason: p.reason, source: p.source ?? null })),
    buttons: buttons.map((b) => ({ text: b.button.text, kind: b.kind, confidence: b.confidence, reason: b.reason })),
    finalSubmit: final?.button.text ?? null,
    jobConfirmed,
  };
}

function resumeFor(store: Store, job: JobRecord): string | null {
  if (!job.resumeVersionId) return null;
  const rv = store.t.resumes.get(job.resumeVersionId);
  if (rv?.status !== "GENERATED" || !rv.pdfPath) return null;
  const abs = fromRoot(rv.pdfPath);
  return fs.existsSync(abs) ? abs : null;
}

type Blocker = { kind: "PAYMENT" | "CAPTCHA" | "OTP" | "SECURITY" | "LOGIN"; what: string; evidence: string };

/** What stands between the agent and the form, most severe first. Payment outranks everything. */
export function blockerOf(s: PageSignals, includeLogin: boolean): Blocker | null {
  if (s.paymentDetected) return { kind: "PAYMENT", what: "payment requested", evidence: s.paymentEvidence ?? "" };
  if (s.captchaDetected) return { kind: "CAPTCHA", what: `CAPTCHA detected (${s.captchaEvidence ?? ""})`, evidence: s.captchaEvidence ?? "" };
  if (s.otpDetected) return { kind: "OTP", what: "OTP / verification code requested", evidence: "one-time code" };
  if (s.securityCheckDetected) return { kind: "SECURITY", what: "security / identity verification requested", evidence: "security check" };
  if (includeLogin && s.loginDetected) return { kind: "LOGIN", what: "login required", evidence: s.passwordFieldPresent ? "password field" : "login text" };
  return null;
}

/** ATS application forms that company career pages embed in an iframe. */
const ATS_EMBED = /greenhouse\.io\/embed\/job_app|jobs\.(eu\.)?lever\.co\/[^/]+\/[^/]+\/apply|jobs\.ashbyhq\.com\/[^/]+\/[^/]+\/application|apply\.workable\.com\//;

/**
 * Finds the application form on the current page. If the page only has non-application forms (or none),
 * opens at most one navigation — an embedded ATS form's own URL, else an "Apply" link — never a submission,
 * and scans again.
 */
export async function locateApplicationForm(page: Page, cfg: AppConfig): Promise<{ scan: PageScan; full: PageScan; isApplication: boolean; navigated: boolean }> {
  let full = await scanPage(page, cfg.safety);
  let sel = selectApplicationForm(full);
  let navigated = false;
  if (!sel.isApplication && !full.signals.captchaDetected) {
    // Company sites often embed the ATS form in an iframe (MongoDB, Okta: Greenhouse's #grnhse_iframe). Opening the
    // iframe's own URL is navigation, like following "Apply", and puts the real form in the top-level page.
    const src = await page
      .evaluate(`(() => { const f = [...document.querySelectorAll("iframe")].find((f) => f.id === "grnhse_iframe" || ${ATS_EMBED.toString()}.test(f.src || "")); return f ? f.src : null; })()`)
      .catch(() => null);
    const embed = typeof src === "string" && /^https?:|^file:/.test(src) ? src : null;
    const nav = full.buttons.filter((b) => b.visible).map(classifyButton).find((c) => c.kind === "NAVIGATION" && /\bapply\b/i.test(c.button.text));
    if (embed) {
      await page.goto(embed, { timeout: cfg.application.waitTimeouts.navigationMs, waitUntil: "domcontentloaded" });
    } else if (nav) {
      // Links often open in a new tab (target=_blank); navigating to the href keeps us on one page.
      if (nav.button.href && /^https?:|^file:/.test(nav.button.href)) await page.goto(nav.button.href, { timeout: cfg.application.waitTimeouts.navigationMs, waitUntil: "domcontentloaded" });
      else await page.locator(`[data-aja-id="${nav.button.key}"]`).first().click();
    }
    if (embed || nav) {
      await settle(page, cfg.application.waitTimeouts.stabilizeMs);
      full = await scanPage(page, cfg.safety);
      sel = selectApplicationForm(full);
      navigated = true;
    }
  }
  return { scan: sel.scan, full, isApplication: sel.isApplication, navigated };
}

/** Read-only inspection of any application URL: nothing is filled or submitted (at most one "Apply" navigation). */
export async function inspectApplication(deps: Pick<ApplicationDeps, "cfg" | "browser" | "questions" | "profile">, url: string, job?: JobRecord): Promise<InspectionReport> {
  const session = await deps.browser.open();
  try {
    await session.page.goto(url, { timeout: deps.cfg.application.waitTimeouts.navigationMs, waitUntil: "domcontentloaded" });
    await settle(session.page, deps.cfg.application.waitTimeouts.stabilizeMs);
    const { scan, isApplication } = await locateApplicationForm(session.page, deps.cfg);
    const plans = planForm(scan.fields, { safety: deps.cfg.safety, records: deps.questions, profile: deps.profile, allowAiSuggested: deps.cfg.application.allowAiSuggestedAnswers, resumeAvailable: true });
    const { candidate, all } = findFinalSubmit(scan.buttons);
    return { ...buildReport(scan, plans, all, candidate, job ? confirmJobOnPage(job, scan) : null), applicationFormFound: isApplication };
  } finally {
    await session.close();
  }
}

/** Starts a new attempt: creates the Applications row once per job and increments attempts once per attempt. */
function startAttempt(store: Store, job: JobRecord, mode: string): void {
  const now = new Date().toISOString();
  const cur = store.t.applications.get(job.jobId);
  if (cur) store.t.applications.update(job.jobId, { attempts: cur.attempts + 1, lastAttemptAt: now, mode, resumeVersionId: job.resumeVersionId, status: "APPLYING" });
  else
    store.t.applications.insert({
      jobId: job.jobId, applicationId: `APP-${job.jobId}`, resumeVersionId: job.resumeVersionId, mode, status: "APPLYING", attempts: 1, url: job.applyUrl,
      startedAt: now, lastAttemptAt: now, submittedAt: null, verifiedAt: null, blockReason: null, screenshotPath: null, evidence: null, form: null,
    });
}

function patchApplication(store: Store, jobId: string, patch: Partial<ApplicationRow>): void {
  store.t.applications.update(jobId, patch);
}

function recordAnswers(store: Store, jobId: string, runId: string | null, plans: FieldPlan[], fills: FillOutcome[]): void {
  const now = new Date().toISOString();
  for (const p of plans) {
    const fill = fills.find((f) => f.label === p.field.label && f.action === p.action);
    const action = p.action === "UPLOAD_RESUME" ? (fill?.ok ? "UPLOADED" : "UPLOAD_FAILED") : p.action === "FILL" ? (fill?.ok ? "FILLED" : "FILL_FAILED") : p.action;
    store.t.answers.insert({
      id: newId("ANS"), at: now, jobId, runId, fieldLabel: p.field.label, fieldKind: p.field.kind, classification: p.classification, canonicalKey: p.canonicalKey,
      answerPreview: preview(p), trust: p.trust, confidence: p.confidence, action,
    });
  }
}

/**
 * One application attempt. Transitions: READY_TO_APPLY → APPLYING → FORM_DETECTED → FORM_FILLED →
 * (SUBMITTING → APPLIED | SUBMISSION_UNVERIFIED) or NEEDS_HUMAN / READY_TO_APPLY (dry run) / FAILED.
 */
export async function processApplication(deps: ApplicationDeps, jobId: string, opts: { keepOpen?: boolean } = {}): Promise<ApplicationResult & { page?: Page }> {
  const { cfg, store, logger } = deps;
  const repo = new JobRepo(store);
  const job = repo.get(jobId);
  if (!job) throw new AgentError("NOT_FOUND", `job ${jobId} not found`);
  if (job.status !== "READY_TO_APPLY") throw new AgentError("INVALID_TRANSITION", `${jobId} is ${job.status}; only READY_TO_APPLY jobs can be applied to`);
  const already = store.t.applications.get(jobId);
  if (already?.status === "APPLIED") throw new AgentError("VALIDATION_FAILED", `${jobId} already has a verified application`);
  const mode = cfg.application.mode;
  const resumePdf = deps.resumeOverride && fs.existsSync(deps.resumeOverride) ? deps.resumeOverride : resumeFor(store, job);
  const human = deps.human;
  transition(store, jobId, "APPLYING", { runId: deps.runId, reason: `mode ${mode}${cfg.dryRun ? " (dry run)" : ""}`, patch: { applicationAttempts: job.applicationAttempts + 1, lastAttemptAt: new Date().toISOString() } });
  startAttempt(store, job, mode);
  recordTimeline(store, jobId, "APPLICATION_STARTED", { runId: deps.runId, detail: { url: job.applyUrl, mode, dryRun: cfg.dryRun } });

  const needsHuman = async (page: Page | null, reason: string, gate?: GateDecision): Promise<ApplicationResult> => {
    const shot = page ? await screenshot(page, jobId, "needs-human") : null;
    transition(store, jobId, "NEEDS_HUMAN", { runId: deps.runId, reason, patch: { requiresHuman: true, blockReason: reason.slice(0, 500) } });
    patchApplication(store, jobId, { status: "NEEDS_HUMAN", blockReason: reason.slice(0, 500), screenshotPath: shot });
    logger.warn({ module: "application", action: "needs_human", status: "blocked", jobId, message: reason });
    return gate ? { status: "NEEDS_HUMAN", reason, screenshot: shot, gate } : { status: "NEEDS_HUMAN", reason, screenshot: shot };
  };

  const canWait = cfg.application.humanWait.enabled && deps.browser.interactive;
  const googleAccount = cfg.env.GOOGLE_SIGNIN_ACCOUNT ?? deps.profile.personal.email ?? "";
  let googleTried = !googleAccount;

  /**
   * Payment → stop now (never waited out). CAPTCHA / OTP / security check / login → with a visible browser, wait
   * for the user to finish it and carry on from the page they leave us on; otherwise stop for a human.
   * Returns null when the page is clear, or the reason to stop.
   */
  const clearBlockers = async (page: Page, includeLogin: boolean): Promise<{ stop: string | null; waited: boolean }> => {
    let waited = false;
    for (let round = 0; round < 5; round++) {
      const s = (await scanPage(page, cfg.safety)).signals;
      const b = blockerOf(s, includeLogin && cfg.safety.requireHumanForLogin);
      if (!b) return { stop: null, waited };
      if (b.kind === "PAYMENT") {
        recordTimeline(store, jobId, "PAYMENT_REQUESTED", { runId: deps.runId, detail: { url: s.url, evidence: b.evidence } });
        return { stop: `PAYMENT_REQUESTED: ${b.evidence} at ${s.url} — stopped immediately; nothing was entered or authorized`, waited };
      }
      if (b.kind === "LOGIN" && !googleTried) {
        // Rule: prefer the site's own "Sign in with Google" with the account already signed in to this profile.
        googleTried = true;
        const g = await googleSignIn(page, {
          email: googleAccount,
          canWait,
          timeoutMs: cfg.application.humanWait.timeoutMs,
          pollMs: cfg.application.humanWait.pollMs,
          ...(deps.googleUrl ? { googleUrl: deps.googleUrl } : {}),
          notify: (message) => logger.warn({ module: "application", action: "google_signin", status: "blocked", jobId, message }),
        });
        if (g.status !== "NOT_AVAILABLE") {
          recordTimeline(store, jobId, "GOOGLE_SIGNIN_STARTED", { runId: deps.runId, detail: { account: googleAccount, steps: g.steps } });
          if (g.status === "NEEDS_USER") return { stop: `${g.reason} (steps so far: ${g.steps.join("; ")})`, waited };
          await settle(page, cfg.application.waitTimeouts.stabilizeMs);
          // Never assume it worked because a button was clicked: the site must stop asking for a login,
          // and must not show a different signed-in account.
          const back = (await scanPage(page, cfg.safety)).signals;
          const otherAccount = [...back.bodyText.matchAll(/[\w.+-]+@gmail\.com/gi)].map((m) => m[0].toLowerCase()).find((e) => e !== googleAccount.toLowerCase());
          if (otherAccount) return { stop: `after Google sign-in the site shows ${otherAccount}, not ${googleAccount}`, waited };
          if (back.loginDetected && !blockerOf(back, false)) return { stop: `Google sign-in finished but ${back.url} still asks for a login`, waited };
          recordTimeline(store, jobId, "GOOGLE_SIGNIN_VERIFIED", { runId: deps.runId, detail: { url: back.url, accountShown: back.bodyText.toLowerCase().includes(googleAccount.toLowerCase()) } });
          waited = true;
          continue; // re-check the page (it may now show OTP, CAPTCHA, or the form)
        }
      }
      if (!canWait) return { stop: `${b.what} at ${s.url}${b.kind === "LOGIN" ? " — no 'Sign in with Google' on the page; log in once in the agent's browser profile (npm run browser:login), then re-queue" : ""}`, waited };
      const minutes = Math.round(cfg.application.humanWait.timeoutMs / 60000);
      logger.warn({ module: "application", action: "human_wait", status: "blocked", jobId, message: `WAITING FOR YOU: ${b.what} in the open browser window (${job.companyName} — ${job.jobTitle}). The application continues by itself once it's done; giving up after ${minutes} min.` });
      recordTimeline(store, jobId, "HUMAN_WAIT_STARTED", { runId: deps.runId, detail: { kind: b.kind, evidence: b.evidence, url: s.url } });
      human?.handoffStarted?.({ kind: b.kind, what: b.what, url: s.url });
      await store.flush().catch(() => undefined);
      const until = Date.now() + cfg.application.humanWait.timeoutMs;
      let cleared = false;
      // "Continue" from the user re-checks the page at once; the page is also re-checked on its own every poll.
      let signal = human?.handoffSignal?.() ?? null;
      while (Date.now() < until) {
        const tick = page.waitForTimeout(cfg.application.humanWait.pollMs).then(() => "tick" as const);
        const r = signal ? await Promise.race([tick, signal]) : await tick;
        if (r === "skip") {
          human?.handoffEnded?.("skipped");
          return { stop: `${b.what}: skipped by you at ${page.url()}`, waited };
        }
        if (r === "continue") signal = human?.handoffSignal?.() ?? null;
        const now = await scanPage(page, cfg.safety).catch(() => null); // the page may be mid-navigation (SSO redirects)
        if (!now) continue;
        if (now.signals.paymentDetected) break; // re-evaluated at the top of the loop → hard stop
        if (blockerOf(now.signals, includeLogin && cfg.safety.requireHumanForLogin)?.kind !== b.kind) {
          cleared = true;
          break;
        }
        if (r === "continue") human?.event?.("HANDOFF_STILL_BLOCKED", { kind: b.kind, what: b.what, url: now.signals.url });
      }
      if (!cleared) {
        if (Date.now() >= until) {
          human?.handoffEnded?.("timeout");
          return { stop: `${b.what} was not completed within ${minutes} min at ${page.url()}`, waited };
        }
        continue; // a payment request appeared: the next round stops on it
      }
      waited = true;
      human?.handoffEnded?.("cleared");
      await settle(page, cfg.application.waitTimeouts.stabilizeMs);
      recordTimeline(store, jobId, "HUMAN_WAIT_COMPLETED", { runId: deps.runId, detail: { kind: b.kind, url: page.url() } });
      logger.info({ module: "application", action: "human_wait", status: "success", jobId, message: `${b.kind} completed by you; continuing the application at ${page.url()}` });
    }
    return { stop: "too many consecutive verification steps; stopping for a human", waited };
  };

  let session;
  try {
    session = await deps.browser.open();
  } catch (err) {
    const e = toAgentError(err, "BROWSER_ERROR");
    transition(store, jobId, "FAILED", { runId: deps.runId, reason: e.message, patch: { lastError: e.message } });
    recordError(store, { runId: deps.runId, jobId, module: "application", code: e.code, message: e.message });
    return { status: "FAILED", reason: e.message, screenshot: null };
  }
  const page = session.page;
  human?.pageOpened?.(page);
  let keep = false;
  try {
    await page.goto(job.applyUrl, { timeout: cfg.application.waitTimeouts.navigationMs, waitUntil: "domcontentloaded" });
    await settle(page, cfg.application.waitTimeouts.stabilizeMs);
    // A job found on LinkedIn: follow its Apply button to the company's own application form.
    if (isLinkedInJobPage(page.url())) {
      const li = await resolveLinkedInApply(page, cfg.application.waitTimeouts.navigationMs);
      if (li.kind === "easy-apply") return await needsHuman(page, "LinkedIn Easy Apply: this job is applied to inside LinkedIn, which the agent does not automate. Open it and apply on LinkedIn yourself (your tailored resume is ready), then mark it applied.");
      if (li.kind === "signed-out") return await needsHuman(page, "LinkedIn login required: sign in to LinkedIn once in the agent's browser (npm run browser:login), then retry — the agent follows LinkedIn's Apply button to the company's site.");
      if (li.kind === "closed") return await needsHuman(page, "This LinkedIn job is no longer accepting applications.");
      if (li.kind === "unknown") return await needsHuman(page, `LinkedIn: ${li.detail}`);
      store.t.jobs.update(jobId, { applyUrl: li.url, updatedAt: new Date().toISOString() });
      recordTimeline(store, jobId, "APPLICATION_STARTED", { runId: deps.runId, detail: { linkedInApplyUrl: li.url } });
      await page.goto(li.url, { timeout: cfg.application.waitTimeouts.navigationMs, waitUntil: "domcontentloaded" });
      await settle(page, cfg.application.waitTimeouts.stabilizeMs);
    }
    const first = await clearBlockers(page, false);
    if (first.stop) return await needsHuman(page, first.stop);

    // Isolate the application form from newsletter/search forms; follow at most one "Apply" link.
    let located = await locateApplicationForm(page, cfg);
    const opened = await clearBlockers(page, true);
    if (opened.stop) return await needsHuman(page, opened.stop);
    if (opened.waited) located = await locateApplicationForm(page, cfg); // continue from where the user left the page
    const scan = located.scan;
    if (!located.isApplication) return await needsHuman(page, `no application form found at ${located.full.signals.url} (only ${located.full.fields.length} non-application field(s); unsupported flow)`);

    transition(store, jobId, "FORM_DETECTED", { runId: deps.runId, reason: `${scan.fields.length} fields, ${scan.buttons.length} buttons` });
    recordTimeline(store, jobId, "FORM_DETECTED", { runId: deps.runId, detail: { url: scan.signals.url, fields: scan.fields.length } });

    human?.event?.("FORM_DETECTED", { url: scan.signals.url, fields: scan.fields.length });
    const classifierCtx = { safety: cfg.safety, records: deps.questions, profile: deps.profile, allowAiSuggested: cfg.application.allowAiSuggestedAnswers, resumeAvailable: resumePdf !== null };
    let plans = planForm(scan.fields, classifierCtx);
    // Required questions with no trusted answer: ask the user (web app) instead of guessing. Without a controller they
    // stay NEEDS_HUMAN and stop the application at the gate, exactly as before.
    const pending: PendingQuestion[] = plans
      .filter((p) => p.action === "NEEDS_HUMAN" && p.field.required && !["CAPTCHA", "OTP", "FILE_UPLOAD"].includes(p.classification))
      .map((p) => ({ label: p.field.label, kind: p.field.kind, options: p.field.options, required: p.field.required, reason: p.reason }));
    // Fill everything already known first, so the page shows progress while you answer the new question(s).
    let prefilled: Awaited<ReturnType<typeof fillForm>> = [];
    if (pending.length && human?.ask) {
      if ((await human.checkpoint?.("before-fill")) === "stop") return await needsHuman(page, "stopped by you before the form was filled");
      prefilled = (await fillForm(page, plans, resumePdf)).filter((f) => f.ok);
      human.event?.("FIELDS_FILLED", { filled: prefilled.length, failed: 0 });
      human.event?.("QUESTION_REQUIRED", { count: pending.length, labels: pending.map((q) => q.label) });
      const answers = await human.ask(pending);
      if (answers === "skip") return await needsHuman(page, `stopped by you at ${pending.length} new question(s): ${pending.map((q) => `'${q.label}'`).join(", ")}`);
      const learned = humanAnswerRecords(answers);
      if (learned.length) {
        plans = planForm(scan.fields, { ...classifierCtx, records: [...learned, ...deps.questions] });
        human.event?.("HUMAN_RESPONSE_RECEIVED", { answered: learned.length });
      }
    }
    if ((await human?.checkpoint?.("before-fill")) === "stop") return await needsHuman(page, "stopped by you before the form was filled");
    const jobConfirmed = confirmJobOnPage(job, scan);
    // Fields filled before the questions are kept; only the rest (your answers) are filled now.
    const done = new Set(prefilled.map((f) => f.label));
    const fills = [...prefilled, ...(await fillForm(page, plans.filter((p) => !done.has(p.field.label)), resumePdf))];
    human?.event?.("FIELDS_FILLED", { filled: fills.filter((f) => f.ok).length, failed: fills.filter((f) => !f.ok).length });
    recordAnswers(store, jobId, deps.runId, plans, fills);
    const failedFills = fills.filter((f) => !f.ok);
    const resumeUploaded = fills.some((f) => f.action === "UPLOAD_RESUME" && f.ok);
    transition(store, jobId, "FORM_FILLED", { runId: deps.runId, reason: `${fills.filter((f) => f.ok).length} filled, ${failedFills.length} failed`, detail: { failedFills } });
    recordTimeline(store, jobId, "FORM_FILLED", { runId: deps.runId, detail: { filled: fills.filter((f) => f.ok).map((f) => f.label) } });
    if (resumeUploaded) recordTimeline(store, jobId, "RESUME_UPLOADED", { runId: deps.runId, detail: { file: resumePdf ? path.basename(resumePdf) : null } });

    const final = findFinalSubmit(scan.buttons);
    const multiStep = !final.candidate && final.all.some((b) => b.kind === "CONTINUE");
    const emptyRequired = await emptyRequiredFields(page);
    const gateInput = {
      mode,
      dryRun: cfg.dryRun,
      plans: plans.map((p): FieldPlan => (failedFills.some((f) => f.label === p.field.label) ? { ...p, action: "NEEDS_HUMAN", reason: "fill could not be verified" } : p)),
      emptyRequiredAfterFill: emptyRequired,
      captcha: scan.signals.captchaDetected,
      // An invisible CAPTCHA may challenge at submit. With a visible browser the agent waits for you to solve it;
      // without one, nobody could, so an automatic submit is not allowed at all.
      captchaDormant: !canWait && !!located.full.signals.captchaDormant,
      otp: scan.signals.otpDetected,
      loginWall: false,
      resumeRequiredField: plans.some((p) => p.action === "UPLOAD_RESUME" || (p.field.kind === "FILE_UPLOAD" && p.field.required)),
      resumeAttached: resumeUploaded,
      jobConfirmed,
      finalSubmit: final.candidate,
      finalSubmitAmbiguous: final.ambiguous,
      highConfidenceThreshold: cfg.application.highConfidenceThreshold,
      humanApproved: false,
    };
    const gate = evaluateGate(gateInput);
    const report = buildReport(scan, plans, final.all, final.candidate, jobConfirmed);
    patchApplication(store, jobId, { form: { report, gate, fills } });

    if (!gate.validationPassed) {
      const reasons = [...(multiStep ? ["multi-step form (continue/next without final submit)"] : []), ...gate.blockers.filter((b) => !b.startsWith("DRY_RUN"))];
      if (reasons.length) {
        transition(store, jobId, "VALIDATION_FAILED", { runId: deps.runId, reason: reasons.join("; ").slice(0, 1000) });
        keep = !!opts.keepOpen;
        return await needsHuman(page, reasons.join("; "), gate);
      }
    }
    recordTimeline(store, jobId, "VALIDATION_PASSED", { runId: deps.runId, detail: { finalSubmit: final.candidate?.button.text ?? null } });

    if (cfg.dryRun) {
      const shot = await screenshot(page, jobId, "dry-run-filled");
      transition(store, jobId, "READY_TO_APPLY", { runId: deps.runId, reason: "DRY_RUN: form filled and validated, not submitted" });
      patchApplication(store, jobId, { status: "DRY_RUN_VALIDATED", screenshotPath: shot });
      return { status: "READY_TO_APPLY", reason: "dry run — validated, not submitted", screenshot: shot, gate };
    }

    let approved = false;
    if (mode === "AUTO_FILL_REVIEW_SUBMIT" && deps.approve) {
      approved = await deps.approve(`${job.companyName} — ${job.jobTitle}\n${report.fields.map((f) => `  ${f.action.padEnd(14)} ${f.label}: ${f.answerPreview ?? ""}`).join("\n")}\nSubmit button: ${report.finalSubmit ?? "?"}`);
    }
    const decision = evaluateGate({ ...gateInput, dryRun: false, humanApproved: approved });
    if (!decision.submitAllowed || !final.candidate) {
      keep = !!opts.keepOpen;
      return await needsHuman(page, `form filled and validated; not submitted: ${decision.reviewReasons.join("; ") || "submission not permitted by mode"}`, decision);
    }

    // ---- Submit ----
    if ((await human?.checkpoint?.("before-submit")) === "stop") {
      keep = !!opts.keepOpen;
      return await needsHuman(page, "stopped by you before submitting; nothing was submitted");
    }
    const preSubmit = await clearBlockers(page, false); // e.g. a fee notice next to the button
    if (preSubmit.stop) {
      keep = !!opts.keepOpen;
      return await needsHuman(page, `not submitted: ${preSubmit.stop}`);
    }
    transition(store, jobId, "SUBMITTING", { runId: deps.runId, reason: `clicking '${final.candidate.button.text}'` });
    const beforeUrl = page.url();
    await page.locator(`[data-aja-id="${final.candidate.button.key}"]`).first().click();
    recordTimeline(store, jobId, "SUBMITTED", { runId: deps.runId, detail: { button: final.candidate.button.text } });
    human?.event?.("APPLICATION_SUBMITTED", { button: final.candidate.button.text });
    await settle(page, cfg.application.waitTimeouts.postSubmitMs);
    // A challenge can appear on submit (invisible CAPTCHA, OTP). Wait it out like any other; a payment page means the
    // application is NOT complete.
    const postSubmit = await clearBlockers(page, false);
    if (postSubmit.stop) {
      keep = !!opts.keepOpen;
      return await needsHuman(page, `submit clicked but the application is NOT complete: ${postSubmit.stop}`);
    }
    if (postSubmit.waited) await settle(page, cfg.application.waitTimeouts.postSubmitMs);
    const after = await scanPage(page, cfg.safety);
    const errors = await page
      .locator("[role=alert], .error, .field-error, [aria-invalid=true]")
      .allInnerTexts()
      .then((t) => t.map((x) => x.trim()).filter(Boolean).slice(0, 10))
      .catch((): string[] => []);
    // Some ATSs show the rejection as a plain banner, e.g. Lever: "There was an error verifying your application."
    const banner = /there was an error (?:verifying|submitting|processing) your application[^\n]*/i.exec(after.signals.bodyText)?.[0].trim();
    if (banner && !errors.includes(banner)) errors.unshift(banner);
    const evidence = evaluateSubmissionEvidence({
      beforeUrl,
      afterUrl: after.signals.url,
      afterText: after.signals.bodyText,
      formStillPresent: after.fields.some((f) => f.kind === "FILE_UPLOAD") || after.fields.length >= Math.max(1, scan.fields.length - 1),
      visibleErrors: errors,
      confirmationPatterns: cfg.application.confirmationPatterns,
      siteError: banner ?? null,
    });
    const shot = await screenshot(page, jobId, `submitted-${evidence.verdict.toLowerCase()}`);
    const now = new Date().toISOString();
    if (evidence.verdict === "VERIFIED") {
      transition(store, jobId, "APPLIED", { runId: deps.runId, reason: evidence.signals.join("; "), patch: { requiresHuman: false, blockReason: null, appliedDate: now.slice(0, 10) } });
      recordTimeline(store, jobId, "SUBMISSION_VERIFIED", { runId: deps.runId, detail: { ...evidence } });
      human?.event?.("CONFIRMATION_DETECTED", { confirmation: evidence.confirmationText, id: evidence.confirmationId });
      patchApplication(store, jobId, { status: "APPLIED", submittedAt: now, verifiedAt: now, evidence, screenshotPath: shot, blockReason: null });
      return { status: "APPLIED", evidence, screenshot: shot };
    }
    if (evidence.verdict === "REJECTED") {
      transition(store, jobId, "NEEDS_HUMAN", { runId: deps.runId, reason: `site rejected submission: ${errors.join(" | ")}`, patch: { requiresHuman: true, blockReason: "submission rejected by site" } });
      patchApplication(store, jobId, { status: "NEEDS_HUMAN", evidence, screenshotPath: shot, blockReason: "submission rejected by site" });
      return { status: "NEEDS_HUMAN", reason: `submission rejected: ${errors.join(" | ")}`, screenshot: shot };
    }
    transition(store, jobId, "SUBMISSION_UNVERIFIED", { runId: deps.runId, reason: `no confirmation found; signals: ${evidence.signals.join("; ") || "none"}`, patch: { requiresHuman: true, blockReason: "submission not verified — check manually" } });
    patchApplication(store, jobId, { status: "SUBMISSION_UNVERIFIED", submittedAt: now, evidence, screenshotPath: shot });
    return { status: "SUBMISSION_UNVERIFIED", evidence, screenshot: shot };
  } catch (err) {
    const e = toAgentError(err, "BROWSER_ERROR");
    const shot = await screenshot(page, jobId, "error");
    const current = repo.get(jobId)?.status;
    // A click on submit may have happened; never fall back to "not applied" silently.
    const to = current === "SUBMITTING" ? "SUBMISSION_UNVERIFIED" : "FAILED";
    transition(store, jobId, to, { runId: deps.runId, reason: e.message, patch: { lastError: e.message.slice(0, 500), requiresHuman: to === "SUBMISSION_UNVERIFIED" } });
    if (store.t.applications.has(jobId)) patchApplication(store, jobId, { status: to, screenshotPath: shot });
    recordError(store, { runId: deps.runId, jobId, module: "application", code: e.code, message: e.message });
    return { status: "FAILED", reason: e.message, screenshot: shot };
  } finally {
    if (!keep) await session.close().catch(() => undefined);
  }
}

export async function processApplicationQueue(deps: ApplicationDeps, limit: number): Promise<Array<{ jobId: string; result: ApplicationResult }>> {
  const repo = new JobRepo(deps.store);
  const out: Array<{ jobId: string; result: ApplicationResult }> = [];
  const queue = repo.byStatus(["READY_TO_APPLY"], limit);
  for (const [i, job] of queue.entries()) {
    deps.logger.info({ module: "application", action: "queue", status: "start", jobId: job.jobId, message: `job ${i + 1} of ${queue.length}: ${job.companyName} — ${job.jobTitle}` });
    try {
      const result = await processApplication(deps, job.jobId);
      out.push({ jobId: job.jobId, result });
      await deps.store.flush();
      deps.logger.info({ module: "application", action: "queue", status: "success", jobId: job.jobId, message: `job ${i + 1} of ${queue.length} finished: ${result.status}${i + 1 < queue.length ? " — opening the next one" : ""}` });
    } catch (err) {
      const e = toAgentError(err);
      recordError(deps.store, { runId: deps.runId, jobId: job.jobId, module: "application", code: e.code, message: e.message });
      out.push({ jobId: job.jobId, result: { status: "FAILED", reason: e.message, screenshot: null } });
    }
  }
  return out;
}
