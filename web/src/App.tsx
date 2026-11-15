import { Shell } from "./components/Shell.tsx";
import { Toasts } from "./components/ui.tsx";
import { useRoute } from "./lib/router.ts";
import { useApp } from "./lib/store.tsx";
import { AgentConsole } from "./pages/Agent.tsx";
import { JobDetail } from "./pages/JobDetail.tsx";
import { Jobs } from "./pages/Jobs.tsx";
import { NeedsYou } from "./pages/NeedsYou.tsx";
import { Profile } from "./pages/Profile.tsx";
import { Settings } from "./pages/Settings.tsx";

/** Five pages: your jobs (from the sheet), the agent applying, what needs you, your resume, settings. */
function Page() {
  const { parts } = useRoute();
  const [root = "jobs", id] = parts;
  switch (root) {
    case "agent":
      return <AgentConsole />;
    case "needs-you":
      return <NeedsYou />;
    case "resume":
      return <Profile />;
    case "settings":
      return <Settings />;
    default:
      return id ? <JobDetail jobId={id} key={id} /> : <Jobs />;
  }
}

export default function App() {
  const { ready, error } = useApp();
  if (error)
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%", padding: 24 }}>
        <div className="panel" style={{ padding: 28, maxWidth: 480 }}>
          <h1 style={{ fontSize: "var(--fs-xl)", marginBottom: 8 }}>ApplyPilot can't reach its server</h1>
          <p className="muted small">{error}</p>
          <p className="muted small" style={{ marginTop: 10 }}>
            Start it with <span className="mono">npm start</span> and reload this page.
          </p>
        </div>
      </div>
    );
  if (!ready)
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%" }} role="status">
        <div className="stack" style={{ alignItems: "center" }}>
          <div className="brand-mark" style={{ width: 40, height: 40 }} />
          <span className="muted small">Connecting to ApplyPilot…</span>
        </div>
      </div>
    );
  return (
    <>
      <Shell>
        <Page />
      </Shell>
      <Toasts />
    </>
  );
}
