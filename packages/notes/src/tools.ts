import type { Context } from "cordis";
import { z } from "zod";
import { defineTool, requireProjectId } from "@tomradex/tools";
import type { Notes } from "./service.js";

const SEARCH_DEFAULT = 10;
const SEARCH_MAX = 50;

/**
 * Notes for an agent: a ranked search that finds words in any order across
 * titles, paths and text — where `search_files` finds exact lines — and the
 * link graph around one note. Both follow the agent index: an unlisted note is
 * left out of a search that names no folder, never refused when named.
 */
export function registerTools(ctx: Context, notes: Notes): void {
  ctx.tools.register(
    defineTool({
      name: "search_notes",
      title: "Search project notes",
      description:
        "Ranked full-text search over the project's notes and text files (the Files library): every word must appear, in any order, best matches first, titles weighing most. " +
        '"Quoted phrases" match as written, #tag keeps notes with that tag, path:folder narrows to a folder. ' +
        "Use it to find which notes are about something; use search_files for exact lines or regular expressions.",
      input: z.object({
        projectId: z.string().optional(),
        query: z.string().min(1),
        folder: z.string().optional().describe("Only this folder of the store"),
        limit: z.number().int().min(1).max(SEARCH_MAX).optional().describe(`Notes to return; ${SEARCH_DEFAULT} by default`)
      }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("search_notes", args.projectId, inv);
        const result = await notes.search(projectId, { query: args.query, limit: args.limit ?? SEARCH_DEFAULT, ...(args.folder ? { folder: args.folder } : { listedOnly: true }) });
        if (!result.hits.length) return `"${args.query}" — no notes match. Try fewer or other words.`;
        const out = [`"${args.query}" — ${result.total} note${result.total === 1 ? "" : "s"}${result.total > result.hits.length ? `, best ${result.hits.length} shown` : ""}`];
        for (const hit of result.hits) {
          out.push(`${hit.path}${hit.title ? ` — ${hit.title}` : ""}${hit.tags.length ? ` · ${hit.tags.map((t) => `#${t}`).join(" ")}` : ""}`);
          if (hit.snippet) out.push(`  ${hit.line ? `L${hit.line}: ` : ""}${hit.snippet}`);
        }
        return out.join("\n");
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "note_links",
      title: "Links around a note",
      description:
        "For one note of the Files library: the notes and files it links to (wiki links and markdown links, resolved to paths), the notes that link to it with the line each link sits on, and notes that mention its name without linking. " +
        "Use it to follow a topic across notes without reading each one.",
      input: z.object({
        projectId: z.string().optional(),
        path: z.string().describe("The note, relative to the store root, e.g. docs/plan.md")
      }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("note_links", args.projectId, inv);
        const p = args.path.replace(/^\/+/, "");
        const links = await notes.links(projectId, p, { listedOnly: true });
        const out = [p];
        out.push(links.outgoing.length ? `links to (${links.outgoing.length}):` : "links to nothing.");
        for (const l of links.outgoing) out.push(`  L${l.line}: ${l.embed ? "embeds " : ""}${l.target}${l.anchor ? `#${l.anchor}` : ""} → ${l.path ?? "(nothing by that name yet)"}`);
        out.push(links.backlinks.length ? `linked from (${links.backlinks.length}):` : "nothing links here.");
        for (const m of links.backlinks) out.push(`  ${m.path}:${m.line}: ${m.text}`);
        if (links.unlinked.length) {
          out.push(`mentioned without a link (${links.unlinked.length}):`);
          for (const m of links.unlinked) out.push(`  ${m.path}:${m.line}: ${m.text}`);
        }
        return out.join("\n");
      }
    })
  );
}
