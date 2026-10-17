import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { attachedMedia, deferredTools, describeFailure, kitLines, stepHint, stepSummary, withRecap, type TurnIO, type TurnInput, type TurnMetrics, type TurnResult } from "@tomradex/agent";
import { bindTurn, lineSplitter, localCli, runtimeDirectory, sessionSystem, spawnCli, stopCli, turnPrompt, type CliLaunch, type Runtime } from "@tomradex/engine-claude-code";
import type {} from "@tomradex/mcp";
import type {} from "@tomradex/tools";
import { bridgeSource } from "./bridge.js";
import { PiOptions, toolSelection } from "./options.js";

type Json = Record<string, any>;
interface Usage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }

const DIALOGS = new Set(["confirm", "select", "input", "editor"]);

/** How one pi process starts: which file, with what environment, and the model flags for this thread. */
export interface PiLaunch {
  launch: CliLaunch;
  env?: NodeJS.ProcessEnv;
  args: string[];
}

/** The person's own pi, found like any local CLI, with the model and effort the thread picked. */
export async function ownPi(input: TurnInput): Promise<PiLaunch> {
  const options = PiOptions.parse(input.options ?? {});
  return {
    launch: await localCli("pi").launch(options.command),
    args: [...(options.model ? ["--model", options.model] : []), ...(options.effort ? ["--thinking", options.effort] : [])]
  };
}

/** Whether a session holds reasoning written by another model than the one pi now runs, which pi sends on as plain text. */
export function reasonedElsewhere(messages: Json[], model: Json | undefined): boolean {
  if (!model) return false;
  return messages.some((m) => m.role === "assistant"
    && (m.provider !== model.provider || m.model !== model.id || (!!m.api && !!model.api && m.api !== model.api))
    && (m.content ?? []).some((b: Json) => b.type === "thinking" && !b.redacted && String(b.thinking ?? "").trim()));
}

