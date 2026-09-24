# @tomrade/plugin-sdk

The contract a Tomrade plugin is written against. `definePlugin` hands `apply()` a `PluginContext`: every call returns a Promise, every function you give it may be async, and every id you register carries your plugin's namespace.

```sh
npx @tomrade/plugin-cli init my-plugin --id you/my-plugin
cd my-plugin && npm install && npm run dev
```

```ts
import { z } from "zod";
import { definePlugin, defineTool, requireProjectId } from "@tomrade/plugin-sdk";

export default definePlugin({
  inject: ["items", "tools", "contributions"],
  async apply(ctx) {
    await ctx.tools.register(
      defineTool({
        name: "my_plugin_count_open", // starts with the namespace
        title: "Count open issues",
        description: "How many issues in the project are not done yet.",
        input: z.object({ projectId: z.string().optional() }),
        execute: async ({ projectId }, inv) =>
          (await ctx.items.list({ projectId: requireProjectId("my_plugin_count_open", projectId, inv) })).filter((i) => i.status !== "done").length
      })
    );
    await ctx.contributions.statusItem({ id: "my_plugin", text: async ({ projectId }) => (projectId ? `${(await ctx.items.list({ projectId })).length} issues` : null) });
  }
});
```

## What the context offers

| Member | |
|---|---|
| `items` | `list`, `query`, `get`, `getByKey`, `create`, `update`, `delete`, `addRelation`, `removeRelation`, `labels` — writes take no author; Tomrade records who wrote |
| `fields`, `boards`, `views`, `projects` | the project's fields (and `create`, `update`, `remove`, `addOption`), workstreams, saved views, projects |
| `db` | `migrate(steps, { tables })` for `plugin_<namespace>_*`; `all`, `get`, `run`, `batch` against a project id or `"hub"` |
| `settings` | `register({ title, schema, defaults })`, `get`, `set` |
| `tools` | `register`, `list`, `call`, `gate` |
| `contributions` | `command`, `badge`, `statusItem`, `section`, `graph` |
| `agent` | `playbook({ id, title, when, body })` |
| `surfaces` | `open({ id, document })` — a document inside your package |
| `on`, `when`, `has`, `effect`, `interval` | events, optional services, cleanup, timers |

## The manifest

`tomrade-plugin.json` beside `package.json`:

```json
{
  "id": "you/my-plugin",
  "version": "0.1.0",
  "title": "My plugin",
  "description": "What it does, in one sentence.",
  "license": "MIT",
  "repository": "https://github.com/you/tomrade-plugin-my-plugin",
  "engines": { "sdk": "^0.2.0" },
  "permissions": { "network": [], "fs": "none", "exec": false }
}
```

Declare what your code does beyond the SDK — the hosts it talks to, whether it touches the disk, whether it starts programs. The store's review compares it with the code. Community lists open-source plugins only, built from your public GitHub repository and reviewed before they are listed.
