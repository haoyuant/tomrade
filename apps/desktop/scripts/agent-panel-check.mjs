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
  const queued = () => $(`[...document.querySelectorAll('.ai-queued')].map((q) => ({ text: q.querySelector('.q-text')?.textContent ?? null, held: q.hasAttribute('data-held') }))`);
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
  await press(`[...document.querySelectorAll('.menu-foot [role="menuitem"]')].find((r) => /Show archived/.test(r.textContent ?? ''))`);
  await sleep(600);
  check("the archive lists what was put away", await $(`[...document.querySelectorAll('.menu-foot .menu-row.is-radio')].some((r) => r.textContent?.includes('Filler conversation 3'))`));
  await press(`[...document.querySelectorAll('.menu-foot .menu-row.is-radio')].find((r) => r.textContent?.includes('Filler conversation 3'))`);
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
