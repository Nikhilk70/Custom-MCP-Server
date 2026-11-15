import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBaseContext } from "../../agent/orchestration/container.ts";
import { Store } from "../../agent/store/sheetStore.ts";
import type { ApplicationDeps, ApplicationResult } from "../../agent/application/applicationEngine.ts";
import type { MatchResult } from "../../agent/core/schemas.ts";
import { InMemorySheetProvider } from "../../integrations/google-sheets/InMemorySheetProvider.ts";
import { AgentRuntime, type AutoApplyRequest } from "../../server/runtime.ts";
import { makeTempRoot } from "../helpers.ts";

/** The runtime around a fake engine: every control path (pause, stop, hand-offs, guards) without a browser. */
let root: string;
let sheet: InMemorySheetProvider;
let rt: AgentRuntime;
let calls: Array<{ jobId: string; dryRun: boolean; mode: string; hasApprove: boolean }>;
let engine: (deps: ApplicationDeps, jobId: string) => Promise<ApplicationResult>;

const eligible = { eligibilityStatus: "ELIGIBLE", eligibilityReason: null, eligible: true } as unknown as MatchResult;
const ineligible = { eligibilityStatus: "NOT_ELIGIBLE", eligibilityReason: "ROLE_FAMILY_INCOMPATIBLE", eligible: false } as unknown as MatchResult;

async function seed(jobs: Array<{ id: string; company?: string; title?: string; status?: string; match?: MatchResult; url?: string }>): Promise<void> {
  const store = await Store.open(sheet);
  const now = new Date().toISOString();
  for (const j of jobs) {
    const url = j.url ?? `https://jobs.example/${j.id}`;
    store.t.jobs.insert({
      jobId: j.id, source: "test", sourcesLabel: "test", externalJobId: null, companyId: null, companyName: j.company ?? `Company ${j.id}`, jobTitle: j.title ?? "Java Developer", location: "Bengaluru",
      workMode: null, experienceRequired: null, salary: null, skills: [], postedDate: null, applyUrl: url, jobUrl: url, jdHash: null, companyDomain: null, matchScore: 80, matchReason: null,
      resumeVersionId: "RV-1", status: (j.status ?? "READY_TO_APPLY") as never, applicationAttempts: 0, requiresHuman: false, blockReason: null, lastError: null, createdAt: now, updatedAt: now, resumeFile: "", lastAttemptAt: null, appliedDate: null,
    });
    store.t.details.insert({ jobId: j.id, jdText: null, jdSource: null, requirements: null, requirementsJdHash: null, match: j.match ?? eligible, matchProfileHash: null, matchedAt: now });
  }
  await store.flush();
}

async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const req = (over: Partial<AutoApplyRequest> = {}): AutoApplyRequest => ({ scope: "selected", live: false, requireReview: true, pauseForQuestions: true, pauseForHuman: true, ...over });
const dry: ApplicationResult = { status: "READY_TO_APPLY", reason: "dry run — validated, not submitted", screenshot: null };

beforeEach(async () => {
  root = makeTempRoot();
  fs.writeFileSync(path.join(root, "Application_Answers.txt"), "First Name : Asha\n");
  sheet = new InMemorySheetProvider();
  calls = [];
  engine = async () => dry;
  const base = createBaseContext({ quiet: true, sheetProvider: sheet });
  rt = new AgentRuntime({
    base,
    openStore: () => Store.open(sheet),
    stateDir: path.join(root, "runtime", "state", "applypilot"),
    answersFile: path.join(root, "Application_Answers.txt"),
    uploadsDir: path.join(root, "runtime", "uploads"),
    demo: false,
    hooks: {
      apply: async (deps, jobId) => {
        calls.push({ jobId, dryRun: deps.cfg.dryRun, mode: deps.cfg.application.mode, hasApprove: !!deps.approve });
        return engine(deps, jobId);
      },
    },
  });
  await rt.connect();
  rt.updateSettings({ delayBetweenApplicationsSec: 0 });
});
afterEach(async () => {
  rt.stopAll();
  await rt.idle();
});