/** One `pi --mode rpc` process owned by Tomrade for one thread; its session lives in pi's own store. */
export class PiRuntime implements Runtime {
  token: string;
  cwd: string;
  alive = true;
  busy = false;
  session?: string;
  /** The files index this session was opened with, so a later turn can notice it went stale. */
  indexDigest: string | null = null;
  /** Holds the bridge extension and the appended system prompt; private to this process. */
  private dir: string;
  private child?: ChildProcessWithoutNullStreams;
  private seq = 0;
  /** This session was started without resume and has not had its first prompt yet. */
  private fresh = false;
  private pending = new Map<string, { resolve(value: Json): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private onEvent?: (event: Json) => void;
  private onFailure?: (error: Error) => void;
  private activeIO?: TurnIO;
  private stderr = "";

  constructor(private ctx: Context, input: TurnInput, private start: (input: TurnInput) => Promise<PiLaunch> = ownPi) {
    const directory = runtimeDirectory(input);
    this.token = directory.token; this.cwd = directory.cwd;
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pi-"));
  }

  close(): void {
    // The process may have died first; its folder still holds the run token.
    fs.rmSync(this.dir, { recursive: true, force: true });
    if (!this.alive) return;
    this.alive = false;
    this.fail(new Error("Pi runtime closed"));
    const child = this.child;
    child?.stdin.end();
    if (child) {
      stopCli(child, "SIGTERM");
      setTimeout(() => stopCli(child, "SIGKILL"), 3000).unref();
    }
  }

  private fail(error: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.onFailure?.(error);
  }

  private send(value: unknown): void {
    if (!this.alive || !this.child?.stdin.writable) throw new Error("Pi connection is closed");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }

  private request(type: string, payload: Json = {}): Promise<Json> {
    return new Promise((resolve, reject) => {
      const id = `tomrade-${++this.seq}`;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi ${type} timed out`)); }, 60_000).unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, type, ...payload }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error as Error); }
    });
  }

  private receive(line: string): void {
    let msg: Json;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "response") {
      const pending = msg.id ? this.pending.get(msg.id) : undefined;
      if (!pending) return;
      this.pending.delete(msg.id); clearTimeout(pending.timer);
      if (msg.success === false) pending.reject(new Error(msg.error ?? `Pi refused ${msg.command}`));
      else pending.resolve(msg.data ?? {});
    } else if (msg.type === "extension_ui_request") {
      void this.dialog(msg).catch((error) => { this.fail(new Error(String(error))); this.close(); });
    } else this.onEvent?.(msg);
  }

  /** An extension asking the person something: answered through the run's permission prompt, otherwise cancelled. */
  private async dialog(request: Json): Promise<void> {
    const io = this.activeIO;
    if (!DIALOGS.has(request.method)) {
      if (io && request.method === "notify" && (request.notifyType === "warning" || request.notifyType === "error")) io.emit({ type: "note", text: `Pi: ${request.message}` });
      return;
    }
    const choices: string[] = request.method === "confirm" ? ["Allow once", "Deny"] : request.method === "select" ? request.options ?? [] : [];
    const text = [request.title, request.message].filter(Boolean).join("\n");
    const answer = io && choices.length && !io.signal.aborted ? await io.requestPermission?.(text, choices, io.signal) ?? null : null;
    const reply = answer === null || io?.signal.aborted ? { cancelled: true }
      : request.method === "confirm" ? { confirmed: answer === "Allow once" } : { value: answer };
    if (this.alive) this.send({ type: "extension_ui_response", id: request.id, ...reply });
  }

  private async spawn(input: TurnInput, io: TurnIO): Promise<void> {
    this.session = io.resume ?? randomUUID();
    const bridge = path.join(this.dir, "tomrade.ts");
    const system = path.join(this.dir, "system.md");
    const approval = input.permissionMode === "ask";
    const listed = io.tools.describe();
    const shown = new Set(listed.map((t) => t.name));
    const deferred = deferredTools(listed, input.purpose, input.messages);
    const hidden = this.ctx.tools.served("run").map((t) => t.name).filter((name) => !shown.has(name));
    fs.writeFileSync(bridge, bridgeSource({ url: this.ctx.mcp.url!, token: this.token, approval, deferred: deferred.map((t) => t.name), hidden, kits: kitLines(deferred, io.tools.kits?.(), { names: false }) }), { mode: 0o600 });
    fs.writeFileSync(system, sessionSystem(input, "Pi"), { mode: 0o600 });
    const tools = toolSelection(input);
    const start = await this.start(input);
    const args = ["--mode", "rpc", "-e", bridge, "--session-id", this.session, "--append-system-prompt", system, ...start.args, ...(tools ? ["--tools", tools] : [])];
    // The token tells the person's own Tomrade extension, if any, that the bridge holds this session.
    const child = spawnCli(start.launch, args, { cwd: this.cwd, env: { ...process.env, ...start.env, ...input.env, TOMRADE_MCP_TOKEN: this.token }, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.stdout.on("data", lineSplitter((line) => { try { this.receive(line); } catch (error) { this.fail(new Error(String(error))); this.close(); } }));
    child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk.toString()).slice(-2000); });
    child.on("error", (error) => { this.fail(error); this.close(); });
    child.stdin.on("error", (error) => { this.fail(error); this.close(); });
    child.on("close", (code) => { this.fail(new Error(`Pi exited with ${code}: ${this.stderr.slice(-400)}`)); this.alive = false; });
    this.indexDigest = input.filesIndex?.digest ?? null;
  }

  async turn(input: TurnInput, io: TurnIO, warm: boolean): Promise<TurnResult> {
    this.activeIO = io;
    const start = performance.now();
    const metrics: TurnMetrics = { transport: "rpc", runtime: warm ? "warm" : "cold", toolCalls: 0, compactions: 0 };
    const binding = bindTurn(this.ctx, this.token, io, input);
    const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const add = (usage: Usage | undefined) => {
      total.input += usage?.input ?? 0; total.output += usage?.output ?? 0;
      total.cacheRead += usage?.cacheRead ?? 0; total.cacheWrite += usage?.cacheWrite ?? 0;
      total.cost += usage?.cost?.total ?? 0;
    };
    // Cached prompt tokens are context the model read, so the ↑ figure counts them.
    const counted = (streaming?: Usage) => ({
      inputTokens: total.input + total.cacheRead + total.cacheWrite + (streaming?.input ?? 0) + (streaming?.cacheRead ?? 0) + (streaming?.cacheWrite ?? 0),
      outputTokens: total.output + (streaming?.output ?? 0)
    });
    let last: Json | undefined;
    let retryError: string | undefined;
    let prompted = false;
    let cancelled = io.signal.aborted;
    let abortTimer: NodeJS.Timeout | undefined;
    let finish!: (value: TurnResult) => void;
    const done = new Promise<TurnResult>((resolve) => { finish = resolve; });
    const result = (stop: TurnResult["stop"], error?: string, details?: string): TurnResult => ({
      stop, ...(error ? { error } : {}), ...(details ? { details } : {}), usage: counted(), ...(total.cost > 0 ? { costUsd: total.cost } : {}), resume: this.session,
      metrics: { ...metrics, uncachedInputTokens: total.input, cacheReadTokens: total.cacheRead, cacheWriteTokens: total.cacheWrite }
    });
    const calls = new Map<string, unknown>();
    // Messages sent into this turn that pi has queued and not yet put before the model.
    const forwarded: { id: string; text: string }[] = [];
    let settled = false;
    io.steerTo?.(async (steer) => {
      if (!prompted || settled || cancelled || !this.alive) return false;
      // known before the request: pi may put it before the model before it answers
      forwarded.push(steer);
      const reply = await this.request("steer", { message: steer.text }).catch(() => ({}) as Json);
      if (reply.disposition === "queued") return true;
      const at = forwarded.indexOf(steer);
      if (at >= 0) forwarded.splice(at, 1);
      return false;
    });
    this.onFailure = (error) => finish(cancelled ? result("cancelled") : result("error", error.message, describeFailure({ error, stderr: this.stderr })));
    // The model's last reply without its text: provider, model, stop reason and Pi's own error words.
    const lastSaid = () => { if (!last) return undefined; const { content: _, ...rest } = last; return rest; };
    this.onEvent = (event) => {
      switch (event.type) {
        case "message_start": {
          // pi puts a queued steer before the model as a user message: that is where it was read
          const message = event.message;
          if (message?.role !== "user" || !forwarded.length) break;
          const text = (typeof message.content === "string" ? message.content : (message.content ?? []).filter((b: Json) => b.type === "text").map((b: Json) => b.text).join("")).trim();
          const at = forwarded.findIndex((s) => s.text === text);
          if (at >= 0) io.steered?.(forwarded.splice(at, 1)[0].id);
          break;
        }
        case "message_update": {
          const update = event.assistantMessageEvent;
          if (update?.type === "text_delta") {
            metrics.firstTokenMs ??= performance.now() - start;
            io.delta(update.delta);
          }
          if (event.usage) io.progress(counted(event.usage));
          break;
        }
        case "message_end": {
          const message = event.message;
          if (message?.role !== "assistant") break;
          last = message;
          add(message.usage);
          metrics.providerModel = `${message.provider}/${message.responseModel ?? message.model}`;
          const text = (message.content ?? []).filter((block: Json) => block.type === "text").map((block: Json) => block.text).join("").trim();
          if (text) io.emit({ type: "text", text });
          io.progress(counted());
          break;
        }
        case "tool_execution_start": {
          if (!event.parentToolCallId) metrics.toolCalls!++;
          calls.set(event.toolCallId, event.args);
          // Tomrade's own tools are traced by the gateway they run through.
          if (!String(event.toolName).startsWith("mcp__tomrade__")) {
            const hint = stepHint(event.args, 60);
            io.activity?.(hint ? `${event.toolName} · ${hint}` : event.toolName);
          }
          break;
        }
        case "tool_execution_end":
          if (!String(event.toolName).startsWith("mcp__tomrade__")) {
            const args = calls.get(event.toolCallId) ?? {};
            io.emit({ type: "trace", tool: event.toolName, args, ok: !event.isError, summary: stepSummary(args, event.result, !event.isError), ms: Math.round(event.durationMs ?? 0) });
          }
          calls.delete(event.toolCallId);
          if (!calls.size) io.activity?.(null);
          break;
        case "compaction_end":
          if (event.result) { metrics.compactions!++; add(event.result.usage); }
          break;
        case "auto_retry_start":
          io.retry?.({ attempt: event.attempt ?? 1, ...(event.maxAttempts ? { max: event.maxAttempts } : {}), reason: String(event.errorMessage ?? "request failed"), ...(event.delayMs !== undefined ? { delayMs: event.delayMs } : {}) });
          break;
        case "auto_retry_end":
          if (!event.success) retryError = event.finalError;
          else io.retry?.(null);
          break;
        case "agent_settled":
          settled = true;
          if (cancelled || event.aborted) finish(result("cancelled"));
          else if (last?.stopReason === "error") finish(result("error", last.errorMessage ?? retryError ?? "Pi reported an error", describeFailure({ reply: lastSaid(), retries: retryError, stderr: this.stderr })));
          else if (last?.stopReason === "length") finish(result("error", "The model reached its output limit before it finished"));
          else finish(result(binding.asked() ? "asked" : "end"));
          break;
      }
    };
    const abort = () => {
      cancelled = true;
      if (!prompted) { this.close(); return; }
      // pi carries on with queued messages after an abort; the ones it has not read go back to the person
      const cleared = forwarded.length ? this.request("clear_queue").catch(() => ({})) : Promise.resolve({});
      void cleared.then(() => this.request("abort")).catch(() => this.close());
      abortTimer ??= setTimeout(() => this.close(), 5000).unref();
    };
    io.signal.addEventListener("abort", abort, { once: true });
    try {
      if (cancelled) return { stop: "cancelled", resume: this.session, metrics };
      if (!this.child) {
        await this.spawn(input, io);
        this.fresh = !io.resume;
        if (io.resume) {
          const messages: Json[] = (await this.request("get_messages")).messages ?? [];
          // pi opens an empty session under an id it has no file for, and only warns on stderr
          if (!messages.length) {
            this.close();
            return { stop: "error", error: `Pi has no session ${io.resume}`, lostSession: true, metrics };
          }
          // pi would replay another model's reasoning to this one as its own reply text, and the model copies it
          if (reasonedElsewhere(messages, (await this.request("get_state")).model)) {
            await this.request("new_session");
            this.session = (await this.request("get_state")).sessionId ?? randomUUID();
            this.fresh = true;
          }
        }
      }
      const images = attachedMedia(input, io).filter((media) => media.mime.startsWith("image/")).map((media) => ({ type: "image", data: media.base64, mimeType: media.mime }));
      const stale = !!input.filesIndex && !!this.indexDigest && input.filesIndex.digest !== this.indexDigest;
      prompted = true;
      const message = turnPrompt(input, io, { staleIndex: stale });
      const accepted = await this.request("prompt", { message: this.fresh ? withRecap(io.recap?.(), message) : message, ...(images.length ? { images } : {}) });
      this.fresh = false;
      metrics.readyMs = performance.now() - start;
      if (accepted.disposition === "handled") finish(result("end"));
      else if (accepted.disposition !== "started") throw new Error(`Pi did not start the turn (${accepted.disposition ?? "no disposition"})`);
      const outcome = await done;
      if (outcome.stop === "error") this.close();
      return outcome;
    } catch (error) {
      this.close();
      return cancelled ? result("cancelled") : result("error", error instanceof Error ? error.message : String(error), describeFailure({ error, stderr: this.stderr }));
    } finally {
      io.signal.removeEventListener("abort", abort); clearTimeout(abortTimer);
      this.onEvent = undefined; this.onFailure = undefined; this.activeIO = undefined;
      await binding.release();
    }
  }
}
