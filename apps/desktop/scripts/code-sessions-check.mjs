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
      const session = ctx.codeLink.store.createSession(project.id, { repoId: "check", branch: `${item.key.toLowerCase()}/check`, itemIds: [item.id], mode: "terminal", agent: "claude-code", threadId: null, device: "check", worktree: cwd });
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
      win = BrowserWindow.getAllWindows().find((w) => w.getTitle().startsWith("代码会话"));
      if (!win) await sleep(100);
    }
    check("窗口打开，标题带项目名", win?.getTitle() === `代码会话 — ${project.name}`, win?.getTitle());
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
    const sessionsWindow = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getTitle().startsWith("代码会话"));
    let forward = true;
    let focusedTitle = "";
    for (let i = 0; i < 3; i++) {
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
      await sleep(500);
    }
    front.destroy();
    check("关掉再打开（三次）、被别的窗口挡住时再点，窗口都到最前并获得焦点", forward, `focused: ${focusedTitle}`);
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
