import fs from "node:fs";
import path from "node:path";
import type { Context } from "cordis";
import type { Author } from "@tomradex/domain";
import type { Git } from "@tomradex/git";
import { sameRepository } from "@tomradex/repos";
import { cursorHookReader } from "./cursor-hooks.js";
import type { Sessions } from "./sessions.js";
import type { CodeLinkStore, SessionView } from "./store.js";
import { errorMessage } from "@tomradex/contracts";

/** How often a repository's agent's hook events reach the database; memory has every one. */
const HOOK_HEARD_WRITE_MS = 60_000;

/** A conversation resumed this soon after its session ended goes on in that session; later, it starts a new one. */
const RESUME_WITHIN_MS = 24 * 3600_000;

/** Sessions that ended this close together ended with one agent process: parallel tickets of one conversation. */
const ENDED_TOGETHER_MS = 10_000;

/** The agent of a session known only by its MCP connection. */
export const MCP_AGENT = "mcp";


export interface ConnectionsDeps {
  ctx: Context;
  store: CodeLinkStore;
  sessions: Sessions;
  git: Git;
  /** Machine-local: each thread's worktree. */
  worktrees: Map<string, string>;
  sessionDir: (sessionId: string) => string;
  notify: (projectId: string) => void;
  /** Where herdr runs a session its hooks did not place. */
  findPane: (projectId: string, sessionId: string, payload: unknown) => void;
}

/**
 * Sessions Tomrade did not start: outside clients' MCP connections bound to
 * the sessions they claimed for, and tokenless hooks from a connected
 * repository matched to a session by where the agent runs.
 */
export class Connections {
  private readonly ctx: Context;
  private readonly store: CodeLinkStore;
  private readonly sessions: Sessions;
  private readonly git: Git;
  private readonly worktrees: Map<string, string>;
  private readonly sessionDir: ConnectionsDeps["sessionDir"];
  private readonly notify: ConnectionsDeps["notify"];
  private readonly findPane: ConnectionsDeps["findPane"];
  /** Folders hooks events came from that were already looked at for a checkout: one look per folder, not per event. */
  private readonly placeLooked = new Set<string>();
  /** Per `projectId\0repoId`, each agent's last hook event here and when it was last written down. */
  private readonly hooksHeard = new Map<string, Map<string, { at: number; written: number }>>();
  /** Cursor's hooks, read into Claude Code's shape; it remembers each conversation's last reply for its stop. */
  private readonly readCursorHook = cursorHookReader();
  /**
   * Which sessions each outside client's MCP connection claimed for — several when it works tickets in parallel —
   * and the one a call without a key means; in memory, so a restart asks the client to name its ticket again.
   */
  private readonly connections = new Map<string, { projectId: string; sessionIds: string[]; current: string }>();

  constructor(deps: ConnectionsDeps) {
    this.ctx = deps.ctx;
    this.store = deps.store;
    this.sessions = deps.sessions;
    this.git = deps.git;
    this.worktrees = deps.worktrees;
    this.sessionDir = deps.sessionDir;
    this.notify = deps.notify;
    this.findPane = deps.findPane;
  }

  /** Bind again the tokens of this machine's live terminal sessions — the ones a restart would otherwise have orphaned. Returns how many. */
  rebindSessions(projectId: string): number {
    let n = 0;
    for (const s of this.store.sessions(projectId, { live: true })) {
      if (s.mode !== "terminal" || s.device !== this.ctx.hub.deviceId || !s.threadId) continue;
      if (this.sessions.rebind(s, `ai:${s.agent}` as Author, this.sessionDir(s.id))) n += 1;
    }
    return n;
  }

