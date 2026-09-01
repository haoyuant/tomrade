import type { Context } from "cordis";
import { z } from "zod";
import type { Board, BoardPatch, CreateBoardInput, CreatedBoard, View, ViewPatch } from "@tomrade/domain";
import { defineTool } from "@tomrade/tools";
import type {} from "@tomrade/ipc";

declare module "@tomrade/ipc" {
  interface Channels {
    "boards.list": (projectId: string) => Board[];
    "boards.create": (input: CreateBoardInput) => CreatedBoard;
    "boards.update": (id: string, patch: BoardPatch) => Board;
    "boards.remove": (id: string) => void;
    "boards.moveItems": (from: string, to: string, itemIds: string[]) => number;
    "views.list": (projectId: string) => View[];
    "views.update": (id: string, patch: ViewPatch) => View;
    "views.ranks": (viewId: string) => Record<string, number>;
    "views.setRank": (viewId: string, itemId: string, rank: number) => void;
  }
}

/** Views stay invisible to agents: a tool scopes a query to a workstream, never to a slice of one. */
export function registerTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: "list_boards",
      title: "List boards",
      description: "List the boards (workstreams) in a project. Every issue belongs to exactly one board; boards flagged `across` own nothing and borrow every issue.",
      input: z.object({ projectId: z.string().optional() }),
      execute: ({ projectId }, inv) => ctx.boards.list(projectId ?? inv.projectId ?? "default")
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
  ctx.ipc.handle("views.update", (id, patch) => ctx.views.update(id, patch));
  ctx.ipc.handle("views.ranks", (viewId) => ctx.views.ranks(viewId));
  ctx.ipc.handle("views.setRank", (viewId, itemId, rank) => ctx.views.setRank(viewId, itemId, rank));
}
