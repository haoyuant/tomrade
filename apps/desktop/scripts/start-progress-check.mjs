/**
 * A slow Start shows what it is doing: spinner, the current step, and past ~10 s the "not stuck" note —
 * in the Start dialog and, ticket by ticket, on a conversation's start card.
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

    // ── 一点就开始（TOM-690）：用上次的 agent 和地方，不弹对话框；后台窗格里跑，面板选中它；▾ 是开始方式的菜单 ──
    ctx.codeLink.startDefaults = () => ({ mode: "run", engine: "ready" });
    ctx.codeLink.terminalWindow = async () => true;
    ctx.agent.engine({ id: "second", title: "Second", author: "ai:second", capabilities: ["code"], available: async () => ({ ok: true }), async turn() { return { stop: "end" }; } });
    // 只有这里的 agent（这台机器装的不算）；内置助手能写代码时才列出来，这里没有模型，当它能
    const engineViews = ctx.agent.engineViews.bind(ctx.agent);
    ctx.agent.engineViews = async (...args) => (await engineViews(...args)).filter((e) => ["ready", "second", "tomrade"].includes(e.id)).map((e) => (e.id === "tomrade" ? { ...e, ok: true, capabilities: ["backlog", "code", "general"] } : e));
    const inWindow = [];
    ctx.codeLink.showSession = async (_projectId, sessionId) => (inWindow.push(sessionId), true);
    let quick = null;
    let release = null;
    ctx.codeLink.start = (projectId, itemId, opts) =>
      new Promise((resolve) => {
        quick = opts;
        release = () => {
          const session = ctx.codeLink.store.createSession(projectId, { repoId: "r", branch: "spr-1/slow-start", itemIds: [itemId], mode: "terminal", agent: opts.engine, threadId: null, device: "check" });
          ctx.codeLink.store.patchSession(projectId, session.id, { herdrPane: "w1:p9", state: "running", lastEventAt: Date.now() });
          resolve({ ok: true, continued: false, threadId: null, sessionId: session.id, branch: "spr-1/slow-start", worktree: null, cwd: work, mode: opts.mode, command: "claude", launched: true, pane: "w1:p9", engine: opts.engine });
        };
      });
    const press = (selector) => js(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) b.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0 })); return true; })()`);
    await js(`location.reload(); true`);
    await sleep(500);
    await js(`location.hash = '#/p/${project.id}/i/${item.id}'; true`);
    await wait(() => js(`(document.querySelector('[data-testid="start-quick"]')?.textContent ?? '').includes('Ready')`));
    assert("记得上次怎么开始时，主按钮写着用哪个 agent", (await js(`document.querySelector('[data-testid="start-quick"]').textContent`)).includes("开始 · Ready"));
    await press('[data-testid="start-ways"]');
    await wait(() => js(`!!document.querySelector('.menu.is-floating')`));
    const ways = await js(`[...document.querySelectorAll('.menu.is-floating .menu-row')].map((r) => r.textContent)`);
    assert("▾ 是四种开始方式：上次的 agent 后台窗格（默认）/ 也打开终端窗口 / 另一个 agent 后台窗格 / 内置助手在面板里，最后是完整设置",
      ways.length === 5 && ways[0].includes("Ready · 后台窗格") && ways[0].includes("默认 · 上次就是这样") && ways[1].includes("Ready · 也打开终端窗口") && ways[2].includes("Second · 后台窗格") && ways[3].includes("内置助手 · 在面板里") && ways[4].includes("完整设置"));
    await js(`document.querySelector('.menu.is-floating').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await wait(() => js(`!document.querySelector('.menu.is-floating')`));
    await js(`document.querySelector('[data-testid="start-quick"]').click(); true`);
    await wait(async () => quick !== null);
    await wait(() => js(`!!document.querySelector('[data-testid="start-starting"]')`));
    assert("一点就开始，用上次的 agent，在后台窗格里", quick.engine === "ready" && quick.mode === "terminal");
    assert("不弹对话框", await js(`!document.querySelector('[data-testid="start-dialog"]')`));
    assert("工单上写着「● Ready 启动中」", (await js(`document.querySelector('[data-testid="start-starting"]').textContent`)).includes("Ready 启动中"));
    await wait(() => js(`!!document.querySelector('.ai .sbar [data-status="start"]')`));
    assert("会话栏最上面是虚线圈的「启动中」", await js(`(() => { const first = document.querySelector('.ai .sbar .sbar-dots > *, .ai .sbar .sbar-cards > *'); return first?.dataset.status === 'start' && getComputedStyle(first.querySelector('.sbar-dot-face') ?? first).borderTopStyle === 'dashed'; })()`));
    fs.writeFileSync(path.join(work, "start-starting.png"), (await win.webContents.capturePage()).toPNG());
    release();
    await wait(() => js(`!document.querySelector('[data-testid="start-starting"]')`));
    const paneSessionId = ctx.codeLink.store.sessions(project.id, { itemId: item.id }).find((s) => s.herdrPane === "w1:p9")?.id;
    await wait(() => js(`document.querySelector('.ai .ai-session')?.dataset.session === ${JSON.stringify(paneSessionId)}`));
    assert("起来后助手面板选中这个会话，没有打开终端窗口", inWindow.length === 0);
    assert("会话栏不再有「启动中」，换成运行中的它", await js(`!document.querySelector('.ai .sbar [data-status="start"]') && !!document.querySelector('.ai .sbar [aria-current="true"]')`));
    await wait(() => js(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('后台窗格'))`));
    assert("提示说在后台窗格里跑、已在面板里打开", true);
    ctx.codeLink.store.patchSession(project.id, paneSessionId, { state: "ended", endedAt: Date.now() });
    ctx.emit("codeLink/changed", project.id);
    ctx.ipc.send("codeLink.changed", project.id);

    // ▾ 里选「也打开终端窗口」：照旧在终端窗口里打开
    quick = null;
    await wait(() => js(`!!document.querySelector('[data-testid="start-ways"]')`));
    await press('[data-testid="start-ways"]');
    await wait(() => js(`!!document.querySelector('.menu.is-floating')`));
    await js(`[...document.querySelectorAll('.menu.is-floating .menu-row')].find((r) => r.textContent.includes('也打开终端窗口')).click(); true`);
    await wait(async () => quick !== null && !!release);
    release();
    await wait(async () => inWindow.length === 1);
    assert("「也打开终端窗口」开始后在终端窗口里显示它", ctx.codeLink.store.session(project.id, inWindow[0])?.herdrPane === "w1:p9");
    assert("这条路也不弹对话框", await js(`!document.querySelector('[data-testid="start-dialog"]')`));
    ctx.codeLink.store.patchSession(project.id, inWindow[0], { state: "ended", endedAt: Date.now() });
    ctx.emit("codeLink/changed", project.id);
    ctx.ipc.send("codeLink.changed", project.id);
    ctx.agent.engineViews = engineViews;
    // 别处开始过（对话里、MCP、另一个窗口）：开着的窗口马上重新读上次的选择，不等缓存过期
    let asked = 0;
    ctx.codeLink.startDefaults = () => (asked++, { mode: "run", engine: "ready" });
    ctx.ipc.send("codeLink.startDefaultsChanged");
    await wait(async () => asked > 0);
    assert("别处开始后，开着的窗口立刻重新读上次的选择", asked > 0);

    // ── 工单已有会话在做：先问去看它、跟它说一句、还是另开一个（TOM-699：都在面板里，另开一个用自己的文件夹和分支） ──
    const shown = [];
    ctx.codeLink.showSession = async (_projectId, sessionId) => (shown.push(sessionId), true);
    const realDeliveries = ctx.codeLink.deliveries.bind(ctx.codeLink);
    const realSessionsOf = ctx.codeLink.sessionsOf.bind(ctx.codeLink);
    const realRecent = ctx.codeLink.recentSessions.bind(ctx.codeLink);
    ctx.codeLink.deliveries = (projectId, itemId) => [{ id: "d1", projectId, itemId, sequence: 1, state: "active", startedAt: Date.now(), completedAt: null, updatedAt: Date.now(), bases: {} }];
    const liveSession = { id: "s-live", projectId: project.id, repoId: "r", delivery: 1, branch: "spr-1/slow-start", itemIds: [item.id], worked: [], marks: [], asked: 0, mode: "terminal", agent: "ready", externalId: null, threadId: null, worktree: null, herdrPane: "w1:p1", terminal: null, title: null, cwd: null, transcript: null, prompted: true, withoutTicket: null, recordSavedAt: null, recordCut: false, state: "running", lastEventAt: Date.now(), lastToolAt: null, lastCommitAt: null, summary: null, activity: "Bash · pnpm test", blocked: null, requestedBy: null, autoMerge: false, device: "here", startedAt: Date.now(), endedAt: null };
    ctx.codeLink.sessionsOf = () => [liveSession];
    ctx.codeLink.recentSessions = (projectId) => [liveSession, ...realRecent(projectId)];
    let apartOpts = null;
    ctx.codeLink.start = async (_projectId, _itemId, opts) => ((apartOpts = opts), { ok: true, continued: false, threadId: null, sessionId: "s-apart", branch: "spr-1/slow-start-b", worktree: null, cwd: work, mode: opts.mode, command: "claude", launched: false, pane: null, engine: "ready" });
    await js(`location.reload(); true`);
    await sleep(500);
    await js(`location.hash = '#/p/${project.id}/i/${item.id}'; true`);
    await wait(() => js(`(document.querySelector('[data-testid="start-quick"]')?.textContent ?? '').includes('继续')`));
    const liveMenu = async () => {
      await press('[data-testid="start-quick"]');
      await wait(() => js(`!!document.querySelector('.menu.is-floating')`));
    };
    await liveMenu();
    const menu = await js(`document.querySelector('.menu.is-floating').textContent`);
    assert("会话还在做时，开始先问：去看它 / 跟它说一句 / 另开一个，并说它在做什么", menu.includes("Ready 已经在做这张了") && menu.includes("去看它") && menu.includes("跟它说一句") && menu.includes("另开一个") && menu.includes("用自己的文件夹和分支") && menu.includes("Bash · pnpm test"));
    await js(`[...document.querySelectorAll('.menu.is-floating .menu-row')].find((r) => r.textContent.includes('去看它')).click(); true`);
    await wait(() => js(`document.querySelector('.ai .ai-session')?.dataset.session === 's-live'`));
    assert("去看它：在助手面板里选中那个会话，不拉起终端窗口", shown.length === 0);
    await liveMenu();
    await js(`[...document.querySelectorAll('.menu.is-floating .menu-row')].find((r) => r.textContent.includes('跟它说一句')).click(); true`);
    await wait(() => js(`document.querySelector('.ai .ai-session')?.dataset.session === 's-live' && !!document.querySelector('.ai-session-foot .ai-input')`));
    assert("跟它说一句：终端会话也行，在面板里打开它的输入框", shown.length === 0);
    await liveMenu();
    await js(`[...document.querySelectorAll('.menu.is-floating .menu-row')].find((r) => r.textContent.includes('另开一个')).click(); true`);
    await wait(() => js(`!!document.querySelector('[data-testid="start-apart"]')`));
    assert("另开一个：对话框说新会话用自己的文件夹和分支", (await js(`document.querySelector('[data-testid="start-apart"]').textContent`)).includes("自己的文件夹和分支"));
    await wait(() => js(`!document.querySelector('[data-testid="start-confirm"]').disabled`));
    await js(`document.querySelector('[data-testid="start-confirm"]').click(); true`);
    await wait(async () => apartOpts !== null);
    assert("另开一个开始时要自己的文件夹和分支", apartOpts.apart === true);
    ctx.codeLink.deliveries = realDeliveries;
    ctx.codeLink.sessionsOf = realSessionsOf;
    ctx.codeLink.recentSessions = realRecent;

    // ── 工单页的会话时间线（TOM-699）：一行一个会话，先写结论；续接不算新会话；两个在同一个文件夹时警告 ──
    const thread1 = ctx.agent.newThread(project.id, "ready");
    const mk = (over) => {
      const s = ctx.codeLink.store.createSession(project.id, { repoId: "r", branch: "spr-1/slow-start", itemIds: [item.id], mode: over.mode ?? "terminal", agent: "ready", threadId: over.threadId ?? null, device: "check", worktree: over.worktree ?? null });
      return ctx.codeLink.store.patchSession(project.id, s.id, over.patch);
    };
    ctx.codeLink.store.ensureActiveDelivery(project.id, item.id);
    mk({ mode: "headless", threadId: thread1.id, patch: { state: "ended", endedAt: Date.now(), summary: "定下录制格式：按窗格分文件", asked: 1 } });
    mk({ threadId: thread1.id, patch: { herdrPane: "w1:p5", state: "ended", endedAt: Date.now(), summary: "录制和读取写好了，测试过了" } });
    const earlier = mk({ worktree: "/wt/spr-1", patch: { state: "running", herdrPane: "w1:p6", activity: "Bash · pnpm test" } });
    const later = mk({ worktree: "/wt/spr-1", patch: { state: "running", herdrPane: "w1:p7", activity: "Read · recorder.ts" } });
    ctx.emit("codeLink/changed", project.id);
    ctx.ipc.send("codeLink.changed", project.id);
    await js(`location.reload(); true`);
    await sleep(500);
    await js(`location.hash = '#/p/${project.id}/i/${item.id}'; true`);
    await wait(() => js(`!!document.querySelector('[data-testid="ticket-timeline"]')`));
    const timeline = await js(`[...document.querySelectorAll('[data-testid="ticket-timeline-row"]')].map((r) => r.textContent)`);
    const handedOff = timeline.find((r) => r.includes("录制和读取写好了"));
    assert("工单页按开始的先后列会话；在助手和终端格子之间续接的只算一行，先写结论", !!handedOff && !timeline.some((r) => r.includes("定下录制格式")) && /续接了 1 次/.test(handedOff) && /问过你 1 次/.test(handedOff) && /助手 → 终端格子/.test(handedOff));
    await js(`[...document.querySelectorAll('[data-testid="ticket-timeline-row"]')].find((r) => r.textContent.includes('录制和读取写好了')).querySelector('.fold-chev').click(); true`);
    await wait(() => js(`!!document.querySelector('[data-testid="ticket-timeline-stops"]')`));
    assert("展开看这个会话去过的地方", (await js(`document.querySelector('[data-testid="ticket-timeline-stops"]').textContent`)).includes("同一个会话去过的地方"));
    assert("「这张工单交了什么」写着来自几个会话，和时间线的行数一样", (await js(`document.querySelector('[data-testid="ticket-delivered"]').textContent`)).includes(`来自 ${timeline.length} 个会话`));
    assert("两个会话同时在同一个文件夹做时有警告条", (await js(`document.querySelector('[data-testid="ticket-clash"]')?.textContent ?? ''`)).includes("2 个会话同时在做这张工单，而且在同一个文件夹"));
    fs.writeFileSync(path.join(work, "ticket-timeline.png"), (await win.webContents.capturePage()).toPNG());
    await js(`document.querySelector('[data-testid="ticket-clash-stop"]').click(); true`);
    await wait(() => js(`!document.querySelector('[data-testid="ticket-clash"]')`));
    assert("「停掉后开始的」停下后开始的那个，警告条消失", ctx.codeLink.store.session(project.id, later.id).state === "ended" && ctx.codeLink.store.session(project.id, earlier.id).state === "running");

    // ── 看板 Doing 卡片一行「● Ready 在做 · …」，数据走看板已有的查询 ──
    ctx.items.update(project.id, item.id, { status: "doing" }, "human");
    await js(`location.hash = '#/p/${project.id}'; true`);
    await wait(() => js(`!!document.querySelector('.card[data-id="${item.id}"] [data-testid="card-session"]')`));
    assert("看板卡片写着哪个 agent 在做、在哪、多久", /Ready 在做 · 终端格子里 · \d+ 分钟/.test(await js(`document.querySelector('.card[data-id="${item.id}"] [data-testid="card-session"]').textContent`)));
    ctx.codeLink.store.patchSession(project.id, earlier.id, { state: "ended", endedAt: Date.now() });

    // ── 对话里的开始卡片（TOM-661）：一张张开始，每张开始时显示自己的步骤 ──
    const tickets = ["Card first", "Card second"].map((title) => ctx.items.create({ projectId: project.id, boardId: board.id, title, workType: "coding", status: "todo", by: "human" })).map((i) => ({ itemId: i.id, key: i.key, title: i.title }));
    const thread = ctx.agent.newThread(project.id, "ready");
    const cardData = { tickets, config: { engine: "ready" } };
    ctx.agent.postCard(project.id, thread.id, { id: "start-batch-spr", schema: "start-batch", title: "SPR", data: cardData });
    ctx.agent.show(thread.id);
    // As the backend does: one ticket after another, each outcome on the card as it comes.
    const releases = [];
    ctx.codeLink.startTickets = async (projectId, request) => {
      const results = [];
      for (const itemId of request.itemIds) {
        await new Promise((resolve) => releases.push(resolve));
        const ticket = tickets.find((t) => t.itemId === itemId);
        results.push({ ...ticket, ok: true, threadId: null, branch: `${ticket.key.toLowerCase()}/card`, engine: "ready", continued: false });
        ctx.agent.postCard(projectId, request.requestedBy, { id: request.cardId, schema: "start-batch", title: "SPR", data: { ...cardData, results: [...results] } });
      }
      return results;
    };
    await js(`location.reload(); true`);
    await sleep(500);
    await js(`location.hash = '#/p/${project.id}'; true`);
    await wait(() => js(`!!document.querySelector('[data-testid="start-batch-go"]')`));
    const rows = () => js(`[...document.querySelectorAll('[data-testid="start-batch-ticket"]')].map((li) => ({ state: li.dataset.state, step: li.querySelector('[data-testid="start-progress-step"]')?.textContent ?? null, text: li.textContent }))`);
    assert("点开始前卡片上没有进度", await js(`!document.querySelector('[data-testid="start-batch"] [data-testid="start-progress"]')`));
    await js(`document.querySelector('[data-testid="start-batch-go"]').click(); true`);
    await wait(async () => releases.length === 1 && (await rows())[0].step !== null);
    let now = await rows();
    assert("第一张显示自己正在进行的步骤", now[0].state === "starting" && now[0].step.includes("准备工作副本"));
    assert("第二张排队，不显示步骤", now[1].state === "queued" && now[1].step === null && now[1].text.includes("排队中"));
    assert("卡片标题说正在开始两个工单", (await js(`document.querySelector('[data-testid="start-batch"] .tool-head').textContent`)).includes("正在开始 2 个工单"));
    assert("开始按钮转着加载图标", await js(`!!document.querySelector('[data-testid="start-batch-go"] .is-spinning')`));
    fs.writeFileSync(path.join(work, "start-batch-progress.png"), (await win.webContents.capturePage()).toPNG());
    await wait(async () => (await rows())[0].step.includes("检出"));
    assert("第一张几秒后换到下一步", true);

    releases[0]();
    await wait(async () => releases.length === 2 && (await rows())[1].step !== null);
    now = await rows();
    assert("第一张开始后显示和以前一样的结果行", now[0].state === "started" && now[0].step === null && now[0].text.includes("card"));
    assert("第二张从第一步开始显示自己的步骤", now[1].state === "starting" && now[1].step.includes("准备工作副本"));
    releases[1]();
    await wait(async () => (await rows()).every((r) => r.state === "started"));
    assert("都开始后卡片上不再有进度，标题说已开始", await js(`!document.querySelector('[data-testid="start-batch"] [data-testid="start-progress"]') && document.querySelector('[data-testid="start-batch"] .tool-head').textContent.includes("已开始 2 个工单")`));
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
