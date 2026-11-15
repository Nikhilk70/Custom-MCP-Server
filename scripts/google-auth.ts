/**
 * One-time Google OAuth consent for Sheets (OAuth "Desktop app" client JSON at GOOGLE_SHEETS_CREDENTIALS_PATH).
 * Starts a loopback server on 127.0.0.1, opens the consent URL, and stores the token at GOOGLE_SHEETS_TOKEN_PATH.
 * Not needed for service-account credentials (share the sheet with the service account email instead).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { google } from "googleapis";
import { z } from "zod";
import { loadEnv } from "../agent/core/env.ts";
import { fromRoot } from "../agent/core/paths.ts";
import { SHEETS_SCOPES } from "../integrations/google-sheets/GoogleSheetsAdapter.ts";

const Client = z.object({ installed: z.object({ client_id: z.string(), client_secret: z.string() }).optional(), web: z.object({ client_id: z.string(), client_secret: z.string() }).optional() });

export async function runSheetsOAuth(): Promise<void> {
  const env = loadEnv();
  if (!env.GOOGLE_SHEETS_CREDENTIALS_PATH || !env.GOOGLE_SHEETS_TOKEN_PATH) throw new Error("set GOOGLE_SHEETS_CREDENTIALS_PATH and GOOGLE_SHEETS_TOKEN_PATH in .env");
  const credFile = fromRoot(env.GOOGLE_SHEETS_CREDENTIALS_PATH);
  if (!fs.existsSync(credFile)) throw new Error(`OAuth client file not found: ${credFile}. Create a Desktop OAuth client in Google Cloud Console and download its JSON there.`);
  const parsed = Client.parse(JSON.parse(fs.readFileSync(credFile, "utf8")));
  const c = parsed.installed ?? parsed.web;
  if (!c) throw new Error("credentials JSON is not an OAuth client (expected 'installed' or 'web')");

  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const redirect = `http://127.0.0.1:${port}/callback`;
  const oauth = new google.auth.OAuth2(c.client_id, c.client_secret, redirect);
  const url = oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SHEETS_SCOPES });
  console.log(`Open this URL in your browser and approve access:\n\n${url}\n`);

  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", redirect);
      const got = u.searchParams.get("code");
      res.end(got ? "Authorized. You can close this tab." : "Missing code.");
      if (got) resolve(got);
      else reject(new Error(u.searchParams.get("error") ?? "no code"));
    });
  });
  server.close();
  const { tokens } = await oauth.getToken(code);
  const tokenFile = fromRoot(env.GOOGLE_SHEETS_TOKEN_PATH);
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  console.log(`Token saved to ${env.GOOGLE_SHEETS_TOKEN_PATH}`);
}
