import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineRecord, RecordLine, RecordRead } from "@tomradex/agent";

/** How much of a transcript is read from each end for its title: titles repeat through it, so the tail nearly always has one. */
const TITLE_CHUNK = 256 * 1024;

/** How much of a conversation's record one read takes, from its end or before an earlier read's start. */
const CONVERSATION_PAGE = 2 * 1024 * 1024;

/** How far past a stretch its calls' results are looked for: a result is written right after its call. */
const RESULT_LOOKAHEAD = 512 * 1024;

/** The longest line a read keeps whole; one longer is left out. */
const LINE_MAX = 16 * 1024 * 1024;

/** How much of a tool call's input or output a line carries. */
const DETAIL_TEXT = 20_000;

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

export const clipDetail = (text: string) => (text.length > DETAIL_TEXT ? `${text.slice(0, DETAIL_TEXT)}…` : text);

/** A line of a record being read: a tool call carries `call`, the id its result is filed under. */
export type RecordCallLine = RecordLine & { call?: string };

/** How one agent's JSONL record reads: each entry's lines, and the tool results it holds. */
export interface JsonlReader {
  lines(entry: Record<string, unknown>): RecordCallLine[];
  results?(entry: Record<string, unknown>): { call: string; output: string }[];
}

/** Where the line holding byte `pos` begins: just after the newline before it, 0, or `pos` itself past `LINE_MAX`. */
function lineStart(fd: number, pos: number): number {
  const chunk = Buffer.alloc(64 * 1024);
  let end = pos;
  while (end > 0 && pos - end < LINE_MAX) {
    const from = Math.max(0, end - chunk.length);
    const n = fs.readSync(fd, chunk, 0, end - from, from);
    const at = chunk.subarray(0, n).lastIndexOf(0x0a);
    if (at >= 0) return from + at + 1;
    end = from;
  }
  return end === 0 ? 0 : pos;
}

const entriesOf = (text: string): Record<string, unknown>[] =>
  text.split("\n").flatMap((row) => {
    if (!row.trim()) return [];
    try {
      return [JSON.parse(row) as Record<string, unknown>];
    } catch {
      // a line still being written, or one cut at a read's edge
      return [];
    }
  });

/**
 * A stretch of a JSONL record as conversation lines: its end, or what came `before` an earlier read's start, in whole
 * lines. Each tool call gets the output filed under its id, from the stretch or just past it. Null when the file
 * cannot be read.
 */
export function readJsonlRecord(file: string, reader: JsonlReader, opts?: { before?: number }): RecordRead | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const end = Math.min(size, Math.max(0, opts?.before ?? size));
    const start = end > 0 ? lineStart(fd, Math.max(0, end - CONVERSATION_PAGE)) : 0;
    const lines: RecordLine[] = [];
    const calls = new Map<string, RecordLine>();
    const fileResults = (entry: Record<string, unknown>) => {
      for (const r of reader.results?.(entry) ?? []) {
        const line = calls.get(r.call);
        if (line?.detail) line.detail.output = clipDetail(r.output);
      }
    };
    for (const entry of entriesOf(readAt(fd, start, end - start))) {
      for (const { call, ...line } of reader.lines(entry)) {
        lines.push(line);
        if (call) calls.set(call, line);
      }
      fileResults(entry);
    }
    if (end < size && calls.size) for (const entry of entriesOf(readAt(fd, end, Math.min(size - end, RESULT_LOOKAHEAD)))) fileResults(entry);
    return { lines, cut: start > 0, start };
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

/** Text blocks as one text, as tool results write them: a string, or a list of blocks of which text ones count. */
export function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: { type?: string; text?: unknown }) => (typeof b?.text === "string" ? b.text : b?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

/** A Claude Code tool call's input as a person reads it: a command as typed, an edit as removed and added lines. */
function claudeInput(input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const edit = (old: unknown, now: unknown) => [...text(old).split("\n").map((l) => `- ${l}`), ...text(now).split("\n").map((l) => `+ ${l}`)].join("\n");
  if (typeof i.command === "string") return `$ ${i.command}`;
  if (typeof i.file_path === "string" && "old_string" in i) return `${i.file_path}\n${edit(i.old_string, i.new_string)}`;
  if (typeof i.file_path === "string" && Array.isArray(i.edits)) return [i.file_path, ...i.edits.map((e: Record<string, unknown>) => edit(e.old_string, e.new_string))].join("\n");
  if (typeof i.file_path === "string" && typeof i.content === "string") return `${i.file_path}\n${i.content}`;
  return JSON.stringify(input ?? {}, null, 2);
}

/** One entry of a Claude Code transcript as conversation lines; sidechains and injected context are left out. */
function claudeTranscriptLines(o: Record<string, unknown>): RecordCallLine[] {
  if (o.isMeta || o.isSidechain) return [];
  const message = o.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (o.type === "user") {
    if (typeof content === "string") return isMachinery(content) ? [] : [{ who: "person", text: clipLine(content.trim()) }];
    if (!Array.isArray(content)) return [];
    return content.flatMap((b: { type?: string; text?: string }) => (b.type === "text" && b.text && !isMachinery(b.text) ? [{ who: "person" as const, text: clipLine(b.text.trim()) }] : []));
  }
  if (o.type === "assistant" && Array.isArray(content)) {
    return content.flatMap((b: { type?: string; text?: string; name?: string; input?: unknown; id?: unknown }): RecordCallLine[] => {
      if (b.type === "text" && b.text?.trim()) return [{ who: "agent", text: clipLine(b.text.trim()) }];
      if (b.type === "tool_use" && b.name) return [{ who: "tool", text: toolLine(b.name, b.input), detail: { input: clipDetail(claudeInput(b.input)) }, ...(typeof b.id === "string" ? { call: b.id } : {}) }];
      return [];
    });
  }
  return [];
}

/** The tool results one Claude Code transcript entry holds, by the call each answers. */
function claudeTranscriptResults(o: Record<string, unknown>): { call: string; output: string }[] {
  const content = (o.message as { content?: unknown } | undefined)?.content;
  if (o.type !== "user" || !Array.isArray(content)) return [];
  return content.flatMap((b: { type?: string; tool_use_id?: unknown; content?: unknown }) =>
    b.type === "tool_result" && typeof b.tool_use_id === "string" ? [{ call: b.tool_use_id, output: blocksText(b.content) }] : []
  );
}

const CLAUDE_TRANSCRIPT: JsonlReader = { lines: claudeTranscriptLines, results: claudeTranscriptResults };

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
    read: (file, opts) => readJsonlRecord(file, CLAUDE_TRANSCRIPT, opts),
    title: claudeTranscriptTitle
  };
}
