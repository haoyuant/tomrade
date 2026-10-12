import fs from "node:fs";
import type { Context } from "cordis";
import type { Agent, Engine } from "@tomradex/agent";
import type {} from "@tomradex/boards";
import type {} from "@tomradex/hub";
import type {} from "@tomradex/items";
import type {} from "@tomradex/repos";
import type {} from "@tomradex/settings";
import type { Author, Board, Item, Repo } from "@tomradex/domain";
import { GitFolder, type Git } from "@tomradex/storage";
import { listDecisions } from "./decisions.js";
import { branchFor } from "./keys.js";
import { BOOTSTRAP_LABEL, bootstrapBody, continuePrompt, firstPrompt } from "./prompts.js";
import { classifyRemoteFailure, probeRemote, remoteFailureDetail, remoteFailureMessage, scrubRemoteOutput } from "./remote.js";
import type { SessionFiles, Sessions } from "./sessions.js";
import type { CodeLinkStore, RepoStateView, SessionMode } from "./store.js";
import { TerminalSettings, fillTemplate, launchTerminal, optionFlags, terminalTemplate, withOptions } from "./terminal.js";
import { githubHttps, usesTomradeCredential, withGithubCredential } from "./credentials.js";

export type StartMode = "run" | "terminal";
export type StartGate = "locked" | "workstream" | "checkout" | "remote" | "readiness" | "blocked" | "engine" | "mcp" | "workdir";

/** What the Start dialog settles: where the work runs, who runs it, and with which knobs. */
export interface StartOptions {
  mode: StartMode;
  /** An engine id, or "other" for the terminal command template that names any MCP-capable CLI. Absent picks the first available. */
  engine?: string;
  /** General tickets only: the delivery method; absent keeps the thread's, or the ticket's default. */
  playbook?: string;
  /** Engine option overrides for the thread (model, effort…); given, they replace earlier overrides. */
  options?: Record<string, unknown>;
  /** Headless coding runs only: the permission mode the engine works under. */
  permissionMode?: string;
  /** Start although tickets this one waits on are still open; the agent is told which. */
  allowBlocked?: boolean;
}

export type StartResult =
  | { ok: false; gate: StartGate; message: string; bootstrapKey?: string; remote?: string; blockers?: string[] }
  | {
      ok: true;
      /** An earlier thread on this ticket was picked up rather than a new one opened. */
      continued: boolean;
      threadId: string;
      sessionId: string;
      branch: string;
      worktree: string | null;
      cwd: string;
      mode: StartMode;
      /** Terminal mode: the command that was (or is to be) run; null for a headless run. */
      command: string | null;
      /** Terminal mode: whether a terminal window was actually opened. */
      launched: boolean;
      /** Headless mode: the run that was started. */
      runId?: string;
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
  git: Git;
  scan(projectId: string): Promise<unknown>;
  notify(projectId: string): void;
  sessionDir(sessionId: string): string;
  /** Machine-local: where each thread's worktree is, for the section and the terminal. */
  worktrees: Map<string, string>;
}

