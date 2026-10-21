import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Git } from "@tomradex/git";
import type { McpProjectApproval } from "@tomradex/agent";
import type { PortClash } from "@tomradex/mcp";
import { cursorHookScripts } from "./cursor-hooks.js";
import { configuredMcpUrl } from "./opencode-files.js";
import { anyHost, CLAUDE_LOCAL_SETTINGS, CODEX_HOOK_EVENTS, CONNECT_FILES, hasHooks, hasTomradeSection, hookCommands, namesEndpoint, OPENCODE_PLUGIN, NO_CONNECTORS, PI_EXTENSION, type ConnectAgent, type Connectors } from "./connect.js";
import { HOOK_EVENTS, stripJsonComments } from "./sessions.js";

export interface AgentConnectionView {
  id: ConnectAgent;
  title: string;
  tools: boolean;
  tracking: "hooks" | "none";
  instructions: boolean;
  reviewHooks: boolean;
  /** Chosen for this repository: Connect writes its files, and only chosen agents decide whether it is connected. */
  chosen: boolean;
  /** When this machine last received the agent's hooks from this repository; absent until it has. */
  lastEventAt?: number;
}

export interface ConnectionView {
  state: "unconnected" | "connected" | "pending" | "other-instance" | "no-checkout" | "unavailable";
  mcpUrl: string | null;
  /** The address the repository's files name; on another host or port with the same project id, it is still connected — to that Tomrade. */
  configuredUrl: string | null;
  instance: "packaged" | "dev";
  branch: string;
  url: string | null;
  agents: AgentConnectionView[];
  /** Connected only through files on this machine, kept out of git; the committed files alone do not connect it. */
  local?: boolean;
  /** Once connected: whether Claude Code in the checkout loads the committed `.mcp.json` server, which it asks about once. */
  claudeApproval?: "approved" | "rejected" | "pending";
  /** The same for each Claude Code config folder in use here, with the command that starts Claude Code under it. */
  claudeApprovals?: McpProjectApproval[];
  /** This Tomrade's port was taken, so `mcpUrl` changes at every restart and Connect refuses to write it. */
  clash?: PortClash;
}

const FILES: readonly string[] = CONNECT_FILES;
/** Agents whose committed hooks a connected repository carries. */
const HOOKED = new Set<AgentConnectionView["id"]>(["claude-code", "codex", "workbuddy", "pi", "opencode", "cursor"]);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function json(text: string | undefined): Record<string, unknown> {
  try { return object(JSON.parse(stripJsonComments(text ?? ""))); } catch { return {}; }
}
const serverUrl = (config: Record<string, unknown>, key = "url") => object(object(config.mcpServers).tomrade)[key];
const asUrl = (value: unknown): string | null => (typeof value === "string" ? value : null);
/** The same project on any Tomrade: a dev build or a teammate on another port is not another instance to reconnect to. */
const sameProject = (configured: string | null, mcpUrl: string) => configured !== null && anyHost(configured) === anyHost(mcpUrl);

function opencodeUrl(text: string | undefined): string | null {
  try { return configuredMcpUrl(stripJsonComments(text || "{}")); } catch { return null; }
}

