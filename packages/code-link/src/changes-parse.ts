import type { ChangedFile, ChangeHunk, ChangeLine, ChangeStatus } from "./changes.js";

/** One file of a patch as git printed it: what the patch alone says, before the file list corrects it. */
export interface PatchFile extends ChangedFile {
  hunks: ChangeHunk[];
}

/** A path git quoted (`"a/caf\303\251 \"x\".txt"`) as the bytes it stands for; an unquoted one unchanged. */
export function unquotePath(text: string): string {
  if (!(text.startsWith('"') && text.endsWith('"') && text.length >= 2)) return text;
  const plain: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  // Escapes are bytes (a UTF-8 character is several), so the whole name is put back together as bytes.
  const parts: Buffer[] = [];
  const body = text.slice(1, -1);
  const escape = /\\([0-7]{3}|.)/g;
  let from = 0;
  for (let m = escape.exec(body); m; m = escape.exec(body)) {
    parts.push(Buffer.from(body.slice(from, m.index), "utf8"));
    const code = m[1].length === 3 ? parseInt(m[1], 8) : (plain[m[1]] ?? m[1].charCodeAt(0));
    parts.push(Buffer.from([code]));
    from = m.index + m[0].length;
  }
  parts.push(Buffer.from(body.slice(from), "utf8"));
  return Buffer.concat(parts).toString("utf8");
}

/** The path of a `--- a/x` or `+++ b/x` line; null for /dev/null. */
function sidePath(rest: string, prefix: "a/" | "b/"): string | null {
  // git ends an unquoted name that has a space in it with a tab
  const name = unquotePath(rest.replace(/\t$/, ""));
  if (name === "/dev/null") return null;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** Both paths of a `diff --git` line, for a file the patch says nothing more about (a mode change, a binary, an empty file). */
function headerPaths(rest: string): { oldPath: string; path: string } | null {
  if (rest.startsWith('"') || rest.endsWith('"')) {
    const m = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|.+)$/.exec(rest);
    if (!m) return null;
    return { oldPath: unquotePath(m[1]).replace(/^a\//, ""), path: unquotePath(m[2]).replace(/^b\//, "") };
  }
  // Unquoted and not a rename: `a/P b/P`, so the two halves are the same length.
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " " && rest.slice(2, half) === rest.slice(half + 3)) return { oldPath: rest.slice(2, half), path: rest.slice(half + 3) };
  const m = /^a\/(.+?) b\/(.+)$/.exec(rest);
  return m ? { oldPath: m[1], path: m[2] } : null;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * A `git diff` patch (prefixes `a/` and `b/`) as files, hunks and numbered lines. Reads at most `maxBytes` of it;
 * the file the limit falls in keeps the lines read so far and is marked truncated.
 */
export function parsePatch(patch: string, maxBytes = Infinity): PatchFile[] {
  const cut = patch.length > maxBytes;
  // Whole lines only: a limit that falls inside a line drops that line.
  const text = cut ? patch.slice(0, patch.lastIndexOf("\n", maxBytes) + 1) : patch;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  let hunk: ChangeHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldAt = 0;
  let newAt = 0;
  let renamed = false;
  let status: ChangeStatus = "modified";
  const close = () => {
    if (!file) return;
    file.status = renamed ? "renamed" : status;
    if (file.status !== "renamed") file.oldPath = null;
    if (file.binary) {
      file.additions = null;
      file.deletions = null;
    }
    files.push(file);
  };
  for (const raw of lines) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const mark = raw[0];
      // The line ending belongs to the file, not the diff: a CRLF file's lines arrive with their \r.
      const body = raw.slice(1).replace(/\r$/, "");
      let line: ChangeLine | null = null;
      if (mark === "+") {
        line = { kind: "add", old: null, new: newAt++, text: body };
        newLeft--;
        file!.additions!++;
      } else if (mark === "-") {
        line = { kind: "del", old: oldAt++, new: null, text: body };
        oldLeft--;
        file!.deletions!++;
      } else if (mark === " " || raw === "") {
        // Some tools strip the lone space of an empty context line.
        line = { kind: "context", old: oldAt++, new: newAt++, text: body };
        oldLeft--;
        newLeft--;
      } else if (mark === "\\") {
        const last = hunk.lines.at(-1);
        if (last) last.noEol = true;
      }
      if (line) hunk.lines.push(line);
      continue;
    }
    if (raw.startsWith("diff --git ")) {
      close();
      const paths = headerPaths(raw.slice("diff --git ".length));
      file = { path: paths?.path ?? "", oldPath: paths?.oldPath ?? null, status: "modified", additions: 0, deletions: 0, binary: false, generated: false, truncated: false, hunks: [] };
      hunk = null;
      renamed = false;
      status = "modified";
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("\\")) {
      const last = hunk?.lines.at(-1);
      if (last) last.noEol = true;
      continue;
    }
    const at = HUNK.exec(raw);
    if (at) {
      hunk = { oldStart: Number(at[1]), oldLines: at[2] === undefined ? 1 : Number(at[2]), newStart: Number(at[3]), newLines: at[4] === undefined ? 1 : Number(at[4]), header: at[5], lines: [] };
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      oldAt = hunk.oldStart;
      newAt = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }
    if (raw.startsWith("new file mode ")) status = "added";
    else if (raw.startsWith("deleted file mode ")) status = "deleted";
    else if (raw.startsWith("rename from ")) {
      renamed = true;
      file.oldPath = unquotePath(raw.slice("rename from ".length));
    } else if (raw.startsWith("rename to ")) {
      renamed = true;
      file.path = unquotePath(raw.slice("rename to ".length));
    } else if (raw.startsWith("--- ")) {
      const side = sidePath(raw.slice(4), "a/");
      if (side !== null && !renamed) file.oldPath = side;
    } else if (raw.startsWith("+++ ")) {
      const side = sidePath(raw.slice(4), "b/");
      if (side !== null && !renamed) file.path = side;
      else if (side === null && file.oldPath) file.path = file.oldPath;
    } else if (raw.startsWith("Binary files ") || raw === "GIT binary patch") file.binary = true;
  }
  if (file && cut) file.truncated = true;
  close();
  return files;
}

