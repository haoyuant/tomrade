import type { Context } from "cordis";
import { z } from "zod";
import { defineTool, requireProjectId } from "@tomrade/tools";
import { formatSize, shortDate } from "./agent-index.js";
import { policyAt } from "./git-sync.js";
import type { Files } from "./service.js";
import type { FileContent, FileEntry, FilesAgentPolicy } from "./types.js";

/** One line per file beats a JSON object per file: the model reads the same thing for a tenth of the context. */
const LIST_LIMIT = 200;
const SEARCH_MAX = 200;
const READ_DEFAULT = 48 * 1024;
const READ_CEILING = 256 * 1024;
const LIBRARY = "The project's Files library — its documents, notes and references, not the code repository.";

const listed = (entries: FileEntry[], policy: FilesAgentPolicy): FileEntry[] =>
  entries.filter((entry) => (entry.listing?.mode ?? policyAt(policy, entry.path, entry.kind === "dir").mode) === "listed");

const depthOf = (path: string, base: string): number => path.slice(base ? base.length + 1 : 0).split("/").length;

const globToRegExp = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");

const lineOf = (entry: FileEntry): string =>
  entry.kind === "dir" ? `${entry.path}/` : `${entry.path} — ${formatSize(entry.size)} · ${shortDate(entry.modifiedAt)}`;

/** The head of a read, so the model can pin a version or ask for the next slice without another call. */
function readHeader(content: FileContent, from: number, to: number, total: number): string {
  const where = from === 1 && to === total ? `${total} lines` : `lines ${from}–${to} of ${total}`;
  return `${content.path} — ${content.mime} · ${formatSize(content.size)} · ${where}` +
    `${content.fileId ? ` · fileId ${content.fileId}` : ""}${content.versionId ? ` · versionId ${content.versionId}` : ""}`;
}

function slice(content: FileContent, range: { start: number; lines: number } | undefined, maxBytes: number): string {
  if (content.encoding !== "utf8") return `${readHeader(content, 1, 0, 0)}\n(binary — not shown)`;
  const all = content.body.split("\n");
  const from = Math.max(1, range?.start ?? 1);
  const wanted = range ? all.slice(from - 1, from - 1 + Math.max(1, range.lines)) : all.slice(from - 1);
  let used = 0;
  const kept: string[] = [];
  for (const line of wanted) {
    if (used + line.length + 1 > maxBytes) break;
    kept.push(line);
    used += line.length + 1;
  }
  const to = from + kept.length - 1;
  const more = to < all.length ? `\n… cut off here; read again from line ${to + 1} for the rest.` : "";
  return `${readHeader(content, from, to, all.length)}\n${kept.join("\n")}${more}`;
}

/**
 * The agent's hands on a project's files. Every save is a version; the pair a
 * write returns is what a ticket pins. What the browsing tools volunteer
 * follows the project's agent index — a path the caller names is always read.
 */
