import type { Context } from "cordis";
import { z } from "zod";
import { createItemSchema, filterClauseSchema, itemStatusSchema, listItemsFilterSchema, patchSchema, sortKeySchema, NotFoundError, type Item, type Patch } from "@tomrade/domain";
import { defineTool, requireProjectId } from "@tomrade/tools";
import type {} from "@tomrade/boards";

const withVersion = z.object({ projectId: z.string().optional(), id: z.string(), baseVersion: z.number().optional() });

type Simple = z.output<typeof listItemsFilterSchema>;

/** The legacy scalar filters, applied after a clause query so both styles compose. */
function matchesSimple(item: Item, f: Simple): boolean {
  if (f.boardId !== undefined && item.boardId !== f.boardId) return false;
  if (f.status !== undefined && item.status !== f.status) return false;
  if (f.kind !== undefined && item.kind !== f.kind) return false;
  if (f.priority !== undefined && item.priority !== f.priority) return false;
  if (f.parentId === null ? item.parentId !== null : f.parentId !== undefined && item.parentId !== f.parentId) return false;
  if (f.label !== undefined && !item.labels.includes(f.label)) return false;
  return true;
}

/**
 * The backlog tools every surface sees. `baseVersion` is optional on writes:
 * when omitted the tool asserts the version it reads, so a write is never
 * unconditional even when the caller could not read first.
 */
export function registerTools(ctx: Context): void {
  const versionOf = (projectId: string, id: string, asserted?: number) => {
    if (asserted !== undefined) return asserted;
    const existing = ctx.items.get(projectId, id);
    if (!existing) throw new NotFoundError(id);
    return existing.version;
  };

  ctx.tools.register(
    defineTool({
      name: "list_items",
      title: "List backlog items",
      description:
        "List backlog items. Simple filters (board, status, kind, priority, label, parent) and a search string over title and body; or `filter` clauses over any field (see list_fields) with `sort` keys — a null value in a clause means empty.",
      input: listItemsFilterSchema.extend({ search: z.string().optional(), filter: z.array(filterClauseSchema).optional(), sort: z.array(sortKeySchema).optional() }),
      execute({ search, filter: clauses, sort, ...filter }, inv) {
        const projectId = requireProjectId("list_items", filter.projectId, inv);
        // A boardId that names no real workstream would otherwise match zero rows
        // silently — indistinguishable from a project that genuinely has none.
        if (filter.boardId !== undefined && !ctx.boards.list(projectId).some((b) => b.id === filter.boardId)) throw new NotFoundError(filter.boardId);
        const items =
          clauses?.length || sort?.length
            ? ctx.items.query({ projectId, filter: clauses, sortBy: sort }).filter((i) => matchesSimple(i, filter))
            : ctx.items.list({ ...filter, projectId });
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
      input: z.object({ projectId: z.string().optional(), id: z.string() }),
      execute: ({ projectId, id }, inv) => ctx.items.get(requireProjectId("get_item", projectId, inv), id)
    })
  );

  ctx.tools.register(
    defineTool({
      name: "create_item",
      title: "Create item",
      description: "Create a ticket or epic. Recorded in the oplog with the caller as author; lands on the project's first board unless boardId is given.",
      input: createItemSchema,
      execute(args, inv) {
        const projectId = requireProjectId("create_item", args.projectId, inv);
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
      execute({ projectId, id, patch, baseVersion }, inv) {
        const scope = requireProjectId("update_item", projectId, inv);
        return ctx.items.update(scope, id, patch as Patch, inv.by, { baseVersion: versionOf(scope, id, baseVersion) });
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "change_status",
      title: "Change item status",
      description: "Move an item through the workflow (backlog → todo → doing → verifying → done/cancelled).",
      input: withVersion.extend({ status: itemStatusSchema }),
      execute({ projectId, id, status, baseVersion }, inv) {
        const scope = requireProjectId("change_status", projectId, inv);
        return ctx.items.update(scope, id, { status }, inv.by, { baseVersion: versionOf(scope, id, baseVersion) });
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "delete_item",
      title: "Delete item",
      description: "Delete an item. Recorded in the oplog and reversible with undo.",
      input: z.object({ projectId: z.string().optional(), id: z.string() }),
      execute({ projectId, id }, inv) {
        ctx.items.delete(requireProjectId("delete_item", projectId, inv), id, inv.by);
        return { deleted: id };
      }
    })
  );
}
