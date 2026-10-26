import type { Context } from "cordis";
import type { CreateItemInput, Item, ListItemsFilter, Patch } from "@tomradex/domain";
import type { z } from "zod";
import type { addResourceSchema, submitDeliverySchema, reviewDeliverySchema } from "@tomradex/domain";
import type { DeliveryView } from "@tomradex/db";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/fields";
import type { ItemCounts, ItemQuery } from "./service.js";
import { errorMessage } from "@tomradex/contracts";

declare module "@tomradex/ipc" {
  interface Channels {
    "items.deliveries": (projectId: string, id: string) => DeliveryView[];
    "items.addResource": (projectId: string, id: string, input: z.input<typeof addResourceSchema>) => Item;
    "items.submitDelivery": (projectId: string, id: string, input: z.input<typeof submitDeliverySchema>) => Item;
    "items.reviewDelivery": (projectId: string, id: string, input: z.input<typeof reviewDeliverySchema>, baseVersion: number) => Item;
    /** Settle delivery evidence a sync left inconsistent: accept the latest submission, or drop dangling references. */
    "items.settleEvidence": (projectId: string, id: string, action: "accept" | "tidy", baseVersion: number) => Item;
    "items.list": (filter?: ListItemsFilter) => Item[];
    "items.counts": (projectId: string) => ItemCounts;
    "items.query": (query: ItemQuery) => Item[];
    "items.get": (projectId: string, id: string) => Item | null;
    "items.create": (input: Omit<CreateItemInput, "by">) => Item;
    "items.update": (projectId: string, id: string, patch: Patch, baseVersion: number) => Item;
    "items.delete": (projectId: string, id: string) => void;
    "items.purge": (projectId: string, id: string, baseVersion?: number) => void;
    "items.labels": (projectId: string) => string[];
  }
  interface Broadcasts {
    /** A project's issues, workstreams or views were written — by anyone: an agent, MCP, an undo, this window. */
    "items.changed": (projectId: string, entities: string[]) => void;
  }
}

/**
 * What the renderer reads carries each derived field's value in `fields`, so
 * the board sorts and filters on it as the items service does. Only here: an
 * item handed back to a write, an undo or an export never holds them.
 */
function withDerived(ctx: Context, items: Item[]): Item[] {
  const fields = ctx.get("fields");
  if (!fields || !items.length || !fields.derivedSql().size) return items;
  const byProject = new Map<string, Map<string, Record<string, number>>>();
  return items.map((item) => {
    let values = byProject.get(item.projectId);
    if (!values) byProject.set(item.projectId, (values = fields.derivedValues(item.projectId)));
    const own = values.get(item.id);
    return own ? { ...item, fields: { ...item.fields, ...own } } : item;
  });
}

/** Every renderer write is a human write. */
export function registerChannels(ctx: Context): void {
  const one = (item: Item | null) => (item ? withDerived(ctx, [item])[0]! : item);
  ctx.ipc.handle("items.deliveries", (projectId, id) => ctx.items.deliveries.list(projectId, id));
  ctx.ipc.handle("items.addResource", (projectId, id, input) => ctx.items.addResource(projectId, id, input, "human"));
  ctx.ipc.handle("items.submitDelivery", (projectId, id, input) => ctx.items.submitDelivery(projectId, id, input, "human"));
  ctx.ipc.handle("items.reviewDelivery", (projectId, id, input, baseVersion) => {
    try {
      return ctx.items.reviewDelivery(projectId, id, input, baseVersion);
    } catch (error) {
      // The panel shows it too; the log is where a "nothing happened" report gets answered.
      ctx.logger.warn(`items: review of ${id} (${input.decision}) refused — ${errorMessage(error)}`);
      throw error;
    }
  });
  ctx.ipc.handle("items.settleEvidence", (projectId, id, action, baseVersion) => ctx.items.settleEvidence(projectId, id, action, baseVersion));
  ctx.ipc.handle("items.list", (filter = {}) => withDerived(ctx, ctx.items.list(filter)));
  ctx.ipc.handle("items.counts", (projectId) => ctx.items.counts(projectId));
  ctx.ipc.handle("items.query", (query) => withDerived(ctx, ctx.items.query(query)));
  ctx.ipc.handle("items.get", (projectId, id) => one(ctx.items.get(projectId, id)));
  ctx.ipc.handle("items.create", (input) => one(ctx.items.create({ ...input, by: "human" }))!);
  ctx.ipc.handle("items.update", (projectId, id, patch, baseVersion) => one(ctx.items.update(projectId, id, patch, "human", { baseVersion }))!);
  ctx.ipc.handle("items.delete", (projectId, id) => ctx.items.delete(projectId, id, "human"));
  ctx.ipc.handle("items.purge", (projectId, id, baseVersion) => ctx.items.purge(projectId, id, "human", { baseVersion }));
  ctx.ipc.handle("items.labels", (projectId) => ctx.items.labelsFor(projectId));

  // Every write reaches the window that shows it, whoever made it; a burst of them goes out as one.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const touched = new Map<string, Set<string>>();
  const announce = (projectId: string, entity: string) => {
    const set = touched.get(projectId) ?? new Set<string>();
    set.add(entity);
    touched.set(projectId, set);
    if (timers.has(projectId)) return;
    timers.set(
      projectId,
      setTimeout(() => {
        timers.delete(projectId);
        const entities = [...(touched.get(projectId) ?? [])];
        touched.delete(projectId);
        ctx.ipc.send("items.changed", projectId, entities);
      }, 100)
    );
  };
  ctx.on("write/committed", (intent) => announce(intent.projectId, intent.entity));
  // an undo can move any of the three
  ctx.on("oplog/reverted", (projectId) => (announce(projectId, "item"), announce(projectId, "board"), announce(projectId, "view")));
  ctx.effect(() => () => {
    for (const timer of timers.values()) clearTimeout(timer);
  }, "items.changed");
}
