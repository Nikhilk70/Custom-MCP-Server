import type { DetectedButton } from "../application/fieldTypes.ts";

export type ButtonKind = "FINAL_SUBMIT" | "CONTINUE" | "REVIEW" | "NAVIGATION" | "OTHER";

export interface ClassifiedButton {
  button: DetectedButton;
  kind: ButtonKind;
  confidence: number;
  reason: string;
}

const CONTINUE = /\b(next|continue|save (and|&) continue|proceed|go to next)\b/i;
const REVIEW = /\b(review( application)?|preview)\b/i;
const FINAL = /\b(submit( (my |your )?application)?|send (my )?application|complete application|finish( application)?|submit and apply)\b/i;
const APPLY_ONLY = /^\s*(apply|apply now|apply for this (job|role|position)|easy apply|quick apply)\s*$/i;
const NAV = /\b(back|previous|cancel|sign in|log in|login|register|save for later|share|print|withdraw)\b/i;
/** Never an application submit, whatever the markup says. */
const NOT_APPLICATION = /\b(subscribe|newsletter|sign up|search|filter|get updates|notify me|job alert|contact us|download|accept( all)? cookies|reject|book a demo|request a demo)\b/i;

/**
 * Classifies a clickable element. "Apply" alone is ambiguous: outside a form (or as a link) it opens
 * the application (NAVIGATION); only a submit-type button inside the application form counts as final.
 */
export function classifyButton(b: DetectedButton): ClassifiedButton {
  const t = b.text.replace(/\s+/g, " ").trim();
  if (!t) return { button: b, kind: "OTHER", confidence: 0.2, reason: "no text" };
  if (NOT_APPLICATION.test(t)) return { button: b, kind: "OTHER", confidence: 0.95, reason: "non-application action (newsletter/search/sign-up)" };
  if (b.tag === "a" && !FINAL.test(t)) return { button: b, kind: "NAVIGATION", confidence: 0.9, reason: "link" };
  if (NAV.test(t) && !FINAL.test(t)) return { button: b, kind: "NAVIGATION", confidence: 0.85, reason: "navigation wording" };
  if (CONTINUE.test(t)) return { button: b, kind: "CONTINUE", confidence: 0.85, reason: "continuation wording" };
  if (REVIEW.test(t) && !FINAL.test(t)) return { button: b, kind: "REVIEW", confidence: 0.8, reason: "review wording" };
  if (FINAL.test(t)) {
    const inFormSubmit = b.inForm && (b.type === "submit" || b.tag === "input" || b.type === null);
    return { button: b, kind: "FINAL_SUBMIT", confidence: inFormSubmit ? 0.95 : 0.7, reason: inFormSubmit ? "submit wording, submit control inside form" : "submit wording but not a form submit control" };
  }
  if (APPLY_ONLY.test(t)) {
    if (b.inForm && b.type === "submit") return { button: b, kind: "FINAL_SUBMIT", confidence: 0.75, reason: "'Apply' submit button inside form (ambiguous wording)" };
    return { button: b, kind: "NAVIGATION", confidence: 0.8, reason: "'Apply' outside a form opens the application" };
  }
  if (b.inForm && b.type === "submit") return { button: b, kind: "FINAL_SUBMIT", confidence: 0.5, reason: "unlabeled form submit" };
  return { button: b, kind: "OTHER", confidence: 0.5, reason: "unrecognized" };
}

export function findFinalSubmit(buttons: DetectedButton[]): { candidate: ClassifiedButton | null; all: ClassifiedButton[]; ambiguous: boolean } {
  const all = buttons.filter((b) => b.visible).map(classifyButton);
  const finals = all.filter((c) => c.kind === "FINAL_SUBMIT").sort((a, b) => b.confidence - a.confidence);
  const top = finals[0] ?? null;
  const ambiguous = finals.length > 1 && (finals[1]?.confidence ?? 0) >= (top?.confidence ?? 0);
  return { candidate: top, all, ambiguous };
}
