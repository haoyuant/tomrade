/**
 * Idle frames (TOM-1023): how many frames the windows draw, and what that costs, when nothing on screen should change.
 * A project of 60 tickets, the main window at 3008×1550 on the board with its panel, the Terminal window on its overview.
 * IDLE_SCENARIO picks what the sessions do: "quiet" (none running), "running" (one running, silent), "busy" (one
 * running, two hook events a second). IDLE_THEME picks the theme (default "light", which has no decorative motion).
 * For IDLE_SECONDS (20) it records each process's CPU, the compositor frames drawn, and the animations each window
 * keeps running, then prints a report. Numbers only: it fails when the scenario could not be set up.
 *
 *   pnpm build:backend && pnpm --filter @tomradex/ui build, serve packages/ui (vite preview) then
 *   TOMRADE_DEV_URL=http://127.0.0.1:<port>/ IDLE_SCENARIO=busy electron scripts/idle-frames-check.mjs
 */
import { app, BrowserWindow, contentTracing } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-idle-frames-"));
for (const key of ["HERDR_SOCKET_PATH", "HERDR_CLIENT_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_ENV"]) delete process.env[key];
process.env.HERDR_SESSION = `tomrade-idle-frames-${process.pid}`;
app.setPath("userData", work);
app.on("window-all-closed", () => {});

const SECONDS = Number(process.env.IDLE_SECONDS ?? 20);
const SCENARIO = process.env.IDLE_SCENARIO ?? "quiet";
const THEME = process.env.IDLE_THEME ?? "light";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const entry = (type, content) => JSON.stringify({ type, uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: type === "user" ? "user" : "assistant", content } }) + "\n";

