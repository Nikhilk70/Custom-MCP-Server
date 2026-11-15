import type { SafetyConfig } from "../core/config.ts";
import type { Profile } from "../profile/profile.ts";
import { answerSourceOf, chooseOption, matchQuestion, resolveAnswer, type AnswerSource, type QuestionRecord, type TrustLevel } from "../questions/questionBank.ts";
import type { DetectedField, FieldClass } from "./fieldTypes.ts";

export type FillAction = "FILL" | "UPLOAD_RESUME" | "SKIP_OPTIONAL" | "NEEDS_HUMAN" | "ALREADY_FILLED";

export interface FieldPlan {
  field: DetectedField;
  classification: FieldClass;
  canonicalKey: string | null;
  answer: string | null;
  trust: TrustLevel;
  confidence: number;
  action: FillAction;
  reason: string;
  /** Where the answer came from; absent when nothing is filled. */
  source?: AnswerSource | "RESUME_FILE";
}

function compile(patterns: string[]): RegExp[] {
  return patterns.map((p) => new RegExp(`(^|\\b)${p}(\\b|$)`, "i"));
}

export interface ClassifierContext {
  safety: SafetyConfig;
  records: QuestionRecord[];
  profile: Profile;
  allowAiSuggested: boolean;
  resumeAvailable: boolean;
}

/**
 * Classifies one field and decides what (if anything) may be filled.
 * Order matters: CAPTCHA/OTP → file → legal → sensitive → question bank → unknown.
 * A legal/sensitive field is filled only when the user has recorded a verified answer for it.
 */
export function planField(field: DetectedField, ctx: ClassifierContext): FieldPlan {
  const text = `${field.label} ${field.name ?? ""} ${field.placeholder ?? ""}`;
  const base = { field, canonicalKey: null, answer: null, trust: "UNKNOWN" as TrustLevel, confidence: 0 };
  const optional = (reason: string, classification: FieldClass): FieldPlan => ({ ...base, classification, action: field.required ? "NEEDS_HUMAN" : "SKIP_OPTIONAL", reason });

  if (/captcha|recaptcha|hcaptcha/i.test(text)) return { ...base, classification: "CAPTCHA", action: "NEEDS_HUMAN", reason: "CAPTCHA field — never automated" };
  if (field.autocomplete === "one-time-code" || compile(ctx.safety.otpPatterns).some((re) => re.test(text))) return { ...base, classification: "OTP", action: "NEEDS_HUMAN", reason: "OTP / verification code — never automated" };

  if (field.kind === "FILE_UPLOAD") {
    if (/resume|cv|curriculum/i.test(text)) {
      return ctx.resumeAvailable
        ? { ...base, classification: "FILE_UPLOAD", confidence: 0.95, trust: "VERIFIED_USER_DATA", action: "UPLOAD_RESUME", reason: "resume upload field", source: "RESUME_FILE" }
        : { ...base, classification: "FILE_UPLOAD", action: "NEEDS_HUMAN", reason: "resume field but no generated resume PDF" };
    }
    return optional(`file upload '${field.label}' is not a resume field`, "FILE_UPLOAD");
  }

  const legal = compile(ctx.safety.legalOrEligibilityPatterns).some((re) => re.test(text));
  const sensitive = !legal && compile(ctx.safety.sensitivePatterns).some((re) => re.test(text));
  const match = matchQuestion(ctx.records, field);
  const resolved = match ? resolveAnswer(match, ctx.profile) : null;
  const userVerifiedExplicit = resolved?.trust === "VERIFIED_USER_DATA" && match?.record.answerRef === null;

  if (legal) {
    if (match && resolved?.value && userVerifiedExplicit && match.confidence >= 0.9) {
      return withOption(field, { ...base, classification: "LEGAL_OR_ELIGIBILITY", canonicalKey: match.record.canonicalKey, answer: resolved.value, trust: resolved.trust, confidence: match.confidence, action: "FILL", reason: `explicit verified rule ${match.record.questionId}`, source: answerSourceOf(match.record) });
    }
    return {
      ...base,
      classification: "LEGAL_OR_ELIGIBILITY",
      canonicalKey: match?.record.canonicalKey ?? null,
      action: field.required ? "NEEDS_HUMAN" : "SKIP_OPTIONAL",
      reason: field.required ? "legal/eligibility question without an explicit verified answer" : "optional legal/consent field left untouched",
    };
  }

  if (!match || !resolved) return optional(`no question-bank match for '${field.label}'`, sensitive ? "SENSITIVE" : "UNKNOWN");
  if (!resolved.value) return { ...optional(resolved.basis, sensitive ? "SENSITIVE" : "UNKNOWN"), canonicalKey: match.record.canonicalKey, confidence: match.confidence };
  if (resolved.trust === "AI_SUGGESTED" && !ctx.allowAiSuggested) return { ...optional("AI-suggested answer not allowed", "KNOWN_REQUIRES_REVIEW"), canonicalKey: match.record.canonicalKey };

  const needsReview = sensitive || match.record.sensitivity !== "normal" || match.confidence < 0.85;
  const classification: FieldClass = sensitive || match.record.sensitivity === "sensitive" ? "SENSITIVE" : needsReview ? "KNOWN_REQUIRES_REVIEW" : "KNOWN_SAFE";
  if (classification === "SENSITIVE" && !userVerifiedExplicit && match.record.answerRef?.startsWith("derived.")) {
    return { ...base, classification, canonicalKey: match.record.canonicalKey, confidence: match.confidence, action: "NEEDS_HUMAN", reason: "sensitive field needs an explicit verified answer" };
  }
  return withOption(field, {
    ...base,
    classification,
    canonicalKey: match.record.canonicalKey,
    answer: resolved.value,
    trust: resolved.trust,
    confidence: match.confidence,
    action: field.currentValue && field.currentValue === resolved.value ? "ALREADY_FILLED" : "FILL",
    reason: `${match.record.questionId} via '${match.matchedPattern}' (${resolved.basis})`,
    source: answerSourceOf(match.record),
  });
}

/** For choice fields, the answer must map onto exactly one offered option. */
function withOption(field: DetectedField, plan: FieldPlan): FieldPlan {
  if (!["DROPDOWN", "RADIO", "MULTI_SELECT"].includes(field.kind) && !(field.kind === "CHECKBOX" && field.options.length > 1)) return plan;
  if (!plan.answer) return plan;
  const opt = chooseOption(field.options, plan.answer);
  if (!opt) return { ...plan, action: field.required ? "NEEDS_HUMAN" : "SKIP_OPTIONAL", reason: `answer '${plan.answer}' matches none of: ${field.options.slice(0, 8).join(" | ")}` };
  return { ...plan, answer: opt };
}

export function planForm(fields: DetectedField[], ctx: ClassifierContext): FieldPlan[] {
  return fields.map((f) => planField(f, ctx));
}
