import { createHash } from "node:crypto";
import { Context, Service } from "cordis";
import { z } from "zod";
import type { Author, FieldDef, Item, Priority } from "@tomradex/domain";
import type {} from "@tomradex/boards";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/db";
import type {} from "@tomradex/fields";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/items";
import type {} from "@tomradex/settings";
import { WORDS, type Locale, type Words } from "./words.js";

export const INBOX_KINDS = ["bug", "feedback", "idea"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];
export type InboxStatus = "new" | "accepted" | "merged" | "closed";
export type CloseReason = "wontfix" | "duplicate";

export interface InboxAttachment {
  name: string;
  url: string;
}

/** One piece of feedback as a source hands it over. */
export interface InboxEntryInput {
  /** The source's own id for it: one entry per (source, externalId), however often it is pulled. */
  externalId: string;
  url?: string | null;
  kind?: InboxKind;
  /** Who sent it, as far as the source shows: a login, a report code. */
  reporter?: string | null;
  title: string;
  body?: string;
  attachments?: InboxAttachment[];
  receivedAt: number;
}

export interface InboxEntry {
  id: string;
  projectId: string;
  source: string;
  externalId: string;
  url: string | null;
  kind: InboxKind;
  reporter: string | null;
  title: string;
  body: string;
  attachments: InboxAttachment[];
  receivedAt: number;
  status: InboxStatus;
  /** The ticket it became, or was merged into. */
  itemId: string | null;
  closeReason: CloseReason | null;
  reply: string | null;
  repliedAt: number | null;
  triagedAt: number | null;
}

/** What the inbox tells a source after a triage, so whoever wrote sees it where they wrote. */
export type TriageChange =
  | { state: "accepted" | "merged"; ticket: { key: string; title: string } }
  | { state: "closed"; reason: CloseReason }
  | { state: "reopened" };

/**
 * Where feedback comes from: Tomrade's own reports, GitHub issues, later mail.
 * Pull only — the backlog is never mirrored back; a source hears just the
 * triage of what came from it, and a reply when it can carry one.
 */
export interface InboxSource {
  id: string;
  title: string | (() => string);
  /** What one of its ids looks like in text ("R-[0-9A-Z]{6}", "#\\d+"), as a regular expression. */
  keyPattern?: string;
  /** Null when it can pull in this project; otherwise why not, in the person's language. */
  available?(projectId: string): string | null | Promise<string | null>;
  /**
   * What arrived since `since` (epoch ms; null: from the start); entries already here are skipped. With
   * `cursor`, the source says where the next pull starts — needed when it leaves some of what it read out.
   */
  pull(scope: { projectId: string; since: number | null }): Promise<InboxEntryInput[] | { entries: InboxEntryInput[]; cursor: number | null }>;
  reply?(entry: InboxEntry, text: string): Promise<void>;
  setStatus?(entry: InboxEntry, change: TriageChange): Promise<void>;
}

export interface InboxSourceView {
  id: string;
  title: string;
  enabled: boolean;
  /** Why it can't pull here; null when it can. */
  unavailable: string | null;
  canReply: boolean;
  keyPattern: string | null;
  pulledAt: number | null;
  error: string | null;
  /** Triage it has not heard about yet. */
  pending: number;
}

export interface AcceptOptions {
  title?: string;
  kind?: InboxKind;
  boardId?: string;
  priority?: Priority;
}

export const InboxConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    /** How often the enabled sources of open projects are pulled. */
    pullMs: z.number().int().min(1_000).default(5 * 60_000)
  })
);
export type InboxConfig = z.output<typeof InboxConfig>;

