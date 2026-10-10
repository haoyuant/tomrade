/**
 * The note syntax both sides read: wiki links, markdown links to other files,
 * tags, a title. Pure — the renderer imports it as `@tomradex/notes/syntax`,
 * so a link resolves to the same file in the editor, the preview and the index.
 */

export interface NoteLink {
  /** As written, before any `#` or `|`; empty for a link into the same note. */
  target: string;
  /** A heading or `^block` after the `#`. */
  anchor: string | null;
  alias: string | null;
  embed: boolean;
  kind: "wiki" | "markdown";
  /** 1-based. */
  line: number;
  from: number;
  to: number;
}

export interface NoteTag {
  /** Without the `#`, as written. */
  tag: string;
  line: number;
  from: number;
  to: number;
}

export interface ParsedNote {
  title: string | null;
  links: NoteLink[];
  /** Every tag once, lower-cased, front matter included. */
  tags: string[];
  /** Inline tags where they stand. */
  tagSpans: NoteTag[];
  aliases: string[];
}

const NOTE_EXT = /\.(md|markdown|mdx)$/i;
const INDEXED_EXT = /\.(md|markdown|mdx|txt)$/i;

export const isNotePath = (path: string): boolean => NOTE_EXT.test(path);
/** What the search index reads: notes, and plain text. */
export const isIndexedPath = (path: string): boolean => INDEXED_EXT.test(path);

/** The name a note goes by: its file name without the extension. */
export const noteName = (path: string): string => (path.split("/").pop() ?? path).replace(NOTE_EXT, "");

const dirOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Lower-cased, forward-slashed, no leading `./` or `/`, no note extension: what two spellings of one link share. */
export function linkKey(target: string): string {
  return target
    .normalize("NFC")
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "")
    .replace(NOTE_EXT, "")
    .toLowerCase();
}

/** `a/./b/../c` → `a/c`; null when it climbs out of the store. */
function joinPath(dir: string, rel: string): string | null {
  const out: string[] = dir ? dir.split("/") : [];
  for (const part of rel.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

// ── parsing ──────────────────────────────────────────────────────────────────

/** Blank out what is not prose — front matter, fenced and inline code, `%%comments%%` — keeping every offset. */
function mask(text: string): { masked: string; frontmatter: string | null } {
  const chars = text.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (chars[i] !== "\n") chars[i] = " ";
  };
  let frontmatter: string | null = null;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (fm) {
    frontmatter = fm[1]!;
    blank(0, fm[0].length);
  }
  let offset = 0;
  let fence: { char: string; size: number; start: number } | null = null;
  for (const line of text.split("\n")) {
    const end = offset + line.length;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.size && !line.slice(marker[0].length).trim()) {
        blank(fence.start, end);
        fence = null;
      }
    } else if (marker && offset >= (fm?.[0].length ?? 0)) {
      fence = { char: marker[1]![0]!, size: marker[1]!.length, start: offset };
    }
    offset = end + 1;
  }
  if (fence) blank(fence.start, text.length);
  const fenced = chars.join("");
  for (const m of fenced.matchAll(/(`+)(?:[^`\n]|[^`\n][^\n]*?[^`\n])\1(?!`)/g)) blank(m.index, m.index + m[0].length);
  for (const m of chars.join("").matchAll(/%%[\s\S]*?%%/g)) blank(m.index, m.index + m[0].length);
  return { masked: chars.join(""), frontmatter };
}

const lineStarts = (text: string): number[] => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
};

const lineAt = (starts: number[], offset: number): number => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
};

/** A YAML list in either spelling: `[a, b]`, `a, b`, or `- a` lines under the key. */
function frontList(frontmatter: string, key: string): string[] {
  const lines = frontmatter.split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^${key}\\s*:`, "i").test(l));
  if (at < 0) return [];
  const rest = lines[at]!.replace(new RegExp(`^${key}\\s*:`, "i"), "").trim();
  const clean = (v: string) => v.trim().replace(/^["']|["']$/g, "").replace(/^#/, "").trim();
  if (rest) return rest.replace(/^\[|\]$/g, "").split(",").map(clean).filter(Boolean);
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s*-\s+(.+)$/.exec(line);
    if (!item) break;
    out.push(clean(item[1]!));
  }
  return out.filter(Boolean);
}

