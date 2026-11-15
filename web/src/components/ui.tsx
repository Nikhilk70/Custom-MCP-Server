import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { tokenUrl } from "../lib/api.ts";
import { useApp } from "../lib/store.tsx";

export function Badge({ tone = "", children, icon: Icon }: { tone?: "" | "blue" | "violet" | "green" | "amber" | "red" | "cyan"; children: ReactNode; icon?: LucideIcon }) {
  return (
    <span className={`badge ${tone}`}>
      {Icon ? <Icon aria-hidden /> : null}
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, "" | "blue" | "violet" | "green" | "amber" | "red" | "cyan"> = {
  APPLIED: "green",
  CONFIRMED: "green",
  SUBMITTED: "cyan",
  SUBMISSION_UNVERIFIED: "cyan",
  READY_TO_APPLY: "blue",
  READY_TO_SUBMIT: "blue",
  READY_FOR_RESUME: "blue",
  RESUME_GENERATED: "blue",
  QUEUED: "violet",
  RUNNING: "violet",
  FILLING: "violet",
  APPLYING: "violet",
  NEEDS_HUMAN: "amber",
  HUMAN_REQUIRED: "amber",
  VALIDATION_FAILED: "amber",
  BLOCKED: "amber",
  FAILED: "red",
  REJECTED: "red",
  NOT_MATCHED: "",
  SKIPPED: "",
  DUPLICATE: "",
  CANCELLED: "",
  DONE: "green",
  MATCHED: "blue",
  JD_FETCHED: "",
  NORMALIZED: "",
  DISCOVERED: "",
};
const STATUS_LABEL: Record<string, string> = {
  READY_TO_APPLY: "Ready",
  READY_FOR_RESUME: "Ready (needs resume)",
  RESUME_GENERATED: "Resume ready",
  NEEDS_HUMAN: "Needs you",
  HUMAN_REQUIRED: "Needs you",
  VALIDATION_FAILED: "Needs you",
  SUBMISSION_UNVERIFIED: "Submitted · unverified",
  NOT_MATCHED: "JD read",
  JD_FETCHED: "Awaiting match",
  NORMALIZED: "New",
  DISCOVERED: "New",
  APPLIED: "Applied",
  DONE: "Done",
};
export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? ""}>{STATUS_LABEL[status] ??status.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}</Badge>;
}

export function MatchScore({ value }: { value: number | null }) {
  if (value === null) return <span className="muted">—</span>;
  return (
    <span className="match" aria-label={`match ${value}%`}>
      <span className="match-bar" aria-hidden>
        <span style={{ width: `${value}%` }} />
      </span>
      {value}%
    </span>
  );
}

export function Panel({ title, icon: Icon, actions, children, className = "", flush = false, id }: { title?: ReactNode; icon?: LucideIcon; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean; id?: string }) {
  return (
    <section className={`panel ${className}`} id={id} aria-label={typeof title === "string" ? title : undefined}>
      {title !== undefined ? (
        <div className="panel-head">
          <h2 className="panel-title">
            {Icon ? <Icon size={15} aria-hidden /> : null}
            {title}
          </h2>
          {actions ? <div className="row">{actions}</div> : null}
        </div>
      ) : null}
      <div className={`panel-body ${flush ? "flush" : ""}`}>{children}</div>
    </section>
  );
}

export function Callout({ tone = "info", title, children, icon }: { tone?: "info" | "warn" | "danger" | "success"; title?: string; children: ReactNode; icon?: LucideIcon }) {
  const Icon = icon ?? (tone === "warn" ? AlertTriangle : tone === "danger" ? XCircle : tone === "success" ? CheckCircle2 : Info);
  return (
    <div className={`callout ${tone}`} role={tone === "danger" || tone === "warn" ? "alert" : "note"}>
      <Icon size={16} aria-hidden />
      <div>
        {title ? <div className="title">{title}</div> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function Empty({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="icon">
        <Icon size={22} aria-hidden />
      </div>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function Skeleton({ rows = 4, height = 14 }: { rows?: number; height?: number }) {
  return (
    <div className="stack sm" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height, width: `${70 + ((i * 13) % 30)}%` }} />
      ))}
    </div>
  );
}

