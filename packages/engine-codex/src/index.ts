import fs from "node:fs";
import path from "node:path";
import type { Context } from "cordis";
import type { Engine } from "@tomradex/agent";
import { pooledEngine } from "@tomradex/engine-kit";
import type {} from "@tomradex/llm";
import { codexHome } from "./account.js";
import { codexEngineInfo, migrateLegacyModel } from "./engine.js";
import { CodexRuntime } from "./app-server.js";
import { codexLentModel } from "./lend.js";
import { codexRecord } from "./record.js";

export function createCodexEngine(ctx: Context): Engine {
  const info = codexEngineInfo(ctx);
  return {
    ...info,
    // app-server takes messages mid-turn (turn/steer)
    steering: "forward",
    media: () => ({ input: ["image/png", "image/jpeg", "image/webp", "image/gif", "audio/mpeg", "audio/wav"], output: ["image"] }),
    // a turn raised to Full access gets it by Tomrade approving what Codex still asks
    liveModes: true,
    permissionModes: { default: "full-access", choices: [
      { value: "full-access", label: "Full access" }, { value: "workspace", label: "Workspace" },
      { value: "read-only", label: "Read only" }, { value: "local", label: "Local rules" }
    ] },
    local: {
      ...info.local,
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
      record: codexRecord,
      // its approval is a pick that opens on "Yes, proceed" (Enter takes it); Esc leaves it as "No, and tell Codex what to do differently"
      approval: { allow: ["enter"], deny: ["esc"] }
    },
    ...pooledEngine(ctx, { create: (input) => new CodexRuntime(ctx, input) })
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
export { codexRecord, codexRolloutTitle, findCodexRollout } from "./record.js";
