import fs from "node:fs";
import path from "node:path";
import type { Context } from "cordis";
import type { Engine } from "@tomradex/agent";
import { RuntimePool, runtimeFingerprint } from "@tomradex/engine-claude-code";
import type {} from "@tomradex/llm";
import { codexHome } from "./account.js";
import { CodexOptions, createCodexCliEngine, migrateLegacyModel } from "./legacy.js";
import { CodexRuntime } from "./app-server.js";
import { codexLentModel } from "./lend.js";

export function createCodexEngine(ctx: Context): Engine {
  const baseline = createCodexCliEngine(ctx);
  const pool = new RuntimePool<CodexRuntime>();
  ctx.effect(() => () => pool.close());
  return {
    ...baseline,
    // app-server takes messages mid-turn (turn/steer)
    steers: true,
    media: options => ({ input: ["image/png", "image/jpeg", "image/webp", "image/gif", ...(CodexOptions.parse(options ?? {}).transport === "app-server" ? ["audio/mpeg", "audio/wav"] : [])], output: ["image"] }),
    permissionModes: { default: "full-access", mainDefault: "workspace", choices: [
      { value: "full-access", label: "Full access" }, { value: "workspace", label: "Workspace" },
      { value: "read-only", label: "Read only" }, { value: "local", label: "Local rules" }
    ] },
    diagnostics: {
      // Codex writes its own log under CODEX_HOME; config.toml says which model and provider it was told to use.
      logs: () => ["codex-tui.log", "codex-login.log"].map((name) => path.join(codexHome(), "log", name)).filter((file) => fs.existsSync(file)),
      facts: () => {
        let config = "";
        try { config = fs.readFileSync(path.join(codexHome(), "config.toml"), "utf8"); } catch {}
        const value = (key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(config)?.[1];
        return { model: value("model") ?? "default", provider: value("model_provider") ?? "default" };
      }
    },
    async turn(input, io) {
      const options = CodexOptions.parse(input.options ?? {});
      if (options.transport === "cli") {
        // `codex exec` has no way in once a turn runs: what is sent goes back to the queue
        io.steerTo?.(async () => false);
        return baseline.turn(input, io);
      }
      if (!ctx.mcp.url) return { stop: "error", error: "The MCP server is not running" };
      return pool.run(`${input.projectId}:${input.threadId}`, runtimeFingerprint(input, io, ctx.mcp.url),
        () => new CodexRuntime(ctx, input), input, io);
    }
  };
}

export default {
  name: "engine-codex", inject: ["agent", "mcp", "tools", "settings"],
  apply(ctx: Context) {
    migrateLegacyModel(ctx);
    const engine = createCodexEngine(ctx);
    ctx.agent.engine(engine);
    ctx.inject(["llm"], (ctx) => ctx.effect(() => ctx.llm.lend(codexLentModel(ctx, async () => (await engine.available()).ok))));
  }
};
export { CodexOptions, codexCanRun, codexModel, codexSignedIn, createCodexCliEngine } from "./legacy.js";
export { codexHome, readCodexAccount, type CodexAccount } from "./account.js";
export { codexLentModel } from "./lend.js";
