import { beforeAll, describe, expect, it } from "vitest";
import { chooseOption, loadQuestionBank, matchQuestion, resolveAnswer, type QuestionRecord } from "../../agent/questions/questionBank.ts";
import { planField, type ClassifierContext } from "../../agent/application/fieldClassifier.ts";
import type { DetectedField } from "../../agent/application/fieldTypes.ts";
import { classifyButton, findFinalSubmit } from "../../agent/validation/buttonClassifier.ts";
import { evaluateGate, type GateInput } from "../../agent/validation/submissionGate.ts";
import { evaluateSubmissionEvidence } from "../../agent/validation/submissionEvidence.ts";
import { loadProfile, type Profile } from "../../agent/profile/profile.ts";
import { makeTempRoot, testConfig } from "../helpers.ts";

let records: QuestionRecord[];
let profile: Profile;
let ctx: ClassifierContext;
beforeAll(() => {
  makeTempRoot();
  const qb = loadQuestionBank();
  expect(qb.issues).toEqual([]);
  records = qb.records;
  profile = loadProfile();
  ctx = { safety: testConfig().safety, records, profile, allowAiSuggested: false, resumeAvailable: true };
});

const field = (label: string, over: Partial<DetectedField> = {}): DetectedField => ({
  key: "f1", kind: "TEXT", label, name: null, id: null, inputType: "text", autocomplete: null, placeholder: null, required: true, options: [], accept: null, multiple: false, currentValue: "", visible: true, formKey: "f0", ...over,
});

describe("question bank", () => {
  const answer = (label: string) => {
    const m = matchQuestion(records, { label });
    return m ? resolveAnswer(m, profile, new Date("2026-09-30")) : null;
  };
  it("answers verified personal data", () => {
    expect(answer("Email address")).toMatchObject({ value: "candidate@example.com", trust: "VERIFIED_USER_DATA" });
    expect(answer("Where are you currently located?")).toMatchObject({ value: "Bengaluru" });
    expect(answer("First Name")).toMatchObject({ value: "Asha", trust: "DETERMINISTIC_DERIVED" });
  });
  it("never invents unknown answers", () => {
    expect(answer("Expected CTC")).toMatchObject({ value: null, trust: "UNKNOWN" });
    expect(answer("Notice period")).toMatchObject({ value: null, trust: "UNKNOWN" });
    expect(answer("Are you willing to relocate?")).toMatchObject({ value: null, trust: "UNKNOWN" });
    expect(answer("Do you require visa sponsorship?")).toMatchObject({ value: null, trust: "UNKNOWN" });
  });
  it("derives experience only from verified professional dates", () => {
    expect(answer("Total years of experience")).toMatchObject({ value: "0.8", trust: "DETERMINISTIC_DERIVED" });
    expect(answer("How many years of professional experience do you have?")).toMatchObject({ value: "0.8" });
  });
  it("never answers narrowed experience questions with total experience or a Yes (live Lever regression)", () => {
    // SaaS has its own user-answered record (empty until the user fills it), never total experience.
    expect(matchQuestion(records, { label: "How many years of experience do you have working with a SaaS firm?" })?.record.canonicalKey).toBe("saas_experience_years");
    expect(answer("How many years of experience do you have working with a SaaS firm?")).toMatchObject({ value: null, trust: "UNKNOWN" });
    const verifiedSaas = records.map((r) => (r.canonicalKey === "saas_experience_years" ? { ...r, answer: 0, verified: true } : r));
    const m = matchQuestion(verifiedSaas, { label: "How many years of experience do you have working with a SaaS firm?" });
    expect(m ? resolveAnswer(m, profile).value : null).toBe("0");
    expect(answer("How many years of experience in Java?")).toBeNull();
    expect(answer("Years of experience with Spring Boot")).toBeNull();
    expect(answer("How many years of experience do you have as a team lead?")).toBeNull();
  });
  it("answers skill questions Yes only for verified skills", () => {
    expect(answer("Do you have experience with Spring Boot?")).toMatchObject({ value: "Yes" });
    expect(answer("Do you have experience with Kubernetes?")).toMatchObject({ value: null, trust: "UNKNOWN" });
    expect(answer("Do you have experience with Python?")).toMatchObject({ value: null });
  });
  it("maps answers to options conservatively", () => {
    expect(chooseOption(["Yes", "No"], "Yes")).toBe("Yes");
    expect(chooseOption(["Bengaluru", "Pune"], "bengaluru")).toBe("Bengaluru");
    expect(chooseOption(["Option A", "Option B"], "Bengaluru")).toBeNull();
    // live Greenhouse phone-country list: "India" must not be ambiguous with "British Indian Ocean Territory"
    expect(chooseOption(["United States +1", "British Indian Ocean Territory +246", "India +91", "Indonesia +62"], "India")).toBe("India +91");
    expect(chooseOption(["Bengaluru, Bengaluru Urban, Karnataka, IND", "Bengaluru, Bangalore, Karnataka, IND"], "Bengaluru")).toBeNull(); // two equal leads → ambiguous, never guessed
  });
});

