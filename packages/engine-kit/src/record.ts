import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addTokens, NO_TOKENS, type EngineRecord, type RecordLine, type RecordRead, type RecordUsageCount, type TokenBreakdown } from "@tomradex/agent";

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

/** The tokens one entry of a record counts: a reply's, under its id when one reply is written as several entries, or the session's running total. */
export interface UsageEntry {
  tokens: TokenBreakdown;
  id?: string;
  running?: boolean;
}

/** How one agent's JSONL record reads: each entry's lines, the tool results it holds, and the tokens it counts. */
export interface JsonlReader {
  lines(entry: Record<string, unknown>): RecordCallLine[];
  results?(entry: Record<string, unknown>): { call: string; output: string }[];
  usage?(entry: Record<string, unknown>): UsageEntry | null;
  /** Whether an entry starts a turn; without this, one holding a line the person said does. */
  startsTurn?(entry: Record<string, unknown>): boolean;
  /** Whether a row may count or start a turn, judged before it is parsed: counting skips the rest unparsed. */
  skim?(row: Buffer): boolean;
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

/** When an entry was written, as Claude Code and Codex stamp theirs (`timestamp`, ISO or ms); null when unstamped. */
const entryTime = (entry: Record<string, unknown>): number | null => {
  const t = entry.timestamp;
  const at = typeof t === "number" ? t : typeof t === "string" ? Date.parse(t) : NaN;
  return Number.isFinite(at) ? at : null;
};

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
 * A stretch of a JSONL record as conversation lines: its end, what came `before` an earlier read's start, or what came
 * `after` an earlier read's `next`, in whole lines. Each tool call gets the output filed under its id, from the stretch
 * or just past it. A read up to the end says where the next one goes on (`next`): past its last whole line, or back at
 * the first call still waiting for its output, with `held` the lines before that. Going on is refused for more than a
 * page, or past the end of a record that shrank: that reads its end afresh. Null when the file cannot be read.
 */
export function readJsonlRecord(file: string, reader: JsonlReader, opts?: { before?: number; after?: number }): RecordRead | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const after = opts?.before === undefined && opts?.after !== undefined && opts.after >= 0 && opts.after <= size && size - opts.after <= CONVERSATION_PAGE ? opts.after : null;
    const end = after !== null ? size : Math.min(size, Math.max(0, opts?.before ?? size));
    const start = after ?? (end > 0 ? lineStart(fd, Math.max(0, end - CONVERSATION_PAGE)) : 0);
    const buf = Buffer.alloc(end - start);
    const got = fs.readSync(fd, buf, 0, buf.length, start);
    const lines: RecordLine[] = [];
    const calls = new Map<string, RecordLine>();
    /** Calls not yet given their output: where their entry begins, and their line's place. */
    const waiting = new Map<string, { at: number; line: number }>();
    const fileResults = (entry: Record<string, unknown>) => {
      for (const r of reader.results?.(entry) ?? []) {
        const line = calls.get(r.call);
        if (line?.detail) line.detail.output = clipDetail(r.output);
        waiting.delete(r.call);
      }
    };
    /** Where the whole lines read end. */
    let whole = start;
    for (let pos = 0; pos < got; ) {
      const nl = buf.indexOf(0x0a, pos);
      const rowEnd = nl < 0 || nl >= got ? got : nl;
      const at = start + pos;
      const row = buf.subarray(pos, rowEnd).toString("utf8");
      pos = rowEnd + 1;
      let entry: Record<string, unknown> | null = null;
      try {
        entry = row.trim() ? (JSON.parse(row) as Record<string, unknown>) : null;
      } catch {
        // a line still being written, or one cut at a read's edge
        if (rowEnd === got) break;
      }
      whole = start + Math.min(pos, got);
      if (!entry) continue;
      const stamped = entryTime(entry);
      for (const { call, ...line } of reader.lines(entry)) {
        if (stamped !== null) line.at = stamped;
        if (call) {
          calls.set(call, line);
          waiting.set(call, { at, line: lines.length });
        }
        lines.push(line);
      }
      fileResults(entry);
    }
    if (end < size && calls.size) for (const entry of entriesOf(readAt(fd, end, Math.min(size - end, RESULT_LOOKAHEAD)))) fileResults(entry);
    if (end < size) return { lines, cut: start > 0, start };
    // A call far back whose output never came is not waited for: its line stays as it is.
    const open = [...waiting.values()].filter((w) => whole - w.at <= RESULT_LOOKAHEAD).sort((x, y) => x.at - y.at)[0];
    return { lines, cut: start > 0, start, next: open?.at ?? whole, held: open?.line ?? lines.length };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** How much of a record one step of counting its tokens reads. */
const USAGE_CHUNK = 4 * 1024 * 1024;

/** How many reply ids a count remembers: one reply's entries are written together, never far apart. */
const SEEN_IDS = 256;

/** What a JSONL count keeps to go on: where it stopped, the last replies it counted, and the last running total. */
interface JsonlTally {
  offset: number;
  seen: string[];
  running: TokenBreakdown | null;
}

const minus = (a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown | null => {
  const d = {
    inputTokens: a.inputTokens - b.inputTokens,
    uncachedInputTokens: a.uncachedInputTokens - b.uncachedInputTokens,
    cacheReadTokens: a.cacheReadTokens - b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens - b.cacheWriteTokens,
    outputTokens: a.outputTokens - b.outputTokens
  };
  return Object.values(d).some((n) => n < 0) ? null : d;
};

/**
 * The tokens a JSONL record counts, going on `from` an earlier count over only what was written since (all of it when
 * the record shrank): each reply once, however many entries write it, and a running total by what it grew. The turn
 * starts at the person's last line; with `turnAt` (a subagent's record, which the person never speaks in) it is what
 * was written from then on. Returns `from` itself when nothing was written since; null when the file cannot be read.
 */
export function countJsonlUsage(file: string, reader: JsonlReader, from?: RecordUsageCount | null, opts?: { turnAt?: number | null }): RecordUsageCount | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const kept = from?.state as JsonlTally | undefined;
    const goesOn = !!kept && kept.offset <= size;
    const given = opts && "turnAt" in opts;
    const turnAt = given ? (opts!.turnAt ?? null) : undefined;
    if (goesOn && kept.offset === size && (!given || (from!.turn?.startedAt ?? null) === turnAt)) return from!;
    let total = goesOn ? from!.total : NO_TOKENS;
    let turn = goesOn ? from!.turn : null;
    if (given) turn = turnAt === null ? null : turn?.startedAt === turnAt ? turn : { startedAt: turnAt!, lastAt: null, tokens: NO_TOKENS };
    const seen = goesOn ? [...kept.seen] : [];
    let running = goesOn ? kept.running : null;
    const isTurn = reader.startsTurn ?? ((entry: Record<string, unknown>) => reader.lines(entry).some((l) => l.who === "person"));
    /** Counts a row; false when it is not whole JSON. The last row, which may still be being written, is always parsed. */
    const take = (row: Buffer, last = false) => {
      if (!row.length || (!last && reader.skim && !reader.skim(row))) return true;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(row.toString("utf8")) as Record<string, unknown>;
      } catch {
        return false;
      }
      const at = entryTime(entry);
      const used = reader.usage?.(entry) ?? null;
      if (!used) {
        if (!given && isTurn(entry)) turn = { startedAt: at, lastAt: at, tokens: NO_TOKENS };
        return true;
      }
      const inTurn = !!turn && (!given || at === null || at >= (turn.startedAt ?? 0));
      if (inTurn && at !== null) turn = { ...turn!, lastAt: at };
      let tokens: TokenBreakdown | null = used.tokens;
      if (used.running) {
        // a total that fell is a new count from nothing (the agent started over)
        tokens = running ? (minus(used.tokens, running) ?? used.tokens) : used.tokens;
        running = used.tokens;
      } else if (used.id) {
        if (seen.includes(used.id)) tokens = null;
        else {
          seen.push(used.id);
          if (seen.length > SEEN_IDS) seen.shift();
        }
      }
      if (!tokens) return true;
      total = addTokens(total, tokens);
      if (inTurn) turn = { ...turn!, tokens: addTokens(turn!.tokens, tokens) };
      return true;
    };
    let pos = goesOn ? kept.offset : 0;
    let offset = pos;
    let carry: Buffer = Buffer.alloc(0);
    let skipping = false;
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(USAGE_CHUNK, size - pos));
      const got = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!got) break;
      pos += got;
      let data = buf.subarray(0, got);
      if (skipping) {
        const nl = data.indexOf(0x0a);
        if (nl < 0) {
          offset = pos;
          continue;
        }
        skipping = false;
        offset = pos - got + nl + 1;
        data = data.subarray(nl + 1);
      }
      if (carry.length) data = Buffer.concat([carry, data]);
      let at = 0;
      for (let nl = data.indexOf(0x0a); nl >= 0; nl = data.indexOf(0x0a, at)) {
        take(data.subarray(at, nl));
        at = nl + 1;
      }
      offset += at;
      carry = Buffer.from(data.subarray(at));
      // a line too long to keep is left out, as reading the conversation leaves it out
      if (carry.length > LINE_MAX) {
        offset += carry.length;
        carry = Buffer.alloc(0);
        skipping = true;
      }
    }
    // the last line, unless it is still being written
    if (carry.length && !skipping && take(carry, true)) offset += carry.length;
    return { total, turn, state: { offset, seen, running } satisfies JsonlTally };
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

