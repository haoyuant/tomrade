import type { Context } from "cordis";
import type { Starter } from "./start.js";
import type { CodeWords } from "./words.js";

/** What claiming came to: the ticket the conversation now writes for, and the branch it writes on when its workstream has a repository. */
export type ClaimResult = { ok: true; itemId: string; key: string; branch: string | null } | { ok: false; message: string };

export interface ClaimHost {
  ctx: Context;
  starter: Starter;
  words(): CodeWords;
  notify(projectId: string): void;
  /** A line of Tomrade's into the thread, on screen at once; `claimed` marks where its writing code for that ticket starts. */
  say(projectId: string, threadId: string, text: string, claimed?: string): void;
}

/**
 * A conversation in the assistant panel that turns to writing code claims a ticket for it: the one it is on, else
 * a new one named after the conversation. On a workstream with a repository the conversation's own copy moves onto
 * the ticket's branch, with what it changed already, and the ticket is tracked as Start tracks it — nothing is sent.
 * A note marks the moment: the conversation's writing code for that ticket starts there.
 */
export class Claims {
  constructor(private readonly host: ClaimHost) {}

  async claim(projectId: string, threadId: string): Promise<ClaimResult> {
    const { ctx } = this.host;
    const w = this.host.words();
    const agent = ctx.get("agent");
    const thread = agent?.store.thread(projectId, threadId);
    if (!agent || !thread) return { ok: false, message: `unknown thread ${threadId}` };
    if (thread.parentId || thread.execution || thread.surface !== "assistant") return { ok: false, message: w("claimNotHere") };
    let item = thread.itemId ? ctx.items.get(projectId, thread.itemId) : null;
    let made = false;
    if (!item) {
      const boardId = thread.boardId ?? ctx.boards.list(projectId)[0]?.id;
      if (!boardId) return { ok: false, message: w("claimNoWorkstream") };
      item = ctx.items.create({ projectId, boardId, title: thread.title.trim() || w("claimUntitled"), workType: "coding", by: "human" });
      made = true;
      agent.store.touchThread(projectId, threadId, { itemId: item.id });
    }
    const undo = () => {
      if (!made) return;
      agent.store.touchThread(projectId, threadId, { itemId: null });
      ctx.items.delete(projectId, item!.id, "human");
    };
    let branch: string | null = null;
    if (ctx.boards.get(projectId, item.boardId)?.repoId) {
      let started;
      try {
        started = await this.host.starter.start(projectId, item.id, { mode: "run", threadId, engine: thread.engine, claim: true });
      } catch (error) {
        undo();
        throw error;
      }
      if (!started.ok) {
        undo();
        return { ok: false, message: started.message };
      }
      branch = started.branch || null;
    } else if (item.status === "backlog" || item.status === "todo") ctx.items.update(projectId, item.id, { status: "doing" }, "human");
    // the moment is marked once per ticket: claiming the one it is on again draws no second line
    const marked = agent.store.messages(projectId, threadId).some((m) => m.block.type === "note" && m.block.claimed === item!.key);
    if (!marked) this.host.say(projectId, threadId, branch ? w("claimedOn", { key: item.key, branch }) : w("claimed", { key: item.key }), item.key);
    this.host.notify(projectId);
    return { ok: true, itemId: item.id, key: item.key, branch };
  }
}
