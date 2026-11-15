import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../core/config.ts";
import type { AIProvider, ResumeProvider } from "../core/interfaces.ts";
import type { Logger } from "../core/logger.ts";
import { fromRoot } from "../core/paths.ts";
import { sanitizeFilenamePart, todayIso } from "../core/text.ts";
import { AgentError, errorMessage, toAgentError } from "../core/errors.ts";
import type { ResumeStatus, Store } from "../store/sheetStore.ts";
import { JobRepo, recordError } from "../store/repositories.ts";
import { recordTimeline, transition } from "../store/stateMachine.ts";
import type { Profile } from "../profile/profile.ts";
import { SkillIndex } from "../profile/profile.ts";
import { detectSkills } from "../matching/skillCatalog.ts";
import { analyzeAndScore, getLatestMatch, getRequirements } from "../matching/matchService.ts";
import { lineDiff, patchMarkers } from "./latex.ts";
import { assertTemplateApproved, readTemplate } from "./templateGuard.ts";
import { buildResumePlan, type ResumePlan } from "./planner.ts";
import { omittedByTemplate, renderAll } from "./renderer.ts";
import { pdfChecks, texChecks, type Check } from "./resumeValidation.ts";

export interface ResumeDeps {
  cfg: AppConfig;
  store: Store;
  logger: Logger;
  profile: Profile;
  compilers: ResumeProvider[];
  ai: AIProvider | null;
  runId: string | null;
}

export const COMPILER_BLOCK_REASON = "RESUME_COMPILER_NOT_CONFIGURED";

/** Accepts an AI-rephrased summary only if it introduces no technology or number absent from MY_DATA. */
export function validateAiSummary(text: string, profile: Profile): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const index = new SkillIndex(profile);
  for (const sk of detectSkills(text)) if (!index.has(sk)) problems.push(`mentions ${sk}, not in MY_DATA`);
  const facts = JSON.stringify([profile.professional, profile.experience, profile.projects, profile.education, profile.certifications]);
  for (const n of text.match(/\d+(?:[.,]\d+)?\+?%?/g) ?? []) if (!facts.includes(n.replace(/\+$/, ""))) problems.push(`number '${n}' not in MY_DATA`);
  if (/\b(years? of (professional )?experience|expert|senior|lead)\b/i.test(text)) problems.push("contains seniority/tenure claim");
  if (text.length > 700) problems.push("too long");
  return { ok: problems.length === 0, problems };
}

async function maybeAiSummary(deps: ResumeDeps, plan: ResumePlan): Promise<{ text: string | undefined; note: string }> {
  if (!deps.cfg.resume.generationRules.allowAiSummaryRewrite) return { text: undefined, note: "AI rewrite disabled (resume.json)" };
  if (!deps.ai || deps.ai.status().state !== "READY") return { text: undefined, note: "AI provider not ready; verbatim summary used" };
  const facts = deps.profile.professional.summaryFacts.join(" ");
  try {
    const out = await deps.ai.generateText(
      `Rewrite this professional summary in 2-3 sentences for a ${plan.jobTitle} role. Put these skills first if present: ${plan.skillsToEmphasize.slice(0, 8).join(", ")}.\nRules: use ONLY facts in the text below; do not add technologies, numbers, years, titles or achievements; no first person.\n\nSUMMARY:\n${facts}`,
      { system: "You rephrase resume text without adding facts.", temperature: 0.1, maxOutputTokens: 300 },
    );
    const v = validateAiSummary(out, deps.profile);
    return v.ok ? { text: out.replace(/\s+/g, " ").trim(), note: "AI-rephrased summary passed fact check" } : { text: undefined, note: `AI summary rejected: ${v.problems.join("; ")}` };
  } catch (err) {
    return { text: undefined, note: `AI summary failed: ${errorMessage(err)}` };
  }
}

export interface PreparedResume {
  resumeVersionId: string;
  outputDir: string;
  texPath: string;
  plan: ResumePlan;
  checks: Check[];
  ok: boolean;
}