declare module "cordis" {
  interface Context {
    inbox: Inbox;
  }
  interface Events {
    "inbox/changed"(projectId: string): void;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "inbox.list": (projectId: string, status?: InboxStatus | "all") => InboxEntry[];
    "inbox.sources": (projectId: string) => InboxSourceView[];
    "inbox.setSource": (projectId: string, sourceId: string, enabled: boolean) => InboxSourceView[];
    "inbox.refresh": (projectId: string) => number;
    "inbox.accept": (projectId: string, entryId: string, opts?: AcceptOptions) => { entry: InboxEntry; item: Item };
    "inbox.merge": (projectId: string, entryId: string, itemId: string) => InboxEntry;
    "inbox.close": (projectId: string, entryId: string, reason: CloseReason) => InboxEntry;
    "inbox.reopen": (projectId: string, entryId: string) => InboxEntry;
    "inbox.reply": (projectId: string, entryId: string, text: string) => InboxEntry;
  }
  interface Broadcasts {
    "inbox.changed": (projectId: string) => void;
  }
}

export const MIGRATIONS = [
  {
    version: 1,
    up: `
CREATE TABLE IF NOT EXISTS plugin_inbox_entries (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  source           TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  url              TEXT,
  kind             TEXT NOT NULL,
  reporter         TEXT,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL DEFAULT '',
  attachments_json TEXT NOT NULL DEFAULT '[]',
  received_at      INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'new',
  item_id          TEXT,
  close_reason     TEXT,
  reply            TEXT,
  replied_at       INTEGER,
  triaged_at       INTEGER,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plugin_inbox_entries_status ON plugin_inbox_entries(project_id, status, received_at);
CREATE INDEX IF NOT EXISTS idx_plugin_inbox_entries_item ON plugin_inbox_entries(item_id);
CREATE TABLE IF NOT EXISTS plugin_inbox_projects (
  project_id   TEXT PRIMARY KEY,
  sources_json TEXT NOT NULL DEFAULT '[]',
  source_field TEXT,
  kind_field   TEXT,
  options_json TEXT NOT NULL DEFAULT '{}',
  view_id      TEXT,
  updated_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_inbox_pulls (
  project_id TEXT NOT NULL,
  source     TEXT NOT NULL,
  cursor     INTEGER,
  pulled_at  INTEGER,
  error      TEXT,
  PRIMARY KEY (project_id, source)
);
CREATE TABLE IF NOT EXISTS plugin_inbox_outbox (
  entry_id    TEXT PRIMARY KEY,
  change_json TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);
`
  }
];

/**
 * Entries and their triage travel with the project, so every machine sees the
 * same inbox. Where each source was read up to, and what a source has yet to
 * hear, belong to the machine that pulled and triaged.
 */
export const TABLES = {
  plugin_inbox_entries: { project: "project_id", export: { order: "id" } },
  plugin_inbox_projects: { project: "project_id", export: { order: "project_id" } },
  plugin_inbox_pulls: { project: "project_id", export: false },
  plugin_inbox_outbox: { project: { via: "entry_id", table: "plugin_inbox_entries" }, export: false }
} as const;

interface EntryRow {
  id: string;
  project_id: string;
  source: string;
  external_id: string;
  url: string | null;
  kind: string;
  reporter: string | null;
  title: string;
  body: string;
  attachments_json: string;
  received_at: number;
  status: string;
  item_id: string | null;
  close_reason: string | null;
  reply: string | null;
  replied_at: number | null;
  triaged_at: number | null;
  updated_at: number;
}

interface ProjectRow {
  project_id: string;
  sources_json: string;
  source_field: string | null;
  kind_field: string | null;
  options_json: string;
  view_id: string | null;
}

interface PullRow {
  source: string;
  cursor: number | null;
  pulled_at: number | null;
  error: string | null;
}

const TRIAGED = "('accepted', 'merged')";
const FEEDBACK_VALUES_SQL = `SELECT item_id AS item_id, COUNT(*) AS value FROM plugin_inbox_entries WHERE item_id IS NOT NULL AND status IN ${TRIAGED} GROUP BY item_id`;
const FEEDBACK_EXPR_SQL = `SELECT NULLIF(COUNT(*), 0) FROM plugin_inbox_entries e WHERE e.item_id = i.id AND e.status IN ${TRIAGED}`;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isKind = (k: unknown): k is InboxKind => (INBOX_KINDS as readonly unknown[]).includes(k);

