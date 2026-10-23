import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { GitFolder, type Git } from "@tomradex/git";
import { CURSOR_HOOK_SCRIPT } from "./cursor-hooks.js";
import { inspectConnection, inspectConnectFiles, type AgentConnectionView, type ConnectionView } from "./connection.js";
import { CONNECT_AGENTS, connectFiles, writeConnectFiles, type ConnectAgent, type ConnectInput, type Connectors, type SkippedAgent } from "./connect.js";
import { compareUrl } from "./landing.js";
import type { CodeLinkStore } from "./store.js";
import { commandOk, exec } from "./terminal.js";
import type { CodeWords } from "./words.js";

/** For everyone who clones the repository (a branch and pull request), or for this machine only (untracked files in the checkout). */
export type ConnectMode = "team" | "local";

export interface ConnectResult {
  agents: AgentConnectionView[];
  /** The connection branch; empty for this machine only. */
  branch: string;
  /** Files written or changed, relative to the repository root. */
  files: string[];
  /** Chosen agents left out because a file of theirs could not be changed safely. */
  skipped: SkippedAgent[];
  committed: boolean;
  pushed: boolean;
  /** The pull request, or the compare page to open one from; null when nothing could be pushed. */
  url: string | null;
  /** Written into the checkout and kept out of git, nothing committed. */
  local?: boolean;
  message: string;
}

export interface RepoConnectDeps {
  ctx: Context;
  store: CodeLinkStore;
  git: Git;
  words: () => CodeWords;
  notify: (projectId: string) => void;
  prefixOf: (projectId: string) => string;
  lastHooks: (projectId: string, repoId: string) => Record<string, number>;
  /** The engines' connection-file writers, looked up when Connect runs. */
  connectors: Connectors;
}

/** Connecting a repository to Tomrade: what its files say now, and writing them for the team or this machine. */
export class RepoConnect {
  private readonly ctx: Context;
  private readonly store: CodeLinkStore;
  private readonly git: Git;
  private readonly words: RepoConnectDeps["words"];
  private readonly notify: RepoConnectDeps["notify"];
  private readonly prefixOf: RepoConnectDeps["prefixOf"];
  private readonly lastHooks: RepoConnectDeps["lastHooks"];
  private readonly connectors: Connectors;

  constructor(deps: RepoConnectDeps) {
    this.ctx = deps.ctx;
    this.store = deps.store;
    this.git = deps.git;
    this.words = deps.words;
    this.notify = deps.notify;
    this.prefixOf = deps.prefixOf;
    this.lastHooks = deps.lastHooks;
    this.connectors = deps.connectors;
  }

  /** The agents a repository is connected for: the person's choice, else the ones installed here, else every one. */
  async connectAgents(projectId: string, repoId: string): Promise<ConnectAgent[]> {
    const chosen = this.store.repoState(projectId, repoId)?.connectAgents;
    if (chosen?.length) return chosen;
    const agent = this.ctx.get("agent");
    // A plugin agent whose engine registered a connector is one more the repository can be connected for.
    const all: ConnectAgent[] = [...CONNECT_AGENTS, ...(this.connectors.agents?.() ?? []).filter((id) => !(CONNECT_AGENTS as readonly string[]).includes(id))];
    const found = await Promise.all(all.map(async (id) => {
      const state = await agent?.engineOf(id)?.available().catch(() => null);
      // Installed is enough: the repository's files do not need it signed in here.
      return state?.ok || state?.cli?.state === "ready" ? [id] : [];
    }));
    const detected = found.flat();
    // A Tomrade that finds none of them cannot tell which the team uses.
    return detected.length ? detected : all;
  }

