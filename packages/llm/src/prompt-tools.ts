import type { ChatEvent, ChatModel, ChatRequest, ContentBlock, Message, ToolSpec } from "./model.js";
import { collect } from "./model.js";

const FENCE = /```tool_call\s*\n([\s\S]*?)\n```/;

function renderTools(tools: ToolSpec[]): string {
  const lines = tools.map((t) => `- ${t.name}: ${t.description}\n  args JSON Schema: ${JSON.stringify(t.inputSchema)}`);
  return [
    "",
    "# Tools",
    "You can call the tools below. To call one, end your reply with EXACTLY one fenced block and nothing after it:",
    "```tool_call",
    '{"name": "<tool name>", "args": { ... }}',
    "```",
    "Call at most one tool per reply. When no tool is needed, reply normally.",
    ...lines
  ].join("\n");
}

const asText = (block: ContentBlock): ContentBlock =>
  block.type === "tool_call"
    ? { type: "text", text: "```tool_call\n" + JSON.stringify({ name: block.name, args: block.args }) + "\n```" }
    : block.type === "tool_result"
      ? { type: "text", text: `[tool result${block.isError ? " (error)" : ""}] ${block.content}` }
      : block;

/**
 * Tools for a model without native tool calling: rendered into the prompt,
 * parsed out of a fence. Lossy (no streaming while parsing, one call per turn) —
 * the UI labels profiles running through this as degraded.
 */
export function withPromptTools(model: ChatModel): ChatModel {
  if (model.capabilities.tools) return model;
  return {
    capabilities: { ...model.capabilities, tools: true, streaming: false },
    async *chat(request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatEvent> {
      if (!request.tools?.length) {
        yield* model.chat(request, signal);
        return;
      }
      const flattened: Message[] = request.messages.map((m) => ({ role: m.role, content: m.content.map(asText) }));
      // Retries pass straight through; the rest is read whole before the fence can be parsed.
      const events: ChatEvent[] = [];
      for await (const event of model.chat({ ...request, system: request.system + renderTools(request.tools), messages: flattened, tools: undefined }, signal)) {
        if (event.type === "retry") yield event;
        else events.push(event);
      }
      const inner = await collect((async function* () { yield* events; })());
      const match = FENCE.exec(inner.text);
      const before = match ? inner.text.slice(0, match.index).trim() : inner.text;
      if (before) yield { type: "text", delta: before };
      for (const media of inner.media ?? []) yield { type: "media", media };
      yield { type: "usage", ...inner.usage };
      if (match) {
        try {
          const parsed = JSON.parse(match[1]) as { name?: string; args?: unknown };
          if (typeof parsed.name === "string") {
            yield { type: "tool_call", id: `ptc_${Date.now()}`, name: parsed.name, args: parsed.args ?? {} };
            yield { type: "stop", reason: "tool_use" };
            return;
          }
        } catch {
          // fall through: the fence was not a tool call after all
        }
        yield { type: "text", delta: "\n" + match[1] };
      }
      yield { type: "stop", reason: inner.stop };
    }
  };
}
