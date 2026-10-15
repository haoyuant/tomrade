import os from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Context } from "cordis";
import { transcriptOf, type ChatModel, type LentModel } from "@tomradex/llm";
import { chosenCommand } from "./availability.js";
import { ClaudeCodeOptions } from "./engine.js";
import { localCli } from "./locate.js";
import { sdkLaunch } from "./sdk.js";

/**
 * The signed-in Claude Code answering one prompt: no tools, MCP servers,
 * settings (so no hooks fire) or saved session. Worker calls use it while no
 * model profile is configured.
 */
export function claudeLentModel(ctx: Context, ready: () => Promise<boolean>): LentModel {
  const model: ChatModel = {
    capabilities: { tools: false, streaming: false, json: false },
    async *chat(request, signal) {
      const options = ClaudeCodeOptions.parse(ctx.get("agent")?.settingsOf().engines["claude-code"] ?? {});
      const launch = await localCli("claude").launch(chosenCommand(ctx, "claude-code"));
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const run = query({
          prompt: transcriptOf(request.messages),
          options: {
            ...sdkLaunch(launch), cwd: os.tmpdir(), env: launch.env(process.env), abortController,
            systemPrompt: request.system, tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [],
            maxTurns: 1, persistSession: false, model: options.model
          }
        });
        for await (const message of run) {
          if (message.type !== "result") continue;
          if (message.subtype !== "success" || message.is_error) {
            throw new Error(`Claude Code could not answer: ${message.subtype === "success" ? message.result : message.errors.join("; ") || message.subtype}`);
          }
          yield { type: "usage", inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
          yield { type: "text", delta: message.result };
          yield { type: "stop", reason: "end" };
          return;
        }
        throw new Error("Claude Code ended without an answer");
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    }
  };
  return { id: "claude-code", title: "Claude Code", ready, model };
}
