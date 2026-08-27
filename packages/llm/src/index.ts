import { Context, Service } from "cordis";
import { z } from "zod";
import type { LlmSettings } from "@tomrade/domain";
import type { SettingsSection } from "@tomrade/settings";

export interface CompletionRequest {
  system: string;
  user: string;
  temperature?: number;
}

/** The seam. Anything that can return one JSON document matching a schema can provide it. */
export interface LLMProvider {
  completeJson<T>(schema: z.ZodType<T>, request: CompletionRequest): Promise<T>;
}

declare module "cordis" {
  interface Context {
    llm: LLMProvider;
  }
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export const LLM_SECTION: SettingsSection<LlmSettings> = {
  id: "llm",
  title: "Assistant",
  description: "The direct provider used for extraction, dedup judging and gap checks. Any OpenAI-compatible endpoint works.",
  schema: z.object({ apiKey: z.string(), baseURL: z.string(), model: z.string() }),
  defaults: {
    apiKey: process.env.LLM_API_KEY ?? "",
    baseURL: process.env.LLM_BASE_URL ?? "https://api.deepseek.com",
    model: process.env.LLM_MODEL ?? "deepseek-chat"
  },
  order: 10
};

/** OpenAI-compatible chat/completions over fetch, with one bounded validate-and-repair retry. */
export class Llm extends Service implements LLMProvider {
  static provide = "llm";
  static inject = ["settings"];

  constructor(ctx: Context) {
    super(ctx, "llm");
  }

  [Service.init]() {
    this.ctx.settings.register(LLM_SECTION);
  }

  async completeJson<T>(schema: z.ZodType<T>, request: CompletionRequest): Promise<T> {
    const { apiKey, baseURL, model } = this.ctx.settings.get().llm ?? LLM_SECTION.defaults;
    if (!apiKey) throw new LlmError("LLM API key not configured");
    const res = await fetch(baseURL.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: request.temperature ?? 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user }
        ]
      })
    });
    if (!res.ok) throw new LlmError("LLM request failed " + res.status + ": " + (await res.text().catch(() => "")).slice(0, 300));
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new LlmError("LLM returned no content");

    const candidates = [content, content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")];
    let lastError: unknown;
    for (const text of candidates) {
      try {
        return schema.parse(JSON.parse(text));
      } catch (err) {
        lastError = err;
      }
    }
    throw new LlmError("LLM output failed schema validation", lastError);
  }
}

/** Deterministic provider for tests and offline demos. */
export class FakeLlm implements LLMProvider {
  constructor(private readonly respond: (system: string, user: string) => unknown) {}

  async completeJson<T>(schema: z.ZodType<T>, request: CompletionRequest): Promise<T> {
    return schema.parse(this.respond(request.system, request.user));
  }
}

/** A plugin that provides ctx.llm from a FakeLlm — the seam, swapped. */
export const fakeLlm = (respond: (system: string, user: string) => unknown) => ({
  name: "fake-llm",
  apply(ctx: Context) {
    ctx.provide("llm", new FakeLlm(respond));
  }
});

export default Llm;
