import { describe, expect, it } from "vitest";
import { normalizeRawJob } from "../../agent/normalization/normalize.ts";
import { upsertJob } from "../../agent/normalization/dedupe.ts";
import { canonicalUrl, normalizeCompany, normalizeLocation, normalizeTitle } from "../../agent/core/text.ts";
import { JobRepo } from "../../agent/store/repositories.ts";
import { getTimeline } from "../../agent/store/stateMachine.ts";
import { USER_COLUMNS } from "../../agent/store/sheetStore.ts";
import { memStore, rawJob } from "../helpers.ts";

describe("normalization", () => {
  it("canonicalizes company, title, location and URL", () => {
    expect(normalizeCompany("Acme Payments Pvt. Ltd.")).toBe("acme payments");
    expect(normalizeTitle("Sr. Full-Stack Dev")).toBe("senior fullstack developer");
    expect(normalizeLocation("Bangalore, India")).toBe(normalizeLocation("Bengaluru India"));
    expect(canonicalUrl("https://WWW.Example.com/jobs/1/?utm_source=x&b=2&a=1#top")).toBe("https://example.com/jobs/1?a=1&b=2");
  });
});

describe("deduplication", () => {
  it("re-seeing the same external id is not a new job", async () => {
    const { store } = await memStore();
    const a = upsertJob(store, normalizeRawJob(rawJob()));
    const b = upsertJob(store, normalizeRawJob(rawJob()));
    expect(a.outcome).toBe("NEW");
    expect(b).toMatchObject({ jobId: a.jobId, outcome: "SEEN_AGAIN", matchedBy: "external_id" });
    expect(store.t.jobs.size).toBe(1);
  });

  it("same posting from another source merges by apply URL and keeps provenance", async () => {
    const { store } = await memStore();
    const a = upsertJob(store, normalizeRawJob(rawJob()));
    const b = upsertJob(store, normalizeRawJob(rawJob({ source: "linkedin", externalJobId: "li-9", applyUrl: "https://boards.greenhouse.io/acme/jobs/1001?utm_source=linkedin" })));
    expect(b).toMatchObject({ jobId: a.jobId, outcome: "DUPLICATE_CROSS_SOURCE", matchedBy: "apply_url" });
    expect(new JobRepo(store).sources(a.jobId).map((s) => s.source)).toEqual(["greenhouse", "linkedin"]);
    expect(store.t.jobs.get(a.jobId)?.sourcesLabel).toBe("greenhouse + linkedin");
  });

  it("cross-source match by company+title+location fingerprint", async () => {
    const { store } = await memStore();
    const a = upsertJob(store, normalizeRawJob(rawJob()));
    const b = upsertJob(store, normalizeRawJob(rawJob({ source: "careers_page", externalJobId: null, companyName: "ACME Payments Ltd", location: "Bangalore, India", applyUrl: "https://acme.example/careers/java-backend", jobUrl: "https://acme.example/careers/java-backend" })));
    expect(b).toMatchObject({ jobId: a.jobId, matchedBy: "identity" });
  });

  it("two requisitions with the same title in one source stay separate", async () => {
    const { store } = await memStore();
    const a = upsertJob(store, normalizeRawJob(rawJob()));
    const b = upsertJob(store, normalizeRawJob(rawJob({ externalJobId: "1002", applyUrl: "https://boards.greenhouse.io/acme/jobs/1002", jobUrl: "https://boards.greenhouse.io/acme/jobs/1002" })));
    expect(b.outcome).toBe("NEW");
    expect(b.jobId).not.toBe(a.jobId);
  });

  it("cross-source match by JD hash when title wording differs", async () => {
    const { store } = await memStore();
    const a = upsertJob(store, normalizeRawJob(rawJob()));
    const b = upsertJob(store, normalizeRawJob(rawJob({ source: "lever", externalJobId: "lv-1", jobTitle: "Backend Engineer (Java)", applyUrl: "https://jobs.lever.co/acme/lv-1/apply", jobUrl: "https://jobs.lever.co/acme/lv-1" })));
    expect(b).toMatchObject({ jobId: a.jobId, matchedBy: "jd_hash" });
  });

  it("new jobs are logged DISCOVERED → NORMALIZED, JD goes to the Job Details tab", async () => {
    const { store } = await memStore();
    const a = upsertJob(store, normalizeRawJob(rawJob()));
    expect(getTimeline(store, a.jobId).map((e) => e.event)).toEqual(["DISCOVERED", "DISCOVERED", "NORMALIZED"]);
    expect(a.jobId).toMatch(/^JOB-\d{6}$/);
    expect(store.t.details.get(a.jobId)?.jdText).toMatch(/Java/);
    expect(new JobRepo(store).get(a.jobId)?.jdText).toMatch(/Java/);
  });

  it("adopts a row the user typed into the dashboard (same Apply Link, no Job ID) instead of duplicating it", async () => {
    const userRow = ["2026-09-01", "manual", "Acme Payments", "Java Backend Developer", "", "", "", "", "", "", "https://boards.greenhouse.io/acme/jobs/1001", "", "", "Interested", "call recruiter"];
    const { store, sheet } = await memStore({ Jobs: [[...USER_COLUMNS, "My Notes"], userRow] });
    const a = upsertJob(store, normalizeRawJob(rawJob()));
    expect(a.matchedBy).toBe("adopted_sheet_row");
    await store.flush();
    const grid = sheet.tabs.get("Jobs") ?? [];
    expect(grid).toHaveLength(2);
    expect(grid[1]?.[grid[0]?.indexOf("Job ID") ?? -1]).toBe(a.jobId);
    expect(grid[1]?.[USER_COLUMNS.length]).toBe("call recruiter");
  });
});
