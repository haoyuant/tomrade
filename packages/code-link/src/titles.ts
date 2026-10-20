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

/** One line of a conversation as the Terminal window shows it, read-only. */
export interface ConversationLine {
  who: "person" | "agent" | "tool";
  text: string;
}

/** How much of a conversation's record is read, from its end. */
const CONVERSATION_TAIL = 2 * 1024 * 1024;

/** How long one line may run in the view. */
const LINE_TEXT = 4000;

/** Text that is the agent's machinery, not the conversation: commands, reminders, injected context. */
const meta = (text: string) => /^\s*</.test(text);

const clip = (text: string) => (text.length > LINE_TEXT ? `${text.slice(0, LINE_TEXT)}…` : text);

/** A tool call as one quiet line: the tool, and what it ran or touched. */
function toolLine(name: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const what = [i.description, i.command, i.file_path, i.path, i.pattern, i.url, i.query, i.key].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  return what ? `${name} · ${what.replace(/\s+/g, " ").slice(0, 160)}` : name;
}

function claudeLines(o: Record<string, unknown>): ConversationLine[] {
  if (o.isMeta || o.isSidechain) return [];
  const message = o.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (o.type === "user") {
    if (typeof content === "string") return meta(content) ? [] : [{ who: "person", text: clip(content.trim()) }];
    if (!Array.isArray(content)) return [];
    return content.flatMap((b: { type?: string; text?: string }) => (b.type === "text" && b.text && !meta(b.text) ? [{ who: "person" as const, text: clip(b.text.trim()) }] : []));
  }
  if (o.type === "assistant" && Array.isArray(content)) {
    return content.flatMap((b: { type?: string; text?: string; name?: string; input?: unknown }): ConversationLine[] => {
      if (b.type === "text" && b.text?.trim()) return [{ who: "agent", text: clip(b.text.trim()) }];
      if (b.type === "tool_use" && b.name) return [{ who: "tool", text: toolLine(b.name, b.input) }];
      return [];
    });
  }
  return [];
}

function codexLines(o: Record<string, unknown>): ConversationLine[] {
  if (o.type !== "response_item") return [];
  const p = (o.payload ?? {}) as { type?: string; role?: string; content?: { type?: string; text?: string }[]; name?: string; arguments?: string };
  if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
    const who = p.role === "user" ? "person" : "agent";
    return (p.content ?? []).flatMap((b) => (b.text && !meta(b.text) ? [{ who, text: clip(b.text.trim()) } as ConversationLine] : []));
  }
  if (p.type === "function_call" && p.name) {
    let args: unknown = {};
    try {
      args = JSON.parse(p.arguments ?? "{}");
    } catch {
      // arguments that are not JSON say nothing more
    }
    const cmd = (args as { cmd?: unknown; command?: unknown }).cmd ?? (args as { command?: unknown }).command;
    return [{ who: "tool", text: toolLine(p.name, { command: Array.isArray(cmd) ? cmd.join(" ") : cmd }) }];
  }
  return [];
}

/**
 * A conversation from its agent's own record, read-only: what the person said, what the agent answered, a line per
 * tool call. Only the record's tail is read; `cut` says the start was left out. Null for agents Tomrade cannot read.
 */
export function readConversation(agent: string, file: string): { lines: ConversationLine[]; cut: boolean } | null {
  const reader = agent === "claude-code" ? claudeLines : agent === "codex" ? codexLines : null;
  if (!reader) return null;
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - CONVERSATION_TAIL);
    const text = read(fd, start, size - start);
    // From the middle of a file the first line is a piece of one.
    const rows = (start > 0 ? text.slice(text.indexOf("\n") + 1) : text).split("\n");
    const lines: ConversationLine[] = [];
    for (const row of rows) {
      if (!row.trim()) continue;
      try {
        lines.push(...reader(JSON.parse(row) as Record<string, unknown>));
      } catch {
        // a line still being written
      }
    }
    return { lines, cut: start > 0 };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Where a Codex conversation's record is, by its id: the rollout file under `~/.codex/sessions` that ends with it. */
export function findCodexRollout(sessionId: string, home = os.homedir()): string | null {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  const walk = (dir: string, depth: number): string | null => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return null;
    }
    for (const name of names.sort().reverse()) {
      const full = path.join(dir, name);
      if (name.startsWith("rollout-") && name.endsWith(`${sessionId}.jsonl`)) return full;
      if (depth < 3 && !name.includes(".")) {
        const found = walk(full, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(path.join(home, ".codex", "sessions"), 0);
}
