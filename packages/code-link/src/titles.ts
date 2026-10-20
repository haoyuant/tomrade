import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** How much of a transcript is read from each end: titles repeat through it, so the tail nearly always has one. */
const CHUNK = 256 * 1024;

/** How long a title from the first prompt may be. */
const PROMPT_TITLE = 60;

const read = (fd: number, start: number, length: number): string => {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, start);
  return buf.subarray(0, n).toString("utf8");
};

/** The title lines in some JSONL: the person's own (`/rename`) over the agent's, the last of each. */
function titleIn(text: string): string | null {
  let custom: string | null = null;
  let ai: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes('"custom-title"') && !line.includes('"ai-title"')) continue;
    try {
      const o = JSON.parse(line) as { type?: string; customTitle?: unknown; aiTitle?: unknown };
      if (o.type === "custom-title" && typeof o.customTitle === "string" && o.customTitle.trim()) custom = o.customTitle.trim();
      if (o.type === "ai-title" && typeof o.aiTitle === "string" && o.aiTitle.trim()) ai = o.aiTitle.trim();
    } catch {
      // a line cut by the chunk's edge
    }
  }
  return custom ?? ai;
}

/** What a Claude Code transcript calls its conversation, reading only its tail and then its head; null without one. */
export function transcriptTitle(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const tail = titleIn(read(fd, Math.max(0, size - CHUNK), Math.min(size, CHUNK)));
    if (tail || size <= CHUNK) return tail;
    return titleIn(read(fd, 0, CHUNK));
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** A first prompt as a title: one line, shortened. */
export function promptTitle(prompt: unknown): string | null {
  if (typeof prompt !== "string") return null;
  const line = prompt.replace(/\s+/g, " ").trim();
  if (!line || line.startsWith("<")) return null;
  return line.length > PROMPT_TITLE ? `${line.slice(0, PROMPT_TITLE - 1)}…` : line;
}

/**
 * Where an older Claude Code session's transcript is, found by its session id under the accounts' project folders:
 * `CLAUDE_CONFIG_DIR`, `~/.claude`, and `~/.claude-*`.
 */
export function findTranscript(sessionId: string, home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string | null {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  const roots = new Set<string>();
  if (env.CLAUDE_CONFIG_DIR) roots.add(env.CLAUDE_CONFIG_DIR);
  roots.add(path.join(home, ".claude"));
  try {
    for (const name of fs.readdirSync(home)) if (name.startsWith(".claude-")) roots.add(path.join(home, name));
  } catch {
    // no home to look in
  }
  for (const root of roots) {
    let projects: string[];
    try {
      projects = fs.readdirSync(path.join(root, "projects"));
    } catch {
      continue;
    }
    for (const project of projects) {
      const file = path.join(root, "projects", project, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

/** The command that takes an agent back into one of its conversations, by its session id; null for agents that cannot. */
export function resumeCommand(agent: string, sessionId: string | null): string | null {
  if (!sessionId || !/^[\w-]+$/.test(sessionId)) return null;
  if (agent === "claude-code") return `claude --resume ${sessionId}`;
  if (agent === "codex") return `codex resume ${sessionId}`;
  return null;
}
