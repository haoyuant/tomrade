import { attachmentsLine, waitsOnLine } from "@tomradex/agent";
import { languageName, type Item, type LanguageTag, type Repo } from "@tomradex/domain";
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
  /** The checkout has no origin: nothing is pushed and there is no pull request. */
  local?: boolean;
  /** The repository lets agents merge their own pull requests. */
  merge?: boolean;
  /** Tomrade's own language, so the agent's output matches what the person reads in the app. */
  locale?: LanguageTag;
}

/**
 * One line, no extra turn: the person reads the app in this language, so the
 * agent writes its output in it. Worded as the cheapest nudge — the agent
 * still reads the English brief and the code, it only answers in this language.
 */
export const languageLine = (locale: LanguageTag = "en") => {
  const name = languageName(locale);
  return `Language: the person reads Tomrade in ${name} — write everything the person will read (your replies, note_progress, questions, reports) in ${name}; keep code, identifiers, commands, file paths and commit messages as they are.`;
};

/** Who merges: the pull request, or, with no remote, the branch into the default branch here. */
export const mergeLine = (merge: boolean, local = false): string =>
  local
    ? merge
      ? "- merging is yours: after link_code, call merge_branch to merge your branch into the default branch here; if it does not merge (a dirty checkout, a conflict), call note_progress with its message and stop — the person merges it"
      : ""
    : merge
      ? "- merging is yours: after link_code, wait for the pull request's checks with gh pr checks <url> --watch and merge only once they pass, with gh pr merge <url> --squash or the method CLAUDE.md names; never pass --admin or work around branch protection. 'no checks reported' means there is nothing to wait for. If the checks cannot be read at all (an error such as 'Resource not accessible by integration'), do not merge without them: call report_merge_blocked saying the check status could not be read, and stop. If the checks fail or the merge is refused — a permission denied, a safety check, branch protection, a review still required — do not try another way: call report_merge_blocked with the reason and stop; the human merges it"
      : "- do not merge the pull request; the human merges it";

const conventions = (key: string, defaultBranch: string, completionPolicy: "merge" | "human" = "human", local = false, merge = false) =>
  [
    "Conventions:",
    `- this run owns exactly ${key}; implement only its stated outcome and acceptance criteria`,
    "- use neighboring tickets only for context and dependencies; do not implement their models, screens, flows, APIs, or cleanup while you are here",
    `- before the first edit, name the smallest expected change; before ${local ? "handing the branch over" : "pushing"}, inspect the full diff and remove work that is not required by this ticket`,
    "- if required work belongs to another ticket, report it with note_progress and leave it for a separate branch and session",
    `- every commit message names ${key}; never commit to ${defaultBranch}, stay on your branch`,
    local
      ? `- this repository has no remote: commit on your branch, do not push, do not add a remote, and open no pull request; after the full-diff scope review, call link_code with scopeChecked: true and no prUrl — that moves the ticket to Verifying${merge ? "" : `, and the human merges your branch into ${defaultBranch} here`}`
      : "- after the full-diff scope review, call link_code with the pull request URL and scopeChecked: true — that moves the ticket to Verifying",
    mergeLine(merge, local),
    "- call note_progress with one line at each milestone; it is what the ticket shows while you work",
    local ? "" : "- if git push, fetch, pull or gh fails with an authentication or repository-not-found error, do not switch accounts, edit credential helpers or change the remote; commit locally, call note_progress with 'blocked: push …', and stop — the human owns credentials",
    `- do not mark the ticket done; ${completionPolicy === "merge" ? "the platform completes delivery after all code links merge" : "human acceptance is required, even after code merges; submit required artifacts for review"}`
  ]
    .filter(Boolean)
    .join("\n");

/** The first message of a thread started from a ticket: the ticket, the place, the protocol. How to code is the repository's CLAUDE.md's business. */
export function firstPrompt(input: FirstPromptInput): string {
  const { item, repo, state, branch, blockers, bootstrap, mcpUrl } = input;
  const playbook = bootstrap ? "code.bootstrap" : "code.implement";
  const accepted = (input.decisions ?? []).filter((d) => d.status === "accepted");
  const parts = [
    `${bootstrap ? "Bootstrap" : "Implement"} ${item.key} — "${item.title}".`,
    languageLine(input.locale),
    `Follow the playbook first: open_playbook("${playbook}").`,
    "",
    "Ticket:",
    item.body?.trim() || "(no description yet — read the backlog around it, and ask before assuming)",
    attachmentsLine(item.body),
    "",
    `Repository: ${repo.name} (${input.local ? "local, no remote" : repo.remote}) · default branch ${repo.defaultBranch} · your branch ${branch}.`,
    input.subdir ? `This workstream's code lives in ${input.subdir}/ inside the repository — you are started there; keep the work under it, and put shared files (CLAUDE.md, CI) at the repository root.` : "",
    state?.hasBrief
      ? "Read CLAUDE.md or AGENTS.md before writing anything."
      : state?.readiness === "scaffolded"
        ? `There is no CLAUDE.md yet: learn the stack from ${state.manifests.join(", ") || "the code"}, and add a short CLAUDE.md as part of this work.`
        : "The repository has no project in it yet.",
    waitsOnLine(blockers.map((b) => ({ key: b.key, title: b.title, status: b.status }))),
    accepted.length
      ? `Decisions on record (list_decisions has the details): ${accepted.map((d) => `${d.id} ${d.title}${d.areas.length ? ` [${d.areas.join(", ")}]` : ""}`).join("; ")}. Anything cross-cutting outside these: ask, then record_decision.`
      : "No decisions are on record yet: a cross-cutting choice (state management, routing, persistence, deployment shape) is asked about, then recorded with record_decision, never made silently.",
    mcpUrl && bootstrap ? `Tomrade's MCP endpoint for this project, for the repository's .mcp.json and .codex/config.toml: ${mcpUrl}` : "",
    "",
    conventions(item.key, repo.defaultBranch, input.completionPolicy ?? (state?.autoDone ? "merge" : "human"), input.local, input.merge ?? state?.agentMerge ?? false)
  ];
  return parts.filter((p) => p !== "").join("\n");
}

/** Picking a thread back up: where it stopped, what the branch looks like now. */
export function continuePrompt(item: Item, repo: Repo, session: SessionView | null, link: CodeLinkView | null, completionPolicy: "merge" | "human" = "human", local = false, locale: LanguageTag = "en", merge = false): string {
  const parts = [
    `Continue ${item.key} — "${item.title}" on branch ${link?.branch ?? session?.branch ?? "(see the thread)"}.`,
    languageLine(locale),
    "",
    "Ticket:",
    item.body?.trim() || "(no description)",
    attachmentsLine(item.body),
    "",
    session?.summary ? `Last note: ${session.summary}` : "",
    link ? `Branch: +${link.ahead} −${link.behind} against ${repo.defaultBranch}${link.prUrl ? ` · pull request ${link.prUrl} (${link.prState ?? "open"})` : local ? "" : " · no pull request yet"}.` : "",
    "Check the working tree and the tests, then carry on where you stopped. get_item has the ticket's latest state if you need it.",
    "",
    conventions(item.key, repo.defaultBranch, completionPolicy, local, merge)
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
