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
  // Chats first, then writes: the transcript sets the writing apart and folds its steps under what they changed.
  ctx.agent.engine({
    id: "coder",
    title: "Coder",
    author: "ai:coder",
    available: async () => ({ ok: true }),
    async turn(input, io) {
      const text = input.input.kind === "text" ? input.input.text : "";
      if (text.startsWith("test")) {
        await io.tools.execute("write_file", { path: "code/part-7.md", content: "part 7" });
        await io.tools.execute("bash", { command: "echo 'Tests  8 passed (8)'" });
        io.emit({ type: "text", text: "Tested." });
        return { stop: "end" };
      }
      if (!text.startsWith("write")) {
        io.emit({ type: "text", text: "Sure, what should it say?" });
        return { stop: "end" };
      }
      for (let i = 1; i <= 6; i++) await io.tools.execute("write_file", { path: `code/part-${i}.md`, content: `part ${i}` });
      io.emit({ type: "text", text: "Written." });
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
  check("earlier steps fold, around the failed one", folds.length === 1 && /^2 earlier steps( · |$)/.test(folds[0].summary) && !folds[0].open && folds[0].rows === 2, folds);
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

  // The session bar: the panel's threads and the project's terminal sessions in one column, waiting first.
  const boardId = ctx.boards.list(alpha.id)[0].id;
  const ticket = ctx.items.create({ projectId: alpha.id, boardId, title: "Record pane output", by: "human" });
  const pane = ctx.codeLink.store.createSession(alpha.id, { repoId: "check", branch: "", itemIds: [ticket.id], mode: "terminal", agent: "claude-code", threadId: null, device: "check" });
  // in another terminal app: no pane for anything here to find gone
  ctx.codeLink.store.patchSession(alpha.id, pane.id, { terminal: "iTerm.app", state: "waiting", activity: "needs your approval", lastEventAt: Date.now() });
  const ended = ctx.codeLink.store.createSession(alpha.id, { repoId: "check", branch: "", itemIds: [], mode: "terminal", agent: "claude-code", threadId: null, device: "check" });
  ctx.codeLink.store.patchSession(alpha.id, ended.id, { title: "Snapshot records", state: "ended", endedAt: Date.now(), summary: "PR #9 merged" });
  const shown = [];
  ctx.codeLink.showSession = async (_projectId, sessionId) => (shown.push(sessionId), true);
  ctx.emit("codeLink/changed", alpha.id);
  ctx.ipc.send("codeLink.changed", alpha.id);
  await sleep(1500);
  const bar = () =>
    $(`(() => { const b = document.querySelector('.ai .sbar'); if (!b) return null; return { mode: b.classList.contains('is-rail') ? 'rail' : 'cards',
      dots: [...b.querySelectorAll('.sbar-dot[data-status]')].map((d) => [d.dataset.status, d.getAttribute('aria-label'), d.dataset.depth ?? null]),
      cards: [...b.querySelectorAll('.sbar-card')].map((c) => [c.dataset.status, c.textContent]),
      waiting: b.querySelector('.sbar-waiting')?.getAttribute('aria-label') ?? null, peek: b.querySelector('[role=tooltip]')?.textContent ?? null }; })()`);
  const flip = () => $(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\\\', code: 'Backslash', metaKey: ${process.platform === "darwin"}, ctrlKey: ${process.platform !== "darwin"}, bubbles: true, cancelable: true }));true`);
  let barSeen = await bar();
  check("the panel has a session bar, as dots while the panel is narrow", barSeen?.mode === "rail", barSeen);
  const waitingDots = barSeen?.dots.filter(([status]) => status === "wait") ?? [];
  check("the terminal session waiting on the person sits with the other waiting ones, first in the bar", waitingDots.some(([, label]) => /Record pane output/.test(label)) && barSeen.dots.findIndex(([status]) => status !== "wait") === waitingDots.length, barSeen?.dots);
  check("the bar counts what waits", barSeen?.waiting === `${waitingDots.length} waiting`, barSeen?.waiting);
  check("the ended session is listed after the live ones", barSeen?.dots.at(-1)?.[0] === "done" && /Snapshot records/.test(barSeen.dots.at(-1)[1]), barSeen?.dots);
  await $(`(() => { const d = [...document.querySelectorAll('.ai .sbar-dot[data-status="wait"]')].find((n) => /Record pane output/.test(n.getAttribute('aria-label'))); d.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true; })()`);
  await sleep(200);
  barSeen = await bar();
  check("hovering a dot peeks at what it waits on", /needs your approval/.test(barSeen?.peek ?? ""), barSeen?.peek);
  await flip();
  await sleep(300);
  barSeen = await bar();
  check("⌘\\ turns the dots into cards", barSeen?.mode === "cards", barSeen?.mode);
  await shot("session-bar-cards.png");
  const card = barSeen?.cards.find(([, text]) => /Record pane output/.test(text));
  check("a card says the ticket, where it runs and what it waits on", card?.[0] === "wait" && /AL-\d+ Record pane output/.test(card[1]) && /iTerm/.test(card[1]) && /needs your approval/.test(card[1]), card);
  check("a session started this minute says it is new", /new/.test(card?.[1] ?? ""), card);
  check("an ended one never does", !barSeen?.cards.some(([status, text]) => status === "done" && /new/.test(text)), barSeen?.cards);
  check("an ended card carries its outcome", barSeen?.cards.some(([status, text]) => status === "done" && /PR #9 merged/.test(text)), barSeen?.cards);
  await press(`[...document.querySelectorAll('.ai .sbar-card')].find((n) => /Record pane output/.test(n.textContent))`);
  await sleep(500);
  const sessionView = () =>
    $(`(() => { const v = document.querySelector('.ai .ai-session'); if (!v) return null; return { id: v.dataset.session, state: v.dataset.state,
      note: document.querySelector('[data-testid="ai-session-note"]')?.textContent ?? null, strip: [...document.querySelectorAll('.ai-strip-line')].map((l) => l.textContent),
      lines: [...document.querySelectorAll('.ai-session-convo .cs-convo-line')].map((l) => [l.dataset.who, l.textContent]), details: document.querySelectorAll('.ai-session-convo .cs-convo-detail').length,
      empty: document.querySelector('.ai-session-empty')?.textContent ?? null, show: !!document.querySelector('[data-testid="ai-session-show"]'),
      approve: document.querySelector('[data-testid="ai-approve"]')?.textContent ?? null, allow: !!document.querySelector('[data-testid="ai-allow"]'), deny: !!document.querySelector('[data-testid="ai-deny"]'), there: !!document.querySelector('[data-testid="ai-answer-there"]'),
      input: document.querySelector('.ai-session-foot .ai-input')?.value ?? null, drawer: document.querySelector('[data-testid="ai-drawer"]')?.textContent ?? null,
      current: document.querySelector('.ai .sbar [aria-current="true"]')?.getAttribute('aria-label') ?? document.querySelector('.ai .sbar [aria-current="true"]')?.textContent ?? null }; })()`);
  let view = await sessionView();
  check("picking a terminal session in another app opens it in the panel, read-only: no pane to read, type there instead", view?.id === pane.id && !view.show && /iTerm/.test(view.note ?? "") && view.strip.length === 0 && shown.length === 0, view);
  check("and the bar marks it as the open one", /Record pane output/.test(view?.current ?? ""), view?.current);
  await flip();
  await sleep(300);
  check("⌘\\ turns them back into dots, and the choice is kept", (await bar())?.mode === "rail" && (await $(`localStorage.getItem('tomrade.ai.sessionBar')`)) === "rail");
  await shot("session-bar.png");

  // ── a session in a Terminal window pane, seen from the panel: the same session from another side ──
  // Its agent's own record, as Claude Code writes one; the session names the file, so code link reads it.
  const record = path.join(work, "cc-check-1.jsonl");
  fs.writeFileSync(record, [
    { type: "user", message: { content: "please record the pane output" } },
    { type: "assistant", message: { content: [{ type: "text", text: "On it: reading the pane first." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "herdr pane read w1:p1" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "line one\nline two" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "The pane says line one and line two." }] } }
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const tailTicket = ctx.items.create({ projectId: alpha.id, boardId, title: "Tail the pane", by: "human" });
  const inPane = ctx.codeLink.store.createSession(alpha.id, { repoId: "check", branch: "", itemIds: [tailTicket.id], mode: "terminal", agent: "claude-code", threadId: null, device: "check" });
  ctx.codeLink.store.patchSession(alpha.id, inPane.id, { herdrPane: "w1:p1", externalId: "cc-check-1", transcript: record, state: "running", activity: "Bash · herdr pane read", lastEventAt: Date.now() });
  // The terminal backend, stood in for: what the panel reads off the pane and what it types into it go through this and nothing else.
  let screen = "❯ claude\n⏺ Reading the pane…\n╭──────────╮\n│ > │\n╰──────────╯\n? for shortcuts";
  const typed = [];
  let tailReads = 0;
  const terminals = ctx.get("terminals");
  terminals.readTail = async (paneId, lines) => (tailReads++, paneId === "w1:p1" ? screen.split("\n").slice(-lines).join("\n") : null);
  terminals.sendInput = async (paneId, input) => (typed.push({ paneId, ...input }), true);
  terminals.terminal = async () => { throw new Error("the panel must never attach a control session"); };
  // Code link follows a live session's pane in the backend; the machine's own herdr has no such pane and would end the session.
  terminals.watch = () => () => undefined;
  terminals.watching = () => [];
  terminals.paneAlive = async () => true;
  terminals.panes = async () => [];
  const readConversation = ctx.codeLink.conversation.bind(ctx.codeLink);
  let convoReads = 0;
  ctx.codeLink.conversation = (...args) => (convoReads++, readConversation(...args));
  const moved = (patch) => {
    ctx.codeLink.store.patchSession(alpha.id, inPane.id, { lastEventAt: Date.now(), ...patch });
    ctx.emit("codeLink/changed", alpha.id);
    ctx.ipc.send("codeLink.changed", alpha.id);
  };
  moved({});
  await sleep(1200);
  const readsBefore = { tail: tailReads, convo: convoReads };
  await sleep(2000);
  check("while no terminal session is shown, the panel reads nothing off the pane or its record", tailReads === readsBefore.tail && convoReads === readsBefore.convo && tailReads === 0, { tailReads, convoReads });
  await press(`[...document.querySelectorAll('.ai .sbar-dot')].find((n) => /Tail the pane/.test(n.getAttribute('aria-label')))`);
  await sleep(1500);
  view = await sessionView();
  check("picking a session in a pane shows it in the panel, with the way to the Terminal window", view?.id === inPane.id && view.show && view.state === "running", view);
  check("its conversation is read from the agent's record, tool calls folded", view?.lines.map((l) => l[0]).join("|") === "person|agent|tool|agent" && view.lines[2][1] === "Bash · herdr pane read w1:p1" && view.details === 0, view?.lines);
  check("the strip shows the pane's last lines that say something", view?.strip.join("|") === "❯ claude|⏺ Reading the pane…", view?.strip);
  await press(`[...document.querySelectorAll('.ai-session-convo .cs-convo-line[data-who="tool"]')][0]`);
  await sleep(200);
  const detail = await $(`document.querySelector('.ai-session-convo .cs-convo-detail')?.textContent ?? null`);
  check("a tool call opens to its input and output", /\$ herdr pane read w1:p1/.test(detail ?? "") && /line one/.test(detail ?? ""), detail);
  screen += "\ntyped in the pane";
  const tailAt = tailReads;
  await sleep(2500);
  view = await sessionView();
  check("what is typed in the pane shows in the strip, read no more than once a second", view?.strip.at(-1) === "typed in the pane" && tailReads - tailAt >= 1 && tailReads - tailAt <= 3, { strip: view?.strip, reads: tailReads - tailAt });
  await $(`(() => { const i = document.querySelector('.ai-session-foot .ai-input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, 'hello from the panel'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()`);
  await sleep(400);
  view = await sessionView();
  check("what is said in the panel is typed into the pane, with Enter, and nothing attaches to it", typed.at(-1)?.paneId === "w1:p1" && typed.at(-1)?.text === "hello from the panel" && typed.at(-1)?.keys?.join() === "enter" && view?.input === "", typed.at(-1));
  await press(`document.querySelector('[data-testid="ai-strip"]')`);
  await sleep(1300);
  view = await sessionView();
  check("the strip opens a drawer with more of the pane", /typed in the pane/.test(view?.drawer ?? "") && /❯ claude/.test(view?.drawer ?? ""), view?.drawer);

  // The agent asks permission: the panel offers Allow and Deny while the pane shows a prompt they answer, pressing the
  // keys the agent declared; the answer closes the ask on both sides.
  // the panel stays on this session after an answer here; going on to the next one waiting is checked further down
  ctx.settings.set({ ...ctx.settings.get(), sessions: { ...ctx.settings.get().sessions, afterAnswer: "stay" } });
  // A folder's trust is no permission (Enter there is "No, exit"): the ask shows, with only the way to answer it in the pane.
  screen = "Do you trust the files in this folder?\n\n❯ No, exit\n  Yes, I trust this folder\n\nEnter to confirm · Esc to cancel";
  const convoAt = convoReads;
  moved({ state: "waiting", activity: "needs your approval: Bash" });
  moved({ state: "waiting", activity: "needs your approval: Bash" });
  moved({ state: "waiting", activity: "needs your approval: Bash" });
  await sleep(1600);
  view = await sessionView();
  check("a session waiting on a folder's trust shows the ask with no Allow or Deny, only the way to its pane", view?.state === "waiting" && /needs your approval: Bash/.test(view.approve ?? "") && !view.allow && !view.deny && view.there, view);
  check("a burst of changes re-reads the record once, not once per change", convoReads - convoAt >= 1 && convoReads - convoAt <= 2, convoReads - convoAt);
  const asks = "Bash command\n  pnpm test\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No, and tell Claude what to do differently (esc)";
  // The cursor on No: Deny alone.
  screen = asks.replace("❯ 1. Yes", "  1. Yes").replace("  3. No", "❯ 3. No");
  moved({ state: "waiting", activity: "needs your approval: Bash" });
  await sleep(1300);
  view = await sessionView();
  check("with No under the cursor only Deny is offered", !view?.allow && view?.deny && !view.there, view);
  screen = asks;
  moved({ state: "waiting", activity: "needs your approval: Bash" });
  await sleep(1300);
  view = await sessionView();
  check("a permission prompt on its screen shows Allow and Deny", view?.state === "waiting" && view.allow && view.deny && /needs your approval: Bash/.test(view.approve ?? ""), view);
  await shot("terminal-session.png");
  await press(`document.querySelector('[data-testid="ai-allow"]')`);
  await sleep(300);
  view = await sessionView();
  check("Allow presses the agent's own key for Yes in the pane and takes the ask down", typed.at(-1)?.keys?.join() === "enter" && typed.at(-1)?.text === undefined && !view?.allow && !view?.approve, { typed: typed.at(-1), view });
  moved({ state: "running", activity: "Bash · pnpm test" });
  await sleep(600);
  check("and the agent going on keeps it down", !(await sessionView())?.approve);
  moved({ state: "waiting", activity: "needs your approval: Edit" });
  await sleep(600);
  await press(`document.querySelector('[data-testid="ai-deny"]')`);
  await sleep(300);
  check("Deny presses its key for No", typed.at(-1)?.keys?.join() === "esc", typed.at(-1));
  // Answered in the pane instead: the session's next event takes the ask down here too.
  moved({ state: "waiting", activity: "needs your approval: Write" });
  await sleep(600);
  check("an ask answered nowhere stays up", (await sessionView())?.allow);
  moved({ state: "running", activity: null });
  await sleep(600);
  check("answered in the pane, the ask goes down in the panel", !(await sessionView())?.approve);
  // An agent that never said how its prompt is answered: the panel only points at the Terminal window.
  const muteTicket = ctx.items.create({ projectId: alpha.id, boardId, title: "Mute agent asks", by: "human" });
  const mute = ctx.codeLink.store.createSession(alpha.id, { repoId: "check", branch: "", itemIds: [muteTicket.id], mode: "terminal", agent: "slow", threadId: null, device: "check" });
  ctx.codeLink.store.patchSession(alpha.id, mute.id, { herdrPane: "w1:p2", state: "waiting", activity: "needs your approval: Bash", lastEventAt: Date.now() });
  ctx.emit("codeLink/changed", alpha.id);
  ctx.ipc.send("codeLink.changed", alpha.id);
  await sleep(800);
  await press(`[...document.querySelectorAll('.ai .sbar-dot')].find((n) => /Mute agent asks/.test(n.getAttribute('aria-label')))`);
  await sleep(900);
  view = await sessionView();
  check("an agent without declared keys gets no Allow, only the way to the Terminal window", view?.id === mute.id && view.allow === false && view.there, view);
  await press(`document.querySelector('[data-testid="ai-answer-there"]')`);
  await sleep(300);
  check("which shows the session there", shown.at(-1) === mute.id, shown);
  await press(`document.querySelector('[data-testid="ai-session-show"]')`);
  await sleep(300);
  check("as the head's link does", shown.length >= 2 && shown.at(-1) === mute.id, shown);
  await press(`[...document.querySelectorAll('.ai .sbar-dot')].find((n) => /Tail the pane/.test(n.getAttribute('aria-label')))`);
  await sleep(900);

  // Looking elsewhere stops every read; the thread comes back as it was.
  const left = { tail: tailReads, convo: convoReads };
  await press(`[...document.querySelectorAll('.ai .sbar-dot')].find((n) => n.getAttribute('aria-label')?.startsWith('Filler conversation'))`);
  await sleep(600);
  moved({ state: "running", activity: "Bash · more" });
  await sleep(2200);
  check("picking a thread brings its conversation back and stops reading the pane and the record", !(await sessionView()) && tailReads === left.tail && convoReads === left.convo && !!(await $(`!!document.querySelector('.ai-scroll .turn, .ai-composer')`)), { tail: tailReads - left.tail, convo: convoReads - left.convo });

  // ── what else waits: a line on top, ⌥↓ to the next, and answering one opens the next — or stays, as the person chose ──
  const until = async (fn, tries = 50) => {
    for (let i = 0; i < tries; i++) {
      if (await fn()) return true;
      await sleep(100);
    }
    return false;
  };
  const present = (selector) => $(`!!document.querySelector(${JSON.stringify(selector)})`);
  let askers = 0;
  const asking = async () => {
    const th = ctx.agent.newThread(alpha.id, "mixed", null, { title: `Asker ${++askers}` });
    ctx.agent.send(alpha.id, th.id, { kind: "text", text: "ask" });
    await until(async () => ctx.agent.thread(alpha.id, th.id).pending?.kind === "question", 60);
    return th.id;
  };
  const shownThread = () => $(`localStorage.getItem('tomrade.agent.thread.${alpha.id}')`);
  const queueLine = () => $(`document.querySelector('[data-testid="wait-queue"] .ai-queue-text')?.textContent ?? null`);
  const asksHere = () => until(() => present('.ai-scroll .q-ask:not(.done) .chip-opt'), 50);
  const answerHere = async () => {
    await press(`document.querySelector('.ai-scroll .q-ask:not(.done) .chip-opt')`);
    await sleep(150);
    await press(`document.querySelector('.ai-scroll .q-ask:not(.done) .q-confirm .btn')`);
  };
  // the session steps above leave nothing waiting in a pane; earlier conversations may still wait, longer, and come first
  ctx.settings.set({ ...ctx.settings.get(), sessions: { ...ctx.settings.get().sessions, afterAnswer: "next" } });
  for (const s of ctx.codeLink.store.sessions(alpha.id)) if (s.state !== "ended" && s.state !== "lost") ctx.codeLink.store.patchSession(alpha.id, s.id, { state: "ended", endedAt: Date.now() });
  ctx.emit("codeLink/changed", alpha.id);
  ctx.ipc.send("codeLink.changed", alpha.id);
  const first = await asking();
  await asking();
  ctx.ipc.send("attention.open", { key: `thread:${first}`, projectId: alpha.id, threadId: first, itemId: null, itemKey: null, kind: "question", who: null, text: "Which one?", since: Date.now() });
  await until(async () => (await shownThread()) === first, 50);
  await shot("wait-queue.png");
  check("with others waiting, a line on top says who waits for what", /Asker 2 asks you something/.test((await queueLine()) ?? ""), await queueLine());
  await asksHere();
  await answerHere();
  check("answering opens the next one waiting", await until(async () => ![first, null].includes(await shownThread()), 50), await shownThread());
  check("and says so", await until(async () => ((await $(`document.body.innerText`)) ?? "").includes("Done with Asker 1 · this one waits too"), 30));
  ctx.settings.set({ ...ctx.settings.get(), sessions: { ...ctx.settings.get().sessions, afterAnswer: "stay" } });
  await asking();
  const answered = await shownThread();
  await asksHere();
  await answerHere();
  await sleep(1500);
  check("set to stay, answering keeps the conversation that was answered", (await shownThread()) === answered, await shownThread());
  check("and the line on top still lists the rest", /asks you something/.test((await queueLine()) ?? ""), await queueLine());
  await $(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));true`);
  check("⌥↓ goes to the next one waiting", await until(async () => (await shownThread()) !== answered, 30), await shownThread());
  ctx.settings.set({ ...ctx.settings.get(), sessions: { ...ctx.settings.get().sessions, afterAnswer: "next" } });

  // ── chat that turns to code: a rule where the writing starts, the earlier steps folded under what they changed ──
  const coder = ctx.agent.newThread(alpha.id, "coder", null, { title: "Coder chat" });
  for (const said of ["hello", "write the parts"]) {
    const sent = ctx.agent.send(alpha.id, coder.id, { kind: "text", text: said });
    for (let i = 0; i < 60 && ctx.agent.store.run(alpha.id, sent.runId)?.status === "running"; i++) await sleep(100);
  }
  ctx.ipc.send("attention.open", { key: `thread:${coder.id}`, projectId: alpha.id, threadId: coder.id, itemId: null, itemKey: null, kind: "question", who: null, text: null, since: Date.now() });
  for (let i = 0; i < 50 && !(await $(`!!document.querySelector('[data-testid="work-rule"]')`)); i++) await sleep(100);
  const rule = await $(`document.querySelector('[data-testid="work-rule"]')?.textContent ?? null`);
  check("where a chat turns to writing files, a rule says so", rule === "Writing code", rule);
  const workFolds = () => $(`[...document.querySelectorAll('.ai-scroll [data-testid="work-fold"]')].map((f) => ({ summary: f.querySelector('summary')?.textContent, open: f.open, rows: f.querySelectorAll('.trace-row').length, waiting: f.hasAttribute('data-waiting') }))`);
  const coderFold = (await workFolds())[0];
  const loose = await $(`[...document.querySelectorAll('.ai-scroll .trace-row')].filter((r) => !r.closest('.trace-fold')).length`);
  check("and the writing folds whole, closed, under what it came to", coderFold?.summary === "6 files changed" && !coderFold.open && coderFold.rows === 6 && loose === 0, { coderFold, loose });
  await shot("writing-code.png");
  // asked before a command: the stretch says what it waits to be allowed, and the question points at the setting
  const tested = ctx.agent.send(alpha.id, coder.id, { kind: "text", text: "test the parts" });
  check("while it waits on a command, the stretch says what it waits to be allowed", await until(async () => (await workFolds())[1]?.summary === "1 file changed · waiting for you to allow `echo 'Tests  8 passed (8)'`", 80), await workFolds());
  check("and the question says every command asks, with the way to the setting", await until(() => present('[data-testid="ask-each-command"] button'), 30), await $(`document.querySelector('.q-ask')?.textContent ?? null`));
  await shot("writing-code-waiting.png");
  await press(`[...document.querySelectorAll('.q-ask:not(.done) .chip-opt')].find((b) => b.textContent === 'Allow once')`);
  await sleep(200);
  await press(`document.querySelector('.q-ask:not(.done) .q-confirm .btn')`);
  await until(() => ctx.agent.store.run(alpha.id, tested.runId)?.status === "done", 80);
  check("once allowed, the stretch folds the answer in and says how the tests went", await until(async () => { const f = (await workFolds())[1]; return f?.summary === "1 file changed · 1 command · tests 8 passed" && !f.waiting && f.rows === 2; }, 50) && !(await present('[data-testid="ask-each-command"]')), await workFolds());

  // ── 「放到后台做」: the coding moves to a child conversation under this one; this one stays free to talk, and the conclusion comes back ──
  const gates = new Map();
  // the stand-in holds its turn here until the harness lets it go — or until the turn is stopped
  // a turn stopped before it got here (between two writes, say) never hears an abort again: it is over already
  const gate = (id, signal) => new Promise((resolve, reject) => { if (signal.aborted) return reject(new Error("stopped")); gates.set(id, resolve); signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }); });
  ctx.agent.engine({
    id: "bgcoder",
    title: "Background coder",
    author: "ai:bgcoder",
    available: async () => ({ ok: true }),
    async turn(input, io) {
      const text = input.input.kind === "text" ? input.input.text : "";
      if (text.startsWith("Carry on in the background")) {
        await io.tools.execute("write_file", { path: "code/part-4.md", content: "part 4" });
        await gate("child", io.signal);
        io.emit({ type: "text", text: "All parts written, tests pass." });
        return { stop: "end" };
      }
      if (text.startsWith("write")) {
        for (let i = 1; i <= 3; i++) await io.tools.execute("write_file", { path: `code/part-${i}.md`, content: `part ${i}` });
        await gate("parent", io.signal);
        io.emit({ type: "text", text: "Written." });
        return { stop: "end" };
      }
      io.emit({ type: "text", text: "Sure." });
      return { stop: "end" };
    }
  });
  const bgParent = ctx.agent.newThread(alpha.id, "bgcoder", null, { title: "Dedupe chat" });
  const bgHello = ctx.agent.send(alpha.id, bgParent.id, { kind: "text", text: "hello" });
  await until(() => ctx.agent.store.run(alpha.id, bgHello.runId)?.status === "done", 60);
  await threads();
  await $(`(() => { const i = document.querySelector('.menu-search input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, 'Dedupe chat'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(300);
  await press(`[...document.querySelectorAll('.menu-row.is-radio')].find((r) => r.querySelector('.m-name')?.textContent === 'Dedupe chat')`);
  await until(async () => (await shownThread()) === bgParent.id, 50);
  await sleep(600);
  await send("write the dedupe script");
  check("while the run writes code, the rule offers to do it in the background", await until(() => present('[data-testid="work-rule"] [data-testid="to-background"]'), 60));
  await shot("to-background.png");
  await press(`document.querySelector('[data-testid="to-background"]')`);
  const childOf = () => ctx.agent.store.threads(alpha.id).find((th) => th.parentId === bgParent.id);
  check("it opens a child conversation under this one, on the same engine, and starts it", await until(() => !!childOf() && childOf().engine === "bgcoder" && ctx.agent.activeRuns().some((a) => a.thread.id === childOf().id), 60), childOf());
  const bgChild = childOf();
  check("the turn here was stopped and the conversation stays open", await until(async () => ctx.agent.store.runs(alpha.id, bgParent.id).at(-1)?.status === "cancelled" && !(await panel()).working && (await shownThread()) === bgParent.id, 50));
  check("and a note says the coding moved, with the way to the child", await until(() => $(`[...document.querySelectorAll('.ai-scroll .agent-note')].some((n) => /Moved the coding to the background/.test(n.textContent) && !!n.querySelector('[data-testid="note-thread"]'))`), 50));
  await sleep(600);
  barSeen = await bar();
  const bgAt = barSeen?.dots.findIndex(([, label]) => /^Dedupe chat,/.test(label)) ?? -1;
  const bgNext = barSeen?.dots[bgAt + 1];
  check("in the session bar the child sits right under its parent, set in, running", bgAt >= 0 && barSeen.dots[bgAt][2] === null && bgNext?.[0] === "run" && /writing code/.test(bgNext?.[1] ?? "") && bgNext?.[2] === "1", barSeen?.dots);
  // the stand-in answers at once, so the new turn is told by the run it started, not by a spinner that may be gone already
  const parentRuns = ctx.agent.store.runs(alpha.id, bgParent.id).length;
  await send("another question");
  await sleep(400);
  check("while the child runs, this conversation takes a message at once, not into the queue", ctx.agent.store.runs(alpha.id, bgParent.id).length === parentRuns + 1 && ctx.agent.activeRuns().some((a) => a.thread.id === bgChild.id) && (await queued()).length === 0 && (await asked()).includes("another question"), { queued: await queued(), asked: await asked() });
  await until(async () => !(await panel()).working, 50);
  await until(() => gates.has("child"), 50);
  gates.get("child")?.();
  await until(() => ctx.agent.store.runs(alpha.id, bgChild.id).at(-1)?.status === "done", 60);
  const conclusions = () => $(`[...document.querySelectorAll('.ai-scroll .agent-note')].filter((n) => /All parts written, tests pass/.test(n.textContent)).length`);
  check("when the child finishes, its conclusion lands here, once", await until(async () => (await conclusions()) === 1, 50) && (await shownThread()) === bgParent.id, await conclusions());
  await sleep(800);
  check("and once only", (await conclusions()) === 1 && ctx.agent.thread(alpha.id, bgParent.id).messages.filter((m) => m.block.type === "note" && m.block.threadFor === bgChild.id).length === 2, await conclusions());
  await shot("background-done.png");

  // ── 「在终端格子里接着做」 and back: a CLI agent's conversation to a terminal cell, one process on its session at a time ──
  const cliTurns = [];
  const cliReleased = [];
  ctx.agent.engine({
    id: "cli",
    title: "Fake CLI",
    author: "ai:cli",
    capabilities: ["backlog", "code"],
    available: async () => ({ ok: true }),
    async turn(input, io) {
      cliTurns.push({ text: input.input.kind === "text" ? input.input.text : "", resume: io.resume ?? null });
      io.emit({ type: "text", text: "ok" });
      return { stop: "end", resume: io.resume ?? "cli-check-1" };
    },
    release: (thread) => void cliReleased.push(thread.threadId)
  });
  // the terminal is a stand-in: no pane opens on this machine, the launch is only recorded
  const launches = [];
  const launchWas = ctx.codeLink.herdr.launch.bind(ctx.codeLink.herdr);
  ctx.codeLink.herdr.launch = async (input) => (launches.push(input), { script: "", launched: true, paneId: "w1:p7" });
  const cliThread = ctx.agent.newThread(alpha.id, "cli", null, { title: "Handoff chat" });
  const cliHello = ctx.agent.send(alpha.id, cliThread.id, { kind: "text", text: "hello" });
  await until(() => ctx.agent.store.run(alpha.id, cliHello.runId)?.status === "done", 60);
  const openThreadNamed = async (name) => {
    await threads();
    await $(`(() => { const i = document.querySelector('.menu-search input'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, ${JSON.stringify(name)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await sleep(300);
    await press(`[...document.querySelectorAll('.menu-row.is-radio')].find((r) => r.querySelector('.m-name')?.textContent === ${JSON.stringify(name)})`);
  };
  const handoffLine = () => $(`(() => { const l = document.querySelector('[data-testid="handoff"]'); if (!l) return null; const b = l.querySelector('[data-testid="to-terminal"], [data-testid="back-to-panel"]'); return { where: l.dataset.where, live: l.hasAttribute('data-live'), text: l.textContent, button: b ? { id: b.dataset.testid, disabled: b.disabled, title: b.title } : null, send: document.querySelector('.ai-send')?.disabled ?? null, sendTitle: document.querySelector('.ai-send')?.title ?? null }; })()`);
  await openThreadNamed("Dedupe chat");
  await until(async () => (await shownThread()) === bgParent.id, 50);
  await sleep(400);
  check("a conversation on the built-in coder shows no way to a terminal", !(await present('[data-testid="handoff"]')));
  await openThreadNamed("Handoff chat");
  await until(async () => (await shownThread()) === cliThread.id, 50);
  check("a CLI agent's conversation offers to go on in a terminal cell", await until(async () => (await handoffLine())?.button?.id === "to-terminal" && !(await handoffLine()).button.disabled, 50), await handoffLine());
  await shot("to-terminal.png");
  await press(`document.querySelector('[data-testid="to-terminal"]')`);
  const cliSession = () => ctx.codeLink.store.sessions(alpha.id).find((s) => s.threadId === cliThread.id && s.mode === "terminal");
  check("it closes the runtime here and opens a terminal session of the thread, resuming the same session in the thread's own folder", await until(() => !!cliSession() && cliReleased.includes(cliThread.id) && launches.length === 1, 60) && cliSession().externalId === "cli-check-1" && launches[0].cwd === cliSession().cwd && /--resume cli-check-1/.test(launches[0].command), { session: cliSession(), launch: launches[0], released: cliReleased });
  check("the panel moves to that session's view, with the way back there but not yet", await until(async () => (await sessionView())?.id === cliSession()?.id, 50) && (await $(`document.querySelector('[data-testid="back-to-panel"]')?.disabled ?? null`)) === true, await sessionView());
  check("and the conversation says where it went and that approvals are the CLI's there", ctx.agent.thread(alpha.id, cliThread.id).messages.some((m) => m.block.type === "note" && /Moved to a terminal cell \(pane w1:p7\).*the CLI asks there itself/.test(m.block.text)));
  await shot("in-terminal.png");
  // back on the thread while its CLI runs: nothing can be sent, and it cannot come back yet
  await press(`document.querySelector('.ai-session-head button[aria-label="Back to the conversation"]')`);
  await until(async () => (await handoffLine())?.where === "terminal", 50);
  let hl = await handoffLine();
  check("back on the thread, the panel says the CLI runs it in a terminal cell, takes no message and cannot take it back yet", hl?.where === "terminal" && hl.live && /(Fake CLI|cli) runs this conversation in a terminal cell/.test(hl.text) && hl.button?.id === "back-to-panel" && hl.button.disabled && hl.send === true && /goes on in a terminal cell/.test(hl.sendTitle ?? ""), hl);
  // the CLI ran as its hooks say, then exited
  ctx.codeLink.sessions.event(alpha.id, cliSession().id, { hook_event_name: "SessionStart", session_id: "cli-check-2", cwd: cliSession().cwd });
  ctx.codeLink.sessions.event(alpha.id, cliSession().id, { hook_event_name: "SessionEnd" });
  check("once the CLI exited, the way back opens", await until(async () => { const l = await handoffLine(); return l?.where === "terminal" && !l.live && l.button?.id === "back-to-panel" && !l.button.disabled; }, 50), await handoffLine());
  await shot("back-offered.png");
  await press(`document.querySelector('[data-testid="back-to-panel"]')`);
  check("taking it back lists the conversation again, free to talk", await until(async () => (await handoffLine())?.where === "here" && ctx.agent.store.thread(alpha.id, cliThread.id).surface === "assistant" && (await shownThread()) === cliThread.id, 50) && (await handoffLine()).sendTitle === "Send", await handoffLine());
  await send("again");
  await until(() => cliTurns.length === 2, 60);
  check("and the next message resumes the session the CLI ran as, through the SDK", cliTurns[1]?.text === "again" && cliTurns[1]?.resume === "cli-check-2", cliTurns);

  // ── the claim card: before a workstream conversation's first change to a file, claim a ticket — here, in the background, or with a CLI ──
  ctx.agent.engine({
    id: "claimer",
    title: "Claimer",
    author: "ai:claimer",
    available: async () => ({ ok: true }),
    async turn(input, io) {
      const text = input.input.kind === "text" ? input.input.text : "";
      if (text.startsWith("Carry on in the background")) {
        io.emit({ type: "text", text: "Finished in the background." });
        return { stop: "end" };
      }
      if (text.startsWith("write")) {
        await io.tools.execute("write_file", { path: `code/${text.replace(/\W+/g, "-")}.md`, content: text });
        io.emit({ type: "text", text: "Written." });
        return { stop: "end" };
      }
      io.emit({ type: "text", text: "Sure." });
      return { stop: "end" };
    }
  });
  const sayTo = async (threadId, text) => {
    const sent = ctx.agent.send(alpha.id, threadId, { kind: "text", text });
    await until(() => ctx.agent.store.run(alpha.id, sent.runId)?.status === "done", 60);
  };
  const claimChat = async (title) => {
    const th = ctx.agent.newThread(alpha.id, "claimer", boardId, { title });
    await sayTo(th.id, "hello");
    await sayTo(th.id, `write ${title}`);
    ctx.ipc.send("attention.open", { key: `thread:${th.id}`, projectId: alpha.id, threadId: th.id, itemId: null, itemKey: null, kind: "question", who: null, text: null, since: Date.now() });
    await until(async () => (await shownThread()) === th.id, 50);
    return th;
  };
  const claimCard = () => $(`(() => { const c = document.querySelector('[data-testid="claim-card"]'); return c ? { text: c.textContent, buttons: [...c.querySelectorAll('button[data-testid]')].map((b) => b.dataset.testid), engine: c.querySelector('[data-testid="claim-cli"]')?.dataset.engine ?? null } : null; })()`);
  const writes = (threadId) => ctx.agent.store.messages(alpha.id, threadId).filter((m) => m.block.type === "trace" && m.block.tool === "write_file" && m.block.ok).length;
  const closeChat = await claimChat("Claim close chat");
  check("before a workstream conversation's first change to a file, a card offers to claim a ticket: here, in the background, or with a CLI", await until(async () => (await claimCard())?.buttons.join() === "claim-close,claim-here,claim-background,claim-cli", 50) && /About to change code/.test((await claimCard()).text), await claimCard());
  check("and it does not hold the writing up", writes(closeChat.id) === 1, writes(closeChat.id));
  await shot("claim-card.png");
  await press(`document.querySelector('[data-testid="claim-close"]')`);
  check("closed, the card goes and the conversation stays without a ticket", await until(async () => !(await claimCard()), 30) && ctx.agent.store.thread(alpha.id, closeChat.id).itemId === null);
  await sayTo(closeChat.id, "write more");
  await sleep(400);
  check("and it writes on as before, the card not back", writes(closeChat.id) === 2 && !(await claimCard()), { writes: writes(closeChat.id), card: await claimCard() });

  const hereChat = await claimChat("Claim here chat");
  await until(async () => !!(await claimCard()), 50);
  await press(`document.querySelector('[data-testid="claim-here"]')`);
  const claimedItem = (threadId) => { const id = ctx.agent.store.thread(alpha.id, threadId)?.itemId; return id ? ctx.items.get(alpha.id, id) : null; };
  check("claiming here puts a new ticket named after the conversation on it, and marks it Doing", await until(() => claimedItem(hereChat.id)?.title === "Claim here chat", 50) && claimedItem(hereChat.id).status === "doing", claimedItem(hereChat.id));
  const claimRule = () => $(`document.querySelector('[data-testid="work-rule"][data-claimed]')?.textContent ?? null`);
  check("the rule is drawn where it claimed, with the ticket, and the card is gone", await until(async () => (await claimRule()) === `${claimedItem(hereChat.id)?.key} · writing code` && !(await claimCard()), 50), { rule: await claimRule(), card: await claimCard() });
  await shot("claimed-here.png");

  const bgChat = await claimChat("Claim background chat");
  await until(async () => !!(await claimCard()), 50);
  await press(`document.querySelector('[data-testid="claim-background"]')`);
  const bgChildOf = () => ctx.agent.store.threads(alpha.id).find((th) => th.parentId === bgChat.id);
  check("claiming into the background opens a child conversation on the new ticket, and this one stays free to talk", await until(() => !!claimedItem(bgChat.id) && !!bgChildOf() && bgChildOf().itemId === claimedItem(bgChat.id).id, 60) && (await shownThread()) === bgChat.id, { child: bgChildOf(), item: claimedItem(bgChat.id) });

  // the CLI a terminal cell takes it up with: the one tickets were last started with on this machine
  ctx.codeLink.defaults.write({ mode: "terminal", engine: "cli" });
  ctx.ipc.send("codeLink.startDefaultsChanged");
  const cliChat = await claimChat("Claim cli chat");
  // the engine list was read before this check's CLI stand-in came: coming back online reads it again
  await $(`window.dispatchEvent(new Event('offline'));window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('visibilitychange'));true`);
  check("the third way names the CLI it would hand over to", await until(async () => (await claimCard())?.engine === "cli", 80), await claimCard());
  const launchedBefore = launches.length;
  await press(`document.querySelector('[data-testid="claim-cli"]')`);
  const cliClaimSession = () => ctx.codeLink.store.sessions(alpha.id).find((s) => s.threadId === cliChat.id && s.mode === "terminal");
  check("switching to the CLI claims the ticket and opens a terminal session of the conversation on that agent, fresh, with what it came to", await until(() => !!cliClaimSession() && launches.length === launchedBefore + 1 && !!claimedItem(cliChat.id), 80)
    && cliClaimSession().agent === "cli" && cliClaimSession().externalId === null && ctx.agent.store.thread(alpha.id, cliChat.id).engine === "cli" && !/--resume/.test(launches.at(-1).command)
    && fs.readFileSync(path.join(ctx.codeLink.sessionDir(cliClaimSession().id), "prompt.md"), "utf8").includes("handed to you from Tomrade's built-in assistant"), { session: cliClaimSession(), launch: launches.at(-1) });
  check("and the panel moves to that session", await until(async () => (await sessionView())?.id === cliClaimSession()?.id, 50), await sessionView());
  await press(`document.querySelector('.ai-session-head button[aria-label="Back to the conversation"]')`);
  await sleep(400);
  ctx.codeLink.herdr.launch = launchWas;

  // The Terminal window from the main window: the title bar's button and ⇧⌘T run its own command for this project.
  const opened = [];
  const runCommand = ctx.contributions.run.bind(ctx.contributions);
  ctx.contributions.run = async (id, scope) => (id === "code-sessions.open" ? (opened.push(scope.projectId), {}) : runCommand(id, scope));
  check("the title bar offers the Terminal window", await $(`!!document.querySelector('[data-testid="titlebar-terminal"]')`));
  await press(`document.querySelector('[data-testid="titlebar-terminal"]')`);
  await sleep(400);
  check("its button opens this project's Terminal window", opened.length === 1 && opened[0] === alpha.id, opened);
  await $(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', code: 'KeyT', shiftKey: true, metaKey: ${process.platform === "darwin"}, ctrlKey: ${process.platform !== "darwin"}, bubbles: true, cancelable: true }));true`);
  await sleep(400);
  check("⇧⌘T opens it too", opened.length === 2 && opened[1] === alpha.id, opened);
  ctx.contributions.run = runCommand;

  // ── ⌘K finds sessions and does things with them, from what the window already holds ──
  const mac = process.platform === "darwin";
  const reads = { threads: 0, sessions: 0 };
  const threadsOf = ctx.agent.store.threads.bind(ctx.agent.store);
  ctx.agent.store.threads = (...args) => (reads.threads++, threadsOf(...args));
  const recentOf = ctx.codeLink.recentSessions.bind(ctx.codeLink);
  ctx.codeLink.recentSessions = (...args) => (reads.sessions++, recentOf(...args));
  const openPalette = async () => {
    await $(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: ${mac}, ctrlKey: ${!mac}, bubbles: true, cancelable: true }));true`);
    return until(() => present(".palette-input"), 30);
  };
  const typePalette = (text) => $(`(() => { const i = document.querySelector('.palette-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const enterPalette = (shift = false) => $(`document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey: ${shift}, bubbles: true, cancelable: true }));true`);
  const readsAt = { ...reads };
  await openPalette();
  await sleep(600);
  const groups = await $(`[...document.querySelectorAll('.palette [cmdk-group-heading]')].map((h) => h.textContent)`);
  check("⌘K lists what waits on you, what is in progress, what to do and what ended, ahead of the views and actions it had", ["Waiting on you", "In progress", "Do", "History", "Views", "Actions"].every((g) => groups.includes(g)) && groups.indexOf("Waiting on you") < groups.indexOf("Views"), groups);
  check("opening it asks the main process for nothing: the sessions are the ones the window holds", reads.threads === readsAt.threads && reads.sessions === readsAt.sessions, { reads, readsAt });
  await shot("palette-sessions.png");
  // ↵ on one waiting: its conversation, here
  const asker = await $(`document.querySelector('[data-testid="palette-waiting"] [cmdk-item]')?.dataset.session ?? null`);
  await press(`document.querySelector('[data-testid="palette-waiting"] [cmdk-item]')`);
  check("picking one that waits opens its conversation in the panel", !!asker && (await until(async () => `thread:${await shownThread()}` === asker, 30)), { asker, shown: await shownThread() });
  // ⇧↵ on a terminal session: its Terminal window cell
  const shownIn = [];
  const showSession = ctx.codeLink.showSession.bind(ctx.codeLink);
  ctx.codeLink.showSession = async (projectId, sessionId) => (shownIn.push(sessionId), true);
  await openPalette();
  await typePalette("Tail the pane");
  await sleep(300);
  // the ticket of that name matches too: the pointer on the session's row makes it the one ↵ takes
  await $(`document.querySelector('[data-session="session:${inPane.id}"]')?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));true`);
  await enterPalette(true);
  await sleep(400);
  check("⇧↵ on a terminal session opens it in a Terminal window cell", shownIn.length === 1 && shownIn[0] === inPane.id, { shownIn, want: inPane.id });
  ctx.codeLink.showSession = showSession;
  // nothing found: ↵ starts a conversation with the words typed
  const threadsBefore = ctx.agent.store.threads(alpha.id, ["assistant"]).length;
  await openPalette();
  await typePalette("zqx draft the release notes");
  await sleep(300);
  check("with nothing found, the palette offers to start a session with the words", await present('[data-testid="palette-start-with"]'));
  await enterPalette();
  const started = await until(async () => ctx.agent.store.threads(alpha.id, ["assistant"]).length > threadsBefore, 50);
  const startedThread = await shownThread();
  const firstSaid = startedThread ? ctx.agent.thread(alpha.id, startedThread)?.messages?.find((m) => m.role === "user")?.block?.text : null;
  check("↵ then starts one, sent those words", started && firstSaid === "zqx draft the release notes", { started, firstSaid });
  ctx.agent.store.threads = threadsOf;
  ctx.codeLink.recentSessions = recentOf;

  // ── the look back: ended sessions by day with what came of each first; one opened read-only, cut by ticket ──
  // A session that did one ticket, then claimed and fixed another on the way: its record, as Claude Code writes one, stamped.
  const reviewTicket = ctx.items.create({ projectId: alpha.id, boardId, title: "Save a record snapshot", by: "human" });
  const alsoTicket = ctx.items.create({ projectId: alpha.id, boardId, title: "Leftover MCP entry", by: "human" });
  const reviewed = ctx.codeLink.store.createSession(alpha.id, { repoId: "check", branch: "al-review/snapshot", itemIds: [reviewTicket.id], mode: "terminal", agent: "claude-code", threadId: null, device: "check" });
  const reviewBase = reviewed.startedAt;
  const stamp = (ms) => new Date(reviewBase + ms).toISOString();
  const reviewRecord = path.join(work, "cc-review-1.jsonl");
  fs.writeFileSync(reviewRecord, [
    { type: "user", timestamp: stamp(0), message: { content: "start on the snapshot" } },
    { type: "assistant", timestamp: stamp(1000), message: { content: [{ type: "text", text: "Reading the ticket first." }, { type: "tool_use", id: "r1", name: "Write", input: { file_path: "packages/code-link/src/snapshots.ts", content: "x" } }] } },
    { type: "user", timestamp: stamp(1500), message: { content: [{ type: "tool_result", tool_use_id: "r1", content: "ok" }] } },
    { type: "assistant", timestamp: stamp(3000), message: { content: [{ type: "text", text: `Found a leftover MCP entry, that is ${alsoTicket.key}. Claiming it.` }, { type: "tool_use", id: "r2", name: "mcp__tomrade__claim_ticket", input: { key: alsoTicket.key } }] } },
    { type: "assistant", timestamp: stamp(4000), message: { content: [{ type: "tool_use", id: "r3", name: "Edit", input: { file_path: "apps/desktop/scripts/check-env.mjs", old_string: "a", new_string: "b" } }] } },
    { type: "assistant", timestamp: stamp(5000), message: { content: [{ type: "text", text: "Fixed and merged." }] } }
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  ctx.codeLink.store.patchSession(alpha.id, reviewed.id, { externalId: "cc-review-1", transcript: reviewRecord, terminal: "iTerm.app", asked: 2, marks: [{ itemId: reviewTicket.id, at: reviewBase }, { itemId: alsoTicket.id, at: reviewBase + 3500 }], worked: [{ itemId: alsoTicket.id, delivery: 1 }], state: "ended", endedAt: reviewBase + 6000, summary: "PR #407 merged" });
  ctx.codeLink.store.upsertLink(alpha.id, { itemId: reviewTicket.id, repoId: "check", branch: "al-review/snapshot" }, { ahead: 4, prNumber: 407, prState: "merged", prUrl: "https://example.test/pr/407" });
  // a claim opens the ticket's delivery: what its page reads the session that moved on from it by
  ctx.codeLink.store.ensureActiveDelivery(alpha.id, alsoTicket.id);
  ctx.emit("codeLink/changed", alpha.id);
  ctx.ipc.send("codeLink.changed", alpha.id);
  await sleep(600);
  // the session bar's History opens the list
  await press(`document.querySelector('[data-testid="sbar-history"]')`);
  check("the session bar's History opens the look back in the panel", await until(() => present('[data-testid="ai-review-list"]'), 30));
  const reviewRows = () => $(`[...document.querySelectorAll('[data-testid="ai-review-row"]')].map((r) => r.textContent)`);
  await until(async () => (await reviewRows()).some((text) => /Save a record snapshot/.test(text)), 30);
  const reviewRow = (await reviewRows()).find((text) => /Save a record snapshot/.test(text)) ?? null;
  check("a row says the outcome first — the pull request, the commits, how often it asked — then the agent and the other ticket it did", /PR #407 merged · 4 commits · asked you 2 times/.test(reviewRow ?? "") && /Claude Code|claude-code/.test(reviewRow ?? "") && new RegExp(`also did ${alsoTicket.key}`).test(reviewRow ?? ""), reviewRow);
  check("rows sit under the day they ended", (await $(`document.querySelector('.ai-review-day')?.textContent ?? null`)) === "Today");
  await shot("review-list.png");
  // searched by a word said in the conversation, in no title
  const typeReview = (text) => $(`(() => { const i = document.querySelector('[data-testid="ai-review-search"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await typeReview("leftover");
  check("searching a word said in a conversation finds it and quotes the line", await until(async () => /leftover/.test(await $(`[...document.querySelectorAll('[data-testid="ai-review-said"]')].map((s) => s.textContent).join('|')`)), 60));
  await typeReview("zqx nothing");
  check("nothing found says so, and that raw output is not searched", await until(async () => /Raw output is not searched/.test(await $(`document.querySelector('.ai-review-list')?.textContent ?? ''`)), 60));
  await typeReview("");
  await until(async () => (await reviewRows()).some((text) => /Save a record snapshot/.test(text)), 30);
  // opened from the list: everything on top, every stretch open
  await press(`[...document.querySelectorAll('[data-testid="ai-review-row"]')].find((r) => /Save a record snapshot/.test(r.textContent))`);
  await until(() => present('[data-testid="ai-review-seg"]'), 50);
  const reviewOpen = await $(`({ title: document.querySelector('[data-testid="ai-review-title"]')?.textContent ?? null, outcome: document.querySelector('[data-testid="ai-review-outcome"]')?.textContent ?? null, tickets: document.querySelector('[data-testid="ai-review-tickets"]')?.textContent ?? null,
    lenses: !!document.querySelector('[data-testid="ai-review-lenses"]'), resume: !!document.querySelector('[data-testid="ai-review-resume"]'), terminal: !!document.querySelector('[data-testid="ai-review-resume-terminal"]'), input: !!document.querySelector('.ai .ai-input') })`);
  check("opening one shows its outcome and the tickets it did on top, read-only, with the ways to go on", /PR #407 merged/.test(reviewOpen.outcome ?? "") && reviewOpen.tickets?.includes(reviewTicket.key) && reviewOpen.tickets?.includes(alsoTicket.key) && reviewOpen.resume && reviewOpen.terminal && !reviewOpen.input, reviewOpen);
  check("without a recording of its pane there is no raw-output tab", !reviewOpen.lenses, reviewOpen);
  const segs = () => $(`[...document.querySelectorAll('[data-testid="ai-review-seg"]')].map((s) => [s.dataset.ticket, s.dataset.kind, !!s.dataset.open])`);
  check("the conversation is cut where the second ticket was claimed, each stretch marked writing code, all open from the list", JSON.stringify(await segs()) === JSON.stringify([[reviewTicket.key, "code", true], [alsoTicket.key, "code", true]]), await segs());
  const segLines = await $(`[...document.querySelectorAll('[data-testid="ai-review-seg"]')].map((s) => [...s.querySelectorAll('.cs-convo-line')].map((l) => l.textContent))`);
  check("each stretch holds its own lines, the claim opening the second", segLines[0]?.[0] === "start on the snapshot" && /claim_ticket/.test(segLines[1]?.[0] ?? ""), segLines);
  await shot("review-open.png");
  // going on in a terminal cell asks the Terminal window for a new cell with the agent's resume command
  const resumedIn = [];
  const resumeInTerminal = ctx.codeLink.resumeInTerminal.bind(ctx.codeLink);
  ctx.codeLink.resumeInTerminal = async (_projectId, sessionId) => (resumedIn.push(sessionId), true);
  await press(`document.querySelector('[data-testid="ai-review-resume-terminal"]')`);
  check("“go on in a terminal cell” asks for a new cell on this session", await until(() => Promise.resolve(resumedIn[0] === reviewed.id), 30) && (await until(async () => /resuming the conversation/.test(await $(`document.body.innerText`)), 30)), resumedIn);
  ctx.codeLink.resumeInTerminal = resumeInTerminal;
  // from the other ticket's page: only its stretches open
  await $(`[...document.querySelectorAll('.card')].find((n) => n.textContent.includes('Leftover MCP entry'))?.click(); true`);
  const reviewRowSel = `[...document.querySelectorAll('.detail .sect-row')].find((r) => /Look back/.test(r.querySelector('dt')?.textContent ?? ''))?.querySelector('button')`;
  check("the ticket's Code section offers to look back on the session that worked it", await until(() => $(`!!${reviewRowSel}`), 50));
  await press(reviewRowSel);
  check("opened from the ticket's page, only that ticket's stretches are open", await until(async () => JSON.stringify(await segs()) === JSON.stringify([[reviewTicket.key, "code", false], [alsoTicket.key, "code", true]]), 50), await segs());
  // ⌘K's History reaches it too, and opens the look back on it
  await press(`document.querySelector('[data-testid="ai-review-back"]')`);
  await openPalette();
  await typePalette("record snapshot");
  const historyRow = `[...document.querySelectorAll('[data-testid="palette-history"] [cmdk-item]')].find((n) => /Save a record snapshot/.test(n.textContent))`;
  check("⌘K's History lists the ended session with its outcome", await until(() => $(`!!${historyRow} && /PR #407 merged/.test(${historyRow}.textContent)`), 30));
  await $(`${historyRow}?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));true`);
  await enterPalette();
  check("picking it in ⌘K opens the look back on it", await until(async () => (await $(`document.querySelector('[data-testid="ai-review-open"]')?.dataset.review ?? null`)) === reviewed.id, 30));
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
