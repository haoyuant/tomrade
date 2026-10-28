import fs from "node:fs";
import path from "node:path";
import type { EngineRecord } from "@tomradex/agent";
import { blocksText, clipDetail, clipLine, countJsonlUsage, isMachinery, promptTitle, readAt, readJsonlRecord, sessionIdShape, toolLine, type JsonlReader, type RecordCallLine, type UsageEntry } from "@tomradex/engine-kit";
import { piAgentDir } from "./outside.js";

/** How much of a session file's head and tail is read for its name or first prompt. */
const TITLE_CHUNK = 256 * 1024;

interface PiMessage {
  role?: string;
  content?: unknown;
  toolCallId?: unknown;
  usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
}

const messageOf = (o: Record<string, unknown>): PiMessage | null => (o.type === "message" && o.message && typeof o.message === "object" ? (o.message as PiMessage) : null);

/** A user message's text: pi writes it as a string or as blocks. */
const userText = (content: unknown): string => (typeof content === "string" ? content : blocksText(content));

/** One entry of a pi session as conversation lines: what the person and pi said, and each tool call — not the system prompt. */
function piLines(o: Record<string, unknown>): RecordCallLine[] {
  const m = messageOf(o);
  if (m?.role === "user") {
    const text = userText(m.content).trim();
    return text && !isMachinery(text) ? [{ who: "person", text: clipLine(text) }] : [];
  }
  if (m?.role !== "assistant" || !Array.isArray(m.content)) return [];
  return (m.content as { type?: string; text?: string; id?: unknown; name?: string; arguments?: unknown }[]).flatMap((b): RecordCallLine[] => {
    if (b.type === "text" && b.text?.trim()) return [{ who: "agent", text: clipLine(b.text.trim()) }];
    if (b.type === "toolCall" && b.name) {
      const args = b.arguments ?? {};
      const input = typeof (args as { command?: unknown }).command === "string" ? `$ ${(args as { command: string }).command}` : JSON.stringify(args, null, 2);
      return [{ who: "tool", text: toolLine(b.name, args), detail: { input: clipDetail(input) }, ...(typeof b.id === "string" ? { call: b.id } : {}) }];
    }
    return [];
  });
}

function piResults(o: Record<string, unknown>): { call: string; output: string }[] {
  const m = messageOf(o);
  return m?.role === "toolResult" && typeof m.toolCallId === "string" ? [{ call: m.toolCallId, output: blocksText(m.content) }] : [];
}

/** A reply's tokens, and what pi spent outside the conversation (a cache warm, a summary): its `input` leaves the cache out. */
function piUsage(o: Record<string, unknown>): UsageEntry | null {
  const m = messageOf(o);
  const u = m?.role === "assistant" ? m.usage : o.type === "usage" || o.type === "compaction" || o.type === "branch_summary" ? (o.usage as PiMessage["usage"]) : null;
  if (!u || typeof u !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const uncached = n(u.input);
  const read = n(u.cacheRead);
  const write = n(u.cacheWrite);
  return { ...(typeof o.id === "string" ? { id: o.id } : {}), tokens: { inputTokens: uncached + read + write, uncachedInputTokens: uncached, cacheReadTokens: read, cacheWriteTokens: write, outputTokens: n(u.output) } };
}

const PI_SESSION: JsonlReader = {
  lines: piLines,
  results: piResults,
  usage: piUsage,
  startsTurn: (o) => messageOf(o)?.role === "user",
  skim: (row) => row.includes('"usage"') || row.includes('"role":"user"')
};

/** What a pi session is called: the name `/name` gave it last, else the first thing the person said. */
export function piSessionTitle(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const entries = (text: string) =>
      text.split("\n").flatMap((row) => {
        try {
          return [JSON.parse(row) as Record<string, unknown>];
        } catch {
          // a row cut at the chunk's edge
          return [];
        }
      });
    const named = (text: string) => entries(text).reverse().find((o) => o.type === "session_info" && typeof o.name === "string" && o.name.trim())?.name as string | undefined;
    const head = readAt(fd, 0, Math.min(size, TITLE_CHUNK));
    const name = (size > TITLE_CHUNK ? named(readAt(fd, size - TITLE_CHUNK, TITLE_CHUNK)) : undefined) ?? named(head);
    if (name) return name.trim();
    for (const o of entries(head)) {
      const m = messageOf(o);
      const title = m?.role === "user" ? promptTitle(userText(m.content)) : null;
      if (title) return title;
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The folder pi files a working folder's sessions under: the path without its leading separator, `/`, `\` and `:` as `-`. */
export const piSessionFolder = (cwd: string): string => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

/** Where a pi session's file is, by its id: under its working folder's when that is known, else under any. */
export function findPiSession(sessionId: string, cwd: string | null, dir = path.join(piAgentDir(), "sessions")): string | null {
  if (!sessionIdShape.test(sessionId)) return null;
  const inFolder = (folder: string): string | null => {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(dir, folder));
    } catch {
      return null;
    }
    const name = names.find((n) => n.endsWith(`_${sessionId}.jsonl`));
    return name ? path.join(dir, folder, name) : null;
  };
  const own = cwd ? piSessionFolder(cwd) : null;
  if (own) {
    const found = inFolder(own);
    if (found) return found;
  }
  let folders: string[];
  try {
    folders = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const folder of folders) {
    if (folder === own) continue;
    const found = inFolder(folder);
    if (found) return found;
  }
  return null;
}

/** pi's own record of its sessions, read-only: what a terminal session's view and the look back show of it. */
export const piRecord: EngineRecord = {
  find: (sessionId, { cwd }) => findPiSession(sessionId, cwd),
  read: (file, opts) => readJsonlRecord(file, PI_SESSION, opts),
  title: piSessionTitle,
  usage: (file, from) => countJsonlUsage(file, PI_SESSION, from)
};
