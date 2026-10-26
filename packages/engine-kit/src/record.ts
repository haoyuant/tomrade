import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineRecord, RecordLine, RecordRead } from "@tomradex/agent";

/** How much of a transcript is read from each end for its title: titles repeat through it, so the tail nearly always has one. */
const TITLE_CHUNK = 256 * 1024;

/** How much of a conversation's record is read, from its end. */
const CONVERSATION_TAIL = 2 * 1024 * 1024;

/** How long a title from the first prompt may be. */
const PROMPT_TITLE = 60;

/** How long one line may run in the view. */
const LINE_TEXT = 4000;

/** Bytes of an open file, from `start`. */
export const readAt = (fd: number, start: number, length: number): string => {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, start);
  return buf.subarray(0, n).toString("utf8");
};

/** A session id as agents write them: anything else could reach outside their folders. */
export const sessionIdShape = /^[\w-]+$/;

/** Text that is the agent's machinery, not the conversation: commands, reminders, injected context. */
export const isMachinery = (text: string) => /^\s*</.test(text);

export const clipLine = (text: string) => (text.length > LINE_TEXT ? `${text.slice(0, LINE_TEXT)}…` : text);

/** A tool call as one quiet line: the tool, and what it ran or touched. */
export function toolLine(name: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const what = [i.description, i.command, i.file_path, i.path, i.pattern, i.url, i.query, i.key].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  return what ? `${name} · ${what.replace(/\s+/g, " ").slice(0, 160)}` : name;
}

/** A first prompt as a title: one line, shortened. */
export function promptTitle(prompt: unknown): string | null {
  if (typeof prompt !== "string") return null;
  const line = prompt.replace(/\s+/g, " ").trim();
  if (!line || isMachinery(line)) return null;
  return line.length > PROMPT_TITLE ? `${line.slice(0, PROMPT_TITLE - 1)}…` : line;
}

/** A JSONL record's tail as conversation lines, each entry turned by `linesOf`; null when the file cannot be read. */
export function readJsonlRecord(file: string, linesOf: (entry: Record<string, unknown>) => RecordLine[]): RecordRead | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - CONVERSATION_TAIL);
    const text = readAt(fd, start, size - start);
    // From the middle of a file the first line is a piece of one.
    const rows = (start > 0 ? text.slice(text.indexOf("\n") + 1) : text).split("\n");
    const lines: RecordLine[] = [];
    for (const row of rows) {
      if (!row.trim()) continue;
      try {
        lines.push(...linesOf(JSON.parse(row) as Record<string, unknown>));
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
export function claudeTranscriptTitle(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const tail = titleIn(readAt(fd, Math.max(0, size - TITLE_CHUNK), Math.min(size, TITLE_CHUNK)));
    if (tail || size <= TITLE_CHUNK) return tail;
    return titleIn(readAt(fd, 0, TITLE_CHUNK));
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** One entry of a Claude Code transcript as conversation lines; sidechains and injected context are left out. */
export function claudeTranscriptLines(o: Record<string, unknown>): RecordLine[] {
  if (o.isMeta || o.isSidechain) return [];
  const message = o.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (o.type === "user") {
    if (typeof content === "string") return isMachinery(content) ? [] : [{ who: "person", text: clipLine(content.trim()) }];
    if (!Array.isArray(content)) return [];
    return content.flatMap((b: { type?: string; text?: string }) => (b.type === "text" && b.text && !isMachinery(b.text) ? [{ who: "person" as const, text: clipLine(b.text.trim()) }] : []));
  }
  if (o.type === "assistant" && Array.isArray(content)) {
    return content.flatMap((b: { type?: string; text?: string; name?: string; input?: unknown }): RecordLine[] => {
      if (b.type === "text" && b.text?.trim()) return [{ who: "agent", text: clipLine(b.text.trim()) }];
      if (b.type === "tool_use" && b.name) return [{ who: "tool", text: toolLine(b.name, b.input) }];
      return [];
    });
  }
  return [];
}

/** Where a CLI writing Claude Code's transcripts keeps its config: the variable that moves it, and its folder in the home. */
export interface ClaudeFolders {
  variable: string;
  dir: string;
}

/**
 * Where a session's transcript is, found by its id under the accounts' project folders: the variable's folder,
 * `~/<dir>`, and `~/<dir>-*`.
 */
export function findClaudeTranscript(sessionId: string, folders: ClaudeFolders, home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string | null {
  if (!sessionIdShape.test(sessionId)) return null;
  const roots = new Set<string>();
  if (env[folders.variable]) roots.add(env[folders.variable]!);
  roots.add(path.join(home, folders.dir));
  try {
    for (const name of fs.readdirSync(home)) if (name.startsWith(`${folders.dir}-`)) roots.add(path.join(home, name));
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

/** The record of a CLI that writes Claude Code's transcripts (Claude Code itself, CodeBuddy) under those folders. */
export function claudeRecord(folders: ClaudeFolders): EngineRecord {
  return {
    find: (sessionId) => findClaudeTranscript(sessionId, folders),
    read: (file) => readJsonlRecord(file, claudeTranscriptLines),
    title: claudeTranscriptTitle
  };
}
