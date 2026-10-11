import { createHash } from "node:crypto";
import { listingAt } from "./git-sync.js";
import type { FileEntry, FilesAgentPolicy } from "./types.js";

/**
 * What an agent is told a project holds, before it asks anything. The point is
 * discovery, not access: a path left out of the index still reads and writes,
 * and the person who left it out only meant "do not bring this up".
 */
export interface AgentIndex {
  markdown: string;
  /** Files named or counted here. */
  listed: number;
  /** Files in the store, including the ones left out. */
  total: number;
  tokens: number;
  /** Changes when the rendered text does, so a session can notice it went stale. */
  digest: string;
}

export interface AgentIndexInput {
  entries: FileEntry[];
  policy: FilesAgentPolicy;
  /** The heading a document gives itself, when it gives one. */
  titleOf(entry: FileEntry): string | null;
  /** Roughly how many tokens the whole index may take. */
  budget?: number;
  /** Folders that stay expanded whatever the budget: the ticket's own, and wherever its materials live. */
  focus?: string[];
  /** This machine's copy, named only for an engine that can open it itself. */
  root?: string | null;
  /** The engine has its own file tools, so the folder is worth naming. */
  native?: boolean;
}

const DEFAULT_BUDGET = 1_500;
/** English and Chinese land either side of this; the index is an estimate, not a meter. */
const CHARS_PER_TOKEN = 3.5;
/** Past this many siblings a folder is a list to browse, not a list to read. */
const FILES_PER_FOLDER = 12;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

