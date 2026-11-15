import { FileUp, Save, Star, Trash2, UserRound, Sparkles, RefreshCw, Database, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, tokenUrl } from "../lib/api.ts";
import { dateTime } from "../lib/format.ts";
import { useAction, useData } from "../lib/store.tsx";
import { Badge, Callout, Panel, Skeleton, Tabs } from "../components/ui.tsx";
import { TemplateEditor } from "../components/TemplateEditor.tsx";

interface ProfileField {
  key: string;
  id: string;
  label: string;
  hint: string | null;
  multiline: boolean;
  value: string | null;
  fallback: { value: string; source: string; basis: string } | null;
  inFile: boolean;
}
interface ProfileData {
  sections: Array<{ id: string; title: string; fields: ProfileField[] }>;
  conflicts: string[];
  myData: { personal: Record<string, string | null>; experience: Array<{ company: string; role: string; type: string; startDate: string | null; endDate: string | null; current: boolean }>; education: Array<{ institution: string; degree: string; endDate: string | null }>; skills: Record<string, string[]>; missing: string[] };
}
interface ResumeItem {
  id: string;
  kind: "UPLOADED" | "TAILORED";
  file: string;
  label: string;
  purpose: string | null;
  company: string | null;
  updatedAt: string;
  sizeBytes: number | null;
  sha256: string | null;
  primary: boolean;
  status: string;
}
interface ResumeAutofill {
  resumeId: string;
  label: string;
  source: "AI" | "PATTERNS";
  extractedAt: string;
  fields: Record<string, string>;
  note: string | null;
}
interface ImportResult {
  importId: string;
  resumeId: string;
  importedAt: string;
  counts: { experience: number; projects: number; education: number; certifications: number; skills: number };
  answersUpdated: string[];
  name: string | null;
}

export function Profile() {
  const [tab, setTab] = useState<"resumes" | "profile" | "template">("resumes");
  /** Set after an upload (or "Fill profile"): Edit profile opens pre-filled from this resume. */
  const [autofill, setAutofill] = useState<ResumeAutofill | null>(null);
  const fillFrom = (a: ResumeAutofill) => {
    setAutofill(a);
    setTab("profile");
  };
  const act = useAction();
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [undone, setUndone] = useState(false);
  const onImported = (r: ImportResult) => {
    setImported(r);
    setUndone(false);
    setTab("profile");
  };
  const undo = async () => {
    if (!imported) return;
    const r = await act(() => api(`/api/resume-imports/${encodeURIComponent(imported.importId)}/undo`, { body: {} }), "Previous resume data restored");
    if (r) setUndone(true);
  };
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">Resume</h1>
          <p className="page-sub">Upload your resume once; every job gets a copy tailored to its job description from this data and the template.</p>
        </div>
        <Tabs value={tab} onChange={setTab} items={[{ id: "resumes", label: "Upload resume" }, { id: "profile", label: "Edit details" }, { id: "template", label: "Resume template" }]} />
      </div>
      {imported ? (
        <Callout tone={undone ? "info" : "success"} icon={Database} title={undone ? "Import undone: your previous resume data is back" : `Resume data updated from ${imported.resumeId}`}>
          <div className="row between wrap small">
            <span>
              {undone
                ? "MY_DATA, the source resume and your answers are exactly as they were before this import."
                : `${imported.name ?? "Your"} details now come from this resume: ${imported.counts.experience} experience, ${imported.counts.projects} projects, ${imported.counts.education} education, ${imported.counts.skills} skills, ${imported.counts.certifications} certifications. ${imported.answersUpdated.length ? `Updated answers: ${imported.answersUpdated.join(", ")}.` : "Your answers already matched."} Everything below is editable.`}
            </span>
            {undone ? (
              <button className="btn ghost sm" onClick={() => setImported(null)}>
                Dismiss
              </button>
            ) : (
              <button className="btn ghost sm" onClick={undo}>
                <Undo2 size={13} /> Undo
              </button>
            )}
          </div>
        </Callout>
      ) : null}
      {tab === "profile" ? <ProfileForm autofill={autofill} onAutofillDone={() => setAutofill(null)} /> : tab === "resumes" ? <Resumes onFill={fillFrom} onImported={onImported} /> : <TemplateEditor />}
    </div>
  );
}

