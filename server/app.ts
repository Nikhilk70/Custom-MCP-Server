import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fromRoot } from "../agent/core/paths.ts";
import { createBaseContext } from "../agent/orchestration/container.ts";
import { answersFilePath } from "../agent/questions/answersFile.ts";
import { Store } from "../agent/store/sheetStore.ts";
import { InMemorySheetProvider } from "../integrations/google-sheets/InMemorySheetProvider.ts";
import type { SheetProvider } from "../agent/core/interfaces.ts";
import type { PlaywrightBrowserProvider } from "../integrations/playwright/PlaywrightBrowserProvider.ts";
import { buildApi } from "./api.ts";
import { APP_SECURITY_HEADERS, errorStatus, hostAllowed, HttpError, readBody, sendJson, serveStatic, tokensEqual, type Req } from "./http.ts";
import { AgentRuntime, type RuntimeHooks } from "./runtime.ts";

export interface AppOptions {
  port: number;
  /** In-memory database instead of your Google Sheet (tests). */
  demo: boolean;
  /** Test hooks. */
  sheetProvider?: SheetProvider;
  browser?: PlaywrightBrowserProvider;
  stateDir?: string;
  hooks?: RuntimeHooks;
  webRoot?: string;
  quiet?: boolean;
}

export interface RunningApp {
  url: string;
  token: string;
  runtime: AgentRuntime;
  close(): Promise<void>;
}

/** Query-string tokens are accepted only where a header can't be sent (EventSource, <img>, file links). */
const QUERY_TOKEN_PATHS = [/^\/api\/events$/, /^\/api\/agent\/preview\.jpg$/, /^\/api\/files\/screenshot$/, /^\/api\/resumes\/[^/]+\/file$/, /^\/api\/template\/pdf\/[^/]+$/];

export async function startApp(o: AppOptions): Promise<RunningApp> {
  const token = crypto.randomBytes(24).toString("hex");
  const stateDir = o.stateDir ?? fromRoot("runtime", "state", o.demo ? "applypilot-demo" : "applypilot");
  const base = createBaseContext({ quiet: o.quiet ?? false, ...(o.sheetProvider ? { sheetProvider: o.sheetProvider } : o.demo ? { sheetProvider: new InMemorySheetProvider() } : {}) });
  if (o.browser) {
    await base.browser.shutdown().catch(() => undefined);
    (base as { browser: PlaywrightBrowserProvider }).browser = o.browser;
  }
  const answersFile = answersFilePath();
  const runtime = new AgentRuntime({
    base,
    openStore: () => Store.open(base.sheet, base.cfg.env.GOOGLE_SHEETS_TAB ? { jobsTab: base.cfg.env.GOOGLE_SHEETS_TAB } : {}),
    stateDir,
    answersFile,
    uploadsDir: path.join(stateDir, "uploads", "resumes"),
    demo: o.demo,
    ...(o.hooks ? { hooks: o.hooks } : {}),
  });
  const api = buildApi(runtime, { stateDir, token });
  const webRoot = o.webRoot ?? fromRoot("web", "dist");

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      try {
        if (!hostAllowed(req.headers.host)) {
          sendJson(res, 403, { error: { code: "FORBIDDEN_HOST", message: "ApplyPilot only answers on localhost" } });
          return;
        }
        if (!url.pathname.startsWith("/api/")) {
          if (!serveStatic(webRoot, url.pathname, res)) {
            res.writeHead(200, { ...APP_SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" });
            res.end(`<!doctype html><meta charset="utf-8"><title>ApplyPilot</title><body style="font-family:system-ui;background:#0b1020;color:#e6e9f2;padding:40px"><h1>ApplyPilot API is running</h1><p>The web app is not built yet. Run <code>npm run web:build</code> and reload, or use <code>npm run web:dev</code> during development.</p>`);
          }
          return;
        }
        // --- API: same-origin only (no CORS headers are ever sent), token on every call except /api/session ---
        if (url.pathname !== "/api/session") {
          const header = req.headers["x-applypilot-token"];
          const supplied = typeof header === "string" ? header : QUERY_TOKEN_PATHS.some((p) => p.test(url.pathname)) ? (url.searchParams.get("token") ?? "") : "";
          if (!supplied || !tokensEqual(supplied, token)) {
            sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "missing or invalid ApplyPilot session token — reload the page" } });
            return;
          }
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
          const origin = req.headers.origin;
          if (origin && !hostAllowed(new URL(origin).host)) {
            sendJson(res, 403, { error: { code: "FORBIDDEN_ORIGIN", message: "cross-site request refused" } });
            return;
          }
        }
        if (url.pathname === "/api/events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
          res.write(`event: state\ndata: ${JSON.stringify({ kind: "state", state: runtime.state() })}\n\n`);
          const unsub = runtime.bus.subscribe((p) => res.write(`event: ${p.kind}\ndata: ${JSON.stringify(p)}\n\n`));
          const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
          req.on("close", () => {
            clearInterval(ping);
            unsub();
          });
          return;
        }
        const m = api.match(req.method ?? "GET", url.pathname);
        if (m === "method") {
          sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: `${req.method ?? ""} not allowed here` } });
          return;
        }
        if (!m) {
          sendJson(res, 404, { error: { code: "NOT_FOUND", message: `no API route ${url.pathname}` } });
          return;
        }
        const r: Req = {
          method: req.method ?? "GET",
          path: url.pathname,
          query: url.searchParams,
          params: m.params,
          headers: req.headers,
          raw: req,
          json: async <T>() => {
            const buf = await readBody(req, 1024 * 1024);
            if (!buf.length) return {} as T;
            try {
              return JSON.parse(buf.toString("utf8")) as T;
            } catch {
              throw new HttpError(400, "BAD_REQUEST", "invalid JSON body");
            }
          },
          bytes: (limit) => readBody(req, limit),
        };
        const out = await m.handler(r, res);
        if (!res.headersSent) sendJson(res, 200, out ?? { ok: true });
      } catch (err) {
        const e = errorStatus(err);
        if (e.status >= 500) runtime.bus.emit({ type: "api.error", category: "errors", level: "error", message: `${req.method ?? ""} ${url.pathname}: ${e.message}` });
        sendJson(res, e.status, { error: { code: e.code, message: e.message } });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : o.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  await runtime.connect();
  runtime.bus.emit({ type: "SYSTEM_STARTED", category: "system", message: "ApplyPilot started — every run is a dry run until you arm live mode" });
  return {
    url: baseUrl,
    token,
    runtime,
    close: async () => {
      await runtime.shutdown();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