/** Stable across machines: two of them pulling the same report make one entry. */
export const entryId = (source: string, externalId: string): string => createHash("sha1").update(`${source}\n${externalId}`).digest("hex").slice(0, 24);

function rowToEntry(r: EntryRow): InboxEntry {
  let attachments: InboxAttachment[] = [];
  try {
    attachments = JSON.parse(r.attachments_json) as InboxAttachment[];
  } catch {}
  return {
    id: r.id,
    projectId: r.project_id,
    source: r.source,
    externalId: r.external_id,
    url: r.url,
    kind: isKind(r.kind) ? r.kind : "feedback",
    reporter: r.reporter,
    title: r.title,
    body: r.body,
    attachments,
    receivedAt: r.received_at,
    status: (["new", "accepted", "merged", "closed"].includes(r.status) ? r.status : "new") as InboxStatus,
    itemId: r.item_id,
    closeReason: r.close_reason === "wontfix" || r.close_reason === "duplicate" ? r.close_reason : null,
    reply: r.reply,
    repliedAt: r.replied_at,
    triagedAt: r.triaged_at
  };
}

/**
 * A project's inbox. Feedback and bug reports arrive from the sources the
 * project switched on and wait here; a person triages each one — accepts it as
 * a ticket, merges it into one, replies, or closes it — and only then does it
 * reach the backlog. Tickets that came from here carry Source and Kind fields
 * and a count of how many times the same thing came in.
 */
export class Inbox extends Service {
  static provide = "inbox";
  static inject = ["db", "items", "fields", "boards", "views"];
  static Config = InboxConfig;

  private readonly home: Context;
  private readonly sourceMap = new Map<string, InboxSource>();
  private readonly pulling = new Map<string, Promise<number>>();
  private readonly flushing = new Map<string, Promise<void>>();

  constructor(
    ctx: Context,
    public readonly config: InboxConfig
  ) {
    super(ctx, "inbox");
    this.home = ctx;
  }

  [Service.init]() {
    const ctx = this.home;
    ctx.db.migrate("inbox", MIGRATIONS, { tables: TABLES });
    ctx.fields.derive({ id: "feedback", name: "Feedback", names: { zh: "反馈数" }, values: FEEDBACK_VALUES_SQL, expr: FEEDBACK_EXPR_SQL });
    const timer = setInterval(() => void this.pullAll(), this.config.pullMs);
    timer.unref?.();
    ctx.effect(() => () => clearInterval(timer), "inbox pull");
    ctx.inject(["ipc"], (ctx) => {
      const inbox = () => ctx.inbox;
      ctx.ipc.handle("inbox.list", (projectId, status) => inbox().list(projectId, status));
      ctx.ipc.handle("inbox.sources", (projectId) => inbox().sources(projectId));
      ctx.ipc.handle("inbox.setSource", (projectId, sourceId, enabled) => inbox().setSource(projectId, sourceId, enabled));
      ctx.ipc.handle("inbox.refresh", (projectId) => inbox().refresh(projectId));
      ctx.ipc.handle("inbox.accept", (projectId, entryId, opts) => inbox().accept(projectId, entryId, opts ?? {}, "human"));
      ctx.ipc.handle("inbox.merge", (projectId, entryId, itemId) => inbox().merge(projectId, entryId, itemId, "human"));
      ctx.ipc.handle("inbox.close", (projectId, entryId, reason) => inbox().close(projectId, entryId, reason));
      ctx.ipc.handle("inbox.reopen", (projectId, entryId) => inbox().reopen(projectId, entryId));
      ctx.ipc.handle("inbox.reply", (projectId, entryId, text) => inbox().reply(projectId, entryId, text));
      ctx.on("inbox/changed", (projectId) => ctx.ipc.send("inbox.changed", projectId));
    });
    ctx.inject(["contributions"], (ctx) => {
      ctx.contributions.sidebarModule({ id: "inbox", title: () => this.words().module, icon: "i-inbox", opens: "inbox", count: ({ projectId }) => this.count(projectId) });
      ctx.contributions.section({ id: "inbox", title: () => this.words().section, render: (item) => this.section(item) });
      ctx.on("inbox/changed", () => ctx.contributions.changed());
    });
  }

