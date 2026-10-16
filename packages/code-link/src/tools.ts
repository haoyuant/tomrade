import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/agent";
import type {} from "@tomradex/boards";
import type {} from "@tomradex/items";
import type {} from "@tomradex/repos";
import type {} from "@tomradex/storage";
import type { Item } from "@tomradex/domain";
import { defineTool, requireProjectId, type ToolInvocation } from "@tomradex/tools";
import { covered, listDecisions, recordDecision } from "./decisions.js";
import { DEFAULT_BRANCH_TEMPLATE, branchFor, titleSlug } from "./keys.js";
import { CODE_WORDS } from "./words.js";
import type {} from "@tomradex/settings";
import { mergeLine } from "./prompts.js";
import { sessionContext } from "./sessions.js";
import type { CodeLinkStore, CodeLinkView, SessionView } from "./store.js";
import type { PrState } from "./rules.js";
import type { CodeSummaryView } from "./service.js";

/** What the tools need from the service without importing it. */
export interface ToolHost {
  store: CodeLinkStore;
  /** Re-judge one ticket in one repository after a link changed by hand or by tool. */
  reevaluate(projectId: string, itemId: string, repoId: string): void;
  /** A repository with no remote has no pull request: the session's scoped link moves the ticket to Verifying. */
  handOver(projectId: string, itemId: string, repoId: string): void;
  noteProgress(projectId: string, sessionId: string, text: string): void;
  /** The agent was not let merge its pull request: the session stops and the person is handed the merge. */
  blockMerge(projectId: string, sessionId: string, reason: string): void;
  /**
   * A session took (another) ticket on: the session's list grows, its branch is set when it had none.
   * On a ticket's new delivery the branch is replaced; `replace` swaps the finished tickets out.
   */
  attach(projectId: string, sessionId: string, itemId: string, branch: string, delivery: number, opts?: { replace?: boolean }): void;
  /** The hooks session a tokenless claim most likely comes from: live on that repository, holding no ticket and no client's connection. */
  externalSession(projectId: string, repoId: string): SessionView | null;
  /** The session an outside client's connection claimed for. */
  connected(projectId: string, connection: string): SessionView | null;
  bindConnection(projectId: string, connection: string, sessionId: string): void;
  /** A new session followed only through a client's connection, for a client with no hooks. */
  connectionSession(projectId: string, repoId: string | null): SessionView;
  notify(projectId: string): void;
  summary(projectId: string, itemId: string): CodeSummaryView;
  /** A repository with no remote: merge the ticket's branch into the default branch here. */
  mergeLocal(projectId: string, itemId: string, opts: { agent: boolean }): Promise<{ merged: boolean; sha: string | null; message: string }>;
}

/** The ticket, repository and branch a call is about: named by key, or implied by the session or the run's thread. */
interface Subject {
  item: Item;
  repoId: string | null;
  branch: string | null;
  session: SessionView | null;
}

const PR_NUMBER = /\/pull\/(\d+)(?:[/?#]|$)/;

export function registerTools(ctx: Context, host: ToolHost): void {
  const untracked = () => CODE_WORDS[ctx.get("settings")?.locale?.() ?? "en"].untrackedSession;
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
      const held = ctx.items.get(projectId, s.itemIds[0]);
      throw new Error(`${tool}: this session owns ${held?.key ?? "another ticket"}, not ${item.key} — use a separate session`);
    }

    const board = ctx.boards.get(projectId, item.boardId);
    // A General session stands on no repository: its ids are empty, and the workstream's repository (if any) applies.
    const repoId = s?.repoId || board?.repoId || null;
    const branch = s?.branch || thread?.branch || null;
    return { item, repoId, branch, session: s };
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

  ctx.tools.register(
    defineTool({
      name: "link_code",
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
        const { item, repoId, branch: implied, session } = subject("link_code", projectId, args.key, inv);
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
        host.reevaluate(projectId, item.id, repoId);
        if (session && !args.prUrl) host.handOver(projectId, item.id, repoId);
        const after = ctx.items.get(projectId, item.id)!;
        return { key: after.key, status: after.status, branch: link.branch, prUrl: link.prUrl, prState: link.prState };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "offer_start",
      title: "Offer to start a ticket",
      description:
        "You do not change code or carry out tickets yourself. When the user wants a ticket implemented (code changed, a document written, any ticket's work done), make sure a ticket describes it — create one if needed — then call this: the user gets a Start button that opens the Start dialog, where they pick the agent, where it works and its permissions. Then end your turn.",
      input: z.object({ key: z.string().describe("Ticket key, e.g. TOM-42"), projectId: z.string().optional() }),
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
        agent.setCard(inv.run.id, { id: `start-${item.id}`, schema: "start", title: `${item.key} ${item.title}`, data: { itemId: item.id, key: item.key, title: item.title } });
        return { offered: item.key, note: "A Start button is in the conversation; the user starts the ticket from there. End your turn." };
      }
    })
  );

  ctx.tools.register(
    defineTool({
      name: "note_progress",
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
      title: "Claim a ticket to work on",
      description:
        "Before implementing a ticket from your own terminal: returns the ticket, the branch to use, and marks it Doing. A session owns one ticket at a time: another can be claimed only once that one is done (and never in a session Tomrade started).",
      input: z.object({ key: z.string().min(1).describe("Ticket key, e.g. TOM-42"), projectId: z.string().optional() }),
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
        // Without a token the claim belongs to the client's connection: the session it claimed before, else a hooks session nobody holds.
        const connected = !tokened && inv.connection ? host.connected(projectId, inv.connection) : null;
        let session = tokened ?? connected ?? (repoId ? host.externalSession(projectId, repoId) : null);
        const others = (session?.itemIds ?? []).filter((id) => id !== item.id).map((id) => ctx.items.get(projectId, id));
        // An outside terminal moves on once its ticket is finished; until then its wrap-up (merging, a blocked merge) is still owed.
        // A session Tomrade started is one ticket's thread and worktree.
        const owed = others.find((held) => !held || (held.status !== "done" && held.status !== "cancelled"));
        if (others.length && (tokened || owed)) {
          const held = owed ?? others[0];
          if (tokened || !held) throw new Error(`claim_ticket: this session already owns ${held?.key ?? "another ticket"} — start a separate session for ${item.key}`);
          throw new Error(`claim_ticket: this session still owns ${held.key}, which is ${held.status} — merge it or hand the merge to the person (report_merge_blocked), then claim ${item.key}`);
        }
        const switched = others.length > 0;
        // A client with no hooks is still followed, through its connection.
        if (!session && inv.connection) session = host.connectionSession(projectId, repoId);
        if (session && !tokened && inv.connection) host.bindConnection(projectId, inv.connection, session.id);
        const delivery = host.store.ensureActiveDelivery(projectId, item.id, item.updatedAt);
        const existing = repoId ? host.store.links(projectId, item.id).find((l) => l.repoId === repoId && l.delivery === delivery.sequence && l.branch) : null;
        // An external session starts with no branch of its own; the template names one.
        // Only a branch that has to be invented needs a slug, and only a CJK title needs the model.
        const settled = existing?.branch || (session?.delivery === delivery.sequence ? session.branch : "");
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
          conventions: [
            `this session owns only ${item.key}; implement only its stated outcome and acceptance criteria`,
            "neighboring tickets are context, not extra implementation work; leave their code for separate sessions",
            "before pushing, review the full diff and remove anything this ticket does not require",
            `work on branch ${branch}; never commit to ${repo?.defaultBranch ?? "the default branch"}`,
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
