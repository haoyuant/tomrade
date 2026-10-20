# Plugin API

Tomrade is a [cordis](https://github.com/cordiverse/cordis) application. The
desktop shell creates one `Context`, reads `apps/desktop/tomrade.yml`, and loads
one plugin per row. Everything else — the database, the write path, the tool
registry, the MCP server, the IPC channels the renderer calls — is a plugin
that claims a key on that context.

There are two kinds of plugin, and this document is the contract for both:

- **Extensions** come from outside the app — Community, a `.tomrade-plugin`
  file, a folder, Plugin Studio. Most are written against
  `@tomradex/plugin-sdk`: their `apply` receives a `PluginContext`, an async,
  attributed, namespaced view of the app that the host builds for them.
  `tomrade-plugin init` scaffolds one that builds and passes its tests. An
  extension that needs more declares [full mode](#full-mode) and is loaded as a
  built-in row is, with the raw `Context` and rows of its own.
- **Built-in rows** are the app's own cordis plugins, listed in `tomrade.yml`.
  They take the raw `Context` and the services below it ([Services](#services)
  onward). A built-in may also be written with the SDK — `@tomradex/deps-graph`
  is — and is then loaded behind the same facade.

## Stability

- `cordis` is pinned to `4.0.0-rc.8`, and `@tomradex/plugin-sdk` is `0.2`. The
  SDK's contract version is `SDK_CONTRACT`; a plugin states the range it needs
  in `engines.sdk` and is refused, with the reason, by a Tomrade outside it.
  Until `1.0` a minor version may break.
- A person may still run a refused plugin, as dsh's version exemptions allow:
  Settings → Plugins offers "Run it on this version anyway", warns that it may
  crash Tomrade or lose data, and records the exact pair — `<id>@<version>` and
  this SDK contract or, for `engines.tomrade`, this Tomrade version — in
  `compatibility.json` beside the plugins lock (`{ "someone/acme@1.0.0":
  { "tomrade": ["0.14.0"], "sdk": [] } }`). A new version of either side asks
  again, and the grant is taken back in the same place. A record the file
  cannot read is reported and left out, never fatal, and the file is not
  rewritten until it is repaired by hand. The store's own filtering is
  unchanged: a grant covers what is already installed or loaded from a folder.
- `@tomradex/plugin-sdk` is not bundled into a plugin: `tomrade-plugin build`
  leaves it out, and the plugin imports the copy that comes with the Tomrade it
  runs in. A value the SDK added in some version (marked "SDK 0.2.x" here, and
  listed with it in `SDK_EXPORTS`) exists only in a Tomrade from that version
  on, so a plugin that imports one must keep `engines.sdk` at that version or
  later — `wordsFor` needs `^0.2.9` — or a Tomrade its range still accepts fails
  to load it. `tomrade-plugin check` blocks such an import. Types are erased
  at build time and need nothing.
- What this file describes is what we promise. Anything reachable but not
  written here — table shapes, private methods, event argument internals — may
  change without notice.

## Trust model

Plugins run in the main process with the same rights as Tomrade itself:
`better-sqlite3`, the filesystem, the network, and the user's API key. **This is
not a sandbox.** What the system does guarantee:

- An SDK extension reaches the app only through its `PluginContext`: every
  call returns a Promise and every value that crosses is plain data, so the
  same plugin can later run behind a process boundary without changing. A
  [full-mode](#full-mode) extension is loaded as the app's own rows are, with
  the raw `Context`, and is labelled so.
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
- Every tool call passes `tools/pre-execute`, and every write `write/pre-commit`:
  a policy there — the app's own or an extension's gate — can refuse it, and a
  tool policy can change its arguments or answer in the tool's place.
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
| `items` | `list`, `query`, `get`, `getByKey`, `create`, `update`, `delete`, `addRelation`, `removeRelation`, `labels`; SDK 0.2.12: `gate(check)`, a policy over every write before it lands — see [Policies](#policies) |
| `fields` / `boards` / `views` / `projects` | the project's fields (and `create`/`update`/`remove`/`addOption`), workstreams, saved views, projects — read |
| `db` | `migrate(steps, { scope, tables })` for `plugin_<namespace>_*`; `all`, `get`, `run`, `batch` (one transaction) against a project id or `"hub"`; `isOpen` |
| `settings` | `register({ title, schema, defaults })` — the card is drawn from the schema — `get`, `set` |
| `tools` | `register(defineTool(…))` (SDK 0.2.6: `kit` keeps a rarely needed tool out of each request until the model loads it; `kit(id, purpose)` says what the kit is for), `list`, `call`, `gate(check)` (throw to refuse any tool call; SDK 0.2.12: answer `{ args }` or `{ result }` — see [Policies](#policies)) |
| `contributions` | `command`, `badge`, `statusItem`, `section`, `graph` — see [Contributions](#contributions); callbacks may be async |
| `agent` | `playbook({ id, title, when, body, tools })`; SDK 0.2.14: `request(hook)`, `requestError(hook)`, `turnEnding(hook)` — the in-app conversation's loop, see [Hooks in the agent's loop](#hooks-in-the-agents-loop); SDK 0.2.15: `cliHook({ events, tools, agents, handle })` — the CLI agents' hooks, see [Hooks in CLI agents](#hooks-in-cli-agents) |
| `surfaces` | `open({ id, document, … })` — a document inside the plugin's own package, never a remote page (SDK 0.2.7: `onClose()` says the window is gone, however it went; the handle's calls then reject). SDK 0.2.11: `kind: "window"` (with `minWidth` / `minHeight`) opens a working window and needs `permissions.window`; `post(message)` sends one message to the document; see [Auxiliary desktop surfaces](#auxiliary-desktop-surfaces) |
| `alerts` | `sounds()` (the system's, its own alert sound first), `play(sound, { volume })` — `system:<name>` or an audio file's absolute path, played by the host — and `notify({ title, body })`, a silent system notification. SDK 0.2.4 |
| `oplog` | `recent`, `history` |
| `im` | `register(adapter)` — an IM transport: `capabilities`, `open(connectionId, io)` returning a session with `deliver` (and optionally `download`). SDK 0.2.5 adds optional capabilities (`threads`, `reactions`, `typing`, `stream`, `select`, `multiSelect`, `textInput`, `cards`, `cardUpdate`, `nativeCommands`, `ephemeral`, `markdown` dialect, `rateLimit`), session methods `indicate`, `react`, `stream.start/append/stop`, `commands`, and `toImDialect` / `splitImText`; also `setup` (credential fields, console steps, permissions, manifest) whose values arrive sealed-at-rest as `io.credentials`, a session `identity`, the `ambient` group activation, a message's `replyTo`, and `retract` / `edit` inbound events. An adapter that declares none of them keeps the 0.2.2 behaviour |
| `webSearch` | `register({ id, title, unavailable(), search(request, signal), read?(request, signal), settings? })` — a provider answering the agent's `web_search` / `web_fetch`, exactly as the app's own do; see [Web search](#web-search). SDK 0.2.9 |
| `models` | `registerProvider({ id, title, baseURL, presets?, list(endpoint, signal), usable?, capabilities?, signIn?, build(profile) })` — a model provider serving the profiles that name it and offering its presets in the model setup, as the app's own do; see [Model providers](#model-providers). SDK 0.2.16 |
| `terminals` | `state()` — whether herdr can hand over a live terminal, and the fix when it cannot — and `open(paneId, { mode, cols, rows })`: a pane's terminal as frames in and `input` / `resize` / `scroll` / `mouse` out; see [Terminals](#terminals). SDK 0.2.10 |
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

**Licenses.** Tomrade, the SDK, `@tomradex/domain`, `@tomradex/plugin-kit`,
`@tomradex/plugin-host` and the CLI are all Apache-2.0, and a plugin may use any
license, commercial ones included.

`tomrade-plugin build` bundles `src/index.ts` into one readable ESM file,
`dist/index.js`, with every dependency inside it except the three the host
provides — `cordis`, `@tomradex/plugin-sdk` and `zod` — which the app resolves
to its own copies wherever the plugin lives. Documents for surfaces go in
`static/` and are copied beside it. The build stamps `inject`, `optional` and
`contributes` into the manifest from what the plugin was seen to do.

A plugin that is data only says `"main": null` and has nothing to build; today
that is a [language pack](#languages), whose `languages` files ship in the
package beside the manifest.

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

**The official catalog** lists Tomrade's own plugins, released from
github.com/haoyuant/tomrade-plugins as `catalog.json` (format in
`packages/plugin-kit/src/catalog.ts`) next to the packages, and needs no cloud
account. Only `tomrade/*` ids come from it, Community can never list them, and
a version shows only when its attestation verifies for the exact digest, id and
version listed — the host serving it is not trusted. The last good catalog is
kept on disk, so a machine offline still lists what it saw.

Some official plugins are **starters**, put on once per machine by the store
check (`community.starters` in `tomrade.yml`); one the person uninstalls stays
gone. A starter written `{ id, whenModelHost: [hosts] }` goes on only once the
person has a model profile on one of those hosts, checked again whenever the
model settings change: a provider's own plugin reaches exactly the people who
use that provider. Such a starter
that is not installed, and whose latest version contributes web search, is
offered as an install button on the card that says web search is unavailable.
A starter written `{ id, replaces: "<row id>" }` takes the place of a row the
app used to ship. If the person had switched that row off, which their patch
file still records, the plugin is installed switched off. The app carries every
starter's package and the catalog it was built against (`officialBundle`;
docs/releasing.md), so a machine that cannot reach GitHub still gets them.

An official plugin meets the standard `tomrade-plugin check --official` holds
it to, written up in tomrade-plugins' `STANDARDS.md`: everything the store asks
of any plugin, plus the `tomrade/<name>` id in `packages/<name>`, an icon, a
CHANGELOG entry for the version, unit tests and a passing `src/test.ts`, both
halves of every `{ en, zh }` text, and `permissions.why` for any host, any
folder or running programs. `tomrade-plugin release` runs that check, signs
the exact build (`TOMRADE_SIGNING_KEY`), packs it, and writes `catalog.json`
with the version added. A version is released once: the same build again
changes nothing, and another build under that version is refused.

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

## Full mode

An installed extension can reach as far as the app's own modules: declare
`"context": "full"` and its `main` is a plain cordis plugin, loaded like a
built-in row with the whole `Context` — engines, `llm`, storage, every event
and waterfall (`write/pre-commit` among them). The SDK stays the simple way to
write a plugin; full mode is for what it does not offer.

```json
{
  "id": "alice/local-model",
  "version": "1.0.0",
  "title": "Local model",
  "license": "MIT",
  "engines": { "sdk": "^0.2.13", "tomrade": ">=0.13.0 <0.14.0" },
  "context": "full",
  "rows": [
    { "id": "llm", "name": "./dist/llm.js", "config": { "model": "qwen3" } },
    { "id": "web-search-tavily", "disabled": true },
    { "id": "local_model-warmup", "name": "./dist/warmup.js" }
  ],
  "permissions": { "why": { "full": "Runs the model on this machine in place of the app's own." } }
}
```

- **`engines.tomrade`** names the Tomrade versions it works with: full mode
  reaches internals the SDK's range does not cover. A release outside the range
  refuses it with the reason instead of loading it to fail, unless the person
  lets that exact pair in (see [Stability](#stability)); a checkout (always
  `0.1.0`) checks no range.
- **`rows`** are laid over the app's composition, merged by id like
  `tomrade.patch.yml` rows: an app row's id switches it off, replaces its
  plugin or changes its config, and a new id — which carries the namespace —
  adds one. A relative `name` is a file inside the package. Rows are laid on at
  start: the app's, then each full-mode extension's in the order they were
  installed, then the person's patch files, which have the last word. Installing,
  switching or removing such an extension changes its rows at the next start;
  its detail in the Plugins pane says so and offers a restart.
- **Tomrade keeps itself.** Rows may not change `ipc` — the renderer's
  channels, through which a plugin is switched off and removed — or
  `community`, which verifies and revokes plugins. A row that switches off the
  last plugin of a required module is refused at install; one that replaces it
  with a plugin that provides nothing is taken back at start, the extension
  installed last first, and its detail names the module.
- **What it writes is still its own.** Writes made from its context, from its
  listeners and from any plugin it or its rows load carry `via: <namespace>` in
  the oplog, so `oplog.undoVia` and revocation reach them. It names its own
  author, as the app's modules do.
- **When two extensions change one row**, both details say so; the one
  installed last is laid on last.
- **It imports the app's own packages**, as a dsh plugin imports dsh's through
  its peers: `import { Llm, NativeSearchRefused } from "@tomradex/llm"` in a
  full-mode plugin's code gets the running app's copy, the same classes the app
  uses, so `instanceof` holds. `tomrade-plugin build` leaves every
  `@tomradex/*` import to the app. To build against them, install the package's
  declarations at the Tomrade version the plugin names: each app package is on
  npm under its own name, declarations only, at the app's version
  (`npm i -D @tomradex/llm@0.14.0 @tomradex/web-search@0.14.0`); the code they
  stand for comes from the app at run time. These are internals: any minor
  release may change them, which is what `engines.tomrade` is for.
  `tomrade-plugin check` holds the plugin's imports to the Tomrade its CLI came
  with (a checkout's own packages, from a checkout): a module or a name that
  Tomrade does not have is a problem. An SDK-mode plugin gets no `@tomradex/*`
  package but the SDK (and `@tomradex/domain`, which it may bundle); importing
  one is a problem there too.
- **Safe start.** File → Restart Without Plugins starts once without the
  person's patch files and installed plugins, and so does `--safe`. A start that
  never got as far as its window is noticed at the next launch, which offers the
  same. Nothing is changed or removed.

Full mode is labelled high risk wherever a person decides (`full`, and `rows`
when it has any), never refused for it; Tomrade's official plugins must say why
in `permissions.why.full`. `tomrade-plugin check` holds it to its shape — a
function, a class, or an object with `apply()` — and the sandbox does not run
it: try it in Tomrade with `plugin_try`.

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
| `ctx.schedules` | optional feature | `@tomradex/schedules` | Templates and their schedules: a template is one or more tickets (`{date}`, `{weekday}`, `{week}`, `{month}`, `{year}` filled in; General and To Do by default; optionally started) or a prompt to the assistant, run by hand or on any number of schedules (daily, weekdays, days of the week, every N days, a day of the month, every N hours). Templates travel with the project; schedules and runs stay on this machine, a missed time caught up once or skipped. A bilingual gallery of suggestions (daily to-do, chores, bills, weekly review, weekly report…). Tools `list_templates`, `create_template` / `schedule_template` (both ask the person), `run_template`, `delete_template` |
| `ctx.pet` | optional feature | `@tomradex/pet` | Pet task-state reduction, settings, renderer state and its embedded/desktop lifecycle |
| `ctx.inbox` | optional feature | `@tomradex/inbox` | A project's inbox: feedback and bug reports from the sources the project switched on wait there until a person triages them — accepts one as a ticket, merges it into one, replies, or closes it. See [The inbox](#the-inbox) |
| `ctx.mcp` | — | `@tomradex/mcp` | Projects `ctx.tools` onto MCP; plugins add prompts (`prompt`, a client's slash command) and connect-time instructions (`instruct`, for sessions without a run token) |
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
The row keeps its `config` (`builtins: false`), which a replacement may ignore.
The `model-*` provider rows offer nothing to one without `registerProvider`:
each logs a warning and loads, and the replacement's own models answer.

The shipped `completeJson` runs on the **worker** role, whichever engine holds the
conversation. Output that does not fit the schema gets one repair round with the
problem quoted back; if that still does not fit, the error names the worker
profile and the offending field. `completeJson(model, schema, request, label)` is
exported for a provider that wants the same behaviour over its own `ChatModel`.
Keep optional fields in a schema forgiving (`.catch(undefined)`), so a cosmetic
slip does not cost the whole document.

While no profile is configured, a plugin can **lend** a model for the worker
role: `ctx.llm.lend({ id, title, rank, ready, model })` returns its withdrawal
(wrap it in `ctx.effect`). The Claude Code, WorkBuddy (CodeBuddy), Codex and
Gemini CLI engines lend their signed-in CLI this way — one prompt, no tools, no
session — so planning works with a subscription and no API key. Automatic asks
the lowest `rank` that is ready (Claude Code 10, WorkBuddy 20, Codex 30, Gemini
CLI 40: the fastest first); an unranked one comes last. A CLI with no sign-in
status command can build its lent model with `cliLentModel` from
`@tomradex/engine-claude-code`: it learns the sign-in from one tiny prompt and
from each call, and `llm.lenders` shows it as still checking (`ready: null`)
meanwhile. The person can also pick a lent model for the
worker over a profile (`roles.worker: "lent:<id>"`); a picked one that is not
ready makes the call fail with the reason, never a silent switch. At most
`LENT_CONCURRENCY` lent calls run at once. `ctx.llm.worker()` says who answers worker calls
(`via: "profile" | "lent"`); `ready()` still answers for profiles only, because
a lent model has no tools to run the loop engine with.

Quick setup lives in the same plugin, so the UI knows no provider: `llm.providers`
lists the well-known ones in the reader's order, `llm.guess` reads a pasted key's
shape, `llm.quickSetup({ preset, apiKey })` checks the key against the provider's
model listing, picks a model and saves the profile first, and `llm.detect` /
`llm.adopt` offer keys exported in the shell and a local Ollama without the key
ever reaching the page.

### Model providers

A profile names its **provider**, and core builds, lists and checks it only
through that provider: `ctx.llm.registerProvider(spec)` serves the profiles
naming `spec.id` and offers its presets until disposed (or the registering
plugin unloads). The app's own are rows of `@tomradex/llm/provider`, one per
provider (`config: { provider: deepseek }`), so each is switched off like any
plugin: `anthropic`, `gemini`, `deepseek`, `kimi`, `openai`, `openrouter`,
`openai-images`, and `openai-compatible`, the catch-all for Ollama, LM Studio,
vLLM and any other compatible address. The `llm` row runs with `builtins:
false`; without it (tests, other compositions) the service registers them all
itself. A provider's `claims(profile)` moves a profile saved for another one
when the provider registers — the catch-all's profiles at api.deepseek.com,
the Moonshot hosts, api.openai.com and openrouter.ai go to their own provider
with address and key kept. An extension adds one with `models` in `inject`
(SDK 0.2.16):

```ts
await ctx.models.registerProvider({
  id: "acme",                                   // carries the namespace; profiles store it
  title: { en: "Acme AI", zh: "Acme AI" },
  baseURL: { default: "https://api.acme.example/v1", editable: false },
  presets: [{ id: "acme", title: "Acme AI", keyPage: "https://acme.example/keys", env: "ACME_API_KEY", keyShapes: [/^ak-/], prefer: [/^acme-large/] }],
  list: async ({ baseURL, apiKey }, signal) => ({ ok: true, models: ["acme-large-2", "acme-small"] }),
  build: (profile) => ({
    capabilities: { tools: true, streaming: true, json: true },
    async *chat(request, signal) {
      yield { type: "text", delta: "…" };
      yield { type: "usage", inputTokens: 12, outputTokens: 3 };
      yield { type: "stop", reason: "end" };
    }
  })
});
```

- **Presets** show in the quick setup and the profile form; a pasted key
  matching `keyShapes` picks the preset, and `env` is the variable the setup
  looks for in the shell. Their ids carry the namespace too.
- **`list`** answers the models the endpoint has (`models: null` when it has no
  listing) or `{ ok: false, status, detail }`; it doubles as the key check when
  a profile is saved. `usable(listed)` keeps the ones a profile can use, best
  first; `capabilities(model, listed)` and `defaultInput` say what a model reads
  besides text.
- **`build(profile)`** is asked synchronously when a profile is first used and
  again once it changes; the model it returns streams one assistant turn per
  `chat` (text, media, tool calls, `native` blocks it wants back in later
  requests, usage, `retry`, then `stop`). A failed request throws with what the
  provider said; Tomrade reads the words (key, quota, model, address) to tell
  the person what to fix. Each step is pulled in the plugin's scope, and the
  request it sees is its own copy.
- **`signIn`** `{ title, run({ open, signal }) }` adds a button beside the key:
  `run` shows the provider's page with `open(url)` and answers `{ apiKey }`,
  which the profile keeps. Only for a sign-in the provider allows third-party
  apps — OpenRouter's OAuth PKCE (the app's `openrouter` provider signs in so,
  through a callback on localhost that lives only while it waits), credentials
  a cloud CLI already holds — never
  a consumer subscription (Claude Pro/Max, ChatGPT Plus), whose terms keep it to
  the vendor's own apps; a signed-in CLI is used through `ctx.llm.lend` instead.
- What the spec leaves out takes the defaults: a key is required, the address
  is editable, it chats, all listed models are usable.
- **A vendor that serves chat/completions** needs no adapter of its own:
  `ctx.models.compatible({ baseURL, apiKey, model, inputModalities?,
  outputModalities?, webSearch?, body? })` — synchronous, so `build` can return
  it — is a model on the app's own OpenAI-compatible adapter (streaming, tool
  calls, retries, media, the token-field quirks). `body(json, request)` has the
  last word on each request body, for the vendor's own fields; one that throws
  fails the request with its message. `webSearch: "chat"` says the model
  searches on its own when a request asks, on chat/completions with the flag
  `body` sets (Qwen's `enable_search`, say); `"responses"` sends such a request
  to the Responses API instead; since the engine asks a searching model to
  search on every step, most of its requests then go there, and
  `responses(json, request)` has the last word on each Responses body (the
  vendor's effort scale, its token limit), as `body` has on chat/completions.
  A search the vendor refuses (400, 403, 404, 422) is remembered: the model
  stops declaring it, and later turns search through a plugin from the start.
  `headers({ url, body })`, sync or async, gives
  the headers of each try in place of `Authorization: Bearer <apiKey>`: a
  vendor's own key header (Azure's `api-key`), a token that expires (fetch it
  there, not in `build`), or a signature over the URL and the exact body sent
  (SigV4). It is asked again before every try; one that throws fails the request
  with its message. `ctx.models.listCompatible({ baseURL, apiKey, headers? },
  signal)` is the app's own `GET /models` listing, media read from it, for
  `list`; `headers` go in place of the bearer key there too.

A plugin that names `models` is labelled elevated risk (`models`): it reads
the conversations and keys of the profiles on its provider. It is shown, never
restricted. The build records the providers in `contributes.modelProviders`, and
`tomrade-plugin check` refuses one whose presets lack the namespace, whose
`list` or `build` is missing, or whose `engines.sdk` admits a Tomrade older
than 0.2.16. An official plugin that contributes `modelProviders` and is not
installed is offered beside the presets (`community.providing`): one click
installs it and opens its first preset. `tomrade-plugin test` loads the real
model seam, so a scenario can `t.models.ask(profile, prompt)` through the
provider with `fetch` stubbed.

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

## Contracts

A **contract** is a registry plugins plug into, named by the call that does it.
Its members are interchangeable — any engine can conduct a thread, any
destination can take a project's folder — and the Plugins pane groups its rows
by them. The composition declares them beside its modules:

```yaml
contracts:
  - id: engine
    title: Engines
    registry: agent.engine
```

| Contract | Registry | Rows that fill it |
|---|---|---|
| `engine` | `ctx.agent.engine` | `engine-loop`, `engine-scripted`, `engine-claude-code`, `engine-codex`, `engine-pi`, `engine-hermes`, `engine-dsh`, `engine-workbuddy` |
| `storage` | `ctx.storage.register` | `storage-git`, `storage-github` |
| `files` | `ctx.files.register` | `files` (this machine only), `files-github` |
| `webSearch` | `ctx.webSearch.register` | `web-search-tavily` |
| `modelProvider` | `ctx.llm.registerProvider` | `model-openai-compatible`, `model-anthropic`, `model-gemini`, `model-deepseek`, `model-kimi`, `model-openai`, `model-openrouter`, `model-openai-images` |
| `inboxSource` | `ctx.inbox.source` | `inbox-tomrade`, `inbox-github` |
| `inboxTriager` | `ctx.inbox.triager` | `inbox-triage` |

Unlike a module's, membership **is** declared, on the row: `implements:
[engine]`. A row switched off registers nothing, and a disabled engine is
exactly the one a person opens the pane to find. A running row is credited as
well with every registry its effects are labelled with — a registration made
through `this.ctx.effect(…, "agent.engine(codex)")` counts — so a patched-in
row groups correctly without the line. `ctx.plugins.list()` returns both as
`implements`, and `test:plugins` fails when a running row registers into a
contract its row does not declare, or declares one it never fills.

A registry that wants a contract of its own labels its registering effect
`<service>.<call>(<id>)`, as the three above do, and the composition adds a row
under `contracts`.

## The agent

`ctx.agent` is the platform every conductor runs on. It owns the threads, the
runs, the per-run ledger, cards (durable thread state such as the requirement
dossier), suspended workflows, and run-scoped undo (`oplog.undoRun`); it holds
no opinion about what to do next. Four registrations extend it, all effects:

```ts
// An ENGINE takes turns: it reads the thread, emits blocks, calls tools.
// `available()` says what stands in the way (`need`: install, sign-in, model…);
// a local agent's `setup` gives its install and sign-in commands, the only
// ones the app will run in a terminal for the person.
ctx.agent.engine({
  id: "acme", title: "Acme", author: "ai:acme",
  available: async () => ({ ok: true }),
  setup: { install: ["npm install -g acme-cli"], signIn: "acme login" },
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

A tool may ask the person at the keyboard: inside a run, `inv.ask(text, options)`
posts a permission question in the thread and resolves with the chosen option
(null when the run is cancelled). The run's wall clock stops while it waits, so a
person taking their time does not spend the agent's budget. `@tomradex/shell`
is the first-party user: its `bash` runs in the run's workstream checkout
(`inv.run.cwd`, with `inv.run.env` for credentials plugins supplied), or else the
project's Files folder, and its Shell settings section chooses `ask` (default —
every command waits for Allow once / Allow for this turn / Deny), `auto`, or
`off` (the tool is unregistered). No agent may change that section. Commands run
one at a time per run, each in its own process group; a timeout, a cancelled
run, or the command finishing stops everything it started.

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
`@tomradex/engine-claude-code`, is that prompt for Claude Code, Codex and Pi; `digest`
is how a long-running session notices the index it opened with has gone stale. A
CLI agent gets no system prompt from Tomrade at all, so `agent/prepare-brief`
(`{ projectId, itemId, filesIndex? }`) is where the same context enters the brief
`agent.prepareGeneral` hands over.

A Files provider registers `ctx.items.files({ getVersion(projectId, reference),
describe(projectId, fileIds) })` and retains the returned disposer;
`@tomradex/files` is the one shipped. `getVersion` must check project access and
return the exact `{ fileId, versionId }`, or `null`; versions must be immutable.
`describe` answers what files are behind ids right now (`FileDescription`: path,
name, mime, size, `localPath`), leaving out ids it has no file for. Registering a resolver does not grant
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
An agent cannot finish a ticket whose latest submission nobody accepted; it
relays the person's own verdict with the `review_delivery` tool instead, quoting
their words (`userSaid`). Where Tomrade can ask the person, it confirms first; the
verdict is recorded as theirs with the relay noted in its comment, and a run or
conversation that worked on the ticket is refused. Every item tool takes a key
(`TOM-12`) wherever it takes an id.

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
"Changed 15 items · Revert" one click. A CLI agent (Claude Code, Codex, Pi) is an
engine like any other: it gets the tools over MCP with a per-run token
(`ctx.mcp.bindRun`), so the ledger, the policies and the revert apply to it
unchanged. Pi has no MCP flag, so `engine-pi` (and a terminal pi session) loads a
generated session-only extension that registers the server instead; the user's
own `mcp.json` is never written. Agents that speak ACP (the Agent Client
Protocol) share one conductor, `@tomradex/engine-acp`: `createAcpEngine(ctx,
agent)` spawns the agent's ACP server on stdio, hands it Tomrade's tools as an
HTTP MCP server in `session/new`, reopens a stored session with
`session/resume` or `session/load`, and answers `session/request_permission`
for the turn's policy — Tomrade's own tools always, the person in "ask" mode,
a refusal for anything but reading in "read-only" and backlog turns. ACP has no
system prompt, so a session's first message carries Tomrade's instructions.
`engine-hermes` (`hermes acp`), `engine-dsh` (`dsh --profile acp`),
`engine-opencode` (`opencode acp`) and `engine-workbuddy` (`codebuddy --acp`,
also the copy inside the WorkBuddy app, run by that app's Electron binary) are
thin descriptions on top of it. An
engine that runs only inside Tomrade sets `terminal: false`, and Start offers
it no terminal session; the reverse, `terminalOnly: true`, is a CLI Tomrade only
ever starts in a terminal (Antigravity CLI from `@tomradex/engine-terminal`, Cursor from `@tomradex/engine-cursor`):
Start offers it no in-app run, the panel never conducts with it, and Code
link's command template hands it a session-only MCP config. An engine that runs
on the model profiles set up in Tomrade (the loop, the built-in agent) sets
`usesModels: true`: a failed turn's key or model error then points to model
settings, while any other engine's points to its own sign-in or settings. A binding may also carry `event(payload)`: whatever is POSTed to
`/sessions/<token>/event` on the MCP server — a coding agent's hooks reporting
it started, stopped or is waiting — reaches the binding that owns the token.
Hooks a repository commits for every developer carry no token; they post to
`/sessions/event`, and `ctx.mcp.onEvent(listener)` hears them with the `cwd`
and `session_id` the payload carries.

A session Tomrade did not start reaches the backlog only when the person wants
it to. `ctx.mcp.prompt({ name, description, render })` offers a prompt each
session renders for its own project (Claude Code lists it as
`/tomrade:<name>`); Code link's `sync` is the one that brings a session's work
back — matching it to tickets by key or search, then linking code, moving
status and filing follow-ups, with unmatched work left alone.
`ctx.mcp.instruct(render, { order })` adds a paragraph to the instructions a
client reads on connect, lowest `order` first (Claude Code keeps 2048
characters); run-bound sessions skip them, since their run already has a brief.
The project's rules travel this way, first: inline when short, otherwise as a
pointer to `get_project_rules`. Codex files instructions as notes on the
server's tools rather than orders, so Connect's AGENTS.md section has it call
`get_project_rules` before its first reply.

An engine declares **capabilities**: `backlog` (the default) talks to the app
through its tools; `code` also edits files and runs commands in a repository.
Only a local coding agent (Claude Code, Codex, Pi, the ACP agents) declares `code`, and only such
an engine is offered when a ticket is started — the in-app loop never
implements a ticket. A thread started from a ticket carries `itemId` and
`branch`; its turns arrive with `purpose: "code"` and a `ticket`, run in a
worktree on that branch (`Repos.workdirFor` with the branch), and get the code
wall clock (`AgentConfig.codeMaxWallMs`, hours) instead of a conversation's
(`agent.maxRunMinutes`, Settings → Assistant, 15 minutes by default). The
platform emits `agent/run-started` and `agent/run-ended` for whoever follows
runs; `ctx.agent.activeRuns()` is what a quit would interrupt.

A turn that stopped on a usage or rate limit returns `stop: "error"` with
`limit: { until }` (epoch ms, or null when the engine did not say); an error
whose words read as a limit ("429", "usage limit", "try again in 2 hours") is
treated the same, its reset time read by `resetTime()`. The thread is then
**parked** on this machine (`ctx.agent.parked()`, emitted as `agent/parked`):
at `until` the platform sends the thread a continue message — at most three
limited runs in a row, and only while `agent.resumeAfterLimit` is on — or
emits `agent/limit-lifted` so the person can be told. Whoever continues the
thread first ends the wait; `ctx.agent.park()` / `unpark()` let a plugin do
the same for work Tomrade cannot type into, such as a terminal session.

### The troubleshooter

`@tomradex/doctor` (`ctx.doctor`) looks into a failure when someone asks it to.
They ask from **Troubleshoot** under a failed turn, from the bottom bar, or
from the palette. Its own engine, `doctor`, runs the troubleshooting threads
(`surface: "doctor"`, listed in the panel beside the assistant's). The engine
declares no capabilities, and an engine with none conducts only the threads its
plugin opens, so no picker, Start dialog or setup check counts it.

Each turn does these things in order:

- It runs the checks and posts a `checklist` card (`ChecklistCard`), which the
  panel redraws as each row settles.
- It runs one real **test turn** on the failing engine, in a `probe` thread
  that nobody sees and that is deleted afterwards.
- It matches the known issues against what it found.
- It ends with `finding` cards (`FindingCard`): a headline, how sure it is,
  and `CardAction` buttons — `install`, `sign-in`, `settings`, `retry-with`
  (move a thread to another ready agent and send its last message again),
  `say` and `report`. The backend writes every label; the panel knows the
  verbs, so a plugin never ships UI for them.

An engine tells the troubleshooter about itself through
`Engine.diagnostics`. Only these are read; no agent gets any other file.

- `logs()`: the agent's own log files, newest first. A report carries their tail.
- `facts()`: short strings that tell one setup from another (edition, endpoint,
  models offered). An ACP agent declares them on its `AcpAgent`, and the
  conductor adds the models it offers.

A plugin adds its own checks with `ctx.doctor.check({ id, title, applies?, run })`
and known problems with `ctx.doctor.issue(KnownIssue)`.

A known issue is data only. It is matched by engine, by a pattern in the
error, or by a fact. It has a `fixedIn` release, from which it stops matching.
What it offers can only name the verbs above, so a catalog fetched later can
explain and point, but never run anything.

When something is left to explain, the last card offers **Let an agent look
into it**. The offer lists the other ready agents, never the one that failed,
and says before anyone is picked that what the agent reads goes to its model
provider. The picked agent is remembered on the thread (`investigator`), and
from then on the person talks to it there.

The troubleshooter hands each turn to that agent's own engine with these
changes:

- The first message is a brief: the job, the house rules, the error, the
  checks, the facts and the log excerpts.
- The agent works as a backlog turn.
- It holds only the investigation's tools:
  - `doctor_read_log` reads only declared logs.
  - `doctor_check_again` runs the checks and a test turn.
  - `doctor_conclude` records the cause, how sure, and which verbs to offer.
  - `ask_user`, `web_search` and `web_fetch`.

  Any other tool is refused.
- The agent's session id is kept per troubleshooting thread, so it carries on
  from where it stopped. *Check again* still checks.

The conclusion becomes a `finding` card and joins the report.

A tool can be kept to one kind of conversation with `ToolDefinition.surface`.
The in-process agent then lists it only on threads of that surface. The MCP
server still serves it, so a local agent investigating can call it, and the
tool refuses calls from anywhere else.

`ctx.doctor.report()` builds the text the person reads, section by section,
before anything is sent. Keys, the home folder's name and email addresses are
masked, and the failed conversation is left out unless ticked.
`ctx.doctor.send()` writes the report to the outbox first, then submits it
through the signed-in account (`tomrade_submit_diagnostic_report`). A report
that can't go now is retried while the app runs.

The maintainer works through the reports with `tomrade-store diag`:

- `diag import --project <id>` turns new reports into TOM tickets through a
  running Tomrade's MCP, one ticket per fingerprint.
- `diag reply` and `diag status` answer one report, or every report on a
  ticket (`--ticket TOM-N`), with `--in 0.7.0` saying which release fixes it.

Feedback, ideas and bugs nobody troubleshot go the same way:
`ctx.doctor.sendFeedback(kind, text)` (`kind` is `bug`, `feedback` or `idea`)
sends what the person wrote and the app's version and system, nothing else, and
the report carries its `kind`. The in-app **Feedback** entry (the bottom bar and
the palette) belongs to `@tomradex/inbox-tomrade`.

The sender sees the status, the reply and the fix in **Settings → About → My
reports**. Meanwhile the bottom bar says a reply came, until it has been read.

Known issues also come from a catalog at `catalogUrl` (default
`https://tomrade.com/known-issues.json`, `{ version: 1, issues: [...] }`):

- It is read at most every six hours and cached under the data folder.
- Each entry is validated on its own: a bad one is dropped, never the whole
  file.
- An entry with the same id replaces the bundled one's wording.

So a newly understood problem reaches everyone without a release.

## Events

Events are the policy layer. `emit` announces; `waterfall` decides — a listener
receives `(...args, next)` and either calls `next()` to delegate or throws to
refuse. Listeners on `write/pre-commit` must be synchronous: the commit runs
inside a SQLite transaction.

| Event | Mode | Purpose |
|---|---|---|
| `write/pre-commit` | waterfall | Refuse or allow a mutation before it lands. `WriteIntent` carries `entity`, `op`, `id`, `by`, `baseVersion`, `before`, `after`, `patch`. Extensions reach it with `items.gate`. |
| `write/committed` | emit | A durable fact: the rows and the oplog entry exist. |
| `tools/pre-execute` | waterfall | Refuse or allow a tool call, first-party or plugin, whoever invokes it. `ToolCall.run` is present when it belongs to an agent run. A listener may replace `call.args` (the tool runs with them once they pass its input again) or return a result without calling `next()`, which answers in the tool's place. Extensions reach it with `tools.gate`. |
| `tools/result` | emit | The outcome of a tool call, success or failure. |
| `settings/changed` | emit | Settings were saved; providers re-read. |
| `agent/event` | emit | Main-process agent lifecycle stream. Receives `(threadId, AgentEvent)`; feature plugins subscribe here instead of observing renderer IPC. |
| `agent/request` | waterfall | Each model request an in-app engine is about to send: `{ system, tools, messages, turn }`. Change it before or after `next()`; what comes back is sent. |
| `agent/request-error` | serial | A model request failed: `{ error, request, attempt }`. The first listener to answer `{ request?, profile? }` has it sent again — changed, on another model profile, or both. |
| `agent/turn-stopping` | serial | An in-app turn is about to end: `{ text, turn, continued }`. The first listener to answer `{ continue }` keeps it going with that message to the model. |
| `agent/cli-hook` | serial | A CLI agent's hook reached Tomrade: `{ event, agent, answerable, projectId, sessionId, ticket, cwd, tool?, text?, raw }`. The first listener to answer `{ deny?, context?, continue? }` decides; it reaches the agent when `answerable`. |

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

### Policies

An extension sets policies with the reach the app's own have (SDK 0.2.12, so
`engines.sdk` `^0.2.12`). Both reach every engine and client: every write and
every Tomrade tool call passes these two waterfalls.

- `ctx.items.gate(check)` runs on `write/pre-commit` for every write — an item,
  a workstream, a view; a person's, an agent's, another plugin's. `check` gets
  a copy of the pending write — `{ projectId, entity, op, id, by, via, runId,
  baseVersion, before, after, patch }` — and throws to refuse it; the error
  reaches whoever wrote. It is asked inside the write's SQLite transaction, so
  it answers at once: a check that returns a Promise is not waited for, and the
  write goes on with a warning in the log.
- `ctx.tools.gate(check)` runs on `tools/pre-execute`. `check` gets `{ name,
  args, author, projectId, runId }`, with a copy of the arguments, and may throw
  to refuse the call, return nothing to let it through, return `{ args }` to go
  on with other arguments — checked against the tool's input again, so a gate
  cannot hand a tool what it would refuse from a caller — or `{ result }` to
  answer in the tool's place without running it. Gates run in the order their
  plugins loaded, each seeing the arguments the one before it chose.

Both return disposers and go with the plugin. `tomrade-plugin test` puts a
plugin's gates in front of its scenario's `updateItem` and `tool` calls.

```ts
await ctx.items.gate((write) => {
  const patch = write.patch as { status?: string } | null;
  if (write.entity === "item" && patch?.status === "done" && write.by !== "human") throw new Error("Only a person closes a ticket here");
});
await ctx.tools.gate((call) => (call.name === "list_items" ? { args: { ...(call.args as object), limit: 20 } } : undefined));
```

### Hooks in the agent's loop

The conversation Tomrade runs itself (`engine-loop`, the in-app assistant)
passes three hooks, as a DeepSeek Harness agent passes its own. CLI agents —
Claude Code, Codex, dsh, OpenCode and the rest — run their own loop in their
own process and send nothing through them; their own hooks reach plugins as
[Hooks in CLI agents](#hooks-in-cli-agents), and what reaches every engine is
[Policies](#policies), since their calls to Tomrade's tools and every write
still pass `tools/pre-execute` and `write/pre-commit`.

| Hook | Engines | What a plugin can do |
|---|---|---|
| `agent/request` | `engine-loop` | Change each request's system prompt, tools and messages before it is sent. |
| `agent/request-error` | `engine-loop` | Have a failed request sent again, changed or on another model profile — at most twice a step. |
| `agent/turn-stopping` | `engine-loop` | Keep a turn going with a message to the model until its own condition holds — at most three times a turn, within the step budget; the conversation says a plugin kept it going. |

Extensions reach them with `ctx.agent.request(hook)`, `ctx.agent.requestError(hook)`
and `ctx.agent.turnEnding(hook)` (SDK 0.2.14, `inject: ["agent"]`). A hook gets
a copy and answers what to change — `{ system?, tools?, messages? }`,
`{ request?, profile? }`, `{ continue }` — or nothing. One that throws or takes
longer than ten seconds is logged and passed over: a plugin never ends the
turn. Built-in and full-mode plugins listen on the events themselves; one that
throws is passed over the same way.

```ts
await ctx.agent.request((request) => ({ system: `${request.system}\n\nAnswer in the person's own words.` }));
await ctx.agent.requestError((failure) => (failure.message.includes("overloaded") ? { profile: "backup" } : undefined));
await ctx.agent.turnEnding((ending) => (ending.continued === 0 && !ending.text.includes("tests pass") ? { continue: "Run the tests before you finish." } : undefined));
```

### Hooks in CLI agents

The CLI agents Tomrade works with — Claude Code, Codex, DeepSeek Harness and the
rest — run their own loop, but their hooks already report to Tomrade: in a
session Tomrade starts, through the session's own token (Claude Code and
WorkBuddy with `--settings`, Pi through its session extension, dsh through its
own Claude Code hook bridge, which the session's `--patch` turns on); in a
repository Tomrade connects, through the hooks committed there. A plugin hooks
into all of them at once, with one shape whichever agent sent the event:

```ts
await ctx.agent.cliHook({
  events: ["pre-tool"],      // session-start, prompt, pre-tool, post-tool, stop, session-end; all when left out
  tools: "^(Bash|bash)$",    // a regular expression on the tool's name
  agents: ["claude-code", "dsh"],
  handle: (call) => (JSON.stringify(call.tool?.input).includes("rm -rf") ? { deny: "Not in this repository." } : undefined)
});
```

`call` carries the event, the agent, the project, Tomrade's code session and
its ticket, the working directory, the tool (name, input, and output or error
after it ran), what the model said last at `stop`, and the hook's own payload.
An answer — `{ deny }` before a tool, `{ context }` at a session's start, a
prompt or after a tool, `{ continue }` when a turn stops — goes back in Claude
Code's hook output, which each agent that answers reads. `call.answerable` says
whether it will be acted on:

| Event | Acts on the answer, in sessions Tomrade starts | Heard only |
|---|---|---|
| `session-start`, `prompt` | Claude Code, WorkBuddy, DeepSeek Harness | Pi, Codex, Cursor, OpenCode, Hermes |
| `pre-tool`, `post-tool` | Claude Code, WorkBuddy, DeepSeek Harness, Pi | Codex, Cursor, OpenCode, Hermes |
| `stop` | Claude Code, WorkBuddy, DeepSeek Harness | Pi, Codex, Cursor, OpenCode, Hermes |
| `session-end` | — | all of them |

A connected repository's hooks are heard only — they post without a token,
and nothing is read back — and an event a started session already reports
through its token is not heard twice. Gemini CLI and Antigravity report no
hooks, so none reach them. `CLI_HOOK_COVERAGE` in the SDK is this table, and a
plugin's detail in the Plugins pane shows it for the events the plugin hears
(its build records them in `contributes.agentHooks`).

Tomrade's own answer comes first: a tool it refuses (a push after the
repository's credentials failed) stays refused, and a plugin's context sits
beside its own. The agent waits five seconds for the answer, so a plugin's hook
has three; one that throws or runs out is logged and passed over. Hooks go
with the plugin: nothing is written into an agent's or a repository's files
for them.

### Local agents

A coding agent installed on the person's machine — a CLI like Hermes, OpenCode
or Cursor's — can be added by an SDK plugin without writing an engine. The
plugin describes the agent and Tomrade's own conductor (the `local-agents`
row, `@tomradex/engine-acp`) runs it exactly as it runs the agents the app
ships: the CLI is found where a person would look (their chosen path in
Settings, PATH, a login shell's PATH, npm's prefix, WSL, a copy inside a
desktop app), sessions run over the Agent Client Protocol with Tomrade's tools
handed over as an MCP server, and its picks, kept model list, availability and
troubleshooter facts behave like any built-in engine's. SDK 0.2.17, `inject:
["agent"]`, `"engines": { "sdk": "^0.2.17" }`:

```ts
await ctx.agent.localAgent({
  id: "acme",                       // the engine id; settings live under engines.acme
  title: "Acme",
  cli: { name: "acme", bundled: (host) => [{ file: "/Applications/Acme.app/Contents/Resources/cli/acme" }] },
  install: "install Acme ({install}) and sign in",
  setup: { install: [{ script: "https://acme.example/install.sh" }, "npm install -g acme-cli"], signIn: "acme login", signInRuns: true },
  options: z.object({ command: z.string().default("acme"), model: z.string().optional() }),
  acp: {
    permissionModes: { default: "full-access", choices: [PERMISSION_CHOICES["full-access"], PERMISSION_CHOICES.ask] },
    args: (options) => ["acp"],
    mode: (policy) => (policy === "full-access" ? "bypass" : "default"),
    usage: "turn",
    terminal: true                  // code link can also hand it a ticket in a terminal
  },
  probe: { args: ["models"], says: (output, catalog) => null, reason: "" },
  mcpLink: { cli: { file: () => "~/.acme/mcp.json", configuredUrl: () => null, add: (url) => ["mcp", "add", "tomrade", url], remove: () => ["mcp", "remove", "tomrade"] } },
  lend: {
    rank: 60,
    async ask(request, io) {
      const run = await io.cli.run(["-p", `${request.system}\n\n${request.transcript}`], { cwd: os.tmpdir(), signal: io.signal });
      if (/not logged in/i.test(run.stderr)) throw new NotSignedIn("Acme is not signed in — run `acme login`");
      return { text: run.stdout.trim(), inputTokens: 0, outputTokens: 0 };
    }
  }
});
```

- **`acp`** present: an in-app engine over ACP — `args` starts its ACP server
  on stdio, and the rest names its quirks (`mode` per policy, where it reports
  tokens, how a session reopens, how it takes a message mid-turn, its own words
  for a refused turn). Absent: an agent with no ACP that Tomrade starts only in
  a terminal (`terminalOnly`), handed the ticket and heard over its user-level
  MCP connection; `picks` are its Model and Effort picks.
- **`mcpLink`** is the agent's own user-level connection to Tomrade, shown and
  switched in Settings → Assistant: either `{ status, connect, disconnect }`
  the plugin manages (each answers the link's state), or `{ cli: { file,
  configuredUrl, add, remove } }`, run through the agent's own `mcp add` /
  `mcp remove`.
- **`setup.install`** lists install commands, the recommended one first. An
  installer script is named by its address (SDK 0.2.18): `{ script: url }`
  runs as `curl -fsSL <url> | bash`, `{ powershell: url }` as
  `irm <url> | iex`. The app writes the command, so plugin code carries no
  download-and-run of its own (the store's checks refuse that); `{install}` in
  `install`, the words after "not found —", stands for the first command.
- **`lend`** lends its sign-in to the worker for one-shot calls, ready only
  while the agent is available and signed in; throwing `NotSignedIn` marks it
  signed out until it is checked again.
- Callbacks get `io`: `io.cli` runs the CLI as Tomrade found it (`run` to its
  end, `jsonl` reading JSON lines), `io.mcp` is Tomrade's MCP address and the
  hooks' event address, and `io.options` the person's settings for it.

What the core asks at once (`args`, `mode`, a usage reader…) runs in the
plugin's scope: a throw from `args` or `env` fails that turn, one from the
others reads as "no answer". What it awaits is held to its time. The engine,
its link and its lent model go when the plugin unloads. An agent the app still
ships under the same id keeps its place, and the plugin's copy stays off.

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
write; `undoRun` still consumes a run's rows outright, then asks every provider
that implements `undoRun` to take back what that run did there.

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

A provider that knows which run made each record can also implement
`runChanges(projectId, runId)` — what the run changed there, for the count and
list under the run in the assistant panel — and `undoRun(projectId, runId)`,
synchronous like the backlog's, which reverts them newest first and returns
what it had to keep, with the reason. `@tomradex/settings` does both for the
settings an agent changes (below); a provider without them stays out of the
run's count and its Undo.

## Tools

```ts
ctx.tools.register(defineTool({ name, title, description, input: z.object({...}), execute(args, invocation) }));
```

Names are global and unique. `execute` receives validated `args` and
`{ by, projectId, run?, signal?, ask? }`; use `inv.by` as the author of any write,
`inv.projectId` as the default scope, and `inv.run` (present inside an agent
run) for the ledger and run-scoped state. `inv.signal` aborts when the caller
stops waiting — the run was cancelled, or an MCP client withdrew the call — and
a tool that waits on a process or a network should stop with it. A registered tool appears on every
surface at once: engines see it via `io.tools.describe()`, and each MCP
session registers it under its own name — the server name is the namespace.
There is no per-surface code to write. The one exception is `mcp: false`: the
MCP server (any local client, Claude Code and Codex included) never lists or runs
such a tool, so only engines in this process reach it — the shell is one.
`readOnly: true` marks a tool that only reads; MCP lists it with `readOnlyHint`,
which lets Codex run it without asking. A tool may return a string as well as a
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

### Web search

`@tomradex/web-search` (`ctx.webSearch`, module `webSearch`) offers every
engine two tools, MCP included: `web_search` (query, up to 10 results, `news`
topic, a time range, sites to include or leave out) and `web_fetch` (up to five
http(s) pages as Markdown, optionally narrowed to the passages about a query).
Both return text an agent can cite, framed as information from the open web
rather than instructions. The module answers nothing itself; providers do:

```ts
ctx.webSearch.register({
  id: "tavily",
  title: "Tavily",
  unavailable: () => (key() ? null : "…tell the user to add one in Settings → Tavily"),
  search: (request, signal) => …,  // { results: [{ title, url, content, published? }] }
  read: (request, signal) => …     // optional: { pages: [{ url, content }], failed: [{ url, error }] }
});
```

The first registered provider that is not `unavailable()` answers; when none
is, the first one's reason is the tool's error, so the agent can tell the
person what to set up, and a conversation in Tomrade gets one card saying how
(pointing at the provider's `settings` pane). `web_search` is always there for
Tomrade's own agent and is served over MCP while any provider is registered;
`web_fetch` exists while one of them can `read`. A model that searches the web
on its own (`capabilities.nativeWebSearch`) is not offered the module's
`web_search` at all. A search is stopped after 30 s and a read after 60 s,
and either stops with the caller's `signal`. `ctx.webSearch.search()` and
`read()` are the same calls for plugins that search on their own.

An extension provides one the same way with `webSearch` in `inject` (SDK
0.2.9): `ctx.webSearch.register(…)` takes the same shape, its id carries the
namespace, `search` and `read` are called back in the plugin's scope with the
caller's `signal`, and `unavailable()` is asked synchronously, so it must
answer at once; one that throws reads as unavailable with the error. The
provider goes when the plugin unloads. `tomrade-plugin test` loads the real
module, so a scenario can `tool("web_search", …)` through its provider.

`@tomradex/web-search-tavily` is the provider the app ships: its `tavily`
section holds the API key (a password field, so machine-scoped and out of every
agent's reach; empty falls back to `TAVILY_API_KEY`) and the search depth
(`basic`, or `advanced` at twice the credits).

### The inbox

`@tomradex/inbox` (`ctx.inbox`) is a project's inbox. A **source** is where
feedback comes from — Tomrade's own reports, GitHub issues, later mail — and a
plugin registers one with `ctx.inbox.source({ id, title, keyPattern?,
available?, pull, reply?, setStatus?, options? })`. Each project switches its sources on
by itself (the inbox's Sources pane); nothing is pulled from a source a project
did not choose.

- `pull({ projectId, since })` returns what arrived since an epoch-ms cursor:
  `{ externalId, url?, kind?, reporter?, title, body?, attachments?, receivedAt }`.
  One entry is kept per `(source, externalId)`, under an id both machines
  derive alike, so pulling twice — here or on another machine — changes
  nothing. A source that leaves some of what it read out returns
  `{ entries, cursor }` to say where the next pull starts, and may add
  `activity: [{ externalId, at }]` — a comment or reopen at the source on an
  entry already triaged. Nothing is done about it on its own: the entry shows
  **New activity** until a person marks it seen (`seen`) or reopens it.
- `available(projectId)` is null when the source can pull here, or why not,
  in the person's words ("sign in first").
- `setStatus(entry, change)` hears each triage — accepted or merged with the
  ticket's key, closed as `wontfix` or `duplicate` (with the entry it
  duplicates, when one was named), reopened — and `shipped` with the release
  once `ctx.inbox.ship(projectId, entryId, version)` says the ticket went out,
  so whoever wrote sees it where they wrote. A change it could not take waits in a
  machine-local outbox and is tried again before every pull.
- `reply(entry, text)` carries an answer, when the source can.
- `options` are per-project switches the source reads with
  `ctx.inbox.option(projectId, sourceId, optionId)`; each has a `default`
  until the project changes it in the Sources pane.

Pull only: the backlog is never mirrored back to a source. Triage is a
person's: accepting makes a ticket through the ordinary write path, with the
entry quoted and linked in its body, and two select fields the inbox makes the
first time — **Source** and **Kind** (`bug`, `feedback`, `idea`) — beside a
saved table view of such tickets, made once. Merging counts the entry on the
ticket it names. The derived field `feedback` is how many entries a ticket
holds, and the ticket's **Feedback** section lists them. Entries and their
triage travel with the project; where each source was read up to stays on the
machine that read it.

A **triager** proposes triage; one is active at a time, registered with
`ctx.inbox.triager({ id, title, available?, suggest })`. `suggest(entry,
{ projectId, canReply, entries })` returns a suggestion — `accept` (with the
`kind`, `priority` and `title` a ticket would get), `merge` into the ticket it
repeats (`itemId`), or `duplicate` of another untriaged entry (`duplicateOf`) —
with a one-sentence `reason` and a draft `reply` when the source takes one.
The inbox asks about up to 20 new arrivals per pull in the background, one at
a time, and on demand (`ctx.inbox.suggest`); a suggestion naming a ticket or
entry that is not there becomes a plain accept, and one that failed keeps its
reason on the entry (`suggestError`) and blocks nothing. Suggestions travel
with the entry. Nothing is triaged until a person confirms:
`ctx.inbox.adopt(projectId, entryId, { reply? })` runs the triage as
suggested and then sends the draft (or the `reply` given; `false` sends none)
— a reply that fails leaves the triage done and says why (`replyError`).
`@tomradex/inbox-triage` is the triager the app ships: one worker-model call
per entry, shown the nearest tickets and untriaged entries by word overlap.

The renderer reaches it over `inbox.list` (a status, `all`, or `activity`),
`inbox.sources`, `inbox.setSource`, `inbox.setSourceOption`, `inbox.refresh`,
`inbox.accept`, `inbox.merge`, `inbox.close`, `inbox.reopen`, `inbox.seen`,
`inbox.reply`, `inbox.triager`, `inbox.suggest` and `inbox.adopt`, and hears
`inbox.changed`. Its sidebar module opens the
inbox and counts what waits: untriaged entries and those with new activity.

`@tomradex/inbox-tomrade` is the source for Tomrade's own reports. It pulls
for an account named in `tomrade_maintainers` (`tomrade-store maintainer add
<email>`), through `tomrade_feedback_pull` and `tomrade_feedback_answer`,
which see a report's code and never its sender; a triage here becomes the
status, ticket and reply the sender reads under My reports.

`@tomradex/inbox-github` is the source for the issues of a project's GitHub
repositories, through the machine's GitHub account (`ctx.github`). The first
pull takes the open issues; later ones take new issues, and comments and
reopens by anyone but that account as activity. It answers on the issue: a
comment when an entry is accepted, merged, closed or shipped (`comment`, on
by default) and, only once a project switches `close` on, closes it —
`completed` when shipped, `not_planned` when not done or a duplicate, with
"Duplicate of #N" pointing at the main issue. Shipped means the ticket is
done and the earliest published, non-prerelease GitHub release of the
repository it was merged into contains its pull request's merge commit (or
code-link's merged commit). Writing needs Issues access: a personal access
token with the `repo` scope, or the Tomrade GitHub App with the Issues
permission.

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
sidebar's Backlog module (under Workstreams) and the Fields sheet.

A workstream may **stand for a code repository**: `Board.repoId` names a row of
`ctx.repos` (shared with the project — the remote URL is its identity) and
`Board.repoPath` a folder inside it. Where that repository is checked out is
this machine's alone (`ctx.repos.selectCheckout(remote, dir)`, verified against
the folder's origin). If the selected folder is not that checkout, the UI offers
a separate explicit `ctx.repos.cloneInto(remote, branch, dir)` action which clones
into a repository-named child of the selected folder; Tomrade never overwrites the
selected folder's contents. A repository can also be added from a folder
(`ctx.repos.addFromFolder(projectId, dir)`, which only reads it): a folder with
an origin is added by that origin, reusing a row that names the same repository
under another spelling; a folder with no origin becomes a **local repository**
whose identity is its path. Code link then probes and pushes nothing, the agent
hands its branch over with `link_code` (no pull request), and merging into the
local default branch finishes the ticket. When such a folder later gains an
origin, the next scan adopts it as the row's remote (`ctx.repos.adoptOrigins`);
the row keeps its id. A
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

A plugin may add a **derived** field: a read-only number it computes from its
own tables in the project's file. `ctx.fields.derive({ id, name, names?, unit?,
values, expr })` lists it with the built-ins (`derived: true`, filterable and
sortable, never groupable or written). `values` is `SELECT item_id, value …`
over every item that has one; `expr` is the same value as a scalar subquery
over the item aliased `i`, which `items.query` filters and sorts on. The two
must agree. Items read over IPC carry the value in `fields`, so the renderer's
evaluator sees it too; items the service hands to writes, undo or export never
do. The agent plugin derives `cost`: the summed `costUsd` of every run of every
thread started from the ticket.

`items.query` takes the same `FilterClause[]` / `SortKey[]` a view stores. A
clause is `{ field, op: "in" | "not-in" | "contains" | "gte" | "lte", values }`,
and a `null` value means empty; empties sort last whichever direction. The
renderer evaluates the same shapes over its cached list with the pure functions
in `@tomradex/domain` (`matchesFilter`, `compareItems`), and a parity test in
`packages/items` keeps the two implementations agreeing. Agents reach all of it
through `list_fields`, `create_field`, `list_items` (`filter` / `sort`) and
`update_item` (`patch.fields`). Both `items.list` and `items.query` also take
`search`: terms that must all appear in title or body, matched as substrings in
any script over an FTS5 trigram index (`items_fts`, kept in step by triggers;
a body's `tomrade-file://` links are left out of it) and returned most relevant first, after any explicit sort. A term is a word, or
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
  namespace is not offered as a choice. Add `private: true` for rows meant
  only for the people the project is shared with, such as conversations: the
  namespace is unticked, and kept off, while the project's remote is known to
  be public (a provider's `visibility` says so), and this machine's rows are
  never replaced by what such a remote holds.
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
  credential: () => ({ url: "https://git.acme.dev", helper: "!acme-credential" }),
  async ensureRemote(c) { /* create it */ },
  async browse() { return [{ label: "acme/app", config: { project: "acme/app" } }]; }
}));
```

`register` is an effect. `configSchema` is rendered from `z.toJSONSchema()` so a
provider ships no UI code; a `format: "password"` field is **refused at
registration** — credentials belong in a `ctx.settings` section named in
`settingsSection`, collected inline through `connection` where the remote is
chosen. The URL `toRemote` returns never carries the secret: `credential()`
names a git credential helper for a URL prefix, which Tomrade passes to each of
its own git commands as `-c credential.<url>.helper=` (clearing the user's own
helpers for that prefix) and then the helper — nothing is written to the
folder's git config. Return null while no account is connected, and the user's
own credentials (SSH keys, keychain) are used. A remote whose URL still names a
credential for the same repository is cleaned whenever it is used.
A connection may also offer `signIn()` (with `prompt.signIn: { name }`): the
panel shows that first and keeps the secret as the fallback. `status()` then
reports `pending: { code, url, expiresAt }` while the person finishes in the
browser — the panel shows the code and polls — and may carry
`action: { label, url, needed }` for a step outside Tomrade, such as choosing
which repositories an App may use; `disconnect()` also calls off a sign-in.
`browse()` and `draft(name)` remove typing. `@tomradex/storage-git`
registers `git` (any URL); `@tomradex/storage-github` adds discovery and
creation on top, with the account and helper of `ctx.github`
(`@tomradex/github`: `token()`, `api`, `connection`, `credential()`, and the
per-checkout helper code links opt into). Its connection signs in to the
Tomrade GitHub App by the device flow when the row's `clientId` is set — no
client secret ships, and the short-lived token is renewed in the main process,
its renewal token kept encrypted with the OS keychain (`safeStorage`) — and
keeps the personal access token as the fallback: while both exist the sign-in
is used, and if it can no longer be renewed or is revoked the token takes over.
Git outside the app reads the current token through the helper, from a `0600`
file beside the settings that holds only the short-lived one.

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
| `ctx.storage.restores()` | Projects the Hub's catalog names that are not on this machine, each with its restore state |
| `ctx.storage.restoreMissing()` | The automatic path (boot, Hub sync, account sync): clone or adopt what is missing, one at a time |
| `ctx.storage.restore(projectId)` / `locate(projectId, dir)` | Retry one now; open the folder holding a project that has no remote |
| `ctx.storage.removeFromHub(projectId)` | Take a project this machine lacks out of the catalog for every machine; deletes nothing |

Restore states: `queued`, `restoring` (step `contacting` / `downloading` /
`opening`), `offline` and `unpublished` (retried with backoff),
`needs-connection` (retried when the provider's account connects),
`needs-provider` (retried when the provider registers), `not-backed-up` and
`failed`. A clone lands in `projects/.restoring-<id>` and moves into place only
after it has been read whole and its id checked; a copy already under
`projects/` that is a checkout of the same remote is adopted and synced instead
of cloned again. A project removed on this machine is never brought back.

Events: `storage/registered`, `storage/unregistered`, `storage/synced`,
`storage/imported`, `storage/restored`; the renderer hears
`storage.changed(projectId)` and `storage.restoresChanged()`.
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
  credential: () => ({ url: "https://drive.acme.dev", helper: "!acme-credential" }),
  async ensureRemote(c) { /* create it */ },
  async browse() { return [{ label: "acme/docs", config: { space: "acme/docs" } }]; }
}));
```

`register` is an effect and refuses a `format: "password"` field, as
`ctx.storage` does: the config is per project and travels in the project's
folder (`plugin_files_remotes`, exported `always` — it is not a What-travels
choice), so a teammate who clones the project clones the files beside it. Credentials belong in a settings section named in
`settingsSection`, collected inline through `connection`, and reach git through
`credential()` exactly as a storage provider's do. `createGitBackend`
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

The project's own repository (a `dedicated` folder) may hold the files in a
folder of it, but not at its root, where `.tomrade/` lives, nor in `files/`:
the project's checkout pulls what Files publishes, and there it would land in
the store's own working tree, where two repositories would commit the same
files (local-only ones included). `bind` throws `ProjectRepositoryError` for
such a target, and a `createGitBackend` store bound there earlier reports the
same error instead of syncing. Another branch of the same repository is fine. A backend that is not built on `createGitBackend` opts in by
implementing `repository(config)` and asking `projectRepository()` from its
open options before each sync.

A ticket's files land in a top-level folder named after its workstream:
`ctx.files.folderFor(projectId, itemId)` is that name (separators become `-`),
`importFor(projectId, itemId, { sources, role })` copies files from this machine
into it and pins them, and `write_file` with an `itemId` places its path under
it. This is the Files side of "which workstream, which folder" in a monorepo:
the code lives in the workstream's `repoPath` of its repository, the documents
about it in `<workstream>/` of the project's Files. It is a default and a name,
not a binding — renaming a workstream starts a new folder and moves nothing,
and any explicit path is honoured as given.

A ticket's description is Markdown, and the files it shows are linked by id —
`![name](tomrade-file://<fileId>)`, or `[name](…)` for anything that is not a
picture — so a rename or a move in Files never breaks the link and never
rewrites the body (`linkedFileIds(body)` in `@tomradex/domain` reads them back).
The editor holds pasted files until the body is saved, then hands every one the
text still links to `ctx.files.addAttachments(projectId, itemId, files)`: they
land in `<workstream>/attachments/<KEY>/` as one version and one step of ⌘Z, a
taken name gets a number (`截图 2.png`), and anything over the 8 MB binary read
limit is refused whole. `readById(projectId, fileId)` reads a file wherever it
has moved, null when it is not on this machine (deleted, or not synced yet).
`get_item` adds `attachments` — the linked files as `describe` sees them — when
a body links any. Attachments are not delivery inputs; pinning one stays a
deliberate act.

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
wins, and `FileEntry.listing` reports the effective mode beside `sync`. One
default is built in: `<workstream>/attachments/` is unlisted (source `default`),
since a ticket's attachments reach an agent through `get_item`; a rule at or
below that folder lists it again. An unlisted path is left out of the index, out of `list_files` and out of a
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
| `ctx.files.addAttachments(projectId, itemId, [{ name, base64 }])` | Save files a ticket body links under `<workstream>/attachments/<KEY>/`, one version; returns their `FileDescription`s in order |
| `ctx.files.readById(projectId, fileId)` / `describeFiles(projectId, fileIds)` | A file's latest content wherever it moved, or null; the resolver's descriptions |

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
with `format: "password"` is masked, `format: "directory"` gets a folder picker
and `format: "audio"` a picker for one sound file. A field marked
`.meta({ advanced: true })` is folded under an Advanced disclosure, so the card
opens on what most people set. `show(id)` opens Settings on a section
from outside the window — a click in a desktop surface: it broadcasts
`settings.show`, the renderer turns Settings to that pane, and the desktop shell
brings the main window forward. Extensions call `ctx.settings.show()` for their
own section.

Extensions speak the app's language, not their own. A section's `title`,
`description` and the schema's `.meta({ title })` / `.describe()` are the
English; `words: { zh: { title, description, fields: { key: { title,
description, options } } } }` gives the card in Chinese, as built-ins do.
`ctx.settings.locale()` is the language now, a BCP 47 tag: `"en"`, `"zh"`, one
of the other languages the app ships, or one a [language pack](#languages)
adds (SDK 0.2.8; before, only `"en"` or `"zh"`). It is a setting, so
`settings.changed` fires when the person switches it. Every plugin may call
`locale()` and hear `settings.changed`, whether or not it names `settings` in
`inject`. Titles the app draws —
commands and their group, status item and section titles, sidebar modules —
take a `Localized`: a string, or `{ en, zh, … }` keyed by tag and picked each
time it is shown: the closest language the plugin wrote, as Tomrade picks its
own (same language and script, so zh-TW finds zh-Hant and never zh), English
where it wrote none. A Tomrade before SDK 0.2.9 takes only the exact tag.
Text a callback returns (a status item's `text` and `menu`, a surface's state)
is the plugin's to put in `locale()`. `wordsFor(await ctx.settings.locale(),
{ en, zh, … })` picks from the plugin's own words the same way, and
`pickLanguage(locale, tags)` names the tag it picks (both SDK 0.2.9, so
`engines.sdk` `^0.2.9`, see [Stability](#stability)). A plugin that still loads
in an older Tomrade picks the words itself, e.g. its `zh` words for `"zh"` and
English for anything else.

A section has a **scope**. `machine` (the default) stays in
`<userData>/settings.json`: credentials, paths, binaries. `user` follows the
person: it is also written to `<Hub>/settings.json` with a timestamp per
section, travels with the Hub, and a clash between two machines is settled by
the later stamp. A section whose schema holds a password is `machine` whatever
it declares.

A section also says what **agents** may do with it, through the
`get_settings` and `update_settings` tools that `@tomradex/settings`
registers: `agent: "write"` lets an agent change it, `"read"` (the default)
lets one look, `"none"` keeps it out of sight. A section whose schema holds a
password is `none` whatever it declares; leave anything that names a command
or a binary, or carries credentials, at `read` or `none` (`mcpServers` is
`none`). Values an agent reads have every string under a key that sounds secret
(`apiKey`, `token`, `password`…), and everything in an `env` or `headers` map,
replaced by `[hidden]`; a `[hidden]` sent back keeps the value it stood for.
`update_settings` takes `{ changes: { <section id>: value } }`, merges an
object section's fields into what is there, validates every section before
any lands, and records the change in the calling project's history — ⌘Z, the
history window and the run's Undo take it back unless the setting has moved on
since. The open sections today are `theme`, `themeAutomation`, `customThemes`,
`language`, `pet`, `notes` and `files`.

First-party plugins register sections the same way: `@tomradex/files` contributes
`files`, whose `agentIndexTokens` (1500) is how much of an agent's prompt the
index of a project's files may take, and zero turns the index off.

## Languages

English is the source of every string: the interface's dictionaries
(`packages/ui/src/lib/i18n-messages`) and each package's backend book
(`defineWords("<book>", { en, zh })` in its `words.ts`) are written in English
first, and the compiler holds Simplified Chinese to every key and `{{slot}}`
English has. Any other language is data and may miss strings: each one it
lacks shows in English.

A plugin adds a language with a **language pack** (SDK 0.2.8), which is data
only. The manifest names each language and the JSON file holding its words;
`"main": null` says the plugin has no code at all:

```json
{
  "id": "alice/portugues",
  "version": "1.0.0",
  "title": "Português (Brasil)",
  "license": "MIT",
  "engines": { "sdk": "^0.2.8" },
  "main": null,
  "languages": [{ "tag": "pt-BR", "name": "Português (Brasil)", "file": "languages/pt-BR.json" }]
}
```

```json
{
  "ui": { "common": { "cancel": "Cancelar", "closeTitled": "Fechar {{title}}" } },
  "backend": { "doctor": { "...": "..." } }
}
```

- `tag` is a canonical BCP 47 tag and never `en`; `name` is the language in
  itself, as Settings → Language lists it. A plugin with code may add languages
  too.
- The file maps `namespace → key → template`: `ui` keys are the interface's
  (`common.cancel` is `t("common.cancel")`), `backend` keys are a book id and
  its key (`doctor`, `code-link`, `im`… — the id `defineWords` names). It holds
  strings only, at most 4,000 characters each and 2 MB in all, and each is
  shown as plain text where the English would be.
- An entry counts only where English has the key and the template asks for the
  same `{{slot}}`s (and `[[cmd:…]]` key chords); anything else reads English.
- One pack per language: a second for the same tag is set aside with a
  warning. A pack for a language the app ships speaks before its built-in words.

Installed — from a file, a folder or the store — the language joins Settings →
Language while the plugin runs, and "System" picks it when the system prefers
it (same language and script; zh-TW finds zh-Hant, never zh). The main process
reads the pack and hands the interface's half to the renderer
(`settings.languages`, `settings.languagePack`), so the window, the status bar,
MCP answers and IM messages speak it alike. Switching the plugin off takes the
language away; a person who had chosen it reads English until it is back.

Prompts written for an agent are not words and no pack translates them: they
stay English and name the person's language in a line such as "write
everything the person will read in Brazilian Portuguese".

`plugin_check` reports each pack's coverage against the English of the
Tomrade it runs in — strings translated, the ones it does not translate (with
their English), keys English no longer has, and entries whose slots differ.
None of it blocks: a gap reads English. `tomrade-plugin check` outside the app
checks the format only.

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
ctx.contributions.sidebarModule({ id: "hello", title: "Hello", icon: "i-link", count: ({ projectId }) => 2, rows: ({ projectId }) => [{ id: "docs", label: "Docs", detail: "docs.example.com", count: 3, command: "hello.say" }] });
ctx.contributions.assistantAccessory({ id: "hello.pet", kind: "animated-pet", title: "Helper", stateChannel: "hello.pet.state", changedChannel: "hello.pet.changed", width: 96, height: 72, animations: { idle: { source: "data:image/gif;base64,…", type: "image/gif", box: { x: 12, y: 30, width: 280, height: 200 } } } });
```

Every callback may return a Promise; the renderer's refresh waits for it. One
that throws is left out of that refresh and logged, and for an extension one
that takes longer than two seconds is left out too — commands get a minute.

Commands appear in the palette under their group and run in the main process
with the current `{ projectId, boardId, viewId, itemId }`. Badges are computed
on every board refresh over the project's items. Status items render in the
status bar; one that names a `command` runs it when clicked, its result
handled as the palette handles it (a `showThread` with a `projectId` opens that
project first, so it works from the projects home too; `settingsPane` opens
Settings on that pane); sections in the
detail pane and the issue sheet. Registering or
unregistering any of them broadcasts `contributions.changed`, and the renderer
refetches. A status item may also give `until`, an epoch ms the renderer counts
down to after the text (`mm:ss`, in the same run of text so the two share a line) without polling; when it
arrives the bar re-reads the item. `menu` lists `{ title, command, icon? }`
actions; with it, a click opens them as a menu instead of running `command`,
and it is re-read with the text so its entries can follow state. State that changes outside a command run —
a timer phase, a click in a desktop surface — calls
`ctx.contributions.refresh()` so every window re-reads. Extensions name their
status item's `command` in their own namespace. A section row may carry `href` — its value opens that link in the
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

A **sidebar module** sits in the project sidebar beside Files, Routines and the
backlog, drawn by the same shell: its head (icon and title, running `command`
when clicked) and, when it has `rows`, a fold button on the left and the rows
under it — each a label with an optional `icon`, a quieter `detail` line, a
`count`, and a `command` to run or an `href` to open. `rows` is computed per
project; returning null hides the module there, and a module without `rows` is
a single door. `count`, also per project, puts a number at the head's end —
what waits there — and shows nothing for null or 0. A first-party module may
name a renderer surface in `opens` ("inbox") for its head to bring up instead
of a command, as a status item's `opens` does; a command's result may name one
the same way. Where it sits and whether it is folded is the person's choice,
kept on their machine: they drag modules by the head or move them from its
right-click menu, and a module the saved order has not met yet lands at the end.

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

Surface documents that need keyboard input can pass `focusable: true` to
`ctx.surfaces.open`. The default is false for passive desktop widgets.
`anchor` names where it first appears: on top of the app element marked
`data-surface-anchor` with that name, left edges aligned — `"sidebar-foot"` is
just above the sidebar's Project settings. When the element is not on screen
(another page, a collapsed sidebar) it opens at the bottom-right of the work
area, as without one.

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

### Windows

A surface of `kind: "window"` (SDK 0.2.11) is a working window instead of a
widget: native frame, resizable down to `minWidth` / `minHeight`, minimizable,
full-screenable and closable (closing calls `onClose`), listed in the Dock or
taskbar, and reopened where the person last left it, by surface id. Several
open at once under different ids. Its title is always the surface's title
followed by the plugin's (`Code sessions — herdr window`), and the document's
own `<title>` never replaces it, so a window cannot pass for Tomrade's or
another app's. An extension needs `permissions.window` in its manifest — shown
at install as a reason to look closer; official plugins also give
`permissions.why.window` — and opening one without it is refused. Built-ins
need none.

The document still has no Node access. Its bridge, `window.tomradeSurface`,
stays feature-neutral: `onState(fn)` hears the whole state the plugin sets,
`onMessage(fn)` hears each `handle.post(message)` in order (for frequent small
updates such as terminal frames; posts made before the document loads wait
for it), `onLook(fn)` hears how the app looks — `{ theme, dark, tokens,
locale }`, the theme's CSS variables as the main window paints them — at once
and on every change, and `send(message)` reaches the plugin's `onMessage`.
Widgets get the same bridge.

## Alerts

`@tomradex/alerts` is the contract for telling the person something happened
when they may not be looking: `ctx.alerts.notify({ title, body })` shows a
system notification (silent; clicking it brings the main window forward) and
`ctx.alerts.play(sound, { volume })` plays a sound once. `sounds()` lists the
system's own — `/System/Library/Sounds` on macOS, `%SystemRoot%\Media` on
Windows, the freedesktop theme on Linux — as `system:<name>`, the one the
system alerts with first. A sound the person chose themselves is passed by its
absolute path, typically from a settings field with `format: "audio"`; the
host refuses anything that is not an existing audio file, so the plugin never
reads it and needs no file permission. The desktop shell plays through the
platform's player (`afplay`, PowerShell's MediaPlayer, `paplay`). Extensions
reach it as `alerts` in `inject` or `optional`.

## Terminals

`@tomradex/herdr` (`ctx.herdr`) can hand over a live terminal of a herdr pane:
`terminal(paneId, { mode, cols, rows })` runs `herdr terminal session control`
(or `observe`) for it and returns a stream. `control` takes the pane's input
and size from any other owner; `observe` watches beside others and drops
input. Frames are ANSI bytes that paint the viewport — the whole of it when
`full`, else only the cells that changed — so scrolling back is asked for with
`scroll`, never kept by the renderer. Closing a controller releases the pane;
it keeps running in herdr. `bridge()` says whether this works here and, when
not, what fixes it: herdr missing, older than 0.9.2, its server stopped, or an
upgraded CLI beside a server still running the old build (`stale`). Native
Windows is `unsupported`. The app's windows reach it over IPC (`herdr.bridge`,
`herdr.terminalOpen` …, frames as the `herdr.terminalFrame` broadcast).

Extensions reach it as `terminals` in `inject` or `optional`
(`ctx.terminals.state()` / `ctx.terminals.open(…)`, SDK 0.2.10): a plugin
never connects to herdr's socket or starts its CLI itself, and a terminal it
leaves open is closed when it unloads. The `plugin_test` sandbox has no herdr.

## What is deliberately not here

- No orchestration graph and no per-message intent router. One engine conducts
  a thread; determinism lives in workflows and policies, judgment in the
  engine's model — and a CLI agent can be the engine.
- No code evaluation in configuration. `tomrade.yml` is static YAML with
  `${userData}`-style substitution and nothing more.
- No profile or bundle layering beyond one file, the full-mode extensions'
  rows, and one patch file, merged by id in that order.
- No renderer plugin bundles. Contributions are data; the only documents a
  plugin ships are surfaces, opened from inside its own package.
