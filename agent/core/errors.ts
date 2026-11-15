/** Error codes used across the agent. Retry policy keys off these, so keep them precise. */
export const ERROR_CODES = [
  "NETWORK_ERROR",
  "TIMEOUT",
  "RATE_LIMITED",
  "AUTH_REQUIRED",
  "SOURCE_UNAVAILABLE",
  "PARSER_FAILED",
  "UNSUPPORTED",
  "NOT_CONFIGURED",
  "VALIDATION_FAILED",
  "CONFIG_INVALID",
  "BROWSER_ERROR",
  "CAPTCHA",
  "OTP",
  "LOGIN_REQUIRED",
  "UNKNOWN_QUESTION",
  "COMPILE_FAILED",
  "TEMPLATE_TAMPERED",
  "INVALID_TRANSITION",
  "NOT_FOUND",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class AgentError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, opts: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "AgentError";
    this.code = code;
    this.retryable = opts.retryable ?? defaultRetryable(code);
    this.details = opts.details;
  }
}

function defaultRetryable(code: ErrorCode): boolean {
  return code === "NETWORK_ERROR" || code === "TIMEOUT" || code === "RATE_LIMITED" || code === "BROWSER_ERROR";
}

export function toAgentError(err: unknown, fallback: ErrorCode = "INTERNAL"): AgentError {
  if (err instanceof AgentError) return err;
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return new AgentError("TIMEOUT", err.message, { cause: err });
    const causeCode = (err.cause as { code?: unknown } | undefined)?.code;
    if (typeof causeCode === "string" && /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR)/.test(causeCode)) {
      return new AgentError("NETWORK_ERROR", `${err.message} (${causeCode})`, { cause: err });
    }
    if (err.message === "fetch failed") return new AgentError("NETWORK_ERROR", err.message, { cause: err });
    return new AgentError(fallback, err.message, { cause: err });
  }
  return new AgentError(fallback, String(err));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
