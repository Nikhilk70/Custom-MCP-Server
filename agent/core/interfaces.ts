import type { CompanyProfile, CompanySearchStatus, JobSearchQuery, RawJob } from "./schemas.ts";

/** Every integration reports one of these. PASS-like states require a verified call, not just a present key. */
export type IntegrationState = "READY" | "VERIFIED" | "NOT_CONFIGURED" | "UNSUPPORTED" | "BLOCKED" | "DISABLED";

export interface IntegrationStatus {
  id: string;
  state: IntegrationState;
  detail: string;
}

export interface Integration {
  readonly id: string;
  status(): IntegrationStatus;
}

export interface JobSource extends Integration {
  readonly sourceId: string;
  search(query: JobSearchQuery): Promise<RawJob[]>;
}

export interface CompanySearchOutcome {
  status: CompanySearchStatus;
  source: string;
  jobs: RawJob[];
  jobsFound: number;
  error: string | null;
}

export interface CompanySource extends Integration {
  search(company: CompanyProfile, query: JobSearchQuery): Promise<CompanySearchOutcome>;
}

export interface JdFetchResult {
  jdText: string;
  method: string;
}

export interface JdProvider extends Integration {
  canFetch(job: { source: string; jobUrl: string }): boolean;
  fetchJd(job: { source: string; jobUrl: string; externalJobId: string | null; companyId: string | null }): Promise<JdFetchResult>;
}

export interface CompileResult {
  ok: boolean;
  pdfPath: string | null;
  log: string;
  compiler: string;
}

export interface ResumeProvider extends Integration {
  /** Compiles texPath into a PDF inside outDir. Must not report ok unless the PDF exists. */
  compile(texPath: string, outDir: string): Promise<CompileResult>;
}

export interface AIProvider extends Integration {
  generateText(prompt: string, opts?: { system?: string; maxOutputTokens?: number; temperature?: number; /** Ask for a JSON response with minimal reasoning (faster). */ json?: boolean; /** Documents sent alongside the prompt (e.g. a PDF). */ files?: Array<{ mimeType: string; data: Buffer }> }): Promise<string>;
}

export interface CellUpdate {
  tab: string;
  /** 1-based sheet row number (row 1 is the header). */
  row: number;
  /** 0-based column index. */
  col: number;
  value: string;
}

/**
 * Minimal spreadsheet API the store needs. Designed for few, batched calls (Sheets API quota):
 * one listTabs + one readTabs to load everything, one writeCells + one append per changed tab to flush.
 */
export interface SheetProvider extends Integration {
  /** Tab titles in spreadsheet order. */
  listTabs(): Promise<string[]>;
  addTabs(tabs: string[]): Promise<void>;
  /** Full grids (header row included) of several tabs in one call. Missing trailing cells are "". */
  readTabs(tabs: string[]): Promise<Record<string, string[][]>>;
  /** One column (header row included) of several tabs in one call — used to re-locate rows before writing. */
  readColumns(requests: Array<{ tab: string; col: number }>): Promise<string[][]>;
  /** Writes individual cells across tabs in one batched call. Values are stored RAW (never parsed as formulas). */
  writeCells(updates: CellUpdate[]): Promise<void>;
  /** Appends rows after the last used row of a tab; returns their 1-based row numbers. */
  appendRows(tab: string, rows: string[][]): Promise<number[]>;
}

export interface SchedulerProvider {
  start(task: () => Promise<void>): void;
  stop(): void;
  nextRunAt(): Date | null;
}
