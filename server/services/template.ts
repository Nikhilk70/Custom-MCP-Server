import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentError } from "../../agent/core/errors.ts";
import { fromRoot } from "../../agent/core/paths.ts";
import { sha256 } from "../../agent/core/text.ts";
import { patchMarkers, validateLatex } from "../../agent/resume/latex.ts";
import { renderAll } from "../../agent/resume/renderer.ts";
import { approveTemplate, readTemplate } from "../../agent/resume/templateGuard.ts";
import type { AgentRuntime } from "../runtime.ts";

const templatePath = (rt: AgentRuntime) => fromRoot(rt.base.cfg.resume.templatePath);

/** The LaTeX resume template (master.tex): view, preview as PDF, and save (a deliberate save is an approval). */
export function getTemplate(rt: AgentRuntime): Record<string, unknown> {
  const file = templatePath(rt);
  const { tex, info } = readTemplate(file);
  const shaFile = path.join(path.dirname(file), ".baseline", "master.sha256");
  const approved = fs.existsSync(shaFile) ? fs.readFileSync(shaFile, "utf8").trim().split(/\s+/)[0] === info.sha256 : false;
  const compiler = rt.base.compilers.find((c) => c.status().state === "READY");
  return { tex, path: rt.base.cfg.resume.templatePath, version: info.version, sha256: info.sha256, markers: info.markers, approved, compiler: compiler ? compiler.status().detail : null };
}

/**
 * Compiles the given LaTeX into a PDF in a scratch folder. withData=true fills the AUTO markers from MY_DATA exactly as
 * a generated resume would be (without job tailoring), so the preview shows your real resume.
 */
export async function previewTemplate(rt: AgentRuntime, stateDir: string, tex: string, withData: boolean): Promise<{ ok: boolean; id: string | null; log: string; errors: string[] }> {
  const v = validateLatex(tex);
  if (!v.ok) return { ok: false, id: null, log: "", errors: v.errors };
  const compiler = rt.base.compilers.find((c) => c.status().state === "READY");
  if (!compiler) throw new AgentError("NOT_CONFIGURED", "no LaTeX compiler is available — install MiKTeX/TeX Live or set LOCAL_LATEX_COMMAND");
  const body = withData ? patchMarkers(tex, renderAll(rt.profile, null, rt.base.cfg.resume)) : tex;
  const root = path.join(stateDir, "template-previews");
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const texPath = path.join(dir, "resume.tex");
  fs.writeFileSync(texPath, body);
  const r = await compiler.compile(texPath, dir);
  // Keep only the latest few previews.
  const all = fs.readdirSync(root).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 6))) fs.rmSync(path.join(root, old), { recursive: true, force: true });
  const errors = r.ok ? [] : r.log.split(/\r?\n/).filter((l) => l.startsWith("!") || /error/i.test(l)).slice(0, 8);
  return { ok: r.ok, id: r.ok ? id : null, log: r.log.slice(-3000), errors };
}

export function previewPdfPath(stateDir: string, id: string): string {
  if (!/^[a-z0-9]+-[a-f0-9]{6}$/.test(id)) throw new AgentError("VALIDATION_FAILED", "bad preview id");
  const p = path.join(stateDir, "template-previews", id, "resume.pdf");
  if (!fs.existsSync(p)) throw new AgentError("NOT_FOUND", "preview not found — compile again");
  return p;
}

export function saveTemplate(rt: AgentRuntime, stateDir: string, tex: string): Record<string, unknown> {
  const v = validateLatex(tex);
  if (!v.ok) throw new AgentError("VALIDATION_FAILED", `not saved — the template is invalid: ${v.errors.join("; ")}`);
  const file = templatePath(rt);
  const old = fs.readFileSync(file, "utf8");
  if (sha256(old) !== sha256(tex)) {
    const backups = path.join(stateDir, "template-backups");
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(path.join(backups, `master-${new Date().toISOString().replace(/[:.]/g, "-")}.tex`), old);
    fs.writeFileSync(file, tex);
  }
  approveTemplate(file, "edited and saved in ApplyPilot");
  return getTemplate(rt);
}
