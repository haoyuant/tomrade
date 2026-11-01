# Packages

Every package in this workspace, what it is for, the key it claims on the cordis context (if any), and what it builds on. `apps/desktop/tomrade.yml` decides which of them the app loads; [`docs/architecture.md`](../docs/architecture.md) explains how they fit together.

## Two scopes

Packages are `@tomradex/*`; the app alone is `@tomrade/desktop`. That is deliberate, not a half-done rename:

- `@tomradex` is the scope on npm. The plugin SDK and its companions are published there, and so are the declarations full-mode plugins compile against, so renaming any of them breaks every plugin that installs them.
- `@tomrade/desktop` is the app and is never published. Electron names a checkout's data folder after it (`~/Library/Application Support/@tomrade/desktop` on macOS; the installed app uses its product name, `Tomrade`), so renaming it would move a checkout's data folder and its keychain key. `apps/desktop/electron-builder.yml` says the same.

## What npm gets

Every package keeps `"private": true`, so `npm publish` from a source folder fails. `scripts/npm-release.mjs` publishes instead: it stages a separate manifest for each package under `build/npm/`, with `workspace:*` dependencies pinned, versions set and, for the CLI and its host, the code bundled. `docs/releasing.md` says when it runs.

- **SDK line**: `domain`, `plugin-sdk`, `plugin-cli` and `plugin-host`, at the SDK's version. Each says so in its own `package.json` with `"tomrade": { "publish": "sdk" }`, and the release script reads that mark, stopping if it disagrees with what the script stages. What `domain` and `plugin-sdk` export is public API: plugins compile against it, and full-mode plugins run against the app's own copy, so a release that removes a name says so in its notes. Code only the app uses goes behind a subpath the published manifest leaves out, as `@tomradex/domain/model-errors` does.
- **Declarations only**: every other `@tomradex` package with `exports`, which is all of the ones below except `ui`, at the app's version. Full-mode plugins compile against these types; the running Tomrade supplies the code.
- **Not published**: `ui` and `apps/*`.

**ctx** is the service a package provides, read as `ctx.<key>` by everyone else. `ipc`, `alerts` and `desktop-surface` only declare a contract; the desktop shell supplies the implementation. **Builds on** lists the package's workspace dependencies from its `package.json`, leaving out `domain`, `contracts`, `ipc`, `db` and `settings`, which most packages use.

## Foundations

| Package | Role | ctx | Builds on |
|---|---|---|---|
| `domain` | Shared types, zod schemas, typed errors and the backend's `defineWords`. No I/O, no context. SDK line on npm. | — | — |
| `contracts` | What packages read of each other's services through `ctx.get`, named once (`contract`, `localeOf`, the troubleshooter's `Check`), and the helpers they share: `errorMessage`, `bestEffort`, atomic JSON files. Backend only. | — | — |
| `ipc` | The typed channel contract between the main process and the renderer. | `ipc` | — |
| `db` | A pool of SQLite caches (`hub.db` plus one file per project), the core schema, plugin migrations. | `db` | — |
| `hub` | This machine: its id, its Hub folder, the projects and checkouts it knows. | `hub` | — |
| `hub-cloud` | The optional account: Hub metadata in Supabase, encrypted sessions, an offline outbox. | `cloudHub` | hub, projects, storage |
| `machine-setup` | What this machine still lacks: finds git, and installs it with the system's own mechanism on a click where there is one (macOS Command Line Tools, winget). | `machineSetup` | — |
| `settings` | File-backed settings; plugins register sections by zod schema. | `settings` | hub, oplog, tools |
| `write` | The write protocol: the `write/pre-commit` waterfall and the default policies. | — | — |
| `oplog` | The append-only mutation log: append, read, undo. | `oplog` | hub, write |
| `tools` | The one tool registry, with guarded execution, for the assistant and MCP alike. | `tools` | write |
| `contributions` | Declarative UI contributions: commands, badges, status items, detail sections. | `contributions` | items |
| `testkit` | Boots a fresh in-memory context for tests. | — | boards, extensions, fields, hub, items, oplog, plugin-sdk, projects, write |

## The backlog

