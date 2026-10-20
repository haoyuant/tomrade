import type { Context } from "cordis";
import type { Engine } from "@tomradex/agent";
import { localAvailability, localCli } from "@tomradex/engine-claude-code";
import type {} from "@tomradex/llm";
import type {} from "@tomradex/mcp";
import { cursorLentModel } from "./lend.js";
import { cursorMcpLink } from "./link.js";

export const CURSOR_INSTALL = process.platform === "win32" ? "irm 'https://cursor.com/install?win32=true' | iex" : "curl https://cursor.com/install -fsS | bash";

/** `cursor-agent status` prints "✓ Logged in as …" or "Not logged in". */
export function cursorSignedIn(output: string): boolean | null {
  if (/not logged in/i.test(output)) return false;
  return /logged in/i.test(output) ? true : null;
}

/**
 * Cursor's CLI (`cursor-agent`). Cursor has no ACP and no per-session MCP
 * flag, so Tomrade starts it only in a terminal, where its user-level
 * `tomrade` server (tokenless) reaches Tomrade and its first act is
 * claim_ticket; a connected repository's `.cursor/hooks.json` reports the rest.
 */
export function createCursorEngine(ctx: Context): Engine {
  const cli = localCli("cursor-agent");
  return {
    id: "cursor",
    title: "Cursor",
    author: "ai:cursor",
    capabilities: ["code", "general"],
    terminalOnly: true,
    terminalViaLink: true,
    terminalClaims: true,
    setup: { install: [CURSOR_INSTALL], signIn: "cursor-agent login", docs: "https://cursor.com/docs/cli/overview" },
    picks: () => [{ key: "model", title: "Model", choices: [], freeText: true }],
    available: localAvailability(ctx, {
      engineId: "cursor",
      title: "Cursor",
      cli,
      install: `install Cursor's CLI (${CURSOR_INSTALL}) and sign in`,
      signIn: { args: ["status"], says: cursorSignedIn, reason: "Cursor's CLI is not signed in — run `cursor-agent login`" },
      desktopApp: { title: "Cursor", mac: ["Cursor"], windows: ["Programs\\cursor"] }
    }),
    checkCli: (file) => cli.check(file),
    mcpLink: cursorMcpLink(ctx),
    async turn() {
      return { stop: "error", error: "Cursor runs only in a terminal — start the ticket \"In a terminal\"" };
    }
  };
}

export default {
  name: "engine-cursor",
  inject: ["agent", "mcp"],
  apply(ctx: Context) {
    const engine = createCursorEngine(ctx);
    ctx.agent.engine(engine);
    ctx.inject(["llm"], (ctx) => ctx.effect(() => ctx.llm.lend(cursorLentModel(ctx, {
      cli: localCli("cursor-agent"),
      found: async () => (await engine.available()).ok,
      options: () => {
        const model = (ctx.get("agent")?.settingsOf().engines.cursor as { model?: unknown } | undefined)?.model;
        return typeof model === "string" && model.trim() ? { model: model.trim() } : {};
      }
    }))));
  }
};

export { cursorLentModel, cursorWorkerDir } from "./lend.js";
export { cursorMcpFile, cursorMcpLink, withMcpEntry } from "./link.js";
