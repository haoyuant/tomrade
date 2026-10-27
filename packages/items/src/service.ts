import { randomUUID } from "node:crypto";
import { z } from "zod";
import { emptyEvidence, addResourceSchema, linkedFileIds, submitDeliverySchema, reviewDeliverySchema, type FileDescription, type FilesResolver, type TicketEvidence, type DeliveryResource } from "@tomradex/domain";
import { Context, Service } from "cordis";
import type { ProjectDb } from "@tomradex/db";
import { DeliveryStore } from "@tomradex/db";
import type { Oplog } from "@tomradex/oplog";
import { write } from "@tomradex/write";
import {
  CLOSED_STATUSES,
  DependencyCycleError,
  NotFoundError,
  type Author,
  type ClosedWindow,
  type CreateItemInput,
  type FieldValue,
  type FilterClause,
  type Item,
  type ItemKind,
  type ItemStatus,
  type ListItemsFilter,
  type Patch,
  type Priority,
  type SortKey
} from "@tomradex/domain";
import type { Fields, StoredValue } from "@tomradex/fields";
import { registerChannels } from "./channels.js";
import { compileQuery, compileSearch, type SearchMode } from "./query.js";
import { registerTools } from "./tools.js";
import { CLOSED_WINDOW_SECTION } from "./settings.js";
import type {} from "@tomradex/settings";
import type { ItemsReader, ItemsWriter } from "@tomradex/contracts";

declare module "cordis" {
  interface Context {
    items: Items;
  }
}

interface ItemRow {
  evidence_json: string;
  id: string;
  project_id: string;
  board_id: string;
  key_num: number;
  key_prefix: string;
  title: string;
  body: string | null;
  kind: ItemKind;
  work_type: Item["workType"];
  playbook_id: string | null;
  status: ItemStatus;
  priority: number;
  parent_id: string | null;
  rank: number;
  updated_at: number;
  updated_by: string;
  version: number;
  human_locked: number;
}

const SELECT_ITEM = "SELECT i.*, COALESCE(p.key_prefix, 'TOM') AS key_prefix FROM items i LEFT JOIN projects p ON p.id = i.project_id";

function baseItem(row: ItemRow): Omit<Item, "labels" | "blocks" | "blockedBy" | "fields"> {
  return {
    evidence: row.evidence_json ? JSON.parse(row.evidence_json) : emptyEvidence(),
    id: row.id,
    projectId: row.project_id,
    boardId: row.board_id,
    keyNum: row.key_num,
    key: `${row.key_prefix}-${row.key_num}`,
    title: row.title,
    body: row.body,
    kind: row.kind,
    workType: row.work_type,
    playbookId: row.playbook_id ?? null,
    status: row.status,
    priority: row.priority as Priority,
    parentId: row.parent_id,
    rank: row.rank,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by as Author,
    version: row.version,
    humanLocked: row.human_locked === 1
  };
}

function groupBy<T, V>(rows: T[], key: (r: T) => string, value: (r: T) => V): Map<string, V[]> {
  const out = new Map<string, V[]>();
  for (const r of rows) {
    const k = key(r);
    const bucket = out.get(k);
    if (bucket) bucket.push(value(r));
    else out.set(k, [value(r)]);
  }
  return out;
}

/** better-sqlite3 cannot bind booleans. */
function toSqlParams(item: Item): Record<string, unknown> {
  const { evidence, labels: _labels, blocks: _blocks, blockedBy: _blockedBy, fields: _fields, key: _key, ...rest } = item;
  return { ...rest, evidenceJson: JSON.stringify(evidence), humanLocked: item.humanLocked ? 1 : 0 };
}

/** The stored shape read back as a value: a number if one is there, the text otherwise. */
const valueOfRow = (r: { num: number | null; text: string | null }): FieldValue => (r.num !== null ? r.num : (r.text as string));

/** How many items a project has, how many are still open (neither done nor cancelled), and when one was last written. */
export interface ItemCounts {
  total: number;
  open: number;
  lastWrite: number | null;
}

export interface ItemQuery {
  projectId: string;
  filter?: FilterClause[];
  sortBy?: SortKey[];
  search?: string;
  /** At most this many rows, from the front of the order. */
  limit?: number;
  /** When no item has every search term, fall back to items with some of them. */
  widen?: boolean;
  /** Order by when each item reached its status, newest first, ahead of every sort key: a closed column's next page. */
  newestClosedFirst?: boolean;
  /** Leave epics out, as the board and the views' counts do. */
  ticketsOnly?: boolean;
}

/** One epic's tickets for its progress: counted where they all are, not in the renderer's window. */
export interface EpicProgress {
  done: number;
  total: number;
}

/**
 * When an item reached its status: its last write that set one (creation
 * included), else its last write at all — a row older than the oplog's
 * patches has nothing better. Matches idx_oplog_item_status.
 */
const STATUS_AT_SQL = "COALESCE((SELECT MAX(o.at) FROM oplog o WHERE o.entity_id = i.id AND o.entity = 'item' AND json_extract(o.patch_json, '$.status') IS NOT NULL), i.updated_at)";
const CLOSED_SQL = `(${CLOSED_STATUSES.map((s) => `'${s}'`).join(", ")})`;
const DAY_MS = 86_400_000;

