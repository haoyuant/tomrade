import fs from "node:fs";
import path from "node:path";
import { PLUGIN_ID, SDK_CONTRACT, nameOf, namespaceOf } from "@tomrade/plugin-sdk";

export interface ScaffoldOptions {
  id: string;
  title?: string;
  description?: string;
  author?: string;
  /** Who wrote the first version; Studio passes "agent". */
  authoredBy?: "human" | "agent";
}

const sdkRange = `^${SDK_CONTRACT}`;

function files(o: Required<Omit<ScaffoldOptions, "author">> & { author: string }) {
  const ns = namespaceOf({ id: o.id });
  const year = new Date().getFullYear();
  return {
    "tomrade-plugin.json": `${JSON.stringify(
      {
        id: o.id,
        version: "0.1.0",
        title: o.title,
        description: o.description,
        license: "MIT",
        author: { name: o.author },
        engines: { sdk: sdkRange },
        main: "dist/index.js",
        permissions: { network: [], fs: "none", exec: false },
        authoredBy: o.authoredBy
      },
      null,
      2
    )}\n`,
    "package.json": `${JSON.stringify(
      {
        name: `tomrade-plugin-${nameOf(o.id)}`,
        private: true,
        type: "module",
        scripts: { build: "tomrade-plugin build", dev: "tomrade-plugin dev", test: "tomrade-plugin test", check: "tomrade-plugin check", pack: "tomrade-plugin pack" },
        devDependencies: { "@tomrade/plugin-sdk": sdkRange, "@tomrade/plugin-cli": sdkRange, zod: "^4.4.3", typescript: "^6.0.0" }
      },
      null,
      2
    )}\n`,
    "tsconfig.json": `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, noEmit: true }, include: ["src"] }, null, 2)}\n`,
    "src/index.ts": `import { z } from "zod";
import { definePlugin, defineTool, requireProjectId } from "@tomrade/plugin-sdk";

/**
 * ${o.title}. Every call to ctx returns a Promise; every id you register starts
 * with "${ns}" — the namespace Tomrade gives this plugin.
 */
export default definePlugin({
  inject: ["items", "tools", "contributions"],
  async apply(ctx) {
    await ctx.tools.register(
      defineTool({
        name: "${ns}_count_open",
        title: "Count open issues",
        description: "How many issues in the project are not done yet.",
        input: z.object({ projectId: z.string().optional() }),
        execute: async ({ projectId }, inv) => {
          const items = await ctx.items.list({ projectId: requireProjectId("${ns}_count_open", projectId, inv) });
          return items.filter((i) => i.status !== "done" && i.status !== "cancelled").length;
        }
      })
    );

    await ctx.contributions.statusItem({
      id: "${ns}",
      text: async ({ projectId }) => {
        if (!projectId) return null;
        const open = (await ctx.items.list({ projectId })).filter((i) => i.status !== "done" && i.status !== "cancelled").length;
        return open ? \`\${open} open\` : null;
      }
    });
  }
});
`,
    "src/test.ts": `/** Run by \`tomrade-plugin test\` against a throwaway project; \`t.check\` records a result. */
export default async function scenario(t: {
  createItem(title: string, patch?: Record<string, unknown>): { id: string };
  tool(name: string, args?: unknown): Promise<unknown>;
  statusItems(): Promise<{ id: string; text: string }[]>;
  check(name: string, ok: boolean, detail?: string): void;
}) {
  t.createItem("Write the README");
  const open = await t.tool("${ns}_count_open");
  t.check("counts open issues", typeof open === "number" && open > 0, String(open));
  const status = await t.statusItems();
  t.check("shows the count in the status bar", status.some((s) => s.id === "${ns}"));
}
`,
    "README.md": `# ${o.title}\n\n${o.description}\n\n## Develop\n\n\`\`\`sh\nnpm install\nnpm run dev      # rebuilds on every change; load this folder in Tomrade → Settings → Plugins → Load folder\nnpm test         # runs src/test.ts against a throwaway project, sandboxed\nnpm run check    # what the store's review will see\nnpm run pack     # a .tomrade-plugin file anyone can install\n\`\`\`\n`,
    LICENSE: `MIT License\n\nCopyright (c) ${year} ${o.author}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`,
    ".gitignore": "node_modules/\ndist/\n*.tomrade-plugin\n"
  } as Record<string, string>;
}

/** A new plugin that builds, tests and loads as it is. Refuses to write over files already there. */
export function scaffold(dir: string, opts: ScaffoldOptions): string[] {
  if (!PLUGIN_ID.test(opts.id)) throw new Error(`"${opts.id}" is not a plugin id: publisher/name, lowercase letters, digits and dashes`);
  const all = files({
    id: opts.id,
    title: opts.title ?? nameOf(opts.id).replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
    description: opts.description ?? "",
    author: opts.author ?? opts.id.split("/")[0]!,
    authoredBy: opts.authoredBy ?? "human"
  });
  const clash = Object.keys(all).filter((rel) => fs.existsSync(path.join(dir, rel)));
  if (clash.length) throw new Error(`${dir} already has ${clash.join(", ")}`);
  for (const [rel, content] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return Object.keys(all);
}
