import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { useState } from "react";
import { time } from "../lib/format.ts";
import type { ActivityEvent } from "../lib/types.ts";
import { Empty } from "./ui.tsx";
import { Activity as ActivityIcon } from "lucide-react";

const FILTERS: Array<{ id: "" | ActivityEvent["category"]; label: string }> = [
  { id: "", label: "All" },
  { id: "jobs", label: "Jobs" },
  { id: "applications", label: "Applications" },
  { id: "questions", label: "Questions" },
  { id: "human", label: "Human actions" },
  { id: "errors", label: "Errors" },
  { id: "system", label: "System" },
];

export function ActivityStream({ events, filterable = true, limit = 80, compact = false }: { events: ActivityEvent[]; filterable?: boolean; limit?: number; compact?: boolean }) {
  const [filter, setFilter] = useState<"" | ActivityEvent["category"]>("");
  const shown = events.filter((e) => !filter || e.category === filter).slice(0, limit);
  return (
    <div>
      {filterable ? (
        <div className="row wrap" style={{ padding: "10px 16px", gap: 6, borderBottom: "1px solid var(--line)" }} role="group" aria-label="Filter activity">
          {FILTERS.map((f) => (
            <button key={f.id} className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      ) : null}
      {shown.length ? (
        <ul className="activity" aria-live="polite" aria-relevant="additions" style={compact ? { maxHeight: 360, overflow: "auto" } : undefined}>
          {shown.map((e) => {
            const Icon = e.level === "success" ? CheckCircle2 : e.level === "warn" ? AlertTriangle : e.level === "error" ? XCircle : Info;
            return (
              <li key={e.id}>
                <time dateTime={e.at}>{time(e.at)}</time>
                <Icon className={`ico lvl-${e.level}`} aria-label={e.level} />
                <span className="msg">
                  {e.message}
                  {e.jobId ? (
                    <>
                      {" "}
                      <a href={`#/jobs/${e.jobId}`} className="xs mono">
                        {e.jobId}
                      </a>
                    </>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty icon={ActivityIcon} title="Nothing here yet">
          Agent activity appears here in real time.
        </Empty>
      )}
    </div>
  );
}
