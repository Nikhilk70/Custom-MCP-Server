import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { CompileResult, IntegrationStatus, ResumeProvider } from "../../agent/core/interfaces.ts";

type Engine = "latexmk" | "pdflatex" | "tectonic";

export function findExecutable(name: string): string | null {
  const probe = process.platform === "win32" ? spawnSync("where", [name], { encoding: "utf8" }) : spawnSync("which", [name], { encoding: "utf8" });
  if (probe.status !== 0) return null;
  return probe.stdout.split(/\r?\n/).find((l) => l.trim())?.trim() ?? null;
}

/** Local TeX fallback. Only used when a real engine is found on PATH (or LOCAL_LATEX_COMMAND points to one). */
export class LocalLatexProvider implements ResumeProvider {
  readonly id = "latex:local";
  private readonly engine: { name: Engine; path: string } | null;

  constructor(private readonly opts: { candidates: Engine[]; explicitCommand?: string | undefined; timeoutMs: number }) {
    this.engine = this.detect();
  }

  private detect(): { name: Engine; path: string } | null {
    if (this.opts.explicitCommand) {
      const base = path.basename(this.opts.explicitCommand).replace(/\.exe$/i, "") as Engine;
      if (fs.existsSync(this.opts.explicitCommand) && ["latexmk", "pdflatex", "tectonic"].includes(base)) return { name: base, path: this.opts.explicitCommand };
    }
    for (const c of this.opts.candidates) {
      const p = findExecutable(c);
      if (p) return { name: c, path: p };
    }
    return null;
  }

  status(): IntegrationStatus {
    return this.engine
      ? { id: this.id, state: "READY", detail: `${this.engine.name} at ${this.engine.path}` }
      : { id: this.id, state: "NOT_CONFIGURED", detail: `no LaTeX engine on PATH (looked for ${this.opts.candidates.join(", ")}); install MiKTeX or TeX Live (pdfLaTeX), or set LOCAL_LATEX_COMMAND` };
  }

  async compile(texPath: string, outDir: string): Promise<CompileResult> {
    if (!this.engine) return { ok: false, pdfPath: null, log: this.status().detail, compiler: this.id };
    const texName = path.basename(texPath);
    const cwd = path.dirname(texPath);
    const args: Record<Engine, string[]> = {
      latexmk: ["-pdf", "-interaction=nonstopmode", "-halt-on-error", `-outdir=${outDir}`, texName],
      pdflatex: ["-interaction=nonstopmode", "-halt-on-error", `-output-directory=${outDir}`, texName],
      tectonic: ["--outdir", outDir, texName],
    };
    let log = "";
    const runs = this.engine.name === "pdflatex" ? 2 : 1; // second pass settles hyperref
    for (let i = 0; i < runs; i++) {
      const r = spawnSync(this.engine.path, args[this.engine.name], { cwd, encoding: "utf8", timeout: this.opts.timeoutMs, windowsHide: true });
      log += `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
      if (r.error || r.status !== 0) return { ok: false, pdfPath: null, log: `${log}\n${r.error?.message ?? `exit ${String(r.status)}`}`.slice(-8000), compiler: `${this.id}:${this.engine.name}` };
    }
    const pdf = path.join(outDir, texName.replace(/\.tex$/, ".pdf"));
    const ok = fs.existsSync(pdf) && fs.statSync(pdf).size > 0;
    return { ok, pdfPath: ok ? pdf : null, log: log.slice(-8000), compiler: `${this.id}:${this.engine.name}` };
  }
}
