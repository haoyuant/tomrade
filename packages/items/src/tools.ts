import type { Context } from "cordis";
import { z } from "zod";
import { ITEM_STATUSES, createItemSchema, filterClauseSchema, itemStatusSchema, listItemsFilterSchema, patchSchema, sortKeySchema, NotFoundError, type Item, type Patch } from "@tomradex/domain";
import { ToolInputError, defineTool, requireProjectId } from "@tomradex/tools";
import type {} from "@tomradex/boards";
import { addResourceSchema, submitDeliverySchema } from "@tomradex/domain";

const withVersion = z.object({ projectId: z.string().optional(), id: z.string(), baseVersion: z.number().optional() });

type Simple = z.output<typeof listItemsFilterSchema>;
const readInput = listItemsFilterSchema.extend({ filter: z.array(filterClauseSchema).optional(), sort: z.array(sortKeySchema).optional() });
type ReadInput = z.output<typeof readInput>;
// Only the listing tool takes a limit; a count is always over every match.
const listInput = readInput.extend({ limit: z.number().int().positive().optional() });
/** A page an agent can read; anything larger is asked for. count_items answers the quantity questions. */
const DEFAULT_LIST_LIMIT = 50;

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

  const find = (tool: string, { filter: clauses, sort, ...filter }: ReadInput, inv: { projectId?: string }, opts: { limit?: number; widen?: boolean } = {}): { projectId: string; items: Item[] } => {
    const projectId = requireProjectId(tool, filter.projectId, inv);
    // A projectId or boardId that names nothing real would otherwise match zero
    // rows silently — indistinguishable from a project that genuinely has none.
    if (!ctx.db.has(projectId)) {
      throw new ToolInputError(tool, [{ code: "custom", path: ["projectId"], message: `unknown project ${projectId} — omit projectId for the current project, or call list_projects`, input: projectId } as unknown as z.core.$ZodIssue]);
    }
    if (filter.boardId !== undefined && !ctx.boards.list(projectId).some((b) => b.id === filter.boardId)) throw new NotFoundError(filter.boardId);
    const { limit, widen } = opts;
    if (!clauses?.length && !sort?.length) return { projectId, items: ctx.items.list({ ...filter, projectId, limit, widen }) };
    // The scalar filters run in JS after a clause query, so SQL may only cut when there are none.
    const { projectId: _p, search, ...scalars } = filter;
    const scalar = Object.values(scalars).some((v) => v !== undefined);
    const items = ctx.items.query({ projectId, filter: clauses, sortBy: sort, search, widen, limit: scalar ? undefined : limit }).filter((i) => matchesSimple(i, filter));
    return { projectId, items: limit !== undefined ? items.slice(0, limit) : items };
  };

  ctx.tools.register(
    defineTool({
      name: "list_items",
      title: "List backlog items",
      description:
        `List backlog items, at most \`limit\` rows (default ${DEFAULT_LIST_LIMIT}; raise it for more). To find items about a topic, search with one or two distinctive words, then try synonyms (goal/target, sign-in/login): search matches title and body in any script, every word must appear, and when no item has them all the items with some of them come back instead, best matches first; a "quoted phrase" must appear contiguously. Filters (board, status, kind, priority, label, parent, filter clauses) narrow the set; sort keys only reorder it, so never repeat a search with another sort. Omit projectId to use the current project. Use count_items for totals and breakdowns; do not fetch rows merely to count them.`,
      input: listInput,
      readOnly: true,
      execute: ({ limit = DEFAULT_LIST_LIMIT, ...args }, inv) => find("list_items", args, inv, { limit, widen: true }).items
    })
  );

  ctx.tools.register(
    defineTool({
      name: "count_items",
      title: "Count backlog items",
      description:
        "Answer backlog quantity questions in one call without listing rows. Returns the exact matched count plus breakdowns by kind, status, and workstream. Takes the same filters as list_items; a search here is strict (every word must appear). In Tomrade, `ticket` and `epic` are distinct item kinds; for 'how many tickets', pass kind: ticket.",
      input: readInput,
      readOnly: true,
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
      description: "Fetch a single backlog item by id or key (TOM-12). The body is Markdown; files it links (tomrade-file://<fileId>) come back under attachments with their Files path.",
      input: z.object({ projectId: z.string().optional(), id: z.string().describe("The item's id, or its key such as TOM-12") }),
      readOnly: true,
      async execute({ projectId, id }, inv) {
        const scope = requireProjectId("get_item", projectId, inv);
        // briefs name tickets by key, so an agent reaches for that first
        const item = ctx.items.get(scope, id) ?? ctx.items.getByKey(scope, id);
        const attachments = item ? await ctx.items.linkedFiles(scope, item.body) : null;
        return item && attachments ? { ...item, attachments } : item;
      }
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
