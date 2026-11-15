import fs from "node:fs";
import path from "node:path";
import { AgentError } from "../core/errors.ts";
import { sha256 } from "../core/text.ts";
import { validateLatex, findMarkers } from "./latex.ts";

export interface TemplateInfo {
  path: string;
  sha256: string;
  version: string;
  markers: string[];
}

function baselineDir(templatePath: string): string {
  return path.join(path.dirname(templatePath), ".baseline");
}

export function readTemplate(templatePath: string): { tex: string; info: TemplateInfo } {
  if (!fs.existsSync(templatePath)) throw new AgentError("NOT_FOUND", `resume template missing: ${templatePath}`);
  const tex = fs.readFileSync(templatePath, "utf8");
  const v = validateLatex(tex);
  if (!v.ok) throw new AgentError("VALIDATION_FAILED", `master.tex is invalid: ${v.errors.join("; ")}`);
  const version = /template-version:\s*([\w.-]+)/.exec(tex)?.[1] ?? "unversioned";
  return { tex, info: { path: templatePath, sha256: sha256(tex), version, markers: findMarkers(tex).map((m) => m.name) } };
}

/**
 * Compares master.tex against the approved baseline. The first call records the baseline.
 * Any later change throws TEMPLATE_TAMPERED until approveTemplate() is run deliberately.
 */
export function assertTemplateApproved(templatePath: string): TemplateInfo {
  const { tex, info } = readTemplate(templatePath);
  const dir = baselineDir(templatePath);
  const shaFile = path.join(dir, "master.sha256");
  if (!fs.existsSync(shaFile)) {
    approveTemplate(templatePath, "initial baseline recorded on first use");
    return info;
  }
  const approved = fs.readFileSync(shaFile, "utf8").trim().split(/\s+/)[0];
  if (approved !== info.sha256) {
    throw new AgentError(
      "TEMPLATE_TAMPERED",
      `master.tex changed since it was approved (approved ${approved?.slice(0, 12)}, now ${info.sha256.slice(0, 12)}). Review the change, then run: npm run template:approve`,
    );
  }
  void tex;
  return info;
}

export function approveTemplate(templatePath: string, note = "approved by user"): TemplateInfo {
  const { tex, info } = readTemplate(templatePath);
  const dir = baselineDir(templatePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "master.sha256"), `${info.sha256}  master.tex\n`);
  fs.writeFileSync(path.join(dir, `master.${info.sha256.slice(0, 12)}.tex`), tex);
  fs.appendFileSync(path.join(dir, "approvals.log"), `${new Date().toISOString()} ${info.sha256} v${info.version} — ${note}\n`);
  return info;
}
