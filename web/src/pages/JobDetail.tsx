import { ArrowLeft, CheckCircle2, ExternalLink, FileText, RotateCcw, Rocket } from "lucide-react";
import { useState } from "react";
import { api, post, tokenUrl } from "../lib/api.ts";
import { dateTime } from "../lib/format.ts";
import { useAction, useApp, useData } from "../lib/store.tsx";
import type { TimelineEntry } from "../lib/types.ts";
import { AutoApplyModal } from "../components/AutoApplyModal.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { Badge, Callout, Dialog, Kv, Panel, Skeleton } from "../components/ui.tsx";
import { fitWhy, ScoreBar, stage, type JobRow } from "./Jobs.tsx";

interface Detail {
  job: JobRow;
  jdText: string | null;
  jdSource: string | null;
  skills: string[];
  match: {
    score: number;
    eligible: boolean;
    reason: string;
    eligibilityReason: string | null;
    role: { family: string; compatible: boolean; why: string };
    experienceFit: string;
    gates: { role: string[]; experience: string[]; mandatory: string[]; technical: string[] };
    matchedSkills: Array<{ skill: string; level: string }>;
    missingSkills: string[];
    components: Array<{ name: string; weight: number; score: number; detail: string }>;
    riskFlags: string[];
  } | null;
  requirements: { minYears: number | null; maxYears: number | null; experienceText: string | null; education: string[] } | null;
  application: { status: string; mode: string; attempts: number; startedAt: string | null; submittedAt: string | null; verifiedAt: string | null; screenshot: string | null; evidence: unknown; url: string | null } | null;
  whyStopped: string | null;
  timeline: TimelineEntry[];
}