export class Items extends Service implements ItemsReader, ItemsWriter {
  get deliveries(): DeliveryStore { return new DeliveryStore(this.ctx.db); }
  private filesResolver: FilesResolver | null = null;

  /** Register the Files plugin's version resolver. This service stores metadata only. */
  files(resolver: FilesResolver): () => void {
    if (this.filesResolver) throw new Error("A Files resolver is already registered");
    this.filesResolver = resolver;
    return () => { if (this.filesResolver === resolver) this.filesResolver = null; };
  }

  /** The files a body links, as Files sees them now; null when it links none, or nothing can say where they are. */
  async linkedFiles(projectId: string, body: string | null): Promise<FileDescription[] | null> {
    const ids = linkedFileIds(body);
    const resolver = this.filesResolver;
    if (!ids.length || !resolver) return null;
    try {
      return await resolver.describe(projectId, ids);
    } catch {
      return null;
    }
  }

  private openTicket(projectId: string, id: string): Item {
    const item = this.get(projectId, id);
    if (!item || item.kind !== "ticket") throw new Error(item ? `${item.key} is an epic — deliveries belong to tickets` : `No ticket ${id} in this project`);
    if (item.status === "done" || item.status === "cancelled") throw new Error("Reopen the ticket before changing its delivery");
    return item;
  }

  async addResource(projectId: string, id: string, input: z.input<typeof addResourceSchema>, by: Author): Promise<Item> {
    return this.addResources(projectId, id, [input], by);
  }

  /** Validate every file first, then add the resources in one versioned item write. */
  async addResources(projectId: string, id: string, inputs: z.input<typeof addResourceSchema>[], by: Author): Promise<Item> {
    const args = z.array(addResourceSchema).min(1).parse(inputs);
    const item = this.openTicket(projectId, id);
    const resolver = this.filesResolver;
    if (!resolver) throw new Error("Files plugin is unavailable; the file has not been delivered");
    const resolved = await Promise.all(args.map(resource => resolver.getVersion(projectId, resource.file)));
    if (resolved.some((reference, index) => !reference || reference.fileId !== args[index]!.file.fileId || reference.versionId !== args[index]!.file.versionId)) {
      throw new Error(`${args.length === 1 ? "The" : "A"} requested file version does not exist in this project's Files plugin`);
    }
    if (this.filesResolver !== resolver) throw new Error("Files plugin became unavailable; try again");
    return this.db(projectId).transaction(() => {
      const hasOutputs = args.some(resource => resource.role === "output");
      const delivery = hasOutputs ? this.deliveries.ensure(projectId, id) : null;
      const createdAt = Date.now();
      const resources: DeliveryResource[] = args.map(resource => ({
        id: randomUUID(),
        name: resource.name,
        role: resource.role,
        deliveryId: resource.role === "output" ? delivery!.id : null,
        file: resource.file,
        createdBy: by,
        createdAt
      }));
      return this.updateInternal(projectId, id, item.status === "verifying" && hasOutputs ? { status: "doing" } : {}, by,
        { baseVersion: item.version }, { ...item.evidence, resources: [...item.evidence.resources, ...resources] });
    });
  }

  submitDelivery(projectId: string, id: string, input: z.input<typeof submitDeliverySchema>, by: Author): Item {
    const args = submitDeliverySchema.parse(input);
    const item = this.openTicket(projectId, id);
    return this.db(projectId).transaction(() => {
      const delivery = this.deliveries.ensure(projectId, id);
      const artifactIds = [...new Set(args.artifactIds)];
      for (const artifactId of artifactIds) {
        if (!item.evidence.resources.some(r => r.id === artifactId && r.role === "output" && r.deliveryId === delivery.id)) throw new Error("A submission can only include this delivery's output artifacts");
      }
      const submission = { id: randomUUID(), deliveryId: delivery.id, report: args.report, artifactIds, submittedBy: by, submittedAt: Date.now() };
      return this.updateInternal(projectId, id, { status: "verifying" }, by, { baseVersion: item.version }, { ...item.evidence, submissions: [...item.evidence.submissions, submission] });
    });
  }

  /**
   * A person settling evidence a sync left disagreeing with itself. "accept" puts an accepted
   * review on the latest submission of the latest delivery (replacing a verdict on it, as a done
   * ticket cannot sit under "changes requested"); "tidy" drops what points at nothing: reviews of
   * a gone submission, all but the newest review of one, and file references that no longer resolve.
   */
  settleEvidence(projectId: string, id: string, action: "accept" | "tidy", baseVersion: number): Item {
    const item = this.get(projectId, id);
    if (!item || item.kind !== "ticket") throw new Error(item ? `${item.key} is an epic — deliveries belong to tickets` : `No ticket ${id} in this project`);
    const evidence = item.evidence;
    if (action === "accept") {
      const delivery = this.deliveries.current(projectId, id);
      const submission = evidence.submissions.filter(s => s.deliveryId === delivery?.id).at(-1);
      if (!submission) throw new Error("There is no submission to accept");
      const review = { id: randomUUID(), submissionId: submission.id, decision: "accepted" as const, comment: "", reviewedBy: "human" as const, reviewedAt: Date.now() };
      return this.updateInternal(projectId, id, {}, "human", { baseVersion }, { ...evidence, reviews: [...evidence.reviews.filter(r => r.submissionId !== submission.id), review] });
    }
    const known = new Set(evidence.submissions.map(s => s.id));
    const newest = new Map<string, number>();
    evidence.reviews.forEach((r, index) => { if (known.has(r.submissionId)) newest.set(r.submissionId, index); });
    const reviews = evidence.reviews.filter((r, index) => newest.get(r.submissionId) === index);
    const outputs = new Map(evidence.resources.filter(r => r.role === "output").map(r => [r.id, r]));
    const submissions = evidence.submissions.map(s => ({ ...s, artifactIds: s.artifactIds.filter(artifact => outputs.get(artifact)?.deliveryId === s.deliveryId) }));
    return this.updateInternal(projectId, id, {}, "human", { baseVersion }, { ...evidence, submissions, reviews });
  }

