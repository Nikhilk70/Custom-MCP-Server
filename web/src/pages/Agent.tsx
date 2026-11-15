import { Bot, ExternalLink, ListChecks, Pause, Play, RotateCcw, SkipForward, Square, Trash2, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { api, tokenUrl, post } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { useAction, useApp, useData } from "../lib/store.tsx";
import type { HumanTask, QueueItem } from "../lib/types.ts";
import { ActivityStream } from "../components/ActivityStream.tsx";
import { PHASE_META } from "../components/AgentStatus.tsx";
import { AutoApplyModal } from "../components/AutoApplyModal.tsx";
import { TaskCard } from "../components/TaskCard.tsx";
import { Badge, Empty, Panel, StatusBadge } from "../components/ui.tsx";

const STEPS = ["OPENING", "FILLING", "WAITING_REVIEW", "SUBMITTING", "VERIFYING"] as const;

export function AgentConsole() {
  const { state, live } = useApp();
  const act = useAction();
  const { data: queue } = useData<{ items: QueueItem[]; current: unknown }>("/api/queue", ["queue", "state"]);
  const { data: tasks } = useData<HumanTask[]>("/api/tasks", ["tasks"]);
  const [auto, setAuto] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const running = state?.operation !== null;
  const phase = state ? PHASE_META[state.phase] : null;

  // Live preview: a fresh screenshot every 2.5 s while the agent has a page open (server-side, same origin).
  useEffect(() => {
    if (!state?.browserOpen) {
      setShot(null);
      return;
    }
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const url = tokenUrl(`/api/agent/preview.jpg?t=${Date.now()}`);
      fetch(url)
        .then(async (r) => (r.status === 200 ? URL.createObjectURL(await r.blob()) : null))
        .then((u) => {
          if (!alive) return;
          setShot((old) => {
            if (old) URL.revokeObjectURL(old);
            return u;
          });
        })
        .catch(() => undefined);
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [state?.browserOpen]);

  const items = queue?.items ?? [];
  const pending = items.filter((i) => i.status === "QUEUED");
  const done = items.filter((i) => !["QUEUED", "RUNNING"].includes(i.status));
  const blocking = (tasks ?? []).filter((t) => t.blocking);
  const stepIndex = state ? STEPS.indexOf(state.phase as (typeof STEPS)[number]) : -1;
  const jobActivity = live.filter((e) => state?.current && e.jobId === state.current.jobId);

  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <h1 className="page-title">Agent console</h1>
          <p className="page-sub" aria-live="polite">
            {state?.message}
          </p>
        </div>
        <div className="row wrap" role="group" aria-label="Agent controls">
          {!running ? (
            <button className="btn primary" onClick={() => (pending.length ? act(() => api("/api/agent/start", { body: { scope: "queued" } }), "Agent started") : setAuto(true))}>
              <Play size={14} /> {pending.length ? `Start (${pending.length} queued)` : "Start Auto Apply"}
            </button>
          ) : state?.paused ? (
            <button className="btn primary" onClick={() => act(() => post("/api/agent/resume"), "Resumed")}>
              <Play size={14} /> Resume
            </button>
          ) : (
            <button className="btn" onClick={() => act(() => post("/api/agent/pause"))}>
              <Pause size={14} /> Pause
            </button>
          )}
          <button className="btn" disabled={!state?.current} onClick={() => act(() => post("/api/agent/skip"), "Skipping the current job")}>
            <SkipForward size={14} /> Skip
          </button>
          <button className="btn" disabled={!state?.browserOpen} onClick={() => act(() => post("/api/agent/focus"))}>
            <ExternalLink size={14} /> Open browser
          </button>
          <button className="btn solid-danger" disabled={!running || state?.phase === "STOPPING"} onClick={() => act(() => post("/api/agent/stop"), "Stopping safely")}>
            <Square size={13} /> STOP ALL
          </button>
        </div>
      </div>

      <div className="panel" style={{ padding: "14px 18px", display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
        <div className={`agent-orb ${state?.phase.startsWith("WAITING") || state?.phase === "PAUSED" ? "waiting" : running ? "active" : ""}`} aria-hidden>
          {phase ? <phase.icon size={18} color={running ? "#fff" : "var(--text-3)"} /> : <Bot size={18} />}
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div className="strong">{phase?.label}</div>
          <div className="muted small">
            {state?.current ? (
              <>
                {state.current.company} — {state.current.role} · <a href={`#/jobs/${state.current.jobId}`}>{state.current.jobId}</a>
              </>
            ) : state?.session ? (
              `Session ${state.session.sessionId} · ${state.session.jobsProcessed} of ${state.session.jobsQueued} processed`
            ) : (
              "Nothing in progress"
            )}
          </div>
        </div>
        <div className="row wrap" aria-label="Application steps">
          {STEPS.map((s, i) => (
            <span key={s} className={`badge ${i < stepIndex ? "green" : i === stepIndex ? "blue" : ""}`}>
              {PHASE_META[s].label}
            </span>
          ))}
        </div>
        {state?.runMode ? <Badge tone={state.runMode.live ? "red" : "blue"}>{state.runMode.live ? "LIVE" : "DRY RUN"}</Badge> : null}
      </div>

      {blocking.length ? (
        <section className="stack" aria-label="Agent is waiting for you">
          {blocking.map((t) => (
            <TaskCard key={t.id} task={t} />
          ))}
        </section>
      ) : null}

      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.3fr) minmax(0, 1fr)" }}>
        <Panel title="Browser view" icon={ExternalLink} actions={<span className="xs muted">{state?.browserOpen ? "live preview · refreshes every 2.5 s" : "no page open"}</span>}>
          <div className="browser-frame">
            <div className="browser-chrome">
              <span className="dots" aria-hidden>
                <i />
                <i />
                <i />
              </span>
              <span className="truncate">{state?.current ? `${state.current.company} — application` : "—"}</span>
            </div>
            <div className="browser-view">
              {shot ? <img src={shot} alt={`Current page of ${state?.current?.company ?? "the application"}`} /> : <div className="muted small">{running ? "Waiting for the browser…" : "The live page appears here while an application runs."}</div>}
            </div>
          </div>
          <p className="xs muted" style={{ marginTop: 8 }}>
            Interact in the real Chrome window (Open browser) — the preview is read-only.
          </p>
        </Panel>
        <Panel title="Agent timeline" icon={ListChecks} flush className="fill">
          <ActivityStream events={state?.current ? jobActivity : live.slice(0, 80)} filterable={false} limit={120} />
        </Panel>
      </div>

      <Panel
        title={`Queue · ${pending.length} waiting`}
        icon={Zap}
        flush
        actions={
          <>
            <button className="btn sm" onClick={() => setAuto(true)}>
              Add jobs
            </button>
            <button className="btn sm" disabled={!pending.length} onClick={() => act(() => post("/api/queue/cancel"), "Queue cancelled")}>
              Cancel queue
            </button>
            <button className="btn ghost sm" disabled={!done.length} onClick={() => act(() => post("/api/queue/clear"))} aria-label="Clear finished items">
              <Trash2 size={13} />
            </button>
          </>
        }
      >
        {items.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Company</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th className="hide-md">Outcome / reason</th>
                  <th className="hide-md">Attempts</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((i, idx) => (
                  <tr key={i.id} className={i.status === "RUNNING" ? "selected" : ""}>
                    <td className="muted small">{idx + 1}</td>
                    <td>
                      <a href={`#/jobs/${i.jobId}`} className="cell-title">
                        {i.company}
                      </a>
                    </td>
                    <td className="small">{i.role}</td>
                    <td>
                      <StatusBadge status={i.status} />
                    </td>
                    <td className="hide-md small muted" style={{ maxWidth: 420 }}>
                      {i.outcome ? <span className="strong" style={{ color: "var(--text-2)" }}>{i.outcome.replace(/_/g, " ").toLowerCase()}</span> : null}
                      {i.failureReason ? ` — ${i.failureReason}` : ""}
                      {i.completedAt ? <span className="xs"> · {ago(i.completedAt)}</span> : null}
                    </td>
                    <td className="hide-md small num">{i.attemptCount}</td>
                    <td>
                      <div className="row">
                        {i.status === "QUEUED" || i.status === "RUNNING" ? (
                          <button className="btn sm ghost" onClick={() => act(() => post(`/api/queue/${i.id}/skip`), "Skipped")}>
                            <SkipForward size={13} /> Skip
                          </button>
                        ) : i.outcome !== "CONFIRMED" && i.outcome !== "SUBMITTED_UNVERIFIED" ? (
                          <button className="btn sm ghost" onClick={() => act(() => post(`/api/queue/${i.id}/retry`), "Back in the queue")}>
                            <RotateCcw size={13} /> Retry
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={Zap} title="The queue is empty" action={<button className="btn primary" onClick={() => setAuto(true)}>Add jobs to the queue</button>}>
            Select jobs on the Jobs page, or apply to every synced job.
          </Empty>
        )}
      </Panel>
      {auto ? <AutoApplyModal jobIds={[]} scope="matched" onClose={() => setAuto(false)} /> : null}
    </div>
  );
}
