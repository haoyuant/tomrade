import fs from "node:fs";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { CURSOR_HOOK_SCRIPT, cursorHookScript, withCursorHooks } from "@tomradex/engine-cursor";
import { opencodePlugin, withMcpEntry } from "@tomradex/engine-opencode";
import { outsideExtension } from "@tomradex/engine-pi";
import { HOOK_EVENTS } from "./sessions.js";
import { syncPrompt, syncSteps } from "./sync.js";

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
const MARKED_SECTION = /^<!-- BEGIN TOMRADE -->[ \t]*\r?$[\s\S]*?^<!-- END TOMRADE -->[ \t]*\r?(?:\n|$)/m;
// Written before the markers: only a heading line that is exactly `## Tomrade`, never `### Tomrade tips`.
const LEGACY_HEADING = /^## Tomrade[ \t]*\r?$/m;
const CODEX_START = "# BEGIN TOMRADE MCP";
const CODEX_END = "# END TOMRADE MCP";
export const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SessionEnd"] as const;

/** Agents whose committed hooks name themselves; Claude Code's carry no header. */
export type HookAgent = "codex" | "workbuddy" | "cursor";

/** Pi has no command hooks: a project extension registers the server and reports instead. */
export const PI_EXTENSION = ".pi/extensions/tomrade.ts";
/** OpenCode loads a project plugin from here by itself. */
export const OPENCODE_PLUGIN = ".opencode/plugins/tomrade.js";

