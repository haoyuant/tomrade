import type { Context } from "cordis";
import { z } from "zod";
import { isMachinePath, type Board, type BoardPatch, type CreateBoardInput, type CreateViewInput, type View, type ViewPatch } from "@tomradex/domain";
import { defineTool, requireProjectId } from "@tomradex/tools";
import type {} from "@tomradex/ipc";
import { itemsOf } from "./items-like.js";

declare module "@tomradex/ipc" {
  interface Channels {
    "boards.list": (projectId: string) => Board[];
    "boards.create": (input: CreateBoardInput) => Board;
    "boards.update": (projectId: string, id: string, patch: BoardPatch) => Board;
    "boards.remove": (projectId: string, id: string) => void;
    "boards.moveItems": (projectId: string, from: string, to: string, itemIds: string[]) => number;
    "views.list": (projectId: string) => View[];
    "views.create": (input: CreateViewInput) => View;
    "views.update": (projectId: string, id: string, patch: ViewPatch) => View;
    "views.remove": (projectId: string, id: string) => void;
    "views.ranks": (projectId: string, viewId: string) => Record<string, number>;
    "views.setRank": (projectId: string, viewId: string, itemId: string, rank: number) => void;
    "views.setRanks": (projectId: string, viewId: string, ranks: Record<string, number>) => void;
  }
}

const glyph = z.string().optional();

/** An agent that passes the checkout's own path is told what the field is, instead of a folder nothing can run in. */
function relativeRepoPath(repoPath: string | undefined): string | undefined {
  if (repoPath !== undefined && isMachinePath(repoPath)) {
    throw new Error(`repoPath is the folder inside the repository, relative to its root (for example apps/web, or empty for the root) — not a path on this machine such as ${repoPath.trim()}`);
  }
  return repoPath;
}

/** Views stay invisible to agents: a tool queries fields, never a saved way of looking at them. Workstreams are a field's options, so they are fully editable. */
export function registerTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: "list_workstreams",
      title: "List workstreams",
      description:
        "List the workstreams in a project — the options of the built-in Workstream field. Every issue belongs to exactly one; `create_item.boardId` and `update_item.patch.boardId` set it.",
      input: z.object({ projectId: z.string().optional() }),
      execute: ({ projectId }, inv) => ctx.boards.list(requireProjectId("list_workstreams", projectId, inv))
    })
  );

  ctx.tools.register(
    defineTool({
      name: "create_workstream",
      title: "Create a workstream",
      description: "Add a workstream to a project. `repoId` (from list_repos) names the code repository it stands for, if any; `repoPath` is the folder inside that repository, relative to its root (`apps/web`; empty or omitted for the root) — never a path on this machine. Logged and undoable.",
      input: z.object({ projectId: z.string().optional(), name: z.string().min(1), icon: glyph, note: z.string().nullable().optional(), repoId: z.string().nullable().optional(), repoPath: z.string().optional() }),
      execute: ({ projectId, ...rest }, inv) => ctx.boards.create({ ...rest, repoPath: relativeRepoPath(rest.repoPath), projectId: requireProjectId("create_workstream", projectId, inv) }, inv.by)
    })
  );

  ctx.tools.register(
    defineTool({
      name: "update_workstream",
      title: "Rename or describe a workstream",
      description: "Change a workstream's name, icon, note, or the repository it stands for (repoId from list_repos; repoPath the folder inside it, relative to the repository root, empty for the root). Logged and undoable.",
      input: z.object({
        projectId: z.string().optional(),
        id: z.string(),
        patch: z.object({ name: z.string().min(1).optional(), icon: glyph, note: z.string().nullable().optional(), repoId: z.string().nullable().optional(), repoPath: z.string().optional() })
      }),
      execute: ({ projectId, id, patch }, inv) => ctx.boards.update(requireProjectId("update_workstream", projectId, inv), id, { ...patch, ...(patch.repoPath !== undefined ? { repoPath: relativeRepoPath(patch.repoPath) } : {}) }, inv.by)
    })
  );

  ctx.tools.register(
    defineTool({
      name: "remove_workstream",
      title: "Remove a workstream",
      description:
        "Remove a workstream. One that still holds issues is refused unless `moveTo` names the workstream they go to first; the project's last workstream never goes.",
      input: z.object({ projectId: z.string().optional(), id: z.string(), moveTo: z.string().optional() }),
      execute({ projectId, id, moveTo }, inv) {
        const scope = requireProjectId("remove_workstream", projectId, inv);
        let moved = 0;
        if (moveTo) {
          const ids = itemsOf(ctx).list({ projectId: scope, boardId: id }).map((i) => i.id);
          moved = ctx.boards.moveItems(scope, id, moveTo, ids, inv.by);
        }
        ctx.boards.remove(scope, id, inv.by);
        return { removed: id, moved };
      }
    })
  );
}

export function registerChannels(ctx: Context): void {
  ctx.ipc.handle("boards.list", (projectId) => ctx.boards.list(projectId));
  ctx.ipc.handle("boards.create", (input) => ctx.boards.create(input));
  ctx.ipc.handle("boards.update", (projectId, id, patch) => ctx.boards.update(projectId, id, patch));
  ctx.ipc.handle("boards.remove", (projectId, id) => ctx.boards.remove(projectId, id));
  ctx.ipc.handle("boards.moveItems", (projectId, from, to, itemIds) => ctx.boards.moveItems(projectId, from, to, itemIds));
  ctx.ipc.handle("views.list", (projectId) => ctx.views.listForProject(projectId));
  ctx.ipc.handle("views.create", (input) => ctx.views.create(input));
  ctx.ipc.handle("views.update", (projectId, id, patch) => ctx.views.update(projectId, id, patch));
  ctx.ipc.handle("views.remove", (projectId, id) => ctx.views.remove(projectId, id));
  ctx.ipc.handle("views.ranks", (projectId, viewId) => ctx.views.ranks(projectId, viewId));
  ctx.ipc.handle("views.setRank", (projectId, viewId, itemId, rank) => ctx.views.setRank(projectId, viewId, itemId, rank));
  ctx.ipc.handle("views.setRanks", (projectId, viewId, ranks) => ctx.views.setRanks(projectId, viewId, ranks));
}
