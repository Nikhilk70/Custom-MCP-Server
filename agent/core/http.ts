import { AgentError, toAgentError } from "./errors.ts";

export interface HttpClient {
  getJson(url: string, opts?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<unknown>;
  postJson(url: string, body: unknown, opts?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<unknown>;
}

const USER_AGENT = "auto-job-agent/0.1 (+personal job search; respects robots and rate limits)";

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw toAgentError(err, "NETWORK_ERROR");
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new AgentError("AUTH_REQUIRED", `HTTP ${res.status} from ${new URL(url).host}`, { details: { status: res.status } });
  if (res.status === 404) throw new AgentError("SOURCE_UNAVAILABLE", `HTTP 404 from ${new URL(url).host}${new URL(url).pathname}`, { details: { status: 404 } });
  if (res.status === 429) throw new AgentError("RATE_LIMITED", `HTTP 429 from ${new URL(url).host}`);
  if (res.status >= 500) throw new AgentError("NETWORK_ERROR", `HTTP ${res.status} from ${new URL(url).host}`, { details: { status: res.status } });
  if (!res.ok) throw new AgentError("SOURCE_UNAVAILABLE", `HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 200)}`, { details: { status: res.status } });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AgentError("PARSER_FAILED", `Non-JSON response from ${new URL(url).host}`, { retryable: false });
  }
}

export const fetchHttpClient: HttpClient = {
  getJson: (url, opts = {}) =>
    request(url, { method: "GET", headers: { "user-agent": USER_AGENT, accept: "application/json", ...opts.headers } }, opts.timeoutMs ?? 20000),
  postJson: (url, body, opts = {}) =>
    request(
      url,
      { method: "POST", headers: { "user-agent": USER_AGENT, "content-type": "application/json", accept: "application/json", ...opts.headers }, body: JSON.stringify(body) },
      opts.timeoutMs ?? 30000,
    ),
};
