/**
 * Upgrading a Tomrade whose local agents were built in to one where they are
 * official plugins (TOM-378), on a machine that cannot reach GitHub: each one
 * comes back from the packages the app carries as the app starts, under the
 * same engine id, with the person's settings, kept model lists, connections
 * and threads as they were, and the row the person had switched off still off.
 *
 *   pnpm build:backend && pnpm --filter @tomrade/desktop bundle:official   then
 *   pnpm --filter @tomrade/desktop test:agent-plugins
 */
import { app } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { boot } from "../dist/boot.js";
import { trustedKeys } from "../dist/trust.js";
import { registerExtensionResolution } from "../dist/extension-resolve.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
// As the app does: an installed plugin imports the SDK, zod and cordis it runs with.
registerExtensionResolution([path.resolve(dir, "../../..")]);
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-agent-plugins-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const AGENTS = { hermes: "tomrade/hermes", dsh: "tomrade/dsh", opencode: "tomrade/opencode", workbuddy: "tomrade/workbuddy", gemini: "tomrade/gemini-cli", agy: "tomrade/antigravity", cursor: "tomrade/cursor" };

const run = async () => {
  const bundle = path.join(dir, "../official-plugins");
  if (!fs.existsSync(path.join(bundle, "catalog.json"))) throw new Error(`${bundle} is empty: run pnpm --filter @tomrade/desktop bundle:official first`);

  // What an earlier Tomrade left: settings for every agent, Gemini CLI and Antigravity switched off, a kept model list.
  const engines = {
    hermes: { command: "hermes", model: "openrouter:some/model" },
    dsh: { command: "dsh", effort: "high" },
    opencode: { command: "opencode", model: "deepseek/deepseek-flash" },
    workbuddy: { command: "codebuddy", model: "hy3", effort: "high", permissionMode: "ask" },
    gemini: { command: "gemini", model: "gemini-2.5-pro" },
    agy: { model: "fast" },
    cursor: { model: "gpt-5" }
  };
  fs.writeFileSync(path.join(work, "settings.json"), JSON.stringify({ language: "en", onboarding: { seen: ["*"] }, agent: { defaultEngine: "hermes", engines } }));
  const patchFile = path.join(work, "tomrade.patch.yml");
  fs.writeFileSync(patchFile, "plugins:\n  - id: engine-terminal\n    disabled: true\n");
  fs.mkdirSync(path.join(work, "cache"), { recursive: true });
  const kept = { hermes: { models: [{ value: "openrouter:kept/model" }], efforts: [] } };
  fs.writeFileSync(path.join(work, "cache", "acp-models.json"), JSON.stringify(kept));
  const hermesHome = path.join(work, "hermes-home");
  fs.mkdirSync(hermesHome, { recursive: true });
  process.env.HERMES_HOME = hermesHome;

  // No host answers: the catalog address is refused, so all of it has to come from the app.
  const { plugins } = parse(fs.readFileSync(path.join(dir, "../tomrade.yml"), "utf8"));
  const community = plugins.find((row) => row.id === "community").config;
  const refused = "http://127.0.0.1:9/catalog.json";
  const t0 = Date.now();
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work },
    patchFiles: [patchFile],
    // As the app starts: the installed plugins' folder, and Tomrade's own signing key.
    extensions: { root: path.join(work, "plugins"), trustedKeys: trustedKeys(), appVersion: null },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "community", config: { ...community, officialCatalog: { ...community.officialCatalog, url: refused } } }]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  const project = ctx.projects.create({ name: "Upgrade", keyPrefix: "UP" });
  // A thread Hermes held before the upgrade, written before its plugin is back.
  const thread = ctx.agent.store.createThread(project.id, "hermes", "From before");

  const on = ["hermes", "dsh", "opencode", "workbuddy", "cursor"];
  for (let waited = 0; waited < 30_000 && !on.every((id) => ctx.agent.engineOf(id)); waited += 100) await sleep(100);
  const seconds = (Date.now() - t0) / 1000;
  check("every agent that was on is back as the app starts, from the app's own packages", on.every((id) => ctx.agent.engineOf(id)), on.filter((id) => !ctx.agent.engineOf(id)));
  check("within a few seconds, not at the first check", seconds < 15, seconds);
  const snapshot = ctx.plugins.snapshot().plugins;
  const state = (id) => snapshot.find((p) => p.id === id)?.state;
  check("each from the official catalog the app carries", Object.values(AGENTS).every((id) => ctx.plugins.extensions.info(id)?.tier === "official"), Object.values(AGENTS).map((id) => [id, ctx.plugins.extensions.info(id)?.version]));
  check("Gemini CLI and Antigravity stay off, as their row was", state("tomrade/gemini-cli") === "disabled" && state("tomrade/antigravity") === "disabled" && !ctx.agent.engineOf("gemini") && !ctx.agent.engineOf("agy"), [state("tomrade/gemini-cli"), state("tomrade/antigravity")]);
  check("and the rest are on", on.every((id) => state(AGENTS[id]) === "active"), on.map((id) => [id, state(AGENTS[id]), snapshot.find((p) => p.id === AGENTS[id])?.error]));

  const after = ctx.settings.get().agent;
  check("the person's settings for every agent are as they were", JSON.stringify(after.engines) === JSON.stringify(engines), after.engines);
  check("and Hermes is still the default", after.defaultEngine === "hermes", after.defaultEngine);
  check("Hermes' kept model list is its pick before any session", JSON.stringify(ctx.agent.engineOf("hermes").picks()[0].choices) === JSON.stringify(kept.hermes.models), ctx.agent.engineOf("hermes").picks());
  check("the thread from before still belongs to Hermes", ctx.agent.store.thread(project.id, thread.id)?.engine === "hermes");
  check("WorkBuddy's settings schema is the one Settings draws", !!ctx.agent.engineOf("workbuddy").options?.safeParse(engines.workbuddy).success);

  // A connection made before the upgrade reads as connected, with nothing to redo.
  fs.writeFileSync(path.join(hermesHome, "config.yaml"), `mcp_servers:\n  tomrade:\n    url: ${ctx.mcp.url}\n`);
  check("Hermes' existing connection reads as connected", (await ctx.agent.engineOf("hermes").mcpLink.status()).state === "connected");
  check("the patch file is as the person left it", fs.readFileSync(patchFile, "utf8") === "plugins:\n  - id: engine-terminal\n    disabled: true\n");
  // Each is written down once its install is through, a moment after its engine registers.
  const startersFile = path.join(work, "official-starters.json");
  const written = () => (fs.existsSync(startersFile) ? JSON.parse(fs.readFileSync(startersFile, "utf8")) : []);
  for (let waited = 0; waited < 10_000 && !Object.values(AGENTS).every((id) => written().includes(id)); waited += 100) await sleep(100);
  const starters = written();
  check("each is put on once, not again at the next start", Object.values(AGENTS).every((id) => starters.includes(id)), starters);
  await ctx.fiber.dispose();
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.error(err);
    check("the check ran to the end", false);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (passed < results.length) console.log(`failed: ${results.filter((r) => !r.pass).map((r) => r.name).join(" | ")}`);
  app.exit(passed === results.length ? 0 : 1);
});
