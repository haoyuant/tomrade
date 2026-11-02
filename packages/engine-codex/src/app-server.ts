import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Context } from "cordis";
import type { TurnIO, TurnInput, TurnResult, TurnMetrics } from "@tomradex/agent";
import { codexMediaBlocks, codexMediaInput, publishNativeImage, withRecap } from "@tomradex/agent";
import { engineLocale, JsonLinePeer, jsonRpc, KIT_WORDS, localCli, MODE_ALLOWS, OpenAsks, RpcError, runtimeDirectory, runTurn, sessionSystem, spawnCli, stopCli, turnPrompt, type Runtime } from "@tomradex/engine-kit";
import { CODEX, CodexOptions, codexModel } from "./engine.js";
import { lostSession } from "./account.js";
import { codexRetry, codexStep } from "./steps.js";

type Json = Record<string, any>;
type Counters = { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteInputTokens?: number };
const zero = (): Counters => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });

/** One stdio connection owned by Tomrade; no shared user daemon is mutated. */
export class CodexRuntime implements Runtime {
  token: string;
  cwd: string;
  alive = true;
  busy = false;
  session?: string;
  /** The files index this session was opened with, so a later turn can notice it went stale. */
  indexDigest: string | null = null;
  private child?: ChildProcessWithoutNullStreams;
  private peer?: JsonLinePeer;
  private notification?: (method: string, params: Json) => void;
  private failure?: (error: Error) => void;
  private totals?: Counters;
  private activeIO?: TurnIO;
  /** Full access picked for the running turn, or the one it started in. */
  private fullAccess = false;
  private asks = new OpenAsks();
  private locale: string | undefined;
  private kit;

  constructor(private ctx: Context, input: TurnInput) {
    const directory = runtimeDirectory(input);
    this.token = directory.token; this.cwd = directory.cwd;
    this.locale = engineLocale(ctx);
    this.kit = KIT_WORDS(this.locale);
  }

  close(): void {
    if (!this.alive) return;
    this.alive = false;
    const error = new Error(this.kit("runtimeClosed", { name: "Codex" }));
    if (this.peer) this.peer.close(error);
    else this.failure?.(error);
    const child = this.child;
    child?.stdin.end();
    if (child) {
      stopCli(child, "SIGTERM");
      setTimeout(() => stopCli(child, "SIGKILL"), 3000).unref();
    }
  }

  private request(method: string, params: Json): Promise<Json> {
    return this.peer ? this.peer.request(method, params) : Promise.reject(new Error(this.kit("notRunning", { name: "Codex" })));
  }

  private async respondToRequest(method: string, params: Json): Promise<Json> {
    const io = this.activeIO;
    const active = io && !io.signal.aborted && (!params.threadId || params.threadId === this.session);
    const command = method === "item/commandExecution/requestApproval";
    const file = method === "item/fileChange/requestApproval";
    // Raised to Full access during the turn: Codex keeps the turn's approval policy, so Tomrade approves what it still asks.
    const allows = () => this.fullAccess;
    if (command || file) {
      const answer = !active ? null : allows() ? MODE_ALLOWS : await this.asks.ask(io,
        `${command ? "Command" : "File changes"} permission\n${JSON.stringify(params, null, 2)}`,
        ["Allow once", "Deny"], allows, io.signal);
      return { decision: (answer === "Allow once" || answer === MODE_ALLOWS) && !io?.signal.aborted ? "accept" : "decline" };
    }
    if (method === "item/permissions/requestApproval") {
      const answer = !active ? null : allows() ? MODE_ALLOWS : await this.asks.ask(io, `Additional permissions\n${JSON.stringify(params, null, 2)}`, ["Allow for this turn", "Deny"], allows, io.signal);
      return { permissions: (answer === "Allow for this turn" || answer === MODE_ALLOWS) && !io?.signal.aborted ? params.permissions : {}, scope: "turn" };
    }
    if (method === "mcpServer/elicitation/request") return { action: "cancel", content: null };
    throw new RpcError("Unsupported interactive request", -32601);
  }