/** A file git does not track yet, as the lines it would add; `text` is its content. */
export function addedFileHunks(text: string): ChangeHunk[] {
  if (!text) return [];
  const body = text.split("\n");
  const noEol = body.at(-1) !== "";
  if (!noEol) body.pop();
  const lines: ChangeLine[] = body.map((line, i) => ({ kind: "add", old: null, new: i + 1, text: line.replace(/\r$/, "") }));
  if (noEol && lines.length) lines.at(-1)!.noEol = true;
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, header: "", lines }];
}

/** One file of `git diff --raw --numstat -z`: every changed file, whatever the patch is cut to. */
export interface ListedFile {
  path: string;
  oldPath: string | null;
  status: ChangeStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

/** `git diff --raw --numstat -z -M` as one row per file, in git's order. */
export function parseFileList(out: string): ListedFile[] {
  const tokens = out.split("\0");
  const files = new Map<string, ListedFile>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (token.startsWith(":")) {
      const letter = token.split(" ").at(-1)?.[0] ?? "M";
      const two = letter === "R" || letter === "C";
      const oldPath = two ? tokens[++i] : null;
      const path = tokens[++i];
      const status: ChangeStatus = letter === "A" || letter === "C" ? "added" : letter === "D" ? "deleted" : letter === "R" ? "renamed" : "modified";
      files.set(path, { path, oldPath: status === "renamed" ? oldPath : null, status, additions: 0, deletions: 0, binary: false });
      continue;
    }
    const [added, deleted, name] = token.split("\t");
    if (deleted === undefined) continue;
    let path = name;
    if (!path) {
      // a rename or copy: the two names follow as their own fields
      i++;
      path = tokens[++i];
    }
    const file = files.get(path);
    if (!file) continue;
    file.binary = added === "-";
    file.additions = file.binary ? null : Number(added);
    file.deletions = file.binary ? null : Number(deleted);
  }
  return [...files.values()];
}
