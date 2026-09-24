/**
 * The plugin manager against the real composition: boots the app's own
 * tomrade.yml over a throwaway userData, then switches rows on and off and
 * checks what the context actually did.
 *
 *   pnpm --filter @tomrade/desktop test:plugins
 */
import { app } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORK = "/tmp/tomrade-plugins-check";
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath("userData", WORK);

const results = [];
const check = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond || !extra ? "" : ` — ${extra}`}`);
};

const refusal = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};

const run = async () => {
  const patchFile = path.join(WORK, "tomrade.patch.yml");
  const { ctx } = await boot({
    configFile: path.join(__dirname, "../tomrade.yml"),
    patchFiles: [patchFile],
    vars: { userData: WORK },
    patches: [[{ id: "mcp", config: { port: 0 } }]]
  });
  const view = (id) => ctx.plugins.list().find((p) => p.id === id);
  const module = (id) => ctx.plugins.modules().find((m) => m.id === id);

  check("every row of the shipped composition is active", ctx.plugins.list().every((p) => p.state === "active"));
  check("every required module has a provider", ctx.plugins.modules().every((m) => !m.required || m.providers.length));
  check("one row is credited with both keys it provides through nested plugins", view("boards")?.provides.join() === "boards,views");

  // The guard, on the plugin nothing may run without.
  const refusedDb = await refusal(() => ctx.plugins.setEnabled("db", false));
  check("switching off the database is refused", refusedDb?.name === "RequiredModuleError", String(refusedDb));
  check("the refusal names the module", /Database/.test(refusedDb?.message ?? ""), refusedDb?.message);
  check("the database is still there", ctx.get("db") !== undefined);
  check("nothing was written to the patch file", !fs.existsSync(patchFile));

  // A third-party row holds nothing up, so it goes.
  await ctx.plugins.setEnabled("stale", false);
  check("a third-party plugin switches off", view("stale")?.state === "disabled");
  check("its tools go with it", !ctx.tools.list().some((t) => t.name === "stale_list_items"), ctx.tools.list().map((t) => t.name).join(","));
  check("the choice is written to the patch file", fs.existsSync(patchFile) && /disabled: true/.test(fs.readFileSync(patchFile, "utf8")));

  await ctx.plugins.setEnabled("stale", true);
  check("and switches back on", view("stale")?.state === "active");
  check("its tools come back", ctx.tools.list().some((t) => t.name === "stale_list_items"));

  // An optional module: every engine injects the agent platform, so switching
  // it off takes all the conductors down together — and back.
  await ctx.plugins.setEnabled("agent", false);
  check("an optional module can be emptied", module("agent")?.providers.length === 0);
  check("what injected it unloaded too", ctx.get("agent") === undefined && ctx.tools.list().every((t) => t.name !== "plan_and_apply"));
  check("and the row says why it is not running", view("engine-loop")?.state === "pending", JSON.stringify(view("engine-loop")));
  check("the spine is untouched", ctx.get("db") !== undefined && ctx.get("items") !== undefined);

  await ctx.plugins.setEnabled("agent", true);
  check("putting it back restores the engines", ctx.get("agent") !== undefined && view("engine-loop")?.state === "active" && ctx.tools.list().some((t) => t.name === "plan_and_apply"));

  // A destination provider registers into ctx.storage rather than providing a
  // key of its own, so it holds no module and one can go without the registry.
  await ctx.plugins.setEnabled("storage-git", false);
  check("a destination provider switches off", !ctx.storage.has("git"), ctx.storage.describe().map((p) => p.id).join(","));
  check("the registry it registered into stays", module("storage")?.providers.join() === "storage");
  check("and the destinations it did not own are untouched", ctx.storage.has("github"), ctx.storage.describe().map((p) => p.id).join(","));
  await ctx.plugins.setEnabled("storage-git", true);
  check("putting it back re-registers it", ctx.storage.has("git"));

  // External MCP servers: a stdio server configured in Settings joins ctx.tools,
  // and goes with the row. Electron runs the fixture as plain Node.
  const fixture = path.join(__dirname, "../../../packages/mcp-client/tests/fixtures/stdio-server.mjs");
  const server = { id: "fx", transport: { type: "stdio", command: process.execPath, args: [fixture], env: { ELECTRON_RUN_AS_NODE: "1" } } };
  ctx.settings.set({ ...ctx.settings.get(), mcpServers: { servers: [server] } });
  await ctx.mcpClient.settled();
  check("a configured MCP server connects", ctx.mcpClient.servers()[0]?.state === "connected", JSON.stringify(ctx.mcpClient.servers()[0]));
  check("its tools are registered under its prefix", ctx.tools.has("fx__echo") && ctx.tools.has("fx__files_read"));
  check("and answer through the guarded path", (await ctx.tools.execute("fx__echo", { text: "hi" }, { by: "ai:check" })) === "hi");
  await ctx.plugins.setEnabled("mcp-client", false);
  check("the MCP client switches off and holds no module", view("mcp-client")?.state === "disabled" && module("mcpClient")?.providers.length === 0);
  check("the server's tools go with it", !ctx.tools.list().some((t) => t.name.startsWith("fx__")));
  await ctx.plugins.setEnabled("mcp-client", true);
  await ctx.mcpClient.settled();
  check("switching it back on reconnects from the saved settings", ctx.tools.has("fx__echo"));

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  app.exit(failed.length ? 1 : 0);
};

app.whenReady().then(run, (error) => {
  console.error(error);
  app.exit(1);
});