/** Builds plan + tailored .tex and validates it structurally. Does not compile and does not change job status. */
export async function prepareResume(deps: ResumeDeps, jobId: string): Promise<PreparedResume> {
  const job = new JobRepo(deps.store).get(jobId);
  if (!job) throw new AgentError("NOT_FOUND", `job ${jobId} not found`);
  if (!job.jdText) throw new AgentError("VALIDATION_FAILED", `job ${jobId} has no JD; cannot tailor`);
  const templatePath = fromRoot(deps.cfg.resume.templatePath);
  const template = assertTemplateApproved(templatePath);
  const { tex: masterTex } = readTemplate(templatePath);

  let reqs = getRequirements(deps.store, jobId);
  let match = getLatestMatch(deps.store, jobId);
  if (!reqs || !match) ({ requirements: reqs, match } = analyzeAndScore(deps, job));
  const plan = buildResumePlan(job, reqs, match, deps.profile, deps.cfg.resume.generationRules);
  const ai = await maybeAiSummary(deps, plan);
  const tex = patchMarkers(masterTex, renderAll(deps.profile, plan, deps.cfg.resume, ai.text));
  const checks = texChecks(masterTex, tex, deps.profile, deps.cfg.resume.allowedSections);

  const date = todayIso();
  const resumeVersionId = `RV-${date}-${String(deps.store.nextSequence("resume")).padStart(6, "0")}`;
  const outputDir = path.join(fromRoot(deps.cfg.resume.outputRoot), date, jobId, resumeVersionId);
  fs.mkdirSync(outputDir, { recursive: true });
  const texPath = path.join(outputDir, "resume.tex");
  fs.writeFileSync(texPath, tex);
  fs.writeFileSync(path.join(outputDir, "resume-plan.json"), JSON.stringify({ ...plan, summaryNote: ai.note }, null, 2));
  fs.writeFileSync(path.join(outputDir, "changes.diff"), lineDiff(masterTex, tex));
  const ok = checks.every((c) => c.ok);
  const metadata = {
    jobId,
    resumeVersionId,
    generatedAt: new Date().toISOString(),
    templateVersion: template.version,
    templateSha256: template.sha256,
    profileHash: deps.profile.hash,
    changedSections: deps.cfg.resume.allowedSections,
    profileRenderedSections: deps.cfg.resume.profileRenderedSections,
    selectedProjects: plan.projectsToPrioritize.map((p) => p.projectId),
    selectedSkills: plan.skillsToEmphasize,
    skillsNotSupported: plan.skillsNotSupported,
    omittedBecauseTemplateHasNoSection: omittedByTemplate(deps.profile),
    summary: ai.note,
    validationStatus: ok ? "TEX_VALID" : "TEX_INVALID",
  };
  fs.writeFileSync(path.join(outputDir, "metadata.json"), JSON.stringify(metadata, null, 2));
  fs.writeFileSync(path.join(outputDir, "validation.json"), JSON.stringify({ stage: "tex", checks }, null, 2));
  deps.store.t.resumes.insert({
    resumeVersionId,
    jobId,
    generatedAt: metadata.generatedAt,
    status: ok ? "TEX_READY" : "VALIDATION_FAILED",
    outputDir: path.relative(fromRoot(), outputDir),
    texPath: path.relative(fromRoot(), texPath),
    pdfPath: null,
    compiler: null,
    templateSha256: template.sha256,
    validation: checks,
    error: ok ? null : checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; "),
  });
  return { resumeVersionId, outputDir, texPath, plan, checks, ok };
}

export interface GenerateOutcome {
  jobId: string;
  resumeVersionId: string | null;
  status: "GENERATED" | "COMPILE_BLOCKED" | "COMPILE_FAILED" | "VALIDATION_FAILED" | "ERROR";
  pdfPath: string | null;
  detail: string;
}