  // ── sources ────────────────────────────────────────────────────────────────

  /** A source of feedback; every project chooses whether to pull from it. */
  source(def: InboxSource): () => void {
    if (this.sourceMap.has(def.id)) throw new Error(`inbox source "${def.id}" is already registered`);
    return this.ctx.effect(() => {
      this.sourceMap.set(def.id, def);
      return () => this.sourceMap.delete(def.id);
    }, `inbox.source(${def.id})`);
  }

  async sources(projectId: string): Promise<InboxSourceView[]> {
    const enabled = this.enabledSources(projectId);
    const pulls = new Map(this.pulls(projectId).map((p) => [p.source, p]));
    const pending = this.has(projectId) ? (this.db(projectId).prepare("SELECT e.source AS source, COUNT(*) AS n FROM plugin_inbox_outbox o JOIN plugin_inbox_entries e ON e.id = o.entry_id GROUP BY e.source").all() as { source: string; n: number }[]) : [];
    return Promise.all(
      [...this.sourceMap.values()].map(async (s) => {
        const pull = pulls.get(s.id);
        return {
          id: s.id,
          title: this.titleOf(s),
          enabled: enabled.includes(s.id),
          unavailable: await this.unavailable(s, projectId),
          canReply: !!s.reply,
          keyPattern: s.keyPattern ?? null,
          pulledAt: pull?.pulled_at ?? null,
          error: pull?.error ?? null,
          pending: pending.find((p) => p.source === s.id)?.n ?? 0
        };
      })
    );
  }

  async setSource(projectId: string, sourceId: string, enabled: boolean): Promise<InboxSourceView[]> {
    if (!this.sourceMap.has(sourceId)) throw new Error(`No inbox source "${sourceId}"`);
    const now = this.enabledSources(projectId).filter((id) => id !== sourceId);
    if (enabled) now.push(sourceId);
    this.ensureProject(projectId);
    this.db(projectId).prepare("UPDATE plugin_inbox_projects SET sources_json = ?, updated_at = ? WHERE project_id = ?").run(JSON.stringify(now), Date.now(), projectId);
    this.changed(projectId);
    if (enabled) await this.refresh(projectId).catch(() => 0);
    return this.sources(projectId);
  }

  // ── entries ────────────────────────────────────────────────────────────────

  list(projectId: string, status: InboxStatus | "all" = "new"): InboxEntry[] {
    if (!this.has(projectId)) return [];
    const db = this.db(projectId);
    const rows = (status === "all"
      ? db.prepare("SELECT * FROM plugin_inbox_entries WHERE project_id = ? ORDER BY received_at DESC").all(projectId)
      : db.prepare("SELECT * FROM plugin_inbox_entries WHERE project_id = ? AND status = ? ORDER BY received_at DESC").all(projectId, status)) as EntryRow[];
    return rows.map(rowToEntry);
  }

