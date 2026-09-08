import fs from "node:fs";
import type { Context } from "cordis";
import type { Agent, Engine } from "@tomrade/agent";
import type {} from "@tomrade/boards";
import type {} from "@tomrade/hub";
import type {} from "@tomrade/items";
import type {} from "@tomrade/repos";
import type {} from "@tomrade/settings";
import type { Author, Board, Item, Repo } from "@tomrade/domain";
import { branchFor } from "./keys.js";
import { BOOTSTRAP_LABEL, bootstrapBody, continuePrompt, firstPrompt } from "./prompts.js";
import type { Sessions } from "./sessions.js";
import type { CodeLinkStore, RepoStateView, SessionMode } from "./store.js";
import { TerminalSettings, fillTemplate, launchTerminal } from "./terminal.js";

export type StartMode = "run" | "terminal";
export type StartGate = "locked" | "workstream" | "checkout" | "readiness" | "blocked" | "engine" | "mcp" | "workdir";

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
    };

/** What the starter needs from the service. */
export interface StartHost {
  ctx: Context;
  store: CodeLinkStore;
  sessions: Sessions;
  scan(projectId: string): Promise<unknown>;
  notify(projectId: string): void;
  sessionDir(sessionId: string): string;
  /** Machine-local: where each thread's worktree is, for the section and the terminal. */
  worktrees: Map<string, string>;
}

const OPEN = new Set(["backlog", "todo", "doing", "verifying"]);

/**
 * Start (or continue) work on a ticket with a local coding agent. Six gates,
 * each answered with the one thing that unblocks it; then a thread on the
 * ticket's workstream, a worktree on the ticket's branch, a session record,
 * and either a headless run or the user's own terminal.
 */
export class Starter {
  constructor(private readonly host: StartHost) {}

