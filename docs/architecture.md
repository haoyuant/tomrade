# Architecture

How Tomrade is put together, and the decisions it is held to. The [README](../README.md) is the tour; this is the map for people changing the code. Domain words (ticket, delivery, code link, sync back…) are defined in [`CONTEXT.md`](../CONTEXT.md).

## Product decisions (direction of record)

1. **Local-first desktop.** Electron shell + React UI + in-process TypeScript backend. Each project is a folder — a text artifact — that is the truth; SQLite is a per-project **cache** of it (+FTS5), one file per project, that can be deleted and rebuilt. The desktop build uses Supabase for an optional account that syncs portable Hub metadata, with an offline outbox; without an account that metadata stays on this machine. Project storage remains local-first either way. See [`supabase-hub.md`](supabase-hub.md).
2. **Full-stack TypeScript.** One language, one process, one set of types. Zod schemas shared by UI / backend / MCP tool definitions.
3. **Human work is sacred.** Field-level `updated_by: human|ai` + optimistic version check + `human_locked` fields + **undo stack**. AI never silently overwrites human edits, and a caller that supplies `baseVersion` is refused when stale *whoever it is*. No approval gates, no changesets — AI writes apply immediately but are always reversible and always carry provenance. The one write undo cannot reach is a **permanent delete**, and it is human-only.
4. **Everything is a plugin on a cordis context.** The database, the oplog, the repositories, the write policy, the tool registry, the LLM provider, the MCP server, the IPC channels and the UI's plugin contributions are each a plugin; every one but the write policy claims one key (`ctx.db`, `ctx.items`, `ctx.tools`, …), and the policy only listens. `apps/desktop/tomrade.yml` is the application: one row per plugin, replaceable by id. A plugin from outside the app — Community, a file, a folder, or one an agent wrote in Plugin Studio — is written against `@tomradex/plugin-sdk` and loaded behind an async, attributed, namespaced facade — see [`plugin-api.md`](plugin-api.md).
5. **One agent platform, pluggable conductors.** `ctx.agent` owns what every conductor needs — threads, runs, the per-run ledger, cards, suspended workflows, run-scoped undo — and holds no opinion about what to do next. **Engines** decide that, and are plugins: `engine-loop` (a conversation model over the tool registry, guided by playbooks), `engine-scripted` (menu-driven, no model, offline), `engine-claude-code` / `engine-codex` / `engine-pi` (the user's own CLI agents, tools over MCP), and, as official plugins on one ACP conductor (`engine-acp`, `ctx.agent.localAgent`), Hermes, DeepSeek Harness, OpenCode, WorkBuddy, Gemini CLI, Antigravity CLI and Cursor. Deterministic multi-step jobs are **workflows** — typed, resumable step machines exposed as tools to every engine; invariants are **policies** on `tools/pre-execute` (an agent create without a duplicate check is refused, whoever conducts). `ctx.llm` stays the model seam: profiles (DeepSeek/Anthropic/OpenAI-compatible/local) with `conversation` and `worker` roles.
6. **One tool registry, every surface.** A tool registered on `ctx.tools` appears in the in-app assistant's prompt and on the MCP server at once. There is no per-surface code.
7. **MCP server is a first-class interface.** VS Code coding agents list/read/write/search tickets over MCP (`@modelcontextprotocol/sdk`, TS). This is the product's open API.
8. **Data shaped for future sync.** UUID PKs, `updated_at` + `updated_by` + `version` per row, an append-only **oplog** whose rows are stamped with the machine that wrote them (`device`/`device_seq` name one op everywhere) and carry the fields they changed (`patch_json`). It feeds undo today and the project folder's write-through log always. A permanent delete is the single exception: it removes the purged item's own rows and leaves a tombstone.
9. **Boards are workstreams; views are slices.** A project holds any number of **boards**, and a board is the container an issue belongs to. A **view** is a saved slice of one board. Dragging a card writes the grouped field and never the board. See [`design-system.md`](design-system.md).

## Explicitly NOT doing

- No approval gates: an agent run applies immediately, and **one click reverts the whole run** (oplog rows carry the `run_id`). No changesets / three-way merge / field provenance tables.
- No event sourcing / reactive reaction model. Plain transactional writes; policy is a synchronous waterfall in front of the commit.
- No orchestration graphs and no per-message intent router: one engine conducts a thread; composition happens through workflows-as-tools.
- No code evaluation in configuration. `tomrade.yml` is static YAML with `${userData}`-style substitution and nothing more.
- No profile or bundle layering. One file plus one patch file, merged by id.
- No renderer plugin bundles. Plugins contribute data — commands, badges, status items, sections, settings cards — and the UI draws it with its own primitives.
- No LangGraph, no LangChain, no separate vector DB. No cloud project database or Realtime project collaboration. Supabase Auth/Postgres holds Hub metadata and separate usage-analytics tables; analytics never joins account or project records. No Docker runtime requirement. No SSR web.

## Repo layout

[`packages/README.md`](../packages/README.md) is the full package table: each package's role, its `ctx` key and what it builds on. The map below is the short version.

```
apps/desktop          Electron shell: boots the context from tomrade.yml, supplies the IPC transport, opens the window
apps/desktop/tomrade.yml   the application — the modules it needs, then one row per plugin

packages/domain       types + zod schemas + typed errors. Zero I/O, zero ctx. Everyone imports this.
packages/contracts    —                what packages read of each other through ctx.get, named once; errorMessage, bestEffort, atomic JSON files
packages/db           ctx.db           a pool of SQLite caches — hub.db plus one project.db per project; core schema, plugin table registry
packages/hub          ctx.hub          this machine: device id, and the catalog of projects and repository checkouts it knows
packages/hub-cloud    ctx.cloudHub     Supabase accounts and Hub metadata; encrypted sessions, durable outbox and conflicts (the account is optional)
packages/oplog        ctx.oplog        append, read, undo — per project, each row stamped with the machine that wrote it
packages/fields       ctx.fields       the field registry: built-in fields plus user-defined ones and their options
packages/write        —                write/pre-commit waterfall + the default policy plugins
packages/items        ctx.items        issues, labels, relations (+ their tools and channels)
packages/deps-graph   —                the Dependencies graph and the "blocked" badge over Item.blocks
packages/boards       ctx.boards, ctx.views
packages/projects     ctx.projects
packages/tools        ctx.tools        one registry, guarded execute
packages/llm          ctx.llm          model profiles + roles; chat-with-tools + structured JSON; OpenAI-compatible & Anthropic adapters
packages/settings     ctx.settings     file-backed; sections registered by zod schema
packages/git          —                running git: the promptless environment, the command runner, one folder's helpers, remote URLs
packages/storage      ctx.storage      the project folder as the truth: text artifact, write-through log, publish/refresh/merge, the Hub's catalog
packages/storage-git  —                any git URL as a remote for a project's own repository (the provider, not the git library)
packages/storage-github —              GitHub: repository discovery and creation on top of storage-git
packages/github       ctx.github       the one GitHub account this machine uses: token, REST client, git credential helper
packages/repos        ctx.repos        the code repositories workstreams stand for; this machine's checkouts; agent worktrees
packages/code-link    ctx.codeLink     a ticket's branches, worktrees, pull requests and coding sessions; status from git; the Start button
packages/herdr        ctx.herdr        herdr on this machine: its socket and panes (optional); ctx.terminals off Windows
packages/pty-host     ctx.terminals    Windows only: a detached pty host (node-pty over ConPTY) in herdr's shapes
packages/code-sessions —                the Terminal window: terminals (ctx.terminals) and code sessions side by side, with live status
packages/files        ctx.files        the project's files beside its backlog: a versioned folder tree, backends, sync and conflicts, the versions tickets pin
packages/files-github —                GitHub as where a project's files are shared
packages/notes        ctx.notes        the files read as notes: wiki links, backlinks, tags, ranked full-text search, links kept on rename
packages/schedules    ctx.schedules    routines: tickets from a template or a prompt to the assistant, on a cadence
packages/agent        ctx.agent        the platform: threads, runs, ledger, cards, workflows, run undo, registries
packages/engine-loop  —                the hybrid conversational conductor
packages/shell        —                a bash tool for in-process engines, asked before each command, never served over MCP
packages/web-search   ctx.webSearch    web_search and web_fetch for every engine, answered by a registered provider
packages/web-search-tavily —           Tavily as that provider, with the person's own API key
packages/engine-scripted —             the no-model conductor: runs registered workflows from a menu
packages/engine-kit —                  what every local-agent engine shares: CLI locating and spawning, JSON lines, runtime pool, prompts, MCP link
packages/engine-claude-code —          Claude Code as conductor (headless, MCP run bindings); engine-codex and engine-pi likewise
packages/engine-acp ctx.localAgents   one conductor for agents that speak ACP, and the registry of the agents official plugins describe (tomrade-plugins)
packages/archify      —                Archify diagrams (architecture, workflow, sequence, data flow, lifecycle) as tools
packages/doctor       ctx.doctor       the troubleshooter: checks what failed, says what to do, sends a report the person has read
packages/agent-backlog —               the backlog method: playbooks, dossier, find_similar, plan_and_apply, dedup policy
packages/mcp          ctx.mcp          projects ctx.tools onto MCP (127.0.0.1)
packages/mcp-client   ctx.mcpClient    external MCP servers (stdio or HTTP) whose tools join ctx.tools
packages/im           ctx.im           IM transports over the agent: bindings, authorized inputs, reliable replies (adapters are plugins)
packages/inbox        ctx.inbox        a project's inbox: feedback waits here until triaged into tickets
packages/inbox-github —                GitHub issues as an inbox source; inbox-tomrade (in-app feedback) and inbox-triage (the worker model's proposal) beside it
packages/ipc          ctx.ipc          the typed channel contract; the shell supplies the Electron transport
packages/contributions ctx.contributions  declarative UI contributions
packages/desktop-surface —                host contract for plugin-owned auxiliary windows; alerts (notifications, sounds) beside it
packages/pet          ctx.pet          the task-state companion, in the panel or on the desktop
packages/keybindings  —                the person's rebound shortcuts
packages/onboarding   ctx.onboarding   the first run's tour project and seen-hints; announcements (shown once per machine) beside it
packages/plugins      ctx.plugins      loads the composition, and manages it: state per row, modules, the guard on switching one off, installed extensions
packages/plugin-sdk   the extension contract: definePlugin, the async PluginContext, the manifest
packages/extensions   the host side of the contract: namespaces, attribution, callbacks held to time limits
packages/plugin-kit   packages, digests, signed attestations, the lock file, the static analyzer
packages/plugin-cli   tomrade-plugin: init, build, dev, test, check, pack — and the sandbox agent-written code runs in
packages/plugin-host  the Tomrade a plugin is tested against, kept out of the CLI so the CLI carries no Tomrade code
packages/plugin-studio ctx tools for an agent to write a plugin, which loads only at a build a person confirmed
packages/community    ctx.community    the store: browse, read before installing, install (digest-checked), update, revoke, report, publish
packages/testkit      boots a fresh in-memory context for tests
packages/ui           React UI (TanStack Router + Query, Tailwind v4, Radix); consumes contributions as data
apps/store-admin      the store's admin tool: reports, revocations, official signatures
design/               OpenDesign prototype — the visual authority for the UI
docs/                 plugin-api.md (the contract), design-system.md (tokens, invariants), releasing.md (installers, signing), testing.md (failure kinds, when to merge with failures)
```

### Data model

Each project's cache is its own SQLite file (`<dir>/projects/<id>/project.db`); the Hub's own file (`hub.db`) tracks which projects and repository checkouts this machine knows.

```
projects  ── boards ── views ── view_item_rank
              │  └─ repos (remote URL = identity; checkouts live in catalog.json)
              │
              └─ items (board_id, key_num, status, priority, parent_id, rank,
                        version, updated_by, human_locked)
                   ├─ item_labels ── labels
                   └─ item_relations   (blocks)
oplog     append-only, spans items/boards/views; each row stamped with device + device_seq, carries the fields it changed; feeds undo and the folder's log
plugin_migrations   one version counter per plugin namespace per file (project or hub); plugins declare their plugin_<id>_* tables (scope, project column, export)
```

Issues carry a human key (`TOM-142`) from the project's `key_prefix` and a per-project counter that never reuses a number. Epics are items with `kind: 'epic'`. Provenance (`human` / `ai` / `locked`) is derived from `updated_by` + `human_locked`, never stored.

### The write path

Every mutation of an item, board or view goes through `write()` in `@tomradex/write`: a synchronous `write/pre-commit` waterfall decides, the commit lands the rows and the oplog entry, and `write/committed` announces it. The guarantees — human lock, human-only purge, optimistic version — are three small policy plugins loaded by the `write-policy` row. Remove the row and the guarantees are gone; `packages/write/tests` proves it.

## Usage statistics and anonymity

The user-facing policy is [Data use and privacy](data-privacy.md)
([简体中文](data-privacy.zh-CN.md)); README and Settings link to these same
language variants. Operational details live in [analytics.md](analytics.md).

`packages/analytics` owns the feature registry, strict event schemas, timer,
local queue and uploader. The renderer sends predefined feature IDs/actions;
Electron supplies window focus, idle and lock/suspend signals. Timing pauses
after 60 seconds idle and excludes background time. No project content, text,
paths, code or account identifiers belong in the event schema. The receiver
rejects undeclared fields.

A local random secret derives the anonymous ID sent with events; the secret
never leaves `userData/analytics`. IDs rotate every 365 days or on reset.
Repeated events under one ID support activity/retention counts, without an
account mapping or a hardware fingerprint. Turning statistics off stops
collection/uploads, cancels retries, clears the queue and removes the secret.
Reset/off does not delete events already accepted by the cloud.

Batches normally flush every 15 minutes or at 200 queued events, and on exit.
The local queue is bounded to 7 days, 20,000 events or 20 MB. The cloud retains
180 days of daily rows containing anonymous IDs; event partitions are dropped
only when their entire month is older than 180 days. Feature/action totals
without IDs remain for 25 months. Cleanup requires the scheduled database job.
Analytics stays outside project storage, oplog and Hub synchronization.

Separate mainland/international endpoints and database scope guards keep detail
on its own side when deployed and configured. The internal dashboard combines
numeric aggregates only; it never transfers or joins identifiers across those
deployments. Regional routing, logging exclusions, backup expiry and the
mainland consent/default decision are deployment responsibilities, not a
consequence of building this repository. The current settings default is on.

## The MCP surface

`packages/mcp` serves every tool registered on `ctx.tools` over streamable HTTP on `127.0.0.1` (19090 for an installed app, 19091 for `pnpm dev`, `TOMRADE_MCP_PORT` to choose; a taken port falls back to a free one and the status bar says so). A per-project URL, `/mcp/<projectId>`, pins a client to one project; it is what "Connect repository to coding agents" writes into `.mcp.json`, `.codex/config.toml`, `.cursor/mcp.json` and `.gemini/settings.json`. The `whoami` tool says which instance and which data a client reached.

The tools are the same ones the in-app assistant gets: `list_items`, `get_item`, `create_item`, `update_item`, `change_status`, `delete_item`, `claim_ticket`, `link_code`, `note_progress`, `find_similar`, `find_gaps`, `plan_and_apply`, `search_files`, … plus whatever plugins add. Views are deliberately invisible to MCP. `delete_item` is the *reversible* delete; there is no purge tool, and the refusal lives in the write policy (`write-policy:human-only-purge`), not in the absence of a tool. The shell tool is never served over MCP.

AI writes are recorded as `ai:mcp` (or `ai:agent`, `ai:claude-code`, `ai:<plugin>`) in the oplog, carry the `baseVersion` the caller read — a write tool that omits it asserts the version it reads itself — and are rejected when the item is human-locked or the version is stale.

## Working on it

```
pnpm install
pnpm test                                # vitest over every package, against sources
pnpm build:backend                       # tsc -b: every plugin package and the shell, incrementally
pnpm dev                                 # builds the backend, then Vite + Electron
pnpm dump-config                         # boots the app headlessly and prints every module and every row's state
pnpm --filter @tomrade/desktop test:ui   # the UI harness (needs `pnpm dev:ui` up and the backend built)
pnpm --filter @tomrade/desktop test:plugins  # switches real rows on and off, against the shipped composition
pnpm --filter @tomrade/desktop test:extensions   # an extension from outside the app, installed and reloaded in the real shell
pnpm --filter @tomrade/desktop test:plugins-ui   # the Plugins pane, Plugin Studio's review dialog, both languages (needs the dev server)
pnpm --filter @tomrade/desktop test:language-pack  # a data-only language pack loaded from a folder, chosen in Settings → Language (needs the dev server)
pnpm --filter @tomrade/desktop test:local-cli    # finding Claude Code and Codex, choosing a CLI path, Start's way to Settings (needs the dev server)
pnpm --filter @tomrade/desktop test:github-signin  # signing in to GitHub from a destination against a stand-in GitHub, token fallback, both languages (needs the dev server)
pnpm --filter @tomrade/desktop package           # installers (DMG/ZIP, NSIS, AppImage); -- --dir for an unpacked app
```

`pnpm test` ends by sorting its failures into `timeout-under-load`, `network` and `real`. [`testing.md`](testing.md) says what each means, what to check before blaming load, and when a pull request may merge with failures.

The backend is one TypeScript build graph: every emitting package is `composite` and lists its workspace dependencies as `references`, and the root `tsconfig.json` references them all, so `tsc -b` rebuilds only what changed. `pnpm dev` runs it before launching Electron; the runtime boot itself loads every plugin in well under a second.

Packages compile with `moduleResolution: "Bundler"`: cordis 4's declaration files use extensionless relative imports, which `NodeNext` refuses to resolve. Relative imports in our own sources keep their `.js` extension so the emitted ESM runs unbundled under Electron and Node.

`electron . --patch my.yml` overlays rows by id — the same overlay the UI harness applies in code (`boot({ patches })`) to run MCP on a free port. A user-level `<userData>/tomrade.patch.yml` is applied automatically, which is how a plugin is installed without touching the app; it is also where the Plugins sheet writes a switch, edited in place so hand-written rows and comments survive.

## History

A reboot of an earlier Tomrade, an enterprise-style design (Supabase + FastAPI + TanStack Start) that is not part of this repository. The second reshaping moved the in-process backend from a barrel of classes onto a cordis context, so that the parts a third party would want to add — tools, tables, settings, channels, UI contributions — are added by plugins rather than by editing first-party files.

