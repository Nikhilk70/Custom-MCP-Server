import path from "node:path";
import { AgentError } from "../agent/core/errors.ts";
import { fromRoot, paths } from "../agent/core/paths.ts";
import type { JobRecord } from "../agent/core/schemas.ts";
import { JobRepo } from "../agent/store/repositories.ts";
import { markApplied } from "../agent/store/jobActions.ts";
import { canTransition, getTimeline, transition } from "../agent/store/stateMachine.ts";
import type { Store } from "../agent/store/sheetStore.ts";
import type { QuestionAnswer } from "../agent/application/humanBridge.ts";
import { ACTIVITY_CATEGORIES, type ActivityCategory } from "./events.ts";
import { HttpError, Router, safeJoin, sendFile, type Req } from "./http.ts";
import { explainStop, PENDING, type AgentRuntime, type AutoApplyRequest, type Settings } from "./runtime.ts";
import { profileView, saveProfile } from "./services/profile.ts";
import { deleteUpload, listResumes, resumeFile, saveUpload } from "./services/resumes.ts";
import { forgetAutofill, resumeAutofill } from "./services/resumeAutofill.ts";
import { importResume, undoImport } from "./services/resumeImport.ts";
import { getTemplate, previewPdfPath, previewTemplate, saveTemplate } from "./services/template.ts";

const str = (v: unknown, name: string, max = 2000): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new HttpError(400, "BAD_REQUEST", `'${name}' is required`);
  return v;
};
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);
const num = (v: string | null): number | undefined => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** One row of the Jobs page. */
function jobRow(store: Store, j: JobRecord, queued: boolean) {
  const resume = j.resumeVersionId ? store.t.resumes.get(j.resumeVersionId) : null;
  const app = store.t.applications.get(j.jobId);
  const m = store.t.details.get(j.jobId)?.match ?? null;
  return {
    jobId: j.jobId,
    company: j.companyName,
    title: j.jobTitle,
    location: j.location,
    applyUrl: j.applyUrl,
    status: j.status,
    queued,
    hasJd: !!j.jdText,
    matchScore: j.matchScore,
    source: j.source,
    postedDate: j.postedDate,
    workMode: j.workMode,
    fit: m ? (m.eligible ? "GOOD" : "LOW") : null,
    fitReason: m ? (m.eligible ? null : m.eligibilityReason) : null,
    experienceFit: m?.experienceCompatibility ?? null,
    roleFit: m?.roleCompatibility ?? null,
    matchedSkills: m ? m.matchedSkills.map((s) => s.skill).slice(0, 12) : [],
    missingSkills: m ? m.missingSkills.slice(0, 12) : [],
    resumeId: resume?.status === "GENERATED" && resume.pdfPath ? resume.resumeVersionId : null,
    applicationStatus: app?.status ?? null,
    submittedAt: app?.submittedAt ?? null,
    lastError: j.lastError,
    blockReason: j.blockReason,
    updatedAt: j.updatedAt,
  };
}

