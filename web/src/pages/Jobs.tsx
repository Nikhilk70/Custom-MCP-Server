import { Briefcase, ExternalLink, FileText, RefreshCw, Rocket, Search, Sheet } from "lucide-react";
import { useMemo, useState } from "react";
import { post, tokenUrl } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { navigate } from "../lib/router.ts";
import { useAction, useApp, useData } from "../lib/store.tsx";
import { AutoApplyModal } from "../components/AutoApplyModal.tsx";
import { Badge, Callout, Empty, Skeleton, Tabs } from "../components/ui.tsx";

export interface JobRow {
  jobId: string;
  company: string;
  title: string;
  location: string;
  applyUrl: string;
  status: string;
  queued: boolean;
  hasJd: boolean;
  matchScore: number | null;
  source: string;
  postedDate: string | null;
  workMode: string | null;
  fit: "GOOD" | "LOW" | null;
  fitReason: string | null;
  experienceFit: "COMPATIBLE" | "INCOMPATIBLE" | null;
  roleFit: "COMPATIBLE" | "INCOMPATIBLE" | null;
  matchedSkills: string[];
  missingSkills: string[];
  resumeId: string | null;
  applicationStatus: string | null;
  submittedAt: string | null;
  lastError: string | null;
  blockReason: string | null;
  updatedAt: string;
}

type Tone = "" | "blue" | "violet" | "green" | "amber" | "red" | "cyan";
type Group = "found" | "todo" | "done" | "problem";
/** The pipeline status in plain words: found → JD read → resume ready → applying → applied. */
export function stage(status: string): { label: string; tone: Tone; group: Group } {
  switch (status) {
    case "MATCHED":
      return { label: "Good fit", tone: "green", group: "found" };
    case "NOT_MATCHED":
      return { label: "Low fit", tone: "", group: "found" };
    case "DISCOVERED":
    case "NORMALIZED":
      return { label: "New", tone: "", group: "todo" };
    case "JD_FETCHED":
    case "READY_FOR_RESUME":
      return { label: "JD read", tone: "blue", group: "todo" };
    case "RESUME_GENERATING":
    case "RESUME_GENERATED":
      return { label: "Tailoring resume", tone: "violet", group: "todo" };
    case "READY_TO_APPLY":
      return { label: "Resume ready", tone: "violet", group: "todo" };
    case "APPLYING":
    case "FORM_DETECTED":
    case "FORM_FILLED":
    case "SUBMITTING":
      return { label: "Applying", tone: "cyan", group: "todo" };
    case "NEEDS_HUMAN":
      return { label: "Needs you", tone: "amber", group: "problem" };
    case "APPLIED":
      return { label: "Applied", tone: "green", group: "done" };
    case "SUBMISSION_UNVERIFIED":
      return { label: "Submitted (check)", tone: "amber", group: "done" };
    case "SKIPPED":
      return { label: "Skipped", tone: "", group: "done" };
    default:
      return { label: "Failed", tone: "red", group: "problem" };
  }
}

/** Why a job is a low fit, in plain words. */
export function fitWhy(code: string | null): string {
  switch (code) {
    case "ROLE_FAMILY_INCOMPATIBLE":
      return "different kind of role";
    case "ROLE_EXCLUDED_PATTERN":
      return "a role type you excluded";
    case "EXPERIENCE_INCOMPATIBLE":
      return "needs more experience";
    case "MANDATORY_REQUIREMENT_FAILED":
      return "missing a must-have requirement";
    case "BELOW_TECHNICAL_THRESHOLD":
      return "few of your skills";
    default:
      return code ? code.toLowerCase().replace(/_/g, " ") : "";
  }
}

export function ScoreBar({ value }: { value: number | null }) {
  if (value === null) return <span className="muted xs">—</span>;
  const color = value >= 70 ? "var(--green, #16a34a)" : value >= 50 ? "var(--amber, #d97706)" : "var(--red, #dc2626)";
  return (
    <div className="stack" style={{ gap: 3, minWidth: 64 }}>
      <strong className="small">{value}%</strong>
      <div style={{ height: 4, borderRadius: 2, background: "var(--border, #e5e7eb)" }}>
        <div style={{ width: `${Math.max(3, Math.min(100, value))}%`, height: 4, borderRadius: 2, background: color }} />
      </div>
    </div>
  );
}

