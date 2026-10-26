/**
 * Agent panel regression: a run keeps going in the main process while the
 * panel looks elsewhere — another project, another thread — and the panel
 * has to show where it got to when it comes back, not the cached moment it
 * left. A slow stand-in engine makes the timing deterministic.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:agent-panel
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-agent-panel-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};
const LINES = ["step one", "step two", "all done"];

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const alpha = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  const beta = ctx.projects.create({ name: "Beta", keyPrefix: "BE" });
  await ctx.storage.ready;
  ctx.agent.engine({
    id: "slow",
    title: "Slow",
    author: "ai:slow",
    available: async () => ({ ok: true }),
    async turn(_input, io) {
      await sleep(600);
      io.emit({ type: "text", text: LINES[0] });
      await sleep(1200);
      io.emit({ type: "text", text: LINES[1] });
      await sleep(1200);
      io.emit({ type: "text", text: LINES[2] });
      return { stop: "end" };
    }
  });
  // registered before the window opens: the panel reads the engine list once
  ctx.agent.engine({
    id: "steerable",
    title: "Steerable",
    author: "ai:steerable",
    steering: "queue",
    available: async () => ({ ok: true }),
    async turn(_input, io) {
      for (let i = 0; i < 4; i++) {
        await sleep(800);
        const heard = io.takeSteers();
        if (heard.length) io.emit({ type: "text", text: `heard: ${heard.join(" + ")}` });
      }
      io.emit({ type: "text", text: "steady" });
      return { stop: "end" };
    }
  });
  ctx.agent.engine({
    id: "deaf",
    title: "Deaf",
    author: "ai:deaf",
    steering: "queue",
    available: async () => ({ ok: true }),
    async turn() {
      await sleep(1200);
      return { stop: "end" };
    }
  });
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", agent: { ...settings.agent, defaultEngine: "slow" } });

  const win = new BrowserWindow({ width: 1400, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${alpha.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const shot = async (name) => {
    if (!process.env.TOMRADE_SHOTS) return;
    fs.mkdirSync(process.env.TOMRADE_SHOTS, { recursive: true });
    fs.writeFileSync(path.join(process.env.TOMRADE_SHOTS, name), (await win.webContents.capturePage()).toPNG());
  };
  const go = (projectId) => $(`location.hash = '#/p/${projectId}';true`);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const send = async (text) => {
    await $(`(() => { const i = document.querySelector('.ai-input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(100);
    await $(`document.querySelector('.ai-send').click();true`);
  };
  const panel = () =>
    $(`({ working: !!document.querySelector('.ai-scroll .working'), locked: document.querySelector('.ai-composer')?.hasAttribute('data-busy') ?? null,
          lines: [...document.querySelectorAll('.ai-scroll .turn-ai .turn-body p')].map((p) => p.textContent).filter((t) => ${JSON.stringify(LINES)}.includes(t)) })`);
  const threads = async () => {
    if (!(await $(`!!document.querySelector('.menu-row.is-radio')`))) await press(`document.querySelector('.ai-head .btn-icon[aria-label="Threads"]')`);
    await sleep(400);
  };
  const newThread = async () => {
    await threads();
    await press(`document.querySelector('button[aria-label="New thread"]')`);
    await sleep(800);
  };
  await sleep(2000);

  // ── the run ends while another project is on screen ──────────────────
  await send("first");
  await sleep(300);
  check("the panel says the run is working", (await panel()).working);
  await go(beta.id);
  await sleep(3500);
  await go(alpha.id);
  await sleep(1000);
  let seen = await panel();
  check("back on the project, the finished run no longer reads as working", !seen.working, seen);
  check("and the composer takes a message again", seen.locked === false, seen);
  check("and everything the run wrote while away is there", LINES.every((line) => seen.lines.includes(line)), seen.lines);

  // ── the panel comes back while the run is still going ────────────────
  await newThread();
  await send("second");
  await sleep(300);
  await go(beta.id);
  await sleep(900); // the first line lands while away
  await go(alpha.id);
  await sleep(500); // back before the second line
  seen = await panel();
  check("back mid-run, the line written while away is there", seen.working && seen.lines[0] === LINES[0], seen);
  await sleep(3000);
  seen = await panel();
  check("and the rest streams in until the run ends", !seen.working && seen.lines.join("|") === LINES.join("|"), seen);

  // ── the run ends while another thread of the project is on screen ────
  await newThread();
  await send("third");
  await sleep(300);
  const busyId = ctx.agent.store.threads(alpha.id)[0].id;
  await newThread();
  check("the panel moved to a fresh thread", (await panel()).lines.length === 0);
  await sleep(3500);
  await threads();
  // Titled from its first message once the run has had a moment, so looked up now.
  const busyTitle = ctx.agent.store.threads(alpha.id).find((th) => th.id === busyId)?.title;
  check("the busy thread is in the threads menu", await press(`[...document.querySelectorAll('.menu-row.is-radio')].find((r) => r.querySelector('.m-name')?.textContent === ${JSON.stringify(busyTitle)})`), busyTitle);
  await sleep(1000);
  seen = await panel();
  check("picking the busy thread again shows its run finished", !seen.working && seen.lines.join("|") === LINES.join("|"), seen);

  // ── the composer: several lines, typed ahead, and the keyboard left where it was ──
  const draftNow = () => $(`document.querySelector('.ai-input')?.value ?? null`);
  const key = (opts) => $(`document.querySelector('.ai-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...${JSON.stringify(opts)} }));true`);
  const setDraft = (text) => $(`(() => { const i = document.querySelector('.ai-input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await newThread();
  await send("fourth");
  await sleep(300);
  check("the composer is a multi-line box that stays open while a run works", await $(`(() => { const i = document.querySelector('.ai-input'); return i.tagName === 'TEXTAREA' && !i.disabled; })()`));
  await setDraft("the next message\nwith a second line");
  await key({ shiftKey: true });
  await sleep(150);
  check("Shift+Enter does not send", (await draftNow()) === "the next message\nwith a second line");
  const queued = () => $(`[...document.querySelectorAll('.ai-queued:not(.is-steering)')].map((q) => ({ text: q.querySelector('.q-text')?.textContent ?? null, held: q.hasAttribute('data-held') }))`);
  const asked = () => $(`[...document.querySelectorAll('.ai-scroll .turn-user p')].map((p) => p.textContent)`);
  await key({});
  await sleep(300);
  let q = await queued();
  check("Enter while the run works queues the message", (await draftNow()) === "" && q.length === 1 && q[0].text === "the next message\nwith a second line" && !q[0].held && (await panel()).working, q);
  check("and the composer says what Enter does now", /Queue a message/.test(await $(`document.querySelector('.ai-input').placeholder`)));
  await $(`(() => { const b = document.createElement('input'); b.id = 'elsewhere'; document.body.appendChild(b); b.focus(); return true; })()`);
  await sleep(4200);
  check("once the turn ends, the queued message goes out by itself", (await queued()).length === 0 && (await asked()).includes("the next message\nwith a second line") && (await panel()).working, await asked());
  check("and the keyboard stays where the person put it", (await $(`document.activeElement?.id`)) === "elsewhere");

  // ── several waiting, edited, removed ─────────────────────────────────
  await setDraft("queued A");
  await key({});
  await setDraft("queued B");
  await key({});
  await sleep(200);
  check("several messages can wait in order", (await queued()).map((x) => x.text).join("|") === "queued A|queued B", await queued());
  await shot("queued.png");
  await press(`document.querySelectorAll('.ai-queued')[1].querySelector('button[aria-label="Edit queued message"]')`);
  await sleep(200);
  await $(`(() => { const i = document.querySelector('.ai-queued .q-edit'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, 'queued B, edited'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
  await sleep(200);
  await press(`document.querySelectorAll('.ai-queued')[0].querySelector('button[aria-label="Remove queued message"]')`);
  await sleep(200);
  check("a queued message can be edited and another removed", (await queued()).map((x) => x.text).join("|") === "queued B, edited", await queued());
  await sleep(4300);
  let said = await asked();
  check("what is left goes out after the turn", said.includes("queued B, edited") && !said.includes("queued A") && (await queued()).length === 0, said);
  await sleep(4000);

  // ── a stop holds the queue ───────────────────────────────────────────
  await send("fifth");
  await sleep(400);
  await setDraft("after the stop");
  await key({});
  await sleep(200);
  await $(`document.querySelector('.ai-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));true`);
  await sleep(3500); // the stand-in engine finishes its sleeps before the stop lands
  q = await queued();
  await shot("queue-held.png");
  check("Esc stops the turn and the queue stays, held", !(await panel()).working && q.length === 1 && q[0].held && !(await asked()).includes("after the stop"), q);
  await press(`[...document.querySelectorAll('.ai-queued button')].find((b) => b.textContent === 'Send now')`);
  await sleep(500);
  check("a held message can be sent by hand", (await asked()).includes("after the stop") && (await queued()).length === 0 && (await panel()).working);
  await sleep(4000);

  // ── a failure or a question holds it too ─────────────────────────────
  ctx.agent.engine({
    id: "mixed",
    title: "Mixed",
    author: "ai:mixed",
    available: async () => ({ ok: true }),
    async turn(input, io) {
      const text = input.input.kind === "text" ? input.input.text : "";
      await sleep(900);
      if (text.startsWith("fail")) return { stop: "error", error: "boom" };
      if (text.startsWith("ask")) {
        await io.tools.execute("ask_user", { question: "Which one?", options: ["A", "B"] });
        return { stop: "asked" };
      }
      io.emit({ type: "text", text: "fine" });
      return { stop: "end" };
    }
  });
  await newThread();
  await $(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  await sleep(300);
  ctx.agent.setEngine(alpha.id, ctx.agent.store.threads(alpha.id)[0].id, "mixed");
  await sleep(500);
  await send("fail please");
  await sleep(300);
  await setDraft("after the failure");
  await key({});
  await sleep(1500);
  q = await queued();
  check("a failed turn holds the queue", q.length === 1 && q[0].held && !(await asked()).includes("after the failure"), q);
  await press(`document.querySelector('.ai-queued button[aria-label="Remove queued message"]')`);
  await sleep(200);
  await send("ask me");
  await sleep(300);
  await setDraft("after the question");
  await key({});
  await sleep(1500);
  q = await queued();
  check("a question waiting for the person holds the queue", q.length === 1 && q[0].held && !(await asked()).includes("after the question") && (await $(`!!document.querySelector('.q-ask:not(.done)')`)), q);
  await press(`document.querySelector('.ai-queued button[aria-label="Remove queued message"]')`);
  await sleep(200);

  // ── steering: into the running turn, or queued when the engine cannot take it ──
  const onEngine = async (id) => {
    await newThread();
    await $(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
    await sleep(300);
    // through the panel's own menu, so what it shows is what runs
    const title = { steerable: "Steerable", deaf: "Deaf", slow: "Slow" }[id];
    await press(`[...document.querySelectorAll('.ai-knobs .chip-btn')].at(-1)`);
    await sleep(400);
    await press(`[...document.querySelectorAll('.menu-row.is-radio')].find((r) => r.querySelector('.m-name')?.textContent === ${JSON.stringify(title)})`);
    await sleep(600);
    return ctx.agent.store.threads(alpha.id)[0].id;
  };
  const agentSaid = () => $(`[...document.querySelectorAll('.ai-scroll .turn-ai .turn-body p')].map((p) => p.textContent)`);
  const steerKey = () => key({ metaKey: true });
  let steerThread = await onEngine("steerable");
  await send("paint it");
  await sleep(300);
  check("a steerable engine says ⌘Enter steers", /steers now/.test(await $(`document.querySelector('.ai-input').placeholder`)));
  await setDraft("make it blue");
  await steerKey();
  await sleep(150);
  check("⌘Enter while it works sends into the turn, not the queue", (await draftNow()) === "" && (await queued()).length === 0 && (await $(`document.querySelector('.ai-queued.is-steering')?.textContent ?? ''`)).includes("make it blue"));
  await sleep(1200);
  check("the agent reads it inside the same turn", (await agentSaid()).includes("heard: make it blue") && (await panel()).working, await agentSaid());
  check("and it sits in the transcript where it was read, marked as steering", await $(`(() => { const s = document.querySelector('.ai-scroll .turn-user.is-steer'); return !!s && s.textContent.includes('make it blue') && s.textContent.includes('Steered mid-turn'); })()`));
  await shot("steered.png");
  await setDraft("and shiny");
  await key({});
  await sleep(200);
  await press(`[...document.querySelectorAll('.ai-queued button')].find((b) => b.textContent === 'Steer now')`);
  await sleep(1200);
  check("a queued message can be steered in", (await agentSaid()).includes("heard: and shiny") && (await queued()).length === 0, await agentSaid());
  await sleep(2500);
  check("all of it was one run", ctx.agent.store.runs(alpha.id, steerThread).length === 1);

  steerThread = await onEngine("deaf");
  await send("one");
  await sleep(300);
  await setDraft("too late");
  await steerKey();
  await sleep(2500);
  said = await asked();
  check("a steer the turn ended without reading goes out next, as a message", said.includes("too late") && !(await $(`!!document.querySelector('.ai-scroll .turn-user.is-steer')`)) && ctx.agent.store.runs(alpha.id, steerThread).length === 2, said);
  await sleep(1500);

  await onEngine("slow");
  await send("not steerable");
  await sleep(300);
  await setDraft("queue me instead");
  await steerKey();
  await sleep(400);
  q = await queued();
  check("an engine that cannot be steered queues the message and says so", q.length === 1 && q[0].text === "queue me instead" && (await $(`document.body.textContent.includes("can't take messages mid-turn")`)), q);
  check("and offers no Steer now", !(await $(`[...document.querySelectorAll('.ai-queued button')].some((b) => b.textContent === 'Steer now')`)));
  await sleep(4200);
  check("it then goes out after the turn", (await asked()).includes("queue me instead"));
  await sleep(4000);

  // ── ↑ brings back what was sent ──────────────────────────────────────
  await onEngine("slow");
  await send("hist one");
  await sleep(4000);
  await send("hist two");
  await sleep(4000);
  await send("hist two");
  await sleep(4000);
  const up = (extra = {}) => key({ key: "ArrowUp", ...extra });
  const down = () => key({ key: "ArrowDown" });
  const stored = () => $(`JSON.parse(localStorage.getItem('tomrade.agent.history.${alpha.id}') ?? '[]')`);
  check("the same message twice in a row is remembered once", (await stored()).slice(-2).join("|") === "hist one|hist two", (await stored()).slice(-3));
  await setDraft("");
  await up();
  await sleep(150);
  check("↑ in an empty composer brings back the last message sent", (await draftNow()) === "hist two", await draftNow());
  await up();
  await sleep(150);
  check("↑ again goes further back", (await draftNow()) === "hist one", await draftNow());
  await down();
  await sleep(150);
  check("↓ comes forward", (await draftNow()) === "hist two", await draftNow());
  await down();
  await sleep(150);
  check("and past the newest, back to the empty draft", (await draftNow()) === "", await draftNow());
  await setDraft("half a thought");
  await up();
  await sleep(150);
  await down();
  await sleep(150);
  check("a draft set aside by ↑ comes back with ↓", (await draftNow()) === "half a thought", await draftNow());
  await setDraft("line one\nline two");
  await up();
  await sleep(150);
  check("↑ off the first line of a longer message leaves it alone", (await draftNow()) === "line one\nline two", await draftNow());
  await setDraft("拼");
  await up({ isComposing: true });
  await sleep(150);
  check("↑ while an input method is composing leaves it alone", (await draftNow()) === "拼", await draftNow());
  await setDraft("");
  await win.webContents.reloadIgnoringCache();
  await sleep(3000);
  await up();
  await sleep(150);
  check("after a restart ↑ still brings it back", (await draftNow()) === "hist two", await draftNow());
  await setDraft("");

  // ── slash commands ───────────────────────────────────────────────────
  const menu = () => $(`[...document.querySelectorAll('.slash-menu .slash-row')].map((r) => ({ name: r.querySelector('.slash-name')?.textContent, on: r.getAttribute('aria-selected') === 'true' }))`);
  const threadCount = () => ctx.agent.store.threads(alpha.id).length;
  await onEngine("slow");
  await setDraft("/");
  await sleep(200);
  let rows = await menu();
  await shot("slash-menu.png");
  check("/ opens the command menu", rows.length >= 1 && rows[0].name === "/new · /clear" && rows[0].on, rows);
  await setDraft("/cl");
  await sleep(200);
  await up();
  await sleep(150);
  check("the menu narrows by name or alias, and ↑ moves in it instead of the history", (await menu()).length === 1 && (await draftNow()) === "/cl", await draftNow());
  await key({ key: "Tab" });
  await sleep(150);
  check("Tab completes the command", (await draftNow()) === "/new", await draftNow());
  await key({ key: "Escape" });
  await sleep(150);
  check("Esc closes the menu and keeps the text", (await menu()).length === 0 && (await draftNow()) === "/new");
  let before = threadCount();
  const oldThread = ctx.agent.store.threads(alpha.id)[0].id;
  await key({});
  await sleep(800);
  check("/new opens a new conversation", threadCount() === before + 1 && (await draftNow()) === "" && (await panel()).lines.length === 0 && (await asked()).length === 0);
  check("and the old one stays in the list", ctx.agent.store.threads(alpha.id).some((th) => th.id === oldThread));
  await setDraft("/clea");
  await sleep(150);
  before = threadCount();
  await key({});
  await sleep(800);
  check("Enter on the menu runs the picked command (/clear is /new)", threadCount() === before + 1 && (await draftNow()) === "");
  await send("/xyz is not a command");
  await sleep(500);
  check("an unknown /word goes out as an ordinary message", (await asked()).includes("/xyz is not a command") && (await panel()).working);
  await $(`window.confirm = () => false;true`);
  before = threadCount();
  await setDraft("/new");
  await key({ key: "Escape" });
  await key({});
  await sleep(500);
  check("/new while a turn runs asks first, and a no leaves everything as it was", threadCount() === before && (await panel()).working && (await draftNow()) === "/new");
  await $(`window.confirm = () => true;true`);
  const runningThread = ctx.agent.store.threads(alpha.id)[0].id;
  await key({});
  await sleep(1200);
  check("a yes opens a new conversation", threadCount() === before + 1 && (await draftNow()) === "");
  await sleep(3500); // the stand-in engine finishes its sleeps before the stop lands
  check("and the turn it left was stopped", ctx.agent.store.runs(alpha.id, runningThread).at(-1)?.status === "cancelled", ctx.agent.store.runs(alpha.id, runningThread).at(-1)?.status);
  await shot("slash.png");

  // ── the guide: a head button and /help ───────────────────────────────
  await press(`document.querySelector('.ai-head button[aria-label="Guide"]')`);
  await sleep(400);
  const guide = await $(`[...document.querySelectorAll('.menu .guide-row')].map((r) => r.textContent)`);
  await shot("guide.png");
  check("the guide button lists what the composer does", guide.length === 10 && ["Shift+Enter", process.platform === "darwin" ? "⌘↵" : "Ctrl+Enter", "Esc", "↑ ↓", "/new · /clear", "/help"].every((k) => guide.some((g) => g.startsWith(k))) && guide.some((g) => /steer/.test(g)) && guide.some((g) => /queue the message/.test(g)), guide);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  await sleep(300);
  const helpThread = ctx.agent.store.threads(alpha.id)[0].id;
  const storedBefore = ctx.agent.thread(alpha.id, helpThread).messages.length;
  await setDraft("/help");
  await sleep(150);
  check("/help is in the command menu", (await menu()).some((r) => r.name === "/help"));
  await key({});
  await sleep(500);
  const helpText = await $(`document.querySelector('.ai-scroll .guide-turn .guide-text')?.textContent ?? null`);
  check("/help prints the guide as text in the conversation", (await draftNow()) === "" && !!helpText && helpText.includes("/new · /clear") && helpText.includes("Shift+Enter") && helpText.split("\n").length === 10, helpText);
  check("and sends nothing to the agent", ctx.agent.thread(alpha.id, helpThread).messages.length === storedBefore && !(await panel()).working);
  await shot("help.png");
  await newThread();
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  await sleep(300);
  check("another conversation does not carry it", !(await $(`!!document.querySelector('.ai-scroll .guide-turn')`)));

  // ── the thread list: searchable, says what runs, keeps the archive ───
  for (let i = 0; i < 8; i++) ctx.agent.newThread(alpha.id, "slow", null, { title: `Filler conversation ${i + 1}` });
  await newThread();
  await send("a long one");
  await sleep(300);
  await threads();
  check("a long thread list offers a search", await $(`!!document.querySelector('.menu-search input')`));
  check("a conversation with a run going says so", await $(`[...document.querySelectorAll('.menu-row.is-radio')].some((r) => (r.textContent ?? '').includes('Running'))`));
  await $(`(() => { const i = document.querySelector('.menu-search input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, 'Filler conversation 3'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(300);
  check("typing narrows the list", (await $(`[...document.querySelectorAll('.menu-row.is-radio')].filter((r) => r.closest('.menu-foot') === null).map((r) => r.querySelector('.m-name')?.textContent)`)).join("|") === "Filler conversation 3");
  // What opened a conversation, said by the plugin that did, shows as chips after its title.
  const tagged = ctx.agent.store.threads(alpha.id).find((th) => th.title === "Filler conversation 5");
  ctx.agent.threadOrigins((_p, list) => list.filter((th) => th.id === tagged.id).map((th) => [th.id, "Routine"]));
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  await sleep(300);
  ctx.ipc.send("codeLink.changed", alpha.id);
  await sleep(600);
  await threads();
  await $(`(() => { const i = document.querySelector('.menu-search input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, 'Filler conversation'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(300);
  const chips = await $(`[...document.querySelectorAll('.menu-row.is-radio')].map((r) => ({ name: r.querySelector('.m-name')?.textContent, chips: [...r.querySelectorAll('.m-chip')].map((c) => c.textContent) })).filter((r) => r.chips.length)`);
  check("a conversation a plugin opened carries its chip after the title", chips.length === 1 && chips[0].name === "Filler conversation 5" && chips[0].chips.join() === "Routine", chips);
  await shot("origin-chips.png");
  await $(`(() => { const i = document.querySelector('.menu-search input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, 'Filler conversation 3'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(300);
  const filler = ctx.agent.store.threads(alpha.id).find((th) => th.title === "Filler conversation 3");
  ctx.agent.archiveThread(alpha.id, filler.id);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  await sleep(300);
  await threads();
  check("the menu foot no longer holds an archive switch", await $(`!document.querySelector('.menu .menu-foot')`));
  await press(`document.querySelector('.menu .menu-head button[aria-label="Show archived conversations"]')`);
  await sleep(600);
  check("the archive opens in the same menu", await $(`document.querySelector('.menu .menu-head .eyebrow')?.textContent === 'Archived'`));
  check("the archive lists what was put away", await $(`[...document.querySelectorAll('.menu .menu-row.is-radio')].some((r) => r.textContent?.includes('Filler conversation 3'))`));
  await press(`document.querySelector('.menu .menu-head button[aria-label="Back to conversations"]')`);
  await sleep(300);
  check("and goes back to the list", await $(`document.querySelector('.menu .menu-head .eyebrow')?.textContent === 'Threads'`));
  await press(`document.querySelector('.menu .menu-head button[aria-label="Show archived conversations"]')`);
  await sleep(600);
  await press(`[...document.querySelectorAll('.menu .menu-row.is-radio')].find((r) => r.textContent?.includes('Filler conversation 3'))`);
  await sleep(800);
  check("picking it brings it back", ctx.agent.store.thread(alpha.id, filler.id)?.archived === false);
  await sleep(3500);

  // ── archived while on screen: stays until the person moves on, read-only ──
  await newThread();
  await send("linger");
  await sleep(3800);
  const lingerId = ctx.agent.store.threads(alpha.id)[0].id;
  const archivedNote = () => $(`[...document.querySelectorAll('.ai-workdir')].some((p) => p.textContent?.includes('Archived.'))`);
  const inputDisabled = () => $(`document.querySelector('.ai-input')?.disabled ?? null`);
  // What code link does when a ticket is done: archive, then tell the windows.
  ctx.agent.archiveThread(alpha.id, lingerId);
  ctx.ipc.send("codeLink.changed", alpha.id);
  await sleep(800);
  seen = await panel();
  check("a conversation archived while open stays on screen", seen.lines.join("|") === LINES.join("|"), seen);
  check("and says it is archived", await archivedNote());
  check("and takes no more messages", (await inputDisabled()) === true && (await $(`document.querySelector('.ai-send')?.disabled ?? null`)) === true);
  await press(`[...document.querySelectorAll('.ai-workdir button')].find((b) => b.textContent === 'Bring it back')`);
  await sleep(800);
  check("bringing it back opens the composer again", (await inputDisabled()) === false && !(await archivedNote()));
  check("and marks it as kept by the person", ctx.agent.store.thread(alpha.id, lingerId)?.restored === true);
  ctx.agent.archiveThread(alpha.id, lingerId);
  ctx.ipc.send("codeLink.changed", alpha.id);
  await sleep(800);
  await newThread();
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  await sleep(300);
  check("moving to another conversation lets it go", (await panel()).lines.length === 0 && !(await archivedNote()));
  await threads();
  const lingerTitle = ctx.agent.store.thread(alpha.id, lingerId)?.title;
  check("and it is not in the list any more", !(await $(`[...document.querySelectorAll('.menu-row.is-radio')].filter((r) => r.closest('.menu-foot') === null).some((r) => r.querySelector('.m-name')?.textContent === ${JSON.stringify(lingerTitle)})`)), lingerTitle);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  await sleep(300);

  // ── every step shown, long runs folded, retries said out loud ─────────
  ctx.agent.engine({
    id: "flaky",
    title: "Flaky",
    author: "ai:flaky",
    available: async () => ({ ok: true }),
    async turn(_input, io) {
      io.activity("Bash · pnpm test");
      await sleep(900);
      io.activity(null);
      for (let i = 1; i <= 7; i++) io.emit({ type: "trace", tool: "Bash", args: { command: `step ${i}` }, ok: i !== 3, summary: i === 3 ? `step ${i} — exit 1` : `step ${i}`, ms: 40 * i });
      await sleep(600);
      io.retry({ attempt: 1, max: 3, reason: "connection dropped", delayMs: 4000 });
      await sleep(1200);
      io.retry({ attempt: 2, max: 3, reason: "connection dropped", delayMs: 9000 });
      await sleep(1500);
      io.emit({ type: "text", text: "recovered and done" });
      return { stop: "end" };
    }
  });
  const line = () => $(`(() => { const w = document.querySelector('.ai-scroll .working'); return w ? { retrying: w.classList.contains('retrying'), text: w.textContent } : null; })()`);
  await newThread();
  await $(`(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  await sleep(300);
  const flakyThread = ctx.agent.store.threads(alpha.id)[0];
  ctx.agent.setEngine(alpha.id, flakyThread.id, "flaky");
  await sleep(500);
  await send("flaky");
  await sleep(500);
  check("a running tool shows on the working line", (await line())?.text.includes("Bash · pnpm test"), await line());
  await sleep(800);
  let now = await line();
  check("and leaves it once it ends", now && !now.text.includes("pnpm test"), now);
  await sleep(1000);
  now = await line();
  check("a failed request reads as a retry, with the count and why", now?.retrying && /retry 1\/3/.test(now.text) && now.text.includes("connection dropped") && /next try in \ds/.test(now.text), now);
  const folds = await $(`[...document.querySelectorAll('.ai-scroll .trace-fold')].map((f) => ({ summary: f.querySelector('summary')?.textContent, open: f.open, rows: f.querySelectorAll('.trace-row').length }))`);
  check("earlier steps fold, around the failed one", folds.length === 1 && folds[0].summary === "2 earlier steps" && !folds[0].open && folds[0].rows === 2, folds);
  check("the failed step and the last ones stay open", (await $(`[...document.querySelectorAll('.ai-scroll .trace-row')].filter((r) => !r.closest('.trace-fold')).map((r) => r.querySelector('.t-sum')?.textContent)`)).join("|") === "step 3 — exit 1|step 4|step 5|step 6|step 7");
  await shot("retrying.png");
  await sleep(1300);
  check("the next retry counts on", /retry 2\/3/.test((await line())?.text ?? ""), await line());
  await sleep(1500);
  const row = await $(`document.querySelector('.ai-scroll .retry-row')?.textContent ?? null`);
  check("once through, the stretch of retries stays in the transcript", /failed 2× \(connection dropped\) · recovered after \d+s/.test(row ?? ""), row);
  check("and the line is gone with the run", !(await line()));
  await press(`document.querySelector('.ai-scroll .trace-fold > summary')`);
  await sleep(300);
  await shot("finished.png");
  check("harness reached the end", true);
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.log("HARNESS ERROR: " + (err && err.stack ? err.stack : String(err)));
    check("harness ran to completion", false);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log("failed: " + failed.map((f) => f.name).join(" | "));
  app.exit(failed.length ? 1 : 0);
});