function inspect(files: Record<string, string>, mcpUrl: string, eventUrl: string, chosen: readonly ConnectAgent[], connectors: Connectors) {
  const mcp = json(files[".mcp.json"]);
  const settings = json(files[".claude/settings.json"]);
  const localSettings = json(files[CLAUDE_LOCAL_SETTINGS]);
  let codex: Record<string, unknown> = {};
  try { codex = parseToml(files[".codex/config.toml"] ?? ""); } catch { /* Invalid config is not connected. */ }
  const urls = {
    mcp: asUrl(serverUrl(mcp)),
    codex: asUrl(object(object(codex.mcp_servers).tomrade).url),
    pi: connectors("pi")?.url(files[PI_EXTENSION] ?? "") ?? null,
    opencode: opencodeUrl(files["opencode.json"]),
    cursor: asUrl(serverUrl(json(files[".cursor/mcp.json"]))),
    gemini: asUrl(serverUrl(json(files[".gemini/settings.json"]), "httpUrl"))
  };
  const configuredUrl = urls.mcp ?? urls.codex ?? urls.pi ?? urls.opencode ?? urls.cursor ?? urls.gemini;
  const claudeHooks = hasHooks(settings, HOOK_EVENTS, hookCommands(eventUrl), true) || hasHooks(localSettings, HOOK_EVENTS, hookCommands(eventUrl), true);
  // Each script the hooks run posts here as Cursor: the sh one names the header as curl does, the PowerShell one as a table.
  const cursorScripts = cursorHookScripts(stripJsonComments(files[".cursor/hooks.json"] ?? ""));
  const cursorHooks = cursorScripts.length > 0 && cursorScripts.every((file) => namesEndpoint(files[file], eventUrl) && /X-Tomrade-Agent(?::|' =) '?cursor\b/.test(files[file] ?? ""));
  const agents = ([
    { id: "claude-code", title: "Claude Code", tools: sameProject(urls.mcp, mcpUrl), tracking: claudeHooks ? "hooks" : "none", instructions: hasTomradeSection(files["CLAUDE.md"]), reviewHooks: false },
    { id: "codex", title: "Codex", tools: sameProject(urls.codex, mcpUrl), tracking: object(codex.features).hooks !== false && hasHooks(codex, CODEX_HOOK_EVENTS, hookCommands(eventUrl, "codex"), true) ? "hooks" : "none", instructions: hasTomradeSection(files["AGENTS.md"]), reviewHooks: true },
    { id: "workbuddy", title: "WorkBuddy", tools: sameProject(urls.mcp, mcpUrl), tracking: hasHooks(json(files[".codebuddy/settings.json"]), HOOK_EVENTS, hookCommands(eventUrl, "workbuddy"), true) ? "hooks" : "none", instructions: hasTomradeSection(files["AGENTS.md"]), reviewHooks: false },
    { id: "pi", title: "Pi", tools: sameProject(urls.pi, mcpUrl), tracking: namesEndpoint(files[PI_EXTENSION], eventUrl) ? "hooks" : "none", instructions: hasTomradeSection(files["AGENTS.md"]), reviewHooks: false },
    { id: "opencode", title: "OpenCode", tools: sameProject(urls.opencode, mcpUrl), tracking: namesEndpoint(files[OPENCODE_PLUGIN], eventUrl) ? "hooks" : "none", instructions: hasTomradeSection(files["AGENTS.md"]), reviewHooks: false },
    { id: "cursor", title: "Cursor", tools: sameProject(urls.cursor, mcpUrl), tracking: cursorHooks ? "hooks" : "none", instructions: hasTomradeSection(files["AGENTS.md"]), reviewHooks: false },
    { id: "gemini", title: "Gemini CLI", tools: sameProject(urls.gemini, mcpUrl), tracking: "none", instructions: false, reviewHooks: false }
  ] satisfies Omit<AgentConnectionView, "chosen">[]).map((agent): AgentConnectionView => ({ ...agent, chosen: chosen.includes(agent.id) }));
  const counted = agents.filter((agent) => agent.chosen);
  return { agents, configuredUrl, sameProject: sameProject(configuredUrl, mcpUrl), connected: counted.length > 0 && counted.every((agent) => agent.tools) && counted.filter((agent) => HOOKED.has(agent.id)).every((agent) => agent.tracking === "hooks") };
}

export function inspectConnectFiles(root: string, mcpUrl: string, eventUrl: string, chosen: readonly ConnectAgent[], connectors: Connectors = NO_CONNECTORS) {
  const files = Object.fromEntries(FILES.map((file) => {
    try { return [file, fs.readFileSync(path.join(root, file), "utf8")]; } catch { return [file, ""]; }
  }));
  return inspect(files, mcpUrl, eventUrl, chosen, connectors);
}

/** Every connection file `ref` holds, read by one `git cat-file --batch`; one it lacks is absent from the map. */
async function committedFiles(git: Git, cwd: string, ref: string): Promise<Map<string, string>> {
  const result = await git(["cat-file", "--batch"], { cwd, ok: true, stdin: FILES.map((file) => `${ref}:${file}\n`).join("") });
  const files = new Map<string, string>();
  if (result.code !== 0) return files;
  // Each answer is "<sha> <type> <size>\n<content>\n", or "<input> missing\n"; sizes count bytes.
  const out = Buffer.from(result.stdout, "utf8");
  let at = 0;
  for (const file of FILES) {
    const end = out.indexOf(10, at);
    if (end === -1) break;
    const header = out.subarray(at, end).toString("utf8").split(" ");
    at = end + 1;
    if (header.length !== 3 || !/^\d+$/.test(header[2]!)) continue;
    const size = Number(header[2]);
    if (header[1] === "blob") files.set(file, out.subarray(at, at + size).toString("utf8"));
    at += size + 1;
  }
  return files;
}

/**
 * Inspect committed configuration, never the currently checked-out ticket's
 * files — plus the files a machine-only connection keeps untracked in the
 * checkout. `local` says the committed files alone would not connect it.
 */
export async function inspectConnection(git: Git, cwd: string, ref: string, mcpUrl: string, eventUrl: string, chosen: readonly ConnectAgent[], connectors: Connectors = NO_CONNECTORS) {
  const listed = await git(["ls-files", "-z", "--", ...FILES], { cwd, ok: true });
  const tracked = new Set(listed.code === 0 ? listed.stdout.split("\0").filter(Boolean) : FILES);
  const found = await committedFiles(git, cwd, ref);
  const committed: Record<string, string> = {};
  const untracked: Record<string, string> = {};
  for (const file of FILES) {
    committed[file] = found.get(file) ?? "";
    if (found.has(file) || tracked.has(file)) continue;
    try { untracked[file] = fs.readFileSync(path.join(cwd, file), "utf8"); } catch { /* Not there: nothing local for it. */ }
  }
  const whole = inspect({ ...committed, ...untracked }, mcpUrl, eventUrl, chosen, connectors);
  const local = whole.connected && !inspect(committed, mcpUrl, eventUrl, chosen, connectors).connected;
  return { ...whole, local };
}
