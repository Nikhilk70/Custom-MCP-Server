import fs from "node:fs";
import { google, type sheets_v4 } from "googleapis";
import { z } from "zod";
import type { CellUpdate, IntegrationStatus, SheetProvider } from "../../agent/core/interfaces.ts";
import { AgentError } from "../../agent/core/errors.ts";
import { fromRoot } from "../../agent/core/paths.ts";
import { withRetry } from "../../agent/core/retry.ts";

export const SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const SHEETS_TIMEOUT_MS = 60_000;

const ServiceAccount = z.object({ type: z.literal("service_account"), client_email: z.string(), private_key: z.string() }).passthrough();
const OAuthClient = z.object({
  installed: z.object({ client_id: z.string(), client_secret: z.string(), redirect_uris: z.array(z.string()).optional() }).optional(),
  web: z.object({ client_id: z.string(), client_secret: z.string(), redirect_uris: z.array(z.string()).optional() }).optional(),
});
const Token = z.object({ refresh_token: z.string().optional(), access_token: z.string().optional(), expiry_date: z.number().optional() }).passthrough();

export function colLetter(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const q = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

export type SheetsAuthKind = "service_account" | "oauth" | "none";

export function describeCredentials(credentialsPath: string | undefined, tokenPath: string | undefined): { kind: SheetsAuthKind; problem: string | null } {
  if (!credentialsPath) return { kind: "none", problem: "GOOGLE_SHEETS_CREDENTIALS_PATH not set" };
  const cred = fromRoot(credentialsPath);
  if (!fs.existsSync(cred)) return { kind: "none", problem: `credentials file not found: ${credentialsPath}` };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(cred, "utf8"));
  } catch {
    return { kind: "none", problem: `credentials file is not valid JSON: ${credentialsPath}` };
  }
  if (ServiceAccount.safeParse(raw).success) return { kind: "service_account", problem: null };
  const oc = OAuthClient.safeParse(raw);
  if (oc.success && (oc.data.installed || oc.data.web)) {
    if (!tokenPath || !fs.existsSync(fromRoot(tokenPath))) return { kind: "oauth", problem: "OAuth client found but no token yet — run `npm run sheets:auth`" };
    return { kind: "oauth", problem: null };
  }
  return { kind: "none", problem: "credentials file is neither a service account key nor an OAuth client" };
}

/**
 * Google Sheets v4 backend for the store. Every request is throttled (Sheets allows ~60 requests/min/user)
 * and retried with backoff on 429/5xx. Values are written RAW so job text can never become a formula.
 */
export class GoogleSheetsAdapter implements SheetProvider {
  readonly id = "google-sheets";
  private api: sheets_v4.Sheets | null = null;
  private lastCall = 0;

  constructor(private readonly opts: { spreadsheetId: string | undefined; credentialsPath: string | undefined; tokenPath: string | undefined; minIntervalMs?: number }) {}

  status(): IntegrationStatus {
    if (!this.opts.spreadsheetId) return { id: this.id, state: "NOT_CONFIGURED", detail: "GOOGLE_SHEETS_SPREADSHEET_ID not set" };
    const d = describeCredentials(this.opts.credentialsPath, this.opts.tokenPath);
    if (d.problem) return { id: this.id, state: "NOT_CONFIGURED", detail: d.problem };
    return { id: this.id, state: "READY", detail: `${d.kind} credentials for spreadsheet ${this.opts.spreadsheetId}` };
  }

  private client(): sheets_v4.Sheets {
    if (this.api) return this.api;
    const st = this.status();
    if (st.state !== "READY") throw new AgentError("NOT_CONFIGURED", `Google Sheets: ${st.detail}`);
    const credFile = fromRoot(this.opts.credentialsPath ?? "");
    const raw: unknown = JSON.parse(fs.readFileSync(credFile, "utf8"));
    if (ServiceAccount.safeParse(raw).success) {
      // A stalled request must fail (and be retried) rather than hang a run that holds the database lock.
      this.api = google.sheets({ version: "v4", auth: new google.auth.GoogleAuth({ keyFile: credFile, scopes: SHEETS_SCOPES }), timeout: SHEETS_TIMEOUT_MS });
    } else {
      const oc = OAuthClient.parse(raw);
      const c = oc.installed ?? oc.web;
      if (!c) throw new AgentError("NOT_CONFIGURED", "OAuth client JSON has neither 'installed' nor 'web'");
      const auth = new google.auth.OAuth2(c.client_id, c.client_secret, c.redirect_uris?.[0]);
      auth.setCredentials(Token.parse(JSON.parse(fs.readFileSync(fromRoot(this.opts.tokenPath ?? ""), "utf8"))));
      this.api = google.sheets({ version: "v4", auth, timeout: SHEETS_TIMEOUT_MS });
    }
    return this.api;
  }

