import type { Context } from "cordis";
import type { CreateItemInput, Item, ListItemsFilter, Patch } from "@tomrade/domain";
import type { z } from "zod";
import type { addResourceSchema, submitDeliverySchema, reviewDeliverySchema } from "@tomrade/domain";
import type { DeliveryView } from "@tomrade/db";
import type {} from "@tomrade/ipc";
import type { ItemQuery } from "./service.js";

declare module "@tomrade/ipc" {
  interface Channels {
    "items.deliveries": (projectId: string, id: string) => DeliveryView[];
    "items.addResource": (projectId: string, id: string, input: z.input<typeof addResourceSchema>) => Item;
    "items.submitDelivery": (projectId: string, id: string, input: z.input<typeof submitDeliverySchema>) => Item;
    "items.reviewDelivery": (projectId: string, id: string, input: z.input<typeof reviewDeliverySchema>, baseVersion: number) => Item;
    "items.list": (filter?: ListItemsFilter) => Item[];
    "items.query": (query: ItemQuery) => Item[];
    "items.get": (projectId: string, id: string) => Item | null;
    "items.create": (input: Omit<CreateItemInput, "by">) => Item;
    "items.update": (projectId: string, id: string, patch: Patch, baseVersion: number) => Item;
    "items.delete": (projectId: string, id: string) => void;
    "items.purge": (projectId: string, id: string, baseVersion?: number) => void;
    "items.labels": (projectId: string) => string[];
  }
}

/** Every renderer write is a human write. */
export function registerChannels(ctx: Context): void {
  ctx.ipc.handle("items.deliveries", (projectId, id) => ctx.items.deliveries.list(projectId, id));
  ctx.ipc.handle("items.addResource", (projectId, id, input) => ctx.items.addResource(projectId, id, input, "human"));
  ctx.ipc.handle("items.submitDelivery", (projectId, id, input) => ctx.items.submitDelivery(projectId, id, input, "human"));
  ctx.ipc.handle("items.reviewDelivery", (projectId, id, input, baseVersion) => ctx.items.reviewDelivery(projectId, id, input, baseVersion));
  ctx.ipc.handle("items.list", (filter = {}) => ctx.items.list(filter));
  ctx.ipc.handle("items.query", (query) => ctx.items.query(query));
  ctx.ipc.handle("items.get", (projectId, id) => ctx.items.get(projectId, id));
  ctx.ipc.handle("items.create", (input) => ctx.items.create({ ...input, by: "human" }));
  ctx.ipc.handle("items.update", (projectId, id, patch, baseVersion) => ctx.items.update(projectId, id, patch, "human", { baseVersion }));
  ctx.ipc.handle("items.delete", (projectId, id) => ctx.items.delete(projectId, id, "human"));
  ctx.ipc.handle("items.purge", (projectId, id, baseVersion) => ctx.items.purge(projectId, id, "human", { baseVersion }));
  ctx.ipc.handle("items.labels", (projectId) => ctx.items.labelsFor(projectId));
}