describe("ApplyPilot runtime — safety guards", () => {
  it("every run is a dry run by default: the engine gets DRY_RUN and nothing is submitted", async () => {
    await seed([{ id: "JOB-000001" }]);
    const r = await rt.autoApply(req({ jobIds: ["JOB-000001"] }));
    expect(r.live).toBe(false);
    await rt.idle();
    expect(calls).toEqual([{ jobId: "JOB-000001", dryRun: true, mode: "AUTO_FILL_REVIEW_SUBMIT", hasApprove: true }]);
    expect(rt.queue.list()[0]).toMatchObject({ status: "DONE", outcome: "DRY_RUN_VALIDATED" });
    expect(rt.sessionsList()[0]).toMatchObject({ status: "COMPLETED", dryRun: true, dryRunValidated: 1, confirmed: 0 });
  });

  it("live requires arming AND typing LIVE for the run; review mode keeps human approval, FULL_AUTO has none", async () => {
    await seed([{ id: "JOB-000001" }, { id: "JOB-000002" }]);
    await expect(rt.autoApply(req({ jobIds: ["JOB-000001"], live: true, confirm: "LIVE" }))).rejects.toThrow(/not armed/);
    expect(() => rt.armLive(true, "yes")).toThrow(/type LIVE/);
    rt.armLive(true, "LIVE");
    await expect(rt.autoApply(req({ jobIds: ["JOB-000001"], live: true, confirm: "live" }))).rejects.toThrow(/type LIVE/);
    await rt.autoApply(req({ jobIds: ["JOB-000001"], live: true, confirm: "LIVE" }));
    await rt.idle();
    await rt.autoApply(req({ jobIds: ["JOB-000002"], live: true, confirm: "LIVE", requireReview: false }));
    await rt.idle();
    expect(calls).toEqual([
      { jobId: "JOB-000001", dryRun: false, mode: "AUTO_FILL_REVIEW_SUBMIT", hasApprove: true },
      { jobId: "JOB-000002", dryRun: false, mode: "FULL_AUTO", hasApprove: false },
    ]);
  });

  it("duplicate protection: an applied job, an unverified submission, and the same posting under another id are never applied to; a low skill match is", async () => {
    await seed([
      { id: "JOB-000001", status: "APPLIED" },
      { id: "JOB-000002", status: "SUBMISSION_UNVERIFIED" },
      { id: "JOB-000003", company: "Acme", title: "Java Developer", status: "APPLIED" },
      { id: "JOB-000004", company: "Acme", title: "Java Developer" },
      { id: "JOB-000005", match: ineligible },
    ]);
    await rt.autoApply(req({ jobIds: ["JOB-000001", "JOB-000002", "JOB-000004", "JOB-000005"] }));
    await rt.idle();
    // Only the job with a low skill match is applied to: there is no eligibility gate, only duplicate protection.
    expect(calls.map((c) => c.jobId)).toEqual(["JOB-000005"]);
    const out = Object.fromEntries(rt.queue.list().map((i) => [i.jobId, `${i.outcome ?? ""}: ${i.failureReason ?? ""}`]));
    expect(out["JOB-000001"]).toMatch(/^DUPLICATE: already applied/);
    expect(out["JOB-000002"]).toMatch(/^DUPLICATE: .*may already have been submitted/);
    expect(out["JOB-000004"]).toMatch(/^DUPLICATE: same posting already applied to as JOB-000003/);
    expect(out["JOB-000005"]).not.toMatch(/^DUPLICATE|^NOT_ELIGIBLE/);
  });

  it("a finished run respects max applications per run and leaves the rest queued", async () => {
    await seed([{ id: "JOB-000001" }, { id: "JOB-000002" }]);
    await rt.autoApply(req({ jobIds: ["JOB-000001", "JOB-000002"], maxApplications: 1 }));
    await rt.idle();
    expect(calls).toHaveLength(1);
    expect(rt.queue.pending()).toBe(1);
    expect(rt.sessionsList()[0]?.note).toMatch(/max per run/);
  });
});

