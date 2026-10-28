import path from "node:path";
import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/agent";
import type {} from "@tomradex/boards";
import type {} from "@tomradex/items";
import { remoteIdentity } from "@tomradex/repos";
import type {} from "@tomradex/storage";
import type { Item } from "@tomradex/domain";
import { defineTool, requireProjectId, type ToolInvocation } from "@tomradex/tools";
import { covered, listDecisions, recordDecision } from "./decisions.js";
import { DEFAULT_BRANCH_TEMPLATE, branchFor, titleSlug } from "./keys.js";
import { CODE_WORDS } from "./words.js";
import type {} from "@tomradex/settings";
import { mergeLine } from "./prompts.js";
import { END_AFTER_MS, sessionContext } from "./sessions.js";
import type { CodeLinkStore, CodeLinkView, SessionView } from "./store.js";
import type { PrState } from "./rules.js";
import type { CodeSummaryView, StartBatchCard, StartBatchEntry, StartBatchRequest, StartConfig } from "./service.js";
import type { MergeLocalResult } from "./landing.js";
import { errorMessage } from "@tomradex/contracts";

/** What the tools need from the service without importing it. */
export interface ToolHost {
  store: CodeLinkStore;
  /** Re-judge one ticket in one repository after a link changed by hand or by tool. */
  reevaluate(projectId: string, itemId: string, repoId: string): void;
  /** A repository with no remote has no pull request: the session's scoped link moves the ticket to Verifying. */
  handOver(projectId: string, itemId: string, repoId: string): void;
  /** The work is linked on `branch`: the branch a claim suggested, still empty, goes, and the sessions on it move to `branch`. */
  dropSuggested(projectId: string, itemId: string, repoId: string, branch: string): void;
  noteProgress(projectId: string, sessionId: string, text: string): void;
  /** The agent was not let merge its pull request: the session stops and the person is handed the merge. */
  blockMerge(projectId: string, sessionId: string, reason: string): void;
  /**
   * A session took (another) ticket on: the session's list grows, its branch is set when it had none.
   * On a ticket's new delivery the branch is replaced; `replace` swaps the finished tickets out.
   */
  attach(projectId: string, sessionId: string, itemId: string, branch: string, delivery: number, opts?: { replace?: boolean }): void;
  /** The hooks session a tokenless claim of `key` comes from: the one whose hooks announced it, else a guess (live on that repository, holding no ticket and no client's connection). */
  externalSession(projectId: string, repoId: string, key?: string): SessionView | null;
  /** The hooks session whose hooks just announced a work_without_ticket call, if one did. */
  excusing(projectId: string): SessionView | null;
  /** A terminal session Start made for this ticket with an agent that reaches Tomrade without its token, no connection has joined yet. */
  awaitingClaim(projectId: string, itemId: string): SessionView | null;
  /** The session an outside client's connection last claimed for: the one its calls without a key mean. */
  connected(projectId: string, connection: string): SessionView | null;
  /** A newer live row of the same conversation that holds nothing, when the connection was bound to an older one. */
  freeSibling(projectId: string, session: SessionView): SessionView | null;
  /** Every live session an outside client's connection claimed for, one per ticket it works in parallel. */
  connectedSessions(projectId: string, connection: string): SessionView[];
  /** The connection's calls without a key mean this session from now on; it keeps its other sessions except `leaving`. */
  bindConnection(projectId: string, connection: string, sessionId: string, leaving?: string): void;
  /** Whether any client's connection holds the session. */
  bound(sessionId: string): boolean;
  /** A new session followed only through a client's connection, for a client with no hooks. */
  connectionSession(projectId: string, repoId: string | null, worktree?: string | null): SessionView;
  /** The same outside agent, as a new session for its next ticket, or for one it works alongside the one it holds. */
  successor(projectId: string, from: SessionView, repoId: string | null, worktree?: string | null): SessionView;
  /** A claim taken back: the session drops the ticket, and one made only for claims ends once it holds nothing. */
  letGo(projectId: string, connection: string, sessionId: string, itemId: string): void;
  notify(projectId: string): void;
  /** A scan that starts now, after any running one: what git and GitHub say at this moment. */
  rescan(projectId: string): Promise<unknown>;
  /** What GitHub says now of one ticket's open pull requests: no fetch, no other repository. */
  settleTicket(projectId: string, itemId: string): Promise<void>;
  summary(projectId: string, itemId: string): CodeSummaryView;
  /** A repository with no remote: merge the ticket's branch into the default branch here. */
  mergeLocal(projectId: string, itemId: string, opts: { agent: boolean }): Promise<{ merged: boolean; sha: string | null; message: string }>;
  /** On the person's word: the ticket's pull request through gh, or its branch here without a remote. */
  merge(projectId: string, itemId: string): Promise<MergeLocalResult>;
  /** How tickets asked for in this conversation run, or that the person has to pick. */
  startConfigFor(projectId: string, threadId: string): Promise<StartConfig>;
  /** Start several tickets headless with one configuration. */
  startTickets(projectId: string, request: StartBatchRequest): Promise<StartBatchEntry[]>;
  /** A merge refused for a conflict: the ticket's session is sent back to bring its branch up to date. */
  resolveMerge(projectId: string, itemId: string, requestedBy: string): Promise<StartBatchEntry>;
}

/** The ticket, repository and branch a call is about: named by key, or implied by the session or the run's thread. */
interface Subject {
  item: Item;
  repoId: string | null;
  branch: string | null;
  session: SessionView | null;
}

