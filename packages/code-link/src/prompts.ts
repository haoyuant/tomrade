import { waitsOnLine } from "@tomradex/agent";
import type { Item, Repo } from "@tomradex/domain";
import type { Decision } from "./decisions.js";
import type { CodeLinkView, RepoStateView, SessionView } from "./store.js";

export const BOOTSTRAP_LABEL = "bootstrap";

export interface FirstPromptInput {
  item: Item;
  repo: Repo;
  state: RepoStateView | null;
  branch: string;
  blockers: Item[];
  bootstrap: boolean;
  mcpUrl: string | null;
  /** What the project has already settled, so the agent neither re-decides it nor decides around it. */
  decisions?: Decision[];
  /** The workstream's folder inside the repository, '' for the root. */
  subdir?: string;
  completionPolicy?: "merge" | "human";
}

const conventions = (key: string, defaultBranch: string, completionPolicy: "merge" | "human" = "human") =>
  [
    "Conventions:",
    `- this run owns exactly ${key}; implement only its stated outcome and acceptance criteria`,
    "- use neighboring tickets only for context and dependencies; do not implement their models, screens, flows, APIs, or cleanup while you are here",
    "- before the first edit, name the smallest expected change; before pushing, inspect the full diff and remove work that is not required by this ticket",
    "- if required work belongs to another ticket, report it with note_progress and leave it for a separate branch and session",
    `- every commit message names ${key}; never commit to ${defaultBranch}, stay on your branch`,
    "- after the full-diff scope review, call link_code with the pull request URL and scopeChecked: true — that moves the ticket to Verifying",
    "- call note_progress with one line at each milestone; it is what the ticket shows while you work",
    "- if git push, fetch, pull or gh fails with an authentication or repository-not-found error, do not switch accounts, edit credential helpers or change the remote; commit locally, call note_progress with 'blocked: push …', and stop — the human owns credentials",
    `- do not mark the ticket done; ${completionPolicy === "merge" ? "the platform completes delivery after all code links merge" : "human acceptance is required, even after code merges; submit required artifacts for review"}`
  ].join("\n");

/** The first message of a thread started from a ticket: the ticket, the place, the protocol. How to code is the repository's CLAUDE.md's business. */
export function firstPrompt(input: FirstPromptInput): string {
  const { item, repo, state, branch, blockers, bootstrap, mcpUrl } = input;
  const playbook = bootstrap ? "code.bootstrap" : "code.implement";
  const accepted = (input.decisions ?? []).filter((d) => d.status === "accepted");
  const parts = [
    `${bootstrap ? "Bootstrap" : "Implement"} ${item.key} — "${item.title}".`,
    `Follow the playbook first: open_playbook("${playbook}").`,
    "",
    "Ticket:",
    item.body?.trim() || "(no description yet — read the backlog around it, and ask before assuming)",
    "",
    `Repository: ${repo.name} (${repo.remote}) · default branch ${repo.defaultBranch} · your branch ${branch}.`,
    input.subdir ? `This workstream's code lives in ${input.subdir}/ inside the repository — you are started there; keep the work under it, and put shared files (CLAUDE.md, CI) at the repository root.` : "",
    state?.hasBrief
      ? "Read CLAUDE.md or AGENTS.md before writing anything."
      : state?.readiness === "scaffolded"
        ? `There is no CLAUDE.md yet: learn the stack from ${state.manifests.join(", ") || "the manifests"}, and add a short CLAUDE.md as part of this work.`
        : "The repository has no project in it yet.",
    waitsOnLine(blockers.map((b) => ({ key: b.key, title: b.title, status: b.status }))),
    accepted.length
      ? `Decisions on record (list_decisions has the details): ${accepted.map((d) => `${d.id} ${d.title}${d.areas.length ? ` [${d.areas.join(", ")}]` : ""}`).join("; ")}. Anything cross-cutting outside these: ask, then record_decision.`
      : "No decisions are on record yet: a cross-cutting choice (state management, routing, persistence, deployment shape) is asked about, then recorded with record_decision, never made silently.",
    mcpUrl && bootstrap ? `Tomrade's MCP endpoint for this project, for the repository's .mcp.json and .codex/config.toml: ${mcpUrl}` : "",
    "",
    conventions(item.key, repo.defaultBranch, input.completionPolicy ?? (state?.autoDone ? "merge" : "human"))
  ];
  return parts.filter((p) => p !== "").join("\n");
}

/** Picking a thread back up: where it stopped, what the branch looks like now. */
export function continuePrompt(item: Item, repo: Repo, session: SessionView | null, link: CodeLinkView | null, completionPolicy: "merge" | "human" = "human"): string {
  const parts = [
    `Continue ${item.key} — "${item.title}" on branch ${link?.branch ?? session?.branch ?? "(see the thread)"}.`,
    "",
    "Ticket:",
    item.body?.trim() || "(no description)",
    "",
    session?.summary ? `Last note: ${session.summary}` : "",
    link ? `Branch: +${link.ahead} −${link.behind} against ${repo.defaultBranch}${link.prUrl ? ` · pull request ${link.prUrl} (${link.prState ?? "open"})` : " · no pull request yet"}.` : "",
    "Check the working tree and the tests, then carry on where you stopped. get_item has the ticket's latest state if you need it.",
    "",
    conventions(item.key, repo.defaultBranch, completionPolicy)
  ];
  return parts.filter((p) => p !== "").join("\n");
}

export const bootstrapBody = (repo: Repo): string =>
  [
    `${repo.name} has no project in it yet. Before any feature ticket can start here, this one settles the stack with the user, scaffolds the project, and writes CLAUDE.md.`,
    "",
    "Done when:",
    "- the cross-cutting choices (language, framework, state, routing, package manager, tests, CI, deployment shape) are recorded as short decision notes under docs/decisions/",
    "- build, test and lint commands run, and CI runs them",
    "- CLAUDE.md at the root explains the stack, the commands, the layout, and the Tomrade conventions (branch `<key>/<slug>`, commits naming the key)",
    "- the pull request is merged"
  ].join("\n");
