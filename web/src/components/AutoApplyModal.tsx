import { FlaskConical, Send, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { useAction, useApp, useData } from "../lib/store.tsx";
import { Callout, Dialog } from "./ui.tsx";

interface Result {
  added: unknown[];
  skipped: Array<{ jobId: string; reason: string }>;
  sessionId: string | null;
  live: boolean;
}

/**
 * Starts applying: for each job the agent reads the JD (if not read yet), tailors your resume to it, then fills the
 * application. Dry run is the default; a live run needs live mode armed in Settings and LIVE typed here.
 */
export function AutoApplyModal({ jobIds, scope: initialScope, onClose }: { jobIds: string[]; scope?: "selected" | "pending" | "matched" | "queued"; onClose: () => void }) {
  const { state } = useApp();
  const act = useAction();
  const [scope, setScope] = useState<"selected" | "pending" | "matched" | "queued">(initialScope ?? (jobIds.length ? "selected" : "matched"));
  // How many jobs each "apply to all" choice would pick up; an empty choice is disabled and never the default.
  const { data: counts } = useData<{ applyCounts: { matched: number; pending: number } }>("/api/jobs", ["jobs"]);
  const matched = counts?.applyCounts.matched ?? null;
  const pending = counts?.applyCounts.pending ?? null;
  useEffect(() => {
    if (matched === null || pending === null) return;
    if (scope === "pending" && pending === 0 && matched > 0) setScope("matched");
    if (scope === "matched" && matched === 0 && pending > 0) setScope("pending");
  }, [matched, pending]);
  const empty = (scope === "matched" && matched === 0) || (scope === "pending" && pending === 0) || (scope === "selected" && !jobIds.length);
  const [live, setLive] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [requireReview, setRequireReview] = useState(true);
  const [busy, setBusy] = useState(false);
  const armed = !!state?.liveArmed;

  const start = async () => {
    setBusy(true);
    const r = await act(() => api<Result>("/api/jobs/auto-apply", { body: { scope, jobIds, live, confirm: live ? confirm : undefined, requireReview: live ? requireReview : true, pauseForQuestions: true, pauseForHuman: true } }));
    setBusy(false);
    if (r) {
      onClose();
      navigate("/agent");
    }
  };

  return (
    <Dialog
      title="Tailor resume & apply"
      subtitle="For each job: read the JD → tailor your resume → fill the application. One job at a time."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className={`btn ${live ? "solid-danger" : "primary"}`} onClick={start} disabled={busy || empty || (live && confirm !== "LIVE")}>
            {live ? <Send size={14} /> : <FlaskConical size={14} />}
            {live ? "Start LIVE run" : "Start dry run"}
          </button>
        </>
      }
    >
      <div className="stack lg">
        <div className="stack sm">
          <span className="label">Jobs</span>
          <label className="check">
            <input type="radio" name="scope" checked={scope === "selected"} disabled={!jobIds.length} onChange={() => setScope("selected")} /> Selected jobs ({jobIds.length})
          </label>
          <label className="check" style={matched === 0 ? { opacity: 0.55 } : undefined}>
            <input type="radio" name="scope" checked={scope === "matched"} disabled={matched === 0} onChange={() => setScope("matched")} /> Every good-fit job Find jobs found{matched !== null ? ` (${matched})` : ""} — best score first
          </label>
          <label className="check" style={pending === 0 ? { opacity: 0.55 } : undefined}>
            <input type="radio" name="scope" checked={scope === "pending"} disabled={pending === 0} onChange={() => setScope("pending")} /> Every job in To apply{pending !== null ? ` (${pending})` : ""} — rows you added to the sheet
          </label>
        </div>
        <div className="stack sm">
          <span className="label">Mode</span>
          <label className="check">
            <input type="radio" name="mode" checked={!live} onChange={() => setLive(false)} />
            <span>
              <strong>Dry run</strong> — tailor the resume, open and fill every form, submit nothing. <span className="muted">(default)</span>
            </span>
          </label>
          <label className="check" style={!armed ? { opacity: 0.6 } : undefined}>
            <input type="radio" name="mode" checked={live} disabled={!armed} onChange={() => setLive(true)} />
            <span>
              <strong>Live</strong> — real applications are submitted.{!armed ? <span className="muted"> Turn on live mode in Settings first.</span> : null}
            </span>
          </label>
          {live ? (
            <div className="stack sm" style={{ paddingLeft: 24 }}>
              <Callout tone="danger" icon={ShieldAlert} title="This sends real applications">
                Type <code>LIVE</code> to confirm. The agent still stops for any CAPTCHA, sign-in or verification for you to complete.
              </Callout>
              <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Type LIVE to confirm" aria-label="Type LIVE to confirm" autoComplete="off" />
              <label className="check">
                <input type="checkbox" checked={requireReview} onChange={(e) => setRequireReview(e.target.checked)} /> Ask me to approve each submission
              </label>
            </div>
          ) : null}
        </div>
        <p className="hint">Max applications per run is set in Settings. New questions, CAPTCHAs and sign-ins appear under Needs you. The agent never guesses an answer.</p>
      </div>
    </Dialog>
  );
}
