/**
 * The code sessions window on native Windows, against Tomrade's own terminal host (node-pty over ConPTY) instead of
 * herdr: ticket sessions run by Git Bash in its panes, plain terminals in PowerShell, scrollback with its bar, observe
 * and takeover, a claim folding in place, the terminals coming back after Tomrade starts again, and the host dying
 * under the window. The host listens on a pipe of this run's own; the person's is not touched.
 *
 *   pnpm --filter @tomradex/ui build && pnpm --filter @tomrade/desktop test:code-sessions
 */
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { agentLinks, changedLinks } from "./agent-links.mjs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchTerminal } from "@tomradex/code-link";
import { hostCall } from "@tomradex/pty-host";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-code-sessions-builtin-"));
const shots = process.env.TOMRADE_CHECK_SHOTS ?? work;
// Run from inside a pane, the pane's variables would name it: this run's terminals name their own.
for (const key of ["HERDR_SOCKET_PATH", "HERDR_CLIENT_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_ENV"]) delete process.env[key];
const pipe = `\\\\.\\pipe\\tomrade-pty-check-${process.pid}`;
app.setPath("userData", work);
// These read the DOM renderer's rows: without the GPU there is no WebGL, so a cell also shows it carries on without.
app.commandLine.appendSwitch("disable-gpu");
app.on("window-all-closed", () => {});

