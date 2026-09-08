# Hand-off: credentials pre-flight, and stopping a session that cannot reach its remote

Written 2026-09-08 by a Claude Code session for whoever carries on (Codex, or Claude when its quota returns).
Branch `feat/code-link`, worktree `.claude/worktrees/code-link`, PR #26 against `main`. Work only in this worktree.
The user is away; do not ask questions — decide as this brief says, note anything you would have asked under *Outcome* at the bottom.

## The problem

A machine has two GitHub accounts. The global credential helper (`gh`) hands git the wrong account's token for
`github.com`, so `git fetch`/`git push`/`gh pr create` against the project's repository fail — for a private repository
GitHub answers `remote: Repository not found.`, not "authentication failed". A coding agent Tomrade started in a
terminal hits this at push time, gets no signal that credentials are the human's problem, and burns tokens trying
alternatives (switching accounts, editing credential helpers, changing the remote). Tomrade shows nothing: the
session row keeps saying `running`, the ticket wears no badge, the thread gets no note.

## What already exists (read these first)

- `packages/code-link/src/scanner.ts` — `scanRepo` fetches and reports `offline` (fetch failed). `readiness` is
  `"unknown"` only when the fetch failed **and** no default branch exists locally; a checkout that already has
  `origin/main` stays `"scaffolded"` even when today's fetch failed. `offline` is counted in `ScanSummary` but is
  **not stored** in repo state and **not shown** in the UI.
- `packages/code-link/src/start.ts` — `Starter.start` has gates `locked / workstream / checkout / remote / readiness /
  blocked / engine / mcp / workdir`. The `remote` gate probes with `GitFolder.probe` (`git ls-remote --exit-code`,
  `packages/storage/src/git.ts`) **only when readiness is `empty` or `unknown`**. A scaffolded repository with broken
  credentials passes.
- `packages/code-link/src/sessions.ts` — `Sessions.event` handles Claude Code hook events. `PostToolUseFailure` only
  sets `activity: "<tool> failed"` and keeps `state: "running"`. `StopFailure` sets `state: "error"` (that is the
  "stuck" badge) but it is about the model API (rate limit, Anthropic auth), not git. `hooksSettings` writes the hook
  settings file: every event runs one `curl` that POSTs the payload to Tomrade's event URL and discards the response
  (`>/dev/null`). `HookPayload` lists the fields read.
- `packages/code-link/src/service.ts` — `noteMoment` appends a note to the ticket's thread; the section rows and
  badges (`stuck`, `waiting`) are computed around lines 740–830; `doScan` writes repo state via `upsertRepoState`.
- `packages/code-link/src/store.ts` — `RepoStateView`/`RepoStatePatch` (SQLite table `plugin_code_link_repo_state`,
  migrations in `MIGRATIONS`), `SessionState = running | waiting | idle | error | ended | lost`, `SessionPatch`.
- `packages/code-link/src/prompts.ts` — `firstPrompt`, `continuePrompt`, the `conventions` block.
- `packages/code-link/playbooks/code.implement/SKILL.md` — the playbook the agent is told to open.
- `packages/repos/src/service.ts` — `setCheckout`, `clone`, `checkout(remote)`; the UI is
  `packages/ui/src/components/projects/RepositoriesBlock.tsx`; the readiness tag is in
  `packages/ui/src/components/workspace/TitleBar.tsx`, strings in `packages/ui/src/lib/i18n-messages/codeLink.ts`
  (English and Chinese — add both).
- `packages/storage-github/src/index.ts` — the Hub's GitHub token (`settings.github.token`), verified with `whoami`
  when saved. Not used for code repositories today, by design ("still their repository — never pushed").

## Claude Code hook facts (verified against https://code.claude.com/docs/en/hooks.md on 2026-09-08)

- Events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest,
  Notification, Stop, StopFailure, SubagentStop, SessionEnd, PreCompact. Matchers on tool name work for
  PreToolUse / PostToolUse / PostToolUseFailure (e.g. `"matcher": "Bash"`).
- `PostToolUseFailure` stdin: `session_id, hook_event_name, tool_name, tool_input, tool_error (string), tool_use_id,
  cwd`. Stdout JSON may carry `additionalContext` and `systemMessage`; both reach the model. No block decision here.
