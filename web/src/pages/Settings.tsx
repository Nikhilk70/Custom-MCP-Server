import { FlaskConical, Settings as SettingsIcon, ShieldAlert, ShieldCheck, Sheet } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { useAction, useApp, useData } from "../lib/store.tsx";
import { Panel, Skeleton } from "../components/ui.tsx";

interface SettingsData {
  settings: { delayBetweenApplicationsSec: number; dailyLiveLimit: number; maxApplicationsPerRun: number };
  liveArmed: boolean;
  defaults: { dryRun: boolean; mode: string };
  sheetId: string | null;
}

export function Settings() {
  const { state } = useApp();
  const act = useAction();
  const { data, reload } = useData<SettingsData>("/api/settings", ["state"]);
  const [confirm, setConfirm] = useState("");
  const [s, setS] = useState<SettingsData["settings"] | null>(null);
  useEffect(() => setS(data?.settings ?? null), [data]);
  if (!data || !s) return <Skeleton rows={8} />;
  const armed = state?.liveArmed ?? data.liveArmed;
  const save = () => act(() => api("/api/settings", { method: "PATCH", body: s }), "Settings saved").then(reload);

  return (
    <div className="stack lg">
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">Every run is a dry run until you turn on live mode here.</p>
        </div>
      </div>
      <div className="grid cols-2" style={{ alignItems: "start" }}>
        <Panel title="Live applications" icon={armed ? ShieldAlert : ShieldCheck}>
          <div className="stack">
            <div className={`callout ${armed ? "danger" : "info"}`}>
              {armed ? <ShieldAlert size={16} /> : <FlaskConical size={16} />}
              <div>
                <div className="title">{armed ? "Live mode is ON" : "Live mode is off — every run is a dry run"}</div>
                {armed ? "Runs you start in Live mode submit real applications. It turns off again when ApplyPilot restarts." : "Turn it on to be able to choose Live when you click Apply. Dry runs fill forms but submit nothing."}
              </div>
            </div>
            {armed ? (
              <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => act(() => api("/api/settings/live", { body: { armed: false } }), "Live mode off").then(reload)}>
                Turn off live mode
              </button>
            ) : (
              <div className="row wrap">
                <input className="input" style={{ maxWidth: 220 }} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Type LIVE" aria-label="Type LIVE to turn on live mode" autoComplete="off" />
                <button className="btn danger" disabled={confirm !== "LIVE"} onClick={() => act(() => api("/api/settings/live", { body: { armed: true, confirm } }), "Live mode on").then(() => (setConfirm(""), reload()))}>
                  Turn on live mode
                </button>
              </div>
            )}
            <p className="hint">Always on: the agent stops for CAPTCHAs, sign-ins and verification codes for you to complete, never guesses an answer, never pays, and never applies to the same job twice.</p>
          </div>
        </Panel>
        <Panel title="Limits" icon={SettingsIcon}>
          <div className="stack">
            <div className="field">
              <label htmlFor="se-max">Max applications per run</label>
              <input id="se-max" className="input" type="number" min={1} max={100} value={s.maxApplicationsPerRun} onChange={(e) => setS({ ...s, maxApplicationsPerRun: Number(e.target.value) })} />
            </div>
            <div className="field">
              <label htmlFor="se-delay">Delay between applications (seconds)</label>
              <input id="se-delay" className="input" type="number" min={0} max={3600} value={s.delayBetweenApplicationsSec} onChange={(e) => setS({ ...s, delayBetweenApplicationsSec: Number(e.target.value) })} />
            </div>
            <div className="field">
              <label htmlFor="se-daily">Live applications per day</label>
              <input id="se-daily" className="input" type="number" min={0} max={200} value={s.dailyLiveLimit} onChange={(e) => setS({ ...s, dailyLiveLimit: Number(e.target.value) })} />
            </div>
            <button className="btn primary" onClick={save} style={{ alignSelf: "flex-start" }}>
              Save
            </button>
          </div>
        </Panel>
        <Panel title="Your sheet" icon={Sheet}>
          <div className="stack sm small">
            {data.sheetId ? (
              <a href={`https://docs.google.com/spreadsheets/d/${data.sheetId}/edit`} target="_blank" rel="noreferrer noopener">
                Open your Google Sheet
              </a>
            ) : (
              <span className="muted">No sheet configured — set GOOGLE_SHEETS_SPREADSHEET_ID in .env.</span>
            )}
            <span className="muted">
              Add jobs as rows in the <strong>Jobs</strong> tab: <strong>Company</strong>, <strong>Job Title</strong>, <strong>Apply Link</strong> (Location optional). Leave <strong>Job ID</strong> empty — ApplyPilot fills it when you click Sync sheet.
            </span>
            <span className="muted">
              To sign in to Google once for &quot;Sign in with Google&quot; buttons, run <span className="mono">npm run browser:login</span>.
            </span>
          </div>
        </Panel>
      </div>
    </div>
  );
}
