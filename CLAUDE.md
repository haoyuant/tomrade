# Tomrade

Local-first backlog workbench: an Electron app (`apps/desktop`) with a React UI (`packages/ui`) over a plugin-based backend (`packages/*`, TypeScript, pnpm workspace). Domain language lives in `CONTEXT.md`.

## Layout

- `apps/desktop` — Electron main process, preload, packaging, Electron-driven UI checks (`scripts/*-check.mjs`)
- `packages/ui` — renderer: React 19, TanStack Router/Query, Tailwind; strings in `src/lib/i18n-messages/` (hand-rolled i18n, see Strings below)
- `packages/*` — core and plugins (`@tomradex/*` / `@tomrade/*`): items, storage, agent engines, files, settings, MCP, …; `packages/README.md` lists each one's role, `ctx` key and dependencies

## Commands

- `pnpm install` — needed once per fresh worktree
- `pnpm typecheck` — `tsc -b` for the backend, then the UI
- `pnpm lint` — ESLint: the React hooks rules for the UI, a few bug-catching TypeScript rules everywhere; `pnpm lint:unused` reports unused files, exports and dependencies (knip) without failing
- `pnpm test` — vitest across packages, on a fast-spawning node (`TOMRADE_TEST_NODE`, else an adhoc-signed one such as Homebrew's; see `docs/testing.md`)
- `pnpm test:related` — only the tests that reach the files changed against `origin/main` (committed or not); falls back to the touched packages' tests
- `pnpm test:ui` — Electron UI regression harness (slow; has a known flaky baseline)
- `pnpm dev` — run the desktop app

## Conventions

- Build features as plugins where possible; core reads contracts only.
- Every user-facing string is translated; see Strings below.
- Minimal comments: short why-comments only.
- Commit messages name the ticket key (e.g. `TOM-42: …`).
- On a ticket, iterate with `pnpm test:related`; run the full `pnpm test` once before opening the pull request, and put that run's node and **Failures by kind** block in the PR body.

## Strings

- UI: every user-facing string goes through `t(...)`. Each feature file in `packages/ui/src/lib/i18n-messages/` exports `en` and `zh`; `index.ts` assembles them and types `zh: typeof en`, so en and zh are both required and a missing zh key fails `pnpm typecheck`.
- The six other built-in locales, `i18n-messages/locales/*.ts` (de, es, fr, ja, ru, zhHant), are `PartialMessages`: a key they lack falls back to English. Add to them when you can; never required.
- `pnpm i18n:check` warns (never fails) about what each of those locales lacks and which translations are stale: git blame shows their English changed in a later commit (`--keys` lists every key). Updating a translation's line makes it current again.
- Backend: a package's words live in `src/words.ts` as `defineWords(id, { en, zh })` (`@tomradex/domain`); zh must have every key with the same `{{slots}}`. Other languages read English (or an installed language pack). Prompts for an agent stay in English.

<!-- BEGIN TOMRADE -->
## Tomrade

The backlog for this repository lives in Tomrade (project "Tomrade"), reachable as the `tomrade` MCP server (`.mcp.json` for Claude Code and WorkBuddy, `.codex/config.toml` for Codex, `.pi/extensions/tomrade.ts` for Pi, `opencode.json` for OpenCode).
This section applies only when the `tomrade` MCP server is available in your session. Tomrade runs on one developer's machine; without it (no such server, or its tools fail to connect) everything below is void: work as usual, never try to reach Tomrade another way, and never mention tickets you cannot read.
Claude Code, Codex, WorkBuddy and Cursor report session lifecycle through repository hooks, Pi through that extension and OpenCode through `.opencode/plugins/tomrade.js`. The hooks also carry Tomrade's answer (Cursor's in its own fields): a code change made before this session claimed a ticket, or recorded the person's word to go without one, is refused with the way on. In Codex, trust the project and review the new hooks with `/hooks`, then start a new session; older Codex versions without hooks must be upgraded. Pi loads the extension once you trust the project. No `notify` setting is changed.
Cursor uses `.cursor/mcp.json`, and `.cursor/hooks.json` runs `.cursor/hooks/tomrade` (`.cursor/hooks/tomrade.ps1` on Windows). Gemini CLI uses `.gemini/settings.json` and does not report its lifecycle, but once it calls `claim_ticket` Tomrade follows the session through its MCP connection: later calls on that connection need no key. Use `note_progress` only when the claim's result says `tracking.tracked` is true.
For other MCP-capable agents, add a Streamable HTTP server named `tomrade` with URL http://127.0.0.1:19090/mcp/014ce729-9739-41b5-a148-8d73f7825928 in that agent's own settings. No configuration is generated for other tools; reading AGENTS.md alone supplies instructions, not MCP tools or session tracking.
Not every session works on a ticket, and not every ticket involves code: never invent one. Work without a ticket is fine.

### Before changing this repository

Before changing code here, look where you are: the checkout's branch, and whether this session holds a ticket. A session that holds a ticket goes on with it turn after turn; when the checkout is already on a ticket's branch (its name carries a key) and the request continues that work, `claim_ticket` that key once and go on there — no new ticket or branch per request. A new piece of work the person asked for gets a ticket of its own — `create_item` (or the key they named), then `claim_ticket` — and is made on the branch the claim returns, every commit message naming the key; do not ask first for that: the person can change or drop the ticket, and the sidebar shows what this session works on from the moment it claims. When it is unclear a ticket is wanted (a tiny fix, an experiment, something they may want kept out of the backlog), ask them first; if they want it done here without one, call `work_without_ticket` with their words and go on. Never edit or commit on the default branch, or on another ticket's branch, without one of these. Reading, searching, explaining and answering questions need nothing.

### When the work is a ticket (the user or the branch names a key such as `TOM-42`) and the `tomrade` server is available

- Call `claim_ticket("TOM-42")` before starting: it returns the ticket and the branch to use, and marks it Doing. A session that claimed a ticket owns only that ticket.
- Implement only its stated outcome and acceptance criteria; neighboring tickets are context, not extra work. Work you find for another ticket stays untouched — mention it when you sync.
- Branch names follow `{key}/{slug}` (for example `tom-42/short-slug`); every commit message names the key (`TOM-42: …`).
- Before pushing, inspect the complete diff against the default branch and remove models, screens, flows, APIs, refactors, and cleanup that the ticket does not require. Then call `link_code` with the pull request URL and `scopeChecked: true`. Never mark a ticket done yourself — merging does that.
- When `claim_ticket` returns `tracking.tracked: true`, call `note_progress` with one line at milestones; otherwise follow its connection instructions first.

### Syncing back

When the user asks to sync with Tomrade (in Claude Code: `/tomrade:sync`; in Codex: `$tomrade-sync`) and the `tomrade` server is available:

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
<!-- END TOMRADE -->