  /** A session took a ticket on — its first, another beside it, or (`replace`) the next once the last is finished. */
  attach(projectId: string, sessionId: string, itemId: string, branch: string, delivery: number, opts: { replace?: boolean } = {}): void {
    const session = this.store.session(projectId, sessionId);
    if (!session) return;
    // A new delivery is new work: the branch merged in the last one must not be read as this one's.
    const fresh = opts.replace || (session.itemIds.includes(itemId) && session.delivery !== delivery);
    // The tickets it leaves keep it as history: their pages still reach the conversation that worked them.
    const left = opts.replace ? session.itemIds.filter((id) => id !== itemId).map((id) => ({ itemId: id, delivery: session.delivery })) : [];
    this.store.patchSession(projectId, sessionId, {
      ...(left.length ? { worked: [...session.worked.filter((w) => !left.some((l) => l.itemId === w.itemId && l.delivery === w.delivery)), ...left] } : {}),
      delivery,
      itemIds: opts.replace ? [itemId] : session.itemIds.includes(itemId) ? session.itemIds : [...session.itemIds, itemId],
      ...(session.branch && !fresh ? {} : { branch }),
      ...(session.state === "ended" ? {} : { state: "running" as const }),
      lastEventAt: Date.now()
    });
    this.notify(projectId);
  }

  /**
   * The hooks session a tokenless claim comes from: the one whose PreToolUse just
   * announced this claim; failing that, a guess — the latest live one on that
   * repository that holds no ticket and no client's connection yet.
   * The guess never takes one that already holds a ticket — that is another terminal's.
   */
  externalSession(projectId: string, repoId: string, key?: string): SessionView | null {
    const asked = key ? this.sessions.claimer(projectId, key) : null;
    const asking = asked ? this.store.session(projectId, asked) : null;
    if (asking && asking.repoId === repoId && asking.threadId === null && asking.endedAt === null && asking.state !== "ended" && asking.state !== "lost") return asking;
    const taken = new Set([...this.connections.values()].filter((c) => c.projectId === projectId).flatMap((c) => c.sessionIds));
    return this.store.sessions(projectId, { live: true }).find((s) => s.repoId === repoId && s.threadId === null && s.state !== "lost" && !s.itemIds.length && !taken.has(s.id)) ?? null;
  }

  /** A terminal session Start made for this ticket with an agent that reaches Tomrade without its token, which no connection has joined yet. */
  awaitingClaim(projectId: string, itemId: string): SessionView | null {
    const agent = this.ctx.get("agent");
    const taken = new Set([...this.connections.values()].filter((c) => c.projectId === projectId).flatMap((c) => c.sessionIds));
    return this.store.sessions(projectId, { live: true }).find((s) => s.mode === "terminal" && s.threadId !== null && s.itemIds.includes(itemId) && !taken.has(s.id)
      && !!agent?.engineOf(s.agent)?.terminal?.claims) ?? null;
  }

  /** The live session an outside client's connection last claimed for, if any: the one its calls without a key mean. */
  connected(projectId: string, connection: string): SessionView | null {
    const sessions = this.connectedSessions(projectId, connection);
    return sessions.find((s) => s.id === this.connections.get(connection)?.current) ?? null;
  }

  /** Every live session an outside client's connection claimed for; the ones that ended are let go. */
  connectedSessions(projectId: string, connection: string): SessionView[] {
    const bound = this.connections.get(connection);
    if (!bound || bound.projectId !== projectId) return [];
    const live = bound.sessionIds.map((id) => this.store.session(projectId, id)).filter((s): s is SessionView => !!s && s.endedAt === null && s.state !== "ended" && s.state !== "lost");
    if (!live.length) this.connections.delete(connection);
    else if (live.length !== bound.sessionIds.length) {
      const ids = live.map((s) => s.id);
      this.connections.set(connection, { projectId, sessionIds: ids, current: ids.includes(bound.current) ? bound.current : ids[ids.length - 1] });
    }
    return live;
  }

  /**
   * From now on this connection's calls without a key belong to the session; a connection it had before is let go.
   * The connection keeps the other sessions it works tickets in, except the one it is `leaving` for this one.
   */
  bindConnection(projectId: string, connection: string, sessionId: string, leaving?: string): void {
    for (const [other, bound] of this.connections) {
      if (other === connection || !bound.sessionIds.includes(sessionId)) continue;
      const rest = bound.sessionIds.filter((id) => id !== sessionId);
      if (!rest.length) this.connections.delete(other);
      else this.connections.set(other, { ...bound, sessionIds: rest, current: bound.current === sessionId ? rest[rest.length - 1] : bound.current });
    }
    const held = this.connections.get(connection);
    const kept = held?.projectId === projectId ? held.sessionIds.filter((id) => id !== sessionId && id !== leaving) : [];
    this.connections.set(connection, { projectId, sessionIds: [...kept, sessionId], current: sessionId });
  }

