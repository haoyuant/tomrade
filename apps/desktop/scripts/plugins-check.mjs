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
  check("its tools go with it", !ctx.tools.list().some((t) => t.name === "list_stale_items"), ctx.tools.list().map((t) => t.name).join(","));
  check("the choice is written to the patch file", fs.existsSync(patchFile) && /disabled: true/.test(fs.readFileSync(patchFile, "utf8")));

  await ctx.plugins.setEnabled("stale", true);
  check("and switches back on", view("stale")?.state === "active");
  check("its tools come back", ctx.tools.list().some((t) => t.name === "list_stale_items"));

  // An optional module: the assistant injects it, so both come down together.
  await ctx.plugins.setEnabled("llm", false);
  check("an optional module can be emptied", module("llm")?.providers.length === 0);
  check("what injected it unloaded too", ctx.get("assistant") === undefined);
  check("and the row says why it is not running", view("assistant")?.state === "pending", JSON.stringify(view("assistant")));
  check("the spine is untouched", ctx.get("db") !== undefined && ctx.get("items") !== undefined);

  await ctx.plugins.setEnabled("llm", true);
  check("putting it back restores the assistant", ctx.get("assistant") !== undefined && view("assistant")?.state === "active");

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  app.exit(failed.length ? 1 : 0);
};

app.whenReady().then(run, (error) => {
  console.error(error);
  app.exit(1);
});