describe("ApplyPilot runtime — controls", () => {
  it("pause holds the queue before the next job; resume continues", async () => {
    await seed([{ id: "JOB-000001" }, { id: "JOB-000002" }]);
    let release: () => void = () => undefined;
    engine = async (_d, id) => {
      if (id === "JOB-000001") await new Promise<void>((r) => (release = r));
      return dry;
    };
    await rt.autoApply(req({ jobIds: ["JOB-000001", "JOB-000002"] }));
    await until(() => calls.length === 1);
    rt.pause();
    release();
    await until(() => rt.phase === "PAUSED");
    expect(calls).toHaveLength(1);
    rt.resume();
    await rt.idle();
    expect(calls.map((c) => c.jobId)).toEqual(["JOB-000001", "JOB-000002"]);
  });

  it("STOP ALL: no further application starts; the waiting jobs stay queued; the run is recorded as stopped", async () => {
    await seed([{ id: "JOB-000001" }, { id: "JOB-000002" }, { id: "JOB-000003" }]);
    let release: () => void = () => undefined;
    engine = async () => {
      await new Promise<void>((r) => (release = r));
      return dry;
    };
    await rt.autoApply(req({ jobIds: ["JOB-000001", "JOB-000002", "JOB-000003"] }));
    await until(() => calls.length === 1);
    rt.stopAll();
    release();
    await rt.idle();
    expect(calls).toHaveLength(1);
    expect(rt.queue.pending()).toBe(2);
    expect(rt.sessionsList()[0]?.status).toBe("STOPPED");
  });

  it("skipping the current job stops it at the next checkpoint; the outcome is SKIPPED", async () => {
    await seed([{ id: "JOB-000001" }]);
    let reached: () => void = () => undefined;
    const atFill = new Promise<void>((r) => (reached = r));
    engine = async (deps) => {
      reached();
      await new Promise((r) => setTimeout(r, 50));
      const go = await deps.human?.checkpoint?.("before-fill");
      return go === "stop" ? { status: "NEEDS_HUMAN", reason: "stopped by you before the form was filled", screenshot: null } : dry;
    };
    await rt.autoApply(req({ jobIds: ["JOB-000001"] }));
    await atFill;
    rt.skipCurrentJob();
    await rt.idle();
    expect(rt.queue.list()[0]).toMatchObject({ status: "SKIPPED", outcome: "SKIPPED" });
  });
});

