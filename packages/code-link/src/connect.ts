import fs from "node:fs";
import path from "node:path";
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

const SECTION_START = "## Tomrade";
const CODEX_START = "# BEGIN TOMRADE MCP";
const CODEX_END = "# END TOMRADE MCP";

/** The CLAUDE.md section that tells any coding agent how this repository and Tomrade stay in step — when the work has a ticket at all. */
export function tomradeSection(input: ConnectInput): string {
  const example = `${input.prefix}-42`;
  return [
    SECTION_START,
    "",
    `The backlog for this repository lives in Tomrade (project "${input.projectName}"), reachable as the \`tomrade\` MCP server (\`.mcp.json\` for Claude Code, \`.codex/config.toml\` for Codex).`,
    "Not every session works on a ticket, and not every ticket involves code. Work without a ticket is fine: never ask for one before starting, and never invent one.",
    "",
    `### When the work is a ticket (the user or the branch names a key such as \`${example}\`)`,
    "",
    `- Call \`claim_ticket("${example}")\` before starting: it returns the ticket and the branch to use, and marks it Doing. A session that claimed a ticket owns only that ticket.`,
    "- Implement only its stated outcome and acceptance criteria; neighboring tickets are context, not extra work. Work you find for another ticket stays untouched — mention it when you sync.",
    `- Branch names follow \`${input.branchTemplate}\` (for example \`${example.toLowerCase()}/short-slug\`); every commit message names the key (\`${example}: …\`).`,
    "- Before pushing, inspect the complete diff against the default branch and remove models, screens, flows, APIs, refactors, and cleanup that the ticket does not require. Then call `link_code` with the pull request URL and `scopeChecked: true`. Never mark a ticket done yourself — merging does that.",
    "- Call `note_progress` with one line at milestones; it is what the ticket shows while you work.",
    "",
    "### Syncing back",
    "",
    "When the user asks to sync with Tomrade (in Claude Code: `/tomrade:sync`; in Codex: `$tomrade-sync`):",
    "",
    ...syncSteps(),
    "",
    "When a meaningful piece of work looks like it belongs to a ticket, you may offer once to sync it back; drop it if the user declines.",
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

function withTomradeSection(existing: string, projectName: string, section: string): string {
  const start = existing.indexOf(SECTION_START);
  if (start < 0) return existing ? `${existing.replace(/\s*$/, "")}\n\n${section}` : `# ${projectName}\n\n${section}`;
  const after = existing.indexOf("\n## ", start + SECTION_START.length);
  return existing.slice(0, start) + section + (after >= 0 ? existing.slice(after + 1) : "");
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
 * replace their `## Tomrade` section; Codex gains the `tomrade-sync` skill;
 * `.claude/settings.json` gains one hook per lifecycle event that posts to
 * Tomrade. Everything else in each file is kept as it was. Returns the files
 * that changed.
 */
export function writeConnectFiles(root: string, input: ConnectInput): string[] {
  const changed: string[] = [];

  const mcpFile = path.join(root, ".mcp.json");
  const mcp = readJson(mcpFile) ?? {};
  const servers = (mcp.mcpServers as Record<string, unknown> | undefined) ?? {};
  const next = { ...mcp, mcpServers: { ...servers, tomrade: { type: "http", url: input.mcpUrl } } };
  const nextText = JSON.stringify(next, null, 2) + "\n";
  if (!fs.existsSync(mcpFile) || fs.readFileSync(mcpFile, "utf8") !== nextText) {
    fs.writeFileSync(mcpFile, nextText);
    changed.push(".mcp.json");
  }

  const codexFile = path.join(root, ".codex", "config.toml");
  const codexExisting = fs.existsSync(codexFile) ? fs.readFileSync(codexFile, "utf8") : "";
  const codexText = withCodexMcp(codexExisting, input.mcpUrl);
  if (codexText !== codexExisting) {
    fs.mkdirSync(path.dirname(codexFile), { recursive: true });
    fs.writeFileSync(codexFile, codexText);
    changed.push(".codex/config.toml");
  }

  const section = tomradeSection(input);
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const file = path.join(root, name);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const body = withTomradeSection(existing, input.projectName, section);
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

  const settingsFile = path.join(root, ".claude", "settings.json");
  const settings = readJson(settingsFile);
  if (settings) {
    const hooks = { ...((settings.hooks as Record<string, unknown[]> | undefined) ?? {}) };
    const command = `curl -s -m 5 -X POST -H 'Content-Type: application/json' --data-binary @- '${input.eventUrl}' >/dev/null 2>&1 || true`;
    let touched = false;
    for (const event of HOOK_EVENTS) {
      const entries = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
      const already = JSON.stringify(entries).includes("/sessions/event");
      if (already) continue;
      entries.push({ hooks: [{ type: "command", command }] });
      hooks[event] = entries;
      touched = true;
    }
    if (touched) {
      fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
      fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, hooks }, null, 2) + "\n");
      changed.push(".claude/settings.json");
    }
  }
  return changed;
}
