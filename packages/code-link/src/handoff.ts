import fs from "node:fs";
import type { Context } from "cordis";
import type { Agent, ThreadSummary } from "@tomradex/agent";
import { agentWorkspace } from "@tomradex/engine-kit";
import type { HerdrBridge } from "./herdr-bridge.js";
import type { Sessions } from "./sessions.js";
import type { Starter } from "./start.js";
import type { CodeLinkStore, SessionView } from "./store.js";
import type { CodeWords } from "./words.js";

/** Why a conversation cannot go to a terminal cell right now; a screen says each in its own words. */
export type HandoffRefusal = "builtin" | "noSession" | "running" | "waiting" | "archived" | "noMcp";

/** Where a conversation runs, for the assistant panel: here, on its engine's SDK, or in a terminal as a session of its own. */
export interface HandoffView {
  where: "here" | "terminal";
  /** Here: whether it can go to a terminal cell now, else why not. */
  toTerminal: { ok: boolean; reason?: HandoffRefusal };
  /** In a terminal: the session it runs as, and whether its CLI still runs there — then it cannot come back yet. */
  terminal: { sessionId: string; live: boolean; pane: string | null; agent: string } | null;
}

export type HandoffResult = { ok: true; sessionId: string; pane: string | null; launched: boolean; warnings?: string[] } | { ok: false; message: string };

export interface HandoffHost {
  ctx: Context;
  store: CodeLinkStore;
  sessions: Sessions;
  starter: Starter;
  herdr: HerdrBridge;
  words(): CodeWords;
  notify(projectId: string): void;
  /** A line of Tomrade's into the thread, on screen at once. */
  say(projectId: string, threadId: string, text: string): void;
}

/** What the CLI is told first when it takes a free conversation up in a terminal; a ticket's gets Start's continue brief. */
export const HANDOFF_PROMPT = "Tomrade: this conversation continues here, in a terminal, from Tomrade's assistant panel. Its session was resumed, so everything said so far is yours, and Tomrade's tools and hooks are connected again. Carry on with what was asked last; if nothing is pending, say in one line that you are here and wait for the person.\n";

const OPEN = new Set(["backlog", "todo", "doing", "verifying"]);
const live = (s: SessionView): boolean => s.state !== "ended" && s.state !== "lost";

/**
 * A conversation moving between the assistant panel and a terminal cell, one process on its session at a time.
 * To a terminal: the thread's warm runtime is closed, and its engine's CLI resumes the same session there as a
 * terminal session of the thread — a ticket's through Start (its brief, its claim, its branch), a free one in
 * the folder its runs use. Back, once that CLI exited: the next message resumes the session through the SDK
 * again, with what the hooks learned of its id. Where a conversation is reads from the thread's surface and its
 * sessions, both kept, so a restart loses nothing.
 */
export class Handoff {
  constructor(private readonly host: HandoffHost) {}

  private agent(): Agent | undefined {
    return this.host.ctx.get("agent");
  }

  /** The thread's newest terminal session, a live one first; null when it never went to a terminal. */
  private terminalSessionOf(projectId: string, threadId: string): SessionView | null {
    const own = this.host.store.sessions(projectId).filter((s) => s.threadId === threadId && s.mode === "terminal");
    return own.find(live) ?? own[0] ?? null;
  }

  private engineOf(agent: Agent, thread: ThreadSummary) {
    return agent.codeEngines().find((e) => e.id === agent.answering(thread.engine)) ?? null;
  }

  /** The engine's own session on the thread, else one an engine it took in left there. */
  private externalOf(agent: Agent, thread: ThreadSummary, engine: { id: string; includes?: string[] }): string | null {
    const external = agent.store.external(thread.projectId, thread.id);
    return external[engine.id] ?? engine.includes?.map((id) => external[id]).find(Boolean) ?? null;
  }

  private refusal(agent: Agent, thread: ThreadSummary): HandoffRefusal | null {
    if (thread.archived) return "archived";
    const engine = this.engineOf(agent, thread);
    if (!engine || engine.terminal?.mode === "none") return "builtin";
    if (!this.externalOf(agent, thread, engine)) return "noSession";
    if (agent.activeRuns().some((a) => a.thread.id === thread.id)) return "running";
    if (agent.store.pending(thread.projectId, thread.id)) return "waiting";
    if (!this.host.ctx.get("mcp")?.url) return "noMcp";
    return null;
  }

  view(projectId: string, threadId: string): HandoffView {
    const agent = this.agent();
    const thread = agent?.store.thread(projectId, threadId);
    if (!agent || !thread) return { where: "here", toTerminal: { ok: false, reason: "builtin" }, terminal: null };
    const session = thread.surface === "code" ? this.terminalSessionOf(projectId, threadId) : null;
    if (session) return { where: "terminal", toTerminal: { ok: false, reason: "running" }, terminal: { sessionId: session.id, live: live(session), pane: session.herdrPane, agent: session.agent } };
    const refusal = this.refusal(agent, thread);
    return { where: "here", toTerminal: refusal ? { ok: false, reason: refusal } : { ok: true }, terminal: null };
  }

  /** The reason a send into the thread is refused while its agent is in a terminal; nothing otherwise. */
  refuseSend(thread: ThreadSummary): string | undefined {
    const session = this.host.starter.liveTerminalSession(thread.projectId, thread.id);
    if (!session) return undefined;
    const w = this.host.words();
    return w("handoffGoesOn", { agent: this.titleOf(session.agent), pane: session.herdrPane ? w("handoffPane", { pane: session.herdrPane }) : "" });
  }

