/** Thin client for the ApplyPilot API. The session token never leaves this module except in same-origin URLs. */
let token = "";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function initSession(): Promise<{ demo: boolean }> {
  const r = await fetch("/api/session", { cache: "no-store" });
  if (!r.ok) throw new ApiError(r.status, "SESSION", "ApplyPilot server is not reachable");
  const j = (await r.json()) as { token: string; demo: boolean };
  token = j.token;
  return { demo: j.demo };
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; raw?: Blob | ArrayBuffer; contentType?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "x-applypilot-token": token };
  let body: BodyInit | undefined;
  if (opts.raw !== undefined) {
    body = opts.raw;
    headers["content-type"] = opts.contentType ?? "application/octet-stream";
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  const r = await fetch(path, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, cache: "no-store" });
  const text = await r.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!r.ok) {
    const e = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(r.status, e?.code ?? "HTTP", e?.message ?? `request failed (${r.status})`);
  }
  return data as T;
}

/** An action (always POST, even without a body). */
export function post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, { method: "POST", body });
}

/** For <img>, <a download> and EventSource, which cannot send headers. */
export function tokenUrl(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

export type PushKind = "activity" | "state" | "queue" | "tasks" | "notification" | "jobs" | "applications" | "answers" | "memory";

/** Server-Sent Events with automatic reconnect. */
export function subscribe(onPush: (kind: PushKind, data: unknown) => void, onStatus: (connected: boolean) => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retry = 1000;
  const kinds: PushKind[] = ["activity", "state", "queue", "tasks", "notification", "jobs", "applications", "answers", "memory"];
  const open = () => {
    if (closed) return;
    es = new EventSource(tokenUrl("/api/events"));
    es.onopen = () => {
      retry = 1000;
      onStatus(true);
    };
    es.onerror = () => {
      onStatus(false);
      es?.close();
      if (!closed) setTimeout(open, (retry = Math.min(retry * 2, 15000)));
    };
    for (const k of kinds) {
      es.addEventListener(k, (ev) => {
        try {
          onPush(k, JSON.parse((ev as MessageEvent<string>).data));
        } catch {
          /* ignore malformed frame */
        }
      });
    }
  };
  open();
  return () => {
    closed = true;
    es?.close();
  };
}
