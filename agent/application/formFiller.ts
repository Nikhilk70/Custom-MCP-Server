import path from "node:path";
import type { Locator, Page } from "playwright";
import type { FieldPlan } from "./fieldClassifier.ts";
import { chooseOption } from "../questions/questionBank.ts";

export interface FillOutcome {
  label: string;
  action: FieldPlan["action"];
  ok: boolean;
  selector: string;
  detail: string;
}

/** Prefer the accessible label when it resolves to exactly this one element; fall back to the tagged node. */
async function locate(page: Page, plan: FieldPlan): Promise<{ loc: Locator; selector: string }> {
  const f = plan.field;
  if (f.label && !f.key.startsWith("group:")) {
    const byLabel = page.getByLabel(f.label, { exact: true });
    if ((await byLabel.count()) === 1 && (await byLabel.getAttribute("data-aja-id")) === f.key) return { loc: byLabel, selector: `label="${f.label}"` };
  }
  if (f.id && !f.key.startsWith("group:")) {
    const byId = page.locator(`[id="${f.id.replace(/"/g, '\\"')}"]`);
    if ((await byId.count()) === 1) return { loc: byId, selector: `#${f.id}` };
  }
  return { loc: page.locator(`[data-aja-id="${f.key}"]`), selector: `[data-aja-id=${f.key}]` };
}

/**
 * What is typed into the field. A number-only box (<input type=number>, e.g. "Notice period: e.g. 45") rejects
 * "15 days", so it gets the number from your answer: "15 days" → "15", "1.5 years" → "1.5", "Immediate" → "0".
 */
export function typedValue(kind: string, answer: string): string {
  if (kind !== "NUMBER") return answer;
  if (/^\s*-?\d+(\.\d+)?\s*$/.test(answer)) return answer.trim();
  if (/\b(immediate(ly)?|none|nil|zero)\b/i.test(answer)) return "0";
  return /-?\d+(\.\d+)?/.exec(answer)?.[0] ?? answer;
}