export function JobDetail({ jobId }: { jobId: string }) {
  const act = useAction();
  const { state } = useApp();
  const { data, error } = useData<Detail>(`/api/jobs/${encodeURIComponent(jobId)}`, ["jobs", "applications", "queue"]);
  const [apply, setApply] = useState(false);
  const [marking, setMarking] = useState(false);
  const [evidence, setEvidence] = useState("");
  if (error) return <Callout tone="danger" title="Could not load this job">{error}</Callout>;
  if (!data) return <Skeleton rows={10} />;
  const { job } = data;
  const st = stage(job.status);

  return (
    <div className="stack lg">
      <a href="#/jobs" className="row small muted" style={{ textDecoration: "none" }}>
        <ArrowLeft size={14} /> All jobs
      </a>
      <div className="page-head">
        <div>
          <h1 className="page-title">{job.title}</h1>
          <p className="page-sub">
            {job.company}
            {job.location && job.location !== "Unspecified" ? ` · ${job.location}` : ""} · <span className="mono">{job.jobId}</span> · <Badge tone={st.tone}>{st.label}</Badge>
          </p>
        </div>
        <div className="row wrap">
          <a className="btn" href={job.applyUrl} target="_blank" rel="noreferrer noopener">
            <ExternalLink size={14} /> Posting
          </a>
          {job.resumeId ? (
            <a className="btn" href={tokenUrl(`/api/resumes/${encodeURIComponent(job.resumeId)}/file`)} target="_blank" rel="noreferrer noopener">
              <FileText size={14} /> Tailored resume
            </a>
          ) : null}
          {st.group !== "done" && !job.queued ? (
            <button className="btn primary" disabled={state?.operation === "sync"} onClick={() => setApply(true)}>
              <Rocket size={14} /> {job.resumeId ? "Apply" : "Tailor resume & apply"}
            </button>
          ) : null}
          {st.group === "problem" && !job.queued ? (
            <button className="btn" onClick={() => act(() => post(`/api/jobs/${job.jobId}/retry`), "Back in the queue — start it from Apply")}>
              <RotateCcw size={14} /> Retry
            </button>
          ) : null}
          {job.status !== "APPLIED" ? (
            <button className="btn ghost" onClick={() => setMarking(true)}>
              <CheckCircle2 size={14} /> I applied myself
            </button>
          ) : null}
        </div>
      </div>

      {data.whyStopped && st.group !== "done" ? (
        <Callout tone={st.group === "problem" ? "warn" : "info"} title="Why it stopped">
          {data.whyStopped}
        </Callout>
      ) : null}

      {data.match ? (
        <Panel title="How well it fits your resume">
          <div className="grid cols-3" style={{ alignItems: "start" }}>
            <div className="stack sm">
              <ScoreBar value={data.match.score} />
              <Badge tone={data.match.eligible ? "green" : "amber"}>{data.match.eligible ? "Good fit" : `Low fit: ${fitWhy(data.match.eligibilityReason)}`}</Badge>
              <span className="small muted">{data.match.reason}</span>
            </div>
            <div className="stack sm small">
              <div>
                <strong>Role:</strong> {data.match.role.family.replace(/_/g, " ").toLowerCase()} — {data.match.role.compatible ? "matches your target roles" : "not one of your target roles"}
              </div>
              <div>
                <strong>Experience:</strong> {data.requirements?.experienceText ?? (data.requirements?.minYears !== null && data.requirements?.minYears !== undefined ? `${data.requirements.minYears}+ years` : "not stated")} — {data.match.experienceFit === "COMPATIBLE" ? "fits you" : "above your experience"}
              </div>
              {[...data.match.gates.role, ...data.match.gates.experience, ...data.match.gates.mandatory].slice(0, 4).map((g) => (
                <div key={g} className="xs muted">
                  {g}
                </div>
              ))}
            </div>
            <div className="stack sm">
              <div className="row wrap" style={{ gap: 3 }}>
                {data.match.matchedSkills.map((s) => (
                  <Badge key={s.skill} tone="green">
                    {s.skill}
                    {s.level !== "verified" ? ` (${s.level})` : ""}
                  </Badge>
                ))}
              </div>
              {data.match.missingSkills.length ? (
                <div className="row wrap" style={{ gap: 3 }}>
                  <span className="xs muted">Not on your resume:</span>
                  {data.match.missingSkills.map((s) => (
                    <Badge key={s}>{s}</Badge>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          <div className="row wrap small muted" style={{ gap: 14, marginTop: 10 }}>
            {data.match.components.map((c) => (
              <span key={c.name} title={c.detail}>
                {c.name}: <strong>{Math.round(c.score)}</strong>/100
              </span>
            ))}
          </div>
        </Panel>
      ) : null}

      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <Panel title="Job description">
          {data.jdText ? (
            <div className="stack sm">
              <div className="xs muted">Read from {data.jdSource ?? "the posting"}</div>
              {data.skills.length ? (
                <div className="row wrap" style={{ gap: 4 }}>
                  {data.skills.slice(0, 30).map((s) => (
                    <Badge key={s}>{s}</Badge>
                  ))}
                </div>
              ) : null}
              <pre className="small" style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", maxHeight: "60vh", overflow: "auto", margin: 0 }}>
                {data.jdText}
              </pre>
            </div>
          ) : (
            <p className="muted small">Not read yet. It is read from the Apply Link when you sync the sheet or apply.</p>
          )}
        </Panel>
        <div className="stack lg">
          <Panel title="Application">
            {data.application ? (
              <Kv
                items={[
                  ["Status", data.application.status],
                  ["Mode", data.application.mode],
                  ["Attempts", String(data.application.attempts)],
                  ["Started", dateTime(data.application.startedAt)],
                  ["Submitted", dateTime(data.application.submittedAt)],
                  ["Confirmed", dateTime(data.application.verifiedAt)],
                ]}
              />
            ) : (
              <p className="muted small">Not applied yet.</p>
            )}
            {data.application?.screenshot ? (
              <a href={tokenUrl(`/api/files/screenshot?path=${encodeURIComponent(data.application.screenshot)}`)} target="_blank" rel="noreferrer noopener" className="small">
                View last screenshot
              </a>
            ) : null}
          </Panel>
          <Panel title="History">
            <Timeline entries={data.timeline} />
          </Panel>
        </div>
      </div>

      {apply ? <AutoApplyModal jobIds={[job.jobId]} scope="selected" onClose={() => setApply(false)} /> : null}
      {marking ? (
        <Dialog
          title="Mark as applied"
          subtitle="Record an application you submitted yourself, so the agent never applies to it again."
          onClose={() => setMarking(false)}
          footer={
            <button
              className="btn primary"
              disabled={!evidence.trim()}
              onClick={() =>
                act(() => api(`/api/jobs/${job.jobId}/mark-applied`, { body: { evidence } }), "Marked applied").then((r) => {
                  if (r) setMarking(false);
                })
              }
            >
              Mark applied
            </button>
          }
        >
          <div className="field">
            <label htmlFor="ev">Evidence (confirmation email subject, reference number…)</label>
            <input id="ev" className="input" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