const results = [];
// What the person's agents name as Tomrade before this run, to find unchanged at its end.
const linksBefore = agentLinks();
const check = (name, ok, extra = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok || !extra ? "" : ` — ${extra}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(200);
  }
  return false;
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** The image a process runs, as Windows names it; null once it is gone. */
const imageOf = (pid) => {
  const line = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true }).trim();
  return line.startsWith('"') ? line.split('","')[0].slice(1).toLowerCase() : null;
};

async function start() {
  const { boot } = await import("../dist/boot.js");
  const uiPages = pathToFileURL(path.join(dir, "../../../packages/ui/dist/")).href;
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work, uiPages },
    patches: [[
      { id: "mcp", config: { port: 0 } },
      { id: "hub-cloud", disabled: true },
      { id: "code-sessions", disabled: false },
      { id: "pty-host", config: { pipe, nodeBinary: process.execPath, logFile: path.join(work, "pty-host.log"), version: "check", idleMs: 20000 } }
    ]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  return ctx;
}

const sessionsWindow = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getTitle().endsWith(" — 终端"));

async function openWindow(ctx, projectId) {
  await ctx.contributions.run("code-sessions.open", { projectId });
  await wait(async () => !!sessionsWindow()?.isVisible(), 10000);
  const win = sessionsWindow();
  win.setBounds({ x: 40, y: 40, width: 1500, height: 900 });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const cellText = (selector) => js(`(() => { const cell = document.querySelector(${JSON.stringify(selector)}); return cell ? [...cell.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent).join('\\n') : ''; })()`);
  /** Typed into a cell until its echo shows: a shell still starting drops what it was sent, so a few tries. */
  const typeIn = async (selector, command, marker) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await js(`document.querySelector(${JSON.stringify(selector)})?.querySelector('.xterm-helper-textarea')?.focus(); true`);
      await sleep(200);
      win.webContents.insertText(command);
      await sleep(200);
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
      win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
      if (await wait(async () => (await cellText(selector)).split("\n").some((l) => l.trim() === marker), 8000)) return true;
    }
    return false;
  };
  return { win, js, cellText, typeIn };
}

app.whenReady().then(async () => {
  let ctx;
  let hostPid = 0;
  try {
    ctx = await start();
    const terminals = ctx.get("terminals");
    check("Windows 上的终端后端是内置 host", terminals?.kind === "builtin", String(terminals?.kind));
    const bridge = await terminals.bridge();
    check("内置 host 的 bridge 状态是 ready", bridge.state === "ready", JSON.stringify(bridge));
    const field = ctx.settings.sections("zh").find((s) => s.id === "codeLink").schema.properties.terminal;
    check("终端设置里有内置终端这个选项，默认仍是自动", field.enum.includes("builtin") && !field.enum.includes("herdr") && ctx.settings.get().codeLink.terminal === "auto", JSON.stringify(field.enum));
    ctx.settings.set({ ...ctx.settings.get(), language: "zh", onboarding: { seen: ["*"] } });
    const project = ctx.projects.create({ name: "内置终端检查", keyPrefix: "BTC" });
    const board = ctx.boards.list(project.id)[0];
    const cwd = fs.mkdtempSync(path.join(work, "repo-"));

    // Ticket sessions as code link starts them in terminal mode: its script, run by Git Bash in a pane of the host.
    const programs = [
      { title: "标记一", command: 'echo marker-one; echo "pane=$HERDR_PANE_ID"' },
      { title: "宽字符", command: "printf '中文宽度｜日本語｜한국어｜END\\n0123456789012345678901234567\\n'" },
      { title: "长输出", command: "seq 1 400" }
    ];
    const sessions = [];
    for (const program of programs) {
      const item = ctx.items.create({ projectId: project.id, boardId: board.id, title: program.title, workType: "coding", status: "doing", by: "human" });
      const launched = await launchTerminal({ cwd, command: program.command, dir: path.join(work, "sessions", item.key), label: item.key, workspace: { key: project.id, label: project.name } }, "builtin", terminals);
      const session = ctx.codeLink.store.createSession(project.id, { repoId: "check", branch: `${item.key.toLowerCase()}/check`, itemIds: [item.id], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: cwd });
      ctx.codeLink.store.patchSession(project.id, session.id, { state: "running", herdrPane: launched.paneId ?? null });
      sessions.push({ ...session, pane: launched.paneId, item, launched });
    }
    check("三个工单会话各在内置 host 的一个 pane 里跑起来", sessions.every((s) => s.launched.launched && s.pane), JSON.stringify(sessions.map((s) => s.launched)));
    const server = await terminals.server();
    hostPid = server?.pid ?? 0;
    check("host 是个独立的进程（Electron 以 Node 运行）", !!hostPid && hostPid !== process.pid && imageOf(hostPid) === path.basename(process.execPath).toLowerCase(), `${hostPid} ${hostPid ? imageOf(hostPid) : ""}`);

    const leaf = (i) => ({ type: "leaf", id: `c${i}`, sessionId: sessions[i].id });
    const layout = { type: "split", id: "root", direction: "row", ratio: 0.34, a: leaf(0), b: { type: "split", id: "rb", direction: "row", ratio: 0.5, a: leaf(1), b: leaf(2) } };
    fs.writeFileSync(path.join(work, "code-sessions.json"), JSON.stringify({ layouts: { [project.id]: layout } }));
    let { win, js, cellText, typeIn } = await openWindow(ctx, project.id);
    check("窗口打开，标题以项目名开头", win?.getTitle() === `${project.name} — 终端`, win?.getTitle());
    check("代码关联认得这个终端窗口（自动 = 内置终端）", await ctx.codeLink.terminalWindow(project.id));
    check("没有 herdr 的安装、启动提示", !(await js(`document.querySelector('[data-testid=cs-bridge]')?.textContent ?? ''`)));
    check("侧栏列出三个会话", await wait(async () => (await js(`document.querySelectorAll('.cs-row').length`)) === 3));
    check("三个格子同时连上终端", await wait(async () => (await js(`document.querySelectorAll('.cs-cell .xterm').length`)) === 3));
    const cell = (i) => `.cs-cell[data-cell="c${i}"]`;
    check("工单脚本经 Git Bash 跑完，输出画在格子里", await wait(async () => (await cellText(cell(0))).includes("marker-one")), await cellText(cell(0)));
    check("脚本里的 HERDR_PANE_ID 就是它的 pane（hooks 靠它把会话归到 pane）", (await cellText(cell(0))).includes(`pane=${sessions[0].pane}`), await cellText(cell(0)));
    const wide = (await cellText(cell(1))).split("\n").filter((l) => l.trimStart().startsWith("中文宽度"));
    const cjk = wide[0] ?? "";
    check("中日韩字符按双宽显示，后面的字符位置正确", cjk.includes("END") && cjk.replace(/\s+$/, "").length < 30, JSON.stringify(cjk));
    check("会话脚本只跑一次（Git Bash 直接运行它，不再往里敲命令）", wide.length === 1, JSON.stringify(wide));
    fs.writeFileSync(path.join(shots, "builtin-three.png"), (await win.webContents.capturePage()).toPNG());

    // Scrollback kept by the host, with the bar the window draws over it.
    let scroll = null;
    const stopScroll = terminals.onScroll(sessions[2].pane, (s) => (scroll = s));
    const bar = () => js(`(() => {
      const bar = document.querySelector('${cell(2)} .cs-scrollbar');
      if (!bar) return null;
      const t = bar.querySelector('.cs-scrollbar-thumb').getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      return { shown: bar.dataset.shown === 'true', opacity: Number(getComputedStyle(bar).opacity), below: Math.round(b.bottom - t.bottom), x: Math.round(t.left + t.width / 2), y: Math.round(t.top + t.height / 2), trackTop: Math.round(b.top) };
    })()`);
    const atRest = await wait(async () => {
      const b = await bar();
      return !!b && b.below < 2 && !b.shown && b.opacity === 0 && scroll?.max > 0;
    });
    check("输出超过一屏后有滚动条，不滚动时看不见", atRest, JSON.stringify({ bar: await bar(), scroll }));
    await js(`document.querySelector('${cell(2)} .xterm-screen').dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true }))`);
    const scrolledUp = await wait(async () => {
      const b = await bar();
      return !!b && b.shown && b.below > 2 && scroll?.offset > 0;
    }, 5000);
    check("滚动时滚动条出现，滑块离开底部", scrolledUp, JSON.stringify({ bar: await bar(), scroll }));
    const thumb = await bar();
    if (thumb) {
      const wc = win.webContents;
      wc.sendInputEvent({ type: "mouseMove", x: thumb.x, y: thumb.y });
      wc.sendInputEvent({ type: "mouseDown", x: thumb.x, y: thumb.y, button: "left", clickCount: 1 });
      for (let y = thumb.y; y >= thumb.trackTop - 40; y -= 20) {
        wc.sendInputEvent({ type: "mouseMove", x: thumb.x, y, modifiers: ["leftButtonDown"] });
        await sleep(20);
      }
      wc.sendInputEvent({ type: "mouseUp", x: thumb.x, y: thumb.trackTop - 40, button: "left", clickCount: 1 });
    }
    const top = await wait(async () => scroll?.max > 0 && scroll.offset === scroll.max, 5000);
    check("把滑块拖到顶：pane 滚到最早的输出", top && (await wait(async () => (await cellText(cell(2))).split("\n").some((l) => l.trim() === "1"), 3000)), JSON.stringify(scroll));
    await terminals.scrollTo(sessions[2].pane, 0);
    stopScroll();

    check("在会话的格子里输入，命令照常回显", await typeIn(cell(0), "echo typed-ok", "typed-ok"));

    // Watching beside the window, and taking the pane over from it.
    const observer = await terminals.terminal(sessions[0].pane, { mode: "observe", cols: 80, rows: 20 });
    let observed = "";
    observer.onFrame((f) => (observed += Buffer.from(f.bytes).toString("utf8")));
    observer.input("echo from-observer\r");
    await wait(async () => observed.includes("typed-ok"), 5000);
    await sleep(1000);
    check("observe 能看到同一个画面，但它的输入不进终端", observed.includes("typed-ok") && !(await terminals.readTail(sessions[0].pane, 40)).includes("from-observer"), (await terminals.readTail(sessions[0].pane, 5)) ?? "");
    observer.close();
    const thief = await terminals.terminal(sessions[0].pane, { mode: "control", cols: 60, rows: 10 });
    const taken = await wait(async () => js(`!!document.querySelector('${cell(0)} .cs-term-closed')`), 8000);
    const takenText = await js(`document.querySelector('${cell(0)} .cs-term-closed')?.textContent ?? ''`);
    check("被别的控制端接管时，格子显示已断开并说明原因", taken && takenText.includes("接管"), takenText);
    thief.close();
    await js(`document.querySelector('${cell(0)} .cs-term-closed button')?.click(); true`);
    check("重新连接后画面回来", await wait(async () => (await cellText(cell(0))).includes("typed-ok")));

    // A plain terminal from the list's button: PowerShell, in a cell beside the others.
    await js(`document.querySelector('[data-testid=cs-side-new-terminal]').click(); true`);
    const opened = await wait(async () => js(`document.querySelectorAll('.cs-cell').length === 4 && !!document.querySelector('.cs-cell[data-cell-terminal] .xterm')`));
    check("新终端：在旁边新开一格并连上内置 host", opened);
    const saved = () => JSON.parse(fs.readFileSync(path.join(work, "code-sessions.json"), "utf8")).terminals?.[project.id] ?? [];
    const plainPane = saved()[0]?.pane;
    const plain = ".cs-cell[data-cell-terminal]";
    check("在新终端里输入的命令跑了", await typeIn(plain, "echo plain-ok", "plain-ok"), `pane: ${plainPane}`);
    check("新终端里的 HERDR_PANE_ID 就是它自己的 pane", await typeIn(plain, "echo pane-is-$env:HERDR_PANE_ID", `pane-is-${plainPane}`));
    const shellPid = await terminalsPid(terminals, plainPane);
    const shell = shellPid ? imageOf(shellPid) : null;
    check("普通终端默认是 PowerShell（有 pwsh 用 pwsh，否则 powershell.exe）", shell === "pwsh.exe" || shell === "powershell.exe", String(shell));

    // An agent in it claims a ticket: the cell becomes that session in place, and a terminal again once it lets go.
    const claimed = ctx.items.create({ projectId: project.id, boardId: board.id, title: "在终端里认领", workType: "coding", status: "doing", by: "human" });
    const claimSession = ctx.codeLink.store.createSession(project.id, { repoId: "check", branch: "", itemIds: [], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: cwd });
    await js(`document.querySelector('${plain} .xterm').dataset.mark = 'same'; true`);
    ctx.codeLink.store.patchSession(project.id, claimSession.id, { state: "running", herdrPane: plainPane });
    ctx.emit("codeLink/changed", project.id);
    await sleep(1000);
    ctx.codeLink.store.patchSession(project.id, claimSession.id, { itemIds: [claimed.id], branch: `${claimed.key.toLowerCase()}/claimed` });
    ctx.emit("codeLink/changed", project.id);
    const folded = await wait(async () => js(`(() => { const cell = document.querySelector('${plain}'); return !!cell && cell.querySelector('.cs-cell-name').textContent.includes(${JSON.stringify(claimed.key)}) && [...cell.querySelectorAll('.link-btn')].some((b) => b.textContent === '继续'); })()`));
    check("终端里的 agent 认领工单后，这个格子原地变成该工单的会话", folded);
    check("不换格子也不重连：还是原来的终端画面", await js(`document.querySelector('${plain} .xterm')?.dataset.mark === 'same' && document.querySelector('${plain}').textContent.includes('plain-ok')`));
    ctx.codeLink.store.patchSession(project.id, claimSession.id, { itemIds: [], state: "ended", endedAt: Date.now() });
    ctx.emit("codeLink/changed", project.id);
    check("释放工单后，格子变回普通终端（不清空、不重连）", await wait(async () => js(`(() => { const cell = document.querySelector('${plain}'); return !!cell && [...cell.querySelectorAll('.link-btn')].some((b) => b.textContent === '关闭终端') && cell.querySelector('.xterm')?.dataset.mark === 'same'; })()`)));

    // A layout kept under a name, and the pane menu.
    await js(`document.querySelector('[data-testid=cs-save-layout]').click(); true`);
    await sleep(200);
    win.webContents.insertText("四格");
    await js(`[...document.querySelectorAll('.cs-layout-form button')].find((b) => b.textContent === '保存').click(); true`);
    check("布局能存成预设", await wait(async () => (await js(`[...document.querySelectorAll('.cs-preset-name')].map((b) => b.textContent).join()`)) === "四格"));
    await js(`document.querySelector('${cell(1)} .cs-cell-bar').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 20 })); true`);
    const menu = await wait(async () => js(`[...document.querySelectorAll('[role=menuitem]')].map((i) => i.textContent).join('|')`).then((t) => t.includes("连接会话") && t.includes("新终端") && t.includes("断开")), 3000);
    check("面板右键菜单：连接会话 / 新终端 / 断开", menu);
    await js(`[...document.querySelectorAll('[role=menuitem]')].find((i) => i.textContent === '断开')?.click(); true`);
    check("右键断开后那个面板空了出来", await wait(async () => !(await js(`!!document.querySelector('${cell(1)} .xterm')`)), 3000));
    fs.writeFileSync(path.join(shots, "builtin-terminal.png"), (await win.webContents.capturePage()).toPNG());

    // Closed and opened again: the terminal is back in its cell.
    win.close();
    await sleep(500);
    check("关窗后 pane 还在 host 里跑", ((await terminals.panes()) ?? []).length >= 4);
    ({ win, js, cellText, typeIn } = await openWindow(ctx, project.id));
    check("关窗重开后，新终端在原来的格子里接回来", await wait(async () => (await cellText(plain)).includes("plain-ok")));

    // Tomrade quits and starts again: the host and its terminals go on, and the cells show their screens again.
    win.close();
    await sleep(300);
    await ctx.fiber.dispose();
    ctx = null;
    await sleep(1000);
    check("Tomrade 退出后 host 还在跑", alive(hostPid));
    ctx = await start();
    const again = ctx.get("terminals");
    check("重新启动后连上同一个 host，pane 都还在", (await again.server())?.pid === hostPid && ((await again.panes()) ?? []).some((p) => p.paneId === plainPane));
    ({ win, js, cellText, typeIn } = await openWindow(ctx, project.id));
    check("重新启动后，终端和它的画面回到原来的格子里", await wait(async () => (await cellText(plain)).includes("plain-ok"), 20000), await cellText(plain));
    check("重新启动后的终端照常输入", await typeIn(plain, "echo after-restart", "after-restart"));

    // The host dies under the window: the cells say so, it is started again, and nothing hangs.
    process.kill(hostPid);
    const told = await wait(async () => js(`[...document.querySelectorAll('.cs-term-closed')].some((e) => e.textContent.includes('终端 host 停了'))`), 10000);
    check("host 死掉时，格子说明 host 停了", told, await js(`[...document.querySelectorAll('.cs-term-closed')].map((e) => e.textContent).join(' | ')`));
    const back = await wait(async () => !!(await again.server()), 20000);
    check("host 被重新启动", back);
    const settled = await wait(async () => js(`![...document.querySelectorAll('.cs-term-closed')].some((e) => e.textContent.includes('终端 host 停了'))`), 30000);
    check("重新启动后格子重新连接，没有卡住（随 host 结束的终端说明已结束，或从窗口里移走）", settled, await js(`[...document.querySelectorAll('.cs-cell')].map((c) => (c.querySelector('.cs-cell-name')?.textContent ?? '') + ':' + (c.querySelector('.cs-term-closed')?.textContent ?? '')).join(' | ')`));
    hostPid = (await again.server())?.pid ?? 0;
    const cellsBefore = await js(`document.querySelectorAll('.cs-cell[data-cell-terminal]').length`);
    await js(`document.querySelector('[data-testid=cs-side-new-terminal]').click(); true`);
    const fresh = await wait(async () => js(`[...document.querySelectorAll('.cs-cell[data-cell-terminal]')].filter((c) => c.querySelector('.xterm') && !c.querySelector('.cs-term-closed')).length > 0 && document.querySelectorAll('.cs-cell[data-cell-terminal]').length > ${cellsBefore - 1}`), 15000);
    const freshCell = ".cs-cell[data-cell-terminal]";
    check("之后新开的终端照常能用", fresh && (await typeIn(freshCell, "echo after-host-ok", "after-host-ok")));

    // Closed from its cell: the pane and its process end.
    const freshPane = saved().sort((a, b) => b.startedAt - a.startedAt)[0]?.pane;
    const freshPid = await terminalsPid(again, freshPane);
    await js(`[...document.querySelector('${freshCell}').querySelectorAll('.link-btn')].find((b) => b.textContent === '关闭终端')?.click(); true`);
    const ended = await wait(async () => !((await again.panes()) ?? []).some((p) => p.paneId === freshPane) && !saved().some((t) => t.pane === freshPane), 15000);
    check("关闭终端：pane 结束、进程树退出，列表里也没了", ended && !!freshPid && (await wait(async () => !alive(freshPid), 10000)), `pane ${freshPane} pid ${freshPid}`);
    check("窗口说的是应用的语言", (await js(`document.querySelector('.cs-bar-title').textContent`)) === "会话");
    win.close();
  } catch (error) {
    check("检查跑完", false, error?.stack ?? String(error));
  } finally {
    // This run's host and its terminals end with it.
    if (hostPid && alive(hostPid)) {
      try {
        execFileSync("taskkill", ["/T", "/F", "/PID", String(hostPid)], { windowsHide: true, stdio: "ignore" });
      } catch {
        // already gone
      }
    }
    await ctx?.fiber.dispose().catch(() => undefined);
    const moved = changedLinks(linksBefore);
    check("没有改动本机 agent 自己配置里的 Tomrade 条目", !moved.length, JSON.stringify(moved));
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed${shots === work ? ` · screenshots in ${work}` : ""}`);
    app.exit(failed ? 1 : 0);
  }
});

/** The pid of a pane's process, as the host lists it. */
async function terminalsPid(terminals, paneId) {
  const { panes } = await hostCall(terminals.pipePath(), "pane.list");
  return panes.find((p) => p.pane_id === paneId)?.pid ?? 0;
}
