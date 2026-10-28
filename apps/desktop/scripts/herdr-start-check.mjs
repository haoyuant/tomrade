/** Isolated renderer + IPC regression. Run after build:backend with the UI dev server running. */
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-herdr-ui-"));
app.setPath("userData", work);
// Inside a herdr pane HERDR_SOCKET_PATH names the person's server and wins over HERDR_SESSION: this run reaches only a session of its own.
for (const key of ["HERDR_SOCKET_PATH", "HERDR_CLIENT_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_ENV"]) delete process.env[key];
const HERDR_SESSION = `tomrade-hs-check-${process.pid}`;
process.env.HERDR_SESSION = HERDR_SESSION;
const ownSession = path.join(os.homedir(), ".config/herdr/sessions", HERDR_SESSION);
/** Nothing here should start herdr; should something have, stop only this run's server. */
const leaveHerdr = () => {
  if (!fs.existsSync(ownSession)) return;
  try {
    const socket = execFileSync("herdr", ["status"], { encoding: "utf8" }).match(/socket:\s*(\S+)/)?.[1];
    if (socket === path.join(ownSession, "herdr.sock")) execFileSync("herdr", ["server", "stop"]);
  } catch {
    // not running
  }
  fs.rmSync(ownSession, { recursive: true, force: true });
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (name, value) => { if (!value) throw new Error(name); console.log(`PASS: ${name}`); };
// Screenshots are for a person to look at: a shown window that is covered or asleep may give none, which fails nothing.
const shot = async (name) => {
  try {
    fs.writeFileSync(path.join(work, name), (await win.webContents.capturePage()).toPNG());
  } catch (error) {
    console.log(`截图 ${name} 没拍成：${error.message}`);
  }
};
let ctx;
let win;
app.whenReady().then(async () => {
  try {
    ({ ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]] }));
    ctx.hub.configure(path.join(work, "hub"));
    const project = ctx.projects.create({ name: "Herdr regression", keyPrefix: "HDR" });
    const board = ctx.boards.list(project.id)[0];
    const item = ctx.items.create({ projectId: project.id, boardId: board.id, title: "Herdr readiness", workType: "coding", status: "todo", by: "human" });
    ctx.agent.engine({ id: "ready", title: "Ready", author: "ai:ready", capabilities: ["code"], available: async () => ({ ok: true }), async turn() { return { stop: "end" }; } });
    ctx.settings.set({ ...ctx.settings.get(), language: "zh", onboarding: { seen: ["*"] }, agent: { ...ctx.settings.get().agent, defaultEngine: "ready" } });
    assert("默认终端是自动", ctx.settings.get().codeLink.terminal === "auto");
    for (const locale of ["en", "zh", "fr"]) {
      const field = ctx.settings.sections(locale).find(s => s.id === "codeLink").schema.properties.terminal;
      assert(`${locale} 终端选项以自动开头并有说明`, field.enum[0] === "auto" && !!field.enumLabels?.auto);
      const help = field.description;
      // How to get herdr is the install button atop the section while it is missing; the field says what an app of your own costs.
      assert(`${locale} 设置说明讲清用自己的终端 app 的代价，不再教手动装 herdr`, help.includes(locale === "zh" ? "没有它的格子" : "no Terminal window cell") && !help.includes("brew") && !help.includes("`herdr`"));
      assert(`${locale} 设置说明不含错误插件命令`, !help.includes("plugin install"));
    }
    let state = "notInstalled";
    ctx.codeLink.herdrStatus = async () => state;
    win = new BrowserWindow({ width: 1200, height: 900, show: true, webPreferences: { backgroundThrottling: false, preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
    await win.loadURL(process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/");
    const js = code => win.webContents.executeJavaScript(code, true);
    const wait = async check => { for (let i = 0; i < 200; i++) { if (await check()) return; await sleep(100); } throw new Error("界面等待超时"); };
    await js(`location.hash = '#/p/${project.id}/i/${item.id}'; true`);
    await wait(() => js(`!!document.querySelector('[data-testid="start-ticket"]')`));
    await js(`document.querySelector('[data-testid="start-ticket"]').click(); true`);
    await wait(() => js(`!!document.querySelector('[data-testid="start-mode"]')`));
    await js(`document.querySelectorAll('[data-testid="start-mode"] button')[1].click(); true`);
    const line = () => js(`document.querySelector('[data-testid="start-herdr-status"]')?.textContent ?? ''`);
    await wait(async () => (await line()).includes("未安装"));
    assert("未安装时显示安装和启动指引", (await line()).includes("安装文档") && (await line()).includes("打开一个终端"));
    await wait(() => js(`!![...document.querySelectorAll('#stEngine option')].find(o => o.value === 'ready')`));
    await js(`const select = document.querySelector('#stEngine'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'ready'); select.dispatchEvent(new Event('change', { bubbles: true })); true`);
    await wait(() => js(`!document.querySelector('[data-testid="start-confirm"]').disabled`));
    assert("未安装 herdr 不阻断开始", await js(`!document.querySelector('[data-testid="start-confirm"]').disabled`));
    await shot("herdr-missing.png");
    state = "notRunning";
    await wait(async () => (await line()).includes("已安装未运行"));
    state = "running";
    await wait(async () => (await line()).includes("运行中"));
    assert("运行中不再显示安装指引", !(await line()).includes("brew install"));
    await js(`document.querySelectorAll('[data-testid="start-mode"] button')[0].click(); true`);
    await wait(() => js(`!document.querySelector('[data-testid="start-herdr-status"]')`));

    // herdr recommended in Settings' terminal picker: the guide without Homebrew, the install button with it.
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    state = "notInstalled";
    let installs = 0;
    let plan = { command: null, guide: "https://herdr.dev/docs/install/" };
    ctx.codeLink.herdrInstall = async () => plan;
    ctx.codeLink.installHerdr = async () => { installs++; return { launched: true, command: plan.command }; };
    const openCodeLink = async () => {
      await wait(() => js(`!!document.querySelector('button[aria-label="设置"]')`));
      await js(`document.querySelector('button[aria-label="设置"]').click(); true`);
      await wait(() => js(`!![...document.querySelectorAll('.side-row')].find(r => r.textContent.includes('代码关联'))`));
      await js(`[...document.querySelectorAll('.side-row')].find(r => r.textContent.includes('代码关联')).click(); true`);
      await wait(() => js(`!!document.querySelector('[data-testid="herdr-recommendation"]')`));
    };
    await openCodeLink();
    const recommendation = () => js(`document.querySelector('[data-testid="herdr-recommendation"]').textContent`);
    assert("没装 herdr 时，代码关联顶上推荐 herdr 并说明好处", (await recommendation()).includes("推荐") && (await recommendation()).includes("Tomrade 退出后"));
    // the terminal is no longer picked up top: an app of your own waits under Advanced, herdr and the built-in terminal are what automatic means
    assert("代码关联顶上不再有终端下拉", await js(`!document.querySelector('#sf-codeLink-terminal')`));
    await js(`document.querySelector('[data-fold="codeLink-advanced"] .fold-head').click(); true`);
    await wait(() => js(`!!document.querySelector('#sf-codeLink-terminal')`));
    const ownApp = await js(`(() => { const s = document.querySelector('#sf-codeLink-terminal'); return { label: s.closest('.panel')?.textContent ?? '', options: [...s.querySelectorAll('option')].map(o => [o.value, o.textContent]) }; })()`);
    assert("高级里是「在自己的终端 app 里开」，默认「不用：Tomrade 自己的终端（自动）」，没有 herdr 这一项", ownApp.label.includes("在自己的终端 app 里开") && JSON.stringify(ownApp.options[0]) === JSON.stringify(["auto", "不用：Tomrade 自己的终端（自动）"]) && !ownApp.options.some(([v]) => v === "herdr" || v === "builtin") && ownApp.options.at(-1)?.[0] === "none", JSON.stringify(ownApp));
    await wait(() => js(`!!document.querySelector('[data-testid="herdr-install-guide"]')`));
    assert("没有 Homebrew 时只给安装指南", await js(`!document.querySelector('[data-testid="herdr-install"]')`));
    win.webContents.reload();
    plan = { command: "brew install herdr", guide: plan.guide };
    await wait(() => js(`!!document.querySelector('[data-testid="start-ticket"]')`));
    await openCodeLink();
    await wait(() => js(`!!document.querySelector('[data-testid="herdr-install"]')`));
    await shot("herdr-settings.png");
    assert("打开设置不会安装", installs === 0);
    await js(`document.querySelector('[data-testid="herdr-install"]').click(); true`);
    await wait(async () => installs === 1);
    assert("点击后才安装", installs === 1);
    state = "running";
    await wait(() => js(`!document.querySelector('[data-testid="herdr-install"]')`));
    assert("装好后代码关联顶上的推荐和安装按钮一起消失", await js(`!document.querySelector('[data-testid="herdr-recommendation"]')`));

    // After a launch in a plain terminal: one hint with the same pitch and the install, then never again.
    state = "notInstalled";
    ctx.settings.set({ ...ctx.settings.get(), onboarding: { seen: ["hint.start", "hint.graph", "hint.revert", "hint.workstreams", "sample-tile", "setup-screen", "setup-required"] } });
    ctx.codeLink.start = async (projectId, itemId, opts) => ({ ok: true, continued: false, threadId: "t-herdr", sessionId: "s-herdr", branch: "hdr-1/herdr-readiness", worktree: null, cwd: work, mode: opts.mode, command: "claude", launched: true, pane: null, engine: "ready" });
    win.webContents.reload();
    const hint = () => js(`[...document.querySelectorAll('.toast')].filter(t => t.textContent.includes('普通终端')).length`);
    const startInTerminal = async () => {
      await wait(() => js(`!!document.querySelector('[data-testid="start-ticket"]')`));
      await js(`document.querySelector('[data-testid="start-ticket"]').click(); true`);
      await wait(() => js(`!!document.querySelector('[data-testid="start-mode"]')`));
      await js(`document.querySelectorAll('[data-testid="start-mode"] button')[1].click(); true`);
      await wait(async () => (await line()).includes("未安装"));
      await wait(() => js(`!![...document.querySelectorAll('#stEngine option')].find(o => o.value === 'ready')`));
      await js(`(() => { const select = document.querySelector('#stEngine'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'ready'); select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      await wait(() => js(`!document.querySelector('[data-testid="start-confirm"]').disabled`));
      await js(`document.querySelector('[data-testid="start-confirm"]').click(); true`);
      await wait(() => js(`!document.querySelector('[data-testid="start-mode"]')`));
    };
    await startInTerminal();
    await wait(async () => (await hint()) === 1);
    await shot("herdr-hint.png");
    assert("普通终端启动后提示 herdr 的好处", await js(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('普通终端') && t.textContent.includes('Tomrade 退出后'))`));
    assert("提示出现时没有安装任何东西", installs === 1);
    await wait(async () => ctx.settings.get().onboarding.seen.includes("hint.herdr"));
    assert("提示按用户记作已看过", ctx.settings.get().onboarding.seen.includes("hint.herdr"));
    await js(`[...document.querySelectorAll('.toast.is-sticky button')].find(b => b.textContent === '安装 herdr').click(); true`);
    await wait(async () => installs === 2);
    assert("点击提示里的安装才安装，提示随之收起", (await hint()) === 0);
    await startInTerminal();
    await sleep(1500);
    assert("关掉后不再出现", (await hint()) === 0);

    // With Tomrade's Terminal window showing herdr's sessions: Start offers it first, and the start opens there.
    const shownSessions = [];
    ctx.codeLink.terminalWindow = async () => true;
    ctx.codeLink.showSession = async (projectId, sessionId) => (shownSessions.push(sessionId), true);
    ctx.codeLink.start = async (projectId, itemId, opts) => ({ ok: true, continued: false, threadId: "t-window", sessionId: "s-window", branch: "hdr-1/herdr-readiness", worktree: null, cwd: work, mode: opts.mode, command: "claude", launched: true, pane: "w1:p1", engine: "ready" });
    state = "running";
    win.webContents.reload();
    await wait(() => js(`!!document.querySelector('[data-testid="start-ticket"]')`));
    await js(`document.querySelector('[data-testid="start-ticket"]').click(); true`);
    await wait(() => js(`!!document.querySelector('[data-testid="start-mode"][data-terminal-window]')`));
    const pressed = () => js(`document.querySelector('[data-testid="start-mode"] [aria-pressed="true"]')?.dataset.mode`);
    assert("终端窗口可用时，默认在 Tomrade 终端里跑", (await pressed()) === "terminal");
    assert("两个选项说清楚去处", await js(`(() => { const b = [...document.querySelectorAll('[data-testid="start-mode"] button')].map(x => x.textContent.trim()); return b.includes('在助手面板里跑') && b.includes('在 Tomrade 终端里跑'); })()`));
    // 设置 › 会话默认「后台窗格」：不勾「也打开终端窗口」时在面板里看
    assert("默认不勾「也打开终端窗口」，说明写着在后台窗格里跑", await js(`!document.querySelector('[data-testid="start-also-window"]').checked && [...document.querySelectorAll('.meta-txt')].some(p => p.textContent.includes('后台窗格'))`));
    await js(`document.querySelector('[data-testid="start-also-window"]').click(); true`);
    await wait(() => js(`document.querySelector('[data-testid="start-also-window"]').checked`));
    assert("勾上后说明里写着在终端窗口里打开", await js(`[...document.querySelectorAll('.meta-txt')].some(p => p.textContent.includes('Tomrade 的终端窗口'))`));
    await shot("start-terminal-window.png");
    await wait(() => js(`!![...document.querySelectorAll('#stEngine option')].find(o => o.value === 'ready')`));
    await wait(() => js(`!document.querySelector('[data-testid="start-confirm"]').disabled`));
    await js(`document.querySelector('[data-testid="start-confirm"]').click(); true`);
    await wait(async () => shownSessions.length === 1);
    assert("开始后在终端窗口里显示这个会话", shownSessions[0] === "s-window");
    await wait(() => js(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('已在终端窗口里'))`));
    assert("提示说会话在终端窗口里", true);
    console.log(`界面截图：${work}`);
    win.destroy();
    await ctx.fiber.dispose();
    leaveHerdr();
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (win) console.error(await win.webContents.executeJavaScript("document.body.innerText"));
    console.error(`测试目录：${work}`);
    leaveHerdr();
    app.exit(1);
  }
});
