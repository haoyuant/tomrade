/**
 * Extensions against the real shell: a plugin written outside the app, which
 * imports the SDK and zod without shipping either, is installed from a
 * package, runs on the host's own copies, and a development folder reloads
 * when its build changes.
 *
 *   pnpm --filter @tomrade/desktop test:extensions
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packPlugin } from "@tomradex/plugin-kit";
import { boot } from "../dist/boot.js";
import { registerExtensionResolution } from "../dist/extension-resolve.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORK = "/tmp/tomrade-extensions-check";
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath("userData", path.join(WORK, "userData"));
registerExtensionResolution([path.resolve(__dirname, "../../..")]);

const results = [];
const check = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond || !extra ? "" : ` — ${extra}`}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function extension(dir, id, body) {
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tomrade-plugin.json"), JSON.stringify({ id, version: "1.0.0", title: id, license: "MIT", engines: { sdk: "^0.2.0" }, inject: ["tools", "items"] }));
  fs.writeFileSync(path.join(dir, "dist/index.js"), body);
}

const counter = (tool, label) => `import { definePlugin, defineTool } from "@tomradex/plugin-sdk";
import { z } from "zod";
export default definePlugin({
  inject: ["tools", "items"],
  async apply(ctx) {
    await ctx.tools.register(defineTool({
      name: ${JSON.stringify(tool)},
      title: "Count",
      description: "How many issues the project holds.",
      input: z.object({ projectId: z.string().optional() }),
      execute: async ({ projectId }, inv) => ${JSON.stringify(label)} + (await ctx.items.list({ projectId: projectId ?? inv.projectId })).length
    }));
  }
});
`;

const run = async () => {
  const { ctx } = await boot({
    configFile: path.join(__dirname, "../tomrade.yml"),
    patchFiles: [],
    vars: { userData: path.join(WORK, "userData") },
    patches: [[{ id: "mcp", config: { port: 0 } }]],
    extensions: { root: path.join(WORK, "plugins"), trustedKeys: {} }
  });
  const view = (id) => ctx.plugins.list().find((p) => p.id === id);
  // A project of its own: the first run's is the sample, which already holds issues.
  const project = ctx.projects.create({ name: "Extensions" });

  const src = path.join(WORK, "src", "hello");
  extension(src, "someone/hello", counter("hello_count", "count: "));
  const { file } = await packPlugin(src, path.join(WORK, "hello.tomrade-plugin"));
  await ctx.plugins.installFile(file);
  check("an extension from outside the app installs and runs", view("someone/hello")?.state === "active", JSON.stringify(view("someone/hello")));
  const described = ctx.tools.describe().find((t) => t.name === "hello_count");
  check("its zod schema is the host's zod", described?.inputSchema?.properties?.projectId?.type === "string", JSON.stringify(described?.inputSchema));
  check("it answers through the host's services", (await ctx.tools.execute("hello_count", {}, { by: "human", projectId: project.id })) === "count: 0");
  check("it is listed as a local package", view("someone/hello")?.extension?.tier === "local");

  const dev = path.join(WORK, "src", "dev");
  extension(dev, "someone/dev", counter("dev_count", "before: "));
  await ctx.plugins.addFolder(dev);
  check("a development folder loads as it stands", (await ctx.tools.execute("dev_count", {}, { by: "human", projectId: project.id })) === "before: 0");
  fs.writeFileSync(path.join(dev, "dist/index.js"), counter("dev_count", "after: "));
  let reloaded = false;
  for (let i = 0; i < 30 && !reloaded; i++) {
    await wait(200);
    reloaded = ctx.tools.has("dev_count") && (await ctx.tools.execute("dev_count", {}, { by: "human", projectId: project.id })) === "after: 0";
  }
  check("and reloads when its build changes", reloaded);

  const lock = JSON.parse(fs.readFileSync(path.join(WORK, "plugins", "plugins.lock.json"), "utf8"));
  check("both are in the lock", lock.plugins.map((p) => p.id).sort().join() === "someone/dev,someone/hello");

  await ctx.plugins.uninstall("someone/hello", { removeData: true });
  check("uninstalling takes its tool with it", !ctx.tools.has("hello_count"));

  // A full-mode plugin imports the app's own packages and gets the app's copies; an SDK plugin does not.
  const full = path.join(WORK, "src", "full");
  fs.mkdirSync(path.join(full, "dist"), { recursive: true });
  fs.writeFileSync(path.join(full, "tomrade-plugin.json"), JSON.stringify({ id: "someone/full", version: "1.0.0", title: "Full", license: "MIT", engines: { sdk: "^0.2.13", tomrade: ">=0.13.0" }, context: "full" }));
  fs.writeFileSync(
    path.join(full, "dist/index.js"),
    `import { Llm, NativeSearchRefused } from "@tomradex/llm";
import { WebSearch } from "@tomradex/web-search";
export default { name: "full", inject: ["llm", "webSearch"], apply(ctx) { globalThis.__full = { Llm, NativeSearchRefused, WebSearch, sameLlm: ctx.llm instanceof Llm, sameSearch: ctx.webSearch instanceof WebSearch }; } };`
  );
  await ctx.plugins.addFolder(full);
  const llmModule = await import("@tomradex/llm");
  const seen = globalThis.__full;
  check("a full-mode plugin imports the app's own packages and gets the app's copies", view("someone/full")?.state === "active" && seen?.sameLlm === true && seen?.sameSearch === true && seen?.NativeSearchRefused === llmModule.NativeSearchRefused, JSON.stringify({ state: view("someone/full")?.state, error: view("someone/full")?.error, sameLlm: seen?.sameLlm, sameSearch: seen?.sameSearch }));

  const sdkOnly = path.join(WORK, "src", "sdk-internal");
  extension(sdkOnly, "someone/sdk-internal", `import { Llm } from "@tomradex/llm";
import { definePlugin } from "@tomradex/plugin-sdk";
export default definePlugin({ inject: ["tools"], async apply() { globalThis.__sdkLlm = Llm; } });
`);
  await ctx.plugins.addFolder(sdkOnly);
  check("an SDK plugin still cannot reach the app's internals", view("someone/sdk-internal")?.state === "failed" && globalThis.__sdkLlm === undefined, JSON.stringify({ state: view("someone/sdk-internal")?.state, error: view("someone/sdk-internal")?.error }));
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (error) {
    console.error(error);
    results.push({ name: "run", pass: false });
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  app.exit(passed === results.length ? 0 : 1);
});