- `PostToolUse` stdin has `tool_output` (the Bash tool's stdout/stderr/exit). Stdout JSON may carry
  `additionalContext` / `systemMessage`.
- `PreToolUse` stdout JSON: `{"hookSpecificOutput": {"permissionDecision": "allow"|"deny", "permissionDecisionReason":
  "...", "additionalContext": "..."}}`. A `deny` blocks the call and the reason is shown to the model.
- `StopFailure` stdin: `error_type` (rate_limit, overloaded, authentication_failed, billing_error, server_error,
  max_output_tokens, unknown, …) and `error_message`. **The current code reads `error` and `error_details` — fix it.**
- `Notification` `notification_type` values include permission_prompt, idle_prompt, agent_needs_input,
  elicitation_dialog, agent_completed.

## Tasks, in order — commit after each, run the checks before each commit

### 1. Reachability is a fact about the checkout: measure it everywhere, store it, show it

- Add to repo state (migration + `RepoStateView` + `RepoStatePatch`): `remote: "ok" | "unreachable" | "unknown"`,
  `remoteDetail: string | null` (the last stderr line, credential-scrubbed — see `cleanRemote`/the scrub in
  `GitError`), `remoteAt: number | null` (last time it was reachable).
- `scanRepo` returns the fetch's stderr last line when it fails; `doScan` stores `remote`/`remoteDetail`/`remoteAt`.
- Classify the failure in one place (a small pure function with tests), e.g. `classifyRemoteFailure(stderr)`:
  - `"credentials"`: `Authentication failed`, `could not read Username`, `Permission denied (publickey)`,
    `Repository not found`, `403`, `The requested URL returned error: 40[13]`, `Invalid username or token`
  - `"network"`: `Could not resolve host`, `Connection timed out`, `Failed to connect`, `Connection refused`,
    `Network is unreachable`, `unable to access` without any of the above
  - `"unknown"` otherwise.
  Note: for a private repository the wrong account yields `Repository not found` — the message must say so:
  "origin says the repository does not exist; for a private repository that usually means the account git uses here
  cannot see it".
- Run the probe after `repos.setCheckout` and `repos.clone` succeed (fire-and-forget via the code-link scan, or a
  direct probe that writes the same fields), so the Repositories row can say "cannot reach origin from this checkout"
  right after the user points Tomrade at a folder.
- UI: the Repositories row (`RepositoriesBlock.tsx`) shows the remote state with the detail as tooltip/hint (follow
  the `StorageBlock` "Cannot reach it" pattern); the TitleBar readiness tag shows "remote unreachable" when
  `remote === "unreachable"`; the status item (`contributions.statusItem` in service.ts) appends `· N unreachable`.
- **Identity line** (which account git will use), computed on demand by an IPC (`codeLink.remoteIdentity(remote)` or
  on the repos service), shown on the Repositories row: for `https://` remotes run `git credential fill` with
  `protocol=https`, `host=<host>`, `path=<owner>/<repo>` on stdin, in the checkout, with the same non-interactive
  env `gitRunner` uses (`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=""`), and return **only the `username=` line — never
  log, store or return the password**. For `git@`/`ssh://` remotes run `ssh -T -o BatchMode=yes git@<host>` and parse
  `Hi <login>!` (GitHub) from stderr; exit code 1 is normal there. Display: "origin reached as @<login>" or
  "no credential for <host>".

### 2. Start: probe every repository, block on credentials, warn on network

In `Starter.start`, after the existing checkout gate:
- Probe for **all** readiness values (keep the existing empty/unknown logic for deciding bootstrap).
- `probe === "offline"` and the classification is `credentials` (or `unknown`) → `{ ok: false, gate: "remote", ... }`
  with the classified message and `remote` filled, so the UI's Start menu can offer "Open Repositories" the way it
  does for the `checkout` gate (`StartTicketMenu.tsx`).
- Classification `network` → do **not** block. Add `warnings?: string[]` to the ok-branch of `StartResult`, put
  "origin unreachable right now (<detail>) — commit locally, do not push until it is back" there, surface it in the
  toast (`startCommand` in service.ts), and append the same line to `firstPrompt`/`continuePrompt` for this start.
- When `agentPush` is on for the repository (`RepoStateView.agentPush`) also run `git push --dry-run origin
  HEAD:refs/heads/<branch>` in the checkout as a write probe (it authenticates without updating refs); a credentials
  failure there blocks like a read failure. Skip the dry run when the read probe already failed.
- Tests in `packages/code-link/tests/start.test.ts`: a scaffolded repository whose origin is unreachable with a
  credentials-looking error is refused at gate `remote`; a network-looking error starts with a warning.

### 3. In-session: recognise the failure, mark the session stuck, and stop the retry loop deterministically

- `hooksSettings`: the curl must print the server's response body to stdout instead of discarding it (keep the
  `-m 5` and `|| true`; Claude Code reads stdout JSON only on exit 0). The event endpoint currently returns nothing
  useful — make the bound `event` handler (`ctx.mcp.bindRun(token, { execute, event })`, see `Sessions.bind` and
  `packages/mcp/src/index.ts`) able to return a JSON body; check what the MCP package's event route does today and
  extend it so the handler's return value becomes the HTTP response body (`{}` when there is nothing to say).