export function buildApi(rt: AgentRuntime, opts: { stateDir: string; token: string }): Router {
  const r = new Router();

  r.get("/api/session", async () => ({ token: opts.token, app: "ApplyPilot", demo: rt.demo }));
  r.get("/api/state", async () => rt.state());
  r.post("/api/refresh", async () => {
    await rt.refresh();
    return rt.state();
  });

  // ------------------------------------------------------------------ jobs (from your sheet)
  r.post("/api/sheet/sync", async () => rt.startSync());
  r.post("/api/jobs/find", async () => rt.startFind());
  r.get("/api/jobs", async () => {
    const store = rt.requireStore();
    const items = new JobRepo(store)
      .all()
      .filter((j) => j.status !== "DUPLICATE")
      .map((j) => jobRow(store, j, !!rt.queue.activeFor(j.jobId)))
      .sort((a, b) => b.jobId.localeCompare(a.jobId));
    // What each "apply to all" choice would pick up — the same rules autoApply uses.
    const all = new JobRepo(store).all();
    const applyCounts = { matched: all.filter((j) => j.status === "MATCHED").length, pending: all.filter((j) => PENDING.includes(j.status)).length };
    return { items, newRows: store.t.jobs.orphans.length, applyCounts };
  });
  r.get("/api/jobs/:id", async (req) => {
    const store = rt.requireStore();
    const id = req.params.id ?? "";
    const job = new JobRepo(store).get(id);
    if (!job) throw new AgentError("NOT_FOUND", `job ${id} not found`);
    const app = store.t.applications.get(id);
    const details = store.t.details.get(id);
    return {
      job: jobRow(store, job, !!rt.queue.activeFor(id)),
      jdText: job.jdText,
      jdSource: details?.jdSource ?? null,
      skills: job.skills,
      match: (() => {
        const m = details?.match;
        if (!m) return null;
        return {
          score: m.technicalMatchScore,
          eligible: m.eligible,
          reason: m.reason,
          eligibilityReason: m.eligibilityReason,
          role: { family: m.role.jobFamily, compatible: m.roleCompatibility === "COMPATIBLE", why: m.role.reason },
          experienceFit: m.experienceCompatibility,
          gates: m.gates,
          matchedSkills: m.matchedSkills.map((s) => ({ skill: s.skill, level: s.level })),
          missingSkills: m.missingSkills,
          components: Object.entries(m.components).map(([name, c]) => ({ name, weight: c.weight, score: c.score, detail: c.detail })),
          riskFlags: m.riskFlags,
        };
      })(),
      requirements: details?.requirements ? { minYears: details.requirements.minYearsExperience, maxYears: details.requirements.maxYearsExperience, experienceText: details.requirements.experienceText, education: details.requirements.educationRequirements } : null,
      application: app ? { status: app.status, mode: app.mode, attempts: app.attempts, startedAt: app.startedAt, submittedAt: app.submittedAt, verifiedAt: app.verifiedAt, screenshot: app.screenshotPath, evidence: app.evidence, url: app.url } : null,
      whyStopped: job.blockReason ? explainStop(job.blockReason) : job.lastError,
      timeline: getTimeline(store, id),
      tasks: rt.tasks.list({ status: "ALL" }).filter((t) => t.jobId === id),
    };
  });
  r.post("/api/jobs/auto-apply", async (req) => {
    const b = await req.json<Partial<AutoApplyRequest>>();
    return rt.autoApply(applyRequest(b, b.scope ?? "selected"));
  });
  r.post("/api/jobs/skip", async (req) => {
    const b = await req.json<{ jobIds?: string[] }>();
    const ids = Array.isArray(b.jobIds) ? b.jobIds.filter((x) => typeof x === "string") : [];
    if (!ids.length) throw new HttpError(400, "BAD_REQUEST", "jobIds required");
    return rt.withStore((store) => {
      const out: Array<{ jobId: string; ok: boolean; detail: string }> = [];
      for (const id of ids) {
        const job = store.t.jobs.get(id);
        if (!job) out.push({ jobId: id, ok: false, detail: "not found" });
        else if (rt.queue.activeFor(id)) out.push({ jobId: id, ok: false, detail: "in the queue — skip it there" });
        else if (!canTransition(job.status, "SKIPPED")) out.push({ jobId: id, ok: false, detail: `cannot skip a ${job.status} job` });
        else {
          transition(store, id, "SKIPPED", { reason: "skipped by you in ApplyPilot" });
          out.push({ jobId: id, ok: true, detail: "skipped" });
        }
      }
      rt.bus.push({ kind: "jobs" });
      return out;
    });
  });
  r.post("/api/jobs/:id/retry", async (req) => {
    await rt.retryJob(req.params.id ?? "");
    return { queued: true };
  });
  r.post("/api/jobs/:id/mark-applied", async (req) => {
    const b = await req.json<{ evidence?: string }>();
    const evidence = str(b.evidence, "evidence");
    const out = await rt.withStore((store) => markApplied(store, req.params.id ?? "", evidence));
    for (const t of rt.tasks.list().filter((x) => x.jobId === req.params.id && !x.blocking)) rt.tasks.close(t.id, "RESOLVED", "marked applied");
    rt.bus.emit({ type: "APPLICATION_MARKED_APPLIED", category: "applications", level: "success", message: `${req.params.id ?? ""} marked applied with your evidence`, jobId: req.params.id ?? null });
    rt.bus.push({ kind: "jobs" });
    return out;
  });
  r.get("/api/files/screenshot", async (req, res) => {
    const file = safeJoin(paths.screenshots(), path.relative(paths.screenshots(), fromRoot(str(req.query.get("path"), "path", 400))), [".png", ".jpg"]);
    sendFile(res, file);
  });

  // ------------------------------------------------------------------ agent (the browser that applies)
  r.post("/api/agent/start", async (req) => {
    const b = await req.json<Partial<AutoApplyRequest>>();
    return rt.autoApply(applyRequest(b, "queued"));
  });
  r.post("/api/agent/pause", async () => {
    rt.pause();
    return rt.state();
  });
  r.post("/api/agent/resume", async () => {
    rt.resume();
    return rt.state();
  });
  r.post("/api/agent/stop", async () => {
    rt.stopAll();
    return rt.state();
  });
  r.post("/api/agent/skip", async () => {
    rt.skipCurrentJob();
    return rt.state();
  });
  r.post("/api/agent/focus", async () => ({ focused: rt.bringBrowserToFront() }));
  r.get("/api/agent/preview.jpg", async (_req, res) => {
    const img = await rt.previewJpeg();
    if (!img) {
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store", "content-length": img.length });
    res.end(img);
  });
  r.get("/api/queue", async () => ({ items: rt.queue.list(), current: rt.current }));
  r.post("/api/queue/:id/skip", async (req) => {
    const item = rt.queue.get(req.params.id ?? "");
    if (!item) throw new AgentError("NOT_FOUND", "queue item not found");
    if (item.status === "RUNNING") rt.skipCurrentJob();
    else rt.queue.skip(item.id);
    rt.bus.push({ kind: "queue" });
    return rt.queue.get(item.id);
  });
  r.post("/api/queue/:id/retry", async (req) => {
    const item = rt.queue.get(req.params.id ?? "");
    if (!item) throw new AgentError("NOT_FOUND", "queue item not found");
    await rt.retryJob(item.jobId);
    return rt.queue.list();
  });
  r.post("/api/queue/cancel", async () => {
    const n = rt.queue.cancelAll();
    rt.bus.push({ kind: "queue" });
    rt.bus.emit({ type: "QUEUE_CANCELLED", category: "system", level: "warn", message: `Queue cancelled: ${n} waiting job(s) removed` });
    return { cancelled: n };
  });
  r.post("/api/queue/clear", async () => {
    const n = rt.queue.clearFinished();
    rt.bus.push({ kind: "queue" });
    return { cleared: n };
  });

  // ------------------------------------------------------------------ things only you can do (CAPTCHA, questions, review)
  r.get("/api/tasks", async (req) => {
    const s = req.query.get("status");
    return rt.tasks.list({ status: s === "ALL" || s === "RESOLVED" || s === "SKIPPED" || s === "EXPIRED" ? s : "PENDING" });
  });
  r.post("/api/tasks/:id", async (req) => {
    const b = await req.json<{ action?: string; answers?: QuestionAnswer[] }>();
    const action = b.action;
    if (!action || !["continue", "skip", "approve", "reject", "answer", "dismiss"].includes(action)) throw new HttpError(400, "BAD_REQUEST", "unknown action");
    const answers = Array.isArray(b.answers)
      ? b.answers.map((a) => ({ label: str(a.label, "label", 1000), answer: typeof a.answer === "string" ? a.answer.slice(0, 2000) : "", remember: a.remember === true }))
      : undefined;
    return rt.actOnTask(req.params.id ?? "", action as "continue", answers);
  });

  // ------------------------------------------------------------------ resume: profile, uploads, LaTeX template
  r.get("/api/profile", async () => profileView(rt));
  r.patch("/api/profile", async (req) => {
    const b = await req.json<{ fields?: Array<{ key: string; value: string }> }>();
    if (!Array.isArray(b.fields)) throw new HttpError(400, "BAD_REQUEST", "fields required");
    return saveProfile(rt, b.fields);
  });
  const importBackups = path.join(opts.stateDir, "resume-imports");
  r.get("/api/resumes", async () => ({ items: listResumes(rt), useUploadedResume: rt.settings.useUploadedResume, primaryResumeId: rt.settings.primaryResumeId }));
  r.post("/api/resumes", async (req) => {
    if (!/application\/pdf/.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "UNSUPPORTED_MEDIA", "upload a PDF (content-type application/pdf)");
    const body = await req.bytes(10 * 1024 * 1024);
    const item = saveUpload(rt, req.query.get("name") ?? "resume.pdf", body, req.query.get("label"), req.query.get("purpose"));
    // By default the upload becomes your resume data (MY_DATA, Source, resume answers). A failed import never fails
    // the upload; Edit profile is then pre-filled from the resume instead, for you to review.
    let imported = null;
    let importError: string | null = null;
    if (req.query.get("import") !== "0") {
      try {
        imported = await importResume(rt, item.id, importBackups);
      } catch (e) {
        importError = e instanceof Error ? e.message : String(e);
      }
    }
    let autofill = null;
    let autofillError: string | null = null;
    if (!imported) {
      try {
        autofill = await resumeAutofill(rt, item.id);
      } catch (e) {
        autofillError = e instanceof Error ? e.message : String(e);
      }
    }
    return { ...item, imported, importError, autofill, autofillError };
  });
  r.post("/api/resumes/:id/import", async (req) => importResume(rt, req.params.id ?? "", importBackups));
  r.post("/api/resume-imports/:importId/undo", async (req) => undoImport(rt, req.params.importId ?? "", importBackups));
  r.get("/api/resumes/autofill", async (req) => ({ autofill: await resumeAutofill(rt, req.query.get("id"), { refresh: req.query.get("refresh") === "1" }) }));
  r.post("/api/resumes/primary", async (req) => {
    const b = await req.json<{ id?: string | null; use?: boolean }>();
    return rt.updateSettings({ primaryResumeId: typeof b.id === "string" ? b.id : null, useUploadedResume: bool(b.use, false) });
  });
  r.delete("/api/resumes/:id", async (req) => {
    deleteUpload(rt, req.params.id ?? "");
    forgetAutofill(rt, req.params.id ?? "");
    return { ok: true };
  });
  r.get("/api/resumes/:id/file", async (req, res) => {
    sendFile(res, resumeFile(rt, req.params.id ?? ""));
  });
  r.get("/api/template", async () => getTemplate(rt));
  r.post("/api/template/preview", async (req) => {
    const b = await req.json<{ tex?: string; withData?: boolean }>();
    return previewTemplate(rt, opts.stateDir, str(b.tex, "tex", 400_000), b.withData === true);
  });
  r.get("/api/template/pdf/:id", async (req, res) => {
    sendFile(res, previewPdfPath(opts.stateDir, req.params.id ?? ""), req.query.get("download") === "1" ? { download: "resume.pdf" } : {});
  });
  r.post("/api/template", async (req) => {
    const b = await req.json<{ tex?: string }>();
    return saveTemplate(rt, opts.stateDir, str(b.tex, "tex", 400_000));
  });

  // ------------------------------------------------------------------ activity, notifications, settings
  r.get("/api/activity", async (req) => {
    const c = req.query.get("category");
    return rt.bus.recent({ category: c && (ACTIVITY_CATEGORIES as readonly string[]).includes(c) ? (c as ActivityCategory) : null, jobId: req.query.get("jobId"), limit: Math.min(num(req.query.get("limit")) ?? 200, 1000) });
  });
  r.get("/api/notifications", async () => ({ items: rt.notifications.list(), unread: rt.notifications.unread() }));
  r.post("/api/notifications/clear", async () => {
    rt.notifications.clear();
    rt.pushState();
    return { unread: 0 };
  });
  r.post("/api/notifications/read", async (req) => {
    const b = await req.json<{ id?: string }>();
    rt.notifications.markRead(typeof b.id === "string" ? b.id : null);
    rt.pushState();
    return { unread: rt.notifications.unread() };
  });
  r.get("/api/settings", async () => ({ settings: rt.settings, liveArmed: rt.liveArmed, defaults: { dryRun: rt.base.cfg.dryRun, mode: rt.base.cfg.application.mode }, sheetId: rt.base.cfg.env.GOOGLE_SHEETS_SPREADSHEET_ID ?? null }));
  r.patch("/api/settings", async (req) => {
    const b = await req.json<Partial<Settings>>();
    const allowed: Array<keyof Settings> = ["delayBetweenApplicationsSec", "dailyLiveLimit", "maxApplicationsPerRun", "browserNotifications"];
    const patch: Partial<Settings> = {};
    for (const k of allowed) if (k in b) (patch as Record<string, unknown>)[k] = b[k];
    return rt.updateSettings(patch);
  });
  r.post("/api/settings/live", async (req) => {
    const b = await req.json<{ armed?: boolean; confirm?: string }>();
    rt.armLive(b.armed === true, b.confirm);
    return rt.state();
  });
  return r;
}

function applyRequest(b: Partial<AutoApplyRequest>, scope: AutoApplyRequest["scope"]): AutoApplyRequest {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 500) : undefined);
  return {
    scope: b.scope === "pending" || b.scope === "matched" || b.scope === "queued" || b.scope === "selected" ? b.scope : scope,
    jobIds: list(b.jobIds),
    live: b.live === true,
    confirm: typeof b.confirm === "string" ? b.confirm : undefined,
    requireReview: b.requireReview !== false,
    pauseForQuestions: b.pauseForQuestions !== false,
    pauseForHuman: b.pauseForHuman !== false,
    maxApplications: typeof b.maxApplications === "number" ? b.maxApplications : undefined,
    delaySeconds: typeof b.delaySeconds === "number" ? b.delaySeconds : undefined,
  };
}

export type { Req };