async function fillOne(page: Page, plan: FieldPlan, resumePdf: string | null): Promise<FillOutcome> {
  const f = plan.field;
  const base = { label: f.label, action: plan.action };
  if (plan.action === "UPLOAD_RESUME") {
    if (!resumePdf) return { ...base, ok: false, selector: "", detail: "no resume PDF" };
    const { loc, selector } = await locate(page, plan);
    await loc.setInputFiles(resumePdf);
    // Upload widgets (Lever, Greenhouse) re-render around the input and parse the file, so check the page
    // rather than the original node: a file input holding the file, or the file name shown on the page.
    const name = path.basename(resumePdf);
    const attached = await page
      .waitForFunction(
        (n) =>
          Array.from(document.querySelectorAll<HTMLInputElement>("input[type=file]")).some((i) => i.files?.[0]?.name === n) ||
          (document.body.innerText || "").toLowerCase().includes(n.toLowerCase()),
        name,
        { timeout: 10_000 },
      )
      .then(() => true)
      .catch(() => false);
    return { ...base, ok: attached, selector, detail: attached ? `attached ${name}` : "file not shown as attached" };
  }
  if (plan.action !== "FILL" || plan.answer === null) return { ...base, ok: true, selector: "", detail: `not filled (${plan.action})` };
  const answer = typedValue(f.kind, plan.answer);

  if (f.key.startsWith("group:")) {
    const radios = page.locator(`input[name="${(f.name ?? "").replace(/"/g, '\\"')}"]`);
    const count = await radios.count();
    // A lone checkbox ("I consent …") is answered Yes/No: tick or untick it, then read the state back.
    if (f.kind === "CHECKBOX" && count === 1 && /^(yes|true|no|false)$/i.test(answer)) {
      const want = /^(yes|true)$/i.test(answer);
      const box = radios.first();
      if (want) await box.check();
      else await box.uncheck();
      return { ...base, ok: (await box.isChecked()) === want, selector: `input[name=${f.name ?? ""}]`, detail: `checkbox ${want ? "ticked" : "left unticked"}` };
    }
    // Read each option's text the way the detector did: aria-labelledby, aria-label, <label for>, a wrapping <label>
    // ("<label><input type=radio> Yes</label>", the most common markup), or the text right after the input.
    const norm = (s: string) => s.replace(/[✱*]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    for (let i = 0; i < count; i++) {
      const r = radios.nth(i);
      const texts = await r.evaluate((el) => {
        const input = el as HTMLInputElement;
        const out: string[] = [];
        const lb = input.getAttribute("aria-labelledby");
        if (lb) out.push(lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
        out.push(input.getAttribute("aria-label") ?? "");
        if (input.id) out.push(document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent ?? "");
        out.push(input.closest("label")?.textContent ?? "");
        out.push(input.nextSibling?.textContent ?? "");
        return out;
      });
      if (texts.some((t) => t.trim() && norm(t) === norm(answer))) {
        await r.check();
        return { ...base, ok: await r.isChecked(), selector: `input[name=${f.name ?? ""}] "${answer}"`, detail: `selected '${answer}'` };
      }
    }
    return { ...base, ok: false, selector: `input[name=${f.name ?? ""}]`, detail: `option '${answer}' not found` };
  }

  const { loc, selector } = await locate(page, plan);
  switch (f.kind) {
    case "COMBOBOX":
      return { ...base, selector, ...(await fillCombobox(page, f.key, answer)) };
    case "DROPDOWN":
      await loc.selectOption({ label: answer });
      break;
    case "CHECKBOX":
      if (/^(yes|true)$/i.test(answer)) await loc.check();
      else if (/^(no|false)$/i.test(answer)) await loc.uncheck();
      else return { ...base, ok: false, selector, detail: `checkbox answer '${answer}' is not boolean` };
      return { ...base, ok: true, selector, detail: `checkbox set ${answer}` };
    default:
      await loc.fill(answer);
  }
  const value = f.kind === "DROPDOWN" ? await loc.evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.text.trim() ?? "") : await loc.inputValue();
  if (value === answer) return { ...base, ok: true, selector, detail: "value verified" };
  // Phone widgets reformat the number ("9876543210" → "98765 43210"): the same digits are the same number.
  const digits = (s: string) => s.replace(/\D+/g, "");
  if (/^[\d\s()+-]{7,}$/.test(answer) && digits(value).length >= 7 && digits(value) === digits(answer)) {
    return { ...base, ok: true, selector, detail: `value verified (the site formatted it as '${value}')` };
  }
  return { ...base, ok: false, selector, detail: `read back '${value}'` };
}

export async function fillForm(page: Page, plans: FieldPlan[], resumePdf: string | null): Promise<FillOutcome[]> {
  const out: FillOutcome[] = [];
  for (const p of plans) {
    if (p.action !== "FILL" && p.action !== "UPLOAD_RESUME") continue;
    try {
      out.push(await fillOne(page, p, resumePdf));
    } catch (err) {
      out.push({ label: p.field.label, action: p.action, ok: false, selector: "", detail: err instanceof Error ? err.message.split("\n")[0] ?? "error" : String(err) });
    }
  }
  await reverify(page, plans, out);
  return out;
}

/**
 * Pages can change a value after it was typed: autocompletes clear text that wasn't picked from their list on
 * blur, and resume parsers fill fields asynchronously. Re-read every text value once the page has settled.
 */
async function reverify(page: Page, plans: FieldPlan[], out: FillOutcome[]): Promise<void> {
  // Leave the last field the way a user would before submitting, so blur handlers run.
  await page.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur()").catch(() => undefined);
  await page.waitForTimeout(1500);
  for (const o of out) {
    const p = plans.find((x) => x.field.label === o.label && x.action === o.action);
    if (!o.ok || !p || p.action !== "FILL" || p.answer === null || p.field.key.startsWith("group:") || !["TEXT", "TEXTAREA", "NUMBER", "DATE"].includes(p.field.kind)) continue;
    const now = await page
      .locator(`[data-aja-id="${p.field.key}"]`)
      .inputValue({ timeout: 2000 })
      .catch(() => null);
    const d = (s: string) => s.replace(/\D+/g, "");
    const expected = typedValue(p.field.kind, p.answer);
    if (now === expected || (now !== null && /^[\d\s()+-]{7,}$/.test(expected) && d(now).length >= 7 && d(now) === d(expected))) continue;
    if (now === "") {
      const picked = await pickSuggestion(page, p.field.key, p.answer);
      if (picked.ok) {
        o.detail = `picked '${picked.value}' from the site's list`;
        continue;
      }
      if (!p.field.required) {
        o.detail = `left empty: the page cleared the typed value and ${picked.detail}`;
        continue;
      }
      o.ok = false;
      o.detail = `the page cleared the typed value and ${picked.detail}`;
      continue;
    }
    o.ok = false;
    o.detail = `changed after fill: now '${now ?? "?"}'`;
  }
}

/** Visible options of the list a combobox controls (aria-controls/aria-owns), else any visible [role=option]. */
const listOptions = (arg: { key: string }): string[] => {
  const input = document.querySelector(`[data-aja-id="${arg.key}"]`);
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const ids = `${input?.getAttribute("aria-controls") ?? ""} ${input?.getAttribute("aria-owns") ?? ""}`.trim().split(/\s+/).filter(Boolean);
  const lists = ids.map((id) => document.getElementById(id)).filter((x): x is HTMLElement => !!x);
  const opts = (lists.length ? lists.flatMap((l) => [...l.querySelectorAll("[role=option]")]) : [...document.querySelectorAll("[role=option]")]).filter(shown);
  opts.forEach((o, i) => o.setAttribute("data-aja-opt", String(i)));
  return opts.map((o) => (o.textContent ?? "").replace(/\s+/g, " ").trim());
};

/**
 * Custom dropdowns keep only a value picked from their own list; typed text is not an answer. Type to filter,
 * choose the one option matching the verified answer (same conservative rules as native selects), click it, then
 * confirm the widget displays it. If no option matches, leave it empty and report — never pick a near miss.
 */
async function fillCombobox(page: Page, key: string, answer: string): Promise<{ ok: boolean; detail: string }> {
  const input = page.locator(`[data-aja-id="${key}"]`).first();
  const read = async () => {
    for (let t = 0; t < 12; t++) {
      await page.waitForTimeout(250);
      const o = await page.evaluate(listOptions, { key }).catch(() => [] as string[]);
      if (o.length) return o;
    }
    return [] as string[];
  };
  await input.click();
  await input.pressSequentially(answer, { delay: 30 });
  let options = await read();
  let choice = chooseOption(options, answer);
  if (!choice) {
    // Some lists don't filter by typing (or filter too hard): open the full list and look again.
    await input.fill("");
    await input.press("ArrowDown").catch(() => undefined);
    options = await read();
    choice = chooseOption(options, answer);
  }
  if (!choice) {
    await input.press("Escape").catch(() => undefined);
    await input.fill("").catch(() => undefined);
    return { ok: false, detail: `no option matches '${answer}'${options.length ? ` (options: ${options.slice(0, 8).join(" | ")})` : " (list did not open)"}` };
  }
  await page.locator(`[data-aja-opt="${options.indexOf(choice)}"]`).first().click();
  await page.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur()").catch(() => undefined);
  await page.waitForTimeout(400);
  const shows = await page.evaluate(
    (arg: { key: string; choice: string }) => {
      let a = document.querySelector(`[data-aja-id="${arg.key}"]`)?.parentElement ?? null;
      for (let i = 0; a && i < 4; i++, a = a.parentElement) {
        const v = a.querySelector("[class*='single-value'], [class*='singleValue'], [class*='multi-value__label'], [class*='multiValueLabel']");
        const text = (v?.textContent ?? a.innerText).replace(/\s+/g, " ").trim();
        if (text.includes(arg.choice)) return text;
      }
      const own = document.querySelector<HTMLInputElement>(`[data-aja-id="${arg.key}"]`)?.value ?? "";
      return own.includes(arg.choice) ? own : null;
    },
    { key, choice },
  );
  if (shows) return { ok: true, detail: `selected '${choice}' (page shows '${shows.slice(0, 80)}')` };
  // Compact widgets show part of the option (a phone-country picker shows a flag and "+91" for "India +91"). That
  // only proves the selection when no other option contains the same part ("+1" is both US and Canada).
  const displayed = await page.evaluate(
    (k: string) => {
      let a = document.querySelector(`[data-aja-id="${k}"]`)?.parentElement ?? null;
      for (let i = 0; a && i < 4; i++, a = a.parentElement) {
        const v = a.querySelector("[class*='single-value'], [class*='singleValue']");
        if (v) return (v.textContent ?? "").replace(/\s+/g, " ").trim();
      }
      return "";
    },
    key,
  );
  const unique = displayed.length >= 2 && choice.includes(displayed) && options.filter((o) => o.includes(displayed)).length === 1;
  return unique
    ? { ok: true, detail: `selected '${choice}' (page shows '${displayed}', which only '${choice}' contains)` }
    : { ok: false, detail: `clicked '${choice}' but the page shows '${displayed || "nothing"}', which does not prove it was selected` };
}

/**
 * Autocomplete inputs (Lever location, Google Places) only keep a value picked from their list. Type the answer
 * like a user, then click the one option whose first comma-separated part is exactly the answer
 * ("Bengaluru" → "Bengaluru, Bengaluru Urban, Karnataka, IND"). Anything else stays empty for a human.
 */
async function pickSuggestion(page: Page, key: string, answer: string): Promise<{ ok: boolean; value: string; detail: string }> {
  const input = page.locator(`[data-aja-id="${key}"]`).first();
  await input.click();
  await input.fill("");
  await input.pressSequentially(answer, { delay: 40 });
  const find = (arg: { key: string; answer: string }) => {
    const norm = (s: string) => s.normalize("NFKC").trim().toLowerCase();
    const el = document.querySelector(`[data-aja-id="${arg.key}"]`);
    const shown = (e: Element) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const scopes: Element[] = [...document.querySelectorAll("[role=listbox]")];
    let a = el?.parentElement ?? null;
    for (let i = 0; a && i < 4; i++, a = a.parentElement) scopes.push(a);
    const seen = new Set<Element>();
    const hits: Element[] = [];
    for (const scope of scopes) {
      for (const c of scope.querySelectorAll("[role=option], li, div, span")) {
        if (seen.has(c) || c === el || c.contains(el)) continue;
        seen.add(c);
        const text = (c.textContent ?? "").trim();
        if (!text || text.length > 150 || !shown(c)) continue;
        if (norm(text.split(",")[0] ?? "") !== norm(arg.answer)) continue;
        if ([...c.children].some((ch) => norm((ch.textContent ?? "").split(",")[0] ?? "") === norm(arg.answer))) continue; // prefer the innermost
        hits.push(c);
      }
    }
    hits.forEach((h, i) => h.setAttribute("data-aja-opt", String(i)));
    return hits.map((h) => (h.textContent ?? "").trim());
  };
  let options: string[] = [];
  for (let t = 0; t < 15 && !options.length; t++) {
    await page.waitForTimeout(200);
    options = await page.evaluate(find, { key, answer }).catch(() => []);
  }
  if (!options.length) {
    await input.fill("");
    return { ok: false, value: "", detail: `no list option starts with '${answer}'` };
  }
  await page.locator('[data-aja-opt="0"]').first().click();
  await page.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur()").catch(() => undefined);
  await page.waitForTimeout(800);
  const value = await input.inputValue().catch(() => "");
  const first = value.split(",")[0]?.trim().toLowerCase() ?? "";
  return first === answer.trim().toLowerCase() ? { ok: true, value, detail: "picked" } : { ok: false, value, detail: `picked option did not stick (value now '${value}')` };
}