  private titleOf(engineId: string): string {
    const agent = this.agent();
    return (agent && agent.codeEngines().find((e) => e.id === agent.answering(engineId))?.title) ?? engineId;
  }

  private reasonText(reason: HandoffRefusal, engine: string): string {
    const w = this.host.words();
    switch (reason) {
      case "archived": return w("handoffArchived");
      case "builtin": return w("handoffBuiltin", { agent: engine });
      case "noSession": return w("handoffNoSession", { agent: engine });
      case "running": return w("handoffRunning");
      case "waiting": return w("handoffWaiting");
      case "noMcp": return "the MCP server is not running — enable the mcp plugin";
    }
  }

  /** The conversation to a terminal cell: its runtime here closed first, so the CLI is the one process on its session. */
  async toTerminal(projectId: string, threadId: string): Promise<HandoffResult> {
    const agent = this.agent();
    const thread = agent?.store.thread(projectId, threadId);
    if (!agent || !thread) return { ok: false, message: `unknown thread ${threadId}` };
    const w = this.host.words();
    const view = this.view(projectId, threadId);
    if (view.where === "terminal") return { ok: false, message: w("handoffAlreadyThere") };
    const engine = this.engineOf(agent, thread);
    if (!view.toTerminal.ok || !engine) return { ok: false, message: this.reasonText(view.toTerminal.reason ?? "builtin", engine?.title ?? thread.engine) };
    agent.releaseRuntime(projectId, threadId);
    let result;
    if (thread.itemId) {
      // The ticket's tracking moves to the terminal session: the headless one ends here, so nothing shows twice.
      const headless = this.host.store.sessions(projectId, { live: true }).filter((s) => s.threadId === threadId && s.mode === "headless");
      for (const s of headless) this.host.sessions.end(projectId, s.id, "ended", true, "the conversation went to a terminal");
      result = await this.host.starter.start(projectId, thread.itemId, { mode: "terminal", threadId, engine: engine.id });
      // Refused: it stays here, and so does the ticket's tracking.
      if (!result.ok && headless[0]) this.ensureHeadlessSession(projectId, thread, headless[0], agent.answering(thread.engine));
    } else {
      const where = await agent.workdir(projectId, threadId, { create: true });
      if (where.problem) return { ok: false, message: where.problem };
      // The folder the thread's runs use: a worktree of its workstream, else the thread's own workspace folder.
      const cwd = where.cwd ?? agentWorkspace(projectId, threadId);
      fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
      result = await this.host.starter.startThread(projectId, thread, { cwd, externalId: this.externalOf(agent, thread, engine)!, prompt: HANDOFF_PROMPT });
    }
    if (!result.ok) return { ok: false, message: result.message };
    const pane = result.pane ?? null;
    this.host.say(projectId, threadId, w("handoffToTerminal", { agent: engine.title, pane: pane ? w("handoffPane", { pane }) : "" }));
    return { ok: true, sessionId: result.sessionId, pane, launched: result.launched, ...(result.warnings?.length ? { warnings: result.warnings } : {}) };
  }

  /** The conversation back to the panel, once its CLI exited: the next message resumes the same session through the SDK. */
  async backToPanel(projectId: string, threadId: string): Promise<HandoffResult> {
    const agent = this.agent();
    const thread = agent?.store.thread(projectId, threadId);
    if (!agent || !thread) return { ok: false, message: `unknown thread ${threadId}` };
    const w = this.host.words();
    const view = this.view(projectId, threadId);
    if (view.where !== "terminal" || !view.terminal) return { ok: false, message: w("handoffNotThere") };
    const session = this.host.store.session(projectId, view.terminal.sessionId)!;
    const title = this.titleOf(session.agent);
    const pane = session.herdrPane;
    // Its session ended as far as the hooks and the process say; a pane that still shows the agent says otherwise.
    const stillThere = view.terminal.live || (!!pane && (await this.host.herdr.paneAlive(pane)) === true && !!(await this.host.herdr.pane(pane))?.agent);
    if (stillThere) return { ok: false, message: w("handoffStillRunning", { agent: title, pane: pane ? w("handoffPane", { pane }) : "" }) };
    const engineId = agent.answering(session.agent);
    // The hooks heard the CLI's session id as it ran: the one the next SDK turn resumes.
    if (session.externalId) agent.store.setExternal(projectId, threadId, engineId, session.externalId);
    if (thread.itemId) this.ensureHeadlessSession(projectId, thread, session, engineId);
    agent.store.touchThread(projectId, threadId, { surface: "assistant" });
    this.host.say(projectId, threadId, w("handoffBack", { agent: title }));
    this.host.notify(projectId);
    return { ok: true, sessionId: session.id, pane: null, launched: false };
  }

  /** A ticket's headless session again, idle, so the runs that follow are tracked on the ticket as before — while it is open. */
  private ensureHeadlessSession(projectId: string, thread: ThreadSummary, from: SessionView, engineId: string): void {
    const item = thread.itemId ? this.host.ctx.items.get(projectId, thread.itemId) : null;
    if (!item || !OPEN.has(item.status)) return;
    const store = this.host.store;
    if (store.sessions(projectId, { live: true }).some((s) => s.threadId === thread.id && s.mode === "headless" && s.state !== "lost")) return;
    const session = store.createSession(projectId, {
      repoId: from.repoId, delivery: from.delivery, branch: from.branch, itemIds: from.itemIds.length ? from.itemIds : [item.id],
      mode: "headless", agent: engineId, threadId: thread.id, device: this.host.ctx.hub.deviceId, externalId: from.externalId
    });
    store.patchSession(projectId, session.id, { state: "idle", activity: null, lastEventAt: Date.now() });
  }
}
