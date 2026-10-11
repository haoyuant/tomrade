import type {} from "cordis";
import type { Context } from "cordis";
import { z } from "zod";
import { HOUSE_RULES, focusSuffix, isSuspended, promptSections, type Engine, type ThreadMessage, type TurnIO, type TurnInput, type TurnResult } from "@tomradex/agent";
import { assistantMessage, collect, toolResultsMessage, type Message, type ToolSpec } from "@tomradex/llm";
import { ToolInputError } from "@tomradex/tools";

export const LoopOptions = z.object({
  /** auto: the playbook index guides the model; none: the bare loop. */
  guidance: z.enum(["auto", "none"]).default("auto"),
  /** A model profile id; empty = the first configured profile. */
  profile: z.string().optional(),
  /** Reasoning effort, where the profile's endpoint has the knob (OpenAI-compatible). */
  effort: z.string().optional(),
  maxSteps: z.number().int().min(1).max(64).default(24),
  maxTokens: z.number().int().min(256).default(8192)
});
export type LoopOptions = z.infer<typeof LoopOptions>;

const IDENTITY =
  "You are Tomrade's agent, working inside a local-first backlog workbench. You operate the app by calling tools; every write you make is attributed, run-scoped, and revertible in one click — act, don't ask for permission.\n" +
  HOUSE_RULES;

const HISTORY_LIMIT = 48;

/** Tools that only read; an identical call within one turn returns the same thing, so it is not run twice. */
const READ_TOOL = /^(list|get|count|find|read|open)_|^diagram_schema$/;
const RESULT_CAP = 6000;
/** A tool that answers in text (the shell) has already sized it; the cap is only a backstop. */
const TEXT_RESULT_CAP = 20_000;
const LIST_CAP = 16000;
const TEXT_CAP = 160;

/**
 * Arguments an adapter could not parse arrive as `{ __raw }`. Validating them reported every
 * field as missing, which sent DeepSeek after the wrong problem twice before the loop gave up;
 * say it is the JSON, and show where it breaks.
 */
function brokenJson(name: string, args: unknown): string | null {
  const raw = args && typeof args === "object" && "__raw" in args ? (args as { __raw: unknown }).__raw : undefined;
  if (typeof raw !== "string") return null;
  let problem = "it is not one JSON object";
  let at = raw.length;
  try {
    JSON.parse(raw);
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err);
    at = Number(/position (\d+)/.exec(problem)?.[1] ?? raw.length);
  }
  return `${name}: the arguments were not valid JSON (${problem}), near: …${raw.slice(Math.max(0, at - 60), at + 30)}… Send the whole call again as one valid JSON object; inside strings, escape double quotes as \\".`;
}

/** One row of a long list, shorn of what a listing does not need: empties, nested records, the tail of long text. */
export function compactRow(row: unknown): unknown {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") out[k] = v.length > TEXT_CAP ? v.slice(0, TEXT_CAP) + "…" : v;
    else if (Array.isArray(v)) {
      if (v.length && v.every((x) => typeof x !== "object")) out[k] = v;
    } else if (typeof v !== "object") out[k] = v;
  }
  return out;
}

/**
 * A tool result as the model reads it. A list that does not fit is not cut
 * mid-record — that read as "there is more, query again" and sent weaker
 * models re-slicing the same rows by status and sort — every row stays in a
 * shortened form, and only past the list cap do rows drop, with the count first.
 */
export function render(result: unknown, cap = RESULT_CAP): string {
  // Read as written: a JSON-escaped string turns every line break of command output into \n.
  if (typeof result === "string") {
    const limit = Math.max(cap, TEXT_RESULT_CAP);
    return result.length <= limit ? result : result.slice(0, limit) + "… (truncated)";
  }
  const full = JSON.stringify(result);
  if (full.length <= cap) return full;
  if (Array.isArray(result) && result.length && result.every((r) => typeof r === "object" && r !== null && !Array.isArray(r))) {
    const rows = result.map(compactRow);
    let kept = rows.length;
    let body = JSON.stringify(rows);
    while (body.length > LIST_CAP && kept > 1) {
      kept = Math.min(kept - 1, Math.floor((kept * LIST_CAP) / body.length));
      body = JSON.stringify(rows.slice(0, kept));
    }
    const head = kept < rows.length ? `(${rows.length} items; showing the first ${kept} — narrow the search or use count_items) ` : `(all ${rows.length} items; long text shortened and nested detail dropped — get_item for one item's full record) `;
    return head + body;
  }
  return full.slice(0, cap) + "… (truncated — fetch details with a narrower tool call)";
}

