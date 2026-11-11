import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Context, Service } from "cordis";
import type {} from "@tomradex/agent";
import type { SessionView } from "@tomradex/code-link";
import { errorMessage, localeOf } from "@tomradex/contracts";
import type {} from "@tomradex/db";
import { languageTag } from "@tomradex/domain";
import type {} from "@tomradex/hub";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/items";
import { reviewPrompt } from "./prompt.js";
import { MIGRATIONS, ReviewStore, TABLES, type ReviewComment, type ReviewDraft, type ReviewState } from "./store.js";
import { CHANGE_REVIEW_WORDS } from "./words.js";

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
  }
  interface Broadcasts {
    "changeReview.changed": (projectId: string, itemId: string) => void;
  }
}

/** The file in a session's folder its agent is told to read. */
const PROMPT_FILE = "review.md";

type Reached = { kind: "terminal" | "conversation"; session: SessionView };

/**
 * A person's comments on the lines of a ticket's diff, and the one act that hands them to the agent working the ticket.
 * Nothing goes to an agent, and nothing is typed into a terminal, except when the person sends.
 */
export class ChangeReview extends Service {
  static provide = "changeReview";
  static inject = ["db", "items", "hub", "codeLink"];

  private readonly home: Context;
  private readonly store: ReviewStore;

  constructor(ctx: Context) {
    super(ctx, "changeReview");
    this.home = ctx;
    this.store = new ReviewStore((projectId) => ctx.db.for(projectId));
  }

  [Service.init]() {
    this.home.db.migrate("changereview", MIGRATIONS, { tables: TABLES });
    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("changeReview.comments", (projectId, itemId) => ctx.changeReview.comments(projectId, itemId));
      ctx.ipc.handle("changeReview.add", (projectId, itemId, draft) => ctx.changeReview.add(projectId, itemId, draft));
      ctx.ipc.handle("changeReview.edit", (projectId, id, edit) => ctx.changeReview.edit(projectId, id, edit));
      ctx.ipc.handle("changeReview.remove", (projectId, id) => ctx.changeReview.remove(projectId, id));
      ctx.ipc.handle("changeReview.target", (projectId, itemId) => ctx.changeReview.target(projectId, itemId));
      ctx.ipc.handle("changeReview.send", (projectId, itemId, opts) => ctx.changeReview.send(projectId, itemId, opts));
      ctx.on("changeReview/changed", (projectId, itemId) => ctx.ipc.send("changeReview.changed", projectId, itemId));
    });
  }

  private words() {
    return CHANGE_REVIEW_WORDS(languageTag(localeOf(this.home)));
  }

  /** A ticket's comments on the code links it still has, oldest first. */
  comments(projectId: string, itemId: string): ReviewComment[] {
    if (!this.home.items.get(projectId, itemId)) return [];
    const links = new Set(this.home.codeLink.links(projectId, itemId).map((link) => link.id));
    return this.store.of(projectId, itemId).filter((comment) => links.has(comment.linkId));
  }

  add(projectId: string, itemId: string, draft: ReviewDraft): ReviewComment {
    if (!this.home.items.get(projectId, itemId)) throw new Error(`unknown ticket ${itemId}`);
    if (!this.home.codeLink.links(projectId, itemId).some((link) => link.id === draft.linkId)) throw new Error(`unknown code link ${draft.linkId}`);
    if (draft.side !== "old" && draft.side !== "new") throw new Error("a comment is on the old side or the new");
    if (!Number.isInteger(draft.line) || !Number.isInteger(draft.endLine) || draft.line < 1 || draft.endLine < draft.line) throw new Error("a comment is on a line, or a run of lines");
    const body = draft.body.trim();
    if (!draft.path || !body) throw new Error(this.words()("emptyComment"));
    const comment = this.store.add(projectId, itemId, randomUUID(), { ...draft, body }, Date.now());
    this.home.emit("changeReview/changed", projectId, itemId);
    return comment;
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
  private unsent(projectId: string, itemId: string): { comments: ReviewComment[]; branchOf: (linkId: string) => string | null } {
    const links = this.home.codeLink.links(projectId, itemId);
    const order = new Map(links.map((link, i) => [link.id, i]));
    const comments = this.store
      .of(projectId, itemId)
      .filter((c) => order.has(c.linkId) && c.state === "open" && c.sentAt === null)
      .sort((a, b) => order.get(a.linkId)! - order.get(b.linkId)! || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line || a.endLine - b.endLine || a.createdAt - b.createdAt);
    return { comments, branchOf: (linkId) => links.find((link) => link.id === linkId)?.branch || null };
  }

  /**
   * Every open comment not yet sent, as one prompt to the session working the ticket. A terminal's agent is told in one
   * line to read a file, never typed the text itself. With no session to reach, or `deliver: false`, the text comes back
   * for the person to pass on. Either way the comments are then sent; a delivery that fails leaves them as they were.
   */
  async send(projectId: string, itemId: string, opts: { deliver?: boolean } = {}): Promise<ReviewSent> {
    const item = this.home.items.get(projectId, itemId);
    const { comments, branchOf } = item ? this.unsent(projectId, itemId) : { comments: [], branchOf: () => null };
    if (!item || !comments.length) return { sent: 0, to: null, text: "" };
    const text = reviewPrompt(item.key, comments, branchOf);
    const reached = opts.deliver === false ? null : this.reach(projectId, itemId);
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
}