/** A claim that waits on GitHub longer than this says so in the log. */
const SLOW_SETTLE_MS = 2_000;
const PR_NUMBER = /\/pull\/(\d+)(?:[/?#]|$)/;

/** Two rows of one outside agent's conversation: the same agent under the same id, neither a thread's. */
export const isSameConversation = (a: SessionView, b: SessionView): boolean => !!a.externalId && a.externalId === b.externalId && a.agent === b.agent && a.threadId === null && b.threadId === null;
const GITHUB_PULL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//i;

export function registerTools(ctx: Context, host: ToolHost): void {
  const untracked = () => CODE_WORDS(ctx.get("settings")?.locale?.())("untrackedSession");
  // One that handed its merge to the person, or has been silent for an hour, is no longer working the ticket.
  const workingOn = (projectId: string, itemId: string): SessionView[] =>
    host.store.sessions(projectId, { itemId, live: true }).filter((s) => s.state !== "lost" && s.endedAt === null && s.blocked !== "merge" && Date.now() - (s.lastEventAt ?? s.startedAt) < END_AFTER_MS);
  /** The other live rows of a session's conversation. */
  const sameConversation = (projectId: string, session: SessionView): SessionView[] =>
    host.store.sessions(projectId, { live: true }).filter((s) => s.id !== session.id && s.state !== "lost" && s.endedAt === null && isSameConversation(s, session));
  const holderView = (s: SessionView) => ({
    sessionId: s.id,
    agent: s.agent,
    worktree: s.worktree,
    state: s.state,
    lastSeen: new Date(s.lastEventAt ?? s.startedAt).toISOString(),
    summary: s.summary
  });
  const subject = (tool: string, projectId: string, key: string | undefined, inv: ToolInvocation): Subject => {
    const bound = sessionContext.getStore();
    const session = bound && bound.projectId === projectId ? host.store.session(projectId, bound.sessionId) : null;
    const thread = inv.run ? (ctx.get("agent")?.store.thread(projectId, inv.run.threadId) ?? null) : null;
    const runSession = thread ? (host.store.sessions(projectId, { live: true }).find((s) => s.threadId === thread.id) ?? null) : null;
    const connected = !session && inv.connection ? host.connected(projectId, inv.connection) : null;
    let s = session ?? runSession ?? connected;

    let item: Item | null = null;
    if (key) item = ctx.items.getByKey(projectId, key.toUpperCase());
    else if (s?.itemIds[0]) item = ctx.items.get(projectId, s.itemIds[0]);
    else if (thread?.itemId) item = ctx.items.get(projectId, thread.itemId);
    if (!item) throw new Error(key ? `${tool}: no ticket ${key} in this project` : `${tool}: this connection has not claimed a ticket — pass key, or call claim_ticket first`);
    // A client back after a reconnect or a restart names its ticket: its outside session is found again, and kept for the calls after.
    if (!s && key && inv.connection) {
      const held = host.store.sessions(projectId, { itemId: item.id, live: true }).find((x) => x.threadId === null && x.mode === "terminal") ?? null;
      if (held) {
        host.bindConnection(projectId, inv.connection, held.id);
        s = held;
      }
    }
    if (s?.itemIds.length && !s.itemIds.includes(item.id)) {
      const holder = s;
      // An outside client working tickets in parallel names by key which of its sessions a call is about:
      // one its connection claimed, else one of the same agent (its identity, on that repository) that holds the ticket.
      const sibling =
        s === connected && inv.connection
          ? (host.connectedSessions(projectId, inv.connection).find((x) => x.itemIds.includes(item!.id)) ??
            host.store
              .sessions(projectId, { itemId: item.id, live: true })
              .find((x) => x.threadId === null && x.mode === "terminal" && x.state !== "lost" && x.agent === holder.agent && x.repoId === holder.repoId && x.externalId === holder.externalId && (x.externalId !== null || !host.bound(x.id))) ??
            null)
          : null;
      if (!sibling) {
        const held = ctx.items.get(projectId, s.itemIds[0]);
        // Never quietly the ticket claimed last: the call would land on another ticket's session.
        if (s === connected) throw new Error(`${tool}: this connection has not claimed ${item.key} (its session owns ${held?.key ?? "another ticket"}) — call claim_ticket with key ${item.key} and parallel: true first`);
        throw new Error(`${tool}: this session owns ${held?.key ?? "another ticket"}, not ${item.key} — use a separate session`);
      }
      s = sibling;
    }

    const board = ctx.boards.get(projectId, item.boardId);
    // A General session stands on no repository: its ids are empty, and the workstream's repository (if any) applies.
    const repoId = s?.repoId || board?.repoId || null;
    const branch = s?.branch || thread?.branch || null;
    return { item, repoId, branch, session: s };
  };

  /** The project's repository a GitHub pull request URL names: the pull request is that repository's, whichever one the session stands in. */
  const repoOfPull = (projectId: string, prUrl: string | undefined): string | null => {
    const slug = prUrl ? GITHUB_PULL.exec(prUrl)?.[1]?.toLowerCase() : undefined;
    if (!slug) return null;
    const named = ctx.repos.list(projectId).filter((r) => remoteIdentity(r.remote)?.path === slug);
    // An SSH alias (`github.com-work`) still names GitHub; another server's copy of the same path does not come first.
    return (named.find((r) => remoteIdentity(r.remote)?.host === "github.com") ?? named.find((r) => remoteIdentity(r.remote)?.host.startsWith("github.com")) ?? named[0])?.id ?? null;
  };

  /**
   * Code linked to a finished ticket is history or new work, never a reason to reopen it quietly: a merged
   * or closed pull request (or a bare branch) is recorded on its last delivery; an open one asks the person.
   */
  const linkFinished = (projectId: string, item: Item, repoId: string, named: string | null, pr: { prUrl: string | null; prNumber: number | null; prState: PrState | null }) => {
    if (pr.prState === "open") {
      const last = host.store.currentDelivery(projectId, item.id);
      const reason = `pull request opened after ${item.status}: ${pr.prUrl ?? `#${pr.prNumber}`} — reopen for a new delivery?`;
      if (last && !host.store.hasRecentProposal(projectId, item.id, last.sequence, "propose", "doing", reason, null)) {
        host.store.addProposal(projectId, { itemId: item.id, delivery: last.sequence, linkId: null, kind: "propose", fromStatus: item.status, toStatus: "doing", reason, evidenceSha: null });
        host.notify(projectId);
      }
      return {
        ok: false,
        key: item.key,
        status: item.status,
        warning: `${item.key} is ${item.status}, so the open pull request was not linked. The person is asked in Tomrade whether to reopen it for a new delivery; tell the user, and call link_code again once it is reopened. If this pull request is already merged or closed, pass prState.`
      };
    }
    let delivery = host.store.currentDelivery(projectId, item.id);
    if (!delivery) {
      // Code found for a ticket that never had any: its one delivery, already over.
      host.store.ensureActiveDelivery(projectId, item.id, item.updatedAt);
      delivery = host.store.finishActiveDelivery(projectId, item.id, item.status === "done" ? "completed" : "cancelled")!;
    }
    const existing = host.store.links(projectId, item.id).find((l) => l.repoId === repoId && l.delivery === delivery.sequence && l.branch);
    const branch = named ?? existing?.branch ?? "";
    if (!branch) throw new Error("link_code: pass branch — this session has none");
    const link = host.store.upsertLink(
      projectId,
      { itemId: item.id, repoId, branch, delivery: delivery.sequence },
      { ...(pr.prUrl ? { prUrl: pr.prUrl } : {}), ...(pr.prNumber ? { prNumber: pr.prNumber } : {}), ...(pr.prState ? { prState: pr.prState } : {}), source: "mcp", lastSeenAt: Date.now() }
    );
    host.notify(projectId);
    return {
      key: item.key,
      status: item.status,
      branch: link.branch,
      prUrl: link.prUrl,
      prState: link.prState,
      warning: `${item.key} is ${item.status}: recorded on its delivery ${delivery.sequence}; its status was not changed`
    };
  };

  ctx.tools.kit("code", "a coding session's ticket");
  ctx.tools.register(
    defineTool({
      name: "link_code",
      kit: "code",
      title: "Link code to a ticket",
      description:
        "Attach a branch and/or pull request to a ticket. A coding session must inspect its complete diff and pass scopeChecked: true; then the ticket moves to Verifying (with the pull request, or with the branch alone in a repository that has no remote). Without `key` it applies to the ticket this session was started from.",
      input: z.object({
        key: z.string().optional().describe("Ticket key, e.g. TOM-42; defaults to this session's ticket"),
        branch: z.string().optional().describe("Branch name; defaults to this session's branch"),
        prUrl: z.string().url().optional(),
        prNumber: z.number().int().positive().optional(),
        prState: z.enum(["open", "merged", "closed"]).optional().describe("Defaults to open when a prUrl is given"),
        scopeChecked: z.literal(true).optional().describe("Required from a coding session: every change in the full diff maps to this ticket's acceptance criteria"),
        projectId: z.string().optional()
      }),
      execute: (args, inv) => {
        const projectId = requireProjectId("link_code", args.projectId, inv);
        const { item, repoId: standing, branch: implied, session } = subject("link_code", projectId, args.key, inv);
        const repoId = repoOfPull(projectId, args.prUrl) ?? standing;
        if (session && args.scopeChecked !== true) {
          throw new Error("link_code: inspect the complete diff against the default branch, remove work outside this ticket, then pass scopeChecked: true");
        }
        if (!repoId) throw new Error(`link_code: ${item.key}'s workstream has no repository`);
        const prNumber = args.prNumber ?? (args.prUrl ? Number(PR_NUMBER.exec(args.prUrl)?.[1]) || null : null);
        const prState: PrState | null = args.prState ?? (args.prUrl ? "open" : null);
        if (item.status === "done" || item.status === "cancelled") return linkFinished(projectId, item, repoId, args.branch?.replace(/^origin\//, "") ?? implied, { prUrl: args.prUrl ?? null, prNumber, prState });
        const delivery = host.store.ensureActiveDelivery(projectId, item.id, item.updatedAt);
        // A session left on an earlier delivery moves to this one; the branch it had there stays behind.
        const moved = !!session && session.delivery !== delivery.sequence;
        if (session && moved) host.attach(projectId, session.id, item.id, "", delivery.sequence);
        const existing = host.store.links(projectId, item.id).filter((l) => l.repoId === repoId && l.delivery === delivery.sequence && l.branch);
        const branch = args.branch?.replace(/^origin\//, "") ?? (moved ? null : implied) ?? existing[0]?.branch ?? "";
        if (!branch) throw new Error("link_code: pass branch — this session has none");
        // An earlier delivery's merged branch would read as this delivery merged, and close the ticket again.
        const landed = host.store.links(projectId, item.id).find((l) => l.repoId === repoId && l.branch === branch && l.delivery !== delivery.sequence && (!!l.mergedSha || l.prState === "merged"));
        if (landed) throw new Error(`link_code: ${branch} was already merged in ${item.key}'s delivery ${landed.delivery} — put this delivery's work on a new branch and link that`);
        const link: CodeLinkView = host.store.upsertLink(
          projectId,
          { itemId: item.id, repoId, branch, delivery: delivery.sequence },
          {
            ...(args.prUrl ? { prUrl: args.prUrl } : {}),
            ...(prNumber ? { prNumber } : {}),
            ...(prState ? { prState } : {}),
            ...(inv.run ? { threadId: inv.run.threadId } : {}),
            source: "mcp",
            lastSeenAt: Date.now()
          }
        );
        host.dropSuggested(projectId, item.id, repoId, branch);
        host.reevaluate(projectId, item.id, repoId);
        if (session && !args.prUrl) host.handOver(projectId, item.id, repoId);
        const after = ctx.items.get(projectId, item.id)!;
        return { key: after.key, status: after.status, branch: link.branch, prUrl: link.prUrl, prState: link.prState };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "start_ticket",
      title: "Start tickets from this conversation",
      description:
        "You do not change code or carry out tickets yourself: this starts a coding session on each ticket, on its own branch in its own worktree, and returns at once — the sessions run on while the conversation goes on. When the user names tickets to be done (one or several), call this once with every key. When you have just filed a ticket for what the user asked, pass confirm: true instead: a card then asks the user whether to start it, and you end your turn. The sessions run with your own engine when it can code; else with what the Start dialog last ran; else the result says a card asks the user to pick the agent, and you end your turn. A ticket that waits on open tickets is not started unless allowBlocked is true: say which it waits on and ask (ask_user) whether to start anyway.",
      input: z.object({
        keys: z.array(z.string().min(1)).min(1).max(20).describe("Ticket keys, e.g. [\"TOM-42\", \"TOM-43\"]"),
        confirm: z.boolean().optional().describe("Ask first: the card shows a Start button instead of starting now — for a ticket you just filed from the user's request"),
        autoMerge: z.boolean().optional().describe("Only when the user said to merge once done: Tomrade merges each delivery by itself instead of asking in the conversation"),
        task: z
          .string()
          .max(500)
          .optional()
          .describe("What each session is to do first, when that is not the ticket's work as written — e.g. \"PR #73 conflicts with main: merge origin/main, resolve the conflicts, run the tests, push, then merge it\""),
        allowBlocked: z.boolean().optional().describe("Start tickets that wait on open ones too; each session is told what is still open"),
        projectId: z.string().optional()
      }),
      // A conversation in Tomrade starts tickets; an outside client has its own terminal for that.
      mcp: "run",
      execute: async (args, inv) => {
        const projectId = requireProjectId("start_ticket", args.projectId, inv);
        const agent = ctx.get("agent");
        if (!inv.run || !agent) throw new Error("start_ticket: only a conversation in Tomrade can start tickets");
        const items: Item[] = [];
        const problems: string[] = [];
        for (const key of args.keys) {
          const item = ctx.items.getByKey(projectId, key.toUpperCase());
          if (!item) problems.push(`no ticket ${key} in this project`);
          else if (item.kind !== "ticket") problems.push(`${item.key} is an epic — start its tickets`);
          else if (item.status === "done" || item.status === "cancelled") problems.push(`${item.key} is ${item.status} — reopen it first`);
          else if (!items.some((i) => i.id === item.id)) items.push(item);
        }
        if (!items.length) throw new Error(`start_ticket: ${problems.join("; ")}`);
        const task = args.task?.trim();
        const config = await host.startConfigFor(projectId, inv.run.threadId);
        const keys = items.map((i) => i.key).join(", ");
        if (config.choose) {
          const card: StartBatchCard = { tickets: items.map((i) => ({ itemId: i.id, key: i.key, title: i.title })), ...(task ? { task } : {}), reason: config.reason };
          agent.setCard(inv.run.id, { id: `start-batch-${inv.run.id}`, schema: "start-batch", title: keys, data: card });
          return { started: [], ...(problems.length ? { problems } : {}), note: `No coding agent is ready for this conversation (${config.reason}). A card in the conversation lets the user pick the agent and start ${keys}. End your turn.` };
        }
        if (args.confirm) {
          const settled = { engine: config.engine, ...(config.options ? { options: config.options } : {}), ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}) };
          const card: StartBatchCard = { tickets: items.map((i) => ({ itemId: i.id, key: i.key, title: i.title })), ...(task ? { task } : {}), config: settled };
          agent.setCard(inv.run.id, { id: `start-batch-${inv.run.id}`, schema: "start-batch", title: keys, data: card });
          return { started: [], ...(problems.length ? { problems } : {}), note: `A card in the conversation asks the user whether to start ${keys}; nothing runs until they say so. Say what the ticket is about in a line and end your turn.` };
        }
        const results = await host.startTickets(projectId, { itemIds: items.map((i) => i.id), requestedBy: inv.run.threadId, engine: config.engine, ...(config.options ? { options: config.options } : {}), ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}), ...(task ? { task } : {}), ...(args.allowBlocked ? { allowBlocked: true } : {}), ...(args.autoMerge ? { autoMerge: true } : {}) });
        const card: StartBatchCard = {
          tickets: items.map((i) => ({ itemId: i.id, key: i.key, title: i.title })),
          ...(task ? { task } : {}),
          results,
          // What a ticket stopped at a gate is started again with from the card, once fixed.
          config: { engine: config.engine, ...(config.options ? { options: config.options } : {}), ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}) }
        };
        agent.setCard(inv.run.id, { id: `start-batch-${inv.run.id}`, schema: "start-batch", title: items.map((i) => i.key).join(", "), data: card });
        const started = results.filter((r) => r.ok);
        const stopped = results.filter((r) => !r.ok);
        return {
          started: started.map((r) => ({ key: r.key, branch: r.branch, engine: r.engine, continued: r.continued ?? false, ...(r.message ? { waitingOn: r.message } : {}) })),
          ...(stopped.length ? { notStarted: stopped.map((r) => ({ key: r.key, gate: r.gate, message: r.message, ...(r.blockers ? { waitsOn: r.blockers } : {}) })) } : {}),
          ...(problems.length ? { problems } : {}),
          note: started.length
            ? `${started.map((r) => r.key).join(", ")} ${started.length === 1 ? "runs" : "run"} in ${started.length === 1 ? "a session" : "sessions"} of ${started.length === 1 ? "its" : "their"} own now; the user is told on a card. Say briefly what was started${stopped.length ? " and what was not, and why" : ""}, then end your turn.`
            : "Nothing started. Say why, in the user's words, and where a gate names a fix, offer it."
        };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "merge_ticket",
      title: "Merge a delivered ticket on the user's word",
      description:
        "When the user says to merge a ticket that is Verifying (its pull request is open, or its branch is handed over in a repository with no remote), call this: Tomrade merges the pull request with gh by the method the repository allows, or the branch into the default branch here. Only on the user's say-so, never on your own. A refused merge comes back as its message; tell the user and stop.",
      input: z.object({ key: z.string().min(1).describe("Ticket key, e.g. TOM-42"), projectId: z.string().optional() }),
      mcp: "run",
      execute: async (args, inv) => {
        const projectId = requireProjectId("merge_ticket", args.projectId, inv);
        if (!inv.run) throw new Error("merge_ticket: only a conversation in Tomrade can merge on the user's word");
        const item = ctx.items.getByKey(projectId, args.key.toUpperCase());
        if (!item) throw new Error(`merge_ticket: no ticket ${args.key} in this project`);
        const result = await host.merge(projectId, item.id);
        const next =
          result.merged ? undefined
          : result.cause === "conflict" ? "the branch conflicts with the default branch: ask the user (ask_user) whether the ticket's session should bring it up to date, and if so call resolve_merge — Tomrade offers the merge again once it hands over"
          : result.cause === "dirty" ? "the person's checkout has uncommitted changes on the default branch: tell them to commit or stash there, then call merge_ticket again when they say so"
          : result.cause === "no-pr" ? "there is no open pull request yet: the session pushes and opens one; once it has, merge_ticket again"
          : "tell the user why it did not merge and stop; the person settles it";
        return { key: item.key, ...result, ...(next ? { next } : {}) };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "resolve_merge",
      title: "Send the ticket's session back to clear a conflicting merge",
      description:
        "After merge_ticket was refused for a conflict and the user agreed: the ticket's coding session is continued with the task of merging the default branch into its branch, resolving the conflicts, testing and handing over again. Tomrade then offers the merge again in the conversation (or merges by itself, when the user asked for that up front). Returns at once.",
      input: z.object({ key: z.string().min(1).describe("Ticket key, e.g. TOM-42"), projectId: z.string().optional() }),
      mcp: "run",
      execute: async (args, inv) => {
        const projectId = requireProjectId("resolve_merge", args.projectId, inv);
        if (!inv.run) throw new Error("resolve_merge: only a conversation in Tomrade can send a session back");
        const item = ctx.items.getByKey(projectId, args.key.toUpperCase());
        if (!item) throw new Error(`resolve_merge: no ticket ${args.key} in this project`);
        const entry = await host.resolveMerge(projectId, item.id, inv.run.threadId);
        return entry.ok
          ? { key: item.key, started: true, branch: entry.branch, engine: entry.engine, note: "The session is bringing its branch up to date; the conversation hears when it hands over. End your turn." }
          : { key: item.key, started: false, gate: entry.gate, message: entry.message, note: "Nothing started: say why, and where a gate names a fix, offer it." };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "offer_start",
      title: "Offer to start a ticket",
      description:
        "Put a Start button for a ticket in the conversation, for the user to open the Start dialog and pick the agent, where it works and its permissions themselves. Use start_ticket to start tickets; call this only when the user wants to choose the configuration themselves or to run the ticket in a terminal. Then end your turn.",
      input: z.object({
        key: z.string().describe("Ticket key, e.g. TOM-42"),
        task: z
          .string()
          .max(500)
          .optional()
          .describe("What the session is to do first, when that is not the ticket's work as written — e.g. \"PR #73 conflicts with main: merge origin/main, resolve the conflicts, run the tests, push, then merge it\". Shown on the card and handed to the session after its brief."),
        projectId: z.string().optional()
      }),
      // Every engine in a Tomrade conversation may offer Start; an outside client has no conversation to put the button in.
      mcp: "run",
      readOnly: true,
      execute: (args, inv) => {
        const projectId = requireProjectId("offer_start", args.projectId, inv);
        const agent = ctx.get("agent");
        if (!inv.run || !agent) throw new Error("offer_start: only a conversation in Tomrade can offer Start");
        const item = ctx.items.getByKey(projectId, args.key.toUpperCase());
        if (!item) throw new Error(`offer_start: no ticket ${args.key} in this project`);
        if (item.kind !== "ticket") throw new Error(`offer_start: ${item.key} is an epic — offer one of its tickets`);
        if (item.status === "done" || item.status === "cancelled") throw new Error(`offer_start: ${item.key} is ${item.status} — reopen it first`);
        const task = args.task?.trim();
        // One card per turn: a card id seen before only updates that card, so an offer made again would never reach the stream.
        agent.setCard(inv.run.id, { id: `start-${item.id}-${inv.run.id}`, schema: "start", title: `${item.key} ${item.title}`, data: { itemId: item.id, key: item.key, title: item.title, ...(task ? { task } : {}) } });
        return { offered: item.key, note: "A Start button is in the conversation; the user starts the ticket from there. End your turn." };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "note_progress",
      kit: "code",
      title: "Note progress on the ticket",
      description: "One line about where the work stands (\"tests green, wiring the API next\"). Shown on the ticket while the session runs. Applies to this session's ticket unless `key` is given.",
      input: z.object({ text: z.string().min(1).max(280), key: z.string().optional(), projectId: z.string().optional() }),
      execute: (args, inv) => {
        const projectId = requireProjectId("note_progress", args.projectId, inv);
        const { item, session: bound } = subject("note_progress", projectId, args.key, inv);
        // A terminal session with hooks but no token is found by the ticket it claimed.
        const session = bound ?? host.store.sessions(projectId, { itemId: item.id, live: true }).find((s) => s.threadId === null) ?? null;
        // A lost note is no reason to stop the work; say plainly that it was not kept.
        if (!session) return { ok: false, key: item.key, warning: `not recorded: Tomrade is not tracking a session on ${item.key} — ${untracked()}` };
        host.noteProgress(projectId, session.id, args.text.trim());
        return { ok: true, key: item.key };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "report_merge_blocked",
      kit: "code",
      title: "Report that the pull request could not be merged",
      description:
        "Only where the brief says merging is yours: the pull request's checks could not be read (e.g. 'Resource not accessible by integration') or failed, or gh pr merge was refused (a permission denied, a safety check, branch protection, a review still required). Say why in one line; Tomrade stops the session and hands the merge to the person. Do not try to merge another way.",
      input: z.object({ reason: z.string().min(1).max(280), key: z.string().optional(), projectId: z.string().optional() }),
      execute: (args, inv) => {
        const projectId = requireProjectId("report_merge_blocked", args.projectId, inv);
        const { item, session: bound } = subject("report_merge_blocked", projectId, args.key, inv);
        const session = bound ?? host.store.sessions(projectId, { itemId: item.id, live: true }).find((s) => s.threadId === null) ?? null;
        // Nothing in Tomrade would carry the hand-off, so the agent carries it: never a quiet success.
        if (!session) {
          return {
            ok: false,
            key: item.key,
            next: "stop",
            warning: `not recorded: Tomrade is not tracking a session on ${item.key}, so it cannot hand the merge over. Tell the user directly that the pull request needs a human to merge it, and why: ${args.reason.trim()}`
          };
        }
        host.blockMerge(projectId, session.id, args.reason.trim());
        return { ok: true, key: item.key, next: "stop here — the person merges the pull request" };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "merge_branch",
      kit: "code",
      title: "Merge the ticket's branch into the default branch, in a repository with no remote",
      description:
        "Only in a repository with no remote, and only where the brief says merging is yours: after link_code, merge the ticket's branch into the default branch on this machine. Tomrade merges only from a clean default-branch checkout or a temporary worktree, aborts on a conflict, and finishes the ticket. When it does not merge, report its message with note_progress and stop; the person merges.",
      input: z.object({ key: z.string().optional(), projectId: z.string().optional() }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("merge_branch", args.projectId, inv);
        const { item } = subject("merge_branch", projectId, args.key, inv);
        const result = await host.mergeLocal(projectId, item.id, { agent: true });
        return { key: item.key, ...result, ...(result.merged ? {} : { next: "call note_progress with this message and stop — the person merges" }) };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "claim_ticket",
      kit: "code",
      title: "Claim a ticket to work on",
      description:
        "Before implementing a ticket from your own terminal: returns the ticket, the branch to use, and marks it Doing. A session owns one ticket at a time: another can be claimed once that one is done, or alongside it with parallel: true, each on its own branch or worktree (never in a session Tomrade started). When another live session is already working the ticket, nothing changes and the result says claimed: false and who holds it. A claim made by mistake is undone with release_ticket.",
      input: z.object({
        key: z.string().min(1).describe("Ticket key, e.g. TOM-42"),
        parallel: z.boolean().optional().describe("Work on this ticket alongside the one you hold, instead of finishing that one first; then pass key to link_code, note_progress and report_merge_blocked"),
        worktree: z.string().optional().describe("The worktree or folder this ticket is worked in"),
        takeOver: z.boolean().optional().describe("Claim it although another live session holds it — only when the person says so, that session is gone, or it is your own from before a reconnect"),
        projectId: z.string().optional()
      }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("claim_ticket", args.projectId, inv);
        const item = ctx.items.getByKey(projectId, args.key.toUpperCase());
        if (!item) throw new Error(`claim_ticket: no ticket ${args.key} in this project`);
        if (item.status === "done" || item.status === "cancelled") throw new Error(`claim_ticket: reopen ${item.key} before starting another delivery`);
        if (item.humanLocked) throw new Error(`claim_ticket: ${item.key} is human-locked — ask the owner to unlock it`);
        const board = ctx.boards.get(projectId, item.boardId);
        const repoId = board?.repoId ?? null;
        const repo = repoId ? ctx.repos.get(projectId, repoId) : null;
        const state = repoId ? host.store.repoState(projectId, repoId) : null;
        const local = state?.remote === "none";
        const blockers = item.blockedBy.map((id) => ctx.items.get(projectId, id)).filter((b): b is Item => !!b && b.status !== "done" && b.status !== "cancelled");

        const bound = sessionContext.getStore();
        const tokened = bound && bound.projectId === projectId ? host.store.session(projectId, bound.sessionId) : null;
        if (tokened && args.parallel) throw new Error(`claim_ticket: a session Tomrade started works one ticket in its own worktree, so it cannot claim ${item.key} in parallel — start_ticket ${item.key} to start it in a session of its own`);
        const worktree = !tokened && args.worktree?.trim() ? path.resolve(args.worktree.trim()) : null;
        // Without a token the claim belongs to the client's connection: the session it claimed before, else a hooks session nobody holds.
        // One it already works this ticket in, alongside others, is that one again.
        const connected = !tokened && inv.connection ? host.connected(projectId, inv.connection) : null;
        const again = !tokened && inv.connection ? (host.connectedSessions(projectId, inv.connection).find((s) => s.itemIds.includes(item.id)) ?? null) : null;
        // An agent that reaches Tomrade without its session's token (agy) claims as its first act: that joins the terminal session Start made for this ticket.
        const started = !tokened && !again && !connected && inv.connection ? host.awaitingClaim(projectId, item.id) : null;
        // A connection outlives the agent's restarts. When the same conversation has since opened a newer row that holds
        // nothing — Start made one for this very ticket — that row is where the agent works, not the one bound before.
        const moved = connected && !connected.itemIds.includes(item.id) ? host.freeSibling(projectId, connected) : null;
        let session = tokened ?? again ?? moved ?? connected ?? started ?? (repoId ? host.externalSession(projectId, repoId, item.key) : null);
        // The same conversation may already hold this ticket in a row of its own: claimed before Tomrade restarted, whose
        // connection went with it. That row is this claim's, not a new one beside it.
        const kin = !tokened && !again && session ? sameConversation(projectId, session).find((s) => s.itemIds.includes(item.id)) : undefined;
        if (kin) session = kin;
        // Another session on this ticket is someone's work in progress: say who and change nothing, unless told to take it over.
        const own = new Set([...(session ? [session.id] : []), ...(!tokened && inv.connection ? host.connectedSessions(projectId, inv.connection).map((s) => s.id) : [])]);
        const holders = workingOn(projectId, item.id).filter((s) => !own.has(s.id));
        if (holders.length && !args.takeOver) {
          return {
            claimed: false,
            key: item.key,
            title: item.title,
            status: item.status,
            heldBy: holders.map(holderView),
            next: `another session is working ${item.key}: do not start on it, and tell the person who holds it. Claim again with takeOver: true only if the person says so, if that session is gone, or if it is your own from before a reconnect (the same worktree).`
          };
        }
        const held = () => (session?.itemIds ?? []).filter((id) => id !== item.id).map((id) => ctx.items.get(projectId, id));
        let others = held();
        // An outside terminal moves on once its ticket is finished, or once it handed that ticket's merge to the person
        // (report_merge_blocked); until then its wrap-up is still owed. One it only filed and never claimed (a claim makes
        // it Doing) owes nothing: it stays in the backlog. A session Tomrade started is one ticket's thread and worktree.
        const handedOff = session?.blocked === "merge";
        const owing = () =>
          others.find((held) => !held || (held.status !== "done" && held.status !== "cancelled" && held.status !== "backlog" && held.status !== "todo" && !(held.status === "verifying" && handedOff)));
        let owed = owing();
        // The agent may have merged its pull request a moment ago, long before the next timed scan: look now rather than refuse.
        if (owed?.status === "verifying" && !tokened && !args.parallel && host.store.links(projectId, owed.id).some((l) => l.prState === "open")) {
          const verifying = owed;
          const asked = Date.now();
          await host.settleTicket(projectId, verifying.id).catch((err) => ctx.logger.warn(`claim_ticket: asking GitHub about ${verifying.key}'s pull request failed: ${errorMessage(err)}`));
          if (Date.now() - asked > SLOW_SETTLE_MS) ctx.logger.warn(`claim_ticket: asking GitHub about ${verifying.key}'s pull request took ${Date.now() - asked}ms`);
          others = held();
          owed = owing();
        }
        let leaving: string | undefined;
        let alongside = false;
        if (session && owed && !tokened && args.parallel) {
          // Side by side: the ticket gets a session of its own with the same identity; the one held stays exactly as it is.
          session = host.successor(projectId, session, repoId, worktree);
          alongside = true;
        } else if (others.length && (tokened || owed)) {
          const held = owed ?? others[0];
          if (tokened || !held) throw new Error(`claim_ticket: this session already owns ${held?.key ?? "another ticket"} — start a separate session for ${item.key}`);
          const meanwhile = ` — or, to work on it alongside ${held.key} on its own branch or worktree, claim ${item.key} with parallel: true`;
          if (held.status === "verifying") throw new Error(`claim_ticket: this session still owns ${held.key}, which is verifying — merge its pull request once the checks pass, or if the merge is refused call report_merge_blocked, then claim ${item.key}${meanwhile}`);
          throw new Error(`claim_ticket: this session still owns ${held.key}, which is ${held.status} — finish it (open its pull request and link_code, then merge or report_merge_blocked), then claim ${item.key}${meanwhile}`);
        }
        // The session waiting on the person's merge keeps its ticket and says so; the next ticket gets a session of its own.
        if (session && !alongside && others.some((held) => held?.status === "verifying") && handedOff) {
          leaving = session.id;
          session = host.successor(projectId, session, repoId, worktree);
        }
        const switched = (session?.itemIds ?? []).some((id) => id !== item.id);
        // A client with no hooks is still followed, through its connection.
        if (!session && inv.connection) session = host.connectionSession(projectId, repoId, worktree);
        if (session && !tokened && worktree && session.worktree !== worktree) session = host.store.patchSession(projectId, session.id, { worktree });
        // The client's MCP headers name the pane it runs in: the sidebar's terminal row is this session's from now on, hooks or none.
        if (session && !tokened && inv.pane && !session.herdrPane) session = host.store.patchSession(projectId, session.id, { herdrPane: inv.pane, ...(inv.terminal && !session.terminal ? { terminal: inv.terminal } : {}) });
        if (session && !tokened && inv.connection) host.bindConnection(projectId, inv.connection, session.id, leaving);
        // Another live session in the same folder changes the same files: say so, and point at a worktree.
        const here = session ? [session.worktree, session.cwd].filter((folder): folder is string => !!folder).map((folder) => path.resolve(folder)) : [];
        const sharing = session && here.length
          ? host.store.sessions(projectId, { live: true }).filter((s) =>
              s.id !== session!.id && !isSameConversation(s, session!) && s.state !== "lost" && s.endedAt === null && Date.now() - (s.lastEventAt ?? s.startedAt) < END_AFTER_MS
              && [s.worktree, s.cwd].some((folder) => !!folder && here.includes(path.resolve(folder))))
          : [];
        const delivery = host.store.ensureActiveDelivery(projectId, item.id, item.updatedAt);
        const existing = repoId ? host.store.links(projectId, item.id).find((l) => l.repoId === repoId && l.delivery === delivery.sequence && l.branch) : null;
        // An external session starts with no branch of its own; the template names one.
        // Only a branch that has to be invented needs a slug, and only a CJK title needs the model.
        // The session's branch is this ticket's only while the session stays on it; moving on to another ticket starts a new one.
        const settled = existing?.branch || (!switched && session?.delivery === delivery.sequence ? session.branch : "");
        const baseBranch = settled
          ? ""
          : branchFor(state?.branchTemplate ?? DEFAULT_BRANCH_TEMPLATE, item.key, item.title, await titleSlug(ctx.get("llm") ?? null, item.title));
        const branch = settled || (delivery.sequence === 1 ? baseBranch : `${baseBranch}-${delivery.sequence}`);
        if (repoId) host.store.upsertLink(projectId, { itemId: item.id, repoId, branch, delivery: delivery.sequence }, { source: "mcp", lastSeenAt: Date.now() });
        if (session) host.attach(projectId, session.id, item.id, branch, delivery.sequence, { replace: switched });
        if (item.status === "backlog" || item.status === "todo") ctx.items.update(projectId, item.id, { status: "doing" }, inv.by);
        host.notify(projectId);
        return {
          key: item.key,
          title: item.title,
          body: item.body,
          status: ctx.items.get(projectId, item.id)!.status,
          branch,
          repository: repo ? { name: repo.name, remote: repo.remote, defaultBranch: repo.defaultBranch, readiness: state?.readiness ?? "unknown", hasBrief: state?.hasBrief ?? false } : null,
          tracking: session ? { tracked: true, sessionId: session.id } : { tracked: false, message: untracked() },
          blockedBy: blockers.map((b) => ({ key: b.key, title: b.title, status: b.status })),
          ...(sharing.length
            ? { sharedCheckout: sharing.map((s) => ({ ...holderView(s), tickets: s.itemIds.map((id) => ctx.items.get(projectId, id)?.key).filter((k): k is string => !!k) })) }
            : {}),
          conventions: [
            ...(sharing.length
              ? [
                  `${sharing.length === 1 ? "another live session works" : `${sharing.length} other live sessions work`} in this same folder (sharedCheckout): do not change files here beside ${sharing.length === 1 ? "it" : "them"} — make a worktree for ${branch} (git worktree add <folder> -b ${branch} ${repo?.defaultBranch ?? "the default branch"}) and work there, telling the person, or ask them which session goes on`
                ]
              : []),
            `this session owns only ${item.key}; implement only its stated outcome and acceptance criteria`,
            "neighboring tickets are context, not extra implementation work; leave their code for separate sessions",
            "before pushing, review the full diff and remove anything this ticket does not require",
            `work on branch ${branch}; never commit to ${repo?.defaultBranch ?? "the default branch"}`,
            ...(alongside
              ? [
                  `you hold other tickets in parallel: create ${branch} from the latest ${repo?.defaultBranch ?? "default branch"}, not from another ticket's branch, and pass key ${item.key} to link_code, note_progress and report_merge_blocked for this ticket`
                ]
              : []),
            ...(switched
              ? [
                  `this session's previous ticket is finished: create ${branch} from the latest ${repo?.defaultBranch ?? "default branch"} (fetch first), not from the previous ticket's branch, and make sure the full-diff review finds none of its commits`
                ]
              : []),
            `every commit message names ${item.key}`,
            local
              ? `this repository has no remote: do not push or open a pull request; after the full-diff review call link_code with scopeChecked: true and no prUrl; do not mark the ticket done — merging does`
              : "call link_code with the pull request URL when you open one; do not mark the ticket done — merging does",
            local && !state?.agentMerge ? `the person merges your branch into ${repo?.defaultBranch ?? "the default branch"}` : mergeLine(!!state?.agentMerge, local).replace(/^- /, ""),
            ...(session ? ["call note_progress with one line at milestones"] : [untracked()])
          ]
        };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "work_without_ticket",
      kit: "code",
      title: "Go on without a ticket, on the person's word",
      description:
        "Only after the person said this change needs no ticket (\"just do it here\", a throwaway experiment, something kept out of the backlog): records their choice on this session, so Tomrade stops holding its code changes for a claim and shows it as working without a ticket. Pass what they said. Not for a session Tomrade started; claim_ticket later takes it back.",
      input: z.object({ reason: z.string().min(1).max(280).describe("What the person said, in a few words"), projectId: z.string().optional() }),
      execute: (args, inv) => {
        const projectId = requireProjectId("work_without_ticket", args.projectId, inv);
        const bound = sessionContext.getStore();
        if (bound && bound.projectId === projectId && host.store.session(projectId, bound.sessionId)) {
          throw new Error("work_without_ticket: a session Tomrade started works its own ticket — there is nothing to go without");
        }
        // The session this connection claimed for; else the hooks session that announced this call; else a free hooks
        // session on one of the project's repositories; else one followed through the connection alone.
        const connected = inv.connection ? host.connected(projectId, inv.connection) : null;
        const free = () => ctx.repos.list(projectId).map((repo) => host.externalSession(projectId, repo.id)).find((s): s is SessionView => !!s) ?? null;
        const session = connected ?? host.excusing(projectId) ?? free() ?? (inv.connection ? host.connectionSession(projectId, null) : null);
        if (!session) return { recorded: false, message: untracked() };
        if (session.itemIds.length) {
          const keys = session.itemIds.map((id) => ctx.items.get(projectId, id)?.key).filter(Boolean).join(", ");
          return { recorded: false, message: `this session holds ${keys}: its changes belong on that ticket's branch. If the person wants work outside it, release_ticket first.` };
        }
        host.store.patchSession(projectId, session.id, { withoutTicket: args.reason.trim() });
        if (inv.connection) host.bindConnection(projectId, inv.connection, session.id);
        host.notify(projectId);
        return {
          recorded: true,
          sessionId: session.id,
          note: "this session changes code without a ticket on the person's word; keep to what they asked, and offer once to sync back when the work turns out to be more than that (claim_ticket takes a ticket on at any time)"
        };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "release_ticket",
      kit: "code",
      title: "Let go of a ticket you claimed",
      description:
        "Undo claim_ticket on a ticket you will not work on — claimed by mistake, or someone else is on it: your session drops it. The ticket's status stays as it is.",
      input: z.object({ key: z.string().min(1).describe("Ticket key, e.g. TOM-42"), projectId: z.string().optional() }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("release_ticket", args.projectId, inv);
        const item = ctx.items.getByKey(projectId, args.key.toUpperCase());
        if (!item) throw new Error(`release_ticket: no ticket ${args.key} in this project`);
        const bound = sessionContext.getStore();
        if (bound && bound.projectId === projectId && host.store.session(projectId, bound.sessionId)) {
          throw new Error(`release_ticket: a session Tomrade started works its own ticket — stop it from Tomrade instead`);
        }
        const mine = inv.connection ? host.connectedSessions(projectId, inv.connection).filter((s) => s.itemIds.includes(item.id)) : [];
        if (!mine.length) return { released: false, key: item.key, status: item.status, message: `this connection holds no claim on ${item.key}` };
        for (const s of mine) host.letGo(projectId, inv.connection!, s.id, item.id);
        const others = workingOn(projectId, item.id);
        return {
          released: true,
          key: item.key,
          status: item.status,
          note: `${item.key} stays ${item.status}; change its status only if the person says so`,
          ...(others.length ? { stillWorkedBy: others.map(holderView) } : {})
        };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "get_code_links",
      title: "Read a ticket's code",
      description:
        "A ticket's code for its current delivery: each branch and pull request (number, URL, open/merged/closed, commits ahead and behind), the coding session working on it (state, what it is doing, whether a merge waits on the person), and the status changes git proposes. Use it to answer where a ticket's code stands.",
      input: z.object({ key: z.string().min(1).describe("Ticket key, e.g. TOM-42"), projectId: z.string().optional() }),
      readOnly: true,
      execute: ({ key, projectId: given }, inv) => {
        const projectId = requireProjectId("get_code_links", given, inv);
        const item = ctx.items.getByKey(projectId, key.toUpperCase());
        if (!item) throw new Error(`get_code_links: no ticket ${key} in this project`);
        return { key: item.key, status: item.status, workType: item.workType, ...host.summary(projectId, item.id) };
      }
    })
  );

  // ── decisions: the cross-cutting choices no ticket should make twice, or silently ──
  const decisionsRoot = (tool: string, projectId: string): string => {
    const dir = ctx.get("storage")?.artifactDirFor(projectId);
    if (!dir) throw new Error(`${tool}: this project has no folder yet — choose one under the project's settings first`);
    return dir;
  };

  ctx.tools.register(
    defineTool({
      name: "list_decisions",
      title: "List the project's decisions",
      description:
        "The cross-cutting decisions on record for this project (stack, state management, routing, persistence, deployment…), from .tomrade/docs/decisions/. Pass `area` to ask whether one area is settled — the pre-flight before touching it.",
      input: z.object({ area: z.string().optional(), projectId: z.string().optional() }),
      readOnly: true,
      execute: ({ area, projectId: given }, inv) => {
        const projectId = requireProjectId("list_decisions", given, inv);
        const decisions = listDecisions(decisionsRoot("list_decisions", projectId));
        return {
          decisions: decisions.map(({ file: _file, ...d }) => d),
          ...(area ? { area, covered: covered(decisions, area) } : {})
        };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "record_decision",
      title: "Record a decision",
      description:
        "Write a short decision note (context, decision, alternatives, consequences) into the project's .tomrade/docs/decisions/. Use it once the user has confirmed a cross-cutting choice; name the areas it settles so later tickets find it.",
      input: z.object({
        title: z.string().min(3),
        context: z.string().min(1),
        decision: z.string().min(1),
        alternatives: z.string().optional(),
        consequences: z.string().optional(),
        areas: z.array(z.string()).optional().describe('What it settles, e.g. ["state management", "routing"]'),
        status: z.enum(["proposed", "accepted", "superseded"]).optional(),
        supersedes: z.string().optional().describe("The id of the decision this one replaces"),
        projectId: z.string().optional()
      }),
      execute: ({ projectId: given, ...input }, inv) => {
        const projectId = requireProjectId("record_decision", given, inv);
        const { file, ...written } = recordDecision(decisionsRoot("record_decision", projectId), input);
        return { ...written, path: file };
      }
    })
  );
}