export function hookCommand(eventUrl: string, agent?: HookAgent): string {
  const url = eventUrl.replace(/'/g, "'\\''");
  return `curl -s -m 2 -X POST -H 'Content-Type: application/json'${agent ? ` -H 'X-Tomrade-Agent: ${agent}'` : ""} --data-binary @- '${url}' >/dev/null 2>&1 || true`;
}

/** Keep comments and unrelated tables; inline-array hooks need TOML reserialization to append safely. */
function withCodexHooks(existing: string, eventUrl: string): string {
  const start = "# BEGIN TOMRADE HOOKS";
  const end = "# END TOMRADE HOOKS";
  const command = hookCommand(eventUrl, "codex");
  const block = [start, ...CODEX_HOOK_EVENTS.flatMap((event) => [
    `[[hooks.${event}]]`, `[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${JSON.stringify(command)}`, "timeout = 3", ""
  ]), end].join("\n");
  const clean = existing.replace(/# BEGIN TOMRADE HOOKS[\s\S]*?# END TOMRADE HOOKS\n?/, "").trimEnd();
  const candidate = `${clean}\n\n${block}\n`;
  try {
    if (clean.includes("X-Tomrade-Agent: codex")) throw new Error("update serialized hooks");
    parseToml(candidate);
    return candidate;
  } catch {
    // Array literals cannot be extended with array-of-table syntax.
    const config = parseToml(clean);
    const hooks = (config.hooks ?? {}) as Record<string, unknown>;
    for (const event of CODEX_HOOK_EVENTS) {
      const entries = Array.isArray(hooks[event]) ? hooks[event] as { hooks?: { type?: string; command?: string; timeout?: number }[] }[] : [];
      hooks[event] = entries.flatMap((entry) => {
        if (!Array.isArray(entry.hooks)) return [entry];
        const kept = entry.hooks.filter((hook) => !hook.command?.includes("X-Tomrade-Agent: codex"));
        return kept.length ? [{ ...entry, hooks: kept }] : [];
      }).concat([{ hooks: [{ type: "command", command, timeout: 3 }] }]);
    }
    return stringifyToml({ ...config, hooks });
  }
}

/**
 * The CLAUDE.md section that tells any coding agent how this repository and
 * Tomrade stay in step — when the work has a ticket at all. Claude Code reads
 * the project's rules in the MCP server's instructions; agents that read
 * AGENTS.md (Codex) take those for tool notes, so `fetchRules` has them ask.
 */
export function tomradeSection(input: ConnectInput, options: { fetchRules?: boolean } = {}): string {
  const example = `${input.prefix}-42`;
  return [
    SECTION_BEGIN,
    SECTION_HEADING,
    "",
    `The backlog for this repository lives in Tomrade (project "${input.projectName}"), reachable as the \`tomrade\` MCP server (\`.mcp.json\` for Claude Code and WorkBuddy, \`.codex/config.toml\` for Codex, \`.pi/extensions/tomrade.ts\` for Pi, \`opencode.json\` for OpenCode).`,
    "Claude Code, Codex, WorkBuddy and Cursor report session lifecycle through repository hooks, Pi through that extension and OpenCode through `.opencode/plugins/tomrade.js`. In Codex, trust the project and review the new hooks with `/hooks`, then start a new session; older Codex versions without hooks must be upgraded. Pi loads the extension once you trust the project. No `notify` setting is changed.",
    "Cursor uses `.cursor/mcp.json`, and `.cursor/hooks.json` runs `.cursor/hooks/tomrade.sh`. Gemini CLI uses `.gemini/settings.json` and does not report its lifecycle, but once it calls `claim_ticket` Tomrade follows the session through its MCP connection: later calls on that connection need no key. Use `note_progress` only when the claim's result says `tracking.tracked` is true.",
    `For other MCP-capable agents, add a Streamable HTTP server named \`tomrade\` with URL ${input.mcpUrl} in that agent's own settings. No configuration is generated for other tools; reading AGENTS.md alone supplies instructions, not MCP tools or session tracking.`,
    "Not every session works on a ticket, and not every ticket involves code. Work without a ticket is fine: never ask for one before starting, and never invent one.",
    ...(options.fetchRules ? ["Before your first reply in every session, call the `tomrade` MCP tool `get_project_rules` and follow what it returns throughout: the person keeps rules there for every agent in this project."] : []),
    "",
    `### When the work is a ticket (the user or the branch names a key such as \`${example}\`)`,
    "",
    `- Call \`claim_ticket("${example}")\` before starting: it returns the ticket and the branch to use, and marks it Doing. A session that claimed a ticket owns only that ticket.`,
    "- Implement only its stated outcome and acceptance criteria; neighboring tickets are context, not extra work. Work you find for another ticket stays untouched — mention it when you sync.",
    `- Branch names follow \`${input.branchTemplate}\` (for example \`${example.toLowerCase()}/short-slug\`); every commit message names the key (\`${example}: …\`).`,
    "- Before pushing, inspect the complete diff against the default branch and remove models, screens, flows, APIs, refactors, and cleanup that the ticket does not require. Then call `link_code` with the pull request URL and `scopeChecked: true`. Never mark a ticket done yourself — merging does that.",
    "- When `claim_ticket` returns `tracking.tracked: true`, call `note_progress` with one line at milestones; otherwise follow its connection instructions first.",
    "",
    "### Syncing back",
    "",
    "When the user asks to sync with Tomrade (in Claude Code: `/tomrade:sync`; in Codex: `$tomrade-sync`):",
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

/** Read a JSON file as an object, or start from nothing; a file that is not JSON is left alone and reported. */
function readJson(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Lay the agent connection files down in a worktree: Claude and Codex each
 * gain a project-scoped `tomrade` MCP server; CLAUDE.md and AGENTS.md gain or
 * replace their marked Tomrade section; Codex gains the `tomrade-sync` skill;
 * `.claude/settings.json` and WorkBuddy's `.codebuddy/settings.json` gain one
 * hook per lifecycle event that posts to Tomrade; WorkBuddy reads `.mcp.json`
 * and AGENTS.md as they are; Pi gains a project extension that does both, and
 * OpenCode a `tomrade` server in opencode.json and a reporting plugin;
 * Cursor's `.cursor/hooks.json` runs a script that posts the same way.
 * Everything else in each file is kept as it was.
 * Returns the files that changed.
 */
export function writeConnectFiles(root: string, input: ConnectInput): string[] {
  const changed: string[] = [];

  const mcpFile = path.join(root, ".mcp.json");
  const mcp = readJson(mcpFile);
  if (!mcp) throw new Error("Cannot update .mcp.json: expected a JSON object");
  const servers = (mcp.mcpServers as Record<string, unknown> | undefined) ?? {};
  const next = { ...mcp, mcpServers: { ...servers, tomrade: { type: "http", url: input.mcpUrl } } };
  const nextText = JSON.stringify(next, null, 2) + "\n";
  if (!fs.existsSync(mcpFile) || fs.readFileSync(mcpFile, "utf8") !== nextText) {
    fs.writeFileSync(mcpFile, nextText);
    changed.push(".mcp.json");
  }

  const codexFile = path.join(root, ".codex", "config.toml");
  const codexExisting = fs.existsSync(codexFile) ? fs.readFileSync(codexFile, "utf8") : "";
  const codexText = withCodexHooks(withCodexMcp(codexExisting, input.mcpUrl), input.eventUrl);
  if (codexText !== codexExisting) {
    fs.mkdirSync(path.dirname(codexFile), { recursive: true });
    fs.writeFileSync(codexFile, codexText);
    changed.push(".codex/config.toml");
  }

  for (const [name, server] of [
    [".cursor/mcp.json", { url: input.mcpUrl }],
    [".gemini/settings.json", { httpUrl: input.mcpUrl }]
  ] as const) {
    const file = path.join(root, name);
    const config = readJson(file);
    if (!config) throw new Error(`Cannot update ${name}: expected a JSON object`);
    const text = JSON.stringify({ ...config, mcpServers: { ...(config.mcpServers as Record<string, unknown> ?? {}), tomrade: server } }, null, 2) + "\n";
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      changed.push(name);
    }
  }

  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const file = path.join(root, name);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const body = withTomradeSection(existing, input.projectName, tomradeSection(input, { fetchRules: name === "AGENTS.md" }));
    if (body !== existing) {
      fs.writeFileSync(file, body);
      changed.push(name);
    }
  }

  const skillFile = path.join(root, ".agents", "skills", "tomrade-sync", "SKILL.md");
  const skill = codexSyncSkill(input);
  if (!fs.existsSync(skillFile) || fs.readFileSync(skillFile, "utf8") !== skill) {
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, skill);
    changed.push(".agents/skills/tomrade-sync/SKILL.md");
  }

  const piFile = path.join(root, PI_EXTENSION);
  const piText = outsideExtension(input.mcpUrl, input.eventUrl);
  if (!fs.existsSync(piFile) || fs.readFileSync(piFile, "utf8") !== piText) {
    fs.mkdirSync(path.dirname(piFile), { recursive: true });
    fs.writeFileSync(piFile, piText);
    changed.push(PI_EXTENSION);
  }

  const opencodeFile = path.join(root, "opencode.json");
  const opencodeExisting = fs.existsSync(opencodeFile) ? fs.readFileSync(opencodeFile, "utf8") : "";
  let opencodeText: string;
  try {
    opencodeText = withMcpEntry(opencodeExisting, input.mcpUrl);
  } catch {
    throw new Error("Cannot update opencode.json: expected a JSON object");
  }
  if (opencodeText !== opencodeExisting) {
    fs.writeFileSync(opencodeFile, opencodeText);
    changed.push("opencode.json");
  }
  const opencodePluginFile = path.join(root, OPENCODE_PLUGIN);
  const opencodePluginText = opencodePlugin(input.eventUrl);
  if (!fs.existsSync(opencodePluginFile) || fs.readFileSync(opencodePluginFile, "utf8") !== opencodePluginText) {
    fs.mkdirSync(path.dirname(opencodePluginFile), { recursive: true });
    fs.writeFileSync(opencodePluginFile, opencodePluginText);
    changed.push(OPENCODE_PLUGIN);
  }

  // WorkBuddy's CLI takes Claude Code's hook format in its own settings file.
  for (const [name, agent] of [[".claude/settings.json", undefined], [".codebuddy/settings.json", "workbuddy"]] as const) {
    const settingsFile = path.join(root, name);
    const settings = readJson(settingsFile);
    if (!settings) throw new Error(`Cannot update ${name}: expected a JSON object`);
    const hooks = { ...((settings.hooks as Record<string, unknown[]> | undefined) ?? {}) };
    const command = hookCommand(input.eventUrl, agent);
    let touched = false;
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
      touched ||= JSON.stringify(entries) !== JSON.stringify(kept);
    }
    if (touched) {
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, hooks }, null, 2) + "\n");
      changed.push(name);
    }
  }
  const cursorHooksFile = path.join(root, ".cursor", "hooks.json");
  const cursorHooksExisting = fs.existsSync(cursorHooksFile) ? fs.readFileSync(cursorHooksFile, "utf8") : "";
  let cursorHooksText: string;
  try {
    cursorHooksText = withCursorHooks(cursorHooksExisting);
  } catch {
    throw new Error("Cannot update .cursor/hooks.json: expected a JSON object");
  }
  if (cursorHooksText !== cursorHooksExisting) {
    fs.mkdirSync(path.dirname(cursorHooksFile), { recursive: true });
    fs.writeFileSync(cursorHooksFile, cursorHooksText);
    changed.push(".cursor/hooks.json");
  }
  const cursorScriptFile = path.join(root, CURSOR_HOOK_SCRIPT);
  const cursorScriptText = cursorHookScript(hookCommand(input.eventUrl, "cursor"));
  if (!fs.existsSync(cursorScriptFile) || fs.readFileSync(cursorScriptFile, "utf8") !== cursorScriptText) {
    fs.mkdirSync(path.dirname(cursorScriptFile), { recursive: true });
    fs.writeFileSync(cursorScriptFile, cursorScriptText, { mode: 0o755 });
    changed.push(CURSOR_HOOK_SCRIPT);
  }
  return changed;
}
