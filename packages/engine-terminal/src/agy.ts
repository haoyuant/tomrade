import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import type { Engine } from "@tomradex/agent";
import { localAvailability, localCli, MCP_NAME, userMcpLink } from "@tomradex/engine-claude-code";
import type {} from "@tomradex/mcp";

/** Where `agy mcp add` keeps servers: ~/.gemini/config/mcp_config.json, shared with the Antigravity app. */
export const agyMcpFile = (home = os.homedir()): string => path.join(home, ".gemini", "config", "mcp_config.json");

/**
 * Antigravity's CLI (`agy`), Google's successor to Gemini CLI. It has no ACP
 * and no per-session MCP flag, and its config takes no `${VAR}` in a header,
 * so Tomrade starts it only in a terminal, where its own user-level `tomrade`
 * server (tokenless) reaches Tomrade and its first act is claim_ticket.
 */
export function createAgyEngine(ctx: Context): Engine {
  const cli = localCli("agy");
  return {
    id: "agy",
    title: "Antigravity CLI",
    author: "ai:agy",
    capabilities: ["code", "general"],
    terminalOnly: true,
    terminalViaLink: true,
    terminalClaims: true,
    setup: {
      install: process.platform === "win32"
        ? ["irm https://antigravity.google/cli/install.ps1 | iex"]
        : ["curl -fsSL https://antigravity.google/cli/install.sh | bash"],
      signIn: "agy",
      signInRuns: true,
      docs: "https://antigravity.google/docs/cli"
    },
    picks: () => [
      { key: "model", title: "Model", choices: [], freeText: true },
      { key: "effort", title: "Effort", choices: ["low", "medium", "high", "xhigh", "max"].map((value) => ({ value })) }
    ],
    available: localAvailability(ctx, { engineId: "agy", title: "Antigravity CLI", cli, install: "install the Antigravity CLI (curl -fsSL https://antigravity.google/cli/install.sh | bash) and sign in; the Antigravity desktop app does not include it" }),
    checkCli: (file) => cli.check(file),
    mcpLink: userMcpLink(ctx, {
      engineId: "agy",
      cli,
      file: () => agyMcpFile(),
      configuredUrl: () => {
        const file = agyMcpFile();
        if (!fs.existsSync(file)) return null;
        const url = (JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, { serverUrl?: unknown }> }).mcpServers?.[MCP_NAME]?.serverUrl;
        return typeof url === "string" ? url : null;
      },
      // "Add or update": an entry at an old address is replaced in place.
      add: (url) => ["mcp", "add", MCP_NAME, url],
      remove: () => ["mcp", "remove", MCP_NAME]
    }),
    async turn() {
      return { stop: "error", error: "Antigravity CLI runs only in a terminal — start the ticket \"In a terminal\"" };
    }
  };
}
