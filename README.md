# Tomrade Next

**Tomrade** ("Tom" + "comrade") — a local-first backlog + knowledge workbench for solo devs and tiny teams, and a partner for your coding agents.

Chat with an LLM → it extracts requirements → specs → epics → **features sized for one PR**. Tomrade tracks what exists (dedup) and what's missing (gaps), and protects human work as the highest priority. Claude Code / Codex / Cursor agents read and write Tomrade over **MCP**.

## Product decisions (direction of record)

1. **Local-first desktop.** Electron shell + React UI + in-process TypeScript backend. Data lives in **SQLite (+FTS5)**, on the user's machine. Cloud is a *future* migration, not today's constraint.
2. **Full-stack TypeScript.** One language, one process, one set of types. Zod schemas shared by UI / backend / MCP tool definitions.
3. **Human work is sacred.** Field-level `updated_by: human|ai` + optimistic version check + `human_locked` fields + **undo stack**. AI never silently overwrites human edits, and a caller that supplies `baseVersion` is refused when stale *whoever it is*. No approval gates, no changesets — AI writes apply immediately but are always reversible and always carry provenance. The one write undo cannot reach is a **permanent delete**, and it is human-only.
4. **Everything is a plugin on a cordis context.** The database, the oplog, the repositories, the write policy, the tool registry, the LLM provider, the MCP server, the IPC channels and the UI's plugin contributions are each a plugin; every one but the write policy claims one key (`ctx.db`, `ctx.items`, `ctx.tools`, …), and the policy only listens. `apps/desktop/tomrade.yml` is the application: one row per plugin, replaceable by id. A third-party plugin uses the same mechanism with the same rights — see [`docs/plugin-api.md`](docs/plugin-api.md) and [`examples/stale`](examples/stale).
5. **Two seams, not one.**
   - `ctx.llm` — direct API calls (DeepSeek/Claude/OpenAI + zod validate-and-repair) for cheap structured work: extraction, dedup-judging, gap-checking.
   - `ctx.agentExecutor` — delegate execution to the user's own CLI agents (`claude -p`, `codex exec`). Reserved, not yet provided: Tomrade plans and records; the CLI agent executes.
6. **One tool registry, every surface.** A tool registered on `ctx.tools` appears in the in-app assistant's prompt and on the MCP server at once. There is no per-surface code.
7. **MCP server is a first-class interface.** VS Code coding agents list/read/write/search tickets over MCP (`@modelcontextprotocol/sdk`, TS). This is the product's open API.
8. **Data shaped for future sync.** UUID PKs, `updated_at` + `updated_by` + `version` per row, an append-only **oplog** (feeds undo today, sync later). A permanent delete is the single exception: it removes the purged item's own rows and leaves a tombstone.
9. **Boards are workstreams; views are slices.** A project holds any number of **boards**, and a board is the container an issue belongs to. A **view** is a saved slice of one board. Dragging a card writes the grouped field and never the board. See [`docs/design-system.md`](docs/design-system.md).

## Explicitly NOT doing

- No enterprise write path: no changesets / approval gates / three-way merge / field provenance tables.
- No event sourcing / reactive reaction model. Plain transactional writes; policy is a synchronous waterfall in front of the commit.
- No agent loop, turn driver, compaction, sandboxes or subagents. The `agentExecutor` seam is the whole answer.
- No code evaluation in configuration. `tomrade.yml` is static YAML with `${userData}`-style substitution and nothing more.
- No profile or bundle layering. One file plus one patch file, merged by id.
- No renderer plugin bundles. Plugins contribute data — commands, badges, status items, sections, settings cards — and the UI draws it with its own primitives.
- No LangGraph, no LangChain, no separate vector DB. No Supabase / RLS / Realtime / Auth. No Docker. No Postgres *yet*. No multi-device sync *yet*. No SSR web.

## Repo layout

