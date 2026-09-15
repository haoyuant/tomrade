import type { Context } from "cordis";
import { z } from "zod";
import { defineTool, requireProjectId } from "@tomrade/tools";
import type { Files } from "./service.js";

/** The agent's hands on a project's files. Every save is a version; the pair it returns is what a ticket pins. */
export function registerTools(ctx: Context, files: Files): void {
  ctx.tools.register(
    defineTool({
      name: "list_files",
      title: "List project files",
      description: "List one folder of the project's Files store — the root when dir is omitted. Returns each entry's path, kind, size and, for files, the stable fileId.",
      input: z.object({
        projectId: z.string().optional(),
        dir: z.string().optional().describe("Folder path relative to the store root, e.g. docs/specs")
      }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("list_files", args.projectId, inv);
        const entries = await files.list(projectId, args.dir ?? "");
        return entries.map((e) => ({ path: e.path, kind: e.kind, size: e.size, fileId: e.fileId, modifiedAt: e.modifiedAt }));
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "read_file",
      title: "Read a project file",
      description: "Read a file from the project's Files store. Text comes back as text; other files report their type and size only.",
      input: z.object({
        projectId: z.string().optional(),
        path: z.string().describe("File path relative to the store root")
      }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("read_file", args.projectId, inv);
        const content = await files.read(projectId, args.path);
        if (!content) throw new Error(`No file at ${args.path}`);
        const base = { path: content.path, fileId: content.fileId, versionId: content.versionId, mime: content.mime, size: content.size };
        return content.encoding === "utf8" ? { ...base, text: content.body, truncated: content.truncated } : { ...base, binary: true };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "write_file",
      title: "Write a project file",
      description:
        "Save text into the project's Files store as a new version, creating folders as needed. Returns the file's stable fileId and the immutable versionId of what was saved — pass both to add_delivery_resource to make it a ticket's material or output artifact. Paths are relative and no segment may start with a dot.",
      input: z.object({
        projectId: z.string().optional(),
        path: z.string().describe("Where to save, e.g. docs/brief.md"),
        content: z.string(),
        message: z.string().optional().describe("What changed, shown in the file's history")
      }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("write_file", args.projectId, inv);
        const saved = await files.write(projectId, args.path, args.content, args.message ? { message: args.message } : {});
        return { path: saved.path, fileId: saved.fileId, versionId: saved.versionId, size: saved.size };
      }
    })
  );
}
