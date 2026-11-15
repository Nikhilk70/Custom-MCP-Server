import { AlertTriangle, Check, Circle, CreditCard, FileUp, Globe, MessageCircleQuestion, Radar, Send, ShieldCheck, Sparkles, UserRound, XCircle, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { dateTime } from "../lib/format.ts";
import type { TimelineEntry } from "../lib/types.ts";

const META: Record<string, { label: string; icon: LucideIcon; tone: "" | "ok" | "warn" | "err" | "active" }> = {
  DISCOVERED: { label: "Added from your sheet", icon: Radar, tone: "ok" },
  NORMALIZED: { label: "Normalized", icon: Check, tone: "ok" },
  JD_FETCHED: { label: "Description fetched", icon: Check, tone: "ok" },
  MATCHED: { label: "Matched", icon: Sparkles, tone: "ok" },
  NOT_MATCHED: { label: "Low skill match", icon: XCircle, tone: "warn" },
  READY_FOR_RESUME: { label: "Queued for resume", icon: Circle, tone: "active" },
  RESUME_GENERATING: { label: "Preparing resume", icon: FileUp, tone: "active" },
  RESUME_GENERATED: { label: "Resume ready", icon: FileUp, tone: "ok" },
  READY_TO_APPLY: { label: "Ready to apply", icon: Check, tone: "ok" },
  APPLYING: { label: "Browser opened", icon: Globe, tone: "active" },
  APPLICATION_STARTED: { label: "Application started", icon: Globe, tone: "active" },
  FORM_DETECTED: { label: "Form detected", icon: Check, tone: "ok" },
  FORM_FILLED: { label: "Fields filled", icon: Check, tone: "ok" },
  RESUME_UPLOADED: { label: "Resume uploaded", icon: FileUp, tone: "ok" },
  HUMAN_WAIT_STARTED: { label: "Waiting for you", icon: UserRound, tone: "warn" },
  HUMAN_WAIT_COMPLETED: { label: "Verification completed by you", icon: ShieldCheck, tone: "ok" },
  GOOGLE_SIGNIN_STARTED: { label: "Google sign-in started", icon: ShieldCheck, tone: "active" },
  GOOGLE_SIGNIN_VERIFIED: { label: "Google sign-in verified", icon: ShieldCheck, tone: "ok" },
  PAYMENT_REQUESTED: { label: "Payment requested — stopped", icon: CreditCard, tone: "err" },
  VALIDATION_PASSED: { label: "Validation passed", icon: Check, tone: "ok" },
  VALIDATION_FAILED: { label: "Validation failed", icon: AlertTriangle, tone: "warn" },
  NEEDS_HUMAN: { label: "Needs you", icon: MessageCircleQuestion, tone: "warn" },
  SUBMITTING: { label: "Submitting", icon: Send, tone: "active" },
  SUBMITTED: { label: "Submitted", icon: Send, tone: "ok" },
  SUBMISSION_VERIFIED: { label: "Confirmation detected", icon: ShieldCheck, tone: "ok" },
  SUBMISSION_UNVERIFIED: { label: "Submitted — not verified", icon: AlertTriangle, tone: "warn" },
  APPLIED: { label: "Applied (confirmed)", icon: Check, tone: "ok" },
  FAILED: { label: "Failed", icon: XCircle, tone: "err" },
  BLOCKED: { label: "Blocked", icon: XCircle, tone: "err" },
  SKIPPED: { label: "Skipped", icon: Circle, tone: "" },
  DUPLICATE: { label: "Duplicate", icon: Circle, tone: "" },
};

export function Timeline({ entries, initial = 14 }: { entries: TimelineEntry[]; initial?: number }) {
  const [all, setAll] = useState(false);
  if (!entries.length) return <p className="muted small">No events recorded yet.</p>;
  // Long histories (many attempts): show the most recent events first-class, the rest on request.
  const hidden = all ? 0 : Math.max(0, entries.length - initial);
  const shown = entries.slice(hidden);
  return (
    <>
    {hidden ? (
      <button className="btn ghost sm" style={{ marginBottom: 10 }} onClick={() => setAll(true)}>
        Show all {entries.length} events ({hidden} earlier)
      </button>
    ) : null}
    <ol className="timeline">
      {shown.map((e, i) => {
        const m = META[e.event] ?? { label: e.event.replace(/_/g, " ").toLowerCase(), icon: Circle, tone: "" as const };
        const Icon = m.icon;
        const detail = e.detail && typeof e.detail === "object" ? (e.detail as Record<string, unknown>) : null;
        const by = detail && typeof detail.by === "string" ? ` · by ${detail.by}` : "";
        const evidence = detail && typeof detail.evidence === "string" ? detail.evidence : null;
        return (
          <li key={i}>
            <span className={`node ${m.tone}`} aria-hidden>
              <Icon />
            </span>
            <div className="t-title">
              {m.label}
              {e.kind === "STATUS" && e.from ? <span className="muted xs"> · from {e.from.toLowerCase().replace(/_/g, " ")}</span> : null}
            </div>
            <div className="t-meta">
              {dateTime(e.at)}
              {by}
              {e.reason ? ` — ${e.reason}` : ""}
              {evidence ? ` — evidence: ${evidence}` : ""}
            </div>
          </li>
        );
      })}
    </ol>
    </>
  );
}
