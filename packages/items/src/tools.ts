import type { Context } from "cordis";
import { z } from "zod";
import { ITEM_STATUSES, createItemSchema, filterClauseSchema, itemStatusSchema, listItemsFilterSchema, patchSchema, sortKeySchema, NotFoundError, type Item, type Patch } from "@tomradex/domain";
import { ToolInputError, defineTool, requireProjectId, type ToolInvocation } from "@tomradex/tools";
import type {} from "@tomradex/boards";
import { addResourceSchema, reviewDeliverySchema, submitDeliverySchema } from "@tomradex/domain";
import { ITEMS_WORDS } from "./words.js";

const itemId = z.string().describe("The item's id, or its key such as TOM-12");
const withVersion = z.object({ projectId: z.string().optional(), id: itemId, baseVersion: z.number().optional() });

type Simple = z.output<typeof listItemsFilterSchema>;
const readInput = listItemsFilterSchema.extend({ filter: z.array(filterClauseSchema).optional(), sort: z.array(sortKeySchema).optional() });
type ReadInput = z.output<typeof readInput>;
// Only the listing tool takes a limit; a count is always over every match.
const listInput = readInput.extend({ limit: z.number().int().positive().optional() });
/** A page an agent can read; anything larger is asked for. count_items answers the quantity questions. */
const DEFAULT_LIST_LIMIT = 50;

/** How long an agent creating a ticket waits for the worker model's playbook pick before the keyword fallback answers. */
export const RECOMMEND_WITHIN_MS = 4_000;
/** How long create_item remembers a requestId, so a client retrying a call that seemed to hang gets the first item back. */
const REQUEST_ID_TTL_MS = 10 * 60_000;

