import type { Context } from "cordis";
import { z } from "zod";
import type { Board, BoardPatch, CreateBoardInput, CreateViewInput, View, ViewPatch } from "@tomrade/domain";
import { defineTool } from "@tomrade/tools";
import type {} from "@tomrade/ipc";

declare module "@tomrade/ipc" {
  interface Channels {
    "boards.list": (projectId: string) => Board[];
    "boards.create": (input: CreateBoardInput) => Board;
    "boards.update": (id: string, patch: BoardPatch) => Board;
    "boards.remove": (id: string) => void;
    "boards.moveItems": (from: string, to: string, itemIds: string[]) => number;
    "views.list": (projectId: string) => View[];
    "views.create": (input: CreateViewInput) => View;
    "views.update": (id: string, patch: ViewPatch) => View;
    "views.remove": (id: string) => void;
    "views.ranks": (viewId: string) => Record<string, number>;
    "views.setRank": (viewId: string, itemId: string, rank: number) => void;
  }
}

const glyph = z.string().optional();

/** Views stay invisible to agents: a tool queries fields, never a saved way of looking at them. Workstreams are a field's options, so they are fully editable. */
export function registerTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: "list_workstreams",
      title: "List workstreams",
      description:
        "List the workstreams in a project — the options of the built-in Workstream field. Every issue belongs to exactly one; `create_item.boardId` and `update_item.patch.boardId` set it.",
      input: z.object({ projectId: z.string().optional() }),
      execute: ({ projectId }, inv) => ctx.boards.list(projectId ?? inv.projectId ?? "default")
    })
  );

  ctx.tools.register(
    defineTool({
      name: "create_workstream",
      title: "Create a workstream",
      description: "Add a workstream to a project. `subtitle` is the package or area it stands for (e.g. packages/ui). Logged and undoable.",
      input: z.object({ projectId: z.string().optional(), name: z.string().min(1), icon: glyph, subtitle: z.string().nullable().optional(), note: z.string().nullable().optional() }),
      execute: ({ projectId, ...rest }, inv) => ctx.boards.create({ ...rest, projectId: projectId ?? inv.projectId ?? "default" }, inv.by)
    })
  );

  ctx.tools.register(
    defineTool({
      name: "update_workstream",
      title: "Rename or describe a workstream",
      description: "Change a workstream's name, icon, subtitle or note. Logged and undoable.",
      input: z.object({ id: z.string(), patch: z.object({ name: z.string().min(1).optional(), icon: glyph, subtitle: z.string().nullable().optional(), note: z.string().nullable().optional() }) }),
      execute: ({ id, patch }, inv) => ctx.boards.update(id, patch, inv.by)
    })
  );

  ctx.tools.register(
    defineTool({
      name: "remove_workstream",
      title: "Remove a workstream",
      description:
        "Remove a workstream. One that still holds issues is refused unless `moveTo` names the workstream they go to first; the project's last workstream never goes.",
      input: z.object({ id: z.string(), moveTo: z.string().optional() }),
      execute({ id, moveTo }, inv) {
        let moved = 0;
        if (moveTo) {
          const ids = (ctx.db.prepare("SELECT id FROM items WHERE board_id = ?").all(id) as { id: string }[]).map((r) => r.id);
          moved = ctx.boards.moveItems(id, moveTo, ids, inv.by);
        }
        ctx.boards.remove(id, inv.by);
        return { removed: id, moved };
      }
    })
  );
}

export function registerChannels(ctx: Context): void {
  ctx.ipc.handle("boards.list", (projectId) => ctx.boards.list(projectId));
  ctx.ipc.handle("boards.create", (input) => ctx.boards.create(input));
  ctx.ipc.handle("boards.update", (id, patch) => ctx.boards.update(id, patch));
  ctx.ipc.handle("boards.remove", (id) => ctx.boards.remove(id));
  ctx.ipc.handle("boards.moveItems", (from, to, itemIds) => ctx.boards.moveItems(from, to, itemIds));
  ctx.ipc.handle("views.list", (projectId) => ctx.views.listForProject(projectId));
  ctx.ipc.handle("views.create", (input) => ctx.views.create(input));
  ctx.ipc.handle("views.update", (id, patch) => ctx.views.update(id, patch));
  ctx.ipc.handle("views.remove", (id) => ctx.views.remove(id));
  ctx.ipc.handle("views.ranks", (viewId) => ctx.views.ranks(viewId));
  ctx.ipc.handle("views.setRank", (viewId, itemId, rank) => ctx.views.setRank(viewId, itemId, rank));
}