function ProfileForm({ autofill, onAutofillDone }: { autofill: ResumeAutofill | null; onAutofillDone: () => void }) {
  const act = useAction();
  const { data, reload } = useData<ProfileData>("/api/profile", ["answers"]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  /** Fields whose current edit came from the resume (cleared once you change that field). */
  const [fromResume, setFromResume] = useState<Set<string>>(new Set());
  const [applied, setApplied] = useState<ResumeAutofill | null>(null);
  const [filling, setFilling] = useState(false);
  useEffect(() => {
    setEdits({});
    setFromResume(new Set());
  }, [data]);
  // Only fields where the resume says something different from what is saved become (unsaved) edits.
  const apply = (a: ResumeAutofill, d: ProfileData) => {
    const saved = new Map(d.sections.flatMap((s) => s.fields).map((f) => [f.key, f.value ?? ""]));
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(a.fields)) if (saved.has(k) && v && v !== saved.get(k)) next[k] = v;
    setEdits(next);
    setFromResume(new Set(Object.keys(next)));
    setApplied(a);
  };
  useEffect(() => {
    if (autofill && data) {
      apply(autofill, data);
      onAutofillDone();
    }
  }, [autofill, data]);
  const fillFromLatest = async () => {
    if (!data) return;
    setFilling(true);
    const r = await act(() => api<{ autofill: ResumeAutofill | null }>("/api/resumes/autofill"), "Read your resume");
    setFilling(false);
    if (r?.autofill) apply(r.autofill, data);
  };
  const edit = (key: string, value: string) => {
    setEdits({ ...edits, [key]: value });
    if (fromResume.has(key)) setFromResume(new Set([...fromResume].filter((k) => k !== key)));
  };
  const dirty = Object.keys(edits).length;
  const save = async () => {
    const fields = Object.entries(edits).map(([key, value]) => ({ key, value }));
    const r = await act(() => api<{ saved: number; conflicts: string[] }>("/api/profile", { method: "PATCH", body: { fields } }), "Profile saved");
    if (r) {
      setApplied(null);
      reload();
    }
  };
  if (!data) return <Skeleton rows={12} />;
  return (
    <div className="stack lg">
      {applied ? (
        <Callout tone="info" icon={Sparkles} title={`Filled from your resume · ${applied.label}`}>
          <span className="small">
            {fromResume.size
              ? `${fromResume.size} field${fromResume.size === 1 ? "" : "s"} pre-filled (marked "from resume"). Review and edit them, then Save profile. Nothing is saved until you do.`
              : "Your saved profile already matches this resume. Nothing new to fill."}{" "}
            {applied.source === "AI" ? "Read with AI; only facts stated in the resume are used." : "Read with pattern matching."}
            {applied.note ? ` ${applied.note}.` : ""}
          </span>
        </Callout>
      ) : (
        <div className="row">
          <button className="btn ghost sm" onClick={fillFromLatest} disabled={filling}>
            <Sparkles size={13} /> {filling ? "Reading resume…" : "Fill from latest uploaded resume"}
          </button>
        </div>
      )}
      {data.conflicts.length ? (
        <Callout tone="warn" title="Some answers contradict your resume data and are not used">
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {data.conflicts.map((c) => (
              <li key={c} className="small">
                {c}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
      {data.myData.missing.length ? (
        <Callout tone="info" title="Resume data (MY_DATA) has gaps">
          <span className="small">{data.myData.missing.join(" · ")} — fill them in Data_Resume/MY_DATA to improve matching and answers.</span>
        </Callout>
      ) : null}
      <div className="grid cols-2">
        {data.sections.map((s) => (
          <Panel key={s.id} title={s.title} icon={UserRound}>
            <div className="stack">
              {s.fields.map((f) => {
                const v = edits[f.key] ?? f.value ?? "";
                return (
                  <div key={f.key} className="field">
                    <label htmlFor={`pf-${f.id}`}>
                      {f.label}
                      {fromResume.has(f.key) ? (
                        <>
                          {" "}
                          <Badge tone="blue">from resume</Badge>
                        </>
                      ) : null}
                      {f.fallback && !v ? <span className="xs muted"> · from {f.fallback.source === "RESUME" ? "resume data" : "profile"}</span> : null}
                    </label>
                    {f.multiline ? (
                      <textarea id={`pf-${f.id}`} className="textarea" value={v} placeholder={f.fallback?.value ?? "Not provided — the agent asks you"} onChange={(e) => edit(f.key, e.target.value)} />
                    ) : (
                      <input id={`pf-${f.id}`} className="input" value={v} placeholder={f.fallback?.value ?? "Not provided — the agent asks you"} onChange={(e) => edit(f.key, e.target.value)} autoComplete="off" />
                    )}
                    {f.hint ? <span className="hint">{f.hint}</span> : null}
                  </div>
                );
              })}
            </div>
          </Panel>
        ))}
      </div>
      <Panel title="Resume facts (read-only, from MY_DATA)">
        <div className="grid cols-3 small">
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>Experience</div>
            {data.myData.experience.map((e, i) => (
              <div key={i} className="muted">
                {e.role} · {e.company} ({e.startDate ?? "?"} – {e.current ? "now" : (e.endDate ?? "?")})
              </div>
            ))}
          </div>
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>Education</div>
            {data.myData.education.map((e, i) => (
              <div key={i} className="muted">
                {e.degree} · {e.institution} ({e.endDate ?? "?"})
              </div>
            ))}
          </div>
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>Verified skills</div>
            <div className="row wrap" style={{ gap: 4 }}>
              {Object.values(data.myData.skills)
                .flat()
                .slice(0, 40)
                .map((s) => (
                  <Badge key={s}>{s}</Badge>
                ))}
            </div>
          </div>
        </div>
      </Panel>
      {dirty ? (
        <div className="bulkbar">
          <strong>{dirty} change{dirty === 1 ? "" : "s"}</strong>
          <button className="btn primary sm" onClick={save}>
            <Save size={13} /> Save profile
          </button>
          <button
            className="btn ghost sm"
            onClick={() => {
              setEdits({});
              setFromResume(new Set());
              setApplied(null);
            }}
          >
            Discard
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Resumes({ onFill, onImported }: { onFill: (a: ResumeAutofill) => void; onImported: (r: ImportResult) => void }) {
  const act = useAction();
  const { data, reload } = useData<{ items: ResumeItem[]; useUploadedResume: boolean; primaryResumeId: string | null }>("/api/resumes", ["state", "applications"]);
  const file = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState("");
  const [purpose, setPurpose] = useState("");
  const [makeData, setMakeData] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [fillError, setFillError] = useState<string | null>(null);
  const fill = async (id: string) => {
    const r = await act(() => api<{ autofill: ResumeAutofill | null }>(`/api/resumes/autofill?id=${encodeURIComponent(id)}`), "Read your resume");
    if (r?.autofill) onFill(r.autofill);
  };
  const makeMyData = async (id: string) => {
    setBusy(id);
    const r = await act(() => api<ImportResult>(`/api/resumes/${encodeURIComponent(id)}/import`, { body: {} }), "Resume data updated from this resume");
    setBusy(null);
    if (r) onImported(r);
  };
  const upload = async () => {
    const f = file.current?.files?.[0];
    if (!f) return;
    setFillError(null);
    setBusy("upload");
    const r = await act(
      () =>
        api<ResumeItem & { imported: ImportResult | null; importError: string | null; autofill: ResumeAutofill | null; autofillError: string | null }>(
          `/api/resumes?name=${encodeURIComponent(f.name)}&label=${encodeURIComponent(label)}&purpose=${encodeURIComponent(purpose)}&import=${makeData ? "1" : "0"}`,
          { raw: f, contentType: "application/pdf" },
        ),
      makeData ? "Resume uploaded and read" : "Resume uploaded",
    );
    setBusy(null);
    if (r) {
      if (file.current) file.current.value = "";
      setLabel("");
      reload();
      if (r.imported) onImported(r.imported);
      else {
        if (r.importError) setFillError(`Your resume data was not changed: ${r.importError}`);
        if (r.autofill) onFill(r.autofill);
        else if (r.autofillError) setFillError(`The resume could not be read: ${r.autofillError}`);
      }
    }
  };
  if (!data) return <Skeleton rows={6} />;
  const uploaded = data.items.filter((r) => r.kind === "UPLOADED");
  const tailored = data.items.filter((r) => r.kind === "TAILORED");
  return (
    <div className="stack lg">
      <Callout tone="info" title="Which resume does the agent upload?">
        {data.useUploadedResume && data.primaryResumeId ? (
          <>
            Your primary uploaded resume <strong>{data.primaryResumeId}</strong> is used for every application.
          </>
        ) : (
          <>The tailored resume generated for each job (Data_Resume/Generated). Set an uploaded resume as primary to use it instead.</>
        )}
      </Callout>
      {fillError ? (
        <Callout tone="warn" title="Uploaded, but not fully applied">
          <span className="small">{fillError}</span>
        </Callout>
      ) : null}
      <div className="grid cols-2">
        <Panel title="Upload resume" icon={FileUp}>
          <div className="stack">
            <div className="field">
              <label htmlFor="rs-file">PDF file (max 10 MB)</label>
              <input id="rs-file" ref={file} type="file" accept="application/pdf" className="input" />
            </div>
            <div className="grid cols-2">
              <div className="field">
                <label htmlFor="rs-label">Label</label>
                <input id="rs-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Java Full Stack" />
              </div>
              <div className="field">
                <label htmlFor="rs-purpose">Purpose</label>
                <input id="rs-purpose" className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Java · Frontend · AI/ML · Full Stack" />
              </div>
            </div>
            <label className="row small" style={{ gap: 8, alignItems: "flex-start" }}>
              <input type="checkbox" checked={makeData} onChange={(e) => setMakeData(e.target.checked)} style={{ marginTop: 3 }} />
              <span>
                Make this my resume data — replaces your details, experience, projects, education, skills and certifications everywhere (MY_DATA, the answers the agent fills in, the source resume). Preferences, CTC, notice period and visa answers are kept. You can undo.
              </span>
            </label>
            <button className="btn primary" onClick={upload} disabled={busy !== null} style={{ alignSelf: "flex-start" }}>
              <FileUp size={14} /> {busy === "upload" ? (makeData ? "Reading resume… (up to a minute)" : "Uploading…") : "Upload"}
            </button>
            <span className="hint">After upload, Edit profile opens pre-filled with the resume's details for you to review, edit and save.</span>
            <span className="hint">Multiple resumes per purpose are supported in the data model; automatic per-job selection is coming soon — today the primary is used.</span>
          </div>
        </Panel>
        <Panel title="Uploaded resumes" flush>
          {uploaded.length ? (
            <table className="data">
              <thead>
                <tr>
                  <th>Resume</th>
                  <th className="hide-md">Updated</th>
                  <th className="hide-md">Version</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {uploaded.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div className="cell-title small">
                        {r.label} {r.primary ? <Badge tone="green" icon={Star}>primary</Badge> : null}
                      </div>
                      <div className="cell-sub mono">
                        {r.file} · {r.sizeBytes ? `${Math.round(r.sizeBytes / 1024)} KB` : ""}
                        {r.purpose ? ` · ${r.purpose}` : ""}
                      </div>
                    </td>
                    <td className="hide-md small muted">{dateTime(r.updatedAt)}</td>
                    <td className="hide-md xs mono muted">{r.sha256?.slice(0, 12)}</td>
                    <td>
                      <div className="row">
                        <a className="btn ghost sm" href={tokenUrl(`/api/resumes/${encodeURIComponent(r.id)}/file`)} target="_blank" rel="noreferrer noopener">
                          View
                        </a>
                        <button className="btn ghost sm" onClick={() => makeMyData(r.id)} disabled={busy !== null} title="Replace your resume data everywhere with this resume">
                          <Database size={13} /> {busy === r.id ? "Reading…" : "Use as my data"}
                        </button>
                        <button className="btn ghost sm" onClick={() => fill(r.id)} title="Pre-fill Edit profile from this resume (review before saving)">
                          <RefreshCw size={13} /> Fill profile
                        </button>
                        <button className="btn ghost sm" onClick={() => act(() => api("/api/resumes/primary", { body: { id: r.primary ? null : r.id, use: !r.primary } }), r.primary ? "Using tailored resumes again" : "Set as primary").then(reload)}>
                          <Star size={13} /> {r.primary ? "Unset" : "Set primary"}
                        </button>
                        <button className="btn ghost sm" onClick={() => confirm(`Delete ${r.file}?`) && act(() => api(`/api/resumes/${encodeURIComponent(r.id)}`, { method: "DELETE" }), "Deleted").then(reload)} aria-label="Delete">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted small" style={{ padding: 16 }}>
              No uploaded resumes. The agent uses the tailored resume it generates per job.
            </p>
          )}
        </Panel>
      </div>
      <Panel title={`Tailored resumes generated by the agent · ${tailored.length}`} flush>
        {tailored.length ? (
          <div className="table-wrap" style={{ maxHeight: 360 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Job</th>
                  <th className="hide-md">File</th>
                  <th>Status</th>
                  <th className="hide-md">Generated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {tailored.map((r) => (
                  <tr key={r.id}>
                    <td className="small">
                      {r.company} · {r.purpose}
                    </td>
                    <td className="hide-md xs mono muted">{r.file}</td>
                    <td>
                      <Badge tone={r.status === "GENERATED" ? "green" : "amber"}>{r.status.toLowerCase()}</Badge>
                    </td>
                    <td className="hide-md small muted">{dateTime(r.updatedAt)}</td>
                    <td>
                      {r.status === "GENERATED" ? (
                        <a className="btn ghost sm" href={tokenUrl(`/api/resumes/${encodeURIComponent(r.id)}/file`)} target="_blank" rel="noreferrer noopener">
                          View
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted small" style={{ padding: 16 }}>
            None yet — they are generated when a job is prepared for application.
          </p>
        )}
      </Panel>
    </div>
  );
}
