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

Services: `items` `fields` `boards` `views` `projects` `db` `settings` `tools` `contributions` `agent` `surfaces` `oplog` `models`.
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
`register({ title, description?, schema: z.object({...}), defaults })` (id defaults to the namespace) · `get<T>()` · `set(value)` · `show()` opens Settings on your section (from a desktop surface click) · `locale()` is the app's language, a BCP 47 tag (`"en"`, `"zh"`, `"ja"`, or one a language pack adds; `settings.changed` fires on a switch). Never write two languages side by side: the schema's `.meta({ title })`/`.describe()` are English, `words: { zh: { title, description, fields: { key: { title, description } } } }` is the Chinese card, and command / status item titles take `{ en, zh }`. The card is drawn from the schema; use `.describe()` on fields for labels.

## tools — for agents
```ts
await ctx.tools.register(defineTool({
  name: `${ns}_something`, title: "…", description: "What it returns and when to call it.",
  input: z.object({ projectId: z.string().optional() }),
  execute: async ({ projectId }, inv) => { const pid = requireProjectId(`${ns}_something`, projectId, inv); … }
}));
```
`inv` is `{ projectId?, runId?, author }`. `ctx.tools.call(name, args, {projectId})` calls another tool. `ctx.tools.gate(call => { if (…) throw new Error("why") })` refuses calls; SDK 0.2.12 (`engines.sdk` `^0.2.12`): return `{ args }` to go on with other arguments, or `{ result }` to answer in the tool's place. `ctx.items.gate(write => { if (…) throw new Error("why") })` refuses any write before it lands (`{ projectId, entity, op, id, by, via, before, after, patch }`); it must answer at once — never `async`.

## contributions — what the person sees
- `command({ id, title, group?, run: async ({projectId, itemId}) => ({ toast }) })` — palette; runs as the person.
- `badge({ id, compute: async (items, {projectId}) => ({ [itemId]: [{ id, label, tone: "faint"|"neutral"|"strong", title? }] }) })`
- `statusItem({ id, text: async ({projectId}) => string | null, icon?, align?: "end", title?, command?, until?: () => epochMs | null, menu?: () => [{ title, command, icon? }] })` — `until` counts down live after the text; `menu` makes the click open those actions; call `refresh()` when state changes outside a command.
- `section({ id, title, render: async (item) => ({ rows: [{ label, value, mono?, href?, command?, state? }], text? }) | null })`
- `graph({ id, title, icon?, compute: async (items) => [{ from, to, tone?, title? }] })`

## agent
`ctx.agent.playbook({ id: `${ns}.how`, title, when: "one line", body: "markdown steps", tools: [...] })`. SDK 0.2.14, the in-app conversation only (not CLI agents): `ctx.agent.request(r => ({ system, tools, messages }))` changes each model request; `ctx.agent.requestError(f => ({ request, profile }))` sends a failed one again; `ctx.agent.turnEnding(e => ({ continue: "message to the model" }))` keeps a turn going (bounded). Return nothing to leave things as they are. SDK 0.2.15, the CLI agents (Claude Code, Codex, dsh…): `ctx.agent.cliHook({ events: ["pre-tool"], tools: "^Bash$", handle: call => ({ deny: "why" }) })` hears their hooks and, in a session Tomrade started, answers — `{ deny }` before a tool, `{ context }`, `{ continue }` at a stop; `call.answerable` says whether the agent acts on it (`CLI_HOOK_COVERAGE`). SDK 0.2.17, a coding agent installed on the machine: `ctx.agent.localAgent({ id: ns, title, cli: { name, bundled? }, install, setup?: { install: [{ script: "https://…/install.sh" } | "npm i -g …"], signIn }, options: z.object({ command: z.string().default(name) }), acp?: { permissionModes, args: (options) => ["acp"], mode?, usage?, terminal? }, picks?, probe?, signedIn?, mcpLink?: { status, connect, disconnect } | { cli: { file, configuredUrl, add, remove } }, lend?: { rank, ask: (request, io) => ({ text, inputTokens, outputTokens }) } })` runs it with the app's own conductor (over ACP, or in a terminal only when `acp` is absent); throw `NotSignedIn` from `lend.ask` when it says it is signed out. `record: { find: (sessionId, { cwd }) => file | null, read: (file, { before }?) => ({ lines: [{ who: "person" | "agent" | "tool", text, detail?: { input, output? } }], cut, start? }) | null, title?: (file) => string | null }` (SDK 0.2.29) reads the agent's own record of a session, so an ended one shows its conversation in the Terminal window; all three answer at once. `read` returns the record's end, and with `before` (an earlier read's `start`) the stretch before it; `cut` says more came before. Needs `"engines": { "sdk": "^0.2.17" }`, `^0.2.18` for an installer `{ script }` / `{ powershell }` (the app writes `curl -fsSL <url> | bash`; never put that text in plugin code).