| Package | Role | ctx | Builds on |
|---|---|---|---|
| `projects` | Projects, the scope every board and issue lives in. | `projects` | hub, tools |
| `boards` | Boards (workstreams) and the views that slice them. | `boards`, `views` | oplog, tools, write |
| `fields` | The field registry: built-in fields plus user-defined ones. | `fields` | tools |
| `items` | Issues, labels and relations, written through the write protocol. | `items` | boards, fields, oplog, settings, tools, write |
| `deps-graph` | The Dependencies graph and the "blocked" badge over `Item.blocks`. | — | plugin-sdk |
| `inbox` | A project's inbox: feedback waits here until triaged into tickets. | `inbox` | boards, contributions, fields, items |
| `inbox-github` | GitHub issues as an inbox source. | — | github, inbox, items, repos |
| `inbox-tomrade` | Feedback sent from the app as an inbox source, for Tomrade's maintainers. | — | contributions, inbox |
| `inbox-triage` | The worker model proposes a kind, duplicate and reply for each new inbox entry. | — | agent-backlog, inbox, items, llm |
| `schedules` | Routines: a ticket from a template, or a prompt to the assistant, on a cadence. | `schedules` | agent, boards, code-link, items, tools |
| `night-shift` | Auto run: the agent plans a batch of tickets on the dependency graph, then works through it by dependency, in terminal panes or background sessions, within limits on concurrency, time, spend and failures. A night shift is its time-limited kind. | `nightShift` | agent, code-link, contributions, items, tools |
| `pr-feedback` | Failed CI, reviews and people's comments on a ticket's pull request reach the agent working that ticket. | `prFeedback` | agent, code-link, github, hub, items, repos |
| `watchdog` | Tells the person when a run seems stuck, repeats itself or goes nowhere; it never touches the run. | `watchdog` | agent, items, llm |
| `onboarding` | The first run's tour project, seen-hints, and the playbook that explains Tomrade. | `onboarding` | agent, boards, hub, inbox, items, keybindings, projects |
| `announcements` | Announcements published to every install, each shown once per machine. | — | contributions, plugin-sdk |

## Storage, files and code

| Package | Role | ctx | Builds on |
|---|---|---|---|
| `git` | Running git: the promptless environment, the command runner, one folder's helpers, remote URLs. A plain library. | — | — |
| `storage` | The project folder as the truth: its text artifact, providers, flush and refresh. | `storage` | alerts, contributions, git, hub, oplog, projects, write |
| `storage-git` | Any git repository as a project's destination: the storage provider for a git URL, not the library that runs git (that is `git`). | — | storage |
| `storage-github` | GitHub as a destination: finds or creates the repository. | — | github, storage, storage-git |
| `github` | The one GitHub account this machine uses: token, REST client, git credential helper. | `github` | git, storage |
| `files` | A project's files: a versioned folder tree, backends, sync, conflicts, pinned versions. | `files` | agent, boards, contributions, git, hub, items, oplog, storage, tools, write |
| `files-github` | GitHub as where a project's files are shared. | — | files, github |
| `notes` | Files read as notes: wiki links, backlinks, tags, full-text search, the journal. | `notes` | files, tools |
| `repos` | The code repositories workstreams stand for, their checkouts, agent worktrees. | `repos` | boards, git, hub, storage, tools |
| `code-link` | A ticket's branches, pull requests and coding sessions; status from git; Start. | `codeLink` | agent, boards, contributions, engine-kit, git, github, herdr, hub, items, llm, mcp, plugin-sdk, repos, storage, tools, write |
| `herdr` | herdr on this machine: its socket, server and panes. Optional. Off Windows it is also `terminals`, the backend the Terminal window and code link run panes on; it reads the agents herdr has no manifest for (CodeBuddy Code) off their panes itself, with the pty host's screen reading. | `herdr` | engine-kit, pty-host |
| `pty-host` | `terminals` on native Windows: a detached pty host Tomrade starts itself (node-pty over ConPTY), speaking herdr's shapes. It names the agent in each pane by Windows' process table and reads its idle / working / blocked off the screen with herdr's detection manifests (a copy in `agent-detection/`) and Tomrade's own for agents herdr has none for (`src/manifests-tomrade.ts`). Loaded on Windows only; elsewhere the app carries only its screen reading (`@tomradex/pty-host/screens`), for herdr's service. | `terminals` | — |
| `code-sessions` | The Terminal window: terminals (herdr's, or the pty host's on Windows) and code sessions side by side, with the assistant panel's conversations in its session bar; what its panes show is recorded, for an ended session's or a closed terminal's raw-output replay; `tomrade term` answers from the person's own terminal. | — | agent, code-link, contributions, desktop-surface, herdr, items, mcp |

## Agents