  async turn(input: TurnInput, io: TurnIO, warm: boolean): Promise<TurnResult> {
    this.activeIO = io;
    const options = CodexOptions.parse(input.options ?? {});
    const start = performance.now();
    const metrics: TurnMetrics = { transport: "app-server", runtime: warm ? "warm" : "cold", toolCalls: 0, compactions: 0 };
    let usage: TurnResult["usage"];
    let interruptTimer: NodeJS.Timeout | undefined;
    // Steps Codex is running itself, until they complete.
    const started = new Map<string, Json>();
    const result = (stop: TurnResult["stop"], error?: string, details?: string): TurnResult =>
      ({ stop, ...(error ? { error } : {}), ...(details ? { details } : {}), resume: this.session, usage, metrics });
    return runTurn(io, {
      ctx: this.ctx, token: this.token, input, metrics, result,
      resume: () => this.session,
      explain: String,
      stderr: () => this.peer?.stderrTail,
      thrown: () => this.close(),
      cleanup: () => {
        for (const item of started.values()) {
          if (item.type !== "commandExecution") continue;
          const step = codexStep({ ...item, status: "interrupted" })!;
          const { label: _, ...trace } = step;
          io.emit({ type: "trace", ...trace });
        }
        if (started.size) io.activity?.(null);
        clearTimeout(interruptTimer);
        this.notification = undefined; this.failure = undefined; this.activeIO = undefined;
      }
    }, async (turn) => {
      let turnId: string | undefined;
      let baseline = this.totals;
      let finish!: (value: TurnResult) => void;
      const done = new Promise<TurnResult>((resolve) => { finish = resolve; });
      const seen = new Set<string>();
      let recap = "";
      // Codex says each failed attempt before it gives up; the last few explain the failure.
      const attempts: Json[] = [];
      const tried = () => (attempts.length ? attempts : undefined);
      // Messages sent into this turn with turn/steer, until Codex adds them to the conversation.
      const forwarded = new Map<string, string>();
      let over = false;
      this.fullAccess = input.permissionMode === "full-access";
      io.modeTo?.(async (mode) => {
        if (over || !this.alive) return false;
        // The session's sandbox and approval policy hold for this turn: Full access can be granted by approving what
        // it asks, and going back to the mode it started in undoes that; anything else waits for the next turn.
        if (mode !== "full-access" && mode !== input.permissionMode) return false;
        this.fullAccess = mode === "full-access";
        this.asks.settle();
        return true;
      });
      io.steersMedia?.();
      // Taken once Codex has started the turn: turn/steer needs its id.
      const forward: Parameters<NonNullable<TurnIO["steerTo"]>>[0] = async (steer) => {
        if (!turnId || over || turn.cancelled || !this.alive) return false;
        // known before the request: Codex may add it to the conversation before it answers
        forwarded.set(steer.id, steer.text);
        try {
          await this.request("turn/steer", { threadId: this.session, expectedTurnId: turnId, clientUserMessageId: steer.id, input: codexMediaBlocks(steer.text, steer.media ?? []) });
          return true;
        } catch (error) {
          forwarded.delete(steer.id);
          throw error;
        }
      };
      const began = (id: string) => {
        const first = !turnId;
        turnId = id;
        if (first) io.steerTo?.(forward);
      };
      this.failure = (error) => finish(turn.failed(error.message, { error, attempts: tried() }));
      const abort = () => {
        if (!turnId) { this.close(); return; }
        void this.request("turn/interrupt", { threadId: this.session, turnId }).catch(() => this.close());
        interruptTimer ??= setTimeout(() => this.close(), 3000).unref();
      };
      turn.onAbort(abort);
      this.notification = (method, params) => {
        if (params.threadId && this.session && params.threadId !== this.session) return;
        if (method === "turn/started") began(params.turn.id);
        if (method === "thread/tokenUsage/updated") {
          const total = params.tokenUsage.total as Counters;
          if (!turnId || params.turnId !== turnId) { this.totals = total; baseline = total; return; }
          if (!baseline) {
            // A resumed rollout may carry totals before this connection started.
            const last = params.tokenUsage.last as Counters;
            baseline = io.resume ? { inputTokens: total.inputTokens - last.inputTokens,
              outputTokens: total.outputTokens - last.outputTokens, cachedInputTokens: total.cachedInputTokens - last.cachedInputTokens,
              ...(total.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: total.cacheWriteInputTokens - (last.cacheWriteInputTokens ?? 0) } : {}) } : zero();
          }
          this.totals = total;
          usage = { inputTokens: Math.max(0, total.inputTokens - baseline.inputTokens), outputTokens: Math.max(0, total.outputTokens - baseline.outputTokens) };
          metrics.cacheReadTokens = Math.max(0, total.cachedInputTokens - baseline.cachedInputTokens);
          if (total.cacheWriteInputTokens !== undefined) metrics.cacheWriteTokens = Math.max(0, total.cacheWriteInputTokens - (baseline.cacheWriteInputTokens ?? 0));
          metrics.uncachedInputTokens = Math.max(0, usage.inputTokens! - metrics.cacheReadTokens);
          io.progress(usage);
        }
        if (params.turnId && turnId && params.turnId !== turnId) return;
        if (method === "error") {
          attempts.push(params); if (attempts.length > 3) attempts.shift();
          const retry = codexRetry(params);
          if (retry) io.retry?.(retry);
        } else if (method === "item/started" && params.item.type === "userMessage") {
          // a steer Codex has put into the conversation: that is where the model reads it
          const text = (params.item.content ?? []).filter((part: Json) => part.type === "text").map((part: Json) => part.text).join("").trim();
          const id = forwarded.has(params.item.clientId) ? params.item.clientId : [...forwarded].find(([, said]) => said === text)?.[0];
          if (id) { forwarded.delete(id); io.steered?.(id); }
        } else if (method === "item/started") {
          const step = codexStep(params.item);
          if (step) { started.set(params.item.id, params.item); io.activity?.(step.label); }
        } else if (method === "item/commandExecution/outputDelta") {
          const item = started.get(params.itemId);
          if (item) item.aggregatedOutput = ((item.aggregatedOutput ?? "") + params.delta).slice(-8000);
        } else if (method === "item/agentMessage/delta") {
          metrics.firstTokenMs ??= performance.now() - start;
          io.delta(params.delta);
        } else if (method === "item/completed") {
          const item = params.item;
          if (seen.has(item.id)) return;
          seen.add(item.id);
          publishNativeImage(item, io);
          if (item.type === "agentMessage" && item.text?.trim()) io.emit({ type: "text", text: item.text.trim() });
          if (item.type === "contextCompaction") metrics.compactions!++;
          if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "collabAgentToolCall"].includes(item.type)) metrics.toolCalls!++;
          const pending = started.get(item.id);
          const step = codexStep({ ...pending, ...item, aggregatedOutput: item.aggregatedOutput ?? pending?.aggregatedOutput });
          if (step) { const { label: _, ...trace } = step; io.emit({ type: "trace", ...trace }); }
          if (started.delete(item.id) && !started.size) io.activity?.(null);
        } else if (method === "turn/completed" && params.turn.id === turnId) {
          over = true;
          finish({ stop: turn.cancelled || params.turn.status === "interrupted" ? "cancelled" : params.turn.status === "failed" ? "error" : turn.asked() ? "asked" : "end",
            error: params.turn.error?.message, resume: this.session, usage, metrics,
            ...(params.turn.status === "failed" && !turn.cancelled ? { details: turn.details({ error: params.turn.error, attempts: tried() }) } : {}) });
        }
      };
      if (!this.child) {
        const launch = await localCli("codex").launch(options.command);
        // Closed while it was being found (a cancel): nothing to start.
        if (!this.alive) throw new Error(this.kit("notRunning", { name: "Codex" }));
        const child = (this.child = spawnCli(launch, ["app-server", "-c", `mcp_servers.tomrade.url=${JSON.stringify(this.ctx.mcp.url)}`,
          "-c", 'mcp_servers.tomrade.bearer_token_env_var="TOMRADE_MCP_TOKEN"',
          "-c", 'mcp_servers.tomrade.default_tools_approval_mode="approve"'],
        { cwd: this.cwd, env: { ...process.env, ...input.env, TOMRADE_MCP_TOKEN: this.token }, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams);
        this.peer = new JsonLinePeer(child, { name: "Codex", dialect: jsonRpc({ empty: () => ({}) }), handlerFailure: "close", locale: this.locale })
          .onNotification((method, params) => this.notification?.(method, params))
          .onRequest((method, params) => this.respondToRequest(method, params))
          .onClose((error) => { this.failure?.(error); this.close(); });
        await this.request("initialize", { clientInfo: { name: "tomrade", version: "0.0.0" } });
        this.peer.notify("initialized", {});
        // Read effective local/project policy even on resume: old Tomrade
        // sessions may have persisted the former forced `never` policy.
        const local = (await this.request("config/read", { cwd: this.cwd })).config;
        const policy = input.permissionMode === "full-access" ? { approvalPolicy: "never", sandbox: "danger-full-access", config: { sandbox_workspace_write: { network_access: true } } }
          : input.permissionMode === "workspace" ? { approvalPolicy: "on-request", sandbox: "workspace-write" }
          : input.permissionMode === "read-only" ? { approvalPolicy: "on-request", sandbox: "read-only" }
          : { approvalPolicy: local?.approval_policy ?? "on-request", sandbox: local?.sandbox_mode ?? "workspace-write" };
        const thread = {
          cwd: this.cwd, model: codexModel(options.model),
          ...policy, approvalsReviewer: "user",
          developerInstructions: sessionSystem(input, CODEX)
        };
        let response: Json;
        try {
          response = await this.request(io.resume ? "thread/resume" : "thread/start", { ...(io.resume ? { threadId: io.resume } : {}), ...thread });
        } catch (error) {
          if (io.resume && lostSession(error)) { this.close(); return { stop: "error", error: String(error), lostSession: true, metrics }; }
          throw error;
        }
        if (!io.resume) recap = io.recap?.() ?? "";
        this.session = response.thread.id;
        this.indexDigest = input.filesIndex?.digest ?? null;
        metrics.providerModel = response.model;
      }
      metrics.readyMs = performance.now() - start;
      if (turn.cancelled) return { stop: "cancelled", resume: this.session, metrics };
      const response = await this.request("turn/start", { threadId: this.session, model: codexModel(options.model), effort: options.effort,
        input: codexMediaInput(input, io, withRecap(recap, turnPrompt(input, io, { staleIndex: !!input.filesIndex && !!this.indexDigest && input.filesIndex.digest !== this.indexDigest }))) });
      recap = "";
      if (!turnId) began(response.turn.id);
      if (turn.cancelled) abort();
      const outcome = await done;
      if (outcome.stop === "error") this.close();
      return outcome;
    });
  }
}
