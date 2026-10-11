/**
 * A first run, end to end: the app opens on the sample project and nothing
 * else, its learning path draws as a graph, the assistant says what is still
 * missing and can be told to stop, the hints show once and stay seen, and the
 * sample can be made again — in the person's language — after it is deleted.
 * A stand-in engine that writes one ticket makes the run deterministic.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:onboarding
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-onboarding-"));
app.setPath("userData", work);
const shots = path.join(dir, "shots");
fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const run = async () => {
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work, locale: "en-US" },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;

  // ── the first run ─────────────────────────────────────────────────────
  const [sample] = ctx.projects.list();
  check("a first run opens on the sample project, and only on it", ctx.projects.list().length === 1 && sample?.sample === true && sample.name === "Tomrade tour", ctx.projects.list());
  check("its seed left nothing in History", ctx.db.for(sample.id).prepare("SELECT COUNT(*) AS n FROM oplog").get().n === 0);
  const written = await ctx.storage.writeHub();
  check("the account's catalog never hears of it", !!written && !written.projects.some((p) => p.id === sample.id), written);

  // A stand-in that can take a ticket and writes one: the setup card then has something ready and something missing.
  ctx.agent.engine({
    id: "writer",
    title: "Writer",
    author: "ai:writer",
    capabilities: ["backlog", "general"],
    available: async () => ({ ok: true }),
    async turn(_input, io) {
      const title = "Written by the assistant";
      await io.tools.execute("find_similar", { title });
      await io.tools.execute("create_item", { title });
      io.emit({ type: "text", text: "added one" });
      return { stop: "end" };
    }
  });
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", agent: { ...settings.agent, defaultEngine: "writer" } });

  const win = new BrowserWindow({ width: 1440, height: 960, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(base);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const has = (selector) => $(`!!document.querySelector(${JSON.stringify(selector)})`);
  const texts = (selector) => $(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((n) => n.textContent.trim())`);
  const press = (js) =>
    $(`(() => { const n = ${js}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const byText = (selector, text) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((n) => n.textContent.trim() === ${JSON.stringify(text)})`;
  const wait = async (cond, what, tries = 150) => {
    for (let i = 0; i < tries; i++) {
      if (await cond()) return true;
      await sleep(100);
    }
    console.log(`timed out waiting for ${what}`);
    return false;
  };
  const shot = async (name) => fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const seen = () => ctx.settings.get().onboarding?.seen ?? [];
  const toasts = () => texts(".toast .toast-body");
  const send = async (text) => {
    await $(`(() => { const i = document.querySelector('.ai-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(100);
    await $(`document.querySelector('.ai-send').click();true`);
  };

  // ── the projects home ─────────────────────────────────────────────────
  check("the home shows the sample", await wait(() => $(`!!${byText(".proj .proj-name", "Tomrade tour")}`), "sample card"));
  check("marked as the tour", (await texts(".proj .tag")).includes("Tour"));
  check("and offers no second one while it exists", !(await has(".proj-sample")));
  await shot("onboarding-01-home");

  // ── the sample, opened ────────────────────────────────────────────────
  await press(`${byText(".proj .proj-name", "Tomrade tour")}?.closest('.proj')`);
  check("it opens on its board", await wait(() => $(`!!${byText(".card-title", "Drag this ticket to Done")}`), "first tour ticket"));
  check("with the tour and the practice backlog as workstreams", await wait(async () => {
    const rows = await texts(".side-workstreams .side-name");
    return rows.includes("Getting started") && rows.includes("Example: Pomodoro app");
  }, "workstreams"));
  check("the learning path is a view in the sidebar", await wait(() => $(`!!${byText(".side-views .side-name", "Learning path")}`), "learning path view"));
  await press(`${byText(".side-views .side-name", "Learning path")}?.closest('a, button, .side-row')`);
  check("and draws as a graph", await wait(() => has('.board-region[data-layout="graph"]'), "graph layout"));
  await shot("onboarding-02-learning-path");
  check("the sample teaches the graph itself, so no graph hint", !(await toasts()).some((t) => t.includes("Switch a view's layout to Graph")));

  // ── what the assistant still needs ────────────────────────────────────
  check("the assistant shows what is set up and what is missing", await wait(() => has(".agent-setup"), "setup card"));
  check("the model is missing, with the way to connect one", await $(`(() => { const row = document.querySelector('[data-setup="model"]'); return !!row && !row.classList.contains('is-ok') && !!row.querySelector('.setup-action'); })()`));
  await shot("onboarding-03-setup-card");
  await press(`document.querySelector('.setup-hide')`);
  check("Hide puts the card away", await wait(async () => !(await has(".agent-setup")), "card hidden"));
  check("and it stays seen", await wait(async () => seen().includes("setup-card"), "seen setup-card"));

  // ── the first write, and the hint beside it ───────────────────────────
  await send("add one");
  check("the run's changes come with a hint about undoing them", await wait(() => has('.run-wrap .hint[data-hint="hint.revert"]'), "revert hint", 200));
  await shot("onboarding-04-revert-hint");
  await press(`document.querySelector('.hint[data-hint="hint.revert"] .hint-ok')`);
  check("Got it puts it away", await wait(async () => !(await has(".hint")), "hint gone"));
  check("for good", await wait(async () => seen().includes("hint.revert"), "seen hint.revert"));
  win.webContents.reload();
  await sleep(2500);
  check("a reload does not bring the card or the hint back", (await has(".run-wrap")) && !(await has(".hint")) && !(await has(".agent-setup")));

  // ── Start, pointed out once ───────────────────────────────────────────
  const tour = ctx.items.list({ projectId: sample.id }).filter((i) => i.title !== "Written by the assistant");
  await $(`location.hash = '#/p/${sample.id}/i/${tour[1].id}';true`);
  check("a ticket a local agent could take points at Start", await wait(async () => (await toasts()).some((t) => t.includes("Start hands this ticket")), "start hint"));
  check("once", seen().includes("hint.start"));
  await $(`document.querySelectorAll('.toast .btn-ghost').forEach((b) => b.textContent.trim() === 'Got it' && b.click());true`);
  await $(`location.hash = '#/p/${sample.id}/i/${tour[2].id}';true`);
  await sleep(1500);
  check("and not again on the next ticket", !(await toasts()).some((t) => t.includes("Start hands this ticket")));

  // ── the first dependency elsewhere points at the graph ────────────────
  const plain = ctx.projects.create({ name: "Plain", keyPrefix: "PLN" });
  const board = ctx.boards.list(plain.id)[0];
  const a = ctx.items.create({ projectId: plain.id, boardId: board.id, title: "First", by: "human" });
  const b = ctx.items.create({ projectId: plain.id, boardId: board.id, title: "Second", by: "human" });
  ctx.items.addRelation(plain.id, a.id, b.id);
  await $(`location.hash = '#/p/${plain.id}';true`);
  check("a project whose tickets depend on each other points at the graph", await wait(async () => (await toasts()).some((t) => t.includes("Switch a view's layout to Graph")), "graph hint"));
  check("seen as soon as it is shown", seen().includes("hint.graph"));

  // ── deleted, and made again in the person's language ──────────────────
  ctx.projects.remove(sample.id);
  ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
  await win.loadURL(base);
  await sleep(1500);
  check("without a sample, the home offers to make one", await wait(() => has(".proj-sample"), "sample tile"));
  await shot("onboarding-05-sample-tile");
  await press(`document.querySelector('.proj-sample')`);
  const again = async () => ctx.projects.list().find((p) => p.sample);
  check("it is made again, in Chinese", await wait(async () => (await again())?.name === "Tomrade 入门", "zh sample"));
  const zh = await again();
  check("its workstreams are named in Chinese too", ctx.boards.list(zh.id).map((b) => b.name).join("|") === "入门|示例：番茄钟 App", ctx.boards.list(zh.id).map((b) => b.name));
  check("and the app opens it", await wait(async () => (await $(`location.hash`)).includes(zh.id), "navigated"));
  await shot("onboarding-06-zh-sample");

  // ── someone who does not want it can say so ───────────────────────────
  ctx.projects.remove(zh.id);
  await win.loadURL(base);
  check("deleted again, the offer is back", await wait(() => has(".proj-sample"), "sample tile again"));
  await press(`document.querySelector('.proj-sample-hide')`);
  check("and its × puts it away", await wait(async () => !(await has(".proj-sample")), "tile hidden"));
  check("for good", await wait(async () => seen().includes("sample-tile"), "seen sample-tile"));

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
