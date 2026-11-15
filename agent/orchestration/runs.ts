import crypto from "node:crypto";
import type { Store } from "../store/sheetStore.ts";

export type RunStatus = "RUNNING" | "COMPLETED" | "COMPLETED_WITH_ERRORS" | "FAILED" | "INTERRUPTED";

export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `RUN-${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

/**
 * Starts a run. If a run of the same kind from today was interrupted (still RUNNING, e.g. the
 * process was killed), it is resumed with the same id so completed steps are skipped.
 */
export function startRun(store: Store, kind: string, opts: { dryRun: boolean; mode: string; resume?: boolean; now?: Date }): { runId: string; resumed: boolean } {
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  if (opts.resume !== false) {
    const open = store.t.runs
      .filter((r) => r.kind === kind && (r.status === "RUNNING" || r.status === "INTERRUPTED") && r.startedAt.startsWith(today) && r.dryRun === opts.dryRun)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (open) {
      store.t.runs.update(open.runId, { status: "RUNNING" });
      return { runId: open.runId, resumed: true };
    }
  }
  for (const r of store.t.runs.filter((x) => x.kind === kind && x.status === "RUNNING")) store.t.runs.update(r.runId, { status: "INTERRUPTED" });
  const runId = newRunId(now);
  store.t.runs.insert({ runId, kind, startedAt: now.toISOString(), finishedAt: null, status: "RUNNING", dryRun: opts.dryRun, mode: opts.mode, currentStep: null, summary: null });
  return { runId, resumed: false };
}

export function finishRun(store: Store, runId: string, status: RunStatus, summary: unknown): void {
  store.t.runs.update(runId, { status, finishedAt: new Date().toISOString(), currentStep: null, summary });
}

const stepKey = (runId: string, step: string) => `${runId}|${step}`;

export function stepDone(store: Store, runId: string, step: string): boolean {
  return store.t.steps.get(stepKey(runId, step))?.status === "DONE";
}

/**
 * Runs a step once per run and flushes the spreadsheet afterwards (the durability checkpoint).
 * Failures are recorded and returned, never thrown, so later steps still run.
 */
export async function runStep<T>(store: Store, runId: string, step: string, fn: () => Promise<T>): Promise<{ skipped: boolean; ok: boolean; result: T | null; error: string | null }> {
  if (stepDone(store, runId, step)) return { skipped: true, ok: true, result: null, error: null };
  const key = stepKey(runId, step);
  const now = new Date().toISOString();
  if (store.t.steps.has(key)) store.t.steps.update(key, { status: "RUNNING", startedAt: now });
  else store.t.steps.insert({ stepKey: key, runId, step, status: "RUNNING", startedAt: now, finishedAt: null, detail: null });
  store.t.runs.update(runId, { currentStep: step });
  let out: { skipped: boolean; ok: boolean; result: T | null; error: string | null };
  try {
    const result = await fn();
    store.t.steps.update(key, { status: "DONE", finishedAt: new Date().toISOString(), detail: summarize(result) });
    out = { skipped: false, ok: true, result, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    store.t.steps.update(key, { status: "FAILED", finishedAt: new Date().toISOString(), detail: { error: msg } });
    out = { skipped: false, ok: false, result: null, error: msg };
  }
  await store.flush();
  return out;
}

/** Step details are kept small so a cell never approaches the 50k-character limit. */
function summarize(result: unknown): unknown {
  const s = JSON.stringify(result ?? null);
  return s.length <= 8000 ? (JSON.parse(s) as unknown) : { truncated: true, preview: s.slice(0, 2000) };
}
