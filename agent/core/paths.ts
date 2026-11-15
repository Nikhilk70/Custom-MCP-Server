import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Nearest ancestor containing package.json — works from agent/core (tsx) and dist/agent/core (build). */
function findRoot(start: string): string {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "config"))) return dir;
    if (path.dirname(dir) === dir) return path.resolve(start, "..", "..");
  }
}

/** Project root. Overridable with AUTO_JOB_AGENT_ROOT or setProjectRoot() (tests). */
const defaultRoot = findRoot(path.dirname(fileURLToPath(import.meta.url)));

let root = process.env.AUTO_JOB_AGENT_ROOT ? path.resolve(process.env.AUTO_JOB_AGENT_ROOT) : defaultRoot;

export function projectRoot(): string {
  return root;
}

/** Test hook: point every path helper at a temporary project directory. */
export function setProjectRoot(dir: string): void {
  root = path.resolve(dir);
}

export function fromRoot(...parts: string[]): string {
  return path.resolve(root, ...parts);
}

export const paths = {
  companies: () => fromRoot("Companies"),
  myData: () => fromRoot("Data_Resume", "MY_DATA"),
  resumeSource: () => fromRoot("Data_Resume", "Source"),
  templateDir: () => fromRoot("Data_Resume", "Resume_Template"),
  generated: () => fromRoot("Data_Resume", "Generated"),
  questions: () => fromRoot("Application_Questions"),
  jobs: (sub: "Raw" | "Processed" | "Matched" | "Applied") => fromRoot("Jobs", sub),
  logs: () => fromRoot("Applications", "Logs"),
  screenshots: () => fromRoot("Applications", "Screenshots"),
  errors: () => fromRoot("Applications", "Errors"),
  reports: () => fromRoot("Applications", "Reports"),
  config: (file: string) => fromRoot("config", file),
  runtime: () => fromRoot("runtime"),
};
