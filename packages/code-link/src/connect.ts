import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { CURSOR_HOOK_POWERSHELL, CURSOR_HOOK_SCRIPT, LEGACY_CURSOR_HOOK_SCRIPT, cursorHookPowerShell, cursorHookScript, withCursorHooks } from "./cursor-hooks.js";
import { opencodePlugin, withMcpEntry } from "./opencode-files.js";
import { HERDR_PANE_HEADER, HOOK_EVENTS, TERMINAL_HEADER, WT_HEADER, stripJsonComments } from "./sessions.js";
import { syncPrompt, syncSteps } from "./sync.js";

/** The agents a repository can be connected for, in the order they are shown. */
export const CONNECT_AGENTS = ["claude-code", "codex", "workbuddy", "pi", "opencode", "cursor", "gemini"] as const;
export type ConnectAgent = (typeof CONNECT_AGENTS)[number];

/**
 * Why Connect left an agent out: its file has comments or trailing commas a
 * rewrite would lose, cannot be read at all, (Codex) holds hooks Tomrade
 * cannot add to without rewriting the whole file, or is tracked by git while
 * the connection is for this machine only.
 */
export type SkipReason = "comments" | "invalid" | "codex-hooks" | "tracked";
export interface SkippedAgent {
  agent: ConnectAgent;
  file: string;
  reason: SkipReason;
}

export interface ConnectInput {
  projectName: string;
  /** The project-scoped MCP endpoint every developer's Claude Code connects to. */
  mcpUrl: string;
  /** Where committed hooks post their lifecycle events (tokenless). */
  eventUrl: string;
  prefix: string;
  branchTemplate: string;
}

const SECTION_HEADING = "## Tomrade";
const SECTION_BEGIN = "<!-- BEGIN TOMRADE -->";
const SECTION_END = "<!-- END TOMRADE -->";
// The BEGIN nearest its END: a BEGIN that lost its END stays the person's text, as does all that follows it.
const MARKED_SECTION = /^<!-- BEGIN TOMRADE -->[ \t]*\r?$(?:(?!^<!-- BEGIN TOMRADE -->)[\s\S])*?^<!-- END TOMRADE -->[ \t]*\r?(?:\n|$)/m;
// Written before the markers: only a heading line that is exactly `## Tomrade`, never `### Tomrade tips`.
const LEGACY_HEADING = /^## Tomrade[ \t]*\r?$/m;
const CODEX_START = "# BEGIN TOMRADE MCP";
const CODEX_END = "# END TOMRADE MCP";
export const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SessionEnd"] as const;

/** Agents whose committed hooks name themselves; Claude Code's carry no header. */
export type HookAgent = "codex" | "workbuddy" | "cursor";

/** Pi has no command hooks: a project extension registers the server and reports instead. */
export const PI_EXTENSION = ".pi/extensions/tomrade.ts";

/**
 * A file Connect lays down for an agent whose engine knows its format best:
 * the engine registers it (`ctx.codeLink.registerConnector`) and code-link
 * imports no engine. Its path stays here, in CONNECT_FILES.
 */
export interface ConnectFileWriter {
  /** The file's text for this project's MCP endpoint and the hooks' event endpoint. */
  write(mcpUrl: string, eventUrl: string): string;
  /** The MCP endpoint a written file names, or null when it names none. */
  url(text: string): string | null;
}