  private get sid(): string {
    return this.opts.spreadsheetId ?? "";
  }

  private async call<T>(what: string, fn: (api: sheets_v4.Sheets) => Promise<T>): Promise<T> {
    const api = this.client();
    return withRetry(async () => {
      const wait = this.lastCall + (this.opts.minIntervalMs ?? 1100) - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCall = Date.now();
      try {
        return await fn(api);
      } catch (err) {
        const status = (err as { code?: unknown; status?: unknown }).code ?? (err as { status?: unknown }).status;
        const msg = err instanceof Error ? err.message : String(err);
        if (status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) {
          throw new AgentError("NOT_CONFIGURED", `Sheets ${what}: the Google Sheets API is disabled in the credentials' Cloud project. Enable it, wait a few minutes, retry. ${msg}`);
        }
        if (status === 401 || status === 403) throw new AgentError("AUTH_REQUIRED", `Sheets ${what}: ${msg} (share the spreadsheet with the service account, or re-run npm run sheets:auth)`);
        if (status === 404) throw new AgentError("NOT_FOUND", `Sheets ${what}: ${msg}`);
        if (status === 429) throw new AgentError("RATE_LIMITED", `Sheets ${what}: ${msg}`);
        if (typeof status === "number" && status >= 400 && status < 500) throw new AgentError("VALIDATION_FAILED", `Sheets ${what}: ${msg}`);
        throw new AgentError("NETWORK_ERROR", `Sheets ${what}: ${msg}`, { cause: err });
      }
    });
  }

  async listTabs(): Promise<string[]> {
    const res = await this.call("listTabs", (a) => a.spreadsheets.get({ spreadsheetId: this.sid, fields: "sheets.properties.title" }));
    return (res.data.sheets ?? []).map((s) => s.properties?.title ?? "").filter(Boolean);
  }

  async addTabs(tabs: string[]): Promise<void> {
    if (!tabs.length) return;
    await this.call("addTabs", (a) => a.spreadsheets.batchUpdate({ spreadsheetId: this.sid, requestBody: { requests: tabs.map((title) => ({ addSheet: { properties: { title } } })) } }));
  }

  async readTabs(tabs: string[]): Promise<Record<string, string[][]>> {
    if (!tabs.length) return {};
    const res = await this.call("readTabs", (a) => a.spreadsheets.values.batchGet({ spreadsheetId: this.sid, ranges: tabs.map(q), majorDimension: "ROWS", valueRenderOption: "FORMATTED_VALUE" }));
    const out: Record<string, string[][]> = {};
    (res.data.valueRanges ?? []).forEach((vr, i) => {
      out[tabs[i] ?? ""] = (vr.values ?? []).map((row) => row.map((c) => (c === null || c === undefined ? "" : String(c as string | number | boolean))));
    });
    return out;
  }

  async readColumns(requests: Array<{ tab: string; col: number }>): Promise<string[][]> {
    if (!requests.length) return [];
    const res = await this.call("readColumns", (a) =>
      a.spreadsheets.values.batchGet({ spreadsheetId: this.sid, ranges: requests.map((r) => `${q(r.tab)}!${colLetter(r.col)}:${colLetter(r.col)}`), majorDimension: "COLUMNS" }),
    );
    return (res.data.valueRanges ?? []).map((vr) => (vr.values?.[0] ?? []).map((c) => (c === null || c === undefined ? "" : String(c as string | number | boolean))));
  }

