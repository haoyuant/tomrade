/**
 * A failed turn shows its one line, with everything the engine knew folded
 * under Details — the model service's whole answer, an agent's own words —
 * ready to copy, with no key in it. The fix it offers follows the engine that
 * failed — model settings for the loop, its own sign-in for an agent — and
 * another ready agent can take the message. The pet keeps a turn's outcome —
 * tears or delight — until the thread runs again.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:error-details
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeFailure } from "@tomradex/agent";
import { codebuddyFailure } from "@tomradex/engine-workbuddy";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-error-details-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const endpoint = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => res.writeHead(401, { "content-type": "application/json", "x-request-id": "req_e2e_401" })
    .end('{"error":{"message":"Authentication Fails, Your api key sk-e2e0123456789abcdef is invalid","type":"authentication_error"}}'));
});

// What CodeBuddy answers a turn that failed upstream, as engine-acp hands it on.
const refusal = { stopReason: "refusal", _meta: { "codebuddy.ai/requestId": "r-1", "codebuddy.ai/errorMessage": JSON.stringify({ code: -32603, message: "Internal error", data: { details: "Request failed with status code 401", statusCode: 401, category: "internal" } }) } };

const run = async () => {
  await new Promise((r) => endpoint.listen(0, "127.0.0.1", r));
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  await ctx.storage.ready;
  ctx.agent.engine({
    id: "refusing",
    title: "Refusing",
    author: "ai:refusing",
    available: async () => ({ ok: true }),
    setup: { install: [], signIn: "refusing login" },
    async turn() {
      return { stop: "error", error: `Refusing stopped: ${codebuddyFailure(refusal)}`, details: describeFailure({ response: refusal, stderr: "warn: endpoint drift\n" }) };
    }
  });
  const settings = ctx.settings.get();
  ctx.settings.set({
    ...settings, language: "en", onboarding: { seen: ["*"] }, agent: { ...settings.agent, defaultEngine: "loop" },
    models: { profiles: [{ id: "bad", title: "Bad key", provider: "openai-compatible", baseURL: `http://127.0.0.1:${endpoint.address().port}/v1`, model: "flaky", apiKey: "sk-e2eSECRETKEY0123456789" }], roles: { worker: "bad" } }
  });

  const win = new BrowserWindow({ width: 1400, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  await win.loadURL(`${process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/"}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const send = async (text) => {
    await $(`(() => { const i = document.querySelector('.ai-input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(100);
    await $(`document.querySelector('.ai-send').click();true`);
  };
  const lastError = () => $(`(() => { const e = [...document.querySelectorAll('.ai-error')].pop(); const d = e?.querySelector('details');
    return e ? { line: e.querySelector(':scope > p')?.textContent ?? '', folded: !!d && !d.open, details: d?.querySelector('pre')?.textContent ?? '', copy: !!d?.querySelector('button') } : null; })()`);
  const pet = () => $(`document.querySelector('.pet-stage')?.dataset.petState ?? null`);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const actions = () => $(`[...([...document.querySelectorAll('.ai-error')].pop()?.querySelectorAll(':scope > .row button') ?? [])].map((b) => b.textContent.trim())`);
  const byText = (text) => `[...document.querySelectorAll('.ai-error .row button')].find((b) => b.textContent.includes(${JSON.stringify(text)}))`;
  await sleep(2500);

  // ── the loop: a 401 from the model service ───────────────────────────
  await send("hello");
  await sleep(2500);
  const loop = await lastError();
  check("a model error keeps its one line", loop?.line === "The model service refused the API key.", loop);
  check("with the details folded, not flooding the thread", loop?.folded === true, loop);
  check("the details hold the service's whole answer: status, URL, request id, body", !!loop && loop.details.includes('"status": 401') && loop.details.includes("/v1/chat/completions") && loop.details.includes("req_e2e_401") && loop.details.includes("authentication_error"), loop?.details);
  check("and never the key", !!loop && !loop.details.includes("SECRETKEY") && !loop.details.includes("0123456789abcdef"), loop?.details);
  check("a copy button sits with them", loop?.copy === true, loop);
  check("the pet cries", (await pet()) === "error", await pet());
  await sleep(4000);
  check("and keeps crying past the old 3 s", (await pet()) === "error", await pet());
  const loopActions = await actions();
  check("the loop's key error leads to model settings, with a retry beside it", loopActions.includes("Open model settings") && loopActions.includes("Try again"), loopActions);
  check("and never to an agent's sign-in", !loopActions.some((a) => a.startsWith("Sign in")), loopActions);

  await $(`[...document.querySelectorAll('.ai-error details')].pop().open = true;true`);
  await sleep(300);
  fs.mkdirSync(path.join(work, "shots"), { recursive: true });
  const shot = path.join(process.env.TOMRADE_SHOTS ?? path.join(work, "shots"), "error-details-loop.png");
  fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
  console.log(`shot: ${shot}`);

  // ── an ACP agent: its own words in the line, its answer under Details ─
  const thread = ctx.agent.newThread(project.id, "refusing");
  ctx.agent.send(project.id, thread.id, { kind: "text", text: "hi" });
  await sleep(2000);
  const shown = await ctx.agent.store.messages(project.id, thread.id).find((m) => m.block.type === "error")?.block;
  check("an agent's refusal says the agent's own words", shown?.text === "Refusing stopped: Request failed with status code 401", shown);
  check("with the whole answer and its stderr under details", !!shown?.details && shown.details.includes('"statusCode\\":401') && shown.details.includes("endpoint drift"), shown?.details);

  // ── on screen: the agent's own sign-in, never Tomrade's model settings ─
  await $(`localStorage.setItem(${JSON.stringify(`tomrade.agent.thread.${project.id}`)}, ${JSON.stringify(thread.id)}); location.reload(); true`);
  await sleep(3000);
  const agent = await lastError();
  check("an agent's 401 is said as its sign-in, by name", agent?.line === "Refusing did not accept its sign-in.", agent);
  const agentActions = await actions();
  check("it offers the agent's own sign-in", agentActions.includes("Sign in to Refusing again"), agentActions);
  check("not Tomrade's model settings, which would not fix it", !agentActions.includes("Open model settings"), agentActions);
  check("and another agent to take the message", agentActions.some((a) => a.startsWith("Try another agent")), agentActions);
  await press(byText("Try another agent"));
  await sleep(500);
  fs.writeFileSync(shot.replace("loop", "agent"), (await win.webContents.capturePage()).toPNG());
  const offered = await $(`[...document.querySelectorAll('[role="menu"] .m-name')].map((n) => n.textContent)`);
  check("the ready agents are offered, the failing one left out", offered.includes("Tomrade") && !offered.includes("Refusing"), offered);

  // ── running again stops the crying ───────────────────────────────────
  endpoint.removeAllListeners("request");
  endpoint.on("request", (req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"pong"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); }); });
  await press(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((n) => n.querySelector(".m-name")?.textContent === "Tomrade")`);
  await sleep(3000);
  const moved = ctx.agent.store.thread(project.id, thread.id);
  check("picking one moves the thread to it", moved?.engine === "tomrade", moved?.engine);
  const after = ctx.agent.store.messages(project.id, thread.id);
  const resent = after.filter((m) => m.role === "user").map((m) => m.block.text);
  check("and sends the failed message again", resent.length === 2 && resent[1] === "hi", resent);
  check("which the other agent answers", after.at(-1)?.block.type === "text" && after.at(-1).block.text === "pong", after.at(-1)?.block);
  check("the next turn's outcome replaces the tears", (await pet()) === "success", await pet());
  await sleep(4000);
  check("and a success stays too, past the old 3 s", (await pet()) === "success", await pet());

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  endpoint.close();
  app.exit(failed.length ? 1 : 0);
};

app.whenReady().then(() => run().catch((error) => { console.error(error); app.exit(1); }));
