/**
 * AI assistant intent routing: given a user message (+ recent history), decide
 * whether to call a Tomrade tool (and with which args) or answer directly.
 * The LLM only ROUTES — the desktop process executes tools against the repo.
 */
import { z } from "zod";
import type { LLMProvider } from "./provider.js";

export const TOOL_NAMES = [
  "list_items",
  "create_item",
  "update_item",
  "delete_item",
  "extract_tickets",
  "gap_analysis"
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const routeSchema = z.object({
  needs_tool: z.boolean(),
  tool: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
  reply: z.string().optional()
});

export interface AssistantRoute {
  needsTool: boolean;
  tool?: ToolName;
  args?: Record<string, unknown>;
  reply?: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const SYSTEM = [
  "You are Tomrade's AI assistant, embedded in a backlog + task management app.",
  "You can operate the app by calling tools. Decide whether the user's message requires one:",
  "- list_items: query the backlog ({status?}, {kind?}, {parentId?}, {search?})",
  "- create_item: create a ticket or epic ({title} required, {body?}, {kind?: ticket|epic}, {parentId?})",
  "- update_item: change status/title/body ({id} required, {status?}, {title?}, {body?}, {parentId?})",
  "- delete_item: delete an item ({id})",
  "- extract_tickets: extract tickets from free text ({text} — the user's raw notes/conversation)",
  "- gap_analysis: find missing items for a requirement ({requirement})",
  "Rules:",
  "- If the user just asks a question or gives feedback, set needs_tool=false and answer in reply.",
  "- If they want to DO something in the backlog, set needs_tool=true, pick ONE tool and fill args.",
  "- For extract/gap, pass the user's raw text as the text/requirement arg.",
  "- For create_item title, use an imperative title sized for one PR.",
  "- Return JSON: {\"needs_tool\": boolean, \"tool\"?: string, \"args\"?: object, \"reply\"?: string}",
].join("\n");

export async function routeIntent(provider: LLMProvider, turns: ChatTurn[]): Promise<AssistantRoute> {
  const user = turns.map((t) => (t.role === "user" ? "USER: " : "ASSISTANT: ") + t.content).join("\n");
  const out = await provider.completeJson(routeSchema, { system: SYSTEM, user: user.slice(0, 8000), temperature: 0.1 });
  const rawTool = out.tool;
  const tool = rawTool && (TOOL_NAMES as readonly string[]).includes(rawTool) ? (rawTool as ToolName) : undefined;
  return {
    needsTool: out.needs_tool,
    tool,
    args: out.args,
    reply: out.reply
  };
}