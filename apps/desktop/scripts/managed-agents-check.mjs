/**
 * Tomrade's own copies of agents, for real (TOM-536): Codex and CodeBuddy are
 * installed from the npm registry into this run's own data folder by the
 * bundled npm on Tomrade's runtime, put on trial, sent one real test message
 * through agent.tryEngine, and kept only once they answer. Both CLIs must
 * already be signed in on this machine; the copies share that sign-in. Slow
 * (several hundred MB) and needs the network, so it is not part of test:ui.
 * The person's npm config, PATH and sign-ins are left as they are.
 *
 *   pnpm --filter @tomrade/desktop fetch:npm && pnpm build:backend   then
 *   pnpm --filter @tomrade/desktop test:managed-agents
 */
import { app } from "electron";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { boot } from "../dist/boot.js";
import { quietStarters } from "./official-agents.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-managed-"));
app.setPath("userData", work);
quietStarters(work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};
const digest = (file) => (fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "absent");
const npmrc = path.join(os.homedir(), ".npmrc");
const before = { npmrc: digest(npmrc), path: process.env.PATH };

const run = async () => {
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work, locale: "en-US" },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, ...["engine-claude-code", "engine-pi", "engine-pi-builtin"].map((id) => ({ id, disabled: true }))]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  const project = ctx.projects.create({ name: "Managed agents", keyPrefix: "MA" });
  // CodeBuddy as its official plugin (tomrade-plugins/workbuddy) declares it, without its catalog and links.
  ctx.localAgents.register({
    id: "workbuddy",
    title: "CodeBuddy (WorkBuddy)",
    cli: { name: "codebuddy" },
    install: "install the CodeBuddy CLI",
    setup: { install: [{ npm: "@tencent-ai/codebuddy-code" }], signIn: "codebuddy", signInRuns: true },
    options: z.object({ command: z.string().default("codebuddy"), model: z.string().optional() }),
    acp: {
      permissionModes: { default: "full-access", choices: [{ value: "full-access", label: "Full access" }] },
      args: () => ["--acp"],
      env: () => ({ CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY: "1" }),
      mode: (policy) => (policy === "full-access" ? "bypassPermissions" : "default")
    }
  });
  check("agent-setup manages copies under this run's data folder", ctx.agentSetup.managed?.config.dir === path.join(work, "agents"), ctx.agentSetup.managed?.config);
  check("with the bundled npm", fs.existsSync(ctx.agentSetup.managed?.config.npmCli ?? ""), ctx.agentSetup.managed?.config.npmCli);

  for (const engineId of ["codex", "workbuddy"]) {
    console.log(`\n── ${engineId} ──`);
    const offer = await ctx.agentSetup.managedOffer(engineId);
    console.log(`offer: ${JSON.stringify(offer)}`);
    check(`${engineId}: the size is known before installing`, offer?.bytes > 0, offer);
    const started = Date.now();
    ctx.agentSetup.start(engineId, "install", { managed: true });
    let progress = ctx.agentSetup.state(engineId);
    let shown = "";
    while (progress?.phase !== "done" && progress?.phase !== "failed") {
      await sleep(1000);
      progress = ctx.agentSetup.state(engineId);
      const line = progress?.output?.split("\n").at(-1) ?? progress?.phase;
      if (line && line !== shown) console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${line.slice(0, 160)}`);
      shown = line;
    }
    check(`${engineId}: Tomrade's own copy installs`, progress.phase === "done", progress);
    if (progress.phase !== "done") continue;
    console.log(`installed ${progress.version} in ${Math.round((Date.now() - started) / 1000)}s`);
    const trial = ctx.agentSetup.managed.stateOf(engineId);
    check(`${engineId}: it is on trial before its test`, trial?.trial === offer.version && !trial.current, trial);
    const view = await ctx.agent.engineOf(engineId).available({ fresh: true });
    console.log(`found: ${view.cli?.path} (${view.cli?.source}) ${view.cli?.version}; ok=${view.ok} ${view.reason ?? ""}`);
    check(`${engineId}: the locator takes Tomrade's copy`, view.cli?.source === "managed" && view.cli.path.startsWith(path.join(work, "agents")), view.cli);
    const tried = await ctx.agent.tryEngine(project.id, engineId);
    console.log(`test message: ${JSON.stringify(tried)}`);
    check(`${engineId}: a real test message gets a reply`, tried.ok && !!tried.reply, tried);
    await sleep(500);
    const kept = ctx.agentSetup.managed.stateOf(engineId);
    check(`${engineId}: answered, it becomes the copy in use`, kept?.current === offer.version && !kept.trial, kept);
    const after = await ctx.agent.engineOf(engineId).available({ fresh: true });
    check(`${engineId}: and is still the one found`, after.cli?.source === "managed", after.cli);
  }
  check("the person's ~/.npmrc is untouched", digest(npmrc) === before.npmrc);
  check("and Tomrade's own PATH did not take the copies' folders", !String(process.env.PATH).includes(path.join(work, "agents")), process.env.PATH);
  console.log(`\ndata folder: ${work}`);
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