  async start(projectId: string, itemId: string, opts: { mode: StartMode; engine?: string }): Promise<StartResult> {
    const { ctx, store } = this.host;
    const item = ctx.items.get(projectId, itemId);
    if (!item) throw new Error(`unknown item ${itemId}`);
    if (item.humanLocked) return { ok: false, gate: "locked", message: `${item.key} is human-locked — unlock it before starting work on it` };

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
    const bootstrapping = item.labels.includes(BOOTSTRAP_LABEL);
    if (state?.readiness === "empty" && !bootstrapping) {
      const bootstrap = this.ensureBootstrap(projectId, item, board, repo);
      return { ok: false, gate: "readiness", message: `${repo.name} has no project in it yet — ${bootstrap.key} bootstraps it first and blocks ${item.key} until it lands`, bootstrapKey: bootstrap.key };
    }

    const blockers = item.blockedBy.map((id) => ctx.items.get(projectId, id)).filter((b): b is Item => !!b && OPEN.has(b.status));
    if (blockers.length) return { ok: false, gate: "blocked", message: `${item.key} waits on ${blockers.map((b) => b.key).join(", ")}`, blockers: blockers.map((b) => b.key) };

    const agent = ctx.get("agent");
    if (!agent) return { ok: false, gate: "engine", message: "the agent plugin is not loaded" };
    const picked = await this.pickEngine(agent, opts.engine);
    if (!picked.ok) return { ok: false, gate: "engine", message: picked.reason };
    const engine = picked.engine;
    // A terminal session connects back over MCP; without the server there is nothing to start, so nothing is created.
    if (opts.mode === "terminal" && !ctx.get("mcp")?.url) return { ok: false, gate: "mcp", message: "the MCP server is not running — enable the mcp plugin" };

    // An open thread on this ticket is continued, not duplicated.
    const links = store.links(projectId, item.id).filter((l) => l.repoId === repo.id && l.branch);
    const previous = links.map((l) => (l.threadId ? agent.store.thread(projectId, l.threadId) : null)).find((t) => !!t) ?? null;
    let continued = false;
    let thread = previous;
    let branch = previous?.branch ?? links[0]?.branch ?? "";
    if (thread) {
      continued = true;
      if (thread.engine !== engine.id && !agent.activeRuns().some((a) => a.thread.id === thread!.id)) agent.setEngine(projectId, thread.id, engine.id);
    } else {
      branch = branchFor(state?.branchTemplate ?? "{key}/{slug}", item.key, item.title);
      thread = agent.newThread(projectId, engine.id, board.id, { itemId: item.id, branch, title: `${item.key} ${item.title}` });
    }

    const where = await agent.workdir(projectId, thread.id);
    if (where.problem || !where.cwd) return { ok: false, gate: where.code === "no-checkout" ? "checkout" : "workdir", message: where.problem ?? "no working folder for this thread", remote: repo.remote };
    this.host.worktrees.set(thread.id, where.worktree ?? where.cwd);

    const now = Date.now();
    const link = store.upsertLink(projectId, { itemId: item.id, repoId: repo.id, branch }, { threadId: thread.id, source: continued ? undefined : "start", lastSeenAt: now });
    if (item.status === "backlog" || item.status === "todo") ctx.items.update(projectId, item.id, { status: "doing" }, "human");

    const mode: SessionMode = opts.mode === "run" ? "headless" : "terminal";
    const onThread = store.sessions(projectId, { itemId: item.id }).filter((s) => s.threadId === thread!.id);
    const live = onThread.find((s) => s.state !== "ended" && s.mode === mode) ?? null;
    // The CLI's own session id is what Continue resumes: the platform learned it from a headless run, a hook from a terminal one.
    const externalId = agent.store.external(projectId, thread.id)[engine.id] ?? onThread.find((s) => s.agent === engine.id && s.externalId)?.externalId ?? null;
    const session =
      live ??
      store.createSession(projectId, {
        repoId: repo.id,
        branch,
        itemIds: [item.id],
        mode,
        agent: engine.id,
        threadId: thread.id,
        device: ctx.hub.deviceId,
        externalId
      });
    const prompt = continued ? continuePrompt(item, repo, live ?? store.sessions(projectId, { itemId: item.id })[0] ?? null, link) : firstPrompt({ item, repo, state, branch, blockers: [], bootstrap: bootstrapping, mcpUrl: ctx.get("mcp")?.urlFor(projectId) ?? null });

    if (opts.mode === "run") {
      if (!agent.activeRuns().some((a) => a.thread.id === thread!.id)) agent.send(projectId, thread.id, { kind: "text", text: prompt });
      store.patchSession(projectId, session.id, { state: "running", lastEventAt: now });
      this.host.notify(projectId);
      return { ok: true, continued, threadId: thread.id, sessionId: session.id, branch, worktree: where.worktree, cwd: where.cwd, mode: opts.mode, command: null, launched: true };
    }

    const files = this.host.sessions.bind(session, `ai:${engine.id}` as Author, this.host.sessionDir(session.id), prompt);
    if (!files) return { ok: false, gate: "mcp", message: "the MCP server is not running — enable the mcp plugin" };
    const settings = TerminalSettings.parse(ctx.settings.get().codeLink ?? {});
    const template = engine.id === "codex" ? settings.codexCommand : settings.claudeCommand;
    const resume = session.externalId ? (engine.id === "codex" ? `resume ${session.externalId}` : `--resume ${session.externalId}`) : "";
    const command = fillTemplate(template, { cwd: where.cwd, prompt: files.prompt, mcpConfig: files.mcpConfig, mcpUrl: files.mcpUrl, token: files.token, settings: files.settings, resume });
    const launch = await launchTerminal({ cwd: where.cwd, command, env: { TOMRADE_MCP_TOKEN: files.token }, dir: files.dir }, settings.terminal);
    store.patchSession(projectId, session.id, { state: "running", lastEventAt: now });
    this.host.notify(projectId);
    return { ok: true, continued, threadId: thread.id, sessionId: session.id, branch, worktree: where.worktree, cwd: where.cwd, mode: opts.mode, command, launched: launch.launched };
  }

  /** A local coding agent that is installed and ready; the in-app model never qualifies. */
  async pickEngine(agent: Agent, wanted?: string): Promise<{ ok: true; engine: Engine } | { ok: false; reason: string }> {
    const candidates = agent.codeEngines().filter((e) => !wanted || e.id === wanted);
    if (!candidates.length) return { ok: false, reason: wanted ? `${wanted} is not a code-capable engine` : "No local coding agent is installed — add Claude Code or Codex, then try again" };
    const reasons: string[] = [];
    for (const engine of candidates) {
      const state = await engine.available().catch((err: unknown) => ({ ok: false, reason: err instanceof Error ? err.message : String(err) }));
      if (state.ok) return { ok: true, engine };
      reasons.push(`${engine.title}: ${state.reason ?? "not available"}`);
    }
    return { ok: false, reason: reasons.join(" · ") };
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
