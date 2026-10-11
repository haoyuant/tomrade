/** Real Electron/IPC/loop/Archify/Files regression with a deterministic HTTP model.
 * Start the UI dev server, then run Electron scripts/media-check.mjs.
 * ARCHIFY_TEST_SKILL may reuse a local checkout; otherwise verifies first installation.
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";
import { ArchifyRuntime, ARCHIFY_REVISION } from "@tomradex/archify";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-media-ui-"));
app.setPath("userData", work);
const checks = [];
const check = (name, pass) => { checks.push({ name, pass: !!pass }); console.log(`${pass ? "PASS" : "FAIL"}: ${name}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=";
let modelServer;
let ctx;
let win;

async function run() {
  const cache = path.join(work, "runtimes/archify");
  if (process.env.ARCHIFY_TEST_SKILL) {
    fs.mkdirSync(cache, { recursive: true });
    fs.cpSync(path.dirname(process.env.ARCHIFY_TEST_SKILL), path.join(cache, ARCHIFY_REVISION), { recursive: true });
  }
  const runtime = new ArchifyRuntime(cache);
  const skill = await runtime.ensureInstalled();
  check("managed runtime installs or reuses its pinned version", fs.existsSync(path.join(skill, "bin/archify.mjs")));
  const { example: spec } = await runtime.schema("architecture");
  const requests = [];
  modelServer = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const last = body.messages.at(-1);
    let delta;
    if (last.role === "tool") delta = { content: "The validated system diagram is displayed below." };
    else if (JSON.stringify(last.content).includes("Draw system diagram")) delta = {
      tool_calls: [{ index: 0, id: "draw", type: "function", function: { name: "diagram_render", arguments: JSON.stringify({ type: "architecture", spec, title: "System diagram" }) } }]
    };
    else if (JSON.stringify(last.content).includes("Generate image")) delta = { content: "Generated image", images: [{ image_url: { url: `data:image/png;base64,${png}` } }] };
    else delta = { content: "Image received." };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => modelServer.listen(0, "127.0.0.1", resolve));
  ({ ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]]
  }));
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Media regression", keyPrefix: "MED" });
  await ctx.storage.ready;
  ctx.settings.set({ ...ctx.settings.get(),
    models: { profiles: [{ id: "media", title: "Multimodal test", provider: "openai-compatible", baseURL: `http://127.0.0.1:${modelServer.address().port}/v1`, model: "media", apiKey: "", inputModalities: ["image"], outputModalities: ["image"] }, { id: "text", title: "Text only", provider: "openai-compatible", baseURL: `http://127.0.0.1:${modelServer.address().port}/v1`, model: "text", apiKey: "", inputModalities: [] }], roles: { worker: "media" } },
    agent: { defaultEngine: "loop", confirmWritesOver: 0, engines: { loop: { profile: "media" } }, playbookChoices: {} }
  });
  check("desktop loads Archify tools and playbook", ctx.tools.has("diagram_render") && ctx.agent.playbookIndex(project.id).some(p => p.id === "diagram.archify"));
  win = new BrowserWindow({ width: 1560, height: 1000, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", event => { if (event.level === "error") console.log(`[renderer] ${event.message}`); });
  await win.loadURL(process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5189/");
  const $ = js => win.webContents.executeJavaScript(js, true);
  const wait = async (predicate, name) => {
    for (let i = 0; i < 150; i++) { if (await predicate()) return; await sleep(100); }
    throw new Error(`Timed out: ${name}`);
  };
  await wait(() => $("!!document.querySelector('.proj')"), "project home");
  await $(`location.hash = '#/p/${project.id}'; true`);
  await wait(() => $("!!document.querySelector('.ai-input')"), "assistant composer");
  const send = async text => {
    await $(`(() => { const input = document.querySelector('.ai-input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(50);
    await $("document.querySelector('.ai-send').click()");
  };
  await send("Draw system diagram");
  await wait(() => $("!!document.querySelector('.turn-body iframe')"), "diagram in conversation");
  await wait(() => !ctx.agent.activeRuns().length, "diagram run finish");
  check("loop renders interactive HTML directly in conversation", await $("!!document.querySelector('.turn-body iframe')"));
  check("HTML preview cannot access the parent origin", await $("!document.querySelector('.turn-body iframe').sandbox.contains('allow-same-origin')"));
  check("preview does not automatically save to Files", (await ctx.files.tree(project.id)).length === 0);
  await $("[...document.querySelectorAll('figure button')].find(b => b.textContent === 'Expand').click()");
  await wait(() => $("!!document.querySelector('.palette iframe')"), "expanded diagram");
  await wait(async () => {
    const frames = win.webContents.mainFrame.frames;
    for (const frame of frames) {
      try { if (await frame.executeJavaScript("!!document.querySelector('svg')")) return true; } catch {}
    }
    return false;
  }, "actual SVG inside preview frame");
  await sleep(300);
  fs.writeFileSync(path.join(work, "diagram-expanded.png"), (await win.webContents.capturePage()).toPNG());
  check("expanded preview is readable and contained", await $("document.querySelector('.palette iframe').getBoundingClientRect().width > 700 && document.documentElement.scrollWidth <= innerWidth"));
  await $("document.querySelector('.palette .dlg-head button').click()");
  await $("[...document.querySelectorAll('figure button')].find(b => b.textContent === 'Save to Files').click()");
  await wait(async () => (await ctx.files.tree(project.id)).some(f => f.name === "diagram.json"), "HTML and source saved");
  const html = (await ctx.files.tree(project.id)).find(f => f.name === "System diagram.html");
  check("save retains HTML and editable JSON in Files", !!html && (await ctx.files.tree(project.id)).some(f => f.name === "diagram.json"));
  const saved = await ctx.files.read(project.id, html.path);
  check("saved artifact has immutable version reference", !!saved.fileId && !!saved.versionId);
  await send("Generate image");
  await wait(() => $("!!document.querySelector('.turn-ai figure img')"), "native generated image");
  check("native model image output displays inline", await $("document.querySelector('.turn-ai figure img').complete"));
  await wait(() => !ctx.agent.activeRuns().length, "image run finish");
  await $(`(() => { const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob('${png}'), c => c.charCodeAt(0))], 'input.png', { type: 'image/png' })); document.querySelector('.ai-foot').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); })()`);
  await wait(() => $("!!document.querySelector('.ai-foot img')"), "pending attachment preview");
  check("dropped image can be sent without text", await $("!document.querySelector('.ai-send').disabled"));
  await $("document.querySelector('.ai-send').click()");
  await wait(() => requests.some(request => request.messages.at(-1)?.content?.some?.(part => part.type === "image_url")), "image bytes on provider request");
  await wait(() => !ctx.agent.activeRuns().length, "attachment run finish");
  await wait(() => $("!!document.querySelector('.turn-user figure img')"), "user attachment in transcript");
  check("user attachment displays in the transcript", true);
  fs.writeFileSync(path.join(work, "conversation-media.png"), (await win.webContents.capturePage()).toPNG());
  await win.webContents.reload();
  await wait(() => $("!!document.querySelector('.turn-ai figure img') && !!document.querySelector('.turn-user figure img')"), "media after reload");
  check("media survives renderer reload", true);
  await $("(() => { const button = [...document.querySelectorAll('.ai-knobs button')].find(b => b.textContent.includes('Multimodal test')); button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })); })()");
  await wait(() => $("[...document.querySelectorAll('.m-name')].some(n => n.textContent === 'Text only')"), "model menu");
  await $("[...document.querySelectorAll('.m-name')].find(n => n.textContent === 'Text only').click()");
  await wait(() => $("document.querySelector('.ai-composer button[aria-label^=\"Attach\"]')?.disabled === true"), "text-only model attachment gate");
  check("text-only model disables attachment input", true);
}

app.whenReady().then(async () => {
  try { await run(); } catch (error) { console.error(error); check("harness completed", false); }
  finally {
    win?.destroy();
    await ctx?.fiber.dispose();
    modelServer?.close();
    console.log(`${checks.filter(c => c.pass).length}/${checks.length} checks passed; screenshots: ${work}`);
    app.exit(checks.some(c => !c.pass) ? 1 : 0);
  }
});
