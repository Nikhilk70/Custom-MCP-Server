import type { Page } from "playwright";
import type { SafetyConfig } from "../core/config.ts";
import type { DetectedButton, DetectedField, PageSignals } from "./fieldTypes.ts";

export interface PageScan {
  fields: DetectedField[];
  buttons: DetectedButton[];
  signals: PageSignals;
  formCount: number;
}

interface RawScan {
  fields: DetectedField[];
  buttons: DetectedButton[];
  url: string;
  title: string;
  bodyText: string;
  captchaEvidence: string | null;
  captchaDormant: string | null;
  paymentFrame: string | null;
  passwordFieldPresent: boolean;
  formCount: number;
}

/**
 * Runs inside the page. Tags each control with data-aja-id so later steps address the exact element,
 * and resolves labels the way assistive tech does: aria-labelledby → aria-label → <label for> →
 * wrapping <label> → fieldset legend (radio/checkbox groups) → placeholder → name.
 */
function scanDom(arg: { captchaSelectors: string[]; paymentFrameSelectors: string[] }): RawScan {
  const visible = (el: Element): boolean => {
    const h = el as HTMLElement;
    const s = window.getComputedStyle(h);
    const r = h.getBoundingClientRect();
    return s.display !== "none" && s.visibility !== "hidden" && (r.width > 0 || r.height > 0);
  };
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").replace(/\s*\*\s*$/, "").trim();
  const textOf = (ids: string) =>
    ids
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
  // innerText, not textContent: hidden status text (e.g. Lever's "Couldn't auto-read resume") must not become the label.
  const seen = (e: Element | null | undefined) => (e as HTMLElement | null)?.innerText ?? e?.textContent ?? "";
  const CONTROLS = "input:not([type=hidden]):not([type=submit]):not([type=button]),select,textarea";
  /**
   * Upload widgets label the input with their button ("Attach", "Upload"); the field's name is the heading of its
   * block (Greenhouse: "Resume/CV*" above "Attach | Dropbox | Enter manually").
   */
  const GENERIC_UPLOAD = /^(attach|upload|browse|choose( a)? file|select( a)? file|add( a)? file|drop (a )?files?)\b/i;
  const rawLabelFor = (el: HTMLElement): string => {
    const base = rawLabelBase(el);
    if ((el as HTMLInputElement).type !== "file" || !GENERIC_UPLOAD.test(clean(base))) return base;
    let a = el.parentElement;
    for (let depth = 0; a && depth < 5; depth++, a = a.parentElement) {
      if (a.querySelectorAll("input[type=file]").length > 1 || a.tagName === "FORM") break;
      const buttons = new Set([...a.querySelectorAll("button, a, [role=button], label")].map((b) => clean(seen(b))));
      const line = seen(a)
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && !GENERIC_UPLOAD.test(clean(l)) && !buttons.has(clean(l)) && !/^(accepted|supported|allowed) file|^max(imum)? (file )?size|^(pdf|docx?)\b/i.test(l));
      if (line) return line;
    }
    return base;
  };
  /** Raw label text (required markers kept) → cleaned by the caller. */
  const rawLabelBase = (el: HTMLElement): string => {
    const lb = el.getAttribute("aria-labelledby");
    if (lb && clean(textOf(lb))) return textOf(lb);
    const al = el.getAttribute("aria-label");
    if (al && clean(al)) return al;
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && clean(seen(l))) return seen(l);
    }
    const wrap = el.closest("label");
    if (wrap && clean(seen(wrap))) return seen(wrap).split("\n").find((l) => clean(l)) ?? "";
    // Question text beside the control (Lever custom questions, many React forms): the nearest ancestor that
    // holds this one control and some short visible text.
    let a = el.parentElement;
    for (let depth = 0; a && depth < 5; depth++, a = a.parentElement) {
      if (a.querySelectorAll(CONTROLS).length > 1 || a.tagName === "FORM") break;
      const t = clean(seen(a));
      if (t && t.length <= 300) return seen(a);
    }
    const ph = el.getAttribute("placeholder");
    if (ph) return ph;
    return el.getAttribute("name") ?? el.id ?? "";
  };
  const labelFor = (el: HTMLElement): string => clean(rawLabelFor(el).replace(/[✱]/g, " "));
  const requiredOf = (el: HTMLElement, label: string) => {
    const raw = rawLabelFor(el).trim();
    const holder = el.closest("li, fieldset, .form-group, .field, [class*='question'], [class*='field']");
    return (
      (el as HTMLInputElement).required ||
      el.getAttribute("aria-required") === "true" ||
      /\*\s*$|✱/.test(raw) ||
      /\(required\)/i.test(label) ||
      (!!holder && holder.querySelectorAll(CONTROLS).length === 1 && !!holder.querySelector(".required, [class*='required-marker'], [aria-label='required' i]"))
    );
  };

  let n = 0;
  const formKeyOf = (el: Element): string => {
    const f = el.closest("form");
    return f ? tag(f) : "noform";
  };
  const tag = (el: Element) => {
    if (!el.getAttribute("data-aja-id")) el.setAttribute("data-aja-id", `f${n++}`);
    return el.getAttribute("data-aja-id") as string;
  };

  const fields: DetectedField[] = [];
  const groups = new Map<string, HTMLInputElement[]>();
  const hiddenRequired: HTMLElement[] = [];
  const isCombo = (el: Element) => el.tagName === "INPUT" && (el.getAttribute("role") === "combobox" || el.getAttribute("aria-autocomplete") === "list");
  /** What a custom dropdown shows as chosen (react-select renders it beside the input, whose own value stays ""). */
  const comboValue = (el: HTMLInputElement): string => {
    let a = el.parentElement;
    for (let i = 0; a && i < 4; i++, a = a.parentElement) {
      const v = a.querySelector("[class*='single-value'], [class*='singleValue'], [class*='multi-value__label'], [class*='multiValueLabel']");
      if (v) return clean(v.textContent);
      if (a.querySelectorAll(CONTROLS).length > 2) break;
    }
    return el.value ?? "";
  };
  const controls = Array.from(document.querySelectorAll<HTMLElement>("input, select, textarea"));
  for (const el of controls) {
    const input = el as HTMLInputElement;
    const type = (input.type || el.tagName).toLowerCase();
    if (["hidden", "submit", "button", "reset", "image", "search"].includes(type)) continue;
    // Validation-only shadows of custom widgets (react-select's hidden `required` input): not fields themselves,
    // but they make the widget beside them required.
    if (type !== "file" && (el.getAttribute("aria-hidden") === "true" || (el.tabIndex === -1 && window.getComputedStyle(el).opacity === "0"))) {
      if (input.required) hiddenRequired.push(el);
      continue;
    }
    if (type !== "file" && !visible(el)) continue;
    if ((type === "radio" || type === "checkbox") && input.name) {
      const g = groups.get(`${type}:${input.name}`) ?? [];
      g.push(input);
      groups.set(`${type}:${input.name}`, g);
      continue;
    }
    const label = labelFor(el);
    const isSelect = el.tagName === "SELECT";
    const sel = el as HTMLSelectElement;
    const kind =
      type === "file" ? "FILE_UPLOAD" : el.tagName === "TEXTAREA" ? "TEXTAREA" : isSelect ? (sel.multiple ? "MULTI_SELECT" : "DROPDOWN") : isCombo(el) ? "COMBOBOX" : type === "date" ? "DATE" : type === "number" ? "NUMBER" : type === "checkbox" ? "CHECKBOX" : type === "radio" ? "RADIO" : "TEXT";
    fields.push({
      key: tag(el),
      kind,
      label,
      name: input.name || null,
      id: el.id || null,
      inputType: isSelect ? "select" : type,
      autocomplete: el.getAttribute("autocomplete"),
      placeholder: el.getAttribute("placeholder"),
      required: requiredOf(el, label),
      options: isSelect ? Array.from(sel.options).filter((o) => o.value !== "" && !/^(select|choose|--)/i.test(o.text.trim())).map((o) => o.text.trim()) : [],
      accept: el.getAttribute("accept"),
      multiple: !!input.multiple,
      currentValue: type === "file" ? (input.files?.[0]?.name ?? "") : type === "checkbox" ? (input.checked ? "true" : "") : isCombo(el) ? comboValue(input) : ((el as HTMLInputElement).value ?? ""),
      visible: visible(el),
      formKey: formKeyOf(el),
    });
  }
  for (const h of hiddenRequired) {
    let a = h.parentElement;
    for (let i = 0; a && i < 4; i++, a = a.parentElement) {
      const combo = a.querySelector("input[role=combobox], input[aria-autocomplete=list]");
      if (combo) {
        const f = fields.find((x) => x.key === combo.getAttribute("data-aja-id"));
        if (f) f.required = true;
        break;
      }
    }
  }
  for (const [gkey, inputs] of groups) {
    const first = inputs[0] as HTMLInputElement;
    const type = gkey.split(":")[0] as "radio" | "checkbox";
    const fs = first.closest("fieldset");
    const legend = clean(fs?.querySelector("legend")?.textContent);
    const groupLabel = legend || clean(first.closest("[role=radiogroup],[role=group]")?.getAttribute("aria-label")) || (inputs.length === 1 ? labelFor(first) : clean(first.name));
    inputs.forEach(tag);
    const checked = inputs.find((i) => i.checked);
    fields.push({
      key: `group:${first.name}`,
      kind: type === "radio" ? "RADIO" : inputs.length > 1 ? "MULTI_SELECT" : "CHECKBOX",
      label: groupLabel,
      name: first.name,
      id: first.id || null,
      inputType: type,
      autocomplete: null,
      placeholder: null,
      required: inputs.some((i) => i.required || i.getAttribute("aria-required") === "true") || /\*\s*$/.test(fs?.querySelector("legend")?.textContent ?? ""),
      options: inputs.map((i) => labelFor(i)),
      accept: null,
      multiple: type === "checkbox" && inputs.length > 1,
      currentValue: checked ? labelFor(checked) : "",
      visible: inputs.some(visible),
      formKey: formKeyOf(first),
    });
  }

  const buttons: DetectedButton[] = [];
  for (const el of Array.from(document.querySelectorAll("button, input[type=submit], input[type=button], a[href], [role=button]"))) {
    const b = el as HTMLButtonElement | HTMLInputElement | HTMLAnchorElement;
    const tagName = el.tagName.toLowerCase();
    const text = clean(tagName === "input" ? (b as HTMLInputElement).value : el.getAttribute("aria-label") || el.textContent);
    if (!text) continue;
    buttons.push({
      key: tag(el),
      text: text.slice(0, 80),
      tag: tagName === "a" ? "a" : tagName === "input" ? "input" : "button",
      type: tagName === "a" ? null : el.getAttribute("type") ?? (tagName === "button" ? "submit" : null),
      inForm: !!el.closest("form"),
      formKey: formKeyOf(el),
      href: tagName === "a" ? (b as HTMLAnchorElement).href : null,
      visible: visible(el),
    });
  }

  // A challenge the user can see blocks everything. A hidden widget (e.g. Lever's invisible hCaptcha: hidden
  // iframes, 0px container) is only dormant: it may challenge at submit, so filling is fine but submitting is not.
  let captchaEvidence: string | null = null;
  let captchaDormant: string | null = null;
  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return visible(el) && r.width >= 20 && r.height >= 20;
  };
  // reCAPTCHA v3 / invisible: only the "protected by reCAPTCHA" badge is on screen; it is not a challenge.
  const badge = (el: Element) => /[?&]size=invisible\b/.test(el.getAttribute("src") ?? "") || !!el.closest(".grecaptcha-badge");
  for (const s of arg.captchaSelectors) {
    const hits = [...document.querySelectorAll(s)];
    if (hits.some((h) => shown(h) && !badge(h))) {
      captchaEvidence = `selector ${s}`;
      break;
    }
    if (hits.length && !captchaDormant) captchaDormant = `hidden widget ${s}`;
  }
  // Payment gateways embed visible card/UPI frames. Hidden ones (e.g. Stripe's fraud-detection iframe) don't count.
  const paymentFrame = arg.paymentFrameSelectors.find((s) => [...document.querySelectorAll(s)].some(shown)) ?? null;
  return {
    paymentFrame,
    fields,
    buttons,
    url: location.href,
    title: document.title,
    bodyText: (document.body?.innerText ?? "").slice(0, 20000),
    captchaEvidence,
    captchaDormant,
    passwordFieldPresent: !!document.querySelector("input[type=password]"),
    formCount: document.querySelectorAll("form").length,
  };
}

