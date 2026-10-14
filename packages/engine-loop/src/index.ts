import type {} from "cordis";
import type { Context } from "cordis";
import { z } from "zod";
import { HOUSE_RULES, focusSuffix, isSuspended, promptSections, type Engine, type ThreadMessage, type TurnIO, type TurnInput, type TurnResult } from "@tomradex/agent";
import { assistantMessage, collect, toolResultsMessage, type Message, type ToolSpec } from "@tomradex/llm";
import { LONG_RESULT, ToolInputError, compactList } from "@tomradex/tools";

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
const RESULT_CAP = LONG_RESULT;
/** A tool that answers in text (the shell) has already sized it; the cap is only a backstop. */
const TEXT_RESULT_CAP = 20_000;
/** Tokens a request may carry before older tool results in the turn are dropped; under every window we ship. */
const CONTEXT_BUDGET = 64_000;
/** Where dropping stops, so it does not happen again on the very next step. */
const CONTEXT_TARGET = 40_000;
/** The latest tool-result messages are never dropped: the model is working from them. */
const KEEP_RECENT_RESULTS = 2;
/** How much of a tool's reference the loop reads (ToolDefinition.whole). */
const WHOLE_CAP = 100_000;

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

/** A tool result as the model reads it; a long list of records comes back compacted (see compactList), unless the tool's result is reference read whole. */
export function render(result: unknown, whole = false): string {
  const cap = whole ? WHOLE_CAP : RESULT_CAP;
  // Read as written: a JSON-escaped string turns every line break of command output into \n.
  if (typeof result === "string") {
    const limit = Math.max(cap, TEXT_RESULT_CAP);
    return result.length <= limit ? result : result.slice(0, limit) + "… (truncated)";
  }
  const full = JSON.stringify(result);
  if (full.length <= cap) return full;
  const list = whole ? null : compactList(result);
  if (list) return `${list.note} ${list.json}`;
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

const sizeOf = (messages: Message[]): number => {
  let n = 0;
  for (const m of messages)
    for (const b of m.content)
      n += b.type === "text" ? b.text.length : b.type === "tool_result" ? b.content.length : b.type === "tool_call" ? JSON.stringify(b.args ?? {}).length : 0;
  return n;
};

/**
 * Drops the oldest tool results of the turn, in place, until about `free` characters are gone;
 * the latest `keep` result messages stay whole. Returns the characters freed.
 */
export function elideOldResults(messages: Message[], free: number, keep = KEEP_RECENT_RESULTS): number {
  const holders = messages.filter((m) => m.content.some((b) => b.type === "tool_result"));
  let freed = 0;
  for (const m of holders.slice(0, Math.max(0, holders.length - keep))) {
    for (const b of m.content) {
      if (freed >= free) return freed;
      if (b.type !== "tool_result" || b.content.length < 200) continue;
      const before = b.content.length;
      b.content = `(result dropped to make room — it was ${before} characters; call the tool again if you still need it)`;
      freed += before - b.content.length;
    }
  }
  return freed;
}

/** What the person sent while the turn ran, worded so the model takes it as a change of course. */
const steering = (texts: string[]) => ({ type: "text" as const, text: texts.map((t) => `(The user added while you were working: ${t})`).join("\n") });

const system = (input: TurnInput, io: TurnIO, options: LoopOptions): string =>
  [IDENTITY, ...promptSections(input, io, { playbooks: options.guidance === "auto" })].join("\n\n");

export function createLoopEngine(ctx: Context): Engine {
  // what the engine itself says in the conversation, in the person's language
  const zh = () => (ctx.get("settings") as { locale?: () => string } | undefined)?.locale?.() === "zh";
  return {
    id: "loop",
    title: "Tomrade loop",
    usesModels: true,
    steers: true,
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
      const described = io.tools.describe().sort((a, b) => a.name.localeCompare(b.name));
      const tools: ToolSpec[] = model.capabilities.tools ? described.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) : [];
      const whole = new Set(described.filter((t) => t.whole).map((t) => t.name));
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
      // What the last request cost in input tokens; 0 until a provider reports it.
      let lastInput = 0;

      for (let step = 1; step <= options.maxSteps; step += 1) {
        const chars = sizeOf(messages);
        // Characters per token varies by language; trust what the provider measured when it said.
        const tokens = Math.max(lastInput, Math.ceil(chars / 4));
        if (tokens > CONTEXT_BUDGET && elideOldResults(messages, Math.ceil(chars * (1 - CONTEXT_TARGET / tokens))) > 0)
          // A remembered answer may be one just dropped; the model must be free to ask again.
          memo.clear();
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
          (delta) => io.delta(delta),
          ({ attempt, max, reason, delayMs }) => io.retry?.({ attempt, max, reason, delayMs })
        );
        lastInput = collected.usage.inputTokens;
        // a reply with only tool calls streams no text; it still means the request went through
        io.retry?.(null);
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
            io.emit({ type: "note", text: zh() ? "模型把整个输出额度都用在了思考上，换成不深度思考再试一次。" : "The model used its whole output allowance thinking. Trying again without extended thinking." });
            continue;
          }
          return {
            stop: "error",
            error: zh()
              ? `模型在${collected.text.trim() ? "回答到一半时" : "开始回答前"}就到了输出上限（${options.maxTokens} 个 token）。换个小一点的请求，或者给这个对话选低一点的推理强度。`
              : `The model reached its output limit (${options.maxTokens} tokens) ${collected.text.trim() ? "mid-answer" : "before answering"}. Ask for something smaller, or pick a lower effort for this thread.`,
            usage
          };
        }
        if (!collected.toolCalls.length) {
          // A message that came in while the model wrote its last reply still belongs to this turn.
          const late = io.takeSteers?.() ?? [];
          if (!late.length) return { stop: "end", usage };
          messages.push(assistantMessage(collected), { role: "user", content: [steering(late)] });
          continue;
        }

        messages.push(assistantMessage(collected));
        // Calls in a reply cut at the limit may be cut too, and still parse — a write_file with half the file. None is run.
        if (collected.stop === "max_tokens") {
          invalidStreak += 1;
          const cut = `ERROR: your reply reached the output limit (${options.maxTokens} tokens) before this call was complete, so it was not run. Send it again in smaller pieces — for a long file, write part of it and append the rest.`;
          messages.push(toolResultsMessage(collected.toolCalls.map((call) => ({ id: call.id, content: cut, isError: true }))));
          continue;
        }
        const results = await Promise.all(
          collected.toolCalls.map(async (call) => {
            const broken = brokenJson(call.name, call.args);
            if (broken) return { id: call.id, suspended: false, content: `ERROR: ${broken}`, isError: true, invalid: true };
            const key = READ_TOOL.test(call.name) ? `${call.name} ${JSON.stringify(call.args)}` : null;
            if (key && memo.has(key)) return { id: call.id, suspended: false, content: "(identical to an earlier call this turn — nothing has changed since; use the result you already have)", invalid: false };
            try {
              const result = await io.tools.execute(call.name, call.args);
              const content = isSuspended(result) ? result.note : render(result, whole.has(call.name));
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
        const answered = toolResultsMessage(results);
        if (results.some((r) => r.suspended)) {
          messages.push(answered);
          return { stop: "asked", usage };
        }
        const steered = io.takeSteers?.() ?? [];
        if (steered.length) answered.content.push(steering(steered));
        messages.push(answered);
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
