import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentQueue, type QueueItem } from "../../server/queue.ts";
import { HumanTaskCenter, type HumanTask } from "../../server/humanTasks.ts";
import { AnswerBank } from "../../server/answerBank.ts";
import { JsonFile } from "../../server/lib/jsonFile.ts";
import { hostAllowed, safeJoin, tokensEqual } from "../../server/http.ts";
import { explainStop } from "../../server/runtime.ts";
import { parseAnswers } from "../../agent/questions/answersFile.ts";
import { asksQualifiedYears, humanAnswerRecords, matchQuestion, type QuestionRecord } from "../../agent/questions/questionBank.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "applypilot-"));

describe("agent queue (persistent, sequential)", () => {
  const make = (dir = tmp()) => new AgentQueue(new JsonFile<QueueItem[]>(path.join(dir, "queue.json"), () => []));
  const job = (n: number) => ({ jobId: `JOB-00000${n}`, company: `Co ${n}`, role: "Developer" });

  it("never queues the same job twice while it is waiting or running", () => {
    const q = make();
    expect(q.enqueue([job(1), job(2)]).added).toHaveLength(2);
    const again = q.enqueue([job(1), job(3)]);
    expect(again.added.map((i) => i.jobId)).toEqual(["JOB-000003"]);
    expect(again.skipped).toEqual([{ jobId: "JOB-000001", reason: "already in the queue" }]);
  });

  it("serves the highest priority first, then the oldest", () => {
    const q = make();
    q.enqueue([job(1), job(2)]);
    q.enqueue([job(3)], 5);
    expect(q.next()?.jobId).toBe("JOB-000003");
  });

  it("start → finish records attempts and outcome; skip, retry and cancel work on waiting items", () => {
    const q = make();
    const [a, b, c] = q.enqueue([job(1), job(2), job(3)]).added;
    if (!a || !b || !c) throw new Error("setup");
    q.start(a.id, "SES-1");
    expect(q.get(a.id)).toMatchObject({ status: "RUNNING", attemptCount: 1, sessionId: "SES-1" });
    q.finish(a.id, "DONE", "DRY_RUN_VALIDATED");
    expect(q.get(a.id)).toMatchObject({ status: "DONE", outcome: "DRY_RUN_VALIDATED" });
    expect(q.skip(b.id).status).toBe("SKIPPED");
    expect(() => q.skip(a.id)).toThrow(/only a queued item/);
    q.retry(b.id);
    expect(q.get(b.id)?.status).toBe("QUEUED");
    expect(q.cancelAll()).toBe(2);
    expect(q.pending()).toBe(0);
  });

  it("an item RUNNING when the process died is marked FAILED for review — never re-run automatically", () => {
    const dir = tmp();
    const q = make(dir);
    const [a] = q.enqueue([job(1)]).added;
    if (!a) throw new Error("setup");
    q.start(a.id, "SES-1");
    const reopened = make(dir);
    expect(reopened.recoverInterrupted()).toBe(1);
    expect(reopened.get(a.id)).toMatchObject({ status: "FAILED", outcome: "FAILED" });
    expect(reopened.get(a.id)?.failureReason).toMatch(/may already have been submitted/);
    expect(reopened.next()).toBeNull();
  });
});

describe("human task center", () => {
  const make = (dir = tmp()) => new HumanTaskCenter(new JsonFile<HumanTask[]>(path.join(dir, "tasks.json"), () => []));
  const base = { title: "t", why: "w", whatToDo: "d", whatNext: "n", jobId: "JOB-1", applicationId: null, company: "Acme", role: "Dev" };

  it("wakes the waiting agent with the user's action; a CAPTCHA task can be signalled more than once", async () => {
    const c = make();
    const t = c.create({ ...base, type: "CAPTCHA", blocking: true });
    const first = c.next(t.id);
    expect(c.signal(t.id, { action: "continue" })).toBe(true);
    await expect(first).resolves.toEqual({ action: "continue" });
    const second = c.next(t.id);
    c.signal(t.id, { action: "skip" });
    await expect(second).resolves.toEqual({ action: "skip" });
    c.close(t.id, "SKIPPED");
    expect(() => c.signal(t.id, { action: "continue" })).toThrow(/already SKIPPED/);
  });

  it("STOP ALL releases every waiter with a negative answer (nothing hangs, a review is rejected)", async () => {
    const c = make();
    const cap = c.create({ ...base, type: "CAPTCHA", blocking: true });
    const rev = c.create({ ...base, type: "REVIEW_SUBMIT", blocking: true });
    const w1 = c.next(cap.id);
    const w2 = c.next(rev.id);
    c.releaseAll("stopped");
    await expect(w1).resolves.toEqual({ action: "skip" });
    await expect(w2).resolves.toEqual({ action: "reject" });
    expect(c.pendingCount()).toBe(0);
  });

  it("after a restart, tasks the agent was blocked on are expired (they can no longer be answered)", () => {
    const dir = tmp();
    const c = make(dir);
    c.create({ ...base, type: "NEW_QUESTION", blocking: true });
    c.create({ ...base, type: "UNKNOWN_FORM", blocking: false });
    const reopened = make(dir);
    expect(reopened.list({ status: "PENDING" }).map((t) => t.type)).toEqual(["UNKNOWN_FORM"]);
    expect(reopened.list({ status: "EXPIRED" })).toHaveLength(1);
  });
});

