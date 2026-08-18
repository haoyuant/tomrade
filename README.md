# Tomrade Next

**Tomrade** ("Tom" + "comrade") — a local-first backlog + knowledge workbench for solo devs and tiny teams, and a partner for your coding agents.

Chat with an LLM → it extracts requirements → specs → epics → **features sized for one PR**. Tomrade tracks what exists (dedup) and what's missing (gaps), and protects human work as the highest priority. Claude Code / Codex / Cursor agents read and write Tomrade over **MCP**.

## Product decisions (direction of record)

1. **Local-first desktop.** Electron shell (start here) + React UI + in-process TypeScript backend. Data lives in **SQLite (+FTS5)**, on the user's machine. Cloud is a *future* migration, not today's constraint.
2. **Full-stack TypeScript.** One language, one process, one set of types. Zod schemas shared by UI / backend / MCP tool definitions.
3. **Human work is sacred.** Field-level `updated_by: human|ai` + optimistic version check + `human_locked` fields + **undo stack**. AI never silently overwrites human edits. No approval gates, no changesets — AI writes apply immediately but are always reversible and always carry provenance.
4. **Two seams, not one.**
   - `LLMProvider` — direct API calls (DeepSeek/Claude/OpenAI + zod validate-and-repair) for cheap structured work: extraction, dedup-judging, gap-checking, summaries.
   - `AgentExecutor` — delegate execution to the user's own CLI agents (`claude -p`, `codex exec`) so they bring their own skills, MCP servers, and CLAUDE.md. Tomrade plans and records; the CLI agent executes.
5. **MCP server is a first-class interface.** VS Code coding agents list/read/write/search tickets and documents over MCP (`@modelcontextprotocol/sdk`, TS). This is the product's open API.
6. **Data shaped for future sync.** UUID PKs, `updated_at` + `updated_by` + `version` per row, an append-only **oplog** (feeds undo today, sync later). Multi-user arrives as a sync layer (ElectricSQL/Zero class), *not* as an early database migration.
7. **Documents later.** Markdown notes/design docs with FTS5 search and doc↔ticket links. Semantic (vector) retrieval added only when keyword recall runs out — a vector column + top-k, not a framework.

## Explicitly NOT doing (lessons from the legacy repo)

- No enterprise write path: no changesets / approval gates / three-way merge / field provenance tables.
- No event sourcing / reactive reaction model. Plain transactional writes + cascade recompute.
- No LangGraph, no LangChain, no RAPTOR, no RRF hybrid retrieval, no separate vector DB.
- No Supabase / RLS / Realtime / Auth in v1. No Docker. No Postgres *yet*.
- No multi-device sync *yet*. No CRDTs. No SSR web (TanStack Start dropped; Vite SPA + TanStack Query/Router).

## Repo layout

```
apps/desktop    Electron shell (window, lifecycle, packaging)
packages/core   In-process backend: LLMProvider, AgentExecutor, write path, SQLite repository
packages/mcp    MCP server (stdio/localhost) exposing Tomrade to coding agents
packages/ui     React UI (TanStack Query/Router)
```

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

Tools: `tomrade.list_items`, `tomrade.get_item`, `tomrade.create_item`, `tomrade.update_item` (optimistic-lock + human_locked protection), `tomrade.change_status`, `tomrade.delete_item`.

AI writes are always recorded as `ai:mcp` in the oplog, require `baseVersion` you read, and are rejected when the item is human-locked or the version is stale — human work is never silently overwritten.

## History

Reboot of `tomrade` (legacy enterprise-style design: Supabase + FastAPI + TanStack Start; archived at tag `legacy-architecture-final`). New design driven by: local-first + MCP + TypeScript-fullstack + human-work protection without enterprise ceremony.