import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import type { EngineMcpLink } from "@tomradex/agent";
import { MCP_NAME, userMcpLink, type CliLocator } from "@tomradex/engine-claude-code";

/** CodeBuddy keeps user-scope servers in `.mcp.json` inside CODEBUDDY_CONFIG_DIR, else `~/.codebuddy`. */
export function codebuddyUserFile(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CODEBUDDY_CONFIG_DIR?.trim() || path.join(os.homedir(), ".codebuddy");
  return path.join(dir, ".mcp.json");
}

export function workbuddyMcpLink(ctx: Context, cli: CliLocator): EngineMcpLink {
  return userMcpLink(ctx, {
    engineId: "workbuddy",
    cli,
    file: () => codebuddyUserFile(),
    configuredUrl: () => {
      const file = codebuddyUserFile();
      if (!fs.existsSync(file)) return null;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, { url?: unknown }> } | null;
      const url = parsed?.mcpServers?.[MCP_NAME]?.url;
      return typeof url === "string" ? url : null;
    },
    add: (url) => ["mcp", "add", "--scope", "user", "--transport", "http", MCP_NAME, url],
    remove: () => ["mcp", "remove", "--scope", "user", MCP_NAME]
  });
}
