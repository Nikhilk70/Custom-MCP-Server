import type { Page } from "playwright";

export type LinkedInApply = { kind: "external"; url: string } | { kind: "easy-apply" } | { kind: "signed-out" } | { kind: "closed" } | { kind: "unknown"; detail: string };

export const isLinkedInJobPage = (url: string) => /linkedin\.com\/jobs\/view\//i.test(url);

/** A web address outside LinkedIn (the company's own application site). */
const external = (u: string) => {
  try {
    return /^https?:/.test(u) && !/(^|\.)linkedin\.com$/i.test(new URL(u).hostname);
  } catch {
    return false;
  }
};

/**
 * On a LinkedIn job page (in the agent's own Chrome, signed in to LinkedIn), finds where the application really
 * happens: follows "Apply" and returns the company's application URL. Easy Apply (LinkedIn's own multi-step form) and
 * a signed-out page are reported instead — nothing is clicked for those, nothing is submitted.
 */
export async function resolveLinkedInApply(page: Page, timeoutMs = 20000): Promise<LinkedInApply> {
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  // Found by what you see — a button or link labelled "Apply" / "Easy Apply" — since LinkedIn changes its markup
  // often; the older class names are kept as a fallback.
  const applyLabel = /^\s*(easy apply|apply)\b/i;
  const btn = page
    .getByRole("button", { name: applyLabel })
    .or(page.getByRole("link", { name: applyLabel }))
    .or(page.locator("button.jobs-apply-button, button#jobs-apply-button-id, a.jobs-apply-button"))
    .filter({ visible: true }) // LinkedIn also keeps hidden copies (e.g. a sticky header); only the visible one counts
    .first();
  try {
    await btn.waitFor({ state: "visible", timeout: 15000 });
  } catch {
    const text = (await page.textContent("body").catch(() => "")) ?? "";
    if (/no longer accepting applications|this job is closed/i.test(text)) return { kind: "closed" };
    // The public (signed-out) page shows "Sign in to apply" instead of the member Apply button.
    if (/sign in to apply|join now|agree & join/i.test(text)) return { kind: "signed-out" };
    return { kind: "unknown", detail: "no Apply button on the LinkedIn page" };
  }
  const label = ((await btn.innerText().catch(() => "")) || (await btn.getAttribute("aria-label").catch(() => "")) || "").trim();
  if (/easy apply/i.test(label)) return { kind: "easy-apply" };

  // A plain link to the company's site needs no click.
  const href = await btn.getAttribute("href").catch(() => null);
  if (href && external(href)) return { kind: "external", url: href };

  // "Apply" opens the company's site in a new tab (sometimes after a "Continue" / share-profile dialog).
  const popup = page.context().waitForEvent("page", { timeout: timeoutMs }).catch(() => null);
  await btn.click();
  const cont = page.getByRole("button", { name: /^continue( applying)?$/i }).first();
  if (await cont.isVisible({ timeout: 2500 }).catch(() => false)) await cont.click().catch(() => undefined);
  const tab = await popup;
  if (tab) {
    // LinkedIn may pass through its own redirect page first; wait until the company's site is reached.
    await tab.waitForURL((u) => external(u.toString()), { timeout: timeoutMs }).catch(() => undefined);
    const url = tab.url();
    await tab.close().catch(() => undefined);
    if (external(url)) return { kind: "external", url };
  }
  // Same-tab navigation.
  await page.waitForURL((u) => external(u.toString()), { timeout: 5000 }).catch(() => undefined);
  if (external(page.url())) return { kind: "external", url: page.url() };
  return { kind: "unknown", detail: `clicked "${label || "Apply"}" but LinkedIn opened no company page` };
}
