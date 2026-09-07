import fs from "node:fs";
import path from "node:path";
import type { OplogEntry } from "@tomrade/domain";
import { ARTIFACT_DIR } from "./state.js";

export const LOG_DIR = "log";

/** One op as the folder's log carries it: the identity, the moment, the author, the change. Never a snapshot. */
export interface LogLine {
  id: string;
  at: number;
  by: string;
  runId?: string | null;
  entity: string;
  entityId: string;
  op: string;
  base: number | null;
  patch: Record<string, unknown> | null;
}

export interface DeviceLog {
  device: string;
  ops: LogLine[];
}

const header = (device: string): string => JSON.stringify({ log: 1, device }) + "\n";

export const logFile = (dir: string, device: string): string => path.join(dir, ARTIFACT_DIR, LOG_DIR, `${device}.jsonl`);

export function toLine(entry: OplogEntry): LogLine | null {
  if (entry.deviceSeq === null) return null;
  return {
    id: `${entry.device}:${entry.deviceSeq}`,
    at: entry.at,
    by: entry.by,
    ...(entry.runId ? { runId: entry.runId } : {}),
    entity: entry.entity,
    entityId: entry.entityId,
    op: entry.op,
    base: entry.baseVersion,
    patch: entry.patch
  };
}

/** Write-through: one line per op, appended as soon as the row exists. The header is written with the first line. */
export function appendLog(dir: string, device: string, lines: LogLine[]): void {
  if (!lines.length) return;
  const file = logFile(dir, device);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fresh = !fs.existsSync(file);
  fs.appendFileSync(file, (fresh ? header(device) : "") + lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
}

/** Every machine's log in the folder. A torn last line (a crash mid-append) is dropped, not an error. */
export function readLogs(dir: string): DeviceLog[] {
  const logs = path.join(dir, ARTIFACT_DIR, LOG_DIR);
  if (!fs.existsSync(logs)) return [];
  return fs
    .readdirSync(logs)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => ({ device: f.slice(0, -".jsonl".length), ops: parseLog(fs.readFileSync(path.join(logs, f), "utf8")) }));
}

export function parseLog(text: string): LogLine[] {
  const ops: LogLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || !("id" in parsed)) continue;
    ops.push(parsed as LogLine);
  }
  return ops;
}

/**
 * Only this machine's own file is ever rewritten: drop what is older than the
 * window. Another machine that has not synced within it falls back to a
 * snapshot-only merge — still correct, just without a referee for a tie.
 */
export function compactLog(dir: string, device: string, windowMs: number, now = Date.now()): void {
  const file = logFile(dir, device);
  if (!fs.existsSync(file)) return;
  const ops = parseLog(fs.readFileSync(file, "utf8"));
  const kept = ops.filter((op) => now - op.at <= windowMs);
  if (kept.length === ops.length) return;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, header(device) + kept.map((l) => JSON.stringify(l)).join("\n") + (kept.length ? "\n" : ""), "utf8");
  fs.renameSync(tmp, file);
}

export const parseOpId = (id: string): { device: string; seq: number } | null => {
  const at = id.lastIndexOf(":");
  if (at < 0) return null;
  const seq = Number(id.slice(at + 1));
  return Number.isFinite(seq) ? { device: id.slice(0, at), seq } : null;
};
