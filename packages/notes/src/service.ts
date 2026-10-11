// cordis first: the packages below augment it, and an augmentation reached
// before cordis itself declares a new module rather than extending one.
import type {} from "cordis";
import { Context, Service } from "cordis";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {} from "@tomradex/db";
import type {} from "@tomradex/files";
import type {} from "@tomradex/tools";
import type { SettingsSection } from "@tomradex/settings";
import type {} from "./channels.js";
import { searchNotes, type NoteSearchInput, type NoteSearchResult } from "./search.js";
import { MIGRATIONS, NotesStore, TABLES, nameKey, type IndexBatch } from "./store.js";
import { isIndexedPath, isNotePath, noteName, parseNote, resolveLink, rewriteLink, type NoteLink } from "./syntax.js";
import { registerTools } from "./tools.js";

declare module "cordis" {
  interface Context {
    notes: Notes;
  }
  interface Events {
    /** A project's index caught up with its files. */
    "notes/indexed"(projectId: string): void;
  }
}

export const NotesConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    /** A burst of saves is indexed once, this long after the last. */
    debounceMs: z.number().int().min(0).default(300),
    /** Bigger files are left out of the index. */
    maxBytes: z.number().int().min(1).default(2 * 1024 * 1024)
  })
);
export type NotesConfig = z.infer<typeof NotesConfig>;

export interface NotesSettings {
  updateLinks: boolean;
  journalFolder: string;
}

export const NOTES_SECTION: SettingsSection<NotesSettings> = {
  id: "notes",
  title: "Notes",
  description: "Links between the project's notes, and where a day's journal goes.",
  schema: z.object({
    updateLinks: z.boolean().default(true).meta({ title: "Update links when a note is renamed or moved" }),
    journalFolder: z.string().default("Journal").meta({ title: "Journal folder" })
  }),
  defaults: { updateLinks: true, journalFolder: "Journal" },
  order: 14,
  agent: "write"
};

export interface Mention {
  path: string;
  title: string | null;
  line: number;
  /** The line it sits on, trimmed. */
  text: string;
}

export interface OutgoingLink {
  target: string;
  anchor: string | null;
  alias: string | null;
  embed: boolean;
  line: number;
  /** Null: nothing in the store answers to it yet. */
  path: string | null;
}

export interface NoteLinks {
  outgoing: OutgoingLink[];
  backlinks: Mention[];
  /** Notes that say this note's name without linking to it. */
  unlinked: Mention[];
}

export interface RetargetResult {
  files: number;
  links: number;
  ref: string | null;
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const clipLine = (text: string): string => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
};
const UNLINKED_MAX = 20;

/**
 * `ctx.notes`: a project's files read as notes — the links between them, their
 * tags, and a ranked full-text index — kept in the project's cache and caught
 * up a moment after every change. It reads the files and never owns them: a
 * rename's link updates are ordinary saves through `ctx.files`.
 */
export class Notes extends Service {
  static provide = "notes";
  static inject = ["db", "files"];
  static Config = NotesConfig;

  private readonly home: Context;
  private store!: NotesStore;
  /** Every file path of a project as of its last reconcile; links to images and PDFs resolve against it. */
  private readonly paths = new Map<string, string[]>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly fresh = new Set<string>();

  constructor(
    ctx: Context,
    public readonly config: NotesConfig
  ) {
    super(ctx, "notes");
    this.home = ctx;
  }

