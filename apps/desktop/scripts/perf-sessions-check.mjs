/**
 * Performance baseline (TOM-715): three agents at work in terminal panes while both windows watch. A project of 500
 * tickets; three sessions in stand-in herdr panes, each with a Claude Code record over 2 MB that keeps growing, and
 * two hook events a second through code link's own hook path; the main window's panel shows one of them, the Terminal
 * window is open on its overview. For PERF_SECONDS (30) it records the main process's event-loop delay, each window's
 * long tasks and frame times, memory at the start and the end, and the IPC between them, then prints a report.
 * Numbers only: it fails when the scenario could not be set up, never on a slow number (PERF_LOOP_P99_MS, 1000,
 * is a sanity bound). PERF_JSON=<file> also writes the report there.
 *
 *   pnpm build:backend && pnpm --filter @tomradex/ui build, serve packages/ui (vite preview) then
 *   TOMRADE_DEV_URL=http://127.0.0.1:<port>/ pnpm --filter @tomrade/desktop test:perf:sessions
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";
import vm from "node:vm";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-perf-sessions-"));
// The panes are stood in for; nothing here may reach the person's own herdr server.
for (const key of ["HERDR_SOCKET_PATH", "HERDR_CLIENT_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_ENV"]) delete process.env[key];
process.env.HERDR_SESSION = `tomrade-perf-sessions-${process.pid}`;
app.setPath("userData", work);
app.commandLine.appendSwitch("js-flags", "--expose-gc");
app.commandLine.appendSwitch("enable-precise-memory-info");
app.on("window-all-closed", () => {});
v8.setFlagsFromString("--expose-gc");
const gc = (() => {
  try {
    return vm.runInNewContext("gc");
  } catch {
    return () => undefined;
  }
})();

const SECONDS = Number(process.env.PERF_SECONDS ?? 30);
const EVENTS_PER_SECOND = 2;
const SESSIONS = 3;
const RECORD_MIN = 2 * 1024 * 1024;
const LOOP_RESOLUTION_MS = 10;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

// ── IPC, counted in this process: every send to a renderer, every invoke and message from one ──
// Sizes are the JSON length of the arguments (and of an invoke's reply): close to what crosses, cheap to take.
const ipc = { on: false, cost: 0, sends: new Map(), invokes: new Map(), messages: new Map() };
const size = (value) => {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
};
const tally = (map, wc, channel, bytes, extra = {}) => {
  const byWc = map.get(wc) ?? new Map();
  map.set(wc, byWc);
  const row = byWc.get(channel) ?? { count: 0, bytes: 0, reply: 0, ms: 0 };
  row.count += 1;
  row.bytes += bytes;
  row.reply += extra.reply ?? 0;
  row.ms += extra.ms ?? 0;
  byWc.set(channel, row);
};
app.on("web-contents-created", (_event, wc) => {
  const send = wc.send.bind(wc);
  wc.send = (channel, ...args) => {
    if (ipc.on) {
      const t = performance.now();
      tally(ipc.sends, wc.id, channel, size(args));
      ipc.cost += performance.now() - t;
    }
    return send(channel, ...args);
  };
});
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) =>
  handle(channel, async (event, ...args) => {
    if (!ipc.on) return handler(event, ...args);
    const t = performance.now();
    const bytes = size(args);
    ipc.cost += performance.now() - t;
    const started = performance.now();
    const out = await handler(event, ...args);
    const ms = performance.now() - started;
    const t2 = performance.now();
    tally(ipc.invokes, event.sender.id, channel, bytes, { reply: size(out), ms });
    ipc.cost += performance.now() - t2;
    return out;
  });
const emit = ipcMain.emit.bind(ipcMain);
ipcMain.emit = (channel, event, ...args) => {
  if (ipc.on && event?.sender) {
    const t = performance.now();
    tally(ipc.messages, event.sender.id, channel, size(args));
    ipc.cost += performance.now() - t;
  }
  return emit(channel, event, ...args);
};
const sum = (byWc, key) => [...(byWc?.values() ?? [])].reduce((n, row) => n + row[key], 0);
const top = (byWc, n = 4) =>
  [...(byWc?.entries() ?? [])]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, n)
    .map(([channel, row]) => `${channel.replace(/^tomrade:/, "")} ×${row.count}`);

// ── what a renderer measures of itself: long tasks, and the time between frames ──
const PROBE = `(() => {
  if (window.__perf) return true;
  const s = (window.__perf = { on: false, frames: [], long: 0, longs: 0, last: 0 });
  try {
    new PerformanceObserver((list) => { if (!s.on) return; for (const e of list.getEntries()) { s.long += e.duration; s.longs += 1; } }).observe({ type: "longtask" });
  } catch {}
  const tick = (t) => { if (s.on && s.last) s.frames.push(t - s.last); s.last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return true;
})()`;
const START = `(() => { const s = window.__perf; s.frames = []; s.long = 0; s.longs = 0; s.last = 0; s.on = true; return true; })()`;
const STOP = `(() => {
  const s = window.__perf; s.on = false;
  const f = [...s.frames].sort((a, b) => a - b);
  const at = (q) => (f.length ? f[Math.min(f.length - 1, Math.floor(q * f.length))] : null);
  return { frames: f.length, p50: at(0.5), p95: at(0.95), max: f.length ? f[f.length - 1] : null, over50: f.filter((d) => d > 50).length, long: s.long, longs: s.longs };
})()`;
const HEAP = `(() => { window.gc?.(); return performance.memory?.usedJSHeapSize ?? null; })()`;

const MB = (bytes) => (bytes === null || bytes === undefined ? null : Math.round((bytes / 1048576) * 10) / 10);
const ms1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

/** Claude Code's record of a busy conversation: a prompt, then tool call after tool call, each with its output. */
const entry = (type, content) => JSON.stringify({ type, uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: type === "user" ? "user" : "assistant", content } }) + "\n";
const output = (n) => Array.from({ length: 24 }, (_, i) => `  ✓ packages/core/tests/case-${n}-${i}.test.ts > keeps step ${i} of ${n} steady (${(i * 7) % 90} ms)`).join("\n");
const toolTurn = (n) =>
  entry("assistant", [{ type: "text", text: `Step ${n}: running the tests for the part that changed.` }, { type: "tool_use", id: `t${n}`, name: "Bash", input: { command: `pnpm test packages/core/tests/case-${n}.test.ts` } }]) +
  entry("user", [{ type: "tool_result", tool_use_id: `t${n}`, content: output(n) }]);

