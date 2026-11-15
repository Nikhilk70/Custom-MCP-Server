import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadQuestionBank, matchQuestion, resolveAnswer, type QuestionRecord } from "../../agent/questions/questionBank.ts";
import { noticeDays, parseAnswers, yesNo } from "../../agent/questions/answersFile.ts";
import { loadProfile, type Profile } from "../../agent/profile/profile.ts";
import { makeTempRoot } from "../helpers.ts";

let root: string;
let profile: Profile;
beforeAll(() => {
  root = makeTempRoot();
  profile = loadProfile();
});

/** The template format from the user's message, with some answers filled. */
const FILE = `# notes are ignored
First Name : Asha
Last Name : M P
Preferred Name :
Email : candidate@example.com
Contact Number : 9876543210
Total Experience : 0-1 years
Java Experience : 1 year
SaaS Experience : 0
Highest Education : MCA
Graduation Year : 2024
Willing to Relocate : No
Willing to Relocate to Pune : Yes
Codeforces Rating :
Have you worked at MongoDB before : No
`;

function bank(text: string): { records: QuestionRecord[]; issues: string[] } {
  const f = path.join(root, "answers-test.txt");
  fs.writeFileSync(f, text);
  return loadQuestionBank(undefined, f, profile);
}
const answer = (records: QuestionRecord[], label: string) => {
  const m = matchQuestion(records, { label });
  return m ? { key: m.record.canonicalKey, ...resolveAnswer(m, profile, new Date("2026-09-30")) } : null;
};

describe("Application_Answers.txt", () => {
  it("parses 'Key : Value' lines; blank means not provided", () => {
    const { entries, issues } = parseAnswers(FILE);
    expect(issues).toEqual([]);
    expect(entries.find((e) => e.key === "Last Name")).toMatchObject({ canonicalKey: "last_name", value: "M P" });
    expect(entries.find((e) => e.key === "Preferred Name")?.value).toBeNull();
    expect(entries.find((e) => e.key === "Java Experience")?.canonicalKey).toBe("java_experience_years");
  });

  it("filled values become explicit, verified answers", () => {
    const { records } = bank(FILE);
    expect(answer(records, "Last Name")).toMatchObject({ value: "M P", trust: "VERIFIED_USER_DATA" });
    expect(answer(records, "Have you ever worked at MongoDB before?")).toMatchObject({ key: "answer_have_you_worked_at_mongodb_before", value: "No" });
  });

  it("skill/domain experience answers only its own subject — never total experience", () => {
    const { records } = bank(FILE);
    expect(answer(records, "How many years of experience do you have in Java?")).toMatchObject({ key: "java_experience_years", value: "1 year" });
    expect(answer(records, "How many years of experience do you have working with a SaaS firm?")).toMatchObject({ key: "saas_experience_years", value: "0" });
    expect(answer(records, "How many years of experience do you have with Kubernetes?")).toBeNull(); // not in the file → a human
    expect(answer(records, "Total years of experience")).toMatchObject({ value: "0.8" }); // "0-1 years" agrees with the verified 0.8
  });

  it("a city-specific relocation answer wins over the general one for that city only", () => {
    const { records } = bank(FILE);
    expect(answer(records, "Are you open to relocating to Pune?")).toMatchObject({ key: "relocate_to_pune", value: "Yes" });
    expect(answer(records, "Are you willing to relocate?")).toMatchObject({ key: "willing_to_relocate", value: "No" });
  });

  it("blank values never produce an answer", () => {
    const { records } = bank(FILE);
    expect(answer(records, "Codeforces Rating")).toMatchObject({ value: null, trust: "UNKNOWN" });
    expect(answer(records, "Preferred Name")).toMatchObject({ value: null });
  });

  it("values contradicting verified resume data are not used and are reported", () => {
    const { records, issues } = bank(FILE);
    expect(issues.join("\n")).toMatch(/'Highest Education : MCA' contradicts MY_DATA \(BE in Electronics & Communication Engineering\)/);
    expect(issues.join("\n")).toMatch(/'Graduation Year : 2024' contradicts MY_DATA \(2025\)/);
    expect(answer(records, "Highest Degree")?.value).toBe("BE in Electronics & Communication Engineering");
    expect(issues.join("\n")).not.toMatch(/Contact Number|Email|Total Experience/); // same values in another format are not conflicts
  });

  it("preferences stated in the file are used as written, not checked against MY_DATA (live regression: notice period)", () => {
    const { records, issues } = bank("Notice Period : 15 days\nExpected CTC : ₹6,00,000 per annum (6 LPA)\n");
    expect(issues).toEqual([]);
    expect(answer(records, "What is your official notice period?")?.value).toBe("15 days");
    expect(answer(records, "What is your expected CTC?")?.value).toBe("₹6,00,000 per annum (6 LPA)");
  });

  it("yes/no and notice-period parsing", () => {
    expect([yesNo("Yes"), yesNo("no, thanks"), yesNo("maybe"), yesNo(null)]).toEqual([true, false, null, null]);
    expect([noticeDays("Immediate"), noticeDays("30 days"), noticeDays("2 months"), noticeDays("1 week"), noticeDays("negotiable")]).toEqual([0, 30, 60, 7, null]);
  });
});