  async connection(projectId: string, repoId: string): Promise<ConnectionView> {
    const repo = this.ctx.repos.get(projectId, repoId);
    if (!repo) throw new Error(`unknown repository ${repoId}`);
    const mcp = this.ctx.get("mcp");
    const mcpUrl = mcp?.urlFor(projectId) ?? null;
    const branch = "tomrade/connect";
    const base = { mcpUrl, configuredUrl: null, instance: mcp?.badge().kind ?? "dev", branch, url: null, agents: [] as AgentConnectionView[], ...(mcp?.clash ? { clash: mcp.clash } : {}) } as const;
    if (!mcpUrl || !mcp?.eventUrl) return { ...base, state: "unavailable" };
    const cwd = this.ctx.repos.checkout(repo.remote).checkout;
    if (!cwd || !fs.existsSync(cwd)) return { ...base, state: "no-checkout" };
    const exists = async (ref: string) => (await this.git(["rev-parse", "--verify", "--quiet", ref], { cwd, ok: true })).code === 0;
    const local = `refs/heads/${repo.defaultBranch}`;
    const remote = `refs/remotes/origin/${repo.defaultBranch}`;
    const hasLocal = await exists(local);
    const hasRemote = await exists(remote);
    // Prefer local work that is ahead; otherwise use the latest fetched default branch.
    const ref = hasLocal && (!hasRemote || (await this.git(["merge-base", "--is-ancestor", remote, local], { cwd, ok: true })).code === 0) ? local : remote;
    const chosen = await this.connectAgents(projectId, repoId);
    const current = await inspectConnection(this.git, cwd, ref, mcpUrl, mcp.eventUrl, chosen, this.connectors);
    const configuredUrl = current.configuredUrl;
    const lastHooks = this.lastHooks(projectId, repoId);
    const heard = (agents: AgentConnectionView[]) => agents.map((agent) => (lastHooks[agent.id] ? { ...agent, lastEventAt: lastHooks[agent.id] } : agent));
    if (current.connected) {
      const link = this.ctx.get("agent")?.engineOf("claude-code")?.local?.mcpLink;
      const claudeApproval = link?.projectApproval?.(cwd);
      const claudeApprovals = link?.projectApprovals?.(cwd);
      return { ...base, agents: heard(current.agents), configuredUrl, state: "connected", ...(current.local ? { local: true } : {}), ...(claudeApproval ? { claudeApproval } : {}), ...(claudeApprovals ? { claudeApprovals } : {}) };
    }
    for (const pendingRef of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
      if (!(await exists(pendingRef))) continue;
      if ((await this.git(["merge-base", "--is-ancestor", pendingRef, ref], { cwd, ok: true })).code === 0) continue;
      const pending = await inspectConnection(this.git, cwd, pendingRef, mcpUrl, mcp.eventUrl, chosen, this.connectors);
      if (pending.connected) return { ...base, agents: heard(pending.agents), configuredUrl, state: "pending", url: compareUrl(repo.remote, repo.defaultBranch, branch) };
    }
    // Another project id is another instance's repository; the same project on another port is only incomplete here.
    return { ...base, agents: heard(current.agents), configuredUrl, state: configuredUrl && !current.sameProject ? "other-instance" : "unconnected" };
  }

