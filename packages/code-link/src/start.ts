import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context } from "cordis";
import type { Agent, Engine, EngineAvailability, EngineCapability, ThreadSummary } from "@tomradex/agent";
import { rulesSection } from "@tomradex/agent";
import type {} from "@tomradex/boards";
import type {} from "@tomradex/hub";
import type {} from "@tomradex/items";
import type { CheckoutProblem } from "@tomradex/repos";
import { roleSection, type Role } from "@tomradex/roles";
import type {} from "@tomradex/settings";
import { normalizeRepoPath, repoSubfolder, type Author, type Board, type Item, type Repo } from "@tomradex/domain";
import { GitFolder, type Git } from "@tomradex/git";
import { fitsCommandLine, promptAsArgument } from "./command-line.js";
import { listDecisions } from "./decisions.js";
import { branchFor, titleSlug } from "./keys.js";
import { BOOTSTRAP_LABEL, bootstrapBody, continuePrompt, firstPrompt, languageLine, loosePrompt } from "./prompts.js";
import { classifyRemoteFailure, probeRemote, remoteFailureDetail, remoteFailureMessage, scrubRemoteOutput } from "./remote.js";
import type { HerdrBridge } from "./herdr-bridge.js";
import type { SessionFiles, Sessions } from "./sessions.js";
import type { CodeLinkStore, SessionMode, SessionView } from "./store.js";
import { RESUME_ID_FILE, TerminalSettings, bareCommand, fillTemplate, optionFlags, shellQuote, terminalPath, terminalTemplate, withOptions, type TerminalPath } from "./terminal.js";
import { CODE_WORDS } from "./words.js";
import { githubHttps } from "@tomradex/github";
import { errorMessage } from "@tomradex/contracts";

export type StartMode = "run" | "terminal";
export type StartGate = "locked" | "workstream" | "checkout" | "remote" | "readiness" | "blocked" | "engine" | "mcp" | "workdir" | "pane" | "prompt";
/** Why the workdir gate found no folder, when that is known. */
export type WorkdirCause = "no-board" | "no-board-repo" | "unknown-repo" | "no-hub" | "branch-in-use" | "folder-outside";

/** What the Start dialog settles: where the work runs, who runs it, and with which knobs. */
export interface StartOptions {
  mode: StartMode;
  /** An engine id, or "other" for the terminal command template that names any MCP-capable CLI. Absent picks the role's first that can start, else the first available. */
  engine?: string;
  /**
   * The project's role to work the ticket as (a role's id); absent, or gone, the implementer. Its agents are tried in
   * its order when no engine is named, its limit sets the permission mode when none is named, and its instructions
   * follow the brief. What the caller names always goes before the role.
   */
  role?: string;
  /** General tickets only: the delivery method; absent keeps the thread's, or the ticket's default. */
  playbook?: string;
  /** Engine option overrides for the thread (model, effort…); given, they replace earlier overrides. */
  options?: Record<string, unknown>;
  /** Headless coding runs only: the permission mode the engine works under. */
  permissionMode?: string;
  /** Start although tickets this one waits on are still open; the agent is told which. */
  allowBlocked?: boolean;
  /** Let go of the ticket's branch in the other worktree that has it checked out, when nothing there would be lost. */
  releaseBranch?: boolean;
  /** Carry this conversation on the ticket into the current delivery — a reopened ticket continued where it was talked about. */
  threadId?: string;
  /** The person's own words, or the task the Start was offered with, sent after the brief. */
  message?: string;
  /** Headless runs only: where the person asked for the start (an IM conversation), kept on the brief as its provenance. */
  source?: Record<string, string>;
  /** Headless runs only: the conversation (thread) that asked for the work, where its delivery is reported back. */
  requestedBy?: string;
  /** Headless runs only: the person said to merge the delivery once it is in, so Tomrade does not ask again. */
  autoMerge?: boolean;
  /** The ticket to start with these same choices once this one is done: the one this bootstrap was started ahead of. */
  then?: string;
  /** Headless runs only: the conversation in `threadId` claims the ticket it writes code for — nothing is sent, and what it changed already comes along onto the branch. */
  claim?: boolean;
  /** Another session beside the one at work: a conversation of its own, on a branch and so in a folder of its own. */
  apart?: boolean;
}

export type StartResult =
  | {
      ok: false;
      gate: StartGate;
      /** English, for agents and logs; a screen says it in its own words from the fields beside it. */
      message: string;
      bootstrapKey?: string;
      remote?: string;
      blockers?: string[];
      /** The workstream the ticket is on — what a missing or vanished repository is fixed on. */
      board?: { id: string; name: string };
      /** The repository it runs in — what a missing checkout or an unreachable origin is fixed on. */
      repo?: { id: string; name: string };
      /** The engine that is not ready, when one was asked for. */
      engine?: string;
      /** Pane gate: the herdr pane whose agent still works the ticket and did not take the prompt. */
      pane?: string;
      /** Checkout gate: the folder this machine names for the repository, and why it cannot be worked in. */
      placed?: { dir: string; problem: CheckoutProblem };
      /** Workdir gate: what stood in the way — the repository id a workstream still names, the branch and the worktree that has it, the folder that lies outside the checkout. */
      cause?: { code: WorkdirCause; repoId?: string; branch?: string; heldAt?: string; releasable?: boolean; folder?: string; checkout?: string };
    }
  | {
      ok: true;
      /** An earlier thread on this ticket was picked up rather than a new one opened. */
      continued: boolean;
      /** Null when the prompt went to a terminal agent that claimed the ticket itself, with no thread of Tomrade's. */
      threadId: string | null;
      sessionId: string;
      branch: string;
      worktree: string | null;
      cwd: string;
      mode: StartMode;
      /** Terminal mode: the command that was (or is to be) run; null for a headless run. */
      command: string | null;
      /** Terminal mode: whether a terminal window was actually opened. */
      launched: boolean;
      /** Terminal mode: the herdr pane it runs in, when it does. */
      pane?: string | null;
      /** Headless mode: the run that was started. */
      runId?: string;
      /** The engine it actually ran with — the one picked for it when the caller named none, so a
       *  remembered configuration is not left without an agent. */
      engine: string;
      /** Headless mode: the thread waits on the person's answer to this, so nothing was sent — show it instead. */
      waitingOn?: string;
      /** Conditions that do not prevent local work, but constrain what the agent may do. */
      warnings?: string[];
    };

/** What the starter needs from the service. */
export interface StartHost {
  ctx: Context;
  store: CodeLinkStore;
  sessions: Sessions;
  /** herdr, the terminal sessions run in when it is there: every launch goes through it. */
  herdr: HerdrBridge;
  git: Git;
  scan(projectId: string): Promise<unknown>;
  notify(projectId: string): void;
  sessionDir(sessionId: string): string;
  /** Machine-local: where each thread's worktree is, for the section and the terminal. */
  worktrees: Map<string, string>;
}

const OPEN = new Set(["backlog", "todo", "doing", "verifying"]);

const sourced = (opts: StartOptions) => (opts.source ? { requestId: `start:${randomUUID()}`, source: opts.source } : undefined);

/** A branch beside the ticket's own for a second session on it: `-b`, `-c`… after it, the first no link or conversation has. */
export function apartBranch(base: string, taken: string[]): string {
  const used = new Set(taken);
  for (const letter of "bcdefghijklmnopqrstuvwxyz") if (!used.has(`${base}-${letter}`)) return `${base}-${letter}`;
  for (let n = 2; ; n++) if (!used.has(`${base}-x${n}`)) return `${base}-x${n}`;
}

/** Unfinished dependencies are a question for the human, not a wall: Start again with allowBlocked to work ahead of them. */
const blockedGate = (item: Item, blockers: Item[]): StartResult => ({
  ok: false,
  gate: "blocked",
  message: `${item.key} waits on ${blockers.map((b) => b.key).join(", ")}`,
  blockers: blockers.map((b) => b.key)
});

/**
 * Start (or continue) work on a ticket with a local coding agent. Six gates,
 * each answered with the one thing that unblocks it; then a thread on the
 * ticket's workstream, a worktree on the ticket's branch, a session record,
 * and either a headless run or the user's own terminal.
 */
