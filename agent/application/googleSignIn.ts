import type { Page } from "playwright";

/**
 * "Sign in with Google" on a career site / ATS, using the Google session already present in the agent's persistent
 * Chrome profile (the user signs in to Google there once, by hand: `npm run browser:login`).
 *
 * The agent only clicks: the site's own Google button, the configured account in Google's account chooser, and
 * "Continue" on a basic sign-in confirmation (name, email, language, profile picture). It never types into a
 * Google page. Password, 2-step verification, "verify it's you", recovery, an account chooser without the configured
 * account, or a consent screen asking for more than basic profile data → the user takes over (waited for when a
 * browser window is visible). Success is only claimed after the site itself no longer asks for a login.
 */

export interface GoogleSignInOptions {
  /** The account to use; must match exactly what Google shows. */
  email: string;
  canWait: boolean;
  timeoutMs: number;
  pollMs: number;
  /** Google's pages. Overridable so tests can use local fixtures. */
  googleUrl?: RegExp;
  /** Waiting notice for the user (logger). */
  notify: (message: string) => void;
}

export type GoogleSignInResult =
  | { status: "NOT_AVAILABLE" }
  | { status: "RETURNED"; steps: string[] } // back on the site; the caller verifies the site is now authenticated
  | { status: "NEEDS_USER"; reason: string; steps: string[] };

const GOOGLE_BUTTON = /^(sign in|sign up|log in|login|continue|register|apply) (with|using|via) google$/i;
const RISKY_SCOPES = /\b(drive|gmail|calendar|contacts|youtube|photos|see, edit|edit, create|create, edit|delete|manage your|send email|read, compose|view and manage)\b/i;
const BASIC_SHARE = /(name|email address|profile picture|language preference)/i;

/** Finds the site's own Google button (a normal button/link, or Google's GSI button iframe) and clicks it. */
async function clickGoogleButton(page: Page): Promise<boolean> {
  const byRole = page.getByRole("button", { name: GOOGLE_BUTTON }).or(page.getByRole("link", { name: GOOGLE_BUTTON }));
  if ((await byRole.count()) > 0) {
    await byRole.first().click();
    return true;
  }
  const byText = page.locator("button, a, [role=button]").filter({ hasText: GOOGLE_BUTTON });
  if ((await byText.count()) > 0) {
    await byText.first().click();
    return true;
  }
  const gsi = page.locator("iframe[src*='accounts.google.com/gsi/button']");
  if ((await gsi.count()) > 0) {
    await page.frameLocator("iframe[src*='accounts.google.com/gsi/button']").locator("[role=button]").first().click();
    return true;
  }
  return false;
}

type GoogleState =
  | { kind: "CHOOSER"; accounts: string[] }
  | { kind: "BASIC_CONSENT" }
  | { kind: "USER_NEEDED"; why: string };

async function readGoogleState(g: Page, email: string): Promise<GoogleState> {
  return g.evaluate(
    (arg: { email: string; risky: string; basic: string }) => {
      const text = (document.body?.innerText ?? "").replace(/\s+/g, " ");
      const shown = (e: Element) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
      };
      if ([...document.querySelectorAll("input[type=password]")].some(shown)) return { kind: "USER_NEEDED" as const, why: "Google is asking for the password" };
      if (/2-step verification|verify (it'?s|it is) you|confirm (it'?s|it is) you|security challenge|suspicious|recover(y| your account)|enter the code|get a verification code|use your phone|tap yes/i.test(text) || /\/challenge\//.test(location.pathname))
        return { kind: "USER_NEEDED" as const, why: "Google is asking for a verification step" };
      if ([...document.querySelectorAll("input[type=email], input[name=identifier]")].some(shown)) return { kind: "USER_NEEDED" as const, why: "Google is asking which account to sign in with (no signed-in session in this profile)" };
      const accounts = [...document.querySelectorAll("[data-identifier], [data-email]")].map((e) => (e.getAttribute("data-identifier") ?? e.getAttribute("data-email") ?? "").trim().toLowerCase()).filter(Boolean);
      if (accounts.length) return { kind: "CHOOSER" as const, accounts };
      const asksAccess = /wants (to )?access your google account|wants additional access|grant .{1,60} access/i.test(text);
      if (asksAccess || new RegExp(arg.risky, "i").test(text)) return { kind: "USER_NEEDED" as const, why: "the site asks for Google permissions beyond basic sign-in; approve or deny them yourself" };
      const hasContinue = [...document.querySelectorAll("button, [role=button]")].some((b) => /^continue$/i.test((b.textContent ?? "").trim()) && shown(b));
      if (hasContinue && new RegExp(arg.basic, "i").test(text)) return { kind: "BASIC_CONSENT" as const };
      return { kind: "USER_NEEDED" as const, why: `unrecognised Google step at ${location.hostname}${location.pathname}` };
    },
    { email, risky: RISKY_SCOPES.source, basic: BASIC_SHARE.source },
  );
}

