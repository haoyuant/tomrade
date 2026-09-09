import type { Context } from "cordis";
import type { Engine } from "@tomrade/agent";
import { RuntimePool, runtimeFingerprint } from "@tomrade/engine-claude-code";
import { CodexOptions, createCodexCliEngine, migrateLegacyModel } from "./legacy.js";
import { CodexRuntime } from "./app-server.js";

export function createCodexEngine(ctx: Context): Engine {
  const baseline = createCodexCliEngine(ctx);
  const pool = new RuntimePool<CodexRuntime>();
  ctx.effect(() => () => pool.close());
  return {
    ...baseline,
    async turn(input, io) {
      const options = CodexOptions.parse(input.options ?? {});
      if (options.transport === "cli") return baseline.turn(input, io);
      if (!ctx.mcp.url) return { stop: "error", error: "The MCP server is not running" };
      return pool.run(`${input.projectId}:${input.threadId}`, runtimeFingerprint(input, io, ctx.mcp.url),
        () => new CodexRuntime(ctx, input), input, io);
    }
  };
}

export default {
  name: "engine-codex", inject: ["agent", "mcp", "tools", "settings"],
  apply(ctx: Context) { migrateLegacyModel(ctx); ctx.agent.engine(createCodexEngine(ctx)); }
};
export { CodexOptions, codexModel, createCodexCliEngine } from "./legacy.js";
