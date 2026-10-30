import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { query, type Query, type SDKMessage, type SDKUserMessage, type Options, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { Context } from "cordis";
import type { TurnIO, TurnInput, TurnResult, TurnMetrics } from "@tomradex/agent";
import { claudeMediaBlocks, claudeMediaInput, resetTime, stepHint, stepSummary, withRecap } from "@tomradex/agent";
import { engineLocale, KIT_WORDS, localCli, MessageQueue, MODE_ALLOWS, OpenAsks, runtimeDirectory, runTurn, sessionSystem, spawnCli, STDERR_CAP, turnPrompt, type CliLaunch, type Runtime } from "@tomradex/engine-kit";
import { lostConversation } from "./cli.js";
import { ClaudeCodeOptions, retryReason } from "./engine.js";
import { LiveUsage, cacheKnown, promptTokens, turnTokens, type Tokens } from "./usage.js";

/**
 * The SDK starts a native path itself; a Windows `.cmd` shim needs our launch
 * (node + script), which the SDK only takes as a custom spawn.
 */
export function sdkLaunch(launch: CliLaunch, onStderr?: (data: string) => void): Pick<Options, "pathToClaudeCodeExecutable" | "spawnClaudeCodeProcess"> {
  if (launch.argv([]).command === launch.file) return { pathToClaudeCodeExecutable: launch.file };
  return {
    pathToClaudeCodeExecutable: launch.file,
    spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
      const child = command === launch.file
        ? spawnCli(launch, args, { cwd, env, signal, stdio: ["pipe", "pipe", "pipe"] })
        : spawn(command, args, { cwd, env, signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      // Unread, a full stderr pipe would stall the CLI.
      if (onStderr) child.stderr?.on("data", (chunk) => onStderr(String(chunk)));
      else child.stderr?.resume();
      return child as unknown as SpawnedProcess;
    }
  };
}

/** The tools acceptEdits lets through without asking. */
const EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** A steer goes into the CLI's queue as written, plus a word for the step it cut short. */
const steerPrompt = (text: string) =>
  `${text}\n\n(Sent while you were working, which stopped here to read it; a command cut short by this was not refused. Do not repeat what you already said, and do not finish a word or sentence it cut off: start with a whole sentence.)`;

/** How long a steer waits for MCP calls in flight before it cuts them anyway: one waiting on the person may never return. */
const CALL_WAIT_MS = 10_000;

/** Which of the client's messages a CLI turn answers, when the CLI stamps it (null when it does not). */
const consumedBy = (message: SDKMessage): string[] | null => {
  const stamped = message as { user_message_uuids?: string[]; user_message_uuid?: string };
  return stamped.user_message_uuids ?? (stamped.user_message_uuid ? [stamped.user_message_uuid] : null);
};

export class ClaudeRuntime implements Runtime {
  token: string;
  cwd: string;
  alive = true;
  busy = false;
  session?: string;
  /** The files index this session was opened with, so a later turn can notice it went stale. */
  indexDigest: string | null = null;
  private queue = new MessageQueue<SDKUserMessage>();
  private query?: Query;
  private onMessage?: (message: SDKMessage) => void;
  private onFailure?: (error: unknown) => void;
  private cost = 0;
  /** This session was started without resume and has not had its first message yet. */
  private fresh = false;
  /** Cumulative counters from the last result; the SDK reports running totals, so a turn is the difference. */
  private tokens: Tokens | null = null;
  private activeIO?: TurnIO;
  /** The mode the session works under, as last set or reported. */
  private mode?: ClaudeCodeOptions["codePermissionMode"];
  private asks = new OpenAsks();
  private stderr = "";
  private keepStderr = (data: string) => { this.stderr = (this.stderr + data).slice(-STDERR_CAP); };
  private kit;

  constructor(private ctx: Context, input: TurnInput) {
    const directory = runtimeDirectory(input);
    this.token = directory.token; this.cwd = directory.cwd;
    this.kit = KIT_WORDS(engineLocale(ctx));
  }

  close(): void {
    if (!this.alive) return;
    this.alive = false;
    this.queue.close();
    this.query?.close();
    this.onFailure?.(new Error(this.kit("runtimeClosed", { name: "Claude" })));
  }

  async turn(input: TurnInput, io: TurnIO, warm: boolean): Promise<TurnResult> {
    this.activeIO = io;
    const options = ClaudeCodeOptions.parse(input.options ?? {});
    if (input.permissionMode) options.codePermissionMode = input.permissionMode === "local" ? undefined : ClaudeCodeOptions.shape.codePermissionMode.parse(input.permissionMode);
    const start = performance.now();
    const metrics: TurnMetrics = { transport: "sdk", runtime: warm ? "warm" : "cold", compactions: 0, toolCalls: 0 };
    let interruptTimer: NodeJS.Timeout | undefined;
    return runTurn(io, {
      ctx: this.ctx, token: this.token, input, metrics,
      result: (stop, error, details) => ({ stop, ...(error ? { error } : {}), ...(details ? { details } : {}), resume: this.session, metrics }),
      resume: () => this.session,
      explain: String,
      stderr: () => this.stderr,
      thrown: () => this.close(),
      cleanup: () => {
        clearTimeout(interruptTimer);
        this.onMessage = undefined; this.onFailure = undefined; this.activeIO = undefined;
      }
    }, async (turn) => {
      let finish!: (result: TurnResult) => void;
      const done = new Promise<TurnResult>((resolve) => { finish = resolve; });
      const seenTools = new Set<string>();
      // Claude Code's own tools, from the call until their result comes back.
      const running = new Map<string, { name: string; args: unknown; at: number }>();
      // MCP calls, Tomrade's own among them, from the call until their result comes back; and the steers waiting for them.
      const calls = new Set<string>();
      const quiet: (() => void)[] = [];
      const calm = () => { for (const done of quiet.splice(0)) done(); };
      const live = new LiveUsage();
      // Messages sent into this turn, by the uuid they carry into the CLI's queue. One that the
      // turn ends without reading runs as a turn of its own right after: this turn waits for it.
      const steers = new Map<string, string>();
      const unplaced = new Set<string>();
      const consumed = new Set<string>();
      const promptId = randomUUID();
      let started = false;
      // A steer cut the CLI's turn short, which can then end as an error: that is not the run's end.
      let cutting = false;
      let over = false;
      const place = (uuids: Iterable<string>) => {
        for (const uuid of uuids) if (unplaced.delete(uuid)) io.steered?.(steers.get(uuid)!);
      };
      const waiting = () => [...steers.keys()].filter((uuid) => !consumed.has(uuid));
      io.modeTo?.(async (mode) => {
        // "local" is the user's own settings, which a running session cannot reread
        const next = mode === "local" ? undefined : ClaudeCodeOptions.shape.codePermissionMode.safeParse(mode).data;
        if (!next || !this.query || over || !this.alive) return false;
        await this.query.setPermissionMode(next);
        this.mode = next;
        this.asks.settle();
        return true;
      });
      io.steersMedia?.();
      // Taken once the CLI is answering the prompt: a "now" message sent before then would be answered ahead of it.
      const forward: Parameters<NonNullable<TurnIO["steerTo"]>>[0] = async (steer) => {
        if (over || turn.cancelled || !this.alive) return false;
        // "now" drops an MCP call's result unread though the server carries the call through, and the agent makes it again: a write twice.
        if (calls.size) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([new Promise<void>((r) => quiet.push(r)), new Promise<void>((r) => { timer = setTimeout(r, CALL_WAIT_MS); })]);
          clearTimeout(timer);
          if (over || turn.cancelled || !this.alive) return false;
        }
        const uuid = randomUUID();
        steers.set(uuid, steer.id); unplaced.add(uuid);
        const text = steerPrompt(steer.text);
        const content = steer.media?.length ? claudeMediaBlocks(text, steer.media) as SDKUserMessage["message"]["content"] : text;
        cutting = true;
        // "now" cuts the reply being written, but a running tool only once it ends; an interrupt ends the tool too.
        if (running.size) await this.query?.interrupt().catch(() => {});
        this.queue.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: this.session ?? "", uuid, priority: "now" });
        return true;
      };
      // A turn can span the CLI's turns for late steers: their figures add up.
      const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, cacheKnown: false };
      // A subscription limit arrives as a rejected rate-limit event and a reply flagged rate_limit; the result only says it failed.
      let limit: { until: number | null; text: string | null } | null = null;
      turn.onAbort(() => {
        calm();
        // A plain interrupt leaves queued messages to run afterwards; ending the process drops them (the session resumes next turn).
        if (waiting().length) { this.close(); return; }
        // A protocol interrupt is scoped to this turn. Kill only on timeout.
        void this.query?.interrupt().catch(() => this.close());
        interruptTimer ??= setTimeout(() => this.close(), 3000).unref();
      });
      this.onFailure = (error) => finish(turn.failed(String(error), { error }));
      this.onMessage = (message) => {
        if (!started && message.type !== "result" && (consumedBy(message)?.includes(promptId) || message.type === "stream_event" || message.type === "assistant")) {
          started = true;
          io.steerTo?.(forward);
        }
        // the first frame of a CLI turn names the messages it answers: a late steer is read there
        if (message.type !== "result") { const answers = consumedBy(message); if (answers) place(answers.filter((uuid) => steers.has(uuid))); }
        if (message.type === "system" && message.subtype === "init") {
          this.session = message.session_id;
          metrics.providerModel = message.model;
          if (message.permissionMode) { this.mode = ClaudeCodeOptions.shape.codePermissionMode.safeParse(message.permissionMode).data ?? this.mode; io.permissionMode?.(message.permissionMode); }
            metrics.readyMs ??= performance.now() - start;
        } else if (message.type === "system" && message.subtype === "compact_boundary") {
          metrics.compactions!++;
        } else if (message.type === "system" && message.subtype === "api_retry") {
          io.progress(live.retry());
          io.retry?.({ attempt: message.attempt, max: message.max_retries, reason: retryReason(message), delayMs: message.retry_delay_ms });
        } else if (message.type === "stream_event") {
          // Subagent requests count too: the final figures include them.
          const counted = live.observe(message.event as Parameters<LiveUsage["observe"]>[0], message.parent_tool_use_id);
          if (counted) io.progress(counted);
          const event = message.event;
          if (!message.parent_tool_use_id && event.type === "content_block_delta" && event.delta.type === "text_delta") {
            metrics.firstTokenMs ??= performance.now() - start;
            io.delta(event.delta.text);
          }
        } else if (message.type === "rate_limit_event") {
          const info = message.rate_limit_info;
          if (info.status === "rejected") limit = { until: info.resetsAt ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt) : limit?.until ?? null, text: limit?.text ?? null };
        } else if (message.type === "assistant" && !message.parent_tool_use_id) {
          if (message.error === "rate_limit") {
            const said = message.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim();
            limit = { until: limit?.until ?? null, text: said || limit?.text || null };
          }
          io.retry?.(null);
          // A reply cut short, by a steer sent now or a stop, can end mid-word: marked unfinished, as a stopped run's is.
          const cut = message.aborted ? message.message.content.map((block) => block.type).lastIndexOf("text") : -1;
          for (const [at, block] of message.message.content.entries()) {
            if (block.type === "text" && block.text.trim()) io.emit({ type: "text", text: at === cut ? `${block.text.trim()} …` : block.text.trim() });
            if (block.type === "tool_use" && !seenTools.has(block.id)) {
              seenTools.add(block.id); metrics.toolCalls!++;
              // Tomrade's own tools are traced by the gateway they run through.
              if (block.name.startsWith("mcp__")) calls.add(block.id);
              else {
                running.set(block.id, { name: block.name, args: block.input, at: Date.now() });
                const hint = stepHint(block.input, 60);
                io.activity?.(hint ? `${block.name} · ${hint}` : block.name);
              }
            }
          }
        } else if (message.type === "user" && !message.parent_tool_use_id && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (block.type === "tool_result" && calls.delete(block.tool_use_id) && !calls.size) calm();
            const call = block.type === "tool_result" ? running.get(block.tool_use_id) : undefined;
            if (!call || block.type !== "tool_result") continue;
            running.delete(block.tool_use_id);
            const ok = !block.is_error;
            io.emit({ type: "trace", tool: call.name, args: call.args, ok, summary: stepSummary(call.args, block.content, ok), ms: Date.now() - call.at });
          }
          if (!running.size) io.activity?.(null);
          // what was queued while the tools ran rides into the next request
          if (message.message.content.some((block) => block.type === "tool_result")) place([...unplaced]);
        } else if (message.type === "result") {
          sum.cost += Math.max(0, message.total_cost_usd - this.cost);
          this.cost = message.total_cost_usd;
          this.session = message.session_id;
          const { turn: part, cumulative } = turnTokens(message, this.tokens);
          this.tokens = cumulative ?? this.tokens;
          sum.input += part.input; sum.output += part.output; sum.cacheRead += part.cacheRead; sum.cacheWrite += part.cacheWrite;
          sum.cacheKnown ||= cacheKnown(message);
          const counted = { input: sum.input, output: sum.output, cacheRead: sum.cacheRead, cacheWrite: sum.cacheWrite };
          const costUsd = sum.cost;
          metrics.uncachedInputTokens = counted.input;
          if (sum.cacheKnown) {
            metrics.cacheReadTokens = counted.cacheRead;
            metrics.cacheWriteTokens = counted.cacheWrite;
          }
          const usage = { inputTokens: promptTokens(counted), outputTokens: counted.output };
          io.progress(usage);
          const answered = consumedBy(message);
          // an older CLI does not say what it read: nothing is waited for
          for (const uuid of answered ?? steers.keys()) consumed.add(uuid);
          place([...unplaced].filter((uuid) => consumed.has(uuid)));
          // the steer runs as the CLI's next turn, still part of this one
          if ((!message.is_error || cutting) && !turn.cancelled && waiting().length) { cutting = false; return; }
          over = true;
          calm();
          const budget = message.subtype === "error_max_turns" || message.subtype === "error_max_budget_usd";
          const error = message.subtype === "success" ? (message.is_error ? message.result || undefined : undefined) : message.errors.join("\n");
          // An error that only reads as a limit is left to runTurn.
          const limited = message.is_error && !turn.cancelled ? limit : null;
          finish({ stop: turn.cancelled ? "cancelled" : budget ? "budget" : message.is_error ? "error" : turn.asked() ? "asked" : "end",
            error: limited?.text ?? error, usage, costUsd, resume: this.session, metrics,
            ...(io.resume && message.is_error && message.num_turns === 0 && lostConversation(error) ? { lostSession: true } : {}),
            ...(message.is_error && !turn.cancelled ? { details: turn.details({ result: message }) } : {}),
            ...(limited ? { limit: { until: limited.until ?? resetTime(limited.text ?? error) } } : {}) });
        }
      };
      if (!this.query) {
        const code = input.purpose !== "backlog";
        const launch = await localCli("claude").launch(options.command);
        const sdkOptions: Options = {
          ...sdkLaunch(launch, this.keepStderr), stderr: this.keepStderr, cwd: this.cwd,
          env: launch.env({ ...process.env, ...input.env }),
          model: options.model, effort: options.effort as Options["effort"],
          resume: io.resume, includePartialMessages: true,
          systemPrompt: { type: "preset", preset: "claude_code", append: sessionSystem(input, "Claude Code") },
          settingSources: ["user", "project", "local"],
          mcpServers: { tomrade: {
            type: "http", url: this.ctx.mcp.url!, headers: { "X-Tomrade-Run": this.token },
            // Pin the registry at session creation. Without this, newer SDK
            // versions may defer remote tools behind tool-search and report a
            // perfectly healthy MCP tool as "not enabled" in a turn.
            tools: this.ctx.tools.served("run").map((tool) => ({ name: tool.name, permission_policy: "always_allow" as const }))
          } },
          strictMcpConfig: !code,
          // Every purpose gets the full preset: a backlog turn that cannot read
          // the code guesses about it. `allowedTools` controls approval only.
          tools: { type: "preset", preset: "claude_code" },
          // MCP tools must be listed for Claude Code to expose the HTTP server's
          // dynamic tool set. They are safe to auto-approve here because every
          // request still carries this runtime's run-scoped token and the MCP
          // server enforces the write policy. Native tools remain hook-gated.
          // Some SDK/CLI versions do not expand an MCP wildcard while the
          // server is discovering tools. Include the registry's concrete names
          // as well; retain the wildcard for tools registered after startup.
          allowedTools: ["mcp__tomrade__*", ...this.ctx.tools.served("run").map((tool) => `mcp__tomrade__${tool.name}`), ...options.allowTools],
          hooks: {
            PreToolUse: [{ hooks: [async (hookInput) => {
              const tool = (hookInput as { tool_name?: string }).tool_name ?? "";
              // Native tools follow codePermissionMode and the user's rules.
              if (!tool.startsWith("mcp__tomrade__")) return { continue: true };
              return {
                continue: true,
                hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Tomrade policy allows this tool" }
              };
            }] }]
          },
          canUseTool: async (tool, args, request) => {
            const io = this.activeIO;
            const answer = io ? await this.asks.ask(io,
              `${request.title ?? tool}\n${request.description ?? request.decisionReason ?? "Permission requested by Claude Code"}\n${JSON.stringify(args, null, 2)}`,
              ["Allow once", "Deny"], () => this.mode === "bypassPermissions" || (this.mode === "acceptEdits" && EDITS.has(tool)), request.signal) : null;
            return (answer === "Allow once" || answer === MODE_ALLOWS) && !request.signal.aborted && !io?.signal.aborted ? { behavior: "allow", updatedInput: args } : { behavior: "deny", message: "Permission was denied or cancelled by the user" };
          },
          permissionMode: options.codePermissionMode,
          // only lets the session be switched to bypassPermissions later in a turn; the mode above is what it starts in
          allowDangerouslySkipPermissions: true,
          maxTurns: code ? options.codeMaxTurns : options.maxTurns,
          maxBudgetUsd: options.maxBudgetUsd
        };
        this.query = query({ prompt: this.queue, options: sdkOptions });
        this.mode = options.codePermissionMode;
        this.fresh = !io.resume;
        this.indexDigest = input.filesIndex?.digest ?? null;
        void this.consume();
      }
      metrics.readyMs ??= warm ? 0 : undefined;
      const stale = !!input.filesIndex && !!this.indexDigest && input.filesIndex.digest !== this.indexDigest;
      const prompt = turnPrompt(input, io, { staleIndex: stale });
      // the first message of a session started without resume carries the thread's conversation so far
      const lead = this.fresh ? withRecap(io.recap?.(), prompt) : prompt;
      this.fresh = false;
      const content = input.input.kind === "text" && input.input.attachments?.length
        ? claudeMediaInput(input, io, lead) as SDKUserMessage["message"]["content"]
        : lead;
      // with a uuid of its own, so the CLI says on each result which messages that turn answered
      this.queue.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: this.session ?? "", uuid: promptId });
      const result = await done;
      // The SDK's maxBudgetUsd is query-wide. Reopen budgeted sessions on the
      // next turn to preserve Tomrade's existing per-run budget exactly.
      if (options.maxBudgetUsd || result.stop === "error" || result.stop === "budget") this.close();
      return result;
    });
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.query!) this.onMessage?.(message);
      this.onFailure?.(new Error(this.kit("inputEnded", { name: "Claude" })));
    } catch (error) { this.onFailure?.(error); }
    finally { this.alive = false; this.queue.close(); }
  }
}