describe("answer bank (Application_Answers.txt, backward compatible)", () => {
  const setup = () => {
    const dir = tmp();
    const file = path.join(dir, "Application_Answers.txt");
    fs.writeFileSync(file, "# My answers\nFirst Name : Asha\nJava Experience : 1 year\n\n# Relocation\nWilling to Relocate : Yes\nWilling to Relocate to Pune : Yes\nNotice Period :\n");
    return { dir, file, bank: new AnswerBank(file, path.join(dir, "backups")) };
  };
  const profile = { personal: { fullName: "Asha Rao" }, experience: [], education: [], skills: {}, preferences: {} } as unknown as Parameters<AnswerBank["list"]>[0]["profile"];

  it("keeps subject-specific and city-specific keys distinct from general ones", () => {
    expect(AnswerBank.keyOf("Java Experience")).toBe("java_experience_years");
    expect(AnswerBank.keyOf("Total Experience")).toBe("years_experience");
    expect(AnswerBank.keyOf("Willing to Relocate to Pune")).toBe("relocate_to_pune");
    expect(AnswerBank.keyOf("Willing to Relocate")).toBe("willing_to_relocate");
    expect(AnswerBank.keyOf("How many years of experience do you have working with a SaaS firm?")).toMatch(/_years$/);
  });

  it("edits a value in place, adds new answers in a learned section, preserves comments, and backs up every change", () => {
    const { dir, file, bank } = setup();
    expect(bank.upsert("Notice Period", "15 days")).toEqual({ id: "notice_period", created: false });
    expect(bank.upsert("Have you worked at MongoDB before?", "No").created).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toMatch(/^# My answers/);
    expect(text).toMatch(/Notice Period : 15 days/);
    expect(text).toMatch(/# Learned in ApplyPilot[^\n]*\nHave you worked at MongoDB before : No/);
    expect(fs.readdirSync(path.join(dir, "backups")).length).toBe(2);
    // The CLI parser reads exactly what the bank wrote.
    const parsed = parseAnswers(text).entries;
    expect(parsed.find((e) => e.canonicalKey === "notice_period")?.value).toBe("15 days");
  });

  it("disable comments a line out (the agent ignores it), enable restores it, delete removes it", () => {
    const { file, bank } = setup();
    bank.setDisabled("java_experience_years", true);
    expect(fs.readFileSync(file, "utf8")).toMatch(/# \[disabled\] Java Experience : 1 year/);
    expect(parseAnswers(fs.readFileSync(file, "utf8")).entries.some((e) => e.canonicalKey === "java_experience_years")).toBe(false);
    bank.setDisabled("java_experience_years", false);
    expect(parseAnswers(fs.readFileSync(file, "utf8")).entries.find((e) => e.canonicalKey === "java_experience_years")?.value).toBe("1 year");
    bank.remove("relocate_to_pune");
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/Pune/);
  });

  it("lists answers with categories, company scope, blank-means-ask notes and usage", () => {
    const { bank } = setup();
    bank.upsert("Have you worked at MongoDB before", "No");
    const usage = new Map([["java_experience_years", { count: 3, last: "2026-09-30T10:00:00Z", history: [] }]]);
    const items = bank.list({ profile, companies: ["MongoDB"], usage, questionsDir: path.join(tmp(), "none") });
    const by = (id: string) => items.find((i) => i.id === id);
    expect(by("java_experience_years")).toMatchObject({ category: "Technology", usageCount: 3, source: "USER" });
    expect(by("relocate_to_pune")?.category).toBe("Relocation");
    expect(by("notice_period")).toMatchObject({ answer: null, category: "Work Preferences" });
    expect(by("notice_period")?.note).toMatch(/never guessed/);
    const mongo = items.find((i) => i.question.startsWith("Have you worked at MongoDB"));
    expect(mongo).toMatchObject({ scope: "COMPANY", company: "MongoDB", source: "COMPANY_SPECIFIC", category: "Company-specific" });
  });
});

describe("answer matching engine (safe, no over-matching)", () => {
  const rec = (canonicalKey: string, patterns: string[], answer: string): QuestionRecord => ({ questionId: canonicalKey, canonicalKey, patterns, answerType: "text", answer, answerRef: null, source: "user_verified", verified: true, sensitivity: "review", note: "Application_Answers.txt line 1", category: "x", file: "Application_Answers.txt" });
  const records = [
    rec("willing_to_relocate", ["willing to relocate", "open to relocating", "open to relocation"], "No"),
    rec("relocate_to_pune", ["open to relocating to pune", "willing to relocate to pune", "relocate to pune", "move to pune"], "Yes"),
    rec("years_experience", ["years of experience", "total experience"], "1"),
    // Built exactly as Application_Answers.txt "Java Experience : 1 year" is.
    rec("java_experience_years", parseAnswers("Java Experience : 1 year").entries[0]?.patterns ?? [], "1 year"),
  ];

  it("a Pune relocation question uses the Pune answer; a general one never does", () => {
    expect(matchQuestion(records, { label: "Are you open to relocating to Pune?" })?.record.canonicalKey).toBe("relocate_to_pune");
    expect(matchQuestion(records, { label: "Would you relocate to Pune?" })?.record.canonicalKey).toBe("relocate_to_pune");
    expect(matchQuestion(records, { label: "Are you willing to relocate?" })?.record.canonicalKey).toBe("willing_to_relocate");
  });

  it("a subject-specific years question is answered only by that subject's record, never by total experience", () => {
    expect(matchQuestion(records, { label: "How many years of experience do you have in Java?" })?.record.canonicalKey).toBe("java_experience_years");
    expect(matchQuestion(records, { label: "How many years of experience do you have working with a SaaS firm?" })).toBeNull();
  });

  it("an answer the user typed during an application matches its own question exactly (confidence 1)", () => {
    const label = "How many years of experience do you have working with a SaaS firm?";
    expect(asksQualifiedYears(label)).toBe(true);
    const learned = humanAnswerRecords([{ label, answer: "0 years" }, { label: "Blank one", answer: "  " }]);
    expect(learned).toHaveLength(1);
    expect(learned[0]?.canonicalKey).toMatch(/_years$/);
    const m = matchQuestion([...learned, ...records], { label });
    expect(m?.record.answer).toBe("0 years");
    // It does not leak onto a different subject.
    expect(matchQuestion([...learned, ...records], { label: "How many years of experience do you have in Kotlin?" })).toBeNull();
  });

  it("company-specific answers stay with that company's question", () => {
    const mongo = humanAnswerRecords([{ label: "Have you ever worked at MongoDB before?", answer: "No" }]);
    const m = matchQuestion(mongo, { label: "Have you ever worked at Rubrik before?" });
    expect(m === null || m.confidence < 0.9).toBe(true);
  });
});

describe("server security helpers", () => {
  it("only localhost host names are served (DNS rebinding protection)", () => {
    expect(hostAllowed("127.0.0.1:4317")).toBe(true);
    expect(hostAllowed("localhost:5173")).toBe(true);
    expect(hostAllowed("[::1]:4317")).toBe(true);
    expect(hostAllowed("evil.example:4317")).toBe(false);
    expect(hostAllowed(undefined)).toBe(false);
  });
  it("tokens compare in constant time and must match exactly", () => {
    expect(tokensEqual("abc123", "abc123")).toBe(true);
    expect(tokensEqual("abc123", "abc124")).toBe(false);
    expect(tokensEqual("abc", "abc123")).toBe(false);
  });
  it("client-supplied file paths cannot escape their folder or change type", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "a.png"), "x");
    expect(safeJoin(dir, "a.png", [".png"])).toBe(path.join(dir, "a.png"));
    expect(() => safeJoin(dir, "../secret.png", [".png"])).toThrow(/not allowed/);
    expect(() => safeJoin(dir, "a.png", [".pdf"])).toThrow(/not allowed/);
  });
  it("'why did the agent stop' explains engine reasons in plain words", () => {
    expect(explainStop("field 'X': no question-bank match for 'X'")).toMatch(/never guesses/);
    expect(explainStop("PAYMENT_REQUESTED: fee")).toMatch(/payment/);
    expect(explainStop("no application form found at https://x (only 0 non-application field(s); unsupported flow)")).toMatch(/unexpected form/);
  });
});
