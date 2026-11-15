import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentError } from "../../agent/core/errors.ts";
import { fromRoot } from "../../agent/core/paths.ts";
import type { AgentRuntime } from "../runtime.ts";

export interface ResumeItem {
  id: string;
  kind: "UPLOADED" | "TAILORED";
  file: string;
  label: string;
  /** Designed for multiple resumes per purpose (Java, Frontend, AI/ML, Full Stack). */
  purpose: string | null;
  jobId: string | null;
  company: string | null;
  updatedAt: string;
  sizeBytes: number | null;
  sha256: string | null;
  primary: boolean;
  status: string;
}

interface UploadMeta {
  [id: string]: { label: string; purpose: string | null; uploadedAt: string; sha256: string };
}

const META = (dir: string) => path.join(dir, "resumes.json");
const readMeta = (dir: string): UploadMeta => {
  try {
    return JSON.parse(fs.readFileSync(META(dir), "utf8")) as UploadMeta;
  } catch {
    return {};
  }
};

export function listResumes(rt: AgentRuntime): ResumeItem[] {
  const dir = rt.uploadsDir;
  const meta = readMeta(dir);
  const out: ResumeItem[] = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith(".pdf"))) {
      const st = fs.statSync(path.join(dir, f));
      const m = meta[f];
      out.push({ id: f, kind: "UPLOADED", file: f, label: m?.label ?? f.replace(/\.pdf$/i, "").replace(/[_-]+/g, " "), purpose: m?.purpose ?? null, jobId: null, company: null, updatedAt: m?.uploadedAt ?? st.mtime.toISOString(), sizeBytes: st.size, sha256: m?.sha256 ?? null, primary: rt.settings.primaryResumeId === f, status: "READY" });
    }
  }
  for (const r of rt.store?.t.resumes.all() ?? []) {
    if (!r.pdfPath) continue;
    const job = rt.store?.t.jobs.get(r.jobId);
    out.push({ id: r.resumeVersionId, kind: "TAILORED", file: path.basename(r.pdfPath), label: `Tailored for ${job?.companyName ?? r.jobId}`, purpose: job?.jobTitle ?? null, jobId: r.jobId, company: job?.companyName ?? null, updatedAt: r.generatedAt, sizeBytes: fs.existsSync(fromRoot(r.pdfPath)) ? fs.statSync(fromRoot(r.pdfPath)).size : null, sha256: r.templateSha256 ? `template ${r.templateSha256.slice(0, 10)}` : null, primary: false, status: r.status });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Stores an uploaded PDF (checked to be a PDF, ≤10 MB) in the local, git-ignored uploads folder. */
export function saveUpload(rt: AgentRuntime, name: string, body: Buffer, label: string | null, purpose: string | null): ResumeItem {
  if (body.length < 100 || body.subarray(0, 5).toString("latin1") !== "%PDF-") throw new AgentError("VALIDATION_FAILED", "that file is not a PDF");
  const safe = (name || "resume.pdf").replace(/\.pdf$/i, "").replace(/[^\w.-]+/g, "_").replace(/^[._]+/, "").slice(0, 80) || "resume";
  const dir = rt.uploadsDir;
  fs.mkdirSync(dir, { recursive: true });
  let file = `${safe}.pdf`;
  for (let i = 2; fs.existsSync(path.join(dir, file)); i++) file = `${safe}_${i}.pdf`;
  fs.writeFileSync(path.join(dir, file), body);
  const meta = readMeta(dir);
  meta[file] = { label: label?.trim() || safe.replace(/[_-]+/g, " "), purpose: purpose?.trim() || null, uploadedAt: new Date().toISOString(), sha256: crypto.createHash("sha256").update(body).digest("hex") };
  fs.writeFileSync(META(dir), JSON.stringify(meta, null, 2));
  const item = listResumes(rt).find((r) => r.id === file);
  if (!item) throw new AgentError("INTERNAL", "upload not found after saving");
  return item;
}

export function deleteUpload(rt: AgentRuntime, id: string): void {
  const p = rt.primaryResumePath(id);
  if (!p) throw new AgentError("NOT_FOUND", "resume not found");
  if (rt.settings.primaryResumeId === id) rt.updateSettings({ primaryResumeId: null, useUploadedResume: false });
  fs.rmSync(p);
  const meta = readMeta(rt.uploadsDir);
  delete meta[id];
  fs.writeFileSync(META(rt.uploadsDir), JSON.stringify(meta, null, 2));
}

export function resumeFile(rt: AgentRuntime, id: string): string {
  const up = rt.primaryResumePath(id);
  if (up) return up;
  const row = rt.store?.t.resumes.get(id);
  if (!row?.pdfPath) throw new AgentError("NOT_FOUND", "resume not found");
  const abs = path.resolve(fromRoot(row.pdfPath));
  if (!abs.startsWith(path.resolve(fromRoot())) || !abs.toLowerCase().endsWith(".pdf") || !fs.existsSync(abs)) throw new AgentError("NOT_FOUND", "resume file missing");
  return abs;
}
