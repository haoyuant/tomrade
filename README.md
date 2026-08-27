# Tomrade Next

**Tomrade** ("Tom" + "comrade") — a local-first backlog + knowledge workbench for solo devs and tiny teams, and a partner for your coding agents.

Chat with an LLM → it extracts requirements → specs → epics → **features sized for one PR**. Tomrade tracks what exists (dedup) and what's missing (gaps), and protects human work as the highest priority. Claude Code / Codex / Cursor agents read and write Tomrade over **MCP**.

## Product decisions (direction of record)

1. **Local-first desktop.** Electron shell (start here) + React UI + in-process TypeScript backend. Data lives in **SQLite (+FTS5)**, on the user's machine. Cloud is a *future* migration, not today's constraint.
2. **Full-stack TypeScript.** One language, one process, one set of types. Zod schemas shared by UI / backend / MCP tool definitions.
3. **Human work is sacred.** Field-level `updated_by: human|ai` + optimistic version check + `human_locked` fields + **undo stack**. AI never silently overwrites human edits, and a caller that supplies `baseVersion` is refused when stale *whoever it is* — so a human drag that races an agent write surfaces a conflict instead of blind-writing over it. No approval gates, no changesets — AI writes apply immediately but are always reversible and always carry provenance. The one write undo cannot reach is a **permanent delete**, and it is human-only: agents keep the reversible `delete`, the repository refuses `purge` to any other author, and the UI asks first.
4. **Two seams, not one.**
   - `LLMProvider` — direct API calls (DeepSeek/Claude/OpenAI + zod validate-and-repair) for cheap structured work: extraction, dedup-judging, gap-checking, summaries.
   - `AgentExecutor` — delegate execution to the user's own CLI agents (`claude -p`, `codex exec`) so they bring their own skills, MCP servers, and CLAUDE.md. Tomrade plans and records; the CLI agent executes.
5. **MCP server is a first-class interface.** VS Code coding agents list/read/write/search tickets and documents over MCP (`@modelcontextprotocol/sdk`, TS). This is the product's open API.
6. **Data shaped for future sync.** UUID PKs, `updated_at` + `updated_by` + `version` per row, an append-only **oplog** (feeds undo today, sync later). The single exception is a permanent delete, which removes the purged item's own rows and leaves a tombstone — and a tombstone is what a sync layer will have to replicate, since a peer that never saw the purge would otherwise re-send the deleted history and resurrect the issue. Multi-user arrives as a sync layer (ElectricSQL/Zero class), *not* as an early database migration.
7. **Documents later.** Markdown notes/design docs with FTS5 search and doc↔ticket links. Semantic (vector) retrieval added only when keyword recall runs out — a vector column + top-k, not a framework.
8. **Boards are workstreams; views are slices.** A project holds any number of **boards**, and a board is the container an issue actually belongs to (`items.board_id`). A **view** is a saved slice of one board — grouping, visible columns, filter, WIP caps. Dragging a card writes the grouped field and never the board. A board flagged `across` owns nothing and borrows every issue in the project. See [`docs/design-system.md`](docs/design-system.md).

## Explicitly NOT doing (lessons from the legacy repo)

- No enterprise write path: no changesets / approval gates / three-way merge / field provenance tables.
- No event sourcing / reactive reaction model. Plain transactional writes + cascade recompute.
- No LangGraph, no LangChain, no RAPTOR, no RRF hybrid retrieval, no separate vector DB.
- No Supabase / RLS / Realtime / Auth in v1. No Docker. No Postgres *yet*.
- No multi-device sync *yet*. No CRDTs. No SSR web (TanStack Start dropped; Vite SPA + TanStack Router/Query).

## Repo layout

```
apps/desktop    Electron shell (window, lifecycle, IPC surface, packaging)
packages/core   In-process backend: LLMProvider, write path, SQLite repositories, migrations
packages/mcp    MCP server (streamable HTTP on localhost) exposing Tomrade to coding agents
packages/ui     React UI (TanStack Router + Query, Tailwind v4, Radix primitives)
design/         OpenDesign prototype — the visual authority for the UI
docs/           design-system.md: tokens, invariants, divergences
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
          (a permanent delete is the one write that removes rows, leaving a tombstone)
```

Issues carry a human key (`TOM-142`) from the project's `key_prefix` and a
per-project counter that never reuses a number. Epics are items with
`kind: 'epic'`; a ticket's `parent_id` is its epic. Provenance
(`human` / `ai` / `locked`) is derived from `updated_by` + `human_locked`, never stored.

`packages/core` migrates in place: a database written by the pre-boards build
gains the new tables and columns, and every existing item is backfilled onto a
seeded **All work** board with a key assigned oldest-first.

## Connecting VS Code agents (MCP)

Run `pnpm dev` (Tomrade desktop). The MCP server listens on `http://127.0.0.1:19090/mcp` (shown in the UI banner).

To let Claude Code / Cline / VS Code MCP clients read and write your backlog, add to your MCP config (e.g. `.mcp.json` in the project, or the client's global MCP config):

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

Tools: `tomrade.list_boards`, `tomrade.list_items` (filter by board, status, kind, priority, label or parent), `tomrade.get_item`, `tomrade.create_item`, `tomrade.update_item` (optimistic-lock + human_locked protection), `tomrade.change_status`, `tomrade.delete_item`.

Views are deliberately invisible to MCP: an agent scopes a query to a workstream,
so the tool contract never grows a second concept. `tomrade.delete_item` is the
*reversible* delete; there is deliberately no purge tool, so no agent can make a
write a human cannot undo — and the refusal lives in the repository, not just in
the absence of a tool.

AI writes are always recorded as `ai:mcp` in the oplog, require `baseVersion` you read, and are rejected when the item is human-locked or the version is stale — human work is never silently overwritten.

## Verifying the UI

```
pnpm dev:ui                              # dev server on 127.0.0.1:5173
pnpm --filter @tomrade/desktop build     # the harness drives dist/, not src/
pnpm --filter @tomrade/desktop test:ui   # 120 checks + screenshots per screen and theme
```

The harness drives the real UI against real repositories over a throwaway
database seeded with the prototype's sample project, and writes screenshots to
`apps/desktop/scripts/shots/`.

## History

Reboot of `tomrade` (legacy enterprise-style design: Supabase + FastAPI + TanStack Start; archived at tag `legacy-architecture-final`). New design driven by: local-first + MCP + TypeScript-fullstack + human-work protection without enterprise ceremony.