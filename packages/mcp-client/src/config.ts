import { createHash } from "node:crypto";
import { z } from "zod";
import type { SettingsSection } from "@tomrade/settings";

/** A server's id prefixes every tool it contributes, so it stays short and safe in a tool name. */
export const ServerId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,23}$/, "lowercase letters, digits, _ or -, at most 24");

export const StdioTransport = z.object({
  type: z.literal("stdio"),
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional()
});

export const HttpTransport = z.object({
  type: z.literal("http"),
  url: z.url({ protocol: /^https?$/ }),
  headers: z.record(z.string(), z.string()).default({})
});

export const McpServerConfig = z.object({
  id: ServerId,
  enabled: z.boolean().default(true),
  transport: z.discriminatedUnion("type", [StdioTransport, HttpTransport]),
  /** Remote tool names to expose; absent exposes every tool the server lists. */
  tools: z.array(z.string()).optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000)
});
export type McpServerConfig = z.output<typeof McpServerConfig>;

export const McpClientSettings = z.object({
  servers: z
    .array(McpServerConfig)
    .max(32)
    .refine((servers) => new Set(servers.map((s) => s.id)).size === servers.length, "server ids must be unique")
});
export type McpClientSettings = z.output<typeof McpClientSettings>;

/** Commands, environments and headers carry credentials: the section never leaves this machine. */
export const MCP_SERVERS_SECTION: SettingsSection<McpClientSettings> = {
  id: "mcpServers",
  title: "MCP servers",
  description: "External MCP servers whose tools Tomrade's agents can call.",
  schema: McpClientSettings,
  defaults: { servers: [] },
  order: 30,
  scope: "machine"
};

/** Hosts prefix a server name (`mcp__tomrade__`, 14 characters) and cap tool names at 64. */
export const TOOL_NAME_MAX = 50;

/** `<server>__<tool>`, name-safe; an overlong name keeps its start and a hash of the original, so it stays unique. */
export function toolName(serverId: string, remote: string): string {
  const name = `${serverId}__${remote.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  if (name.length <= TOOL_NAME_MAX) return name;
  const hash = createHash("sha1").update(remote).digest("hex").slice(0, 6);
  return `${name.slice(0, TOOL_NAME_MAX - 7)}_${hash}`;
}

/** The one line a person recognises a server by: its command line, or its URL. */
export function targetOf(config: McpServerConfig): string {
  const t = config.transport;
  return t.type === "stdio" ? [t.command, ...t.args].join(" ") : t.url;
}
