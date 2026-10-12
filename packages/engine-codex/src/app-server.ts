import type { ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { Context } from "cordis";
import type { TurnIO, TurnInput, TurnResult, TurnMetrics } from "@tomradex/agent";
import { codexMediaInput, describeFailure, publishNativeImage } from "@tomradex/agent";
import { bindTurn, localCli, runtimeDirectory, sessionSystem, spawnCli, stopCli, turnPrompt, type Runtime } from "@tomradex/engine-claude-code";
import { CodexOptions, codexModel } from "./legacy.js";

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
  private seq = 0;
  private pending = new Map<number, { resolve(value: Json): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private notification?: (method: string, params: Json) => void;
  private failure?: (error: Error) => void;
  private totals?: Counters;
  private stderr = "";
  private activeIO?: TurnIO;
  private code = false;

  constructor(private ctx: Context, input: TurnInput) {
    const directory = runtimeDirectory(input);
    this.token = directory.token; this.cwd = directory.cwd;
  }

  close(): void {
    if (!this.alive) return;
    this.alive = false;
    this.fail(new Error("Codex runtime closed"));
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
    this.failure?.(error);
  }

  private send(value: unknown): void {
    if (!this.alive || !this.child?.stdin.writable) throw new Error("Codex connection is closed");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }

  private request(method: string, params: Json): Promise<Json> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 60_000).unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  private receive(line: string): void {
    let msg: Json;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && !msg.method) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id); clearTimeout(pending.timer);
      if (msg.error) pending.reject(Object.assign(new Error(msg.error.message ?? "Codex protocol error"), { code: msg.error.code, data: msg.error.data }));
      else pending.resolve(msg.result ?? {});
    } else if (msg.id !== undefined) {
      void this.respondToRequest(msg).catch((error) => { this.fail(new Error(String(error))); this.close(); });
    } else if (msg.method) this.notification?.(msg.method, msg.params ?? {});
  }


  private async respondToRequest(msg: Json): Promise<void> {
    const io = this.activeIO;
    const params = msg.params ?? {};
    const active = this.code && io && !io.signal.aborted && (!params.threadId || params.threadId === this.session);
    const command = msg.method === "item/commandExecution/requestApproval";
    const file = msg.method === "item/fileChange/requestApproval";
    let result: Json | undefined;
    if (command || file) {
      const answer = active ? await io.requestPermission?.(
        `${command ? "Command" : "File changes"} permission\n${JSON.stringify(params, null, 2)}`,
        ["Allow once", "Deny"], io.signal) : null;
      result = { decision: answer === "Allow once" && !io?.signal.aborted ? "accept" : "decline" };
    } else if (msg.method === "item/permissions/requestApproval") {
      const answer = active ? await io.requestPermission?.(`Additional permissions\n${JSON.stringify(params, null, 2)}`, ["Allow for this turn", "Deny"], io.signal) : null;
      result = { permissions: answer === "Allow for this turn" && !io?.signal.aborted ? params.permissions : {}, scope: "turn" };
    } else if (msg.method === "mcpServer/elicitation/request") result = { action: "cancel", content: null };
    if (this.alive) this.send(result ? { id: msg.id, result } : { id: msg.id, error: { code: -32601, message: "Unsupported interactive request" } });
  }

  async turn(input: TurnInput, io: TurnIO, warm: boolean): Promise<TurnResult> {
    this.activeIO = io; this.code = input.purpose !== "backlog";
    const options = CodexOptions.parse(input.options ?? {});
    const start = performance.now();
    const metrics: TurnMetrics = { transport: "app-server", runtime: warm ? "warm" : "cold", toolCalls: 0, compactions: 0 };
    const binding = bindTurn(this.ctx, this.token, io, input);
    let turnId: string | undefined;
    let baseline = this.totals;
    let usage: TurnResult["usage"];
    let cancelled = io.signal.aborted;
    let interruptTimer: NodeJS.Timeout | undefined;
    let finish!: (value: TurnResult) => void;
    const done = new Promise<TurnResult>((resolve) => { finish = resolve; });
    const seen = new Set<string>();
    // Codex says each failed attempt before it gives up; the last few explain the failure.
    const attempts: Json[] = [];
    this.failure = (error) => finish({ stop: cancelled ? "cancelled" : "error", error: cancelled ? undefined : error.message,
      details: cancelled ? undefined : describeFailure({ error, attempts: attempts.length ? attempts : undefined, stderr: this.stderr }), resume: this.session, usage, metrics });
    const abort = () => {
      cancelled = true;
      if (!turnId) { this.close(); return; }
      void this.request("turn/interrupt", { threadId: this.session, turnId }).catch(() => this.close());
      interruptTimer ??= setTimeout(() => this.close(), 3000).unref();
    };
    this.notification = (method, params) => {
      if (params.threadId && this.session && params.threadId !== this.session) return;
      if (method === "turn/started") turnId = params.turn.id;
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
      if (method === "error") { attempts.push(params); if (attempts.length > 3) attempts.shift(); }
      else if (method === "item/agentMessage/delta") {
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
      } else if (method === "turn/completed" && params.turn.id === turnId) {
        finish({ stop: cancelled || params.turn.status === "interrupted" ? "cancelled" : params.turn.status === "failed" ? "error" : binding.asked() ? "asked" : "end",
          error: params.turn.error?.message, resume: this.session, usage, metrics,
          ...(params.turn.status === "failed" && !cancelled ? { details: describeFailure({ error: params.turn.error, attempts: attempts.length ? attempts : undefined, stderr: this.stderr }) } : {}) });
      }
    };
    io.signal.addEventListener("abort", abort, { once: true });
    try {
      if (cancelled) return { stop: "cancelled", resume: this.session, metrics };
      if (!this.child) {
        this.child = spawnCli(await localCli("codex").launch(options.command), ["app-server", "-c", `mcp_servers.tomrade.url=${JSON.stringify(this.ctx.mcp.url)}`,
          "-c", 'mcp_servers.tomrade.bearer_token_env_var="TOMRADE_MCP_TOKEN"',
          "-c", 'mcp_servers.tomrade.default_tools_approval_mode="approve"'],
        { cwd: this.cwd, env: { ...process.env, ...input.env, TOMRADE_MCP_TOKEN: this.token }, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
        const reader = readline.createInterface({ input: this.child.stdout });
        reader.on("line", (line) => { try { this.receive(line); } catch (error) { this.fail(new Error(String(error))); this.close(); } });
        this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk.toString()).slice(-2000); });
        this.child.on("error", (error) => { this.fail(error); this.close(); });
        this.child.stdin.on("error", (error) => { this.fail(error); this.close(); });
        this.child.on("close", (code) => { reader.close(); this.fail(new Error(`Codex exited with ${code}: ${this.stderr.slice(-400)}`)); this.alive = false; });
        await this.request("initialize", { clientInfo: { name: "tomrade", version: "0.0.0" } });
        this.send({ method: "initialized", params: {} });
        // Read effective local/project policy even on resume: old Tomrade
        // sessions may have persisted the former forced `never` policy.
        const local = this.code ? (await this.request("config/read", { cwd: this.cwd })).config : null;
        const policy = input.permissionMode === "full-access" ? { approvalPolicy: "never", sandbox: "danger-full-access", config: { sandbox_workspace_write: { network_access: true } } }
          : input.permissionMode === "workspace" ? { approvalPolicy: "on-request", sandbox: "workspace-write" }
          : input.permissionMode === "read-only" ? { approvalPolicy: "on-request", sandbox: "read-only" }
          : { approvalPolicy: local?.approval_policy ?? "on-request", sandbox: local?.sandbox_mode ?? "workspace-write" };
        const response = await this.request(io.resume ? "thread/resume" : "thread/start", {
          ...(io.resume ? { threadId: io.resume } : {}),
          cwd: this.cwd, model: codexModel(options.model),
          ...(this.code ? { ...policy, approvalsReviewer: "user" } : { approvalPolicy: "never", sandbox: "read-only" }),
          developerInstructions: sessionSystem(input, "Codex")
        });
        this.session = response.thread.id;
        this.indexDigest = input.filesIndex?.digest ?? null;
        metrics.providerModel = response.model;
      }
      metrics.readyMs = performance.now() - start;
      if (cancelled) return { stop: "cancelled", resume: this.session, metrics };
      const response = await this.request("turn/start", { threadId: this.session, model: codexModel(options.model), effort: options.effort,
        input: codexMediaInput(input, io, turnPrompt(input, io, { staleIndex: !!input.filesIndex && !!this.indexDigest && input.filesIndex.digest !== this.indexDigest })) });
      turnId ??= response.turn.id;
      if (cancelled) abort();
      const result = await done;
      if (result.stop === "error") this.close();
      return result;
    } catch (error) {
      this.close();
      return { stop: cancelled ? "cancelled" : "error", error: cancelled ? undefined : String(error),
        details: cancelled ? undefined : describeFailure({ error, stderr: this.stderr }), resume: this.session, usage, metrics };
    } finally {
      io.signal.removeEventListener("abort", abort); clearTimeout(interruptTimer);
      this.notification = undefined; this.failure = undefined; this.activeIO = undefined;
      await binding.release();
    }
  }
}
