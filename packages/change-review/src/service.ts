import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Context, Service } from "cordis";
import { z } from "zod";
import type { Engine, RunView, ThreadSummary } from "@tomradex/agent";
import type { CodeLinkView, SessionView } from "@tomradex/code-link";
import { errorMessage, localeOf } from "@tomradex/contracts";
import type {} from "@tomradex/db";
import { levelOf } from "@tomradex/dispatch";
import { languageTag, type Item } from "@tomradex/domain";
import type {} from "@tomradex/hub";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/items";
import type { SettingsSection } from "@tomradex/settings";
import { reviewPrompt, reviewerPrompt } from "./prompt.js";
import { MIGRATIONS, ReviewStore, TABLES, type AgentReview, type ReviewComment, type ReviewDraft, type ReviewFinding, type ReviewSeverity, type ReviewState } from "./store.js";
import { registerReviewTools } from "./tools.js";
import { CHANGE_REVIEW_WORDS } from "./words.js";

/** A coding agent that could review here, and why not when it cannot. */
export interface ReviewerChoice {
  id: string;
  title: string;
  ok: boolean;
  why?: string;
}

/** Who can review a ticket's changes on this machine. `pick` is the one a review starts with unless another is asked for. */
export interface ReviewerChoices {
  engines: ReviewerChoice[];
  pick: string | null;
  /** The engine of the session that works the ticket, when there is one: a review prefers another. */
  author: string | null;
}

/** A review as a person reads it. `stale`: the branch has moved since, so what it found is of older code. */
export interface AgentReviewView extends AgentReview {
  engineTitle: string;
  stale: boolean;
}

/** Findings that wait on the person, as a line for whatever reminds them. */
export interface ReviewNotice {
  key: string;
  projectId: string;
  itemId: string;
  threadId: string;
  agent: string;
  text: string;
}

interface Prefs {
  autoReview: boolean;
  autoHandBack: boolean;
}

const en = CHANGE_REVIEW_WORDS("en");
const zh = CHANGE_REVIEW_WORDS("zh");

/** Machine scope, and no agent access past reading: an agent never turns on what starts or wakes agents. */
const SECTION: SettingsSection<Prefs> = {
  id: "changeReview",
  title: en("settingsTitle"),
  description: en("settingsDescription"),
  schema: z.object({
    autoReview: z.boolean().default(false).meta({ title: en("autoReviewTitle") }).describe(en("autoReviewDescription")),
    autoHandBack: z.boolean().default(false).meta({ title: en("autoHandBackTitle") }).describe(en("autoHandBackDescription"))
  }),
  defaults: { autoReview: false, autoHandBack: false },
  order: 17,
  scope: "machine",
  agent: "read",
  words: {
    zh: {
      title: zh("settingsTitle"),
      description: zh("settingsDescription"),
      fields: {
        autoReview: { title: zh("autoReviewTitle"), description: zh("autoReviewDescription") },
        autoHandBack: { title: zh("autoHandBackTitle"), description: zh("autoHandBackDescription") }
      }
    }
  }
};

/** How often a review's findings go to the agent by themselves for one delivery of a ticket; past that they wait on the person. */
export const MAX_ROUNDS = 3;

export interface ChangeReviewConfig {
  /** How long after a ticket or its code changed the look for tickets to review waits, so a burst of changes is one look. */
  autoDelayMs?: number;
}

/** Where a ticket's comments would go: its session's terminal pane, its background conversation, or nowhere Tomrade can reach. */
export type ReviewTarget = { kind: "terminal" | "conversation"; sessionId: string; agent: string; agentTitle: string } | { kind: "none" };

/** What a send did: how many comments, where they went (null: nowhere, the text is for the person to pass on), and the text. */
export interface ReviewSent {
  sent: number;
  to: "terminal" | "conversation" | null;
  text: string;
}

export interface ReviewEdit {
  body?: string;
  state?: ReviewState;
}

