import fs from "node:fs";
import path from "node:path";
import type { Context } from "cordis";
import { parse as parseToml } from "smol-toml";
import type { EngineMcpLink } from "@tomradex/agent";
import { MCP_NAME, userMcpLink, type CliLocator } from "@tomradex/engine-kit";
import { codexHome } from "./account.js";

export const codexUserFile = (): string => path.join(codexHome(), "config.toml");

/** Codex keeps it as `[mcp_servers.tomrade]` in CODEX_HOME's config.toml. */
export function codexMcpLink(ctx: Context, cli: CliLocator): EngineMcpLink {
  return userMcpLink(ctx, {
    engineId: "codex",
    cli,
    file: codexUserFile,
    configuredUrl: () => {
      const file = codexUserFile();
      if (!fs.existsSync(file)) return null;
      const servers = parseToml(fs.readFileSync(file, "utf8")).mcp_servers as Record<string, { url?: unknown }> | undefined;
      const url = servers?.[MCP_NAME]?.url;
      return typeof url === "string" ? url : null;
    },
    add: (url) => ["mcp", "add", MCP_NAME, "--url", url],
    remove: () => ["mcp", "remove", MCP_NAME]
  });
}
