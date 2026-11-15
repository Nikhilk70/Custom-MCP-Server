import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canTransition, getTimeline, recordTimeline, transition } from "../../agent/store/stateMachine.ts";
import { normalizeRawJob } from "../../agent/normalization/normalize.ts";
import { upsertJob } from "../../agent/normalization/dedupe.ts";
import { AgentError } from "../../agent/core/errors.ts";
import { withRetry } from "../../agent/core/retry.ts";
import { SecretMasker } from "../../agent/core/logger.ts";
import { loadProfile } from "../../agent/profile/profile.ts";
import { verifyProfileAgainstSource } from "../../agent/profile/verifyProfile.ts";
import { makeTempRoot, memStore, rawJob } from "../helpers.ts";

describe("state machine", () => {
  it("rejects illegal transitions and logs legal ones", async () => {
    const { store } = await memStore();
    const { jobId } = upsertJob(store, normalizeRawJob(rawJob()));
    expect(() => transition(store, jobId, "APPLIED")).toThrowError(/not allowed/);
    transition(store, jobId, "JD_FETCHED", { reason: "test" });
    recordTimeline(store, jobId, "JD_FETCHED");
    const tl = getTimeline(store, jobId);
    expect(tl.map((t) => t.event)).toEqual(["DISCOVERED", "DISCOVERED", "NORMALIZED", "JD_FETCHED", "JD_FETCHED"]);
    expect(canTransition("APPLIED", "FAILED")).toBe(false);
    expect(canTransition("SUBMITTING", "SUBMISSION_UNVERIFIED")).toBe(true);
  });
});

describe("retry", () => {
  it("retries network errors a bounded number of times", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new AgentError("NETWORK_ERROR", "x"); }, { sleep: async () => undefined })).rejects.toThrow();
    expect(n).toBe(3);
  });
  it("never retries CAPTCHA, auth or unknown questions", async () => {
    for (const code of ["CAPTCHA", "AUTH_REQUIRED", "UNKNOWN_QUESTION", "OTP"] as const) {
      let n = 0;
      await expect(withRetry(async () => { n++; throw new AgentError(code, "x"); }, { sleep: async () => undefined })).rejects.toThrow();
      expect(n).toBe(1);
    }
  });
});

describe("secret masking", () => {
  it("masks known values and secret-looking keys", () => {
    const m = new SecretMasker(["supersecretvalue"]);
    expect(m.maskValue({ msg: "token=supersecretvalue", apiKey: "abc123", nested: { password: "p" } })).toEqual({ msg: "token=***", apiKey: "***", nested: { password: "***" } });
  });
});

describe("profile integrity", () => {
  it("every MY_DATA fact is found in the resume source", () => {
    makeTempRoot();
    const v = verifyProfileAgainstSource(loadProfile());
    expect(v.unverified).toEqual([]);
    expect(v.checked).toBeGreaterThan(20); // any real resume has at least this many facts
  });
  it("detects a fabricated fact", () => {
    const root = makeTempRoot();
    const f = path.join(root, "Data_Resume/MY_DATA/Projects/projects.json");
    const j = JSON.parse(fs.readFileSync(f, "utf8")) as { entries: Array<{ achievements: string[] }> };
    j.entries[0]?.achievements.push("Reduced latency by 80% for 1M users.");
    fs.writeFileSync(f, JSON.stringify(j));
    expect(verifyProfileAgainstSource(loadProfile()).unverified.map((u) => u.value)).toContain("Reduced latency by 80% for 1M users.");
  });
});

