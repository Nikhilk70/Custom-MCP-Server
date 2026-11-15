import type { CellUpdate, IntegrationStatus, SheetProvider } from "../../agent/core/interfaces.ts";

/** Faithful in-memory spreadsheet used by tests. Counts API-equivalent calls so tests can assert batching. */
export class InMemorySheetProvider implements SheetProvider {
  readonly id = "google-sheets:memory";
  readonly tabs = new Map<string, string[][]>();
  calls = { list: 0, add: 0, read: 0, readColumns: 0, write: 0, append: 0 };

  constructor(initial: Record<string, string[][]> = { Sheet1: [] }) {
    for (const [k, v] of Object.entries(initial)) this.tabs.set(k, v.map((r) => [...r]));
  }

  status(): IntegrationStatus {
    return { id: this.id, state: "READY", detail: "in-memory spreadsheet (tests only; nothing persists)" };
  }

  private grid(tab: string): string[][] {
    const g = this.tabs.get(tab);
    if (!g) throw new Error(`tab '${tab}' not found`);
    return g;
  }

  async listTabs(): Promise<string[]> {
    this.calls.list++;
    return [...this.tabs.keys()];
  }
  async addTabs(tabs: string[]): Promise<void> {
    this.calls.add++;
    for (const t of tabs) if (!this.tabs.has(t)) this.tabs.set(t, []);
  }
  async readTabs(tabs: string[]): Promise<Record<string, string[][]>> {
    this.calls.read++;
    return Object.fromEntries(tabs.map((t) => [t, this.grid(t).map((r) => [...r])]));
  }
  async readColumns(requests: Array<{ tab: string; col: number }>): Promise<string[][]> {
    this.calls.readColumns++;
    return requests.map((r) => this.grid(r.tab).map((row) => row[r.col] ?? ""));
  }
  async writeCells(updates: CellUpdate[]): Promise<void> {
    if (!updates.length) return;
    this.calls.write++;
    for (const u of updates) {
      const g = this.grid(u.tab);
      while (g.length < u.row) g.push([]);
      const row = g[u.row - 1] ?? [];
      while (row.length <= u.col) row.push("");
      row[u.col] = u.value;
      g[u.row - 1] = row;
    }
  }
  async appendRows(tab: string, rows: string[][]): Promise<number[]> {
    if (!rows.length) return [];
    this.calls.append++;
    const g = this.grid(tab);
    // Like the Sheets API: append after the last row that has any value.
    let last = g.length;
    while (last > 0 && (g[last - 1] ?? []).every((c) => c === "")) last--;
    g.length = last;
    const start = last + 1;
    for (const r of rows) g.push([...r]);
    return rows.map((_, i) => start + i);
  }
}
