import { randomUUID } from "node:crypto";
import os from "node:os";
import { query, type Options, type Query, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Context } from "cordis";
import { transcriptOf, type ChatEvent, type ChatModel, type ChatRequest, type LentModel } from "@tomradex/llm";
import { chosenCommand, localCli, MessageQueue, type CliLaunch } from "@tomradex/engine-kit";
import { ClaudeCodeOptions } from "./engine.js";
import { sdkLaunch } from "./sdk.js";

/** A kept session that answered nothing for this long exits; the next call starts one again. */
export const LENT_IDLE_MS = 5 * 60_000;

// The kept session has one system prompt, so each call's instructions travel in its message.
const SESSION_SYSTEM = "Each message opens with <instructions>. Follow them for that message alone, and reply with the answer only.";

/** No tools, MCP servers, settings (so no hooks fire) or saved session: the CLI answers text and nothing else. */
const bare = (launch: CliLaunch, model: string | undefined): Options => ({
  ...sdkLaunch(launch), cwd: os.tmpdir(), env: launch.env(process.env),
  tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], persistSession: false, model
});

function answer(result: SDKResultMessage): ChatEvent[] {
  if (result.subtype !== "success" || result.is_error) {
    throw new Error(`Claude Code could not answer: ${result.subtype === "success" ? result.result : result.errors.join("; ") || result.subtype}`);
  }
  // input_tokens leaves out what the cache read and wrote; Tomrade counts input as all of it.
  const { input_tokens, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens } = result.usage;
  return [
    { type: "usage", inputTokens: input_tokens + (read ?? 0) + (write ?? 0), outputTokens: output_tokens, ...(read != null ? { cacheReadTokens: read } : {}), ...(write != null ? { cacheWriteTokens: write } : {}) },
    { type: "text", delta: result.result },
    { type: "stop", reason: "end" }
  ];
}

/** The process ended before it answered, so a fresh one may try once. */
class SessionEnded extends Error {}

/**
 * One Claude Code process kept between worker calls, so a call skips the CLI's
 * start-up. `/clear` after every answer means no call sees another's text.
 */
class KeptSession {
  alive = true;
  busy = false;
  /** Set while `/clear` runs after an answer: a moment, worth waiting for rather than starting a process. */
  clearing: Promise<void> | null = null;
  private queue = new MessageQueue<SDKUserMessage>();
  private query: Query;
  private waiting?: { resolve(result: SDKResultMessage): void; reject(error: unknown): void };
  private idle?: NodeJS.Timeout;

  constructor(readonly key: string, options: Options, private idleMs: number) {
    this.query = query({ prompt: this.queue, options: { ...options, systemPrompt: SESSION_SYSTEM } });
    void this.consume();
  }

  async ask(request: ChatRequest, signal?: AbortSignal): Promise<SDKResultMessage> {
    this.busy = true;
    clearTimeout(this.idle);
    // A call withdrawn mid-answer leaves the session inside a turn; ending it is the only clean stop.
    const abort = () => this.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await this.send(`<instructions>\n${request.system}\n</instructions>\n\n${transcriptOf(request.messages)}`);
      this.clearing = this.send("/clear").then(() => this.rest(), () => this.close()).finally(() => { this.clearing = null; });
      return result;
    } catch (error) {
      this.close();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  close(): void {
    if (!this.alive) return;
    this.alive = false;
    clearTimeout(this.idle);
    this.queue.close();
    this.query.close();
    this.waiting?.reject(new SessionEnded("Claude Code ended the kept session"));
    this.waiting = undefined;
  }

  private send(content: string): Promise<SDKResultMessage> {
    if (!this.alive) return Promise.reject(new SessionEnded("Claude Code ended the kept session"));
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.queue.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "", uuid: randomUUID() });
    });
  }

  private rest(): void {
    this.busy = false;
    this.idle = setTimeout(() => this.close(), this.idleMs);
    this.idle.unref?.();
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.query) {
        if (message.type !== "result") continue;
        const waiting = this.waiting;
        this.waiting = undefined;
        waiting?.resolve(message);
      }
    } catch {
      // the caller learns of it as SessionEnded
    } finally {
      this.close();
    }
  }
}

/**
 * The signed-in Claude Code answering worker calls. One session is kept warm
 * between calls; a call arriving while it is busy runs in a process of its own.
 */
export function claudeLentModel(ctx: Context, ready: () => Promise<boolean>, opts: { idleMs?: number } = {}): LentModel & { close(): void } {
  let kept: KeptSession | null = null;

  async function oneShot(options: Options, request: ChatRequest, signal?: AbortSignal): Promise<SDKResultMessage> {
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const run = query({ prompt: transcriptOf(request.messages), options: { ...options, abortController, systemPrompt: request.system, maxTurns: 1 } });
      for await (const message of run) if (message.type === "result") return message;
      throw new Error("Claude Code ended without an answer");
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  const model: ChatModel = {
    capabilities: { tools: false, streaming: false, json: false },
    async *chat(request, signal) {
      const settings = ClaudeCodeOptions.parse(ctx.get("agent")?.settingsOf().engines["claude-code"] ?? {});
      const launch = await localCli("claude").launch(chosenCommand(ctx, "claude-code"));
      const options = bare(launch, settings.model);
      const key = JSON.stringify([launch.argv([]), settings.model]);
      await kept?.clearing;
      if (kept && (!kept.alive || (!kept.busy && kept.key !== key))) {
        kept.close();
        kept = null;
      }
      if (kept?.busy) {
        yield* answer(await oneShot(options, request, signal));
        return;
      }
      kept ??= new KeptSession(key, options, opts.idleMs ?? LENT_IDLE_MS);
      let result: SDKResultMessage;
      try {
        result = await kept.ask(request, signal);
      } catch (error) {
        if (!(error instanceof SessionEnded) || signal?.aborted) throw error;
        kept = null;
        result = await oneShot(options, request, signal);
      }
      yield* answer(result);
    }
  };
  return {
    // Automatic asks the fastest first: Claude Code 10, WorkBuddy 20, Codex 30, Gemini CLI 40.
    id: "claude-code", title: "Claude Code", rank: 10, ready, model,
    close: () => {
      kept?.close();
      kept = null;
    }
  };
}