export function Jobs() {
  const act = useAction();
  const { state } = useApp();
  const { data, loading } = useData<{ items: JobRow[]; newRows: number }>("/api/jobs", ["jobs", "queue", "applications", "state"]);
  const { data: settings } = useData<{ sheetId: string | null }>("/api/settings");
  const [tab, setTab] = useState<Group | "all">("found");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [apply, setApply] = useState<{ ids: string[]; scope: "selected" | "pending" | "matched" } | null>(null);
  const items = data?.items ?? [];
  const shown = useMemo(() => {
    const list = items.filter((j) => tab === "all" || stage(j.status).group === tab);
    return tab === "found" ? [...list].sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1)) : list;
  }, [items, tab]);
  const count = (g: Group) => items.filter((j) => stage(j.status).group === g).length;
  const goodFit = items.filter((j) => j.status === "MATCHED").length;
  const busy = !!state?.operation;
  const op = state?.operation;
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const sheetUrl = settings?.sheetId ? `https://docs.google.com/spreadsheets/d/${settings.sheetId}/edit` : null;

  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <h1 className="page-title">Jobs</h1>
          <p className="page-sub">Find jobs on LinkedIn that fit your resume, check each score, then tailor your resume and apply.</p>
        </div>
        <div className="row wrap">
          {sheetUrl ? (
            <a className="btn ghost" href={sheetUrl} target="_blank" rel="noreferrer noopener">
              <Sheet size={14} /> Sheet
            </a>
          ) : null}
          <button className="btn" disabled={busy} onClick={() => act(() => post("/api/sheet/sync"), "Syncing your sheet…")} title="Add the rows you typed into the sheet">
            <RefreshCw size={14} style={op === "sync" ? { animation: "spin 1s linear infinite" } : undefined} /> {op === "sync" ? "Syncing…" : "Sync sheet"}
          </button>
          <button className="btn primary" disabled={busy} onClick={() => act(() => post("/api/jobs/find"), "Searching for jobs that fit your resume…").then(() => setTab("found"))}>
            <Search size={14} /> {op === "find" ? "Finding jobs…" : "Find jobs"}
          </button>
        </div>
      </div>

      {op === "find" || op === "sync" ? <Callout tone="info" title={op === "find" ? "Finding jobs" : "Syncing"}>{state?.message}</Callout> : null}
      {data && data.newRows > 0 && !busy ? (
        <Callout tone="info" icon={Sheet} title={`${data.newRows} new row${data.newRows === 1 ? "" : "s"} in your sheet`}>
          Click <strong>Sync sheet</strong> to add {data.newRows === 1 ? "it" : "them"}.
        </Callout>
      ) : null}

      <div className="row between wrap">
        <Tabs
          value={tab}
          onChange={(t) => {
            setTab(t);
            setSelected(new Set());
          }}
          items={[
            { id: "found", label: "Found", count: count("found") },
            { id: "todo", label: "To apply", count: count("todo") },
            { id: "problem", label: "Needs attention", count: count("problem") },
            { id: "done", label: "Done", count: count("done") },
            { id: "all", label: "All", count: items.length },
          ]}
        />
        {tab === "found" && goodFit ? (
          <button className="btn primary" disabled={busy} onClick={() => setApply({ ids: [], scope: "matched" })}>
            <Rocket size={14} /> Apply to {goodFit} good fit{goodFit === 1 ? "" : "s"}
          </button>
        ) : tab === "todo" && count("todo") ? (
          <button className="btn primary" disabled={busy} onClick={() => setApply({ ids: [], scope: "pending" })}>
            <Rocket size={14} /> Apply to all
          </button>
        ) : null}
      </div>

      {!data && loading ? <Skeleton rows={8} height={40} /> : null}
      {data && !items.length ? (
        <Empty icon={Briefcase} title="No jobs yet">
          Click <strong>Find jobs</strong> to search LinkedIn for roles that fit your resume: each job is added to your sheet with its job description and a score. Or add rows (Company, Job Title, Apply Link) to your sheet and click <strong>Sync sheet</strong>.
        </Empty>
      ) : null}
      {data && items.length && !shown.length ? <p className="muted small">Nothing here{tab === "found" ? " — click Find jobs." : "."}</p> : null}

      {shown.length ? (
        <div className="panel flush">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input type="checkbox" aria-label="Select all" checked={shown.length > 0 && shown.every((j) => selected.has(j.jobId))} onChange={(e) => setSelected(e.target.checked ? new Set(shown.map((j) => j.jobId)) : new Set())} />
                  </th>
                  <th>Job</th>
                  <th>Score</th>
                  <th className="hide-md">Your skills it asks for</th>
                  <th>Status</th>
                  <th className="hide-md">Resume</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((j) => {
                  const st = stage(j.status);
                  return (
                    <tr key={j.jobId} className="clickable" onClick={() => navigate(`/jobs/${j.jobId}`)}>
                      <td onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" aria-label={`Select ${j.company} ${j.title}`} checked={selected.has(j.jobId)} onChange={() => toggle(j.jobId)} />
                      </td>
                      <td>
                        <div className="cell-title">{j.title}</div>
                        <div className="cell-sub">
                          {j.company}
                          {j.location && j.location !== "Unspecified" ? ` · ${j.location}` : ""}
                          {j.workMode ? ` · ${j.workMode}` : ""}
                          {j.postedDate ? ` · posted ${ago(j.postedDate)}` : ""}
                          {j.source === "linkedin" ? " · LinkedIn" : ""}
                        </div>
                      </td>
                      <td>
                        <ScoreBar value={j.matchScore} />
                        {j.fit === "LOW" && j.fitReason ? <div className="xs muted" style={{ marginTop: 3 }}>{fitWhy(j.fitReason)}</div> : null}
                        {j.experienceFit === "INCOMPATIBLE" && j.fitReason !== "EXPERIENCE_INCOMPATIBLE" ? <div className="xs muted">needs more experience</div> : null}
                      </td>
                      <td className="hide-md" style={{ maxWidth: 300 }}>
                        <div className="row wrap" style={{ gap: 3 }}>
                          {j.matchedSkills.slice(0, 5).map((s) => (
                            <Badge key={s} tone="green">
                              {s}
                            </Badge>
                          ))}
                          {j.missingSkills.slice(0, 3).map((s) => (
                            <Badge key={`m-${s}`}>{s}?</Badge>
                          ))}
                          {!j.matchedSkills.length && !j.missingSkills.length ? <span className="muted xs">—</span> : null}
                        </div>
                      </td>
                      <td>
                        <Badge tone={st.tone}>{st.label}</Badge> {j.queued ? <Badge tone="cyan">queued</Badge> : null}
                        {st.group === "problem" && (j.lastError || j.blockReason) ? <div className="xs muted" style={{ marginTop: 4, maxWidth: 280 }}>{(j.lastError ?? j.blockReason ?? "").slice(0, 120)}</div> : null}
                      </td>
                      <td className="hide-md" onClick={(e) => e.stopPropagation()}>
                        {j.resumeId ? (
                          <a className="btn ghost sm" href={tokenUrl(`/api/resumes/${encodeURIComponent(j.resumeId)}/file`)} target="_blank" rel="noreferrer noopener">
                            <FileText size={13} /> PDF
                          </a>
                        ) : (
                          <span className="muted xs">—</span>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row">
                          {st.group !== "done" && !j.queued ? (
                            <button className="btn sm" disabled={busy && op !== "auto-apply"} onClick={() => setApply({ ids: [j.jobId], scope: "selected" })}>
                              <Rocket size={13} /> Apply
                            </button>
                          ) : null}
                          <a className="btn ghost sm" href={j.applyUrl} target="_blank" rel="noreferrer noopener" aria-label="Open the job posting">
                            <ExternalLink size={13} />
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {selected.size ? (
        <div className="bulkbar">
          <strong>{selected.size} selected</strong>
          <button className="btn primary sm" disabled={busy && op !== "auto-apply"} onClick={() => setApply({ ids: [...selected], scope: "selected" })}>
            <Rocket size={13} /> Tailor resume & apply
          </button>
          <button className="btn ghost sm" onClick={() => act(() => post("/api/jobs/skip", { jobIds: [...selected] }), "Skipped").then(() => setSelected(new Set()))}>
            Skip
          </button>
          <button className="btn ghost sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      ) : null}

      {apply ? <AutoApplyModal jobIds={apply.ids} scope={apply.scope} onClose={() => setApply(null)} /> : null}
      {items.length ? <p className="xs muted">Updated {ago(items[0]?.updatedAt)} · every job is also in your Google Sheet (Jobs tab; JD in the Job Details tab).</p> : null}
    </div>
  );
}
