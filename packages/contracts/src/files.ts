import fs from "node:fs";
import path from "node:path";

export interface AtomicWriteOptions {
  /** Make the parent folder first; on unless false. */
  mkdir?: boolean;
  /** Name the temporary file after this process too, for a file more than one process writes. */
  perProcess?: boolean;
  /** The file's permissions, the temporary file's from the start. */
  mode?: number;
}

export interface JsonWriteOptions extends AtomicWriteOptions {
  /** Two-space indentation; on unless false. */
  pretty?: boolean;
  /** End with a newline; follows `pretty` unless given. */
  newline?: boolean;
}

/** Writes through a temporary file and a rename: a crash leaves the old file or the new one, never half of one. */
export function writeFileAtomic(file: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): void {
  if (opts.mkdir !== false) fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = opts.perProcess ? `${file}.${process.pid}.tmp` : `${file}.tmp`;
  if (opts.mode === undefined) fs.writeFileSync(tmp, data);
  else {
    fs.writeFileSync(tmp, data, { mode: opts.mode });
    // A temporary file left from before keeps its own mode through the write.
    fs.chmodSync(tmp, opts.mode);
  }
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file: string, value: unknown, opts: JsonWriteOptions = {}): void {
  const pretty = opts.pretty !== false;
  const body = (pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)) + ((opts.newline ?? pretty) ? "\n" : "");
  writeFileAtomic(file, body, opts);
}

/**
 * The file's JSON, unchecked, or `fallback` when it is missing or does not
 * parse. With `missingOnly`, only a missing file falls back.
 */
export function readJsonOr<T>(file: string, fallback: T, opts: { missingOnly?: boolean } = {}): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    if (opts.missingOnly && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return fallback;
  }
}
