import fs from "node:fs";
import path from "node:path";
import type { EngineRecord } from "@tomradex/agent";
import { blocksText, clipDetail, clipLine, countJsonlUsage, isMachinery, promptTitle, readAt, readJsonlRecord, sessionIdShape, toolLine, type JsonlReader, type RecordCallLine, type UsageEntry } from "@tomradex/engine-kit";
import { codexHome } from "./account.js";

/** How much of a rollout's head is read for its first prompt. */
const TITLE_CHUNK = 256 * 1024;

/** A call's arguments as a person reads them: a command as typed, anything else as JSON. */
function codexInput(args: unknown): string {
  const cmd = (args as { cmd?: unknown; command?: unknown }).cmd ?? (args as { command?: unknown }).command;
  if (typeof cmd === "string" || Array.isArray(cmd)) return `$ ${Array.isArray(cmd) ? cmd.join(" ") : cmd}`;
  return JSON.stringify(args ?? {}, null, 2);
}

/** One entry of a Codex rollout as conversation lines: messages and tool calls, not the context Codex injects. */
function codexRolloutLines(o: Record<string, unknown>): RecordCallLine[] {
  if (o.type !== "response_item") return [];
  const p = (o.payload ?? {}) as { type?: string; role?: string; content?: { type?: string; text?: string }[]; name?: string; arguments?: string; input?: unknown; call_id?: unknown };
  const call = typeof p.call_id === "string" ? { call: p.call_id } : {};
  if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
    const who = p.role === "user" ? "person" : "agent";
    return (p.content ?? []).flatMap((b) => (b.text && !isMachinery(b.text) ? [{ who, text: clipLine(b.text.trim()) } as RecordCallLine] : []));
  }
  if (p.type === "function_call" && p.name) {
    let args: unknown = {};
    try {
      args = JSON.parse(p.arguments ?? "{}");
    } catch {
      // arguments that are not JSON say nothing more
    }
    const cmd = (args as { cmd?: unknown; command?: unknown }).cmd ?? (args as { command?: unknown }).command;
    return [{ who: "tool", text: toolLine(p.name, { command: Array.isArray(cmd) ? cmd.join(" ") : cmd }), detail: { input: clipDetail(codexInput(args)) }, ...call }];
  }
  // Newer Codex runs its tools as free-form calls: the input is the script it wrote.
  if (p.type === "custom_tool_call" && p.name) {
    const input = typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? "");
    return [{ who: "tool", text: toolLine(p.name, { command: input.split("\n").find((l) => l.trim()) ?? "" }), detail: { input: clipDetail(input) }, ...call }];
  }
  return [];
}

/** A call's output as Codex filed it: text, blocks of text, or JSON holding the text under `output`. */
function codexOutput(output: unknown): string {
  if (typeof output !== "string") return blocksText(output);
  try {
    const parsed = JSON.parse(output) as { output?: unknown };
    if (typeof parsed?.output === "string") return parsed.output;
  } catch {
    // plain text
  }
  return output;
}

/** The tool results one rollout entry holds, by the call each answers. */
function codexRolloutResults(o: Record<string, unknown>): { call: string; output: string }[] {
  if (o.type !== "response_item") return [];
  const p = (o.payload ?? {}) as { type?: string; call_id?: unknown; output?: unknown };
  if ((p.type === "function_call_output" || p.type === "custom_tool_call_output") && typeof p.call_id === "string") return [{ call: p.call_id, output: codexOutput(p.output) }];
  return [];
}

/** The session's tokens so far, as Codex writes them after each reply: cached and cache-written input are part of its input. */
function codexRolloutUsage(o: Record<string, unknown>): UsageEntry | null {
  if (o.type !== "event_msg") return null;
  const p = (o.payload ?? {}) as { type?: string; info?: { total_token_usage?: Record<string, unknown> } | null };
  const u = p.type === "token_count" ? p.info?.total_token_usage : null;
  if (!u || typeof u !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const input = n(u.input_tokens);
  const read = Math.min(input, n(u.cached_input_tokens));
  const write = Math.min(input - read, n(u.cache_write_input_tokens));
  return { running: true, tokens: { inputTokens: input, uncachedInputTokens: input - read - write, cacheReadTokens: read, cacheWriteTokens: write, outputTokens: n(u.output_tokens) } };
}

const CODEX_ROLLOUT: JsonlReader = {
  lines: codexRolloutLines,
  results: codexRolloutResults,
  usage: codexRolloutUsage,
  skim: (row) => row.includes('"token_count"') || row.includes('"role":"user"')
};

/** The first thing the person said in a Codex rollout, as a title. */
export function codexRolloutTitle(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    for (const line of readAt(fd, 0, TITLE_CHUNK).split("\n")) {
      if (!line.includes('"user"')) continue;
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        if (o.type !== "response_item") continue;
        const p = (o.payload ?? {}) as { type?: string; role?: string; content?: { type?: string; text?: string }[] };
        if (p.type !== "message" || p.role !== "user") continue;
        const text = (p.content ?? []).find((part) => typeof part.text === "string" && part.text.trim())?.text;
        const title = promptTitle(text);
        if (title) return title;
      } catch {
        // a line cut by the chunk's edge
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Where a Codex conversation's record is, by its id: the rollout file under `<CODEX_HOME>/sessions` that ends with it. */
export function findCodexRollout(sessionId: string, home = codexHome()): string | null {
  if (!sessionIdShape.test(sessionId)) return null;
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
  return walk(path.join(home, "sessions"), 0);
}

export const codexRecord: EngineRecord = {
  find: (sessionId) => findCodexRollout(sessionId),
  read: (file, opts) => readJsonlRecord(file, CODEX_ROLLOUT, opts),
  title: codexRolloutTitle,
  usage: (file, from) => countJsonlUsage(file, CODEX_ROLLOUT, from)
};