  [Service.init]() {
    this.ctx.db.migrate("notes", MIGRATIONS, { tables: TABLES });
    this.store = new NotesStore(this.ctx.db);
    this.ctx.on("files/changed", (projectId) => this.schedule(projectId));
    this.ctx.on("db/opened", (projectId) => this.schedule(projectId));
    this.ctx.on("db/closed", (projectId) => this.forget(projectId));
    this.ctx.on("files/moved", async (projectId, from, to) => {
      if (!this.settings().updateLinks) return;
      try {
        await this.retarget(projectId, from, to);
      } catch (error) {
        this.warn(projectId, error);
      }
    });
    this.home.inject(["settings"], (ctx) => ctx.settings.register(NOTES_SECTION));
    this.home.inject(["tools"], (ctx) => registerTools(ctx, this));
    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("notes.search", (projectId, input) => this.search(projectId, input));
      ctx.ipc.handle("notes.links", (projectId, p) => this.links(projectId, p));
      ctx.ipc.handle("notes.tags", (projectId) => this.tags(projectId));
      ctx.ipc.handle("notes.resolve", (projectId, target, from) => this.resolve(projectId, target, from));
      ctx.ipc.handle("notes.journal", (projectId, date) => this.journal(projectId, date));
    });
    return () => {
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
    };
  }

  private settings(): NotesSettings {
    const stored = this.home.get("settings")?.get().notes as Partial<NotesSettings> | undefined;
    return { ...NOTES_SECTION.defaults, ...stored };
  }

  private warn(projectId: string, error: unknown): void {
    this.home.logger.warn(`notes: ${projectId}: ${message(error)}`);
  }

  private forget(projectId: string): void {
    const timer = this.timers.get(projectId);
    if (timer) clearTimeout(timer);
    this.timers.delete(projectId);
    this.paths.delete(projectId);
    this.fresh.delete(projectId);
  }

  // ── the index ───────────────────────────────────────────────────────────────

  private schedule(projectId: string): void {
    this.fresh.delete(projectId);
    const pending = this.timers.get(projectId);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.timers.delete(projectId);
      void this.reconcile(projectId).catch((error) => this.warn(projectId, error));
    }, this.config.debounceMs);
    timer.unref?.();
    this.timers.set(projectId, timer);
  }

  /** The index as of now: a query never answers from before the last change it could know about. */
  async ready(projectId: string): Promise<void> {
    if (this.fresh.has(projectId) && !this.timers.has(projectId) && !this.running.has(projectId)) return;
    const pending = this.timers.get(projectId);
    if (pending) {
      clearTimeout(pending);
      this.timers.delete(projectId);
    }
    await this.reconcile(projectId);
  }

  /** Catch the index up with the files: only what changed size or time is read, only what changed bytes is parsed. */
  reconcile(projectId: string): Promise<void> {
    const current = this.running.get(projectId);
    if (current) {
      this.again.add(projectId);
      return current;
    }
    const run = (async () => {
      try {
        do {
          this.again.delete(projectId);
          await this.pass(projectId);
        } while (this.again.has(projectId));
      } finally {
        this.running.delete(projectId);
      }
    })();
    this.running.set(projectId, run);
    return run;
  }

  private async pass(projectId: string): Promise<void> {
    if (!this.ctx.db.has(projectId)) return;
    const dir = this.ctx.files.dirFor(projectId);
    if (!dir) return;
    const entries = (await this.ctx.files.tree(projectId)).filter((e) => e.kind === "file");
    if (!this.ctx.db.has(projectId)) return;
    this.paths.set(projectId, entries.map((e) => e.path));
    const known = new Map(this.store.docs(projectId).map((d) => [d.path, d]));
    const batch: IndexBatch = { put: [], drop: [] };
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!isIndexedPath(entry.path) || entry.size > this.config.maxBytes) continue;
      seen.add(entry.path);
      const listed = entry.listing?.mode !== "unlisted";
      const doc = known.get(entry.path);
      if (doc && doc.size === entry.size && doc.modifiedAt === entry.modifiedAt && doc.listed === listed) continue;
      let bytes: Buffer;
      try {
        bytes = await fs.promises.readFile(path.join(dir, ...entry.path.split("/")));
      } catch {
        continue;
      }
      const hash = sha256(bytes);
      if (doc && doc.hash === hash) {
        batch.put.push({ path: entry.path, size: entry.size, modifiedAt: entry.modifiedAt, hash, listed, body: null, parsed: null });
        continue;
      }
      const body = bytes.toString("utf8");
      batch.put.push({ path: entry.path, size: entry.size, modifiedAt: entry.modifiedAt, hash, listed, body, parsed: parseNote(body) });
    }
    for (const p of known.keys()) if (!seen.has(p)) batch.drop.push(p);
    if (!this.ctx.db.has(projectId)) return;
    if (batch.put.length || batch.drop.length) this.store.apply(projectId, batch);
    this.fresh.add(projectId);
    if (batch.put.some((d) => d.parsed) || batch.drop.length) {
      this.home.get("ipc")?.send("notes.changed", projectId);
      this.home.emit("notes/indexed", projectId);
    }
  }

  private filePaths(projectId: string): string[] {
    return this.paths.get(projectId) ?? this.store.docs(projectId).map((d) => d.path);
  }

  // ── reading ─────────────────────────────────────────────────────────────────

  async search(projectId: string, input: NoteSearchInput): Promise<NoteSearchResult> {
    await this.ready(projectId);
    return searchNotes(this.ctx.db, projectId, input);
  }

  async tags(projectId: string): Promise<{ tag: string; count: number }[]> {
    await this.ready(projectId);
    return this.store.tags(projectId);
  }

  /** Which file a link written in `from` means, by the same rules the editor and the preview use. */
  async resolve(projectId: string, target: string, from: string): Promise<string | null> {
    await this.ready(projectId);
    const parsed = parseNote(target).links[0];
    const link = parsed ?? { target, kind: "wiki" as const };
    return resolveLink(link, from, this.filePaths(projectId));
  }

  /** What a note links to, what links to it, and who mentions it by name without a link. */
  /** `listedOnly` leaves out notes kept out of the agent index: they are not volunteered, even as a backlink. */
  async links(projectId: string, p: string, opts: { unlinked?: boolean; listedOnly?: boolean } = {}): Promise<NoteLinks> {
    await this.ready(projectId);
    const paths = this.filePaths(projectId);
    const doc = this.store.doc(projectId, p);
    const outgoing: OutgoingLink[] = doc
      ? parseNote(this.store.body(projectId, doc.id)).links.map((l) => ({ target: l.target, anchor: l.anchor, alias: l.alias, embed: l.embed, line: l.line, path: resolveLink(l, p, paths) }))
      : [];
    const docs = this.store.docs(projectId);
    const titles = new Map(docs.map((d) => [d.path, d.title]));
    const hidden = opts.listedOnly ? new Set(docs.filter((d) => !d.listed).map((d) => d.path)) : new Set<string>();
    const name = isNotePath(p) ? noteName(p) : (p.split("/").pop() ?? p);
    const bodies = new Map<number, string[]>();
    const lineOf = (docId: number, line: number) => {
      if (!bodies.has(docId)) bodies.set(docId, this.store.body(projectId, docId).split(/\r?\n/));
      return clipLine(bodies.get(docId)![line - 1] ?? "");
    };
    const backlinks: Mention[] = [];
    const linking = new Set<string>();
    for (const row of this.store.linksNamed(projectId, nameKey(name))) {
      if (row.source === p || hidden.has(row.source) || resolveLink(row, row.source, paths) !== p) continue;
      linking.add(row.source);
      if (backlinks.some((b) => b.path === row.source && b.line === row.line)) continue;
      backlinks.push({ path: row.source, title: titles.get(row.source) ?? null, line: row.line, text: lineOf(row.docId, row.line) });
    }
    const unlinked = opts.unlinked === false || !isNotePath(p) ? [] : this.unlinked(projectId, p, name, linking).filter((m) => !hidden.has(m.path));
    return { outgoing, backlinks, unlinked };
  }

  private unlinked(projectId: string, p: string, name: string, linking: Set<string>): Mention[] {
    if ([...name].length < 2) return [];
    const { hits } = searchNotes(this.ctx.db, projectId, { query: `"${name.replace(/"/g, "")}"`, limit: 60 });
    const needle = name.toLowerCase();
    const out: Mention[] = [];
    for (const hit of hits) {
      if (hit.path === p || linking.has(hit.path) || out.length >= UNLINKED_MAX) continue;
      const doc = this.store.doc(projectId, hit.path);
      if (!doc) continue;
      const body = this.store.body(projectId, doc.id);
      const spans = parseNote(body).links;
      const lower = body.toLowerCase();
      for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
        if (spans.some((l) => at >= l.from && at < l.to)) continue;
        const line = body.slice(0, at).split("\n").length;
        out.push({ path: hit.path, title: hit.title, line, text: clipLine(body.split(/\r?\n/)[line - 1] ?? "") });
        break;
      }
    }
    return out;
  }

  // ── writing through ctx.files ───────────────────────────────────────────────

  /** Today's note, made from its date when it does not exist yet. */
  async journal(projectId: string, date: string): Promise<string> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Not a date: ${date}`);
    const folder = this.settings().journalFolder.replace(/^\/+|\/+$/g, "");
    const target = folder ? `${folder}/${date}.md` : `${date}.md`;
    if (!(await this.ctx.files.read(projectId, target))) {
      await this.ctx.files.save(projectId, target, `# ${date}\n\n`, { expect: null, message: `Started the journal for ${date}` });
    }
    return target;
  }

  /**
   * Keep links meaning what they meant after `from` moved to `to` (a file or a
   * whole folder): every note whose link resolved to a moved file, and every
   * moved note whose own relative links would now miss, is rewritten in one
   * version. Links are judged against the files as they were before the move,
   * so the index being a beat behind changes nothing.
   */
  async retarget(projectId: string, from: string, to: string): Promise<RetargetResult> {
    const dir = this.ctx.files.dirFor(projectId);
    if (!dir) return { files: 0, links: 0, ref: null };
    // A link written a moment ago must be among the candidates; rows read after the move map back below.
    await this.ready(projectId);
    const now = (await this.ctx.files.tree(projectId)).filter((e) => e.kind === "file").map((e) => e.path);
    const under = (p: string, base: string) => p === base || p.startsWith(`${base}/`);
    const back = (p: string) => (under(p, to) ? from + p.slice(to.length) : p);
    const moves = new Map<string, string>();
    for (const p of now) if (under(p, to)) moves.set(back(p), p);
    if (!moves.size) return { files: 0, links: 0, ref: null };
    const before = now.map(back);
    const names = new Set([...moves.keys()].map((p) => nameKey(isNotePath(p) ? noteName(p) : (p.split("/").pop() ?? p))));
    const candidates = new Set<string>();
    for (const n of names) for (const row of this.store.linksNamed(projectId, n)) candidates.add(moves.get(row.source) ?? row.source);
    for (const moved of moves.values()) if (isNotePath(moved)) candidates.add(moved);
    const entries: { path: string; body: string; expect: string }[] = [];
    let links = 0;
    for (const current of candidates) {
      if (!now.includes(current) || !isNotePath(current)) continue;
      let bytes: Buffer;
      try {
        bytes = await fs.promises.readFile(path.join(dir, ...current.split("/")));
      } catch {
        continue;
      }
      const text = bytes.toString("utf8");
      const was = back(current);
      const edits: { link: NoteLink; text: string }[] = [];
      for (const link of parseNote(text).links) {
        if (!link.target) continue;
        const meant = resolveLink(link, was, before);
        if (!meant) continue;
        const target = moves.get(meant) ?? meant;
        if (resolveLink(link, current, now) === target) continue;
        edits.push({ link, text: rewriteLink(link, target, current, now) });
      }
      if (!edits.length) continue;
      let next = text;
      for (const edit of [...edits].reverse()) next = next.slice(0, edit.link.from) + edit.text + next.slice(edit.link.to);
      entries.push({ path: current, body: next, expect: sha256(bytes) });
      links += edits.length;
    }
    if (!entries.length) return { files: 0, links: 0, ref: null };
    const label = isNotePath(to) ? noteName(to) : (to.split("/").pop() ?? to);
    const ref = await this.ctx.files.writeMany(projectId, entries, { message: `Updated ${links === 1 ? "a link" : `${links} links`} to ${label}` });
    return { files: entries.length, links, ref };
  }
}
