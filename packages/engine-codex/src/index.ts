import fs from "node:fs";
import path from "node:path";
import type { Context } from "cordis";
import type { Engine } from "@tomradex/agent";
import { RuntimePool, runtimeFingerprint } from "@tomradex/engine-kit";
import type {} from "@tomradex/llm";
import { codexHome } from "./account.js";
import { codexEngineInfo, migrateLegacyModel } from "./engine.js";
import { CodexRuntime } from "./app-server.js";
import { codexLentModel } from "./lend.js";

export function createCodexEngine(ctx: Context): Engine {
  const pool = new RuntimePool<CodexRuntime>();
  ctx.effect(() => () => pool.close());
  return {
    ...codexEngineInfo(ctx),
    // app-server takes messages mid-turn (turn/steer)
    steers: true,
    media: () => ({ input: ["image/png", "image/jpeg", "image/webp", "image/gif", "audio/mpeg", "audio/wav"], output: ["image"] }),
    permissionModes: { default: "full-access", choices: [
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
export { CodexOptions, codexCanRun, codexEngineInfo, codexInstall, codexModel, codexSignedIn } from "./engine.js";
export { codexHome, readCodexAccount, type CodexAccount } from "./account.js";
export { codexLentModel } from "./lend.js";
export { codexMcpLink, codexUserFile } from "./mcp-link.js";