  boundAnywhere(sessionId: string): boolean {
    return [...this.connections.values()].some((c) => c.sessionIds.includes(sessionId));
  }

  /**
   * A session for a client that reports no hooks — Cursor, Gemini CLI, any MCP
   * client: followed only through its connection, so its notes and merge
   * hand-offs still reach the ticket. It ends when the connection closes.
   */
  connectionSession(projectId: string, repoId: string | null, worktree: string | null = null): SessionView {
    return this.store.createSession(projectId, { repoId: repoId ?? "", branch: "", itemIds: [], mode: "terminal", agent: MCP_AGENT, threadId: null, device: this.ctx.hub.deviceId, worktree });
  }

  /**
   * An outside agent that handed its ticket's merge to the person goes on to the next ticket as a
   * new session with the same identity, so its hooks and calls follow the new one (the newest is
   * matched first). The one it leaves keeps the ticket and the merge waiting on the person.
   */
  successor(projectId: string, from: SessionView, repoId: string | null, worktree: string | null = null): SessionView {
    return this.store.createSession(projectId, { repoId: repoId ?? from.repoId, branch: "", itemIds: [], mode: from.mode, agent: from.agent, threadId: null, device: this.ctx.hub.deviceId, externalId: from.externalId, worktree });
  }

  /**
   * A claim taken back: the session drops the ticket. One made only for claims — a client known by its
   * connection alone, or a parallel successor — ends once it holds nothing, so the agent's hooks reach its
   * other session again; the agent's own hooks session stays, free for its next claim.
   */
  letGo(projectId: string, connection: string, sessionId: string, itemId: string): void {
    const session = this.store.session(projectId, sessionId);
    if (!session) return;
    const rest = session.itemIds.filter((id) => id !== itemId);
    const forClaims = session.agent === MCP_AGENT
      || (!!session.externalId && this.store.sessions(projectId, { live: true }).some((s) => s.id !== session.id && s.agent === session.agent && s.externalId === session.externalId && s.startedAt <= session.startedAt));
    this.store.patchSession(projectId, sessionId, { itemIds: rest, ...(rest.length ? {} : { branch: "" }) });
    if (!rest.length && forClaims) {
      this.sessions.end(projectId, sessionId, "ended", true, "its claim was let go and it holds nothing");
      const bound = this.connections.get(connection);
      const kept = bound?.sessionIds.filter((id) => id !== sessionId) ?? [];
      if (!bound || !kept.length) this.connections.delete(connection);
      else this.connections.set(connection, { projectId, sessionIds: kept, current: bound.current === sessionId ? kept[kept.length - 1] : bound.current });
    }
    this.notify(projectId);
  }

  /**
   * A session another one took over from: nothing reaches it any more, so once its merge lands it is over.
   * Two sessions of one agent working in worktrees of their own run side by side; neither took over from the other.
   */
  superseded(projectId: string, s: SessionView): boolean {
    if (s.threadId !== null) return false;
    const apart = (o: SessionView) => !!s.worktree && !!o.worktree && s.worktree !== o.worktree;
    if (s.externalId) return this.store.sessions(projectId, { live: true }).some((o) => o.id !== s.id && o.agent === s.agent && o.externalId === s.externalId && o.startedAt >= s.startedAt && !apart(o));
    return s.agent === MCP_AGENT && !this.boundAnywhere(s.id);
  }

  disconnected(connection: string): void {
    const bound = this.connections.get(connection);
    if (!bound) return;
    this.connections.delete(connection);
    // A hooks session ends when its agent says so; one known only by its connection ends with it.
    for (const id of bound.sessionIds) {
      const session = this.store.session(bound.projectId, id);
      if (session?.agent === MCP_AGENT && !this.boundAnywhere(session.id)) this.sessions.end(bound.projectId, session.id, "ended", false, "its MCP connection closed");
    }
  }