/** An item as a listing shows it: less the project the caller named, the number its key repeats, and a lock that is not set. */
const listed = ({ projectId: _project, keyNum: _keyNum, humanLocked, ...row }: Item) => (humanLocked ? { ...row, humanLocked } : row);

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
  // Briefs and people name items by key, so every tool that takes an id takes a key too.
  const lookup = (projectId: string, id: string): Item | null => {
    const byId = ctx.items.get(projectId, id);
    if (byId) return byId;
    const byKey = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(id.trim()) ? ctx.items.getByKey(projectId, id.trim()) : null;
    return byKey && byKey.key.toUpperCase() === id.trim().toUpperCase() ? byKey : null;
  };
  const resolve = (projectId: string, id: string): string => {
    const item = lookup(projectId, id);
    if (!item) throw new NotFoundError(id);
    return item.id;
  };
  // A parent or blocked item named by key was stored as that string — a parent that is not there.
  const resolveRefs = <T extends { parentId?: string | null; blocks?: string[] }>(projectId: string, value: T): T => ({
    ...value,
    ...(value.parentId ? { parentId: resolve(projectId, value.parentId) } : {}),
    ...(value.blocks ? { blocks: value.blocks.map((id) => resolve(projectId, id)) } : {})
  });

  ctx.tools.register(defineTool({
    name: "add_delivery_resource", title: "Link a file version",
    description: "Link an existing immutable Files plugin version as input material or an output artifact. Does not store file bytes or accept local paths. Fails when the Files plugin or version is unavailable.",
    input: z.object({ projectId: z.string().optional(), id: itemId, resource: addResourceSchema }),
    execute: ({ projectId, id, resource }, inv) => {
      const scope = requireProjectId("add_delivery_resource", projectId, inv);
      return ctx.items.addResource(scope, resolve(scope, id), resource, inv.by);
    }
  }));
  ctx.tools.register(defineTool({
    name: "submit_delivery", title: "Submit results for review",
    description: "Submit a completion report and selected output artifact IDs for human review. A successful run does not complete the ticket. Human activities can submit a report without files.",
    input: z.object({ projectId: z.string().optional(), id: itemId, submission: submitDeliverySchema }),
    execute: ({ projectId, id, submission }, inv) => {
      const scope = requireProjectId("submit_delivery", projectId, inv);
      return ctx.items.submitDelivery(scope, resolve(scope, id), submission, inv.by);
    }
  }));
  ctx.tools.register(defineTool({
    name: "review_delivery", title: "Record the user's verdict on a delivery",
    description:
      "Record the verdict the USER gave on a ticket's latest submitted delivery: accepted finishes the ticket, changes-requested sends it back to Doing. Only on the user's explicit word in this conversation — never your own judgement, and never on a delivery you submitted or worked on yourself. Pass their words in userSaid; where Tomrade can ask them, it asks to confirm first. The verdict is recorded as theirs, noting that you relayed it.",
    input: z.object({
      projectId: z.string().optional(),
      id: itemId,
      decision: reviewDeliverySchema.shape.decision,
      comment: z.string().optional().describe("What the user said should change (changes-requested) or any note to keep with the verdict"),
      userSaid: z.string().trim().min(1).describe("The user's own words giving this verdict, quoted")
    }),
    async execute({ projectId, id, decision, comment, userSaid }, inv) {
      const scope = requireProjectId("review_delivery", projectId, inv);
      const item = lookup(scope, id);
      if (!item) throw new NotFoundError(id);
      const submission = item.evidence.submissions.at(-1);
      if (!submission) throw new Error(`${item.key} has no submitted delivery to review — submit_delivery comes first`);
      if (inv.run?.ledger.find((e) => e.ok && (e.tool === "submit_delivery" || e.tool === "link_code"))) throw new Error(`review_delivery: this run delivered work, so it cannot review a delivery — the user accepts ${item.key} in its delivery panel`);
      if (inv.ask) {
        const w = ITEMS_WORDS((ctx.get("settings") as { locale?: () => string } | undefined)?.locale?.());
        const yes = w(decision === "accepted" ? "reviewAccept" : "reviewSendBack");
        const question = w("reviewConfirm", { key: item.key, verdict: yes, userSaid });
        if ((await inv.ask(question, [yes, w("cancel")])) !== yes) return { recorded: false, note: "The user did not confirm; nothing was recorded." };
      }
      const relayed = `Relayed by ${inv.by}; the user said: “${userSaid}”`;
      return ctx.items.reviewDelivery(scope, item.id, { submissionId: submission.id, decision, comment: comment?.trim() ? `${comment.trim()}\n\n${relayed}` : relayed }, item.version);
    }
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
    if (filter.parentId) filter = { ...filter, parentId: resolve(projectId, filter.parentId) };
    const { limit, widen } = opts;
    if (!clauses?.length && !sort?.length) return { projectId, items: ctx.items.list({ ...filter, projectId, limit, widen }) };
    // The scalar filters run in JS after a clause query, so SQL may only cut when there are none.
    const { projectId: _p, search, ...scalars } = filter;
    const scalar = Object.values(scalars).some((v) => v !== undefined);
    const items = ctx.items.query({ projectId, filter: clauses, sortBy: sort, search, widen, limit: scalar ? undefined : limit }).filter((i) => matchesSimple(i, filter));
    return { projectId, items: limit !== undefined ? items.slice(0, limit) : items };
  };

  const requests = new Map<string, { title: string; item: Promise<Item>; at: number }>();
  const create = async (projectId: string, args: z.output<typeof createItemSchema>, inv: ToolInvocation): Promise<Item> => {
    // Agent-created tickets should receive the same recommendation as tickets
    // created through the UI. Keep this optional and duck-typed here so the
    // items package does not depend on the agent package (MCP/tool-only hosts
    // simply retain the explicit/default values).
    let playbookId = args.playbookId;
    let workType = args.workType;
    if (playbookId === undefined && inv.by.startsWith("ai:")) {
      const agent = ctx.get("agent") as { recommendPlaybook?: (projectId: string, input: { title: string; body?: string | null; workType?: "coding" | "general" }, opts?: { withinMs?: number; signal?: AbortSignal }) => Promise<{ playbookId: string | null; workType: "coding" | "general" }> } | undefined;
      if (agent?.recommendPlaybook) {
        try {
          // The agent is waiting on this call; past the budget the recommendation falls back to keywords.
          const recommendation = await agent.recommendPlaybook(projectId, { title: args.title, body: args.body ?? null, workType }, { withinMs: RECOMMEND_WITHIN_MS, signal: inv.signal });
          playbookId = recommendation.playbookId;
          if (workType === undefined) workType = recommendation.workType;
        } catch {
          // Recommendation is advisory; ticket creation must still succeed.
        }
      }
    }
    return ctx.items.create({ ...resolveRefs(projectId, args), playbookId, workType, projectId, boardId: args.boardId ?? ctx.boards.defaultFor(projectId).id, by: inv.by });
  };

  ctx.tools.register(
    defineTool({
      name: "list_items",
      title: "List backlog items",
      description:
        `List backlog items, at most \`limit\` rows (default ${DEFAULT_LIST_LIMIT}). To find items about a topic, search one or two distinctive words, then synonyms (goal/target, sign-in/login): every word must appear in the title or body, in any script; when no item has them all, items with some come back, best first; a "quoted phrase" matches as written. Filters (board, status, kind, priority, label, parent, filter clauses) narrow the set; sort only reorders it, so never repeat a search with another sort. Omit projectId for the current project. For totals use count_items, not rows.`,
      input: listInput,
      readOnly: true,
      execute: ({ limit = DEFAULT_LIST_LIMIT, ...args }, inv) => find("list_items", args, inv, { limit, widen: true }).items.map(listed)
    })
  );

  ctx.tools.register(
    defineTool({
      name: "count_items",
      title: "Count backlog items",
      description:
        "Answer how-many questions without listing rows: the exact count, with breakdowns by kind, status and workstream. Same filters as list_items; search here is strict (every word must appear). `ticket` and `epic` are separate kinds: for 'how many tickets', pass kind: ticket.",
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
      input: z.object({ projectId: z.string().optional(), id: itemId }),
      readOnly: true,
      async execute({ projectId, id }, inv) {
        const scope = requireProjectId("get_item", projectId, inv);
        const item = lookup(scope, id);
        const attachments = item ? await ctx.items.linkedFiles(scope, item.body) : null;
        return item && attachments ? { ...item, attachments } : item;
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "create_item",
      title: "Create item",
      description:
        "Create a ticket or epic, recorded with you as author, on the project's first board unless boardId is given. Omit playbookId and Tomrade picks one; pass null for none, or an id to set it. When you may retry, pass a requestId: a repeat returns the item the first call made instead of a second.",
      input: createItemSchema.extend({
        requestId: z.string().trim().min(1).max(200).optional().describe("Any unique string for this creation; reuse it when retrying the same call")
      }),
      async execute({ requestId, ...args }, inv) {
        const projectId = requireProjectId("create_item", args.projectId, inv);
        if (!requestId) return create(projectId, args, inv);
        const key = `${projectId}\u0000${requestId}`;
        const now = Date.now();
        for (const [k, entry] of requests) if (now - entry.at > REQUEST_ID_TTL_MS) requests.delete(k);
        const earlier = requests.get(key);
        if (earlier) {
          if (earlier.title !== args.title) throw new ToolInputError("create_item", [{ code: "custom", path: ["requestId"], message: `already used for another item ("${earlier.title}") — use a new requestId for a new item`, input: requestId } as unknown as z.core.$ZodIssue]);
          const first = await earlier.item;
          return ctx.items.get(projectId, first.id) ?? first;
        }
        const item = create(projectId, args, inv);
        requests.set(key, { title: args.title, item, at: now });
        item.catch(() => requests.delete(key));
        return item;
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
        const target = resolve(scope, id);
        if (patch.boardId !== undefined && !ctx.boards.list(scope).some((b) => b.id === patch.boardId)) throw new NotFoundError(patch.boardId);
        return ctx.items.update(scope, target, resolveRefs(scope, patch) as Patch, inv.by, { baseVersion: versionOf(scope, target, baseVersion) });
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
        const target = resolve(scope, id);
        return ctx.items.update(scope, target, { status }, inv.by, { baseVersion: versionOf(scope, target, baseVersion) });
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "delete_item",
      title: "Delete item",
      description: "Delete an item. Recorded in the oplog and reversible with undo.",
      input: z.object({ projectId: z.string().optional(), id: itemId }),
      execute({ projectId, id }, inv) {
        const scope = requireProjectId("delete_item", projectId, inv);
        const target = resolve(scope, id);
        ctx.items.delete(scope, target, inv.by);
        return { deleted: target };
      }
    })
  );
}
