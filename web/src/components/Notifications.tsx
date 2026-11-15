import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { api, post } from "../lib/api.ts";
import { ago } from "../lib/format.ts";
import { useApp, useData } from "../lib/store.tsx";
import type { AppNotification } from "../lib/types.ts";

export function NotificationsPopover({ onClose }: { onClose: () => void }) {
  const { data, reload } = useData<{ items: AppNotification[]; unread: number }>("/api/notifications", ["notification"]);
  const { setPaletteOpen } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    setPaletteOpen(false);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, setPaletteOpen]);
  const markAll = async () => {
    await api("/api/notifications/read", { body: {} });
    reload();
  };
  const items = data?.items ?? [];
  const clearAll = async () => {
    await post("/api/notifications/clear");
    reload();
  };
  return (
    <div ref={ref} className="panel glass" role="dialog" aria-label="Notifications" style={{ position: "absolute", right: 0, top: 40, width: 360, zIndex: 30, maxHeight: 460, display: "flex", flexDirection: "column" }}>
      <div className="panel-head">
        <span className="panel-title">Notifications</span>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn ghost sm" onClick={markAll} disabled={!data?.unread}>
            Mark all read
          </button>
          <button className="btn ghost sm" onClick={clearAll} disabled={!items.length}>
            Clear
          </button>
        </div>
      </div>
      <div style={{ overflow: "auto" }}>
        {items.length ? (
          items.slice(0, 40).map((n) => {
            const Icon = n.level === "error" ? XCircle : n.level === "success" ? CheckCircle2 : n.level === "warn" ? AlertTriangle : Info;
            return (
              <a
                key={n.id}
                href={n.link ?? "#/jobs"}
                onClick={() => {
                  void api("/api/notifications/read", { body: { id: n.id } });
                  onClose();
                }}
                style={{ display: "grid", gridTemplateColumns: "18px 1fr auto", gap: 10, padding: "10px 16px", borderBottom: "1px solid var(--line)", color: "inherit", textDecoration: "none", opacity: n.read ? 0.65 : 1 }}
              >
                <Icon size={15} className={`lvl-${n.level}`} aria-hidden style={{ marginTop: 2 }} />
                <span style={{ minWidth: 0 }}>
                  <div className="strong small">{n.title}</div>
                  <div className="xs muted">{n.body}</div>
                </span>
                <span className="xs muted">{ago(n.at)}</span>
              </a>
            );
          })
        ) : (
          <div className="muted small" style={{ padding: 20, textAlign: "center" }}>
            No notifications yet
          </div>
        )}
      </div>
    </div>
  );
}