describe("field classification", () => {
  it("KNOWN_SAFE for verified contact fields", () => {
    expect(planField(field("Email", { autocomplete: "email" }), ctx)).toMatchObject({ classification: "KNOWN_SAFE", action: "FILL" });
  });
  it("legal questions need a human", () => {
    expect(planField(field("Are you legally authorized to work in India?", { kind: "RADIO", options: ["Yes", "No"] }), ctx)).toMatchObject({ classification: "LEGAL_OR_ELIGIBILITY", action: "NEEDS_HUMAN" });
  });
  it("sensitive unknowns need a human; optional unknowns are skipped", () => {
    expect(planField(field("Expected CTC"), ctx)).toMatchObject({ classification: "SENSITIVE", action: "NEEDS_HUMAN" });
    expect(planField(field("Favourite colour", { required: false }), ctx)).toMatchObject({ classification: "UNKNOWN", action: "SKIP_OPTIONAL" });
  });
  it("OTP and CAPTCHA are never automated", () => {
    expect(planField(field("Enter the verification code", { autocomplete: "one-time-code" }), ctx).classification).toBe("OTP");
    expect(planField(field("captcha"), ctx).classification).toBe("CAPTCHA");
  });
  it("resume upload fields are recognized", () => {
    expect(planField(field("Resume/CV", { kind: "FILE_UPLOAD", inputType: "file" }), ctx)).toMatchObject({ action: "UPLOAD_RESUME" });
    expect(planField(field("Resume/CV", { kind: "FILE_UPLOAD" }), { ...ctx, resumeAvailable: false }).action).toBe("NEEDS_HUMAN");
  });
  it("dropdown answers must match an offered option", () => {
    expect(planField(field("Highest Degree", { kind: "DROPDOWN", options: ["MCA", "BE in Electronics & Communication Engineering"] }), ctx)).toMatchObject({ action: "FILL", answer: "BE in Electronics & Communication Engineering" });
    expect(planField(field("Highest Degree", { kind: "DROPDOWN", options: ["MCA", "MBA"] }), ctx).action).toBe("NEEDS_HUMAN");
  });
});

describe("buttons", () => {
  const b = (text: string, over = {}) => ({ key: "b", text, tag: "button" as const, type: "submit", inForm: true, href: null, visible: true, formKey: "f0", ...over });
  it("distinguishes final submit from navigation and continuation", () => {
    expect(classifyButton(b("Submit Application")).kind).toBe("FINAL_SUBMIT");
    expect(classifyButton(b("Next")).kind).toBe("CONTINUE");
    expect(classifyButton(b("Apply for this job", { tag: "a", inForm: false, type: null })).kind).toBe("NAVIGATION");
    expect(classifyButton(b("Apply", { inForm: false, type: "button" })).kind).toBe("NAVIGATION");
    expect(classifyButton(b("Review")).kind).toBe("REVIEW");
    expect(classifyButton(b("Subscribe")).kind).toBe("OTHER"); // regression: live newsletter form on a careers page
  });
  it("flags ambiguity when two equal final-submit buttons exist", () => {
    expect(findFinalSubmit([b("Submit"), b("Submit application")]).ambiguous).toBe(true);
  });
});

describe("submission gate", () => {
  const base: GateInput = {
    mode: "FULL_AUTO", dryRun: false, plans: [], emptyRequiredAfterFill: [], captcha: false, otp: false, loginWall: false, resumeRequiredField: true, resumeAttached: true, jobConfirmed: true,
    finalSubmit: classifyButton({ key: "b", text: "Submit Application", tag: "button", type: "submit", inForm: true, href: null, visible: true, formKey: "f0" }), finalSubmitAmbiguous: false, highConfidenceThreshold: 0.85, humanApproved: false,
  };
  it("FULL_AUTO submits only when everything is verified", () => {
    expect(evaluateGate(base).submitAllowed).toBe(true);
    expect(evaluateGate({ ...base, captcha: true }).submitAllowed).toBe(false);
    expect(evaluateGate({ ...base, captchaDormant: true }).submitAllowed).toBe(false);
    expect(evaluateGate({ ...base, mode: "AUTO_FILL_REVIEW_SUBMIT", humanApproved: true, captchaDormant: true }).submitAllowed).toBe(false);
    expect(evaluateGate({ ...base, resumeAttached: false }).submitAllowed).toBe(false);
    expect(evaluateGate({ ...base, jobConfirmed: false }).submitAllowed).toBe(false);
    expect(evaluateGate({ ...base, emptyRequiredAfterFill: ["Phone"] }).submitAllowed).toBe(false);
  });
  it("REVIEW_ONLY and DRY_RUN never submit; AUTO_FILL_REVIEW_SUBMIT needs approval", () => {
    expect(evaluateGate({ ...base, mode: "REVIEW_ONLY" }).submitAllowed).toBe(false);
    expect(evaluateGate({ ...base, dryRun: true }).submitAllowed).toBe(false);
    expect(evaluateGate({ ...base, mode: "AUTO_FILL_REVIEW_SUBMIT" }).submitAllowed).toBe(false);
    expect(evaluateGate({ ...base, mode: "AUTO_FILL_REVIEW_SUBMIT", humanApproved: true }).submitAllowed).toBe(true);
  });});

describe("submission evidence", () => {
  const e = { beforeUrl: "https://x/apply", confirmationPatterns: testConfig().application.confirmationPatterns };
  it("requires confirmation text for VERIFIED", () => {
    expect(evaluateSubmissionEvidence({ ...e, afterUrl: "https://x/thanks", afterText: "Thank you for applying! Reference ID: AB-1234", formStillPresent: false, visibleErrors: [] })).toMatchObject({ verdict: "VERIFIED", confirmationId: "AB-1234" });
    expect(evaluateSubmissionEvidence({ ...e, afterUrl: "https://x/home", afterText: "Welcome", formStillPresent: false, visibleErrors: [] }).verdict).toBe("UNVERIFIED");
    expect(evaluateSubmissionEvidence({ ...e, afterUrl: "https://x/apply", afterText: "Phone is required", formStillPresent: true, visibleErrors: ["Phone is required"] }).verdict).toBe("REJECTED");
  });
});
