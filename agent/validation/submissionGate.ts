import type { ApplicationMode } from "../core/env.ts";
import type { FieldPlan } from "../application/fieldClassifier.ts";
import type { ClassifiedButton } from "./buttonClassifier.ts";

export interface GateInput {
  mode: ApplicationMode;
  dryRun: boolean;
  plans: FieldPlan[];
  emptyRequiredAfterFill: string[];
  captcha: boolean;
  /** Invisible CAPTCHA widget on the page: it may challenge on submit, so a human must submit. */
  captchaDormant?: boolean;
  otp: boolean;
  loginWall: boolean;
  resumeRequiredField: boolean;
  resumeAttached: boolean;
  jobConfirmed: boolean;
  finalSubmit: ClassifiedButton | null;
  finalSubmitAmbiguous: boolean;
  highConfidenceThreshold: number;
  humanApproved: boolean;
}

export interface GateDecision {
  validationPassed: boolean;
  submitAllowed: boolean;
  blockers: string[];
  reviewReasons: string[];
}

/**
 * Pure submission gate. validationPassed = the form is correct and complete.
 * submitAllowed additionally requires the mode to permit submission:
 *   REVIEW_ONLY            → never
 *   AUTO_FILL_REVIEW_SUBMIT → only with explicit human approval
 *   FULL_AUTO              → only if every field is KNOWN_SAFE, high-confidence and verified
 * DRY_RUN always blocks submission.
 */
export function evaluateGate(g: GateInput): GateDecision {
  const blockers: string[] = [];
  const review: string[] = [];
  if (g.captcha) blockers.push("CAPTCHA present");
  else if (g.captchaDormant) blockers.push("invisible CAPTCHA on the page (may challenge at submit): a human must submit");
  if (g.otp) blockers.push("OTP / verification code requested");
  if (g.loginWall) blockers.push("login required");
  if (!g.jobConfirmed) blockers.push("page does not confirm the expected company/job title");
  for (const p of g.plans) if (p.action === "NEEDS_HUMAN") blockers.push(`field '${p.field.label}': ${p.reason}`);
  for (const l of g.emptyRequiredAfterFill) blockers.push(`required field still empty: '${l}'`);
  if (g.resumeRequiredField && !g.resumeAttached) blockers.push("resume not attached");
  if (!g.finalSubmit) blockers.push("final submit button not identified");
  else if (g.finalSubmitAmbiguous) blockers.push("more than one possible final submit button");
  const validationPassed = blockers.length === 0;

  for (const p of g.plans) {
    if (p.action !== "FILL" && p.action !== "UPLOAD_RESUME" && p.action !== "ALREADY_FILLED") continue;
    if (p.classification !== "KNOWN_SAFE" && p.classification !== "FILE_UPLOAD") review.push(`'${p.field.label}' is ${p.classification}`);
    if (p.confidence < g.highConfidenceThreshold) review.push(`'${p.field.label}' mapped with confidence ${p.confidence}`);
    if (p.trust !== "VERIFIED_USER_DATA" && p.trust !== "DETERMINISTIC_DERIVED") review.push(`'${p.field.label}' answer trust ${p.trust}`);
  }
  if (g.finalSubmit && g.finalSubmit.confidence < g.highConfidenceThreshold) review.push(`submit button confidence ${g.finalSubmit.confidence} (${g.finalSubmit.reason})`);

  let submitAllowed = false;
  if (g.dryRun) blockers.push("DRY_RUN=true — submission disabled");
  else if (!validationPassed) submitAllowed = false;
  else if (g.mode === "REVIEW_ONLY") review.push("mode REVIEW_ONLY — human submits");
  else if (g.mode === "AUTO_FILL_REVIEW_SUBMIT") {
    if (g.humanApproved) submitAllowed = true;
    else review.push("mode AUTO_FILL_REVIEW_SUBMIT — awaiting human approval");
  } else if (g.mode === "FULL_AUTO") submitAllowed = review.length === 0;

  return { validationPassed, submitAllowed: submitAllowed && !g.dryRun, blockers, reviewReasons: review };
}