export async function googleSignIn(page: Page, o: GoogleSignInOptions): Promise<GoogleSignInResult> {
  const isGoogle = (p: Page) => !p.isClosed() && (o.googleUrl ?? /^https:\/\/accounts\.google\.com\//).test(p.url());
  const steps: string[] = [];
  const popupP = page.context().waitForEvent("page", { timeout: 8000 }).catch(() => null);
  if (!(await clickGoogleButton(page))) return { status: "NOT_AVAILABLE" };
  steps.push("clicked the site's Google sign-in button");
  const popup = await Promise.race([popupP, page.waitForURL(o.googleUrl ?? /accounts\.google\.com/, { timeout: 8000 }).then(() => null).catch(() => null)]);
  const g = popup ?? page;
  await g.waitForLoadState("domcontentloaded").catch(() => undefined);

  for (let i = 0; i < 8 && isGoogle(g); i++) {
    await g.waitForTimeout(800);
    const state = await readGoogleState(g, o.email).catch(() => null);
    if (!state) continue; // navigating
    if (state.kind === "CHOOSER") {
      const want = o.email.trim().toLowerCase();
      if (!state.accounts.includes(want)) {
        const r = await handOver(g, o, `Google's account chooser shows ${state.accounts.join(", ") || "no accounts"}, not ${o.email}; choose the account yourself or sign in to it`, steps);
        if (r) return r;
        continue;
      }
      await g.locator(`[data-identifier="${want}" i], [data-email="${want}" i]`).first().click();
      steps.push(`chose ${o.email} in Google's account chooser`);
      continue;
    }
    if (state.kind === "BASIC_CONSENT") {
      await g.getByRole("button", { name: /^continue$/i }).first().click();
      steps.push("confirmed Google's basic sign-in (name, email, profile picture only)");
      continue;
    }
    const r = await handOver(g, o, state.why, steps);
    if (r) return r;
  }
  if (isGoogle(g)) return { status: "NEEDS_USER", reason: "Google sign-in did not finish", steps };
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  return { status: "RETURNED", steps };
}

/** Wait for the user to finish a Google step themselves; null when they did (continue), else the stop result. */
async function handOver(g: Page, o: GoogleSignInOptions, why: string, steps: string[]): Promise<GoogleSignInResult | null> {
  if (!o.canWait) return { status: "NEEDS_USER", reason: `Google sign-in: ${why}`, steps };
  o.notify(`WAITING FOR YOU in the Google window: ${why}. Nothing will be typed for you; the application continues once Google is done (up to ${Math.round(o.timeoutMs / 60000)} min).`);
  const start = g.url();
  const until = Date.now() + o.timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, o.pollMs));
    if (g.isClosed() || g.url() !== start) {
      steps.push(`you completed: ${why}`);
      return null;
    }
  }
  return { status: "NEEDS_USER", reason: `Google sign-in: ${why} — not completed within ${Math.round(o.timeoutMs / 60000)} min`, steps };
}
