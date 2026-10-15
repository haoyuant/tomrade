import type { Git } from "@tomradex/storage";
import { HOOK_EVENTS } from "./sessions.js";

export interface ConnectionView {
  state: "unconnected" | "connected" | "pending" | "other-instance" | "no-checkout" | "unavailable";
  mcpUrl: string | null;
  configuredUrl: string | null;
  instance: "packaged" | "dev";
  branch: string;
  url: string | null;
}

/** Inspect committed configuration, never the currently checked-out ticket's files. */
export async function inspectConnection(git: Git, cwd: string, ref: string, mcpUrl: string, eventUrl: string): Promise<{ connected: boolean; configuredUrl: string | null }> {
  const read = async (file: string) => {
    const result = await git(["show", `${ref}:${file}`], { cwd, ok: true });
    try { return result.code === 0 ? JSON.parse(result.stdout) : null; } catch { return null; }
  };
  const [mcp, settings] = await Promise.all([read(".mcp.json"), read(".claude/settings.json")]);
  const configuredUrl = typeof mcp?.mcpServers?.tomrade?.url === "string" ? mcp.mcpServers.tomrade.url : null;
  const hooks = HOOK_EVENTS.every((event) => Array.isArray(settings?.hooks?.[event]) && settings.hooks[event].some((entry: { hooks?: { command?: string }[] }) =>
    Array.isArray(entry?.hooks) && entry.hooks.some((hook) => typeof hook?.command === "string" && hook.command.includes(`'${eventUrl}'`))));
  return { connected: configuredUrl === mcpUrl && hooks, configuredUrl };
}