declare module "cordis" {
  interface Context {
    changeReview: ChangeReview;
  }
  interface Events {
    "changeReview/changed"(projectId: string, itemId: string): void;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "changeReview.comments": (projectId: string, itemId: string) => ReviewComment[];
    "changeReview.add": (projectId: string, itemId: string, draft: ReviewDraft) => ReviewComment;
    "changeReview.edit": (projectId: string, id: string, edit: ReviewEdit) => ReviewComment | null;
    "changeReview.remove": (projectId: string, id: string) => boolean;
    "changeReview.target": (projectId: string, itemId: string) => ReviewTarget;
    /** `deliver: false` reaches no session: the comments count as sent and the text comes back to be copied. */
    "changeReview.send": (projectId: string, itemId: string, opts?: { deliver?: boolean }) => ReviewSent;
    "changeReview.reviewers": (projectId: string, itemId: string) => ReviewerChoices;
    /** Starts an agent's review of the ticket's changes in a session of its own; the one already going comes back instead of a second. */
    "changeReview.review": (projectId: string, itemId: string, opts?: { engine?: string }) => AgentReviewView;
    "changeReview.reviews": (projectId: string, itemId: string) => AgentReviewView[];
    /** The person has seen findings that waited on them: the reminder goes. */
    "changeReview.release": (projectId: string, itemId: string) => void;
  }
  interface Broadcasts {
    "changeReview.changed": (projectId: string, itemId: string) => void;
  }
}

/** The file in a session's folder its agent is told to read. */
const PROMPT_FILE = "review.md";

type Reached = { kind: "terminal" | "conversation"; session: SessionView };

/** The mode of an engine that changes nothing, when it has one. */
const readMode = (engine: Engine): string | null => engine.permissionModes?.choices.find((choice) => levelOf(choice.value) === "read")?.value ?? null;

/**
 * A person's comments on the lines of a ticket's diff, and the one act that hands them to the agent working the ticket;
 * and an agent's review of those changes, in a session that reads and changes nothing. Nothing is typed into a terminal
 * except when the person sends, and a review's findings go to the agent by themselves only where the person turned that on.
 */
export class ChangeReview extends Service {
  static provide = "changeReview";
  static inject = ["db", "items", "hub", "codeLink"];

  private readonly home: Context;
  private readonly store: ReviewStore;
  private readonly autoDelayMs: number;
  private readonly looks = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly looking = new Map<string, Promise<void>>();

  constructor(ctx: Context, config: ChangeReviewConfig = {}) {
    super(ctx, "changeReview");
    this.home = ctx;
    this.store = new ReviewStore((projectId) => ctx.db.for(projectId));
    this.autoDelayMs = config.autoDelayMs ?? 2000;
  }

