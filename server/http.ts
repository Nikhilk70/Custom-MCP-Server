import crypto from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { AgentError } from "../agent/core/errors.ts";

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: IncomingMessage["headers"];
  raw: IncomingMessage;
  json<T = Record<string, unknown>>(): Promise<T>;
  bytes(limit: number): Promise<Buffer>;
}

export type Handler = (req: Req, res: ServerResponse) => Promise<unknown>;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

/** Minimal router: "/api/jobs/:id/apply". A handler's return value is sent as JSON unless it already responded. */
export class Router {
  private readonly routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });
    return this;
  }
  get(p: string, h: Handler) {
    return this.on("GET", p, h);
  }
  post(p: string, h: Handler) {
    return this.on("POST", p, h);
  }
  patch(p: string, h: Handler) {
    return this.on("PATCH", p, h);
  }
  delete(p: string, h: Handler) {
    return this.on("DELETE", p, h);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null | "method" {
    const segs = pathname.split("/").filter(Boolean);
    let methodMismatch = false;
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = r.parts[i] ?? "";
        const s = segs[i] ?? "";
        if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(s);
        else if (p !== s) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (r.method !== method) {
        methodMismatch = true;
        continue;
      }
      return { handler: r.handler, params };
    }
    return methodMismatch ? "method" : null;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const STATUS: Record<string, number> = { NOT_FOUND: 404, VALIDATION_FAILED: 409, INVALID_TRANSITION: 409, CONFIG_INVALID: 400, NOT_CONFIGURED: 503 };

export function errorStatus(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof HttpError) return { status: err.status, code: err.code, message: err.message };
  if (err instanceof AgentError) return { status: STATUS[err.code] ?? 500, code: err.code, message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, code: "INTERNAL_ERROR", message };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "PAYLOAD_TOO_LARGE", `request body over ${Math.round(limit / 1024)} KB`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Only this machine, by name: blocks DNS-rebinding pages that point a foreign host name at 127.0.0.1. */
export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

export function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const APP_SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "content-security-policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".pdf": "application/pdf", ".jpg": "image/jpeg" };

/** Serves the built web app with SPA fallback to index.html. */
export function serveStatic(root: string, pathname: string, res: ServerResponse): boolean {
  if (!fs.existsSync(root)) return false;
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  let file = path.resolve(root, rel);
  if (!file.startsWith(path.resolve(root))) return false;
  if (!rel || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
  if (!fs.existsSync(file)) return false;
  const ext = path.extname(file);
  res.writeHead(200, { ...APP_SECURITY_HEADERS, "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": ext === ".html" ? "no-store" : "public, max-age=31536000, immutable" });
  fs.createReadStream(file).pipe(res);
  return true;
}

export function sendFile(res: ServerResponse, file: string, opts: { download?: string } = {}): void {
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff", ...(opts.download ? { "content-disposition": `attachment; filename="${opts.download.replace(/"/g, "")}"` } : {}) });
  fs.createReadStream(file).pipe(res);
}

/** A path from the client must resolve inside `root` and have one of the allowed extensions. */
export function safeJoin(root: string, rel: string, exts: string[]): string {
  const abs = path.resolve(root, rel);
  const base = path.resolve(root);
  if (!(abs === base || abs.startsWith(base + path.sep)) || !exts.includes(path.extname(abs).toLowerCase())) throw new HttpError(400, "BAD_PATH", "file path not allowed");
  if (!fs.existsSync(abs)) throw new HttpError(404, "NOT_FOUND", "file not found");
  return abs;
}