  /**
   * The verdict on the latest submission. A first verdict needs the ticket in review; a later one
   * replaces it, so "changes requested" is not final and a done ticket can still be taken back.
   */
  reviewDelivery(projectId: string, id: string, input: z.input<typeof reviewDeliverySchema>, baseVersion: number): Item {
    const args = reviewDeliverySchema.parse(input);
    const item = this.get(projectId, id);
    if (!item || item.kind !== "ticket") throw new Error(item ? `${item.key} is an epic — deliveries belong to tickets` : `No ticket ${id} in this project`);
    if (item.status === "cancelled") throw new Error("Reopen the ticket before changing its delivery");
    const delivery = this.deliveries.active(projectId, id) ?? this.deliveries.current(projectId, id);
    const submission = item.evidence.submissions.filter(s => s.deliveryId === delivery?.id).at(-1);
    const earlier = submission && item.evidence.reviews.find(r => r.submissionId === submission.id);
    const awaiting = item.status === "verifying";
    if (!submission || submission.id !== args.submissionId || (!earlier && !awaiting)) throw new Error("This submission is no longer awaiting review; refresh the ticket");
    const status = args.decision === "accepted" ? "done" : "doing";
    if (earlier?.decision === args.decision && item.status === status) throw new Error("This submission already has that verdict");
    const review = { id: randomUUID(), submissionId: submission.id, decision: args.decision, comment: args.comment, reviewedBy: "human" as const, reviewedAt: Date.now() };
    const reviews = [...item.evidence.reviews.filter(r => r.submissionId !== submission.id), review];
    return this.updateInternal(projectId, id, { status }, "human", { baseVersion }, { ...item.evidence, reviews });
  }
  static provide = "items";
  static inject = ["db", "oplog", "fields"];

  constructor(ctx: Context) {
    super(ctx, "items");
  }

  [Service.init]() {
    this.ctx.inject(["tools", "boards"], registerTools);
    this.ctx.inject(["ipc"], registerChannels);
    this.ctx.inject(["settings"], (ctx) => ctx.settings.register(CLOSED_WINDOW_SECTION));
  }

  /** Resolved per call: a rebuild swaps a project's file underneath, so nothing holds a handle. */
  private db(projectId: string): ProjectDb {
    if (!this.ctx.db.has(projectId)) throw new NotFoundError(projectId);
    return this.ctx.db.for(projectId);
  }

  private get oplog(): Oplog {
    return this.ctx.oplog;
  }

  private get fields(): Fields {
    return this.ctx.fields;
  }

  /** A project's ticket numbers as its card on the projects screen shows them, counted in SQL rather than read row by row. */
  counts(projectId: string): ItemCounts {
    const row = this.db(projectId)
      .prepare("SELECT COUNT(*) AS total, COALESCE(SUM(status NOT IN ('done', 'cancelled')), 0) AS open, MAX(updated_at) AS lastWrite FROM items")
      .get() as ItemCounts;
    return { total: row.total, open: row.open, lastWrite: row.lastWrite ?? null };
  }

  /** Without a project the list is the union over every open project, for surfaces that span them. */
  list(filter: ListItemsFilter = {}): Item[] {
    const where: string[] = [];
    const params: unknown[] = [];
    const eq = (column: string, value: unknown) => {
      where.push(`${column} = ?`);
      params.push(value);
    };
    if (filter.boardId !== undefined) eq("i.board_id", filter.boardId);
    if (filter.status !== undefined) eq("i.status", filter.status);
    if (filter.kind !== undefined) eq("i.kind", filter.kind);
    if (filter.workType !== undefined) eq("i.work_type", filter.workType);
    if (filter.priority !== undefined) eq("i.priority", filter.priority);
    if (filter.parentId === null) where.push("i.parent_id IS NULL");
    else if (filter.parentId !== undefined) eq("i.parent_id", filter.parentId);
    if (filter.label !== undefined) {
      where.push("i.id IN (SELECT il.item_id FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE l.name = ?)");
      params.push(filter.label);
    }
    const projectIds = filter.projectId !== undefined ? [filter.projectId] : this.ctx.db.openIds();
    const run = (mode: SearchMode) => {
      const search = compileSearch(filter.search, mode);
      const all = [...where, ...search.where];
      const bound = [...params, ...search.whereParams, ...search.orderParams, ...(filter.limit !== undefined ? [filter.limit] : [])];
      const sql = `${SELECT_ITEM} ${search.joins.join(" ")} ${all.length ? "WHERE " + all.join(" AND ") : ""} ORDER BY ${[...search.orderBy, "i.rank ASC", "i.updated_at DESC"].join(", ")}${filter.limit !== undefined ? " LIMIT ?" : ""}`;
      const rows = projectIds.flatMap((projectId) => {
        if (!this.ctx.db.has(projectId)) return [];
        const db = this.ctx.db.for(projectId);
        return this.hydrate(db, db.prepare(sql).all(...search.joinParams, ...bound) as ItemRow[]);
      });
      // The limit applied per project; across several it still caps the whole list.
      return { rows: filter.limit !== undefined ? rows.slice(0, filter.limit) : rows, terms: search.terms };
    };
    const strict = run("all");
    return !strict.rows.length && filter.widen && strict.terms >= 2 ? run("any").rows : strict.rows;
  }