  /**
   * Values writes fail with "exceeds grid limits" outside a tab's grid (a new tab has 26 columns), so grow the
   * grid first. Sizes are cached and only re-read when a write needs more than the cache says exists.
   */
  private grid: Map<string, { sheetId: number; rows: number; cols: number }> | null = null;

  private async ensureGrid(needs: Map<string, { rows: number; cols: number }>): Promise<void> {
    const short = () => [...needs].filter(([tab, n]) => { const g = this.grid?.get(tab); return !g || g.rows < n.rows || g.cols < n.cols; });
    if (!short().length) return;
    const res = await this.call("readGrid", (a) => a.spreadsheets.get({ spreadsheetId: this.sid, fields: "sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))" }));
    this.grid = new Map();
    for (const s of res.data.sheets ?? []) {
      const p = s.properties;
      if (p?.title) this.grid.set(p.title, { sheetId: p.sheetId ?? 0, rows: p.gridProperties?.rowCount ?? 0, cols: p.gridProperties?.columnCount ?? 0 });
    }
    const requests: sheets_v4.Schema$Request[] = [];
    for (const [tab, n] of short()) {
      const g = this.grid.get(tab);
      if (!g) throw new AgentError("NOT_FOUND", `Sheets: tab '${tab}' does not exist`);
      if (g.rows < n.rows) requests.push({ appendDimension: { sheetId: g.sheetId, dimension: "ROWS", length: n.rows - g.rows + 100 } });
      if (g.cols < n.cols) requests.push({ appendDimension: { sheetId: g.sheetId, dimension: "COLUMNS", length: n.cols - g.cols + 5 } });
      g.rows = Math.max(g.rows, n.rows + 100);
      g.cols = Math.max(g.cols, n.cols + 5);
    }
    if (requests.length) await this.call("growGrid", (a) => a.spreadsheets.batchUpdate({ spreadsheetId: this.sid, requestBody: { requests } }));
  }

  async writeCells(updates: CellUpdate[]): Promise<void> {
    const needs = new Map<string, { rows: number; cols: number }>();
    for (const u of updates) {
      const n = needs.get(u.tab) ?? { rows: 0, cols: 0 };
      needs.set(u.tab, { rows: Math.max(n.rows, u.row), cols: Math.max(n.cols, u.col + 1) });
    }
    await this.ensureGrid(needs);
    // Batches are bounded by cell count AND size: re-scoring rewrites large JSON cells (match, JD analysis) for every
    // job, and one multi-megabyte request gets its connection dropped. ~2 MB per request goes through reliably.
    const MAX_CELLS = 2000;
    const MAX_CHARS = 2_000_000;
    let batch: Array<{ range: string; values: string[][] }> = [];
    let chars = 0;
    const send = async () => {
      if (!batch.length) return;
      const data = batch;
      batch = [];
      chars = 0;
      await this.call("writeCells", (a) => a.spreadsheets.values.batchUpdate({ spreadsheetId: this.sid, requestBody: { valueInputOption: "RAW", data } }));
    };
    for (const u of updates) {
      const size = u.value.length + 40;
      if (batch.length && (batch.length >= MAX_CELLS || chars + size > MAX_CHARS)) await send();
      batch.push({ range: `${q(u.tab)}!${colLetter(u.col)}${u.row}`, values: [[u.value]] });
      chars += size;
    }
    await send();
  }

  async appendRows(tab: string, rows: string[][]): Promise<number[]> {
    if (!rows.length) return [];
    // INSERT_ROWS adds the rows itself; only the width has to fit.
    await this.ensureGrid(new Map([[tab, { rows: 0, cols: Math.max(...rows.map((r) => r.length)) }]]));
    const res = await this.call("appendRows", (a) =>
      a.spreadsheets.values.append({ spreadsheetId: this.sid, range: `${q(tab)}!A1`, valueInputOption: "RAW", insertDataOption: "INSERT_ROWS", requestBody: { values: rows } }),
    );
    const range = res.data.updates?.updatedRange ?? "";
    const m = /![A-Z]+(\d+)(?::[A-Z]+(\d+))?$/.exec(range);
    if (!m?.[1]) throw new AgentError("PARSER_FAILED", `cannot parse appended range '${range}'`);
    const start = Number(m[1]);
    return rows.map((_, i) => start + i);
  }
}
