# Plugin API

Tomrade is a [cordis](https://github.com/cordiverse/cordis) application. The
desktop shell creates one `Context`, reads `apps/desktop/tomrade.yml`, and loads
one plugin per row. Everything else — the database, the write path, the tool
registry, the MCP server, the IPC channels the renderer calls — is a plugin
that claims a key on that context.

There are two kinds of plugin, and this document is the contract for both:

- **Extensions** are written against `@tomradex/plugin-sdk`. Their `apply`
  receives a `PluginContext`: an async, attributed, namespaced view of the app
  that the host builds for them. Everything that comes from outside the app —
  Community, a `.tomrade-plugin` file, a folder, Plugin Studio — must be one.
  `tomrade-plugin init` scaffolds one that builds and passes its tests.
- **Built-in rows** are the app's own cordis plugins, listed in `tomrade.yml`.
  They take the raw `Context` and the services below it ([Services](#services)
  onward). A built-in may also be written with the SDK — `@tomradex/deps-graph`
  is — and is then loaded behind the same facade.

## Stability

- `cordis` is pinned to `4.0.0-rc.8`, and `@tomradex/plugin-sdk` is `0.2`. The
  SDK's contract version is `SDK_CONTRACT`; a plugin states the range it needs
  in `engines.sdk` and is refused, with the reason, by a Tomrade outside it.
  Until `1.0` a minor version may break.
- What this file describes is what we promise. Anything reachable but not
  written here — table shapes, private methods, event argument internals — may
  change without notice.

## Trust model

Plugins run in the main process with the same rights as Tomrade itself:
`better-sqlite3`, the filesystem, the network, and the user's API key. **This is
not a sandbox.** What the system does guarantee:

- An extension reaches the app only through its `PluginContext`: every call
  returns a Promise and every value that crosses is plain data, so the same
  plugin can later run behind a process boundary without changing.
- A service not named in `inject` or `optional` is refused.
- **The host says who wrote.** Writes through the facade take no author: they
  are the person's when a person drove the call (a palette command, a surface
  document's message), the agent run's when an agent's tool call made them, and
  `ai:<namespace>` otherwise. Every one carries `via: <namespace>` in the
  oplog, and `oplog.undoVia` takes back everything one extension wrote in a
  project. An extension that claims `"human"` outside a person's call is
  refused by the write policy, which also keeps purge out of its reach.
- **Everything it registers carries its namespace**: tools, commands, badges,
  status items, sections, graphs, settings sections, playbooks, surfaces, and
  `plugin_<namespace>_*` tables. Two extensions cannot share one.
- Every tool call passes `tools/pre-execute`, where a policy can refuse it.
- A render callback (badge, section, status item, graph) that throws or takes
  longer than two seconds costs only itself, never the refresh it is part of.
- Every registration is an effect: unload the plugin and its tools, channels,
  listeners, badges and settings cards go with it.
- `db` is the widest thing an extension can ask for: plain SQL over every table
  in the project caches. It is not scoped to the plugin's own tables; writing
  the app's tables goes around history and undo, and every install dialog
  says so.

## An extension

```ts
import { z } from "zod";
import { definePlugin, defineTool, requireProjectId } from "@tomradex/plugin-sdk";

export default definePlugin({
  inject: ["items", "tools", "contributions"],
  async apply(ctx) {
    await ctx.tools.register(
      defineTool({
        name: "hello_count",                      // starts with the namespace, "hello"
        title: "Count items",
        description: "How many issues the project holds.",
        input: z.object({ projectId: z.string().optional() }),
        execute: async ({ projectId }, inv) => (await ctx.items.list({ projectId: requireProjectId("hello_count", projectId, inv) })).length
      })
    );
    await ctx.contributions.statusItem({ id: "hello", text: async ({ projectId }) => (projectId ? `${(await ctx.items.list({ projectId })).length} issues` : null) });
  }
});
```

`optional` names services used when present: `ctx.has(name)` says whether one
is, and `ctx.when(name, (inner) => …)` runs while it is — what the callback
returns is disposed when the service goes.

### The context

| Member | What it offers |
|---|---|
| `items` | `list`, `query`, `get`, `getByKey`, `create`, `update`, `delete`, `addRelation`, `removeRelation`, `labels` |
| `fields` / `boards` / `views` / `projects` | the project's fields (and `create`/`update`/`remove`/`addOption`), workstreams, saved views, projects — read |
| `db` | `migrate(steps, { scope, tables })` for `plugin_<namespace>_*`; `all`, `get`, `run`, `batch` (one transaction) against a project id or `"hub"`; `isOpen` |
| `settings` | `register({ title, schema, defaults })` — the card is drawn from the schema — `get`, `set` |
| `tools` | `register(defineTool(…))`, `list`, `call`, `gate(check)` (throw to refuse any tool call) |
| `contributions` | `command`, `badge`, `statusItem`, `section`, `graph` — see [Contributions](#contributions); callbacks may be async |
| `agent` | `playbook({ id, title, when, body, tools })` |
| `surfaces` | `open({ id, document, … })` — a document inside the plugin's own package, never a remote page |
| `oplog` | `recent`, `history` |
| `on(event, fn)` | `write` (after commit: entity, op, id, by, via, runId), `tool.result`, `project.opened`, `project.closed`, `settings.changed` |
| `effect`, `interval` | cleanup and timers that end with the plugin |
| `id`, `namespace`, `dataDir`, `logger` | who it is, its prefix, a directory only it writes, its log |

## Packages

A plugin is a folder with `tomrade-plugin.json` beside its source:

```json
{
  "id": "alice/stale",
  "version": "1.2.0",
  "title": "Stale issues",
  "description": "Flags open issues nobody has written to in a while.",
  "license": "MIT",
  "repository": "https://github.com/alice/tomrade-plugin-stale",
  "engines": { "sdk": "^0.2.0" },
  "permissions": { "network": [], "fs": "none", "exec": false }
}
```

The namespace is `namespace`, or the name part of the id with dashes as
underscores. `permissions` declares what the code does beyond the SDK — hosts
it talks to (`*` for any), `fs` (`plugin`, `project`, `any`) and `exec`. It is
not enforced; it is checked against the code. Starting programs, disk anywhere
and any host are **high risk**: labelled everywhere a person decides, never
refused for that alone.

**Licenses.** The SDK, `@tomradex/domain`, `@tomradex/plugin-kit` and the CLI are
Apache-2.0, and a plugin may use any license, commercial ones included.
`tomrade-plugin test` loads the plugin into `@tomradex/plugin-host`, which is
Tomrade's own code and comes with the CLI under the repository's Business Source
License — testing a plugin with it is a permitted use.

`tomrade-plugin build` bundles `src/index.ts` into one readable ESM file,
`dist/index.js`, with every dependency inside it except the three the host
provides — `cordis`, `@tomradex/plugin-sdk` and `zod` — which the app resolves
to its own copies wherever the plugin lives. Documents for surfaces go in
`static/` and are copied beside it. The build stamps `inject`, `optional` and
`contributes` into the manifest from what the plugin was seen to do.

A `.tomrade-plugin` file is the package: a tarball of the manifest, `dist/`,
the README, the license and, for Tomrade's own plugins, `ATTESTATION.json` —
the store key's Ed25519 signature over the package's digest, its tier and its
risk. Installed
versions live in `~/Tomrade/plugins/<publisher>/<name>/<version>/`, each
plugin's data in `…/<name>/data/`, and `plugins.lock.json` records what is
installed, from where, at which digest.

**Every load checks the files.** A package whose files changed since install
still loads — it is on this person's machine — but it becomes their own copy:
tier *local*, no automatic updates. An update keeps the version before it, so
one that fails goes back.

| Tier | How it gets there |
|---|---|
| 官方 · Official | published by Tomrade, and signed with the store key |
| 社区 · Community | from the store: the publisher's own build of a public, open-source commit, reviewed by nobody |
| 本地 · Local | a file handed over by hand, or a package changed after install |
| 开发中 · In development | a folder loaded as it stands, or Plugin Studio |

## Writing one

With the agent: **Plugin Studio** (Settings → Manage plugins → My plugins, or
ask the assistant). `@tomradex/plugin-studio` gives every engine tools confined
to one workspace in `~/Tomrade/plugins-dev/<name>/` — `plugin_create`,
`plugin_reference`, `plugin_files`, `plugin_read`, `plugin_write`,
`plugin_build`, `plugin_test`, `plugin_check`, `plugin_try`, `plugin_status`,
`plugin_logs` — and the `studio.build-plugin` playbook. The agent's code runs
only in the sandbox until a person confirms an exact build: `plugin_try` stages
it, the app shows what changed since the last build they allowed and what it
can reach, and only their confirmation loads it. A new build needs a new
confirmation. The plugin's own tables are saved before each new build runs and
can be put back.

By hand: the `tomrade-plugin` CLI (`@tomradex/plugin-cli`).

```sh
tomrade-plugin init my-plugin --id alice/my-plugin   # a plugin that builds, tests and loads as it is
tomrade-plugin dev                                    # rebuild on change; Settings → Load folder, once
tomrade-plugin test                                   # src/test.ts against a throwaway project, sandboxed
tomrade-plugin check                                  # what someone installing it will see
tomrade-plugin pack                                   # a .tomrade-plugin anyone can install
```

**The sandbox** that `test`, `check` and Plugin Studio run code in is a child
process under Node's permission model: it reads only the plugin's folder and
the app's runtime, writes only a temporary directory, and cannot start programs
or workers. The Node that Electron 43 embeds does not close the network; the
system Node 26 does.

## The store

**Community** (`@tomradex/community`, the registry in `supabase/migrations`)
lists open-source plugins only, and reviews none of them: whoever installs a
plugin judges it. A publisher is a Tomrade account with a linked GitHub
identity; a plugin id starts with that login and its repository belongs to it.
Publishing renames a local plugin to the publisher (its namespace stays), runs
the check, then commits, tags and pushes the source to the public repository.
The check's build of that same tree is uploaded under the publisher's login,
and `tomrade_publish_plugin` lists it at once — after checking, on the server,
that the license is OSI-approved and the id, repository and package path are
the publisher's. Nothing proves the package was built from the commit; the
bundle is one readable file, and the listing links the commit.

Installing first reads the exact package on this machine — what it injects,
the hosts it names, and what the static analyzer sees it do — and refuses a
package whose digest is not the one the store lists. An update lands by itself
only when the person switched that on, it reaches no further than what is
installed, and it is no riskier; one of Tomrade's own (`official`, signed with
the store key in `apps/desktop/src/trust.ts`) only moves to another Tomrade
signed. Tomrade revokes what reports show to be malicious
(`apps/store-admin`), and revocations switch a plugin off at the next check
while online.

## Built-in rows

A built-in is a function `(ctx, config)`, a class whose constructor takes
`(ctx, config)`, or an object with `apply(ctx, config)`. `inject` lists the
services it needs; it loads when all of them are active and unloads when one
goes away. `Config` may be a zod schema; the row's `config` is validated
against it before `apply` runs. Optional dependencies are nested contexts:

```ts
ctx.inject(["contributions"], (ctx) => {
  ctx.contributions.statusItem({ id: "hello", text: () => "hello" });
});
```

### Loading it

Add a row to `tomrade.yml`, or to `<userData>/tomrade.patch.yml`, which is
merged by `id` and can add rows the app does not ship:

```yaml
plugins:
  - id: hello
    name: "@tomradex/hello"
    config: {}
```

One TypeScript rule, because it costs an afternoon the first time: **import
`cordis` before any `@tomradex/*` package, in the file that reaches it first.**
A `declare module "cordis"` inside a package loaded before cordis itself
*declares a new module* rather than augmenting the real one, and every later
file then sees a `Context` with no `inject`, `plugin` or `get`. Alphabetical
file order decides who is first, so a bare `import type {} from "cordis";` at
the top of a barrel or a channels file is the cheap insurance.

`name` is a package name or a path relative to the file it appears in.
`disabled: true` skips a row. `electron . --dump-config` prints every row with
its state — `active`, `failed` with the error, `pending` with the services it is
still waiting for, or `disabled` — alongside what it provides and needs.

The same list is the Plugins pane in the app (⌘K → Plugins, or Settings →
Manage plugins), where a row can be switched on or off without a restart. See
[Modules](#modules) for the one switch it will not throw.

## Services

A **spine** service has one implementation and is assumed. A **seam** is
expected to be swapped: provide the same key from your own plugin and every
consumer follows.

| Key | Kind | Package | Owns |
|---|---|---|---|
| `ctx.db` | spine | `@tomradex/db` | The pool of SQLite caches — one per project plus the Hub's — the core schema, `migrate()` |
| `ctx.hub` | spine | `@tomradex/hub` | This machine: its device id, the Hub folder, the catalog of projects and repository checkouts it knows |
| `ctx.oplog` | spine | `@tomradex/oplog` | `append`, `recent`, `historyFor`, `undoLast`; the timeline across providers: `undo`, `redo`, `timeline`, `rollback`, `revert`, `provide` |
| `ctx.items` | spine | `@tomradex/items` | Issues, labels, relations, custom values; `query()` runs a view query in SQL |
| `ctx.fields` | spine | `@tomradex/fields` | The field registry: built-in definitions plus each project's custom fields and their options |
| `ctx.boards`, `ctx.views` | spine | `@tomradex/boards` | Workstreams (the options of the built-in Workstream field) and the project's saved views |
| `ctx.projects` | spine | `@tomradex/projects` | The container; outside the oplog and undo |
| `ctx.tools` | spine | `@tomradex/tools` | The registry and guarded `execute` |
| `ctx.contributions` | spine | `@tomradex/contributions` | Commands, badges, status items, detail sections, board graphs, assistant accessories |
| `ctx.ipc` | spine | `@tomradex/ipc` (contract), `apps/desktop/src/ipc.ts` (Electron) | Typed channels to the renderer |
| `ctx.desktopSurfaces` | seam | `@tomradex/desktop-surface` (contract), desktop shell (Electron) | Transparent auxiliary-window mechanics for feature plugins |
| `ctx.settings` | seam | `@tomradex/settings` | A JSON file today; sections registered by schema |
| `ctx.storage` | spine registry | `@tomradex/storage` | The project folder as the truth: the text artifact, the write-through log, publish/refresh/merge, remote providers, the Hub's catalog |
| `ctx.repos` | spine | `@tomradex/repos` | The code repositories workstreams stand for; this machine's checkouts; the worktrees agents run in |
| `ctx.files` | optional registry | `@tomradex/files` | The project's files beside its backlog: a folder tree with versions, the backend registry, the remote a project shares through, sync and conflicts, the versioned references tickets pin |
| `ctx.llm` | seam | `@tomradex/llm` | Model profiles + roles: `for('conversation'|'worker').chat(...)` and `completeJson(schema, request)` |
| `ctx.agent` | spine registry | `@tomradex/agent` | The agent platform: threads, runs, the ledger, run-scoped undo; registries for engines, workflows, playbooks and policies |
| `ctx.pet` | optional feature | `@tomradex/pet` | Pet task-state reduction, settings, renderer state and its embedded/desktop lifecycle |
| `ctx.mcp` | — | `@tomradex/mcp` | Projects `ctx.tools` onto MCP |
| `ctx.plugins` | — | `@tomradex/plugins` | The composition itself: what is loaded, what it provides, and which modules may not be emptied |

Reserved, not yet declared or provided: `ctx.search` (FTS5, later a vector
column), `ctx.sync`. A plugin may provide either today; until a first-party
declaration lands it augments `Context` with the key itself. (The old
`ctx.agentExecutor` reservation is fulfilled: a CLI agent is an **engine** —
see below.)

### Providing a seam

```ts
import { Context, Service } from "cordis";
import type { LLMProvider } from "@tomradex/llm";

class Anthropic extends Service implements LLMProvider {
  static provide = "llm";
  constructor(ctx: Context) { super(ctx, "llm"); }
  async completeJson(schema, request) { /* ... */ }
}
```

Replace the `llm` row's `name` in `tomrade.yml` and the assistant never notices.

The shipped `completeJson` runs on the **worker** role, whichever engine holds the
conversation. Output that does not fit the schema gets one repair round with the
problem quoted back; if that still does not fit, the error names the worker
profile and the offending field. `completeJson(model, schema, request, label)` is
exported for a provider that wants the same behaviour over its own `ChatModel`.
Keep optional fields in a schema forgiving (`.catch(undefined)`), so a cosmetic
slip does not cost the whole document.

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
is credited with what the plugins *it* loads provide, and `@tomradex/boards`
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

// Optional frontmatter / registration metadata: workTypes (recommendations),
// requires (hard gates), optionalCapabilities, outputs. These are not tool
// permissions. Advertise only implemented capabilities and dispose on unload.
const releaseCapability = ctx.agent.capability("files.write");

// A POLICY is an invariant in code: it runs on tools/pre-execute for calls that
// belong to an agent run and can read the run's ledger and waivers. Throw to
// refuse — the message reaches the model, which self-corrects.
ctx.agent.policy({
  id: "one-doc-per-run",
  before: (call, next) => (call.name === "write_doc" && call.run.ledger.find((e) => e.tool === "write_doc") ? Promise.reject(new Error("one document per run")) : next())
});

// A FOLLOW-UP runs when a turn ends, while its run is still open: it may start
// one of your workflows, which then writes into the same run and asks like any
// other. canAsk is false when the run already ends on a question (or failed);
// note what you owe the thread and start it on a later turn.
ctx.agent.followUp({
  id: "doc-index",
  after: ({ runId, canAsk }) => (canAsk && touchedDocs(runId) ? { workflow: "reindex_docs", args: { runId } } : null)
});
```

A workflow step the platform starts or resumes itself, a follow-up or a clicked
answer, writes under the run's `run_id` just as a tool call does, so it counts
in "Changed N" and reverts with that run. `@tomradex/agent-backlog` uses a
follow-up for dependencies: after a turn that creates, deletes, cancels or
re-scopes tickets, `review_dependencies` asks the worker model which `blocks`
edges the change calls for (named prerequisite/dependent, so a model cannot get
the direction backwards), drops unknown keys, cycles, finished targets and edges
the others already imply, and asks the user before writing anything.

### General work, deliveries and the Files plugin

Ticket `workType` defaults to `coding` on a workstream with a repository and to
`general` on one without; `general` needs no repository. Structural
`kind` still distinguishes tickets and epics. `playbookId` is an optional default
method, including `task.assist`, `document.write`, `design.create` and
`media.generate`. The latter methods require provider capabilities: `@tomradex/files`
advertises `files.read`, `files.write` and `document.preview`; media generation
providers are intentionally not implemented in core.

`agent.startGeneral(projectId, itemId, { engine?, playbook?, options?, allowBlocked? })` preflights the
engine, ticket and required capabilities. A ticket that waits on open work is refused
unless `allowBlocked` says the person chose to start anyway; the open dependencies
then travel as `TurnInput.ticket.waitsOn` on every turn (`waitsOnLine` renders them)
and never stop a run. A run uses a temporary
execution directory, not durable artifact storage. `agent.prepareGeneral` does
everything but send the first message — it binds the thread to the delivery and
the playbook and returns the brief a CLI agent starts from — which is how
`@tomradex/code-link` opens a General ticket in the user's own terminal. The
ticket's Start button is one dialog for both work types: `codeLink.start(projectId,
itemId, { mode: "run" | "terminal", engine?, playbook?, options?, permissionMode?, allowBlocked? })`
settles where the work runs, which agent, and the model/effort knobs; `options`
are stored on the thread (`ThreadSummary.options`, `agent.setOptions`) and merged
over the engine's settings for every turn, so two tickets can run on different
models at once. A terminal template's `{options}` slot receives the same knobs as
the CLI's own flags. Resuming the active delivery
preserves its method snapshot; `agent.takeoverGeneral` cancels and waits for
execution to stop without marking the ticket complete. Runs expose `execution`
and `playbooks` snapshots (source, content hash and body), including methods
explicitly loaded through `open_playbook` on Coding runs.

Ticket creation can call `agent.recommendPlaybook(projectId, { title, body,
workType? })` before persisting. The worker model receives only the ticket brief
and applicable Playbook metadata, and returns a suggested work type, method,
confidence and reason. The renderer preselects that method in the New Ticket dialog and again in the
ticket's Start dialog; it must remain an advisory choice. A human selection wins and stops later recommendations from
overwriting it. If no model is configured or the response is invalid, the Agent
uses a deterministic keyword/metadata fallback. Recommendation never starts a
run and never bypasses capability checks.

`TurnInput.filesIndex` carries `{ markdown, digest }`: what this project's Files
hold, filled in by a plugin on `agent/prepare-turn` — `@tomradex/files` is the one
that does. It is discovery, not permission: it says what is there to look up and
nothing about what may be read. `promptSections(input, io, { filesIndex: false })`
leaves it out of the per-turn text, which is what an engine asks for when its
session prompt already carries it, a user message being paid for again every turn
while a system prompt is cached. `sessionSystem(input, agentName)`, exported from
`@tomradex/engine-claude-code`, is that prompt for Claude Code and Codex; `digest`
is how a long-running session notices the index it opened with has gone stale. A
CLI agent gets no system prompt from Tomrade at all, so `agent/prepare-brief`
(`{ projectId, itemId, filesIndex? }`) is where the same context enters the brief
`agent.prepareGeneral` hands over.

A Files provider registers `ctx.items.files({ getVersion(projectId, reference) })`
and retains the returned disposer; `@tomradex/files` is the one shipped. The
resolver must check project access and return the exact `{ fileId, versionId }`,
or `null`; versions must be immutable. Registering a resolver does not grant
agent tools permission to read/write files. There is no fallback attachment
directory or file-content field on Ticket.

After persisting a version in Files, call
`items.addResource(projectId, itemId, { name, role: "input" | "output", file }, by)`.
Inputs are ticket-wide materials; outputs belong to the active Delivery. Agent
tools are `add_delivery_resource` and `submit_delivery`. Submission takes a
nonempty report and selected output resource IDs from this delivery, transitions
to Verifying, and pins those file versions. Report-only human work is supported.
Human-only `items.reviewDelivery` IPC takes submission ID, decision, comment and
the observed item version. Stale review is refused. Acceptance completes;
changes requested return to Doing without losing earlier submissions.

The Files screen owns selection, preview and file permissions. Its picker returns
one or more versioned references, never machine-local paths or mutable “latest”
aliases (`files.attach` and `files.attachMany` save the working copy first, so
what is pinned is what is there). A pinned artifact opens the submitted version
rather than the current file head, and reads as unavailable when that version is
gone or the plugin is off. The Delivery panel adds materials and outputs through
that picker; a multi-selection is validated completely and added in one Ticket
write.

Files selective sharing is a backend-independent contract. `files.syncPolicy`
returns `{ default: "shared" | "local", rules: [{ path, mode }] }`;
`files.setSyncRules(projectId, paths, mode)` changes a batch atomically. `inherit`
removes an explicit exception, and the empty path sets the root default.
The closest ancestor rule wins. Changing a folder preserves its explicit child
exceptions. `FileEntry.sync` reports the effective mode, its source and whether a
folder is mixed; it expresses intent, not a successful transfer. Backends
without these optional methods offer no selective-sharing controls.

Local-only files keep their versions, stable ids and undo. The policy travels
with the remote so every machine applies the same rules, which means the names
of local-only paths are visible there while their content and history never
are. Making a shared file local removes its current copy from the remote; the
versions already published stay, so `{ fileId, versionId }` pins keep resolving
on every machine. The Git backend never pushes its local commits: it builds each
remote commit on the remote's own tip through a separate projection, publishing
the shared files, one record per shared version (the bytes at
`.tomrade-files/versions/<fileId>/<versionId>`, the path in a `.json` beside
them — the same blob as the file, so a current version costs nothing extra) and
the policy. Only the remote's tip is fetched.

Git remote destinations can specify a `directory` relative to the repository
root. Files presents paths relative to it and changes nothing outside it: in a
monorepo `project-files/brief.md` appears as `brief.md`, while `src/` and
`package.json` belong to Code. GitHub repository picks and drafts use
`project-files`; configurations without a directory keep their repository-root
meaning. Moving a project's Files between a repository root and a folder
switches to a separate local store — the root shows the repository, code and
all, which a folder must not republish and a root must not receive twice — and
the previous store is parked whole under `.tomrade/files-archive/`, where its
pinned versions stay readable and its operations stop being undoable. Moving
between folders keeps the store and its files.

Shared Delivery rows travel with snapshots. Item evidence and delivery status
participate in undo. Independent evidence additions merge; incompatible active
deliveries, duplicate reviews, and broken submitted references fail sync with a
reconciliation error, preserving the source snapshots rather than fabricating
completion. Work type cannot change during an active delivery.

Engines emit **blocks** — text, trace, question, card, status, changes, note —
and the panel draws them with the design system's own primitives; a
third-party engine ships no UI code. While a workflow is suspended, on-script
input (a clicked option, or the question's own answer) resumes it
deterministically; anything else goes to the engine, which holds
`resume_workflow` / `cancel_workflow`. Typed text counts as on-script only for an
engine that declares `literal: true` (no model, like the scripted one): a model
engine reads the reply with the waiting question in its prompt and decides
whether it is the answer or an instruction that moves on. Every tool call an engine makes is
run-bound: the oplog rows it produces carry the `run_id`, which is what makes
"Changed 15 items · Revert" one click. A CLI agent (Claude Code, Codex) is an
engine like any other: it gets the tools over MCP with a per-run token
(`ctx.mcp.bindRun`), so the ledger, the policies and the revert apply to it
unchanged. A binding may also carry `event(payload)`: whatever is POSTed to
`/sessions/<token>/event` on the MCP server — a coding agent's hooks reporting
it started, stopped or is waiting — reaches the binding that owns the token.
Hooks a repository commits for every developer carry no token; they post to
`/sessions/event`, and `ctx.mcp.onEvent(listener)` hears them with the `cwd`
and `session_id` the payload carries.

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
| `agent/event` | emit | Main-process agent lifecycle stream. Receives `(threadId, AgentEvent)`; feature plugins subscribe here instead of observing renderer IPC. |

A main-process observer loaded while work is already active can seed itself
from `ctx.agent.activities()`, which returns current in-memory runs and durable
pending questions; subsequent changes arrive through `agent/event`.

The rule everything else rests on: **every mutation of an item, board or view
passes `write/pre-commit` and lands an oplog row.** `@tomradex/write` enforces the
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

### Undo, redo and the timeline

⌘Z is `oplog.undo(projectId)`: the newest thing this machine did, wherever it
did it. A reverted row is not deleted but parked in `oplog_undone`, so ⇧⌘Z —
`oplog.redo` — can put it back; a redo lands as a new row with a fresh
`deviceSeq`, at its old place in time. Any write anywhere empties the redo
stack, in the oplog and in every provider. `oplog.timeline(projectId)` is the
history window's list — every record, newest first, undone ones with
`undoneAt` set — and `oplog.rollback(projectId, ref)` moves the cursor to a
record: everything newer than a live record is undone, newest first; an undone
record is redone together with whatever was undone after it. `oplog.revert`
takes back one named record out of order, which is what a toast's Undo does.
`undoLast(projectId, entityId)` still reverts one entity's latest backlog
write; `undoRun` still consumes a run's rows outright.

A plugin whose operations are not oplog rows joins the same ⌘Z with an
**undo provider**:

```ts
ctx.oplog.provide({
  id: "files",
  timeline: (projectId, limit) => ops.list(projectId, limit).map(toRecord),   // UndoRecord[], newest first
  undo: (projectId, id) => restore(id, "before"),                              // returns the toast line; throw to refuse
  redo: (projectId, id) => restore(id, "after"),
  forget: (projectId) => ops.forget(projectId)                                 // a write landed: drop the undone ones
});
```

`provide` is an effect. A record's `ref` is `provider:id`; `undoable` is false
for what the timeline shows but cannot take back — purges, sync notes, other
machines' rows. `@tomradex/files` is the first provider: each write, folder,
move, copy, delete and import is remembered as the versions before and after
it, and undo restores exactly its paths, refusing with `FileMovedOnError` when
one has changed since. The renderer reaches all of this through `oplog.undo`,
`oplog.redo`, `oplog.timeline`, `oplog.rollback` and `oplog.revert`.

## Tools

```ts
ctx.tools.register(defineTool({ name, title, description, input: z.object({...}), execute(args, invocation) }));
```

Names are global and unique. `execute` receives validated `args` and
`{ by, projectId, run?, signal? }`; use `inv.by` as the author of any write,
`inv.projectId` as the default scope, and `inv.run` (present inside an agent
run) for the ledger and run-scoped state. `inv.signal` aborts when the caller
stops waiting — the run was cancelled, or an MCP client withdrew the call — and
a tool that waits on a process or a network should stop with it. A registered tool appears on every
surface at once: engines see it via `io.tools.describe()`, and each MCP
session registers it under its own name — the server name is the namespace.
There is no per-surface code to write. A tool may return a string as well as a
value: the MCP server passes a string through as the result text and serialises
anything else as compact JSON, so a tool whose answer is already prose spends no
context on quoting and indentation.

### Tools from external MCP servers

`@tomradex/mcp-client` is the other direction of `@tomradex/mcp`: servers the
person connects in Settings › MCP servers (a command run over stdio, or a
Streamable HTTP URL with SSE as the fallback) have every tool they list
registered here as `<server>__<tool>`, so engines and Tomrade's own MCP
endpoint see them like any other tool and every call passes
`tools/pre-execute`. The configuration is the machine-scope `mcpServers`
settings section; the plugin keeps the registry in step with it and with the
server's own `tools/list_changed`. A name already taken is skipped and reported,
never thrown; a server that fails is marked failed with its reason and holds
nothing else up. A dropped server is retried after `retryDelaysMs` (1 s, 5 s,
30 s by default), and a connection has to last `stableMs` before it earns those
retries again, so one that keeps dying stays failed. A cancelled call is
cancelled on the server too. What a server writes outside Tomrade is not in the oplog and
cannot be undone.

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
this machine's alone (`ctx.repos.selectCheckout(remote, dir)`, verified against
the folder's origin). If the selected folder is not that checkout, the UI offers
a separate explicit `ctx.repos.cloneInto(remote, branch, dir)` action which clones
into a repository-named child of the selected folder; Tomrade never overwrites the
selected folder's contents. A
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
in `@tomradex/domain` (`matchesFilter`, `compareItems`), and a parity test in
`packages/items` keeps the two implementations agreeing. Agents reach all of it
through `list_fields`, `create_field`, `list_items` (`filter` / `sort`) and
`update_item` (`patch.fields`). Both `items.list` and `items.query` also take
`search`: terms that must all appear in title or body, matched as substrings in
any script over an FTS5 trigram index (`items_fts`, kept in step by triggers)
and returned most relevant first, after any explicit sort. A term is a word, or
a double-quoted run (`"login timeout"`, `“登录 超时”`) that must appear
contiguously. Relevance is BM25 with the title weighted 5:1 over the body;
terms under three characters are below a trigram, filter with `instr()` and
rank by whether they hit the title. With `widen`, a search that matched
nothing is retried with any term sufficing (rows matching more terms first);
`list_items` widens, `count_items` never does. Both also take `limit`, the
first N rows of that order; `list_items` exposes it and defaults to 50,
`count_items` has none. A `projectId` that names no open project is a
`ToolInputError`, like a `boardId` that names no workstream.

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
default project to fall back to. A call already bound to a project (an assistant
thread's run, a run token, a `/mcp/<projectId>` session) stays in it: naming
another project is refused, so an agent never reads or writes a project the user
is not looking at. Only an unbound caller picks the project per call.

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
  The user ticks which namespaces travel under Storage → What travels; add
  `always: true` for a table that is part of the project's identity rather
  than data about it (a binding every machine needs, such as where the files
  live) — it travels regardless, even inside a code checkout, and the
  namespace is not offered as a choice.
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
(`mergeStates` in `@tomradex/storage`): a row changed on one side only is taken,
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
chosen. `browse()` and `draft(name)` remove typing. `@tomradex/storage-git`
registers `git` (any URL); `@tomradex/storage-github` adds discovery and
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

## Files

Every project keeps its files beside its backlog: `<dir>/files/` next to
`.tomrade/` (inside `.tomrade/files/` when the folder is somebody's checkout,
where Tomrade writes nothing else). The folder is a git repository of its own —
every save is a version, ids follow files across renames through
`.tomrade-files/ids.jsonl` (append-only, `merge=union`), and hidden names are
never files. A **backend** is a way of keeping those files; `local` is always
there, and a remote backend adds where they are shared:

```ts
ctx.files.register(createGitBackend({
  id: "acme-drive", title: "Acme Drive",
  configSchema: z.object({ space: z.string() }), defaults: { space: "" },
  describe: (c) => `drive.acme.dev/${c.space}`,
  remote: (c) => ({ url: `https://drive.acme.dev/${c.space}.git`, branch: "main" }),
  async ensureRemote(c) { /* create it */ },
  async browse() { return [{ label: "acme/docs", config: { space: "acme/docs" } }]; }
}));
```

`register` is an effect and refuses a `format: "password"` field, as
`ctx.storage` does: the config is per project and travels in the project's
folder (`plugin_files_remotes`, exported `always` — it is not a What-travels
choice), so a teammate who clones the project clones the files beside it. Credentials belong in a settings section named in
`settingsSection`, collected inline through `connection`. `createGitBackend`
is the git-backed store every remote backend builds on; a backend that keeps
files some other way implements `FileStore` itself (`list`, `tree`, `read`,
`readVersion`, `resolveVersion`, `locate`, `history`, `write`, `mkdir`, `move`,
`remove`, `settle`, `status`, `sync`, `conflicts`, `resolve`, and — to be
undoable — `head` and `restore`; `writeMany` to save several files as one
version). Its `read` should give each `FileContent` a `hash` (sha-256 of the
whole file) and its `write` should honour `expect`: without them an editor's
save lands over whatever is there. `agentPolicy`, `setAgentRules` and `search`
are optional too: a backend without them lists everything and cannot search.
`@tomradex/files-github` registers `github`, sharing the `github` token section
with `@tomradex/storage-github`.

A ticket's files land in a top-level folder named after its workstream:
`ctx.files.folderFor(projectId, itemId)` is that name (separators become `-`),
`importFor(projectId, itemId, { sources, role })` copies files from this machine
into it and pins them, and `write_file` with an `itemId` places its path under
it. This is the Files side of "which workstream, which folder" in a monorepo:
the code lives in the workstream's `repoPath` of its repository, the documents
about it in `<workstream>/` of the project's Files. It is a default and a name,
not a binding — renaming a workstream starts a new folder and moves nothing,
and any explicit path is honoured as given.

A write can be guarded. `expect` is the `hash` the writer last read — `null`
for "this name must be free" — and a file that no longer has it is left alone:
`write` throws `FileChangedError`, and `ctx.files.save(projectId, path, body,
{ expect })` (the renderer's `files.save`) answers `{ ok: false, current }`
with what is there now instead of throwing. That is the editor's save, so an
agent's `write_file`, a sync merging a teammate's change or an edit in Finder
between reading and saving becomes a question for the person, never a silent
loss. `writeMany(projectId, entries, { message })` saves several files as one
version and one step of ⌘Z, checking every `expect` before any byte lands. A
move through the service emits `files/moved(projectId, from, to)` and awaits
its listeners, which is how link updates ride along with a rename.

Sync never forces. A save is pushed a few seconds after it lands, outside edits
are saved as versions when they settle, and every open project is fetched,
merged and pushed on a sweep (`autoSyncMs`). A file changed on both sides is a
**conflict**, not a loss: the merge stays open, `status().state` reads
`conflicted`, the other files keep syncing, and `resolve(path, "ours" | "theirs"
| "both")` settles it — `both` keeps theirs beside ours as `name (theirs).ext`.

A project's files introduce themselves. Every turn carries an **index** of what
the store holds — paths, sizes, dates and the title a document gives itself, the
biggest folders folded to a token budget and left saying how much they hold.
`ctx.files.agentIndex(projectId, { budget, focus, native })` builds it, and
`ctx.files.indexFor(projectId, native, itemId?)` is the same thing as a prompt
wants it: the person's budget applied, the ticket's own workstream folder kept
open whatever that budget is, and with `native` this machine's folder named for
an engine that has file tools of its own. Without an index an agent has to go
looking, and mostly answers from memory instead.

Listing governs what Tomrade volunteers, never what an agent may do.
`ctx.files.agentPolicy(projectId)` returns `{ default: "listed" | "unlisted",
rules: [{ path, mode }] }` and `ctx.files.setAgentRules(projectId, paths, mode)`
changes a batch atomically, in the same shape as the sharing rules: `inherit`
drops an exception, the empty path sets the root default, the closest ancestor
wins, and `FileEntry.listing` reports the effective mode beside `sync`. An
unlisted path is left out of the index, out of `list_files` and out of a
`search_files` call that named no path; it reads and writes exactly as a listed
one, and a path the person names in conversation or pins to a ticket always
resolves. `ctx.files.search(projectId, input)` is the search behind that tool —
literal strings or regular expressions over the working copy, several queries in
one call — and it withholds unlisted hits only when the caller named no path.

Both dimensions share one policy file, `{ v: 2, sync, agents }`; a version-1 file
is the bare sync policy and is read as one, then rewritten. The Git backend
publishes it to `.tomrade-files/policy.json` beside the shared files and merges
it three-way per dimension against the last synchronized copy. Sharing fails
closed when two machines changed the same rule, because bytes are at stake;
listing settles on `unlisted` instead, a disagreement about what to volunteer
being no reason to stop an exchange.

| Call | Does |
|---|---|
| `ctx.files.dirFor(projectId)` | This machine's copy, or null until the project has a folder |
| `ctx.files.info(projectId)` / `status(projectId)` | Folder, remote, `local` / `synced` / `ahead` / `behind` / `diverged` / `conflicted` / `syncing` / `offline` / `error` / `unavailable` |
| `ctx.files.tree(projectId)` / `list(projectId, dir)` / `read(projectId, path)` | The entries and a working copy, with each file's stable id and last version |
| `ctx.files.readVersion(projectId, { fileId, versionId })` | An immutable version, or null |
| `ctx.files.search(projectId, input)` | Literal or regular-expression hits over the working copy, several queries at once; unlisted paths are withheld unless the caller named one |
| `ctx.files.write(projectId, path, body, { message, expect })` | A new version, returned with its `fileId` and `versionId`; `FileChangedError` when `expect` no longer holds |
| `ctx.files.save(projectId, path, body, { expect, message })` | The same, answering `{ ok: true, content }` or `{ ok: false, current }` |
| `ctx.files.writeMany(projectId, entries, { message })` | Several files as one version and one history record, or none of them |
| `ctx.files.mkdir` / `move` / `copy` / `remove(projectId, …)` | Each returns the history record it made (`files:<seq>`, for `oplog.revert`) or null when nothing changed; all undoable through `oplog.undo` |
| `ctx.files.sync(projectId)` / `conflicts(projectId)` / `resolve(projectId, path, choice)` | Save, take theirs, push; what waits; settle one |
| `ctx.files.agentPolicy(projectId)` / `setAgentRules(projectId, paths, mode)` | What the index and the browsing tools mention unasked: `listed`, `unlisted`, `inherit` |
| `ctx.files.agentIndex(projectId, opts)` / `indexFor(projectId, native, itemId?)` | The index and its digest; `indexFor` applies the settings budget and keeps a ticket's folder open |
| `ctx.files.bind(projectId, backendId, config)` / `unbind(projectId)` | Share through a backend's remote (and sync at once); stop sharing, keeping everything |
| `ctx.files.attach(projectId, itemId, { path, role })` | Pin the file's latest version to a ticket as material or an output |
| `ctx.files.attachMany(projectId, itemId, { paths, role })` | Pin several latest file versions to a ticket in one write |

Agent tools: `list_files`, `search_files`, `read_file`, `write_file` and
`manage_file`, which moves, copies or deletes in one call; `write_file` returns
the pair `add_delivery_resource` takes. Events: `files/registered`,
`files/unregistered`, `files/changed`, `files/synced`, `files/moved`; the
renderer hears `files.changed(projectId)`. The renderer draws the tree above
the views in the sidebar, the viewer (markdown rendered and sanitized, HTML in
a sandboxed frame, text, images) with its version rail, the conflict panel, the
Sharing block in project settings, and — for any text file of the latest
version — a Read/Edit switch (⌘E) over a CodeMirror editor that saves on a
pause, on leaving and on ⌘S, each save a guarded version, plus Split for a file
that renders (markdown, HTML, SVG): the editor and a live preview side by side.

## Notes

`@tomradex/notes` (`ctx.notes`, module `notes`) reads a project's files as
notes, the way Obsidian reads a vault: it never owns a file, and switching it
off leaves Files exactly as it was. What it adds is an index in the project's
cache — derived, never exported, rebuilt from the files on any machine — caught
up a moment after every `files/changed` and before every query:

- **Links.** `[[Note]]`, `[[folder/Note#Heading|alias]]`, `![[picture.png]]`
  and markdown links to files of the store. A wiki link resolves the way
  Obsidian's does: a path from the linking note's folder, then the whole path,
  then a path suffix — the bare name being the usual one — ties going to the
  linking note's folder, then the shallowest path; no extension means a note.
  `@tomradex/notes/syntax` is that parser and resolver as a pure module, which
  the renderer imports, so the editor, the preview and the index agree.
- **Tags.** `#tag` and `#nested/tag` in prose (never in code, headings or
  link text), and `tags:` in front matter.
- **Search.** A trigram FTS5 table over title, path and text, ranked by BM25
  with the title weighing most; words in any order, `"quoted phrases"`,
  `#tag`, `path:folder`. Words under three characters — two-character Chinese
  words among them — go through `instr`, as items search does.
- **Moves.** When `files/moved` fires and the `notes` setting `updateLinks` is
  on (the default), every note whose link resolved to a moved file — and every
  moved note whose own relative links would now miss — is rewritten in one
  `writeMany`, judged against the files as they were before the move. A link
  that still resolves is left as written.

| Call | Does |
|---|---|
| `ctx.notes.search(projectId, { query, limit, folder, listedOnly })` | Ranked hits: path, title, the line that holds most of the words with their offsets marked, tags |
| `ctx.notes.links(projectId, path)` | `outgoing` (each resolved, or null), `backlinks` (source, line, the line's text), `unlinked` (notes naming it without a link) |
| `ctx.notes.tags(projectId)` | Every tag with how many notes carry it |
| `ctx.notes.resolve(projectId, target, from)` | The file a link written in `from` means |
| `ctx.notes.retarget(projectId, from, to)` | The move rewrite, by hand |
| `ctx.notes.journal(projectId, "YYYY-MM-DD")` | The day's note under the `journalFolder` setting, made from its date when absent |

Agents get `search_notes` (ranked, a line per hit) and `note_links`; both
follow the agent index, so an unlisted note stays out of a search that names
no folder and still answers when named. `search_files` remains the exact-line
and regular-expression search. Channels are `notes.search`, `notes.links`,
`notes.tags`, `notes.resolve`, `notes.journal`; the broadcast
`notes.changed(projectId)` says the index caught up. The renderer draws
backlinks and unlinked mentions under a note (Link turns a mention into one),
the search pane in the sidebar (⇧⌘F, or a tag clicked in a note), New note and
Today's note in the add menus, and offers the notes from the palette when no
name matches.

## Settings

Configured Supabase deployments install `ctx.cloudHub`. It supplies the Hub-only
`ctx.storage.useHubBackend()` port and the user-only
`ctx.settings.useUserStore()` port. Project storage providers, machine settings
and local catalog paths keep their existing roles. The old Hub JSON files are
retained as migration inputs. See [Supabase Hub migration](supabase-hub.md) for
the cloud tables, outbox, account binding and deployment procedure.

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

First-party plugins register sections the same way: `@tomradex/files` contributes
`files`, whose `agentIndexTokens` (1500) is how much of an agent's prompt the
index of a project's files may take, and zero turns the index off.

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
ctx.contributions.assistantAccessory({ id: "hello.pet", kind: "animated-pet", title: "Helper", stateChannel: "hello.pet.state", changedChannel: "hello.pet.changed", width: 96, height: 72, animations: { idle: { source: "data:image/gif;base64,…", type: "image/gif", box: { x: 12, y: 30, width: 280, height: 200 } } } });
```

Every callback may return a Promise; the renderer's refresh waits for it. One
that throws is left out of that refresh and logged, and for an extension one
that takes longer than two seconds is left out too — commands get a minute.

Commands appear in the palette under their group and run in the main process
with the current `{ projectId, boardId, viewId, itemId }`. Badges are computed
on every board refresh over the project's items. Status items render in the
status bar; sections in the detail pane and the issue sheet. Registering or
unregistering any of them broadcasts `contributions.changed`, and the renderer
refetches. A section row may carry `href` — its value opens that link in the
browser — or `command`, the id of a palette command the value runs with the
item in scope; `icon` (a sprite id) leads the label, `mono` sets the value in
the mono face, and `state` puts a mark before the value — `live` breathes,
`waiting` blinks, `ended`/`lost` are hollow — still declarative, still drawn by
the renderer.

An `animated-pet` **assistant accessory** reserves the renderer-owned stage
directly above the composer. Each state is a still or animated image (GIF,
WebP, APNG, PNG, JPEG or AVIF) given as a URL with its MIME `type`; the
renderer decodes it and shows every frame for its own duration. `box` names the
part worth showing in image pixels — it is fitted into the stage at 90% of its
height, bottom-aligned — and `pixelated` asks for nearest-neighbour scaling.
The renderer owns animation and accessibility, holds the first frame under
reduced motion, and removes the stage when the contribution disappears. `stateChannel` returns `{ mood }` for a selected
thread and `changedChannel` broadcasts `(threadId, { mood })`; naming both in
the descriptor keeps the renderer independent of the feature package.
`@tomradex/pet` is the shipped example.

A **graph** is what a view with the Graph layout draws: the renderer puts the
same issue cards on an interactive canvas with the plugin's edges as arrows,
and the view's `query.graph` names which contributed graph. The plugin returns
item-id pairs (`{ from, to, tone?, title? }`) — no layout, no pixels; the view's
filter still applies, and edges whose ends are filtered out are not drawn. A graph that declares `edits: "blocks"` gets an editable canvas:
dragging between cards and deleting an arrow write `Item.blocks` patches
through the ordinary guarded path. `@tomradex/deps-graph` is the shipped
example — the Dependencies graph plus a `blocked` badge for issues waiting on
unfinished work.

## Channels

Plugins add renderer channels by augmenting the contract and registering a
handler when `ipc` is present:

```ts
declare module "@tomradex/ipc" {
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

## Auxiliary desktop surfaces

`@tomradex/desktop-surface` is the non-Electron contract for a feature-owned
top-level window. A plugin calls `ctx.desktopSurfaces.open({ id, url, width,
height, ... })`; the returned controller can send serializable state, inspect
the current work area, move the surface and close it. Opening is a Cordis
effect, so unloading the caller destroys its window even if the caller forgets
to close it explicitly. The shell owns frameless/transparent BrowserWindow
policy and an isolated preload; the feature owns its document, state and the
decision to open or close.

Transparent pixels do not imply click-through in Electron. With
`clickThrough`, the generic preload forwards mouse movement on macOS and
Windows and lets the surface document mark only its opaque pixels interactive;
those pixels may use the native draggable region. Linux keeps the tightly sized
surface interactive because forwarded moves are unavailable. Programmatic
top-level positioning is also unavailable on native Wayland, exposed as
`surface.capabilities.programmaticPosition === false`; roaming features must
stay stationary there. Surface documents can report preferences such as
`prefers-reduced-motion` through `onMessage` so feature-owned movement stops as
well as CSS animation.

## What is deliberately not here

- No orchestration graph and no per-message intent router. One engine conducts
  a thread; determinism lives in workflows and policies, judgment in the
  engine's model — and a CLI agent can be the engine.
- No code evaluation in configuration. `tomrade.yml` is static YAML with
  `${userData}`-style substitution and nothing more.
- No profile or bundle layering. One file, one patch file, merged by id.
- No renderer plugin bundles. Contributions are data; the only documents a
  plugin ships are surfaces, opened from inside its own package.