export function Spinner({ label = "Working" }: { label?: string }) {
  return (
    <span className="row muted small" role="status">
      <Loader2 size={14} className="spin" aria-hidden style={{ animation: "spin 1s linear infinite" }} /> {label}
    </span>
  );
}

/** Accessible modal: focus trap, Escape closes, labelled by its title. */
export function Dialog({ title, subtitle, onClose, children, footer, wide = false, closeLabel = "Close" }: { title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; closeLabel?: string }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("input, textarea, select, button:not([data-close])");
    (first ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && el) {
        const f = [...el.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), input:not(:disabled), textarea, select, [tabindex]:not([tabindex='-1'])")];
        if (!f.length) return;
        const a = f[0] as HTMLElement;
        const z = f[f.length - 1] as HTMLElement;
        if (e.shiftKey && document.activeElement === a) {
          z.focus();
          e.preventDefault();
        } else if (!e.shiftKey && document.activeElement === z) {
          a.focus();
          e.preventDefault();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} tabIndex={-1}>
        <div className="dialog-head">
          <div>
            <h2 id={id} style={{ fontSize: "var(--fs-xl)" }}>
              {title}
            </h2>
            {subtitle ? <div className="muted small" style={{ marginTop: 4 }}>{subtitle}</div> : null}
          </div>
          <button className="btn ghost icon" onClick={onClose} aria-label={closeLabel} data-close>
            <X size={16} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/**
 * Spotlight: a centred, wide detail window (replaces the old right-edge drawer). A banner header with an optional
 * monogram/icon tile, title, subtitle and chips; an optional sticky side column; a footer action bar. On phones it
 * becomes a full-height bottom sheet.
 */
export function Drawer({ title, subtitle, onClose, children, footer, icon, meta, aside, accent = "blue", size = "lg" }: { title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; icon?: ReactNode; meta?: ReactNode; aside?: ReactNode; accent?: "blue" | "violet" | "green" | "amber" | "red" | "cyan"; size?: "md" | "lg" }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="spot-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} className={`spot ${size} accent-${accent}`} role="dialog" aria-modal="true" aria-labelledby={id}>
        <header className="spot-hero">
          <div className="spot-glow" aria-hidden />
          <div className="spot-hero-row">
            {icon ? <div className="spot-icon" aria-hidden>{icon}</div> : null}
            <div className="spot-titles">
              <h2 id={id} className="spot-title">{title}</h2>
              {subtitle ? <div className="spot-sub">{subtitle}</div> : null}
            </div>
            <button className="btn ghost icon spot-close" onClick={onClose} aria-label="Close panel">
              <X size={18} />
            </button>
          </div>
          {meta ? <div className="spot-meta">{meta}</div> : null}
        </header>
        <div className={`spot-body${aside ? " has-aside" : ""}`}>
          <div className="spot-main">{children}</div>
          {aside ? <aside className="spot-aside">{aside}</aside> : null}
        </div>
        {footer ? <footer className="spot-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

/** A coloured initials tile for a company/name. */
/**
 * A company's logo (fetched once by the local server from the company's own domain), or its initials on a coloured
 * tile when there is no logo. Logos never load from outside sites directly.
 */
export function Monogram({ name }: { name: string }) {
  const [state, setState] = useState<"loading" | "ok" | "none">(() => LOGO_STATE.get(name) ?? "loading");
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").split(/s+/).filter(Boolean);
  const text = (words.length > 1 ? (words[0]?.[0] ?? "") + (words[1]?.[0] ?? "") : name.slice(0, 2)).toUpperCase();
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  const done = (v: "ok" | "none") => {
    LOGO_STATE.set(name, v);
    setState(v);
  };
  return (
    <span className={`monogram${state === "ok" ? " has-logo" : ""}`} style={state === "ok" ? undefined : { background: `linear-gradient(135deg, hsl(${h} 80% 58%), hsl(${(h + 50) % 360} 75% 48%))` }}>
      {state === "ok" ? null : text || "?"}
      {state === "none" ? null : <img src={tokenUrl(`/api/logo?company=${encodeURIComponent(name)}`)} alt="" loading="lazy" onLoad={() => done("ok")} onError={() => done("none")} style={state === "ok" ? undefined : { position: "absolute", opacity: 0, width: 1, height: 1 }} />}
    </span>
  );
}
/** Remembers which companies have a logo, so cards don't flicker or re-request on every render. */
const LOGO_STATE = new Map<string, "ok" | "none">();

/** A circular score ring (0–100). */
export function ScoreRing({ value, label, size = 64 }: { value: number | null; label: string; size?: number }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const v = value ?? 0;
  const tone = value === null ? "var(--text-4)" : v >= 70 ? "var(--green)" : v >= 45 ? "var(--amber)" : "var(--red)";
  return (
    <div className="ring" style={{ width: size }} aria-label={`${label} ${value === null ? "unknown" : `${value}%`}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-2)" strokeWidth="6" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${(c * v) / 100} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <span className="ring-val" style={{ width: size, height: size }}>{value === null ? "—" : value}</span>
      <span className="ring-label">{label}</span>
    </div>
  );
}

/** Small labelled fact tiles. */
export function FactTiles({ items }: { items: Array<{ label: string; value: ReactNode; icon?: LucideIcon; wide?: boolean }> }) {
  return (
    <div className="facts">
      {items.map(({ label, value, icon: Icon, wide }) => (
        <div key={label} className={`fact${wide ? " wide" : ""}`}>
          <div className="fact-label">
            {Icon ? <Icon size={12} aria-hidden /> : null}
            {label}
          </div>
          <div className="fact-value">{value ?? <span className="muted">—</span>}</div>
        </div>
      ))}
    </div>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  if (!toasts.length) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => {
        const Icon = t.level === "error" ? XCircle : t.level === "success" ? CheckCircle2 : t.level === "warn" ? AlertTriangle : Info;
        return (
          <div key={t.id} className={`toast ${t.level}`} role="status">
            <Icon size={16} className={`lvl-${t.level}`} aria-hidden />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="strong">{t.title}</div>
              {t.body ? <div className="muted small">{t.body}</div> : null}
              {t.link ? (
                <a href={t.link} className="small" onClick={() => dismissToast(t.id)}>
                  Open
                </a>
              ) : null}
            </div>
            <button className="btn ghost icon sm" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: Array<{ id: T; label: string; count?: number }> }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((it) => (
        <button key={it.id} role="tab" className="tab" aria-selected={value === it.id} onClick={() => onChange(it.id)}>
          {it.label}
          {it.count !== undefined ? <span className="n">{it.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function SourceTag({ source }: { source: string | null }) {
  if (!source) return null;
  const label: Record<string, string> = { APPLICATION_ANSWERS: "Your answers", HUMAN_ANSWER: "Answered by you", PROFILE: "Profile", RESUME: "Resume data", RESUME_FILE: "Resume file", QUESTION_BANK: "Question bank", AI_SUGGESTED: "AI suggested" };
  const tone = source === "HUMAN_ANSWER" ? "violet" : source === "APPLICATION_ANSWERS" ? "blue" : source === "AI_SUGGESTED" ? "amber" : "";
  return <Badge tone={tone}>{label[source] ?? source}</Badge>;
}

export function Kv({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="kv">
      {items.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v ?? <span className="muted">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Page controls: "Showing 26–50 of 140", previous / next, and page numbers around the current one. */
export function Pager({ page, total, pageSize, onPage, label = "items" }: { page: number; total: number; pageSize: number; onPage: (p: number) => void; label?: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const nums = [...new Set([1, page - 1, page, page + 1, pages].filter((n) => n >= 1 && n <= pages))].sort((a, b) => a - b);
  return (
    <nav className="pager" aria-label="Pages">
      <span className="muted small">
        Showing {from}–{to} of {total} {label}
      </span>
      <div className="row" style={{ gap: 4 }}>
        <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          ‹
        </button>
        {nums.map((n, i) => (
          <span key={n} className="row" style={{ gap: 4 }}>
            {i > 0 && n - (nums[i - 1] ?? n) > 1 ? <span className="muted xs">…</span> : null}
            <button className={`btn sm${n === page ? " primary" : ""}`} onClick={() => onPage(n)} aria-label={`Page ${n}`} aria-current={n === page ? "page" : undefined}>
              {n}
            </button>
          </span>
        ))}
        <button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          ›
        </button>
      </div>
    </nav>
  );
}
