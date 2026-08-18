/**
 * LLMProvider — the only place that talks to an LLM vendor (openai-compatible
 * chat/completions over fetch). Structured outputs via response_format json_object
 * + zod validate-and-repair (one bounded retry). Provider/model are configuration,
 * never code: swapping DeepSeek, OpenAI, OpenRouter — anything compatible is config.
 */
import { z } from "zod";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

export class LlmError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "LlmError";
  }
}

export interface LLMProvider {
  /** Ask the model for one structured (JSON) answer matching `schema`. */
  completeJson<T>(
    schema: z.ZodType<T>,
    opts: { system: string; user: string; temperature?: number }
  ): Promise<T>;
}

/** OpenAI-compatible chat/completions provider (DeepSeek, OpenAI, OpenRouter, ...). */
export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly cfg: () => ProviderConfig) {}

  async completeJson<T>(
    schema: z.ZodType<T>,
    opts: { system: string; user: string; temperature?: number }
  ): Promise<T> {
    const { apiKey, baseURL, model } = this.cfg();
    if (!apiKey) throw new LlmError("LLM API key not configured");
    const url = baseURL.replace(/\/$/, "") + "/chat/completions";

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const body = {
        model,
        temperature: opts.temperature ?? 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system" as const, content: opts.system },
          { role: "user" as const, content: opts.user }
        ]
      };
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new LlmError("LLM request failed " + res.status + ": " + text.slice(0, 300));
      }
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new LlmError("LLM returned no content");

      try {
        const parsed: unknown = JSON.parse(content);
        return schema.parse(parsed);
      } catch (err) {
        lastError = err;
        if (attempt === 0) {
          // bounded repair: strip code fences and retry once
          const repaired = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
          try {
            return schema.parse(JSON.parse(repaired));
          } catch {
            // fall through to final error
          }
        }
      }
    }
    throw new LlmError("LLM output failed schema validation", lastError);
  }
}

/** Deterministic fake provider for tests/offline demo — returns canned JSON. */
export class FakeProvider implements LLMProvider {
  constructor(private readonly respond: (system: string, user: string) => unknown) {}
  async completeJson<T>(schema: z.ZodType<T>, opts: { system: string; user: string }): Promise<T> {
    const value = this.respond(opts.system, opts.user);
    return schema.parse(value);
  }
}