const STATUSES = ["backlog", "todo", "doing", "verifying", "done"];

const run = async () => {
  const { boot } = await import("../dist/boot.js");
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }, { id: "code-sessions", disabled: false }, { id: "herdr", config: { statePath: path.join(work, "herdr.json"), socket: path.join(work, "no-herdr.sock") } }]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Perf", keyPrefix: "PF" });
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", onboarding: { seen: ["*"] }, codeLink: { ...settings.codeLink, terminal: "herdr" } });
  const boardId = ctx.boards.list(project.id)[0].id;
  const tickets = [];
  for (let i = 0; i < 500; i++) {
    const busy = i < SESSIONS;
    tickets.push(ctx.items.create({ projectId: project.id, boardId, title: busy ? `Busy session ${i + 1}` : `Ticket number ${i} with a title long enough to wrap onto a second line`, status: busy ? "doing" : STATUSES[i % 5], priority: i % 4, labels: i % 3 ? ["ui"] : ["core", "sync"], ...(busy ? { workType: "coding" } : {}), by: i % 2 ? "human" : "ai:mcp" }));
  }

  // ── three sessions in stand-in herdr panes, each with a record over 2 MB ──
  const cwd = fs.mkdtempSync(path.join(work, "repo-"));
  const sessions = [];
  for (let i = 0; i < SESSIONS; i++) {
    const externalId = randomUUID();
    const record = path.join(work, `${externalId}.jsonl`);
    let text = entry("user", `Work on ${tickets[i].key}: make the busy part fast.`);
    for (let n = 0; text.length < RECORD_MIN; n++) text += toolTurn(n);
    fs.writeFileSync(record, text);
    const pane = `w1:p${i + 1}`;
    const session = ctx.codeLink.store.createSession(project.id, { repoId: "perf", branch: `${tickets[i].key.toLowerCase()}/perf`, itemIds: [tickets[i].id], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: cwd });
    ctx.codeLink.store.patchSession(project.id, session.id, { herdrPane: pane, externalId, transcript: record, cwd, state: "running", prompted: true, lastEventAt: Date.now() });
    sessions.push({ id: session.id, ticket: tickets[i], pane, externalId, record, step: 1000, tick: 0, screen: ["❯ claude", `⏺ Working on ${tickets[i].key}`] });
  }
  const sizes = sessions.map((s) => fs.statSync(s.record).size);
  check("three sessions, each with a record over 2 MB", sizes.every((n) => n >= RECORD_MIN), sizes);

  // The terminal backend, stood in for: panes that answer, screens that change, and no stream to attach.
  const byPane = new Map(sessions.map((s) => [s.pane, s]));
  const terminals = ctx.get("terminals");
  terminals.bridge = async () => ({ state: "ready", version: "0.6.0" });
  terminals.server = async () => ({ version: "0.6.0", protocol: 1, socket: path.join(work, "no-herdr.sock") });
  terminals.installed = async () => "0.6.0";
  terminals.clientAttached = async () => false;
  terminals.readTail = async (pane, lines = 20) => byPane.get(pane)?.screen.slice(-lines).join("\n") ?? null;
  terminals.sendInput = async () => true;
  terminals.terminal = async () => {
    throw new Error("no pane is attached in this scenario");
  };
  terminals.watch = () => () => undefined;
  terminals.watching = () => [];
  terminals.paneAlive = async (pane) => byPane.has(pane);
  terminals.panes = async () => sessions.map((s) => ({ paneId: s.pane, agent: "claude", agentSession: s.externalId, status: "working", title: null }));
  terminals.processes = async () => [];
  terminals.info = async () => null;
  // The Terminal window's cells stay empty, so the overview is all it draws.
  fs.writeFileSync(path.join(work, "code-sessions.json"), JSON.stringify({ autoPlace: false, layouts: { [project.id]: { type: "leaf", id: "c1", sessionId: null } } }));

  // ── the main window: the board, and the panel on the first session ──
  const win = new BrowserWindow({ x: 0, y: 0, width: 1600, height: 1000, show: false, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.setBackgroundThrottling(false);
  win.showInactive();
  await win.loadURL(`${process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/"}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return true;
      await sleep(200);
    }
    return false;
  };
  await until(() => $(`document.querySelectorAll('.card').length >= 450`));
  check("the board holds the project's tickets", (await $(`document.querySelectorAll('.card').length`)) >= 450, await $(`document.querySelectorAll('.card').length`));
  const dot = `[...document.querySelectorAll('.ai .sbar-dot, .ai .sbar-card')].find((n) => /Busy session 1/.test(n.getAttribute('aria-label') ?? n.textContent))`;
  await until(() => $(`!!${dot}`));
  await $(`(() => { const n = ${dot}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  await until(() => $(`document.querySelector('.ai .ai-session')?.dataset.session === ${JSON.stringify(sessions[0].id)} && document.querySelectorAll('.ai-session-convo .cs-convo-line').length > 0`));
  const panel = await $(`({ id: document.querySelector('.ai .ai-session')?.dataset.session ?? null, lines: document.querySelectorAll('.ai-session-convo .cs-convo-line').length })`);
  check("the panel shows the first session, its conversation read from its record", panel.id === sessions[0].id && panel.lines > 0, panel);

  // ── the Terminal window, on its overview ──
  await ctx.contributions.run("code-sessions.open", { projectId: project.id });
  let term;
  await until(async () => !!(term = BrowserWindow.getAllWindows().find((w) => w.getTitle().endsWith(" — Terminal"))), 10000);
  check("the Terminal window opens", !!term, BrowserWindow.getAllWindows().map((w) => w.getTitle()));
  if (!term) return;
  term.webContents.setBackgroundThrottling(false);
  term.setBounds({ x: 120, y: 80, width: 1200, height: 760 });
  const t$ = (js) => term.webContents.executeJavaScript(js, true);
  await until(() => t$(`!!document.querySelector('[data-testid=cs-view-overview]')`));
  await t$(`document.querySelector('[data-testid=cs-view-overview]')?.click(); true`);
  await until(() => t$(`document.querySelectorAll('[data-testid=cs-big]').length >= ${SESSIONS}`));
  check("its overview shows a card per session", (await t$(`document.querySelectorAll('[data-testid=cs-big]').length`)) >= SESSIONS, await t$(`document.querySelectorAll('[data-testid=cs-big]').length`));

  // ── the load: two hook events a second per session, the record and the screen growing with them ──
  // A turn of ten seconds: the prompt, nine tool calls, the stop. Prompt and stop move the session; the rest only say what it does.
  const delivered = { ok: 0, failed: 0 };
  const hook = (s) => {
    const at = s.tick++ % (EVENTS_PER_SECOND * 10);
    const base = { session_id: s.externalId, transcript_path: s.record, cwd, herdr_pane: s.pane };
    let payload;
    if (at === 0) {
      fs.appendFileSync(s.record, entry("user", `Go on with ${s.ticket.key}.`));
      s.screen.push(`> Go on with ${s.ticket.key}.`);
      payload = { ...base, hook_event_name: "UserPromptSubmit", prompt: `Go on with ${s.ticket.key}.` };
    } else if (at === EVENTS_PER_SECOND * 10 - 1) {
      const said = `Step ${s.step} is green; waiting for the next prompt.`;
      fs.appendFileSync(s.record, entry("assistant", [{ type: "text", text: said }]));
      s.screen.push(`⏺ ${said}`);
      payload = { ...base, hook_event_name: "Stop", last_assistant_message: said };
    } else if (at % 2 === 1) {
      s.step += 1;
      s.screen.push(`⏺ Bash(pnpm test packages/core/tests/case-${s.step}.test.ts)`);
      payload = { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `pnpm test packages/core/tests/case-${s.step}.test.ts` } };
    } else {
      fs.appendFileSync(s.record, toolTurn(s.step));
      s.screen.push(`  ⎿ 24 passed (${s.step})`);
      payload = { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `pnpm test packages/core/tests/case-${s.step}.test.ts` }, tool_response: { stdout: output(s.step), exitCode: 0 } };
    }
    if (s.screen.length > 200) s.screen.splice(0, s.screen.length - 200);
    ctx.codeLink.sessions.hook(project.id, s.id, payload, true).then(
      () => (delivered.ok += 1),
      () => (delivered.failed += 1)
    );
  };
  const timers = [];
  const startLoad = () =>
    sessions.forEach((s, i) =>
      setTimeout(() => {
        hook(s);
        timers.push(setInterval(() => hook(s), 1000 / EVENTS_PER_SECOND));
      }, (i * 1000) / EVENTS_PER_SECOND / SESSIONS)
    );

  await $(PROBE);
  await t$(PROBE);
  // Settled before the start's numbers are taken: what opening the windows set off has finished.
  await sleep(3000);
  const metricsOf = () => new Map(app.getAppMetrics().map((m) => [m.pid, m]));
  const memory = async () => {
    gc();
    const mainMem = process.memoryUsage();
    const metrics = metricsOf();
    const workingSet = (w) => (metrics.get(w.webContents.getOSProcessId())?.memory.workingSetSize ?? 0) * 1024;
    return { mainHeap: mainMem.heapUsed, mainRss: mainMem.rss, mainHeapJs: await $(HEAP), mainWs: workingSet(win), termHeapJs: await t$(HEAP), termWs: workingSet(term) };
  };
  const before = await memory();
  const loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  await $(START);
  await t$(START);
  ipc.on = true;
  loop.enable();
  const started = performance.now();
  startLoad();
  await sleep(SECONDS * 1000);
  for (const timer of timers) clearInterval(timer);
  loop.disable();
  ipc.on = false;
  const elapsed = (performance.now() - started) / 1000;
  const mainFrames = await $(STOP);
  const termFrames = await t$(STOP);
  await sleep(500);
  const after = await memory();
  const panelAfter = await $(`({ id: document.querySelector('.ai .ai-session')?.dataset.session ?? null, grew: /case-1\\d{3}\\.test/.test(document.querySelector('.ai-session-convo')?.textContent ?? '') })`);
  const cardsAfter = await t$(`document.querySelectorAll('[data-testid=cs-big]').length`);

  // The histogram counts the whole tick; what is past the tick is the delay.
  const delay = (ns) => Math.max(0, ns / 1e6 - LOOP_RESOLUTION_MS);
  const ids = { main: win.webContents.id, terminal: term.webContents.id };
  const ipcOf = (id) => ({
    sends: { count: sum(ipc.sends.get(id), "count"), kb: Math.round(sum(ipc.sends.get(id), "bytes") / 1024) },
    invokes: { count: sum(ipc.invokes.get(id), "count"), kb: Math.round(sum(ipc.invokes.get(id), "bytes") / 1024), replyKb: Math.round(sum(ipc.invokes.get(id), "reply") / 1024), ms: Math.round(sum(ipc.invokes.get(id), "ms")) },
    messages: { count: sum(ipc.messages.get(id), "count"), kb: Math.round(sum(ipc.messages.get(id), "bytes") / 1024) },
    topSends: top(ipc.sends.get(id)),
    topInvokes: top(ipc.invokes.get(id)),
    topMessages: top(ipc.messages.get(id))
  });
  const frames = (f) => ({ frames: f.frames, p50: ms1(f.p50), p95: ms1(f.p95), max: ms1(f.max), over50: f.over50, longTaskMs: Math.round(f.long), longTasks: f.longs });
  const report = {
    seconds: Math.round(elapsed * 10) / 10,
    hookEvents: delivered,
    loopDelayMs: { p50: ms1(delay(loop.percentile(50))), p99: ms1(delay(loop.percentile(99))), max: ms1(delay(loop.max)) },
    main: { ...frames(mainFrames), ipc: ipcOf(ids.main) },
    terminal: { ...frames(termFrames), ipc: ipcOf(ids.terminal) },
    memoryMb: {
      mainHeap: [MB(before.mainHeap), MB(after.mainHeap)],
      mainRss: [MB(before.mainRss), MB(after.mainRss)],
      mainWindowJsHeap: [MB(before.mainHeapJs), MB(after.mainHeapJs)],
      mainWindowWorkingSet: [MB(before.mainWs), MB(after.mainWs)],
      terminalJsHeap: [MB(before.termHeapJs), MB(after.termHeapJs)],
      terminalWorkingSet: [MB(before.termWs), MB(after.termWs)]
    },
    recordsMb: sessions.map((s) => MB(fs.statSync(s.record).size)),
    instrumentationMs: Math.round(ipc.cost)
  };

  const expected = Math.floor(SECONDS * EVENTS_PER_SECOND * SESSIONS * 0.9);
  check(`the hooks were heard: about ${EVENTS_PER_SECOND} a second per session, none failed`, delivered.ok >= expected && delivered.failed === 0, delivered);
  check("the panel still shows the session, with what its record gained meanwhile", panelAfter.id === sessions[0].id && panelAfter.grew, panelAfter);
  check("the overview still shows every session", cardsAfter >= SESSIONS, cardsAfter);
  check("both windows drew frames while it ran", mainFrames.frames > 0 && termFrames.frames > 0, { main: mainFrames.frames, terminal: termFrames.frames });
  const bound = Number(process.env.PERF_LOOP_P99_MS ?? 1000);
  check(`the main process's event loop p99 stays under ${bound} ms (a sanity bound, not a budget)`, report.loopDelayMs.p99 < bound, report.loopDelayMs);

  const r = report;
  const row = (label, a, b) => console.log(`  ${label.padEnd(34)}${String(a).padStart(16)}${String(b ?? "").padStart(16)}`);
  console.log(`\nmulti-session perf, ${r.seconds} s, ${r.hookEvents.ok} hook events`);
  row("main event loop delay p50/p99/max", `${r.loopDelayMs.p50}/${r.loopDelayMs.p99}/${r.loopDelayMs.max} ms`);
  row("", "main window", "Terminal");
  row("long tasks (total ms / count)", `${r.main.longTaskMs} / ${r.main.longTasks}`, `${r.terminal.longTaskMs} / ${r.terminal.longTasks}`);
  row("frame time p50 / p95 / max (ms)", `${r.main.p50}/${r.main.p95}/${r.main.max}`, `${r.terminal.p50}/${r.terminal.p95}/${r.terminal.max}`);
  row("frames over 50 ms", r.main.over50, r.terminal.over50);
  row("main → renderer sends (n / KB)", `${r.main.ipc.sends.count} / ${r.main.ipc.sends.kb}`, `${r.terminal.ipc.sends.count} / ${r.terminal.ipc.sends.kb}`);
  row("renderer → main invokes (n / KB)", `${r.main.ipc.invokes.count} / ${r.main.ipc.invokes.kb}`, `${r.terminal.ipc.invokes.count} / ${r.terminal.ipc.invokes.kb}`);
  row("  their replies (KB)", r.main.ipc.invokes.replyKb, r.terminal.ipc.invokes.replyKb);
  row("renderer → main messages (n / KB)", `${r.main.ipc.messages.count} / ${r.main.ipc.messages.kb}`, `${r.terminal.ipc.messages.count} / ${r.terminal.ipc.messages.kb}`);
  row("JS heap start → end (MB)", `${r.memoryMb.mainWindowJsHeap[0]} → ${r.memoryMb.mainWindowJsHeap[1]}`, `${r.memoryMb.terminalJsHeap[0]} → ${r.memoryMb.terminalJsHeap[1]}`);
  row("working set start → end (MB)", `${r.memoryMb.mainWindowWorkingSet[0]} → ${r.memoryMb.mainWindowWorkingSet[1]}`, `${r.memoryMb.terminalWorkingSet[0]} → ${r.memoryMb.terminalWorkingSet[1]}`);
  row("main process: heap | rss (MB)", `${r.memoryMb.mainHeap[0]} → ${r.memoryMb.mainHeap[1]}`, `${r.memoryMb.mainRss[0]} → ${r.memoryMb.mainRss[1]}`);
  console.log(`  busiest: main sends ${r.main.ipc.topSends.join(", ")}; invokes ${r.main.ipc.topInvokes.join(", ")}`);
  console.log(`           Terminal sends ${r.terminal.ipc.topSends.join(", ")}; messages ${r.terminal.ipc.topMessages.join(", ")}`);
  console.log(`  (counting IPC took ${r.instrumentationMs} ms of the main thread)`);
  console.log(`PERF_SESSIONS_JSON ${JSON.stringify(report)}`);
  if (process.env.PERF_JSON) fs.writeFileSync(process.env.PERF_JSON, JSON.stringify(report, null, 2));
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
