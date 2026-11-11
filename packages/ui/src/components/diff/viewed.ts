import type { ChangedFile } from "@tomradex/code-link";

/** The versions of each file a person marked as viewed, by path. */
export type ViewedMarks = Record<string, string[]>;

/** Versions remembered per file: enough for the same file seen under a few scopes. */
const KEPT = 6;
const PREFIX = "tomrade.diff.viewed.";

/** FNV-1a, 32 bit: small, stable, and enough to tell two versions of a file's diff apart. */
function hash(text: string, seed = 0x811c9dc5): number {
  let h = seed;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** What a file's diff says, as one short string: it changes whenever a line of the diff does. */
export function fileVersion(file: ChangedFile): string {
  let h = hash(`${file.status}\0${file.oldPath ?? ""}\0${file.additions ?? "b"}\0${file.deletions ?? "b"}`);
  for (const hunk of file.hunks ?? []) {
    h = hash(`${hunk.oldStart},${hunk.newStart}`, h);
    for (const line of hunk.lines) h = hash(`${line.kind[0]}${line.text}\n`, h);
  }
  return h.toString(36);
}

export const isViewed = (marks: ViewedMarks, file: ChangedFile): boolean => marks[file.path]?.includes(fileVersion(file)) ?? false;

/** The marks with this version of the file marked viewed, or no longer. */
export function markViewed(marks: ViewedMarks, file: ChangedFile, viewed: boolean): ViewedMarks {
  const version = fileVersion(file);
  const rest = (marks[file.path] ?? []).filter((v) => v !== version);
  const next = viewed ? [...rest, version].slice(-KEPT) : rest;
  const { [file.path]: _dropped, ...others } = marks;
  return next.length ? { ...others, [file.path]: next } : others;
}

/** The marks kept under `key` (a ticket, say); none when there is no key or the store cannot be read. */
export function readViewed(key: string | undefined): ViewedMarks {
  if (!key) return {};
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(PREFIX + key) ?? "{}");
    return stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as ViewedMarks) : {};
  } catch {
    return {};
  }
}

export function writeViewed(key: string | undefined, marks: ViewedMarks): void {
  if (!key) return;
  try {
    if (Object.keys(marks).length) localStorage.setItem(PREFIX + key, JSON.stringify(marks));
    else localStorage.removeItem(PREFIX + key);
  } catch {
    // a private window or a full store: the marks last for this view only
  }
}
