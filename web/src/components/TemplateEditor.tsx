import { Download, Eye, FileCode2, RotateCcw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { api, tokenUrl } from "../lib/api.ts";
import { useAction } from "../lib/store.tsx";
import { Badge, Callout, Dialog, Skeleton } from "./ui.tsx";

interface TemplateInfo {
  tex: string;
  path: string;
  version: string;
  sha256: string;
  markers: string[];
  approved: boolean;
  compiler: string | null;
}
interface Preview {
  ok: boolean;
  id: string | null;
  log: string;
  errors: string[];
}

/**
 * master.tex on the left, its compiled PDF on the right. "With my data" fills the AUTO markers from MY_DATA the way a
 * generated resume does (no job tailoring). Saving writes master.tex and records it as approved (a deliberate edit).
 */
export function TemplateEditor() {
  const act = useAction();
  const [info, setInfo] = useState<TemplateInfo | null>(null);
  const [tex, setTex] = useState("");
  const [withData, setWithData] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);
  const dirty = info !== null && tex !== info.tex;

  const compile = async (source: string, data: boolean) => {
    setBusy(true);
    const r = await act(() => api<Preview>("/api/template/preview", { body: { tex: source, withData: data } }));
    setPreview(r);
    setBusy(false);
  };

  useEffect(() => {
    void api<TemplateInfo>("/api/template")
      .then((t) => {
        setInfo(t);
        setTex(t.tex);
        if (t.compiler) void compile(t.tex, true);
      })
      .catch(() => setInfo(null));
  }, []);

  if (!info) return <Skeleton rows={12} />;
  const pdf = preview?.ok && preview.id ? tokenUrl(`/api/template/pdf/${preview.id}`) : null;

  return (
    <div className="stack">
      <div className="row between wrap">
        <div className="row wrap">
          <FileCode2 size={16} aria-hidden />
          <span className="mono small">{info.path}</span>
          <Badge>v{info.version}</Badge>
          <Badge tone={info.approved ? "green" : "amber"}>{info.approved ? "approved" : "not approved yet"}</Badge>
          {dirty ? <Badge tone="blue">unsaved changes</Badge> : null}
        </div>
        <div className="row wrap">
          <div className="tabs" role="tablist" aria-label="Preview content">
            <button role="tab" className="tab" aria-selected={withData} onClick={() => (setWithData(true), void compile(tex, true))}>
              With my data
            </button>
            <button role="tab" className="tab" aria-selected={!withData} onClick={() => (setWithData(false), void compile(tex, false))}>
              Template only
            </button>
          </div>
          <button className="btn" onClick={() => compile(tex, withData)} disabled={busy || !info.compiler}>
            <Eye size={14} /> {busy ? "Compiling…" : "Preview"}
          </button>
          <a className={`btn ${pdf ? "" : "disabled"}`} href={pdf ? `${pdf}&download=1` : undefined} aria-disabled={!pdf} onClick={(e) => !pdf && e.preventDefault()}>
            <Download size={14} /> Download PDF
          </a>
          <button className="btn ghost" onClick={() => setTex(info.tex)} disabled={!dirty}>
            <RotateCcw size={14} /> Revert
          </button>
          <button className="btn primary" onClick={() => setConfirmSave(true)} disabled={!dirty}>
            <Save size={14} /> Save
          </button>
        </div>
      </div>
      {!info.compiler ? <Callout tone="warn" title="No LaTeX compiler found">Install MiKTeX or TeX Live, or set LOCAL_LATEX_COMMAND in .env, to preview and download PDFs.</Callout> : null}
      <div className="grid cols-2" style={{ alignItems: "stretch" }}>
        <div className="field">
          <label htmlFor="tpl-tex">LaTeX source</label>
          <textarea
            id="tpl-tex"
            className="textarea mono"
            spellCheck={false}
            value={tex}
            onChange={(e) => setTex(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void compile(tex, withData);
              if (e.key === "Tab") {
                e.preventDefault();
                const el = e.currentTarget;
                const s = el.selectionStart;
                setTex(`${tex.slice(0, s)}  ${tex.slice(el.selectionEnd)}`);
                requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
              }
            }}
            style={{ height: "72vh", fontSize: 12.5, lineHeight: 1.55, whiteSpace: "pre", overflowWrap: "normal" }}
          />
          <span className="hint">
            Ctrl+Enter to preview. Keep the <span className="mono">% === AUTO: … ===</span> markers ({info.markers.join(", ")}) — the agent fills them per job from your verified data.
          </span>
        </div>
        <div className="field">
          <label>PDF preview {withData ? "(filled with your data)" : "(template as written)"}</label>
          <div className="browser-frame" style={{ height: "72vh", display: "grid", placeItems: "center" }}>
            {busy ? (
              <span className="muted small">Compiling with {info.compiler ?? "LaTeX"}…</span>
            ) : pdf ? (
              <iframe title="Resume PDF preview" src={pdf} style={{ width: "100%", height: "100%", border: 0, background: "#fff" }} />
            ) : preview && !preview.ok ? (
              <div className="stack" style={{ padding: 16, width: "100%", alignSelf: "start" }}>
                <Callout tone="danger" title="LaTeX did not compile">
                  {preview.errors.length ? preview.errors.join(" · ") : "See the log below."}
                </Callout>
                <pre className="mono xs" style={{ whiteSpace: "pre-wrap", maxHeight: "50vh", overflow: "auto", color: "var(--text-2)" }}>
                  {preview.log}
                </pre>
              </div>
            ) : (
              <span className="muted small">Click Preview to compile.</span>
            )}
          </div>
        </div>
      </div>
      {confirmSave ? (
        <Dialog
          title="Save and approve master.tex?"
          subtitle="Every future tailored resume uses this template. The previous version is kept as a backup."
          onClose={() => setConfirmSave(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmSave(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  const r = await act(() => api<TemplateInfo>("/api/template", { body: { tex } }), "Template saved and approved");
                  if (r) {
                    setInfo(r);
                    setTex(r.tex);
                  }
                  setConfirmSave(false);
                }}
              >
                Save & approve
              </button>
            </>
          }
        >
          <p className="small muted">Saving records the new version as approved (the same as running npm run template:approve). Preview it first to be sure it compiles.</p>
        </Dialog>
      ) : null}
    </div>
  );
}
