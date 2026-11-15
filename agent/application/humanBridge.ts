import type { Page } from "playwright";

/** What stands between the agent and the form and needs the user: they act in the open browser window. */
export type HandoffKind = "CAPTCHA" | "OTP" | "SECURITY" | "LOGIN";

/** A required question the agent has no trusted answer for. */
export interface PendingQuestion {
  label: string;
  kind: string;
  options: string[];
  required: boolean;
  /** Why the agent could not answer it (e.g. "no question-bank match"). */
  reason: string;
}

/** The user's answer. remember=true → saved to Application_Answers.txt; false → used for this application only. */
export interface QuestionAnswer {
  label: string;
  answer: string;
  remember: boolean;
}

/**
 * Optional link between the application engine and an interactive controller (the ApplyPilot web app).
 * The CLI does not use it; every hook is optional and the engine behaves exactly as before without it.
 * Nothing here can solve or skip a CAPTCHA: the user completes it in the browser, the engine re-checks the page.
 */
export interface HumanBridge {
  /** The browser page the engine works in (live preview, "open browser"). */
  pageOpened?(page: Page): void;
  /** Progress events for the activity stream. */
  event?(type: string, detail: Record<string, unknown>): void;
  /** Pause/stop point. Resolves when the agent may go on ("go") or must stop this application ("stop"). */
  checkpoint?(stage: "before-fill" | "before-submit"): Promise<"go" | "stop">;
  /** A CAPTCHA / OTP / security check / login needs the user. */
  handoffStarted?(h: { kind: HandoffKind; what: string; url: string }): void;
  /**
   * Resolves when the user clicks Continue (the engine re-checks the page at once) or Skip (the application stops).
   * Each call returns a fresh signal.
   */
  handoffSignal?(): Promise<"continue" | "skip">;
  handoffEnded?(outcome: "cleared" | "timeout" | "skipped"): void;
  /** Required questions without a trusted answer. Answers are used only if the user gives them; "skip" stops the job. */
  ask?(questions: PendingQuestion[]): Promise<QuestionAnswer[] | "skip">;
}
