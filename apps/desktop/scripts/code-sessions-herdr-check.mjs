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
import { app, BrowserWindow, clipboard } from "electron";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import { agentLinks, changedLinks } from "./agent-links.mjs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-code-sessions-"));
const shots = process.env.TOMRADE_CHECK_SHOTS ?? work;
// Inside a herdr pane HERDR_SOCKET_PATH names the person's server and wins over HERDR_SESSION: drop the pane's variables
// so this run, everything it spawns and the Tomrade under test reach only the server started here.
for (const key of ["HERDR_SOCKET_PATH", "HERDR_CLIENT_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_ENV"]) delete process.env[key];
const HERDR_SESSION = `tomrade-cs-check-${process.pid}`;
process.env.HERDR_SESSION = HERDR_SESSION;
const ownSocket = path.join(os.homedir(), ".config/herdr/sessions", HERDR_SESSION, "herdr.sock");
app.setPath("userData", work);
// These read the DOM renderer's rows: without the GPU there is no WebGL, so a cell also shows it carries on without.
app.commandLine.appendSwitch("disable-gpu");
app.on("window-all-closed", () => {});

/**
 * The window drives on while other windows cover it, as it does for a person looking at it: covered, Chromium would
 * pause its animation frames, and a step waiting on one (the keyboard following a selected pane) would never see it.
 */
