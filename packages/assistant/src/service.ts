import { Context, Service } from "cordis";
import { z } from "zod";
import type { ChatTurn, DedupResult, ExtractCandidate, GapCandidate } from "@tomrade/domain";
import type {} from "@tomrade/ipc";
import type {} from "@tomrade/items";
import type {} from "@tomrade/llm";
import { defineTool } from "@tomrade/tools";
import { checkDuplicate, type BacklogSummary } from "./workflows/dedup.js";
import { extractTickets } from "./workflows/extract.js";
import { gapAnalysis } from "./workflows/gap.js";
import { routeIntent } from "./workflows/route.js";

export type AiChatResult =
  | { kind: "text"; reply: string }
  | { kind: "tool"; tool: string; result: unknown; reply?: string }
  | { kind: "error"; tool?: string; error: string };

export interface AiExtractResult {
  candidates: ExtractCandidate[];
  dedup: Record<number, DedupResult>;
}

declare module "cordis" {
  interface Context {
    assistant: Assistant;
  }
}

declare module "@tomrade/ipc" {
  interface Channels {
    "assistant.chat": (text: string, history: ChatTurn[], projectId?: string) => AiChatResult;
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Assistant extends Service {
  static provide = "assistant";
  static inject = ["llm", "tools", "items"];

  constructor(ctx: Context) {
    super(ctx, "assistant");
  }

  [Service.init]() {
    this.ctx.tools.register(
      defineTool({
        name: "extract_tickets",
        title: "Extract tickets",
        description: "Extract candidate backlog items from free text (notes, a conversation, a spec), each judged against the existing backlog for duplicates.",
        input: z.object({ text: z.string().min(1) }),
        execute: ({ text }, inv) => this.extract(text, inv.projectId)
      })
    );
    this.ctx.tools.register(
      defineTool({
        name: "gap_analysis",
        title: "Gap analysis",
        description: "Compare a stated requirement against the existing backlog and list the items still missing.",
        input: z.object({ requirement: z.string().min(1) }),
        execute: ({ requirement }, inv) => this.gap(requirement, inv.projectId)
      })
    );
    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("assistant.chat", (text, history, projectId) => ctx.assistant.chat(text, history, projectId));
    });
  }

  /** Route the message; when it names a tool, run it as ai:assistant and return the result for the panel. */
  async chat(text: string, history: ChatTurn[] = [], projectId?: string): Promise<AiChatResult> {
    const route = await routeIntent(this.ctx.llm, this.ctx.tools.describe(), [...history, { role: "user", content: text }]);
    if (!route.needsTool || !route.tool) return { kind: "text", reply: route.reply ?? "I don't need a tool for that." };
    try {
      const result = await this.ctx.tools.execute(route.tool, route.args ?? {}, { by: "ai:assistant", projectId });
      return { kind: "tool", tool: route.tool, result, reply: route.reply };
    } catch (err) {
      return { kind: "error", tool: route.tool, error: message(err) };
    }
  }

  async extract(text: string, projectId?: string): Promise<AiExtractResult> {
    const candidates = await extractTickets(this.ctx.llm, text);
    const existing = this.summary(projectId);
    const dedup: Record<number, DedupResult> = {};
    for (const [i, candidate] of candidates.entries()) {
      try {
        dedup[i] = await checkDuplicate(this.ctx.llm, { title: candidate.title, body: candidate.body, existing });
      } catch {
        dedup[i] = { isDuplicate: false, duplicates: [] };
      }
    }
    return { candidates, dedup };
  }

  gap(requirement: string, projectId?: string): Promise<GapCandidate[]> {
    return gapAnalysis(this.ctx.llm, { requirement, existing: this.summary(projectId) });
  }

  private summary(projectId?: string): BacklogSummary[] {
    return this.ctx.items.list(projectId ? { projectId } : {}).map((i) => ({ id: i.id, title: i.title, body: i.body }));
  }
}
