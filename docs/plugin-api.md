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
| `ctx.db` | spine | `@tomrade/db` | The SQLite connection, the core schema, `migrate()` |
| `ctx.oplog` | spine | `@tomrade/oplog` | `append`, `recent`, `historyFor`, `undoLast` |
| `ctx.items` | spine | `@tomrade/items` | Issues, labels, relations |
| `ctx.boards`, `ctx.views` | spine | `@tomrade/boards` | Workstreams and their slices |
| `ctx.projects` | spine | `@tomrade/projects` | The container; outside the oplog and undo |
| `ctx.tools` | spine | `@tomrade/tools` | The registry and guarded `execute` |
| `ctx.contributions` | spine | `@tomrade/contributions` | Commands, badges, status items, detail sections |
| `ctx.ipc` | spine | `@tomrade/ipc` (contract), `apps/desktop/src/ipc.ts` (Electron) | Typed channels to the renderer |
| `ctx.settings` | seam | `@tomrade/settings` | A JSON file today; sections registered by schema |
| `ctx.storage` | spine registry | `@tomrade/storage` | Where a project's shareable copy lives: providers, the text artifact, flush/refresh |
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
// every prompt, the body loads on demand (open_playbook). SKILL.md files in
// <userData>/playbooks/<name>/ register the same way, editable without a plugin.
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
unchanged.

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
outside the oplog; `views.setRank`, `items.addRelation` and `boards.moveItems`
are not logged today.

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

## Storage

```ts
ctx.db.migrate("hello", [
  { version: 1, up: "CREATE TABLE IF NOT EXISTS plugin_hello_notes (id TEXT PRIMARY KEY, body TEXT)" },
  { version: 2, up: (db) => db.exec("ALTER TABLE plugin_hello_notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0") }
]);
```

Each namespace keeps its own version counter in `plugin_migrations`. SQL
migrations may only create, alter or drop tables named `plugin_<namespace>_*`;
the registry refuses anything else. Read and write your tables through
`ctx.db.prepare()`; write core tables only through their services, so the
policy and the oplog see it.

## Destinations

A project's live SQLite file always sits in `<userData>`. What the user chooses
is where its *shareable copy* goes, and that copy is **text**: a `.tomrade/`
folder holding `project.json`, one `state/<table>.jsonl` per core table sorted
by id, and a `.gitignore` that keeps a database out. The serialisation is
deterministic, so an unchanged project produces no diff and no commit.

A **provider** moves that folder and nothing else. It never sees SQLite.

```ts
ctx.storage.register({
  id: "acme-drive",
  title: "Acme Drive",
  configSchema: z.object({ folder: z.string().meta({ format: "directory" }) }),
  defaults: { folder: "" },
  // Resolve the destination from the config ALONE — an attach must open it
  // before it can read which project is inside.
  async open(config, { create }) {
    return {
      location: config.folder,
      dir: config.folder,
      pull: async () => ({ changed: false }),
      push: async (message) => {},
      status: async () => ({ state: "synced", location: config.folder }),
      dispose: async () => {}
    };
  }
});
```

`register` is an effect: the provider, and its option in every project's
settings, goes when the plugin unloads. `configSchema` is rendered by the
renderer from `z.toJSONSchema()`, so a provider ships no UI code — and a
`format: "password"` field in it is **refused at registration**, because a
per-project config is committed alongside the code. Credentials belong in a
`ctx.settings` section the provider registers, named in `settingsSection`.

A destination that needs an account declares a `connection`, and the renderer
collects it **where it is used** — in the project's own destination block —
rather than in a settings card the user has to go and find first:

```ts
connection: {
  prompt: { label: "Personal access token", help: "…", url: "https://…/tokens/new" },
  status: () => Promise<{ connected: boolean; label?: string; detail?: string }>,
  connect: (secret: string) => Promise<{ connected: boolean; label?: string }>,
  disconnect: () => Promise<void>
}
```

The secret is still the provider's to keep, in its own `ctx.settings` section,
because one account serves every project and none of it may reach a config that
gets committed. But a section a storage provider claims through
`settingsSection` is **not drawn again** by the settings dialog — the connection
block is where it lives. Verify before storing: a credential that does not work
should never be saved.

Two more optional capabilities remove typing. `browse()` lists what the account
already has as ready-made configs, and `draft(name)` builds a whole config from
a name alone, for a destination that does not exist yet. A provider offering
both means the user picks from a list or types one name — never four fields.

The states a project can be in are decided by content, not by trust: the
artifact's own digest is compared with the one last published, so `ahead`,
`behind` and `diverged` read the same whether a change arrived by git, by
rsync or by hand. `flush` refuses to overwrite a destination that has moved,
`refresh` refuses to discard local work that has not been published, and
neither ever deletes a copy holding writes the other side lacks.

| Call | Does |
|---|---|
| `ctx.storage.bind(projectId, providerId, config)` | Point a project at a destination and publish it there |
| `ctx.storage.unbind(projectId)` | Forget the destination. Nothing there is deleted |
| `ctx.storage.flush(projectId)` | Publish. Skips entirely when the bytes would be identical |
| `ctx.storage.refresh(projectId)` | Take the destination's copy, when local is clean |
| `ctx.storage.sync(projectId)` | `refresh`, then `flush` |
| `ctx.storage.attach(providerId, config)` | Bring in a project this machine does not know; returns its id |
| `ctx.storage.statusFor(projectId)` | `local` / `synced` / `ahead` / `behind` / `diverged` / `offline` / `error` / `unavailable`. Contacts the remote, so poll it sparingly |

An **unbound project is a local project**: there is no `local` provider to keep
in step, and `statusFor` answers `local`. Events are `storage/registered`,
`storage/unregistered`, `storage/synced` and `storage/imported`; the renderer
hears `storage.changed(projectId)` and refetches everything keyed by it.

`@tomrade/storage-git` adds git as a mechanism — a clone under `<userData>`,
fast-forward-only pulls, commits of *only* its own subtree so it is safe inside
the user's own checkout, and a push that is reported rather than forced when it
would not fast-forward. `@tomrade/storage-github` adds only what git cannot do
alone: find a repository and make one. A hosting provider for GitLab or Gitea is
`createGitProvider` plus a REST client, in a row of its own.

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

## Contributions

Declarative only. A plugin contributes data and the renderer draws it with the
design system's own primitives — no bundling, no CSP work, on-design by
construction.

```ts
ctx.contributions.command({ id: "hello.say", title: "Say hello", group: "Hello", run: ({ itemId }) => ({ toast: `hello ${itemId}` }) });
ctx.contributions.badge({ id: "hello", compute: (items) => ({ [items[0]?.id]: [{ id: "hi", label: "hi", tone: "strong" }] }) });
ctx.contributions.statusItem({ id: "hello", text: ({ projectId }) => "hello" });
ctx.contributions.section({ id: "hello", title: "Hello", render: (item) => ({ rows: [{ label: "Key", value: item.key }] }) });
```

Commands appear in the palette under their group and run in the main process
with the current `{ projectId, boardId, viewId, itemId }`. Badges are computed
on every board refresh over the project's items. Status items render in the
status bar; sections in the detail pane and the issue sheet. Registering or
unregistering any of them broadcasts `contributions.changed`, and the renderer
refetches.

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
