/**
 * Connecting an AI on a first run, end to end: the screen before the projects
 * finds a key already exported in the shell, says in plain words why a pasted
 * key does not work, connects the found one with a click, and says what that
 * unlocked — the assistant, the built-in agent for Start, planning. Then the
 * built-in agent (the bundled Pi, run by this Electron as Node) takes a turn.
 * A stand-in OpenAI-compatible endpoint plays DeepSeek, so nothing is spent.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:setup
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";
import { quietStarters } from "./official-agents.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-setup-"));
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

// DeepSeek's stand-in: lists models, refuses any key but sk-good…, and answers chat with one Tomrade tool call, then text.
const requests = [];
const endpoint = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.headers.authorization?.startsWith("Bearer sk-good")) return res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"Authentication Fails, Your api key is invalid"}}');
    if (req.url.endsWith("/models")) return res.writeHead(200, { "content-type": "application/json" }).end('{"object":"list","data":[{"id":"deepseek-reasoner"},{"id":"deepseek-v4-flash"}]}');
    const request = JSON.parse(body || "{}");
    requests.push(request);
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const listItems = (request.tools ?? []).map((t) => t.function.name).find((name) => name.endsWith("list_items"));
    if (listItems && !request.messages.some((m) => m.role === "tool")) return res.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: listItems, arguments: "{}" } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
    res.end(chunk({ role: "assistant", content: "pong — 1 item" }) + chunk({}, "stop") + "data: [DONE]\n\n");
  });
});

const run = async () => {
  await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  const fake = `http://127.0.0.1:${endpoint.address().port}`;
  // The app's own requests to DeepSeek go to the stand-in; a key exported in the shell is what detection finds.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => realFetch(String(url).replace("https://api.deepseek.com", fake), init);
  for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MOONSHOT_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY"]) delete process.env[name];
  process.env.DEEPSEEK_API_KEY = "sk-good-from-shell-1a2b";

  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work, locale: "en-US" },
    // This machine may have a local agent signed in, which would make the screen unnecessary.
    // Tomrade hands its backlog turns to the built-in pi here too, so the turn below runs the bundled agent.
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "engine-tomrade", config: { backlog: "pi-builtin" } }, ...["engine-claude-code", "engine-codex", "engine-pi"].map((id) => ({ id, disabled: true }))]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en" });

  const win = new BrowserWindow({ width: 1280, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  await win.loadURL(process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/");
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const has = (selector) => $(`!!document.querySelector(${JSON.stringify(selector)})`);
  const text = (selector) => $(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`);
  const texts = (selector) => $(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((n) => n.textContent.trim())`);
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
  const shot = async (name) => {
    await sleep(600);
    fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };

  // ── the screen before the projects ────────────────────────────────────
  check("with nothing set up, a first run opens on connecting an AI", await wait(() => has('[data-testid="first-run-setup"]'), "first-run setup"));
  check("it finds the key exported in the shell, masked", await wait(async () => (await text('[data-detected="env:DEEPSEEK_API_KEY"] .setup-name')) === "DeepSeek key in your shell · DEEPSEEK_API_KEY · sk-…1a2b", "detected key"), await text('[data-detected="env:DEEPSEEK_API_KEY"] .setup-name'));
  const page = await $(`document.body.innerText`);
  check("the key itself never reaches the page", !page.includes("sk-good-from-shell"));
  check("Claude Code and Codex are not offered when their plugins are off", !(await has('[data-testid="local-agents"]')));
  await shot("setup-01-first-run");

  await click('[data-provider="deepseek"]');
  await type("#quickKey", "sk-bad-0000");
  await click('[data-testid="quick-connect"]');
  check("a wrong key is refused in plain words", await wait(async () => (await text('[data-testid="setup-problem"] p')) === "DeepSeek refused this API key.", "auth problem"), await text('[data-testid="setup-problem"] p'));
  check("and nothing is saved", !(ctx.settings.get().models?.profiles ?? []).length);
  await shot("setup-02-wrong-key");

  await click('[data-detected="env:DEEPSEEK_API_KEY"] .btn-primary');
  check("using the found key connects it", await wait(() => has('[data-testid="setup-done"]'), "done panel", 200));
  const profiles = ctx.settings.get().models?.profiles ?? [];
  check("as the first profile, on a model the provider lists", profiles[0]?.id === "deepseek" && profiles[0].model === "deepseek-v4-flash" && profiles[0].apiKey === "sk-good-from-shell-1a2b", profiles);
  const done = await texts('[data-testid="setup-done"] .setup-row');
  const bundled = fs.existsSync(path.join(dir, "../vendor/pi/dist/bundle/cli.js"));
  check("it says what that unlocked", done.includes("Assistant: Tomrade") && done.includes("Planning uses: DeepSeek") && (!bundled || done.includes("Start hands tickets to: Tomrade")), done);
  check("and points at the sample project next", (await text('[data-testid="setup-open-tour"]')) === "Open the sample project" && (await has('[data-testid="setup-continue"]')));
  await shot("setup-03-done");
  await click('[data-testid="setup-open-tour"]');
  check("which opens on its board, and the screen stays away for good", await wait(async () => (await texts(".card-title")).includes("Drag this ticket to Done") && (ctx.settings.get().onboarding?.seen ?? []).includes("setup-screen"), "sample board"));
  check("with no setup card in the assistant", await wait(() => has(".ai-input"), "assistant panel") && !(await has(".agent-setup")));
  await shot("setup-04-sample");

  // ── the built-in agent takes a turn ───────────────────────────────────
  if (!bundled) {
    console.log("vendor/pi is missing — run `pnpm --filter @tomrade/desktop fetch:pi` to check the built-in agent");
  } else {
    // Pi talks to the model itself, past this process's fetch: point the profile at the stand-in.
    ctx.settings.set({ ...ctx.settings.get(), models: { profiles: [{ ...profiles[0], baseURL: `${fake}/v1` }], roles: { worker: "" } } });
    // Tomrade answers for the built-in pi; "code" among what it can do means pi itself is ready.
    const view = (await ctx.agent.engineViews(true)).find((e) => e.id === "tomrade");
    check("the built-in agent is ready with nothing installed", view?.ok === true && view.capabilities.includes("code"), view);
    const project = ctx.projects.list()[0];
    const thread = ctx.agent.newThread(project.id, "tomrade");
    const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "How many items are there?" });
    await wait(() => ctx.agent.store.run(project.id, runId)?.status !== "running", "built-in run", 600);
    const runDone = ctx.agent.store.run(project.id, runId);
    const blocks = ctx.agent.store.messages(project.id, thread.id).map((m) => m.block);
    check("it conducts a turn on the profile, calling Tomrade's tools", runDone?.status === "done" && blocks.some((b) => b.type === "trace" && b.tool === "list_items" && b.ok) && blocks.some((b) => b.type === "text" && b.text.includes("pong")), runDone?.error ?? blocks);
    check("the key went only in the environment", !fs.readFileSync(path.join(work, "pi", "models.json"), "utf8").includes("sk-good"));
  }
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