/** esbuild (tsx/vitest) may wrap functions with a __name() helper that does not exist in the page. */
async function ensureShim(page: Page): Promise<void> {
  await page.evaluate("globalThis.__name = globalThis.__name || ((f) => f)");
}

export async function scanPage(page: Page, safety: SafetyConfig): Promise<PageScan> {
  await ensureShim(page);
  const raw = await page.evaluate(scanDom, { captchaSelectors: safety.captchaSelectors, paymentFrameSelectors: safety.paymentFrameSelectors });
  const text = raw.bodyText;
  const has = (patterns: string[], s: string) => patterns.find((p) => new RegExp(p, "i").test(s)) ?? null;
  const captchaText = has(safety.captchaTextPatterns, text);
  const otp = raw.fields.some((f) => f.autocomplete === "one-time-code") || !!has(safety.otpPatterns, text);
  const login = raw.passwordFieldPresent || !!has(safety.loginPatterns, text);
  // Payment: a card/UPI/bank field, a visible gateway frame, or explicit fee/pay-now text. Job descriptions talk
  // about "payments" and "UPI" all the time (Razorpay, Stripe), so text patterns are about paying, not the topic.
  const payField = raw.fields.find((f) => (f.autocomplete ?? "").startsWith("cc-") || !!has(safety.paymentFieldPatterns, `${f.label} ${f.name ?? ""} ${f.id ?? ""}`));
  const payText = has(safety.paymentTextPatterns, text);
  const paymentEvidence = payField ? `payment field '${payField.label || payField.name || payField.id || "?"}'` : raw.paymentFrame ? `payment frame ${raw.paymentFrame}` : payText ? `text /${payText}/` : null;
  return {
    fields: raw.fields,
    buttons: raw.buttons,
    formCount: raw.formCount,
    signals: {
      url: raw.url,
      title: raw.title,
      bodyText: text,
      captchaDetected: !!raw.captchaEvidence || !!captchaText,
      captchaEvidence: raw.captchaEvidence ?? (captchaText ? `text /${captchaText}/` : null),
      captchaDormant: raw.captchaDormant,
      otpDetected: otp,
      loginDetected: login,
      passwordFieldPresent: raw.passwordFieldPresent,
      securityCheckDetected: !!has(safety.securityCheckPatterns, text),
      paymentDetected: paymentEvidence !== null,
      paymentEvidence,
    },
  };
}