export const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)}M` : bytes >= 1024 ? `${Math.round(bytes / 1024)}k` : `${bytes}`;

/** Same year needs no year: the index is read by something that knows what today is. */
export function shortDate(at: number, now = Date.now()): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getFullYear() === new Date(now).getFullYear() ? stamp : `${d.getFullYear()}-${stamp}`;
}

interface Node {
  entry: FileEntry;
  children: Node[];
  /** Listed files at or below here. */
  files: number;
  newest: number;
}

function build(entries: FileEntry[], policy: FilesAgentPolicy): { roots: Node[]; listed: number; withheld: { person: boolean; attachments: boolean } } {
  const nodes = new Map<string, Node>();
  const roots: Node[] = [];
  const withheld = { person: false, attachments: false };
  // Depth first, folders before files, so a parent always exists by the time a
  // child arrives. An unlisted folder is still built: a rule deeper down may
  // list one file inside it, and that file needs somewhere to hang.
  for (const entry of entries) {
    if (entry.kind === "file") {
      const listing = listingAt(policy, entry.path);
      if (listing.mode === "unlisted") {
        // the person's rules, or the built-in default for attachments folders
        if (listing.source === "default" && policy.default === "listed") withheld.attachments = true;
        else withheld.person = true;
        continue;
      }
    }
    const node: Node = { entry, children: [], files: entry.kind === "file" ? 1 : 0, newest: entry.modifiedAt };
    const slash = entry.path.lastIndexOf("/");
    const parent = slash === -1 ? null : nodes.get(entry.path.slice(0, slash));
    if (slash !== -1 && !parent) continue;
    nodes.set(entry.path, node);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  let listed = 0;
  const roll = (node: Node): void => {
    for (const child of node.children) {
      roll(child);
      if (node.entry.kind === "dir") {
        node.files += child.files;
        node.newest = Math.max(node.newest, child.newest);
      }
    }
    if (node.entry.kind === "file") listed++;
  };
  for (const root of roots) roll(root);
  // A folder holding nothing listed has nothing to say.
  const prune = (list: Node[]): Node[] =>
    list.filter((n) => n.entry.kind === "file" || n.files > 0).map((n) => ({ ...n, children: prune(n.children) }));
  return { roots: prune(roots), listed, withheld };
}

function render(roots: Node[], folded: Set<string>, titleOf: (e: FileEntry) => string | null, now: number): string[] {
  const lines: string[] = [];
  const walk = (nodes: Node[], depth: number): void => {
    const indent = "  ".repeat(depth);
    const dirs = nodes.filter((n) => n.entry.kind === "dir");
    const files = nodes.filter((n) => n.entry.kind === "file");
    for (const dir of dirs) {
      if (folded.has(dir.entry.path)) {
        lines.push(`${indent}- ${dir.entry.path}/ (${dir.files} files, newest ${shortDate(dir.newest, now)})`);
        continue;
      }
      const title = titleOf(dir.entry);
      lines.push(`${indent}- ${dir.entry.path}/ (${dir.files})${title ? ` — ${title}` : ""}`);
      walk(dir.children, depth + 1);
    }
    const shown = files.length > FILES_PER_FOLDER ? [...files].sort((a, b) => b.entry.modifiedAt - a.entry.modifiedAt).slice(0, FILES_PER_FOLDER) : files;
    for (const file of shown) {
      const title = titleOf(file.entry);
      lines.push(`${indent}- ${file.entry.path} — ${formatSize(file.entry.size)} · ${shortDate(file.entry.modifiedAt, now)}${title ? ` · ${title}` : ""}`);
    }
    if (shown.length < files.length) lines.push(`${indent}- … ${files.length - shown.length} more here (list_files to see them)`);
  };
  walk(roots, 0);
  return lines;
}

/** Every folder that must stay open: the focus paths themselves and everything above them. */
function protectedPaths(focus: string[]): Set<string> {
  const keep = new Set<string>();
  for (const path of focus) {
    const parts = path.split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) keep.add(parts.slice(0, i).join("/"));
  }
  return keep;
}

/**
 * Fold the biggest, deepest folder that nobody asked to keep open, and keep
 * folding until the index fits. What is folded still says how much it holds and
 * how recent it is, which is enough for the model to decide to look.
 */
export function buildAgentIndex(input: AgentIndexInput): AgentIndex {
  const now = Date.now();
  const budget = input.budget ?? DEFAULT_BUDGET;
  const { roots, listed, withheld } = build(input.entries, input.policy);
  const total = input.entries.filter((e) => e.kind === "file").length;
  const keep = protectedPaths(input.focus ?? []);

  const foldable: Node[] = [];
  const collect = (nodes: Node[], depth: number): void => {
    for (const node of nodes) {
      if (node.entry.kind !== "dir") continue;
      if (!keep.has(node.entry.path) && node.files > 0) foldable.push(node);
      collect(node.children, depth + 1);
    }
  };
  collect(roots, 0);
  // Deepest first, then biggest: folding a leaf folder costs the least context.
  foldable.sort((a, b) => b.entry.path.split("/").length - a.entry.path.split("/").length || b.files - a.files);

  const folded = new Set<string>();
  const header = headerLines(input, listed, roots);
  const footer = footerLines(input, withheld);
  const assemble = (lines: string[]) => [...header, "", ...lines, "", ...footer].join("\n");

  let lines = render(roots, folded, input.titleOf, now);
  for (const node of foldable) {
    if (estimateTokens(assemble(lines)) <= budget) break;
    // A folder inside one already folded is gone from the output anyway.
    if ([...folded].some((p) => node.entry.path.startsWith(`${p}/`))) continue;
    folded.add(node.entry.path);
    lines = render(roots, folded, input.titleOf, now);
  }
  let markdown = assemble(lines);
  if (estimateTokens(markdown) > budget && lines.length) {
    // Nothing left to fold and still too long: keep the top of the list and say so.
    const room = Math.max(1, Math.floor(budget * CHARS_PER_TOKEN) - header.join("\n").length - footer.join("\n").length - 120);
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
      if (used + line.length + 1 > room) break;
      kept.push(line);
      used += line.length + 1;
    }
    kept.push(`- … ${lines.length - kept.length} more entries (list_files to browse the rest)`);
    markdown = assemble(kept);
  }
  return { markdown, listed, total, tokens: estimateTokens(markdown), digest: createHash("sha256").update(markdown).digest("hex").slice(0, 12) };
}

function headerLines(input: AgentIndexInput, listed: number, roots: Node[]): string[] {
  const folders = roots.filter((n) => n.entry.kind === "dir").length;
  const where = folders ? ` in ${folders} top-level folder${folders === 1 ? "" : "s"}` : "";
  const lines = [`Project Files — ${listed} file${listed === 1 ? "" : "s"}${where}. The project's documents and references; not the code repository.`];
  if (input.native && input.root) {
    lines.push(`On this machine: ${input.root} — you may read and search it with your own tools. Skip .tomrade-files/ and .git/ there; they are Tomrade's bookkeeping, not documents.`);
  }
  return lines;
}

function footerLines(input: AgentIndexInput, withheld: { person: boolean; attachments: boolean }): string[] {
  const lines: string[] = [];
  if (withheld.attachments) lines.push("Tickets' attachments/ folders are not shown; get_item lists the files a ticket's description links.");
  if (withheld.person) lines.push("Paths the person keeps out of this index are not shown. Any path you are given still reads and writes normally.");
  lines.push(
    input.native
      ? "read_file returns the version ids a delivery pins; save through write_file (or add_delivery_resource for an existing version) when the result is a ticket's artifact."
      : "search_files finds text across these files, read_file reads one (range for a long one), list_files expands a folder."
  );
  return lines;
}
