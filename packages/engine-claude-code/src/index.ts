import type { Context } from "cordis";
import type { Engine } from "@tomradex/agent";
import type {} from "@tomradex/llm";
import { ClaudeCodeOptions, createClaudeCodeCliEngine } from "./legacy.js";
import { claudeLentModel } from "./lend.js";
import { claudeCommands } from "./permissions.js";
import { ClaudeRuntime } from "./sdk.js";
import { RuntimePool, runtimeFingerprint } from "./runtime.js";

export function createClaudeCodeEngine(ctx: Context): Engine {
  const baseline = createClaudeCodeCliEngine(ctx);
  const pool = new RuntimePool<ClaudeRuntime>();
  ctx.effect(() => () => pool.close());
  return {
    ...baseline,
    // the SDK session takes messages mid-turn through its input queue
    steers: true,
    commands: claudeCommands,
    media: () => ({ input: ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"], output: [] }),
    permissionModes: { default: "auto", mainDefault: "default", choices: [
      { value: "auto", label: "Auto" }, { value: "bypassPermissions", label: "Full access" },
      { value: "acceptEdits", label: "Accept edits" }, { value: "default", label: "Ask permissions" },
      { value: "plan", label: "Plan" }, { value: "local", label: "Local rules" }
    ] },
    async turn(input, io) {
      const options = ClaudeCodeOptions.parse(input.options ?? {});
      if (options.transport === "cli") {
        // `claude -p` has no way in once a turn runs: what is sent goes back to the queue
        io.steerTo?.(async () => false);
        return baseline.turn(input, io);
      }
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
    ctx.inject(["llm"], (ctx) => ctx.effect(() => ctx.llm.lend(claudeLentModel(ctx, async () => (await engine.available()).ok))));
  }
};

export { ClaudeCodeOptions, createClaudeCodeCliEngine } from "./legacy.js";
export { claudeSignedIn, lineSplitter, runJsonl, signedIn } from "./cli.js";
export { localAvailability, chosenCommand } from "./availability.js";
export { claudeLentModel } from "./lend.js";
export { bashRuleMatches, claudeCommands, userSettingsFile } from "./permissions.js";
export {
  CliLocator, localCli, launchFor, bundledLaunch, spawnCli, stopCli, cliReason, describeRun, fileNames, shimTarget, cmdArgument, cmdLine, parseRegPath, expandWindowsVars, splitPath, knownDirs,
  type BundledCli, type CliHost, type CliLaunch, type CliRunResult
} from "./locate.js";
export { buildSystem, promptOf, sessionSystem, staticSystem, turnPrompt } from "./system.js";
export { RuntimePool, runtimeFingerprint, runtimeDirectory, bindTurn, type Runtime } from "./runtime.js";