  [Service.init]() {
    this.home.db.migrate("changereview", MIGRATIONS, { tables: TABLES });
    this.home.inject(["tools"], (ctx) => registerReviewTools(ctx));
    this.home.inject(["settings"], (ctx) => ctx.settings.register(SECTION));
    this.home.inject(["agent"], (ctx) => {
      ctx.on("agent/run-ended", (run, thread) => void this.settle(run, thread).catch((error: unknown) => this.home.logger("change-review").warn("a review could not be settled: %s", errorMessage(error))));
      // A review cannot have survived a restart: its conversation was stopped with the app.
      for (const projectId of ctx.db.openIds()) this.reconcile(projectId);
      ctx.on("db/opened", (projectId) => this.reconcile(projectId));
    });
    // A ticket is delivered, and its branch moves, through its code links: each such change is a reason to look.
    this.home.on("codeLink/changed", (projectId) => this.schedule(projectId));
    this.home.effect(() => () => {
      for (const timer of this.looks.values()) clearTimeout(timer);
      this.looks.clear();
    }, "change review looks");
    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("changeReview.comments", (projectId, itemId) => ctx.changeReview.comments(projectId, itemId));
      ctx.ipc.handle("changeReview.add", (projectId, itemId, draft) => ctx.changeReview.add(projectId, itemId, draft));
      ctx.ipc.handle("changeReview.edit", (projectId, id, edit) => ctx.changeReview.edit(projectId, id, edit));
      ctx.ipc.handle("changeReview.remove", (projectId, id) => ctx.changeReview.remove(projectId, id));
      ctx.ipc.handle("changeReview.target", (projectId, itemId) => ctx.changeReview.target(projectId, itemId));
      ctx.ipc.handle("changeReview.send", (projectId, itemId, opts) => ctx.changeReview.send(projectId, itemId, opts));
      ctx.ipc.handle("changeReview.reviewers", (projectId, itemId) => ctx.changeReview.reviewers(projectId, itemId));
      ctx.ipc.handle("changeReview.review", (projectId, itemId, opts) => ctx.changeReview.review(projectId, itemId, opts));
      ctx.ipc.handle("changeReview.reviews", (projectId, itemId) => ctx.changeReview.reviews(projectId, itemId));
      ctx.ipc.handle("changeReview.release", (projectId, itemId) => ctx.changeReview.release(projectId, itemId));
      ctx.on("changeReview/changed", (projectId, itemId) => ctx.ipc.send("changeReview.changed", projectId, itemId));
    });
  }

  private words() {
    return CHANGE_REVIEW_WORDS(languageTag(localeOf(this.home)));
  }

  /** A ticket's comments on the code links it still has, oldest first. */
  comments(projectId: string, itemId: string): ReviewComment[] {
    if (!this.home.items.get(projectId, itemId)) return [];
    const all = this.home.codeLink.links(projectId, itemId);
    const links = new Set(all.map((link) => link.id));
    const old = new Set(this.store.reviews(projectId, itemId).filter((review) => this.stale(review, all)).map((review) => review.id));
    return this.store
      .of(projectId, itemId)
      .filter((comment) => links.has(comment.linkId))
      .map((comment) => (comment.finding?.reviewId && old.has(comment.finding.reviewId) ? { ...comment, stale: true } : comment));
  }

  /** A comment has a ticket, a code link of it, a side and lines, and words; its words come back trimmed. */
  private checked(projectId: string, itemId: string, draft: ReviewDraft): ReviewDraft {
    if (!this.home.items.get(projectId, itemId)) throw new Error(`unknown ticket ${itemId}`);
    if (!this.home.codeLink.links(projectId, itemId).some((link) => link.id === draft.linkId)) throw new Error(`unknown code link ${draft.linkId}`);
    if (draft.side !== "old" && draft.side !== "new") throw new Error("a comment is on the old side or the new");
    if (!Number.isInteger(draft.line) || !Number.isInteger(draft.endLine) || draft.line < 1 || draft.endLine < draft.line) throw new Error("a comment is on a line, or a run of lines");
    const body = draft.body.trim();
    if (!draft.path || !body) throw new Error(this.words()("emptyComment"));
    return { linkId: draft.linkId, path: draft.path, side: draft.side, line: draft.line, endLine: draft.endLine, quote: draft.quote, body };
  }

  add(projectId: string, itemId: string, draft: ReviewDraft): ReviewComment {
    const comment = this.store.add(projectId, itemId, randomUUID(), this.checked(projectId, itemId, draft), Date.now());
    this.home.emit("changeReview/changed", projectId, itemId);
    return comment;
  }

  /**
   * A reviewing agent's findings, kept as comments it is named on and nobody has sent: the person reads them beside
   * their own, and sends or resolves them the same way. All of them are kept, or none when one has no place.
   */
  addFindings(projectId: string, itemId: string, found: (ReviewDraft & { severity: ReviewSeverity })[], by: Omit<ReviewFinding, "severity">): ReviewComment[] {
    const drafts = found.map((finding) => ({ draft: this.checked(projectId, itemId, finding), severity: finding.severity }));
    const comments = drafts.map(({ draft, severity }) => this.store.add(projectId, itemId, randomUUID(), draft, Date.now(), { ...by, severity }));
    if (comments.length) this.home.emit("changeReview/changed", projectId, itemId);
    return comments;
  }

  /**
   * Findings as a tool call brings them. The session that works a ticket reviews none of its own changes, and a finding
   * made in a review Tomrade started is kept with that review.
   */
  submitFindings(projectId: string, itemId: string, found: (ReviewDraft & { severity: ReviewSeverity })[], call: { by: ReviewFinding["reviewer"]; run?: { id: string; threadId: string }; connection?: string }): ReviewComment[] {
    const item = this.home.items.get(projectId, itemId);
    const thread = call.run ? this.home.get("agent")?.store.thread(projectId, call.run.threadId) : null;
    const outside = call.connection ? this.home.codeLink.connectedSessions(projectId, call.connection) : [];
    if (item && (thread?.itemId === itemId || outside.some((session) => session.itemIds.includes(itemId)))) throw new Error(this.words()("ownWork", { key: item.key }));
    const review = thread ? this.store.reviewOfThread(projectId, thread.id) : null;
    return this.addFindings(projectId, itemId, found, { reviewer: call.by, ...(call.run ? { runId: call.run.id } : {}), ...(review ? { reviewId: review.id } : {}) });
  }

  /** Null when the comment is not there. */
  edit(projectId: string, id: string, edit: ReviewEdit): ReviewComment | null {
    const before = this.store.get(projectId, id);
    if (!before) return null;
    const body = edit.body?.trim();
    if (body === "") throw new Error(this.words()("emptyComment"));
    if (edit.state !== undefined && edit.state !== "open" && edit.state !== "resolved") throw new Error("a comment is open or resolved");
    const patch = { ...(body !== undefined && body !== before.body ? { body } : {}), ...(edit.state !== undefined && edit.state !== before.state ? { state: edit.state } : {}) };
    if (!Object.keys(patch).length) return before;
    this.store.patch(projectId, id, patch, Date.now());
    this.home.emit("changeReview/changed", projectId, before.itemId);
    return this.store.get(projectId, id);
  }

  remove(projectId: string, id: string): boolean {
    const before = this.store.get(projectId, id);
    if (!before || !this.store.remove(projectId, id)) return false;
    this.home.emit("changeReview/changed", projectId, before.itemId);
    return true;
  }

  target(projectId: string, itemId: string): ReviewTarget {
    const reached = this.reach(projectId, itemId);
    return reached ? { kind: reached.kind, sessionId: reached.session.id, agent: reached.session.agent, agentTitle: this.titleOf(reached.session.agent) } : { kind: "none" };
  }

  private titleOf(agent: string): string {
    return this.home.get("agent")?.codeEngines().find((engine) => engine.id === agent)?.title ?? agent;
  }

  /**
   * The one session that works the ticket on this machine: its newest live one, else the newest it had. Only that one
   * is asked, so comments never start an older conversation beside the agent the person is with now.
   */
  private reach(projectId: string, itemId: string): Reached | null {
    const { codeLink, hub } = this.home;
    const sessions = codeLink.sessionsOf(projectId, itemId).filter((s) => s.device === hub.deviceId).sort((a, b) => b.startedAt - a.startedAt);
    const live = (s: SessionView) => s.state !== "ended" && s.state !== "lost";
    const session = sessions.find(live) ?? sessions[0];
    if (!session) return null;
    if (live(session) && codeLink.sessionPanel(projectId, session.id).input === "ok") return { kind: "terminal", session };
    // A background session's conversation takes words after its run ended: they start its next run.
    if (session.mode === "headless" && session.threadId && this.home.get("agent")?.store.thread(projectId, session.threadId)) return { kind: "conversation", session };
    return null;
  }

  /** Open comments the agent has not been sent, in the order a person reads a diff: by code link, file, then line. */
  private unsent(projectId: string, itemId: string, only?: (comment: ReviewComment) => boolean): { comments: ReviewComment[]; branchOf: (linkId: string) => string | null } {
    const links = this.home.codeLink.links(projectId, itemId);
    const order = new Map(links.map((link, i) => [link.id, i]));
    const comments = this.store
      .of(projectId, itemId)
      .filter((c) => order.has(c.linkId) && c.state === "open" && c.sentAt === null && (!only || only(c)))
      .sort((a, b) => order.get(a.linkId)! - order.get(b.linkId)! || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line || a.endLine - b.endLine || a.createdAt - b.createdAt);
    return { comments, branchOf: (linkId) => links.find((link) => link.id === linkId)?.branch || null };
  }

  /**
   * Every open comment not yet sent, as one prompt to the session working the ticket. A terminal's agent is told in one
   * line to read a file, never typed the text itself. With no session to reach, or `deliver: false`, the text comes back
   * for the person to pass on. Either way the comments are then sent; a delivery that fails leaves them as they were.
   */
  async send(projectId: string, itemId: string, opts: { deliver?: boolean } = {}): Promise<ReviewSent> {
    const sent = await this.pass(projectId, itemId, opts.deliver === false ? null : this.reach(projectId, itemId));
    // The person has dealt with what waited on them.
    if (sent.sent) this.release(projectId, itemId);
    return sent;
  }

  /** The open, unsent comments (`only`: those of them) as one prompt to `reached`, or as text alone when nobody is reached. */
  private async pass(projectId: string, itemId: string, reached: Reached | null, only?: (comment: ReviewComment) => boolean): Promise<ReviewSent> {
    const item = this.home.items.get(projectId, itemId);
    const { comments, branchOf } = item ? this.unsent(projectId, itemId, only) : { comments: [], branchOf: () => null };
    if (!item || !comments.length) return { sent: 0, to: null, text: "" };
    const text = reviewPrompt(item.key, comments, branchOf);
    if (reached) await this.deliver(projectId, item.key, reached, comments, text);
    this.store.sent(projectId, comments.map((c) => c.id), Date.now());
    this.home.emit("changeReview/changed", projectId, itemId);
    return { sent: comments.length, to: reached?.kind ?? null, text };
  }

  private async deliver(projectId: string, key: string, reached: Reached, comments: ReviewComment[], text: string): Promise<void> {
    const w = this.words();
    const { session } = reached;
    const agent = this.titleOf(session.agent);
    if (reached.kind === "terminal") {
      const file = path.join(this.home.codeLink.sessionDir(session.id), PROMPT_FILE);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      } catch (error) {
        throw new Error(w("sendFailed", { agent, why: errorMessage(error) }));
      }
      const took = await this.home.codeLink.sessionSay(projectId, session.id, `Tomrade: review comments on ${key} — read ${file} and address them.`).catch(() => false);
      if (!took) throw new Error(w("paneRefused", { agent }));
      return;
    }
    // The same comments in the same words are one request: a retry after a lost answer starts no second run.
    const batch = createHash("sha256").update(comments.map((c) => `${c.id}:${c.updatedAt}`).join("\n")).digest("hex").slice(0, 32);
    try {
      this.home.get("agent")!.send(projectId, session.threadId!, { kind: "text", text }, { requestId: `change-review:${batch}`, source: { kind: "change-review" } });
    } catch (error) {
      throw new Error(w("sendFailed", { agent, why: errorMessage(error) }));
    }
  }

  private prefs(): Prefs {
    return { ...SECTION.defaults, ...(this.home.get("settings")?.get().changeReview as Partial<Prefs> | undefined) };
  }

  /** The code links of the ticket's newest delivery that have a branch still unmerged: what a review reads. */
  private current(projectId: string, itemId: string): CodeLinkView[] {
    const links = this.home.codeLink.links(projectId, itemId).filter((link) => link.branch && !link.mergedSha);
    const delivery = Math.max(0, ...links.map((link) => link.delivery));
    return links.filter((link) => link.delivery === delivery);
  }

  /**
   * Whether a branch a review read has moved since. The tip Tomrade last saw may trail the tip the review read, so a
   * link counts as moved only when its tip is neither of the two the review started from.
   */
  private stale(review: AgentReview, links: CodeLinkView[]): boolean {
    return links.some((link) => {
      const read = review.heads[link.id];
      return !!read && !!link.headSha && link.headSha !== read.head && link.headSha !== read.seen;
    });
  }

  private view(review: AgentReview, links: CodeLinkView[]): AgentReviewView {
    return { ...review, engineTitle: this.titleOf(review.engine), stale: this.stale(review, links) };
  }

  /** A ticket's agent reviews, newest first. */
  reviews(projectId: string, itemId: string): AgentReviewView[] {
    if (!this.home.items.get(projectId, itemId)) return [];
    const links = this.home.codeLink.links(projectId, itemId);
    return this.store.reviews(projectId, itemId).map((review) => this.view(review, links));
  }

  /** The engine that works the ticket here: its newest session's, else the one its branch was started with. */
  private authorOf(projectId: string, itemId: string): string | null {
    const agent = this.home.get("agent");
    const { codeLink, hub } = this.home;
    const session = codeLink.sessionsOf(projectId, itemId).filter((s) => s.device === hub.deviceId).sort((a, b) => b.startedAt - a.startedAt)[0];
    const threadId = this.current(projectId, itemId).find((link) => link.threadId)?.threadId;
    const engine = session?.agent ?? (threadId ? agent?.store.thread(projectId, threadId)?.engine : null) ?? null;
    return engine && agent ? agent.answering(engine) : engine;
  }

  /** The coding agents here and whether each can review: one that runs inside Tomrade, is ready, and has a mode that changes nothing. */
  async reviewers(projectId: string, itemId: string): Promise<ReviewerChoices> {
    const agent = this.home.get("agent");
    const author = this.authorOf(projectId, itemId);
    if (!agent) return { engines: [], pick: null, author };
    const w = this.words();
    const engines = await Promise.all(
      agent.codeEngines().map(async (engine): Promise<ReviewerChoice> => {
        const choice = { id: engine.id, title: engine.title };
        if (engine.terminal?.mode === "only") return { ...choice, ok: false, why: w("terminalOnly") };
        if (!readMode(engine)) return { ...choice, ok: false, why: w("noReadMode") };
        const state = await engine.available().catch((error: unknown) => ({ ok: false, reason: errorMessage(error) }));
        return state.ok ? { ...choice, ok: true } : { ...choice, ok: false, why: state.reason ?? "not available" };
      })
    );
    const ready = engines.filter((engine) => engine.ok);
    return { engines, pick: (ready.find((engine) => engine.id !== author) ?? ready[0])?.id ?? null, author };
  }

  /**
   * Starts an agent's review of the ticket's changes: a new conversation that implements nothing, in the engine's
   * read-only mode, told the ticket and where to read the change — never what the session working the ticket said.
   * A review of the ticket already going comes back instead of a second.
   */
  async review(projectId: string, itemId: string, opts: { engine?: string; askedBy?: AgentReview["askedBy"] } = {}): Promise<AgentReviewView> {
    const w = this.words();
    const item = this.home.items.get(projectId, itemId);
    if (!item) throw new Error(`unknown ticket ${itemId}`);
    const agent = this.home.get("agent");
    const going = this.store.reviews(projectId, itemId).find((review) => review.state === "running");
    if (going) return this.view(going, this.home.codeLink.links(projectId, itemId));
    const links = this.current(projectId, itemId);
    const heads: AgentReview["heads"] = {};
    for (const link of links) {
      const read = await this.home.codeLink.changes(projectId, itemId, { linkId: link.id }).catch(() => null);
      if (read?.head) heads[link.id] = { head: read.head, seen: link.headSha };
    }
    if (!agent || !Object.keys(heads).length) throw new Error(w("nothingToReview", { key: item.key }));
    const choices = await this.reviewers(projectId, itemId);
    const asked = opts.engine ? choices.engines.find((engine) => engine.id === agent.answering(opts.engine!)) : null;
    if (opts.engine && !asked?.ok) throw new Error(w("notReviewer", { agent: asked?.title ?? opts.engine, why: asked?.why ?? "unknown" }));
    const engineId = asked?.id ?? choices.pick;
    const engine = engineId ? agent.engineOf(engineId) : undefined;
    const mode = engine ? readMode(engine) : null;
    if (!engine || !mode) throw new Error(w("noReviewer", { why: choices.engines.map((e) => `${e.title}: ${e.why}`).join(" · ") || w("noReviewerAtAll") }));
    // A person asking again has seen what waited on them.
    if (opts.askedBy !== "auto") this.release(projectId, itemId);
    const thread = agent.newThread(projectId, engine.id, item.boardId, { title: w("reviewTitle", { key: item.key }) });
    agent.setPermissionMode(projectId, thread.id, mode);
    const review = this.store.addReview(projectId, {
      id: randomUUID(), itemId, delivery: links[0]!.delivery, engine: engine.id, same: engine.id === choices.author,
      threadId: thread.id, heads, askedBy: opts.askedBy ?? "person", startedAt: Date.now()
    });
    try {
      agent.send(projectId, thread.id, { kind: "text", text: reviewerPrompt(item) }, { requestId: `change-review:review:${review.id}`, source: { kind: "change-review" } });
    } catch (error) {
      this.store.patchReview(projectId, review.id, { state: "failed", error: errorMessage(error), findings: 0, endedAt: Date.now() });
      this.home.emit("changeReview/changed", projectId, itemId);
      throw error;
    }
    this.home.emit("changeReview/changed", projectId, itemId);
    return this.view(this.store.review(projectId, review.id)!, this.home.codeLink.links(projectId, itemId));
  }

  /** A review's conversation stopped: what it found is counted, and where the person asked for it, handed on. */
  private async settle(run: RunView, thread: ThreadSummary): Promise<void> {
    const projectId = thread.projectId;
    const review = this.store.reviewOfThread(projectId, thread.id);
    // `asked`: it waits on the person, and goes on when they answer.
    if (!review || review.state !== "running" || run.status === "running" || run.status === "asked") return;
    const findings = this.store.of(projectId, review.itemId).filter((comment) => comment.finding?.reviewId === review.id).length;
    const state = run.status === "done" ? "done" : run.status === "cancelled" ? "cancelled" : "failed";
    this.store.patchReview(projectId, review.id, { state, findings, error: state === "failed" ? (run.error ?? run.stop) : null, endedAt: Date.now() });
    this.home.emit("changeReview/changed", projectId, review.itemId);
    if (state === "done" && findings > 0 && this.prefs().autoHandBack) await this.handBack(projectId, this.store.review(projectId, review.id)!);
    this.schedule(projectId);
  }

  /**
   * A review's findings go to the conversation working the ticket without the person, at most `MAX_ROUNDS` times for one
   * delivery. Nothing is typed into a terminal for it: there, and past the limit, the findings wait on the person.
   */
  private async handBack(projectId: string, review: AgentReview): Promise<void> {
    const hold = () => {
      this.store.patchReview(projectId, review.id, { held: true });
      this.home.emit("changeReview/changed", projectId, review.itemId);
    };
    // Findings on code that has since changed are for the person to judge.
    if (this.stale(review, this.home.codeLink.links(projectId, review.itemId))) return;
    const reached = this.reach(projectId, review.itemId);
    if (this.rounds(projectId, review) >= MAX_ROUNDS || reached?.kind !== "conversation") return hold();
    try {
      const sent = await this.pass(projectId, review.itemId, reached, (comment) => comment.finding?.reviewId === review.id);
      if (sent.sent) this.store.patchReview(projectId, review.id, { handedAt: Date.now() });
      this.home.emit("changeReview/changed", projectId, review.itemId);
    } catch {
      hold();
    }
  }

  /** How many reviews of this delivery already went to the agent by themselves. */
  private rounds(projectId: string, review: Pick<AgentReview, "itemId" | "delivery">): number {
    return this.store.reviews(projectId, review.itemId).filter((r) => r.delivery === review.delivery && r.handedAt !== null).length;
  }

  /** The person has seen what waited on them for this ticket. */
  release(projectId: string, itemId: string): void {
    const held = this.store.reviews(projectId, itemId).filter((review) => review.held);
    if (!held.length) return;
    for (const review of held) this.store.patchReview(projectId, review.id, { held: false });
    this.home.emit("changeReview/changed", projectId, itemId);
  }

  /** What waits on the person, in their language: findings nobody could be told, or a back and forth that reached its limit. */
  notices(): ReviewNotice[] {
    const w = this.words();
    const out: ReviewNotice[] = [];
    for (const projectId of this.home.db.openIds()) {
      for (const review of this.store.heldReviews(projectId)) {
        const item = this.home.items.get(projectId, review.itemId);
        if (!item || item.status === "done" || item.status === "cancelled") continue;
        const rounds = this.rounds(projectId, review);
        const text = review.handedAt !== null ? w("heldRounds", { key: item.key, rounds }) : rounds >= MAX_ROUNDS ? w("heldLimit", { key: item.key, n: review.findings ?? 0, rounds }) : w("heldNobody", { key: item.key, n: review.findings ?? 0 });
        out.push({ key: review.id, projectId, itemId: review.itemId, threadId: review.threadId, agent: review.engine, text });
      }
    }
    return out;
  }

  /** A review still marked as going when no run of its conversation is, and none waits on an answer: the app closed under it. */
  private reconcile(projectId: string): void {
    const agent = this.home.get("agent");
    if (!agent) return;
    const live = new Set(agent.activeRuns().map(({ thread }) => thread.id));
    for (const review of this.store.runningReviews(projectId)) {
      if (live.has(review.threadId) || agent.store.pending(projectId, review.threadId)) continue;
      const findings = this.store.of(projectId, review.itemId).filter((comment) => comment.finding?.reviewId === review.id).length;
      this.store.patchReview(projectId, review.id, { state: "failed", findings, error: this.words()("reviewInterrupted"), endedAt: Date.now() });
      this.home.emit("changeReview/changed", projectId, review.itemId);
    }
  }

  private schedule(projectId: string): void {
    if (!this.prefs().autoReview || this.looks.has(projectId)) return;
    const timer = setTimeout(() => {
      this.looks.delete(projectId);
      void this.look(projectId);
    }, this.autoDelayMs);
    timer.unref?.();
    this.looks.set(projectId, timer);
  }

  /**
   * Where reviews start by themselves: the project's delivered tickets are looked through, and the first whose current
   * commit no agent has reviewed gets one. One at a time: the next look comes when that review ends.
   */
  look(projectId: string): Promise<void> {
    const going = this.looking.get(projectId);
    if (going) return going;
    const run = (async () => {
      if (!this.prefs().autoReview || !this.home.db.has(projectId)) return;
      if (this.store.runningReviews(projectId).length) return;
      for (const item of this.home.items.list({ projectId, status: "verifying", workType: "coding" })) {
        if (await this.reviewDue(projectId, item)) {
          await this.review(projectId, item.id, { askedBy: "auto" }).catch((error: unknown) => this.home.logger("change-review").warn("%s was not reviewed: %s", item.key, errorMessage(error)));
          return;
        }
      }
    })().finally(() => this.looking.delete(projectId));
    this.looking.set(projectId, run);
    return run;
  }

  /** Whether a delivered ticket should be reviewed now without being asked: its commit is unreviewed, nobody is at it, and the person is not owed a look first. */
  private async reviewDue(projectId: string, item: Item): Promise<boolean> {
    const links = this.current(projectId, item.id);
    if (!links.length) return false;
    const delivery = links[0]!.delivery;
    const reviews = this.store.reviews(projectId, item.id).filter((review) => review.delivery === delivery);
    if (reviews.some((review) => review.held)) return false;
    // The agent is still at it: its next stop is another change to the ticket's code, and another look.
    const working = this.home.codeLink.sessionsOf(projectId, item.id, { live: true }).some((session) => session.state === "running");
    if (working) return false;
    const last = reviews[0];
    if (last) {
      // One review per commit, however it ended.
      let moved = false;
      for (const link of links) {
        const read = last.heads[link.id];
        const tip = link.headSha && (link.headSha === read?.head || link.headSha === read?.seen) ? read!.head : ((await this.home.codeLink.changes(projectId, item.id, { linkId: link.id }).catch(() => null))?.head ?? null);
        if (tip && tip !== read?.head) moved = true;
      }
      if (!moved) return false;
      if (this.rounds(projectId, last) >= MAX_ROUNDS) {
        // The back and forth has had its rounds: the change now waits on the person, and no session is started for it.
        this.store.patchReview(projectId, last.id, { held: true });
        this.home.emit("changeReview/changed", projectId, item.id);
        return false;
      }
    }
    return true;
  }
}
