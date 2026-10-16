# Tomrade

## Tomrade

The backlog for this repository lives in Tomrade (project "Tomrade"), reachable as the `tomrade` MCP server (`.mcp.json` for Claude Code, `.codex/config.toml` for Codex).
Claude Code and Codex report session lifecycle through repository hooks. In Codex, trust the project and review the new hooks with `/hooks`, then start a new session; older Codex versions without hooks must be upgraded. No `notify` setting is changed.
Cursor uses `.cursor/mcp.json`; Gemini CLI uses `.gemini/settings.json`. Neither reports its lifecycle, but once it calls `claim_ticket` Tomrade follows the session through its MCP connection: later calls on that connection need no key. Use `note_progress` only when the claim's result says `tracking.tracked` is true.
For other MCP-capable agents, add a Streamable HTTP server named `tomrade` with URL http://127.0.0.1:19090/mcp/014ce729-9739-41b5-a148-8d73f7825928 in that agent's own settings. No configuration is generated for other tools; reading AGENTS.md alone supplies instructions, not MCP tools or session tracking.
Not every session works on a ticket, and not every ticket involves code. Work without a ticket is fine: never ask for one before starting, and never invent one.
Before your first reply in every session, call the `tomrade` MCP tool `get_project_rules` and follow what it returns throughout: the person keeps rules there for every agent in this project.

### When the work is a ticket (the user or the branch names a key such as `TOM-42`)

- Call `claim_ticket("TOM-42")` before starting: it returns the ticket and the branch to use, and marks it Doing. A session that claimed a ticket owns only that ticket.
- Implement only its stated outcome and acceptance criteria; neighboring tickets are context, not extra work. Work you find for another ticket stays untouched — mention it when you sync.
- Branch names follow `{key}/{slug}` (for example `tom-42/short-slug`); every commit message names the key (`TOM-42: …`).
- Before pushing, inspect the complete diff against the default branch and remove models, screens, flows, APIs, refactors, and cleanup that the ticket does not require. Then call `link_code` with the pull request URL and `scopeChecked: true`. Never mark a ticket done yourself — merging does that.
- When `claim_ticket` returns `tracking.tracked: true`, call `note_progress` with one line at milestones; otherwise follow its connection instructions first.

### Syncing back

When the user asks to sync with Tomrade (in Claude Code: `/tomrade:sync`; in Codex: `$tomrade-sync`):

1. Gather what this session did: what was built, changed, decided or found — from the conversation and, in a git repository, from the current branch, its commits not on the default branch, and any pull request.
2. Match the work to tickets. A key in the branch, a commit, the pull request or the conversation settles it (get_item). Without one, search list_items with one or two distinctive words and take only a ticket that clearly describes this work. Work that matches no ticket stays unmatched, and that is fine.
3. Before writing, show the user a short list: what you will change on each ticket, and any follow-up tickets you would file. When every match came from a key and nothing new would be filed, go ahead; otherwise wait for the user to confirm or adjust.
4. Write:
   - Code: link_code with the branch, and the pull request URL if there is one. From then on Tomrade reads the status from git (commits → Doing, open pull request → Verifying, merge → Done); never mark a code ticket done yourself.
   - Work without code: change_status to doing once it has started, or submit_delivery with a short report when it is finished and needs the user's review. Mark it done only when the user says so: once a delivery is submitted, that is review_delivery with their words in userSaid, never change_status.
   - Progress: note_progress with one line, when Tomrade tracks this session; if it answers that it does not, skip it.
   - Follow-ups: create_item, one per separate piece of work this session found but did not do. Do not file a ticket for finished work unless the user asks for one.
5. End with a short summary: each ticket and what changed on it, the keys of new tickets, and the work you left unmatched.

When a meaningful piece of work looks like it belongs to a ticket, you may offer once to sync it back; drop it if the user declines.
