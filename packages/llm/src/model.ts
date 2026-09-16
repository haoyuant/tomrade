import type { z } from "zod";

export type LlmRole = "worker";
export type InputModality = "image" | "audio" | "video" | "pdf";
export interface MediaData { mime: string; base64: string; name: string }
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export function inputMimes(modalities: readonly InputModality[]): string[] {
  return modalities.flatMap(mode => mode === "image" ? IMAGE_MIMES : mode === "audio" ? ["audio/wav", "audio/mpeg"] : mode === "video" ? ["video/mp4", "video/webm"] : ["application/pdf"]);
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "media"; media: MediaData }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; content: string; isError?: boolean };

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

/** Model-facing tool description; `inputSchema` is JSON Schema. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  system: string;
  messages: Message[];
  tools?: ToolSpec[];
  toolChoice?: "auto" | "none" | { name: string };
  maxTokens?: number;
  temperature?: number;
  /** Reasoning effort where the endpoint has the knob (OpenAI-compatible `reasoning_effort`); others ignore it. */
  effort?: string;
  /** Ask for a single JSON document; adapters that can enforce it do. */
  json?: boolean;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal";

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "media"; media: MediaData }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "stop"; reason: StopReason };

export interface ChatCapabilities {
  mediaInput?: string[];
  mediaOutput?: string[];
  tools: boolean;
  streaming: boolean;
  json: boolean;
}

/** The conversational seam: anything that can stream one assistant turn, tools included. */
export interface ChatModel {
  capabilities: ChatCapabilities;
  chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent>;
}

export const text = (t: string): ContentBlock => ({ type: "text", text: t });
export const userMessage = (t: string): Message => ({ role: "user", content: [text(t)] });

export interface Collected {
  media?: MediaData[];
  text: string;
  toolCalls: { id: string; name: string; args: unknown }[];
  stop: StopReason;
  usage: { inputTokens: number; outputTokens: number };
}

/** Drain one turn; `onText` sees deltas as they stream. */
export async function collect(events: AsyncIterable<ChatEvent>, onText?: (delta: string) => void): Promise<Collected> {
  const out: Collected = { text: "", toolCalls: [], stop: "end", usage: { inputTokens: 0, outputTokens: 0 } };
  for await (const event of events) {
    if (event.type === "text") {
      out.text += event.delta;
      onText?.(event.delta);
    } else if (event.type === "media") {
      (out.media ??= []).push(event.media);
    } else if (event.type === "tool_call") {
      out.toolCalls.push({ id: event.id, name: event.name, args: event.args });
    } else if (event.type === "usage") {
      out.usage.inputTokens += event.inputTokens ?? 0;
      out.usage.outputTokens += event.outputTokens ?? 0;
    } else {
      out.stop = event.reason;
    }
  }
  if (out.toolCalls.length && out.stop === "end") out.stop = "tool_use";
  return out;
}

/** The turn an assistant message with tool calls becomes in the transcript. */
export function assistantMessage(collected: Pick<Collected, "text" | "toolCalls">): Message {
  const content: ContentBlock[] = [];
  if (collected.text) content.push(text(collected.text));
  for (const call of collected.toolCalls) content.push({ type: "tool_call", id: call.id, name: call.name, args: call.args });
  return { role: "assistant", content };
}

export function toolResultsMessage(results: { id: string; content: string; isError?: boolean }[]): Message {
  return { role: "user", content: results.map((r) => ({ type: "tool_result" as const, id: r.id, content: r.content, isError: r.isError })) };
}

export type { z };