```
apps/desktop          Electron shell: boots the context from tomrade.yml, supplies the IPC transport, opens the window
apps/desktop/tomrade.yml   the application — the modules it needs, then one row per plugin

packages/domain       types + zod schemas + typed errors. Zero I/O, zero ctx. Everyone imports this.
packages/db           ctx.db           SQLite connection, core schema, plugin migration registry
packages/oplog        ctx.oplog        append, read, undo
packages/write        —                write/pre-commit waterfall + the default policy plugins
packages/items        ctx.items        issues, labels, relations (+ their tools and channels)
packages/boards       ctx.boards, ctx.views
packages/projects     ctx.projects
packages/tools        ctx.tools        one registry, guarded execute
packages/llm          ctx.llm          the LLM seam (OpenAI-compatible by default, FakeLlm for tests)
packages/settings     ctx.settings     file-backed; sections registered by zod schema
packages/assistant    ctx.assistant    chat routing over ctx.tools; extract / dedup / gap workflows
packages/mcp          ctx.mcp          projects ctx.tools onto MCP (127.0.0.1)
packages/ipc          ctx.ipc          the typed channel contract; the shell supplies the Electron transport
packages/contributions ctx.contributions  declarative UI contributions
packages/plugins      ctx.plugins      loads the composition, and manages it: state per row, modules, the guard on switching one off
packages/plugin-sdk   the public plugin API in one import
packages/testkit      boots a fresh in-memory context for tests
packages/ui           React UI (TanStack Router + Query, Tailwind v4, Radix); consumes contributions as data
examples/stale        a third-party plugin that edits no first-party file
design/               OpenDesign prototype — the visual authority for the UI
docs/                 plugin-api.md (the contract), design-system.md (tokens, invariants)
```

### Data model

```
projects  ── boards ── views ── view_item_rank
              │
              └─ items (board_id, key_num, status, priority, parent_id, rank,
                        version, updated_by, human_locked)
                   ├─ item_labels ── labels
                   └─ item_relations   (blocks)
oplog     append-only, spans items/boards/views; feeds undo today, sync later
plugin_migrations   one version counter per plugin namespace; plugins own plugin_<id>_* tables
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

Every registered tool is exposed as `tomrade.<name>`: `list_boards`, `list_items`, `get_item`, `create_item`, `update_item`, `change_status`, `delete_item`, `extract_tickets`, `gap_analysis` — plus whatever plugins add (`list_stale_items` from the example). Views are deliberately invisible to MCP. `delete_item` is the *reversible* delete; there is no purge tool, and the refusal lives in the write policy, not in the absence of a tool.

AI writes are recorded as `ai:mcp` (or `ai:assistant`, `ai:<plugin>`) in the oplog, carry the `baseVersion` the caller read — a write tool that omits it asserts the version it reads itself — and are rejected when the item is human-locked or the version is stale.

## Working on it

```
pnpm install
pnpm test                                # vitest over every package and the example, against sources
pnpm build:backend                       # tsc -b: every plugin package, the example and the shell, incrementally
pnpm dev                                 # builds the backend, then Vite + Electron
pnpm dump-config                         # boots the app headlessly and prints every module and every row's state
pnpm --filter @tomrade/desktop test:ui   # the UI harness (needs `pnpm dev:ui` up and the backend built)
pnpm --filter @tomrade/desktop test:plugins  # switches real rows on and off, against the shipped composition
```

The backend is one TypeScript build graph: every emitting package is `composite` and lists its workspace dependencies as `references`, and the root `tsconfig.json` references them all, so `tsc -b` rebuilds only what changed. `pnpm dev` runs it before launching Electron; the runtime boot itself loads every plugin in well under a second.

Packages compile with `moduleResolution: "Bundler"`: cordis 4's declaration files use extensionless relative imports, which `NodeNext` refuses to resolve. Relative imports in our own sources keep their `.js` extension so the emitted ESM runs unbundled under Electron and Node.

`electron . --patch my.yml` overlays rows by id — the same overlay the UI harness applies in code (`boot({ patches })`) to run MCP on a free port. A user-level `<userData>/tomrade.patch.yml` is applied automatically, which is how a plugin is installed without touching the app; it is also where the Plugins sheet writes a switch, edited in place so hand-written rows and comments survive.

## History

Reboot of `tomrade` (legacy enterprise-style design: Supabase + FastAPI + TanStack Start; archived at tag `legacy-architecture-final`). The second reshaping moved the in-process backend from a barrel of classes onto a cordis context, so that the parts a third party would want to add — tools, tables, settings, channels, UI contributions — are added by plugins rather than by editing first-party files.