/** What an agent resuming its own session in the background is told first. */
const RESUME_PROMPT = "Tomrade: this conversation was taken up again from its look back. Carry on with what was asked last; if nothing is pending, say in one line where it stands and wait for the person.\n";

export class Starter {
  constructor(private readonly host: StartHost) {}

  async start(projectId: string, itemId: string, opts: StartOptions): Promise<StartResult> {
    const { ctx, store } = this.host;
    const found = ctx.items.get(projectId, itemId);
    if (!found) throw new Error(`unknown item ${itemId}`);
    let item: Item = found;
    if (!OPEN.has(item.status)) throw new Error(`Reopen ${item.key} before starting another delivery`);
    if (item.humanLocked) return { ok: false, gate: "locked", message: `${item.key} is human-locked — unlock it before starting work on it` };
    if (item.workType === "general") return this.startGeneral(projectId, item, opts);

    const board = ctx.boards.get(projectId, item.boardId);
    const onBoard = board ? { board: { id: board.id, name: board.name } } : {};
    if (!board?.repoId) return { ok: false, gate: "workstream", message: `${board?.name ?? "This workstream"} has no repository yet — link one under Repositories`, ...onBoard };
    const repo = ctx.repos.get(projectId, board.repoId);
    if (!repo) return { ok: false, gate: "workstream", message: `${board.name} points at a repository this project no longer has`, ...onBoard };
    const onRepo = { ...onBoard, repo: { id: repo.id, name: repo.name }, remote: repo.remote };
    const placement = ctx.repos.checkout(repo.remote);
    if (opts.mode === "terminal") {
      const claimed = await this.continueClaimed(projectId, item, repo, placement.checkout);
      if (claimed) return claimed;
    }
    if (!placement.checkout) {
      return { ok: false, gate: "checkout", message: `No checkout of ${repo.name} on this machine — point Tomrade at yours, or let it clone one`, ...onRepo };
    }
    // A folder that went away, or is no longer a repository, would only fail later — or hang in git.
    if (placement.problem) {
      const what = placement.problem === "missing" ? "does not exist" : "is not a git repository";
      return { ok: false, gate: "checkout", message: `The checkout of ${repo.name} on this machine, ${placement.checkout}, ${what} — point Tomrade at the right folder, or let it clone one`, placed: { dir: placement.checkout, problem: placement.problem }, ...onRepo };
    }

    let state = store.repoState(projectId, repo.id);
    // "Empty" opens a bootstrap, so it is read fresh: the last scan may predate the merge that filled it.
    if (!state?.scannedAt || state.readiness === "empty") {
      await this.host.scan(projectId);
      state = store.repoState(projectId, repo.id);
    }
    const warnings: string[] = [];
    // A checkout with no origin is a local repository: nothing to reach, nothing to push.
    const local = !(await new GitFolder(this.host.git, placement.checkout).remoteUrl());
    const probe = local ? null : await probeRemote(this.host.git, placement.checkout, repo.defaultBranch);
    if (probe?.state === "offline") {
      if (probe.failure !== "network") return { ok: false, gate: "remote", message: remoteFailureMessage(probe.stderr), ...onRepo };
      warnings.push(`origin unreachable right now (${probe.detail ?? "network error"}) — commit locally, do not push until it is back`);
    }
    // "Empty" is only believed when the remote confirms it. A checkout whose
    // fetch fails — wrong account, no network — looks the same from here, and
    // bootstrapping a repository that is full elsewhere would be the wrong move.
    if (state?.readiness === "empty" || state?.readiness === "unknown") {
      if (probe?.state === "exists") {
        // The remote has the branch but this machine never fetched it: fetch now and read again.
        await this.host.scan(projectId);
        state = store.repoState(projectId, repo.id);
        if (state?.readiness === "unknown") return { ok: false, gate: "remote", message: `${repo.remote} has ${repo.defaultBranch}, but this checkout cannot fetch it — check the credentials that checkout uses`, ...onRepo };
      }
    }
    const delivery = store.ensureActiveDelivery(projectId, item.id, item.updatedAt);
    const deliveryLinks = store.links(projectId, item.id).filter((link) => link.delivery === delivery.sequence);
    const placed = deliveryLinks.find((link) => link.repoId === repo.id && link.branch)?.branch ?? null;
    // A branch that already exists is reused untouched; only a new one needs a slug,
    // and only a CJK title needs the model for it.
    const baseBranch = placed ?? branchFor(state?.branchTemplate ?? "{key}/{slug}", item.key, item.title, await titleSlug(this.host.ctx.get("llm") ?? null, item.title));
    const plannedBranch = placed ?? (delivery.sequence === 1 ? baseBranch : `${baseBranch}-${delivery.sequence}`);
    if (probe && probe.state !== "offline" && (state?.agentPush ?? true)) {
      const pushed = await this.host.git(["push", "--dry-run", "origin", `HEAD:refs/heads/${plannedBranch}`], { cwd: placement.checkout, ok: true });
      if (pushed.code !== 0) {
        const stderr = scrubRemoteOutput(pushed.stderr ?? "");
        const failure = classifyRemoteFailure(stderr);
        if (failure === "credentials") return { ok: false, gate: "remote", message: remoteFailureMessage(stderr), ...onRepo };
        if (failure === "network") warnings.push(`origin unreachable right now (${remoteFailureDetail(stderr) ?? "network error"}) — commit locally, do not push until it is back`);
      }
    }
    const bootstrapping = item.labels.includes(BOOTSTRAP_LABEL);
    if (state?.readiness === "empty" && !bootstrapping) {
      // A workstream is bootstrapped once. After that ticket closes, a scan that still reads empty
      // is a doubt to mention, never a reason to open the same ticket again.
      const settled = ctx.items.list({ projectId }).find((i) => i.boardId === board.id && i.labels.includes(BOOTSTRAP_LABEL) && !OPEN.has(i.status));
      if (settled) warnings.push(`${repo.defaultBranch} still shows no project although ${settled.key} (bootstrap) is ${settled.status} — check that its work reached ${repo.defaultBranch} before building on it`);
      else {
        const bootstrap = this.ensureBootstrap(projectId, item, board, repo);
        return { ok: false, gate: "readiness", message: `${repo.name} has no project in it yet — ${bootstrap.key} bootstraps it first and blocks ${item.key} until it lands`, bootstrapKey: bootstrap.key, ...onRepo };
      }
    }

    // The readiness gate creates this dependency, so it also owns removing it
    // when a later scan finds that the repository has been scaffolded elsewhere.
    if (state?.readiness === "scaffolded") {
      for (const bootstrap of ctx.items.list({ projectId }).filter((candidate) => candidate.boardId === board.id && candidate.labels.includes(BOOTSTRAP_LABEL) && OPEN.has(candidate.status) && candidate.blocks.includes(item.id))) {
        ctx.items.update(projectId, bootstrap.id, { blocks: bootstrap.blocks.filter((id) => id !== item.id) }, "sync:git");
      }
      item = ctx.items.get(projectId, item.id) ?? item;
    }

    const blockers = this.openBlockers(projectId, item);
    if (blockers.length && !opts.allowBlocked) return blockedGate(item, blockers);

    const agent = ctx.get("agent");
    if (!agent) return { ok: false, gate: "engine", message: "the agent plugin is not loaded" };
    const terminalSettings = await this.host.herdr.terminalSettings();
    const mode: SessionMode = opts.mode === "run" ? "headless" : "terminal";
    const surface = mode === "terminal" ? "code" : "assistant";
    // In a terminal any CLI agent with an MCP client will do: "other" is whatever the machine's command template names.
    const other = opts.mode === "terminal" && (opts.engine === "other" || (!opts.engine && agent.codeEngines().length === 0)) && !!terminalSettings.otherCommand.trim();
    let engineId = "other";
    // Without the plugin, or with a role that says nothing, a Start goes as it always did.
    const role = ctx.get("roles")?.orDefault(projectId, opts.role, "implement") ?? null;
    let roleMode: string | null = null;
    if (!other) {
      const picked = opts.engine || !role?.engines.length ? await this.pickEngine(agent, opts.engine, opts.mode === "terminal") : await this.pickForRole(agent, role, opts.mode === "terminal");
      if (!picked.ok) return { ok: false, gate: "engine", message: picked.reason, ...(opts.engine ? { engine: opts.engine } : {}) };
      engineId = picked.engine.id;
      // A role's limit holds a run inside Tomrade; a terminal's agent is started by the machine's own command.
      if (role?.permission && opts.mode === "run" && !opts.permissionMode) {
        const modes = picked.engine.permissionModes?.choices.map((choice) => choice.value);
        roleMode = ctx.get("roles")!.modeFor(projectId, role.id, engineId);
        if (modes?.length && !roleMode) return { ok: false, gate: "engine", message: `${picked.engine.title} has no permission mode within the limit of the role ${role.title} (${role.permission}) — pick another agent, or change the role`, engine: engineId };
      }
    }
    // A terminal session connects back over MCP; without the server there is nothing to start, so nothing is created.
    if (opts.mode === "terminal" && !ctx.get("mcp")?.url) return { ok: false, gate: "mcp", message: "the MCP server is not running — enable the mcp plugin" };

    // An open thread on this ticket is continued, not duplicated.
    const links = store.links(projectId, item.id).filter((l) => l.repoId === repo.id && l.delivery === delivery.sequence && l.branch);
    const linked = opts.apart ? null : (links.map((l) => (l.threadId ? agent.store.thread(projectId, l.threadId) : null)).find((t) => !!t) ?? null);
    // A conversation from an earlier delivery comes along on this delivery's own branch: the old one is delivered.
    const named = !linked && !opts.apart && opts.threadId ? agent.store.thread(projectId, opts.threadId) : null;
    const carried = named?.itemId === item.id ? named : null;
    const previous = linked ?? carried;
    let continued = false;
    let fresh: string | null = null;
    let thread = previous;
    let branch = carried ? plannedBranch : previous?.branch ?? links[0]?.branch ?? "";
    const carriedFrom = carried?.branch ?? null;
    if (carried) agent.store.touchThread(projectId, carried.id, { branch });
    const uncarry = () => { if (carried) agent.store.touchThread(projectId, carried.id, { branch: carriedFrom }); };
    // The conversation goes on in a terminal right now: a run here would be a second process on its session.
    const inTerminal = thread && opts.mode === "run" ? this.liveTerminalSession(projectId, thread.id) : null;
    if (inTerminal) {
      uncarry();
      return this.terminalGate(item.key, inTerminal);
    }
    // An open question takes any message as its answer, and switching engines would drop it: the thread
    // is left as it is and the question handed back, for the person to answer in the conversation.
    const asked = thread && opts.mode === "run" && !agent.activeRuns().some((a) => a.thread.id === thread!.id) ? agent.store.pending(projectId, thread.id)?.question : undefined;
    if (thread) {
      continued = true;
      // continuing a conversation someone archived brings it back, so the run is not out of sight;
      // and once started again it is put away like any other when the ticket is done
      if (thread.archived || thread.restored) {
        agent.unarchiveThread(projectId, thread.id);
        thread = agent.store.thread(projectId, thread.id)!;
      }
      if (thread.surface !== surface) {
        agent.store.touchThread(projectId, thread.id, { surface });
        thread = agent.store.thread(projectId, thread.id)!;
      }
      if (!asked && engineId !== "other" && thread.engine !== engineId && !agent.activeRuns().some((a) => a.thread.id === thread!.id)) agent.setEngine(projectId, thread.id, engineId);
    } else {
      branch = opts.apart ? apartBranch(plannedBranch, [...store.links(projectId, item.id).map((l) => l.branch), ...agent.store.threads(projectId, null).flatMap((t) => (t.itemId === item.id && t.branch ? [t.branch] : []))]) : plannedBranch;
      thread = agent.newThread(projectId, engineId === "other" ? undefined : engineId, board.id, { itemId: item.id, branch, title: `${item.key} ${item.title}`, surface });
      fresh = thread.id;
    }
    // A thread made for this Start and then refused has no link to find it by: it goes, so a retry does not leave it behind.
    const discard = () => { if (fresh) agent.deleteThread(projectId, fresh); };
    let where: Awaited<ReturnType<typeof agent.workdir>> & { releasable?: boolean };
    try {
      if (!asked && engineId !== "other" && !agent.activeRuns().some((a) => a.thread.id === thread!.id)) {
        if (opts.options !== undefined) thread = agent.setOptions(projectId, thread.id, opts.options);
        if (opts.permissionMode && opts.mode === "run") agent.setPermissionMode(projectId, thread.id, opts.permissionMode);
        // A conversation the person has since given another mode keeps theirs.
        else if (roleMode && (!continued || !thread.permissionMode)) agent.setPermissionMode(projectId, thread.id, roleMode);
      }
      // Start is the person asking for the work, so a finished ticket's worktree may come back here.
      where = await agent.workdir(projectId, thread.id, { create: true, revive: true });
      if (where.code === "branch-in-use" && where.heldAt) {
        const held = await this.branchHolder(projectId, item.id, where.heldAt);
        if (held.releasable && (held.ours || opts.releaseBranch) && (await this.releaseBranch(where.heldAt))) where = await agent.workdir(projectId, thread.id, { create: true, revive: true });
        else where = { ...where, releasable: held.releasable };
      }
    } catch (err) {
      discard();
      uncarry();
      throw err;
    }
    if (where.problem || !where.cwd) {
      discard();
      uncarry();
      return this.workdirGate(projectId, thread, where, onRepo);
    }
    if (carried && where.worktree) {
      const moved = await this.moveWorktree(where.worktree, branch, repo.defaultBranch, !!opts.claim);
      if (moved) {
        uncarry();
        return { ok: false, gate: "workdir", message: moved, ...onRepo };
      }
    }
    this.host.worktrees.set(thread.id, where.worktree ?? where.cwd);

    const now = Date.now();
    const link = store.upsertLink(projectId, { itemId: item.id, repoId: repo.id, branch, delivery: delivery.sequence }, { threadId: thread.id, source: continued && !carried ? undefined : "start", lastSeenAt: now });
    if (item.status === "backlog" || item.status === "todo") ctx.items.update(projectId, item.id, { status: "doing" }, "human");

    const onThread = store.sessions(projectId, { itemId: item.id, delivery: delivery.sequence }).filter((s) => s.threadId === thread!.id);
    const live = onThread.find((s) => s.state !== "ended" && s.mode === mode) ?? null;
    // The CLI's own session id is what Continue resumes: the platform learned it from a headless run, a hook from a terminal one.
    const externalId = agent.store.external(projectId, thread.id)[engineId] ?? onThread.find((s) => s.agent === engineId && s.externalId)?.externalId ?? null;
    const session =
      live ??
      store.createSession(projectId, {
        repoId: repo.id,
        delivery: delivery.sequence,
        branch,
        itemIds: [item.id],
        mode,
        agent: engineId,
        threadId: thread.id,
        device: ctx.hub.deviceId,
        externalId,
        ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}),
        ...(opts.autoMerge ? { autoMerge: true } : {}),
        ...(role && opts.role === role.id ? { role: role.id } : {})
      });
    if (continued && (session.blocked || session.state === "error")) store.patchSession(projectId, session.id, { blocked: null, state: "idle", activity: null });
    // A continued session answers to whoever asked last, and merges by itself only if asked to this time.
    if (live && opts.requestedBy && (live.requestedBy !== opts.requestedBy || live.autoMerge !== !!opts.autoMerge)) store.patchSession(projectId, session.id, { requestedBy: opts.requestedBy, autoMerge: !!opts.autoMerge });
    const artifactDir = ctx.get("storage")?.artifactDirFor(projectId) ?? null;
    const decisions = artifactDir ? listDecisions(artifactDir) : [];
    const completionPolicy = ctx.codeLink.completionPolicy(projectId, item);
    // Only the ticket started first on a repository without CLAUDE.md writes it; the others would conflict with its pull request.
    const claudeMdBy =
      !continued && state && !state.hasBrief
        ? store.sessions(projectId, { live: true }).filter((s) => s.repoId === repo.id).sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))[0]?.itemIds.map((id) => ctx.items.get(projectId, id)).find((i) => i && i.id !== item.id)?.key ?? null
        : null;
    const basePrompt = continued
      ? continuePrompt(item, repo, live ?? store.sessions(projectId, { itemId: item.id })[0] ?? null, link, completionPolicy, local, ctx.settings.locale?.() ?? "en", state?.agentMerge ?? false)
      : firstPrompt({ item, repo, state, branch, blockers, bootstrap: bootstrapping, mcpUrl: ctx.get("mcp")?.urlFor(projectId) ?? null, decisions, subdir: repoSubfolder(board.repoPath, placement.checkout) ?? normalizeRepoPath(board.repoPath), completionPolicy, local, locale: ctx.settings.locale?.() ?? "en", claudeMdBy });
    const withWarnings = warnings.length ? `${basePrompt}\n\n${warnings.join("\n")}` : basePrompt;
    const briefed = role?.instructions ? `${withWarnings}\n\n${roleSection(role)}` : withWarnings;
    const prompt = opts.message?.trim() ? `${briefed}\n\n${opts.message.trim()}` : briefed;
    // An in-app run hears the rules with every turn; a terminal agent only ever reads this file.
    const rules = agent.rules(projectId);
    const terminalPrompt = rules ? `${prompt}\n\n${rulesSection(rules)}` : prompt;

    if (opts.mode === "run") {
      if (asked) {
        this.host.notify(projectId);
        return { ok: true, continued, threadId: thread.id, sessionId: session.id, branch, worktree: where.worktree, cwd: where.cwd, mode: opts.mode, command: null, launched: false, waitingOn: asked.text, engine: engineId, ...(warnings.length ? { warnings } : {}) };
      }
      // A claim sends nothing: the conversation goes on as it was, now on the ticket.
      const runId = agent.activeRuns().find((a) => a.thread.id === thread!.id)?.run.id ?? (opts.claim ? null : agent.send(projectId, thread.id, { kind: "text", text: prompt }, sourced(opts)).runId);
      store.patchSession(projectId, session.id, { state: runId ? "running" : "idle", lastEventAt: now });
      this.host.notify(projectId);
      return { ok: true, continued, threadId: thread.id, sessionId: session.id, branch, worktree: where.worktree, cwd: where.cwd, mode: opts.mode, command: null, launched: !!runId, ...(runId ? { runId } : {}), engine: engineId, ...(warnings.length ? { warnings } : {}) };
    }

    const terminalWords = CODE_WORDS(ctx.settings.locale?.());
    // A session still sitting in its herdr pane takes the next prompt there: no new terminal, no new token.
    if (live?.herdrPane && (await this.continueInPane(live, engineId, withClaimFirst(agent, engineId, item.key, terminalPrompt)))) {
      store.patchSession(projectId, session.id, { state: "running", lastEventAt: now, activity: null });
      this.host.notify(projectId);
      return { ok: true, continued, threadId: thread.id, sessionId: session.id, branch, worktree: where.worktree, cwd: where.cwd, mode: opts.mode, command: null, launched: true, pane: live.herdrPane, engine: engineId, ...(warnings.length ? { warnings } : {}) };
    }
    const files = this.host.sessions.bind(session, `ai:${engineId}` as Author, this.host.sessionDir(session.id), withClaimFirst(agent, engineId, item.key, terminalPrompt));
    if (!files) return { ok: false, gate: "mcp", message: "the MCP server is not running — enable the mcp plugin" };
    const { bin, path: onPath } = await binOf(agent, engineId);
    const options = agent.optionsOf(thread, engineId);
    const baseCommand = this.command(terminalSettings, engineId, session, files, where.cwd, options, bin);
    const tooLong = this.promptTooLong(terminalSettings, engineId, session, files, baseCommand, terminalWords.locale);
    if (tooLong) return tooLong;
    const wrapped = githubHttps(repo.remote) && await ctx.github.usesHelper(this.host.git, where.cwd);
    const command = wrapped ? ctx.github.wrap(baseCommand) : baseCommand;
    const baseResume = this.resumeCommand(terminalSettings, engineId, files, where.cwd, options, bin);
    const resume = baseResume && wrapped ? ctx.github.wrap(baseResume) : baseResume;
    const workspace = this.workspaceOf(projectId);
    const launch = await this.host.herdr.launch({ cwd: where.cwd, command, env: { TOMRADE_MCP_TOKEN: files.token }, dir: files.dir, path: onPath, label: item.key, ...(workspace ? { workspace } : {}), ...(resume ? { resume } : {}) }, terminalSettings.terminal);
    const fallback = this.host.herdr.fallbackNote(terminalWords.locale, launch);
    if (fallback) warnings.push(fallback);
    store.patchSession(projectId, session.id, { state: "running", lastEventAt: now, ...(launch.paneId ? { herdrPane: launch.paneId } : {}) });
    this.host.notify(projectId);
    return { ok: true, continued, threadId: thread.id, sessionId: session.id, branch, worktree: where.worktree, cwd: where.cwd, mode: opts.mode, command, launched: launch.launched, pane: launch.paneId ?? null, engine: engineId, ...(warnings.length ? { warnings } : {}) };
  }

  /**
   * A conversation with no ticket, taken up in a terminal: its engine's CLI resumes the thread's own session in
   * `cwd`, the folder the thread's runs use (Claude Code keeps its sessions by folder), with Tomrade's tools and
   * hooks, as a terminal session of the thread. The caller has closed the thread's warm runtime first; nothing else
   * of Start's — no ticket, no branch, no worktree — applies, and the thread leaves the panel's list for the bar's.
   */
  async startThread(projectId: string, thread: ThreadSummary, input: { cwd: string; externalId: string | null; prompt: string }): Promise<StartResult> {
    const { ctx, store } = this.host;
    const agent = ctx.get("agent");
    if (!agent) return { ok: false, gate: "engine", message: "the agent plugin is not loaded" };
    if (!ctx.get("mcp")?.url) return { ok: false, gate: "mcp", message: "the MCP server is not running — enable the mcp plugin" };
    const picked = await this.pickEngine(agent, thread.engine, true);
    if (!picked.ok) return { ok: false, gate: "engine", message: picked.reason, engine: thread.engine };
    const engineId = picked.engine.id;
    const terminalSettings = await this.host.herdr.terminalSettings();
    const locale = ctx.settings.locale?.() ?? "en";
    const now = Date.now();
    const session = store.createSession(projectId, { repoId: "", branch: "", itemIds: [], mode: "terminal", agent: engineId, threadId: thread.id, device: ctx.hub.deviceId, externalId: input.externalId });
    store.patchSession(projectId, session.id, { cwd: input.cwd, ...(thread.title ? { title: thread.title } : {}) });
    const files = this.host.sessions.bind(session, `ai:${engineId}` as Author, this.host.sessionDir(session.id), input.prompt);
    if (!files) return { ok: false, gate: "mcp", message: "the MCP server is not running — enable the mcp plugin" };
    const { bin, path: onPath } = await binOf(agent, engineId);
    const options = agent.optionsOf(thread, engineId);
    const command = this.command(terminalSettings, engineId, session, files, input.cwd, options, bin);
    const tooLong = this.promptTooLong(terminalSettings, engineId, session, files, command, locale);
    if (tooLong) {
      store.patchSession(projectId, session.id, { state: "ended", endedAt: now, activity: null });
      return tooLong;
    }
    const resume = this.resumeCommand(terminalSettings, engineId, files, input.cwd, options, bin);
    const workspace = this.workspaceOf(projectId);
    const launch = await this.host.herdr.launch({ cwd: input.cwd, command, env: { TOMRADE_MCP_TOKEN: files.token }, dir: files.dir, path: onPath, label: thread.title || picked.engine.title, ...(workspace ? { workspace } : {}), ...(resume ? { resume } : {}) }, terminalSettings.terminal);
    store.patchSession(projectId, session.id, { state: "running", lastEventAt: now, ...(launch.paneId ? { herdrPane: launch.paneId } : {}) });
    // In the bar as its session from now on, as a ticket's terminal conversation is; back in the panel's list once it returns.
    agent.store.touchThread(projectId, thread.id, { surface: "code" });
    this.host.notify(projectId);
    const fallback = this.host.herdr.fallbackNote(locale, launch);
    return { ok: true, continued: true, threadId: thread.id, sessionId: session.id, branch: "", worktree: null, cwd: input.cwd, mode: "terminal", command, launched: launch.launched, pane: launch.paneId ?? null, engine: engineId, ...(fallback ? { warnings: [fallback] } : {}) };
  }

  /**
   * An ended terminal session on no ticket, taken up again in the background: its agent resumes the same session id
   * in the folder it ran in, in a terminal pane nothing brings to the front, as the same session — the bar shows it
   * running again. One process on a session at a time: a session still live is left as it is.
   */
  async resumeSession(projectId: string, sessionId: string): Promise<StartResult> {
    const { ctx, store } = this.host;
    const session = store.session(projectId, sessionId);
    const agent = ctx.get("agent");
    if (!agent) return { ok: false, gate: "engine", message: "the agent plugin is not loaded" };
    if (!session?.externalId || !session.cwd) return { ok: false, gate: "workdir", message: "this conversation cannot be taken up again here" };
    if (session.state !== "ended" && session.state !== "lost") return { ok: false, gate: "engine", message: "this conversation is still running" };
    if (!ctx.get("mcp")?.url) return { ok: false, gate: "mcp", message: "the MCP server is not running — enable the mcp plugin" };
    const picked = await this.pickEngine(agent, session.agent, true);
    if (!picked.ok) return { ok: false, gate: "engine", message: picked.reason, engine: session.agent };
    const engineId = picked.engine.id;
    const terminalSettings = await this.host.herdr.terminalSettings();
    const files = this.host.sessions.bind(session, `ai:${engineId}` as Author, this.host.sessionDir(session.id), RESUME_PROMPT);
    if (!files) return { ok: false, gate: "mcp", message: "the MCP server is not running — enable the mcp plugin" };
    const { bin, path: onPath } = await binOf(agent, engineId);
    const command = this.command(terminalSettings, engineId, session, files, session.cwd, agent.optionsOf({ options: null }, engineId), bin);
    const workspace = this.workspaceOf(projectId);
    const launch = await this.host.herdr.launch({ cwd: session.cwd, command, env: { TOMRADE_MCP_TOKEN: files.token }, dir: files.dir, path: onPath, label: session.title || picked.engine.title, ...(workspace ? { workspace } : {}) }, terminalSettings.terminal);
    const now = Date.now();
    store.patchSession(projectId, session.id, { state: "running", endedAt: null, activity: null, lastEventAt: now, ...(launch.paneId ? { herdrPane: launch.paneId } : {}) });
    this.host.notify(projectId);
    return { ok: true, continued: true, threadId: null, sessionId: session.id, branch: session.branch, worktree: session.worktree, cwd: session.cwd, mode: "terminal", command, launched: launch.launched, pane: launch.paneId ?? null, engine: engineId };
  }

  /**
   * A coding agent started on the person's own words, with no ticket and no thread: a terminal session in `cwd`, with
   * Tomrade's tools and hooks. The repository's instructions have it claim a ticket before it changes code.
   */
  async startLoose(projectId: string, input: { engine?: string; prompt: string; cwd: string }): Promise<StartResult> {
    const { ctx, store } = this.host;
    const agent = ctx.get("agent");
    if (!agent) return { ok: false, gate: "engine", message: "the agent plugin is not loaded" };
    if (!ctx.get("mcp")?.url) return { ok: false, gate: "mcp", message: "the MCP server is not running — enable the mcp plugin" };
    const picked = await this.pickEngine(agent, input.engine, true);
    if (!picked.ok) return { ok: false, gate: "engine", message: picked.reason, ...(input.engine ? { engine: input.engine } : {}) };
    const engineId = picked.engine.id;
    const terminalSettings = await this.host.herdr.terminalSettings();
    const locale = ctx.settings.locale?.() ?? "en";
    const now = Date.now();
    const title = input.prompt.trim().split("\n")[0]!.slice(0, 80);
    const session = store.createSession(projectId, { repoId: "", branch: "", itemIds: [], mode: "terminal", agent: engineId, threadId: null, device: ctx.hub.deviceId });
    store.patchSession(projectId, session.id, { cwd: input.cwd, title, prompted: true });
    const ended = () => store.patchSession(projectId, session.id, { state: "ended", endedAt: now, activity: null });
    const files = this.host.sessions.bind(session, `ai:${engineId}` as Author, this.host.sessionDir(session.id), loosePrompt(input.prompt, locale));
    if (!files) {
      ended();
      return { ok: false, gate: "mcp", message: "the MCP server is not running — enable the mcp plugin" };
    }
    const { bin, path: onPath } = await binOf(agent, engineId);
    const command = this.command(terminalSettings, engineId, { externalId: null }, files, input.cwd, agent.optionsOf({}, engineId), bin);
    const tooLong = this.promptTooLong(terminalSettings, engineId, session, files, command, locale);
    if (tooLong) {
      ended();
      return tooLong;
    }
    const workspace = this.workspaceOf(projectId);
    const launch = await this.host.herdr.launch({ cwd: input.cwd, command, env: { TOMRADE_MCP_TOKEN: files.token }, dir: files.dir, path: onPath, label: title || picked.engine.title, ...(workspace ? { workspace } : {}) }, terminalSettings.terminal);
    store.patchSession(projectId, session.id, { state: "running", lastEventAt: now, ...(launch.paneId ? { herdrPane: launch.paneId } : {}) });
    this.host.notify(projectId);
    const fallback = this.host.herdr.fallbackNote(locale, launch);
    return { ok: true, continued: false, threadId: null, sessionId: session.id, branch: "", worktree: null, cwd: input.cwd, mode: "terminal", command, launched: launch.launched, pane: launch.paneId ?? null, engine: engineId, ...(fallback ? { warnings: [fallback] } : {}) };
  }

  /** The thread's terminal session whose agent still runs, if any: one whose agent exited, its pane back at the shell, ends here. */
  liveTerminalSession(projectId: string, threadId: string): SessionView | null {
    const sessions = this.host.store.sessions(projectId, { live: true }).filter((s) => s.threadId === threadId && s.mode === "terminal" && s.state !== "lost");
    return sessions.find((s) => !this.host.sessions.endIfExited(projectId, s.id)) ?? null;
  }

  /** A headless run refused because the conversation's agent is in a terminal: one process on its session at a time. */
  private terminalGate(key: string, session: SessionView): StartResult {
    const where = session.herdrPane ? `herdr pane ${session.herdrPane}` : (session.terminal ?? "a terminal");
    return { ok: false, gate: "pane", message: `${key} goes on in ${where}; wait for its agent to exit, or go on with it there`, ...(session.herdrPane ? { pane: session.herdrPane } : {}) };
  }

  /** A project's sessions share one herdr workspace, a tab each. */
  private workspaceOf(projectId: string): { key: string; label: string } | undefined {
    const name = (this.host.ctx.db.for(projectId).prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined)?.name;
    return name ? { key: projectId, label: name } : undefined;
  }

  /**
   * The next prompt into the pane a session already runs in, with herdr: the prompt file is
   * written as always and the agent told to read it, over the session's own token — bound again
   * if Tomrade restarted in between. False when the pane, the agent, or herdr is not there.
   */
  private async continueInPane(session: SessionView, engineId: string, prompt: string): Promise<boolean> {
    const pane = session.herdrPane;
    if (!pane || !(await this.host.herdr.paneAlive(pane))) return false;
    const dir = this.host.sessionDir(session.id);
    if (!this.host.sessions.token(session.id) && !this.host.sessions.rebind(session, `ai:${engineId}` as Author, dir)) return false;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "prompt.md");
    fs.writeFileSync(file, prompt);
    return this.host.herdr.prompt(pane, `Tomrade: continue this ticket — read ${file} and follow it.`);
  }

  /**
   * A terminal agent that claimed the ticket itself (over MCP, no thread of Tomrade's) and still runs in its herdr pane,
   * often working other tickets there too: Continue is a prompt in that pane, never a second agent on the ticket. Null
   * when no such pane is alive, and Start goes on as usual.
   */
  private async continueClaimed(projectId: string, item: Item, repo: Repo, checkout: string | null): Promise<StartResult | null> {
    const { ctx, store } = this.host;
    const delivery = store.currentDelivery(projectId, item.id)?.sequence;
    const session = store.sessions(projectId, { itemId: item.id, live: true }).find((s) => s.mode === "terminal" && !s.threadId && s.herdrPane && s.state !== "lost" && (delivery === undefined || s.delivery === delivery));
    if (!session?.herdrPane || (await this.host.herdr.paneAlive(session.herdrPane)) !== true) return null;
    const link = store.links(projectId, item.id).find((l) => l.repoId === repo.id && l.branch === session.branch) ?? null;
    const local = !!checkout && !(await new GitFolder(this.host.git, checkout).remoteUrl());
    const prompt = continuePrompt(item, repo, session, link, ctx.codeLink.completionPolicy(projectId, item), local, ctx.settings.locale?.() ?? "en", store.repoState(projectId, repo.id)?.agentMerge ?? false);
    const dir = this.host.sessionDir(session.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "prompt.md");
    fs.writeFileSync(file, prompt);
    if (!(await this.host.herdr.prompt(session.herdrPane, `Tomrade: continue ${item.key} — read ${file} and follow it.`))) {
      // Its agent is there but did not take it (waiting on the person, say): a second agent is not the answer.
      if ((await this.host.herdr.pane(session.herdrPane))?.agent) return { ok: false, gate: "pane", message: `${item.key} is still worked by the agent in herdr pane ${session.herdrPane}, which did not take the prompt — go on with it there`, pane: session.herdrPane };
      return null;
    }
    store.patchSession(projectId, session.id, { blocked: null, state: "running", activity: null, lastEventAt: Date.now() });
    this.host.notify(projectId);
    const cwd = session.worktree ?? session.cwd ?? checkout ?? "";
    return { ok: true, continued: true, threadId: null, sessionId: session.id, branch: session.branch, worktree: session.worktree, cwd, mode: "terminal", command: null, launched: true, pane: session.herdrPane, engine: session.agent };
  }

  /**
   * The worktree git keeps the ticket's branch in: whether letting go of the branch there loses
   * nothing — a linked worktree, not the person's checkout, with no uncommitted changes and no
   * session running in it — and whether it is where this ticket was worked before.
   */
  private async branchHolder(projectId: string, itemId: string, heldAt: string): Promise<{ releasable: boolean; ours: boolean }> {
    const git = this.host.git;
    const real = (dir: string) => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } };
    const at = real(heldAt);
    const sessions = this.host.store.sessions(projectId);
    const there = (s: (typeof sessions)[number]) => (s.worktree ? real(s.worktree) === at : false) || (!!s.threadId && path.basename(at) === s.threadId);
    const ours = sessions.some((s) => s.itemIds.includes(itemId) && there(s));
    if (sessions.some((s) => s.state === "running" && there(s))) return { releasable: false, ours };
    const dirs = await git(["rev-parse", "--git-dir", "--git-common-dir"], { cwd: heldAt, ok: true });
    const [own, common] = dirs.stdout.trim().split("\n").map((d) => path.resolve(heldAt, d.trim()));
    if (dirs.code !== 0 || !own || own === common) return { releasable: false, ours };
    const status = await git(["status", "--porcelain", "--untracked-files=no"], { cwd: heldAt, ok: true });
    return { releasable: status.code === 0 && !status.stdout.trim(), ours };
  }

  /** Detaches the other worktree at the commit it is on: its files stay as they are, and the branch is free to check out here. */
  private async releaseBranch(heldAt: string): Promise<boolean> {
    return (await this.host.git(["switch", "--detach"], { cwd: heldAt, ok: true })).code === 0;
  }

  /** A carried conversation's worktree onto the new delivery's branch, from the default branch; the reason it cannot, or null. */
  private async moveWorktree(worktree: string, branch: string, defaultBranch: string, carry = false): Promise<string | null> {
    const git = this.host.git;
    const head = (await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree, ok: true })).stdout.trim();
    if (head === branch) return null;
    const dirty = !!(await git(["status", "--porcelain"], { cwd: worktree, ok: true })).stdout.trim();
    // A conversation claiming the ticket it is writing for: the branch starts where its copy is, its changes with it.
    if (dirty && carry) {
      const exists = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: worktree, ok: true })).code === 0;
      const switched = await git(exists ? ["switch", branch] : ["switch", "-c", branch], { cwd: worktree, ok: true });
      return switched.code === 0 ? null : `could not move ${worktree} onto ${branch}: ${(switched.stderr ?? "").trim() || "git switch failed"}`;
    }
    if (dirty) return `${worktree} has uncommitted changes on ${head} — commit or discard them first, so the new delivery starts clean on ${branch}`;
    await git(["fetch", "--quiet", "origin", defaultBranch], { cwd: worktree, ok: true });
    const from = (await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${defaultBranch}`], { cwd: worktree, ok: true })).code === 0 ? `origin/${defaultBranch}` : defaultBranch;
    const exists = (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: worktree, ok: true })).code === 0;
    const switched = await git(exists ? ["switch", branch] : ["switch", "-c", branch, from], { cwd: worktree, ok: true });
    return switched.code === 0 ? null : `could not move ${worktree} onto ${branch}: ${(switched.stderr ?? "").trim() || "git switch failed"}`;
  }

  /**
   * The command herdr runs to bring the session back after a restart of its own — the same as
   * the terminal's, resuming the id the hooks reported (read from a file when it runs, since it
   * is not known yet), with a prompt that says what happened. Only for a terminal of herdr; null
   * for an engine whose command has no place for a resume.
   */
  private resumeCommand(settings: TerminalSettings, engineId: string, files: SessionFiles, cwd: string, options: unknown, bin: string): string | null {
    if (settings.terminal !== "herdr" || !this.template(settings, engineId).includes("{resume}")) return null;
    const prompt = path.join(files.dir, "resume-prompt.md");
    fs.writeFileSync(prompt, "Tomrade: herdr restarted and brought this session back. Carry on where you left off; Tomrade's tools and hooks are connected again.\n");
    return this.command(settings, engineId, { externalId: `"$(cat ${shellQuote(path.join(files.dir, RESUME_ID_FILE))})"` }, { ...files, prompt }, cwd, options, bin);
  }

  /** The engine's own terminal template, else the one its engine ID names in the machine settings. */
  private template(settings: TerminalSettings, engineId: string): string {
    const agent = this.host.ctx.get("agent");
    const declared = agent?.codeEngines().find((engine) => engine.id === agent.answering(engineId))?.terminal?.command;
    return terminalTemplate(settings, engineId, declared);
  }

  /** The terminal command for a session: the engine's template, the knobs picked at Start, and the CLI's own session to resume. */
  private command(settings: TerminalSettings, engineId: string, session: { externalId: string | null }, files: SessionFiles, cwd: string, options: unknown, bin: string): string {
    const template = this.template(settings, engineId);
    const id = session.externalId;
    const resume = id ? (engineId === "codex" ? `resume ${id}` : engineId === "pi" ? `--session-id ${id}` : engineId === "gemini" ? `-r ${id}` : engineId === "opencode" ? `--session ${id}` : engineId === "dsh" ? `--session-id ${id}` : engineId === "agy" ? `--conversation ${id}` : engineId === "other" ? id : `--resume ${id}`) : "";
    return fillTemplate(withOptions(template, optionFlags(engineId, options)), {
      cwd, prompt: files.prompt, mcpConfig: files.mcpConfig, mcpUrl: files.mcpUrl, token: files.token, settings: files.settings, piExtension: files.piExtension,
      geminiHome: files.geminiHome, opencodeConfig: files.opencodeConfig, dshPatch: files.dshPatch, dshReporter: files.dshReporter, resume,
      // The CLI Tomrade located (an app's own copy included), and a runtime for scripts that needs no Node installed.
      bin, node: process.execPath
    });
  }

  /**
   * A prompt the engine's template passes as one argument, past what this platform's command line holds: refused
   * before anything opens, the prompt file left for the person to paste from.
   */
  private promptTooLong(settings: TerminalSettings, engineId: string, session: SessionView, files: SessionFiles, command: string, locale: string | undefined): StartResult | null {
    if (!promptAsArgument(this.template(settings, engineId)) || fitsCommandLine([fs.readFileSync(files.prompt, "utf8"), command])) return null;
    this.host.sessions.release(session.id);
    return { ok: false, gate: "prompt", message: CODE_WORDS(locale)("promptTooLong", { file: files.prompt }) };
  }

  /** No folder for the run: said with its cause, so a screen can point at the one thing that fixes it. */
  private workdirGate(
    projectId: string,
    thread: { boardId: string | null },
    where: { code: string | null; problem: string | null; branch: string | null; heldAt?: string; releasable?: boolean },
    onRepo: Pick<Extract<StartResult, { ok: false }>, "board" | "repo" | "remote">
  ): StartResult {
    if (where.code === "no-checkout") return { ok: false, gate: "checkout", message: where.problem ?? "no checkout on this machine", ...onRepo };
    // The conversation's own workstream, which a continued conversation may not share with the ticket.
    const board = thread.boardId ? this.host.ctx.boards.get(projectId, thread.boardId) : null;
    const onBoard = board ? { board: { id: board.id, name: board.name } } : {};
    const name = board?.name ?? "This conversation's workstream";
    switch (where.code) {
      case "no-board":
        return { ok: false, gate: "workdir", message: "this conversation belongs to no workstream, so it has no repository to work in", cause: { code: "no-board" }, ...onRepo };
      case "no-board-repo":
        return { ok: false, gate: "workdir", message: `${name} has no repository yet — link one under Repositories`, cause: { code: "no-board-repo" }, ...onRepo, ...onBoard };
      case "unknown-repo":
        return { ok: false, gate: "workdir", message: `${name} points at repository ${board?.repoId ?? "?"}, which this project no longer has — link it to another under Repositories`, cause: { code: "unknown-repo", ...(board?.repoId ? { repoId: board.repoId } : {}) }, ...onRepo, ...onBoard };
      case "no-hub":
        return { ok: false, gate: "workdir", message: where.problem ?? "no Hub folder is chosen on this machine", cause: { code: "no-hub" }, ...onRepo };
      case "branch-in-use":
        return { ok: false, gate: "workdir", message: where.problem ?? "the branch is checked out in another worktree", cause: { code: "branch-in-use", ...(where.branch ? { branch: where.branch } : {}), ...(where.heldAt ? { heldAt: where.heldAt } : {}), releasable: !!where.releasable }, ...onRepo };
      case "folder-outside": {
        const checkout = onRepo.remote ? this.host.ctx.repos.checkout(onRepo.remote).checkout : null;
        return { ok: false, gate: "workdir", message: where.problem ?? "the workstream's folder lies outside the checkout", cause: { code: "folder-outside", folder: normalizeRepoPath(board?.repoPath ?? ""), ...(checkout ? { checkout } : {}) }, ...onRepo, ...onBoard };
      }
      default:
        return { ok: false, gate: "workdir", message: where.problem ?? "no working folder for this conversation", ...onRepo };
    }
  }

  /**
   * A General ticket needs no repository: the agent platform binds the thread
   * to the delivery and the playbook, and the work runs in a scratch folder —
   * headless in the panel, or in the user's own terminal over MCP exactly like
   * a coding session, so the ticket follows it the same way.
   */
  private async startGeneral(projectId: string, item: Item, opts: StartOptions): Promise<StartResult> {
    const { ctx, store } = this.host;
    const agent = ctx.get("agent");
    if (!agent) return { ok: false, gate: "engine", message: "the agent plugin is not loaded" };
    const terminalSettings = await this.host.herdr.terminalSettings();
    const locale = ctx.settings.locale?.() ?? "en";
    const mode: SessionMode = opts.mode === "run" ? "headless" : "terminal";
    if (opts.mode === "terminal" && !ctx.get("mcp")?.url) return { ok: false, gate: "mcp", message: "the MCP server is not running — enable the mcp plugin" };
    const other = opts.mode === "terminal" && opts.engine === "other";
    if (other && !terminalSettings.otherCommand.trim()) return { ok: false, gate: "engine", message: "No command is set for another CLI agent — add one under Settings → Code link" };
    const asked = opts.mode === "terminal" && !other && opts.engine ? agent.codeEngines().find((e) => e.id === agent.answering(opts.engine!)) : undefined;
    const refused = opts.mode === "terminal" && !other && opts.engine ? insideOnly(agent, opts.engine) ?? (asked ? await linkFirst(asked, locale) : null) : null;
    if (refused) return { ok: false, gate: "engine", message: refused, ...(opts.engine ? { engine: opts.engine } : {}) };
    const blockers = this.openBlockers(projectId, item);
    if (blockers.length && !opts.allowBlocked) return blockedGate(item, blockers);
    // The ticket's conversation goes on in a terminal right now: a run here would be a second process on its session.
    const inTerminal = opts.mode === "run" ? agent.store.threadsForItem(projectId, item.id).map((t) => this.liveTerminalSession(projectId, t.id)).find((s) => !!s) ?? null : null;
    if (inTerminal) return this.terminalGate(item.key, inTerminal);
    const prepared = await agent.prepareGeneral(projectId, item.id, {
      ...(other ? {} : { engine: opts.engine }),
      playbook: opts.playbook,
      options: opts.options,
      surface: opts.mode === "terminal" ? "code" : "assistant",
      external: other,
      allowBlocked: opts.allowBlocked
    });
    const thread = agent.store.thread(projectId, prepared.threadId)!;
    const engineId = other ? "other" : prepared.engine;
    const delivery = store.ensureActiveDelivery(projectId, item.id, item.updatedAt);
    const now = Date.now();
    const onThread = store.sessions(projectId, { itemId: item.id, delivery: delivery.sequence }).filter((s) => s.threadId === thread.id);
    const live = onThread.find((s) => s.state !== "ended" && s.mode === mode) ?? null;
    const externalId = agent.store.external(projectId, thread.id)[engineId] ?? onThread.find((s) => s.agent === engineId && s.externalId)?.externalId ?? null;
    const session =
      live ??
      store.createSession(projectId, { repoId: "", delivery: delivery.sequence, branch: "", itemIds: [item.id], mode, agent: engineId, threadId: thread.id, device: ctx.hub.deviceId, externalId });
    if (prepared.continued && (session.blocked || session.state === "error")) store.patchSession(projectId, session.id, { blocked: null, state: "idle", activity: null });
    const base = { ok: true as const, continued: prepared.continued, threadId: thread.id, sessionId: session.id, branch: "", worktree: null, cwd: prepared.cwd, mode: opts.mode, engine: engineId };
    const added = opts.message?.trim() ? `\n\n${opts.message.trim()}` : "";

    if (opts.mode === "run") {
      const runId = agent.activeRuns().find((a) => a.thread.id === thread.id)?.run.id ?? agent.send(projectId, thread.id, { kind: "text", text: `${prepared.opener}\n${languageLine(locale)}${added}` }, sourced(opts)).runId;
      store.patchSession(projectId, session.id, { state: "running", lastEventAt: now });
      this.host.notify(projectId);
      return { ...base, command: null, launched: true, runId };
    }

    // The thread may have brought its own engine; one that runs only inside Tomrade has no terminal session.
    const chosen = agent.codeEngines().find((e) => e.id === agent.answering(engineId));
    const inside = insideOnly(agent, engineId) ?? (chosen ? await linkFirst(chosen, locale) : null);
    if (inside) return { ok: false, gate: "engine", message: inside, engine: engineId };
    const generalPrompt = withClaimFirst(agent, engineId, item.key, `${prepared.prompt}\n\n${languageLine(locale)}${added}`);
    if (live?.herdrPane && (await this.continueInPane(live, engineId, generalPrompt))) {
      store.patchSession(projectId, session.id, { state: "running", lastEventAt: now, activity: null });
      this.host.notify(projectId);
      return { ...base, command: null, launched: true, pane: live.herdrPane };
    }
    const files = this.host.sessions.bind(session, `ai:${engineId}` as Author, this.host.sessionDir(session.id), generalPrompt);
    if (!files) return { ok: false, gate: "mcp", message: "the MCP server is not running — enable the mcp plugin" };
    const { bin, path: onPath } = await binOf(agent, engineId);
    const options = agent.optionsOf(thread, engineId);
    const command = this.command(terminalSettings, engineId, session, files, prepared.cwd, options, bin);
    const tooLong = this.promptTooLong(terminalSettings, engineId, session, files, command, locale);
    if (tooLong) return tooLong;
    const resume = this.resumeCommand(terminalSettings, engineId, files, prepared.cwd, options, bin);
    const launch = await this.host.herdr.launch({ cwd: prepared.cwd, command, env: { TOMRADE_MCP_TOKEN: files.token }, dir: files.dir, path: onPath, label: item.key, ...(resume ? { resume } : {}) }, terminalSettings.terminal);
    store.patchSession(projectId, session.id, { state: "running", lastEventAt: now, ...(launch.paneId ? { herdrPane: launch.paneId } : {}) });
    this.host.notify(projectId);
    const fallback = this.host.herdr.fallbackNote(locale, launch);
    return { ...base, command, launched: launch.launched, pane: launch.paneId ?? null, ...(fallback ? { warnings: [fallback] } : {}) };
  }

  /** The first code engine that can take a ticket right now; one that can only chat (Tomrade with no model) is passed over. */
  async pickEngine(agent: Agent, asked?: string, terminal = false): Promise<{ ok: true; engine: Engine } | { ok: false; reason: string }> {
    const wanted = asked && agent.answering(asked);
    const inside = terminal && wanted ? insideOnly(agent, wanted) : null;
    if (inside) return { ok: false, reason: inside };
    const only = !terminal && wanted ? agent.codeEngines().find((e) => e.id === wanted && e.terminal?.mode === "only") : undefined;
    if (only) return { ok: false, reason: `${only.title} runs only in a terminal — choose In a terminal` };
    const candidates = agent.codeEngines().filter((e) => (!wanted || e.id === wanted) && (!terminal || e.terminal?.mode !== "none") && (terminal || e.terminal?.mode !== "only"));
    if (!candidates.length) return { ok: false, reason: wanted ? `${wanted} is not a code-capable engine` : "No local coding agent is installed — add Claude Code, Codex or Pi, then try again" };
    const reasons: string[] = [];
    for (const engine of candidates) {
      const state: EngineAvailability = await engine.available().catch((err: unknown) => ({ ok: false, reason: errorMessage(err) }));
      if (!state.ok) {
        reasons.push(`${engine.title}: ${state.reason ?? "not available"}`);
        continue;
      }
      if (state.capabilities && !state.capabilities.includes("code")) {
        reasons.push(`${engine.title}: can only chat for now — connect a model in Settings → Assistant to run tickets`);
        continue;
      }
      const unlinked = terminal ? await linkFirst(engine, this.host.ctx.settings.locale?.()) : null;
      if (unlinked) {
        reasons.push(unlinked);
        continue;
      }
      return { ok: true, engine };
    }
    return { ok: false, reason: reasons.join(" · ") };
  }

  /**
   * The first of a role's agents that can take a ticket right now, in the role's order. None of them: the Start is
   * refused with each one's reason, never handed to an agent the role does not name.
   */
  async pickForRole(agent: Agent, role: Pick<Role, "title" | "engines">, terminal = false): Promise<{ ok: true; engine: Engine } | { ok: false; reason: string }> {
    const reasons: string[] = [];
    for (const id of role.engines) {
      const picked = await this.pickEngine(agent, id, terminal);
      if (picked.ok) return picked;
      reasons.push(picked.reason);
    }
    return { ok: false, reason: `None of the agents of the role ${role.title} can start here — ${reasons.join(" · ")}` };
  }

  /** Who can take a ticket over from the engines it stopped on: the agent's pick, past any a terminal Start would refuse until it is linked. */
  async takeOver(agent: Agent, stopped: readonly string[], need: { capability: EngineCapability; terminal: boolean }): Promise<Engine | null> {
    const passed = [...stopped];
    for (;;) {
      const engine = await agent.nextEngine(passed, need);
      if (!engine || !need.terminal || !(await linkFirst(engine, this.host.ctx.settings.locale?.()))) return engine;
      passed.push(engine.id);
    }
  }

  private openBlockers(projectId: string, item: Item): Item[] {
    return item.blockedBy.map((id) => this.host.ctx.items.get(projectId, id)).filter((b): b is Item => !!b && OPEN.has(b.status));
  }

  /** The one ticket that stands between an empty repository and every other ticket on its workstream. */
  ensureBootstrap(projectId: string, item: Item, board: Board, repo: Repo): Item {
    const { ctx } = this.host;
    let bootstrap = ctx.items.list({ projectId }).find((i) => i.boardId === board.id && i.labels.includes(BOOTSTRAP_LABEL) && OPEN.has(i.status)) ?? null;
    if (!bootstrap) {
      bootstrap = ctx.items.create({ projectId, boardId: board.id, title: `Bootstrap ${repo.name}: stack, scaffold, CLAUDE.md`, body: bootstrapBody(repo), status: "todo", priority: 3, labels: [BOOTSTRAP_LABEL], by: "human" });
    }
    if (!bootstrap.blocks.includes(item.id)) bootstrap = ctx.items.update(projectId, bootstrap.id, { blocks: [...bootstrap.blocks, item.id] }, "human");
    return bootstrap;
  }
}

/**
 * Every terminal agent is told to claim the ticket before anything else: one
 * whose connection carries no session token needs the claim to be tied to this
 * session, and one Tomrade started still claims so its ticket and sidebar are
 * on the ticket from the first move, as Claude Code's instructions have it.
 */
function withClaimFirst(agent: Agent, engineId: string, key: string, prompt: string): string {
  const engine = agent.codeEngines().find((e) => e.id === agent.answering(engineId));
  if (engine?.terminal?.mode === "none") return prompt;
  const why = engine?.terminal?.claims
    ? "this session reaches Tomrade without a session token, and the claim ties it to this ticket"
    : "the claim keeps this session and its sidebar on the ticket";
  const claim = `Before anything else, call the tomrade MCP tool claim_ticket with key "${key}": ${why}.`;
  // After the opening line, which names the ticket and makes the better conversation title.
  const [first, ...rest] = prompt.split("\n");
  return `${first}\n\n${claim}\n${rest.join("\n")}`;
}

/** The CLI an engine located — an app's own copy included — for a template's {bin}, and the folders it runs with; a bare name when it found none. */
async function binOf(agent: Agent, engineId: string): Promise<{ bin: string; path: TerminalPath }> {
  const engine = agent.codeEngines().find((e) => e.id === agent.answering(engineId));
  const cli = (await engine?.available().catch(() => null))?.cli;
  const found = cli?.path && cli.state !== "missing" ? cli : null;
  return { bin: found ? bashBin(found.path!) : (cli?.name ?? bareCommand(engineId)), path: terminalPath(found) };
}

/** On Windows, the sh shim npm writes beside a `.cmd`, as Git Bash picks by name: no cmd.exe to cut the prompt at its first line break. */
function bashBin(file: string, platform: NodeJS.Platform = process.platform): string {
  const shim = platform === "win32" ? file.replace(/\.cmd$/i, "") : file;
  return shim !== file && fs.existsSync(shim) ? shim : file;
}

/**
 * An engine that reaches Tomrade in a terminal only through its own
 * connection: if that is not made, make it now — Tomrade's address is known,
 * and the file is its own entry — rather than send the person to Settings.
 */
async function linkFirst(engine: Engine, locale: string | undefined): Promise<string | null> {
  if (engine.terminal?.via !== "link") return null;
  const link = engine.local?.mcpLink;
  if (!link) return CODE_WORDS(locale)("linkFirst", { title: engine.title });
  const made = (state: string | undefined) => state === "connected";
  if (made((await link.status().catch(() => null))?.state)) return null;
  if (made((await link.connect().catch(() => null))?.state)) return null;
  return CODE_WORDS(locale)("linkFirst", { title: engine.title });
}

/** Why an engine cannot be handed a ticket in a terminal, or null when it can. */
function insideOnly(agent: Agent, engineId: string): string | null {
  const engine = agent.codeEngines().find((e) => e.id === agent.answering(engineId));
  return engine?.terminal?.mode === "none" ? `${engine.title} runs only inside Tomrade — choose Run here, or set up another CLI agent under Settings → Code link` : null;
}