function pickCompiler(deps: ResumeDeps): ResumeProvider | null {
  const order = deps.cfg.resume.compiler.provider === "auto" ? deps.cfg.resume.compiler.order : deps.cfg.resume.compiler.provider === "none" ? [] : [deps.cfg.resume.compiler.provider];
  for (const id of order) {
    const c = deps.compilers.find((x) => x.id === id || x.id.startsWith(`${id === "local" ? "latex:local" : id}`));
    if (c && c.status().state === "READY") return c;
  }
  return null;
}

/** Full generation for one job: prepare → compile → validate PDF → store. Status only advances on verified success. */
export async function generateResume(deps: ResumeDeps, jobId: string): Promise<GenerateOutcome> {
  const repo = new JobRepo(deps.store);
  const job = repo.get(jobId);
  if (!job) throw new AgentError("NOT_FOUND", `job ${jobId} not found`);
  if (job.status === "BLOCKED" && job.blockReason === COMPILER_BLOCK_REASON) transition(deps.store, jobId, "READY_FOR_RESUME", { runId: deps.runId, reason: "retry after compiler block" });
  else if (job.status !== "READY_FOR_RESUME") throw new AgentError("INVALID_TRANSITION", `${jobId} is ${job.status}, expected READY_FOR_RESUME`);
  // Every job you add to the sheet gets a tailored resume: there is no eligibility gate (the match only orders skills).
  transition(deps.store, jobId, "RESUME_GENERATING", { runId: deps.runId, patch: { blockReason: null } });

  let prepared: PreparedResume;
  try {
    prepared = await prepareResume(deps, jobId);
  } catch (err) {
    const e = toAgentError(err);
    transition(deps.store, jobId, e.code === "TEMPLATE_TAMPERED" ? "BLOCKED" : "FAILED", { runId: deps.runId, reason: e.message, patch: { lastError: e.message, blockReason: e.code === "TEMPLATE_TAMPERED" ? "TEMPLATE_TAMPERED" : null } });
    recordError(deps.store, { runId: deps.runId, jobId, module: "resume", code: e.code, message: e.message });
    if (e.code === "TEMPLATE_TAMPERED") throw e; // stop the whole resume step
    return { jobId, resumeVersionId: null, status: "ERROR", pdfPath: null, detail: e.message };
  }
  const { resumeVersionId, outputDir } = prepared;
  const setVersion = (status: ResumeStatus, extra: { pdf?: string | null; compiler?: string | null; error?: string | null; validation?: Check[] } = {}) => {
    const cur = deps.store.t.resumes.get(resumeVersionId);
    deps.store.t.resumes.update(resumeVersionId, {
      status,
      pdfPath: extra.pdf ?? cur?.pdfPath ?? null,
      compiler: extra.compiler ?? cur?.compiler ?? null,
      error: extra.error ?? null,
      validation: extra.validation ?? cur?.validation ?? null,
    });
  };

  if (!prepared.ok) {
    const msg = prepared.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; ");
    transition(deps.store, jobId, "FAILED", { runId: deps.runId, reason: `resume validation failed: ${msg}`, patch: { lastError: msg } });
    return { jobId, resumeVersionId, status: "VALIDATION_FAILED", pdfPath: null, detail: msg };
  }

  const compiler = pickCompiler(deps);
  if (!compiler) {
    const detail = `no compiler available: ${deps.compilers.map((c) => `${c.id}=${c.status().state} (${c.status().detail})`).join("; ")}`;
    setVersion("COMPILE_BLOCKED", { error: detail });
    transition(deps.store, jobId, "BLOCKED", { runId: deps.runId, reason: detail, patch: { blockReason: COMPILER_BLOCK_REASON, resumeVersionId } });
    deps.logger.warn({ module: "resume", action: "compile", status: "blocked", jobId, errorCode: "NOT_CONFIGURED", message: `tex ready at ${prepared.texPath}; ${detail}` });
    return { jobId, resumeVersionId, status: "COMPILE_BLOCKED", pdfPath: null, detail };
  }

  const compiled = await deps.logger.time({ module: "resume", action: "compile", jobId, message: compiler.id }, () => compiler.compile(prepared.texPath, outputDir));
  fs.writeFileSync(path.join(outputDir, "compile.log"), compiled.log);
  if (!compiled.ok || !compiled.pdfPath || !fs.existsSync(compiled.pdfPath)) {
    setVersion("COMPILE_FAILED", { compiler: compiled.compiler, error: "compilation failed; see compile.log" });
    transition(deps.store, jobId, "FAILED", { runId: deps.runId, reason: "LaTeX compilation failed", patch: { lastError: `compile failed (${compiled.compiler}); see ${path.join(outputDir, "compile.log")}`, resumeVersionId } });
    return { jobId, resumeVersionId, status: "COMPILE_FAILED", pdfPath: null, detail: "compilation failed" };
  }

  const finalName = `${[sanitizeFilenamePart(job.companyName, 40), sanitizeFilenamePart(job.jobTitle, 50), jobId.replace(/[^A-Za-z0-9-]/g, "")].join("_")}.pdf`;
  const finalPdf = path.join(outputDir, finalName);
  fs.copyFileSync(compiled.pdfPath, finalPdf);
  const checks = [...prepared.checks, ...(await pdfChecks(finalPdf, deps.profile, deps.cfg.resume.maxPages, deps.cfg.resume.expectedSectionNames))];
  fs.writeFileSync(path.join(outputDir, "validation.json"), JSON.stringify({ stage: "pdf", checks }, null, 2));
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) {
    const msg = failed.map((c) => `${c.name}: ${c.detail}`).join("; ");
    setVersion("VALIDATION_FAILED", { pdf: path.relative(fromRoot(), finalPdf), compiler: compiled.compiler, error: msg, validation: checks });
    transition(deps.store, jobId, "FAILED", { runId: deps.runId, reason: `PDF validation failed: ${msg}`, patch: { lastError: msg, resumeVersionId } });
    return { jobId, resumeVersionId, status: "VALIDATION_FAILED", pdfPath: finalPdf, detail: msg };
  }
  setVersion("GENERATED", { pdf: path.relative(fromRoot(), finalPdf), compiler: compiled.compiler, validation: checks });
  // A copy of every validated resume in one easy folder (Resumes/), named Company_Role_JOB-id.pdf.
  try {
    fs.mkdirSync(fromRoot("Resumes"), { recursive: true });
    fs.copyFileSync(finalPdf, fromRoot("Resumes", finalName));
  } catch {
    // the copy is a convenience; the resume itself is already saved
  }
  const metaFile = path.join(outputDir, "metadata.json");
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, validationStatus: "PASSED", pdf: finalName, compiler: compiled.compiler }, null, 2));
  transition(deps.store, jobId, "RESUME_GENERATED", { runId: deps.runId, patch: { resumeVersionId, lastError: null, resumeFile: path.relative(fromRoot(), finalPdf) } });
  recordTimeline(deps.store, jobId, "RESUME_GENERATED", { runId: deps.runId, detail: { resumeVersionId, pdf: finalName } });
  transition(deps.store, jobId, "READY_TO_APPLY", { runId: deps.runId, reason: "resume generated and validated" });
  return { jobId, resumeVersionId, status: "GENERATED", pdfPath: finalPdf, detail: `validated (${checks.length} checks)` };
}

export async function generateResumes(deps: ResumeDeps, limit = 25): Promise<GenerateOutcome[]> {
  const repo = new JobRepo(deps.store);
  const hasCompiler = pickCompiler(deps) !== null;
  const queue = [...repo.byStatus(["READY_FOR_RESUME"], limit), ...(hasCompiler ? repo.byStatus(["BLOCKED"], limit).filter((j) => j.blockReason === COMPILER_BLOCK_REASON) : [])].slice(0, limit);
  const out: GenerateOutcome[] = [];
  for (const job of queue) {
    try {
      out.push(await generateResume(deps, job.jobId));
      await deps.store.flush();
    } catch (err) {
      const e = toAgentError(err);
      out.push({ jobId: job.jobId, resumeVersionId: null, status: "ERROR", pdfPath: null, detail: e.message });
      if (e.code === "TEMPLATE_TAMPERED") break;
    }
  }
  return out;
}
