import { spawn } from "node:child_process";
import { startApp } from "./app.ts";

/**
 * ApplyPilot — local web control center for the job application agent.
 *   npm start   → http://127.0.0.1:4317 (your Google Sheet)
 *   --port 5000, --no-open
 */
function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? "") : null;
}

async function main(): Promise<void> {
  const demo = false;
  const port = Number(arg("port") ?? process.env.APPLYPILOT_PORT ?? 4317);
  const app = await startApp({ port, demo });
  console.log(`\n  ApplyPilot is running at ${app.url}\n  Every run is a DRY RUN until you arm live mode in Settings. Ctrl+C to stop.\n`);
  if (!process.argv.includes("--no-open") && process.platform === "win32") spawn("cmd", ["/c", "start", "", app.url], { stdio: "ignore", detached: true }).unref();
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    console.log("\n  Stopping ApplyPilot safely…");
    void app.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err: unknown) => {
  console.error(`ApplyPilot failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
