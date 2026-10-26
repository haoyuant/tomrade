import fs from "node:fs";
import path from "node:path";
import type { EngineRecord, RecordLine, RecordRead } from "@tomradex/agent";
import { readJsonlRecord, sessionIdShape } from "@tomradex/engine-kit";

/** The most of a conversation one snapshot keeps, as written; past it only the end is kept. */
const SNAPSHOT_MAX = 8 * 1024 * 1024;

/** The first line of a snapshot, which is not a line of the conversation. */
interface SnapshotHead {
  snapshot: 1;
  agent: string;
  at: number;
  cut: boolean;
}

/** Where one conversation's snapshot goes: by its agent and its id, so a conversation taken up again keeps one. */
export function snapshotFile(dir: string, agent: string, externalId: string): string | null {
  if (!sessionIdShape.test(externalId) || !sessionIdShape.test(agent)) return null;
  return path.join(dir, `${agent}-${externalId}.jsonl`);
}

/** One turn of the event loop, so a long read does not hold up the app. */
const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The conversation in an agent's record, written to `to` as its lines, the newest kept when it runs past
 * `SNAPSHOT_MAX`. Read a stretch at a time, giving way between stretches; written whole or not at all. Null when the
 * record cannot be read.
 */
export async function saveSnapshot(to: string, agent: string, record: EngineRecord, file: string, now = Date.now(), max = SNAPSHOT_MAX): Promise<{ cut: boolean } | null> {
  const stretches: string[][] = [];
  let size = 0;
  let read = record.read(file);
  if (!read) return null;
  let cut = false;
  for (;;) {
    const rows = read.lines.map((line) => JSON.stringify(line));
    const kept: string[] = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      size += Buffer.byteLength(rows[i]!) + 1;
      if (size > max) {
        cut = true;
        break;
      }
      kept.unshift(rows[i]!);
    }
    stretches.unshift(kept);
    if (cut || !read.cut || read.start === undefined) break;
    const before = read.start;
    await yieldTurn();
    read = record.read(file, { before });
    // A record that stops answering partway keeps what was read, said to be cut.
    if (!read || (read.start !== undefined && read.start >= before)) {
      cut = true;
      break;
    }
  }
  const head: SnapshotHead = { snapshot: 1, agent, at: now, cut };
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  const temp = `${to}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, [JSON.stringify(head), ...stretches.flat()].join("\n") + "\n");
  await fs.promises.rename(temp, to);
  return { cut };
}

const SNAPSHOT_LINES = {
  lines: (entry: Record<string, unknown>): RecordLine[] => (typeof entry.who === "string" && typeof entry.text === "string" ? [entry as unknown as RecordLine] : [])
};

/** A stretch of a snapshot, read the way an agent's own record is; null when there is none. */
export function readSnapshot(file: string, before?: number): RecordRead | null {
  return readJsonlRecord(file, SNAPSHOT_LINES, before === undefined ? undefined : { before });
}
