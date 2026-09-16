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
      name: "move_file",
      title: "Move or rename a project file",
      description: "Move a file or folder to a new path within the project's Files store, renaming it when the last segment changes. Fails if the destination already exists.",
      input: z.object({
        projectId: z.string().optional(),
        from: z.string().describe("Current path, relative to the store root"),
        to: z.string().describe("New path, relative to the store root")
      }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("move_file", args.projectId, inv);
        await files.move(projectId, args.from, args.to);
        return { from: args.from, to: args.to };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "copy_file",
      title: "Copy a project file",
      description: "Copy a file or folder to a new path within the project's Files store, as a version of its own with a fresh fileId. Fails if the destination already exists.",
      input: z.object({
        projectId: z.string().optional(),
        from: z.string().describe("Path to copy, relative to the store root"),
        to: z.string().describe("Destination path, relative to the store root")
      }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("copy_file", args.projectId, inv);
        await files.copy(projectId, args.from, args.to);
        return { from: args.from, to: args.to };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "delete_file",
      title: "Delete a project file",
      description: "Delete a file or folder from the project's Files store. Its versions stay in the history — deleting is not undone here, but nothing already saved is lost.",
      input: z.object({
        projectId: z.string().optional(),
        path: z.string().describe("Path to delete, relative to the store root")
      }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("delete_file", args.projectId, inv);
        await files.remove(projectId, args.path);
        return { path: args.path };
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