const frontValue = (frontmatter: string, key: string): string | null => {
  const m = new RegExp(`^${key}\\s*:\\s*(.+)$`, "im").exec(frontmatter);
  const value = m?.[1]?.trim().replace(/^["']|["']$/g, "").trim();
  return value || null;
};

const WIKI = /(!?)\[\[([^[\]\n|#]*)(?:#([^[\]\n|]*))?(?:\|([^[\]\n]*))?\]\]/g;
const MARKDOWN = /(!?)\[([^\]\n]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\)/g;
// A tag starts a word, holds at least one non-digit, and may nest with `/`.
const TAG = /(^|[\s(,;])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

export function parseNote(text: string): ParsedNote {
  const { masked, frontmatter } = mask(text);
  const starts = lineStarts(text);
  const links: NoteLink[] = [];
  for (const m of masked.matchAll(WIKI)) {
    const target = m[2]!.trim();
    links.push({
      target,
      anchor: m[3]?.trim() || null,
      alias: m[4]?.trim() || null,
      embed: m[1] === "!",
      kind: "wiki",
      line: lineAt(starts, m.index),
      from: m.index,
      to: m.index + m[0].length
    });
  }
  for (const m of masked.matchAll(MARKDOWN)) {
    const raw = m[3]!;
    // Somewhere else on the web, or a place in this page: not a link between notes.
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#")) continue;
    const [pathPart, anchor] = raw.split("#", 2) as [string, string | undefined];
    let target = pathPart;
    try {
      target = decodeURI(pathPart);
    } catch {
      // a stray % stays as written
    }
    links.push({ target, anchor: anchor || null, alias: m[2] || null, embed: m[1] === "!", kind: "markdown", line: lineAt(starts, m.index), from: m.index, to: m.index + m[0].length });
  }
  links.sort((a, b) => a.from - b.from);

  // Link text is not where tags live: `[[Note#Heading]]` names a heading.
  const chars = masked.split("");
  for (const l of links) chars.fill(" ", l.from, l.to);
  const linkless = chars.join("");
  const tagSpans: NoteTag[] = [];
  for (const m of linkless.matchAll(TAG)) {
    const tag = m[2]!.replace(/\/+$/, "");
    if (!tag) continue;
    const from = m.index + m[1]!.length;
    tagSpans.push({ tag, line: lineAt(starts, from), from, to: from + 1 + tag.length });
  }
  const tags = new Set(tagSpans.map((t) => t.tag.toLowerCase()));
  for (const t of frontmatter ? [...frontList(frontmatter, "tags"), ...frontList(frontmatter, "tag")] : []) if (!/\s/.test(t)) tags.add(t.toLowerCase());

  let title = frontmatter ? frontValue(frontmatter, "title") : null;
  if (!title) {
    const h1 = /^#[ \t]+(.+?)[ \t#]*$/m.exec(masked);
    if (h1) title = text.slice(h1.index, h1.index + h1[0].length).replace(/^#[ \t]+/, "").replace(/[ \t#]*$/, "").trim() || null;
  }
  return { title, links, tags: [...tags], tagSpans, aliases: frontmatter ? frontList(frontmatter, "aliases") : [] };
}

// ── resolution ───────────────────────────────────────────────────────────────

/**
 * Which file a link means, among `paths` (files, store-relative). A markdown
 * link is a relative path. A wiki link names a note the way Obsidian does: a
 * path from the linking note's folder, the whole path from the root, or a path
 * suffix — the bare name being the usual one — with ties going to the linking
 * note's own folder, then the shallowest path. No extension means a note; one
 * that is not a note's names the file exactly (`[[diagram.png]]`).
 */
export function resolveLink(link: Pick<NoteLink, "target" | "kind">, from: string, paths: readonly string[]): string | null {
  const target = link.target.trim();
  if (!target) return paths.includes(from) ? from : null;
  const here = dirOf(from);
  if (link.kind === "markdown") {
    for (const base of [here, ""]) {
      const joined = joinPath(base, target);
      if (joined === null) continue;
      const hit = findExact(joined, paths) ?? findExact(`${joined}.md`, paths);
      if (hit) return hit;
    }
    return null;
  }
  const relative = joinPath(here, target);
  const note = bestMatch(linkKey(target), relative === null ? null : linkKey(relative), here, paths.filter(isNotePath), linkKey);
  if (note || NOTE_EXT.test(target)) return note;
  const lower = (p: string) => p.normalize("NFC").replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "").toLowerCase();
  return bestMatch(lower(target), relative === null ? null : lower(relative), here, paths.filter((p) => !isNotePath(p)), lower);
}

function bestMatch(key: string, relativeKey: string | null, here: string, paths: readonly string[], keyOf: (p: string) => string): string | null {
  if (!key) return null;
  let best: { path: string; score: number } | null = null;
  for (const path of paths) {
    const k = keyOf(path);
    let rank: number;
    if (relativeKey !== null && k === relativeKey) rank = 0;
    else if (k === key) rank = 1;
    else if (k.endsWith(`/${key}`)) rank = 2;
    else continue;
    // Same folder first, then the shallowest, then by name: one answer, always the same.
    const score = rank * 1e6 + (dirOf(path) === here ? 0 : 1e5) + path.split("/").length * 1e3;
    if (!best || score < best.score || (score === best.score && path < best.path)) best = { path, score };
  }
  return best?.path ?? null;
}

function findExact(path: string, paths: readonly string[]): string | null {
  if (paths.includes(path)) return path;
  const lower = path.toLowerCase();
  return paths.find((p) => p.toLowerCase() === lower) ?? null;
}

/** The shortest wiki target that still means `to` from `from`: the bare name when it is unambiguous. */
export function linkTarget(to: string, from: string, paths: readonly string[]): string {
  const bare = isNotePath(to) ? noteName(to) : (to.split("/").pop() ?? to);
  if (resolveLink({ target: bare, kind: "wiki" }, from, paths) === to) return bare;
  return isNotePath(to) ? to.replace(NOTE_EXT, "") : to;
}

/** A link as it should now read, pointing at `to`; alias, anchor and embed kept. */
export function rewriteLink(link: NoteLink, to: string, from: string, paths: readonly string[]): string {
  if (link.kind === "markdown") {
    const rel = relativePath(dirOf(from), to);
    const href = encodeURI(rel) + (link.anchor ? `#${link.anchor}` : "");
    return `${link.embed ? "!" : ""}[${link.alias ?? ""}](${href})`;
  }
  const target = linkTarget(to, from, paths);
  return `${link.embed ? "!" : ""}[[${target}${link.anchor ? `#${link.anchor}` : ""}${link.alias ? `|${link.alias}` : ""}]]`;
}

function relativePath(fromDir: string, to: string): string {
  const a = fromDir ? fromDir.split("/") : [];
  const b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

/** A new note's path for a link that resolves to nothing: beside the linking note, or where the link says. */
export function newNotePath(target: string, from: string): string | null {
  const clean = target.trim().replace(/\\/g, "/");
  if (!clean) return null;
  const withExt = NOTE_EXT.test(clean) ? clean : `${clean}.md`;
  return clean.includes("/") ? joinPath("", withExt) : joinPath(dirOf(from), withExt);
}
