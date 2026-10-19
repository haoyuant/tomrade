import type {} from "cordis";
import type { Context } from "cordis";
import { z } from "zod";
import { HOUSE_RULES, deferredTools, focusSuffix, isSuspended, kitLines, promptSections, type AgentRequest, type AgentTurnInfo, type Engine, type ThreadMessage, type TurnIO, type TurnInput, type TurnResult } from "@tomradex/agent";
import { MediaRefused, NativeMediaRefused, NativeSearchRefused, assistantMessage, collect, modalityOf, toolResultsMessage, userMessage, type InputModality, type LlmService, type Message, type OutputModality, type ToolSpec } from "@tomradex/llm";
import { LONG_RESULT, ToolInputError, compactList, type ToolDescriptor } from "@tomradex/tools";
import { LOOP_WORDS } from "./words.js";

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
  "You are Tomrade's agent, working inside a local-first backlog workbench. You operate the app by calling tools; every write you make is attributed, run-scoped, and revertible in one click — act, don't ask for permission. You do not change code or carry out tickets yourself: when the user wants that done, make sure a ticket describes it, then call offer_start.\n" +
  HOUSE_RULES;

const HISTORY_LIMIT = 48;

/** Tools that only read; an identical call within one turn returns the same thing, so it is not run twice. */
const READ_TOOL = /^(list|get|count|find|read|open)_|^diagram_schema$/;

/** The loop's own tool: brings a kit this conversation was not given into the requests that follow. */
export const LOAD_TOOLS = "load_tools";

/** The web search plugin's tool; a model that searches on its own is not offered it. */
const WEB_SEARCH = "web_search";

/** The loop's own tool: an image or speech, made by the thread's model when it can, else by another profile that can. */
export const MAKE_MEDIA = "make_media";

const makeMediaSpec: ToolSpec = {
  name: MAKE_MEDIA,
  description: "Make an image or a spoken audio clip and show it in the conversation. Use it when the person asks for a picture or to hear something, or when one serves them better than words. Write prompt to stand on its own: for an image, a complete description of it; for audio, the exact words to speak.",
  inputSchema: {
    type: "object",
    properties: { kind: { type: "string", enum: ["image", "audio"] }, prompt: { type: "string" } },
    required: ["kind", "prompt"],
    additionalProperties: false
  }
};

const MAKER_SYSTEM: Record<OutputModality, string> = {
  image: "Make the image the user describes. Answer with the image and at most one short sentence.",
  audio: "Say the user's text aloud, word for word, and nothing else."
};

/** Whether a profile's model can make `kind` itself. */
const makes = (llm: LlmService, id: string, kind: OutputModality): boolean => {
  try {
    return !!llm.forProfile(id).capabilities.mediaOutput?.includes(kind);
  } catch {
    return false;
  }
};

const spec = (t: ToolDescriptor): ToolSpec => ({ name: t.name, description: t.description, inputSchema: t.inputSchema });

function loadToolsSpec(deferred: ToolDescriptor[], purposes: Record<string, string> = {}): ToolSpec {
  return {
    name: LOAD_TOOLS,
    description: `Load a kit of tools this conversation was not given. As soon as the person asks for what a kit does, load it and use its tools — do not make do without them. Kits: ${kitLines(deferred, purposes).join("; ")}.`,
    inputSchema: { type: "object", properties: { kit: { type: "string", enum: [...new Set(deferred.map((t) => t.kit))] } }, required: ["kit"], additionalProperties: false }
  };
}

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

/**
 * Takes media of the refused kinds out of the request, in place, each replaced by a line saying it
 * was left out, so the model knows a file was there. Returns how many were taken out.
 */
export function withoutMedia(messages: Message[], kinds: readonly InputModality[]): number {
  let taken = 0;
  for (const m of messages)
    m.content = m.content.map((b) => {
      if (b.type !== "media" || !kinds.includes(modalityOf(b.media.mime)!)) return b;
      taken += 1;
      return { type: "text", text: `(attachment ${b.media.name} left out: this model cannot read ${modalityOf(b.media.mime)} files)` };
    });
  return taken;
}