  /**
   * A view's query, run in SQL: filter clauses over any field, sort keys over
   * any sortable field, empty values last, ties by relevance when there is a
   * search, then rank, then recency. What the renderer computes over its cached
   * list for the live board, this computes for tools and for projects too large
   * to hold in memory.
   */
  query(q: ItemQuery): Item[] {
    const db = this.db(q.projectId);
    const run = (mode: SearchMode) => {
      const c = this.compiled(q, mode);
      const orderBy = [...(q.newestClosedFirst ? [`${STATUS_AT_SQL} DESC`, "i.key_num DESC"] : []), ...c.orderBy, "i.rank ASC", "i.updated_at DESC"];
      const sql = `${SELECT_ITEM} ${c.from} ORDER BY ${orderBy.join(", ")}${q.limit !== undefined ? " LIMIT ?" : ""}`;
      return { rows: this.hydrate(db, db.prepare(sql).all(...c.params, ...c.orderParams, ...(q.limit !== undefined ? [q.limit] : [])) as ItemRow[]), terms: c.terms };
    };
    const strict = run("all");
    return !strict.rows.length && q.widen && strict.terms >= 2 ? run("any").rows : strict.rows;
  }

  /** How many items a query matches, counted in SQL: the true size of a column the renderer holds only part of. */
  count(q: ItemQuery): number {
    const c = this.compiled(q, "all");
    return (this.db(q.projectId).prepare(`SELECT COUNT(*) AS n FROM items i ${c.from}`).get(...c.params) as { n: number }).n;
  }

  /** A query's joins and WHERE clause after `FROM items i`, with their params in order. */
  private compiled(q: ItemQuery, mode: SearchMode) {
    const defs = new Map(this.fields.list(q.projectId).map((f) => [f.id, f]));
    const compiled = compileQuery({ filter: q.filter ?? [], sortBy: q.sortBy ?? [] }, defs, this.fields.derivedSql());
    const search = compileSearch(q.search, mode);
    const joins = [...compiled.joins, ...search.joins];
    const where = [...(q.ticketsOnly ? ["i.kind = 'ticket'"] : []), ...compiled.where, ...search.where];
    // The project id binds after the joins and before the clause params.
    const joinCount = compiled.joins.length;
    return {
      from: `${joins.join(" ")} WHERE i.project_id = ?${where.length ? " AND " + where.join(" AND ") : ""}`,
      params: [...compiled.params.slice(0, joinCount), ...search.joinParams, q.projectId, ...compiled.params.slice(joinCount), ...search.whereParams],
      orderBy: [...compiled.orderBy, ...search.orderBy],
      orderParams: search.orderParams,
      terms: search.terms
    };
  }

  /**
   * What the renderer holds of a project: every epic and every open ticket,
   * and of each closed status the newest tickets the window lets through, by
   * when they reached it. The rest is asked for when something shows it.
   */
  windowed(projectId: string, window: ClosedWindow): Item[] {
    const db = this.db(projectId);
    const since = window.days !== null ? Date.now() - window.days * DAY_MS : null;
    const closed = `SELECT id, status, key_num, ${STATUS_AT_SQL} AS at FROM items i WHERE i.kind = 'ticket' AND i.status IN ${CLOSED_SQL}`;
    const ranked = `SELECT id, at, ROW_NUMBER() OVER (PARTITION BY status ORDER BY at DESC, key_num DESC) AS n FROM (${closed})`;
    const sql = `${SELECT_ITEM} WHERE i.project_id = ? AND (i.kind = 'epic' OR i.status NOT IN ${CLOSED_SQL} OR i.id IN (SELECT id FROM (${ranked}) WHERE (? IS NULL OR n <= ?) AND (? IS NULL OR at >= ?))) ORDER BY i.rank ASC, i.updated_at DESC`;
    return this.hydrate(db, db.prepare(sql).all(projectId, window.limit, window.limit, since, since) as ItemRow[]);
  }

  /** Every epic's tickets, done and in all, keyed by epic id. Cancelled ones count for neither side. */
  epicProgress(projectId: string): Record<string, EpicProgress> {
    const rows = this.db(projectId)
      .prepare("SELECT parent_id AS id, COUNT(*) AS total, SUM(status = 'done') AS done FROM items WHERE kind = 'ticket' AND parent_id IS NOT NULL AND status != 'cancelled' GROUP BY parent_id")
      .all() as { id: string; total: number; done: number }[];
    return Object.fromEntries(rows.map((r) => [r.id, { done: r.done, total: r.total }]));
  }