/** The agents whose connection file an engine writes: Pi's, at PI_EXTENSION. */
export type ConnectorAgent = "pi";
/** The writer registered for an agent, read when Connect runs. */
export type Connectors = (agent: ConnectorAgent) => ConnectFileWriter | undefined;
export const NO_CONNECTORS: Connectors = () => undefined;
/** OpenCode loads a project plugin from here by itself. */
export const OPENCODE_PLUGIN = ".opencode/plugins/tomrade.js";
/** Claude Code's personal settings for one checkout: a machine-only connection keeps its hooks there. */
export const CLAUDE_LOCAL_SETTINGS = ".claude/settings.local.json";
export const CODEX_SYNC_SKILL = ".agents/skills/tomrade-sync/SKILL.md";
/** Every file a connection may write, committed or for this machine only, and the Cursor script an older Tomrade wrote. */
export const CONNECT_FILES = [".mcp.json", ".claude/settings.json", CLAUDE_LOCAL_SETTINGS, ".codebuddy/settings.json", ".codex/config.toml", CODEX_SYNC_SKILL, PI_EXTENSION, "opencode.json", OPENCODE_PLUGIN, ".cursor/mcp.json", ".cursor/hooks.json", CURSOR_HOOK_SCRIPT, CURSOR_HOOK_POWERSHELL, LEGACY_CURSOR_HOOK_SCRIPT, ".gemini/settings.json", "CLAUDE.md", "AGENTS.md"] as const;

/**
 * The committed hook's command, read alike by every shell these agents run
 * hooks in: sh, bash, zsh and Git Bash, and PowerShell (Codex's on Windows,
 * Claude Code's where Windows has no Git Bash). Each `set tomrade "$(…)"`
 * keeps a command's output in a variable — Set-Variable, to PowerShell — so
 * nothing reaches the agent, and the hook exits 0 whether Tomrade answered or
 * not. Windows PowerShell's `curl` alias goes first, so curl.exe answers;
 * other shells find no such command, quietly.
 *
 * `reply` is for the hooks of a session Tomrade started: Tomrade's answer (a
 * denied tool, context to add) is left on stdout for the agent to read.
 */
