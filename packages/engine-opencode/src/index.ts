import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/agent";
import { createAcpEngine, PERMISSION_CHOICES, type AcpAgent } from "@tomradex/engine-acp";
import { localCli } from "@tomradex/engine-claude-code";
import type {} from "@tomradex/llm";
import { opencodeLentModel } from "./lend.js";
import { opencodeMcpLink } from "./link.js";

export const OpencodeOptions = z.object({
  command: z.string().default("opencode"),
  /** `provider/model` as OpenCode lists it; empty keeps its own default. */
  model: z.string().optional()
});
export type OpencodeOptions = z.infer<typeof OpencodeOptions>;

export const opencode: AcpAgent<OpencodeOptions> = {
  id: "opencode",
  title: "OpenCode",
  cli: localCli("opencode"),
  install: "install OpenCode (curl -fsSL https://opencode.ai/install | bash) and add a provider",
  setup: {
    install: process.platform === "win32" ? ["npm install -g opencode-ai"] : ["curl -fsSL https://opencode.ai/install | bash", "npm install -g opencode-ai"],
    signIn: "opencode auth login",
    signInRuns: true,
    docs: "https://opencode.ai/docs/"
  },
  options: OpencodeOptions,
  // Its "plan" agent cannot edit or run commands, so read-only is one it keeps; "build" asks only where its own rules say so.
  permissionModes: { default: "full-access", mainDefault: "read-only", choices: [PERMISSION_CHOICES["full-access"], PERMISSION_CHOICES.local, PERMISSION_CHOICES["read-only"]] },
  args: () => ["acp"],
  mode: (policy) => (policy === "read-only" ? "plan" : "build"),
  // The prompt's answer counts that turn alone, its cached prompt tokens apart from inputTokens.
  usage: "turn",
  cacheApart: true,
  // `opencode` with a session id, as code link starts it.
  terminal: true,
  signIn: "run `opencode auth login` to add a provider and its key",
  diagnostics: {
    logs: () => [path.join(process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share"), "opencode", "log", "opencode.log")]
  }
};

export function createOpencodeEngine(ctx: Context) {
  return { ...createAcpEngine(ctx, opencode), mcpLink: opencodeMcpLink(ctx) };
}

export default {
  name: "engine-opencode",
  inject: ["agent", "mcp", "tools"],
  apply(ctx: Context) {
    const engine = createOpencodeEngine(ctx);
    ctx.agent.engine(engine);
    ctx.inject(["llm"], (ctx) => ctx.effect(() => ctx.llm.lend(opencodeLentModel(ctx, {
      cli: opencode.cli,
      found: async () => (await engine.available()).ok,
      options: () => OpencodeOptions.parse(ctx.get("agent")?.settingsOf().engines.opencode ?? {})
    }))));
  }
};

export { opencodeLentModel } from "./lend.js";
export { configuredMcpUrl, opencodeConfigDir, opencodeMcpEntry, opencodeMcpLink, opencodePlugin, opencodeUserFile, opencodeUserPlugin, withMcpEntry } from "./link.js";
