import { Bot, Pause, Play, Square, FlaskConical, Radar, FileText, Globe, PenLine, UserRound, ShieldCheck, ClipboardCheck, Send, SearchCheck, PauseCircle, OctagonX, type LucideIcon } from "lucide-react";
import { post } from "../lib/api.ts";
import { useAction, useApp } from "../lib/store.tsx";
import type { Phase } from "../lib/types.ts";

export const PHASE_META: Record<Phase, { label: string; icon: LucideIcon; tone: "" | "live" | "warn" | "blue" | "err" }> = {
  IDLE: { label: "Agent idle", icon: Bot, tone: "" },
  SEARCHING: { label: "Finding jobs", icon: SearchCheck, tone: "blue" },
  SYNCING: { label: "Syncing sheet", icon: Radar, tone: "blue" },
  PREPARING: { label: "Preparing", icon: FileText, tone: "blue" },
  OPENING: { label: "Opening application", icon: Globe, tone: "blue" },
  FILLING: { label: "Filling application", icon: PenLine, tone: "live" },
  WAITING_HUMAN: { label: "Waiting for your input", icon: UserRound, tone: "warn" },
  WAITING_CAPTCHA: { label: "Waiting for verification", icon: ShieldCheck, tone: "warn" },
  WAITING_REVIEW: { label: "Waiting for your approval", icon: ClipboardCheck, tone: "warn" },
  SUBMITTING: { label: "Submitting", icon: Send, tone: "live" },
  VERIFYING: { label: "Verifying", icon: SearchCheck, tone: "live" },
  PAUSED: { label: "Paused", icon: PauseCircle, tone: "warn" },
  STOPPING: { label: "Stopping", icon: OctagonX, tone: "err" },
};

export function AgentPill() {
  const { state } = useApp();
  if (!state) return null;
  const m = PHASE_META[state.phase];
  const Icon = m.icon;
  const active = state.operation !== null;
  return (
    <a href="#/agent" className="agent-pill" aria-label={`Agent status: ${m.label}. ${state.message}`} title={state.message} style={{ textDecoration: "none", color: "inherit" }}>
      <span className={`status-dot ${m.tone} ${active && m.tone !== "warn" ? "pulse" : ""}`} aria-hidden />
      <Icon size={14} aria-hidden className="hide-sm" />
      <span className="pill-text truncate">{m.label}</span>
    </a>
  );
}

/** The global kill switch: visible on every screen while the agent runs. */
export function KillSwitch() {
  const { state } = useApp();
  const act = useAction();
  if (!state) return null;
  const running = state.operation !== null;
  return (
    <div className="row" role="group" aria-label="Agent controls">
      {running && state.phase !== "STOPPING" ? (
        state.paused ? (
          <button className="btn sm" onClick={() => act(() => post("/api/agent/resume"), "Agent resumed")}>
            <Play size={13} /> Resume
          </button>
        ) : (
          <button className="btn sm" onClick={() => act(() => post("/api/agent/pause"))}>
            <Pause size={13} /> Pause
          </button>
        )
      ) : null}
      <button className={`btn sm ${running ? "solid-danger" : "danger"}`} disabled={!running || state.phase === "STOPPING"} onClick={() => act(() => post("/api/agent/stop"), "Stopping — nothing more will be submitted")} title="Stops the queue; the current application stops before submitting">
        <Square size={12} /> STOP ALL
      </button>
    </div>
  );
}

export function ModeBanner() {
  const { state } = useApp();
  if (!state) return null;
  const live = state.runMode?.live;
  const cls = live ? "live" : state.liveArmed ? "armed" : "dry";
  return (
    <div className={`mode-banner ${cls}`} role="status">
      {live ? (
        <>
          <Send size={14} aria-hidden /> <strong>LIVE APPLICATION MODE</strong> — real applications may be submitted{state.runMode?.requireReview ? " after your approval" : " automatically when every answer is verified"}.
        </>
      ) : state.liveArmed ? (
        <>
          <ShieldCheck size={14} aria-hidden /> <strong>LIVE MODE ARMED</strong> — the next run you start in live mode can submit real applications. Runs started as dry runs still submit nothing.
        </>
      ) : (
        <>
          <FlaskConical size={14} aria-hidden /> <strong>DRY RUN</strong> — no application will be submitted. {state.demo ? "Demo mode: in-memory database and a local mock job site." : "Arm live mode in Settings when you're ready."}
        </>
      )}
    </div>
  );
}
