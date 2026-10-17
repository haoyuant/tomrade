# Tomrade plugin SDK — reference for agents

## Shape

```ts
import { z } from "zod";
import { definePlugin, defineTool, requireProjectId, type Item } from "@tomradex/plugin-sdk";

export default definePlugin({
  inject: ["items", "tools", "contributions"],   // loaded when all are present
  optional: ["agent"],                            // reached with ctx.when / ctx.has
  async apply(ctx) {
    // ctx.namespace is this plugin's prefix, e.g. "stale"
  }
});
```

Services: `items` `fields` `boards` `views` `projects` `db` `settings` `tools` `contributions` `agent` `surfaces` `oplog`.
Every call returns a Promise. Values are plain data.

## items
`list(filter?)` `query({projectId, filter?, sortBy?, search?, limit?})` `get(projectId, id)` `getByKey(projectId, "TOM-12")`
`create({projectId, boardId, title, body?, status?, priority?, kind?, labels?, fields?})` `update(projectId, id, patch, {baseVersion?})`
`delete(projectId, id)` `addRelation(projectId, id, blockedId)` `removeRelation(...)` `labels(projectId)`.
Item: `{ id, key, projectId, boardId, title, body, status ("backlog"|"todo"|"doing"|"verifying"|"done"|"cancelled"), priority, kind, labels, blocks, blockedBy, parentId, updatedAt, updatedBy, version, fields }`.

## fields / boards / views / projects
`fields.list(projectId)` `fields.create({projectId, name, type, options?})` · `boards.list(projectId)` `boards.defaultFor(projectId)` · `views.list(projectId)` · `projects.list()` `projects.get(id)`.

## db — plain SQL on the project caches
```ts
await ctx.db.migrate([{ version: 1, up: "CREATE TABLE IF NOT EXISTS plugin_<ns>_notes (item_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, note TEXT)" }],
  { tables: { plugin_<ns>_notes: { project: "project_id", export: false } } });
await ctx.db.all(projectId, "SELECT * FROM plugin_<ns>_notes WHERE project_id = ?", [projectId]);
await ctx.db.get(projectId, sql, params); await ctx.db.run(projectId, sql, params); await ctx.db.batch(projectId, [{ sql, params }]);
```
`export: { order: "item_id" }` makes the table travel in the project's folder; `false` keeps it on this machine. `"hub"` as the target addresses the Hub's database (migrate with `scope: "hub"`).

## settings
`register({ title, description?, schema: z.object({...}), defaults })` (id defaults to the namespace) · `get<T>()` · `set(value)` · `show()` opens Settings on your section (from a desktop surface click) · `locale()` is the app's language (`"en"`/`"zh"`; `settings.changed` fires on a switch). Never write two languages side by side: the schema's `.meta({ title })`/`.describe()` are English, `words: { zh: { title, description, fields: { key: { title, description } } } }` is the Chinese card, and command / status item titles take `{ en, zh }`. The card is drawn from the schema; use `.describe()` on fields for labels.

## tools — for agents
```ts
await ctx.tools.register(defineTool({
  name: `${ns}_something`, title: "…", description: "What it returns and when to call it.",
  input: z.object({ projectId: z.string().optional() }),
  execute: async ({ projectId }, inv) => { const pid = requireProjectId(`${ns}_something`, projectId, inv); … }
}));
```
`inv` is `{ projectId?, runId?, author }`. `ctx.tools.call(name, args, {projectId})` calls another tool. `ctx.tools.gate(call => { if (…) throw new Error("why") })` refuses calls.

## contributions — what the person sees
- `command({ id, title, group?, run: async ({projectId, itemId}) => ({ toast }) })` — palette; runs as the person.
- `badge({ id, compute: async (items, {projectId}) => ({ [itemId]: [{ id, label, tone: "faint"|"neutral"|"strong", title? }] }) })`
- `statusItem({ id, text: async ({projectId}) => string | null, icon?, align?: "end", title?, command?, until?: () => epochMs | null, menu?: () => [{ title, command, icon? }] })` — `until` counts down live after the text; `menu` makes the click open those actions; call `refresh()` when state changes outside a command.
- `section({ id, title, render: async (item) => ({ rows: [{ label, value, mono?, href?, command?, state? }], text? }) | null })`
- `graph({ id, title, icon?, compute: async (items) => [{ from, to, tone?, title? }] })`

## agent
`ctx.agent.playbook({ id: `${ns}.how`, title, when: "one line", body: "markdown steps", tools: [...] })`.

## surfaces
`ctx.surfaces.open({ id, title, document: "dist/static/panel.html", width, height, focusable?, transparent?, clickThrough?, anchor?: "sidebar-foot", onMessage })` → handle with `setState`, `close`. Documents are files in the package (put them in `static/`).

## events and lifetime
`ctx.on("write", e => …)` (`{projectId, entity, op, id, by, via}`) · `ctx.on("project.opened", id => …)` · `ctx.on("settings.changed", …)`
`ctx.interval(fn, ms)` · `ctx.effect(() => dispose)` · `ctx.when("agent", inner => …)` · `ctx.has("agent")`. Everything is undone when the plugin unloads.

## Manifest (`tomrade-plugin.json`)
`id` publisher/name · `version` · `title` · `description` · `license` (OSI SPDX id) · `repository` (public GitHub URL, to publish) · `engines.sdk` · `permissions: { network: ["api.example.com"], fs: "none"|"plugin"|"project"|"any", exec: false }`. `inject`, `optional` and `contributes` are filled in by the build.

## Scenario (`src/test.ts`)
```ts
export default async function (t) {
  const a = t.createItem("Needs a note", { status: "todo" });
  const out = await t.tool(`${ns}_something`, {});
  t.check("returns something", out != null, JSON.stringify(out));
  const badges = await t.badges(); const sections = await t.sections(a.id); const status = await t.statusItems();
  await t.command(`${ns}.cmd`, a.id);
}
```
A plugin that names `surfaces` gets windows that never open: `t.surfaces.opened()` lists them (`{ id, title, state, closed }`, `state` the last `setState`), and `await t.surfaces.message(id, msg)` sends `msg` as if the document had. A plugin that waits on a service the sandbox lacks fails `loads`, naming it.