  get(projectId: string, id: string): Item | null {
    if (!this.ctx.db.has(projectId)) return null;
    const db = this.ctx.db.for(projectId);
    const row = db.prepare(`${SELECT_ITEM} WHERE i.id = ?`).get(id) as ItemRow | undefined;
    return row ? this.hydrate(db, [row])[0] : null;
  }

  /** Resolve a human key ('TOM-142') within a project. */
  getByKey(projectId: string, key: string): Item | null {
    if (!this.ctx.db.has(projectId)) return null;
    const num = Number(key.split("-").pop());
    if (!Number.isFinite(num)) return null;
    const db = this.ctx.db.for(projectId);
    const row = db.prepare(`${SELECT_ITEM} WHERE i.project_id = ? AND i.key_num = ?`).get(projectId, num) as ItemRow | undefined;
    return row ? this.hydrate(db, [row])[0] : null;
  }

  create(input: CreateItemInput): Item {
    const projectId = input.projectId;
    if (!projectId) throw new NotFoundError("(no projectId) — every item belongs to a project; call list_projects and pass one");
    const db = this.db(projectId);
    // The counter lives on the project so a deleted key is never handed out again; a counter left behind the items (a rebuilt cache, an import) never hands out a key in use.
    const proj = db
      .prepare("SELECT key_prefix, MAX(next_key_num, COALESCE((SELECT MAX(key_num) FROM items WHERE project_id = @projectId), 0) + 1) AS next_key_num FROM projects WHERE id = @projectId")
      .get({ projectId }) as { key_prefix: string; next_key_num: number } | undefined;
    if (!proj) throw new NotFoundError(projectId);
    const now = Date.now();
    const stored = this.fields.normalize(projectId, input.fields ?? {});
    const item: Item = {
      evidence: emptyEvidence(),
      id: randomUUID(),
      projectId,
      boardId: input.boardId,
      keyNum: proj.next_key_num,
      key: `${proj.key_prefix}-${proj.next_key_num}`,
      title: input.title,
      body: input.body ?? null,
      kind: input.kind ?? "ticket",
      workType: input.workType ?? this.defaultWorkType(db, input.boardId),
      playbookId: input.playbookId ?? null,
      status: input.status ?? "backlog",
      priority: input.priority ?? 2,
      parentId: input.parentId ?? null,
      rank: input.rank ?? 0,
      labels: input.labels ?? [],
      blocks: [],
      blockedBy: [],
      fields: mergeFields({}, input.fields ?? {}, stored),
      updatedAt: now,
      updatedBy: input.by,
      version: 1,
      humanLocked: false
    };
    return write(this.ctx, { projectId, entity: "item", op: "create", id: item.id, by: input.by, before: null, after: item }, () =>
      db.transaction(() => {
        db.prepare("UPDATE projects SET next_key_num = ? WHERE id = ?").run(item.keyNum + 1, projectId);
        db.prepare(
          `INSERT INTO items (id, project_id, board_id, key_num, title, body, kind, work_type, playbook_id, evidence_json, status, priority, parent_id, rank, updated_at, updated_by, version, human_locked)
           VALUES (@id, @projectId, @boardId, @keyNum, @title, @body, @kind, @workType, @playbookId, @evidenceJson, @status, @priority, @parentId, @rank, @updatedAt, @updatedBy, @version, @humanLocked)`
        ).run(toSqlParams(item));
        this.writeLabels(db, item.id, projectId, item.labels);
        this.writeValues(db, item.id, stored);
        if (item.workType === "general" && item.kind === "ticket" && !["backlog", "todo"].includes(item.status)) {
          const delivery = this.deliveries.ensure(projectId, item.id, now);
          if (item.status === "done" && input.by === "human") {
            const submissionId = randomUUID();
            item.evidence = {
              resources: [],
              submissions: [{ id: submissionId, deliveryId: delivery.id, report: "Created as complete by a human.", artifactIds: [], submittedBy: "human", submittedAt: now }],
              reviews: [{ id: randomUUID(), submissionId, decision: "accepted", comment: "", reviewedBy: "human", reviewedAt: now }]
            };
            db.prepare("UPDATE items SET evidence_json = ? WHERE id = ?").run(JSON.stringify(item.evidence), item.id);
          }
          if (item.status === "done" || item.status === "cancelled") this.deliveries.finish(projectId, item.id, item.status === "done" ? "completed" : "cancelled", now);
        }
        this.oplog.append(projectId, { entity: "item", op: "create", entityId: item.id, baseVersion: null, before: null, after: item, by: input.by, at: now });
        return item;
      })
    );
  }

  /** Coding needs somewhere for the code to go: a workstream without a repository holds general work. */
  private defaultWorkType(db: ProjectDb, boardId: string): Item["workType"] {
    const board = db.prepare("SELECT repo_id FROM boards WHERE id = ?").get(boardId) as { repo_id: string | null } | undefined;
    return board?.repo_id ? "coding" : "general";
  }

  /**
   * Omitting baseVersion is an unconditional write; supplying one asserts the
   * version the caller read, and the policy refuses a stale assertion whoever made it.
   */
  update(projectId: string, id: string, patch: Patch, by: Author, opts: { baseVersion?: number } = {}): Item {
    if ("evidence" in patch) throw new Error("Use delivery resource and review operations to change evidence");
    return this.updateInternal(projectId, id, patch, by, opts);
  }

