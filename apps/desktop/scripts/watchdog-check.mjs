/**
 * The watchdog on the real plugin tree, with a stand-in engine that goes quiet: the row loads on by default, its card
 * has its words, a quiet run lands on the attention list as "may be stuck" (not "stopped") and shows in the panel, the
 * run is left alone, and the entry leaves when the run moves, when it ends, and when the person turns the watchdog off.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:watchdog
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-watchdog-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MINUTE = 60_000;
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const run = async () => {
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work },
    // looks come from this check, each at the time it names
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }, { id: "watchdog", config: { intervalMs: 3_600_000 } }]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  await ctx.storage.ready;
  ctx.settings.set({ ...ctx.settings.get(), language: "en", onboarding: { seen: ["*"] } });

  check("the row loads and says what it provides", !!ctx.get("watchdog"));
  check("on by default", ctx.settings.get().watchdog?.enabled === true, ctx.settings.get().watchdog);
  check("its card has words in Chinese", ctx.settings.sections("zh").find((s) => s.id === "watchdog")?.title === "巡检");

  const turns = [];
  ctx.agent.engine({
    id: "quiet",
    title: "Quiet",
    author: "ai:quiet",
    available: async () => ({ ok: true }),
    async turn(_input, io) {
      turns.push(io);
      io.emit({ type: "trace", tool: "Bash", args: { command: "pnpm test" }, ok: true, summary: "ran it", ms: 1 });
      await new Promise((resolve) => io.signal.addEventListener("abort", resolve, { once: true }));
      return { stop: "cancelled" };
    }
  });

  const win = new BrowserWindow({ width: 1280, height: 860, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  await win.loadURL(`${process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/"}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  await sleep(2500);

  const entries = () => $(`window.tomrade.invoke("attention.list")`);
  const thread = ctx.agent.newThread(project.id, "quiet", null, { title: "Long job" });
  const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go" });
  await sleep(300);
  const now = Date.now();
  ctx.watchdog.look(now);
  ctx.watchdog.look(now + 14 * MINUTE);
  await sleep(600);
  check("short of the limit it says nothing", (await entries()).length === 0, await entries());

  ctx.watchdog.look(now + 16 * MINUTE);
  await sleep(600);
  const [entry] = await entries();
  check("a quiet run is listed as suspected, not as stopped", entry?.kind === "suspect" && entry.threadId === thread.id, entry);
  check("the entry says what it last did", /No activity/.test(entry?.text ?? "") && entry.text.includes("Bash"), entry);
  check("the run is left alone", ctx.agent.activeRuns().some((r) => r.run.id === runId) && !turns[0].signal.aborted);
  check("nothing was written into the conversation", !ctx.agent.thread(project.id, thread.id).messages.some((m) => /No activity|stuck/i.test(JSON.stringify(m.block))));
  // what a click on the notification does
  ctx.ipc.send("attention.open", { projectId: project.id, threadId: thread.id, itemId: null });
  await sleep(1500);
  const opened = await $(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => n.textContent.includes('waiting for you'));
    if (!b) return false;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) b.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    return true;
  })()`);
  await sleep(600);
  const menu = await $(`document.body.textContent`);
  check("the status bar lists it in its own words", opened && menu.includes("May be stuck") && menu.includes("No activity") && !menu.includes("Stopped"), menu.slice(-400));
  if (process.env.TOMRADE_SHOTS) fs.writeFileSync(path.join(process.env.TOMRADE_SHOTS, "watchdog-panel.png"), (await win.webContents.capturePage()).toPNG());
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);

  turns[0].delta("still here");
  await sleep(600);
  check("moving again takes it off the list", (await entries()).length === 0, await entries());

  const later = Date.now();
  ctx.watchdog.look(later + 16 * MINUTE);
  await sleep(600);
  check("quiet again, it is back", (await entries())[0]?.kind === "suspect", await entries());
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, watchdog: { ...settings.watchdog, enabled: false } });
  await sleep(600);
  check("turned off, what it told leaves the list", (await entries()).length === 0, await entries());
  ctx.settings.set({ ...settings, watchdog: { ...settings.watchdog, enabled: true } });
  await sleep(200);

  ctx.watchdog.look(Date.now());
  ctx.watchdog.look(Date.now() + 16 * MINUTE);
  await sleep(600);
  check("turned on again, it watches again", (await entries())[0]?.kind === "suspect", await entries());
  ctx.agent.cancel(runId);
  await sleep(800);
  check("when the run ends it leaves the list", !(await entries()).some((e) => e.kind === "suspect"), await entries());
};

app
  .whenReady()
  .then(run)
  .catch((error) => {
    results.push({ name: `threw: ${error?.stack ?? error}`, pass: false });
    console.log(`FAIL: ${error?.stack ?? error}`);
  })
  .finally(() => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    fs.rmSync(work, { recursive: true, force: true });
    app.exit(failed.length ? 1 : 0);
  });
