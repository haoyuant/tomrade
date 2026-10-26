import fs from "node:fs";
import { claudeConfigDirs, claudeProfileEnv, claudeUserFile } from "@tomradex/engine-claude-code";
import { codexUserFile } from "@tomradex/engine-codex";

const read = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/**
 * The `tomrade` server each agent's own user-level configuration names on this machine, by file: Claude Code's in
 * every config folder it uses, Codex's `[mcp_servers.tomrade]`. A check leaves these as it found them. Only that
 * entry is compared: the agents rewrite the rest of their files as they run.
 */
export function agentLinks() {
  const links = {};
  for (const dir of claudeConfigDirs()) {
    const file = claudeUserFile(claudeProfileEnv(dir));
    let parsed = null;
    try {
      parsed = JSON.parse(read(file) ?? "null");
    } catch {
      // half-written by the agent this moment: read as unknown, not as changed
      parsed = undefined;
    }
    if (parsed !== undefined) links[file] = parsed?.mcpServers?.tomrade ?? null;
  }
  const codex = codexUserFile();
  links[codex] = /^\[mcp_servers\.tomrade\][^[]*/m.exec(read(codex) ?? "")?.[0].trim() ?? null;
  return links;
}

/** The files whose `tomrade` entry differs from `before`, each with what it was and what it is. */
export function changedLinks(before, after = agentLinks()) {
  return Object.keys({ ...before, ...after })
    .filter((file) => file in before && file in after && JSON.stringify(before[file]) !== JSON.stringify(after[file]))
    .map((file) => ({ file, before: before[file], after: after[file] }));
}