describe("ApplyPilot runtime — human in the loop", () => {
  it("new required question: the agent pauses, you answer, 'remember' saves it to the Answer Bank, the same application continues", async () => {
    await seed([{ id: "JOB-000001" }]);
    let got: unknown = null;
    engine = async (deps) => {
      got = await deps.human?.ask?.([{ label: "Have you contributed to an open-source project?", kind: "RADIO", options: ["Yes", "No"], required: true, reason: "no question-bank match" }]);
      return dry;
    };
    await rt.autoApply(req({ jobIds: ["JOB-000001"] }));
    await until(() => rt.tasks.list().some((t) => t.type === "NEW_QUESTION"));
    expect(rt.phase).toBe("WAITING_HUMAN");
    const task = rt.tasks.list().find((t) => t.type === "NEW_QUESTION");
    if (!task) throw new Error("no task");
    expect(task).toMatchObject({ blocking: true, jobId: "JOB-000001" });
    expect(task.why).toMatch(/never guesses/);
    rt.actOnTask(task.id, "answer", [{ label: "Have you contributed to an open-source project?", answer: "Yes", remember: true }]);
    await rt.idle();
    expect(got).toEqual([{ label: "Have you contributed to an open-source project?", answer: "Yes", remember: true }]);
    expect(fs.readFileSync(path.join(root, "Application_Answers.txt"), "utf8")).toMatch(/Have you contributed to an open-source project : Yes/);
    expect(rt.questions.some((q) => q.patterns.includes("have you contributed to an open source project"))).toBe(true);
    expect(rt.sessionsList()[0]).toMatchObject({ answersLearned: 1, humanInterventions: 1 });
    expect(rt.tasks.get(task.id)?.status).toBe("RESOLVED");
  });

  it("'answer once' is used for this application only and not saved", async () => {
    await seed([{ id: "JOB-000001" }]);
    engine = async (deps) => {
      await deps.human?.ask?.([{ label: "What interests you about Acme?", kind: "TEXTAREA", options: [], required: true, reason: "no match" }]);
      return dry;
    };
    await rt.autoApply(req({ jobIds: ["JOB-000001"] }));
    await until(() => rt.tasks.list().some((t) => t.type === "NEW_QUESTION"));
    const task = rt.tasks.list().find((t) => t.type === "NEW_QUESTION");
    rt.actOnTask(task?.id ?? "", "answer", [{ label: "What interests you about Acme?", answer: "The product", remember: false }]);
    await rt.idle();
    expect(fs.readFileSync(path.join(root, "Application_Answers.txt"), "utf8")).not.toMatch(/interests you/);
  });

  it("with question pausing off, the engine gets no ask hook (the application stops instead of guessing)", async () => {
    await seed([{ id: "JOB-000001" }]);
    let hasAsk = true;
    engine = async (deps) => {
      hasAsk = !!deps.human?.ask;
      return dry;
    };
    await rt.autoApply(req({ jobIds: ["JOB-000001"], pauseForQuestions: false }));
    await rt.idle();
    expect(hasAsk).toBe(false);
  });

  it("CAPTCHA: the agent waits; 'Continue' wakes it to re-check the page; the task closes when the page is clear", async () => {
    await seed([{ id: "JOB-000001" }]);
    const signals: string[] = [];
    engine = async (deps) => {
      const h = deps.human;
      h?.handoffStarted?.({ kind: "CAPTCHA", what: "CAPTCHA detected (.g-recaptcha)", url: "https://jobs.example/apply" });
      signals.push((await h?.handoffSignal?.()) ?? "none");
      h?.handoffEnded?.("cleared");
      return dry;
    };
    await rt.autoApply(req({ jobIds: ["JOB-000001"] }));
    await until(() => rt.tasks.list().some((t) => t.type === "CAPTCHA"));
    expect(rt.phase).toBe("WAITING_CAPTCHA");
    const task = rt.tasks.list().find((t) => t.type === "CAPTCHA");
    expect(task?.whatToDo).toMatch(/complete the step yourself/);
    expect(task?.why).toMatch(/never solves or bypasses/);
    expect(() => rt.actOnTask(task?.id ?? "", "approve")).toThrow(/not an action/);
    rt.actOnTask(task?.id ?? "", "continue");
    await rt.idle();
    expect(signals).toEqual(["continue"]);
    expect(rt.tasks.get(task?.id ?? "")?.status).toBe("RESOLVED");
  });

  it("review before submit: nothing is submitted until you approve; cancel means no submission", async () => {
    await seed([{ id: "JOB-000001" }, { id: "JOB-000002" }]);
    rt.armLive(true, "LIVE");
    const decisions: boolean[] = [];
    engine = async (deps) => {
      decisions.push((await deps.approve?.("summary")) ?? false);
      return dry;
    };
    await rt.autoApply(req({ jobIds: ["JOB-000001", "JOB-000002"], live: true, confirm: "LIVE" }));
    await until(() => rt.tasks.list().some((t) => t.type === "REVIEW_SUBMIT"));
    rt.actOnTask(rt.tasks.list().find((t) => t.type === "REVIEW_SUBMIT")?.id ?? "", "approve");
    await until(() => decisions.length === 1 && rt.tasks.list().some((t) => t.type === "REVIEW_SUBMIT"));
    rt.actOnTask(rt.tasks.list().find((t) => t.type === "REVIEW_SUBMIT")?.id ?? "", "reject");
    await rt.idle();
    expect(decisions).toEqual([true, false]);
  });

  it("a stopped application becomes a 'why did the agent stop' task; Retry puts it back in the queue", async () => {
    await seed([{ id: "JOB-000001" }]);
    engine = async () => ({ status: "NEEDS_HUMAN", reason: "no application form found at https://x (only 0 non-application field(s); unsupported flow)", screenshot: null });
    await rt.autoApply(req({ jobIds: ["JOB-000001"] }));
    await rt.idle();
    const task = rt.tasks.list().find((t) => t.type === "UNKNOWN_FORM");
    expect(task?.why).toMatch(/unexpected form/);
    expect(rt.queue.list()[0]).toMatchObject({ status: "HUMAN_REQUIRED", outcome: "NEEDS_ATTENTION" });
    await rt.retryJob("JOB-000001");
    expect(rt.queue.pending()).toBe(1);
    expect(rt.tasks.get(task?.id ?? "")?.status).toBe("RESOLVED");
  });
});
