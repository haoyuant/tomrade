import fs from "node:fs";
import path from "node:path";
import type { EngineRecord, RecordLine } from "@tomradex/agent";
import { clipLine, isMachinery, promptTitle, readAt, readJsonlRecord, sessionIdShape, toolLine } from "@tomradex/engine-kit";
import { codexHome } from "./account.js";

/** How much of a rollout's head is read for its first prompt. */
const TITLE_CHUNK = 256 * 1024;

/** One entry of a Codex rollout as conversation lines: messages and function calls, not the context Codex injects. */
function codexRolloutLines(o: Record<string, unknown>): RecordLine[] {
  if (o.type !== "response_item") return [];
  const p = (o.payload ?? {}) as { type?: string; role?: string; content?: { type?: string; text?: string }[]; name?: string; arguments?: string };
  if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
    const who = p.role === "user" ? "person" : "agent";
    return (p.content ?? []).flatMap((b) => (b.text && !isMachinery(b.text) ? [{ who, text: clipLine(b.text.trim()) } as RecordLine] : []));
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
  read: (file) => readJsonlRecord(file, codexRolloutLines),
  title: codexRolloutTitle
};