  /** A hook fired without a token: match it to a session by where the agent runs — a Tomrade worktree, or someone's checkout. */
  externalEvent(raw: unknown): void {
    // Cursor's hooks post in its own names; the rest of this reads Claude Code's.
    const payload = (raw as { tomrade_agent?: unknown } | null)?.tomrade_agent === "cursor" ? this.readCursorHook(raw) : raw;
    if (!payload) return;
    const p = payload as { hook_event_name?: string; session_id?: string; cwd?: string; transcript_path?: string; tomrade_agent?: string; source?: string };
    if (!p.cwd || !p.session_id) return;
    const agent = p.tomrade_agent === "codex" || p.tomrade_agent === "workbuddy" || p.tomrade_agent === "pi" || p.tomrade_agent === "hermes" || p.tomrade_agent === "opencode" || p.tomrade_agent === "cursor" ? p.tomrade_agent : "claude-code";
    // Where the transcript lives tells which of the person's Claude Code accounts ran it.
    if (agent === "claude-code" && typeof p.transcript_path === "string") this.ctx.get("agent")?.engineOf("claude-code")?.local?.mcpLink?.sawTranscript?.(p.transcript_path);
    const cwd = path.resolve(p.cwd);
    const within = (root: string) => cwd === root || cwd.startsWith(root + path.sep);
    // Resumed, by hand or by herdr after its server restarted, or still going after another process of it ended
    // (`claude --continue` elsewhere): the conversation goes on in the session it had.
    if (p.hook_event_name !== "SessionEnd") this.continueEnded(agent, p.session_id);
    for (const [threadId, dir] of this.worktrees) {
      if (!within(path.resolve(dir))) continue;
      for (const projectId of this.ctx.db.openIds()) {
        const session = this.store.sessions(projectId, { live: true }).find((s) => s.threadId === threadId);
        if (session) {
          this.heardHook(projectId, session.repoId, agent);
          this.heard(projectId, session.id, payload);
          return;
        }
      }
      return;
    }
    const mine = (projectId: string) => this.store.sessions(projectId, { live: true }).filter((s) => s.threadId === null && s.agent === agent && s.externalId === p.session_id);
    // The agent itself is gone: every session it had, parallel or not, ends with it.
    const deliver = (projectId: string, sessions: SessionView[]) => {
      for (const s of p.hook_event_name === "SessionEnd" ? sessions : sessions.slice(0, 1)) this.heard(projectId, s.id, payload);
    };
    // One agent working tickets in parallel, each in a worktree it named: an event from inside one is that session's.
    for (const projectId of this.ctx.db.openIds()) {
      const all = mine(projectId);
      const placed = all.filter((s) => s.worktree && within(path.resolve(s.worktree))).sort((a, b) => b.worktree!.length - a.worktree!.length)[0];
      if (placed) {
        this.heardHook(projectId, placed.repoId, agent);
        deliver(projectId, [placed, ...all.filter((s) => s.id !== placed.id)]);
        return;
      }
    }
    for (const projectId of this.ctx.db.openIds()) {
      for (const repo of this.ctx.repos.list(projectId)) {
        const checkout = this.ctx.repos.checkout(repo.remote).checkout;
        if (!checkout || !within(path.resolve(checkout))) continue;
        this.heardHook(projectId, repo.id, agent);
        // Anywhere else in the checkout, the newest of its sessions there.
        const known = mine(projectId).filter((s) => s.repoId === repo.id);
        if (known.length) {
          deliver(projectId, known);
          return;
        }
        // The end of a session never heard of is nothing to record.
        if (p.hook_event_name === "SessionEnd") return;
        const created = this.store.createSession(projectId, { repoId: repo.id, branch: "", itemIds: [], mode: "terminal", agent, threadId: null, device: this.ctx.hub.deviceId, externalId: p.session_id ?? null });
        this.heard(projectId, created.id, payload);
        return;
      }
    }
    void this.placeFrom(cwd).catch((err) => this.ctx.logger.warn(`placing a checkout from ${cwd} failed: ${errorMessage(err)}`));
  }

  /** A connected repository's hook, for a session: recorded, and shown to plugins' hooks, which cannot answer it. */
  private heard(projectId: string, sessionId: string, payload: unknown): void {
    void this.sessions.hook(projectId, sessionId, payload, false).catch((err) => this.ctx.logger.warn(`a repository hook for ${sessionId}: ${errorMessage(err)}`));
    this.findPane(projectId, sessionId, payload);
  }

