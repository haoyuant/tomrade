import type { Context } from "cordis";
import { z } from "zod";
import { ITEM_STATUSES, createItemSchema, filterClauseSchema, itemStatusSchema, listItemsFilterSchema, patchSchema, sortKeySchema, NotFoundError, type Item, type Patch } from "@tomrade/domain";
import { defineTool, requireProjectId } from "@tomrade/tools";
import type {} from "@tomrade/boards";
import { addResourceSchema, submitDeliverySchema } from "@tomrade/domain";

const withVersion = z.object({ projectId: z.string().optional(), id: z.string(), baseVersion: z.number().optional() });

type Simple = z.output<typeof listItemsFilterSchema>;
const readInput = listItemsFilterSchema.extend({ search: z.string().optional(), filter: z.array(filterClauseSchema).optional(), sort: z.array(sortKeySchema).optional() });
type ReadInput = z.output<typeof readInput>;

/** The legacy scalar filters, applied after a clause query so both styles compose. */
function matchesSimple(item: Item, f: Simple): boolean {
  if (f.boardId !== undefined && item.boardId !== f.boardId) return false;
  if (f.status !== undefined && item.status !== f.status) return false;
  if (f.kind !== undefined && item.kind !== f.kind) return false;
  if (f.workType !== undefined && item.workType !== f.workType) return false;
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
  ctx.tools.register(defineTool({
    name: "add_delivery_resource", title: "Link a file version",
    description: "Link an existing immutable Files plugin version as input material or an output artifact. Does not store file bytes or accept local paths. Fails when the Files plugin or version is unavailable.",
    input: z.object({ projectId: z.string().optional(), id: z.string(), resource: addResourceSchema }),
    execute: ({ projectId, id, resource }, inv) => ctx.items.addResource(requireProjectId("add_delivery_resource", projectId, inv), id, resource, inv.by)
  }));
  ctx.tools.register(defineTool({
    name: "submit_delivery", title: "Submit results for review",
    description: "Submit a completion report and selected output artifact IDs for human review. A successful run does not complete the ticket. Human activities can submit a report without files.",
    input: z.object({ projectId: z.string().optional(), id: z.string(), submission: submitDeliverySchema }),
    execute: ({ projectId, id, submission }, inv) => ctx.items.submitDelivery(requireProjectId("submit_delivery", projectId, inv), id, submission, inv.by)
  }));
  const versionOf = (projectId: string, id: string, asserted?: number) => {
    if (asserted !== undefined) return asserted;
    const existing = ctx.items.get(projectId, id);
    if (!existing) throw new NotFoundError(id);
    return existing.version;
  };

  const find = (tool: string, { search, filter: clauses, sort, ...filter }: ReadInput, inv: { projectId?: string }): { projectId: string; items: Item[] } => {
    const projectId = requireProjectId(tool, filter.projectId, inv);
    // A boardId that names no real workstream would otherwise match zero rows
    // silently — indistinguishable from a project that genuinely has none.
    if (filter.boardId !== undefined && !ctx.boards.list(projectId).some((b) => b.id === filter.boardId)) throw new NotFoundError(filter.boardId);
    const rows =
      clauses?.length || sort?.length
        ? ctx.items.query({ projectId, filter: clauses, sortBy: sort }).filter((i) => matchesSimple(i, filter))
        : ctx.items.list({ ...filter, projectId });
    const q = search?.trim().toLowerCase();
    return { projectId, items: q ? rows.filter((i) => i.title.toLowerCase().includes(q) || (i.body ?? "").toLowerCase().includes(q)) : rows };
  };

  ctx.tools.register(
    defineTool({
      name: "list_items",
      title: "List backlog items",
      description:
        "List backlog item details. Use count_items instead for totals, counts, or breakdowns; do not fetch rows merely to count them. Supports simple filters (board, status, kind, priority, label, parent), search over title/body, filter clauses, and sort keys.",
      input: readInput,
      execute: (args, inv) => find("list_items", args, inv).items
    })
  );

  ctx.tools.register(
    defineTool({
      name: "count_items",
      title: "Count backlog items",
      description:
        "Answer backlog quantity questions in one call without listing rows. Returns the exact matched count plus breakdowns by kind, status, and workstream. In Tomrade, `ticket` and `epic` are distinct item kinds; for 'how many tickets', pass kind: ticket.",
      input: readInput,
      execute(args, inv) {
        const { projectId, items } = find("count_items", args, inv);
        const boards = new Map(ctx.boards.list(projectId).map((board) => [board.id, board.name]));
        const byKind = { ticket: 0, epic: 0 };
        const byStatus = Object.fromEntries(ITEM_STATUSES.map((status) => [status, 0])) as Record<(typeof ITEM_STATUSES)[number], number>;
        const byWorkstream: Record<string, number> = {};
        for (const item of items) {
          byKind[item.kind] += 1;
          byStatus[item.status] += 1;
          const board = boards.get(item.boardId) ?? item.boardId;
          byWorkstream[board] = (byWorkstream[board] ?? 0) + 1;
        }
        return { count: items.length, byKind, byStatus, byWorkstream };
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
      async execute(args, inv) {
        const projectId = requireProjectId("create_item", args.projectId, inv);
        // Agent-created tickets should receive the same recommendation as tickets
        // created through the UI. Keep this optional and duck-typed here so the
        // items package does not depend on the agent package (MCP/tool-only hosts
        // simply retain the explicit/default values).
        let playbookId = args.playbookId;
        let workType = args.workType;
        if (playbookId === undefined && inv.by.startsWith("ai:")) {
          const agent = ctx.get("agent") as { recommendPlaybook?: (projectId: string, input: { title: string; body?: string | null; workType?: "coding" | "general" }) => Promise<{ playbookId: string | null; workType: "coding" | "general" }> } | undefined;
          if (agent?.recommendPlaybook) {
            try {
              const recommendation = await agent.recommendPlaybook(projectId, { title: args.title, body: args.body ?? null, workType });
              playbookId = recommendation.playbookId;
              if (workType === undefined) workType = recommendation.workType;
            } catch {
              // Recommendation is advisory; ticket creation must still succeed.
            }
          }
        }
        return ctx.items.create({ ...args, playbookId, workType, projectId, boardId: args.boardId ?? ctx.boards.defaultFor(projectId).id, by: inv.by });
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
