import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { processApplication, inspectApplication, type ApplicationDeps } from "../../agent/application/applicationEngine.ts";
import { loadQuestionBank } from "../../agent/questions/questionBank.ts";
import { loadProfile } from "../../agent/profile/profile.ts";
import { getTimeline } from "../../agent/store/stateMachine.ts";
import { JobRepo } from "../../agent/store/repositories.ts";
import { PlaywrightBrowserProvider } from "../../integrations/playwright/PlaywrightBrowserProvider.ts";
import type { AppConfig } from "../../agent/core/config.ts";
import type { MatchResult } from "../../agent/core/schemas.ts";
import type { Store } from "../../agent/store/sheetStore.ts";
import { FIXTURES, logger, makeTempRoot, memStore, testConfig } from "../helpers.ts";

/** Real headless Chromium against local fixture pages. No real application site is ever contacted. */
let root: string;
let pdf: string;
const browser = new PlaywrightBrowserProvider({ profileDir: "unused", headless: true, slowMoMs: 0, persistent: false });
const formUrl = (f: string) => pathToFileURL(path.join(FIXTURES, "forms", f)).toString();

beforeAll(() => {
  root = makeTempRoot();
  pdf = path.join(root, "Acme_Payments_Java_Backend_Developer_JOB-000001.pdf");
  const r = spawnSync("python", ["-c", "import fitz,sys;d=fitz.open();p=d.new_page();p.insert_text((72,72),'ASHA RAO');d.save(sys.argv[1])", pdf]);
  expect(r.status).toBe(0);
});
afterAll(async () => browser.shutdown());

let n = 0;
function seedJob(store: Store, url: string, eligible = true): string {
  const jobId = `JOB-${String(++n).padStart(6, "0")}`;
  const now = new Date().toISOString();
  const rv = `RV-TEST-${jobId}`;
  store.t.jobs.insert({
    jobId, source: "test", sourcesLabel: "test", externalJobId: null, companyId: null, companyName: "Acme Payments", jobTitle: "Java Backend Developer", location: "Bengaluru",
    workMode: null, experienceRequired: null, salary: null, skills: [], postedDate: null, applyUrl: url, jobUrl: url, jdHash: null, companyDomain: null, matchScore: 80, matchReason: null,
    resumeVersionId: rv, status: "READY_TO_APPLY", applicationAttempts: 0, requiresHuman: false, blockReason: null, lastError: null, createdAt: now, updatedAt: now, resumeFile: "", lastAttemptAt: null, appliedDate: null,
  });
  store.t.resumes.insert({ resumeVersionId: rv, jobId, generatedAt: now, status: "GENERATED", outputDir: ".", texPath: "x.tex", pdfPath: path.relative(root, pdf), compiler: "test", templateSha256: "x", validation: null, error: null });
  store.t.details.insert({ jobId, jdText: null, jdSource: null, requirements: null, requirementsJdHash: null, match: eligibleMatch(eligible), matchProfileHash: null, matchedAt: now });
  return jobId;
}

/** Only the eligibility fields the engine checks; the rest of the match is irrelevant to form handling. */
const eligibleMatch = (eligible: boolean) =>
  ({ eligibilityStatus: eligible ? "ELIGIBLE" : "NOT_ELIGIBLE", eligibilityReason: eligible ? null : "ROLE_FAMILY_INCOMPATIBLE", eligible }) as unknown as MatchResult;

/** Simulates the user having entered their last name in the question bank (it is never inferred). */
const confirmedLastName = () => loadQuestionBank().records.map((r) => (r.canonicalKey === "last_name" ? { ...r, answer: "M P", verified: true } : r));

function deps(store: Store, over: Partial<AppConfig["application"]> = {}, dryRun = false, questions = loadQuestionBank().records): ApplicationDeps {
  const cfg = testConfig({ dryRun });
  cfg.application = { ...cfg.application, ...over, waitTimeouts: { navigationMs: 15000, stabilizeMs: 200, elementMs: 5000, postSubmitMs: 800 } };
  return { cfg, store, logger: logger(), profile: loadProfile(), browser, questions, runId: "RUN-TEST" };
}