export function hookCommand(eventUrl: string, agent?: HookAgent, options: { reply?: boolean; seconds?: number; source?: "dsh-hooks"; terminal?: boolean; wt?: boolean } = {}): string {
  // Within double quotes sh or PowerShell would expand these; a URL carries them percent-encoded.
  const url = eventUrl.replace(/["$`\\]/g, encodeURIComponent);
  const curl = `curl -s -m ${options.seconds ?? 2} -X POST -H "Content-Type: application/json" ${HERDR_PANE_HEADER}${options.terminal === false ? "" : ` ${TERMINAL_HEADER}`}${options.terminal === false || options.wt === false ? "" : ` ${WT_HEADER}`}${agent ? ` -H "X-Tomrade-Agent: ${agent}"` : ""}${options.source ? ` -H "X-Tomrade-Source: ${options.source}"` : ""} --data-binary "@-" "${url}"`;
  return `set tomrade "$(Remove-Item Alias:curl -Force -ErrorAction Ignore 2>&1)"; ${options.reply ? curl : `set tomrade "$(${curl} 2>&1)"`}; exit 0`;
}

/**
 * The POSIX-only command: Cursor's script runs it under sh, and an older
 * Tomrade committed it as the hook itself — `pane: false` from before hooks
 * named their herdr pane — which still counts as connected.
 */
export function posixHookCommand(eventUrl: string, agent?: HookAgent, options: { pane?: boolean; terminal?: boolean; wt?: boolean } = {}): string {
  const url = eventUrl.replace(/'/g, "'\\''");
  return `curl -s -m 2 -X POST -H 'Content-Type: application/json'${options.pane === false ? "" : ` ${HERDR_PANE_HEADER}`}${options.pane === false || options.terminal === false ? "" : ` ${TERMINAL_HEADER}`}${options.pane === false || options.terminal === false || options.wt === false ? "" : ` ${WT_HEADER}`}${agent ? ` -H 'X-Tomrade-Agent: ${agent}'` : ""} --data-binary @- '${url}' >/dev/null 2>&1 || true`;
}

/** Every command of ours a hook may carry: today's, the ones from before hooks named their terminal or Windows Terminal, and the POSIX ones an older Tomrade committed. */
export const hookCommands = (eventUrl: string, agent?: HookAgent): string[] => [
  hookCommand(eventUrl, agent),
  hookCommand(eventUrl, agent, { wt: false }),
  hookCommand(eventUrl, agent, { terminal: false }),
  posixHookCommand(eventUrl, agent),
  posixHookCommand(eventUrl, agent, { wt: false }),
  posixHookCommand(eventUrl, agent, { terminal: false }),
  posixHookCommand(eventUrl, agent, { pane: false })
];

/** The same report in PowerShell, for a script that gets the payload piped in (or on stdin); it gives up after 2 s and exits 0. */
export function powershellHook(eventUrl: string, agent: HookAgent): string {
  return [
    '$body = [Text.Encoding]::UTF8.GetBytes((@($input) -join "`n"))',
    "if (-not $body.Length -and [Console]::IsInputRedirected) { $stdin = New-Object IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($stdin); $body = $stdin.ToArray() }",
    `$headers = @{ 'X-Tomrade-Agent' = '${agent}' }`,
    "if ($env:HERDR_PANE_ID) { $headers['X-Tomrade-Herdr-Pane'] = $env:HERDR_PANE_ID }",
    "if ($env:TERM_PROGRAM) { $headers['X-Tomrade-Terminal'] = $env:TERM_PROGRAM } elseif ($env:WT_SESSION) { $headers['X-Tomrade-WT'] = $env:WT_SESSION }",
    `try { Invoke-WebRequest -UseBasicParsing -Method Post -Uri '${eventUrl.replace(/'/g, "''")}' -TimeoutSec 2 -ContentType 'application/json' -Headers $headers -Body $body -ErrorAction Stop | Out-Null } catch { }`,
    "exit 0"
  ].join("\n");
}

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** A URL, or text naming URLs, with every host and port taken out: the project id in the path is what tells two Tomrades' addresses apart. */
export const anyHost = (text: string): string => text.replace(/https?:\/\/[^/\s"']+/g, "");

/** Whether `text` names `url` on any host and port. */
export function namesEndpoint(text: string | undefined, url: string): boolean {
  return !!text && [...text.matchAll(/https?:\/\/[^\s"']+/g)].some((match) => anyHost(match[0]) === anyHost(url));
}

/**
 * Whether every event runs one of `commands` among its hooks, in Claude
 * Code's (and Codex's) hook format; `loose` takes the same command posting
 * to another host or port as well.
 */
export function hasHooks(config: Record<string, unknown>, events: readonly string[], commands: string | string[], loose = false): boolean {
  const ours = Array.isArray(commands) ? commands : [commands];
  const same = (found: unknown) => typeof found === "string" && ours.some((command) => found === command || (loose && anyHost(found) === anyHost(command)));
  return events.every((event) => {
    const entries = object(config.hooks)[event];
    return Array.isArray(entries) && entries.some((entry) => {
      const hooks = object(entry).hooks;
      return Array.isArray(hooks) && hooks.some((hook) => same(object(hook).command));
    });
  });
}

/**
 * Tomrade's hooks between their markers, everything else as it was — or null
 * when that cannot be done without rewriting the file: inline hook arrays take
 * no array-of-table entries, and Tomrade hooks outside the markers (an older
 * Tomrade serialised the whole file) cannot be replaced in place.
 */
function withCodexHooks(existing: string, eventUrl: string): string | null {
  const start = "# BEGIN TOMRADE HOOKS";
  const end = "# END TOMRADE HOOKS";
  const command = hookCommand(eventUrl, "codex");
  const block = [start, ...CODEX_HOOK_EVENTS.flatMap((event) => [
    `[[hooks.${event}]]`, `[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${JSON.stringify(command)}`, "timeout = 3", ""
  ]), end].join("\n");
  const clean = existing.replace(/# BEGIN TOMRADE HOOKS[\s\S]*?# END TOMRADE HOOKS\n?/, "").trimEnd();
  try {
    if (clean.includes("X-Tomrade-Agent: codex")) return hasHooks(parseToml(clean), CODEX_HOOK_EVENTS, hookCommands(eventUrl, "codex")) ? existing : null;
    const candidate = `${clean}\n\n${block}\n`;
    parseToml(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * The CLAUDE.md section that tells any coding agent how this repository and
 * Tomrade stay in step — when the work has a ticket at all, and only where
 * the `tomrade` server is reachable: the file is committed, Tomrade is one
 * developer's. Claude Code reads the project's rules in the MCP server's
 * instructions; agents that read AGENTS.md (Codex) take those for tool
 * notes, so `fetchRules` has them ask.
 */
export function tomradeSection(input: ConnectInput, options: { fetchRules?: boolean } = {}): string {
  const example = `${input.prefix}-42`;
  return [
    SECTION_BEGIN,
    SECTION_HEADING,
    "",
    `The backlog for this repository lives in Tomrade (project "${input.projectName}"), reachable as the \`tomrade\` MCP server (\`.mcp.json\` for Claude Code and WorkBuddy, \`.codex/config.toml\` for Codex, \`.pi/extensions/tomrade.ts\` for Pi, \`opencode.json\` for OpenCode).`,
    "This section applies only when the `tomrade` MCP server is available in your session. Tomrade runs on one developer's machine; without it (no such server, or its tools fail to connect) everything below is void: work as usual, never try to reach Tomrade another way, and never mention tickets you cannot read.",
    "Claude Code, Codex, WorkBuddy and Cursor report session lifecycle through repository hooks, Pi through that extension and OpenCode through `.opencode/plugins/tomrade.js`. In Codex, trust the project and review the new hooks with `/hooks`, then start a new session; older Codex versions without hooks must be upgraded. Pi loads the extension once you trust the project. No `notify` setting is changed.",
    "Cursor uses `.cursor/mcp.json`, and `.cursor/hooks.json` runs `.cursor/hooks/tomrade` (`.cursor/hooks/tomrade.ps1` on Windows). Gemini CLI uses `.gemini/settings.json` and does not report its lifecycle, but once it calls `claim_ticket` Tomrade follows the session through its MCP connection: later calls on that connection need no key. Use `note_progress` only when the claim's result says `tracking.tracked` is true.",
    `For other MCP-capable agents, add a Streamable HTTP server named \`tomrade\` with URL ${input.mcpUrl} in that agent's own settings. No configuration is generated for other tools; reading AGENTS.md alone supplies instructions, not MCP tools or session tracking.`,
    "Not every session works on a ticket, and not every ticket involves code. Work without a ticket is fine: never ask for one before starting, and never invent one.",
    ...(options.fetchRules ? ["When the `tomrade` MCP server is available, call its tool `get_project_rules` before your first reply in every session and follow what it returns throughout: the person keeps rules there for every agent in this project."] : []),
    "",
    `### When the work is a ticket (the user or the branch names a key such as \`${example}\`) and the \`tomrade\` server is available`,
    "",
    `- Call \`claim_ticket("${example}")\` before starting: it returns the ticket and the branch to use, and marks it Doing. A session that claimed a ticket owns only that ticket.`,
    "- Implement only its stated outcome and acceptance criteria; neighboring tickets are context, not extra work. Work you find for another ticket stays untouched — mention it when you sync.",
    `- Branch names follow \`${input.branchTemplate}\` (for example \`${example.toLowerCase()}/short-slug\`); every commit message names the key (\`${example}: …\`).`,
    "- Before pushing, inspect the complete diff against the default branch and remove models, screens, flows, APIs, refactors, and cleanup that the ticket does not require. Then call `link_code` with the pull request URL and `scopeChecked: true`. Never mark a ticket done yourself — merging does that.",
    "- When `claim_ticket` returns `tracking.tracked: true`, call `note_progress` with one line at milestones; otherwise follow its connection instructions first.",
    "",
    "### Syncing back",
    "",
    "When the user asks to sync with Tomrade (in Claude Code: `/tomrade:sync`; in Codex: `$tomrade-sync`) and the `tomrade` server is available:",
    "",
    ...syncSteps(),
    "",
    "When a meaningful piece of work looks like it belongs to a ticket, you may offer once to sync it back; drop it if the user declines.",
    SECTION_END,
    ""
  ].join("\n");
}

/** Codex reads no MCP prompts; a repository skill is its `/tomrade:sync`, invoked as `$tomrade-sync`. */
export function codexSyncSkill(input: ConnectInput): string {
  return [
    "---",
    "name: tomrade-sync",
    // A JSON string is a valid YAML scalar whatever the project is called.
    `description: ${JSON.stringify(`Bring this session's work back into the Tomrade backlog (project "${input.projectName}") when the user asks to sync with Tomrade — match it to tickets, link code, update status, file follow-ups.`)}`,
    "---",
    "",
    syncPrompt({ projectName: input.projectName, prefix: input.prefix }),
    ""
  ].join("\n");
}

/** Whether agent instructions carry the Tomrade section, marked or from before the markers. */
export function hasTomradeSection(text: string | undefined): boolean {
  return !!text && (MARKED_SECTION.test(text) || LEGACY_HEADING.test(text));
}

/** Tomrade owns only what lies between its markers; everything around them is the person's. */
function withTomradeSection(existing: string, projectName: string, section: string): string {
  const marked = MARKED_SECTION.exec(existing);
  if (marked) return existing.slice(0, marked.index) + section + existing.slice(marked.index + marked[0].length);
  // An unmarked section ends at the next heading of its level or above; reconnecting marks it.
  const legacy = LEGACY_HEADING.exec(existing);
  if (legacy) {
    const body = legacy.index + legacy[0].length;
    const next = /^ {0,3}#{1,2}(?:[ \t]|\r?$)/m.exec(existing.slice(body));
    return existing.slice(0, legacy.index) + section + (next ? `\n${existing.slice(body + next.index)}` : "");
  }
  return existing ? `${existing.replace(/\s*$/, "")}\n\n${section}` : `# ${projectName}\n\n${section}`;
}

/** Preserve unrelated Codex config while owning one clearly marked MCP table. */
function withCodexMcp(existing: string, url: string): string {
  const block = `${CODEX_START}\n[mcp_servers.tomrade]\nurl = ${JSON.stringify(url)}\n${CODEX_END}`;
  const marked = new RegExp(`${CODEX_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${CODEX_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  if (marked.test(existing)) return existing.replace(marked, block);

  // Adopt an unmarked table written by an older/manual setup, up to the next table.
  const table = /^\s*\[mcp_servers(?:\.tomrade|\."tomrade")\]\s*(?:#.*)?$/m.exec(existing);
  if (table?.index !== undefined) {
    const rest = existing.slice(table.index + table[0].length);
    const next = /^\s*\[[^\n]+\]\s*(?:#.*)?$/m.exec(rest);
    const end = next?.index === undefined ? existing.length : table.index + table[0].length + next.index;
    return `${existing.slice(0, table.index)}${block}\n${existing.slice(end).replace(/^\s*/, "")}`;
  }
  return existing ? `${existing.replace(/\s*$/, "")}\n\n${block}\n` : `${block}\n`;
}

class Unwritable extends Error {
  constructor(readonly file: string, readonly reason: SkipReason) {
    super(`Cannot update ${file}: ${reason}`);
  }
}

function isJsonObject(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as unknown;
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

const sameJson = (a: string, b: string) => JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));

/**
 * A JSON config's next text, or null when it already says what it should. One
 * with comments or trailing commas is read but never rewritten, which would
 * drop them, and one that is no JSON object is left as it is.
 */
function nextJson(root: string, name: string, change: (json: string) => string): string | null {
  const file = path.join(root, name);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (!text.trim()) return change("");
  if (isJsonObject(text)) {
    const next = change(text);
    return sameJson(next, text) ? null : next;
  }
  const loose = stripJsonComments(text);
  if (!isJsonObject(loose)) throw new Unwritable(name, "invalid");
  if (sameJson(change(loose), loose)) return null;
  throw new Unwritable(name, "comments");
}

const withServer = (server: Record<string, unknown>) => (json: string) => {
  const config = object(json ? JSON.parse(json) : {});
  return JSON.stringify({ ...config, mcpServers: { ...object(config.mcpServers), tomrade: server } }, null, 2) + "\n";
};

/** One lifecycle hook per event after the person's own, replacing any Tomrade hook from before. */
const withSessionHooks = (command: string) => (json: string) => {
  const settings = object(json ? JSON.parse(json) : {});
  const hooks = { ...((settings.hooks as Record<string, unknown[]> | undefined) ?? {}) };
  for (const event of HOOK_EVENTS) {
    const entries = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    const kept = entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || !Array.isArray((entry as { hooks?: unknown }).hooks)) return [entry];
      const row = entry as { hooks: { command?: string }[] };
      const unrelated = row.hooks.filter((hook) => !hook.command?.includes("/sessions/event"));
      return unrelated.length ? [{ ...row, hooks: unrelated }] : [];
    });
    kept.push({ hooks: [{ type: "command", command }] });
    hooks[event] = kept;
  }
  return JSON.stringify({ ...settings, hooks }, null, 2) + "\n";
};

/** Claude Code loads the checkout's `.mcp.json` server without asking once its settings list it; a rejection from before gives way. */
const withApprovedServer = (json: string) => {
  const settings = object(json ? JSON.parse(json) : {});
  const list = (key: string) => (Array.isArray(settings[key]) ? settings[key] as unknown[] : []);
  const enabled = list("enabledMcpjsonServers").includes("tomrade") ? list("enabledMcpjsonServers") : [...list("enabledMcpjsonServers"), "tomrade"];
  const disabled = list("disabledMcpjsonServers").filter((name) => name !== "tomrade");
  return JSON.stringify({ ...settings, enabledMcpjsonServers: enabled, ...(settings.disabledMcpjsonServers === undefined ? {} : { disabledMcpjsonServers: disabled }) }, null, 2) + "\n";
};

/**
 * A connection for this machine only: the files go into the checkout
 * untracked, so one git already tracks cannot be changed, and the agent
 * instruction files stay the team's.
 */
export interface LocalConnect {
  tracked: ReadonlySet<string>;
}

/**
 * Lay the chosen agents' connection files down in a worktree: Claude and Codex
 * each gain a project-scoped `tomrade` MCP server; CLAUDE.md and AGENTS.md
 * gain or replace their marked Tomrade section; Codex gains the
 * `tomrade-sync` skill; `.claude/settings.json` and WorkBuddy's
 * `.codebuddy/settings.json` gain one hook per lifecycle event that posts to
 * Tomrade; WorkBuddy reads `.mcp.json` and AGENTS.md as they are; Pi gains a
 * project extension that does both, and OpenCode a `tomrade` server in
 * opencode.json and a reporting plugin; Cursor's `.cursor/hooks.json` runs a
 * script that posts the same way. Everything else in each file is kept as it
 * was. An agent whose file cannot be changed without losing what is in it is
 * skipped whole and reported, never failing the others.
 *
 * For this machine only (`local`), the same files go into the checkout
 * itself: Claude Code's hooks and its approval of the `.mcp.json` server in
 * `.claude/settings.local.json`, no instruction section, and no change to a
 * file git tracks — that agent is skipped and says so.
 */
export function writeConnectFiles(root: string, input: ConnectInput, agents: readonly ConnectAgent[] = CONNECT_AGENTS, local?: LocalConnect, connectors: Connectors = NO_CONNECTORS): { files: string[]; skipped: SkippedAgent[] } {
  interface Write { name: string; text: string | null; mode?: number }
  const read = (name: string) => {
    const file = path.join(root, name);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  };
  const exact = (name: string, text: string, mode?: number): Write => ({ name, text: read(name) === text ? null : text, ...(mode ? { mode } : {}) });
  const json = (name: string, change: (json: string) => string): Write => ({ name, text: nextJson(root, name, change) });
  const section = (name: "CLAUDE.md" | "AGENTS.md"): Write[] => {
    if (local) return [];
    const existing = read(name) ?? "";
    const body = withTomradeSection(existing, input.projectName, tomradeSection(input, { fetchRules: name === "AGENTS.md" }));
    return [{ name, text: body === existing ? null : body }];
  };
  const skipped: SkippedAgent[] = [];
  const codex = (): Write => {
    const name = ".codex/config.toml";
    const existing = read(name) ?? "";
    const withMcp = withCodexMcp(existing, input.mcpUrl);
    try {
      parseToml(existing);
      parseToml(withMcp);
    } catch {
      throw new Unwritable(name, "invalid");
    }
    const text = withCodexHooks(withMcp, input.eventUrl);
    // Its MCP server still goes in; only the hooks wait for the person.
    if (text === null) skipped.push({ agent: "codex", file: name, reason: "codex-hooks" });
    const next = text ?? withMcp;
    return { name, text: next === existing ? null : next };
  };
  const mcp = () => json(".mcp.json", withServer({ type: "http", url: input.mcpUrl }));
  const claudeHooks = withSessionHooks(hookCommand(input.eventUrl));
  // Without its engine's writer (the engine is off), Pi gets the instructions alone.
  const pi = connectors("pi");
  const plans: Record<ConnectAgent, () => Write[]> = {
    "claude-code": () => [mcp(), local ? json(CLAUDE_LOCAL_SETTINGS, (text) => withApprovedServer(claudeHooks(text))) : json(".claude/settings.json", claudeHooks), ...section("CLAUDE.md")],
    codex: () => [codex(), ...section("AGENTS.md"), exact(CODEX_SYNC_SKILL, codexSyncSkill(input))],
    // WorkBuddy's CLI takes Claude Code's hook format in its own settings file.
    workbuddy: () => [mcp(), json(".codebuddy/settings.json", withSessionHooks(hookCommand(input.eventUrl, "workbuddy"))), ...section("AGENTS.md")],
    pi: () => [...(pi ? [exact(PI_EXTENSION, pi.write(input.mcpUrl, input.eventUrl))] : []), ...section("AGENTS.md")],
    opencode: () => [json("opencode.json", (text) => withMcpEntry(text, input.mcpUrl)), exact(OPENCODE_PLUGIN, opencodePlugin(input.eventUrl)), ...section("AGENTS.md")],
    cursor: () => [json(".cursor/mcp.json", withServer({ url: input.mcpUrl })), json(".cursor/hooks.json", withCursorHooks), exact(CURSOR_HOOK_SCRIPT, cursorHookScript(posixHookCommand(input.eventUrl, "cursor")), 0o755), exact(CURSOR_HOOK_POWERSHELL, cursorHookPowerShell(powershellHook(input.eventUrl, "cursor"))), ...section("AGENTS.md")],
    gemini: () => [json(".gemini/settings.json", withServer({ httpUrl: input.mcpUrl }))]
  };

  // Every file an agent needs is worked out before anything is written, so one it cannot have leaves that agent out whole.
  const writes = new Map<string, Write>();
  for (const agent of CONNECT_AGENTS.filter((id) => agents.includes(id))) {
    try {
      for (const write of plans[agent]()) {
        if (write.text !== null && local?.tracked.has(write.name)) throw new Unwritable(write.name, "tracked");
        writes.set(write.name, write);
      }
    } catch (error) {
      if (!(error instanceof Unwritable)) throw error;
      skipped.push({ agent, file: error.file, reason: error.reason });
    }
  }
  const files: string[] = [];
  for (const { name, text, mode } of writes.values()) {
    if (text === null) continue;
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, mode ? { mode } : undefined);
    files.push(name);
  }
  return { files, skipped };
}
