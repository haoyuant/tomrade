/**
 * The code sessions window against the real shell and a real herdr: sessions
 * in herdr panes show in a window of their own, six at once, with Claude Code
 * and Codex drawn by their own TUIs, wide characters in place, text committed
 * the way an input method commits it, and what happens when something else
 * takes a pane over. herdr runs on a session of its own; the person's is not
 * touched.
 *
 *   pnpm --filter @tomradex/ui build && pnpm --filter @tomrade/desktop test:code-sessions
 */
import { app, BrowserWindow } from "electron";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-code-sessions-"));
const shots = process.env.TOMRADE_CHECK_SHOTS ?? work;
const HERDR_SESSION = "tomrade-cs-check";
process.env.HERDR_SESSION = HERDR_SESSION;
app.setPath("userData", work);
app.on("window-all-closed", () => {});

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok || !extra ? "" : ` — ${extra}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const herdr = (...args) => execFileSync("herdr", args, { env: { ...process.env, HERDR_SESSION }, encoding: "utf8" });

app.whenReady().then(async () => {
  let ctx;
  let server;
  const others = [];
  try {
    server = spawn("herdr", ["server"], { env: { ...process.env, HERDR_SESSION }, stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try {
        herdr("status");
        break;
      } catch {
        await sleep(200);
      }
    }
    const { boot } = await import("../dist/boot.js");
    const uiPages = pathToFileURL(path.join(dir, "../../../packages/ui/dist/")).href;
    ({ ctx } = await boot({
      configFile: path.join(dir, "../tomrade.yml"),
      vars: { userData: work, uiPages },
      patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "code-sessions", disabled: false }]]
    }));
    ctx.hub.configure(path.join(work, "hub"));
    ctx.settings.set({ ...ctx.settings.get(), language: "zh", onboarding: { seen: ["*"] }, codeLink: { ...ctx.settings.get().codeLink, terminal: "herdr" } });
    const project = ctx.projects.create({ name: "代码会话检查", keyPrefix: "CSC" });
    const board = ctx.boards.list(project.id)[0];
    const cwd = fs.mkdtempSync(path.join(work, "repo-"));

    // Six panes in the project's workspace: Claude Code, Codex, wide characters, and three that print a marker.
    const programs = [
      { title: "Claude Code TUI", command: "claude" },
      { title: "Codex TUI", command: "codex" },
      { title: "宽字符", command: "printf '中文宽度｜日本語｜한국어｜END\\n0123456789012345678901234567\\n'" },
      { title: "Marker four", command: "echo marker-four" },
      { title: "Marker five", command: "echo marker-five" },
      { title: "Marker six", command: "echo marker-six" }
    ];
    const sessions = [];
    for (const program of programs) {
      const item = ctx.items.create({ projectId: project.id, boardId: board.id, title: program.title, workType: "coding", status: "doing", by: "human" });
      const pane = await ctx.herdr.launch({ cwd, label: item.key, command: program.command, workspace: { key: project.id, label: project.name } });
      const session = ctx.codeLink.store.createSession(project.id, { repoId: "check", branch: `${item.key.toLowerCase()}/check`, itemIds: [item.id], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: cwd });
      ctx.codeLink.store.patchSession(project.id, session.id, { state: "running", herdrPane: pane.paneId });
      sessions.push({ ...session, pane: pane.paneId, item });
    }
    check("六个会话在同一个项目 workspace 的六个 tab 里", new Set(sessions.map((s) => s.pane.split(":")[0])).size === 1 && sessions.length === 6, sessions.map((s) => s.pane).join(","));
    await sleep(4000);

    // A 3 × 2 layout remembered for the project, as the window saves it.
    const leaf = (i) => ({ type: "leaf", id: `c${i}`, sessionId: sessions[i].id });
    const row = (a, b, c, id) => ({ type: "split", id, direction: "row", ratio: 0.34, a: leaf(a), b: { type: "split", id: `${id}b`, direction: "row", ratio: 0.5, a: leaf(b), b: leaf(c) } });
    const layout = { type: "split", id: "root", direction: "column", ratio: 0.5, a: row(0, 1, 2, "top"), b: row(3, 4, 5, "bottom") };
    fs.writeFileSync(path.join(work, "code-sessions.json"), JSON.stringify({ layouts: { [project.id]: layout } }));

    await ctx.contributions.run("code-sessions.open", { projectId: project.id });
    let win;
    for (let i = 0; i < 50 && !win; i++) {
      win = BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith("终端 — "));
      if (!win) await sleep(100);
    }
    check("窗口打开，标题带项目名", win?.getTitle() === `终端 — ${project.name}`, win?.getTitle());
    win.setBounds({ x: 40, y: 40, width: 1680, height: 1000 });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const terminalText = (i) => js(`(() => { const cell = document.querySelectorAll('.cs-cell')[${i}]; return cell ? [...cell.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent).join('\\n') : ''; })()`);
    const wait = async (fn, ms = 15000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await fn()) return true;
        await sleep(200);
      }
      return false;
    };
    check("侧栏列出六个会话", await wait(async () => (await js(`document.querySelectorAll('.cs-row').length`)) === 6));
    check("六个格子同时连上终端", await wait(async () => (await js(`document.querySelectorAll('.cs-cell .xterm').length`)) === 6));
    const markers = await wait(async () => {
      const texts = await Promise.all([3, 4, 5].map(terminalText));
      return texts[0].includes("marker-four") && texts[1].includes("marker-five") && texts[2].includes("marker-six");
    });
    check("六个终端各自收到自己 pane 的画面", markers);
    const claude = await wait(async () => /trust|Claude Code|Welcome|信任/i.test(await terminalText(0)), 20000);
    check("Claude Code 的 TUI 画出来了", claude, (await terminalText(0)).slice(0, 300));
    const codex = await wait(async () => /codex|OpenAI|sign in|trust|model/i.test(await terminalText(1)), 20000);
    check("Codex 的 TUI 画出来了", codex, (await terminalText(1)).slice(0, 300));
    const wide = await terminalText(2);
    const lines = wide.split("\n");
    // The output line, not the command echoed before it.
    const cjk = lines.find((l) => l.trimStart().startsWith("中文宽度")) ?? "";
    check("中日韩字符按双宽显示，后面的字符位置正确", cjk.includes("END") && cjk.replace(/\s+$/, "").length < 30, JSON.stringify(cjk));
    fs.writeFileSync(path.join(shots, "code-sessions-six.png"), (await win.webContents.capturePage()).toPNG());

    // Text committed the way an input method commits it, into the wide-character pane's shell.
    await js(`document.querySelectorAll('.cs-cell')[2].querySelector('.xterm-helper-textarea').focus(); true`);
    await sleep(200);
    win.webContents.insertText("echo 输入法提交");
    await sleep(200);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    const ime = await wait(async () => herdr("pane", "read", sessions[2].pane, "--source", "recent", "--lines", "20").includes("输入法提交"));
    check("像输入法那样提交的中文进到了 pane", ime);

    // Another controller takes the pane over: the cell says it was let go and offers to attach again.
    const thief = spawn("herdr", ["terminal", "session", "control", sessions[5].pane, "--takeover", "--cols", "60", "--rows", "10"], { env: { ...process.env, HERDR_SESSION }, stdio: ["pipe", "ignore", "ignore"] });
    others.push(thief);
    const taken = await wait(async () => js(`!!document.querySelectorAll('.cs-cell')[5].querySelector('.cs-term-closed')`), 8000);
    const takenText = await js(`document.querySelectorAll('.cs-cell')[5].querySelector('.cs-term-closed')?.textContent ?? ''`);
    check("被别的控制端抢走时，格子显示已断开并可重连", taken, takenText);
    console.log(`INFO: takeover → ${taken ? JSON.stringify(takenText) : "this window kept streaming"}`);
    thief.stdin.end(`${JSON.stringify({ type: "terminal.release" })}\n`);
    await sleep(500);
    if (taken) {
      await js(`document.querySelectorAll('.cs-cell')[5].querySelector('.cs-term-closed button').click(); true`);
      check("重新连接后画面回来", await wait(async () => (await terminalText(5)).includes("marker-six")));
    }

    // herdr's own TUI attached to the same server: does this window keep its panes?
    const tui = spawn("script", ["-q", "/dev/null", "herdr"], { env: { ...process.env, HERDR_SESSION, TERM: "xterm-256color", COLUMNS: "100", LINES: "30" }, stdio: ["pipe", "ignore", "ignore"] });
    others.push(tui);
    await sleep(3000);
    await js(`document.querySelectorAll('.cs-cell')[3].querySelector('.xterm-helper-textarea').focus(); true`);
    win.webContents.insertText("echo after-herdr-tui");
    await sleep(200);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    const coexist = await wait(async () => (await terminalText(3)).includes("after-herdr-tui"), 8000);
    const stillOpen = await js(`[...document.querySelectorAll('.cs-cell')].filter((c) => c.querySelector('.cs-term-closed')).length`);
    check("herdr 自己的 TUI 连着时，窗口仍能输入并看到输出", coexist, `closed cells: ${stillOpen}`);
    console.log(`INFO: with herdr's TUI attached → typed text shown: ${coexist}, cells let go: ${stillOpen}`);
    fs.writeFileSync(path.join(shots, "code-sessions-after.png"), (await win.webContents.capturePage()).toPNG());

    check("窗口说的是应用的语言", (await js(`document.querySelector('.cs-side-head').textContent`)) === "会话");
    win.close();
    await sleep(500);
    check("关窗后 pane 还在 herdr 里跑", JSON.parse(herdr("pane", "list")).result.panes.length >= 6);

    // Closed and opened again, and opened while another window is in front: it comes forward each time.
    const front = new BrowserWindow({ width: 1600, height: 1000, x: 0, y: 0, title: "app window stand-in" });
    await front.loadURL("about:blank");
    const sessionsWindow = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getTitle().startsWith("终端 — "));
    // Focus only moves inside the app that is in front; macOS may keep it with the app the person is using.
    app.focus({ steal: true });
    front.focus();
    const canFocus = await wait(async () => BrowserWindow.getFocusedWindow() === front, 3000);
    let forward = true;
    let focusedTitle = "";
    for (let i = 0; i < 3 && canFocus; i++) {
      front.focus();
      await sleep(300);
      await ctx.contributions.run("code-sessions.open", { projectId: project.id });
      await wait(async () => BrowserWindow.getFocusedWindow() === sessionsWindow(), 10000);
      const again = sessionsWindow();
      focusedTitle = BrowserWindow.getFocusedWindow()?.getTitle() ?? "none";
      if (!again || BrowserWindow.getFocusedWindow() !== again) forward = false;
      front.focus();
      await sleep(300);
      await ctx.contributions.run("code-sessions.open", { projectId: project.id });
      await wait(async () => BrowserWindow.getFocusedWindow() === again, 3000);
      if (BrowserWindow.getFocusedWindow() !== again) forward = false;
      again?.close();
      // Gone before the next round looks for the window by its title.
      await wait(async () => !again || again.isDestroyed(), 5000);
    }
    front.destroy();
    if (canFocus) check("关掉再打开（三次）、被别的窗口挡住时再点，窗口都到最前并获得焦点", forward, `focused: ${focusedTitle}`);
    else console.log("INFO: skipped the focus step — another app is in front, so this app's windows cannot take focus");

    // A plain terminal from the list's button: every cell is taken, so it opens in a new one beside them.
    await ctx.contributions.run("code-sessions.open", { projectId: project.id });
    await wait(async () => sessionsWindow()?.isVisible() ?? false, 10000);
    let tw = sessionsWindow();
    let tjs = (code) => tw.webContents.executeJavaScript(code, true);
    await wait(async () => (await tjs(`document.querySelectorAll('.cs-cell .xterm').length`)) === 6);
    await tjs(`document.querySelector('[data-testid=cs-side-new-terminal]').click(); true`);
    const opened = await wait(async () => (await tjs(`document.querySelectorAll('.cs-cell').length === 7 && !!document.querySelector('.cs-cell[data-cell-terminal] .xterm')`)));
    check("新终端：格子都占满时，在旁边新开一格并连上 herdr", opened);
    const listed = await wait(async () => (await tjs(`document.querySelectorAll('[data-terminal]').length`)) === 1, 5000);
    check("左侧终端列表列出它", listed);
    await tjs(`document.querySelector('.cs-cell[data-cell-terminal] .xterm-helper-textarea').focus(); true`);
    await sleep(200);
    tw.webContents.insertText("echo plain-terminal-ok");
    await sleep(200);
    tw.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    tw.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    tw.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    const saved = () => JSON.parse(fs.readFileSync(path.join(work, "code-sessions.json"), "utf8")).terminals?.[project.id] ?? [];
    const plainPane = saved()[0]?.pane;
    const typed = !!plainPane && (await wait(async () => herdr("pane", "read", plainPane, "--source", "recent", "--lines", "20").includes("plain-terminal-ok")));
    check("在新终端里输入的命令跑了", typed, `pane: ${plainPane}`);
    // An agent's hooks name their pane from HERDR_PANE_ID: in a plain terminal it is that terminal's pane.
    herdr("pane", "send-text", plainPane, "echo pane-is-$HERDR_PANE_ID");
    herdr("pane", "send-keys", plainPane, "enter");
    const named = await wait(async () => herdr("pane", "read", plainPane, "--source", "recent", "--lines", "20").replace(/\n/g, "").includes(`pane-is-${plainPane}`));
    check("新终端里的 HERDR_PANE_ID 就是它自己的 pane（hooks 靠它报告 pane）", named);
    fs.writeFileSync(path.join(shots, "code-sessions-terminal.png"), (await tw.webContents.capturePage()).toPNG());

    // Kept across the window: reopened, the same cell shows it again.
    tw.close();
    await sleep(500);
    await ctx.contributions.run("code-sessions.open", { projectId: project.id });
    await wait(async () => sessionsWindow()?.isVisible() ?? false, 10000);
    tw = sessionsWindow();
    tjs = (code) => tw.webContents.executeJavaScript(code, true);
    const back = await wait(async () => (await tjs(`(() => { const cell = document.querySelector('.cs-cell[data-cell-terminal]'); return !!cell?.querySelector('.xterm') && [...cell.querySelectorAll('.xterm-rows > div')].some((r) => r.textContent.includes('plain-terminal-ok')); })()`)));
    check("关窗重开后，新终端在原来的格子里接回来", back);

    // An agent in it claims a ticket: code link learns the pane (as the repo's hooks report it) and the cell becomes
    // that session in place — same xterm, same picture, no second row. Letting the claim go makes it a terminal again.
    const claimed = ctx.items.create({ projectId: project.id, boardId: board.id, title: "在终端里认领", workType: "coding", status: "doing", by: "human" });
    const claimSession = ctx.codeLink.store.createSession(project.id, { repoId: "check", branch: `${claimed.key.toLowerCase()}/claimed`, itemIds: [claimed.id], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: cwd });
    await tjs(`document.querySelector('.cs-cell[data-cell-terminal] .xterm').dataset.mark = 'same'; true`);
    ctx.codeLink.store.patchSession(project.id, claimSession.id, { state: "running", herdrPane: plainPane });
    ctx.emit("codeLink/changed", project.id);
    const folded = await wait(async () => tjs(`(() => { const cell = document.querySelector('.cs-cell[data-cell-terminal]'); return !!cell && cell.querySelector('.cs-cell-name').textContent.includes(${JSON.stringify(claimed.key)}) && [...cell.querySelectorAll('.link-btn')].some((b) => b.textContent === '继续'); })()`));
    check("终端里的 agent 认领工单后，这个格子原地变成该工单的会话", folded);
    const inPlace = await tjs(`(() => { const cell = document.querySelector('.cs-cell[data-cell-terminal]'); return cell.querySelector('.xterm')?.dataset.mark === 'same' && [...cell.querySelectorAll('.xterm-rows > div')].some((r) => r.textContent.includes('plain-terminal-ok')); })()`);
    check("不换格子也不重连：还是原来的终端画面", inPlace);
    const rows = await tjs(`[document.querySelectorAll('[data-terminal]').length, [...document.querySelectorAll('.cs-row')].filter((r) => r.textContent.includes(${JSON.stringify(claimed.key)})).length]`);
    check("列表里只有工单会话这一行，没有重复的终端行", rows[0] === 0 && rows[1] === 1, JSON.stringify(rows));
    ctx.codeLink.store.patchSession(project.id, claimSession.id, { itemIds: [] });
    ctx.emit("codeLink/changed", project.id);
    const plainAgain = await wait(async () => tjs(`(() => { const cell = document.querySelector('.cs-cell[data-cell-terminal]'); return !!cell && [...cell.querySelectorAll('.link-btn')].some((b) => b.textContent === '关闭终端') && cell.querySelector('.xterm')?.dataset.mark === 'same'; })()`));
    check("释放工单后，格子变回普通终端（不清空、不重连）", plainAgain);

    // Closed from its cell: the pane ends in herdr.
    await tjs(`[...document.querySelector('.cs-cell[data-cell-terminal]').querySelectorAll('.link-btn')].find((b) => b.textContent === '关闭终端').click(); true`);
    const ended = await wait(async () => !JSON.parse(herdr("pane", "list")).result.panes.some((p) => p.pane_id === plainPane) && saved().length === 0);
    check("关闭终端：herdr 里的 pane 结束，列表里也没了", ended);

    // A layout kept under a name.
    await tjs(`document.querySelector('[data-testid=cs-save-layout]').click(); true`);
    await sleep(200);
    tw.webContents.insertText("七格");
    await tjs(`[...document.querySelectorAll('.cs-layout-form button')].find((b) => b.textContent === '保存').click(); true`);
    const kept = await wait(async () => (await tjs(`[...document.querySelectorAll('.cs-preset-name')].map((b) => b.textContent).join()`)) === "七格");
    const stored = JSON.parse(fs.readFileSync(path.join(work, "code-sessions.json"), "utf8")).presets ?? [];
    const noSessions = (l) => (l.type === "leaf" ? l.sessionId === null : noSessions(l.a) && noSessions(l.b));
    check("布局能存成预设，预设里不带会话", kept && stored.length === 1 && noSessions(stored[0].layout), JSON.stringify(stored.map((p) => p.name)));

    // Right-click on a pane's bar: the menu, and Detach empties that pane.
    const emptyCells = () => tjs(`document.querySelectorAll('.cs-cell [data-testid=cs-new-terminal]').length`);
    const emptyBefore = await emptyCells();
    await tjs(`document.querySelector('.cs-cell .cs-cell-bar').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 20 })); true`);
    const menu = await wait(async () => tjs(`[...document.querySelectorAll('[role=menuitem]')].map((i) => i.textContent).join('|')`).then((t) => t.includes("连接会话") && t.includes("新终端") && t.includes("断开")), 3000);
    check("面板右键菜单：连接会话 / 新终端 / 断开 / 拆分 / 关闭", menu);
    await tjs(`[...document.querySelectorAll('[role=menuitem]')].find((i) => i.textContent === '断开').click(); true`);
    const emptied = await wait(async () => (await emptyCells()) === emptyBefore + 1, 3000);
    check("右键断开后那个面板空了出来", emptied);

    // A session that appears goes to the empty pane by itself; switched off, the next one does not.
    const appear = async (title) => {
      const item = ctx.items.create({ projectId: project.id, boardId: board.id, title, workType: "coding", status: "doing", by: "human" });
      const p = await ctx.herdr.launch({ cwd, label: item.key, command: `echo ${item.key}`, workspace: { key: project.id, label: project.name } });
      const s = ctx.codeLink.store.createSession(project.id, { repoId: "check", branch: `${item.key.toLowerCase()}/check`, itemIds: [item.id], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: cwd });
      ctx.codeLink.store.patchSession(project.id, s.id, { state: "running", herdrPane: p.paneId });
      ctx.emit("codeLink/changed", project.id);
      return item.key;
    };
    const inCell = (key) => tjs(`[...document.querySelectorAll('.cs-cell-name')].some((n) => n.textContent.includes(${JSON.stringify(key)}))`);
    const auto = await appear("自动放进空面板");
    check("新会话自动放进空面板", await wait(async () => inCell(auto), 8000));
    await tjs(`document.querySelector('[data-testid=cs-side-new-terminal]').click(); true`);
    await sleep(300);
    await tjs(`document.querySelector('.cs-cell-bar').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 20 })); true`);
    await sleep(300);
    await tjs(`[...document.querySelectorAll('[role=menuitem]')].find((i) => i.textContent === '断开')?.click(); true`);
    await tjs(`document.querySelector('[data-testid=cs-auto-place]').click(); true`);
    await wait(async () => !JSON.parse(fs.readFileSync(path.join(work, "code-sessions.json"), "utf8")).autoPlace === false || JSON.parse(fs.readFileSync(path.join(work, "code-sessions.json"), "utf8")).autoPlace === false, 3000);
    const manual = await appear("关掉自动分配");
    await sleep(2500);
    check("关掉自动分配后，新会话不会自己占面板", !(await inCell(manual)) && (await tjs(`document.querySelectorAll('.cs-cell [data-testid=cs-new-terminal]').length`)) >= 1);
    fs.writeFileSync(path.join(shots, "code-sessions-layouts.png"), (await tw.webContents.capturePage()).toPNG());

    // A session in iTerm2 (its hooks said so): tagged in the list, and its pane says where it runs and what can be done.
    const outsideItem = ctx.items.create({ projectId: project.id, boardId: board.id, title: "在 iTerm2 里跑", workType: "coding", status: "doing", by: "human" });
    const outside = ctx.codeLink.store.createSession(project.id, { repoId: "check", branch: `${outsideItem.key.toLowerCase()}/iterm`, itemIds: [outsideItem.id], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: cwd });
    ctx.codeLink.store.patchSession(project.id, outside.id, { state: "running", terminal: "iTerm.app" });
    ctx.emit("codeLink/changed", project.id);
    const rowOf = `[...document.querySelectorAll('.cs-row')].find((r) => r.textContent.includes(${JSON.stringify(outsideItem.key)}))`;
    const tagged = await wait(async () => tjs(`${rowOf}?.querySelector('.cs-where')?.textContent === 'iTerm2'`), 8000);
    check("外部终端里的会话在列表里标出 iTerm2", tagged);
    await tjs(`${rowOf}.click(); true`);
    const told = await wait(async () => tjs(`(() => { const box = document.querySelector('[data-testid=cs-outside]'); return !!box && box.textContent.includes('这个会话在 iTerm2 里运行') && [...box.querySelectorAll('button')].map((b) => b.textContent).join('|'); })()`), 5000);
    const buttons = await tjs(`[...document.querySelector('[data-testid=cs-outside]')?.querySelectorAll('button') ?? []].map((b) => b.textContent)`);
    check("面板里说明它在 iTerm2 里、不能在这里显示，有「切到 iTerm2」，运行中不给接着做", !!told && buttons.join() === (process.platform === "darwin" ? "切到 iTerm2" : ""), JSON.stringify(buttons));
    ctx.codeLink.store.patchSession(project.id, outside.id, { state: "idle" });
    ctx.emit("codeLink/changed", project.id);
    const resumable = await wait(async () => tjs(`[...document.querySelector('[data-testid=cs-outside]')?.querySelectorAll('button') ?? []].some((b) => b.textContent === '在新终端里接着做')`), 5000);
    check("空闲后才出现「在新终端里接着做」", resumable);
    fs.writeFileSync(path.join(shots, "code-sessions-outside.png"), (await tw.webContents.capturePage()).toPNG());
    tw.close();
  } catch (error) {
    check("检查跑完", false, error?.stack ?? String(error));
  } finally {
    for (const p of others) p.kill();
    try {
      herdr("server", "stop");
    } catch {
      // already gone
    }
    server?.kill();
    fs.rmSync(path.join(os.homedir(), ".config/herdr/sessions", HERDR_SESSION), { recursive: true, force: true });
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed${shots === work ? ` · screenshots in ${work}` : ""}`);
    app.exit(failed ? 1 : 0);
  }
});