| Package | Role | ctx | Builds on |
|---|---|---|---|
| `agent` | The agent platform: threads, runs, ledger, workflows, run undo, the registries. | `agent` | fields, hub, llm, oplog, tools, write |
| `agent-backlog` | The backlog method: playbooks, dossier, `find_similar`, `plan_and_apply`, dedup policy. | — | agent, boards, items, llm, tools |
| `llm` | Model profiles and roles behind one interface; OpenAI-compatible and Anthropic adapters. | `llm` | desktop-surface, web-search |
| `engine-loop` | The in-app conductor: a model reasoning over the tool registry, guided by playbooks. | — | agent, llm, tools |
| `engine-scripted` | The no-model conductor: runs registered workflows from a menu. | — | agent |
| `engine-kit` | What every local-agent engine shares: finding and starting its CLI, JSON lines, the JSON-RPC peer, the turn frame, the pooled runtimes, prompts, the MCP link, the lent CLI model. | — | agent, llm, mcp |
| `engine-claude-code` | Claude Code as conductor, with Tomrade's tools over MCP. | — | agent, engine-kit, llm, mcp |
| `engine-codex` | Codex (app-server) as conductor. | — | agent, engine-kit, llm, mcp |
| `engine-pi` | The Pi coding agent as conductor. | — | agent, code-link, engine-kit, llm, mcp |
| `engine-acp` | One conductor for agents that speak ACP; the agents official plugins describe. | `localAgents` | agent, engine-kit, llm, mcp, plugin-sdk |
| `agent-setup` | One-click agent setup: installs a chosen agent's CLI in the background and watches its sign-in until it works. | `agentSetup` | agent, engine-kit |
| `acp-registry` | Agents added from the ACP registry (Zed + JetBrains's catalog): each becomes a local-agent declaration, installed with npm, run through npx and signed in the way the agent lists. | `acpRegistry` | agent, engine-acp, engine-kit, plugin-sdk |
| `shell` | A bash tool for in-process engines, asked before each command, never served over MCP. | — | tools |
| `web-search` | `web_search` and `web_fetch` for every engine, answered by a registered provider. | `webSearch` | tools |
| `web-search-tavily` | Tavily as that provider, with the person's own key. | — | web-search |
| `archify` | Archify diagrams as tools. | — | agent, files, tools |
| `doctor` | The troubleshooter: checks what failed, says what to do, sends a report. | `doctor` | agent, contributions, llm, projects, tools |
| `mcp` | Serves `ctx.tools` over MCP on 127.0.0.1. | `mcp` | contributions, tools |
| `mcp-client` | External MCP servers whose tools join `ctx.tools`. | `mcpClient` | engine-kit, tools |
| `im` | Chat-app transports over the agent: bindings, authorized inputs, replies. Adapters are plugins. | `im` | agent, contributions, oplog, plugin-sdk, projects |

## Desktop

| Package | Role | ctx | Builds on |
|---|---|---|---|
| `ui` | The React renderer; draws plugin contributions with its own primitives. Not published. | — | agent, announcements, fields, hub, hub-cloud, notes, repos, storage |
| `desktop-surface` | Contract for plugin-owned auxiliary windows. | `desktopSurfaces` | — |
| `alerts` | Contract for system notifications and sounds. | `alerts` | — |
| `pet` | The task-state companion, in the panel or on the desktop. | `pet` | agent, contributions, desktop-surface |
| `theme-image` | The pictures behind custom themes, kept on this machine; an assistant conversation, or the picture's own palette, turns them into a theme. | — | agent, settings, tools |
| `keybindings` | The default shortcuts and the person's rebound ones. | — | — |

## Plugins

| Package | Role | ctx | Builds on |
|---|---|---|---|
| `plugin-sdk` | The extension contract: `definePlugin`, the async `PluginContext`, the manifest. SDK line on npm. | — | — |
| `extensions` | The host side of that contract: namespaces, attribution, time-limited callbacks. | — | agent, alerts, boards, contributions, desktop-surface, fields, herdr, im, items, llm, oplog, plugin-sdk, projects, tools, web-search, write |
| `plugins` | Loads and manages the composition: rows, modules, installed extensions. | `plugins` | extensions, plugin-kit, plugin-sdk |
| `plugin-kit` | Package format, digests, signatures, the lock file, the static analyzer. | — | plugin-sdk |
| `plugin-cli` | `tomrade-plugin`: init, build, dev, test, check, pack. SDK line on npm. | — | plugin-host, plugin-kit, plugin-sdk |
| `plugin-host` | The Tomrade a plugin is tested against. SDK line on npm. | — | agent, alerts, contributions, desktop-surface, engine-acp, extensions, im, llm, testkit, tools, web-search |
| `plugin-studio` | Tools for an agent to write a plugin, loaded only at a build a person confirmed. | — | agent, plugin-cli, plugin-kit, plugin-sdk, plugins, tools |
| `community` | The plugin store: browse, install (digest-checked), update, revoke, report, publish. | `community` | git, github, hub-cloud, plugin-cli, plugin-kit, plugin-sdk, plugins |

## Apps

| App | Role |
|---|---|
| `apps/desktop` | The Electron shell: boots the context from `tomrade.yml`, supplies the IPC transport, alerts and windows, packages the installers. |
| `apps/store-admin` | The store's admin tool (`tomrade-store`): reports, revocations, official signatures. |
