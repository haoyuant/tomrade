/**
 * A slow Start shows what it is doing: spinner, the current step, and past ~10 s the "not stuck" note.
 * Run after build:backend with the UI dev server running.
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-start-progress-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (name, value) => { if (!value) throw new Error(name); console.log(`PASS: ${name}`); };
let ctx;
let win;
app.whenReady().then(async () => {
  try {
    ({ ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]] }));
    ctx.hub.configure(path.join(work, "hub"));
    const project = ctx.projects.create({ name: "Start progress", keyPrefix: "SPR" });
    const board = ctx.boards.list(project.id)[0];
    const item = ctx.items.create({ projectId: project.id, boardId: board.id, title: "Slow start", workType: "coding", status: "todo", by: "human" });
    ctx.agent.engine({ id: "ready", title: "Ready", author: "ai:ready", capabilities: ["code"], available: async () => ({ ok: true }), async turn() { return { stop: "end" }; } });
    ctx.settings.set({ ...ctx.settings.get(), language: "zh", onboarding: { seen: ["*"] }, agent: { ...ctx.settings.get().agent, defaultEngine: "ready" } });
    // A first worktree on a large repository: the start answers only after the test says so.
    let finish;
    ctx.codeLink.terminalWindow = async () => false;
    ctx.codeLink.start = (projectId, itemId, opts) =>
      new Promise((resolve) => { finish = () => resolve({ ok: true, continued: false, threadId: null, sessionId: "s-slow", branch: "spr-1/slow-start", worktree: null, cwd: work, mode: opts.mode, command: "claude", launched: false, pane: null, engine: "ready" }); });

    win = new BrowserWindow({ width: 1200, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { backgroundThrottling: false, preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
    await win.loadURL(process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/");
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const wait = async (check) => { for (let i = 0; i < 200; i++) { if (await check()) return; await sleep(100); } throw new Error("界面等待超时"); };
    await js(`location.hash = '#/p/${project.id}/i/${item.id}'; true`);
    await wait(() => js(`!!document.querySelector('[data-testid="start-ticket"]')`));
    await js(`document.querySelector('[data-testid="start-ticket"]').click(); true`);
    await wait(() => js(`!![...document.querySelectorAll('#stEngine option')].find(o => o.value === 'ready')`));
    await js(`(() => { const select = document.querySelector('#stEngine'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'ready'); select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await wait(() => js(`!document.querySelector('[data-testid="start-confirm"]').disabled`));
    assert("开始前没有进度", await js(`!document.querySelector('[data-testid="start-progress"]')`));
    await js(`document.querySelector('[data-testid="start-confirm"]').click(); true`);

    await wait(() => js(`!!document.querySelector('[data-testid="start-progress"]')`));
    assert("等待时显示转动的加载图标", await js(`!!document.querySelector('[data-testid="start-progress"] .is-spinning') && !!document.querySelector('[data-testid="start-confirm"] .is-spinning')`));
    const step = () => js(`document.querySelector('[data-testid="start-progress-step"]')?.textContent ?? ''`);
    assert("第一步说明在准备工作副本", (await step()).includes("准备工作副本"));
    assert("进度区是 status 区域，屏幕阅读器会读出", await js(`document.querySelector('[data-testid="start-progress"]').getAttribute('role') === 'status'`));
    assert("对话框内容仍在，选项不可改", await js(`!!document.querySelector('[data-testid="start-mode"]') && document.querySelector('#stEngine').disabled`));
    await wait(async () => (await step()).includes("检出工单分支"));
    assert("几秒后换到检出分支", true);
    assert("10 秒前不显示“没有卡住”", await js(`!document.querySelector('[data-testid="start-progress-slow"]')`));
    await wait(async () => (await step()).includes("打开终端") || (await step()).includes("启动智能体"));
    await wait(() => js(`!!document.querySelector('[data-testid="start-progress-slow"]')`));
    assert("超过 10 秒说明程序没有卡住", (await js(`document.querySelector('[data-testid="start-progress-slow"]').textContent`)).includes("没有卡住"));
    fs.writeFileSync(path.join(work, "start-progress.png"), (await win.webContents.capturePage()).toPNG());

    finish();
    await wait(() => js(`!document.querySelector('[data-testid="start-dialog"]')`));
    assert("启动完成后对话框关闭", true);

    // ── 一点就开始：用上次的 agent 和地方，不用再选、不用再点确认 ──
    ctx.codeLink.startDefaults = () => ({ mode: "run", engine: "ready" });
    let quick = null;
    ctx.codeLink.start = async (_projectId, _itemId, opts) => {
      quick = opts;
      return { ok: true, continued: false, threadId: null, sessionId: "s-quick", branch: "spr-1/slow-start", worktree: null, cwd: work, mode: opts.mode, command: "claude", launched: false, pane: null, engine: "ready" };
    };
    await js(`location.reload(); true`);
    await sleep(500);
    await js(`location.hash = '#/p/${project.id}/i/${item.id}'; true`);
    await wait(() => js(`(document.querySelector('[data-testid="start-quick"]')?.textContent ?? '').includes('Ready')`));
    assert("记得上次怎么开始时，主按钮写着用哪个 agent", (await js(`document.querySelector('[data-testid="start-quick"]').textContent`)).includes("开始 · Ready"));
    assert("旁边的按钮仍打开完整的对话框", await js(`!!document.querySelector('[data-testid="start-ticket"][aria-label]')`));
    await js(`document.querySelector('[data-testid="start-quick"]').click(); true`);
    await wait(async () => quick !== null && (await js(`!document.querySelector('[data-testid="start-dialog"]')`)));
    assert("一点就开始，用上次的 agent 和地方", quick.engine === "ready" && quick.mode === "run");

    // ── 工单已有会话在做：先问去看它、跟它说一句、还是另开一个 ──
    const shown = [];
    ctx.codeLink.showSession = async (_projectId, sessionId) => (shown.push(sessionId), true);
    const realDeliveries = ctx.codeLink.deliveries.bind(ctx.codeLink);
    ctx.codeLink.deliveries = (projectId, itemId) => [{ id: "d1", projectId, itemId, sequence: 1, state: "active", startedAt: Date.now(), completedAt: null, updatedAt: Date.now(), bases: {} }];
    ctx.codeLink.sessionsOf = (projectId) => [{ id: "s-live", projectId, repoId: "r", delivery: 1, branch: "spr-1/slow-start", itemIds: [item.id], worked: [], mode: "terminal", agent: "ready", externalId: null, threadId: null, worktree: null, herdrPane: "w1:p1", terminal: null, title: null, cwd: null, transcript: null, prompted: true, withoutTicket: null, recordSavedAt: null, recordCut: false, state: "running", lastEventAt: Date.now(), lastToolAt: null, lastCommitAt: null, summary: null, activity: "Bash · pnpm test", blocked: null, requestedBy: null, autoMerge: false, device: "here", startedAt: Date.now(), endedAt: null }];
    await js(`location.reload(); true`);
    await sleep(500);
    await js(`location.hash = '#/p/${project.id}/i/${item.id}'; true`);
    await wait(() => js(`(document.querySelector('[data-testid="start-quick"]')?.textContent ?? '').includes('继续')`));
    await js(`(() => { const b = document.querySelector('[data-testid="start-quick"]'); for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) b.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0 })); return true; })()`);
    await wait(() => js(`!!document.querySelector('.menu.is-floating')`));
    const menu = await js(`document.querySelector('.menu.is-floating').textContent`);
    assert("会话还在做时，开始先问：去看它 / 另开一个，并说它在做什么", menu.includes("Ready 已经在做这张了") && menu.includes("去看它") && menu.includes("另开一个") && menu.includes("Bash · pnpm test"));
    await js(`[...document.querySelectorAll('.menu.is-floating .menu-row')].find((r) => r.textContent.includes('去看它')).click(); true`);
    await wait(async () => shown.length > 0);
    assert("去看它：在终端窗口里打开那个会话", shown[0] === "s-live");
    ctx.codeLink.deliveries = realDeliveries;
    console.log(`界面截图：${work}`);
    win.destroy();
    await ctx.fiber.dispose();
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (win) console.error(await win.webContents.executeJavaScript("document.body.innerText"));
    console.error(`测试目录：${work}`);
    app.exit(1);
  }
});
