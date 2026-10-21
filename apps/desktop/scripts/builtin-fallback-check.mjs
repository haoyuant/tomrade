/**
 * A first run where every local agent fails its test (TOM-538): setup shows
 * the ways to start in order, the person's own install marked failed, and
 * offers the built-in agent next. A model connected there and answering its
 * test completes setup, which says the built-in agent is the route in use,
 * and the built-in agent (the bundled Pi) then takes a turn. Two stand-in ACP
 * agents fail — one cannot list its models, the other cannot answer a prompt
 * — and a stand-in OpenAI-compatible endpoint plays DeepSeek.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:builtin-fallback
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { boot } from "../dist/boot.js";
import { ensureBundledPi } from "./bundled-pi.mjs";
import { quietStarters } from "./official-agents.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-builtin-fallback-"));
app.setPath("userData", work);
ensureBundledPi();
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

// The stand-in agents: "no-models" refuses every session; "no-reply" opens one but fails every prompt.
const agentJs = path.join(work, "fake-agent.mjs");
fs.writeFileSync(
  agentJs,
  `const mode = process.argv.at(-1);
if (process.argv.includes("--version")) { console.log("fake-agent 1.0.0"); process.exit(0); }
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
    const m = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
    if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [] } });
    else if (m.method === "session/new") {
      if (mode === "no-models") send({ id: m.id, error: { code: -32603, message: "Model not found: default-model" } });
      else send({ id: m.id, result: { sessionId: "s1", configOptions: [{ id: "model", category: "model", type: "select", currentValue: "fast", options: [{ value: "fast", name: "Fast" }] }] } });
    } else if (m.method === "session/prompt") send({ id: m.id, error: { code: -32603, message: "Quota exceeded for this account" } });
    else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: "not here" } });
  }
});
process.stdin.on("end", () => process.exit(0));
`
);
const bin = (mode) => {
  const file = path.join(work, "bin", mode);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${process.execPath}' '${agentJs}' "$@" ${mode}\n`, { mode: 0o755 });
  return file;
};

// DeepSeek's stand-in: lists models, refuses any key but sk-good…, and answers chat with one Tomrade tool call, then text.
const endpoint = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.headers.authorization?.startsWith("Bearer sk-good")) return res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"Authentication Fails, Your api key is invalid"}}');
    if (req.url.endsWith("/models")) return res.writeHead(200, { "content-type": "application/json" }).end('{"object":"list","data":[{"id":"deepseek-v4-flash"}]}');
    const request = JSON.parse(body || "{}");
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const listItems = (request.tools ?? []).map((t) => t.function.name).find((name) => name.endsWith("list_items"));
    if (listItems && !request.messages.some((m) => m.role === "tool")) return res.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: listItems, arguments: "{}" } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
    res.end(chunk({ role: "assistant", content: "pong" }) + chunk({}, "stop") + "data: [DONE]\n\n");
  });
});

const run = async () => {
  await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const fake = `http://127.0.0.1:${endpoint.address().port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(String(url).replace("https://api.deepseek.com", fake), init);
  for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MOONSHOT_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY"]) delete process.env[name];

  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work, locale: "en-US" },
    // Only the stand-ins are local agents here; Tomrade's backlog turns go to the built-in pi.
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "engine-tomrade", config: { backlog: "pi-builtin" } }, ...["engine-claude-code", "engine-codex", "engine-pi"].map((id) => ({ id, disabled: true }))]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", agent: { ...settings.agent, engines: { ...settings.agent?.engines, "no-models": { command: bin("no-models") }, "no-reply": { command: bin("no-reply") } } } });
  for (const [id, title] of [["no-models", "Agent One"], ["no-reply", "Agent Two"]]) {
    ctx.localAgents.register({
      id,
      title,
      cli: { name: `tomrade-${id}` },
      install: `install ${title}`,
      setup: { install: [`npm install -g ${id}`], suggested: true },
      options: z.object({ command: z.string().optional() }),
      acp: { permissionModes: { default: "ask", choices: [{ value: "ask", label: "Ask" }] }, args: () => ["--acp"] }
    });
  }

  const win = new BrowserWindow({ width: 1280, height: 1000, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  await win.loadURL(process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/");
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const has = (selector) => $(`!!document.querySelector(${JSON.stringify(selector)})`);
  const text = (selector) => $(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`);
  const click = (selector) => $(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; n.click(); return true; })()`);
  const type = (selector, value) =>
    $(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(n, ${JSON.stringify(value)}); n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const wait = async (cond, what, tries = 150) => {
    for (let i = 0; i < tries; i++) {
      if (await cond()) return true;
      await sleep(100);
    }
    console.log(`timed out waiting for ${what}`);
    return false;
  };
  const health = (id) => $(`document.querySelector('[data-testid="local-agents"] [data-engine="${id}"]')?.dataset.health ?? null`);
  const route = (id) => $(`document.querySelector('[data-testid="setup-routes"] [data-route="${id}"]')?.dataset.state ?? null`);
  const shot = async (name) => {
    await sleep(600);
    fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };

  // ── every local agent fails: the next route is offered ─────────────────
  check("a first run opens on connecting an AI", await wait(() => has('[data-testid="first-run-setup"]'), "first-run setup"));
  check("the agent that cannot list its models fails", await wait(async () => (await health("no-models")) === "broken", "no-models broken", 300), await health("no-models"));
  check("the agent whose test message gets no reply fails", await wait(async () => (await health("no-reply")) === "broken" && (await has('[data-testid="problem-no-reply"]')), "no-reply broken", 400), await health("no-reply"));
  check("setup offers the built-in agent as the next way to start", await wait(() => has('[data-testid="builtin-fallback"]'), "fallback"));
  check("showing the order: own install failed, then Tomrade's own copy, then the built-in agent", (await $(`[...document.querySelectorAll('[data-testid="setup-routes"] [data-route]')].map((n) => n.dataset.route).join(",")`)) === "own,managed,builtin" && (await route("own")) === "failed" && (await route("builtin")) === "pending");
  check("naming the agents that failed", /Agent One · Agent Two/.test((await text('[data-testid="setup-routes"] [data-route="own"]')) ?? ""), await text('[data-testid="setup-routes"] [data-route="own"]'));
  check("with the key form moved into that route, not offered twice", (await $(`document.querySelectorAll('[data-testid="quick-model"]').length`)) === 0);
  check("and nothing counts as set yet", !(await has('[data-testid="setup-done"]')));
  await $(`document.querySelector('[data-testid="builtin-fallback"]').scrollIntoView({ block: "center" })`);
  await shot("builtin-fallback-01-offered");

  // ── use the built-in agent: a model, its test, done ───────────────────
  await click('[data-testid="use-builtin"]');
  check("choosing it opens the quick model setup", await wait(() => has('[data-testid="builtin-fallback"] [data-testid="quick-model"]'), "quick model"));
  check("and the route is under way", (await route("builtin")) === "active", await route("builtin"));
  await click('[data-testid="builtin-fallback"] [data-provider="deepseek"]');
  await type("#quickKey", "sk-good-0000");
  await click('[data-testid="quick-connect"]');
  check("a model that answers its test completes setup", await wait(() => has('[data-testid="setup-done"]'), "done panel", 300), await text('[data-testid="builtin-fallback"]'));
  check("the model was tested, not only saved", (await ctx.llm.workerTest())?.ok === true, await ctx.llm.workerTest());
  check("setup says the built-in agent is the route in use", (await $(`document.querySelector('[data-testid="setup-route"]')?.dataset.route ?? null`)) === "builtin" && ((await text('[data-testid="setup-route"]')) ?? "").includes("DeepSeek"), await text('[data-testid="setup-done"]'));
  await shot("builtin-fallback-02-done");

  // ── and the built-in agent works ──────────────────────────────────────
  const view = (await ctx.agent.engineViews(true)).find((e) => e.id === "tomrade");
  check("the built-in agent can take tickets", view?.ok === true && view.capabilities.includes("code"), view);
  // Pi talks to the model itself, past this process's fetch: point the profile at the stand-in.
  const profiles = ctx.settings.get().models?.profiles ?? [];
  ctx.settings.set({ ...ctx.settings.get(), models: { ...ctx.settings.get().models, profiles: [{ ...profiles[0], baseURL: `${fake}/v1` }] } });
  const project = ctx.projects.list()[0];
  const thread = ctx.agent.newThread(project.id, "tomrade");
  const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "How many items are there?" });
  await wait(() => ctx.agent.store.run(project.id, runId)?.status !== "running", "built-in run", 600);
  const runDone = ctx.agent.store.run(project.id, runId);
  const blocks = ctx.agent.store.messages(project.id, thread.id).map((m) => m.block);
  check("and takes a turn on the model, calling Tomrade's tools", runDone?.status === "done" && blocks.some((b) => b.type === "trace" && b.tool === "list_items" && b.ok) && blocks.some((b) => b.type === "text" && b.text.includes("pong")), runDone?.error ?? blocks);
  console.log(`screenshots in ${shots}`);
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.error(err);
    check("the check ran to the end", false);
  }
  endpoint.close();
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (passed < results.length) console.log(`failed: ${results.filter((r) => !r.pass).map((r) => r.name).join(" | ")}`);
  app.exit(passed === results.length ? 0 : 1);
});