/** One Claude Code reply's tokens: its input is new, cache read and cache write together. Several entries share one reply's id. */
function claudeTranscriptUsage(o: Record<string, unknown>): UsageEntry | null {
  if (o.type !== "assistant") return null;
  const message = o.message as { id?: unknown; usage?: Record<string, unknown> } | undefined;
  const u = message?.usage;
  if (!u || typeof u !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const uncached = n(u.input_tokens);
  const read = n(u.cache_read_input_tokens);
  const write = n(u.cache_creation_input_tokens);
  const tokens = { inputTokens: uncached + read + write, uncachedInputTokens: uncached, cacheReadTokens: read, cacheWriteTokens: write, outputTokens: n(u.output_tokens) };
  return typeof message?.id === "string" ? { tokens, id: message.id } : { tokens };
}

const CLAUDE_TRANSCRIPT: JsonlReader = {
  lines: claudeTranscriptLines,
  results: claudeTranscriptResults,
  usage: claudeTranscriptUsage,
  // a compacted conversation's summary is written as the person's, though they said nothing
  startsTurn: (o) => !o.isCompactSummary && claudeTranscriptLines(o).some((l) => l.who === "person"),
  // tool results are most of a transcript, and neither count nor start a turn
  skim: (row) => row.includes('"usage"') || (row.includes('"type":"user"') && !row.includes('"tool_result"'))
};

/** What a Claude Code count keeps: its transcript's, and each of its subagents' by file name. */
interface ClaudeTally {
  main: RecordUsageCount;
  subs: Record<string, RecordUsageCount>;
}

/**
 * The tokens of a Claude Code session: its transcript's, and those of the subagents it ran, which Claude Code writes
 * beside it in `<session id>/subagents/agent-*.jsonl`; a subagent's count in the turn is what it wrote since the
 * person's last line.
 */
function claudeSessionUsage(file: string, from?: RecordUsageCount | null): RecordUsageCount | null {
  const kept = from?.state as ClaudeTally | undefined;
  const main = countJsonlUsage(file, CLAUDE_TRANSCRIPT, kept?.main);
  if (!main) return null;
  const dir = path.join(path.dirname(file), path.basename(file, ".jsonl"), "subagents");
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => /^agent-[\w-]+\.jsonl$/.test(name)).sort();
  } catch {
    // no subagents ran
  }
  const turnAt = main.turn?.startedAt ?? null;
  const subs: Record<string, RecordUsageCount> = {};
  let same = !!kept && main === kept.main && names.length === Object.keys(kept.subs).length;
  for (const name of names) {
    const sub = countJsonlUsage(path.join(dir, name), CLAUDE_TRANSCRIPT, kept?.subs[name], { turnAt });
    if (!sub) continue;
    subs[name] = sub;
    if (sub !== kept?.subs[name]) same = false;
  }
  if (same) return from!;
  let total = main.total;
  let turnTokens = main.turn?.tokens ?? null;
  for (const sub of Object.values(subs)) {
    total = addTokens(total, sub.total);
    if (turnTokens && sub.turn && sub.turn.startedAt === turnAt) turnTokens = addTokens(turnTokens, sub.turn.tokens);
  }
  return { total, turn: main.turn && turnTokens ? { ...main.turn, tokens: turnTokens } : null, state: { main, subs } satisfies ClaudeTally };
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
    read: (file, opts) => readJsonlRecord(file, CLAUDE_TRANSCRIPT, opts),
    title: claudeTranscriptTitle,
    usage: claudeSessionUsage
  };
}