  /**
   * The newest sessions of an agent's conversation, ended within the day by its process ending, live again, ticket
   * and all — unless one of its sessions is still live, or its tickets are finished.
   */
  private continueEnded(agent: string, externalId: string): void {
    const now = Date.now();
    const ended: { projectId: string; session: SessionView }[] = [];
    const ownOf = (s: SessionView) => s.threadId === null && s.mode === "terminal" && s.agent === agent && s.externalId === externalId;
    // Asked on every hook: the live ones first, and the ended ones only when none is.
    if (this.ctx.db.openIds().some((projectId) => this.store.sessions(projectId, { live: true }).some((s) => ownOf(s) && s.state !== "lost"))) return;
    for (const projectId of this.ctx.db.openIds()) {
      const own = this.store.sessions(projectId).filter(ownOf);
      if (own.some((s) => s.state !== "ended" && s.state !== "lost")) return;
      for (const session of own) {
        if (session.state !== "ended" || !session.endedAt || now - session.endedAt > RESUME_WITHIN_MS) continue;
        const finished = session.itemIds.some((id) => {
          const status = this.ctx.items.get(projectId, id)?.status;
          return status === "done" || status === "cancelled";
        });
        if (!finished) ended.push({ projectId, session });
      }
    }
    if (!ended.length) return;
    const last = Math.max(...ended.map((e) => e.session.endedAt!));
    const changed = new Set<string>();
    for (const { projectId, session } of ended) {
      if (session.endedAt! < last - ENDED_TOGETHER_MS) continue;
      this.store.patchSession(projectId, session.id, { state: "running", endedAt: null });
      this.ctx.logger.info(`session ${session.id} (${agent} ${externalId}) lives again: its conversation goes on`);
      changed.add(projectId);
    }
    for (const projectId of changed) this.notify(projectId);
  }

  /** A repository's hooks reached this Tomrade. Claude Code posts on every tool call, so the database hears of it once a minute at most. */
  private heardHook(projectId: string, repoId: string, agent: string): void {
    const key = `${projectId}\0${repoId}`;
    const byAgent = this.hooksHeard.get(key) ?? new Map<string, { at: number; written: number }>();
    this.hooksHeard.set(key, byAgent);
    const at = Date.now();
    const seen = byAgent.get(agent);
    if (seen && at - seen.written < HOOK_HEARD_WRITE_MS) {
      seen.at = at;
      return;
    }
    this.store.noteHookHeard(projectId, repoId, agent, at);
    byAgent.set(agent, { at, written: at });
  }

  /** Each agent's last hook event from the repository on this machine: memory where it is newer than the database. */
  lastHooks(projectId: string, repoId: string): Record<string, number> {
    const last = this.store.hooksHeard(projectId, repoId);
    for (const [agent, { at }] of this.hooksHeard.get(`${projectId}\0${repoId}`) ?? []) last[agent] = Math.max(last[agent] ?? 0, at);
    return last;
  }

  /**
   * A coding session in a checkout, or a worktree of one, of a project repository this machine has
   * no checkout of: that checkout's main working tree is the repository's checkout from now on.
   */
  private async placeFrom(cwd: string): Promise<void> {
    if (this.placeLooked.has(cwd)) return;
    this.placeLooked.add(cwd);
    const common = await this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, ok: true });
    const gitDir = common.code === 0 ? common.stdout.trim() : "";
    // A bare repository, or a git dir kept apart from its working tree, has no main working tree to name.
    if (path.basename(gitDir) !== ".git") return;
    const top = path.dirname(gitDir);
    const origin = await this.git(["remote", "get-url", "origin"], { cwd: top, ok: true });
    if (origin.code !== 0 || !origin.stdout.trim()) return;
    for (const projectId of this.ctx.db.openIds()) {
      for (const repo of this.ctx.repos.list(projectId)) {
        const placed = this.ctx.repos.checkout(repo.remote).checkout;
        if (placed && fs.existsSync(placed)) continue;
        if (!(await sameRepository(origin.stdout.trim(), repo.remote))) continue;
        await this.ctx.repos.setCheckout(repo.remote, top);
      }
    }
  }
}