  private updateInternal(projectId: string, id: string, patch: Patch, by: Author, opts: { baseVersion?: number } = {}, evidence?: TicketEvidence): Item {
    const db = this.db(projectId);
    const existing = this.get(projectId, id);
    if (!existing) throw new NotFoundError(id);
    if (patch.blocks) patch = { ...patch, blocks: this.checkBlocks(db, existing, patch.blocks) };
    // Validated before the write path sees it, so a bad value is refused as a bad value, not as a conflict.
    const stored = patch.fields ? this.fields.normalize(projectId, patch.fields) : null;
    const { fields: fieldsPatch, ...rest } = patch;
    const next: Item = { ...existing, ...rest, evidence: evidence ?? existing.evidence, fields: mergeFields(existing.fields, fieldsPatch ?? {}, stored ?? new Map()), updatedAt: Date.now(), updatedBy: by, version: existing.version + 1 };
    const active = this.deliveries.active(projectId, id);
    if (active && (next.workType !== existing.workType || next.kind !== existing.kind)) throw new Error("Finish or cancel the active delivery before changing its work type or kind");
    const hasOutputs = existing.evidence.resources.some(r => r.role === "output" && r.deliveryId === active?.id);
    // Work an agent submitted is accepted by a person. A delivery with nothing submitted may be closed on the person's
    // word through an agent; the agent plugin refuses that to an agent that ran the delivery itself.
    const submitted = existing.evidence.submissions.some(s => s.deliveryId === active?.id);
    const settledOn = active?.id ?? this.deliveries.current(projectId, id)?.id;
    const lastSubmission = existing.evidence.submissions.filter(s => s.deliveryId === settledOn).at(-1);
    const unaccepted = !!lastSubmission && !existing.evidence.reviews.some(r => r.submissionId === lastSubmission.id && r.decision === "accepted");
    // Finishing it would stand in for the person's review and leave the evidence disagreeing with the status.
    if (next.status === "done" && existing.status !== "done" && by.startsWith("ai:") && !evidence && unaccepted) {
      throw new Error(`${existing.key}'s latest delivery has not been accepted — the user accepts it in the delivery panel, or tells you to and you call review_delivery with their words`);
    }
    if (next.workType === "general" && next.status === "done" && existing.status !== "done" && by !== "human" && (hasOutputs || submitted)) throw new Error("General deliveries require human acceptance");
    if (next.status === "done" && existing.status !== "done" && hasOutputs && by !== "human") throw new Error("Artifact deliveries require human acceptance");
    // A person finishing a ticket over a delivery nobody accepted records that as their own word, so the
    // evidence never disagrees with the status (it used to, and a later sync flagged it).
    if (next.status === "done" && existing.status !== "done" && by === "human" && !evidence && (next.workType === "general" || hasOutputs || unaccepted)) {
      const deliveryId = active?.id ?? `${id}:delivery:${(this.deliveries.current(projectId, id)?.sequence ?? 0) + 1}`;
      const submitted = existing.evidence.submissions.filter(s => s.deliveryId === deliveryId).at(-1);
      const current = existing.status === "verifying" && submitted && !existing.evidence.reviews.some(r => r.submissionId === submitted.id) ? submitted : null;
      const submission = current ?? { id: randomUUID(), deliveryId, report: "Marked complete by a human.", artifactIds: existing.evidence.resources.filter(r => r.role === "output" && r.deliveryId === deliveryId).map(r => r.id), submittedBy: "human" as const, submittedAt: next.updatedAt };
      next.evidence = { ...existing.evidence,
        submissions: current ? existing.evidence.submissions : [...existing.evidence.submissions, submission],
        reviews: [...existing.evidence.reviews, { id: randomUUID(), submissionId: submission.id, decision: "accepted", comment: "", reviewedBy: "human", reviewedAt: next.updatedAt }] };
    }
    const beforeDeliveries = this.deliveries.list(projectId, id);
    return write(this.ctx, { projectId, entity: "item", op: "update", id, by, baseVersion: opts.baseVersion, before: existing, after: next, patch }, () =>
      db.transaction(() => {
        db.prepare(
          `UPDATE items SET board_id = @boardId, title = @title, body = @body, kind = @kind, work_type = @workType, playbook_id = @playbookId, evidence_json = @evidenceJson, status = @status,
             priority = @priority, parent_id = @parentId, rank = @rank, updated_at = @updatedAt,
             updated_by = @updatedBy, version = @version, human_locked = @humanLocked
           WHERE id = @id`
        ).run(toSqlParams(next));
        if (patch.labels) this.writeLabels(db, id, projectId, next.labels);
        if (patch.blocks) this.writeBlocks(db, id, next.blocks);
        if (stored) this.writeValues(db, id, stored);
        if ((next.workType === "general" || hasOutputs || existing.evidence.submissions.some(s => s.deliveryId === active?.id)) && next.kind === "ticket" && existing.status !== next.status) {
          if (next.status === "doing" || next.status === "verifying" || existing.status === "done" || existing.status === "cancelled") {
            this.deliveries.ensure(projectId, id, next.updatedAt);
          }
          if (next.status === "done" || next.status === "cancelled") {
            this.deliveries.ensure(projectId, id, next.updatedAt);
            this.deliveries.finish(projectId, id, next.status === "done" ? "completed" : "cancelled", next.updatedAt);
          }
        }
        this.oplog.append(projectId, { entity: "item", op: "update", entityId: id, baseVersion: existing.version,
          before: { ...existing, deliveries: beforeDeliveries }, after: { ...next, deliveries: this.deliveries.list(projectId, id) }, by, at: next.updatedAt });
        return next;
      })
    );
  }

