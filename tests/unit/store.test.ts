import os from "node:os";
import { describe, expect, it } from "vitest";
import { Store, SYSTEM_TABS, USER_COLUMNS } from "../../agent/store/sheetStore.ts";
import { MAX_CELL } from "../../agent/store/table.ts";
import { transition } from "../../agent/store/stateMachine.ts";
import { normalizeRawJob } from "../../agent/normalization/normalize.ts";
import { upsertJob } from "../../agent/normalization/dedupe.ts";
import { InMemorySheetProvider } from "../../integrations/google-sheets/InMemorySheetProvider.ts";
import type { CellUpdate } from "../../agent/core/interfaces.ts";
import { memStore, rawJob } from "../helpers.ts";

const col = (grid: string[][] | undefined, name: string) => grid?.[0]?.indexOf(name) ?? -1;

describe("Google Sheets store (in-memory spreadsheet)", () => {
  it("creates every system tab and header on first use, user columns first", async () => {
    const { store, sheet } = await memStore({ Sheet1: [] });
    await store.flush();
    for (const t of Object.values(SYSTEM_TABS)) expect(sheet.tabs.has(t)).toBe(true);
    expect(store.jobsTab).toBe("Sheet1");
    expect(sheet.tabs.get("Sheet1")?.[0]?.slice(0, USER_COLUMNS.length)).toEqual([...USER_COLUMNS]);
    expect(sheet.tabs.get("Timeline")?.[0]?.[0]).toBe("ID");
  });

  it("keeps an existing header order and user-added columns; appends system columns to the right", async () => {
    const header = ["Company", "Job Title", "My Notes", "Status"];
    const { store, sheet } = await memStore({ Jobs: [header] });
    upsertJob(store, normalizeRawJob(rawJob()));
    await store.flush();
    const grid = sheet.tabs.get("Jobs") ?? [];
    expect(grid[0]?.slice(0, 4)).toEqual(header);
    expect(grid[0]).toContain("Job ID");
    expect(grid[1]?.[0]).toBe("Acme Payments");
    expect(grid[1]?.[2]).toBe(""); // user column untouched
    expect(grid[1]?.[3]).toBe("NORMALIZED");
  });

  it("round-trips typed values through the sheet", async () => {
    const { store, sheet } = await memStore();
    const { jobId } = upsertJob(store, normalizeRawJob(rawJob()));
    transition(store, jobId, "JD_FETCHED", { patch: { matchScore: 72, requiresHuman: true, blockReason: null } });
    store.t.jobs.update(jobId, { skills: ["Java", "Spring Boot"] });
    await store.flush();
    const reopened = await Store.open(sheet);
    const j = reopened.t.jobs.get(jobId);
    expect(j).toMatchObject({ status: "JD_FETCHED", matchScore: 72, requiresHuman: true, blockReason: null, skills: ["Java", "Spring Boot"], companyName: "Acme Payments" });
    expect(reopened.t.timeline.filter((e) => e.jobId === jobId).length).toBe(4);
  });

  it("is idempotent: a second flush with no changes makes no API calls; only changed cells are written", async () => {
    const { store, sheet } = await memStore();
    const { jobId } = upsertJob(store, normalizeRawJob(rawJob()));
    await store.flush();
    const calls = { ...sheet.calls };
    const again = await store.flush();
    expect(again.apiCalls).toBe(0);
    expect(sheet.calls).toEqual(calls);
    store.t.jobs.update(jobId, { matchScore: 80 });
    const s = await store.flush();
    expect(s.cellsWritten).toBe(1);
  });

  it("uses few, batched API calls", async () => {
    const sheet = new InMemorySheetProvider();
    const store = await Store.open(sheet);
    expect(sheet.calls).toMatchObject({ list: 1, add: 1, read: 1 });
    for (let i = 0; i < 20; i++) upsertJob(store, normalizeRawJob(rawJob({ externalJobId: String(i), applyUrl: `https://x/${i}`, jobUrl: `https://x/${i}`, jobTitle: `Developer ${i}` })));
    const s = await store.flush();
    expect(s.apiCalls).toBeLessThanOrEqual(1 + Object.keys(SYSTEM_TABS).length + 1); // header write + one append per touched tab
  });

  it("re-locates rows by Job ID before writing, so a user sort cannot cause wrong-row writes", async () => {
    const { store, sheet } = await memStore();
    const a = upsertJob(store, normalizeRawJob(rawJob()));
    const b = upsertJob(store, normalizeRawJob(rawJob({ externalJobId: "2", applyUrl: "https://x/2", jobUrl: "https://x/2", jobTitle: "Full Stack Developer" })));
    await store.flush();
    const grid = sheet.tabs.get(store.jobsTab) ?? [];
    [grid[1], grid[2]] = [grid[2] ?? [], grid[1] ?? []]; // user sorts the dashboard
    transition(store, a.jobId, "JD_FETCHED");
    await store.flush();
    const idCol = col(grid, "Job ID");
    const statusCol = col(grid, "Status");
    const rowA = grid.find((r) => r[idCol] === a.jobId);
    const rowB = grid.find((r) => r[idCol] === b.jobId);
    expect(rowA?.[statusCol]).toBe("JD_FETCHED");
    expect(rowB?.[statusCol]).toBe("NORMALIZED");
  });

  it("re-adds a row the user deleted instead of overwriting another row", async () => {
    const { store, sheet } = await memStore();
    const a = upsertJob(store, normalizeRawJob(rawJob()));
    await store.flush();
    const grid = sheet.tabs.get(store.jobsTab) ?? [];
    grid.splice(1, 1);
    transition(store, a.jobId, "JD_FETCHED");
    const s = await store.flush();
    expect(s.reappended).toBe(1);
    expect(grid.find((r) => r[col(grid, "Job ID")] === a.jobId)?.[col(grid, "Status")]).toBe("JD_FETCHED");
    expect(store.warnings.join(" ")).toMatch(/re-added/);
  });

  it("never loses edits made while a flush is in flight", async () => {
    const sheet = new InMemorySheetProvider();
    const store = await Store.open(sheet);
    const a = upsertJob(store, normalizeRawJob(rawJob()));
    await store.flush();
    const realWrite = sheet.writeCells.bind(sheet);
    sheet.writeCells = async (u: CellUpdate[]) => {
      store.t.jobs.update(a.jobId, { matchScore: 99 }); // concurrent edit during the network call
      await realWrite(u);
    };
    store.t.jobs.update(a.jobId, { matchScore: 50 });
    await store.flush();
    sheet.writeCells = realWrite;
    await store.flush();
    const reopened = await Store.open(sheet);
    expect(reopened.t.jobs.get(a.jobId)?.matchScore).toBe(99);
  });

  it("restores pending changes when a write fails, and succeeds on the next flush", async () => {
    const sheet = new InMemorySheetProvider();
    const store = await Store.open(sheet);
    const a = upsertJob(store, normalizeRawJob(rawJob()));
    const realAppend = sheet.appendRows.bind(sheet);
    sheet.appendRows = async () => {
      throw new Error("quota exceeded");
    };
    await expect(store.flush()).rejects.toThrow(/quota/);
    sheet.appendRows = realAppend;
    await store.flush();
    const reopened = await Store.open(sheet);
    expect(reopened.t.jobs.get(a.jobId)?.companyName).toBe("Acme Payments");
    expect(reopened.t.timeline.size).toBeGreaterThanOrEqual(3);
  });

  it("an invalid Status typed into the sheet becomes NEEDS_HUMAN with a warning", async () => {
    const { store, sheet } = await memStore();
    const { jobId } = upsertJob(store, normalizeRawJob(rawJob()));
    await store.flush();
    const grid = sheet.tabs.get("Sheet1") ?? [];
    (grid[1] ?? [])[col(grid, "Status")] = "maybe later";
    const reopened = await Store.open(sheet);
    expect(reopened.t.jobs.get(jobId)?.status).toBe("NEEDS_HUMAN");
    expect(reopened.warnings.join(" ")).toMatch(/invalid Status 'maybe later'/);
  });

  it("clips oversized cells below the 50,000-character Sheets limit", async () => {
    const { store, sheet } = await memStore();
    const { jobId } = upsertJob(store, normalizeRawJob(rawJob({ jdText: "x".repeat(80_000) })));
    await store.flush();
    const grid = sheet.tabs.get("Job Details") ?? [];
    const cell = grid.find((r) => r[0] === jobId)?.[col(grid, "JD Text")] ?? "";
    expect(cell.length).toBeLessThanOrEqual(MAX_CELL);
    expect(cell).toMatch(/truncated/);
  });

  it("the advisory lock blocks a second writer until released", async () => {
    const sheet = new InMemorySheetProvider();
    const first = await Store.open(sheet);
    await first.acquireLock("daily-run");
    const second = await Store.open(sheet);
    await expect(second.acquireLock("mcp:discover")).rejects.toThrow(/lock/);
    await first.releaseLock();
    const third = await Store.open(sheet);
    await expect(third.acquireLock("mcp:discover")).resolves.toBeUndefined();
  });

  it("a lock left by a process on this machine that no longer exists is taken over (live: killed run)", async () => {
    const sheet = new InMemorySheetProvider();
    const first = await Store.open(sheet);
    first.t.meta.insert({ name: "lock", value: `${os.hostname()}:999999:apply|${new Date().toISOString()}`, updatedAt: new Date().toISOString() });
    await first.flush();
    const second = await Store.open(sheet);
    await expect(second.acquireLock("apply")).resolves.toBeUndefined();
    expect(second.warnings.join(" ")).toMatch(/that process no longer exists/);
    // a live holder on another machine still blocks
    first.t.meta.update("lock", { value: `other-host:1:apply|${new Date().toISOString()}`, updatedAt: new Date().toISOString() });
    await first.flush();
    await expect((await Store.open(sheet)).acquireLock("apply")).rejects.toThrow(/lock/);
  });

  it("job ids stay unique even if the Meta counter is lost", async () => {
    const { store, sheet } = await memStore();
    upsertJob(store, normalizeRawJob(rawJob()));
    await store.flush();
    sheet.tabs.set("Meta", [["Name", "Value", "Updated At"]]);
    const reopened = await Store.open(sheet);
    const b = upsertJob(reopened, normalizeRawJob(rawJob({ externalJobId: "9", applyUrl: "https://x/9", jobUrl: "https://x/9", jobTitle: "Backend Developer" })));
    expect(b.jobId).toBe("JOB-000002");
  });
});
