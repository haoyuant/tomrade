/**
 * Night shift regression: the title bar and the palette open the dialog, To Do tickets are chosen
 * and a dependency is explained, terminal panes or sessions are picked, the shift
 * starts where it was told, progress shows in the dialog, the title bar and the status bar,
 * and Stop ends it. Start itself is a stand-in: real starts are covered by
 * packages/night-shift/tests/real-start.test.ts.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:night-shift
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const shots = process.env.TOMRADE_SHOTS ?? path.join(dir, "shots");
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-night-shift-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work, linkAgents: "false" }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  await ctx.storage.ready;
  const board = ctx.boards.list(project.id)[0];
  ctx.settings.set({ ...ctx.settings.get(), language: "en", onboarding: { seen: ["*"] } });

  ctx.agent.engine({ id: "standin", title: "Stand-in coder", author: "ai:standin", capabilities: ["backlog", "code", "general"], available: async () => ({ ok: true }), async turn() { return { stop: "end" }; } });
  const make = (title, status = "todo") => ctx.items.create({ projectId: project.id, boardId: board.id, title, status, workType: "coding", by: "human" });
  const first = make("Add the export button");
  const second = make("Write the export docs");
  const later = make("A long one for a later night, whose title runs on well past the width of the dialog so that it has to wrap", "backlog");
  const general = ctx.items.create({ projectId: project.id, boardId: board.id, title: "Sign the lease", status: "todo", workType: "general", by: "human" });
  const keyOf = (item) => item.key;
  ctx.llm.worker = async () => ({ ok: true });
  ctx.llm.completeJson = async (_schema, opts) => {
    if (opts.system.startsWith("You decide")) return { decision: "now", why: "It stops the export working" };
    if (!opts.system.startsWith("You plan")) throw new Error("no judgement in this check");
    await planHeld;
    if (planRefusal) throw new Error(planRefusal);
    return { summary: "Ship the export.", suggested: suggesting, excluded: [], dependencies: [{ before: second.key, after: later.key, why: "It documents what the later one changes" }] };
  };
  let suggesting = [first.key, second.key];
  let planHeld = Promise.resolve();
  let planRefusal = "";
  ctx.items.update(project.id, first.id, { blocks: [second.id] }, "human");
  const starts = [];
  ctx.codeLink.start = async (_projectId, itemId, opts) => {
    starts.push({ itemId, mode: opts.mode, engine: opts.engine });
    return { ok: true, threadId: null, branch: `work/${itemId}` };
  };

  ctx.codeLink.prChecks = async () => "pending";

  const win = new BrowserWindow({ width: 1500, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  win.webContents.on("console-message", (e) => { if (e.level === "error") console.log(`RENDERER: ${String(e.message).slice(0, 400)}`); });
  const press = (expr) => $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true })); return true; })()`);
  const shot = async (name) => fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const waitFor = async (expr, ms = 8000) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (await $(expr)) return true;
      await sleep(80);
    }
    return false;
  };
  const test = (id) => `document.querySelector('[data-testid="${id}"]')`;
  const text = (id) => `(${test(id)}?.textContent ?? '')`;
  const candidate = (title) => `[...document.querySelectorAll('[data-testid="night-shift-candidate"]')].find((r) => r.textContent.includes(${JSON.stringify(title)}))`;
  const status = () => `[...document.querySelectorAll('.statusbar .status-item')].map((n) => n.textContent).join(' | ')`;
  const closeDialog = `[...document.querySelectorAll('.dlg-foot .btn-secondary')].find((b) => /^(Cancel|Close)$/.test(b.textContent.trim()))`;
  await waitFor(`!!document.querySelector('.statusbar')`, 20000);

  // ── from the title bar ────────────────────────────────────────────────
  await sleep(600);
  check("a project with no repository has no door to a shift it could not run", !(await $(`!!${test("titlebar-night-shift")}`)));
  ctx.repos.create({ projectId: project.id, name: "alpha", remote: "https://example.com/alpha.git" });
  const reloaded = new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  win.webContents.reload();
  await reloaded;
  await waitFor(`!!document.querySelector('.statusbar')`, 20000);
  check("with a repository, the title bar offers a night shift", await waitFor(`!!${test("titlebar-night-shift")}`));
  await shot("night-shift-entry");
  await press(test("titlebar-night-shift"));
  check("the title bar opens the dialog", await waitFor(`!!${test("plan-view")}`));
  await press(closeDialog);
  await waitFor(`!${test("plan-view")}`);

  // ── from the sidebar ──────────────────────────────────────────────────
  check("the backlog's sidebar module ends with the way in", await waitFor(`document.querySelector('.side-backlog .side-module-body')?.lastElementChild === ${test("sidebar-auto-run")} && ${test("sidebar-auto-run")} !== null`));
  await press(test("sidebar-auto-run"));
  check("which opens the dialog", await waitFor(`!!${test("plan-view")}`));
  await press(closeDialog);
  await waitFor(`!${test("plan-view")}`);

  // ── from the palette ──────────────────────────────────────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));true`);
  check("the palette offers a night shift", await waitFor(`[...document.querySelectorAll('.palette-row')].some((r) => r.textContent.includes('Start an auto run'))`));
  await press(`[...document.querySelectorAll('.palette-row')].find((r) => r.textContent.includes('Start an auto run'))`);
  check("which opens the dialog", await waitFor(`!!${test("plan-view")}`));

  // ── the plan ──────────────────────────────────────────────────────────
  const nodeNamed = (key) => `document.querySelector('[data-testid="plan-node"][data-key="${key}"]')`;
  const nodeChosen = (key) => `${nodeNamed(key)}?.classList.contains('is-chosen')`;
  check("the dialog opens on the graph, with every open ticket", await waitFor(`document.querySelectorAll('[data-testid="plan-node"]').length === 4`), await $(`document.querySelectorAll('[data-testid="plan-node"]').length`));
  check("the plan says the agent ran", await waitFor(`${text("plan-summary")}.includes('Ship the export')`), await $(text("plan-summary")));
  check("the suggested ticket is chosen, the excluded one is not, and it says why", await $(`${nodeChosen(keyOf(first))} && ${nodeChosen(keyOf(second))} && !${nodeChosen(keyOf(later))} && !${nodeChosen(keyOf(general))} && ${nodeNamed(keyOf(general))}.textContent.includes('Not coding work')`));
  await sleep(800);
  await shot("plan-graph");
  const size = await $(`(() => { const s = document.querySelector('.palette').getBoundingClientRect(); const g = ${test("plan-graph")}.getBoundingClientRect(); return { sheet: s.width, graph: g.height, bottom: g.bottom, foot: document.querySelector('.dlg-foot').getBoundingClientRect().top }; })()`);
  check("the sheet opens wide, with a tall graph", size.sheet >= 1200 && size.graph >= 400, size);
  check("and the graph ends above the buttons, unscrolled", size.bottom <= size.foot, size);
  const zoom = `Number(/scale\\(([\\d.]+)\\)/.exec(document.querySelector('.plan-graph .react-flow__viewport').style.transform)?.[1] ?? 0)`;
  check("the cards are drawn large enough to read", (await $(zoom)) >= 0.8, await $(zoom));
  check("Suggested says how many", (await $(text("plan-pick-suggested"))).endsWith("2"), await $(text("plan-pick-suggested")));
  await press(test("plan-pick-suggested"));
  check("pressing it with nothing to change still answers", await waitFor(`${text("plan-pick-note")}.includes('2 suggested')`), await $(text("plan-pick-note")));
  await press(`document.querySelector('[data-testid="plan-pick-none"]')`);
  check("None clears the choice", await waitFor(`!document.querySelector('.plan-node.is-chosen')`));
  check("and the answer goes with it", !(await $(text("plan-pick-note"))));
  await press(`document.querySelector('[data-testid="plan-pick-suggested"]')`);
  check("Suggested brings it back", await waitFor(`document.querySelectorAll('.plan-node.is-chosen').length === 2`));
  planRefusal = '400 {"type":"error","error":{"message":"Your credit balance is too low"}}';
  await press(test("plan-again"));
  check("a failed analysis says what stopped it", await waitFor(`(${text("plan-why")}).includes('Your credit balance is too low')`), await $(text("plan-summary")));
  planRefusal = "";
  await press(test("plan-again"));
  await waitFor(`${text("plan-summary")}.includes('Ship the export')`);
  suggesting = [];
  await press(test("plan-again"));
  check("a plan that suggests nothing says so, and the button is off", await waitFor(`${text("plan-pick-note")}.includes('suggests no tickets') && ${test("plan-pick-suggested")}.disabled`), await $(text("plan-pick-note")));
  await sleep(200);
  await shot("plan-none-suggested");
  suggesting = [first.key, second.key];
  let letPlanGo;
  planHeld = new Promise((resolve) => { letPlanGo = resolve; });
  await press(test("plan-again"));
  check("while it plans, Suggested waits", await waitFor(`${test("plan-pick-suggested")}.disabled && ${text("plan-summary")}.length > 0 && !${test("plan-again")}`));
  await press(nodeNamed(keyOf(later)));
  await waitFor(nodeChosen(keyOf(later)));
  letPlanGo();
  planHeld = Promise.resolve();
  check("a plan that lands after a click still ticks what it suggests", await waitFor(`${nodeChosen(keyOf(first))} && ${nodeChosen(keyOf(second))} && ${nodeChosen(keyOf(later))}`), await $(`document.querySelectorAll('.plan-node.is-chosen').length`));
  await press(nodeNamed(keyOf(later)));
  await waitFor(`!${nodeChosen(keyOf(later))}`);
  await press(nodeNamed(keyOf(later)));
  check("a click takes a ticket", await waitFor(nodeChosen(keyOf(later))));
  await press(nodeNamed(keyOf(later)));
  check("and leaves it", await waitFor(`!${nodeChosen(keyOf(later))}`));
  const box = await $(`(() => { const r = document.querySelector('.plan-graph .react-flow__pane').getBoundingClientRect(); return { left: r.left + 4, top: r.top + 4, right: r.right - 4, bottom: r.bottom - 4 }; })()`);
  win.webContents.sendInputEvent({ type: "mouseMove", x: box.left, y: box.top });
  win.webContents.sendInputEvent({ type: "mouseDown", x: box.left, y: box.top, button: "left", clickCount: 1 });
  for (let i = 1; i <= 8; i++) win.webContents.sendInputEvent({ type: "mouseMove", x: box.left + ((box.right - box.left) * i) / 8, y: box.top + ((box.bottom - box.top) * i) / 8, button: "left" });
  win.webContents.sendInputEvent({ type: "mouseUp", x: box.right, y: box.bottom, button: "left", clickCount: 1 });
  check("a drag across the canvas takes everything it touches", await waitFor(`document.querySelectorAll('.plan-node.is-chosen').length === 4`), await $(`document.querySelectorAll('.plan-node.is-chosen').length`));
  await press(`document.querySelector('[data-testid="plan-pick-suggested"]')`);
  await waitFor(`document.querySelectorAll('.plan-node.is-chosen').length === 2`);
  check("the agent's dependency is drawn dashed and offered", await waitFor(`!!${test("plan-proposed")} && !!document.querySelector('.plan-graph path[style*="dasharray"]')`));
  check("nothing is written while it is only offered", !ctx.items.get(project.id, later.id).blockedBy.length);
  await press(`document.querySelector('[data-testid="plan-proposed-edge"] input')`);
  check("taken, it is drawn solid", await waitFor(`!document.querySelector('.plan-graph path[style*="dasharray"]')`));
  // ── a node's own settings ─────────────────────────────────────────────
  await press(`${nodeNamed(keyOf(second))}.querySelector('[data-testid="plan-node-cfg"]')`);
  check("a node opens its settings, and a click on them does not choose it", (await waitFor(`!!${test("plan-config")}`)) && (await $(nodeChosen(keyOf(second)))));
  check("left alone, it goes as the run goes", (await $(text("plan-config-from"))) === "As the run goes", await $(text("plan-config-from")));
  await shot("plan-config");
  const pick = (selector, value) => $(`(() => { const s = ${selector}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await pick(`${test("plan-config")}.querySelectorAll('select')[0]`, "terminal");
  check("a setting by hand says so, on the panel and on the node", (await waitFor(`${text("plan-config-from")} === 'Set by hand'`)) && (await waitFor(`${nodeNamed(keyOf(second))}.textContent.includes('Set by hand')`)));
  await press(`document.querySelector('[data-testid="plan-rules"]')?.closest('.fold')?.querySelector('.fold-head') ?? document.querySelector('[data-fold="plan-rules"] .fold-head')`);
  await waitFor(`!!${test("plan-rule-add")}`);
  await press(test("plan-rule-add"));
  check("a new rule says it matches nothing yet", await waitFor(`!!${test("plan-rule-empty")}`));
  await $(`(() => { const i = ${test("plan-rule-label")}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'docs'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); return true; })()`);
  check("a condition saves it", await waitFor(`!${test("plan-rule-empty")}`) && (await (async () => { for (let i = 0; i < 40 && !ctx.nightShift.rules(project.id)[0]?.when.label; i++) await sleep(50); return ctx.nightShift.rules(project.id)[0]?.when.label === "docs"; })()), ctx.nightShift.rules(project.id));
  await press(test("plan-rule-delete"));
  check("and it can go again", await waitFor(`!${test("plan-rule")}`) && (await (async () => { for (let i = 0; i < 40 && ctx.nightShift.rules(project.id).length; i++) await sleep(50); return !ctx.nightShift.rules(project.id).length; })()));
  await press(`document.querySelector('[data-testid="plan-view"] [data-view="list"]')`);
  check("the list is a click away", await waitFor(`!!${test("night-shift-pick")} && !${test("plan-graph")}`));
  check("how long: until done has no hours to set, a night shift does", !(await $(`!!document.querySelector('#nsHours')`)));
  await press(`document.querySelector('[data-testid="night-shift-kind"] [data-kind="night"]')`);
  check("a night shift asks for its hours", await waitFor(`!!document.querySelector('#nsHours')`));
  await press(`document.querySelector('[data-testid="night-shift-kind"] [data-kind="done"]')`);

  // ── choosing ──────────────────────────────────────────────────────────
  check("To Do is chosen, Backlog is not", await $(`${candidate("Add the export button")}.querySelector('input').checked && ${candidate("Write the export docs")}.querySelector('input').checked && !${candidate("A long one")}.querySelector('input').checked`));
  check("a dependant says it needs automatic merging", (await $(`${candidate("Write the export docs")}.textContent`)).includes("starts only with automatic merging"));
  await press(test("night-shift-auto-merge"));
  check("with it on, it says what it waits for", await waitFor(`${candidate("Write the export docs")}.textContent.includes('After AL-')  && !${candidate("Write the export docs")}.textContent.includes('only with')`));

  // ── where it runs ─────────────────────────────────────────────────────
  const pressed = () => $(`${test("night-shift-mode")}.querySelector('[aria-pressed="true"]').dataset.mode`);
  await press(`${test("night-shift-mode")}.querySelector('[data-mode="run"]')`);
  check("sessions can be picked", await waitFor(`${test("night-shift-mode")}.querySelector('[data-mode="run"]').getAttribute('aria-pressed') === 'true'`));
  await press(`${test("night-shift-mode")}.querySelector('[data-mode="terminal"]')`);
  check("and terminal panes", await waitFor(`${test("night-shift-mode")}.querySelector('[data-mode="terminal"]').getAttribute('aria-pressed') === 'true'`), await pressed());
  check("in a terminal it says the agent's own permissions apply", await waitFor(`!!${test("night-shift-terminal-permissions")}`));
  await shot("night-shift-setup");

  // ── the number stepper ────────────────────────────────────────────────
  await $(`(() => { const n = document.querySelector('#nsInserts'); n.scrollIntoView({ block: 'center' }); n.focus(); return true; })()`);
  await sleep(200);
  const before = Number(await $(`document.querySelector('#nsInserts').value`));
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Up" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Up" });
  await sleep(150);
  check("the arrow keys still step", Number(await $(`document.querySelector('#nsInserts').value`)) === before + 1, await $(`document.querySelector('#nsInserts').value`));
  await shot("number-stepper");

  // ── a narrow window, Glass ────────────────────────────────────────────
  const fits = () => $(`(() => { const s = document.querySelector('.palette'); return !!s && s.scrollWidth <= s.clientWidth + 1 && s.getBoundingClientRect().right <= innerWidth; })()`);
  win.setSize(760, 620);
  await sleep(400);
  check("nothing spills out of a narrow window", await fits());
  check("and its buttons stay on screen", await $(`document.querySelector('.dlg-foot').getBoundingClientRect().bottom <= innerHeight`));
  await shot("night-shift-narrow");
  await $(`document.documentElement.classList.add('glass');true`);
  await sleep(300);
  check("nor under Glass", await fits());
  await shot("night-shift-glass");
  await $(`document.documentElement.classList.remove('glass');true`);
  win.setSize(1500, 900);
  await sleep(300);

  // ── going ─────────────────────────────────────────────────────────────
  // finding the agents on this machine takes a moment, and the button waits for them
  await $(`(() => { const s = ${test("night-shift-notify")}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'stuck'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  check("the start button waits for an agent", await waitFor(`${test("night-shift-start")}?.disabled === false`, 30000));
  await press(test("night-shift-start"));
  check("it starts in the place chosen, upstream first", await waitFor(`!!${test("night-shift-going")}`) && (await (async () => { for (let i = 0; i < 50 && !starts.length; i++) await sleep(100); return starts[0]?.itemId === first.id && starts[0]?.mode === "terminal"; })()), starts);
  check("its dependant waits", starts.length === 1, starts);
  check("the dependency the person took is on the tickets", ctx.items.get(project.id, second.id).blocks.includes(later.id), ctx.items.get(project.id, second.id).blocks);
  check("until done runs for three days at most", ctx.nightShift.current(project.id)?.settings.maxMinutes === 72 * 60);
  check("what was set on the node reached the shift", ctx.nightShift.current(project.id)?.tickets.find((x) => x.itemId === second.id)?.config?.mode === "terminal");
  check("how to be told is kept on the run", ctx.nightShift.current(project.id)?.settings.notify === "stuck");
  check("the running dialog shows the plan graph", await waitFor(`!!${test("plan-graph")} && !!${nodeNamed(keyOf(first))}`));
  check("a node shows where it stands", await waitFor(`${nodeNamed(keyOf(first))}?.dataset.state === 'running' && ${nodeNamed(keyOf(second))}?.dataset.state === 'queued'`), await $(`${nodeNamed(keyOf(first))}?.dataset.state`));
  check("the timeline says it started", await waitFor(`[...document.querySelectorAll('[data-testid="plan-step"]')].some((s) => s.dataset.kind === 'started' && s.textContent.includes(${JSON.stringify(keyOf(first))}))`));
  check("the setting is kept on the shift", ctx.nightShift.current(project.id)?.settings.mode === "terminal" && ctx.nightShift.current(project.id)?.settings.autoMerge === true);
  check("the dialog says where it runs", await waitFor(`${text("night-shift-going")}.includes('In terminal panes')`));
  check("the status bar shows it", await waitFor(`(${status()}).includes('Auto run 0/2')`), await $(status()));
  check("the title bar says how far along it is", await waitFor(`${text("titlebar-night-shift")}.includes('0/2')`), await $(text("titlebar-night-shift")));

  ctx.items.update(project.id, first.id, { status: "verifying" }, "human");
  await ctx.nightShift.tick();
  check("a delivery moves the count, in the dialog and on the status bar", (await waitFor(`${text("night-shift-going")}.includes('1 of 2 delivered')`)) && (await waitFor(`(${status()}).includes('Auto run 1/2')`)), await $(text("night-shift-going")));
  check("a delivery moves the node and the timeline", (await waitFor(`${nodeNamed(keyOf(first))}?.dataset.state === 'delivered'`)) && (await waitFor(`[...document.querySelectorAll('[data-testid="plan-step"]')].some((s) => s.dataset.kind === 'delivered')`)));
  const reported = await ctx.nightShift.report(project.id, first.key, { title: "Saving crashes on empty names", body: "src/save.ts throws" });
  await ctx.nightShift.tick();
  check("a problem an agent found joins the run", reported.outcome === "inserted", reported);
  check("the graph marks it, with where it came from and why", await waitFor(`${nodeNamed(reported.key)}?.dataset.added === 'true' && ${nodeNamed(reported.key)}.textContent.includes('Added') && ${nodeNamed(reported.key)}.textContent.includes('It stops the export working')`, 12000), await $(`${nodeNamed(reported.key)}?.outerHTML?.slice(0, 300) ?? null`));
  check("a dashed line runs to it from where it was found", await waitFor(`!!document.querySelector('.plan-graph path[style*="dasharray"]')`));
  check("the timeline says so", await waitFor(`[...document.querySelectorAll('[data-testid="plan-step"]')].some((s) => s.dataset.kind === 'inserted' && s.textContent.includes(${JSON.stringify(reported.key)}))`));
  check("the summary counts it", await waitFor(`${text("night-shift-going")}.includes('1 added')`), await $(text("night-shift-going")));
  await sleep(800);
  await shot("night-shift-going");
  check("the agent for it was started", await (async () => { for (let i = 0; i < 40 && starts.length < 2; i++) await sleep(50); return starts.length === 2; })(), starts);
  ctx.items.update(project.id, ctx.nightShift.current(project.id).tickets.find((x) => x.origin).itemId, { status: "verifying" }, "human");
  await ctx.nightShift.tick();
  const current = ctx.nightShift.current.bind(ctx.nightShift);
  ctx.nightShift.current = (id) => { const shift = current(id); return shift && { ...shift, counts: { ...shift.counts, "needs-you": 1 } }; };
  ctx.ipc.send("nightShift.changed", project.id);
  check("the title bar shows a ticket waiting for you", await waitFor(`${test("titlebar-night-shift")}.title.includes('1 need you') && !!${test("titlebar-night-shift")}.querySelector('.titlebar-night-shift-waiting')`), await $(`${test("titlebar-night-shift")}.title`));
  await press(closeDialog);
  check("the dialog closes", await waitFor(`!${test("night-shift-going")}`));
  await sleep(300);
  await shot("night-shift-entry-waiting");
  const barFits = () => $(`(() => { const bar = document.querySelector('.titlebar').getBoundingClientRect(); const last = document.querySelector('.titlebar > :last-child').getBoundingClientRect(); return last.right <= bar.right; })()`);
  for (const width of [1500, 1280, 1100]) {
    win.setSize(width, 900);
    await sleep(300);
    check(`at ${width} wide, with a shift going, settings stay on the bar`, await barFits(), await $(`document.querySelector('.titlebar').clientWidth`));
    check(`and the waiting count shows`, await $(`${test("titlebar-night-shift")}.querySelector('.titlebar-night-shift-waiting').getBoundingClientRect().width > 0`));
  }
  await shot("night-shift-entry-tight");
  win.setSize(1500, 900);
  await sleep(300);
  await press(test("titlebar-night-shift"));
  await waitFor(`!!${test("night-shift-going")}`);
  ctx.nightShift.current = current;
  ctx.ipc.send("nightShift.changed", project.id);

  // ── stopping ──────────────────────────────────────────────────────────
  await press(test("night-shift-stop"));
  check("Stop halts it", await waitFor(`${text("night-shift-going")}.includes('Stopping') || !!${test("plan-view")}`));
  await ctx.nightShift.tick();
  await sleep(200);
  check("no new ticket started", starts.length === 2, starts);
  check("the status bar lets go once it ends", await waitFor(`!(${status()}).includes('Auto run')`), await $(status()));
  check("the title bar goes back to offering one", await waitFor(`${test("titlebar-night-shift")}.title === 'Start the auto run'`), await $(`${test("titlebar-night-shift")}.title`));
  check("the dialog says how the last one went", await waitFor(`${text("night-shift-last")}.includes('Stopped: 2 of 3 delivered')`), await $(text("night-shift-last")));
  check("the morning report lands in Files, with a way to it from the dialog", await waitFor(`!!${test("night-shift-brief")}`), ctx.nightShift.list(project.id, 1)[0]?.briefPath);
  const brief = ctx.nightShift.list(project.id, 1)[0]?.briefPath;
  const written = brief ? (await ctx.files.read(project.id, brief)) : null;
  check("and it says what happened", !!written && String(written.body ?? written).includes("It was stopped before it finished."), written);
  await shot("night-shift-stopped");
  await press(test("night-shift-brief"));
  check("the link opens the report", await waitFor(`location.hash.includes('/f/')`), await $(`location.hash`));
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