/** Prior turns re-read as plain text; the current turn keeps native tool blocks. */
export function historyMessages(messages: ThreadMessage[], io?: TurnIO, accepted: string[] = []): Message[] {
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
    if (m.role === "user" && b.type === "text") {
      push("user", b.text + focusSuffix(b.focus));
      for (const ref of b.attachments ?? []) {
        if (accepted.includes(ref.mime) && io?.media) out[out.length - 1].content.push({ type: "media", media: io.media.read(ref.id) });
        else push("user", `(attachment ${ref.name}, ${ref.id}: ${ref.mime} is not supported by this model)`);
      }
    }
    else if (b.type === "media") {
      push("assistant", `(displayed ${b.media.name}, media ID ${b.media.id}${b.caption ? ": " + b.caption : ""})`);
      if (accepted.includes(b.media.mime) && io?.media) out.push({ role: "user", content: [{ type: "media", media: io.media.read(b.media.id) }] });
    }
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
    media: options => {
      const parsed = LoopOptions.parse(options ?? {});
      const llm = ctx.get("llm");
      const profile = parsed.profile ?? llm?.profiles()[0]?.id;
      if (!llm || !profile) return { input: [], output: [] };
      const caps = llm.forProfile(profile).capabilities;
      return { input: caps.mediaInput ?? [], output: caps.mediaOutput ?? [] };
    },
    author: "ai:agent",
    // Talks to the backlog through tools (a shell among them while @tomradex/shell is on); never implements a ticket.
    capabilities: ["backlog"],
    options: LoopOptions,
    available: async () => {
      const llm = ctx.get("llm");
      if (!llm) return { ok: false, reason: "No language model plugin is loaded", need: "service" };
      const state = llm.ready();
      return state.ok ? state : { ...state, need: "model" };
    },
    picks: () => {
      const profiles = ctx.get("llm")?.profiles() ?? [];
      return [
        // shown even with one profile, so it's clear at a glance which model the thread uses
        ...(profiles.length > 0 ? [{ key: "profile", title: "Model", choices: profiles.map((p) => ({ value: p.id, label: p.title })) }] : []),
        { key: "effort", title: "Effort", choices: [{ value: "minimal" }, { value: "low" }, { value: "medium" }, { value: "high" }] }
      ];
    },
    async turn(input: TurnInput, io: TurnIO): Promise<TurnResult> {
      if (!io.llm) return { stop: "error", error: "no language model available" };
      const options = LoopOptions.parse(input.options ?? {});
      const profileId = options.profile ?? io.llm.profiles()[0]?.id;
      if (!profileId) return { stop: "error", error: "no language model profile configured" };
      const model = io.llm.forProfile(profileId);
      const tools: ToolSpec[] = model.capabilities.tools ? io.tools
        .describe()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) : [];
      const messages = historyMessages(input.messages, io, model.capabilities.mediaInput ?? []);
      // A workflow that finished on the user's answer may have spoken last. A request may not end on the
      // assistant: thinking-mode endpoints read it as an unfinished turn and refuse it without its reasoning.
      if (messages.at(-1)?.role === "assistant") messages.push({ role: "user", content: [{ type: "text", text: "(That ran in reply to the user's last message. Reply to the user now.)" }] });
      const usage = { inputTokens: 0, outputTokens: 0 };
      // Dropped for the rest of the turn once the model has thought its way past the output limit.
      let effort = options.effort;
      let invalidStreak = 0;
      // What each read call answered this turn; a write clears it, since the answer may have changed.
      const memo = new Map<string, string>();

      for (let step = 1; step <= options.maxSteps; step += 1) {
        const collected = await collect(
          model.chat(
            {
              system: system(input, io, options),
              messages,
              tools,
              toolChoice: invalidStreak >= 2 ? "none" : undefined,
              maxTokens: options.maxTokens,
              effort
            },
            io.signal
          ),
          (delta) => io.delta(delta)
        );
        usage.inputTokens += collected.usage.inputTokens;
        usage.outputTokens += collected.usage.outputTokens;
        io.progress(usage);
        if (collected.text.trim()) io.emit({ type: "text", text: collected.text.trim() });
        for (const media of collected.media ?? []) {
          if (!io.media) throw new Error("This runtime cannot publish media");
          io.media.publish(media);
        }
        if (collected.stop === "refusal") return { stop: "error", error: "the model declined to answer", usage };
        // Cut off with no call to make. Ending as "done" here read as the agent going quiet mid-task.
        if (collected.stop === "max_tokens" && !collected.toolCalls.length) {
          // Nothing but reasoning, which is never kept: the same step again, without extended thinking.
          if (effort && !collected.text.trim()) {
            effort = undefined;
            io.emit({ type: "note", text: "The model used its whole output allowance thinking. Trying again without extended thinking." });
            continue;
          }
          return {
            stop: "error",
            error: `The model reached its output limit (${options.maxTokens} tokens) ${collected.text.trim() ? "mid-answer" : "before answering"}. Ask for something smaller, or pick a lower effort for this thread.`,
            usage
          };
        }
        if (!collected.toolCalls.length) return { stop: "end", usage };

        messages.push(assistantMessage(collected));
        const results = await Promise.all(
          collected.toolCalls.map(async (call) => {
            const broken = brokenJson(call.name, call.args);
            if (broken) return { id: call.id, suspended: false, content: `ERROR: ${broken}`, isError: true, invalid: true };
            const key = READ_TOOL.test(call.name) ? `${call.name} ${JSON.stringify(call.args)}` : null;
            if (key && memo.has(key)) return { id: call.id, suspended: false, content: "(identical to an earlier call this turn — nothing has changed since; use the result you already have)", invalid: false };
            try {
              const result = await io.tools.execute(call.name, call.args);
              const content = isSuspended(result) ? result.note : render(result, call.name === "diagram_schema" || call.name === "open_playbook" ? 100_000 : RESULT_CAP);
              if (key) memo.set(key, content);
              return { id: call.id, suspended: isSuspended(result), content, invalid: false };
            } catch (err) {
              const invalid = err instanceof ToolInputError;
              return { id: call.id, suspended: false, content: `ERROR: ${err instanceof Error ? err.message : String(err)}`, isError: true, invalid };
            }
          })
        );
        if (collected.toolCalls.some((call) => !READ_TOOL.test(call.name))) memo.clear();
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
