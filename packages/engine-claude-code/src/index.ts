import type { Context } from "cordis";
import type { Engine } from "@tomrade/agent";
import { ClaudeCodeOptions, createClaudeCodeCliEngine } from "./legacy.js";
import { ClaudeRuntime } from "./sdk.js";
import { RuntimePool, runtimeFingerprint } from "./runtime.js";

export function createClaudeCodeEngine(ctx: Context): Engine {
  const baseline = createClaudeCodeCliEngine(ctx);
  const pool = new RuntimePool<ClaudeRuntime>();
  ctx.effect(() => () => pool.close());
  return {
    ...baseline,
    media: () => ({ input: ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"], output: [] }),
    permissionModes: { default: "auto", choices: [
      { value: "auto", label: "Auto" }, { value: "bypassPermissions", label: "Full access" },
      { value: "acceptEdits", label: "Accept edits" }, { value: "default", label: "Ask permissions" },
      { value: "plan", label: "Plan" }, { value: "local", label: "Local rules" }
    ] },
    async turn(input, io) {
      const options = ClaudeCodeOptions.parse(input.options ?? {});
      if (options.transport === "cli") return baseline.turn(input, io);
      if (!ctx.mcp.url) return { stop: "error", error: "The MCP server is not running" };
      return pool.run(`${input.projectId}:${input.threadId}`, runtimeFingerprint(input, io, ctx.mcp.url),
        () => new ClaudeRuntime(ctx, input), input, io);
    }
  };
}

export default {
  name: "engine-claude-code",
  inject: ["agent", "mcp", "tools"],
  apply(ctx: Context) { ctx.agent.engine(createClaudeCodeEngine(ctx)); }
};

export { ClaudeCodeOptions, createClaudeCodeCliEngine } from "./legacy.js";
export { binaryOk, runJsonl } from "./cli.js";
export { buildSystem, promptOf, sessionSystem, staticSystem, turnPrompt } from "./system.js";
export { RuntimePool, runtimeFingerprint, runtimeDirectory, bindTurn, type Runtime } from "./runtime.js";