const OPEN = new Set(["backlog", "todo", "doing", "verifying"]);

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
    if (!board?.repoId) return { ok: false, gate: "workstream", message: `${board?.name ?? "This workstream"} has no repository yet — link one under Repositories` };
    const repo = ctx.repos.get(projectId, board.repoId);
    if (!repo) return { ok: false, gate: "workstream", message: `${board.name} points at a repository this project no longer has` };
    const placement = ctx.repos.checkout(repo.remote);
    if (!placement.checkout || !fs.existsSync(placement.checkout)) {
      return { ok: false, gate: "checkout", message: `No checkout of ${repo.name} on this machine — point Tomrade at yours, or let it clone one`, remote: repo.remote };
    }

    let state = store.repoState(projectId, repo.id);
    if (!state?.scannedAt) {
      await this.host.scan(projectId);
      state = store.repoState(projectId, repo.id);
    }
    const warnings: string[] = [];
    // A checkout with no origin is a local repository: nothing to reach, nothing to push.
    const local = !(await new GitFolder(this.host.git, placement.checkout).remoteUrl());
    const probe = local ? null : await probeRemote(this.host.git, placement.checkout, repo.defaultBranch);
    if (probe?.state === "offline") {
      if (probe.failure !== "network") return { ok: false, gate: "remote", message: remoteFailureMessage(probe.stderr), remote: repo.remote };
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
        if (state?.readiness === "unknown") return { ok: false, gate: "remote", message: `${repo.remote} has ${repo.defaultBranch}, but this checkout cannot fetch it — check the credentials that checkout uses`, remote: repo.remote };
      }
    }
    const delivery = store.ensureActiveDelivery(projectId, item.id, item.updatedAt);
    const deliveryLinks = store.links(projectId, item.id).filter((link) => link.delivery === delivery.sequence);
    const baseBranch = branchFor(state?.branchTemplate ?? "{key}/{slug}", item.key, item.title);
    const plannedBranch = deliveryLinks.find((link) => link.repoId === repo.id && link.branch)?.branch ?? (delivery.sequence === 1 ? baseBranch : `${baseBranch}-${delivery.sequence}`);
    if (probe && probe.state !== "offline" && (state?.agentPush ?? true)) {
      const pushed = await this.host.git(["push", "--dry-run", "origin", `HEAD:refs/heads/${plannedBranch}`], { cwd: placement.checkout, ok: true });
      if (pushed.code !== 0) {
        const stderr = scrubRemoteOutput(pushed.stderr ?? "");
        const failure = classifyRemoteFailure(stderr);
        if (failure === "credentials") return { ok: false, gate: "remote", message: remoteFailureMessage(stderr), remote: repo.remote };
        if (failure === "network") warnings.push(`origin unreachable right now (${remoteFailureDetail(stderr) ?? "network error"}) — commit locally, do not push until it is back`);
      }
    }
    const bootstrapping = item.labels.includes(BOOTSTRAP_LABEL);
    if (state?.readiness === "empty" && !bootstrapping) {
      const bootstrap = this.ensureBootstrap(projectId, item, board, repo);
      return { ok: false, gate: "readiness", message: `${repo.name} has no project in it yet — ${bootstrap.key} bootstraps it first and blocks ${item.key} until it lands`, bootstrapKey: bootstrap.key };
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
    const terminalSettings = TerminalSettings.parse(ctx.settings.get().codeLink ?? {});
    const mode: SessionMode = opts.mode === "run" ? "headless" : "terminal";
    const surface = mode === "terminal" ? "code" : "assistant";
    // In a terminal any CLI agent with an MCP client will do: "other" is whatever the machine's command template names.
    const other = opts.mode === "terminal" && (opts.engine === "other" || (!opts.engine && agent.codeEngines().length === 0)) && !!terminalSettings.otherCommand.trim();
    let engineId = "other";
    if (!other) {
      const picked = await this.pickEngine(agent, opts.engine, opts.mode === "terminal");
      if (!picked.ok) return { ok: false, gate: "engine", message: picked.reason };
      engineId = picked.engine.id;
    }
    // A terminal session connects back over MCP; without the server there is nothing to start, so nothing is created.
    if (opts.mode === "terminal" && !ctx.get("mcp")?.url) return { ok: false, gate: "mcp", message: "the MCP server is not running — enable the mcp plugin" };

    // An open thread on this ticket is continued, not duplicated.
    const links = store.links(projectId, item.id).filter((l) => l.repoId === repo.id && l.delivery === delivery.sequence && l.branch);
    const previous = links.map((l) => (l.threadId ? agent.store.thread(projectId, l.threadId) : null)).find((t) => !!t) ?? null;
    let continued = false;
    let thread = previous;
    let branch = previous?.branch ?? links[0]?.branch ?? "";
    // An open question takes any message as its answer, and switching engines would drop it: the thread
    // is left as it is and the question handed back, for the person to answer in the conversation.
    const asked = thread && opts.mode === "run" && !agent.activeRuns().some((a) => a.thread.id === thread!.id) ? agent.store.pending(projectId, thread.id)?.question : undefined;
    if (thread) {
      continued = true;
      // continuing a conversation someone archived brings it back, so the run is not out of sight
      if (thread.archived) {
        agent.unarchiveThread(projectId, thread.id);
        thread = agent.store.thread(projectId, thread.id)!;
      }
      if (thread.surface !== surface) {
        agent.store.touchThread(projectId, thread.id, { surface });
        thread = agent.store.thread(projectId, thread.id)!;
      }
      if (!asked && engineId !== "other" && thread.engine !== engineId && !agent.activeRuns().some((a) => a.thread.id === thread!.id)) agent.setEngine(projectId, thread.id, engineId);
    } else {
      branch = plannedBranch;
      thread = agent.newThread(projectId, engineId === "other" ? undefined : engineId, board.id, { itemId: item.id, branch, title: `${item.key} ${item.title}`, surface });
    }
    if (!asked && engineId !== "other" && !agent.activeRuns().some((a) => a.thread.id === thread!.id)) {
      if (opts.options !== undefined) thread = agent.setOptions(projectId, thread.id, opts.options);
      if (opts.permissionMode && opts.mode === "run") agent.setPermissionMode(projectId, thread.id, opts.permissionMode);
    }

    const where = await agent.workdir(projectId, thread.id);
    if (where.problem || !where.cwd) return { ok: false, gate: where.code === "no-checkout" ? "checkout" : "workdir", message: where.problem ?? "no working folder for this thread", remote: repo.remote };
    this.host.worktrees.set(thread.id, where.worktree ?? where.cwd);

    const now = Date.now();
    const link = store.upsertLink(projectId, { itemId: item.id, repoId: repo.id, branch, delivery: delivery.sequence }, { threadId: thread.id, source: continued ? undefined : "start", lastSeenAt: now });
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
        externalId
      });
    if (continued && (session.blocked || session.state === "error")) store.patchSession(projectId, session.id, { blocked: null, state: "idle", activity: null });
    const artifactDir = ctx.get("storage")?.artifactDirFor(projectId) ?? null;
    const decisions = artifactDir ? listDecisions(artifactDir) : [];
    const completionPolicy = ctx.codeLink.completionPolicy(projectId, item);
    const basePrompt = continued
      ? continuePrompt(item, repo, live ?? store.sessions(projectId, { itemId: item.id })[0] ?? null, link, completionPolicy, local)
      : firstPrompt({ item, repo, state, branch, blockers, bootstrap: bootstrapping, mcpUrl: ctx.get("mcp")?.urlFor(projectId) ?? null, decisions, subdir: board.repoPath.replace(/^\/+|\/+$/g, ""), completionPolicy, local });
    const prompt = warnings.length ? `${basePrompt}\n\n${warnings.join("\n")}` : basePrompt;

    if (opts.mode === "run") {
      if (asked) {
        this.host.notify(projectId);
        return { ok: true, continued, threadId: thread.id, sessionId: session.id, branch, worktree: where.worktree, cwd: where.cwd, mode: opts.mode, command: null, launched: false, waitingOn: asked.text, ...(warnings.length ? { warnings } : {}) };
      }
      const runId = agent.activeRuns().find((a) => a.thread.id === thread!.id)?.run.id ?? agent.send(projectId, thread.id, { kind: "text", text: prompt }).runId;
      store.patchSession(projectId, session.id, { state: "running", lastEventAt: now });
      this.host.notify(projectId);
      return { ok: true, continued, threadId: thread.id, sessionId: session.id, branch, worktree: where.worktree, cwd: where.cwd, mode: opts.mode, command: null, launched: true, runId, ...(warnings.length ? { warnings } : {}) };
    }

    const files = this.host.sessions.bind(session, `ai:${engineId}` as Author, this.host.sessionDir(session.id), prompt);
    if (!files) return { ok: false, gate: "mcp", message: "the MCP server is not running — enable the mcp plugin" };
    const baseCommand = this.command(terminalSettings, engineId, session, files, where.cwd, agent.optionsOf(thread, engineId));
    const settings = ctx.settings.config.path;
    const command = githubHttps(repo.remote) && await usesTomradeCredential(this.host.git, where.cwd, settings) ? withGithubCredential(settings, baseCommand) : baseCommand;
    const launch = await launchTerminal({ cwd: where.cwd, command, env: { TOMRADE_MCP_TOKEN: files.token }, dir: files.dir }, terminalSettings.terminal);
    store.patchSession(projectId, session.id, { state: "running", lastEventAt: now });
    this.host.notify(projectId);
    return { ok: true, continued, threadId: thread.id, sessionId: session.id, branch, worktree: where.worktree, cwd: where.cwd, mode: opts.mode, command, launched: launch.launched, ...(warnings.length ? { warnings } : {}) };
  }

  /** The terminal command for a session: the engine's template, the knobs picked at Start, and the CLI's own session to resume. */
  private command(settings: TerminalSettings, engineId: string, session: { externalId: string | null }, files: SessionFiles, cwd: string, options: unknown): string {
    const template = terminalTemplate(settings, engineId);
    const id = session.externalId;
    const resume = id ? (engineId === "codex" ? `resume ${id}` : engineId === "pi" ? `--session-id ${id}` : engineId === "gemini" ? `-r ${id}` : engineId === "opencode" ? `--session ${id}` : engineId === "other" ? id : `--resume ${id}`) : "";
    return fillTemplate(withOptions(template, optionFlags(engineId, options)), {
      cwd, prompt: files.prompt, mcpConfig: files.mcpConfig, mcpUrl: files.mcpUrl, token: files.token, settings: files.settings, piExtension: files.piExtension,
      geminiSettings: files.geminiSettings, opencodeConfig: files.opencodeConfig, resume
    });
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
    const terminalSettings = TerminalSettings.parse(ctx.settings.get().codeLink ?? {});
    const mode: SessionMode = opts.mode === "run" ? "headless" : "terminal";
    if (opts.mode === "terminal" && !ctx.get("mcp")?.url) return { ok: false, gate: "mcp", message: "the MCP server is not running — enable the mcp plugin" };
    const other = opts.mode === "terminal" && opts.engine === "other";
    if (other && !terminalSettings.otherCommand.trim()) return { ok: false, gate: "engine", message: "No command is set for another CLI agent — add one under Settings → Code link" };
    const refused = opts.mode === "terminal" && !other && opts.engine ? insideOnly(agent, opts.engine) : null;
    if (refused) return { ok: false, gate: "engine", message: refused };
    const blockers = this.openBlockers(projectId, item);
    if (blockers.length && !opts.allowBlocked) return blockedGate(item, blockers);
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
    const base = { ok: true as const, continued: prepared.continued, threadId: thread.id, sessionId: session.id, branch: "", worktree: null, cwd: prepared.cwd, mode: opts.mode };

    if (opts.mode === "run") {
      const runId = agent.activeRuns().find((a) => a.thread.id === thread.id)?.run.id ?? agent.send(projectId, thread.id, { kind: "text", text: prepared.opener }).runId;
      store.patchSession(projectId, session.id, { state: "running", lastEventAt: now });
      this.host.notify(projectId);
      return { ...base, command: null, launched: true, runId };
    }

    // The thread may have brought its own engine; one that runs only inside Tomrade has no terminal session.
    const inside = insideOnly(agent, engineId);
    if (inside) return { ok: false, gate: "engine", message: inside };
    const files = this.host.sessions.bind(session, `ai:${engineId}` as Author, this.host.sessionDir(session.id), prepared.prompt);
    if (!files) return { ok: false, gate: "mcp", message: "the MCP server is not running — enable the mcp plugin" };
    const command = this.command(terminalSettings, engineId, session, files, prepared.cwd, agent.optionsOf(thread, engineId));
    const launch = await launchTerminal({ cwd: prepared.cwd, command, env: { TOMRADE_MCP_TOKEN: files.token }, dir: files.dir }, terminalSettings.terminal);
    store.patchSession(projectId, session.id, { state: "running", lastEventAt: now });
    this.host.notify(projectId);
    return { ...base, command, launched: launch.launched };
  }

  /** A local coding agent that is installed and ready; the in-app model never qualifies. */
  async pickEngine(agent: Agent, wanted?: string, terminal = false): Promise<{ ok: true; engine: Engine } | { ok: false; reason: string }> {
    const inside = terminal && wanted ? insideOnly(agent, wanted) : null;
    if (inside) return { ok: false, reason: inside };
    const only = !terminal && wanted ? agent.codeEngines().find((e) => e.id === wanted && e.terminalOnly) : undefined;
    if (only) return { ok: false, reason: `${only.title} runs only in a terminal — choose In a terminal` };
    const candidates = agent.codeEngines().filter((e) => (!wanted || e.id === wanted) && (!terminal || e.terminal !== false) && (terminal || !e.terminalOnly));
    if (!candidates.length) return { ok: false, reason: wanted ? `${wanted} is not a code-capable engine` : "No local coding agent is installed — add Claude Code, Codex or Pi, then try again" };
    const reasons: string[] = [];
    for (const engine of candidates) {
      const state = await engine.available().catch((err: unknown) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
      if (state.ok) return { ok: true, engine };
      reasons.push(`${engine.title}: ${state.reason ?? "not available"}`);
    }
    return { ok: false, reason: reasons.join(" · ") };
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

export type { RepoStateView };

/** Why an engine cannot be handed a ticket in a terminal, or null when it can. */
function insideOnly(agent: Agent, engineId: string): string | null {
  const engine = agent.codeEngines().find((e) => e.id === engineId);
  return engine?.terminal === false ? `${engine.title} runs only inside Tomrade — choose Run here, or set up another CLI agent under Settings → Code link` : null;
}
