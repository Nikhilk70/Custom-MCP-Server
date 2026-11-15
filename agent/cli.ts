import { AgentError, errorMessage } from "./core/errors.ts";
import { fromRoot } from "./core/paths.ts";
import { approveTemplate } from "./resume/templateGuard.ts";

/** One-time setup commands. Everything else (sync the sheet, tailor resumes, apply) is done from the web app. */
const HELP = `ApplyPilot setup commands:
  sheets:auth        OAuth consent for Google Sheets (OAuth client credentials)
  browser:login      open the agent's Chrome profile so you can sign in to Google once (kept for all runs)
  template:approve   accept the current master.tex as the resume template baseline
Run the app with: npm start  (then open http://127.0.0.1:4317)`;

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);
  if (command === "help" || command === "--help") return void console.log(HELP);
  if (command === "sheets:auth") {
    const { runSheetsOAuth } = await import("../scripts/google-auth.ts");
    return runSheetsOAuth();
  }
  if (command === "browser:login") {
    // Plain Chrome on the agent's own profile — no automation attached — so Google treats it as a normal browser.
    // You sign in (password, 2-step verification) yourself; the agent never sees any of it.
    const { loadConfig } = await import("./core/config.ts");
    const { findChrome } = await import("../integrations/playwright/PlaywrightBrowserProvider.ts");
    const { spawn } = await import("node:child_process");
    const chrome = findChrome();
    if (!chrome) throw new AgentError("NOT_CONFIGURED", "Google Chrome is not installed");
    const cfg = loadConfig();
    const dir = fromRoot(cfg.application.browser.profileDir);
    const account = cfg.env.GOOGLE_SIGNIN_ACCOUNT ?? "the Google account you apply with";
    console.log(`Opening Chrome with the agent's profile (${dir}).\nSign in to Google as ${account} and to LinkedIn (two tabs), then close that Chrome window. The session is kept for every future run.`);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(chrome, [`--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "https://accounts.google.com/", "https://www.linkedin.com/login"], { stdio: "ignore" });
      p.on("error", reject);
      p.on("exit", () => resolve());
    });
    return void console.log("Chrome closed. The sign-in is kept for every application run.");
  }
  if (command === "template:approve") {
    const { loadConfig } = await import("./core/config.ts");
    const note = rest.find((a) => a.startsWith("--note="))?.slice(7) ?? "approved via CLI";
    const info = approveTemplate(fromRoot(loadConfig().resume.templatePath), note);
    return void console.log(JSON.stringify({ approved: info.sha256, version: info.version }, null, 2));
  }
  throw new AgentError("VALIDATION_FAILED", `unknown command '${command}'\n\n${HELP}`);
}

main().catch((err: unknown) => {
  console.error(errorMessage(err));
  process.exitCode = 1;
});
