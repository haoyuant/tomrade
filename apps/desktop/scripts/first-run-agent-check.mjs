/**
 * A first run with a local agent that is found but cannot run (TOM-503): the
 * setup screen opens and says what is wrong, instead of being skipped because
 * the agent was found. Once the agent lists its models and answers the test
 * message setup sends it (TOM-525), the screen says it is set, and a later
 * launch goes straight to the projects. A stand-in ACP agent fails to open a
 * session ("model not found") until a flag file says it works.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:first-run-agent
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { boot } from "../dist/boot.js";
import { quietStarters } from "./official-agents.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-first-run-agent-"));
app.setPath("userData", work);
quietStarters(work);
const shots = path.join(dir, "shots");
fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

// The stand-in agent: answers ACP, but refuses to open a session while the flag file says it is broken.
const flag = path.join(work, "agent-state");
const agentJs = path.join(work, "fake-agent.mjs");
fs.writeFileSync(
  agentJs,
  `import fs from "node:fs";
if (process.argv.includes("--version")) { console.log("fake-agent 1.0.0"); process.exit(0); }
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
    const m = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
    if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [] } });
    else if (m.method === "session/new") {
      if (fs.readFileSync(${JSON.stringify(flag)}, "utf8").trim() !== "works") send({ id: m.id, error: { code: -32603, message: "Model not found: default-model" } });
      else send({ id: m.id, result: { sessionId: "s1", configOptions: [{ id: "model", category: "model", type: "select", currentValue: "fast", options: [{ value: "fast", name: "Fast" }, { value: "deep", name: "Deep" }] }] } });
    } else if (m.method === "session/prompt") {
      send({ method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } } } });
      send({ id: m.id, result: { stopReason: "end_turn" } });
    } else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: "not here" } });
  }
});
process.stdin.on("end", () => process.exit(0));
`
);
const bin = path.join(work, "bin", "fake-agent");
fs.mkdirSync(path.dirname(bin), { recursive: true });
// This Electron runs it as Node.
fs.writeFileSync(bin, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${agentJs}' "$@"\n`, { mode: 0o755 });
fs.writeFileSync(flag, "broken");

const run = async () => {
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work, locale: "en-US" },
    // Only the stand-in can answer: this machine's own agents stay out.
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, ...["engine-claude-code", "engine-codex", "engine-pi", "engine-pi-builtin"].map((id) => ({ id, disabled: true }))]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", agent: { ...settings.agent, engines: { ...settings.agent?.engines, "fake-agent": { command: bin } } } });
  // Found, signed in, and lending its sign-in to planning: before TOM-503 that was enough to skip the screen.
  ctx.localAgents.register({
    id: "fake-agent",
    title: "Fake Agent",
    cli: { name: "fake-agent" },
    install: "install Fake Agent",
    setup: { install: ["npm install -g fake-agent"], suggested: true },
    options: z.object({ command: z.string().optional() }),
    acp: { permissionModes: { default: "ask", choices: [{ value: "ask", label: "Ask" }] }, args: () => ["--acp"] },
    lend: { ask: async () => ({ text: "pong", inputTokens: 1, outputTokens: 1 }) }
  });
  const view = async (fresh = false) => (await ctx.agent.engineViews(fresh)).find((e) => e.id === "fake-agent");
  const settled = async () => {
    for (let i = 0; i < 100; i++) {
      const v = await view();
      if (v && !v.picks?.[0]?.pending) return v;
      await sleep(100);
    }
    return view();
  };
  const broken = await settled();
  check("the agent is found and signed in", broken?.ok === true, broken);
  check("but could not list its models, and the engine says why", /Model not found/.test(broken?.picks?.[0]?.failed ?? ""), broken?.picks);
  check("planning would still take its sign-in", (await ctx.llm.worker()).ok, await ctx.llm.worker());

  const win = new BrowserWindow({ width: 1280, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  await win.loadURL(process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/");
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const has = (selector) => $(`!!document.querySelector(${JSON.stringify(selector)})`);
  const text = (selector) => $(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`);
  const wait = async (cond, what, tries = 150) => {
    for (let i = 0; i < tries; i++) {
      if (await cond()) return true;
      await sleep(100);
    }
    console.log(`timed out waiting for ${what}`);
    return false;
  };
  const shot = async (name) => {
    await sleep(600);
    fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };

  // ── found but broken: the screen opens and says what is wrong ─────────
  check("a first run with an agent that cannot run opens on connecting an AI", await wait(() => has('[data-testid="first-run-setup"]'), "first-run setup"));
  const row = '[data-testid="local-agents"] [data-engine="fake-agent"]';
  check("the agent's row says it cannot run yet", await wait(async () => (await $(`document.querySelector(${JSON.stringify(row)})?.dataset.health ?? null`)) === "broken", "broken row"), await text(row));
  check("and shows what its agent said", ((await text('[data-testid="problem-fake-agent"]')) ?? "").includes("Model not found: default-model"), await text('[data-testid="problem-fake-agent"]'));
  check("with a way to look again", await has('[data-testid="setup-recheck"]'));
  await shot("first-run-agent-01-broken");

  // ── fixed: looking again finds it working, and the screen says so ─────
  fs.writeFileSync(flag, "works");
  await $(`document.querySelector('[data-testid="setup-recheck"]').click()`);
  check("once it lists its models and answers its test message, the screen says Tomrade is set", await wait(() => has('[data-testid="setup-done"]'), "done panel", 300), await text(row));
  check("with the agent as the assistant", ((await text('[data-testid="setup-done"]')) ?? "").includes("Assistant: Fake Agent"), await text('[data-testid="setup-done"]'));
  await shot("first-run-agent-02-fixed");

  // ── working: a launch with nothing seen yet goes straight to the projects ──
  check("the screen was never put away by hand", !(ctx.settings.get().onboarding?.seen ?? []).includes("setup-screen"));
  await win.webContents.reload();
  check("with a working agent, the next launch skips the screen", (await wait(() => has(".proj-grid"), "home")) && !(await has('[data-testid="first-run-setup"]')));
  await sleep(1500);
  check("and it stays skipped", !(await has('[data-testid="first-run-setup"]')));
  await shot("first-run-agent-03-skipped");
  console.log(`screenshots in ${shots}`);
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