export function registerTools(ctx: Context, files: Files): void {
  ctx.tools.register(
    defineTool({
      name: "list_files",
      title: "List project files",
      description:
        `${LIBRARY} Browse one folder, or the root when dir is omitted. Returns one line per entry: path, size and date. ` +
        "Use it to expand a folder the index only counted; to find text inside files, search instead.",
      input: z.object({
        projectId: z.string().optional(),
        dir: z.string().optional().describe("Folder path relative to the store root, e.g. docs/specs"),
        depth: z.number().int().min(1).max(4).optional().describe("How many levels below dir to include; 1 by default"),
        glob: z.string().optional().describe("Keep only files whose name matches, e.g. *.md")
      }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("list_files", args.projectId, inv);
        const base = args.dir ? args.dir.replace(/^\/+|\/+$/g, "") : "";
        const depth = args.depth ?? 1;
        const policy = await files.agentPolicy(projectId);
        const all = depth > 1 ? await files.tree(projectId) : await files.list(projectId, base);
        const scoped = depth > 1 ? all.filter((e) => (!base || e.path.startsWith(`${base}/`)) && depthOf(e.path, base) <= depth) : all;
        const match = args.glob ? globToRegExp(args.glob) : null;
        const rows = listed(scoped, policy).filter((e) => !match || e.kind === "dir" || match.test(e.name));
        if (!rows.length) return `${base || "(root)"} — nothing here.`;
        const head = `${base ? `${base}/` : "(root)"} — ${rows.length} entr${rows.length === 1 ? "y" : "ies"}${depth > 1 ? `, depth ${depth}` : ""}`;
        const shown = rows.slice(0, LIST_LIMIT).map(lineOf);
        if (rows.length > LIST_LIMIT) shown.push(`… ${rows.length - LIST_LIMIT} more; narrow with dir or glob.`);
        return [head, ...shown].join("\n");
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "search_files",
      title: "Search project files",
      description:
        `${LIBRARY} Find text across the files. Give several queries at once — synonyms, or different facts you need — and each is answered separately in one call. ` +
        "Results are path, line number and the matching line, which often answers the question without reading anything.",
      input: z.object({
        projectId: z.string().optional(),
        queries: z.array(z.string().min(1)).min(1).max(8).describe("Literal strings unless regex is true"),
        path: z.string().optional().describe("Limit to this folder or file"),
        glob: z.string().optional().describe("Limit to matching file names, e.g. *.md"),
        max: z.number().int().min(1).max(SEARCH_MAX).optional().describe("Hits per query; 40 by default"),
        regex: z.boolean().optional().describe("Treat each query as an extended regular expression"),
        caseSensitive: z.boolean().optional()
      }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("search_files", args.projectId, inv);
        const result = await files.search(projectId, {
          queries: args.queries,
          max: args.max ?? 40,
          ...(args.path ? { path: args.path } : {}),
          ...(args.glob ? { glob: args.glob } : {}),
          ...(args.regex === undefined ? {} : { regex: args.regex }),
          ...(args.caseSensitive === undefined ? {} : { caseSensitive: args.caseSensitive })
        });
        const out: string[] = [];
        for (const query of args.queries) {
          const hits = result.hits.filter((hit) => hit.query === query);
          if (!hits.length) {
            out.push(`"${query}" — no matches.`);
            continue;
          }
          const paths = new Set(hits.map((hit) => hit.path));
          out.push(`"${query}" — ${hits.length} hit${hits.length === 1 ? "" : "s"} in ${paths.size} file${paths.size === 1 ? "" : "s"}${result.truncated.includes(query) ? " (cut off at max)" : ""}`);
          for (const hit of hits) out.push(`${hit.path}:${hit.line}: ${hit.text}`);
        }
        return out.join("\n");
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "read_file",
      title: "Read project files",
      description:
        `${LIBRARY} Read one or several files in a single call, by path or by the fileId and versionId a ticket pinned. ` +
        "A long file comes back in slices: pass range to pick one, and the result says where the next begins.",
      input: z.object({
        projectId: z.string().optional(),
        paths: z.array(z.string()).min(1).max(10).optional().describe("File paths relative to the store root"),
        path: z.string().optional().describe("A single path, when that is all you need"),
        fileId: z.string().optional().describe("With versionId, reads exactly the version a ticket pinned"),
        versionId: z.string().optional(),
        range: z.object({ start: z.number().int().min(1), lines: z.number().int().min(1) }).optional().describe("A slice of one file, from line start"),
        maxBytes: z.number().int().min(1024).max(READ_CEILING).optional().describe("Cap per file; 48 KB by default")
      }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("read_file", args.projectId, inv);
        const cap = Math.min(args.maxBytes ?? READ_DEFAULT, READ_CEILING);
        if (args.fileId && args.versionId) {
          const version = await files.readVersion(projectId, { fileId: args.fileId, versionId: args.versionId });
          if (!version) throw new Error(`No version ${args.versionId} of file ${args.fileId}`);
          return slice(version, args.range, cap);
        }
        const paths = args.paths ?? (args.path ? [args.path] : []);
        if (!paths.length) throw new Error("Give paths, path, or a fileId with its versionId");
        if (args.range && paths.length > 1) throw new Error("range reads one file; give a single path with it");
        const out: string[] = [];
        for (const p of paths) {
          const content = await files.read(projectId, p);
          out.push(content ? slice(content, args.range, cap) : `${p} — no such file.`);
        }
        return out.join("\n\n");
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "write_file",
      title: "Write a project file",
      description:
        "Save text into the project's Files store as a new version, creating folders as needed. Returns the file's stable fileId and the immutable versionId of what was saved — pass both to add_delivery_resource to make it a ticket's material or output artifact. Give itemId for a ticket's own files: the path is then placed in the ticket's workstream folder, where its artifacts belong. Paths are relative and no segment may start with a dot.",
      input: z.object({
        projectId: z.string().optional(),
        itemId: z.string().optional().describe("The ticket the file is for; its workstream folder becomes the path's root"),
        path: z.string().describe("Where to save, e.g. docs/brief.md — or brief.md inside the ticket's workstream folder when itemId is given"),
        content: z.string(),
        message: z.string().optional().describe("What changed, shown in the file's history")
      }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("write_file", args.projectId, inv);
        const path = args.itemId ? files.pathFor(projectId, args.itemId, args.path) : args.path;
        const saved = await files.write(projectId, path, args.content, args.message ? { message: args.message } : {});
        return { path: saved.path, fileId: saved.fileId, versionId: saved.versionId, size: saved.size };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "manage_file",
      title: "Move, copy or delete a project file",
      description:
        "Rearrange the project's Files store: move renames when the last segment changes, copy makes a new file with a fresh id, delete removes one. " +
        "Every one is a version, and the person can undo it (⌘Z or the History window), so nothing already saved is lost. Move and copy refuse an existing destination.",
      input: z.object({
        projectId: z.string().optional(),
        action: z.enum(["move", "copy", "delete"]),
        path: z.string().describe("The file or folder to act on, relative to the store root"),
        to: z.string().optional().describe("Destination path, for move and copy")
      }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("manage_file", args.projectId, inv);
        if (args.action === "delete") {
          await files.remove(projectId, args.path);
          return `Deleted ${args.path}`;
        }
        if (!args.to) throw new Error(`${args.action} needs a destination in "to"`);
        if (args.action === "move") await files.move(projectId, args.path, args.to);
        else await files.copy(projectId, args.path, args.to);
        return `${args.action === "move" ? "Moved" : "Copied"} ${args.path} to ${args.to}`;
      }
    })
  );
}
