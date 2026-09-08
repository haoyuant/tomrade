# Plugin API

Tomrade is a [cordis](https://github.com/cordiverse/cordis) application. The
desktop shell creates one `Context`, reads `apps/desktop/tomrade.yml`, and loads
one plugin per row. Everything else — the database, the write path, the tool
registry, the MCP server, the IPC channels the renderer calls — is a plugin
that claims a key on that context. Third-party plugins use the same mechanism
with the same rights.

This document is the contract. `packages/plugin-sdk` is the import; the example
in `examples/stale` is the documentation that compiles.

## Stability

- `cordis` is pinned to `4.0.0-rc.8`. The framework is a release candidate and
  says so; so does `@tomrade/plugin-sdk`, which is `0.x`. Expect breaking
  changes between minor versions until both are `1.0`.
- What this file describes is what we promise. Anything reachable but not
  written here — table shapes, private methods, event argument internals — may
  change without notice.

## Trust model

Plugins run in the main process with the same rights as Tomrade itself:
`better-sqlite3`, the filesystem, the network, and the user's API key. **This is
not a sandbox.** What the system does guarantee:

- A plugin sees only the services it names in `inject`; `ctx.foo` without
  `foo` in `inject` throws.
- Every write a plugin makes is attributed. Pass `by: "ai:<plugin-id>"` and it
  is recorded in the oplog, refused on human-locked fields, and undoable like
  any agent write. Only `"human"` may purge.
- Every tool call passes `tools/pre-execute`, where a policy plugin can refuse it.
- Every registration is an effect: unload the plugin and its tools, channels,
  listeners, badges and settings cards go with it.

## A plugin

```ts
import { z } from "zod";
import { definePlugin, defineTool } from "@tomrade/plugin-sdk";

export default definePlugin({
  name: "hello",
  inject: ["items", "tools"],
  apply(ctx) {
    ctx.tools.register(
      defineTool({
        name: "count_items",
        title: "Count items",
        description: "How many issues the project holds.",
        input: z.object({ projectId: z.string().optional() }),
        execute: ({ projectId }, inv) => ctx.items.list({ projectId: projectId ?? inv.projectId }).length
      })
    );
  }
});
```

A plugin is a function `(ctx, config)`, a class whose constructor takes
`(ctx, config)`, or an object with `apply(ctx, config)`. `inject` lists the
services it needs; it loads when all of them are active and unloads when one
goes away. `Config` may be a zod schema; the row's `config` is validated
against it before `apply` runs.

Optional dependencies are nested contexts:

```ts
ctx.inject(["contributions"], (ctx) => {
  ctx.contributions.statusItem({ id: "hello", text: () => "hello" });
});
```

The callback runs when `contributions` appears and is unwound when it disappears.

### Loading it

Add a row to `tomrade.yml`, or to `<userData>/tomrade.patch.yml`, which is
merged by `id` and can add rows the app does not ship:

```yaml
plugins:
  - id: hello
    name: /absolute/path/to/hello/dist/index.js
    config: {}
```

One TypeScript rule, because it costs an afternoon the first time: **import
`cordis` before any `@tomrade/*` package, in the file that reaches it first.**
A `declare module "cordis"` inside a package loaded before cordis itself
*declares a new module* rather than augmenting the real one, and every later
file then sees a `Context` with no `inject`, `plugin` or `get`. Alphabetical
file order decides who is first, so a bare `import type {} from "cordis";` at
the top of a barrel or a channels file is the cheap insurance.

`name` is a package name or a path relative to the file it appears in.
`disabled: true` skips a row. `electron . --dump-config` prints every row with
its state — `active`, `failed` with the error, `pending` with the services it is
still waiting for, or `disabled` — alongside what it provides and needs.

The same list is the Plugins sheet in the app (⌘K → Plugins, or Settings →
Manage plugins), where a row can be switched on or off without a restart. See
[Modules](#modules) for the one switch it will not throw.

## Services

A **spine** service has one implementation and is assumed. A **seam** is
expected to be swapped: provide the same key from your own plugin and every
consumer follows.

| Key | Kind | Package | Owns |
|---|---|---|---|
| `ctx.db` | spine | `@tomrade/db` | The pool of SQLite caches — one per project plus the Hub's — the core schema, `migrate()` |
| `ctx.hub` | spine | `@tomrade/hub` | This machine: its device id, the Hub folder, the catalog of projects and repository checkouts it knows |
| `ctx.oplog` | spine | `@tomrade/oplog` | `append`, `recent`, `historyFor`, `undoLast` |
| `ctx.items` | spine | `@tomrade/items` | Issues, labels, relations, custom values; `query()` runs a view query in SQL |
| `ctx.fields` | spine | `@tomrade/fields` | The field registry: built-in definitions plus each project's custom fields and their options |
| `ctx.boards`, `ctx.views` | spine | `@tomrade/boards` | Workstreams (the options of the built-in Workstream field) and the project's saved views |
| `ctx.projects` | spine | `@tomrade/projects` | The container; outside the oplog and undo |
| `ctx.tools` | spine | `@tomrade/tools` | The registry and guarded `execute` |
| `ctx.contributions` | spine | `@tomrade/contributions` | Commands, badges, status items, detail sections, board graphs |
| `ctx.ipc` | spine | `@tomrade/ipc` (contract), `apps/desktop/src/ipc.ts` (Electron) | Typed channels to the renderer |
| `ctx.settings` | seam | `@tomrade/settings` | A JSON file today; sections registered by schema |
| `ctx.storage` | spine registry | `@tomrade/storage` | The project folder as the truth: the text artifact, the write-through log, publish/refresh/merge, remote providers, the Hub's catalog |
| `ctx.repos` | spine | `@tomrade/repos` | The code repositories workstreams stand for; this machine's checkouts; the worktrees agents run in |
| `ctx.llm` | seam | `@tomrade/llm` | Model profiles + roles: `for('conversation'|'worker').chat(...)` and `completeJson(schema, request)` |
| `ctx.agent` | spine registry | `@tomrade/agent` | The agent platform: threads, runs, the ledger, run-scoped undo; registries for engines, workflows, playbooks and policies |
| `ctx.mcp` | — | `@tomrade/mcp` | Projects `ctx.tools` onto MCP |
| `ctx.plugins` | — | `@tomrade/plugins` | The composition itself: what is loaded, what it provides, and which modules may not be emptied |

Reserved, not yet declared or provided: `ctx.search` (FTS5, later a vector
column), `ctx.sync`. A plugin may provide either today; until a first-party
declaration lands it augments `Context` with the key itself. (The old
`ctx.agentExecutor` reservation is fulfilled: a CLI agent is an **engine** —
see below.)

### Providing a seam

```ts
import { Service, type Context, type LLMProvider } from "@tomrade/plugin-sdk";

class Anthropic extends Service implements LLMProvider {
  static provide = "llm";
  constructor(ctx: Context) { super(ctx, "llm"); }
  async completeJson(schema, request) { /* ... */ }
}
```

Replace the `llm` row's `name` in `tomrade.yml` and the assistant never notices.

## Modules

A **module** is a capability, named by the service key that carries it. The
composition declares them above its rows:

```yaml
modules:
  - id: db
    title: Database
    required: true
  - id: llm
    title: Language model
```

Which plugin fills a module is never declared. `ctx.plugins` reads it off the
running context — cordis records the fiber that provided each service, so a row
is credited with what the plugins *it* loads provide, and `@tomrade/boards`
correctly answers for both `boards` and `views` from one row.

**A required module may not be left empty.** `ctx.plugins.setEnabled(id, false)`
refuses when `id` is the only plugin providing one, and refuses again — putting
the row back — if unloading it cascaded into emptying one. A module that was
already unfilled before the switch is not held against it.

Because a service key has exactly one owner, a required module's provider
cannot be replaced by switching a second one on beside it. Swapping one is a
change of `name` on its row.

| Call | Does |
|---|---|
| `ctx.plugins.list()` | Every row: state, error, what it waits for, what it provides, what it injects, and the required modules it alone holds up |
| `ctx.plugins.modules()` | Every module, whether it is required, and which plugins fill it |
| `ctx.plugins.setEnabled(id, on)` | Load or unload a row now, and write the choice to `<userData>/tomrade.patch.yml` |
| `ctx.plugins.snapshot()` | Both lists at once — what `--dump-config` prints and what the renderer draws |

`ctx.plugins` is not a row. It is what reads the composition and loads it, so
there is no switch that turns off the switching; the renderer reaches it over
`plugins.list` and `plugins.setEnabled`, and hears `plugins.changed`.

Switching a row off is an ordinary cordis unload: its tools, channels, badges,
settings cards and listeners go with it, and so does anything that injected
what it provided. Nothing here makes a plugin safe — `write-policy` provides no
service, holds no module, and is therefore switchable, which is the same thing
the contract says about removing its row by hand.

## The agent

`ctx.agent` is the platform every conductor runs on. It owns the threads, the
runs, the per-run ledger, cards (durable thread state such as the requirement
dossier), suspended workflows, and run-scoped undo (`oplog.undoRun`); it holds
no opinion about what to do next. Four registrations extend it, all effects:

```ts
// An ENGINE takes turns: it reads the thread, emits blocks, calls tools.
ctx.agent.engine({
  id: "acme", title: "Acme", author: "ai:acme",
  available: async () => ({ ok: true }),
  async turn(input, io) {
    const items = await io.tools.execute("list_items", { status: "backlog" });
    io.emit({ type: "text", text: `${(items as unknown[]).length} in the backlog.` });
    return { stop: "end" };
  }
});

// A WORKFLOW is a typed, resumable step machine, exposed to every engine as a
// tool named by its id. Control flow is code; a step that returns `ask`
// suspends — the platform persists the state and feeds the user's next
// on-script answer back into the same step.
ctx.agent.workflow({
  id: "release_wizard", title: "Release wizard", description: "…",
  input: z.object({}), state: z.object({ version: z.string() }), entry: "ask",
  steps: {
    ask: (state, io, answer) =>
      answer === undefined
        ? { ask: { text: "Which version?", freeText: true }, state }
        : { done: { version: String(answer) } }
  }
});

// A PLAYBOOK is methodology for model-driven engines: the `when` line lives in
// every prompt, the body loads on demand (open_playbook). Three sources carry
// them — plugins (this call, or SKILL.md files the plugin ships and reads with
// loadPlaybookDir), the user's <userData>/playbooks/<name>/SKILL.md folders,
// and a project's .tomrade/playbooks/ in its shared copy. The same id from
// several sources is a conflict, not an error: the most specific wins
// (project > user > plugin) until the user records a choice in
// settings.agent.playbookChoices — the workspace offers that choice in a toast,
// and the Assistant settings pane keeps a picker per conflicted id.
ctx.agent.playbook({ id: "acme.review", title: "Review", when: "the user asks for a review", body: "…" });

// A POLICY is an invariant in code: it runs on tools/pre-execute for calls that
// belong to an agent run and can read the run's ledger and waivers. Throw to
// refuse — the message reaches the model, which self-corrects.
ctx.agent.policy({
  id: "one-doc-per-run",
  before: (call, next) => (call.name === "write_doc" && call.run.ledger.find((e) => e.tool === "write_doc") ? Promise.reject(new Error("one document per run")) : next())
});
```

Engines emit **blocks** — text, trace, question, card, status, changes, note —
and the panel draws them with the design system's own primitives; a
third-party engine ships no UI code. While a workflow is suspended, on-script
input resumes it deterministically; off-script input goes to the engine, which
holds `resume_workflow` / `cancel_workflow`. Every tool call an engine makes is
run-bound: the oplog rows it produces carry the `run_id`, which is what makes
"Changed 15 items · Revert" one click. A CLI agent (Claude Code, Codex) is an
engine like any other: it gets the tools over MCP with a per-run token
(`ctx.mcp.bindRun`), so the ledger, the policies and the revert apply to it
unchanged. A binding may also carry `event(payload)`: whatever is POSTed to
`/sessions/<token>/event` on the MCP server — a coding agent's hooks reporting
it started, stopped or is waiting — reaches the binding that owns the token.

An engine declares **capabilities**: `backlog` (the default) talks to the app
through its tools; `code` also edits files and runs commands in a repository.
Only a local coding agent (Claude Code, Codex) declares `code`, and only such
an engine is offered when a ticket is started — the in-app loop never
implements a ticket. A thread started from a ticket carries `itemId` and
`branch`; its turns arrive with `purpose: "code"` and a `ticket`, run in a
worktree on that branch (`Repos.workdirFor` with the branch), and get the code
wall clock (`AgentConfig.codeMaxWallMs`, hours) instead of the backlog one. The
platform emits `agent/run-started` and `agent/run-ended` for whoever follows
runs; `ctx.agent.activeRuns()` is what a quit would interrupt.

## Events

Events are the policy layer. `emit` announces; `waterfall` decides — a listener
receives `(...args, next)` and either calls `next()` to delegate or throws to
refuse. Listeners on `write/pre-commit` must be synchronous: the commit runs
inside a SQLite transaction.

| Event | Mode | Purpose |
|---|---|---|
| `write/pre-commit` | waterfall | Refuse or allow a mutation before it lands. `WriteIntent` carries `entity`, `op`, `id`, `by`, `baseVersion`, `before`, `after`, `patch`. |
| `write/committed` | emit | A durable fact: the rows and the oplog entry exist. |
| `tools/pre-execute` | waterfall | Refuse or allow a tool call, first-party or plugin, whoever invokes it. `ToolCall.run` is present when it belongs to an agent run. |
| `tools/result` | emit | The outcome of a tool call, success or failure. |
| `settings/changed` | emit | Settings were saved; providers re-read. |

The rule everything else rests on: **every mutation of an item, board or view
passes `write/pre-commit` and lands an oplog row.** `@tomrade/write` enforces the
default policy — human lock, human-only purge, optimistic version — as three
plugins. Remove the row and the guarantees are gone, which is what
`packages/write/tests` proves. A repository method that skips `write()` is a
bug; the helper asserts that a listener either refused or delegated.

Exceptions, deliberately: projects are managed by humans through the UI and sit
outside the oplog, and so are field *definitions* — schema, not work — while the
*values* they hold ride on `items.update` like any other patch key. Everything
else is logged: `views.setRank` lands a `rank` row (one item's manual position
in one view, undoable, kept apart so history reads as decisions rather than
drags), `boards.moveItems` is one `items.update` per issue, and
`items.addRelation` / `removeRelation` are `blocks` patches. A patch that would
close a dependency cycle is refused with `DependencyCycleError`.

Every oplog row carries the machine that wrote it (`device`) and its position in
that machine's own sequence (`deviceSeq`), so `device:deviceSeq` names one op
everywhere, and `patch` — the fields the op changed — which is what the
project folder's log carries. Undo reaches only this machine's own rows; a row
that arrived from another machine's log is history and evidence, and taking it
back is a new write of ours.

## Tools

```ts
ctx.tools.register(defineTool({ name, title, description, input: z.object({...}), execute(args, invocation) }));
```

Names are global and unique. `execute` receives validated `args` and
`{ by, projectId, run? }`; use `inv.by` as the author of any write,
`inv.projectId` as the default scope, and `inv.run` (present inside an agent
run) for the ledger and run-scoped state. A registered tool appears on every
surface at once: engines see it via `io.tools.describe()`, and each MCP
session registers it under its own name — the server name is the namespace.
There is no per-surface code to write.

## Views

A **view** is a saved way of looking at a project's backlog: a name, an icon,
a **layout** — `board`, `table` or `graph` — and a `ViewQuery`: `filter`
clauses, `columnBy` (the field a board's columns stand for), `groupBy`
(swimlanes on a board, sections in a table), `sortBy` (empty means the manual
order kept in `view_item_rank`), the `fields` shown, `wip` caps and, for a
graph, the contributed `graph`. Views belong to the project; `ctx.views`
creates, updates, reorders and removes them through `write()`, and a project
always keeps at least one. Agents do not see views — they query fields.

**Workstreams** are the options of the built-in `board` field: `ctx.boards`
manages them, every issue carries exactly one (`items.board_id`), and a
workstream that still holds issues, or is the project's last, refuses to go.
Agents reach them through `list_workstreams`, `create_workstream`,
`update_workstream` and `remove_workstream` (which takes a `moveTo` for the
issues a doomed workstream still holds); the renderer offers the same in the
sidebar's Workstreams group and the Fields sheet.

A workstream may **stand for a code repository**: `Board.repoId` names a row of
`ctx.repos` (shared with the project — the remote URL is its identity) and
`Board.repoPath` a folder inside it. Where that repository is checked out is
this machine's alone (`ctx.repos.setCheckout(remote, dir)`, verified against the
folder's origin, or `ctx.repos.clone(remote, branch)` into `<Hub>/repos/`). A
thread on such a workstream runs its engine in a detached worktree of the
checkout under `<Hub>/worktrees/`, or in the checkout itself when the user
chose that, and refuses to start while no checkout is named. Tomrade never
pushes a code repository. Agents see `list_repos`; `TurnInput.cwd` is where a
code-running engine works.

## Fields

Every attribute a view can filter, sort or group by is a **field**. Built-in
fields (`title`, `status`, `priority`, `epic`, `labels`, `board`, `updated`,
`key`, `provenance`) are columns on `items` and the same in every project; a
project may add its own — `text`, `number`, `date` or `select` — and their
values live in `item_values`, one sparse row per (item, field), numbers in
`num` and everything else in `text`, so a sort or range filter on any field is
one indexed column. A select stores the option id and sorts by option order.

```ts
const points = ctx.fields.create({ projectId, name: "Story points", type: "number" });
ctx.items.update(id, { fields: { [points.id]: 5 } }, "ai:hello");   // typed, versioned, logged, undoable
ctx.items.update(id, { fields: { [points.id]: null } }, "ai:hello"); // null clears; absent keys are left alone
ctx.items.query({ projectId, filter: [{ field: points.id, op: "gte", values: [5] }], sortBy: [{ field: "priority", dir: "asc" }] });
```

`ctx.fields.list(projectId)` returns built-ins then custom definitions;
`create`, `update`, `remove`, `addOption`, `updateOption` and `removeOption`
change them live — removing a field or an option takes the values holding it
(or moves them, with `moveTo`). A value that does not fit its field is refused
with `FieldValueError` before the write path sees it; built-in ids are refused
in `fields` because they have their own patch keys.

`items.query` takes the same `FilterClause[]` / `SortKey[]` a view stores. A
clause is `{ field, op: "in" | "not-in" | "contains" | "gte" | "lte", values }`,
and a `null` value means empty; empties sort last whichever direction. The
renderer evaluates the same shapes over its cached list with the pure functions
in `@tomrade/domain` (`matchesFilter`, `compareItems`), and a parity test in
`packages/items` keeps the two implementations agreeing. Agents reach all of it
through `list_fields`, `create_field`, `list_items` (`filter` / `sort`) and
`update_item` (`patch.fields`).

## Storage

`ctx.db` is a pool, not a connection. Every project has its own SQLite file
under `<userData>/cache/projects/<id>/project.db`, and the Hub has one for
hub-level plugin tables. Both are **caches**: the truth is the text in the
project's folder (see Destinations), and any file here can be deleted and
rebuilt. A repository resolves a handle per call and never keeps it:

```ts
ctx.db.for(projectId).prepare("SELECT …").all();   // a project's file; throws ProjectNotOpenError
ctx.db.hub.prepare("SELECT …").all();              // hub.db
ctx.db.openIds();                                   // the projects open on this machine
```

Every method that takes an entity id takes the **project id first** —
`items.get(projectId, id)`, `views.setRank(projectId, viewId, itemId, rank)`,
`oplog.undoLast(projectId)` — and so does every renderer channel. A tool
resolves its project with `requireProjectId(name, args.projectId, inv)`, which
refuses a call that names none and points at `list_projects`; there is no
default project to fall back to.

```ts
ctx.db.migrate("hello", [
  { version: 1, up: "CREATE TABLE IF NOT EXISTS plugin_hello_notes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT)" },
  { version: 2, up: (db) => db.exec("ALTER TABLE plugin_hello_notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0") }
], {
  tables: {
    plugin_hello_notes: { project: "project_id", export: { order: "id" } }
  }
});
```

`migrate` is a **registration**, applied to every open project file now and to
each one opened later (create, attach, rebuild); it returns a disposer, and the
registration goes with the plugin, though nothing drops a table. Each file keeps
its own `plugin_migrations` counter. SQL migrations may only create, alter or
drop tables named `plugin_<namespace>_*`, **and every table they create must be
declared** in `tables` — the registry refuses a namespace that does not say:

- `project` — how a table's rows belong to a project: a column, or a chain
  through another table (`{ via: "thread_id", table: "plugin_hello_threads" }`).
  Project deletion, the legacy split and the export all use it.
- `export` — where the durable copy goes. `{ order, appendOnly? }` puts the
  table in the project's folder as `.tomrade/plugins/<ns>/<table>.jsonl`, so it
  travels with the project and merges (append-only tables by union, others by
  row); `false` means machine-local working state, gone when the cache is rebuilt.
- `scope: "hub"` (on the call) for tables that belong to no project: they live in
  `hub.db`, need no `project`, and export to the Hub folder's `plugins/`.

Pure configuration is never a table — register a settings section. A file that
arrives with a higher version of your namespace than this build knows is opened
with your tables marked unhealthy (`ctx.db.healthy(ns, projectId)`) rather than
refused; a file carrying tables of a plugin this machine lacks carries them on
unchanged.

## Destinations

Every project is a **folder the user can see** — by default
`<Hub>/projects/<slug>/` under the Hub folder (`~/Tomrade`) chosen on first
run — holding `.tomrade/`: `project.json` (identity, schema version, a digest of
the state files and a `checkpoint` of each machine's furthest op), `state/` (one
`<table>.jsonl` per core table, sorted by id), `log/<device>.jsonl` (each
machine's own change log, append-only, written through on every commit, compacted
to a window), `plugins/<ns>/<table>.jsonl` (plugin tables the project exports),
`docs/` (the user's), a `.gitattributes` that lets git keep both sides of a
line clash (`merge=union`), and a `README.md` for whoever finds the folder.

**The folder is the truth and the cache follows it.** A write lands in the cache
and in the log at once; the snapshot is rewritten after a quiet period, each
file through a temporary name and the manifest last, so a reader never sees a
manifest describing files that are not there yet. A folder changed by anyone
else (a pull, a sync tool, a hand edit) is read back in: taken whole when the
cache is clean, **merged** when both moved. The merge is a pure function
(`mergeStates` in `@tomrade/storage`): a row changed on one side only is taken,
a row changed on both merges field by field, the same field changed on both is
settled by the logs — later `at` wins, tie by device id, silence falls to the
folder — and every contested field leaves a `merge` row in the oplog by
`ai:sync`, with the losing value in `before`, which undo steps over. A row
deleted on one side and edited on the other keeps the edit. Issue keys minted
on both sides are renumbered on the side that never published them.

Who drives git in the folder depends on where it is (`ctx.storage.info(id).git`):

| Origin | Means | Tomrade does |
|---|---|---|
| `none` | A plain folder — of its own, or in Dropbox | Writes files; a sync tool moves them |
| `dedicated` | A repository Tomrade made for the project alone (`project.json.repo`) | Commits, fetches, merges with a merge commit, pushes — never forces |
| `shared` | Inside the user's own code checkout | Writes `.tomrade/` only; optionally commits that subtree; `fetch` for status; **never push, pull, checkout or reset** |

A **provider** is a remote transport for a dedicated repository: it turns a
non-secret config into a git remote, and may find or create one. It never sees
SQLite and never touches a folder.

```ts
ctx.storage.register(createRemoteProvider({
  id: "acme-git",
  title: "Acme Git",
  configSchema: z.object({ project: z.string() }),
  defaults: { project: "" },
  toRemote: (c) => ({ url: `https://git.acme.dev/${c.project}.git`, branch: "main" }),
  async ensureRemote(c) { /* create it */ },
  async browse() { return [{ label: "acme/app", config: { project: "acme/app" } }]; }
}));
```

`register` is an effect. `configSchema` is rendered from `z.toJSONSchema()` so a
provider ships no UI code; a `format: "password"` field is **refused at
registration** — credentials belong in a `ctx.settings` section named in
`settingsSection`, collected inline through `connection` where the remote is
chosen. `browse()` and `draft(name)` remove typing. `@tomrade/storage-git`
registers `git` (any URL); `@tomrade/storage-github` adds discovery and
creation on top.

| Call | Does |
|---|---|
| `ctx.storage.info(projectId)` | Folder, origin, remote, what travels |
| `ctx.storage.statusFor(projectId)` | `local` / `synced` / `ahead` / `behind` / `diverged` / `syncing` / `offline` / `error` / `unavailable` |
| `ctx.storage.publish(projectId)` | Snapshot now; commit and push a dedicated repository |
| `ctx.storage.refresh(projectId)` | Take the folder's (or remote's) changes: import or merge |
| `ctx.storage.sync(projectId)` | `refresh`, then `publish` |
| `ctx.storage.setFolder(projectId, dir)` | Move the project to another folder; the old one is left alone |
| `ctx.storage.setExports(projectId, ns[])` | Which plugin namespaces travel (shared through the manifest) |
| `ctx.storage.bind(projectId, providerId, config)` | Give a dedicated repository a remote; refused for a shared checkout |
| `ctx.storage.attach(dir)` / `attachRemote(providerId, config)` | Open a folder, or clone a published project into the Hub |
| `ctx.storage.rebuild(projectId)` | Drop the cache and read the folder again, history included |

Events: `storage/registered`, `storage/unregistered`, `storage/synced`,
`storage/imported`; the renderer hears `storage.changed(projectId)`.
`ctx.storage.artifactDirFor(projectId)` names `<dir>/.tomrade` for whatever
reads what travels beside the state (playbooks, docs).

## Settings

```ts
ctx.settings.register({
  id: "hello",
  title: "Hello",
  description: "Shown under the card title.",
  schema: z.object({ greeting: z.string() }),
  defaults: { greeting: "hi" }
});
const { greeting } = ctx.settings.get().hello as { greeting: string };
```

`get()` returns every registered section with defaults filled in; `set()`
validates each registered section against its schema and persists the file.
The settings dialog draws a card for every section it does not lay out by hand,
from the schema's JSON Schema: strings, numbers, booleans and enums; a string
with `format: "password"` is masked.

A section has a **scope**. `machine` (the default) stays in
`<userData>/settings.json`: credentials, paths, binaries. `user` follows the
person: it is also written to `<Hub>/settings.json` with a timestamp per
section, travels with the Hub, and a clash between two machines is settled by
the later stamp. A section whose schema holds a password is `machine` whatever
it declares.

## Contributions

Declarative only. A plugin contributes data and the renderer draws it with the
design system's own primitives — no bundling, no CSP work, on-design by
construction.

```ts
ctx.contributions.command({ id: "hello.say", title: "Say hello", group: "Hello", run: ({ itemId }) => ({ toast: `hello ${itemId}` }) });
ctx.contributions.badge({ id: "hello", compute: (items) => ({ [items[0]?.id]: [{ id: "hi", label: "hi", tone: "strong" }] }) });
ctx.contributions.statusItem({ id: "hello", text: ({ projectId }) => "hello" });
ctx.contributions.section({ id: "hello", title: "Hello", render: (item) => ({ rows: [{ label: "Key", value: item.key }] }) });
ctx.contributions.graph({ id: "hello", title: "Hello", icon: "i-graph", compute: (items) => items.flatMap((i) => (i.parentId ? [{ from: i.parentId, to: i.id }] : [])) });
```

Commands appear in the palette under their group and run in the main process
with the current `{ projectId, boardId, viewId, itemId }`. Badges are computed
on every board refresh over the project's items. Status items render in the
status bar; sections in the detail pane and the issue sheet. Registering or
unregistering any of them broadcasts `contributions.changed`, and the renderer
refetches. A section row may carry `href` — its value opens that link in the
browser — or `command`, the id of a palette command the value runs with the
item in scope; still declarative, still drawn by the renderer.

A **graph** is what a view with the Graph layout draws: the renderer puts the
same issue cards on an interactive canvas with the plugin's edges as arrows,
and the view's `query.graph` names which contributed graph. The plugin returns
item-id pairs (`{ from, to, tone?, title? }`) — no layout, no pixels; the view's
filter still applies, and edges whose ends are filtered out are not drawn. A graph that declares `edits: "blocks"` gets an editable canvas:
dragging between cards and deleting an arrow write `Item.blocks` patches
through the ordinary guarded path. `@tomrade/deps-graph` is the shipped
example — the Dependencies graph plus a `blocked` badge for issues waiting on
unfinished work.

## Channels

Plugins add renderer channels by augmenting the contract and registering a
handler when `ipc` is present:

```ts
declare module "@tomrade/ipc" {
  interface Channels {
    "hello.count": (projectId: string) => number;
  }
}
ctx.inject(["ipc"], (ctx) => {
  ctx.ipc.handle("hello.count", (projectId) => ctx.items.list({ projectId }).length);
});
```

The renderer calls `invoke("hello.count", projectId)` and gets the declared
return type. Every renderer write is a human write; channel handlers pass
`"human"` as the author.

## What is deliberately not here

- No orchestration graph and no per-message intent router. One engine conducts
  a thread; determinism lives in workflows and policies, judgment in the
  engine's model — and a CLI agent can be the engine.
- No code evaluation in configuration. `tomrade.yml` is static YAML with
  `${userData}`-style substitution and nothing more.
- No profile or bundle layering. One file, one patch file, merged by id.
- No renderer plugin bundles. Contributions are data.