describe("application engine (fixture forms, headless Chromium)", () => {
  it("FULL_AUTO stops on a required field the user hasn't answered (last name is never inferred from the full name)", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("simple-apply.html"));
    const r = await processApplication(deps(store, { mode: "FULL_AUTO" }), id);
    expect(r.status).toBe("NEEDS_HUMAN");
    expect("reason" in r ? r.reason : "").toMatch(/field 'Last Name': no verified answer for 'last_name'/);
    expect(store.t.answers.find((a) => a.jobId === id && a.fieldLabel.startsWith("Last Name"))?.action).not.toBe("FILLED");
    expect(getTimeline(store, id).map((t) => t.event)).not.toContain("SUBMITTED");
  });

  it("FULL_AUTO: fills verified answers, uploads resume, submits, and verifies confirmation", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("simple-apply.html"));
    const r = await processApplication(deps(store, { mode: "FULL_AUTO" }, false, confirmedLastName()), id);
    expect(r.status).toBe("APPLIED");
    const events = getTimeline(store, id).map((t) => t.event);
    expect(events).toEqual(expect.arrayContaining(["APPLICATION_STARTED", "FORM_DETECTED", "FORM_FILLED", "RESUME_UPLOADED", "VALIDATION_PASSED", "SUBMITTED", "SUBMISSION_VERIFIED", "APPLIED"]));
    const answers = store.t.answers.filter((x) => x.jobId === id).map((x) => ({ field_label: x.fieldLabel, action: x.action }));
    expect(answers.find((a) => a.field_label.startsWith("Email"))?.action).toBe("FILLED");
    expect(answers.find((a) => a.field_label.startsWith("Resume"))?.action).toBe("UPLOADED");
    expect(answers.find((a) => a.field_label.startsWith("Highest Degree"))?.action).toBe("FILLED");
    expect(JSON.stringify(store.t.applications.get(id)?.evidence)).toMatch(/ACME-12345/);
    expect(store.t.jobs.get(id)?.appliedDate).toBeTruthy();
  });

  it("submission without confirmation is SUBMISSION_UNVERIFIED, not APPLIED", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("unverified-apply.html"));
    const r = await processApplication(deps(store, { mode: "FULL_AUTO" }, false, confirmedLastName()), id);
    expect(r.status).toBe("SUBMISSION_UNVERIFIED");
    expect(new JobRepo(store).get(id)?.status).toBe("SUBMISSION_UNVERIFIED");
  });

  it("REVIEW_ONLY fills and validates but never submits", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("simple-apply.html"));
    const r = await processApplication(deps(store, { mode: "REVIEW_ONLY" }, false, confirmedLastName()), id);
    expect(r.status).toBe("NEEDS_HUMAN");
    expect(getTimeline(store, id).map((t) => t.event)).not.toContain("SUBMITTED");
    expect(new JobRepo(store).get(id)?.blockReason).toMatch(/REVIEW_ONLY/);
  });

  it("DRY_RUN fills and validates, never submits, and re-queues the job", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("simple-apply.html"));
    const r = await processApplication(deps(store, { mode: "FULL_AUTO" }, true, confirmedLastName()), id);
    expect(r.status).toBe("READY_TO_APPLY");
    expect(getTimeline(store, id).map((t) => t.event)).not.toContain("SUBMITTED");
  });

  it("unknown, legal and salary questions stop for a human", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("unknown-question.html"));
    const r = await processApplication(deps(store, { mode: "FULL_AUTO" }), id);
    expect(r.status).toBe("NEEDS_HUMAN");
    const reason = new JobRepo(store).get(id)?.blockReason ?? "";
    expect(reason).toMatch(/distributed-systems failure/);
    expect(reason).toMatch(/legally authorized/);
    expect(reason).toMatch(/Expected CTC/);
    expect(getTimeline(store, id).map((t) => t.event)).not.toContain("SUBMITTED");
  });

  it("refuses a job that is not ELIGIBLE: no browser, no upload, stays out of the queue", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("simple-apply.html"), false);
    await expect(processApplication(deps(store, { mode: "FULL_AUTO" }), id)).rejects.toThrow(/not ELIGIBLE \(ROLE_FAMILY_INCOMPATIBLE\)/);
    expect(getTimeline(store, id).map((t) => t.event)).not.toContain("APPLICATION_STARTED");
    expect(store.t.answers.filter((a) => a.jobId === id)).toHaveLength(0);
  });

  it("CAPTCHA stops only that job for a human with a screenshot", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("captcha.html"));
    const r = await processApplication(deps(store, { mode: "FULL_AUTO" }), id);
    expect(r.status).toBe("NEEDS_HUMAN");
    expect("reason" in r ? r.reason : "").toMatch(/CAPTCHA/);
    expect(r.screenshot).toBeTruthy();
    expect(fs.existsSync(path.join(root, r.screenshot ?? ""))).toBe(true);
  });

  it("Lever-style form: sibling question labels, ✱ required, hidden status text, cleared autocomplete, invisible CAPTCHA", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("lever-style.html"));
    const r = await processApplication(deps(store, { mode: "FULL_AUTO" }), id);
    expect(r.status).toBe("NEEDS_HUMAN");
    const reason = "reason" in r ? r.reason : "";
    expect(reason).toMatch(/invisible CAPTCHA/); // dormant widget: the form is filled, but a human submits
    expect(reason).toMatch(/expected CTC/i); // the sibling-div question is recognised, not skipped as optional
    expect(reason).not.toMatch(/resume not attached|Couldn't auto-read/);
    expect(getTimeline(store, id).map((t) => t.event)).not.toContain("SUBMITTED");
    const form = store.t.applications.get(id)?.form as { report: { fields: Array<{ label: string; required: boolean }> }; fills: Array<{ label: string; ok: boolean; detail: string }> };
    const labels = form.report.fields.map((f) => f.label);
    expect(labels).toEqual(expect.arrayContaining(["Resume/CV", "Full name", "Email", "Current location", "What is your expected CTC?"]));
    expect(form.report.fields.filter((f) => f.required).map((f) => f.label)).toEqual(expect.arrayContaining(["Resume/CV", "Full name", "Email", "What is your expected CTC?"]));
    expect(form.fills.find((f) => f.label === "Resume/CV")?.ok).toBe(true);
    const location = form.fills.find((f) => f.label === "Current location");
    expect(location?.ok).toBe(true);
    expect(location?.detail).toBe("picked 'Bengaluru, Bengaluru Urban, Karnataka, IND' from the site's list");
  });

  it("Lever-style form: SaaS and per-skill experience questions go to a human, never total experience or Yes", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("lever-style.html"));
    await processApplication(deps(store, { mode: "FULL_AUTO" }), id);
    const form = store.t.applications.get(id)?.form as { report: { fields: Array<{ label: string; action: string; answerPreview: string | null }> } };
    for (const label of ["How many years of experience do you have working with a SaaS firm?", "How many years of experience do you have in Java?"]) {
      const f = form.report.fields.find((x) => x.label === label);
      expect(f, label).toBeTruthy();
      expect(f?.action, label).toBe("NEEDS_HUMAN");
      expect(f?.answerPreview, label).toBeNull();
    }
  });

  it("follows an 'Apply for this job' link (navigation, not submission) to reach the form", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("job-page-with-apply-link.html"));
    const r = await processApplication(deps(store, { mode: "REVIEW_ONLY" }), id);
    expect(r.status).toBe("NEEDS_HUMAN");
    expect(getTimeline(store, id).map((t) => t.event)).toContain("FORM_DETECTED");
  });

  it("ignores a newsletter form and follows 'Apply' to the real form (regression from a live careers page)", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("job-page-with-newsletter.html"));
    await processApplication(deps(store, { mode: "REVIEW_ONLY" }), id);
    const labels = store.t.answers.filter((x) => x.jobId === id).map((x) => x.fieldLabel);
    expect(labels).not.toContain("Enter email");
    expect(labels.some((l) => l.startsWith("Resume"))).toBe(true);
  });

  it("opens a Greenhouse form embedded in an iframe on the company page (regression: live MongoDB page)", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("job-page-with-embedded-form.html"));
    const r = await processApplication(deps(store, { mode: "REVIEW_ONLY" }, false, confirmedLastName()), id);
    expect(r.status).toBe("NEEDS_HUMAN");
    expect(new JobRepo(store).get(id)?.blockReason).toMatch(/REVIEW_ONLY/); // got to the review gate, i.e. the form was found and filled
    const answers = store.t.answers.filter((a) => a.jobId === id);
    expect(answers.find((a) => a.fieldLabel.startsWith("Email"))?.action).toBe("FILLED");
    expect(answers.find((a) => a.fieldLabel.startsWith("Resume"))?.action).toBe("UPLOADED");
    expect(getTimeline(store, id).map((t) => t.event)).not.toContain("SUBMITTED");
  });

  it("PAYMENT: a fee + card field stops immediately; nothing is entered, even in FULL_AUTO", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("payment-fee.html"));
    const r = await processApplication(deps(store, { mode: "FULL_AUTO" }, false, confirmedLastName()), id);
    expect(r.status).toBe("NEEDS_HUMAN");
    expect("reason" in r ? r.reason : "").toMatch(/^PAYMENT_REQUESTED: payment field 'Card number'/);
    const events = getTimeline(store, id).map((t) => t.event);
    expect(events).toContain("PAYMENT_REQUESTED");
    expect(events).not.toContain("FORM_FILLED");
    expect(events).not.toContain("SUBMITTED");
    expect(store.t.answers.filter((a) => a.jobId === id)).toHaveLength(0);
  });

  it("PAYMENT: a fintech JD that talks about payment gateways and UPI is not a payment request", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("fintech-apply.html"));
    const r = await processApplication(deps(store, { mode: "REVIEW_ONLY" }), id);
    expect("reason" in r ? r.reason : "").not.toMatch(/PAYMENT/);
    expect(getTimeline(store, id).map((t) => t.event)).toContain("FORM_FILLED");
  });

  it("COMBOBOX: picks the real option from a react-select-style list and verifies the page shows it", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("combobox-apply.html"));
    await processApplication(deps(store, { mode: "REVIEW_ONLY" }), id);
    const form = store.t.applications.get(id)?.form as { report: { fields: Array<{ label: string; kind: string; required: boolean }> }; fills: Array<{ label: string; ok: boolean; detail: string }> };
    const country = form.report.fields.find((f) => f.label === "Country");
    expect(country).toMatchObject({ kind: "COMBOBOX", required: true }); // required comes from the hidden validation input
    expect(form.report.fields.some((f) => f.label === "")).toBe(false); // the hidden input is not a field of its own
    const fill = form.fills.find((f) => f.label === "Country");
    expect(fill?.ok).toBe(true);
    expect(fill?.detail).toMatch(/^selected 'India' \(page shows 'India'\)/); // not "Indonesia" or "British Indian Ocean Territory"
    expect(new JobRepo(store).get(id)?.blockReason ?? "").not.toMatch(/required field still empty: 'Country'/);
    // Greenhouse-style upload block: the input is labelled "Attach"; the field is the block heading
    expect(form.report.fields.find((f) => f.kind === "FILE_UPLOAD")?.label).toBe("Resume/CV");
    expect(form.fills.find((f) => f.label === "Resume/CV")?.ok).toBe(true);
  });

  it("GOOGLE SIGN-IN: clicks the site's button, chooses the configured account, confirms basic sign-in, verifies, continues the same job", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("login-google.html"));
    const r = await processApplication({ ...deps(store, { mode: "REVIEW_ONLY" }, false, confirmedLastName()), googleUrl: /google-(chooser|consent|password)/ }, id);
    const events = getTimeline(store, id);
    const started = events.find((t) => t.event === "GOOGLE_SIGNIN_STARTED")?.detail as { account: string; steps: string[] } | undefined;
    expect(started?.account).toBe("candidate@example.com");
    expect(started?.steps.join(" | ")).toMatch(/clicked the site's Google sign-in button \| chose candidate@example.com .* \| confirmed Google's basic sign-in/);
    expect(events.map((t) => t.event)).toEqual(expect.arrayContaining(["GOOGLE_SIGNIN_VERIFIED", "FORM_DETECTED", "FORM_FILLED"]));
    expect("reason" in r ? r.reason : "").toMatch(/REVIEW_ONLY/); // reached the review gate of the same job's form
  });

  it("GOOGLE SIGN-IN: an account chooser without the configured account is handed to the user, nothing chosen", async () => {
    const { store } = await memStore();
    const id = seedJob(store, `${formUrl("login-google.html")}?next=google-chooser-other.html`);
    const r = await processApplication({ ...deps(store, { mode: "FULL_AUTO" }), googleUrl: /google-(chooser|consent|password)/ }, id);
    expect(r.status).toBe("NEEDS_HUMAN");
    expect("reason" in r ? r.reason : "").toMatch(/account chooser shows someone\.else@gmail\.com, not candidate@example.com/);
    expect(getTimeline(store, id).map((t) => t.event)).not.toContain("GOOGLE_SIGNIN_VERIFIED");
  });

  it("GOOGLE SIGN-IN: a Google password prompt is never typed into; the user takes over", async () => {
    const { store } = await memStore();
    const id = seedJob(store, `${formUrl("login-google.html")}?next=google-password.html`);
    const r = await processApplication({ ...deps(store, { mode: "FULL_AUTO" }), googleUrl: /google-(chooser|consent|password)/ }, id);
    expect(r.status).toBe("NEEDS_HUMAN");
    expect("reason" in r ? r.reason : "").toMatch(/Google is asking for the password/);
  });

  /** Same headless browser, reported as a visible window, so the engine uses its wait-for-the-user path. */
  const interactive = { id: "test-interactive", interactive: true, status: () => browser.status(), open: () => browser.open() };
  const waiting = (store: Store, timeoutMs: number) => {
    const d = deps(store, { mode: "REVIEW_ONLY" }, false, confirmedLastName());
    d.cfg.application.humanWait = { enabled: true, timeoutMs, pollMs: 250 };
    return { ...d, browser: interactive };
  };

  it("CAPTCHA with a visible browser: waits for the user, then continues the SAME application on that page", async () => {
    const { store } = await memStore();
    const id = seedJob(store, `${formUrl("captcha-then-form.html")}?solveAfter=2500`);
    const r = await processApplication(waiting(store, 20_000), id);
    const events = getTimeline(store, id).map((t) => t.event);
    expect(events).toEqual(expect.arrayContaining(["HUMAN_WAIT_STARTED", "HUMAN_WAIT_COMPLETED", "FORM_DETECTED", "FORM_FILLED"]));
    expect(events.indexOf("HUMAN_WAIT_COMPLETED")).toBeLessThan(events.indexOf("FORM_FILLED"));
    expect(store.t.answers.find((a) => a.jobId === id && a.fieldLabel.startsWith("Email"))?.action).toBe("FILLED");
    expect("reason" in r ? r.reason : "").toMatch(/REVIEW_ONLY/);
  });

  it("CAPTCHA with a visible browser that the user never completes: stops after the wait limit, fills nothing", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("captcha-then-form.html"));
    const r = await processApplication(waiting(store, 1500), id);
    expect(r.status).toBe("NEEDS_HUMAN");
    expect("reason" in r ? r.reason : "").toMatch(/CAPTCHA detected .* was not completed within/);
    expect(getTimeline(store, id).map((t) => t.event)).not.toContain("FORM_FILLED");
  });

  it("a page with only a newsletter form stops for a human and fills nothing", async () => {
    const { store } = await memStore();
    const id = seedJob(store, formUrl("newsletter-only.html"));
    const r = await processApplication(deps(store, { mode: "FULL_AUTO" }, false, confirmedLastName()), id);
    expect(r.status).toBe("NEEDS_HUMAN");
    expect("reason" in r ? r.reason : "").toMatch(/no application form found/);
    expect(store.t.answers.filter((x) => x.jobId === id)).toHaveLength(0);
  });

  it("inspect_application is read-only", async () => {
    const d = deps((await memStore()).store);
    const report = await inspectApplication(d, formUrl("unknown-question.html"));
    expect(report.finalSubmit).toBe("Submit Application");
    expect(report.fields.find((f) => f.label.includes("legally"))?.classification).toBe("LEGAL_OR_ELIGIBILITY");
    expect(report.fields.find((f) => f.label.startsWith("Email"))?.classification).toBe("KNOWN_SAFE");
  });
});
