import type { CellUpdate } from "../core/interfaces.ts";

/** Google Sheets rejects cells over 50,000 characters. */
export const MAX_CELL = 49_000;

export interface Col<T> {
  name: string;
  get: (r: T) => string;
  /** Absent for write-only (derived) columns such as "Date Added". */
  set?: (r: T, v: string) => void;
}

type Keys<T> = Extract<keyof T, string>;

/** Text for a scalar cell; anything structured is JSON (never "[object Object]"). */
function scalar(v: unknown, fallback = ""): string {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function clip(s: string): string {
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL - 40)} …[truncated ${s.length - MAX_CELL + 40} chars]` : s;
}

/** Column constructors. Empty cell ⇄ null for nullable kinds; booleans read yes/true/1. */
export const c = {
  str<T>(name: string, key: Keys<T>): Col<T> {
    return { name, get: (r) => clip(scalar((r as Record<string, unknown>)[key])), set: (r, v) => ((r as Record<string, unknown>)[key] = v) };
  },
  nstr<T>(name: string, key: Keys<T>): Col<T> {
    return { name, get: (r) => clip(scalar((r as Record<string, unknown>)[key])), set: (r, v) => ((r as Record<string, unknown>)[key] = v.trim() === "" ? null : v) };
  },
  num<T>(name: string, key: Keys<T>): Col<T> {
    return {
      name,
      get: (r) => scalar((r as Record<string, unknown>)[key], "0"),
      set: (r, v) => {
        const n = Number(v.replace(/,/g, ""));
        (r as Record<string, unknown>)[key] = Number.isFinite(n) ? n : 0;
      },
    };
  },
  nnum<T>(name: string, key: Keys<T>): Col<T> {
    return {
      name,
      get: (r) => {
        const v = (r as Record<string, unknown>)[key];
        return scalar(v);
      },
      set: (r, v) => {
        const n = Number(v.replace(/,/g, ""));
        (r as Record<string, unknown>)[key] = v.trim() === "" || !Number.isFinite(n) ? null : n;
      },
    };
  },
  bool<T>(name: string, key: Keys<T>): Col<T> {
    return { name, get: (r) => ((r as Record<string, unknown>)[key] ? "YES" : ""), set: (r, v) => ((r as Record<string, unknown>)[key] = /^(yes|true|1)$/i.test(v.trim())) };
  },
  json<T>(name: string, key: Keys<T>): Col<T> {
    return {
      name,
      get: (r) => {
        const v = (r as Record<string, unknown>)[key];
        if (v === null || v === undefined) return "";
        const s = JSON.stringify(v);
        return s.length > MAX_CELL ? JSON.stringify({ _truncated: true, chars: s.length, preview: s.slice(0, 2000) }) : s;
      },
      set: (r, v) => {
        let parsed: unknown;
        try {
          parsed = v.trim() ? (JSON.parse(v) as unknown) : null;
        } catch {
          parsed = { _unparseable: v.slice(0, 2000) };
        }
        (r as Record<string, unknown>)[key] = parsed;
      },
    };
  },
  derived<T>(name: string, get: (r: T) => string): Col<T> {
    return { name, get };
  },
};

interface Entry<T> {
  row: number | null;
  data: T;
  dirty: Set<string>;
  /** An append for this entry is in flight; it must not be planned again. */
  pending?: boolean;
  /** Sheet row of an adopted orphan (its key cell is still empty until the first flush). */
  adoptedAt?: number;
}

export interface FlushPlan<T> {
  header: CellUpdate[];
  headerSnapshot: Array<{ name: string; col: number }>;
  updates: Array<{ key: string; entry: Entry<T>; cols: Array<{ col: number; value: string }>; dirtyNames: string[] }>;
  appends: Array<{ entry: Entry<T>; row: string[]; dirtyNames: string[] }>;
}

/**
 * One spreadsheet tab as a keyed table. Reads parse only the managed columns; writes touch only
 * cells whose serialized value changed, so user-added columns and unrelated edits are preserved.
 */
export class Table<T extends object> {
  private header: string[] = [];
  private readonly colIndex = new Map<string, number>();
  private readonly entries: Array<Entry<T>> = [];
  private readonly byKey = new Map<string, Entry<T>>();
  private newHeaderCols: Array<{ name: string; col: number }> = [];
  /** Rows with an empty key cell (e.g. rows the user typed into the dashboard). */
  orphans: Array<{ row: number; cells: string[] }> = [];
  readonly warnings: string[] = [];

  constructor(
    readonly tab: string,
    readonly keyColumn: string,
    readonly cols: Array<Col<T>>,
    private readonly keyOf: (r: T) => string,
    private readonly blank: () => T,
  ) {}

  load(grid: string[][], onRow?: (r: T, rowNumber: number) => void): void {
    this.header = [...(grid[0] ?? [])].map((h) => h.trim());
    this.colIndex.clear();
    this.header.forEach((h, i) => {
      if (h && !this.colIndex.has(h)) this.colIndex.set(h, i);
    });
    this.newHeaderCols = [];
    for (const col of this.cols) {
      if (!this.colIndex.has(col.name)) {
        const idx = this.header.length + this.newHeaderCols.length;
        this.newHeaderCols.push({ name: col.name, col: idx });
        this.colIndex.set(col.name, idx);
      }
    }
    const keyIdx = this.colIndex.get(this.keyColumn) ?? -1;
    this.entries.length = 0;
    this.byKey.clear();
    this.orphans = [];
    for (let r = 1; r < grid.length; r++) {
      const cells = grid[r] ?? [];
      const key = (cells[keyIdx] ?? "").trim();
      if (!key) {
        if (cells.some((x) => x.trim() !== "")) this.orphans.push({ row: r + 1, cells });
        continue;
      }
      if (this.byKey.has(key)) {
        this.warnings.push(`${this.tab}: duplicate key '${key}' at row ${r + 1} ignored`);
        continue;
      }
      const data = this.blank();
      for (const col of this.cols) col.set?.(data, cells[this.colIndex.get(col.name) ?? -1] ?? "");
      const entry: Entry<T> = { row: r + 1, data, dirty: new Set() };
      onRow?.(data, r + 1);
      this.entries.push(entry);
      this.byKey.set(key, entry);
    }
  }

  get size(): number {
    return this.entries.length;
  }
  all(): T[] {
    return this.entries.map((e) => ({ ...e.data }));
  }
  filter(pred: (r: T) => boolean): T[] {
    return this.entries.filter((e) => pred(e.data)).map((e) => ({ ...e.data }));
  }
  find(pred: (r: T) => boolean): T | undefined {
    const e = this.entries.find((x) => pred(x.data));
    return e ? { ...e.data } : undefined;
  }
  get(key: string): T | undefined {
    const e = this.byKey.get(key);
    return e ? { ...e.data } : undefined;
  }
  has(key: string): boolean {
    return this.byKey.has(key);
  }
  rowOf(key: string): number | null {
    return this.byKey.get(key)?.row ?? null;
  }

  insert(r: T): T {
    const key = this.keyOf(r);
    if (!key) throw new Error(`${this.tab}: cannot insert a row with an empty key`);
    if (this.byKey.has(key)) throw new Error(`${this.tab}: key '${key}' already exists`);
    const entry: Entry<T> = { row: null, data: { ...r }, dirty: new Set(this.cols.map((c) => c.name)) };
    this.entries.push(entry);
    this.byKey.set(key, entry);
    return { ...r };
  }

  update(key: string, patch: Partial<T>): T {
    const e = this.byKey.get(key);
    if (!e) throw new Error(`${this.tab}: key '${key}' not found`);
    const next = { ...e.data, ...patch };
    for (const col of this.cols) if (col.get(e.data) !== col.get(next)) e.dirty.add(col.name);
    e.data = next;
    return { ...next };
  }

  /** Claims an orphan row (same sheet row) for a new keyed record instead of appending a duplicate. */
  adopt(orphanRow: number, r: T): T {
    const idx = this.orphans.findIndex((o) => o.row === orphanRow);
    if (idx === -1) throw new Error(`${this.tab}: no orphan at row ${orphanRow}`);
    this.orphans.splice(idx, 1);
    const inserted = this.insert(r);
    const e = this.byKey.get(this.keyOf(r));
    if (e) {
      e.row = orphanRow;
      e.adoptedAt = orphanRow;
    }
    return inserted;
  }

  isDirty(): boolean {
    return this.newHeaderCols.length > 0 || this.entries.some((e) => e.dirty.size > 0);
  }

  /** Value of a named column in a raw row (e.g. an orphan). */
  cell(cells: string[], column: string): string {
    const idx = this.colIndex.get(column);
    return idx === undefined ? "" : (cells[idx] ?? "");
  }

  keyColumnIndex(): number {
    return this.colIndex.get(this.keyColumn) ?? -1;
  }

  /**
   * Snapshots pending changes and clears their dirty flags immediately, so edits made while the
   * network write is in flight are kept for the next flush. Call restore(plan) if the write fails.
   */
  planFlush(): FlushPlan<T> {
    const headerSnapshot = this.newHeaderCols;
    this.newHeaderCols = [];
    for (const h of headerSnapshot) this.header[h.col] = h.name;
    const header = headerSnapshot.map((h) => ({ tab: this.tab, row: 1, col: h.col, value: h.name }));
    const width = Math.max(this.header.length, ...[...this.colIndex.values()].map((v) => v + 1));
    const updates: FlushPlan<T>["updates"] = [];
    const appends: FlushPlan<T>["appends"] = [];
    for (const e of this.entries) {
      if (e.pending || e.dirty.size === 0) continue;
      const dirtyNames = [...e.dirty];
      e.dirty = new Set();
      if (e.row === null) {
        const row = new Array<string>(width).fill("");
        for (const col of this.cols) row[this.colIndex.get(col.name) ?? 0] = col.get(e.data);
        e.pending = true;
        appends.push({ entry: e, row, dirtyNames });
      } else {
        const cols = this.cols.filter((col) => dirtyNames.includes(col.name)).map((col) => ({ col: this.colIndex.get(col.name) ?? 0, value: col.get(e.data) }));
        updates.push({ key: this.keyOf(e.data), entry: e, cols, dirtyNames });
      }
    }
    return { header, headerSnapshot, updates, appends };
  }

  /** Called by the store after a successful write. */
  markFlushed(plan: FlushPlan<T>): void {
    for (const a of plan.appends) a.entry.pending = false;
    for (const u of plan.updates) delete u.entry.adoptedAt;
  }

  /** Undo planFlush after a failed write so nothing is lost. */
  restore(plan: FlushPlan<T>): void {
    for (const h of plan.headerSnapshot) {
      this.header.length = Math.min(this.header.length, h.col);
      this.newHeaderCols.push(h);
    }
    for (const u of plan.updates) for (const n of u.dirtyNames) u.entry.dirty.add(n);
    for (const a of plan.appends) {
      a.entry.pending = false;
      if (a.entry.row === null) for (const n of a.dirtyNames) a.entry.dirty.add(n);
    }
  }

  /** Full row for an entry (used when a row the user deleted must be re-appended). */
  fullRow(entry: { data: T }): string[] {
    const width = Math.max(this.header.length, ...[...this.colIndex.values()].map((v) => v + 1));
    const row = new Array<string>(width).fill("");
    for (const col of this.cols) row[this.colIndex.get(col.name) ?? 0] = col.get(entry.data);
    return row;
  }
}