const awake = (w) => {
  w?.webContents.setBackgroundThrottling(false);
  return w;
};
const results = [];
// What the person's agents name as Tomrade before this run, to find unchanged at its end.
const linksBefore = agentLinks();
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
    // Every terminal stream core opens, watched for the typing steps' failure reports: its pane, when it opened and
    // closed, its last frame, and what was typed into it (and whether it was closed by then).
    const streams = [];
    const herdrService = ctx.get("herdr");
    const openStream = herdrService.terminal.bind(herdrService);
    herdrService.terminal = async (pane, opts) => {
      const stream = await openStream(pane, opts);
      const seen = { pane, mode: opts?.mode ?? "control", opened: Date.now(), closed: null, lastFrame: null, typed: [] };
      streams.push(seen);
      stream.onFrame(() => (seen.lastFrame = Date.now()));
      stream.onClose((reason) => (seen.closed = { at: Date.now(), reason }));
      const input = stream.input;
      stream.input = (data) => {
        seen.typed.push({ at: Date.now(), data, closed: stream.closed });
        input(data);
      };
      return stream;
    };
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
      win = BrowserWindow.getAllWindows().find((w) => w.getTitle().endsWith(" — 终端"));
      if (!win) await sleep(100);
    }
    check("窗口打开，标题以项目名开头", win?.getTitle() === `${project.name} — 终端`, win?.getTitle());
    awake(win);
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
    // The window as typing sees it, element@cell for where things are: whether it has the keyboard, where the keyboard
    // is, the selected cell, what cell i's textarea holds and any "detached" it shows, and the key and input events
    // heard since the last look.
    const typingState = (i) => `(() => {
      const cells = [...document.querySelectorAll('.cs-cell')];
      const at = (el) => (!el || el === document.body ? 'none' : el.tagName.toLowerCase() + '@' + [...document.querySelectorAll('.cs-cell')].findIndex((c) => c.contains(el)));
      if (!window.__typingHeard) {
        window.__typingHeard = true;
        for (const type of ['focusin', 'focusout', 'keydown', 'keypress', 'keyup', 'input', 'compositionstart', 'compositionend'])
          document.addEventListener(type, (e) => window.__typing.push([type, at(e.target), e.inputType, e.data ?? e.key].filter(Boolean).join(' ')), true);
      }
      const now = { visible: document.visibilityState, focus: document.hasFocus(), keyboard: at(document.activeElement), selected: cells.findIndex((c) => c.dataset.focused), textarea: cells[${i}]?.querySelector('.xterm-helper-textarea')?.value ?? null, detached: cells[${i}]?.querySelector('.cs-term-closed')?.textContent ?? null, heard: window.__typing ?? [] };
      window.__typing = [];
      return now;
    })()`;
    // Typed into a cell's terminal until its output shows there: a shell still starting (after a restore) drops what
    // it was sent, so a few tries, each waiting on the output rather than a fixed time. A failed try logs what the
    // window saw, the streams core typed it into, and what the cell and the panes (those streams', and `pane`) held.
    const typeInCell = async (wc, run, i, command, marker, seen = async () => (await run(`document.querySelectorAll('.cs-cell')[${i}]?.textContent ?? ''`)).includes(marker), pane = null) => {
      const inCell = `document.activeElement?.closest('.cs-cell') === document.querySelectorAll('.cs-cell')[${i}]`;
      for (let attempt = 0; attempt < 3; attempt++) {
        // The window moves the keyboard itself when a pane is selected; type only once it is in this cell.
        if (!(await run(`!!document.querySelectorAll('.cs-cell')[${i}]?.querySelector('.xterm-helper-textarea')`))) return false;
        const from = Date.now();
        await run(typingState(i));
        await run(`document.querySelectorAll('.cs-cell')[${i}].querySelector('.xterm-helper-textarea').focus(); true`);
        await wait(async () => run(inCell), 2000);
        const before = await run(typingState(i));
        wc.insertText(command);
        await sleep(200);
        const typed = await run(typingState(i));
        wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
        wc.sendInputEvent({ type: "char", keyCode: "\r" });
        wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
        // A covered or minimised window draws no frames, so its cell shows nothing new though its terminal has it: then the
        // echo is read from the panes core typed into (a line of its own, not the command typed), and the step says so.
        const drawn = async () => {
          if (await seen()) return true;
          if ((await run("document.visibilityState")) !== "hidden") return false;
          const typedInto = [...new Set(streams.filter((s) => s.typed.some((t) => t.at >= from)).map((s) => s.pane))];
          const lines = (p) => {
            try {
              return herdr("pane", "read", p, "--source", "recent", "--lines", "20").split("\n");
            } catch {
              return [];
            }
          };
          const echoed = typedInto.find((p) => lines(p).some((l) => l.trim() === marker));
          if (echoed) console.log(`INFO: typing into cell ${i}: the window was hidden, so the cell drew nothing; the echo was read from herdr's pane ${echoed}`);
          return !!echoed;
        };
        if (await wait(drawn, 8000)) return true;
        const after = await run(typingState(i));
        const tail = (text) => text.replace(/\s+$/, "").slice(-300);
        const shown = tail(await run(`[...(document.querySelectorAll('.cs-cell')[${i}]?.querySelectorAll('.xterm-rows > div') ?? [])].map((r) => r.textContent).join('\\n')`));
        // Core's side, in ms from the try's start: every stream of the panes this try's keys reached, or that none took them.
        const reached = [...new Set(streams.filter((s) => s.typed.some((t) => t.at >= from)).map((s) => s.pane))];
        const ms = (t) => (t == null ? null : t - from);
        const core = reached.length
          ? streams.filter((s) => reached.includes(s.pane)).map((s) => ({ pane: s.pane, opened: ms(s.opened), closed: s.closed && { at: ms(s.closed.at), reason: s.closed.reason?.split("\n")[0] }, lastFrame: ms(s.lastFrame), typed: s.typed.filter((t) => t.at >= from).map((t) => `${t.closed ? "(closed) " : ""}${t.data}`) }))
          : "no stream took it";
        const held = [...new Set([...reached, ...(pane ? [pane] : [])])].map((p) => {
          try {
            return `${p}: ${tail(herdr("pane", "read", p, "--source", "recent", "--lines", "20"))}`;
          } catch (error) {
            return `${p}: ${error.message.split("\n")[0]}`;
          }
        });
        console.log(`INFO: typing into cell ${i}, try ${attempt + 1} of 3 — before: ${JSON.stringify(before)} · typed: ${JSON.stringify(typed)} · after Enter: ${JSON.stringify(after)} · core: ${JSON.stringify(core)} · cell: ${JSON.stringify(shown)} · pane: ${JSON.stringify(held)}`);
      }
      return false;
    };
    check("侧栏列出六个会话", await wait(async () => (await js(`document.querySelectorAll('.cs-row').length`)) === 6));
    check("六个格子同时连上终端", await wait(async () => (await js(`document.querySelectorAll('.cs-cell .xterm').length`)) === 6));
    // A pane selected: its session is the list's one current row, wherever the selection goes next; all six still read as shown.
    const selectPane = async (i) => {
      await js(`document.querySelectorAll('.cs-cell')[${i}].querySelector('.cs-cell-bar').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
      return wait(async () => {
        const rows = await js(`[...document.querySelectorAll('.cs-row[aria-current="true"]')].map((r) => r.textContent)`);
        return rows.length === 1 && rows[0].includes(sessions[i].item.key);
      }, 3000);
    };
    const followed = (await selectPane(4)) && (await selectPane(1));
    const shownRows = await js(`document.querySelectorAll('.cs-row[data-active]').length`);
    check("选中面板时，侧栏只把它的会话标成当前，其余显示中的会话仍有标记", followed && shownRows === 6, `current: ${await js(`[...document.querySelectorAll('.cs-row[aria-current="true"]')].map((r) => r.textContent).join(" | ")`)}, shown: ${shownRows}`);
    // On Tomrade's theme: the terminal's background is its pane's, nothing dark around light, and its ANSI colours are the theme's.
    const colours = await js(`(() => {
      const term = document.querySelector('.cs-cell .cs-term');
      const viewport = term.querySelector('.xterm-viewport');
      return { pane: getComputedStyle(term).backgroundColor, terminal: getComputedStyle(viewport).backgroundColor };
    })()`);
    const rgb = (css) => (css.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
    const near = (a, b) => a.length === 3 && b.length === 3 && a.every((v, i) => Math.abs(v - b[i]) <= 2);
    check("终端底色就是面板底色（Tomrade 主题，不再是深色）", near(rgb(colours.pane), rgb(colours.terminal)) && !near(rgb(colours.terminal), [30, 30, 30]), JSON.stringify(colours));
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

    // herdr's scrollback has a bar: unseen at rest, shown while the view moves and gone a second after; dragging it scrolls the pane.
    const wideCell = `document.querySelectorAll('.cs-cell')[2]`;
    const paneScroll = () => JSON.parse(herdr("pane", "get", sessions[2].pane)).result.pane.scroll ?? {};
    const bar = () => js(`(() => {
      const bar = ${wideCell}.querySelector('.cs-scrollbar');
      if (!bar) return null;
      const t = bar.querySelector('.cs-scrollbar-thumb').getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      return { shown: bar.dataset.shown === 'true', opacity: Number(getComputedStyle(bar).opacity), above: Math.round(t.top - b.top), below: Math.round(b.bottom - t.bottom), x: Math.round(t.left + t.width / 2), y: Math.round(t.top + t.height / 2), trackTop: Math.round(b.top) };
    })()`);
    herdr("pane", "run", sessions[2].pane, "seq 1 400");
    const atRest = await wait(async () => {
      const b = await bar();
      return !!b && b.below < 2 && !b.shown && b.opacity === 0;
    });
    check("输出超过一屏后有滚动条，不滚动时看不见", atRest, JSON.stringify({ bar: await bar(), scroll: paneScroll() }));
    await js(`${wideCell}.querySelector('.xterm-screen').dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true }))`);
    const scrolledUp = await wait(async () => {
      const b = await bar();
      return !!b && b.shown && b.below > 2 && paneScroll().offset_from_bottom > 0;
    }, 5000);
    check("滚动时滚动条出现，滑块离开底部", scrolledUp, JSON.stringify({ bar: await bar(), scroll: paneScroll() }));
    const hidAgain = await wait(async () => (await bar())?.opacity === 0, 4000);
    check("停止滚动约一秒后滚动条自动隐藏", hidAgain, JSON.stringify(await bar()));
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
    const draggedTop = await wait(() => {
      const s = paneScroll();
      return s.max_offset_from_bottom > 0 && s.offset_from_bottom === s.max_offset_from_bottom;
    }, 5000);
    check("把滑块拖到顶：pane 滚到最早的输出", draggedTop, JSON.stringify({ bar: await bar(), scroll: paneScroll() }));
    fs.writeFileSync(path.join(shots, "code-sessions-scrollbar.png"), (await win.webContents.capturePage()).toPNG());

    // A selection moves with the text when the pane scrolls, and a copy still takes it once it is out of view.
    const screen = await js(`(() => {
      const r = ${wideCell}.querySelector('.xterm-screen').getBoundingClientRect();
      const rows = ${wideCell}.querySelectorAll('.xterm-rows > div').length;
      return { left: Math.round(r.left), right: Math.round(r.right), top: r.top, row: r.height / rows };
    })()`);
    const selectionTop = () => js(`(() => { const s = ${wideCell}.querySelector('.xterm-selection div'); return s ? s.getBoundingClientRect().top : null; })()`);
    const copied = async () => {
      clipboard.clear();
      win.webContents.copy();
      await sleep(200);
      return clipboard.readText();
    };
    {
      const wc = win.webContents;
      const y = (row) => Math.round(screen.top + (row + 0.5) * screen.row);
      wc.sendInputEvent({ type: "mouseMove", x: screen.left + 2, y: y(10) });
      wc.sendInputEvent({ type: "mouseDown", x: screen.left + 2, y: y(10), button: "left", clickCount: 1 });
      for (let row = 10; row <= 12; row++) {
        wc.sendInputEvent({ type: "mouseMove", x: screen.right - 2, y: y(row), modifiers: ["leftButtonDown"] });
        await sleep(30);
      }
      wc.sendInputEvent({ type: "mouseUp", x: screen.right - 2, y: y(12), button: "left", clickCount: 1 });
    }
    await sleep(300);
    const picked = await copied();
    const pickedAt = await selectionTop();
    const offsetBefore = paneScroll().offset_from_bottom;
    // One notch (deltaY 120) scrolls six rows.
    await js(`${wideCell}.querySelector('.xterm-screen').dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))`);
    const stepped = await wait(() => paneScroll().offset_from_bottom === offsetBefore - 6, 3000);
    // xterm draws no selection while the window is hidden; then the copy alone tells where the selection is.
    if (pickedAt === null) console.log("INFO: the selection was not drawn (the window is hidden); checking it by what a copy takes");
    const moved = async () => {
      const at = await selectionTop();
      return pickedAt === null || (at !== null && Math.abs(at - (pickedAt - 6 * screen.row)) < 2);
    };
    const stayed = await wait(async () => (await moved()) && (await copied()) === picked, 3000);
    check("滚轮一格滚六行", stepped, JSON.stringify({ before: offsetBefore, now: paneScroll() }));
    check("选中文本后滚动，选区跟着文本走，复制的还是原来那几行", picked.split("\n").length === 3 && stayed, JSON.stringify({ picked, copied: await copied(), pickedAt, now: await selectionTop(), row: screen.row }));
    await js(`${wideCell}.querySelector('.xterm-screen').dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }))`);
    await wait(() => paneScroll().offset_from_bottom === offsetBefore - 18, 3000);
    const outOfView = await wait(async () => (await selectionTop()) === null && (await copied()) === picked, 3000);
    check("选区滚出视野后不再画在屏幕上，复制仍拿到整段", outOfView, JSON.stringify({ copied: await copied(), now: await selectionTop(), scroll: paneScroll() }));
    await ctx.herdr.scrollTo(sessions[2].pane, 0);

    // Focus that enters a pane without a click (Tab, a file drop, a script) selects it: the border marks where typing goes.
    // A window without focus gets no focus events, so the step needs this app in front.
    win.focus();
    await sleep(300);
    if (await js(`document.hasFocus()`)) {
      await js(`document.querySelectorAll('.cs-cell')[3].querySelector('.xterm-helper-textarea').focus(); true`);
      const focusSelects = await wait(async () => js(`(() => { const cell = document.querySelectorAll('.cs-cell')[3]; const rows = [...document.querySelectorAll('.cs-row[aria-current="true"]')]; return cell.hasAttribute('data-focused') && rows.length === 1 && rows[0].textContent.includes(${JSON.stringify(sessions[3].item.key)}); })()`), 3000);
      check("键盘焦点进入面板（不点击）也会选中它：边框和侧栏当前行都跟着走", focusSelects);
    } else console.log("INFO: skipped the focus-selects step — another app is in front, so this window gets no focus events");
    await selectPane(3);

    // One agent claims a second ticket alongside, in the same pane: the two rows sit together, the one the pane does not
    // read as is marked as on it, and picking it makes the pane read as that ticket without attaching again.
    const alongItem = ctx.items.create({ projectId: project.id, boardId: board.id, title: "Marker four, alongside", workType: "coding", status: "doing", by: "human" });
    const along = ctx.codeLink.store.createSession(project.id, { repoId: "check", branch: `${alongItem.key.toLowerCase()}/check`, itemIds: [alongItem.id], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: cwd });
    ctx.codeLink.store.patchSession(project.id, along.id, { state: "running", herdrPane: sessions[3].pane });
    ctx.emit("codeLink/changed", project.id);
    const rowWith = (key) => `[...document.querySelectorAll('.cs-row')].find((r) => r.textContent.includes(${JSON.stringify(key)}))`;
    const bundled = await wait(async () => js(`(() => { const b = [...document.querySelectorAll('[data-testid=cs-bundle]')]; return b.length === 1 && b[0].hasAttribute('data-selected') && b[0].querySelectorAll('.cs-row').length === 2 && b[0].textContent.includes(${JSON.stringify(sessions[3].item.key)}) && b[0].textContent.includes(${JSON.stringify(alongItem.key)}); })()`), 5000);
    const marks = () => js(`[${rowWith(sessions[3].item.key)}, ${rowWith(alongItem.key)}].map((r) => [r?.getAttribute('aria-current') ?? '', r?.dataset.bound ?? ''])`);
    const bundleMarks = await marks();
    check("同一面板里并行认领的工单在侧栏放在一组，当前工单高亮，另一个标成「在这个面板」", bundled && JSON.stringify(bundleMarks) === JSON.stringify([["true", ""], ["", "selected"]]), JSON.stringify(bundleMarks));
    fs.writeFileSync(path.join(shots, "code-sessions-bundle.png"), (await win.webContents.capturePage()).toPNG());
    const streamsBefore = streams.length;
    await js(`${rowWith(alongItem.key)}.click(); true`);
    const switched = await wait(async () => JSON.stringify(await marks()) === JSON.stringify([["", "selected"], ["true", ""]]) && (await js(`document.querySelectorAll('.cs-cell')[3].querySelector('.cs-cell-name').textContent`)).startsWith(`${alongItem.key} `), 3000);
    await sleep(800);
    check("点同组的另一个工单：面板改为显示它、侧栏当前行跟过去，终端不重连", switched && streams.length === streamsBefore, JSON.stringify({ marks: await marks(), streamsBefore, now: streams.length }));
    await js(`${rowWith(sessions[3].item.key)}.click(); true`);
    check("再点回原工单，面板和当前行都回来", await wait(async () => JSON.stringify(await marks()) === JSON.stringify(bundleMarks), 3000), JSON.stringify(await marks()));
    // The ticket the locked pane reads as finishes while the agent goes on there: the pane stays, as the other ticket.
    await js(`${rowWith(alongItem.key)}.click(); true`);
    await wait(async () => (await js(`document.querySelectorAll('.cs-cell')[3].querySelector('.cs-cell-name').textContent`)).startsWith(`${alongItem.key} `), 3000);
    await js(`document.querySelectorAll('.cs-cell')[3].querySelector('[data-testid=cs-lock]').click(); true`);
    const endedAt = Date.now();
    ctx.codeLink.store.patchSession(project.id, along.id, { state: "ended", endedAt });
    ctx.emit("codeLink/changed", project.id);
    const cellFour = () => js(`(() => { const cell = document.querySelectorAll('.cs-cell')[3]; return { name: cell.querySelector('.cs-cell-name').textContent, terminal: !!cell.querySelector('.xterm'), ended: !!cell.querySelector('[data-testid=cs-ended]'), locked: cell.hasAttribute('data-locked') }; })()`);
    const carried = await wait(async () => {
      const c = await cellFour();
      return c.name.startsWith(`${sessions[3].item.key} `) && c.terminal && !c.ended && c.locked;
    }, 8000);
    const carriedText = await wait(async () => (await terminalText(3)).includes("marker-four"), 10000);
    const sameStream = !streams.some((x) => x.pane === sessions[3].pane && x.opened >= endedAt);
    check("面板显示的工单结束、同一 agent 还在这个面板做别的工单：格子留在面板上改显示那个工单，锁保持，终端不重连", carried && carriedText && sameStream, JSON.stringify({ ...(await cellFour()), text: (await terminalText(3)).trim().slice(0, 200), streams: streams.filter((x) => x.pane === sessions[3].pane).map((x) => ({ opened: x.opened - endedAt, closed: x.closed && { at: x.closed.at - endedAt, reason: x.closed.reason }, lastFrame: x.lastFrame && x.lastFrame - endedAt })) }));
    await js(`document.querySelectorAll('.cs-cell')[3].querySelector('[data-testid=cs-lock]').click(); true`);
    await wait(async () => (await js(`document.querySelectorAll('.cs-row').length`)) === 6 && !(await cellFour()).locked, 5000);

    // Every pane full and a seventh session in the list: a pick never silently hides what a pane showed.
    const seventhItem = ctx.items.create({ projectId: project.id, boardId: board.id, title: "Marker seven", workType: "coding", status: "doing", by: "human" });
    const seventhPane = await ctx.herdr.launch({ cwd, label: seventhItem.key, command: "echo marker-seven", workspace: { key: project.id, label: project.name } });
    const seventh = ctx.codeLink.store.createSession(project.id, { repoId: "check", branch: `${seventhItem.key.toLowerCase()}/check`, itemIds: [seventhItem.id], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: cwd });
    ctx.codeLink.store.patchSession(project.id, seventh.id, { state: "running", herdrPane: seventhPane.paneId });
    ctx.emit("codeLink/changed", project.id);
    await wait(async () => (await js(`document.querySelectorAll('.cs-row').length`)) === 7, 8000);
    const cellNames = () => js(`[...document.querySelectorAll('.cs-cell .cs-cell-name')].map((n) => n.textContent)`);
    const cellShows = async (key) => (await cellNames()).some((n) => n.startsWith(`${key} `));
    const seventhRow = `[...document.querySelectorAll('.cs-row')].find((r) => r.textContent.includes(${JSON.stringify(seventhItem.key)}))`;
    const undoPick = async (sixShown) => {
      await js(`document.querySelector('[data-testid=cs-toast-action]').click(); true`);
      return wait(async () => JSON.stringify(await cellNames()) === JSON.stringify(sixShown), 3000);
    };
    const sixShown = await cellNames();
    // The selected pane locked: the pick lands in another pane, says what left it, and Undo puts that back.
    await js(`document.querySelectorAll('.cs-cell')[3].querySelector('[data-testid=cs-lock]').click(); true`);
    const lockOn = await wait(async () => js(`(() => { const cell = document.querySelectorAll('.cs-cell')[3]; return cell.hasAttribute('data-locked') && cell.querySelector('[data-testid=cs-lock]').getAttribute('aria-pressed') === 'true'; })()`), 3000);
    await js(`${seventhRow}.click(); true`);
    const pickedAside = await wait(async () => cellShows(seventhItem.key), 3000);
    const namesLocked = await cellNames();
    const pickToast = await js(`document.querySelector('[data-testid=cs-toast]')?.textContent ?? ''`);
    check("锁住的面板不会被侧栏点击替换：会话换进别的面板，并提示「已移出面板」可撤销", lockOn && pickedAside && namesLocked[3]?.startsWith(`${sessions[3].item.key} `) && pickToast.includes("已移出面板") && pickToast.includes("撤销"), JSON.stringify({ namesLocked, pickToast }));
    check("撤销后被换下的会话回到原来的面板", await undoPick(sixShown), JSON.stringify(await cellNames()));
    // A session that needs you in the selected pane: it stays, the pick goes elsewhere.
    ctx.codeLink.store.patchSession(project.id, sessions[5].id, { state: "waiting", blocked: "merge" });
    ctx.emit("codeLink/changed", project.id);
    await wait(async () => js(`[...document.querySelectorAll('.cs-row[data-needs]')].some((r) => r.textContent.includes(${JSON.stringify(sessions[5].item.key)}))`), 5000);
    const barChip = (key) => js(`(() => { const cell = [...document.querySelectorAll('.cs-cell')].find((c) => c.querySelector('.cs-cell-name')?.textContent.startsWith(${JSON.stringify(`${key} `)})); const chip = cell?.querySelector('.cs-cell-bar [data-testid=cs-state]'); return chip ? [chip.dataset.state, chip.textContent] : null; })()`);
    const needsBar = await wait(async () => (await barChip(sessions[5].item.key))?.[0] === "needs", 3000);
    const runningBar = await barChip(sessions[4].item.key);
    check("每个面板的标题栏标出会话状态：需要你、运行中", needsBar && runningBar?.[1] === "运行中", JSON.stringify({ needs: await barChip(sessions[5].item.key), running: runningBar }));
    const cellOf = (key) => `[...document.querySelectorAll('.cs-cell')].find((c) => c.querySelector('.cs-cell-name')?.textContent.startsWith(${JSON.stringify(`${key} `)}))`;
    const waitBorder = await js(`(() => { const cell = ${cellOf(sessions[5].item.key)}; const run = ${cellOf(sessions[4].item.key)}; const probe = document.createElement('div'); probe.style.color = 'var(--warn)'; document.body.append(probe); const want = getComputedStyle(probe).color; probe.remove(); return { wait: !!cell?.hasAttribute('data-wait'), border: cell ? getComputedStyle(cell).borderTopColor : null, want, runWait: !!run?.hasAttribute('data-wait'), runBorder: run ? getComputedStyle(run).borderTopColor : null }; })()`);
    check("等你的格子边框标橙，运行中的不标", waitBorder.wait && waitBorder.border === waitBorder.want && !waitBorder.runWait && waitBorder.runBorder !== waitBorder.want, JSON.stringify(waitBorder));
    await selectPane(5);
    await js(`${seventhRow}.click(); true`);
    const needsKept = (await wait(async () => cellShows(seventhItem.key), 3000)) && (await cellNames())[5]?.startsWith(`${sessions[5].item.key} `);
    check("等你处理的会话不会被侧栏点击换下", needsKept, JSON.stringify(await cellNames()));
    check("再次撤销也回到原样", await undoPick(sixShown), JSON.stringify(await cellNames()));
    ctx.codeLink.store.patchSession(project.id, sessions[5].id, { state: "running", blocked: null });
    ctx.emit("codeLink/changed", project.id);
    // ⌘-click (Ctrl-click elsewhere) opens it in a new pane beside the selected one; the six stay as they were.
    await js(`${seventhRow}.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: ${process.platform === "darwin"}, ctrlKey: ${process.platform !== "darwin"} })); true`);
    const besideShown = await wait(async () => (await js(`document.querySelectorAll('.cs-cell').length`)) === 7 && (await cellShows(seventhItem.key)), 3000);
    const besideOthers = (await cellNames()).filter((n) => !n.startsWith(`${seventhItem.key} `));
    check("⌘ 点击在新面板中打开，原来的六个面板不变", besideShown && JSON.stringify(besideOthers) === JSON.stringify(sixShown), JSON.stringify(await cellNames()));
    // ⌘-click on what a pane already shows: that pane is selected, nothing opens a second time.
    const sevenCells = await js(`document.querySelectorAll('.cs-cell').length`);
    await js(`${seventhRow}.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: ${process.platform === "darwin"}, ctrlKey: ${process.platform !== "darwin"} })); true`);
    await sleep(800);
    const once = (await js(`document.querySelectorAll('.cs-cell').length`)) === sevenCells && (await cellNames()).filter((n) => n.startsWith(`${seventhItem.key} `)).length === 1;
    check("⌘ 点击已经在面板里的会话：选中那个面板，不再开第二份", once, JSON.stringify(await cellNames()));
    await js(`(() => { const cell = [...document.querySelectorAll('.cs-cell')].find((c) => c.querySelector('.cs-cell-name').textContent.startsWith(${JSON.stringify(`${seventhItem.key} `)})); [...cell.querySelectorAll('.cs-cell-tools .icon-btn')].at(-1).click(); return true; })()`);
    await js(`document.querySelectorAll('.cs-cell')[3].querySelector('[data-testid=cs-lock]').click(); true`);
    const sixBack = await wait(async () => (await js(`document.querySelectorAll('.cs-cell').length === 6 && !document.querySelector('.cs-cell[data-locked]')`)) && JSON.stringify(await cellNames()) === JSON.stringify(sixShown), 3000);
    check("关掉新面板、解锁后回到原来的六个面板", sixBack, JSON.stringify(await cellNames()));
    await wait(async () => (await js(`document.querySelectorAll('.cs-cell .xterm').length`)) === 6, 10000);
    await selectPane(1);

    // Text committed the way an input method commits it, into the wide-character pane's shell.
    const ime = await typeInCell(win.webContents, js, 2, "echo 输入法提交", "输入法提交", async () => herdr("pane", "read", sessions[2].pane, "--source", "recent", "--lines", "20").includes("输入法提交"), sessions[2].pane);
    check("像输入法那样提交的中文进到了 pane", ime);

    // Files dropped from outside onto a terminal: a real file goes in as its escaped path; one without a path sends nothing.
    const dropped = path.join(work, "拖入 文件(1).txt");
    fs.writeFileSync(dropped, "drop");
    await js(`(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'cs-drop-probe'; i.style.display = 'none'; document.body.append(i); return true; })()`);
    win.webContents.debugger.attach("1.3");
    const { root } = await win.webContents.debugger.sendCommand("DOM.getDocument");
    const { nodeId } = await win.webContents.debugger.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: "#cs-drop-probe" });
    await win.webContents.debugger.sendCommand("DOM.setFileInputFiles", { nodeId, files: [dropped] });
    win.webContents.debugger.detach();
    const dropOn = (files) => js(`(() => {
      const term = document.querySelectorAll('.cs-cell')[4].querySelector('.cs-term');
      const data = new DataTransfer();
      ${files === "real" ? "data.items.add(document.getElementById('cs-drop-probe').files[0]);" : "data.items.add(new File(['x'], 'from-a-page.png', { type: 'image/png' }));"}
      term.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data }));
      term.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      // A drag-over is not drawn at once: wait for the hint, a little, before letting go. On a timer, not animation
      // frames: a hidden window or a sleeping display draws none, and the wait would never end.
      return new Promise((resolve) => {
        const end = Date.now() + 2000;
        const look = () => {
          const shown = !!term.querySelector('.cs-term-drop')?.textContent;
          if (!shown && Date.now() < end) return setTimeout(look, 30);
          term.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
          resolve(shown);
        };
        look();
      });
    })()`);
    const paneFive = () => herdr("pane", "read", sessions[4].pane, "--source", "recent", "--lines", "20");
    const untouched = paneFive();
    const hinted = await dropOn("page");
    await sleep(1000);
    check("拖到终端上时格子提示可以放下", hinted, `no hint within 2 s; the page is ${await js("document.visibilityState")}`);
    check("没有真实路径的拖入什么也不发", paneFive() === untouched, paneFive().slice(-200));
    await dropOn("real");
    const pasted = await wait(async () => paneFive().includes("拖入\\ 文件\\(1\\).txt"));
    check("拖入的文件以转义后的路径输入到终端", pasted, paneFive().slice(-300));
    check("拖放后键盘焦点在那个终端", await js(`document.activeElement === document.querySelectorAll('.cs-cell')[4].querySelector('.xterm-helper-textarea')`));
    const guarded = await js(`(() => { const e = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }); document.querySelector('.cs-side').dispatchEvent(e); return e.defaultPrevented; })()`);
    check("拖到终端以外的地方不会把窗口导航走", guarded);

    // iTerm2's pane keys, pressed while a terminal has the keyboard: the window takes them, the shell never sees them.
    const press = (keyCode, modifiers) => {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    };
    const paneCells = () => js(`(() => { const cells = [...document.querySelectorAll('.cs-cell')]; return { count: cells.length, selected: cells.findIndex((c) => c.dataset.focused), typing: cells.findIndex((c) => c.contains(document.activeElement)), empty: cells.map((c) => !c.querySelector('.xterm')) }; })()`);
    const settled = (want) => wait(async () => {
      const now = await paneCells();
      return Object.entries(want).every(([k, v]) => JSON.stringify(now[k]) === JSON.stringify(v));
    }, 5000);
    await js(`(() => { const cell = document.querySelectorAll('.cs-cell')[3]; cell.querySelector('.cs-cell-bar').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); cell.querySelector('.xterm-helper-textarea').focus(); return true; })()`);
    const rowsBefore = await js(`document.querySelectorAll('.cs-row').length`);
    // Split like iTerm: the new half is a plain shell, in the folder of the cell it came from, and selected.
    const savedTerminals = () => JSON.parse(fs.readFileSync(path.join(work, "code-sessions.json"), "utf8")).terminals?.[project.id] ?? [];
    const terminalsBefore = savedTerminals().length;
    press("D", ["meta"]);
    const splitRight = await settled({ count: 7, selected: 4 });
    const rightShell = await wait(async () => (await paneCells()).empty[4] === false && savedTerminals().length === terminalsBefore + 1, 10000);
    press("D", ["meta", "shift"]);
    const splitDown = await settled({ count: 8, selected: 5 });
    const downShell = await wait(async () => (await paneCells()).empty[5] === false && savedTerminals().length === terminalsBefore + 2, 10000);
    const splitFolders = savedTerminals().slice(terminalsBefore).map((t) => t.cwd);
    check("⌘D 向右分屏、⇧⌘D 向下分屏：分出来就是 shell（不问 agent），文件夹跟着当前格子，并被选中", splitRight && rightShell && splitDown && downShell && splitFolders.every((f) => f === cwd || f === fs.realpathSync(cwd)), JSON.stringify({ cells: await paneCells(), splitFolders, cwd }));
    press("Left", ["meta", "alt"]);
    const wentLeft = await settled({ selected: 3, typing: 3 });
    press("Right", ["meta", "alt"]);
    const wentRight = await settled({ selected: 4 });
    check("⌥⌘← / ⌥⌘→ 选中旁边的面板，键盘跟着进到它的终端", wentLeft && wentRight, JSON.stringify(await paneCells()));
    // The two shells end, so the list is as it was; their cells stay until closed.
    for (const t of savedTerminals().slice(terminalsBefore)) await js(`(() => { const cell = document.querySelector('.cs-cell[data-cell-terminal="${t.id}"]'); [...(cell?.querySelectorAll('.cs-cell-bar .link-btn') ?? [])].find((b) => b.textContent === '关闭终端')?.click(); return true; })()`);
    await wait(async () => savedTerminals().length === terminalsBefore && (await js(`document.querySelectorAll('.cs-row').length`)) === rowsBefore, 8000);
    await js(`document.querySelectorAll('.cs-cell')[4].querySelector('.cs-cell-bar').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
    await settled({ selected: 4 });
    press("W", ["meta"]);
    const closedOne = await settled({ count: 7, selected: 4 });
    press("W", ["meta"]);
    const closedTwo = await settled({ count: 6, selected: 3 });
    const rowsAfter = await js(`document.querySelectorAll('.cs-row').length`);
    check("⌘W 关掉选中的面板，会话还在列表里", closedOne && closedTwo && rowsAfter === rowsBefore, `${JSON.stringify(await paneCells())} · rows ${rowsBefore} → ${rowsAfter}`);
    // Moved in the layout, the cell attached its terminal again: typing waits for its picture.
    await wait(async () => (await terminalText(3)).includes("marker-four"));
    await js(`document.querySelectorAll('.cs-cell')[3].querySelector('.xterm-helper-textarea').focus(); true`);
    win.webContents.insertText("echo after-pane-keys");
    await sleep(200);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    // Its output on a line of its own: a key that had leaked into the shell would have spoiled the command.
    const ranClean = await wait(async () => herdr("pane", "read", sessions[3].pane, "--source", "recent", "--lines", "20").split("\n").some((l) => l.trim() === "after-pane-keys"), 10000);
    check("快捷键没有进到终端里：之后输入的命令原样执行并有回显", ranClean, herdr("pane", "read", sessions[3].pane, "--source", "recent", "--lines", "8").slice(-300));

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
    const coexist = await typeInCell(win.webContents, js, 3, "echo after-herdr-tui", "after-herdr-tui");
    const stillOpen = await js(`[...document.querySelectorAll('.cs-cell')].filter((c) => c.querySelector('.cs-term-closed')).length`);
    check("herdr 自己的 TUI 连着时，窗口仍能输入并看到输出", coexist, `closed cells: ${stillOpen}`);
    console.log(`INFO: with herdr's TUI attached → typed text shown: ${coexist}, cells let go: ${stillOpen}`);
    fs.writeFileSync(path.join(shots, "code-sessions-after.png"), (await win.webContents.capturePage()).toPNG());

    check("窗口说的是应用的语言", (await js(`document.querySelector('.cs-bar-title').textContent`)) === "会话");
    win.close();
    await sleep(500);
    check("关窗后 pane 还在 herdr 里跑", JSON.parse(herdr("pane", "list")).result.panes.length >= 6);
    // With no window, what the panes show is still recorded: herdr's observer watches each beside whoever holds it,
    // never taking it over; the session's raw output has what was typed after the window closed.
    const awayPane = sessions[2].pane;
    const closedAt = Date.now();
    await wait(async () => streams.some((st) => st.pane === awayPane && st.mode === "observe" && st.opened >= closedAt && !st.closed), 5000);
    herdr("pane", "send-text", awayPane, "echo bgmark-$((40+2))");
    herdr("pane", "send-keys", awayPane, "enter");
    const recordedAway = await wait(async () => {
      const raw = await ctx.serial("codeLink/raw-output", project.id, sessions[2].id);
      // A frame paints only the cells that changed: the words are read with the escapes between them taken out.
      const painted = (raw?.records ?? []).filter((r) => r.t >= closedAt).map((r) => Buffer.from(r.bytes).toString("utf8")).join("");
      return painted.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").includes("bgmark-42");
    }, 10000);
    const controlledAway = streams.filter((st) => st.pane === awayPane && st.opened >= closedAt && st.mode !== "observe").length;
    check("终端窗口关着时窗格照样录：herdr 只旁观（observe，不接管），关窗后敲的命令在会话的原始输出里", recordedAway && controlledAway === 0, JSON.stringify({ recordedAway, controlledAway, observers: streams.filter((st) => st.mode === "observe").length }));

    // Closed and opened again, and opened while another window is in front: it comes forward each time.
    const front = new BrowserWindow({ width: 1600, height: 1000, x: 0, y: 0, title: "app window stand-in" });
    await front.loadURL("about:blank");
    const sessionsWindow = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getTitle().endsWith(" — 终端"));
    // Focus only moves inside the app that is in front; macOS may keep it with the app the person is using.
    app.focus({ steal: true });
    front.focus();
    const canFocus = await wait(async () => BrowserWindow.getFocusedWindow() === front, 3000);
    let forward = true;
    let focusedTitle = "";
    // The person going to another app meanwhile takes focus from this whole app: then the step cannot tell, and says so.
    let interrupted = false;
    const cameForward = async (win, ms) => {
      await wait(async () => BrowserWindow.getFocusedWindow() === win, ms);
      const now = BrowserWindow.getFocusedWindow();
      if (!now) interrupted = true;
      else if (now !== win || !win?.isVisible()) {
        forward = false;
        focusedTitle = now.getTitle();
      }
    };
    for (let i = 0; i < 3 && canFocus && !interrupted; i++) {
      front.focus();
      await sleep(300);
      await ctx.contributions.run("code-sessions.open", { projectId: project.id });
      await wait(async () => !!sessionsWindow(), 10000);
      const again = sessionsWindow();
      await cameForward(again, 10000);
      front.focus();
      await sleep(300);
      await ctx.contributions.run("code-sessions.open", { projectId: project.id });
      await cameForward(again, 3000);
      again?.close();
      // Gone before the next round looks for the window by its title.
      await wait(async () => !again || again.isDestroyed(), 5000);
    }
    front.destroy();
    if (canFocus && !interrupted) check("关掉再打开（三次）、被别的窗口挡住时再点，窗口都到最前并获得焦点", forward, `focused: ${focusedTitle}`);
    else console.log(`INFO: skipped the focus step — ${canFocus ? "another app took focus while it ran" : "another app is in front"}, so this app's windows cannot take focus`);

    // A plain terminal from the list's button: every cell is taken, so it opens in a new one beside them.
    await ctx.contributions.run("code-sessions.open", { projectId: project.id });
    await wait(async () => sessionsWindow()?.isVisible() ?? false, 10000);
    let tw = awake(sessionsWindow());
    let tjs = (code) => tw.webContents.executeJavaScript(code, true);
    await wait(async () => (await tjs(`document.querySelectorAll('.cs-cell .xterm').length`)) === 6);
    await tjs(`document.querySelector('[data-testid=cs-side-new-terminal]').click(); true`);
    const opened = await wait(async () => (await tjs(`document.querySelectorAll('.cs-cell').length === 7 && !!document.querySelector('.cs-cell[data-cell-terminal] .xterm')`)));
    check("新终端：格子都占满时，在旁边新开一格并连上 herdr", opened);
    // Its bar's split button: a plain shell beside it, in the folder its shell has moved to since it opened.
    const termsNow = () => JSON.parse(fs.readFileSync(path.join(work, "code-sessions.json"), "utf8")).terminals?.[project.id] ?? [];
    const firstTerminal = await tjs(`document.querySelector('.cs-cell[data-cell-terminal]').dataset.cellTerminal`);
    const newPane = termsNow().find((t) => t.id === firstTerminal)?.pane;
    const movedTo = fs.realpathSync(fs.mkdtempSync(path.join(cwd, "moved-")));
    const shellCwd = () => JSON.parse(herdr("pane", "process-info", "--pane", newPane)).result.process_info.foreground_processes.map((p) => p.cwd);
    await sleep(800);
    herdr("pane", "send-text", newPane, `cd ${movedTo}`);
    herdr("pane", "send-keys", newPane, "enter");
    await wait(async () => shellCwd().some((d) => d && fs.realpathSync(d) === movedTo), 5000);
    await tjs(`document.querySelector('.cs-cell[data-cell-terminal] button[aria-label="向右分屏"]').click(); true`);
    const splitOff = () => termsNow().find((t) => t.id !== firstTerminal);
    const buttonShell = await wait(async () => !!splitOff()?.pane && (await tjs(`!!document.querySelector('.cs-cell[data-cell-terminal="${splitOff()?.id}"] .xterm')`)), 10000);
    const buttonFolder = splitOff()?.cwd;
    check("格子标题栏的分屏按钮分出来就是 shell，文件夹是当前格子的 shell 现在所在的目录", buttonShell && !!buttonFolder && fs.realpathSync(buttonFolder) === movedTo, JSON.stringify({ splitOff: splitOff(), movedTo, shell: shellCwd() }));
    // That shell ends and its cell is let go: an empty pane beside the terminal. Auto-place on, the agent in the terminal
    // starts and its hooks make it a session with no ticket on the same pane: it is not placed in the empty pane, and
    // the terminal's cell is not knocked off.
    const offId = splitOff()?.id;
    await tjs(`(() => { const cell = document.querySelector('.cs-cell[data-cell-terminal="${offId}"]'); [...(cell?.querySelectorAll('.cs-cell-bar .link-btn') ?? [])].find((b) => b.textContent === '关闭终端')?.click(); return true; })()`);
    await wait(async () => !splitOff(), 8000);
    await tjs(`(() => { const cell = [...document.querySelectorAll('.cs-cell')].find((c) => c.querySelector('[data-testid=cs-closed-terminal]') || (!c.querySelector('.xterm') && c.dataset.cell !== document.querySelector('.cs-cell[data-cell-terminal]')?.dataset.cell)); cell?.querySelector('.cs-cell-bar').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 20 })); return true; })()`);
    await sleep(300);
    await tjs(`[...document.querySelectorAll('[role=menuitem]')].find((i) => i.textContent === '断开')?.click(); true`);
    await wait(async () => (await tjs(`[...document.querySelectorAll('.cs-cell-name')].filter((n) => n.textContent === '从右侧选一个会话，在这里显示它的终端').length`)) === 1, 5000);
    const emptyText = await tjs(`[...document.querySelectorAll('.cs-cell')].find((c) => c.querySelector('.cs-cell-name').textContent === '从右侧选一个会话，在这里显示它的终端')?.querySelector('.cs-cell-empty > span')?.textContent ?? ''`);
    check("空格子写着「⌘D / ⇧⌘D 分出新格子，或 ⌘K 把会话放进来」，下面仍有文件夹和「新终端」", emptyText.includes("分出新格子") && emptyText.includes("把会话放进来") && (await tjs(`!!document.querySelector('.cs-cell-empty > .cs-new-terminal [data-testid=cs-new-terminal]')`)), emptyText);
    const cellsNow = await tjs(`document.querySelectorAll('.cs-cell').length`);
    const hooked = ctx.codeLink.store.createSession(project.id, { repoId: "check", branch: "", itemIds: [], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: cwd });
    ctx.codeLink.store.patchSession(project.id, hooked.id, { state: "running", herdrPane: newPane });
    ctx.emit("codeLink/changed", project.id);
    await sleep(2000);
    // Only the terminal's own cell counts: herdr's own TUI, still attached from above, may take other panes over.
    const single = await tjs(`(() => { const cell = document.querySelector('.cs-cell[data-cell-terminal]'); return [document.querySelectorAll('.cs-cell').length, !!cell?.querySelector('.xterm'), !!cell?.querySelector('.cs-term-closed')?.offsetParent, [...document.querySelectorAll('.cs-cell-name')].filter((n) => n.textContent === '从右侧选一个会话，在这里显示它的终端').length]; })()`);
    check("同一个 pane 上的会话不会被放进旁边的空面板，终端的格子也不会被挤掉", !!newPane && single[0] === cellsNow && single[1] && !single[2] && single[3] === 1, JSON.stringify({ cellsNow, single }));
    // The empty pane goes again, for what follows.
    await tjs(`(() => { const empty = [...document.querySelectorAll('.cs-cell')].find((c) => c.querySelector('.cs-cell-name').textContent === '从右侧选一个会话，在这里显示它的终端'); empty?.querySelector('button[aria-label="关闭这个窗格"]')?.click(); return true; })()`);
    await wait(async () => (await tjs(`document.querySelectorAll('.cs-cell').length`)) === cellsNow - 1, 5000);
    ctx.codeLink.store.patchSession(project.id, hooked.id, { state: "ended", endedAt: Date.now() });
    ctx.emit("codeLink/changed", project.id);
    const listed = await wait(async () => (await tjs(`document.querySelectorAll('[data-terminal]').length`)) === 1, 5000);
    check("左侧列表把它列成一行", listed);
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

    // Typing into a cell while panes no cell shows print without pause: recorded through observers, then not (only
    // what the window shows). Keystroke to the cell's screen, median of 15 each way; the observers' own cost from ps.
    const latency = async () => {
      await tjs(`window.__lat = new Promise((resolve) => { const rows = document.querySelector('.cs-cell[data-cell-terminal] .xterm-rows'); const before = rows.textContent; const t0 = performance.now(); const seen = new MutationObserver(() => { if (rows.textContent !== before) { seen.disconnect(); resolve(performance.now() - t0); } }); seen.observe(rows, { subtree: true, childList: true, characterData: true }); setTimeout(() => { seen.disconnect(); resolve(-1); }, 2000); }); true`);
      tw.webContents.insertText("x");
      return tjs("window.__lat");
    };
    const median = async () => {
      await tjs(`document.querySelector('.cs-cell[data-cell-terminal] .xterm-helper-textarea').focus(); true`);
      const runs = [];
      for (let i = 0; i < 15; i++) {
        runs.push(await latency());
        await sleep(120);
      }
      herdr("pane", "send-keys", plainPane, "ctrl+u");
      const ok = runs.filter((n) => n >= 0).sort((a, b) => a - b);
      return { median: Math.round(ok[Math.floor(ok.length / 2)] ?? -1), p90: Math.round(ok[Math.floor(ok.length * 0.9)] ?? -1), lost: runs.length - ok.length };
    };
    const noisy = [];
    for (let i = 0; i < 3; i++) {
      const pane = await ctx.herdr.launch({ cwd, label: `noise ${i}`, command: "while true; do echo noise-$RANDOM-$RANDOM-$RANDOM; sleep 0.02; done", workspace: { key: project.id, label: project.name } });
      const s = ctx.codeLink.store.createSession(project.id, { repoId: "check", branch: `noise-${i}`, itemIds: [], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: cwd });
      ctx.codeLink.store.patchSession(project.id, s.id, { state: "running", herdrPane: pane.paneId });
      noisy.push({ id: s.id, pane: pane.paneId });
    }
    ctx.emit("codeLink/changed", project.id);
    const observing = () => noisy.filter((n) => streams.some((st) => st.pane === n.pane && st.mode === "observe" && !st.closed)).length;
    const recordSettings = (background) => ctx.settings.set({ ...ctx.settings.get(), terminalRecording: { ...ctx.settings.get().terminalRecording, background } });
    // Warmed up first; then not observed, observed, not observed again, so neither side gets the cold start.
    recordSettings(false);
    await wait(async () => observing() === 0, 5000);
    await median();
    const withoutBefore = await median();
    recordSettings(true);
    const watchedNoise = await wait(async () => observing() === noisy.length, 8000);
    await sleep(1500);
    const observerCost = execFileSync("ps", ["-Ao", "%cpu=,rss=,command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes("terminal session observe")).map((l) => l.trim().split(/\s+/).slice(0, 2).map(Number));
    const withObservers = await median();
    recordSettings(false);
    await wait(async () => observing() === 0, 5000);
    const withoutAfter = await median();
    recordSettings(true);
    const baseline = Math.round((withoutBefore.median + withoutAfter.median) / 2);
    console.log(`INFO: typing latency in a cell, ${noisy.length} panes printing without pause — observed: ${JSON.stringify(withObservers)} · not observed, before and after: ${JSON.stringify(withoutBefore)} ${JSON.stringify(withoutAfter)} · observers (%cpu, rss KB): ${JSON.stringify(observerCost)}`);
    check("后台窗格在录时打字延迟不回退（中位数不比不录时多 15 ms）", watchedNoise && withObservers.median >= 0 && withObservers.median <= baseline + 15, JSON.stringify({ watchedNoise, withObservers, withoutBefore, withoutAfter }));
    for (const n of noisy) {
      ctx.codeLink.store.patchSession(project.id, n.id, { state: "ended", endedAt: Date.now() });
      herdr("pane", "close", n.pane);
    }
    ctx.emit("codeLink/changed", project.id);
    await sleep(500);
    // A plain terminal goes by what runs in it while it runs. Sent once the shell is back at its prompt: typed ahead,
    // zsh drops it.
    const foreground = () => JSON.parse(herdr("pane", "process-info", "--pane", plainPane)).result.process_info.foreground_processes.map((p) => p.cmdline);
    await sleep(1500);
    herdr("pane", "send-text", plainPane, "sleep 8");
    herdr("pane", "send-keys", plainPane, "enter");
    const sleeping = await wait(async () => foreground().includes("sleep 8"), 4000);
    const runningShown = sleeping && (await wait(async () => {
      ctx.emit("codeLink/changed", project.id);
      return (await tjs(`document.querySelector('[data-terminal] .cs-row-head')?.textContent ?? ''`)).includes("sleep 8");
    }, 5000));
    check("普通终端在列表里显示正在跑的命令", runningShown, JSON.stringify({ sleeping, rows: await tjs(`[...document.querySelectorAll('[data-terminal] .cs-row-head')].map((h) => h.textContent)`) }));
    await wait(async () => !foreground().includes("sleep 8"), 10000);
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
    tw = awake(sessionsWindow());
    tjs = (code) => tw.webContents.executeJavaScript(code, true);
    // Something new on the pane, not an old line the reopened cell's viewport may no longer hold: the cell streams it.
    herdr("pane", "send-text", plainPane, "echo reopened-ok");
    herdr("pane", "send-keys", plainPane, "enter");
    const back = await wait(async () => (await tjs(`(() => { const cell = document.querySelector('.cs-cell[data-cell-terminal]'); return !!cell?.querySelector('.xterm') && [...cell.querySelectorAll('.xterm-rows > div')].some((r) => r.textContent.includes('reopened-ok')); })()`)));
    check("关窗重开后，新终端在原来的格子里接回来", back);
    const plainChip = () => tjs(`document.querySelector('.cs-cell[data-cell-terminal] .cs-cell-bar [data-testid=cs-state]')?.dataset.state ?? null`);
    const rowsOfManual = `[...(document.querySelector('.cs-cell[data-cell-terminal] .cs-pane-timeline .cs-replay')?.querySelectorAll('.xterm-rows > div') ?? [])].map((r) => r.textContent).join('\\n')`;
    check("普通终端里只有 shell 时，标题栏不显示状态", (await plainChip()) === null, String(await plainChip()));
    const shellHint = await wait(async () => tjs(`(() => { const hint = document.querySelector('.cs-cell[data-cell-terminal] [data-testid=cs-shell-hint]'); return !!hint?.offsetParent && hint.textContent.includes('在这里敲 claude 试试') && hint.textContent.includes('普通 shell 不算会话'); })()`), 8000);
    check("只有 shell 的格子下面一行提示「在这里敲 claude 试试 · 普通 shell 不算会话；agent 一启动就算」", shellHint, await tjs(`document.querySelector('.cs-cell[data-cell-terminal]')?.textContent?.slice(-200)`));

    // An agent in it claims a ticket: code link learns the pane (as the repo's hooks report it) and the cell becomes
    // that session in place — same xterm, same picture, no second row. Letting the claim go makes it a terminal again.
    const claimed = ctx.items.create({ projectId: project.id, boardId: board.id, title: "在终端里认领", workType: "coding", status: "doing", by: "human" });
    // Before the claim the agent's hooks have made it a session with no ticket: still the terminal's one row, never a blank one.
    const rowCount = await tjs(`document.querySelectorAll('.cs-row').length`);
    const claimSession = ctx.codeLink.store.createSession(project.id, { repoId: "check", branch: "", itemIds: [], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: cwd });
    await tjs(`document.querySelector('.cs-cell[data-cell-terminal] .xterm').dataset.mark = 'same'; true`);
    ctx.codeLink.store.patchSession(project.id, claimSession.id, { state: "running", herdrPane: plainPane });
    ctx.emit("codeLink/changed", project.id);
    await sleep(1500);
    const unclaimed = await tjs(`[document.querySelectorAll('.cs-row').length, document.querySelectorAll('[data-terminal]').length, [...document.querySelectorAll('.cs-row .cs-row-head .mono')].filter((n) => !n.textContent.trim()).length]`);
    check("还没认领工单的 agent 只是它终端的那一行，没有空白的会话行", unclaimed[0] === rowCount && unclaimed[1] === 1 && unclaimed[2] === 0, JSON.stringify({ before: rowCount, now: unclaimed }));
    // Its first words, as its hooks report them, sound like that ticket: the guess is offered on the terminal's card and in
    // its cell, and taking it is the claim.
    ctx.codeLink.sessions.event(project.id, claimSession.id, { hook_event_name: "UserPromptSubmit", prompt: "在终端里认领这张工单的活。" });
    const guessed = await wait(async () => tjs(`(() => { const cell = document.querySelector('.cs-cell[data-cell-terminal] [data-testid=cs-guess]'); const card = document.querySelector('.cs-card:has([data-terminal]) [data-testid=cs-guess]'); return !!cell && !!card && [cell, card].every((g) => g.textContent.includes(${JSON.stringify(`你说的话像是 ${claimed.key}`)}) && g.textContent.includes('不用工单')); })()`), 15000);
    check("没挂工单的会话：卡片和格子上「你说的话像是 …」+「认领」/「不用工单」", guessed, JSON.stringify(await tjs(`[...document.querySelectorAll('[data-testid=cs-guess]')].map((g) => g.textContent)`)));
    await tjs(`document.querySelector('.cs-cell[data-cell-terminal] [data-testid=cs-guess-take]')?.click(); true`);
    const folded = await wait(async () => tjs(`(() => { const cell = document.querySelector('.cs-cell[data-cell-terminal]'); return !!cell && cell.querySelector('.cs-cell-name').textContent.includes(${JSON.stringify(claimed.key)}) && [...cell.querySelectorAll('.link-btn')].some((b) => b.textContent === '继续'); })()`));
    check("终端里的 agent 认领工单后，这个格子原地变成该工单的会话", folded);
    const inPlace = await tjs(`(() => { const cell = document.querySelector('.cs-cell[data-cell-terminal]'); return cell.querySelector('.xterm')?.dataset.mark === 'same' && [...cell.querySelectorAll('.xterm-rows > div')].some((r) => r.textContent.includes('reopened-ok')); })()`);
    check("不换格子也不重连：还是原来的终端画面", inPlace);
    const rows = await tjs(`(() => { const withKey = [...document.querySelectorAll('.cs-row')].filter((r) => r.textContent.includes(${JSON.stringify(claimed.key)})); return [document.querySelectorAll('.cs-row').length, withKey.length, withKey.filter((r) => r.dataset.terminal).length]; })()`);
    check("还是终端的那一行，现在显示工单，没有多出第二行", rows[0] === rowCount && rows[1] === 1 && rows[2] === 1, JSON.stringify({ before: rowCount, now: rows }));
    ctx.codeLink.store.patchSession(project.id, claimSession.id, { itemIds: [] });
    ctx.emit("codeLink/changed", project.id);
    const plainAgain = await wait(async () => tjs(`(() => { const cell = document.querySelector('.cs-cell[data-cell-terminal]'); return !!cell && [...cell.querySelectorAll('.link-btn')].some((b) => b.textContent === '关闭终端') && cell.querySelector('.xterm')?.dataset.mark === 'same'; })()`));
    check("释放工单后，格子变回普通终端（不清空、不重连）", plainAgain);

    // The pane's timeline over its cell: the sessions that ran there and the manual work between them; manual work
    // reads as raw output only, with where it is kept and who can see it.
    await tjs(`document.querySelector('.cs-cell[data-cell-terminal] [data-testid=cs-timeline-open]')?.click(); true`);
    const timelineRows = () => tjs(`[...document.querySelectorAll('.cs-cell[data-cell-terminal] [data-testid=cs-timeline-entry]')].map((r) => [r.dataset.kind, r.textContent])`);
    const timelineShown = await wait(async () => (await timelineRows()).some(([kind]) => kind === "manual") && (await timelineRows()).some(([kind]) => kind === "session"), 10000);
    await tjs(`[...document.querySelectorAll('.cs-cell[data-cell-terminal] [data-testid=cs-timeline-entry]')].find((r) => r.dataset.kind === 'manual')?.click(); true`);
    const manualReplay = ".cs-cell[data-cell-terminal] .cs-pane-timeline .cs-replay";
    const manualOpen = await wait(async () => tjs(`!!document.querySelector(${JSON.stringify(manualReplay)}) && !document.querySelector(${JSON.stringify(manualReplay)}).hasAttribute('data-drawing')`), 10000);
    const convoOff = await tjs(`document.querySelector('.cs-cell[data-cell-terminal] [data-testid=cs-timeline-convo]')?.disabled === true`);
    const tags = await tjs(`document.querySelector('.cs-cell[data-cell-terminal] .cs-pane-timeline [data-testid=cs-raw-tags]')?.textContent ?? ''`);
    const seekManual = (fraction) => tjs(`(() => { const s = document.querySelector('.cs-cell[data-cell-terminal] .cs-pane-timeline [data-testid=cs-replay-slider]'); if (!s) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(s, Math.round(Number(s.max) * ${fraction})); s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    let manualEcho = false;
    for (let fraction = 1; manualOpen && fraction >= 0 && !manualEcho; fraction = Math.round((fraction - 0.1) * 10) / 10) {
      if (!(await seekManual(fraction))) break;
      manualEcho = await wait(async () => /plain-terminal-ok|pane-is-|reopened-ok/.test(await tjs(rowsOfManual)), 1500);
    }
    check("窗格时间线（格子 N · 目录 · 从早到晚）列出会话段和「手动操作」段；手动段只放原始输出，带隐私标签", timelineShown && manualOpen && convoOff && manualEcho && tags.includes("只存在这台电脑") && tags.includes("不进搜索"), JSON.stringify({ rows: await timelineRows(), manualOpen, convoOff, manualEcho, tags }));
    fs.writeFileSync(path.join(shots, "code-sessions-pane-timeline.png"), (await tw.webContents.capturePage()).toPNG());
    await tjs(`document.querySelector('.cs-cell[data-cell-terminal] [data-testid=cs-timeline-close]')?.click(); true`);

    // An agent started in the plain terminal from the hint's button, which types its command without running it: herdr
    // reads it, and the pane's bar shows how it stands, before any claim.
    await tjs(`document.querySelector('.cs-cell[data-cell-terminal] [data-testid=cs-shell-try]')?.click(); true`);
    const typedClaude = await wait(async () => /\bclaude\s*$/m.test(herdr("pane", "read", plainPane, "--source", "recent", "--lines", "5").trimEnd()), 5000);
    check("点「在这里敲 claude 试试」把 claude 打进这个格子，不回车", typedClaude, herdr("pane", "read", plainPane, "--source", "recent", "--lines", "5").slice(-200));
    herdr("pane", "send-keys", plainPane, "enter");
    const agentChip = await wait(async () => ["running", "needs", "idle", "done"].includes(await plainChip()), 20000);
    check("普通终端里跑起 agent 后，标题栏按 herdr 的判断显示它的状态", agentChip, JSON.stringify({ chip: await plainChip(), pane: JSON.parse(herdr("pane", "get", plainPane)).result.pane }));

    // Closed from its cell: the pane ends in herdr.
    await tjs(`[...document.querySelector('.cs-cell[data-cell-terminal]').querySelectorAll('.link-btn')].find((b) => b.textContent === '关闭终端').click(); true`);
    const ended = await wait(async () => !JSON.parse(herdr("pane", "list")).result.panes.some((p) => p.pane_id === plainPane) && saved().length === 0);
    check("关闭终端：herdr 里的 pane 结束，列表里也没了", ended);

    // The closed terminal's output was recorded while its cell showed it: under History's closed-terminals filter,
    // played back in the cell it is picked into. The ended ticket session that ran alongside in pane four has a second
    // tab, the raw output of its own stretch: marker-four was on its screen, what was typed after it ended is not.
    const rowsOf = (sel) => `[...(document.querySelector(${JSON.stringify(sel)})?.querySelectorAll('.xterm-rows > div') ?? [])].map((r) => r.textContent).join('\\n')`;
    const replayText = (sel) => tjs(rowsOf(sel));
    const detachCell = async (sel) => {
      await tjs(`document.querySelector(${JSON.stringify(sel)})?.closest('.cs-cell')?.querySelector('.cs-cell-bar').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 20 })); true`);
      await sleep(300);
      await tjs(`[...document.querySelectorAll('[role=menuitem]')].find((i) => i.textContent === '断开')?.click(); true`);
      await sleep(300);
    };
    // History is the assistant panel's list, in the bar: its rows, not the bar's cards.
    const historyRowWith = (text) => `[...document.querySelectorAll('[data-testid=ai-review-list] .ai-review-row')].find((r) => r.textContent.includes(${JSON.stringify(text)}))`;
    await tjs(`document.querySelector('[data-testid=cs-history]').click(); true`);
    await wait(async () => tjs(`!!document.querySelector('[data-testid=cs-history-terminals]')`), 5000);
    await tjs(`document.querySelector('[data-testid=cs-history-terminals]').click(); true`);
    const closedRow = await wait(async () => tjs(`!!document.querySelector('[data-testid=ai-review-list] .ai-review-row[data-kind=terminal]')`), 8000);
    await tjs(`document.querySelector('[data-testid=ai-review-list] .ai-review-row[data-kind=terminal]')?.click(); true`);
    // It opens on the terminal's last screen, Claude Code's trust prompt; the slider dragged back finds the lines
    // echoed before it (set through the native setter, so React hears the change).
    const closedReplay = "[data-testid=cs-closed-terminal] .cs-replay";
    const replayOpen = closedRow && (await wait(async () => tjs(`!!document.querySelector(${JSON.stringify(closedReplay)}) && !document.querySelector(${JSON.stringify(closedReplay)}).hasAttribute('data-drawing')`), 15000));
    const seekTo = (fraction) => tjs(`(() => { const s = document.querySelector('[data-testid=cs-closed-terminal] [data-testid=cs-replay-slider]'); if (!s) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(s, Math.round(Number(s.max) * ${fraction})); s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    let echoed = false;
    for (let fraction = 0.9; replayOpen && fraction >= 0 && !echoed; fraction = Math.round((fraction - 0.1) * 10) / 10) {
      if (!(await seekTo(fraction))) break;
      echoed = await wait(async () => (await replayText(closedReplay)).includes("pane-is-"), 1500);
    }
    check("关掉的普通终端是历史里的一个筛选项，选中后格子回放它的原始输出，进度条拖回去能看到之前回显的内容", closedRow && replayOpen && echoed, JSON.stringify({ closedRow, replayOpen, text: (await replayText(closedReplay)).trim().slice(-300) }));
    fs.writeFileSync(path.join(shots, "code-sessions-replay-terminal.png"), (await tw.webContents.capturePage()).toPNG());
    await tjs(`document.querySelector('[data-testid=cs-history-all]').click(); true`);
    await wait(async () => tjs(`!!${historyRowWith(alongItem.key)}`), 8000);
    await tjs(`${historyRowWith(alongItem.key)}?.click(); true`);
    const rawTab = await wait(async () => tjs(`!!document.querySelector('[data-testid=cs-ended] [data-testid=cs-tab-raw][data-recorded]')`), 8000);
    await tjs(`document.querySelector('[data-testid=cs-ended] [data-testid=cs-tab-raw]')?.click(); true`);
    const sessionReplay = () => replayText("[data-testid=cs-ended] .cs-replay");
    const ownStretch = rawTab && (await wait(async () => (await sessionReplay()).includes("marker-four"), 15000)) && !(await sessionReplay()).includes("after-pane-keys");
    check("结束的会话多一个「原始输出」标签：回放只含它自己那段，有 marker-four，没有它结束后才输入的 after-pane-keys", ownStretch, JSON.stringify({ rawTab, text: (await sessionReplay()).trim().slice(-400) }));
    fs.writeFileSync(path.join(shots, "code-sessions-replay-session.png"), (await tw.webContents.capturePage()).toPNG());
    await tjs(`document.querySelector('[data-testid=cs-history-back]').click(); true`);
    await sleep(300);
    // The cell used for reading is emptied again, for the steps below that count empty cells.
    await detachCell("[data-testid=cs-ended]");

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
    const emptyCells = () => tjs(`document.querySelectorAll('.cs-cell-empty > .cs-new-terminal [data-testid=cs-new-terminal]').length`);
    // the first cell that holds something: which cell History's picks above landed in follows the selection
    const heldBar = `[...document.querySelectorAll('.cs-cell')].find((c) => !c.querySelector('.cs-cell-empty'))?.querySelector('.cs-cell-bar')`;
    const emptyBefore = await emptyCells();
    await tjs(`${heldBar}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 20 })); true`);
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
    // A card by its name alone: CSC-1 is not CSC-12.
    const cardOf = (key) => `[...document.querySelectorAll('.cs-card')].find((c) => c.querySelector('.cs-row-name')?.firstChild && [...c.querySelector('.cs-row-name').childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() === ${JSON.stringify(key)}))`;
    const newMark = await wait(async () => tjs(`${cardOf(auto)}?.querySelector('[data-testid=cs-new]')?.textContent === '新'`), 3000);
    const oldUnmarked = await tjs(`!!${cardOf(sessions[0].item.key)} && !${cardOf(sessions[0].item.key)}.querySelector('[data-testid=cs-new]')`);
    check("刚开始的会话卡片带「新」（一分钟内，同助手面板），早开始的不带", newMark && oldUnmarked, JSON.stringify({ newMark, oldUnmarked }));
    await tjs(`document.querySelector('[data-testid=cs-side-new-terminal]').click(); true`);
    await sleep(300);
    await tjs(`${heldBar}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 20 })); true`);
    await sleep(300);
    await tjs(`[...document.querySelectorAll('[role=menuitem]')].find((i) => i.textContent === '断开')?.click(); true`);
    await tjs(`document.querySelector('[data-testid=cs-auto-place]').click(); true`);
    await wait(async () => !JSON.parse(fs.readFileSync(path.join(work, "code-sessions.json"), "utf8")).autoPlace === false || JSON.parse(fs.readFileSync(path.join(work, "code-sessions.json"), "utf8")).autoPlace === false, 3000);
    const manual = await appear("关掉自动分配");
    await sleep(2500);
    check("关掉自动分配后，新会话不会自己占面板", !(await inCell(manual)) && (await tjs(`document.querySelectorAll('.cs-cell-empty > .cs-new-terminal [data-testid=cs-new-terminal]').length`)) >= 1);
    // Asked from outside — "open in terminal" on its ticket — the session comes into a cell and is selected, auto-place off or not.
    check("代码关联认得这个终端窗口", await ctx.codeLink.terminalWindow(project.id));
    const manualItem = ctx.items.list({ projectId: project.id }).find((i) => i.key === manual);
    const jumped = await ctx.contributions.run("code-link.open-terminal", { projectId: project.id, itemId: manualItem.id });
    const currentRows = () => tjs(`[...document.querySelectorAll('.cs-row[aria-current="true"]')].map((r) => r.textContent).join(' | ')`);
    const revealed = await wait(async () => (await inCell(manual)) && (await currentRows()).includes(manual), 8000);
    check("在终端打开：终端窗口把会话放进格子并选中它", revealed && !jumped.toast, `${JSON.stringify(jumped)} · current: ${await currentRows()}`);
    // Let go again, and the plain terminal's cell selected as before: the steps below count the empty cells.
    await tjs(`[...document.querySelectorAll('.cs-cell')].find((c) => c.querySelector('.cs-cell-name')?.textContent.includes(${JSON.stringify(manual)})).querySelector('.cs-cell-bar').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 20 })); true`);
    const detachShown = await wait(async () => tjs(`[...document.querySelectorAll('[role=menuitem]')].some((i) => i.textContent === '断开')`), 3000);
    await tjs(`[...document.querySelectorAll('[role=menuitem]')].find((i) => i.textContent === '断开')?.click(); true`);
    const letGo = await wait(async () => !(await inCell(manual)), 3000);
    console.log(`INFO: letting the revealed session go → menu ${detachShown ? "shown" : "not shown within 3 s"}, cell ${letGo ? "emptied" : "still shows it"}`);
    await tjs(`document.querySelectorAll('.cs-cell')[1].querySelector('.cs-cell-bar').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
    fs.writeFileSync(path.join(shots, "code-sessions-layouts.png"), (await tw.webContents.capturePage()).toPNG());

    // A session in iTerm2 (its hooks said so): tagged in the list, and its pane says where it runs and what can be done.
    const outsideItem = ctx.items.create({ projectId: project.id, boardId: board.id, title: "在 iTerm2 里跑", workType: "coding", status: "doing", by: "human" });
    const outside = ctx.codeLink.store.createSession(project.id, { repoId: "check", branch: `${outsideItem.key.toLowerCase()}/iterm`, itemIds: [outsideItem.id], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree: cwd });
    ctx.codeLink.store.patchSession(project.id, outside.id, { state: "running", terminal: "iTerm.app" });
    ctx.emit("codeLink/changed", project.id);
    const rowOf = `[...document.querySelectorAll('.cs-row')].find((r) => r.textContent.includes(${JSON.stringify(outsideItem.key)}))`;
    // It waits in its own group, closed, which counts it; opened, the row is there.
    const grouped = await wait(async () => tjs(`(() => { const g = document.querySelector('[data-testid=cs-outside-group]'); return !!g && g.querySelector('[aria-expanded]').getAttribute('aria-expanded') === 'false' && g.querySelector('[data-testid=cs-outside-count]').textContent === '1' && !${rowOf}; })()`), 8000);
    check("外部终端里的会话在「在其他地方」分组里，默认收起，分组标题数着它", grouped);
    await tjs(`document.querySelector('[data-testid=cs-outside-group] [aria-expanded]').click(); true`);
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

    // The project named at the top; ⌘B folds the list to a strip that still names it, even from inside a terminal, and back.
    check("侧栏顶上写着这个窗口的项目", (await tjs(`document.querySelector('[data-testid=cs-project]')?.textContent`)) === project.name);
    await tjs(`document.querySelector('.cs-cell .xterm-helper-textarea')?.focus(); true`);
    const foldKey = () => tw.webContents.sendInputEvent({ type: "keyDown", keyCode: "B", modifiers: [process.platform === "darwin" ? "meta" : "control", ...(process.platform === "darwin" ? [] : ["shift"])] });
    foldKey();
    const foldedNow = await wait(async () => tjs(`!!document.querySelector('.cs-side[data-folded]') && document.querySelector('[data-testid=cs-project]')?.textContent === ${JSON.stringify(project.name)} && document.querySelector('.cs-side').getBoundingClientRect().width < 60`), 3000);
    await sleep(300);
    fs.writeFileSync(path.join(shots, "code-sessions-folded.png"), (await tw.webContents.capturePage()).toPNG());
    foldKey();
    const unfolded = await wait(async () => tjs(`!document.querySelector('.cs-side[data-folded]') && !!document.querySelector('.cs-row')`), 3000);
    check("⌘B 收起侧栏（窄条上还写着项目名），再按一次展开", foldedNow && unfolded);
    await sleep(300);
    fs.writeFileSync(path.join(shots, "code-sessions-unfolded.png"), (await tw.webContents.capturePage()).toPNG());

    // The session bar, the assistant panel's: on the right, cards open and dots folded, the keys along the bottom.
    const barRight = await tjs(`(() => { const side = document.querySelector('.cs-side').getBoundingClientRect(); const main = document.querySelector('.cs-main').getBoundingClientRect(); return side.left >= main.right - 1 && !!document.querySelector('[data-testid=cs-views]'); })()`);
    check("会话栏在右边，顶部有「格子 | 总览」", barRight);
    // The top bar breathes: the view switch carries an icon on each word, stands shorter than the bar and centred in it,
    // and the bar's last button ends on the session cards' right edge; the project name starts on the first cell's left edge.
    const topbar = await tjs(`(() => { const r = (el) => el.getBoundingClientRect(); const bar = r(document.querySelector('.cs-topbar')); const views = r(document.querySelector('[data-testid=cs-views]')); const last = r(document.querySelector('.cs-topbar').lastElementChild); const side = document.querySelector('.cs-side'); const cards = r(side).right - parseFloat(getComputedStyle(side).paddingRight); const name = r(document.querySelector('[data-testid=cs-project]')); const cell = r(document.querySelector('.cs-cell')); return { room: bar.height - views.height, centred: Math.abs((views.top - bar.top) - (bar.bottom - views.bottom)) <= 1, right: Math.abs(last.right - cards) <= 1, left: Math.abs(name.left - cell.left) <= 1, icons: document.querySelectorAll('[data-testid=cs-views] button svg').length }; })()`);
    check("顶栏有余地：「格子 | 总览」各带图标，比顶栏矮且居中，右边齐会话卡片，项目名齐第一个格子", topbar.room >= 8 && topbar.centred && topbar.right && topbar.left && topbar.icons === 2, JSON.stringify(topbar));
    foldKey();
    const dots = await wait(async () => tjs(`!!document.querySelector('.cs-side[data-folded]') && document.querySelectorAll('.cs-dot').length >= 6 && document.querySelectorAll('.cs-row').length === 0`), 3000);
    // React hears mouseenter as a mouseover that bubbles, and draws the peek on its next frame.
    await tjs(`document.querySelector('.cs-dot').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); true`);
    const dotPeek = await wait(async () => tjs(`!!document.querySelector('[data-testid=cs-peek]')`), 2000);
    foldKey();
    const cards = await wait(async () => tjs(`!document.querySelector('.cs-side[data-folded]') && document.querySelectorAll('.cs-row').length >= 6 && [...document.querySelectorAll('.cs-row')].every((r) => getComputedStyle(r).borderRadius !== '0px')`), 3000);
    check("收起是一列点（悬停有预览），展开是卡片", dots && dotPeek && cards, JSON.stringify({ dots, dotPeek, cards }));
    const keysText = await tjs(`document.querySelector('[data-testid=cs-keys]')?.textContent ?? ''`);
    const keyLabels = process.platform === "darwin" ? ["⌘D", "⇧⌘D", "⌘W", "⌥⌘", "⌘[", "⌘]", "⌘B", "⌘K"] : ["Ctrl+Shift+D", "Ctrl+Shift+O", "Ctrl+Shift+W", "Alt", "Ctrl+Shift+Tab", "Ctrl+Tab", "Ctrl+Shift+B", "Ctrl+Shift+K"];
    check("底部一行写着沿用的按键", keyLabels.every((k) => keysText.includes(k)), keysText);

    // An assistant conversation, the built-in kind: listed as a card with no pane; opening it brings the app window up on it.
    const opens = [];
    ctx.on("desktop/open", (target) => opens.push(target));
    ctx.agent.engine({ id: "quick", title: "Quick", author: "ai:quick", available: async () => ({ ok: true }), async turn(_input, io) { io.emit({ type: "text", text: "整理完了" }); return { stop: "end" }; } });
    const thread = ctx.agent.newThread(project.id, "quick", board.id, { title: "整理 Q4 backlog" });
    ctx.agent.send(project.id, thread.id, { kind: "text", text: "整理一下" });
    const threadCard = `[...document.querySelectorAll('.cs-row.cs-thread')].find((r) => r.textContent.includes('整理 Q4 backlog'))`;
    const threadListed = await wait(async () => tjs(`!!${threadCard} && ${threadCard}.textContent.includes('在助手里 · 没有格子')`), 8000);
    check("助手面板里的会话出现在会话栏，标「在助手里 · 没有格子」", threadListed, await tjs(`[...document.querySelectorAll('.cs-row')].map((r) => r.textContent.slice(0, 60))`).then((rows) => JSON.stringify(rows)));
    await tjs(`${threadCard}?.click(); true`);
    const openedThread = await wait(async () => opens.some((t) => t.projectId === project.id && t.threadId === thread.id), 3000);
    check("点它在主窗口打开（desktop/open 带着这个对话）", openedThread, JSON.stringify(opens));

    // The top bar's own buttons, beside the view switch: split right and down, ⌘K, and the main window.
    const topWords = await tjs(`['cs-top-split-right', 'cs-top-split-down', 'cs-top-palette', 'cs-top-main'].map((id) => document.querySelector('[data-testid=' + id + ']')?.textContent.trim() ?? null)`);
    const wordsOk = process.platform !== "darwin" || JSON.stringify(topWords) === JSON.stringify(["向右分⌘D", "向下分⇧⌘D", "⌘K找会话或做事", "主窗口"]);
    const cellsBeforeTop = await tjs(`document.querySelectorAll('.cs-cell').length`);
    const terminalsBeforeTop = await tjs(`document.querySelectorAll('.cs-cell[data-cell-terminal]').length`);
    await tjs(`document.querySelector('[data-testid=cs-top-split-right]').click(); true`);
    const topSplit = await wait(async () => tjs(`document.querySelectorAll('.cs-cell').length === ${cellsBeforeTop + 1} && document.querySelectorAll('.cs-cell[data-cell-terminal] .xterm').length === ${terminalsBeforeTop + 1}`), 10000);
    // That shell goes again, and its cell.
    await tjs(`(() => { const cell = document.querySelector('.cs-cell[data-focused]'); [...(cell?.querySelectorAll('.cs-cell-bar .link-btn') ?? [])].find((b) => b.textContent === '关闭终端')?.click(); return true; })()`);
    await sleep(800);
    await tjs(`document.querySelector('.cs-cell[data-focused] button[aria-label="关闭这个窗格"]')?.click(); true`);
    await wait(async () => (await tjs(`document.querySelectorAll('.cs-cell').length`)) === cellsBeforeTop, 5000);
    await tjs(`document.querySelector('[data-testid=cs-top-palette]').click(); true`);
    const topPalette = await wait(async () => tjs(`!!document.querySelector('[data-testid=cs-palette]')`), 3000);
    tw.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    tw.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    if (!(await wait(async () => tjs(`!document.querySelector('[data-testid=cs-palette]')`), 2000))) {
      const mac = process.platform === "darwin";
      await tjs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: ${mac}, ctrlKey: ${!mac}, shiftKey: ${!mac}, bubbles: true, cancelable: true })); true`);
      await wait(async () => tjs(`!document.querySelector('[data-testid=cs-palette]')`), 2000);
    }
    const opensBefore = opens.length;
    await tjs(`document.querySelector('[data-testid=cs-top-main]').click(); true`);
    const topMain = await wait(async () => opens.slice(opensBefore).some((t) => t.projectId === project.id && !t.threadId), 3000);
    check("顶栏右侧「向右分 ⌘D」「向下分 ⇧⌘D」「⌘K 找会话或做事」「主窗口」：分出 shell、打开 ⌘K、把主窗口调到前面", wordsOk && topSplit && topPalette && topMain, JSON.stringify({ topWords, topSplit, topPalette, topMain }));

    // A session waiting on a permission its agent declared the keys for: its card goes to the top and allows from there.
    const typedIn = [];
    const realSendInput = ctx.herdr.sendInput;
    // Allow presses keys only on a permission prompt the pane's screen shows: these panes print one.
    const showsOnScreen = async (pane, command, seen) => {
      // a drop earlier may have left words on the shell's line
      await realSendInput.call(ctx.herdr, pane, { keys: ["ctrl+c"] });
      await realSendInput.call(ctx.herdr, pane, { text: command, keys: ["enter"] });
      return wait(async () => ((await ctx.herdr.readTail(pane, 12)) ?? "").split("\n").some((l) => l.trim() === seen), 5000);
    };
    await showsOnScreen(sessions[4].pane, "printf 'Do you want to proceed?\\n❯ 1. Yes\\n  2. No, and tell Claude what to do differently\\n'", "❯ 1. Yes");
    await showsOnScreen(sessions[3].pane, "printf 'Do you trust the files in this folder?\\n❯ 1. No, exit\\n  2. Yes, I trust this folder\\n'", "❯ 1. No, exit");
    ctx.herdr.sendInput = async (pane, input) => { typedIn.push([pane, input]); return true; };
    ctx.codeLink.store.patchSession(project.id, sessions[4].id, { state: "waiting", activity: "needs your approval: Bash" });
    ctx.emit("codeLink/changed", project.id);
    const askCard = `[...document.querySelectorAll('.cs-row')].find((r) => r.textContent.includes(${JSON.stringify(sessions[4].item.key)}))`;
    // Allow and Deny sit under the card, in its list item (a pane with history puts the card in a fold row first).
    const asksOnTop = await wait(async () => tjs(`(() => { const card = ${askCard}; return !!card && card.dataset.status === 'wait' && document.querySelector('.cs-row') === card && !!card.closest('li').querySelector('[data-testid=cs-allow]'); })()`), 8000);
    check("等你允许的会话排在最上，卡片下有「允许」「拒绝」", asksOnTop, await tjs(`[...document.querySelectorAll('.cs-row')].map((r) => [r.dataset.status, r.textContent.slice(0, 40)])`).then((rows) => JSON.stringify(rows)));
    fs.writeFileSync(path.join(shots, "code-sessions-bar.png"), (await tw.webContents.capturePage()).toPNG());
    await tjs(`${askCard}?.closest('li').querySelector('[data-testid=cs-allow]')?.click(); true`);
    const allowed = await wait(async () => typedIn.length === 1, 3000);
    check("点「允许」把 agent 声明的按键发进它的 pane", allowed && JSON.stringify(typedIn[0]) === JSON.stringify([sessions[4].pane, { keys: ["enter"] }]), JSON.stringify(typedIn));
    // A folder's trust is no permission (Enter there would pick "No, exit"): its card waits on you, with no Allow or Deny to press.
    ctx.codeLink.store.patchSession(project.id, sessions[3].id, { state: "waiting", activity: "needs your approval" });
    ctx.emit("codeLink/changed", project.id);
    const trustCard = `[...document.querySelectorAll('.cs-row')].find((r) => r.textContent.includes(${JSON.stringify(sessions[3].item.key)}))`;
    // the state that says it waits carries what its screen asks, so no buttons by then means none at all
    const trustWaits = await wait(async () => tjs(`${trustCard}?.dataset.status === 'wait'`), 5000);
    const trustButtons = await tjs(`!!${trustCard}?.closest('li').querySelector('[data-testid=cs-allow], [data-testid=cs-deny]')`);
    check("屏幕上不是权限提示（信任文件夹）时卡片照旧等你，但没有「允许」「拒绝」，一个键也不发", trustWaits && !trustButtons && typedIn.length === 1, JSON.stringify({ typedIn, trustWaits, trustButtons }));
    ctx.herdr.sendInput = realSendInput;
    // the overview below reads this pane's marker in its last lines
    await realSendInput.call(ctx.herdr, sessions[4].pane, { text: "echo marker-five", keys: ["enter"] });
    ctx.codeLink.store.patchSession(project.id, sessions[3].id, { state: "running", activity: null });
    ctx.codeLink.store.patchSession(project.id, sessions[4].id, { state: "running", activity: null });
    ctx.emit("codeLink/changed", project.id);
    await wait(async () => tjs(`${askCard}?.dataset.status === 'run'`), 5000);

    // The overview: every session as a big card with its pane's last lines; "see in a pane" goes back to the cells on it.
    await tjs(`document.querySelector('[data-testid=cs-view-overview]').click(); true`);
    const overview = await wait(async () => tjs(`!!document.querySelector('[data-testid=cs-overview]') && document.querySelectorAll('[data-testid=cs-big]').length >= 7`), 5000);
    const bigFive = `[...document.querySelectorAll('[data-testid=cs-big]')].find((c) => c.textContent.includes(${JSON.stringify(sessions[4].item.key)}))`;
    const tailShown = await wait(async () => tjs(`${bigFive}?.querySelector('[data-testid=cs-big-tail]')?.textContent.includes('marker-five') ?? false`), 8000);
    const threadBig = await tjs(`!![...document.querySelectorAll('[data-testid=cs-big]')].find((c) => c.textContent.includes('整理 Q4 backlog'))?.querySelector('[data-testid=cs-open-in-main]')`);
    check("总览把每个会话摊成大卡片，显示窗格最近几行；助手会话的卡片能在主窗口打开", overview && tailShown && threadBig, JSON.stringify({ overview, tailShown, threadBig, cards: await tjs(`document.querySelectorAll('[data-testid=cs-big]').length`) }));
    const overviewEdge = await tjs(`(() => { const name = document.querySelector('[data-testid=cs-project]').getBoundingClientRect(); const card = document.querySelector('[data-testid=cs-big]').getBoundingClientRect(); return Math.abs(name.left - card.left) <= 1; })()`);
    check("总览的第一张卡片齐项目名", overviewEdge);
    fs.writeFileSync(path.join(shots, "code-sessions-overview.png"), (await tw.webContents.capturePage()).toPNG());
    // A card of the session bar picked over the overview: back to the cells, its own selected.
    await tjs(`[...document.querySelectorAll('.cs-side .cs-row')].find((r) => r.textContent.includes(${JSON.stringify(sessions[3].item.key)}))?.click(); true`);
    const barToGrid = await wait(async () => tjs(`!document.querySelector('[data-testid=cs-overview]') && document.querySelector('[data-testid=cs-view-grid]').getAttribute('aria-pressed') === 'true' && (document.querySelector('.cs-cell[data-focused] .cs-cell-name')?.textContent ?? '').startsWith(${JSON.stringify(`${sessions[3].item.key} `)})`), 5000);
    check("在总览里点会话栏的卡片：切回格子视图并选中它的格子", barToGrid, await tjs(`document.querySelector('.cs-cell[data-focused] .cs-cell-name')?.textContent`));
    await tjs(`document.querySelector('[data-testid=cs-view-overview]').click(); true`);
    await wait(async () => tjs(`!!document.querySelector('[data-testid=cs-overview]')`), 3000);
    await tjs(`${bigFive}?.querySelector('[data-testid=cs-see-in-pane]')?.click(); true`);
    const backToGrid = await wait(async () => tjs(`!document.querySelector('[data-testid=cs-overview]') && document.querySelector('[data-testid=cs-view-grid]').getAttribute('aria-pressed') === 'true' && (document.querySelector('.cs-cell[data-focused] .cs-cell-name')?.textContent ?? '').startsWith(${JSON.stringify(`${sessions[4].item.key} `)})`), 5000);
    check("「在格子里看」回到格子并选中它的格子", backToGrid, await tjs(`document.querySelector('.cs-cell[data-focused] .cs-cell-name')?.textContent`));

    // ⌘K here too: the window's sessions, what to do, what ran before. ↵ goes to a session's cell; "clear" is in it.
    const mac = process.platform === "darwin";
    const paletteKey = () => tjs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: ${mac}, ctrlKey: ${!mac}, shiftKey: ${!mac}, bubbles: true, cancelable: true })); true`);
    await paletteKey();
    const paletteGroups = await wait(async () => tjs(`(() => { const h = [...document.querySelectorAll('[data-testid=cs-palette] [cmdk-group-heading]')].map((n) => n.textContent); return h.includes('进行中') && h.includes('做事') ? h : false; })()`), 3000);
    check("终端窗口里 ⌘K 打开同一套：等你 / 进行中 / 做事 / 历史，「清屏」在做事里", !!paletteGroups && (await tjs(`!!document.querySelector('[data-testid=cs-palette] [data-do=clear]')`)), JSON.stringify(paletteGroups));
    fs.writeFileSync(path.join(shots, "code-sessions-palette.png"), (await tw.webContents.capturePage()).toPNG());
    await tjs(`document.querySelector('[data-testid=cs-palette] [data-row="${sessions[5].id}"]')?.click(); true`);
    const paletteJumped = await wait(async () => tjs(`!document.querySelector('[data-testid=cs-palette]') && (document.querySelector('.cs-cell[data-focused] .cs-cell-name')?.textContent ?? '').startsWith(${JSON.stringify(sessions[5].item.key)})`), 3000);
    check("在 ⌘K 里选一个会话，跳到它的格子并选中", paletteJumped, await tjs(`document.querySelector('.cs-cell[data-focused] .cs-cell-name')?.textContent`));
    const focusedScreen = () => tjs(`[...(document.querySelector('.cs-cell[data-focused]')?.querySelectorAll('.xterm-rows > div') ?? [])].map((r) => r.textContent).join('\\n')`);
    await paletteKey();
    await wait(async () => tjs(`!!document.querySelector('[data-testid=cs-palette] [data-do=clear]')`), 3000);
    await tjs(`document.querySelector('[data-testid=cs-palette] [data-do=clear]').click(); true`);
    const cleared = await wait(async () => !(await focusedScreen()).includes("echo marker-six"), 4000);
    check("「清屏」让选中格子里的 shell 清屏（Ctrl+L）", cleared, (await focusedScreen()).slice(0, 200));
    await paletteKey();
    await wait(async () => tjs(`!!document.querySelector('[data-testid=cs-palette]')`), 2000);
    await paletteKey();
    check("再按 ⌘K 关掉它", await wait(async () => tjs(`!document.querySelector('[data-testid=cs-palette]')`), 2000));

    // A session whose terminal is gone keeps "continue" and offers the same new-terminal picker, starting in its
    // worktree (the project's repository and that worktree are the places now); a terminal opened there takes the cell.
    const repoDir = path.join(work, "code", "app");
    const wtDir = path.join(work, "code", "app-gone");
    fs.mkdirSync(repoDir, { recursive: true });
    const git = (...args) => execFileSync("git", ["-c", "user.email=dev@localhost", "-c", "user.name=Dev", ...args], { cwd: repoDir, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "start");
    git("worktree", "add", "-q", "-b", "gone/check", wtDir);
    // git names the worktree by its real path (/private/var on a Mac), as code link records it.
    const worktree = fs.realpathSync(wtDir);
    const repo = ctx.repos.create({ projectId: project.id, remote: repoDir });
    await ctx.repos.setCheckout(repoDir, repoDir);
    ctx.boards.update(project.id, board.id, { repoId: repo.id });
    const goneItem = ctx.items.create({ projectId: project.id, boardId: board.id, title: "终端已经没有了", workType: "coding", status: "doing", by: "human" });
    const gone = ctx.codeLink.store.createSession(project.id, { repoId: repo.id, branch: "gone/check", itemIds: [goneItem.id], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, worktree });
    ctx.codeLink.store.patchSession(project.id, gone.id, { state: "ended", endedAt: Date.now() });
    ctx.emit("codeLink/changed", project.id);
    const goneRow = `[...document.querySelectorAll('.cs-row')].find((r) => r.textContent.includes(${JSON.stringify(goneItem.key)}))`;
    // Ended, it is not the bar's but History's; opened there, it shows in a pane as before.
    const offBar = await wait(async () => tjs(`!${goneRow} && document.querySelectorAll('[data-testid=cs-new-terminal-where] option').length >= 2`), 8000);
    await tjs(`document.querySelector('[data-testid=cs-history]').click(); true`);
    const inHistory = await wait(async () => tjs(`!!${historyRowWith(goneItem.key)}`), 8000);
    check("结束的会话不在会话栏里，在历史里找得到", offBar && inHistory);
    fs.writeFileSync(path.join(shots, "code-sessions-history.png"), (await tw.webContents.capturePage()).toPNG());
    await tjs(`${historyRowWith(goneItem.key)}.click(); true`);
    await tjs(`document.querySelector('[data-testid=cs-history-back]').click(); true`);
    const goneCell = `document.querySelector('[data-testid=cs-ended]')`;
    const offered = await wait(async () => tjs(`(() => { const box = ${goneCell}; return !!box && [...box.querySelectorAll('button')].some((b) => b.textContent === '在新终端里接着做') && !!box.querySelector('[data-testid=cs-new-terminal-where]') && !!box.querySelector('[data-testid=cs-new-terminal]'); })()`), 5000);
    check("终端已经没有的会话：保留「在新终端里接着做」，也有目录和「新终端」", offered);
    const startsIn = await tjs(`${goneCell}?.querySelector('[data-testid=cs-new-terminal-where]')?.value`);
    check("目录默认是这个会话的 worktree", startsIn === worktree, startsIn);
    const order = await tjs(`(() => { const box = ${goneCell}.querySelector('.cs-new-terminal'); const a = box.querySelector('select').getBoundingClientRect(); const b = box.querySelector('[data-testid=cs-new-terminal]').getBoundingClientRect(); return b.top >= a.bottom; })()`);
    const boxed = await tjs(`(() => { const s = getComputedStyle(${goneCell}.querySelector('select')); return s.borderTopStyle !== 'none' && parseFloat(s.borderTopWidth) > 0; })()`);
    check("目录下拉框有边框，「新终端」在它下方", order && boxed);
    // Seven panes side by side: narrow ones keep the label and the whole dropdown inside the pane.
    const inside = await tjs(`[...document.querySelectorAll('.cs-new-terminal-where')].map((row) => { const cell = row.closest('.cs-cell').getBoundingClientRect(); const label = row.querySelector('span').getBoundingClientRect(); const select = row.querySelector('select').getBoundingClientRect(); return label.left >= cell.left && select.right <= cell.right && label.width > 0; })`);
    // The ended session's cell is always one of them; how many empty ones there are depends on what was placed before.
    check("窄格子里「目录」和整个下拉框都在格子内", inside.length >= 1 && inside.every(Boolean), JSON.stringify(inside));
    await tjs(`(() => { const s = ${goneCell}.querySelector('select'); s.focus(); return true; })()`);
    const oneFrame = await tjs(`getComputedStyle(${goneCell}.querySelector('select')).boxShadow`);
    check("选过之后只有边框变色，不再多一圈", oneFrame === "none", oneFrame);
    fs.writeFileSync(path.join(shots, "code-sessions-ended.png"), (await tw.webContents.capturePage()).toPNG());
    // Followed by the cell's own id, not its place: other cells may come and go while herdr opens the pane.
    const goneId = await tjs(`${goneCell}.closest('.cs-cell').dataset.cell`);
    await tjs(`${goneCell}.querySelector('[data-testid=cs-new-terminal]').click(); true`);
    const took = await wait(async () => tjs(`(() => { const cell = document.querySelector('.cs-cell[data-cell="${goneId}"]'); return !!cell?.dataset.cellTerminal && !!cell.querySelector('.xterm') && cell.querySelector('.cs-cell-name').textContent.includes(${JSON.stringify(path.basename(wtDir))}); })()`), 20000);
    check("在那里开的新终端占了这个格子，目录就是 worktree", took);
    if (!took) {
      // What the cell showed instead, for TOM-404's last flaky step.
      const seen = await tjs(`(() => { const cell = document.querySelector('.cs-cell[data-cell="${goneId}"]'); return cell ? { terminal: cell.dataset.cellTerminal ?? null, xterm: !!cell.querySelector('.xterm'), name: cell.querySelector('.cs-cell-name')?.textContent ?? null, body: cell.textContent.slice(0, 200) } : null; })()`);
      console.log(`INFO: the cell after "新终端" → ${JSON.stringify(seen)}; saved terminals ${JSON.stringify(JSON.parse(fs.readFileSync(path.join(work, "code-sessions.json"), "utf8")).terminals?.[project.id] ?? [])}`);
      fs.writeFileSync(path.join(shots, "code-sessions-took.png"), (await tw.webContents.capturePage()).toPNG());
    }

    // A conversation had without a ticket, ended: in History by its title, and taken up again in a new terminal by
    // its agent's resume, in the folder it ran in.
    const talk = ctx.codeLink.store.createSession(project.id, { repoId: repo.id, branch: "", itemIds: [], mode: "terminal", agent: "claude-code", threadId: null, device: ctx.hub.deviceId, externalId: "talk-check-1" });
    const talkFile = path.join(work, "talk-check-1.jsonl");
    fs.writeFileSync(talkFile, [{ type: "user", message: { content: "侧栏该怎么分组？" } }, { type: "assistant", message: { content: [{ type: "text", text: "分成「这个窗口里」和「在其他地方」两组。" }, { type: "tool_use", id: "u1", name: "Bash", input: { command: "rg -n Sidebar", description: "Show the sidebar code" } }] } }, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "Sidebar.tsx:15" }] } }].map((o) => JSON.stringify(o)).join("\n"));
    ctx.codeLink.store.patchSession(project.id, talk.id, { title: "终端侧栏设计讨论", prompted: true, cwd: repoDir, transcript: talkFile, state: "ended", endedAt: Date.now() });
    ctx.emit("codeLink/changed", project.id);
    await tjs(`document.querySelector('[data-testid=cs-history]').click(); true`);
    const talkRow = historyRowWith("终端侧栏设计讨论");
    const talkListed = await wait(async () => tjs(`!!${talkRow}`), 5000);
    check("没有工单的对话结束后在历史里，用它的标题", talkListed);
    await tjs(`${talkRow}?.click(); true`);
    await tjs(`document.querySelector('[data-testid=cs-history-back]').click(); true`);
    const offeredTalk = await wait(async () => tjs(`!!document.querySelector('[data-testid=cs-talk-on]')`), 5000);
    // Its cell says who worked it and shows the conversation, read-only, under the way to go on.
    const readBack = await wait(async () => tjs(`(() => { const by = document.querySelector('[data-testid=cs-ended-by]')?.textContent ?? ''; const lines = [...document.querySelectorAll('[data-testid=cs-convo] .cs-convo-line')].map((l) => [l.dataset.who, l.textContent]); return by.startsWith('Claude Code') && JSON.stringify(lines) === JSON.stringify([["person", "侧栏该怎么分组？"], ["agent", "分成「这个窗口里」和「在其他地方」两组。"], ["tool", "Bash · Show the sidebar code"]]); })()`), 5000);
    check("结束的对话格子里写着是 Claude Code 做的，并只读显示当时的对话", readBack, JSON.stringify(await tjs(`document.querySelector('[data-testid=cs-ended]')?.textContent?.slice(0, 200)`)));
    // A tool call folds open to what it ran and what came back.
    await tjs(`document.querySelector('[data-testid=cs-convo] button.cs-convo-line')?.click(); true`);
    const toolOpened = await wait(async () => tjs(`(() => { const d = document.querySelector('[data-testid=cs-convo-detail]')?.textContent ?? ''; return d.includes('$ rg -n Sidebar') && d.includes('Sidebar.tsx:15'); })()`), 5000);
    check("点开工具调用，看到它跑的命令和输出", toolOpened);
    fs.writeFileSync(path.join(shots, "code-sessions-convo.png"), (await tw.webContents.capturePage()).toPNG());
    const panesBefore = new Set(JSON.parse(herdr("pane", "list")).result.panes.map((p) => p.pane_id));
    await tjs(`document.querySelector('[data-testid=cs-talk-on]')?.click(); true`);
    const resumed = offeredTalk && (await wait(async () => {
      const fresh = JSON.parse(herdr("pane", "list")).result.panes.filter((p) => !panesBefore.has(p.pane_id));
      return fresh.some((p) => p.cwd === fs.realpathSync(repoDir) || p.cwd === repoDir) && fresh.some((p) => herdr("pane", "read", p.pane_id, "--source", "recent", "--lines", "20").includes("claude --resume talk-check-1"));
    }, 15000));
    check("「在新终端里接着聊」在它原来的文件夹开新终端，跑 claude --resume", resumed);
    // Its cell attached before what follows counts the cells.
    await wait(async () => tjs(`[...document.querySelectorAll('.cs-cell')].every((c) => !c.dataset.cellTerminal || !!c.querySelector('.xterm'))`), 10000);

    // A pane that ran Codex before the session it shows now: its row folds open to that one, which opens in a cell.
    const earlier = ctx.codeLink.store.createSession(project.id, { repoId: repo.id, branch: "", itemIds: [], mode: "terminal", agent: "codex", threadId: null, device: ctx.hub.deviceId, externalId: "hist-check-1" });
    ctx.codeLink.store.patchSession(project.id, earlier.id, { herdrPane: sessions[0].pane, title: "之前在这个窗格里", prompted: true, state: "ended", endedAt: Date.now() });
    ctx.emit("codeLink/changed", project.id);
    // Another pane has its own history by now: the chevron is the one on this pane's row.
    const paneRow = `[...document.querySelectorAll('.cs-list > li')].find((li) => li.querySelector(':scope > .cs-fold-row .cs-row-head > :first-child')?.textContent === ${JSON.stringify(sessions[0].item.key)})`;
    const history = await wait(async () => tjs(`(() => { const li = ${paneRow}; const chev = li?.querySelector('[data-testid=cs-pane-history]'); if (!chev) return false; if (chev.getAttribute('aria-expanded') !== 'true') chev.click(); return [...li.querySelectorAll('[data-testid=cs-timeline] .cs-row')].some((r) => r.textContent.includes('之前在这个窗格里')); })()`), 8000);
    await tjs(`[...(${paneRow})?.querySelectorAll('[data-testid=cs-timeline] .cs-row') ?? []].find((r) => r.textContent.includes('之前在这个窗格里'))?.click(); true`);
    // It has no record to read back: its cell says only who worked it.
    const openedBefore = history && (await wait(async () => tjs(`[...document.querySelectorAll('[data-testid=cs-ended]')].some((e) => e.textContent.includes('Codex'))`), 8000));
    check("窗格之前跑过的会话：行左边的箭头展开时间线，点一条在格子里打开", history && openedBefore, JSON.stringify(await tjs(`({ timeline: [...document.querySelectorAll('[data-testid=cs-timeline] .cs-row')].map((r) => r.textContent), ended: [...document.querySelectorAll('[data-testid=cs-ended]')].map((e) => e.textContent.slice(0, 80)) })`)));

    // Put back what that cell showed: the restart below types in its terminal.
    await tjs(`document.querySelector('[data-testid=cs-toast-action]')?.click(); true`);
    await wait(async () => tjs(`!!document.querySelector('.cs-cell[data-cell="${goneId}"] .xterm')`), 8000);

    // History finds a conversation by something said in it, not only by its title, and quotes the line.
    await tjs(`document.querySelector('[data-testid=cs-history]').click(); true`);
    await wait(async () => tjs(`!!document.querySelector('[data-testid=ai-review-search]')`), 5000);
    await tjs(`(() => { const box = document.querySelector('[data-testid=ai-review-search]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(box, '这个窗口里'); box.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const foundSaid = await wait(async () => tjs(`[...document.querySelectorAll('[data-testid=ai-review-list] .ai-review-row')].some((r) => r.textContent.includes('终端侧栏设计讨论') && (r.querySelector('[data-testid=ai-review-said]')?.textContent ?? '').includes('这个窗口里'))`), 8000);
    check("历史里搜对话里说过的词，找到那段对话并引出说过的那句", foundSaid, JSON.stringify(await tjs(`[...document.querySelectorAll('[data-testid=ai-review-list] .ai-review-row')].map((r) => r.textContent)`)));
    await tjs(`document.querySelector('[data-testid=cs-history-back]').click(); true`);

    // herdr's server goes away under the window (this run's own, by its socket): Tomrade starts it again, herdr brings
    // the panes back with their ids, and the cells attach on their own.
    const paneIds = () => JSON.parse(herdr("pane", "list")).result.panes.map((p) => p.pane_id).sort().join(",");
    const up = () => {
      try {
        return /status: running/.test(herdr("status"));
      } catch {
        return false;
      }
    };
    const before = paneIds();
    const attachedBefore = await tjs(`document.querySelectorAll('.cs-cell .xterm').length`);
    const own = herdr("status").match(/socket:\s*(\S+)/)?.[1] === ownSocket;
    if (own) herdr("server", "stop");
    const wentDown = await wait(async () => !up(), 10000);
    const cameBack = wentDown && (await wait(async () => up() && paneIds() === before, 30000));
    check("herdr 服务停掉后，Tomrade 自己把它重新启动，pane 原样回来", own && cameBack, `before ${before} · after ${up() ? paneIds() : "not running"}`);
    const reattached = await wait(async () => tjs(`document.querySelectorAll('.cs-cell .xterm').length === ${attachedBefore} && ![...document.querySelectorAll('.cs-term-closed')].some((e) => e.offsetParent)`), 20000);
    check("格子自己重新连上，不用点「重新连接」", reattached, JSON.stringify({ before: attachedBefore, cells: await tjs(`[...document.querySelectorAll('.cs-cell')].map((c) => [c.querySelector('.cs-cell-name')?.textContent?.slice(0, 30), !!c.querySelector('.xterm'), !!c.querySelector('.cs-term-closed')?.offsetParent])`) }));
    const here = await tjs(`[...document.querySelectorAll('.cs-cell')].indexOf(document.querySelector('.cs-cell[data-cell="${goneId}"]'))`);
    const answers = here >= 0 && (await typeInCell(tw.webContents, tjs, here, "echo back-after-restart", "back-after-restart"));
    check("重启后在终端里输入照常有回显", answers);

    // A Gemini CLI session Tomrade started reports through the hooks in its own Gemini home (TOM-684): each one, run as
    // Gemini runs it (bash -c, Gemini's own payload on stdin), says nothing back and gives the session its id and its
    // record; once it ends, History reads the conversation from that record. Gemini CLI's reader is the official
    // plugin's when it is loaded, else a stand-in that reads the fixture's lines.
    if (!ctx.agent.engineOf("gemini")) {
      const standIn = { find: () => null, read: (file) => ({ lines: fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).flatMap((m) => (m.type === "user" ? [{ who: "person", text: m.content[0].text }] : m.type === "gemini" ? [{ who: "agent", text: m.content }] : [])), cut: false, start: 0 }) };
      ctx.agent.engine({ id: "gemini", title: "Gemini CLI", author: "ai:gemini", terminal: { mode: "only" }, local: { record: standIn }, available: async () => ({ ok: true }), async turn() { return { stop: "error", error: "terminal only" }; } });
    }
    const geminiItem = ctx.items.create({ projectId: project.id, boardId: board.id, title: "Gemini 终端会话", workType: "coding", status: "doing", by: "human" });
    const geminiSession = ctx.codeLink.store.createSession(project.id, { repoId: "check", branch: `${geminiItem.key.toLowerCase()}/check`, itemIds: [geminiItem.id], mode: "terminal", agent: "gemini", threadId: null, device: ctx.hub.deviceId, worktree: cwd });
    ctx.codeLink.store.patchSession(project.id, geminiSession.id, { state: "running" });
    // The session home is made from a stand-in ~/.gemini, so this run links nothing of the person's.
    const ownGemini = process.env.GEMINI_CLI_HOME;
    process.env.GEMINI_CLI_HOME = fs.mkdtempSync(path.join(work, "gemini-own-"));
    const geminiFiles = ctx.codeLink.sessions.bind(geminiSession, "ai:gemini", ctx.codeLink.sessionDir(geminiSession.id), "Say hi");
    if (ownGemini === undefined) delete process.env.GEMINI_CLI_HOME;
    else process.env.GEMINI_CLI_HOME = ownGemini;
    const geminiHooks = JSON.parse(fs.readFileSync(path.join(geminiFiles.geminiHome, ".gemini", "settings.json"), "utf8")).hooks ?? {};
    const geminiRecord = path.join(work, "session-2026-10-27T12-00-gemchk01.jsonl");
    fs.writeFileSync(geminiRecord, [{ sessionId: "gemchk01-check", projectHash: "x", startTime: "2026-10-27T12:00:00.000Z", kind: "main" }, { id: "m1", type: "user", content: [{ text: "说声你好" }] }, { id: "m2", type: "gemini", content: "你好！" }].map((o) => JSON.stringify(o)).join("\n") + "\n");
    const geminiBase = { session_id: "gemchk01-check", transcript_path: geminiRecord, cwd, timestamp: new Date().toISOString() };
    const geminiEvents = [
      ["SessionStart", { source: "startup" }],
      ["BeforeAgent", { prompt: "说声你好" }],
      ["BeforeTool", { tool_name: "run_shell_command", tool_input: { command: "echo 你好" } }],
      ["AfterTool", { tool_name: "run_shell_command", tool_input: { command: "echo 你好" }, tool_response: { llmContent: "Output: 你好", returnDisplay: "你好" } }],
      ["AfterAgent", { prompt: "说声你好", prompt_response: "你好！", stop_hook_active: false }],
      ["SessionEnd", { reason: "exit" }]
    ];
    // Not execFileSync: the hook posts to this process's own server, which must keep answering.
    const runHook = (command, payload) => new Promise((resolve) => {
      const child = spawn("bash", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => resolve({ code, out }));
      child.stdin.end(JSON.stringify(payload));
    });
    const hookRuns = [];
    for (const [event, fields] of geminiEvents) {
      const command = geminiHooks[event]?.at(-1)?.hooks?.[0]?.command;
      hookRuns.push(command ? await runHook(command, { ...geminiBase, hook_event_name: event, ...fields }) : { code: "no hook", out: "" });
    }
    const reported = ctx.codeLink.store.session(project.id, geminiSession.id);
    check("Gemini 会话主目录里的 hooks 照 Gemini 的方式运行：不往回打印，退出码 0，会话拿到 Gemini 的会话 id 和记录，结束后标为结束", hookRuns.every((r) => r.code === 0 && r.out === "") && reported?.externalId === "gemchk01-check" && reported?.transcript === geminiRecord && reported?.state === "ended", JSON.stringify({ hookRuns, session: { externalId: reported?.externalId, transcript: reported?.transcript, state: reported?.state } }));
    ctx.emit("codeLink/changed", project.id);
    await tjs(`document.querySelector('[data-testid=cs-history]').click(); true`);
    const geminiRow = historyRowWith(geminiItem.key);
    const geminiListed = await wait(async () => tjs(`!!${geminiRow}`), 8000);
    await tjs(`${geminiRow}?.click(); true`);
    const geminiRead = geminiListed && (await wait(async () => tjs(`(() => { const ended = [...document.querySelectorAll('[data-testid=cs-ended]')].find((e) => (e.querySelector('[data-testid=cs-ended-by]')?.textContent ?? '').startsWith('Gemini CLI')); const lines = [...(ended?.querySelectorAll('[data-testid=cs-convo] .cs-convo-line') ?? [])].map((l) => [l.dataset.who, l.textContent]); return JSON.stringify(lines.slice(0, 1)) === JSON.stringify([["person", "说声你好"]]) && lines.some(([who, text]) => who === "agent" && text === "你好！"); })()`), 8000));
    check("新开的 Gemini CLI 会话结束后，历史里能看到它的对话", geminiRead, JSON.stringify(await tjs(`[...document.querySelectorAll('[data-testid=cs-ended]')].map((e) => e.textContent.slice(0, 160))`)));
    fs.writeFileSync(path.join(shots, "code-sessions-gemini.png"), (await tw.webContents.capturePage()).toPNG());
    await tjs(`document.querySelector('[data-testid=cs-history-back]')?.click(); true`);
    tw.close();
  } catch (error) {
    check("检查跑完", false, error?.stack ?? String(error));
  } finally {
    for (const p of others) p.kill();
    try {
      // Stop only this run's server: never one that a changed environment points elsewhere.
      const socket = herdr("status").match(/socket:\s*(\S+)/)?.[1];
      if (socket === ownSocket) herdr("server", "stop");
      else console.log(`INFO: left herdr at ${socket ?? "an unknown socket"} running; this run's is ${ownSocket}`);
    } catch {
      // already gone
    }
    server?.kill();
    fs.rmSync(path.join(os.homedir(), ".config/herdr/sessions", HERDR_SESSION), { recursive: true, force: true });
    const moved = changedLinks(linksBefore);
    check("没有改动本机 agent 自己配置里的 Tomrade 条目", !moved.length, JSON.stringify(moved));
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed${shots === work ? ` · screenshots in ${work}` : ""}`);
    app.exit(failed ? 1 : 0);
  }
});
