import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Context } from "cordis";
import { attachedMedia, describeFailure, withRecap, type TurnIO, type TurnInput, type TurnMetrics, type TurnResult } from "@tomradex/agent";
import { bindTurn, runtimeDirectory, sessionSystem, spawnCli, stopCli, turnPrompt, type Runtime } from "@tomradex/engine-claude-code";
import type {} from "@tomradex/mcp";
import { isTomradeTool, policyOf, wrappedTool, type AcpAgent, type AcpOptions, type Catalog, type Policy, type RequestUsage } from "./agent.js";
import { AcpConnection, AcpError, AUTH_REQUIRED, type AcpPeer } from "./connection.js";

type Json = Record<string, any>;

/** What Hermes answers a `/steer` with (acp_adapter/commands.py): said to the client, never part of the reply. */
const STEER_QUEUED = "⏩ Steer queued for the active turn: ";
const STEER_SAID = /^(⏩ Steer queued for the active turn: |⚠️ Steer failed: |No active turn — queued for the next turn\.)/;

/** A steer as the agent gets it: as written, plus a word for when it lands after the reply was finished. */
const steerText = (text: string) => `${text}\n\n(Sent while you were working. If your reply is already finished, answer only what this adds or changes; do not repeat it.)`;

/** Kinds that only look; a read-only turn lets them through. */
const LOOKS = new Set(["read", "search", "think", "fetch"]);

/** Session settings by what they are: agents name them differently but tag them with these categories. */
const SETTINGS = {
  mode: { category: "mode", ids: ["mode"] },
  model: { category: "model", ids: ["model"] },
  effort: { category: "thought_level", ids: ["reasoning_effort", "effort", "thought_level"] }
};
type Setting = keyof typeof SETTINGS;

/** A select's choices, its groups flattened. */
const choicesOf = (option: Json): Json[] => (option.options ?? []).flatMap((entry: Json) => (Array.isArray(entry.options) ? entry.options : [entry]));

/**
 * The choice a typed value means: its exact value, its name, or — for agents
 * whose values encode `[provider, model]` — the model or `provider/model`.
 */
export function resolveChoice(option: Json, value: string): string | undefined {
  const choices = choicesOf(option);
  const wanted = value.trim().toLowerCase();
  const exact = choices.find((choice) => String(choice.value) === value) ?? choices.find((choice) => String(choice.name ?? "").toLowerCase() === wanted);
  if (exact) return String(exact.value);
  return choices.find((choice) => {
    try {
      const parts = JSON.parse(String(choice.value));
      return Array.isArray(parts) && (parts.map(String).join("/").toLowerCase() === wanted || String(parts.at(-1)).toLowerCase() === wanted);
    } catch { return false; }
  })?.value;
}

/** A choice's name, with a short description such as a credit multiplier. */
const labelOf = (value: string, name?: string, description?: string | null): string | undefined => {
  const base = name && name !== value ? name : undefined;
  if (description && description.length <= 24) return `${base ?? value} · ${description}`;
  return base;
};

interface Call { name: string; title: string; kind?: string; args: unknown; at: number; done?: boolean }

/** One ACP agent process owned by Tomrade for one thread; the session itself lives in the agent's own store. */
export class AcpRuntime implements Runtime {
  token: string;
  cwd: string;
  alive = true;
  busy = false;
  session?: string;
  /** The files index this session was opened with, so a later turn can notice it went stale. */
  indexDigest: string | null = null;
  private child?: ChildProcessWithoutNullStreams;
  private conn?: AcpConnection;
  private caps: Json = {};
  private config: Json[] = [];
  private modes?: Json;
  private models?: Json;
  /** A session this process started rather than reopened: its first prompt carries Tomrade's instructions. */
  private brief = false;
  private io?: TurnIO;
  private policy: Policy = "full-access";
  private calls = new Map<string, Call>();
  /** What Tomrade or the person refused this turn, by label and by call; some agents end the turn on a refusal. */
  private refused: string[] = [];
  private refusedCalls = new Set<string>();
  private listener?: (update: Json) => void;
  /** The last running totals an agent reported, to tell one turn's share. */
  private sessionUsage?: RequestUsage;
  private sessionCost?: number;