  /** Reversible: the snapshot carries labels and relations in both directions. */
  delete(projectId: string, id: string, by: Author): void {
    const db = this.db(projectId);
    const existing = this.get(projectId, id);
    if (!existing) throw new NotFoundError(id);
    const snapshot = { ...existing, deliveries: this.deliveries.list(projectId, id) };
    write(this.ctx, { projectId, entity: "item", op: "delete", id, by, before: existing, after: null }, () =>
      db.transaction(() => {
        this.detach(db, id);
        db.prepare("DELETE FROM deliveries WHERE item_id = ?").run(id);
        db.prepare("DELETE FROM items WHERE id = ?").run(id);
        this.oplog.append(projectId, { entity: "item", op: "delete", entityId: id, baseVersion: existing.version, before: snapshot, after: null, by, at: Date.now() });
      })
    );
  }

  /**
   * Permanent. The item's own history goes with it, so no snapshot can put the
   * row back; the tombstone names what happened and nothing that could rebuild it.
   */
  purge(projectId: string, id: string, by: Author, opts: { baseVersion?: number } = {}): void {
    const db = this.db(projectId);
    const existing = this.get(projectId, id);
    if (!existing) throw new NotFoundError(id);
    write(this.ctx, { projectId, entity: "item", op: "purge", id, by, baseVersion: opts.baseVersion, before: existing, after: null }, () =>
      db.transaction(() => {
        const releasedChildren = (db.prepare("SELECT id FROM items WHERE parent_id = ?").all(id) as { id: string }[]).map((r) => r.id);
        this.detach(db, id);
        db.prepare("DELETE FROM deliveries WHERE item_id = ?").run(id);
        db.prepare("DELETE FROM items WHERE id = ?").run(id);
        this.oplog.erase(projectId, "item", id);
        this.oplog.append(projectId, {
          entity: "item",
          op: "purge",
          entityId: id,
          baseVersion: null,
          before: { key: existing.key, title: existing.title, projectId: existing.projectId, releasedChildren },
          after: null,
          by,
          at: Date.now()
        });
      })
    );
  }

  /** Bulk-move issues between workstreams, one logged update each, so every move is undoable and travels. */
  moveToBoard(projectId: string, itemIds: string[], toBoardId: string, by: Author = "human"): number {
    let moved = 0;
    for (const id of itemIds) {
      const existing = this.get(projectId, id);
      if (!existing || existing.boardId === toBoardId) continue;
      this.update(projectId, id, { boardId: toBoardId }, by);
      moved += 1;
    }
    return moved;
  }

  /**
   * "Blocked until done" only means something on a DAG, so a patch that would
   * close a loop is refused before the write path ever sees it. Returns the
   * normalized list: de-duplicated, self-edges dropped, every target a live
   * item of the same project.
   */
  private checkBlocks(db: ProjectDb, item: Item, raw: string[]): string[] {
    const targets = [...new Set(raw)].filter((t) => t !== item.id);
    if (targets.length) {
      const placeholders = targets.map(() => "?").join(",");
      const known = new Set((db.prepare(`SELECT id FROM items WHERE project_id = ? AND id IN (${placeholders})`).all(item.projectId, ...targets) as { id: string }[]).map((r) => r.id));
      for (const t of targets) if (!known.has(t)) throw new NotFoundError(t);
    }
    // The proposed graph: everyone else's edges as stored, this item's replaced.
    const edges = new Map<string, string[]>([[item.id, targets]]);
    const rel = db
      .prepare("SELECT r.from_item_id AS f, r.to_item_id AS t FROM item_relations r JOIN items i ON i.id = r.from_item_id WHERE r.kind = 'blocks' AND i.project_id = ? AND r.from_item_id != ?")
      .all(item.projectId, item.id) as { f: string; t: string }[];
    for (const { f, t } of rel) {
      const bucket = edges.get(f);
      if (bucket) bucket.push(t);
      else edges.set(f, [t]);
    }
    const keyOf = (id: string) => db.prepare("SELECT i.key_num, COALESCE(p.key_prefix, 'TOM') AS kp FROM items i LEFT JOIN projects p ON p.id = i.project_id WHERE i.id = ?").get(id) as { key_num: number; kp: string } | undefined;
    const label = (id: string) => {
      const row = keyOf(id);
      return row ? `${row.kp}-${row.key_num}` : id;
    };
    const seen = new Set<string>();
    const walk = (node: string, path: string[]): void => {
      for (const nxt of edges.get(node) ?? []) {
        if (nxt === item.id) throw new DependencyCycleError(item.id, [...path, nxt].map(label));
        if (seen.has(nxt)) continue;
        seen.add(nxt);
        walk(nxt, [...path, nxt]);
      }
    };
    walk(item.id, [item.id]);
    return targets;
  }