## models (SDK 0.2.16)
`ctx.models.registerProvider({ id: ns, title, baseURL: { default: "https://api.example.com/v1" }, presets: [{ id: ns, title, keyPage, env, keyShapes: [/^ex-/], prefer: [/^ex-large/] }], list: (endpoint, signal) => ({ ok: true, models: [...] }), usable?, capabilities?, signIn?, build: (profile) => ({ capabilities: { tools, streaming, json, nativeWebSearch? }, async *chat(request, signal) { yield { type: "text", delta }; … yield { type: "stop", reason: "end" } } }) })` adds a model provider like the app's own: its presets show in the model setup, `list` doubles as the key check, profiles naming it build through `build`. A failed request throws with what the provider said. `signIn: { title, run({ open, signal }) => ({ apiKey }) }` only for a sign-in the provider allows third-party apps (OAuth that ends in a key), never a consumer subscription. `wire: "openai-completions" | "anthropic-messages" | "google-generative-ai"` (SDK 0.2.28) says the endpoint is a plain one: Tomrade's built-in agent then runs profiles on this provider too — on `baseURL.default`, with the key only in that process's environment. Leave it out when requests need headers or a body of your own, or the endpoint is not plain OpenAI, Anthropic or Gemini. A vendor serving chat/completions builds on the app's adapter: `build: (p) => ctx.models.compatible({ baseURL, apiKey: p.apiKey, model: p.model, webSearch: "chat", body: (json, r) => (r.webSearch ? { ...json, enable_search: true } : json) })` (synchronous) and `list: (e, signal) => ctx.models.listCompatible({ baseURL, apiKey: e.apiKey }, signal)`. With `webSearch: "responses"`, `responses: (json, r) => ({ ...json, reasoning: { effort } })` shapes the Responses body, where most steps of a searching model go. `compatible({ …, headers: async ({ url, body }) => ({ "api-key": key }) })` replaces the bearer header on every try (a vendor's key header, a token that expires, a signature); `listCompatible({ baseURL, apiKey, headers })` likewise. Needs `"engines": { "sdk": "^0.2.16" }`.

## surfaces
`ctx.surfaces.open({ id, title, document: "dist/static/panel.html", width, height, focusable?, transparent?, clickThrough?, anchor?: "sidebar-foot", onMessage, onClose })` → handle with `setState`, `close`. `onClose` runs once when the window is gone (the person, `close()`, unloading); after it the handle's calls reject, so open a new window rather than reuse it. Documents are files in the package (put them in `static/`).

## events and lifetime
`ctx.on("write", e => …)` (`{projectId, entity, op, id, by, via}`) · `ctx.on("project.opened", id => …)` · `ctx.on("settings.changed", …)`
`ctx.interval(fn, ms)` · `ctx.effect(() => dispose)` · `ctx.when("agent", inner => …)` · `ctx.has("agent")`. Everything is undone when the plugin unloads.

## Manifest (`tomrade-plugin.json`)
`id` publisher/name · `version` · `title` · `description` · `license` (OSI SPDX id) · `repository` (public GitHub URL, to publish) · `engines.sdk` · `permissions: { network: ["api.example.com"], fs: "none"|"plugin"|"project"|"any", exec: false, window: false }` (`window`: may open working windows, SDK 0.2.11). `inject`, `optional` and `contributes` are filled in by the build.

Full mode (SDK 0.2.13), only when the SDK cannot do it: `"context": "full"` plus `"engines": { "tomrade": ">=0.13.0 <0.14.0" }` makes `main` a plain cordis plugin, `export default { name, inject: ["llm"], apply(ctx, config) { … } }`, given Tomrade's whole Context. `"rows": [{ "id": "llm", "name": "./dist/llm.js" }, { "id": "web-search-tavily", "disabled": true }, { "id": "<ns>-extra", "name": "./dist/extra.js" }]` replace, switch off or add rows of the app at the next start. Its code may import the app's own packages (`import { Llm } from "@tomradex/llm"`) and gets the running app's copies; the build leaves them out, and their declarations are on npm at the app's version, so name only what that Tomrade has. It is labelled high risk; `plugin_test` does not run it — use `plugin_try`.

## Language packs (data only)
A plugin that adds a language: `"engines": { "sdk": "^0.2.8" }`, `"main": null` (no code, no `src/`), `"languages": [{ "tag": "pt-BR", "name": "Português (Brasil)", "file": "languages/pt-BR.json" }]` (a canonical tag, never `en`; the name in the language itself). The file is `{ "ui": { "<namespace>": { "<key>": "…" } }, "backend": { "<book>": { "<key>": "…" } } }`, strings only, each shown as plain text. Keep every `{{slot}}` and `[[cmd:…]]` its English has; an entry that changes them, or a key English lacks, reads English, and so does anything left out. `plugin_check` lists the coverage per side: `next` holds the next strings to translate with their English — translate those, check again. Agent prompts are not translatable.

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
A plugin that names `surfaces` gets windows that never open: `t.surfaces.opened()` lists them (`{ id, title, state, closed }`, `state` the last `setState`), `await t.surfaces.message(id, msg)` sends `msg` as if the document had, and `await t.surfaces.close(id)` closes it as the person would. A plugin that names `models` gets the real model seam: `t.models.presets()`, `t.models.providers()`, and `await t.models.ask(profile, "hi")` — one turn through its provider (stub `fetch` for the network). A plugin that waits on a service the sandbox lacks fails `loads`, naming it.
