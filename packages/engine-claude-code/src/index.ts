import type { Context } from "cordis";
import type { Engine } from "@tomradex/agent";
import { claudeRecord, pooledEngine } from "@tomradex/engine-kit";
import type {} from "@tomradex/llm";
import type {} from "@tomradex/mcp";
import { claudeCodeEngineInfo } from "./engine.js";
import { claudeLentModel } from "./lend.js";
import { claudeCommands } from "./permissions.js";
import { ClaudeRuntime } from "./sdk.js";

export function createClaudeCodeEngine(ctx: Context): Engine {
  const info = claudeCodeEngineInfo(ctx);
  return {
    ...info,
    // the SDK session takes messages mid-turn through its input queue
    steering: "forward",
    // the SDK session switches its permission mode mid-turn
    liveModes: true,
    local: { ...info.local, commands: claudeCommands, record: claudeRecord({ variable: "CLAUDE_CONFIG_DIR", dir: ".claude" }) },
    media: () => ({ input: ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"], output: [] }),
    permissionModes: { default: "bypassPermissions", choices: [
      { value: "auto", label: "Auto" }, { value: "bypassPermissions", label: "Full access" },
      { value: "acceptEdits", label: "Accept edits" }, { value: "default", label: "Ask permissions" },
      { value: "plan", label: "Plan" }, { value: "local", label: "Local rules" }
    ] },
    turn: pooledEngine(ctx, { create: (input) => new ClaudeRuntime(ctx, input) })
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