  /** Replace an item's outgoing edges to match the patched list. */
  private writeBlocks(db: ProjectDb, itemId: string, targets: string[]): void {
    db.prepare("DELETE FROM item_relations WHERE from_item_id = ? AND kind = 'blocks'").run(itemId);
    for (const t of targets) db.prepare("INSERT OR IGNORE INTO item_relations (from_item_id, to_item_id, kind) VALUES (?, ?, 'blocks')").run(itemId, t);
  }

  /** Record that `id` blocks `blockedId`. A logged blocks edit, so seeding and undo agree. */
  addRelation(projectId: string, id: string, blockedId: string, by: Author = "human"): void {
    const existing = this.get(projectId, id);
    if (!existing) throw new NotFoundError(id);
    if (existing.blocks.includes(blockedId)) return;
    this.update(projectId, id, { blocks: [...existing.blocks, blockedId] }, by);
  }

  removeRelation(projectId: string, id: string, blockedId: string, by: Author = "human"): void {
    const existing = this.get(projectId, id);
    if (!existing) throw new NotFoundError(id);
    if (!existing.blocks.includes(blockedId)) return;
    this.update(projectId, id, { blocks: existing.blocks.filter((t) => t !== blockedId) }, by);
  }

  labelsFor(projectId: string): string[] {
    return (this.db(projectId).prepare("SELECT name FROM labels WHERE project_id = ? ORDER BY name ASC").all(projectId) as { name: string }[]).map((r) => r.name);
  }

  /** Cut labels, values, edges and ranks, and release children so they never point at a dead epic. */
  private detach(db: ProjectDb, id: string): void {
    db.prepare("DELETE FROM item_labels WHERE item_id = ?").run(id);
    db.prepare("DELETE FROM item_values WHERE item_id = ?").run(id);
    db.prepare("DELETE FROM item_relations WHERE from_item_id = ? OR to_item_id = ?").run(id, id);
    db.prepare("DELETE FROM view_item_rank WHERE item_id = ?").run(id);
    db.prepare("UPDATE items SET parent_id = NULL WHERE parent_id = ?").run(id);
  }

  private hydrate(db: ProjectDb, rows: ItemRow[]): Item[] {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const labelRows = db
      .prepare(`SELECT il.item_id, l.name FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id IN (${placeholders}) ORDER BY l.name`)
      .all(...ids) as { item_id: string; name: string }[];
    const relRows = db
      .prepare(`SELECT from_item_id, to_item_id FROM item_relations WHERE kind = 'blocks' AND (from_item_id IN (${placeholders}) OR to_item_id IN (${placeholders}))`)
      .all(...ids, ...ids) as { from_item_id: string; to_item_id: string }[];
    const valueRows = db.prepare(`SELECT item_id, field_id, num, text FROM item_values WHERE item_id IN (${placeholders})`).all(...ids) as {
      item_id: string;
      field_id: string;
      num: number | null;
      text: string | null;
    }[];
    const labels = groupBy(labelRows, (r) => r.item_id, (r) => r.name);
    const blocks = groupBy(relRows, (r) => r.from_item_id, (r) => r.to_item_id);
    const blockedBy = groupBy(relRows, (r) => r.to_item_id, (r) => r.from_item_id);
    const values = groupBy(valueRows, (r) => r.item_id, (r) => [r.field_id, valueOfRow(r)] as const);
    return rows.map((row) => ({
      ...baseItem(row),
      labels: labels.get(row.id) ?? [],
      blocks: blocks.get(row.id) ?? [],
      blockedBy: blockedBy.get(row.id) ?? [],
      fields: Object.fromEntries(values.get(row.id) ?? [])
    }));
  }

  /** Upsert or clear one row per field named in the patch; untouched fields keep their rows. */
  private writeValues(db: ProjectDb, itemId: string, stored: Map<string, StoredValue | null>): void {
    for (const [fieldId, value] of stored) {
      if (value === null) db.prepare("DELETE FROM item_values WHERE item_id = ? AND field_id = ?").run(itemId, fieldId);
      else {
        db.prepare("INSERT INTO item_values (item_id, field_id, num, text) VALUES (?, ?, ?, ?) ON CONFLICT(item_id, field_id) DO UPDATE SET num = excluded.num, text = excluded.text").run(itemId, fieldId, value.num, value.text);
      }
    }
  }

  /** Replace an item's labels, creating any that are new to the project. */
  private writeLabels(db: ProjectDb, itemId: string, projectId: string, names: string[]): void {
    db.prepare("DELETE FROM item_labels WHERE item_id = ?").run(itemId);
    for (const raw of names) {
      const name = raw.trim();
      if (!name) continue;
      db.prepare("INSERT OR IGNORE INTO labels (id, project_id, name) VALUES (?, ?, ?)").run(randomUUID(), projectId, name);
      const label = db.prepare("SELECT id FROM labels WHERE project_id = ? AND name = ?").get(projectId, name) as { id: string };
      db.prepare("INSERT OR IGNORE INTO item_labels (item_id, label_id) VALUES (?, ?)").run(itemId, label.id);
    }
  }
}

/**
 * The merged `fields` an item carries after a patch: a key the registry
 * normalized to nothing (null, or an unticked checkbox) is dropped, absent keys survive.
 */
function mergeFields(current: Record<string, FieldValue>, patch: Record<string, FieldValue | null>, stored: Map<string, StoredValue | null>): Record<string, FieldValue> {
  const out = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || stored.get(k) === null) delete out[k];
    else out[k] = v;
  }
  return out;
}
