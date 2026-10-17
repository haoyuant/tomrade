import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Git } from "@tomradex/storage";
import type { McpProjectApproval } from "@tomradex/agent";
import type { PortClash } from "@tomradex/mcp";
import { CURSOR_HOOK_SCRIPT, hasCursorHooks } from "@tomradex/engine-cursor";
import { configuredMcpUrl } from "@tomradex/engine-opencode";
import { outsideExtensionUrl } from "@tomradex/engine-pi";
import { CODEX_HOOK_EVENTS, hasTomradeSection, hookCommand, OPENCODE_PLUGIN, PI_EXTENSION } from "./connect.js";
import { HOOK_EVENTS } from "./sessions.js";

export interface AgentConnectionView {
  id: "claude-code" | "codex" | "workbuddy" | "pi" | "opencode" | "cursor" | "gemini";
  title: string;
  tools: boolean;
  tracking: "hooks" | "none";
  instructions: boolean;
  reviewHooks: boolean;
}

export interface ConnectionView {
  state: "unconnected" | "connected" | "pending" | "other-instance" | "no-checkout" | "unavailable";
  mcpUrl: string | null;
  configuredUrl: string | null;
  instance: "packaged" | "dev";
  branch: string;
  url: string | null;
  agents: AgentConnectionView[];
  /** Once connected: whether Claude Code in the checkout loads the committed `.mcp.json` server, which it asks about once. */
  claudeApproval?: "approved" | "rejected" | "pending";
  /** The same for each Claude Code config folder in use here, with the command that starts Claude Code under it. */
  claudeApprovals?: McpProjectApproval[];
  /** This Tomrade's port was taken, so `mcpUrl` changes at every restart and Connect refuses to write it. */
  clash?: PortClash;
}

const FILES = [".mcp.json", ".claude/settings.json", ".codebuddy/settings.json", ".codex/config.toml", PI_EXTENSION, "opencode.json", OPENCODE_PLUGIN, ".cursor/mcp.json", ".cursor/hooks.json", CURSOR_HOOK_SCRIPT, ".gemini/settings.json", "CLAUDE.md", "AGENTS.md"];
/** Agents whose committed hooks a connected repository carries. */
const HOOKED = new Set<AgentConnectionView["id"]>(["claude-code", "codex", "workbuddy", "pi", "opencode", "cursor"]);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function json(text: string | undefined): Record<string, unknown> {
  try { return object(JSON.parse(text ?? "")); } catch { return {}; }
}
const serverUrl = (config: Record<string, unknown>, key = "url") => object(object(config.mcpServers).tomrade)[key];
function hasHooks(config: Record<string, unknown>, events: readonly string[], command: string): boolean {
  return events.every((event) => {
    const entries = object(config.hooks)[event];
    return Array.isArray(entries) && entries.some((entry) => {
      const hooks = object(entry).hooks;
      return Array.isArray(hooks) && hooks.some((hook) => object(hook).command === command);
    });
  });
}

function opencodeUrl(text: string | undefined): string | null {
  try { return configuredMcpUrl(text || "{}"); } catch { return null; }
}

function inspect(files: Record<string, string>, mcpUrl: string, eventUrl: string) {
  const mcp = json(files[".mcp.json"]);
  const settings = json(files[".claude/settings.json"]);
  let codex: Record<string, unknown> = {};
  try { codex = parseToml(files[".codex/config.toml"] ?? ""); } catch { /* Invalid config is not connected. */ }
  const configuredUrl = typeof serverUrl(mcp) === "string" ? serverUrl(mcp) as string : null;
  const agents: AgentConnectionView[] = [
    { id: "claude-code", title: "Claude Code", tools: configuredUrl === mcpUrl, tracking: hasHooks(settings, HOOK_EVENTS, hookCommand(eventUrl)) ? "hooks" : "none", instructions: hasTomradeSection(files["CLAUDE.md"]), reviewHooks: false },
    { id: "codex", title: "Codex", tools: object(object(codex.mcp_servers).tomrade).url === mcpUrl, tracking: object(codex.features).hooks !== false && hasHooks(codex, CODEX_HOOK_EVENTS, hookCommand(eventUrl, "codex")) ? "hooks" : "none", instructions: hasTomradeSection(files["AGENTS.md"]), reviewHooks: true },
    { id: "workbuddy", title: "WorkBuddy", tools: configuredUrl === mcpUrl, tracking: hasHooks(json(files[".codebuddy/settings.json"]), HOOK_EVENTS, hookCommand(eventUrl, "workbuddy")) ? "hooks" : "none", instructions: hasTomradeSection(files["AGENTS.md"]), reviewHooks: false },
    { id: "pi", title: "Pi", tools: outsideExtensionUrl(files[PI_EXTENSION] ?? "") === mcpUrl, tracking: files[PI_EXTENSION]?.includes(JSON.stringify(eventUrl)) ? "hooks" : "none", instructions: hasTomradeSection(files["AGENTS.md"]), reviewHooks: false },
    { id: "opencode", title: "OpenCode", tools: opencodeUrl(files["opencode.json"]) === mcpUrl, tracking: files[OPENCODE_PLUGIN]?.includes(JSON.stringify(eventUrl)) ? "hooks" : "none", instructions: hasTomradeSection(files["AGENTS.md"]), reviewHooks: false },
    { id: "cursor", title: "Cursor", tools: serverUrl(json(files[".cursor/mcp.json"])) === mcpUrl, tracking: hasCursorHooks(files[".cursor/hooks.json"]) && !!files[CURSOR_HOOK_SCRIPT]?.includes(hookCommand(eventUrl, "cursor")) ? "hooks" : "none", instructions: hasTomradeSection(files["AGENTS.md"]), reviewHooks: false },
    { id: "gemini", title: "Gemini CLI", tools: serverUrl(json(files[".gemini/settings.json"]), "httpUrl") === mcpUrl, tracking: "none", instructions: false, reviewHooks: false }
  ];
  return { agents, configuredUrl, connected: agents.every((agent) => agent.tools) && agents.filter((agent) => HOOKED.has(agent.id)).every((agent) => agent.tracking === "hooks") };
}

export function inspectConnectFiles(root: string, mcpUrl: string, eventUrl: string) {
  const files = Object.fromEntries(FILES.map((file) => {
    try { return [file, fs.readFileSync(path.join(root, file), "utf8")]; } catch { return [file, ""]; }
  }));
  return inspect(files, mcpUrl, eventUrl);
}

/** Inspect committed configuration, never the currently checked-out ticket's files. */
export async function inspectConnection(git: Git, cwd: string, ref: string, mcpUrl: string, eventUrl: string) {
  const files = Object.fromEntries(await Promise.all(FILES.map(async (file) => {
    const result = await git(["show", `${ref}:${file}`], { cwd, ok: true });
    return [file, result.code === 0 ? result.stdout : ""];
  })));
  return inspect(files, mcpUrl, eventUrl);
}
