import fs from "node:fs";
import path from "node:path";
import type { Context } from "cordis";
import type { Agent } from "@tomradex/agent";
import type { Repo } from "@tomradex/domain";
import { languageLine } from "./prompts.js";
import type { Starter } from "./start.js";
import type { CodeLinkStore } from "./store.js";
import type { CodeWords } from "./words.js";

export interface OrientationHost {
  ctx: Context;
  store: CodeLinkStore;
  starter: Starter;
  words: () => CodeWords;
}

/** How much of each file the scan-written brief carries: enough to say what the project is, not the whole document. */
const EXCERPT = 1500;

/** What an imported repository is asked to be read for, before anyone plans against it. */
export function orientationPrompt(input: { repo: Repo; manifests: string[]; subdir: string; locale: Parameters<typeof languageLine>[0] }): string {
  const { repo, manifests, subdir } = input;
  return [
    `Orientation: learn ${repo.name} so Tomrade can plan work against what already exists.`,
    languageLine(input.locale),
    "This is a read-only pass: change no file, run no build or install, create no ticket.",
    `Read CLAUDE.md or AGENTS.md, README, the manifests (${manifests.join(", ") || "none found"}), the main modules and the data layer${subdir ? `, starting in ${subdir}/` : ""}.`,
    "Then call update_project_brief once, with at most 2500 characters, covering:",
    "- what the product is and who uses it",
    "- the stack, and the commands that build, test and run it",
    "- the layout: where each kind of code lives",
    "- where its data comes from: what this code manages itself and what it fetches or syncs from elsewhere (an upstream feed, an external API, another system)",
    "- the domain vocabulary, and the conventions an agent must follow",
    "State what you read, not what you assume; where something is unclear, say so in the brief. Then reply with one line saying the brief is written."
  ].join("\n");
}

/** The brief a machine without a coding agent writes: the manifests, and the documents a repository explains itself with. */
export function scanBrief(checkout: string, repo: Repo, manifests: string[]): string {
  const parts = [
    `${repo.name}: written by Tomrade from the repository's files, not by an agent that read the code. Treat it as partial, and replace it with update_project_brief once the code has been read.`,
    `Manifests: ${manifests.join(", ") || "none"}.`
  ];
  const names = fs.readdirSync(checkout);
  const documents = ["CLAUDE.md", "AGENTS.md", names.find((name) => /^readme(\.|$)/i.test(name))].filter((name): name is string => !!name && names.includes(name));
  for (const name of documents) {
    const text = fs.readFileSync(path.join(checkout, name), "utf8").trim();
    if (text) parts.push(`## ${name}\n${text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text}`);
  }
  return parts.join("\n\n");
}

/**
 * A project's first look at a repository it was just pointed at. The planners
 * and the main conversation read the project brief for what the code already
 * does; an imported project has none, so one is written here — by a coding
 * agent reading the code in a worktree of its own, or, without one on this
 * machine, from the repository's own documents. Once per repository.
 */
export class Orientation {
  private readonly started = new Set<string>();

  constructor(private readonly host: OrientationHost) {}

  /** After a scan: the first repository with a project in it orients the project, while its brief is still empty. */
  async sweep(projectId: string): Promise<void> {
    const agent = this.host.ctx.get("agent");
    if (!agent || agent.brief(projectId)?.trim()) return;
    for (const repo of this.host.ctx.repos.list(projectId)) {
      const state = this.host.store.repoState(projectId, repo.id);
      if (state?.readiness !== "scaffolded") continue;
      if (await this.orient(projectId, repo, agent, state.manifests)) return;
    }
  }

  private async orient(projectId: string, repo: Repo, agent: Agent, manifests: string[]): Promise<boolean> {
    const key = `${projectId}\0${repo.id}`;
    if (this.started.has(key)) return false;
    const title = this.host.words()("orientationTitle", { repo: repo.name });
    // A conversation already opened for it, from an earlier run of Tomrade: its agent writes the brief, or the person asked it not to.
    if (agent.store.threads(projectId, "assistant").some((thread) => thread.title === title)) {
      this.started.add(key);
      return false;
    }
    const placement = this.host.ctx.repos.checkout(repo.remote);
    if (!placement.checkout || !fs.existsSync(placement.checkout)) return false;
    const picked = await this.host.starter.pickEngine(agent);
    if (picked.ok) {
      // The agent reads in a worktree of the workstream's repository, so a workstream has to name it; until one does, a later scan comes back here.
      const board = this.host.ctx.boards.list(projectId).find((b) => b.repoId === repo.id);
      if (!board) return false;
      this.started.add(key);
      const thread = agent.newThread(projectId, picked.engine.id, board.id, { title, surface: "assistant" });
      const subdir = board.repoPath.replace(/^\/+|\/+$/g, "");
      agent.send(projectId, thread.id, { kind: "text", text: orientationPrompt({ repo, manifests, subdir, locale: this.host.ctx.settings.locale?.() ?? "en" }) });
      return true;
    }
    this.started.add(key);
    agent.store.setBrief(projectId, scanBrief(placement.checkout, repo, manifests));
    return true;
  }
}
