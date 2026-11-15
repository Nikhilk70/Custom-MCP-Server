import { toAgentError, type AgentError, type ErrorCode } from "./errors.ts";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** Bounded retry budgets per error class. CAPTCHA/OTP/auth/unknown-question never retry. */
export const RETRY_POLICIES: Partial<Record<ErrorCode, RetryPolicy>> = {
  NETWORK_ERROR: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 },
  TIMEOUT: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 },
  RATE_LIMITED: { maxAttempts: 3, baseDelayMs: 5000, maxDelayMs: 30000 },
  BROWSER_ERROR: { maxAttempts: 2, baseDelayMs: 2000, maxDelayMs: 5000 },
  PARSER_FAILED: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 500 },
};

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { sleep?: Sleep; onRetry?: (err: AgentError, attempt: number, delayMs: number) => void; policies?: typeof RETRY_POLICIES } = {},
): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  const policies = opts.policies ?? RETRY_POLICIES;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (raw) {
      const err = toAgentError(raw);
      const policy = policies[err.code];
      if (!policy || (!err.retryable && err.code !== "PARSER_FAILED") || attempt >= policy.maxAttempts) throw err;
      const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
}