/**
 * What the person sent while the turn ran, worded so the model takes it as a change of course.
 * After a finished reply the model must not write it again: the person has already read it.
 */
export const steering = (texts: string[], afterReply = false) => ({
  type: "text" as const,
  text: texts.map((t) => `(The user added while you were working: ${t})`).join("\n") +
    (afterReply ? "\n(Your reply above is already on the user's screen. Answer only what this adds or changes; do not repeat it.)" : "")
});

const system = (input: TurnInput, io: TurnIO, options: LoopOptions): string =>
  [IDENTITY, ...promptSections(input, io, { playbooks: options.guidance === "auto" })].join("\n\n");

/** Times one step is sent again on plugins' answers to a failed request. */
const RETRIES_PER_STEP = 2;
/** Times plugins may keep one turn going; the step budget bounds it as well. */
const CONTINUES_PER_TURN = 3;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What plugins make of a step's request. A listener that throws is passed over: it never ends the turn. */
async function shape(ctx: Context, draft: AgentRequest): Promise<AgentRequest> {
  try {
    return await ctx.waterfall("agent/request", draft, async () => draft);
  } catch (err) {
    ctx.logger("engine-loop").warn(`agent/request: ${messageOf(err)}`);
    return draft;
  }
}

/** The first plugin's answer to a hook, or none when every listener passed or one threw. */
async function asked<T>(ctx: Context, hook: string, ask: () => Promise<T | void>): Promise<T | undefined> {
  try {
    return (await ask()) ?? undefined;
  } catch (err) {
    ctx.logger("engine-loop").warn(`${hook}: ${messageOf(err)}`);
    return undefined;
  }
}

/** The picked profile while it exists; a removed one counts as no pick, so the first profile answers. */
const profileOf = (llm: LlmService, picked: string | undefined): string | undefined => {
  const profiles = llm.profiles();
  return profiles.find((p) => p.id === picked)?.id ?? profiles[0]?.id;
};