/**
 * Narrows a scan to the application form. Pages often carry other forms (newsletter, search, cookie
 * consent). The application form is the one with a resume upload, else the one with the most fields;
 * it only counts as an application form if it has a file upload or at least 3 fields.
 */
export function selectApplicationForm(scan: PageScan): { scan: PageScan; formKey: string | null; isApplication: boolean } {
  const groups = new Map<string, number>();
  for (const f of scan.fields) groups.set(f.formKey, (groups.get(f.formKey) ?? 0) + 1);
  if (groups.size === 0) return { scan, formKey: null, isApplication: false };
  const withResume = scan.fields.find((f) => f.kind === "FILE_UPLOAD" && /resume|cv/i.test(`${f.label} ${f.name ?? ""}`));
  const formKey = withResume?.formKey ?? [...groups.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const fields = scan.fields.filter((f) => f.formKey === formKey);
  const isApplication = fields.some((f) => f.kind === "FILE_UPLOAD") || fields.length >= 3;
  const buttons = scan.buttons.filter((b) => b.formKey === formKey || (formKey === "noform" && !b.inForm) || (b.tag === "a" && !b.inForm));
  return { scan: { ...scan, fields, buttons }, formKey, isApplication };
}

/** Required fields that are still empty after filling, read back from the live DOM. */
export async function emptyRequiredFields(page: Page): Promise<string[]> {
  await ensureShim(page);
  const rescan = await page.evaluate(scanDom, { captchaSelectors: [], paymentFrameSelectors: [] });
  return rescan.fields.filter((f) => f.required && f.visible !== false && !f.currentValue).map((f) => f.label || f.name || f.key);
}
