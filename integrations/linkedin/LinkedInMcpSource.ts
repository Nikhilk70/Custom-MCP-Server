import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { IntegrationStatus } from "../../agent/core/interfaces.ts";
import type { RawJob } from "../../agent/core/schemas.ts";
import { AgentError, errorMessage } from "../../agent/core/errors.ts";
import { fromRoot, paths } from "../../agent/core/paths.ts";

/**
 * LinkedIn job search through the linkedin-jobs MCP server (github.com/administrativetrick/linkedin-mcp), declared in
 * config/mcp-servers.json. It searches LinkedIn's public job listings — no LinkedIn account or password is used.
 * Its one tool, search_linkedin_jobs, answers in text; parseLinkedInResults turns that into jobs.
 */

const ServersSchema = z.object({ servers: z.record(z.string(), z.object({ command: z.string(), args: z.array(z.string()).default([]) })) });

export interface LinkedInSearch {
  keyword: string;
  location: string;
  experienceLevel?: "internship" | "entry level" | "associate" | "senior" | "director" | "executive" | "";
  dateSincePosted?: "past month" | "past week" | "24hr" | "";
  limit?: number;
}

/** "https://in.linkedin.com/jobs/view/frontend-developer-at-giva-4474117454?position=3…" → "4474117454". */
export function linkedInJobId(url: string): string | null {
  return /linkedin\.com\/jobs\/view\/(?:[^/?#]*-)?(\d{6,})/i.exec(url)?.[1] ?? null;
}

export const linkedInJobUrl = (id: string) => `https://www.linkedin.com/jobs/view/${id}/`;

/** "4 days ago" → ISO date, relative to now. */
function postedFrom(ago: string, now: Date): string | null {
  const m = /(\d+)\s*(minute|hour|day|week|month)/i.exec(ago);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const days = unit.startsWith("month") ? n * 30 : unit.startsWith("week") ? n * 7 : unit.startsWith("day") ? n : 0;
  return new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
}

/** Parses the tool's text answer ("1. Title\n   Company: …\n   Location: …\n   Posted: …\n   Apply: url"). */
export function parseLinkedInResults(text: string, now = new Date()): RawJob[] {
  const jobs: RawJob[] = [];
  for (const block of text.split(/\n(?=\d+\.\s)/)) {
    const title = /^\d+\.\s+(.+)$/m.exec(block)?.[1]?.trim();
    const field = (name: string) => new RegExp(`^\\s+${name}:\\s*(.+)$`, "m").exec(block)?.[1]?.trim() ?? "";
    const url = field("Apply");
    const id = linkedInJobId(url);
    if (!title || !id) continue;
    const salary = field("Salary");
    jobs.push({
      source: "linkedin",
      externalJobId: id,
      companyName: field("Company") || "Unknown company",
      companyId: null,
      jobTitle: title,
      location: field("Location"),
      workMode: null,
      experienceRequired: null,
      salary: salary && !/not specified/i.test(salary) ? salary : null,
      postedDate: postedFrom(field("Posted"), now),
      applyUrl: linkedInJobUrl(id),
      jobUrl: linkedInJobUrl(id),
      jdText: null,
      companyDomain: null,
      raw: { linkedin: block.trim() },
    });
  }
  return jobs;
}

export class LinkedInMcpSource {
  readonly id = "linkedin:mcp";
  private readonly server: { command: string; args: string[] } | null;

  constructor(private readonly opts: { enabled: boolean; mcpServer: string }) {
    this.server = null;
    try {
      const cfg = ServersSchema.parse(JSON.parse(fs.readFileSync(paths.config("mcp-servers.json"), "utf8")));
      const s = cfg.servers[opts.mcpServer];
      // Script paths are relative to the project root, so the config works wherever the project is.
      if (s) this.server = { command: s.command, args: s.args.map((a) => (/\.(c|m)?js$/.test(a) && !path.isAbsolute(a) ? fromRoot(a) : a)) };
    } catch {
      this.server = null;
    }
  }

  status(): IntegrationStatus {
    if (!this.opts.enabled) return { id: this.id, state: "DISABLED", detail: "sources.linkedin.enabled is false" };
    if (!this.server) return { id: this.id, state: "NOT_CONFIGURED", detail: `MCP server '${this.opts.mcpServer}' is not in config/mcp-servers.json` };
    const script = this.server.args.find((a) => /\.(c|m)?js$/.test(a));
    if (script && !fs.existsSync(script)) return { id: this.id, state: "NOT_CONFIGURED", detail: `${script} not found — clone and build github.com/administrativetrick/linkedin-mcp there` };
    return { id: this.id, state: "READY", detail: `MCP '${this.opts.mcpServer}' (search_linkedin_jobs)` };
  }

  /** Runs several searches over one MCP connection. A failed search is reported, the others still run. */
  async search(searches: LinkedInSearch[], onSearch?: (s: LinkedInSearch, i: number) => void): Promise<{ jobs: RawJob[]; errors: string[]; searches: number }> {
    if (this.status().state !== "READY" || !this.server) throw new AgentError("NOT_CONFIGURED", this.status().detail);
    const client = new Client({ name: "applypilot", version: "0.1.0" });
    await client.connect(new StdioClientTransport({ command: this.server.command, args: this.server.args, stderr: "pipe" }));
    const jobs: RawJob[] = [];
    const errors: string[] = [];
    try {
      for (const [i, s] of searches.entries()) {
        onSearch?.(s, i);
        try {
          const r = (await client.callTool({
            name: "search_linkedin_jobs",
            arguments: { keyword: s.keyword, location: s.location, experienceLevel: s.experienceLevel ?? "", dateSincePosted: s.dateSincePosted ?? "past week", limit: String(s.limit ?? 25), sortBy: "recent", page: "0" },
          })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
          const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
          if (r.isError) errors.push(`${s.keyword} in ${s.location}: ${text.split("\n")[0]}`);
          else jobs.push(...parseLinkedInResults(text));
        } catch (err) {
          errors.push(`${s.keyword} in ${s.location}: ${errorMessage(err)}`);
        }
      }
    } finally {
      await client.close().catch(() => undefined);
    }
    const seen = new Set<string>();
    return { jobs: jobs.filter((j) => (seen.has(j.externalJobId!) ? false : (seen.add(j.externalJobId!), true))), errors, searches: searches.length };
  }
}