export function createLoopEngine(ctx: Context): Engine {
  // what the engine itself says in the conversation, in the person's language
  const words = () => LOOP_WORDS((ctx.get("settings") as { locale?: () => string } | undefined)?.locale?.());
  return {
    id: "loop",
    title: "Tomrade loop",
    usesModels: true,
    steers: true,
    media: options => {
      const parsed = LoopOptions.parse(options ?? {});
      const llm = ctx.get("llm");
      const profile = llm && profileOf(llm, parsed.profile);
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
      const llm = ctx.get("llm");
      const profiles = llm?.profiles() ?? [];
      const searchesWeb = (id: string) => {
        try {
          return !!llm?.forProfile(id).capabilities.nativeWebSearch;
        } catch {
          return false;
        }
      };
      return [
        // shown even with one profile, so it's clear at a glance which model the thread uses
        ...(profiles.length > 0 ? [{ key: "profile", title: "Model", choices: profiles.map((p) => ({ value: p.id, label: p.title, ...(searchesWeb(p.id) ? { searchesWeb: true } : {}) })) }] : []),
        { key: "effort", title: "Effort", choices: [{ value: "minimal" }, { value: "low" }, { value: "medium" }, { value: "high" }] }
      ];
    },
    async turn(input: TurnInput, io: TurnIO): Promise<TurnResult> {
      if (!io.llm) return { stop: "error", error: "no language model available" };
      const options = LoopOptions.parse(input.options ?? {});
      const profileId = profileOf(io.llm, options.profile);
      if (!profileId) return { stop: "error", error: "no language model profile configured" };
      const model = io.llm.forProfile(profileId);
      // Off for the rest of the turn once the provider turns its own search down.
      let nativeSearch = !!model.capabilities.nativeWebSearch;
      const described = io.tools.describe().sort((a, b) => a.name.localeCompare(b.name));
      // A kit this kind of conversation does not carry stays out of every request until the model loads it.
      const deferred = new Map(deferredTools(described, input.purpose, input.messages).map((t) => [t.name, t]));
      const load = (names: readonly string[]) => names.filter((name) => deferred.delete(name));
      const offered = (): ToolSpec[] => {
        if (!model.capabilities.tools) return [];
        const carried = described.filter((t) => !deferred.has(t.name) && !(nativeSearch && t.name === WEB_SEARCH)).map(spec);
        carried.push(makeMediaSpec);
        return deferred.size ? [...carried, loadToolsSpec([...deferred.values()], io.tools.kits?.())] : carried;
      };
      const whole = new Set(described.filter((t) => t.whole).map((t) => t.name));
      const messages = historyMessages(input.messages, io, model.capabilities.mediaInput ?? []);
      // A workflow that finished on the user's answer may have spoken last. A request may not end on the
      // assistant: thinking-mode endpoints read it as an unfinished turn and refuse it without its reasoning.
      if (messages.at(-1)?.role === "assistant") messages.push({ role: "user", content: [{ type: "text", text: "(That ran in reply to the user's last message. Reply to the user now.)" }] });
      const usage = { inputTokens: 0, outputTokens: 0 };
      // Only what the provider reported: a profile whose endpoint says nothing about its cache gets no counts, not zeros.
      const cache: { cacheReadTokens?: number; cacheWriteTokens?: number } = {};
      const spent = (): Pick<TurnResult, "usage" | "metrics"> =>
        cache.cacheReadTokens !== undefined || cache.cacheWriteTokens !== undefined ? { usage, metrics: { transport: "http", runtime: "warm", ...cache } } : { usage };
      // Dropped for the rest of the turn once the model has thought its way past the output limit.
      let effort = options.effort;
      let invalidStreak = 0;
      // What each read call answered this turn; a write clears it, since the answer may have changed.
      const memo = new Map<string, string>();
      // What the last request cost in input tokens; 0 until a provider reports it.
      let lastInput = 0;
      // "profile kind" a provider turned down; that profile is not asked for that kind again this turn.
      const refused = new Set<string>();
      const llm = io.llm;
      // Times plugins kept this turn going past where the model would have stopped.
      let continued = 0;
      const about = (step: number): AgentTurnInfo => ({ runId: io.run.id, threadId: input.threadId, projectId: input.projectId, purpose: input.purpose, profile: profileId, step });
      const makeMedia = async (kind: OutputModality, prompt: string): Promise<{ content: string; isError?: boolean }> => {
        if (!io.media) throw new Error("This runtime cannot publish media");
        // The thread's own model first, then any other profile that makes this kind (an Image API profile for pictures).
        const makers = [profileId, ...llm.profiles().map((p) => p.id).filter((id) => id !== profileId)].filter((id) => !refused.has(`${id} ${kind}`) && makes(llm, id, kind));
        for (const id of makers) {
          let made;
          try {
            made = await collect(llm.forProfile(id).chat({ system: MAKER_SYSTEM[kind], messages: [userMessage(prompt)], maxTokens: options.maxTokens, mediaOutput: [kind] }, io.signal));
          } catch (err) {
            if (!(err instanceof NativeMediaRefused)) throw err;
            if (id === profileId) io.emit({ type: "note", text: words()(kind === "image" ? "imageRefused" : "audioRefused") });
            refused.add(`${id} ${kind}`);
            continue;
          }
          usage.inputTokens += made.usage.inputTokens;
          usage.outputTokens += made.usage.outputTokens;
          const shown = (made.media ?? []).map((media) => io.media!.publish(media));
          if (!shown.length) return { content: `ERROR: the ${kind} model answered without one${made.text.trim() ? `: ${made.text.trim()}` : ""}`, isError: true };
          return { content: `Shown in the conversation: ${shown.map((m) => `${m.name} (media ID ${m.id})`).join(", ")}.${made.text.trim() ? ` The model said: ${made.text.trim()}` : ""}` };
        }
        io.emit({ type: "note", text: words()(kind === "image" ? "noImageMaker" : "noAudioMaker") });
        return { content: `ERROR: no model profile here can make ${kind === "image" ? "images" : "audio"}. The person has been told how to add one; do not call ${MAKE_MEDIA} for it again this turn, and answer in words.`, isError: true };
      };

      for (let step = 1; step <= options.maxSteps; step += 1) {
        const chars = sizeOf(messages);
        // Characters per token varies by language; trust what the provider measured when it said.
        const tokens = Math.max(lastInput, Math.ceil(chars / 4));
        if (tokens > CONTEXT_BUDGET && elideOldResults(messages, Math.ceil(chars * (1 - CONTEXT_TARGET / tokens))) > 0)
          // A remembered answer may be one just dropped; the model must be free to ask again.
          memo.clear();
        // Plugins see each step's request before it is sent, and what they hand back is what goes.
        let request = await shape(ctx, { system: system(input, io, options), tools: offered(), messages: [...messages], turn: about(step) });
        let chat = model;
        let collected;
        let again = false;
        for (let attempt = 0; ; attempt += 1) {
          try {
            collected = await collect(
              chat.chat(
                {
                  system: request.system,
                  messages: request.messages,
                  tools: request.tools,
                  toolChoice: invalidStreak >= 2 ? "none" : undefined,
                  maxTokens: options.maxTokens,
                  effort,
                  ...(nativeSearch ? { webSearch: true } : {})
                },
                io.signal
              ),
              (delta) => io.delta(delta),
              ({ attempt, max, reason, delayMs }) => io.retry?.({ attempt, max, reason, delayMs })
            );
            break;
          } catch (err) {
            // Refused for media it cannot read: the same step again without it, said once per kind.
            if (err instanceof MediaRefused && withoutMedia(messages, err.kinds) > 0) {
              const w = words();
              io.emit({ type: "note", text: w("mediaRefused", { kinds: err.kinds.map((kind) => w(`kind_${kind}`)).join(w("kindJoin")) }) });
              again = true;
              break;
            }
            // Refused before anything streamed: the same step again, searching through the plugin.
            if (err instanceof NativeSearchRefused && nativeSearch) {
              nativeSearch = false;
              io.emit({ type: "note", text: words()("nativeSearchRefused") });
              again = true;
              break;
            }
            // A plugin may know what to try instead: a changed request, another model, or both. A stopped turn stays stopped.
            if (io.signal.aborted) throw err;
            const retry = attempt < RETRIES_PER_STEP ? await asked(ctx, "agent/request-error", () => ctx.serial("agent/request-error", { error: err, request, attempt })) : undefined;
            if (!retry) throw err;
            if (retry.profile) {
              try {
                chat = llm.forProfile(retry.profile);
              } catch (cause) {
                ctx.logger("engine-loop").warn(`agent/request-error named the model profile "${retry.profile}": ${messageOf(cause)}`);
              }
            }
            request = { ...request, ...retry.request, turn: request.turn };
          }
        }
        if (again) {
          step -= 1;
          continue;
        }
        if (!collected) throw new Error("the model request ended without a reply");
        lastInput = collected.usage.inputTokens;
        // a reply with only tool calls streams no text; it still means the request went through
        io.retry?.(null);
        usage.inputTokens += collected.usage.inputTokens;
        usage.outputTokens += collected.usage.outputTokens;
        for (const key of ["cacheReadTokens", "cacheWriteTokens"] as const) {
          const n = collected.usage[key];
          if (n !== undefined) cache[key] = (cache[key] ?? 0) + n;
        }
        io.progress(usage);
        if (collected.text.trim()) io.emit({ type: "text", text: collected.text.trim() });
        for (const media of collected.media ?? []) {
          if (!io.media) throw new Error("This runtime cannot publish media");
          io.media.publish(media);
        }
        if (collected.stop === "refusal") return { stop: "error", error: "the model declined to answer", ...spent() };
        // Cut off with no call to make. Ending as "done" here read as the agent going quiet mid-task.
        if (collected.stop === "max_tokens" && !collected.toolCalls.length) {
          // Nothing but reasoning, which is never kept: the same step again, without extended thinking.
          if (effort && !collected.text.trim()) {
            effort = undefined;
            io.emit({ type: "note", text: words()("retryWithoutThinking") });
            continue;
          }
          return {
            stop: "error",
            error: words()(collected.text.trim() ? "outputLimitMidAnswer" : "outputLimitBeforeAnswer", { max: options.maxTokens }),
            ...spent()
          };
        }
        if (!collected.toolCalls.length) {
          // A message that came in while the model wrote its last reply still belongs to this turn.
          const late = io.takeSteers?.() ?? [];
          if (late.length) {
            messages.push(assistantMessage(collected), { role: "user", content: [steering(late, !!collected.text.trim())] });
            continue;
          }
          // A plugin whose condition does not hold yet keeps the turn going, a few times at most.
          const text = collected.text;
          const more = continued < CONTINUES_PER_TURN ? await asked(ctx, "agent/turn-stopping", () => ctx.serial("agent/turn-stopping", { text, turn: about(step), continued })) : undefined;
          if (!more?.continue) return { stop: "end", ...spent() };
          continued += 1;
          io.emit({ type: "note", text: words()("keptGoing") });
          messages.push(assistantMessage(collected), { role: "user", content: [{ type: "text", text: more.continue }] });
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
            if (call.name === LOAD_TOOLS) {
              const kit = (call.args as { kit?: unknown }).kit;
              const loaded = load([...deferred.values()].filter((t) => t.kit === kit).map((t) => t.name));
              return loaded.length
                ? { id: call.id, suspended: false, content: `Loaded ${loaded.join(", ")}: call them directly.`, invalid: false }
                : { id: call.id, suspended: false, content: `ERROR: no kit "${String(kit)}" left to load`, isError: true, invalid: true };
            }
            if (call.name === MAKE_MEDIA) {
              const { kind, prompt } = call.args as { kind?: unknown; prompt?: unknown };
              if ((kind !== "image" && kind !== "audio") || typeof prompt !== "string" || !prompt.trim())
                return { id: call.id, suspended: false, content: `ERROR: ${MAKE_MEDIA} needs kind ("image" or "audio") and a prompt`, isError: true, invalid: true };
              try {
                return { id: call.id, suspended: false, ...(await makeMedia(kind, prompt)), invalid: false };
              } catch (err) {
                return { id: call.id, suspended: false, content: `ERROR: ${err instanceof Error ? err.message : String(err)}`, isError: true, invalid: false };
              }
            }
            const key = READ_TOOL.test(call.name) ? `${call.name} ${JSON.stringify(call.args)}` : null;
            if (key && memo.has(key)) return { id: call.id, suspended: false, content: "(identical to an earlier call this turn — nothing has changed since; use the result you already have)", invalid: false };
            try {
              const result = await io.tools.execute(call.name, call.args);
              // A playbook names the tools its method uses: opening it brings them in.
              if (call.name === "open_playbook") load(io.playbooks.index().find((p) => p.id === (call.args as { id?: unknown }).id)?.tools ?? []);
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
          return { stop: "asked", ...spent() };
        }
        const steered = io.takeSteers?.() ?? [];
        if (steered.length) answered.content.push(steering(steered));
        messages.push(answered);
        if (step === options.maxSteps - 1)
          messages.push({ role: "user", content: [{ type: "text", text: "(budget nearly spent: wrap up — summarize what happened, make no more writes)" }] });
      }
      return { stop: "budget", ...spent() };
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
