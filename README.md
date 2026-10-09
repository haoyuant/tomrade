# Tomrade Next

**Tomrade** ("Tom" + "comrade") — a local-first backlog + knowledge workbench for solo devs and tiny teams, and a partner for your coding agents.

Talk to the agent → it shapes the requirement with you → plans epics and **features sized for one PR** → writes the whole tree in one revertible run. Tomrade tracks what exists (dedup) and what's missing (gaps), and protects human work as the highest priority. Claude Code / Codex / Cursor agents read and write Tomrade over **MCP** — or take the conductor's seat themselves.

## Product decisions (direction of record)

1. **Local-first desktop.** Electron shell + React UI + in-process TypeScript backend. Each project is a folder — a text artifact — that is the truth; SQLite is a per-project **cache** of it (+FTS5), one file per project, that can be deleted and rebuilt. Configured cloud builds use Supabase for accounts and portable Hub metadata, with an offline outbox; project storage remains local-first. See [`docs/supabase-hub.md`](docs/supabase-hub.md).
2. **Full-stack TypeScript.** One language, one process, one set of types. Zod schemas shared by UI / backend / MCP tool definitions.
3. **Human work is sacred.** Field-level `updated_by: human|ai` + optimistic version check + `human_locked` fields + **undo stack**. AI never silently overwrites human edits, and a caller that supplies `baseVersion` is refused when stale *whoever it is*. No approval gates, no changesets — AI writes apply immediately but are always reversible and always carry provenance. The one write undo cannot reach is a **permanent delete**, and it is human-only.
4. **Everything is a plugin on a cordis context.** The database, the oplog, the repositories, the write policy, the tool registry, the LLM provider, the MCP server, the IPC channels and the UI's plugin contributions are each a plugin; every one but the write policy claims one key (`ctx.db`, `ctx.items`, `ctx.tools`, …), and the policy only listens. `apps/desktop/tomrade.yml` is the application: one row per plugin, replaceable by id. A plugin from outside the app — Community, a file, a folder, or one an agent wrote in Plugin Studio — is written against `@tomrade/plugin-sdk` and loaded behind an async, attributed, namespaced facade — see [`docs/plugin-api.md`](docs/plugin-api.md) and [`examples/stale`](examples/stale).
5. **One agent platform, pluggable conductors.** `ctx.agent` owns what every conductor needs — threads, runs, the per-run ledger, cards, suspended workflows, run-scoped undo — and holds no opinion about what to do next. **Engines** decide that, and are plugins: `engine-loop` (a conversation model over the tool registry, guided by playbooks), `engine-scripted` (menu-driven, no model, offline), `engine-claude-code` / `engine-codex` (the user's own CLI agents, tools over MCP). Deterministic multi-step jobs are **workflows** — typed, resumable step machines exposed as tools to every engine; invariants are **policies** on `tools/pre-execute` (an agent create without a duplicate check is refused, whoever conducts). `ctx.llm` stays the model seam: profiles (DeepSeek/Anthropic/OpenAI-compatible/local) with `conversation` and `worker` roles.
6. **One tool registry, every surface.** A tool registered on `ctx.tools` appears in the in-app assistant's prompt and on the MCP server at once. There is no per-surface code.
7. **MCP server is a first-class interface.** VS Code coding agents list/read/write/search tickets over MCP (`@modelcontextprotocol/sdk`, TS). This is the product's open API.
8. **Data shaped for future sync.** UUID PKs, `updated_at` + `updated_by` + `version` per row, an append-only **oplog** whose rows are stamped with the machine that wrote them (`device`/`device_seq` name one op everywhere) and carry the fields they changed (`patch_json`). It feeds undo today and the project folder's write-through log always. A permanent delete is the single exception: it removes the purged item's own rows and leaves a tombstone.
9. **Boards are workstreams; views are slices.** A project holds any number of **boards**, and a board is the container an issue belongs to. A **view** is a saved slice of one board. Dragging a card writes the grouped field and never the board. See [`docs/design-system.md`](docs/design-system.md).

## Explicitly NOT doing

- No approval gates: an agent run applies immediately, and **one click reverts the whole run** (oplog rows carry the `run_id`). No changesets / three-way merge / field provenance tables.
- No event sourcing / reactive reaction model. Plain transactional writes; policy is a synchronous waterfall in front of the commit.
- No orchestration graphs and no per-message intent router: one engine conducts a thread; composition happens through workflows-as-tools.
- No code evaluation in configuration. `tomrade.yml` is static YAML with `${userData}`-style substitution and nothing more.
- No profile or bundle layering. One file plus one patch file, merged by id.
- No renderer plugin bundles. Plugins contribute data — commands, badges, status items, sections, settings cards — and the UI draws it with its own primitives.
- No LangGraph, no LangChain, no separate vector DB. No cloud project database or Realtime project collaboration. Supabase Auth/Postgres is limited to Hub metadata. No Docker runtime requirement. No SSR web.

## Repo layout

```
apps/desktop          Electron shell: boots the context from tomrade.yml, supplies the IPC transport, opens the window
apps/desktop/tomrade.yml   the application — the modules it needs, then one row per plugin

packages/domain       types + zod schemas + typed errors. Zero I/O, zero ctx. Everyone imports this.
packages/db           ctx.db           a pool of SQLite caches — hub.db plus one project.db per project; core schema, plugin table registry
packages/hub          ctx.hub          this machine: device id, and the catalog of projects and repository checkouts it knows
packages/hub-cloud    ctx.cloudHub     Supabase accounts and Hub metadata; encrypted sessions, durable outbox and conflicts (when configured)
packages/oplog        ctx.oplog        append, read, undo — per project, each row stamped with the machine that wrote it
packages/write        —                write/pre-commit waterfall + the default policy plugins
packages/items        ctx.items        issues, labels, relations (+ their tools and channels)
packages/boards       ctx.boards, ctx.views
packages/projects     ctx.projects
packages/tools        ctx.tools        one registry, guarded execute
packages/llm          ctx.llm          model profiles + roles; chat-with-tools + structured JSON; OpenAI-compatible & Anthropic adapters
packages/settings     ctx.settings     file-backed; sections registered by zod schema
packages/storage      ctx.storage      the project folder as the truth: text artifact, write-through log, publish/refresh/merge, the Hub's catalog
packages/storage-git  —                any git URL as a remote for a project's own repository
packages/storage-github —              GitHub: repository discovery and creation on top of storage-git
packages/repos        ctx.repos        the code repositories workstreams stand for; this machine's checkouts; agent worktrees
packages/files        ctx.files        the project's files beside its backlog: a versioned folder tree, backends, sync and conflicts, the versions tickets pin
packages/files-github —                GitHub as where a project's files are shared
packages/agent        ctx.agent        the platform: threads, runs, ledger, cards, workflows, run undo, registries
packages/engine-loop  —                the hybrid conversational conductor
packages/engine-scripted —             the no-model conductor: runs registered workflows from a menu
packages/engine-claude-code —          Claude Code as conductor (headless, MCP run bindings); engine-codex likewise
packages/agent-backlog —               the backlog method: playbooks, dossier, find_similar, plan_and_apply, dedup policy
packages/mcp          ctx.mcp          projects ctx.tools onto MCP (127.0.0.1)
packages/mcp-client   ctx.mcpClient    external MCP servers (stdio or HTTP) whose tools join ctx.tools
packages/ipc          ctx.ipc          the typed channel contract; the shell supplies the Electron transport
packages/contributions ctx.contributions  declarative UI contributions
packages/plugins      ctx.plugins      loads the composition, and manages it: state per row, modules, the guard on switching one off, installed extensions
packages/plugin-sdk   the extension contract: definePlugin, the async PluginContext, the manifest
packages/extensions   the host side of the contract: namespaces, attribution, callbacks held to time limits
packages/plugin-kit   packages, digests, signed attestations, the lock file, the static analyzer
packages/plugin-cli   tomrade-plugin: init, build, dev, test, check, pack — and the sandbox agent-written code runs in
packages/plugin-studio ctx tools for an agent to write a plugin, which loads only at a build a person confirmed
packages/community    ctx.community    the store: browse, install (attestation-checked), update, revoke, report, publish
packages/testkit      boots a fresh in-memory context for tests
packages/ui           React UI (TanStack Router + Query, Tailwind v4, Radix); consumes contributions as data
examples/stale        an extension that edits no first-party file
apps/review           the store's review worker and admin tool
design/               OpenDesign prototype — the visual authority for the UI
docs/                 plugin-api.md (the contract), design-system.md (tokens, invariants)
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

Every mutation of an item, board or view goes through `write()` in `@tomrade/write`: a synchronous `write/pre-commit` waterfall decides, the commit lands the rows and the oplog entry, and `write/committed` announces it. The guarantees — human lock, human-only purge, optimistic version — are three small policy plugins loaded by the `write-policy` row. Remove the row and the guarantees are gone; `packages/write/tests` proves it.

## Connecting VS Code agents (MCP)

Run `pnpm dev`. The MCP server listens on `http://127.0.0.1:19090/mcp` (shown in the UI's status bar and settings).

```json
{
  "mcpServers": {
    "tomrade": {
      "type": "http",
      "url": "http://127.0.0.1:19090/mcp"
    }
  }
}
```

Every registered tool is exposed as `tomrade.<name>`: `list_boards`, `list_items`, `get_item`, `create_item`, `update_item`, `change_status`, `delete_item`, `extract_tickets`, `gap_analysis` — plus whatever plugins add (`stale_list_items` from the example). Views are deliberately invisible to MCP. `delete_item` is the *reversible* delete; there is no purge tool, and the refusal lives in the write policy, not in the absence of a tool.

AI writes are recorded as `ai:mcp` (or `ai:agent`, `ai:claude-code`, `ai:<plugin>`) in the oplog, carry the `baseVersion` the caller read — a write tool that omits it asserts the version it reads itself — and are rejected when the item is human-locked or the version is stale.

## Working on it

```
pnpm install
pnpm test                                # vitest over every package and the example, against sources
pnpm build:backend                       # tsc -b: every plugin package, the example and the shell, incrementally
pnpm dev                                 # builds the backend, then Vite + Electron
pnpm dump-config                         # boots the app headlessly and prints every module and every row's state
pnpm --filter @tomrade/desktop test:ui   # the UI harness (needs `pnpm dev:ui` up and the backend built)
pnpm --filter @tomrade/desktop test:plugins  # switches real rows on and off, against the shipped composition
pnpm --filter @tomrade/desktop test:extensions   # an extension from outside the app, installed and reloaded in the real shell
pnpm --filter @tomrade/desktop test:plugins-ui   # the Plugins pane, Plugin Studio's review dialog, both languages (needs the dev server)
pnpm --filter @tomrade/desktop package           # installers (DMG/ZIP, NSIS, AppImage); -- --dir for an unpacked app
```

The backend is one TypeScript build graph: every emitting package is `composite` and lists its workspace dependencies as `references`, and the root `tsconfig.json` references them all, so `tsc -b` rebuilds only what changed. `pnpm dev` runs it before launching Electron; the runtime boot itself loads every plugin in well under a second.

Packages compile with `moduleResolution: "Bundler"`: cordis 4's declaration files use extensionless relative imports, which `NodeNext` refuses to resolve. Relative imports in our own sources keep their `.js` extension so the emitted ESM runs unbundled under Electron and Node.

`electron . --patch my.yml` overlays rows by id — the same overlay the UI harness applies in code (`boot({ patches })`) to run MCP on a free port. A user-level `<userData>/tomrade.patch.yml` is applied automatically, which is how a plugin is installed without touching the app; it is also where the Plugins sheet writes a switch, edited in place so hand-written rows and comments survive.

## History

Reboot of `tomrade` (legacy enterprise-style design: Supabase + FastAPI + TanStack Start; archived at tag `legacy-architecture-final`). The second reshaping moved the in-process backend from a barrel of classes onto a cordis context, so that the parts a third party would want to add — tools, tables, settings, channels, UI contributions — are added by plugins rather than by editing first-party files.
