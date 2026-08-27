import type { Context } from "cordis";
import { z } from "zod";
import { createItemSchema, itemStatusSchema, listItemsFilterSchema, patchSchema, NotFoundError, type Patch } from "@tomrade/domain";
import { defineTool } from "@tomrade/tools";
import type {} from "@tomrade/boards";

const withVersion = z.object({ id: z.string(), baseVersion: z.number().optional() });

/**
 * The backlog tools every surface sees. `baseVersion` is optional on writes:
 * when omitted the tool asserts the version it reads, so a write is never
 * unconditional even when the caller could not read first.
 */
export function registerTools(ctx: Context): void {
  const versionOf = (id: string, asserted?: number) => {
    if (asserted !== undefined) return asserted;
    const existing = ctx.items.get(id);
    if (!existing) throw new NotFoundError(id);
    return existing.version;
  };

  ctx.tools.register(
    defineTool({
      name: "list_items",
      title: "List backlog items",
      description: "List backlog items, optionally filtered by project, board, status, kind, priority, label, parent or a search string over title and body.",
      input: listItemsFilterSchema.extend({ search: z.string().optional() }),
      execute({ search, ...filter }, inv) {
        const items = ctx.items.list({ ...filter, projectId: filter.projectId ?? inv.projectId });
        const q = search?.trim().toLowerCase();
        return q ? items.filter((i) => i.title.toLowerCase().includes(q) || (i.body ?? "").toLowerCase().includes(q)) : items;
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "get_item",
      title: "Get one item",
      description: "Fetch a single backlog item by id.",
      input: z.object({ id: z.string() }),
      execute: ({ id }) => ctx.items.get(id)
    })
  );

  ctx.tools.register(
    defineTool({
      name: "create_item",
      title: "Create item",
      description: "Create a ticket or epic. Recorded in the oplog with the caller as author; lands on the project's first board unless boardId is given.",
      input: createItemSchema,
      execute(args, inv) {
        const projectId = args.projectId ?? inv.projectId ?? "default";
        return ctx.items.create({ ...args, projectId, boardId: args.boardId ?? ctx.boards.defaultFor(projectId).id, by: inv.by });
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "update_item",
      title: "Update item (optimistic lock)",
      description: "Change fields on an item. Pass the baseVersion you read; a stale version is refused (ConflictError), and human-locked fields refuse AI writes (HumanLockedError).",
      input: withVersion.extend({ patch: patchSchema }),
      execute: ({ id, patch, baseVersion }, inv) => ctx.items.update(id, patch as Patch, inv.by, { baseVersion: versionOf(id, baseVersion) })
    })
  );

  ctx.tools.register(
    defineTool({
      name: "change_status",
      title: "Change item status",
      description: "Move an item through the workflow (backlog → todo → doing → verifying → done/cancelled).",
      input: withVersion.extend({ status: itemStatusSchema }),
      execute: ({ id, status, baseVersion }, inv) => ctx.items.update(id, { status }, inv.by, { baseVersion: versionOf(id, baseVersion) })
    })
  );

  ctx.tools.register(
    defineTool({
      name: "delete_item",
      title: "Delete item",
      description: "Delete an item. Recorded in the oplog and reversible with undo.",
      input: z.object({ id: z.string() }),
      execute({ id }, inv) {
        ctx.items.delete(id, inv.by);
        return { deleted: id };
      }
    })
  );
}
