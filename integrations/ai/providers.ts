import { z } from "zod";
import type { AIProvider, IntegrationStatus } from "../../agent/core/interfaces.ts";
import type { Env } from "../../agent/core/env.ts";
import { AgentError } from "../../agent/core/errors.ts";
import type { HttpClient } from "../../agent/core/http.ts";

const GeminiResponse = z.object({
  candidates: z
    .array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string().optional() })).optional() }).optional(), finishReason: z.string().optional() }))
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
});

/** Google Gemini via the documented generateContent REST endpoint. Key verified by preflight (models.list). */
export class GeminiProvider implements AIProvider {
  readonly id = "ai:gemini";
  constructor(
    private readonly http: HttpClient,
    private readonly opts: { apiKey: string | undefined; model: string },
  ) {}

  status(): IntegrationStatus {
    return this.opts.apiKey ? { id: this.id, state: "READY", detail: `model ${this.opts.model}` } : { id: this.id, state: "NOT_CONFIGURED", detail: "GEMINI_API_KEY missing" };
  }

  async listModels(): Promise<string[]> {
    const r = z.object({ models: z.array(z.object({ name: z.string() })).optional() }).parse(
      await this.http.getJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": this.opts.apiKey ?? "" } }),
    );
    return (r.models ?? []).map((m) => m.name.replace(/^models\//, ""));
  }

  async generateText(prompt: string, o: { system?: string; maxOutputTokens?: number; temperature?: number; json?: boolean; files?: Array<{ mimeType: string; data: Buffer }> } = {}): Promise<string> {
    if (!this.opts.apiKey) throw new AgentError("NOT_CONFIGURED", "GEMINI_API_KEY missing");
    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts: [...(o.files ?? []).map((f) => ({ inlineData: { mimeType: f.mimeType, data: f.data.toString("base64") } })), { text: prompt }] }],
      generationConfig: { temperature: o.temperature ?? 0.2, maxOutputTokens: o.maxOutputTokens ?? 800 },
    };
    if (o.json) {
      const gc = body.generationConfig as Record<string, unknown>;
      gc.responseMimeType = "application/json";
      if (/^gemini-[3-9]/.test(this.opts.model)) gc.thinkingConfig = { thinkingLevel: "low" };
    }
    if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.opts.model)}:generateContent`;
    const headers = { "x-goog-api-key": this.opts.apiKey };
    // Gemini answers 503 "high demand" in bursts; a short backoff usually gets through.
    let reply: unknown;
    for (let attempt = 0; ; attempt++) {
      try {
        reply = await this.http.postJson(url, body, { headers, timeoutMs: 90000 });
        break;
      } catch (e) {
        if (attempt >= 3 || !(e instanceof AgentError) || !e.retryable) throw e;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
    const res = GeminiResponse.parse(reply);
    if (res.promptFeedback?.blockReason) throw new AgentError("VALIDATION_FAILED", `Gemini blocked the prompt: ${res.promptFeedback.blockReason}`);
    const text = (res.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
    if (!text) throw new AgentError("PARSER_FAILED", "Gemini returned no text", { retryable: false });
    return text;
  }
}

const EmbedResponse = z.object({ embeddings: z.array(z.object({ values: z.array(z.number()) })).optional() });

/** Gemini text embeddings (batchEmbedContents) for ApplyPilot's semantic retrieval. */
export class GeminiEmbedder {
  readonly id: string;
  constructor(
    private readonly http: HttpClient,
    private readonly opts: { apiKey: string | undefined; model: string; dimensions: number },
  ) {
    this.id = `gemini:${opts.model}:${opts.dimensions}`;
  }
  available(): boolean {
    return !!this.opts.apiKey;
  }
  async embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
    if (!this.opts.apiKey) throw new AgentError("NOT_CONFIGURED", "GEMINI_API_KEY missing");
    const model = `models/${this.opts.model}`;
    const res = EmbedResponse.parse(
      await this.http.postJson(
        `https://generativelanguage.googleapis.com/v1beta/${model}:batchEmbedContents`,
        { requests: texts.map((text) => ({ model, content: { parts: [{ text }] }, taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT", outputDimensionality: this.opts.dimensions })) },
        { headers: { "x-goog-api-key": this.opts.apiKey }, timeoutMs: 30000 },
      ),
    );
    const out = (res.embeddings ?? []).map((e) => e.values);
    if (out.length !== texts.length) throw new AgentError("PARSER_FAILED", `Gemini returned ${out.length} embeddings for ${texts.length} texts`);
    return out;
  }
}

export function buildEmbedder(env: Env, http: HttpClient): GeminiEmbedder | null {
  return env.AI_PROVIDER === "gemini" && env.GEMINI_API_KEY ? new GeminiEmbedder(http, { apiKey: env.GEMINI_API_KEY, model: "gemini-embedding-001", dimensions: 768 }) : null;
}

export class UnavailableAIProvider implements AIProvider {
  constructor(
    readonly id: string,
    private readonly reason: string,
  ) {}
  status(): IntegrationStatus {
    return { id: this.id, state: "NOT_CONFIGURED", detail: this.reason };
  }
  async generateText(): Promise<string> {
    throw new AgentError("NOT_CONFIGURED", this.reason);
  }
}

export function buildAIProvider(env: Env, http: HttpClient): AIProvider {
  switch (env.AI_PROVIDER) {
    case "gemini":
      return new GeminiProvider(http, { apiKey: env.GEMINI_API_KEY, model: env.AI_MODEL ?? "gemini-2.5-flash" });
    case "openai":
    case "anthropic":
      return new UnavailableAIProvider(`ai:${env.AI_PROVIDER}`, `AI_PROVIDER=${env.AI_PROVIDER} has no adapter yet (only gemini is implemented and verified)`);
    default:
      return new UnavailableAIProvider("ai:none", "AI_PROVIDER=none");
  }
}