- In `Sessions.event`:
  - `PostToolUseFailure` (and `PostToolUse` whose `tool_output` shows a non-zero exit — check which one Claude Code
    fires for a failing Bash command; handle both) with `tool_name === "Bash"`, a command matching
    `\bgit\s+(push|fetch|pull|ls-remote|clone)\b` or `^\s*gh\s`, and a `credentials` classification of the error text →
    `state: "error"`, `summary: "cannot reach origin from this worktree: <detail>"`, `activity: null`, a moment of kind
    `failed` (the thread note), and a hook response `{ "additionalContext": "<the stop text below>" }`.
  - Remember the finding on the session (`SessionPatch`: a `blocked: "credentials" | null` column, migration) so the
    **next** `PreToolUse` for Bash with a matching `git push|fetch|pull` / `gh` command answers
    `{"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "<the stop text>"}}`. Other
    commands stay allowed — the agent may still commit locally and run tests.
  - The stop text: "Tomrade: origin is not reachable from this worktree with the credentials git has here (<detail>).
    Credentials are the human's to fix — do not switch accounts, edit credential helpers, or change the remote. Commit
    your work locally, call note_progress with one line starting 'blocked: push', and stop."
  - Clear `blocked` and the `error` state when the session is continued (`Starter.start` on the `continued` path)
    and when a later probe of the same checkout succeeds (a scan that finds `remote: "ok"` clears every live
    session's `blocked` on that repository and returns them to `idle`).
  - Fix `StopFailure` to read `error_type` / `error_message`.
- Headless (`mode: "run"`) sessions do not go through hooks; do the same classification on the engine's tool
  results if there is a hook point (`agent/run-ended` carries `run.error`; look for a per-tool event on the agent
  platform and use it if it exists — otherwise leave headless for later and say so under *Outcome*).
- Tests: a `PostToolUseFailure` payload with a `Repository not found` error on `git push` flips the session to
  `error`, appends a note, returns `additionalContext`; the following `PreToolUse` for `git push` is denied; a
  `PreToolUse` for `pnpm test` is not; Continue clears it.

### 4. Playbook and conventions

Add one line to `code.implement/SKILL.md` (after step 7) and to `conventions()` in `prompts.ts`: if `git push`,
`fetch`, `pull` or `gh` fails with an authentication or "repository not found" error, do not switch accounts, edit
credential helpers or change the remote; commit locally, call `note_progress` with `blocked: push …`, and stop — the
human owns credentials.

### 5. (Only if 1–4 are green and time remains) one-click credential fix

On the Repositories row, when `remote === "unreachable"` with a credentials classification **and** the Hub's GitHub
token is connected (`storage-github`'s `connection.status()` says connected as `@login`): a button "Use Tomrade's
GitHub account (@login) for this checkout". It writes to the checkout's own `.git/config` (never global):
`credential.https://github.com.helper` = `''` (an empty entry to cut the global chain) followed by a second entry
pointing at a small helper script Tomrade writes under the Hub (`<hub>/bin/tomrade-credential`) that prints
`username=x-access-token` and `password=<token read from Tomrade's settings file at call time>` for the `get` action
and exits 0 for `store`/`erase`. Then re-probe. Do not build SSH key management.

## Constraints and gotchas

- Checks, from this worktree: `pnpm test` (baseline: 308 passing on `fc7aad3`), `pnpm build:backend`,
  `pnpm --filter @tomrade/ui typecheck`. Run all three before every commit. Do not run `pnpm install` unless a
  dependency changes (node_modules is present).
- Do not touch `/Users/haoyuant/Projects/tomrade-next` (the main worktree) — another session works there.
- Do not push. Commit per task with the style already in `git log`: `feat(code-link): …` / `fix(code-link): …`,
  a subject that says what changed for the user, a short body that says why.
- Code style: short "why" comments only, no narration; keep the existing voice of the files.
- Plugin namespace is `code_link` (tables `plugin_code_link_*`); schema changes go through `MIGRATIONS` in `store.ts`
  with the next `version`.
- Git format strings use `%00` / `%x1f` / `%x1e`, never literal control characters in source.
- Test fixtures: `CodeLink` injects `settings`, so contexts need `[Settings, {path}]`; branches in fixtures must be
  created from `main` explicitly; nested `ctx.inject` fibers need a `settle()` tick (`@tomrade/testkit`).
- In terminal mode the MCP gate must stay **before** thread/link/session creation (a failed start must leave nothing
  behind); put the new `remote` gate before it too, where the current one is.
- Never let a token reach a log, toast, thread note or repo-state row: scrub `//user:pass@` from any git output you
  store (see `GitError` in `packages/storage/src/git.ts`).
- i18n: every new UI string gets an English and a Chinese entry in the relevant `i18n-messages/*.ts`.

## Outcome

Completed 2026-09-08 in this worktree. Nothing was pushed.

### Landed

1. `302fac3` — `feat(code-link): show checkout reachability and git identity`
   - Stores `remote`, scrubbed `remoteDetail`, and the last successful `remoteAt`; checkout placement and clone trigger a scan.
   - Shows reachability in Repositories and the workstream title, counts unreachable repositories, and resolves the checkout's HTTPS/SSH login on demand without returning a password.
2. `1cde272` — `feat(code-link): preflight remote access before starting`
   - Probes every checkout before Start, blocks credential/unknown read failures, warns but permits local work during network failures, and dry-runs push authentication when agent push is enabled.
3. `2e61f5c` — `feat(code-link): stop credential retry loops in sessions`
   - Returns hook JSON through the MCP event route, recognizes both Bash failure event shapes, persists the credential block, denies subsequent remote commands, writes the failed moment, clears the block on Continue or a successful scan, and reads the current StopFailure fields.
   - The agent platform exposes no per-tool shell event for headless engines. Headless sessions therefore use the available `agent/run-ended` error as a fallback and apply the same credential classification there.
4. `db4e3e7` — `docs(code-link): teach agents to stop on credential failures`
   - Adds the human-owned credential boundary to the implementation playbook and generated prompt conventions.

### Checks

- Before changes, `pnpm test`: 306 passed, 7 failed, 1 skipped (314 total). All seven failures were MCP-backed tests unable to bind `127.0.0.1:0`.
- After tasks 1–4, `pnpm test`: 326 passed, 7 failed, 1 skipped (334 total). The same seven tests fail for the same sandbox restriction; a direct Node probe confirms `listen EPERM: operation not permitted 127.0.0.1` in this environment.
- `pnpm build:backend` and `pnpm --filter @tomrade/ui typecheck` passed before every task commit.
- Runnable focused coverage passed: 22/22 task-1 reachability tests; 3/3 task-2 preflight cases; 9/9 non-TCP session/start checks (with the one TCP terminal case excluded); and 3/3 task-4 prompt/session checks.

### Skipped at the initial handoff

- Task 5 was not attempted. Its condition says tasks 1–4 and their checks must all be green; the required full suite cannot be green in this sandbox because local TCP listen is prohibited. No checkout credential helper or GitHub-token integration was written.
- The MCP HTTP response assertion was added but could not execute here for the same TCP restriction. The response contract compiles, and the handler response plus generated curl command are covered without a socket.

### What I would have asked

- Whether to treat the sandbox's seven unchanged TCP-listener failures as an environmental exception and continue committing tasks 1–4. The brief says never ask and to decide, so I continued after proving the restriction independently and kept exact counts above.
- Whether to attempt task 5 despite that exception. The brief's condition is explicit, so I skipped it.

### Task 5 follow-up — completed after the user's explicit request

- Repositories offers the connected Tomrade GitHub account for HTTPS GitHub credential failures, including Git's `fatal: repository '<url>' not found` form. The switch validates the current origin, updates only the checkout's shared local config using a lock and atomic replacement, and probes origin again. A failed probe remains visibly unreachable; a successful probe clears blocked sessions.
- `<hub>/bin/tomrade-credential` reads the token from machine settings on each request. Neither the helper nor git config contains a token. Existing worktrees inherit the helper; global helpers, other hosts, HTTP and SSH are unaffected.
- App-initiated `gh` PR calls and newly launched terminal/headless coding processes in opted-in checkouts receive ephemeral `GH_TOKEN` / `GITHUB_TOKEN`. The agent prepare-turn event supplies subprocess environment without persisting it or adding it to prompts. Terminal launch scripts contain only a runtime helper invocation. Already-running processes need a new turn or restart to receive the environment; independently opened terminals retain their own `gh` login.
- Corrected the scoped `storage` dependency on CodeLink: direct service calls could see it before, but IPC calls could not. The Electron regression verifies the real IPC path.
- Project settings use design tokens for 8px content gaps, 12px field/card gaps and 20px section gaps. Remote error title/detail stack without overlap, and the branch input no longer consumes the repository header.
- The earlier Claude Code startup fix is preserved: headless code turns use `--strict-mcp-config`, avoiding inherited MCP startup delays.

Validation: 341 tests passed, 1 skipped under Electron's Node runtime (the installed SQLite addon targets Electron); backend build and UI build/typecheck passed. The isolated Electron credential UI check passed, covering IPC account lookup, the button, spacing/overflow, remote reprobe and updated identity. All credential fixtures use fake accounts/tokens; no real repository was pushed or had its credentials changed by the checks.

Run the focused UI check with the feature branch's dev server: `TOMRADE_DEV_URL=http://127.0.0.1:5174 pnpm --filter @tomrade/desktop exec electron scripts/credential-check.mjs`. Before/after captures are written to `/tmp/tomrade-project-settings-{before,after}.png`. Port 5173 belongs to the main checkout in this session; the feature checkout runs on 5174.
