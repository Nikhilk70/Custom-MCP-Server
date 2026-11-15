import { Bell, Bot, Briefcase, FileText, RefreshCw, Settings, Wifi, WifiOff, Zap } from "lucide-react";
import { useState, type ReactNode } from "react";
import { post } from "../lib/api.ts";
import { useAction, useApp } from "../lib/store.tsx";
import { useRoute } from "../lib/router.ts";
import { AgentPill, KillSwitch, ModeBanner } from "./AgentStatus.tsx";
import { NotificationsPopover } from "./Notifications.tsx";

export const NAV = [
  { to: "/jobs", label: "Jobs", icon: Briefcase },
  { to: "/agent", label: "Apply", icon: Bot },
  { to: "/needs-you", label: "Needs you", icon: Zap, countKey: "tasks" as const },
  { to: "/resume", label: "Resume", icon: FileText },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Shell({ children }: { children: ReactNode }) {
  const { state, connected } = useApp();
  const route = useRoute();
  const act = useAction();
  const [notifOpen, setNotifOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const current = (to: string) => (route.path === to || route.path.startsWith(`${to}/`) ? "page" : undefined);
  const tasks = state?.tasks.pending ?? 0;
  const refresh = async () => {
    setRefreshing(true);
    await act(() => post("/api/refresh"), "Data refreshed from your sheet");
    setRefreshing(false);
  };

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Main">
        <a href="#/jobs" className="brand" style={{ textDecoration: "none", color: "inherit" }}>
          <span className="brand-mark" aria-hidden>
            <Zap size={15} color="#fff" />
          </span>
          <span>
            <div className="brand-name">ApplyPilot</div>
            <div className="brand-sub">Sheet → resume → apply</div>
          </span>
        </a>
        {NAV.map((n) => (
          <a key={n.to} href={`#${n.to}`} className="nav-item" aria-current={current(n.to)}>
            <n.icon size={16} aria-hidden />
            {n.label}
            {n.countKey === "tasks" && tasks ? (
              <span className="count" aria-label={`${tasks} pending`}>
                {tasks}
              </span>
            ) : null}
          </a>
        ))}
        <div className="sidebar-foot">
          <div className="row xs muted" style={{ padding: "8px 10px 2px" }}>
            {connected ? <Wifi size={12} aria-hidden /> : <WifiOff size={12} aria-hidden />} {connected ? "Live updates on" : "Reconnecting…"}
          </div>
        </div>
      </nav>
      <div className="main">
        <header className="topbar">
          <div className="spacer" />
          <AgentPill />
          <KillSwitch />
          <button className="btn ghost icon" onClick={refresh} disabled={refreshing || state?.operation !== null} aria-label="Refresh data from your sheet" title="Refresh data">
            <RefreshCw size={15} style={refreshing ? { animation: "spin 1s linear infinite" } : undefined} />
          </button>
          <div style={{ position: "relative" }}>
            <button className="btn ghost icon" onClick={() => setNotifOpen((o) => !o)} aria-label={`Notifications${state?.notifications.unread ? `, ${state.notifications.unread} unread` : ""}`} aria-expanded={notifOpen}>
              <Bell size={15} />
              {state?.notifications.unread ? <span className="status-dot warn" style={{ position: "absolute", top: 6, right: 6 }} aria-hidden /> : null}
            </button>
            {notifOpen ? <NotificationsPopover onClose={() => setNotifOpen(false)} /> : null}
          </div>
        </header>
        <ModeBanner />
        <main id="main" className="content" tabIndex={-1}>
          {children}
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Main (mobile)">
        {NAV.map((n) => (
          <a key={n.to} href={`#${n.to}`} aria-current={current(n.to)}>
            <n.icon size={18} aria-hidden />
            {n.label}
            {n.countKey === "tasks" && tasks ? <span className="status-dot warn" style={{ position: "absolute", top: 2, right: 4 }} aria-hidden /> : null}
          </a>
        ))}
      </nav>
    </div>
  );
}
