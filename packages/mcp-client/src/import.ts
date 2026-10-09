import { McpServerConfig } from "./config.js";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function slug(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 24) || "server";
  let id = base;
  for (let i = 2; taken.has(id); i += 1) id = `${base.slice(0, 24 - String(i).length - 1)}-${i}`;
  taken.add(id);
  return id;
}

/**
 * The `mcpServers` block other MCP clients print in their READMEs (Claude
 * Desktop, Cursor, VS Code's `servers`), as Tomrade server configurations.
 * `taken` are ids already in use; imported ids never collide with them.
 */
export function parseClientConfig(text: string, taken: string[] = []): { servers: McpServerConfig[]; errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { servers: [], errors: [`not JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const block = isRecord(json) ? (json.mcpServers ?? json.servers ?? json) : null;
  if (!isRecord(block)) return { servers: [], errors: ["expected an object of servers"] };
  const entries = typeof block.command === "string" || typeof block.url === "string" ? [["server", block] as const] : Object.entries(block);

  const ids = new Set(taken);
  const servers: McpServerConfig[] = [];
  const errors: string[] = [];
  for (const [name, entry] of entries) {
    if (!isRecord(entry)) {
      errors.push(`${name}: not an object`);
      continue;
    }
    const url = entry.url ?? entry.serverUrl;
    const transport =
      typeof entry.command === "string"
        ? { type: "stdio", command: entry.command, args: entry.args ?? [], env: entry.env ?? {}, ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}) }
        : typeof url === "string"
          ? { type: "http", url, headers: entry.headers ?? {} }
          : null;
    if (!transport) {
      errors.push(`${name}: needs a command or a url`);
      continue;
    }
    const parsed = McpServerConfig.safeParse({ id: slug(name, ids), enabled: entry.disabled !== true, transport });
    if (parsed.success) servers.push(parsed.data);
    else errors.push(`${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return { servers, errors };
}
