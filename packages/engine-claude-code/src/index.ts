import type { Context } from "cordis";
import type { Engine } from "@tomradex/agent";
import { RuntimePool, runtimeFingerprint } from "@tomradex/engine-kit";
import type {} from "@tomradex/llm";
import type {} from "@tomradex/mcp";
import { claudeCodeEngineInfo } from "./engine.js";
import { claudeLentModel } from "./lend.js";
import { claudeCommands } from "./permissions.js";
import { ClaudeRuntime } from "./sdk.js";

export function createClaudeCodeEngine(ctx: Context): Engine {
  const pool = new RuntimePool<ClaudeRuntime>();
  ctx.effect(() => () => pool.close());
  return {
    ...claudeCodeEngineInfo(ctx),
    // the SDK session takes messages mid-turn through its input queue
    steers: true,
    commands: claudeCommands,
    media: () => ({ input: ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"], output: [] }),
    permissionModes: { default: "bypassPermissions", choices: [
      { value: "auto", label: "Auto" }, { value: "bypassPermissions", label: "Full access" },
      { value: "acceptEdits", label: "Accept edits" }, { value: "default", label: "Ask permissions" },
      { value: "plan", label: "Plan" }, { value: "local", label: "Local rules" }
    ] },
    async turn(input, io) {
      if (!ctx.mcp.url) return { stop: "error", error: "The MCP server is not running" };
      return pool.run(`${input.projectId}:${input.threadId}`, runtimeFingerprint(input, io, ctx.mcp.url),
        () => new ClaudeRuntime(ctx, input), input, io);
    }
  };
}

export default {
  name: "engine-claude-code",
  inject: ["agent", "mcp", "tools"],
  apply(ctx: Context) {
    const engine = createClaudeCodeEngine(ctx);
    ctx.agent.engine(engine);
    ctx.inject(["llm"], (ctx) => ctx.effect(() => {
      const lent = claudeLentModel(ctx, async () => (await engine.available()).ok);
      const withdraw = ctx.llm.lend(lent);
      return () => { withdraw(); lent.close(); };
    }));
  }
};

export { ClaudeCodeOptions, claudeCodeEngineInfo, retryReason } from "./engine.js";
export { claudeSignedIn } from "./cli.js";
export { claudeLentModel, LENT_IDLE_MS } from "./lend.js";
export { claudeConfigDirOf, claudeConfigDirs, claudeMcpLink, claudeProfileEnv, claudeProjectServerApproval, claudeUserFile } from "./mcp-link.js";
export { bashRuleMatches, claudeCommands, userSettingsFile } from "./permissions.js";