  /**
   * Connect a repository to Tomrade for everyone who clones it: Claude and
   * Codex MCP config, agent instruction files, and Claude lifecycle hooks —
   * written in a worktree on a branch of their own and offered as a pull
   * request, never into the user's checkout. For this machine only (`local`),
   * the same files go into the checkout untracked and listed in
   * `.git/info/exclude`: nothing to push, merge or pull.
   */
  async connect(projectId: string, repoId: string, mode: ConnectMode = "team"): Promise<ConnectResult> {
    const repo = this.ctx.repos.get(projectId, repoId);
    if (!repo) throw new Error(`unknown repository ${repoId}`);
    const mcp = this.ctx.get("mcp");
    if (!mcp?.url) throw new Error("the MCP server is not running — enable the mcp plugin");
    // A port taken at startup is replaced by a random one; written down, it would point nowhere after the next restart.
    if (mcp.clash) throw new Error(this.words()("connectPortClash", { port: mcp.clash.port, holder: mcp.holderText() }));
    const placement = this.ctx.repos.checkout(repo.remote);
    if (!placement.checkout || !fs.existsSync(placement.checkout)) throw new Error(`no checkout of ${repo.name} on this machine`);

    const branch = "tomrade/connect";
    const w = this.words();
    await new GitFolder(this.git, placement.checkout).fetch(repo.defaultBranch);
    const chosen = await this.connectAgents(projectId, repoId);
    // What it was connected for stays the choice, whatever is installed here later.
    if (!this.store.repoState(projectId, repoId)?.connectAgents) this.store.upsertRepoState(projectId, repoId, { connectAgents: chosen });
    const connection = await this.connection(projectId, repoId);
    const input = {
      projectName: (this.ctx.db.for(projectId).prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined)?.name ?? "Tomrade project",
      mcpUrl: mcp.urlFor(projectId)!,
      eventUrl: mcp.eventUrl!,
      prefix: this.prefixOf(projectId),
      branchTemplate: this.store.repoState(projectId, repoId)?.branchTemplate ?? "{key}/{slug}"
    };
    if (mode === "local") {
      if (connection.state === "connected") return { branch: "", agents: connection.agents, files: [], skipped: [], committed: false, pushed: false, url: null, local: true, message: w("connected") };
      return this.connectLocally(projectId, repoId, placement.checkout, input, chosen);
    }
    // A connection this machine alone holds does not stand in for the team's.
    if (connection.state === "connected" && !connection.local) {
      return { branch, agents: connection.agents, files: [], skipped: [], committed: false, pushed: false, url: null, message: w("connected") };
    }
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-connect-"));
    const worktree = path.join(temporary, "repo");
    const exists = async (ref: string) => (await this.git(["rev-parse", "--verify", "--quiet", ref], { cwd: placement.checkout!, ok: true })).code === 0;
    const base = await exists(`refs/remotes/origin/${repo.defaultBranch}`) ? `origin/${repo.defaultBranch}` : repo.defaultBranch;
    try {
      if (await exists(`refs/heads/${branch}`)) await this.git(["worktree", "add", worktree, branch], { cwd: placement.checkout });
      else if (await exists(`refs/remotes/origin/${branch}`)) await this.git(["worktree", "add", "-b", branch, worktree, `origin/${branch}`], { cwd: placement.checkout });
      else if (await exists(base)) await this.git(["worktree", "add", "-b", branch, worktree, base], { cwd: placement.checkout });
      else await this.git(["worktree", "add", "--orphan", "-b", branch, worktree], { cwd: placement.checkout });
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
    const state = this.store.repoState(projectId, repoId);
    try {
      if (await exists(base)) await this.git(["merge", "--no-edit", base], { cwd: worktree });
      const written = writeConnectFiles(worktree, input, chosen, undefined, this.connectors);
      const { files } = written;
      const agents = inspectConnectFiles(worktree, mcp.urlFor(projectId)!, mcp.eventUrl!, chosen, this.connectors).agents;
      const skipped = this.said(written.skipped, agents);
      const folder = new GitFolder(this.git, worktree);
      // A checkout on Windows records no executable bit, and elsewhere Cursor runs the script by its path.
      if (files.includes(CURSOR_HOOK_SCRIPT)) await this.git(["add", "--chmod=+x", "--", CURSOR_HOOK_SCRIPT], { cwd: worktree });
      const committed = files.length > 0 && (await folder.commit("Connect this repository to Tomrade\n\nProject MCP config lets Claude Code, Codex and WorkBuddy discover Tomrade, a project extension does it for Pi and opencode.json with a plugin for OpenCode, agent instructions describe the ticket conventions, and their hooks report session lifecycle back."));

      if (!(await folder.remoteUrl())) return { branch, agents, files, skipped, committed, pushed: false, url: null, message: w("connectLocal", { branch, base: repo.defaultBranch }) };
      if (state && !state.agentPush) return { branch, agents, files, skipped, committed, pushed: false, url: null, message: w("connectPushOff", { branch }) };
      const pushed = (await this.git(["push", "-q", "-u", "origin", `HEAD:refs/heads/${branch}`], { cwd: worktree, ok: true })).code === 0;
      if (!pushed) return { branch, agents, files, skipped, committed, pushed: false, url: null, message: w("connectPushFailed", { branch }) };
      let url: string | null = null;
      let created = false;
      if (await commandOk("gh")) {
        const env = await this.ctx.github.environment(this.git, worktree);
        try {
          url = (await exec("gh", ["pr", "create", "--head", branch, "--base", repo.defaultBranch, "--title", "Connect this repository to Tomrade", "--body", `Adds ${files.join(", ")} to connect agent tools and Claude Code/Codex/WorkBuddy/Pi/OpenCode lifecycle reports. Review Codex hooks with /hooks after merging.`], worktree, env)).trim().split("\n").pop() ?? null;
          created = !!url;
        } catch {
          try {
            url = (await exec("gh", ["pr", "view", branch, "--json", "url", "-q", ".url"], worktree, env)).trim() || null;
          } catch {
            url = null;
          }
        }
      }
      url ??= compareUrl(repo.remote, repo.defaultBranch, branch);
      this.notify(projectId);
      return { branch, agents, files, skipped, committed, pushed, url, message: created ? w("connectOpened") : w("connectPushed", { branch }) };
    } finally {
      await this.git(["worktree", "remove", "--force", worktree], { cwd: placement.checkout, ok: true });
      fs.rmSync(temporary, { recursive: true, force: true });
      this.notify(projectId);
    }
  }

  /**
   * The chosen agents' files, written into the checkout and kept out of git
   * through `.git/info/exclude`: a tracked file is never changed (its agent
   * is skipped and says so), and the team's tracked CLAUDE.md / AGENTS.md stay
   * as they are — an untracked one, or none, carries the section so the agent
   * reads the rules without the team seeing them.
   */
  private async connectLocally(projectId: string, repoId: string, checkout: string, input: ConnectInput, chosen: ConnectAgent[]): Promise<ConnectResult> {
    const list = connectFiles(this.connectors);
    const listed = await this.git(["ls-files", "-z", "--", ...list], { cwd: checkout, ok: true });
    const tracked = new Set(listed.code === 0 ? listed.stdout.split("\0").filter(Boolean) : list);
    const { files, skipped } = writeConnectFiles(checkout, input, chosen, { tracked }, this.connectors);
    // Only what git does not ignore already; the exclude file is this clone's own, never committed.
    const exposed: string[] = [];
    for (const file of files) {
      if ((await this.git(["check-ignore", "-q", "--", file], { cwd: checkout, ok: true })).code !== 0) exposed.push(file);
    }
    if (exposed.length) {
      const where = (await this.git(["rev-parse", "--git-path", "info/exclude"], { cwd: checkout, ok: true })).stdout.trim();
      const exclude = path.isAbsolute(where) ? where : path.join(checkout, where);
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      const existing = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
      const lines = ["# Tomrade: agent connection files for this machine only", ...exposed.map((file) => `/${file}`)];
      fs.writeFileSync(exclude, `${existing.replace(/\s*$/, "")}${existing.trim() ? "\n\n" : ""}${lines.join("\n")}\n`);
    }
    this.notify(projectId);
    const { agents } = await this.connection(projectId, repoId);
    return { branch: "", agents, files, skipped: this.said(skipped, agents), committed: false, pushed: false, url: null, local: true, message: this.words()(files.length === 1 ? "connectedLocallyOne" : "connectedLocallyMany", { n: files.length }) };
  }

  /** A skip the app's own strings do not name, said in the person's words. */
  private said(skipped: SkippedAgent[], agents: AgentConnectionView[]): SkippedAgent[] {
    const w = this.words();
    return skipped.map((skip) => (skip.reason === "no-connector" ? { ...skip, message: w("connectNoConnector", { file: skip.file, agent: agents.find((agent) => agent.id === skip.agent)?.title ?? skip.agent }) } : skip));
  }
}