  constructor(private ctx: Context, private agent: AcpAgent<any>, private catalog: Catalog, input: TurnInput) {
    const directory = runtimeDirectory(input);
    this.token = directory.token; this.cwd = directory.cwd;
  }

  close(): void {
    if (!this.alive) return;
    this.alive = false;
    this.conn?.close(new Error(`${this.agent.title} runtime closed`));
    const child = this.child;
    if (child) {
      child.stdin.end();
      stopCli(child, "SIGTERM");
      setTimeout(() => stopCli(child, "SIGKILL"), 3000).unref();
    }
  }

  private peer: AcpPeer = {
    notification: (method, params) => {
      if (method !== "session/update" || !this.session || params.sessionId !== this.session) return;
      const update: Json = params.update ?? {};
      if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) this.config = update.configOptions;
      else if (update.sessionUpdate === "current_mode_update" && this.modes) this.modes = { ...this.modes, currentModeId: update.currentModeId };
      else this.listener?.(update);
    },
    request: (method, params) =>
      method === "session/request_permission" ? this.permission(params) : Promise.reject(new AcpError(`Tomrade does not offer ${method}`, -32601)),
    closed: () => { this.alive = false; }
  };

  /** Tomrade's tools always run; otherwise the turn's policy answers, or the person does. */
  private async permission(params: Json): Promise<Json> {
    const io = this.io;
    const options: Json[] = Array.isArray(params.options) ? params.options : [];
    const pick = (...kinds: string[]) => kinds.map((kind) => options.find((option) => option.kind === kind)).find(Boolean);
    const answer = (option?: Json) => ({ outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } });
    if (!io || io.signal.aborted || params.sessionId !== this.session) return answer();
    const known = this.calls.get(params.toolCall?.toolCallId);
    const call = { name: params.toolCall?.name ?? known?.name ?? this.nameOf(params.toolCall?.toolCallId), title: params.toolCall?.title ?? known?.title, kind: params.toolCall?.kind ?? known?.kind, args: params.toolCall?.rawInput ?? known?.args };
    const label = wrappedTool(call.args) ?? (call.title || call.name || "a tool");
    const refuse = () => {
      this.refused.push(label);
      if (typeof params.toolCall?.toolCallId === "string") this.refusedCalls.add(params.toolCall.toolCallId);
      return answer(pick("reject_once", "reject_always"));
    };
    if (isTomradeTool(call) || this.policy === "full-access") return answer(pick("allow_once", "allow_always"));
    if (this.policy === "read-only") return LOOKS.has(call.kind ?? "") ? answer(pick("allow_once", "allow_always")) : refuse();
    const details = call.args === undefined ? "" : `\n${JSON.stringify(call.args, null, 2).slice(0, 2000)}`;
    const said = await io.requestPermission?.(`${this.agent.title}: ${label}${details}`, options.map((option) => option.name), io.signal) ?? null;
    if (io.signal.aborted) return answer();
    const chosen = said === null ? undefined : options.find((option) => option.name === said);
    return chosen && !chosen.kind?.startsWith("reject") ? answer(chosen) : refuse();
  }

  private nameOf(toolCallId: unknown): string | undefined {
    return typeof toolCallId === "string" ? this.agent.callName?.(toolCallId) : undefined;
  }

  private option(setting: Setting): Json | undefined {
    const { category, ids } = SETTINGS[setting];
    return this.config.find((option) => option.type === "select" && (option.category === category || ids.includes(option.id)));
  }

  private async setOption(option: Json, value: string): Promise<void> {
    const result = await this.conn!.request("session/set_config_option", { sessionId: this.session, configId: option.id, value });
    if (Array.isArray(result?.configOptions) && result.configOptions.length) this.config = result.configOptions;
    else option.currentValue = value;
  }

  /** What the session advertised feeds the picks the next time they are drawn. */
  private learn(): void {
    const model = this.option("model");
    const models = model
      ? choicesOf(model).map((choice) => ({ value: String(choice.value), label: labelOf(String(choice.value), choice.name, choice.description) }))
      : (this.models?.availableModels ?? []).map((m: Json) => ({ value: String(m.modelId), label: labelOf(String(m.modelId), m.name, m.description) }));
    if (models.length) this.catalog.models = models;
    const effort = this.option("effort");
    if (effort) this.catalog.efforts = choicesOf(effort).map((choice) => ({ value: String(choice.value), label: labelOf(String(choice.value), choice.name) }));
  }

  /** The agent's own mode sets how much it asks. Only a failure that could leave it asking less than wanted stops the turn. */
  private async setMode(mode: string, io: TurnIO): Promise<void> {
    try {
      const option = this.option("mode");
      if (option && choicesOf(option).some((choice) => choice.value === mode)) {
        if (option.currentValue !== mode) await this.setOption(option, mode);
      } else if (this.modes?.availableModes?.some((m: Json) => m.id === mode)) {
        if (this.modes.currentModeId !== mode) await this.conn!.request("session/set_mode", { sessionId: this.session, modeId: mode });
        this.modes.currentModeId = mode;
      } else if (option || this.modes) throw new Error("it does not offer that mode");
    } catch (error) {
      if (this.policy !== "full-access") throw new Error(`${this.agent.title} did not switch to its "${mode}" mode: ${messageOf(error)}`);
      io.emit({ type: "note", text: `${this.agent.title} did not switch to its "${mode}" mode (${messageOf(error)})` });
    }
  }

  private async choose(setting: "model" | "effort", value: string, io: TurnIO): Promise<void> {
    try {
      const option = this.option(setting);
      if (option) {
        const choice = resolveChoice(option, value) ?? value;
        if (option.currentValue !== choice) await this.setOption(option, choice);
      }
      else if (setting === "model" && this.models) {
        if (this.models.currentModelId !== value) await this.conn!.request("session/set_model", { sessionId: this.session, modelId: value });
        this.models.currentModelId = value;
      } else io.emit({ type: "note", text: `${this.agent.title} offers no ${setting} setting, so it keeps its own` });
    } catch (error) {
      io.emit({ type: "note", text: `${this.agent.title} did not take ${setting} "${value}" (${messageOf(error)}); it keeps its own` });
    }
  }

  /** The reopened session; null when the agent cannot reopen one, "lost" when it tried and no longer has it. */
  private async reopen(sessionId: string, mcpServers: Json[]): Promise<Json | null | "lost"> {
    const resume = !!this.caps.sessionCapabilities?.resume && this.agent.reopen !== "load";
    const method = this.agent.reopen === "never" ? null : resume ? "session/resume" : this.caps.loadSession ? "session/load" : null;
    if (!method) return null;
    try {
      // A loaded session replays its history first; with no turn listening, the replay goes nowhere.
      const result = await this.conn!.request(method, { sessionId, cwd: this.cwd, mcpServers }, 120_000);
      // Hermes answers session/load with null for a session it no longer has
      return result && typeof result === "object" ? result : "lost";
    } catch {
      return "lost";
    }
  }

  /** False when the session in `io.resume` is gone; Tomrade then runs the turn again without it. */
  private async open(input: TurnInput, io: TurnIO, options: AcpOptions): Promise<boolean> {
    const launch = await this.agent.cli.launch(options.command);
    const child = spawnCli(launch, this.agent.args(input, options), {
      // A user-level server naming ${TOMRADE_MCP_TOKEN} (Hermes) then carries this session's token too.
      cwd: this.cwd, env: { ...process.env, ...input.env, ...this.agent.env?.(input, options), TOMRADE_MCP_TOKEN: this.token }, stdio: ["pipe", "pipe", "pipe"]
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    // CodeBuddy outlives a closed stdin; Tomrade quits without closing its runtimes, so it takes the agent down itself.
    const reap = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
    process.once("exit", reap);
    child.once("exit", () => process.off("exit", reap));
    const conn = (this.conn = new AcpConnection(child, this.peer, this.agent.title));
    const init = await conn.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "tomrade", title: "Tomrade", version: "1" }
    }, 120_000);
    if (typeof init?.protocolVersion === "number" && init.protocolVersion !== 1) throw new Error(`${this.agent.title} speaks ACP version ${init.protocolVersion}; Tomrade speaks version 1`);
    this.caps = init?.agentCapabilities ?? {};
    if (this.caps.mcpCapabilities?.http !== true && this.agent.httpMcp !== "always") throw new Error(`${this.agent.title} takes no MCP server over HTTP, so it cannot reach Tomrade's tools`);
    const mcpServers = [{ type: "http", name: "tomrade", url: this.ctx.mcp.url, headers: [{ name: "X-Tomrade-Run", value: this.token }] }];
    const reopened = io.resume ? await this.reopen(io.resume, mcpServers) : null;
    if (reopened === "lost") return false;
    const session = reopened ?? (await conn.request("session/new", { cwd: this.cwd, mcpServers }, 120_000));
    this.session = reopened ? io.resume : session?.sessionId;
    if (!this.session) throw new Error(`${this.agent.title} did not open a session`);
    this.brief = !reopened;
    this.config = Array.isArray(session.configOptions) ? session.configOptions : [];
    this.modes = session.modes ?? undefined;
    this.models = session.models ?? undefined;
    this.learn();
    this.indexDigest = input.filesIndex?.digest ?? null;
    const mode = this.agent.mode?.(this.policy);
    if (mode) await this.setMode(mode, io);
    if (options.model) await this.choose("model", options.model, io);
    if (options.effort) await this.choose("effort", options.effort, io);
    return true;
  }

  private prompt(input: TurnInput, io: TurnIO): Json[] {
    const stale = !!input.filesIndex && !!this.indexDigest && input.filesIndex.digest !== this.indexDigest;
    let text = turnPrompt(input, io, { staleIndex: stale });
    // ACP has no system prompt of its own; the session's first message carries it, and the history keeps it.
    // A new session on a thread with history (the agent cannot reopen, or the thread came from another engine) gets the conversation too.
    if (this.brief) { text = `${sessionSystem(input, this.agent.title)}\n\n${withRecap(io.recap?.(), text)}`; this.brief = false; }
    const images = attachedMedia(input, io).filter((media) => media.mime.startsWith("image/"));
    const seesImages = this.caps.promptCapabilities?.image === true;
    if (images.length && !seesImages) io.emit({ type: "note", text: `${this.agent.title} takes no images in a prompt, so the attached ones were left out` });
    return [{ type: "text", text }, ...(seesImages ? images.map((media) => ({ type: "image", data: media.base64, mimeType: media.mime })) : [])];
  }

  private explain(error: unknown): string {
    const message = innermost(messageOf(error));
    if (error instanceof AcpError && (error.code === AUTH_REQUIRED || /auth|log ?in|sign ?in|credential|api key/i.test(message))) return `${message} — ${this.agent.signIn ?? `sign in to ${this.agent.title}`}, then try again`;
    return message;
  }

  async turn(input: TurnInput, io: TurnIO, warm: boolean): Promise<TurnResult> {
    const options = this.agent.options.parse(input.options ?? {}) as AcpOptions;
    const start = performance.now();
    const metrics: TurnMetrics = { transport: "acp", runtime: warm ? "warm" : "cold", toolCalls: 0 };
    const binding = bindTurn(this.ctx, this.token, io, input);
    this.io = io; this.policy = policyOf(input, this.agent); this.calls = new Map(); this.refused = []; this.refusedCalls = new Set();
    let cancelled = io.signal.aborted;
    let prompted = false;
    let abortTimer: NodeJS.Timeout | undefined;

    let text = "";
    let messageId: string | undefined;
    const flush = () => { const said = text.trim(); text = ""; if (said) io.emit({ type: "text", text: said }); };

    const tokens: RequestUsage = { input: 0, output: 0 };
    let counted = false;
    let context: number | undefined;
    let cost: number | undefined;
    const add = (sample: RequestUsage) => {
      counted = true;
      tokens.input += sample.input; tokens.output += sample.output;
      if (sample.cacheRead !== undefined) tokens.cacheRead = (tokens.cacheRead ?? 0) + sample.cacheRead;
      if (sample.cacheWrite !== undefined) tokens.cacheWrite = (tokens.cacheWrite ?? 0) + sample.cacheWrite;
    };
    const live = () => (counted ? { inputTokens: tokens.input, outputTokens: tokens.output } : context !== undefined ? { inputTokens: context } : {});

    // Messages sent into this turn, until the agent reads them (TOM-111). CodeBuddy says so with a
    // user_message_chunk carrying the id it was given. Hermes only says it queued one; it reads it
    // before its next model request, so one acknowledged while a tool ran is read by the next
    // output, and one acknowledged mid-reply only after a tool that reply calls.
    const forwarded = new Map<string, string>();
    const acknowledged: { id: string; armed: boolean }[] = [];
    const answering: Promise<void>[] = [];
    // `/steer` prompts Hermes has not answered yet, by message id
    const unanswered = new Set<string>();
    let owner: string | undefined;
    let over = false;
    let lastWasTool = false;
    const steered = (id: string) => {
      if (!forwarded.delete(id)) return;
      flush();
      io.steered?.(id);
    };
    const readArmed = () => {
      for (const entry of acknowledged.filter((a) => a.armed)) { acknowledged.splice(acknowledged.indexOf(entry), 1); steered(entry.id); }
    };
    if (this.agent.steer) io.steerTo?.(async (steer) => {
      if (!prompted || over || cancelled || !this.conn?.alive) return false;
      const text = steerText(steer.text);
      forwarded.set(steer.id, text);
      try {
        if (this.agent.steer === "method") {
          const answer = await this.conn.request("session/steer", { sessionId: this.session, contentBlocks: [{ type: "text", text }], clientUserMessageId: steer.id, ...(owner ? { expectedRequestId: owner } : {}) });
          if (answer?.steered === true) { owner = typeof answer.ownerRequestId === "string" ? answer.ownerRequestId : owner; return true; }
        } else {
          // Answered at once while the turn runs; after it, Hermes runs it as a prompt of its own, which this turn waits out.
          unanswered.add(steer.id);
          answering.push(this.conn.request("session/prompt", { sessionId: this.session, prompt: [{ type: "text", text: `/steer ${text}` }] }, 0)
            .then((response) => this.account(response?.usage, add), () => {})
            .finally(() => unanswered.delete(steer.id)));
          return true;
        }
      } catch {}
      forwarded.delete(steer.id);
      return false;
    });

    const finishCall = (call: Call, ok: boolean) => {
      call.done = true;
      // Tomrade's own tools are traced by the gateway they run through.
      if (isTomradeTool(call)) return;
      io.emit({ type: "trace", tool: wrappedTool(call.args) ?? (call.name || call.title || "tool"), args: call.args ?? {}, ok, summary: `run by ${this.agent.title} itself`, ms: Math.round(performance.now() - call.at) });
    };
    const track = (update: Json) => {
      let call = this.calls.get(update.toolCallId);
      if (!call) {
        flush();
        call = { name: this.nameOf(update.toolCallId) ?? "", title: "", args: {}, at: performance.now() };
        this.calls.set(update.toolCallId, call);
        metrics.toolCalls!++;
      }
      if (update.name) call.name = update.name;
      if (update.title) call.title = update.title;
      if (update.kind) call.kind = update.kind;
      if (update.rawInput !== undefined && update.rawInput !== null) call.args = update.rawInput;
      if ((update.status === "completed" || update.status === "failed") && !call.done) finishCall(call, update.status === "completed");
    };

    this.listener = (update) => {
      switch (update.sessionUpdate) {
        case "user_message_chunk": {
          const id = update.messageId ?? update._meta?.["codebuddy.ai/messageId"];
          if (typeof id === "string" && forwarded.has(id)) steered(id);
          break;
        }
        case "agent_message_chunk":
          if (update.content?.type !== "text" || typeof update.content.text !== "string") break;
          if (this.agent.steer === "slash" && STEER_SAID.test(update.content.text)) {
            if (update.content.text.startsWith(STEER_QUEUED)) {
              const preview = update.content.text.slice(STEER_QUEUED.length).replace(/\.\.\.$/, "");
              const id = [...forwarded].find(([sent, said]) => !acknowledged.some((a) => a.id === sent) && said.startsWith(preview))?.[0];
              if (id) acknowledged.push({ id, armed: lastWasTool });
            }
            break;
          }
          readArmed();
          lastWasTool = false;
          if (update.messageId && messageId && update.messageId !== messageId) flush();
          messageId = update.messageId ?? messageId;
          metrics.firstTokenMs ??= performance.now() - start;
          text += update.content.text;
          io.delta(update.content.text);
          break;
        case "tool_call":
        case "tool_call_update":
          if (typeof update.toolCallId === "string") track(update);
          // a reply that calls a tool is followed by another model request, which reads what was queued
          for (const entry of acknowledged) entry.armed = true;
          lastWasTool = true;
          break;
        case "usage_update": {
          if (typeof update.used === "number") context = update.used;
          if (update.cost?.currency === "USD" && typeof update.cost.amount === "number") cost = update.cost.amount;
          const sample = typeof this.agent.usage === "function" ? this.agent.usage(update) : null;
          if (sample) add(sample);
          const now = live();
          if (now.inputTokens !== undefined) io.progress(now);
          break;
        }
      }
    };

    const result = (stop: TurnResult["stop"], error?: string, details?: string): TurnResult => {
      let costUsd: number | undefined;
      if (cost !== undefined) { costUsd = cost - (this.sessionCost ?? 0); this.sessionCost = cost; }
      if (tokens.cacheRead !== undefined) {
        metrics.cacheReadTokens = tokens.cacheRead;
        if (tokens.cacheWrite !== undefined) metrics.cacheWriteTokens = tokens.cacheWrite;
        metrics.uncachedInputTokens = Math.max(0, tokens.input - tokens.cacheRead - (tokens.cacheWrite ?? 0));
      }
      const model = this.option("model")?.currentValue ?? this.models?.currentModelId;
      if (model) metrics.providerModel = String(model);
      return {
        stop, ...(error ? { error } : {}), ...(details ? { details } : {}), ...(counted ? { usage: { inputTokens: tokens.input, outputTokens: tokens.output } } : {}),
        ...(costUsd && costUsd > 0 ? { costUsd } : {}), resume: this.session, metrics
      };
    };

    const abort = () => {
      cancelled = true;
      // An agent may go on with a message it queued once the turn is cancelled; ending it drops them (the session reopens next turn).
      if (!prompted || forwarded.size) { this.close(); return; }
      this.conn?.notify("session/cancel", { sessionId: this.session });
      abortTimer ??= setTimeout(() => this.close(), 5000).unref();
    };
    io.signal.addEventListener("abort", abort, { once: true });
    try {
      if (cancelled) return { stop: "cancelled", resume: this.session, metrics };
      if (!this.conn && !(await this.open(input, io, options))) {
        this.close();
        return { stop: "error", error: `${this.agent.title} no longer has session ${io.resume}`, lostSession: true, metrics };
      }
      metrics.readyMs = performance.now() - start;
      if (cancelled) return result("cancelled");
      const blocks = this.prompt(input, io);
      prompted = true;
      const response = await this.conn!.request("session/prompt", { sessionId: this.session, prompt: blocks }, 0);
      // a /steer Hermes never acknowledged arrived after the turn: it runs as a prompt of its own, part of this turn
      if (!cancelled && answering.length) {
        for (const id of [...unanswered]) if (!acknowledged.some((a) => a.id === id)) steered(id);
        await Promise.all(answering);
      }
      over = true;
      // what was acknowledged and then followed by a model request was read; the rest was dropped and goes back to the person
      readArmed();
      flush();
      // Hermes never reports a call's end; a turn that finished ran every call nobody refused.
      if (!cancelled) for (const [id, call] of this.calls) if (!call.done) finishCall(call, !this.refusedCalls.has(id));
      this.account(response?.usage, add);
      const stop = response?.stopReason;
      if (cancelled) return result("cancelled");
      if (stop === "cancelled") {
        // Nobody cancelled: the agent gave up on the turn, as CodeBuddy does when a tool is refused.
        if (this.refused.length) io.emit({ type: "note", text: `${this.agent.title} stopped after ${[...new Set(this.refused)].join(", ")} was refused` });
        return result(binding.asked() ? "asked" : "end");
      }
      if (stop === "max_tokens") return result("error", "The model reached its output limit before it finished");
      if (stop === "max_turn_requests") return result("budget", `${this.agent.title} reached its limit of model requests for one turn`);
      if (stop === "refusal") {
        const said = this.agent.failure?.(response);
        return result("error", said ? `${this.agent.title} stopped: ${said}` : `${this.agent.title} refused to go on`, describeFailure({ response, stderr: this.conn?.stderrTail }));
      }
      return result(binding.asked() ? "asked" : "end");
    } catch (error) {
      flush();
      const stderr = this.conn?.stderrTail;
      this.close();
      return result(cancelled ? "cancelled" : "error", cancelled ? undefined : this.explain(error), cancelled ? undefined : describeFailure({ error, stderr }));
    } finally {
      io.signal.removeEventListener("abort", abort); clearTimeout(abortTimer);
      this.listener = undefined; this.io = undefined;
      await binding.release();
    }
  }

  /** A prompt's own usage: this turn's, or the session's running total less what was already counted. */
  private account(usage: Json | null | undefined, add: (sample: RequestUsage) => void): void {
    if (!usage || typeof usage.inputTokens !== "number" || (this.agent.usage !== "turn" && this.agent.usage !== "session")) return;
    const apart = this.agent.cacheApart ? (usage.cachedReadTokens ?? 0) + (usage.cachedWriteTokens ?? 0) : 0;
    const total: RequestUsage = {
      input: usage.inputTokens + apart, output: usage.outputTokens ?? 0,
      ...(typeof usage.cachedReadTokens === "number" ? { cacheRead: usage.cachedReadTokens } : {}),
      ...(typeof usage.cachedWriteTokens === "number" ? { cacheWrite: usage.cachedWriteTokens } : {})
    };
    if (this.agent.usage === "turn") { add(total); return; }
    const before = this.sessionUsage;
    this.sessionUsage = total;
    if (!before) { add(total); return; }
    const less = (now?: number, then?: number) => (now === undefined ? undefined : Math.max(0, now - (then ?? 0)));
    add({ input: less(total.input, before.input)!, output: less(total.output, before.output)!, cacheRead: less(total.cacheRead, before.cacheRead), cacheWrite: less(total.cacheWrite, before.cacheWrite) });
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A model API's error passed on as JSON, sometimes JSON in JSON (Gemini CLI): its innermost message. */
export function innermost(message: string): string {
  let parsed: any;
  try { parsed = JSON.parse(message); } catch { return message; }
  const inner = parsed?.error?.message ?? parsed?.message;
  return typeof inner === "string" && inner.trim() ? innermost(inner.trim()) : message;
}
