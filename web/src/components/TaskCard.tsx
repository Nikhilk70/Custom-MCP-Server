import { ArrowRight, Check, ExternalLink, HelpCircle, ShieldCheck, SkipForward, X } from "lucide-react";
import { useState } from "react";
import { api, post } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { useAction } from "../lib/store.tsx";
import type { FieldRow, HumanTask, PendingQuestion } from "../lib/types.ts";
import { Badge, Callout, SourceTag } from "./ui.tsx";
import { Suggestions } from "./Suggestions.tsx";

const TYPE_LABEL: Record<string, string> = { CAPTCHA: "Human verification", NEW_QUESTION: "New question", REVIEW_SUBMIT: "Review before submit", LOGIN: "Sign-in", VERIFICATION_CODE: "Verification code", SECURITY_CHECK: "Security check", UNKNOWN_FORM: "Agent stopped", OTHER: "Check needed", CONSENT: "Consent", EMAIL_VERIFICATION: "Email verification", PHONE_VERIFICATION: "Phone verification" };

/** One human task with "Why am I seeing this? / What do I do? / What happens next?" and the right actions. */
export function TaskCard({ task, compact = false }: { task: HumanTask; compact?: boolean }) {
  const act = useAction();
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, { answer: string; remember: boolean }>>({});
  const questions = (task.payload.questions as PendingQuestion[] | undefined) ?? [];
  const fields = (task.payload.fields as FieldRow[] | undefined) ?? [];
  const send = async (action: string, extra?: Record<string, unknown>, msg?: string) => {
    setBusy(true);
    await act(() => api(`/api/tasks/${task.id}`, { body: { action, ...extra } }), msg);
    setBusy(false);
  };
  const focus = () => act(() => post("/api/agent/focus"));
  const pending = task.status === "PENDING";
  const kind = task.type === "REVIEW_SUBMIT" ? "review" : task.blocking ? "blocking" : "";
  return (
    <article className={`panel task-card ${kind}`} aria-labelledby={`t-${task.id}`}>
      <div className="panel-body stack">
        <div className="row between wrap">
          <div className="row wrap">
            <Badge tone={task.type === "REVIEW_SUBMIT" ? "blue" : task.blocking ? "red" : "amber"} icon={task.type === "CAPTCHA" ? ShieldCheck : HelpCircle}>
              {TYPE_LABEL[task.type] ?? task.type}
            </Badge>
            {task.blocking && pending ? <Badge tone="violet">agent waiting</Badge> : null}
            {!pending ? <Badge>{task.status.toLowerCase()}</Badge> : null}
            <span className="xs muted">{ago(task.createdAt)}</span>
          </div>
          {task.jobId ? (
            <a href={`#/jobs/${task.jobId}`} className="small">
              {task.company} — {task.role}
            </a>
          ) : null}
        </div>
        <h3 id={`t-${task.id}`} style={{ fontSize: "var(--fs-lg)" }}>
          {task.title}
        </h3>
        {!compact ? (
          <div className="why-grid">
            <div>
              <span className="eyebrow">Why am I seeing this?</span>
              {task.why}
            </div>
            <div>
              <span className="eyebrow">What do I need to do?</span>
              {task.whatToDo}
            </div>
            <div>
              <span className="eyebrow">What happens afterward?</span>
              {task.whatNext}
            </div>
          </div>
        ) : (
          <p className="muted small">{task.why}</p>
        )}
        {typeof task.payload.reason === "string" ? (
          <Callout tone="warn" title="Reason">
            <span style={{ wordBreak: "break-word" }}>{task.payload.reason}</span>
          </Callout>
        ) : null}
        {typeof task.payload.screenshot === "string" ? (
          <a href={`#/jobs/${task.jobId ?? ""}`} className="small">
            View screenshot and timeline
          </a>
        ) : null}

        {task.type === "NEW_QUESTION" && pending ? (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void send("answer", { answers: questions.map((q) => ({ label: q.label, answer: answers[q.label]?.answer ?? "", remember: answers[q.label]?.remember ?? true })) }, "Answers sent to the agent");
            }}
          >
            {questions.map((q, i) => {
              const a = answers[q.label] ?? { answer: "", remember: true };
              const set = (patch: Partial<typeof a>) => setAnswers((x) => ({ ...x, [q.label]: { ...a, ...patch } }));
              return (
                <div key={q.label} className="stack sm" style={{ padding: 12, borderRadius: "var(--r-md)", background: "var(--bg-2)", border: "1px solid var(--line)" }}>
                  <label htmlFor={`q-${task.id}-${i}`} className="strong">
                    {q.label} {q.required ? <span className="lvl-error" aria-label="required">*</span> : null}
                  </label>
                  <div className="xs muted">{q.reason}</div>
                  <Suggestions suggestions={q.suggestions ?? []} sources={q.sources ?? []} onUse={(answer) => set({ answer })} />
                  {q.options.length ? (
                    <select id={`q-${task.id}-${i}`} className="select" value={a.answer} onChange={(e) => set({ answer: e.target.value })}>
                      <option value="">Choose…</option>
                      {q.options.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  ) : q.kind === "TEXTAREA" ? (
                    <textarea id={`q-${task.id}-${i}`} className="textarea" value={a.answer} onChange={(e) => set({ answer: e.target.value })} />
                  ) : (
                    <input id={`q-${task.id}-${i}`} className="input" value={a.answer} onChange={(e) => set({ answer: e.target.value })} autoComplete="off" />
                  )}
                  <label className="check">
                    <input type="checkbox" checked={a.remember} onChange={(e) => set({ remember: e.target.checked })} /> Remember this answer <span className="muted">— saved to your Answer Bank; unticked = used for this application only</span>
                  </label>
                </div>
              );
            })}
            <div className="row wrap">
              <button className="btn primary" type="submit" disabled={busy || questions.some((q) => q.required && !answers[q.label]?.answer.trim())}>
                <Check size={14} /> {questions.some((q) => answers[q.label]?.remember !== false) ? "Save & continue" : "Answer once & continue"}
              </button>
              <button className="btn" type="button" onClick={() => send("skip", undefined, "Question skipped — this application stops")} disabled={busy}>
                <SkipForward size={14} /> Skip this job
              </button>
            </div>
          </form>
        ) : null}

        {task.type === "REVIEW_SUBMIT" && pending ? (
          <div className="stack">
            <ReviewSummary fields={fields} finalSubmit={task.payload.finalSubmit as string | null} resume={task.payload.resume as string | null} />
            <div className="row wrap">
              <button className="btn primary" onClick={() => send("approve", undefined, "Approved — submitting")} disabled={busy}>
                <Check size={14} /> Submit application
              </button>
              <button className="btn" onClick={focus}>
                <ExternalLink size={14} /> Open browser
              </button>
              <button className="btn danger" onClick={() => send("reject", undefined, "Cancelled — nothing was submitted")} disabled={busy}>
                <X size={14} /> Cancel
              </button>
            </div>
          </div>
        ) : null}

        {["CAPTCHA", "LOGIN", "VERIFICATION_CODE", "SECURITY_CHECK"].includes(task.type) && pending && task.blocking ? (
          <div className="stack sm">
            <Callout tone="warn" icon={ShieldCheck} title={task.type === "CAPTCHA" ? "The agent has paused and will not continue until you complete it." : "Complete this step yourself in the browser."}>
              ApplyPilot never solves, bypasses or automates verification steps. Page: <span className="mono xs">{typeof task.payload.url === "string" ? task.payload.url : ""}</span>
            </Callout>
            <div className="row wrap">
              <button className="btn" onClick={focus}>
                <ExternalLink size={14} /> Open browser
              </button>
              <button className="btn primary" onClick={() => send("continue", undefined, "Checking the page…")} disabled={busy}>
                <ArrowRight size={14} /> I've completed it — Continue
              </button>
              <button className="btn danger" onClick={() => send("skip", undefined, "Skipped — this application stops")} disabled={busy}>
                <SkipForward size={14} /> Skip job
              </button>
            </div>
          </div>
        ) : null}

        {!task.blocking && pending ? (
          <div className="row wrap">
            {task.jobId ? (
              <button className="btn primary" onClick={() => act(() => post(`/api/applications/${task.jobId ?? ""}/retry`), "Job queued for another attempt")}>
                Retry job
              </button>
            ) : null}
            {task.jobId && /submitted|went through/i.test(task.title) ? (
              <a className="btn" href={`#/jobs/${task.jobId}?mark=1`}>
                Mark as applied (with evidence)
              </a>
            ) : null}
            <button className="btn ghost" onClick={() => send("dismiss")} disabled={busy}>
              Dismiss
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function ReviewSummary({ fields, finalSubmit, resume }: { fields: FieldRow[]; finalSubmit: string | null; resume: string | null }) {
  const filled = fields.filter((f) => f.action === "FILL" || f.action === "ALREADY_FILLED" || f.action === "UPLOAD_RESUME");
  const human = filled.filter((f) => f.source === "HUMAN_ANSWER").length;
  const unknown = fields.filter((f) => f.action === "NEEDS_HUMAN").length;
  return (
    <div className="stack sm">
      <div className="grid cols-3">
        <div className="metric panel">
          <div className="v">{filled.length}</div>
          <div className="k">Fields completed</div>
        </div>
        <div className="metric panel">
          <div className="v">{human}</div>
          <div className="k">Human answers</div>
        </div>
        <div className="metric panel">
          <div className="v">{unknown}</div>
          <div className="k">Unknown</div>
        </div>
      </div>
      <div className="small muted">
        Resume: <span className="mono">{resume ?? "tailored resume"}</span> · Submit button: <span className="mono">{finalSubmit ?? "?"}</span>
      </div>
      <FieldTable fields={fields} />
    </div>
  );
}

export function FieldTable({ fields }: { fields: FieldRow[] }) {
  if (!fields.length) return <p className="muted small">No field report recorded.</p>;
  return (
    <div className="table-wrap" style={{ maxHeight: 320, border: "1px solid var(--line)", borderRadius: "var(--r-md)" }}>
      <table className="data">
        <thead>
          <tr>
            <th>Field</th>
            <th>Value</th>
            <th>Source</th>
            <th>Confidence</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f, i) => (
            <tr key={i}>
              <td>
                <div className="cell-title small">
                  {f.label} {f.required ? <span className="lvl-error">*</span> : null}
                </div>
                <div className="cell-sub">{f.kind.toLowerCase()}</div>
              </td>
              <td className="small">{f.answerPreview ?? <span className="muted">—</span>}</td>
              <td>
                <SourceTag source={f.source} />
              </td>
              <td className="num small">{f.confidence ? `${Math.round(f.confidence * 100)}%` : "—"}</td>
              <td>
                <Badge tone={f.action === "NEEDS_HUMAN" ? "amber" : f.action === "FILL" || f.action === "UPLOAD_RESUME" ? "green" : ""}>{f.action.replace(/_/g, " ").toLowerCase()}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
