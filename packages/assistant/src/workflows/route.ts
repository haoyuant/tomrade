import { z } from "zod";
import type { ChatTurn } from "@tomrade/domain";
import type { LLMProvider } from "@tomrade/llm";
import type { ToolDescriptor } from "@tomrade/tools";

const schema = z.object({
  needs_tool: z.boolean(),
  tool: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  reply: z.string().optional()
});

export interface AssistantRoute {
  needsTool: boolean;
  tool?: string;
  args?: Record<string, unknown>;
  reply?: string;
}

interface JsonSchemaish {
  properties?: Record<string, { type?: string | string[]; enum?: unknown[] }>;
  required?: string[];
}

/** `{status?: backlog|todo, id: string}` — compact enough to sit in a system prompt. */
function describeArgs(schema: Record<string, unknown>): string {
  const { properties = {}, required = [] } = schema as JsonSchemaish;
  const fields = Object.entries(properties).map(([key, prop]) => {
    const type = prop.enum ? prop.enum.join("|") : Array.isArray(prop.type) ? prop.type.join("|") : (prop.type ?? "any");
    return `${key}${required.includes(key) ? "" : "?"}: ${type}`;
  });
  return `{${fields.join(", ")}}`;
}

/** The LLM only routes; the tool registry executes. The prompt is generated from the registry, so a new tool needs no prompt edit. */
export function systemPrompt(tools: ToolDescriptor[]): string {
  return [
    "You are Tomrade's AI assistant, embedded in a backlog + task management app.",
    "You can operate the app by calling tools. Decide whether the user's message requires one:",
    ...tools.map((t) => `- ${t.name}: ${t.description} Args: ${describeArgs(t.inputSchema)}`),
    "Rules:",
    "- If the user just asks a question or gives feedback, set needs_tool=false and answer in reply.",
    "- If they want to DO something in the backlog, set needs_tool=true, pick ONE tool and fill args.",
    "- For extract/gap tools, pass the user's raw text as the text/requirement arg.",
    "- For a new item's title, use an imperative title sized for one PR.",
    '- Return JSON: {"needs_tool": boolean, "tool"?: string, "args"?: object, "reply"?: string}'
  ].join("\n");
}

export async function routeIntent(llm: LLMProvider, tools: ToolDescriptor[], turns: ChatTurn[]): Promise<AssistantRoute> {
  const user = turns.map((t) => (t.role === "user" ? "USER: " : "ASSISTANT: ") + t.content).join("\n");
  const out = await llm.completeJson(schema, { system: systemPrompt(tools), user: user.slice(0, 8000), temperature: 0.1 });
  const known = new Set(tools.map((t) => t.name));
  return { needsTool: out.needs_tool, tool: out.tool && known.has(out.tool) ? out.tool : undefined, args: out.args, reply: out.reply };
}
