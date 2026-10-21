/**
 * A first run, end to end: the app first asks to connect a model or a local
 * agent — and can be told "later" — then opens the sample project, on its
 * first lesson the first time, and nothing else; its learning path draws as a graph, the assistant keeps a
 * setup card until one is connected, the hints show once and stay seen, and the
 * sample can be made again from the home — in the person's language, on its
 * first lesson — after it is deleted, and the whole of it can be run again
 * from Settings → About, as often as wanted.
 * A stand-in engine that writes one ticket makes the run deterministic; the
 * local CLI agents are switched off, since this machine may have one signed in.
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
import { quietStarters } from "./official-agents.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-onboarding-"));
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

const run = async () => {
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work, locale: "en-US" },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, ...["engine-claude-code", "engine-codex", "engine-pi"].map((id) => ({ id, disabled: true }))]]
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
  const text = (selector) => $(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`);
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
    await $(`(() => { const i = document.querySelector('.ai-input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(100);
    await $(`document.querySelector('.ai-send').click();true`);
  };

  // ── connect an AI first ───────────────────────────────────────────────
  check("a first run asks to connect an AI before the projects", await wait(() => has('[data-testid="first-run-setup"]'), "first-run setup"));
  check("it offers to paste a key, providers in the reader's order", (await texts('[data-testid="quick-model"] .chip-opt'))[0] === "Anthropic" && (await has("#quickKey")), await texts('[data-testid="quick-model"] .chip-opt'));
  await $(`(() => { const i = document.querySelector('#quickKey'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'sk-ant-api03-abc'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  check("a pasted key picks its provider", await wait(async () => (await texts('[data-testid="quick-model"] .chip-opt.sel'))[0] === "Anthropic" && (await texts('[data-testid="quick-model"] .meta-txt')).some((t) => t === "Looks like a key from Anthropic."), "guess"));
  await shot("onboarding-00-connect");
  await press(`document.querySelector('[data-testid="setup-later"]')`);
  check("Set up later opens the sample project, and the screen stays away", await wait(async () => !(await has('[data-testid="first-run-setup"]')) && seen().includes("setup-screen") && (await $(`location.hash`)).startsWith(`#/p/${sample.id}/`), "later"));
  const lesson = () => $(`(() => { const d = document.querySelector('aside.detail'); const r = d?.getBoundingClientRect(); return d ? { label: d.getAttribute('aria-label'), left: r.left, right: r.right, width: innerWidth } : null; })()`);
  check("on its first lesson, open beside the board", await wait(async () => (await lesson())?.label?.endsWith("Drag this ticket to Done"), "first lesson"), await lesson());
  const shown = await lesson();
  check("in view without scrolling sideways", shown && shown.left >= 0 && shown.right <= shown.width, shown);
  check("which counts as seen", seen().includes("sample-first-lesson"));
  check("the first ticket a local agent could take points at Start", await wait(async () => (await toasts()).some((t) => t.includes("Start hands this ticket")), "start hint"));
  check("once", seen().includes("hint.start"));
  await $(`document.querySelectorAll('.toast .btn-ghost').forEach((b) => b.textContent.trim() === 'Got it' && b.click());true`);
  await shot("onboarding-01-first-lesson");

  // ── the projects home ─────────────────────────────────────────────────
  await $(`location.hash = '#/';true`);
  check("the home shows the sample", await wait(() => $(`!!${byText(".proj .proj-name", "Tomrade tour")}`), "sample card"));
  check("marked as the tour", (await texts(".proj .tag")).includes("Tour"));
  check("and keeps no onboarding button of its own", !(await has('[data-testid="restart-onboarding"]')));
  await shot("onboarding-01-home");

  // ── the sample, opened again ──────────────────────────────────────────
  await press(`${byText(".proj .proj-name", "Tomrade tour")}?.closest('.proj')`);
  check("it opens on its board", await wait(() => $(`!!${byText(".card-title", "Drag this ticket to Done")}`), "first tour ticket"));
  await sleep(800);
  check("and leaves the first lesson closed this time", !(await has("aside.detail")));
  check("with the tour and the practice backlog as workstreams", await wait(async () => {
    const rows = await texts(".side-workstreams .side-name");
    return rows.includes("Getting started") && rows.includes("Example: Pomodoro app");
  }, "workstreams"));
  check("the learning path is a view in the sidebar", await wait(() => $(`!!${byText(".side-views .side-name", "Learning path")}`), "learning path view"));
  await press(`${byText(".side-views .side-name", "Learning path")}?.closest('a, button, .side-row')`);
  check("and draws as a graph", await wait(() => has('.board-region[data-layout="graph"]'), "graph layout"));
  await shot("onboarding-02-learning-path");
  check("the sample teaches the graph itself, so no graph hint", !(await toasts()).some((t) => t.includes("Switch the view to Graph")));

  // ── what the assistant still needs ────────────────────────────────────
  check("the assistant keeps a setup card until an AI is connected", await wait(() => has(".agent-setup"), "setup card"));
  check("it offers to paste a key right there", await has('.agent-setup [data-testid="quick-model"]'));
  check("it says either a model or a local agent will do", (await texts(".agent-setup .setup-head")).includes("Connect an AI first — a model or a local agent, either one works."));
  check("and cannot be put away", await $(`!document.querySelector('.agent-setup .btn-icon')`));
  await shot("onboarding-03-setup-card");

  // ── the first write, and the hint beside it ───────────────────────────
  await send("add one");
  check("the run's changes come with a hint about undoing them", await wait(() => has('.run-wrap .hint[data-hint="hint.revert"]'), "revert hint", 200));
  await shot("onboarding-04-revert-hint");
  await press(`document.querySelector('.hint[data-hint="hint.revert"] .hint-ok')`);
  check("Got it puts it away", await wait(async () => !(await has(".hint")), "hint gone"));
  check("for good", await wait(async () => seen().includes("hint.revert"), "seen hint.revert"));
  win.webContents.reload();
  await sleep(2500);
  check("a reload does not bring the hint back, and the card leaves a thread with a run in it", (await has(".run-wrap")) && !(await has(".hint")) && !(await has(".agent-setup")));
  if (!(await $(`!!document.querySelector('.menu-row.is-radio')`))) await press(`document.querySelector('.ai-head .btn-icon[aria-label="Threads"]')`);
  await sleep(400);
  await press(`document.querySelector('button[aria-label="New thread"]')`);
  check("a new thread shows what is still missing again", await wait(() => has(".agent-setup"), "setup card in a new thread"));
  await $(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);

  // ── Start, pointed out once (on the first lesson, above) ──────────────
  const tour = ctx.items.list({ projectId: sample.id }).filter((i) => i.title !== "Written by the assistant");
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
  check("a project whose tickets depend on each other points at the graph", await wait(async () => (await toasts()).some((t) => t.includes("Switch the view to Graph")), "graph hint"));
  check("seen as soon as it is shown", seen().includes("hint.graph"));

  // ── deleted, and made again from the home in the person's language ────
  ctx.projects.remove(sample.id);
  ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
  await win.loadURL(base);
  await sleep(1500);
  const again = async () => ctx.projects.list().find((p) => p.sample);
  check("without a sample, the home offers to make one", await wait(() => has(".proj-sample"), "sample tile"));
  check("and keeps no onboarding button beside it", !(await has('[data-testid="restart-onboarding"]')));
  await shot("onboarding-05-sample-tile");
  await press(`document.querySelector('.proj-sample')`);
  check("it is made again, in Chinese", await wait(async () => (await again())?.name === "Tomrade 入门", "zh sample"));
  const tiled = await again();
  check("its workstreams are named in Chinese too", ctx.boards.list(tiled.id).map((b) => b.name).join("|") === "入门|示例：番茄钟 App", ctx.boards.list(tiled.id).map((b) => b.name));
  check("and the app opens it on its first lesson", await wait(async () => (await $(`location.hash`)).includes(tiled.id) && (await lesson())?.label?.endsWith("把这个工单拖到「已完成」"), "sample tile opens lesson"), await lesson());
  check("leaving the other hints seen", seen().includes("hint.graph") && !seen().includes("sample-tile"), seen());
  await shot("onboarding-06-zh-sample");

  // ── someone who does not want it can say so ───────────────────────────
  ctx.projects.remove(tiled.id);
  await win.loadURL(base);
  check("deleted again, the offer is back", await wait(() => has(".proj-sample"), "sample tile again"));
  await press(`document.querySelector('.proj-sample-hide')`);
  check("and its × puts it away", await wait(async () => !(await has(".proj-sample")), "tile hidden"));
  check("for good", await wait(async () => seen().includes("sample-tile"), "seen sample-tile"));
  await win.loadURL(base);
  check("even after a reload", (await wait(() => has(".proj-grid"), "home")) && !(await has(".proj-sample")));

  // ── onboarding again, from Settings, as often as wanted ───────────────
  const openAbout = async () => {
    await press(`document.querySelector('.titlebar button[aria-label="设置"]')`);
    await wait(() => $(`!!${byText(".side-row", "关于")}`), "settings");
    await press(byText(".side-row", "关于"));
    return wait(() => has('[data-testid="restart-onboarding"]'), "restart button");
  };
  check("Settings → About offers to run onboarding again", (await openAbout()) && (await text('[data-testid="restart-onboarding"]')) === "重新开始新手引导", await text('[data-testid="restart-onboarding"]'));
  await shot("onboarding-05-settings-restart");
  await press(`document.querySelector('[data-testid="restart-onboarding"]')`);
  check("with no sample, it says one is made again", await wait(async () => (await texts(".dlg-body .meta-txt")).includes("会重新创建示例项目。"), "restart dialog"));
  await press(`document.querySelector('[data-testid="restart-confirm"]')`);
  check("it opens on the setup screen again", await wait(() => has('[data-testid="first-run-setup"]'), "setup screen again"));
  check("with every hint unseen and the sample back", seen().length === 0 && !!(await again()));
  const zh = await again();
  check("made again in Chinese", zh?.name === "Tomrade 入门", zh?.name);
  check("its workstreams are named in Chinese too", ctx.boards.list(zh.id).map((b) => b.name).join("|") === "入门|示例：番茄钟 App", ctx.boards.list(zh.id).map((b) => b.name));
  await shot("onboarding-07-restarted");
  await press(`document.querySelector('[data-testid="setup-later"]')`);
  const before = await again();
  check("Later opens the sample, on its first lesson again", await wait(async () => (await $(`location.hash`)).includes(before.id) && (await lesson())?.label?.endsWith("把这个工单拖到「已完成」"), "sample again"), await lesson());
  const firstTicket = ctx.items.list({ projectId: before.id })[0];
  ctx.items.update(before.id, firstTicket.id, { status: "done" }, "human");
  check("inside a project, Settings → About offers it too", await openAbout());
  await press(`document.querySelector('[data-testid="restart-onboarding"]')`);
  check("with a sample, it asks before putting it back as it began", await wait(() => $(`document.querySelector('[data-testid="restart-reset-sample"]')?.checked === true`), "reset checkbox"));
  await press(`document.querySelector('[data-testid="restart-confirm"]')`);
  check("and does: a fresh sample, nothing done in it", await wait(async () => { const now = await again(); return !!now && now.id !== before.id && ctx.items.list({ projectId: now.id }).every((i) => i.status !== "done"); }, "fresh sample"));
  check("run twice, the setup screen comes again, leaving the project for it", await wait(async () => (await has('[data-testid="first-run-setup"]')) && (await $(`location.hash`)) === "#/", "setup screen twice"));

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