  get(projectId: string, id: string): InboxEntry | null {
    if (!this.has(projectId)) return null;
    const row = this.db(projectId).prepare("SELECT * FROM plugin_inbox_entries WHERE id = ? AND project_id = ?").get(id, projectId) as EntryRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  /** What waits for triage. */
  count(projectId: string): number {
    if (!this.has(projectId)) return 0;
    return (this.db(projectId).prepare("SELECT COUNT(*) AS n FROM plugin_inbox_entries WHERE project_id = ? AND status = 'new'").get(projectId) as { n: number }).n;
  }

  /** New entries from one source; one already here — pulled before, or on another machine — is left as it is. */
  add(projectId: string, sourceId: string, inputs: InboxEntryInput[]): number {
    const db = this.db(projectId);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO plugin_inbox_entries (id, project_id, source, external_id, url, kind, reporter, title, body, attachments_json, received_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const now = Date.now();
    const added = db.transaction(() =>
      inputs.reduce((n, e) => {
        const title = e.title.trim() || e.body?.trim().split("\n")[0]?.slice(0, 120) || e.externalId;
        const r = insert.run(entryId(sourceId, e.externalId), projectId, sourceId, e.externalId, e.url ?? null, isKind(e.kind) ? e.kind : "feedback", e.reporter ?? null, title, e.body ?? "", JSON.stringify(e.attachments ?? []), e.receivedAt, now);
        return n + r.changes;
      }, 0)
    );
    if (added) this.changed(projectId);
    return added;
  }

  /** Pull every enabled source now — or one — after telling them what was triaged since. Returns how many arrived. */
  refresh(projectId: string, only?: string): Promise<number> {
    const key = `${projectId}\n${only ?? "*"}`;
    const running = this.pulling.get(key);
    if (running) return running;
    const run = this.pullNow(projectId, only).finally(() => this.pulling.delete(key));
    this.pulling.set(key, run);
    return run;
  }

  private async pullNow(projectId: string, only?: string): Promise<number> {
    if (!this.has(projectId)) return 0;
    await this.flush(projectId);
    let added = 0;
    for (const id of this.enabledSources(projectId)) {
      if (only && id !== only) continue;
      const source = this.sourceMap.get(id);
      if (!source) continue;
      const db = this.db(projectId);
      const prior = db.prepare("SELECT * FROM plugin_inbox_pulls WHERE project_id = ? AND source = ?").get(projectId, id) as PullRow | undefined;
      const record = (cursor: number | null, error: string | null) =>
        db.prepare("INSERT INTO plugin_inbox_pulls (project_id, source, cursor, pulled_at, error) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, source) DO UPDATE SET cursor = excluded.cursor, pulled_at = excluded.pulled_at, error = excluded.error").run(projectId, id, cursor, Date.now(), error);
      const unavailable = await this.unavailable(source, projectId);
      if (unavailable) {
        record(prior?.cursor ?? null, unavailable);
        continue;
      }
      try {
        const since = prior?.cursor ?? null;
        const pulled = await source.pull({ projectId, since });
        const inputs = Array.isArray(pulled) ? pulled : pulled.entries;
        added += this.add(projectId, id, inputs);
        const cursor = Array.isArray(pulled) ? inputs.reduce<number | null>((max, e) => (max === null || e.receivedAt > max ? e.receivedAt : max), since) : pulled.cursor;
        record(cursor, null);
      } catch (error) {
        record(prior?.cursor ?? null, message(error));
      }
    }
    this.changed(projectId);
    return added;
  }

  private async pullAll(): Promise<void> {
    for (const projectId of this.home.db.openIds()) {
      if (this.enabledSources(projectId).length) await this.refresh(projectId).catch(() => 0);
    }
  }

  // ── triage ─────────────────────────────────────────────────────────────────

  /** A new ticket from the entry, carrying where it came from; the source hears which ticket. */
  async accept(projectId: string, id: string, opts: AcceptOptions = {}, by: Author = "human"): Promise<{ entry: InboxEntry; item: Item }> {
    const entry = this.open(projectId, id);
    const kind = opts.kind ?? entry.kind;
    const fields = this.ensureFields(projectId, entry.source, kind);
    const item = this.home.items.create({
      projectId,
      boardId: opts.boardId ?? this.home.boards.defaultFor(projectId).id,
      title: opts.title?.trim() || entry.title,
      body: this.ticketBody(entry),
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
      fields,
      by
    });
    this.ensureView(projectId, by);
    const done = this.triage(projectId, entry, { status: "accepted", item_id: item.id, kind }, { state: "accepted", ticket: { key: item.key, title: item.title } });
    return { entry: done, item };
  }

  /** The same thing came in again: counted on the ticket it already is. */
  async merge(projectId: string, id: string, itemId: string, by: Author = "human"): Promise<InboxEntry> {
    const entry = this.open(projectId, id);
    const item = this.home.items.get(projectId, itemId) ?? this.home.items.getByKey(projectId, itemId);
    if (!item) throw new Error(`No ticket ${itemId}`);
    const fields = this.ensureFields(projectId, entry.source, entry.kind);
    const missing = Object.fromEntries(Object.entries(fields).filter(([field]) => item.fields[field] === undefined || item.fields[field] === null));
    if (Object.keys(missing).length) this.home.items.update(projectId, item.id, { fields: missing }, by);
    return this.triage(projectId, entry, { status: "merged", item_id: item.id }, { state: "merged", ticket: { key: item.key, title: item.title } });
  }

  async close(projectId: string, id: string, reason: CloseReason): Promise<InboxEntry> {
    if (reason !== "wontfix" && reason !== "duplicate") throw new Error(`Not a reason to close: ${String(reason)}`);
    const entry = this.open(projectId, id);
    return this.triage(projectId, entry, { status: "closed", close_reason: reason }, { state: "closed", reason });
  }

  /** Back to untriaged. A ticket it became stays: it may hold work by now. */
  async reopen(projectId: string, id: string): Promise<InboxEntry> {
    const entry = this.get(projectId, id);
    if (!entry) throw new Error("No such inbox entry");
    if (entry.status === "new") return entry;
    return this.triage(projectId, entry, { status: "new", item_id: null, close_reason: null, triaged_at: null }, { state: "reopened" });
  }

  /** Said through the source, where the person who wrote reads it. */
  async reply(projectId: string, id: string, text: string): Promise<InboxEntry> {
    const entry = this.get(projectId, id);
    if (!entry) throw new Error("No such inbox entry");
    const source = this.sourceMap.get(entry.source);
    const body = text.trim();
    if (!body) throw new Error("Write a reply first");
    if (!source?.reply) throw new Error(this.words().noReply(source ? this.titleOf(source) : entry.source));
    await source.reply(entry, body);
    const now = Date.now();
    this.db(projectId).prepare("UPDATE plugin_inbox_entries SET reply = ?, replied_at = ?, updated_at = ? WHERE id = ?").run(body, now, now, id);
    this.changed(projectId);
    return this.get(projectId, id)!;
  }

  private open(projectId: string, id: string): InboxEntry {
    const entry = this.get(projectId, id);
    if (!entry) throw new Error("No such inbox entry");
    if (entry.status !== "new") throw new Error("Already triaged; reopen it first");
    return entry;
  }

  /** The entry's new state now; the source hears about it as soon as it can, and again until it has. */
  private triage(projectId: string, entry: InboxEntry, patch: Partial<Pick<EntryRow, "status" | "item_id" | "close_reason" | "kind" | "triaged_at">>, change: TriageChange): InboxEntry {
    const db = this.db(projectId);
    const now = Date.now();
    const next = { triaged_at: now, ...patch };
    const cols = Object.keys(next);
    db.transaction(() => {
      db.prepare(`UPDATE plugin_inbox_entries SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => next[c as keyof typeof next] ?? null), now, entry.id);
      if (this.sourceMap.get(entry.source)?.setStatus) db.prepare("INSERT INTO plugin_inbox_outbox (entry_id, change_json) VALUES (?, ?) ON CONFLICT(entry_id) DO UPDATE SET change_json = excluded.change_json, attempts = 0, error = NULL").run(entry.id, JSON.stringify(change));
    });
    this.changed(projectId);
    void this.flush(projectId);
    return this.get(projectId, entry.id)!;
  }

  /** Tell the sources what was triaged here; what fails waits for the next pull. */
  flush(projectId: string): Promise<void> {
    const running = this.flushing.get(projectId);
    if (running) return running.then(() => this.flush(projectId));
    const run = this.flushNow(projectId).finally(() => this.flushing.delete(projectId));
    this.flushing.set(projectId, run);
    return run;
  }

  private async flushNow(projectId: string): Promise<void> {
    if (!this.has(projectId)) return;
    const db = this.db(projectId);
    const rows = db.prepare("SELECT o.entry_id AS entry_id, o.change_json AS change_json FROM plugin_inbox_outbox o").all() as { entry_id: string; change_json: string }[];
    for (const row of rows) {
      const entry = this.get(projectId, row.entry_id);
      const source = entry && this.sourceMap.get(entry.source);
      if (!entry) {
        db.prepare("DELETE FROM plugin_inbox_outbox WHERE entry_id = ?").run(row.entry_id);
        continue;
      }
      if (!source?.setStatus) continue;
      try {
        await source.setStatus(entry, JSON.parse(row.change_json) as TriageChange);
        // a newer triage may have replaced this change meanwhile
        db.prepare("DELETE FROM plugin_inbox_outbox WHERE entry_id = ? AND change_json = ?").run(row.entry_id, row.change_json);
      } catch (error) {
        db.prepare("UPDATE plugin_inbox_outbox SET attempts = attempts + 1, error = ? WHERE entry_id = ?").run(message(error), row.entry_id);
      }
    }
  }

  // ── tickets ────────────────────────────────────────────────────────────────

  private ticketBody(entry: InboxEntry): string {
    const w = this.words();
    const source = this.sourceMap.get(entry.source);
    const ref = entry.url ? `[${entry.externalId}](${entry.url})` : `\`${entry.externalId}\``;
    const when = new Date(entry.receivedAt).toISOString().slice(0, 10);
    const head = `> ${w.quoted(source ? this.titleOf(source) : entry.source, when)} · ${ref}${entry.reporter ? ` · ${w.reporter} ${entry.reporter}` : ""}`;
    const files = entry.attachments.map((a) => `- [${a.name}](${a.url})`).join("\n");
    return [head, entry.body.trim(), files].filter(Boolean).join("\n\n");
  }

  /** The Source and Kind fields, made the first time a ticket comes from the inbox; the person may rename them. */
  private ensureFields(projectId: string, sourceId: string, kind: InboxKind): Record<string, string> {
    const w = this.words();
    const row = this.ensureProject(projectId);
    const options = JSON.parse(row.options_json) as Record<string, string>;
    const field = (current: string | null, name: string): FieldDef => {
      const kept = current ? this.home.fields.get(projectId, current) : null;
      if (kept?.type === "select") return kept;
      const named = this.home.fields.custom(projectId).find((f) => f.name === name);
      if (named?.type === "select") return named;
      return this.home.fields.create({ projectId, name: named ? `${name} · ${w.module}` : name, type: "select" });
    };
    const option = (def: FieldDef, key: string, name: string): string => {
      const known = options[key];
      if (known && def.options?.some((o) => o.id === known)) return known;
      const named = def.options?.find((o) => o.name === name);
      const id = named?.id ?? this.home.fields.addOption(projectId, def.id, { name }).id;
      options[key] = id;
      return id;
    };
    const sourceDef = field(row.source_field, w.sourceField);
    const kindDef = field(row.kind_field, w.kindField);
    const source = this.sourceMap.get(sourceId);
    const sourceOption = option(sourceDef, `source:${sourceId}`, source ? this.titleOf(source) : sourceId);
    const kindOption = option(kindDef, `kind:${kind}`, w.kinds[kind]);
    this.db(projectId).prepare("UPDATE plugin_inbox_projects SET source_field = ?, kind_field = ?, options_json = ?, updated_at = ? WHERE project_id = ?").run(sourceDef.id, kindDef.id, JSON.stringify(options), Date.now(), projectId);
    return { [sourceDef.id]: sourceOption, [kindDef.id]: kindOption };
  }

  /** "From feedback": made once, beside the first ticket from the inbox. Deleted, it stays deleted. */
  private ensureView(projectId: string, by: Author): void {
    const row = this.ensureProject(projectId);
    if (row.view_id || !row.source_field) return;
    const view = this.home.views.create(
      {
        projectId,
        name: this.words().view,
        icon: "i-inbox",
        layout: "table",
        query: { filter: [{ field: row.source_field, op: "not-in", values: [null] }], groupBy: row.kind_field, fields: ["status", row.source_field, "feedback"] }
      },
      by
    );
    this.db(projectId).prepare("UPDATE plugin_inbox_projects SET view_id = ?, updated_at = ? WHERE project_id = ?").run(view.id, Date.now(), projectId);
  }

  private section(item: Item) {
    if (!this.has(item.projectId)) return null;
    const rows = this.db(item.projectId).prepare(`SELECT * FROM plugin_inbox_entries WHERE item_id = ? AND status IN ${TRIAGED} ORDER BY received_at ASC`).all(item.id) as EntryRow[];
    if (!rows.length) return null;
    const w = this.words();
    return {
      text: w.sectionText(rows.length),
      rows: rows.map(rowToEntry).map((e) => {
        const source = this.sourceMap.get(e.source);
        return {
          label: source ? this.titleOf(source) : e.source,
          value: [e.externalId, e.reporter, new Date(e.receivedAt).toISOString().slice(0, 10)].filter(Boolean).join(" · "),
          icon: "i-inbox",
          ...(e.url ? { href: e.url } : {})
        };
      })
    };
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  private has(projectId: string): boolean {
    return this.home.db.has(projectId);
  }

  private db(projectId: string) {
    if (!this.has(projectId)) throw new Error("That project is not open on this machine");
    return this.home.db.for(projectId);
  }

  private ensureProject(projectId: string): ProjectRow {
    const db = this.db(projectId);
    db.prepare("INSERT OR IGNORE INTO plugin_inbox_projects (project_id, updated_at) VALUES (?, ?)").run(projectId, Date.now());
    return db.prepare("SELECT * FROM plugin_inbox_projects WHERE project_id = ?").get(projectId) as ProjectRow;
  }

  private enabledSources(projectId: string): string[] {
    if (!this.has(projectId)) return [];
    const row = this.db(projectId).prepare("SELECT sources_json FROM plugin_inbox_projects WHERE project_id = ?").get(projectId) as { sources_json: string } | undefined;
    try {
      return row ? (JSON.parse(row.sources_json) as string[]) : [];
    } catch {
      return [];
    }
  }

  private pulls(projectId: string): PullRow[] {
    if (!this.has(projectId)) return [];
    return this.db(projectId).prepare("SELECT source, cursor, pulled_at, error FROM plugin_inbox_pulls WHERE project_id = ?").all(projectId) as PullRow[];
  }

  private async unavailable(source: InboxSource, projectId: string): Promise<string | null> {
    try {
      return (await source.available?.(projectId)) ?? null;
    } catch (error) {
      return message(error);
    }
  }

  private titleOf(source: InboxSource): string {
    return typeof source.title === "function" ? source.title() : source.title;
  }

  private locale(): Locale {
    return (this.home.get("settings") as { locale?: () => Locale } | undefined)?.locale?.() === "zh" ? "zh" : "en";
  }

  words(): Words {
    return WORDS[this.locale()];
  }

  private changed(projectId: string): void {
    this.home.emit("inbox/changed", projectId);
  }
}
