import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, initSession, subscribe, type PushKind } from "./api.ts";
import type { ActivityEvent, AgentState, AppNotification } from "./types.ts";

export interface Toast {
  id: number;
  level: "info" | "success" | "warn" | "error";
  title: string;
  body?: string;
  link?: string | null;
}

interface AppStore {
  ready: boolean;
  error: string | null;
  connected: boolean;
  state: AgentState | null;
  /** Bumped whenever the server says a data set changed; pages refetch on it. */
  versions: Record<PushKind, number>;
  live: ActivityEvent[];
  toasts: Toast[];
  toast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
  reducedMotion: boolean;
  setReducedMotion: (v: boolean) => void;
  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
}

export type Theme = "dark" | "light" | "system";

function readPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

const Ctx = createContext<AppStore | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<AgentState | null>(null);
  const [versions, setVersions] = useState<Record<PushKind, number>>({ activity: 0, state: 0, queue: 0, tasks: 0, notification: 0, jobs: 0, applications: 0, answers: 0, memory: 0 });
  const [live, setLive] = useState<ActivityEvent[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [reducedMotion, setReducedMotionState] = useState(() => {
    try {
      return localStorage.getItem("ap.reducedMotion") === "1";
    } catch {
      return false;
    }
  });
  const [theme, setTheme] = useState<Theme>(() => readPref<Theme>("ap.theme", "dark"));
  const nextId = useRef(1);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "light" : "dark") : theme;
    };
    apply();
    try {
      localStorage.setItem("ap.theme", theme);
    } catch {
      /* private mode */
    }
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  const toast = useCallback((t: Omit<Toast, "id">) => {
    const id = nextId.current++;
    setToasts((x) => [...x.slice(-4), { ...t, id }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), t.level === "error" ? 9000 : 5500);
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((x) => x.filter((y) => y.id !== id)), []);

  useEffect(() => {
    document.documentElement.dataset.reducedMotion = reducedMotion ? "true" : "false";
    try {
      localStorage.setItem("ap.reducedMotion", reducedMotion ? "1" : "0");
    } catch {
      /* private mode */
    }
  }, [reducedMotion]);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    initSession()
      .then(async () => {
        setState(await api<AgentState>("/api/state"));
        setLive(await api<ActivityEvent[]>("/api/activity?limit=60"));
        setReady(true);
        unsub = subscribe((kind, data) => {
          setVersions((v) => ({ ...v, [kind]: v[kind] + 1 }));
          if (kind === "state") setState((data as { state: AgentState }).state);
          if (kind === "activity") setLive((l) => [(data as { event: ActivityEvent }).event, ...l].slice(0, 300));
          if (kind === "notification") {
            const n = (data as { notification: AppNotification }).notification;
            toast({ level: n.level, title: n.title, body: n.body, link: n.link });
            if (n.level !== "info" && "Notification" in window && Notification.permission === "granted" && document.hidden) {
              try {
                new Notification(`ApplyPilot — ${n.title}`, { body: n.body });
              } catch {
                /* blocked */
              }
            }
          }
        }, setConnected);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => unsub?.();
  }, [toast]);

  const value = useMemo<AppStore>(
    () => ({ ready, error, connected, state, versions, live, toasts, toast, dismissToast, reducedMotion, setReducedMotion: setReducedMotionState, paletteOpen, setPaletteOpen, theme, setTheme }),
    [ready, error, connected, state, versions, live, toasts, toast, dismissToast, reducedMotion, paletteOpen, theme],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppStore {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

/** Fetches `path` now and again whenever any of `deps` versions change. */
export function useData<T>(path: string | null, kinds: PushKind[] = [], extra: unknown[] = []): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const { versions } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const key = kinds.map((k) => versions[k]).join(",");
  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading((l) => l || data === null);
    api<T>(path)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [path, key, tick, ...extra]);
  return { data, loading, error, reload: () => setTick((t) => t + 1) };
}

/** Wraps an API mutation with a toast on failure and an optional success message. */
export function useAction() {
  const { toast } = useApp();
  return useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | null> => {
      try {
        const r = await fn();
        if (success) toast({ level: "success", title: success });
        return r;
      } catch (e) {
        toast({ level: "error", title: "That didn't work", body: e instanceof Error ? e.message : String(e) });
        return null;
      }
    },
    [toast],
  );
}
