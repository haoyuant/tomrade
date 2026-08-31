import type {} from "cordis";
import type { Context } from "cordis";
import { z } from "zod";
import { HOUSE_RULES, isSuspended, promptSections, type Engine, type ThreadMessage, type TurnIO, type TurnInput, type TurnResult } from "@tomrade/agent";
import { assistantMessage, collect, toolResultsMessage, type Message, type ToolSpec } from "@tomrade/llm";
import { ToolInputError } from "@tomrade/tools";

export const LoopOptions = z.object({
  /** auto: the playbook index guides the model; none: the bare loop. */
  guidance: z.enum(["auto", "none"]).default("auto"),
  maxSteps: z.number().int().min(1).max(64).default(24),
  maxTokens: z.number().int().min(256).default(8192)
});
export type LoopOptions = z.infer<typeof LoopOptions>;

const IDENTITY =
  "You are Tomrade's agent, working inside a local-first backlog workbench. You operate the app by calling tools; every write you make is attributed, run-scoped, and revertible in one click — act, don't ask for permission.\n" +
  HOUSE_RULES;

const HISTORY_LIMIT = 48;

const flat = (value: unknown): string => {
  const text = JSON.stringify(value);
  return text.length > 3500 ? text.slice(0, 3500) + "… (truncated — fetch details with a narrower tool call)" : text;
};

/** Prior turns re-read as plain text; the current turn keeps native tool blocks. */
function historyMessages(messages: ThreadMessage[]): Message[] {
  const out: Message[] = [];
  const push = (role: "user" | "assistant", text: string) => {
    const last = out[out.length - 1];
    if (last && last.role === role && last.content[0]?.type === "text") {
      (last.content[0] as { text: string }).text += "\n" + text;
      return;
    }
    out.push({ role, content: [{ type: "text", text }] });
  };
  for (const m of messages) {
    const b = m.block;
    if (m.role === "user" && b.type === "text") push("user", b.text);
    else if (b.type === "text") push("assistant", b.text);
    else if (b.type === "question") push("assistant", `(asked the user: ${b.text}${b.options ? " — options: " + b.options.join(" / ") : ""})`);
    else if (b.type === "trace") push("assistant", `(${b.ok ? "did" : "failed"} ${b.tool} → ${b.summary})`);
    else if (b.type === "card") push("assistant", `(updated card "${b.title}")`);
    else if (b.type === "note") push("user", `(note: ${b.text})`);
  }
  if (out.length > HISTORY_LIMIT) {
    const kept = out.slice(-HISTORY_LIMIT);
    kept.unshift({ role: "user", content: [{ type: "text", text: "(earlier turns omitted for length — the cards and brief above carry the durable state)" }] });
    return kept;
  }
  return out;
}

const system = (input: TurnInput, io: TurnIO, options: LoopOptions): string =>
  [IDENTITY, ...promptSections(input, io, { playbooks: options.guidance === "auto" })].join("\n\n");

export function createLoopEngine(ctx: Context): Engine {
  return {
    id: "loop",
    title: "Tomrade loop",
    author: "ai:agent",
    options: LoopOptions,
    available: async () => {
      const llm = ctx.get("llm");
      if (!llm) return { ok: false, reason: "No language model plugin is loaded" };
      return llm.ready("conversation");
    },
    async turn(input: TurnInput, io: TurnIO): Promise<TurnResult> {
      if (!io.llm) return { stop: "error", error: "no language model available" };
      const options = LoopOptions.parse(input.options ?? {});
      const model = io.llm.for("conversation");
      const tools: ToolSpec[] = io.tools
        .describe()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      const messages = historyMessages(input.messages);
      const usage = { inputTokens: 0, outputTokens: 0 };
      let invalidStreak = 0;

      for (let step = 1; step <= options.maxSteps; step += 1) {
        const collected = await collect(
          model.chat(
            {
              system: system(input, io, options),
              messages,
              tools,
              toolChoice: invalidStreak >= 2 ? "none" : undefined,
              maxTokens: options.maxTokens
            },
            io.signal
          ),
          (delta) => io.delta(delta)
        );
        usage.inputTokens += collected.usage.inputTokens;
        usage.outputTokens += collected.usage.outputTokens;
        io.progress(usage);
        if (collected.text.trim()) io.emit({ type: "text", text: collected.text.trim() });
        if (collected.stop === "refusal") return { stop: "error", error: "the model declined to answer", usage };
        if (!collected.toolCalls.length) return { stop: "end", usage };

        messages.push(assistantMessage(collected));
        const results = await Promise.all(
          collected.toolCalls.map(async (call) => {
            try {
              const result = await io.tools.execute(call.name, call.args);
              return { id: call.id, suspended: isSuspended(result), content: isSuspended(result) ? result.note : flat(result), invalid: false };
            } catch (err) {
              const invalid = err instanceof ToolInputError;
              return { id: call.id, suspended: false, content: `ERROR: ${err instanceof Error ? err.message : String(err)}`, isError: true, invalid };
            }
          })
        );
        invalidStreak = results.some((r) => r.invalid) ? invalidStreak + 1 : 0;
        messages.push(toolResultsMessage(results));
        if (results.some((r) => r.suspended)) return { stop: "asked", usage };
        if (step === options.maxSteps - 1)
          messages.push({ role: "user", content: [{ type: "text", text: "(budget nearly spent: wrap up — summarize what happened, make no more writes)" }] });
      }
      return { stop: "budget", usage };
    }
  };
}

export default {
  name: "engine-loop",
  inject: ["agent"],
  apply(ctx: Context) {
    ctx.agent.engine(createLoopEngine(ctx));
  }
};
