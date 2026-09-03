import type { Context } from "cordis";
import type { CreateItemInput, Item, ListItemsFilter, Patch } from "@tomrade/domain";
import type {} from "@tomrade/ipc";
import type { ItemQuery } from "./service.js";

declare module "@tomrade/ipc" {
  interface Channels {
    "items.list": (filter?: ListItemsFilter) => Item[];
    "items.query": (query: ItemQuery) => Item[];
    "items.get": (id: string) => Item | null;
    "items.create": (input: Omit<CreateItemInput, "by">) => Item;
    "items.update": (id: string, patch: Patch, baseVersion: number) => Item;
    "items.delete": (id: string) => void;
    "items.purge": (id: string, baseVersion?: number) => void;
    "items.labels": (projectId: string) => string[];
  }
}

/** Every renderer write is a human write. */
export function registerChannels(ctx: Context): void {
  ctx.ipc.handle("items.list", (filter = {}) => ctx.items.list(filter));
  ctx.ipc.handle("items.query", (query) => ctx.items.query(query));
  ctx.ipc.handle("items.get", (id) => ctx.items.get(id));
  ctx.ipc.handle("items.create", (input) => ctx.items.create({ ...input, by: "human" }));
  ctx.ipc.handle("items.update", (id, patch, baseVersion) => ctx.items.update(id, patch, "human", { baseVersion }));
  ctx.ipc.handle("items.delete", (id) => ctx.items.delete(id, "human"));
  ctx.ipc.handle("items.purge", (id, baseVersion) => ctx.items.purge(id, "human", { baseVersion }));
  ctx.ipc.handle("items.labels", (projectId) => ctx.items.labelsFor(projectId));
}