// What each window keeps animating, named by the element it runs on.
const ANIMATIONS = `(() => {
  const name = (n) => !n ? '?' : (n.tagName?.toLowerCase() ?? '?') + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\\s+/).slice(0, 3).join('.') : '');
  const rows = new Map();
  for (const a of document.getAnimations()) {
    if (a.playState !== 'running') continue;
    const t = a.effect?.target, pseudo = a.effect?.pseudoElement ?? '';
    const key = (a.animationName ?? a.constructor.name) + ' on ' + name(t) + pseudo + (t?.isConnected && t.getClientRects().length === 0 ? ' (not rendered)' : '');
    rows.set(key, (rows.get(key) ?? 0) + 1);
  }
  return [...rows.entries()].map(([k, n]) => n > 1 ? k + ' ×' + n : k);
})()`;
// Frames the renderer's main thread produced, and rAF callers left running.
const PROBE = `(() => {
  const s = (window.__idle = { on: false, raf: 0 });
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => { if (s.on) s.raf += 1; cb(t); });
  return true;
})()`;

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
  const project = ctx.projects.create({ name: "Idle", keyPrefix: "ID" });
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", theme: THEME, onboarding: { seen: ["*"] }, codeLink: { ...settings.codeLink, terminal: "herdr" } });
  const boardId = ctx.boards.list(project.id)[0].id;
  const STATUSES = ["backlog", "todo", "doing", "verifying", "done"];
  const tickets = [];
  for (let i = 0; i < 60; i++) tickets.push(ctx.items.create({ projectId: project.id, boardId, title: i === 0 ? "The session's ticket" : `Ticket number ${i}`, status: i === 0 ? "doing" : STATUSES[i % 5], priority: i % 4, workType: "coding", by: "human" }));

  // ── one session in a stand-in herdr pane; running or not as the scenario says ──
  const cwd = fs.mkdtempSync(path.join(work, "repo-"));
  const externalId = randomUUID();
  const record = path.join(work, `${externalId}.jsonl`);
  fs.writeFileSync(record, entry("user", `Work on ${tickets[0].key}.`) + entry("assistant", [{ type: "text", text: "On it." }]));
  const pane = "w1:p1";
  const live = SCENARIO !== "quiet";
  const session = ctx.codeLink.store.createSession(project.id, { repoId: "idle", branch: `${tickets[0].key.toLowerCase()}/idle`, itemIds: [tickets[0].id], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: cwd });
  ctx.codeLink.store.patchSession(project.id, session.id, { herdrPane: pane, externalId, transcript: record, cwd, state: live ? "running" : "idle", prompted: true, lastEventAt: Date.now() });
  const screen = ["❯ claude", `⏺ Working on ${tickets[0].key}`];
  const terminals = ctx.get("terminals");
  terminals.bridge = async () => ({ state: "ready", version: "0.6.0" });
  terminals.server = async () => ({ version: "0.6.0", protocol: 1, socket: path.join(work, "no-herdr.sock") });
  terminals.installed = async () => "0.6.0";
  terminals.clientAttached = async () => false;
  terminals.readTail = async (p, lines = 20) => (p === pane ? screen.slice(-lines).join("\n") : null);
  terminals.sendInput = async () => true;
  terminals.terminal = async () => {
    throw new Error("no pane is attached in this scenario");
  };
  terminals.watch = () => () => undefined;
  terminals.watching = () => [];
  terminals.paneAlive = async (p) => p === pane;
  terminals.panes = async () => [{ paneId: pane, agent: "claude", agentSession: externalId, status: live ? "working" : "idle", title: null }];
  terminals.processes = async () => [];
  terminals.info = async () => null;
  fs.writeFileSync(path.join(work, "code-sessions.json"), JSON.stringify({ autoPlace: false, layouts: { [project.id]: { type: "leaf", id: "c1", sessionId: null } } }));

  // ── the main window: the board, and the panel on the session ──
  const win = new BrowserWindow({ x: 0, y: 0, width: 3008, height: 1550, show: false, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
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
  await until(() => $(`document.querySelectorAll('.card').length >= 50`));
  check("the board holds the project's tickets", (await $(`document.querySelectorAll('.card').length`)) >= 50, await $(`document.querySelectorAll('.card').length`));
  const dot = `[...document.querySelectorAll('.ai .sbar-dot, .ai .sbar-card')].find((n) => /session's ticket/.test(n.getAttribute('aria-label') ?? n.textContent))`;
  await until(() => $(`!!${dot}`));
  await $(`(() => { const n = ${dot}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  check("the panel shows the session", await until(() => $(`document.querySelector('.ai .ai-session')?.dataset.session === ${JSON.stringify(session.id)}`)));
  check(`the theme is ${THEME}`, await until(() => $(`document.documentElement.dataset.themeId === ${JSON.stringify(THEME)}`)), await $(`document.documentElement.dataset.themeId`));

  // ── the Terminal window, on its overview ──
  await ctx.contributions.run("code-sessions.open", { projectId: project.id });
  let term;
  await until(async () => !!(term = BrowserWindow.getAllWindows().find((w) => w.getTitle().endsWith(" — Terminal"))), 10000);
  check("the Terminal window opens", !!term, BrowserWindow.getAllWindows().map((w) => w.getTitle()));
  if (!term) return;
  term.webContents.setBackgroundThrottling(false);
  term.setBounds({ x: 200, y: 120, width: 1600, height: 1000 });
  const t$ = (js) => term.webContents.executeJavaScript(js, true);
  await until(() => t$(`!!document.querySelector('[data-testid=cs-view-overview]')`));
  await t$(`document.querySelector('[data-testid=cs-view-overview]')?.click(); true`);
  check("its overview shows the session", await until(() => t$(`document.querySelectorAll('[data-testid=cs-big]').length >= 1`)));

  // ── the load, in "busy": two hook events a second, the record and the screen growing with them ──
  let tick = 0, step = 1;
  const delivered = { ok: 0, failed: 0 };
  const hook = () => {
    const at = tick++ % 20;
    const base = { session_id: externalId, transcript_path: record, cwd, herdr_pane: pane };
    let payload;
    if (at === 0) payload = { ...base, hook_event_name: "UserPromptSubmit", prompt: `Go on with ${tickets[0].key}.` };
    else if (at % 2 === 1) {
      step += 1;
      screen.push(`⏺ Bash(pnpm test case-${step})`);
      payload = { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `pnpm test case-${step}` } };
    } else {
      fs.appendFileSync(record, entry("assistant", [{ type: "text", text: `Step ${step} passed.` }]));
      screen.push(`  ⎿ passed (${step})`);
      payload = { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `pnpm test case-${step}` }, tool_response: { stdout: "ok", exitCode: 0 } };
    }
    ctx.codeLink.sessions.hook(project.id, session.id, payload, true).then(() => (delivered.ok += 1), () => (delivered.failed += 1));
  };

  // IDLE_CSS: a stylesheet laid over both windows, to try a change without building it.
  if (process.env.IDLE_CSS) {
    await win.webContents.insertCSS(process.env.IDLE_CSS);
    await term.webContents.insertCSS(process.env.IDLE_CSS);
  }
  // IDLE_JS: a script run in both windows, likewise.
  if (process.env.IDLE_JS) {
    await $(process.env.IDLE_JS);
    await t$(process.env.IDLE_JS);
  }
  await $(PROBE);
  await t$(PROBE);
  await sleep(4000); // what opening the windows set off has settled
  const pids = { main: process.pid, gpu: null, mainWindow: win.webContents.getOSProcessId(), terminal: term.webContents.getOSProcessId() };
  const cpuOf = () => new Map(app.getAppMetrics().map((m) => [m.pid, { type: m.type, cpu: m.cpu.cumulativeCPUUsage ?? 0, ws: m.memory.workingSetSize }]));
  const before = cpuOf();
  pids.gpu = [...before.entries()].find(([, m]) => m.type === "GPU")?.[0] ?? null;
  await contentTracing.startRecording({ included_categories: ["viz", "cc", "gpu", "benchmark"], excluded_categories: ["*"] });
  await $(`window.__idle.on = true`);
  await t$(`window.__idle.on = true`);
  const timer = SCENARIO === "busy" ? setInterval(hook, 500) : null;
  const started = Date.now();
  await sleep(SECONDS * 1000);
  if (timer) clearInterval(timer);
  const elapsed = (Date.now() - started) / 1000;
  const after = cpuOf();
  const traceFile = await contentTracing.stopRecording();
  const raf = { mainWindow: await $(`window.__idle.raf`), terminal: await t$(`window.__idle.raf`) };
  const animations = { mainWindow: await $(ANIMATIONS), terminal: await t$(ANIMATIONS) };

  // Frames per process, by the trace's own names: what the renderer's compositor drew, what viz put on screen.
  const trace = JSON.parse(fs.readFileSync(traceFile, "utf8"));
  const events = (trace.traceEvents ?? trace).filter((e) => e.ph === "X" || e.ph === "B" || e.ph === "I" || e.ph === "i" || e.ph === "n");
  const counts = new Map();
  for (const e of events) {
    const key = `${e.pid}|${e.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const roleOf = (pid) => Object.entries(pids).find(([, p]) => p === pid)?.[0] ?? `pid ${pid}`;
  const frameNames = ["LayerTreeHostImpl::PrepareToDraw", "ProxyMain::BeginMainFrame", "Display::DrawAndSwap", "Graphics.Pipeline.DrawAndSwap", "PaintLayerContents", "Paint", "DisplayScheduler::DrawAndSwap"];
  const frames = {};
  for (const [key, n] of counts) {
    const [pid, name] = key.split("|");
    if (!frameNames.includes(name)) continue;
    (frames[roleOf(Number(pid))] ??= {})[name] = Math.round((n / elapsed) * 10) / 10;
  }
  const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => { const [pid, name] = k.split("|"); return `${roleOf(Number(pid))}: ${name} ${Math.round(n / elapsed)}/s`; });
  const cpuPct = {};
  for (const [role, pid] of Object.entries(pids)) {
    const a = before.get(pid), b = after.get(pid);
    cpuPct[role] = a && b ? Math.round(((b.cpu - a.cpu) / elapsed) * 1000) / 10 : null;
    if (role !== "main" && b) cpuPct[`${role}WsMb`] = Math.round(b.ws / 1024);
  }
  const report = { scenario: SCENARIO, theme: THEME, seconds: Math.round(elapsed * 10) / 10, hookEvents: delivered, cpuPercentOfOneCore: cpuPct, framesPerSecond: frames, rafPerSecond: { mainWindow: Math.round(raf.mainWindow / elapsed), terminal: Math.round(raf.terminal / elapsed) }, animations, busiestTraceEvents: busiest };
  if (SCENARIO === "busy") check("the hooks were heard", delivered.ok >= SECONDS * 2 * 0.9 && delivered.failed === 0, delivered);
  console.log(`\nidle frames, ${SCENARIO}, theme ${THEME}, ${report.seconds} s`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`IDLE_FRAMES_JSON ${JSON.stringify(report)}`);
  if (process.env.IDLE_JSON) fs.writeFileSync(process.env.IDLE_JSON, JSON.stringify(report, null, 2));
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
