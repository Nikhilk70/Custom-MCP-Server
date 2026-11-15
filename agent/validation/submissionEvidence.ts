export interface EvidenceInput {
  beforeUrl: string;
  afterUrl: string;
  afterText: string;
  formStillPresent: boolean;
  visibleErrors: string[];
  confirmationPatterns: string[];
  /** The site said, in words, that the application failed ("There was an error processing your application"). */
  siteError?: string | null;
}

export interface SubmissionEvidence {
  verdict: "VERIFIED" | "UNVERIFIED" | "REJECTED";
  signals: string[];
  confirmationText: string | null;
  confirmationId: string | null;
}

/**
 * Decides whether a submission is proven. A click alone proves nothing:
 *  VERIFIED   — explicit confirmation wording on the resulting page
 *  REJECTED   — the form is still there and shows validation errors, or the site said the application failed
 *  UNVERIFIED — anything else (e.g. URL changed but no confirmation text)
 */
export function evaluateSubmissionEvidence(e: EvidenceInput): SubmissionEvidence {
  const signals: string[] = [];
  const text = e.afterText.replace(/\s+/g, " ");
  let confirmationText: string | null = null;
  for (const p of e.confirmationPatterns) {
    const m = new RegExp(p, "i").exec(text);
    if (m) {
      confirmationText = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 80).trim();
      signals.push(`confirmation text: /${p}/`);
      break;
    }
  }
  const idMatch = /(application|reference|confirmation)\s*(id|number|#|no\.?)\s*[:#]?\s*([A-Z0-9-]{4,})/i.exec(text);
  const confirmationId = idMatch?.[3] ?? null;
  if (confirmationId) signals.push(`confirmation id ${confirmationId}`);
  if (e.afterUrl !== e.beforeUrl) signals.push(`url changed → ${e.afterUrl}`);
  if (/thank|confirm|success|submitted/i.test(new URL(e.afterUrl, "http://x").pathname)) signals.push("confirmation-like URL path");
  if (!e.formStillPresent) signals.push("application form no longer present");

  if (e.siteError && !confirmationText) return { verdict: "REJECTED", signals: [...signals, `site error: ${e.siteError}`], confirmationText: null, confirmationId: null };
  if (e.formStillPresent && e.visibleErrors.length && !confirmationText) return { verdict: "REJECTED", signals: [...signals, ...e.visibleErrors.map((x) => `error: ${x}`)], confirmationText: null, confirmationId: null };
  if (confirmationText) return { verdict: "VERIFIED", signals, confirmationText, confirmationId };
  return { verdict: "UNVERIFIED", signals, confirmationText: null, confirmationId };
}
