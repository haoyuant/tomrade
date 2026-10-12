/** The project a session stands in; null on the bare MCP endpoint, which spans projects. */
export interface SyncScope {
  projectName: string;
  prefix: string;
}

export const SYNC_PROMPT = "sync";

const where = (scope: SyncScope | null): string =>
  scope
    ? `Tomrade, the backlog of project "${scope.projectName}" (ticket keys look like ${scope.prefix}-42)`
    : "Tomrade (this connection spans projects: call list_projects and pass projectId to each tool)";

/**
 * How one session's work goes back into the backlog. A sync never requires a
 * ticket: plenty of work has none, and plenty of tickets have no code.
 */
export function syncSteps(): string[] {
  return [
    "1. Gather what this session did: what was built, changed, decided or found — from the conversation and, in a git repository, from the current branch, its commits not on the default branch, and any pull request.",
    "2. Match the work to tickets. A key in the branch, a commit, the pull request or the conversation settles it (get_item). Without one, search list_items with one or two distinctive words and take only a ticket that clearly describes this work. Work that matches no ticket stays unmatched, and that is fine.",
    "3. Before writing, show the user a short list: what you will change on each ticket, and any follow-up tickets you would file. When every match came from a key and nothing new would be filed, go ahead; otherwise wait for the user to confirm or adjust.",
    "4. Write:",
    "   - Code: link_code with the branch, and the pull request URL if there is one. From then on Tomrade reads the status from git (commits → Doing, open pull request → Verifying, merge → Done); never mark a code ticket done yourself.",
    "   - Work without code: change_status to doing once it has started, or submit_delivery with a short report when it is finished and needs the user's review. Mark it done only when the user says so.",
    "   - Progress: note_progress with one line, when Tomrade tracks this session; if it answers that it does not, skip it.",
    "   - Follow-ups: create_item, one per separate piece of work this session found but did not do. Do not file a ticket for finished work unless the user asks for one.",
    "5. End with a short summary: each ticket and what changed on it, the keys of new tickets, and the work you left unmatched."
  ];
}

/** What `/tomrade:sync` sends as the user's message. */
export function syncPrompt(scope: SyncScope | null): string {
  return [`Sync this session's work back to ${where(scope)}.`, "", ...syncSteps()].join("\n");
}

/** What every client connected without a run token reads first: when Tomrade is worth reaching for, and that it is never required. */
export function syncInstructions(scope: SyncScope | null): string {
  return [
    `This server is ${where(scope)}.`,
    "Not every session works on a ticket and not every ticket involves code: never ask the user to open a ticket before working, and never invent one.",
    "When the user names a ticket to work on, claim_ticket marks it Doing and names the branch.",
    "When the user asks to sync with Tomrade (in Claude Code: /tomrade:sync), gather what the session did, match it to tickets by key or by search, show what you will write, then link code (link_code), move status (change_status), and file follow-ups (create_item).",
    "When a meaningful piece of work looks like it belongs to a ticket, you may offer once to sync it back; drop it if the user declines."
  ].join(" ");
}
