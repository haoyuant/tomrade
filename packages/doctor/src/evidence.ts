import fs from "node:fs";
import os from "node:os";
import { redactSecrets } from "@tomradex/agent";

/** Keys, the home folder's name and email addresses never leave the machine in a report. */
export function scrub(text: string, home = os.homedir()): string {
  let out = redactSecrets(text);
  if (home && home.length > 1) out = out.split(home).join("~");
  return out.replace(/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g, "$1…@…");
}

export const TAIL_LINES = 120;
export const TAIL_CHARS = 24_000;

/** The end of a log file, scrubbed: the last lines, never more than a few dozen KB. */
export function tail(file: string, lines = TAIL_LINES, chars = TAIL_CHARS): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, chars * 2);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8").split(/\r?\n/);
    // A partial first line from the middle of the file says nothing.
    if (length < size) text.shift();
    const kept = scrub(text.slice(-lines).join("\n"));
    return kept.length > chars ? kept.slice(-chars) : kept;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Newest first: the files in `dir` whose names pass `keep`. */
export function newestFiles(dir: string, keep: (name: string) => boolean = () => true, limit = 2): string[] {
  try {
    return fs.readdirSync(dir)
      .filter(keep)
      .map((name) => ({ file: `${dir}/${name}`, at: fs.statSync(`${dir}/${name}`) }))
      .filter((f) => f.at.isFile())
      .sort((a, b) => b.at.mtimeMs - a.at.mtimeMs)
      .slice(0, limit)
      .map((f) => f.file);
  } catch {
    return [];
  }
}

/** Lines that look like errors, from the newest Tomrade logs: what a report shows first. */
export function errorLines(text: string, limit = 30): string[] {
  return text.split("\n").filter((line) => /\b(error|fail(ed|ure)?|exception|unhandled|refused)\b/i.test(line)).slice(-limit);
}
