import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { IntegrationStatus } from "../../agent/core/interfaces.ts";
import { fromRoot } from "../../agent/core/paths.ts";

export interface BrowserSession {
  page: Page;
  close(): Promise<void>;
}

export interface BrowserProvider {
  readonly id: string;
  /** A window the user can see and act in (headed). Only then can the agent wait for them to solve a CAPTCHA or log in. */
  readonly interactive: boolean;
  status(): IntegrationStatus;
  open(): Promise<BrowserSession>;
}

/** The installed Google Chrome, if any (Windows, macOS, Linux standard locations). */
export function findChrome(): string | null {
  const candidates = [
    path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  return candidates.find((c) => c && fs.existsSync(c)) ?? null;
}

/**
 * A persistent profile (runtime/browser-profile) so the user signs in once — to Google via `npm run browser:login`,
 * or to a site — and the session is reused on every run. With channel "chrome" it is the user's installed Google
 * Chrome (Google sign-in works there); otherwise Playwright's Chromium. Never types passwords.
 *
 * This is the agent's own profile, never the user's everyday Chrome profile: Chrome (136+) refuses automation of
 * the default profile, and that profile's cookies are not the agent's to take.
 */
export class PlaywrightBrowserProvider implements BrowserProvider {
  readonly id = "playwright";
  private context: BrowserContext | null = null;
  private readonly inUse = new Set<Page>();

  constructor(private readonly opts: { profileDir: string; headless: boolean; slowMoMs: number; persistent: boolean; channel?: string | undefined }) {}

  get interactive(): boolean {
    return !this.opts.headless;
  }

  status(): IntegrationStatus {
    const where = `${this.opts.persistent ? `persistent profile ${this.opts.profileDir}` : "ephemeral"} headless=${String(this.opts.headless)}`;
    if (this.opts.channel === "chrome") {
      const chrome = findChrome();
      return chrome ? { id: this.id, state: "READY", detail: `Google Chrome (${chrome}) ${where}` } : { id: this.id, state: "NOT_CONFIGURED", detail: "BROWSER_CHANNEL=chrome but Google Chrome is not installed" };
    }
    let exe: string;
    try {
      exe = chromium.executablePath();
    } catch {
      exe = "";
    }
    if (!exe || !fs.existsSync(exe)) return { id: this.id, state: "NOT_CONFIGURED", detail: "Chromium not installed — run: npx playwright install chromium" };
    return { id: this.id, state: "READY", detail: `chromium ${where}` };
  }

  async open(): Promise<BrowserSession> {
    try {
      return await this.openOnce();
    } catch (err) {
      // The user closed the agent's Chrome window: forget the dead browser and start a fresh one (same profile, same sign-ins).
      if (this.opts.persistent && /closed|Target page|has been closed/i.test(err instanceof Error ? err.message : String(err))) {
        this.context = null;
        this.inUse.clear();
        return this.openOnce();
      }
      throw err;
    }
  }

  private async openOnce(): Promise<BrowserSession> {
    if (this.opts.persistent) {
      if (!this.context) {
        const dir = fromRoot(this.opts.profileDir);
        fs.mkdirSync(dir, { recursive: true });
        this.context = await chromium.launchPersistentContext(dir, {
          headless: this.opts.headless,
          slowMo: this.opts.slowMoMs,
          acceptDownloads: false,
          viewport: { width: 1280, height: 900 },
          // Playwright turns Chrome's sandbox off by default ("--no-sandbox … security will suffer"); keep it on.
          chromiumSandbox: true,
          ...(this.opts.channel ? { channel: this.opts.channel } : {}),
        });
        const opened = this.context;
        opened.on("close", () => {
          if (this.context === opened) {
            this.context = null;
            this.inUse.clear();
          }
        });
      }
      const ctx = this.context;
      // Chrome starts with an empty tab. Use it rather than opening a second one, so the window you see is the job.
      const blank = ctx.pages().find((p) => p.url() === "about:blank" && !this.inUse.has(p));
      const page = blank ?? (await ctx.newPage());
      this.inUse.add(page);
      await page.bringToFront().catch(() => undefined);
      return {
        page,
        close: async () => {
          this.inUse.delete(page);
          // Keep the window alive (closing its last tab would close Chrome and drop the session mid-run).
          if (ctx.pages().length > 1) await page.close();
          else await page.goto("about:blank").catch(() => undefined);
        },
      };
    }
    const browser: Browser = await chromium.launch({ headless: this.opts.headless, slowMo: this.opts.slowMoMs });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    return { page, close: async () => browser.close() };
  }

  async shutdown(): Promise<void> {
    await this.context?.close();
    this.context = null;
  }
}
