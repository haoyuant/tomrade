/**
 * Films the real app for Tomrade's demo videos: boots it on a fresh data folder, seeds the "Feedback form"
 * project, then drives the UI the way a person would — a drawn cursor that travels before each click, text typed
 * key by key — while an offscreen window paints every frame into ffmpeg. The agents are the person's own (Claude
 * Code, Codex); nothing they say or do is scripted. Each step's time goes to <out>.markers.json for the edit.
 *
 * pnpm build:backend && pnpm dev:ui, then from apps/desktop:
 *   npx electron scripts/film.mjs <scene> [out-dir]
 * scenes: idea, waiting, night, morning, tidy, takeover, inbox, ship, look, claim, files, plugins, kegel, pomowidget,
 * petmoods, dpair, dphone. A take is cut into a short by film-short.mjs from an edit in film-edits/.
 *
 * `waiting` films the real Terminal window on screen (its terminals draw with WebGL, which an offscreen window has
 * not got), at full-screen size: six Claude Code sessions in herdr panes, and every ask answered from its card in the
 * sidebar. It needs the demo repository cloned at FILM_REPO (default ~/Demo/tomrade-demo-drafts), herdr, a signed-in
 * Claude Code, swiftc and Screen Recording. Only that window is recorded, so the computer stays free to use.
 *
 * `night` films an auto run from start to morning report: the main window on screen at full-screen size, and the
 * Terminal window beside it for the agents at work. Its deliveries merge into the demo repository's main, so a take
 * after it starts from `.demo/reset.sh`.
 *
 * `plugins`, `kegel` and `pomowidget` load plugins from a tomrade-plugins checkout beside this one (~/Projects).
 * `dpair` connects a Discord bot from the token in ~/TomradeDemo/.discord-demo-token and waits for its pairing code;
 * `dphone` then runs on that take's data (FILM_WORK) and films the iPhone Mirroring window beside the app.
 */
import { app, BrowserWindow, screen } from "electron";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A 1440×900 layout filmed at 1920×1200: an offscreen window paints at scale 1, so the page is zoomed instead.
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 4 / 3;
const FPS = Number(process.env.FILM_FPS ?? 60);
// What a scene in a window of its own fills: this display's full screen, in points.
const SCREEN = { width: Number(process.env.FILM_WIDTH ?? 3008), height: Number(process.env.FILM_HEIGHT ?? 1692) };
// A window behind others keeps drawing.
for (const flag of ["disable-renderer-backgrounding", "disable-backgrounding-occluded-windows"]) app.commandLine.appendSwitch(flag);
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
if (process.env.FILM_GPU === "0") app.disableHardwareAcceleration();

const FILM_TITLE = "Tomrade film";
const dir = path.dirname(fileURLToPath(import.meta.url));
const scene = process.argv[2] ?? "tidy";
const outDir = path.resolve(process.argv[3] ?? path.join(os.homedir(), "TomradeDemo", "film"));
fs.mkdirSync(outDir, { recursive: true });
// A scene can pick up an earlier take's data, for the morning after it.
const work = process.env.FILM_WORK ?? fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-film-"));
console.log(`[film] data in ${work}`);
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const acceptance = (...lines) => `\n\n## Acceptance\n${lines.map((line) => `- ${line}`).join("\n")}`;
// The same backlog as the demo repository's .demo/seed.mjs, so a take here matches a take in the installed app.
const SEED = [
  { slug: "readme", title: "Add a README with how to run it", status: "done", priority: 1, body: "Say what the app is and how to start it and run the tests." + acceptance("README.md names `npm start` and `npm test`.") },
  { slug: "failed-sends", title: "Handle failed sends in the feedback form", status: "done", priority: 3, body: "When sending fails, the text is kept and the person sees why." + acceptance("A failed send keeps the message and shows an error.", "Tests cover the failure.") },
  { slug: "polish", kind: "epic", title: "Polish the form", status: "todo", priority: 2, body: "Small things that make the form nicer to use." },
  { slug: "send-shortcut", parent: "polish", title: "Send with ⌘/Ctrl+Enter", status: "todo", priority: 2, body: "People who type a lot want to send without reaching for the mouse." + acceptance("⌘+Enter on macOS and Ctrl+Enter elsewhere send the form, exactly like pressing Send.", "Plain Enter still adds a new line.", "The decision (is this key event a send shortcut?) is a pure helper in src/feedback.js with a node --test test.") },
  { slug: "chars-left", parent: "polish", title: "Show how many characters are left near the limit", status: "backlog", priority: 1, body: "The limit is 2000 characters. From 1800 on, show how many are left instead of the count." + acceptance("At 1800+ the label reads “N left”.", "Tested in src/feedback.js.") },
  { slug: "dark-system", parent: "polish", title: "Follow the system's dark mode", status: "backlog", priority: 1, body: "Use prefers-color-scheme so the form is dark when the system is." + acceptance("Dark colours under prefers-color-scheme: dark.", "Text stays readable in both.") },
  { slug: "dark-mode", title: "Support dark mode", status: "backlog", priority: 1, body: "Someone asked for a dark version of the form." + acceptance("The form has a dark look.") },
  { slug: "emoji", title: "Count emoji as one character", status: "backlog", priority: 2, body: "👍 counts as 2 characters today; count what a person sees." + acceptance("countLabel counts user-perceived characters (Intl.Segmenter).", "Tests cover emoji and accented letters.") },
  { slug: "leave-warning", title: "Warn before closing the tab with unsent text", status: "backlog", priority: 1, body: "If the box has text that wasn't sent, ask before the tab closes." + acceptance("beforeunload asks only when there is unsent text.") },
  { slug: "v2", title: "Feedback v2: attachments, categories and follow-up by email", status: "backlog", priority: 1, body: "Let people attach a screenshot, pick a category (bug, idea, question) and leave an email address if they want an answer. Show a summary before sending, and send a confirmation email afterwards." }
];

// What `night` works through: the board's own story, a chain of real dependencies, so a run reads as a flow. The last one stays out, for Edit plan.
const NIGHT_SEED = [
  ...SEED.filter((item) => item.status === "done"),
  { slug: "draft", kind: "epic", title: "Keep drafts when the tab crashes", status: "todo", priority: 3, body: "People lose what they typed when the tab crashes." },
  { slug: "draft-save", parent: "draft", title: "Save the draft as people type", status: "todo", priority: 3, blocks: ["draft-restore", "draft-note"], body: "Keep what is in the box in localStorage, debounced, through a pure helper in src/feedback.js." + acceptance("Typing stores the draft in localStorage.", "The storage helpers are pure and tested with node --test.") },
  { slug: "draft-restore", parent: "draft", title: "Restore the draft when the form opens", status: "todo", priority: 3, blocks: ["draft-clear"], body: "If a draft was saved, put it back in the box on load." + acceptance("Reloading the page brings the text back.", "A missing or corrupt draft is ignored.") },
  { slug: "draft-note", parent: "draft", title: "Show a small 'draft saved' note", status: "todo", priority: 2, body: "A quiet note under the box after each save." + acceptance("The note shows after a save and is styled in src/style.css.") },
  { slug: "draft-clear", parent: "draft", title: "Clear the draft after a successful send", status: "todo", priority: 3, blocks: ["draft-docs"], body: "A sent message must not come back." + acceptance("A successful send removes the draft.", "A failed send keeps it.") },
  { slug: "draft-docs", parent: "draft", title: "Explain drafts in the README", status: "todo", priority: 1, body: "One short section: what is saved, where, and when it is cleared." + acceptance("README.md has a Drafts section.", "Only README.md changes.") }
];

/** Paints every frame of `win` into an H.264 master at a steady 30 fps, repeating the last frame while nothing changes. */
function film(win, file) {
  const size = { width: Math.round(WIDTH * SCALE), height: Math.round(HEIGHT * SCALE) };
  const ffmpeg = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${size.width}x${size.height}`, "-r", String(FPS), "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", file], { stdio: ["pipe", "inherit", "inherit"] });
  // The newest paint stays an image until a frame is due: converting every paint stalls the painter.
  let fresh = null;
  let last = null;
  let told = false;
  let paints = 0;
  const perSecond = [];
  win.webContents.on("paint", (_event, _dirty, image) => {
    const s = image.getSize();
    paints++;
    const sec = Math.floor((performance.now() - started) / 1000);
    perSecond[sec] = (perSecond[sec] ?? 0) + 1;
    if (!told) { told = true; console.log(`[film] paints ${s.width}×${s.height}`); }
    fresh = s.width === size.width && s.height === size.height ? image : image.resize(size);
  });
  win.webContents.setFrameRate(FPS);
  const started = performance.now();
  let frames = 0;
  const tick = setInterval(() => {
    if (fresh) {
      last = fresh.toBitmap();
      fresh = null;
    }
    if (!last) return;
    // Catch up after a busy main thread, so the video's clock is the wall clock.
    const due = Math.floor(((performance.now() - started) / 1000) * FPS);
    while (frames < due) {
      ffmpeg.stdin.write(last);
      frames++;
    }
  }, 1000 / FPS / 2);
  return {
    at: () => (performance.now() - started) / 1000,
    async stop() {
      clearInterval(tick);
      const seconds = (performance.now() - started) / 1000;
      console.log(`[film] ${paints} paints in ${seconds.toFixed(1)} s, busiest second ${Math.max(0, ...perSecond.filter(Boolean))}, per second: ${perSecond.map((n) => n ?? 0).join(" ")}`);
      ffmpeg.stdin.end();
      await new Promise((resolve) => ffmpeg.on("close", resolve));
    }
  };
}

/**
 * Films one window by its title with ScreenCaptureKit (film-capture.swift): the compositor's real pixels, terminals'
 * WebGL included, and nothing else on the display, so the window can sit behind whatever the person is doing. The real
 * mouse stays out of the picture; the drawn cursor is the only one.
 */
/** A window's size in device pixels, which a zoomed shot needs: a 6016-wide capture stays sharp where a 3008-wide one blurs. */
const nativeSize = (win) => {
  const bounds = win.getBounds();
  const scale = screen.getDisplayMatching(bounds).scaleFactor;
  return { width: bounds.width * scale, height: bounds.height * scale };
};

function filmOneWindow(title, file, size, { fps = FPS, mbps = 240 } = {}) {
  const bin = path.join(os.tmpdir(), "tomrade-film-capture");
  const source = path.join(dir, "film-capture.swift");
  if (!fs.existsSync(bin) || fs.statSync(bin).mtimeMs < fs.statSync(source).mtimeMs) execFileSync("swiftc", ["-O", source, "-o", bin], { stdio: "inherit" });
  const capture = spawn(bin, [title, file, String(size.width), String(size.height), String(fps), String(mbps)], { stdio: ["pipe", "pipe", "inherit"] });
  const closed = new Promise((resolve) => capture.on("close", resolve));
  let started = performance.now();
  // The clock is the film's: it starts with the first frame written.
  const ready = new Promise((resolve, reject) => {
    capture.stdout.once("data", () => { started = performance.now(); resolve(); });
    closed.then((code) => reject(new Error(`film-capture stopped before its first frame: ${code}`)));
  });
  return {
    ready,
    at: () => (performance.now() - started) / 1000,
    async stop() {
      capture.stdin.write("q\n");
      capture.stdin.end();
      const code = await closed;
      if (code) console.error(`[film] film-capture exited with ${code}`);
    }
  };
}

/** A drawn cursor, clicks and typing that reach the page as real input events; `log` hears each, for the sound. */
function hands(win, log = () => {}, scale = SCALE) {
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const pos = { x: WIDTH * 0.62, y: HEIGHT * 0.55 };
  // Page coordinates are CSS pixels of the 1440×900 layout; input events take the window's own.
  const px = (v) => Math.round(v * scale);
  const cursor = async () =>
    $(`(() => {
      if (document.getElementById('film-cursor')) return true;
      // A film shows no one's home directory: paths on screen read from ~ instead.
      const home = ${JSON.stringify(os.homedir())};
      const scrub = (root) => { const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); while (walk.nextNode()) if (walk.currentNode.data.includes(home)) walk.currentNode.data = walk.currentNode.data.split(home).join('~'); };
      scrub(document.body);
      new MutationObserver(() => scrub(document.body)).observe(document.body, { childList: true, subtree: true, characterData: true });
      const c = document.createElement('div');
      c.id = 'film-cursor';
      c.innerHTML = '<svg width="22" height="28" viewBox="0 0 22 28"><path d="M2 2 L2 22 L7.5 17 L11 25.5 L14.6 24 L11.2 15.8 L18.5 15.8 Z" fill="#1f1a17" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
      Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none', transform: 'translate(${pos.x}px, ${pos.y}px)', transition: 'transform 520ms cubic-bezier(.3,.1,.2,1)', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.25))' });
      const ring = document.createElement('div');
      ring.id = 'film-ring';
      Object.assign(ring.style, { position: 'fixed', left: '-14px', top: '-14px', width: '28px', height: '28px', borderRadius: '50%', border: '2px solid rgba(181,72,44,.75)', zIndex: 2147483646, pointerEvents: 'none', opacity: '0', transform: 'scale(.4)', transition: 'opacity 380ms, transform 380ms' });
      document.body.append(ring, c);
      return true;
    })()`);
  const rectOf = (expr) => $(`(() => { const n = ${expr}; if (!n) return null; n.scrollIntoView({ block: 'nearest' }); const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const moveTo = async (x, y) => {
    await cursor();
    await $(`document.getElementById('film-cursor').style.transform = 'translate(${x}px, ${y}px)'`);
    win.webContents.sendInputEvent({ type: "mouseMove", x: px(x), y: px(y) });
    pos.x = x;
    pos.y = y;
    await sleep(620);
  };
  return {
    $,
    cursor,
    async waitFor(js, what, seconds = 60) {
      for (let i = 0; i < seconds * 10; i++) {
        if (await $(js)) return true;
        await sleep(100);
      }
      throw new Error(`timed out waiting for ${what}`);
    },
    async click(expr) {
      const at = await rectOf(expr);
      if (!at) throw new Error(`nothing to click: ${expr}`);
      await moveTo(at.x, at.y);
      await sleep(200);
      await $(`(() => { const r = document.getElementById('film-ring'); r.style.transition = 'none'; r.style.opacity = '1'; r.style.transform = 'translate(${at.x}px, ${at.y}px) scale(.4)'; r.offsetWidth; r.style.transition = 'opacity 380ms, transform 380ms'; r.style.opacity = '0'; r.style.transform = 'translate(${at.x}px, ${at.y}px) scale(1.3)'; })()`);
      const x = px(at.x);
      const y = px(at.y);
      log("click");
      win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      await sleep(70);
      win.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      await sleep(350);
    },
    async type(text, perKey = 38) {
      for (const ch of text) {
        log("key");
        win.webContents.sendInputEvent({ type: "char", keyCode: ch });
        await sleep(perKey + (/[ ,.:]/.test(ch) ? 40 : 0));
      }
    },
    async key(keyCode, modifiers = []) {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await sleep(150);
    },
    /** Scrolls a thing into the middle of view the way a hand would, not in a jump. */
    async glide(expr) {
      await $(`${expr}?.scrollIntoView({ block: 'center', behavior: 'smooth' })`);
      await sleep(900);
    },
    async hover(expr) {
      const at = await rectOf(expr);
      if (at) await moveTo(at.x, at.y);
    }
  };
}

/** The demo repository, connected on this machine, with no earlier take's worktrees or ticket branches in the way. */
async function connectRepo(ctx, project) {
  const repoDir = process.env.FILM_REPO ?? path.join(os.homedir(), "Demo", "tomrade-demo-drafts");
  const git = (...args) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
  for (const line of git("worktree", "list", "--porcelain").split("\n")) {
    const dir = /^worktree (.+)$/.exec(line)?.[1];
    if (dir && path.resolve(dir) !== path.resolve(repoDir)) execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: repoDir });
  }
  git("worktree", "prune");
  // An agent started by hand works in the checkout itself.
  git("checkout", "main");
  for (const branch of git("branch", "--list").split("\n").map((b) => b.replace(/^[*+ ]+/, "").trim()).filter((b) => b && b !== "main")) git("branch", "-D", branch);
  // Offline the checkout is filmed as it stands.
  try { git("pull", "--ff-only", "origin", "main"); } catch (error) { console.log(`[film] pull skipped: ${String(error.stderr ?? error).trim().slice(0, 120)}`); }
  // A brief already written: no orientation conversation opens beside the sessions.
  await ctx.tools.execute("update_project_brief", { body: "# Feedback form\n\nA small feedback form: index.html, src/feedback.js (pure logic), src/main.js (DOM). `npm test` runs node --test. No dependencies, no build." }, { by: "human", projectId: project.id });
  const { repo } = await ctx.repos.addFromFolder(project.id, repoDir);
  const board = ctx.boards.list(project.id)[0];
  ctx.boards.update(project.id, board.id, { repoId: repo.id, repoPath: "" });
  const connected = await ctx.codeLink.connect(project.id, repo.id, "local");
  console.log(`[film] connected ${repoDir}: ${JSON.stringify(connected).slice(0, 300)}`);
}

/** The Terminal window with six empty panes, two rows of three, sized like a full screen behind whatever is in front. */
async function openPanes(ctx, project) {
  const leaf = (n) => ({ type: "leaf", id: `c${n}`, sessionId: null });
  const row = (n) => ({ type: "split", id: `row${n}`, direction: "row", ratio: 1 / 3, a: leaf(n), b: { type: "split", id: `rest${n}`, direction: "row", ratio: 0.5, a: leaf(n + 1), b: leaf(n + 2) } });
  fs.writeFileSync(path.join(work, "code-sessions.json"), JSON.stringify({ layouts: { [project.id]: { type: "split", id: "rows", direction: "column", ratio: 0.5, a: row(1), b: row(4) } } }));
  await ctx.contributions.run("code-sessions.open", { projectId: project.id });
  const terminal = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getTitle().endsWith(" — Terminal"));
  for (let i = 0; i < 300 && !terminal(); i++) await sleep(100);
  const win = terminal();
  if (!win) throw new Error("the Terminal window did not open");
  win.webContents.setBackgroundThrottling(false);
  win.setWindowButtonVisibility(false);
  win.setBounds({ x: 0, y: 40, ...SCREEN });
  await sleep(1500);
  return win;
}

/** Answers the assistant's open question: every proposal when it takes several, otherwise the first choice that says yes. */
async function answerAsk(h, mark) {
  mark("ask");
  // The agent may still be writing under its question; the choices only wake once it stops.
  await h.waitFor(`[...document.querySelectorAll('.q-ask:not(.done) .chip-opt')].every((b) => !b.disabled)`, "the choices to wake", 120);
  mark("choices");
  await sleep(1200);
  // Pick any: every proposal; pick one: the first that says yes.
  const multiple = await h.$(`/any/i.test([...document.querySelectorAll('.q-ask:not(.done) .q-eyebrow')].at(-1)?.textContent ?? '')`);
  const chips = await h.$(`document.querySelectorAll('.q-ask:not(.done) .chip-opt').length`);
  // A re-render can drop a pick, so every chip is checked until all of them are on.
  if (multiple) for (let round = 0; round < 3; round++) {
    for (let i = 0; i < chips; i++) {
      if (await h.$(`document.querySelectorAll('.q-ask:not(.done) .chip-opt')[${i}]?.getAttribute('aria-pressed') !== 'true'`)) await h.click(`document.querySelectorAll('.q-ask:not(.done) .chip-opt')[${i}]`);
    }
    await sleep(300);
    if (await h.$(`[...document.querySelectorAll('.q-ask:not(.done) .chip-opt')].every((b) => b.getAttribute('aria-pressed') === 'true')`)) break;
  }
  else await h.click(`[...document.querySelectorAll('.q-ask:not(.done) .chip-opt')].find((b) => /^(apply|yes|go|write|merge|do it|allow)/i.test(b.textContent.trim())) ?? document.querySelector('.q-ask:not(.done) .chip-opt')`);
  // Confirm only once the pick has taken; then wait for this question to close, so it is never answered twice.
  await h.waitFor(`document.querySelector('.q-ask:not(.done) .q-confirm button')?.disabled === false`, "Confirm to wake", 10);
  await h.click(`document.querySelector('.q-ask:not(.done) .q-confirm button')`);
  await h.waitFor(`!document.querySelector('.q-ask:not(.done)')`, "the question to close", 30);
  mark("answered");
}

/** A button or link by its words. */
const byText = (pattern) => `[...document.querySelectorAll('button, a, [role=button]')].find((b) => ${pattern}.test(b.textContent.trim()))`;

const running = `document.querySelector('.ai-send')?.getAttribute('aria-label') === 'Stop'`;
const idle = `!!document.querySelector('.ai-send') && document.querySelector('.ai-send').getAttribute('aria-label') !== 'Stop'`;

const SCENES = {
  /** No agent: the cursor and the keyboard, to measure how smoothly a take paints. */
  async probe({ h, mark }) {
    for (const expr of [`document.querySelector('.ai-input')`, `document.querySelector('.card')`, `document.querySelector('.ai-input')`]) await h.hover(expr);
    await h.click(`document.querySelector('.ai-input')`);
    mark("type");
    await h.type("Just checking how smooth this looks.");
    await sleep(1000);
  },

  /** Short B: the assistant tidies the backlog, the board changes, one click reverts the whole run. */
  tidy: { theme: "sunrise", screen: true, async act({ h, mark }) {
    await h.click(`document.querySelector('.ai-input')`);
    mark("type");
    await h.type("Tidy up the backlog: merge duplicates and split anything too big for one PR.");
    await sleep(400);
    await h.key("Enter");
    mark("sent");
    await h.waitFor(running, "the run to start", 30);
    // It may stop to ask before writing; the first choice that says yes answers it. Done is idle for four seconds straight.
    let idleSince = null;
    for (;;) {
      const state = await h.$(`(() => {
        const live = [...document.querySelectorAll('.q-ask:not(.done)')].at(-1);
        if (live) return 'ask';
        return ${idle} ? 'idle' : 'busy';
      })()`);
      if (state !== "idle") idleSince = null;
      else if (idleSince === null) idleSince = Date.now();
      else if (Date.now() - idleSince > 4000) break;
      // The big write is in once a run's footer shows: a later question would only split the story into more runs.
      if (await h.$(`document.querySelectorAll('.rf-btn').length > 0`)) break;
      if (state === "ask") {
        await answerAsk(h, mark);
      }
      await sleep(500);
    }
    mark("done");
    await sleep(2500);
    await h.hover(`document.querySelector('.rf-btn')`);
    await sleep(1200);
    mark("revert");
    await h.click(`document.querySelector('.rf-btn')`);
    await h.waitFor(`[...document.querySelectorAll('.rf-note')].some((n) => n.textContent.startsWith('Reverted'))`, "the revert", 30);
    mark("reverted");
    await sleep(3500);
  } },

  /**
   * Short F / main #12: the morning after a `night` take, FILM_WORK pointing at its data. Its report waits on judging each
   * delivery; a take that ended first has it written here, from that run, without the judging.
   */
  morning: {
    theme: "sunrise",
    screen: true,
    async prepare({ ctx, project }) {
      const nights = ctx.get("nightShift");
      const [last] = nights.list(project.id, 1);
      if (!last.briefPath) console.log(`[film] report: ${await nights.brief({ ...last, settings: { ...last.settings, judge: false } })}`);
    },
    async act({ h, mark, project }) {
      const brief = `document.querySelector('[data-testid=night-shift-brief]')`;
      await sleep(1500);
      mark("door");
      await h.click(`document.querySelector('.titlebar-night-shift')`);
      await h.waitFor(`!!${brief}`, "the last run", 30);
      mark("last");
      await sleep(2200);
      await h.click(brief);
      mark("report");
      await sleep(3500);
      // Down the page by hand, as a person reads it.
      await h.$(`(() => { const all = [...document.querySelectorAll('main *, [class*=file] *')].filter((n) => n.scrollHeight > n.clientHeight + 40 && getComputedStyle(n).overflowY !== 'visible'); all.sort((a, b) => b.clientHeight - a.clientHeight)[0]?.scrollBy({ top: 420, behavior: 'smooth' }); })()`);
      await sleep(3500);
      await h.$(`location.hash = '#/p/${project.id}'`);
      mark("board");
      await sleep(5000);
    }
  },

  /**
   * Short I: Files. Linked notes first (a spec, a decision log, a meeting), then the assistant draws the repository's
   * architecture with archify's trace animation, saves it into Files, it plays across the window, and is read back.
   */
  files: {
    theme: "sunrise",
    screen: true,
    prefix: "FI",
    async prepare({ ctx, project }) {
      await connectRepo(ctx, project);
      const write = (p, content) => ctx.tools.execute("write_file", { path: p, content }, { by: "human", projectId: project.id });
      await write("notes/Draft restore.md", "# Draft restore\n\nPeople lose what they typed when the tab crashes. Keep the draft in localStorage and bring it back on reload. #spec #feedback-form\n\n- Save as they type, debounced\n- Restore when the form opens\n- Clear after a successful send\n\nWhy localStorage and not the server: see [[Decisions]]. Discussed in [[2026-11-03 standup]].\n");
      await write("notes/Decisions.md", "# Decisions\n\n- **Drafts stay in the browser.** No account, no server call: [[Draft restore]] uses localStorage. #decision\n- **No build step.** Plain ES modules, `npm test` runs node --test. #decision\n");
      await write("notes/2026-11-03 standup.md", "# 2026-11-03 standup\n\n- Draft restore is next; spec in [[Draft restore]]. #meeting\n- Emoji count fixed in FI-8.\n");
    },
    async act({ h, mark }) {
      const settle = async (limit) => {
        const started = Date.now();
        let quiet = null;
        for (;;) {
          const state = await h.$(`document.querySelector('.q-ask:not(.done)') ? 'ask' : ${idle} ? 'idle' : 'busy'`);
          if (state === "ask") { await answerAsk(h, mark); quiet = null; }
          else if (state === "busy") quiet = null;
          else if (quiet === null) quiet = Date.now();
          else if (Date.now() - quiet > 4000) return;
          if (Date.now() - started > limit * 1000) { mark("out-of-time"); return; }
          await sleep(500);
        }
      };
      const entry = (name) => `[...document.querySelectorAll('.side-name')].find((n) => ${name}.test(n.textContent.trim()))?.closest('button, a, [role=treeitem], li')`;
      await sleep(1200);
      // Files itself: the notes folder, the spec with its links and tags, a link followed, the backlinks under it.
      await h.click(entry("/^notes$/"));
      mark("notes");
      await sleep(1400);
      await h.click(entry("/^Draft restore(\\.md)?$/"));
      await h.waitFor(`!!document.querySelector('.wikilink')`, "the spec to open", 20);
      mark("spec");
      await sleep(3500);
      await h.click(`[...document.querySelectorAll('.wikilink')].find((a) => /Decisions/.test(a.textContent))`);
      mark("follow");
      await sleep(2500);
      await h.$(`document.querySelector('[data-testid="backlinks"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' })`);
      mark("backlinks");
      await sleep(3500);
      // The diagram, asked for.
      await h.click(`document.querySelector('.ai-input')`);
      mark("type");
      await h.type("Draw this repo's architecture, animated, in the signal flow style.");
      await sleep(400);
      await h.key("Enter");
      mark("sent");
      await h.waitFor(running, "the run to start", 30);
      await settle(480);
      mark("saved");
      await sleep(2000);
      // Into Files with the panel aside, so the diagram's one animated pass plays across the window as it loads.
      await h.key("j", ["meta"]);
      await sleep(1000);
      await h.click(entry("/^diagrams$/"));
      await sleep(1200);
      // the folder archify was told to use, inside diagrams
      if (!(await h.$(`!!${entry("/^diagram\\.html$/")}`))) {
        await h.click(`(() => { const names = [...document.querySelectorAll('.side-name')].map((n) => n.textContent.trim()); const at = names.indexOf('diagrams'); return [...document.querySelectorAll('.side-name')][at + 1]?.closest('button, a, [role=treeitem], li'); })()`);
        await sleep(1200);
      }
      mark("folder");
      await h.click(entry("/^diagram\\.html$/"));
      await h.waitFor(`!!document.querySelector('iframe.html-view')`, "the diagram to open", 20);
      await h.$(`document.querySelector('iframe.html-view')?.scrollIntoView({ block: 'start' })`);
      mark("opened");
      await sleep(9000);
      mark("wide");
      await h.key("j", ["meta"]);
      await sleep(1200);
      await h.click(`document.querySelector('.ai-input')`);
      mark("ask2");
      await h.type("Which part sends the feedback? Check the diagram in Files.");
      await sleep(400);
      await h.key("Enter");
      mark("sent2");
      await h.waitFor(running, "the second run", 30);
      await settle(240);
      mark("answered2");
      await sleep(3000);
    }
  },

  /**
   * Short D, set up once off camera: the demo Discord bot connected from a token file, and a pairing code the person sends
   * it from their phone. The take after it (`dphone`) runs on this one's data through FILM_WORK.
   */
  dpair: {
    theme: "sunrise",
    prefix: "FD",
    async prepare({ ctx }) {
      ctx.plugins.addFolder(path.join(os.homedir(), "Projects", "tomrade-plugins", "packages", "discord"));
      const botToken = fs.readFileSync(path.join(os.homedir(), "TomradeDemo", ".discord-demo-token"), "utf8").trim();
      const settings = ctx.settings.get();
      ctx.settings.set({ ...settings, im: { ...(settings.im ?? {}), connections: [{ id: "demo-discord", adapterId: "discord", enabled: true, label: "Discord", credentials: { botToken } }] } });
      for (let i = 0; i < 120; i++) {
        const view = ctx.im.views().find((c) => c.id === "demo-discord");
        if (view?.state === "connected") { console.log(`[film] discord connected as ${JSON.stringify(view.identity ?? null)}`); break; }
        if (i % 5 === 0) console.log(`[film] discord: ${view?.state} ${JSON.stringify({ detail: view?.detail, missing: view?.missing, notices: view?.notices }).slice(0, 300)} adapters=${JSON.stringify(ctx.im.adapterViews?.() ?? null).slice(0, 120)}`);
        await sleep(1000);
      }
    },
    async act({ ctx, project, mark }) {
      const { code } = ctx.im.pairStart("demo-discord", project.id);
      console.log(`[film] PAIRING CODE ${code} — send it to the bot in a direct message`);
      mark("code");
      for (let i = 0; i < 900; i++) {
        if (ctx.im.pairConfirm("demo-discord")) { mark("paired"); console.log("[film] paired"); break; }
        if (i % 15 === 0) console.log(`[film] waiting: ${JSON.stringify(ctx.im.pairingViews()).slice(0, 200)} conn=${ctx.im.views().find((c) => c.id === "demo-discord")?.state}`);
        await sleep(1000);
      }
      await sleep(3000);
    }
  },

  /** Short D: a message from the phone becomes a ticket on the board. The phone, mirrored, is filmed beside the window. */
  dphone: {
    theme: "sunrise",
    screen: true,
    phone: true,
    async act({ ctx, project, mark }) {
      const before = ctx.items.listAll(project.id).length;
      mark("ready");
      console.log("[film] READY — send the message from the phone");
      for (let i = 0; i < 900; i++) {
        if (ctx.items.listAll(project.id).length > before) { mark("ticket"); break; }
        await sleep(500);
      }
      // the reply reaching the phone, and the card settling on the board
      await sleep(20000);
      mark("replied");
    }
  },

  /** Short H, its end: a plugin asked for in one sentence, written in the studio, loaded, and on screen in the status bar. */
  kegel: {
    theme: "sunrise",
    screen: true,
    prefix: "FK",
    async act({ h, mark }) {
      await sleep(1000);
      await h.click(`document.querySelector('.ai-input')`);
      mark("type");
      await h.type("Make me a tiny plugin: a status bar item that counts down 20 seconds, then says \"Kegel time! 该提肛了\".");
      await sleep(400);
      await h.key("Enter");
      mark("sent");
      await h.waitFor(running, "the run to start", 30);
      const started = Date.now();
      let quiet = null;
      for (;;) {
        if (await h.$(`!!${byText("/^Review( and load)?$/")}`)) { mark("build-ready"); break; }
        const state = await h.$(`document.querySelector('.q-ask:not(.done)') ? 'ask' : ${idle} ? 'idle' : 'busy'`);
        if (state === "ask") { await answerAsk(h, mark); quiet = null; }
        else if (state === "busy") quiet = null;
        else if (quiet === null) quiet = Date.now();
        else if (Date.now() - quiet > 8000) break;
        if (Date.now() - started > 900_000) { mark("out-of-time"); break; }
        await sleep(1000);
      }
      mark("built");
      await sleep(1500);
      await h.click(byText("/^Review( and load)?$/")).catch(() => mark("no-review"));
      await h.waitFor(`!!${byText("/^Load it$/")}`, "the load prompt", 15).catch(() => mark("no-load"));
      mark("review");
      await sleep(2500);
      await h.click(byText("/^Load it$/")).catch(() => null);
      mark("loaded");
      // the status bar's end sits under the assistant panel: it steps aside for the countdown
      await sleep(1200);
      await h.key("j", ["meta"]);
      mark("panel-closed");
      for (let i = 0; i < 90; i++) {
        if (await h.$(`/提肛|Kegel time/.test(document.body.innerText)`)) { mark("kegel"); break; }
        await sleep(1000);
      }
      await sleep(5000);
      mark("done");
    }
  },

  /**
   * Short H: everything is a plugin. One take through several, cut later into a grid: the pet watching an agent, the
   * Pomodoro timer in the status bar, a model provider and the plugin list in Settings, and a theme made from a picture.
   */
  plugins: {
    theme: "sunrise",
    screen: true,
    prefix: "FP",
    async prepare({ ctx, project }) {
      await connectRepo(ctx, project);
      const home = path.join(os.homedir(), "Projects", "tomrade-plugins", "packages");
      for (const name of ["pomodoro", "qwen"]) ctx.plugins.addFolder(path.join(home, name));
      const settings = ctx.settings.get();
      ctx.settings.set({ ...settings, pet: { ...settings.pet, enabled: true, displayMode: "embedded" } });
      await sleep(4000);
    },
    async act({ h, mark, ctx, project }) {
      const nav = (label) => `[...document.querySelectorAll('[role=dialog] button, [role=dialog] [role=tab], [role=dialog] a')].find((b) => ${label}.test(b.textContent.trim()))`;
      await sleep(1000);
      // The pet, while an agent works.
      await h.click(`document.querySelector('.ai-input')`);
      mark("pet-ask");
      await h.type("Which tickets are about drafts?");
      await sleep(300);
      await h.key("Enter");
      await h.waitFor(running, "the run to start", 30);
      mark("pet-working");
      await h.waitFor(idle, "the run to end", 180).catch(() => mark("pet-slow"));
      mark("pet-done");
      await sleep(3000);
      // The Pomodoro timer: started, then on to its break, in a status bar the assistant panel no longer covers.
      await h.key("j", ["meta"]);
      await sleep(1200);
      await ctx.tools.execute("pomodoro_control", { action: "toggle" }, { by: "human", projectId: project.id }).catch((e) => mark(`pomodoro-failed:${e.message}`));
      mark("pomodoro");
      await sleep(4000);
      await ctx.tools.execute("pomodoro_control", { action: "skip" }, { by: "human", projectId: project.id }).catch(() => null);
      mark("pomodoro-break");
      await sleep(4000);
      await h.key("j", ["meta"]);
      await sleep(1200);
      // Settings: the plugins, a model provider among the assistant's, and a theme from a picture.
      await h.click(`document.querySelector('use[href="#i-gear"]')?.closest('button')`);
      await sleep(1500);
      await h.click(nav("/^(Manage|Plugins)/i"));
      mark("plugins");
      await sleep(4500);
      await h.click(nav("/^Assistant/i"));
      mark("assistant");
      await sleep(1500);
      await h.$(`[...document.querySelectorAll('[role=dialog] *')].find((n) => n.children.length === 0 && /^Qwen/.test(n.textContent.trim()))?.scrollIntoView({ block: 'center', behavior: 'smooth' })`);
      mark("qwen");
      await sleep(4000);
      await h.click(nav("/^Appearance/i"));
      mark("appearance");
      await sleep(1500);
      await h.click(nav("/^AI theme from a picture/i"));
      await h.waitFor(`!!document.querySelector('[role=dialog] .picture-form')`, "the picture form", 10);
      mark("picture-form");
      await sleep(1200);
      // A picture painted here, a dusk over hills, so no one's photo is in the film.
      const picked = await h.$(`(async () => {
        const c = document.createElement('canvas'); c.width = 1600; c.height = 1000; const g = c.getContext('2d');
        const sky = g.createLinearGradient(0, 0, 0, 1000); sky.addColorStop(0, '#1d2550'); sky.addColorStop(0.55, '#c8607a'); sky.addColorStop(1, '#f2b179');
        g.fillStyle = sky; g.fillRect(0, 0, 1600, 1000);
        g.fillStyle = '#ffe2b0'; g.beginPath(); g.arc(1120, 560, 110, 0, Math.PI * 2); g.fill();
        for (let i = 0; i < 90; i++) { g.fillStyle = 'rgba(255,255,255,' + (0.3 + (i % 5) / 8) + ')'; g.fillRect((i * 173) % 1600, (i * 97) % 380, 2, 2); }
        [['#7a3f6b', 620, 90], ['#4a2a5c', 720, 120], ['#24193d', 820, 70]].forEach(([color, base, amp], k) => {
          g.fillStyle = color; g.beginPath(); g.moveTo(0, 1000);
          for (let x = 0; x <= 1600; x += 20) g.lineTo(x, base - amp * Math.sin(x / (210 + k * 60) + k) - amp * 0.4 * Math.sin(x / 70 + k * 2));
          g.lineTo(1600, 1000); g.fill();
        });
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        const input = document.querySelector('[role=dialog] .picture-form input[type=file]');
        if (!input) return false;
        const dt = new DataTransfer(); dt.items.add(new File([blob], 'dusk.png', { type: 'image/png' }));
        input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      mark(picked ? "picture" : "no-picture-input");
      await sleep(1800);
      await h.click(nav("/^The picture's own colours/i"));
      await sleep(800);
      await h.click(nav("/^Create theme$/i"));
      mark("create");
      await sleep(9000);
      mark("themed");
      await h.key("Escape");
      await sleep(5000);
      mark("board");
    }
  },

  /** Short H, the Pomodoro widget: its own floating window, enlarged and set on paper, counting down and turning to a break. */
  pomowidget: {
    theme: "sunrise",
    screen: true,
    prefix: "FW",
    async prepare({ ctx }) {
      ctx.plugins.addFolder(path.join(os.homedir(), "Projects", "tomrade-plugins", "packages", "pomodoro"));
      const widget = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.getTitle() === "Pomodoro");
      for (let i = 0; i < 100 && !widget(); i++) await sleep(200);
      const win = widget();
      if (!win) throw new Error("the Pomodoro widget did not open");
      win.webContents.setBackgroundThrottling(false);
      win.setAlwaysOnTop(false);
      win.setIgnoreMouseEvents(false);
      // three times its size, so it stays sharp when the film zooms into it; paper behind its transparent glass
      win.webContents.setZoomFactor(3);
      win.setSize(720, 444);
      await win.webContents.executeJavaScript(`document.documentElement.style.background = 'radial-gradient(120% 120% at 50% 110%, #f7cfa8 0%, #f6e3cd 45%, #f6efe3 100%)'`, true);
      await sleep(1500);
      return { win };
    },
    async act({ ctx, project, mark, win }) {
      await win.webContents.executeJavaScript(`document.getElementById('film-cursor')?.remove()`, true);
      await sleep(1500);
      await ctx.tools.execute("pomodoro_control", { action: "toggle" }, { by: "human", projectId: project.id });
      mark("focus");
      await sleep(6000);
      await ctx.tools.execute("pomodoro_control", { action: "skip" }, { by: "human", projectId: project.id });
      mark("break");
      await sleep(5000);
    }
  },

  /** Short H, the pet's states: Nini's own animation for each mood, side by side in its settings, filmed large. */
  petmoods: {
    theme: "sunrise",
    screen: true,
    prefix: "FN",
    async prepare({ ctx }) {
      const settings = ctx.settings.get();
      ctx.settings.set({ ...settings, pet: { ...settings.pet, enabled: true, displayMode: "embedded" } });
      await sleep(2000);
    },
    async act({ h, mark }) {
      const nav = (label) => `[...document.querySelectorAll('[role=dialog] button, [role=dialog] [role=tab], [role=dialog] a')].find((b) => ${label}.test(b.textContent.trim()))`;
      await h.click(`document.querySelector('use[href="#i-gear"]')?.closest('button')`);
      await sleep(1500);
      await h.click(nav("/^Pet$/"));
      await h.waitFor(`!!document.querySelector('[data-testid="pet-editor"]')`, "the pet editor", 15);
      await h.$(`document.querySelector('[data-testid="pet-editor"] .pet-slot')?.scrollIntoView({ block: 'start' })`);
      mark("moods");
      await sleep(12000);
      mark("done");
    }
  },

  /** Main #1–#3: one sentence becomes an epic and tickets on the board, then the dependency graph. */
  idea: {
    theme: "sunrise",
    screen: true,
    async act({ h, mark }) {
      await h.click(`document.querySelector('.ai-input')`);
      mark("type");
      await h.type("People lose their drafts when the tab crashes.");
      await sleep(400);
      await h.key("Enter");
      mark("sent");
      await h.waitFor(running, "the run to start", 30);
      // Each message ends in a run's footer; a second one asks for the split that the graph then shows.
      const settle = async (footers) => {
        let quiet = null;
        for (;;) {
          const state = await h.$(`document.querySelector('.q-ask:not(.done)') ? 'ask' : ${idle} ? 'idle' : 'busy'`);
          if (state === "ask") { await answerAsk(h, mark); quiet = null; }
          else if (state === "busy") quiet = null;
          else if (quiet === null) quiet = Date.now();
          else if (Date.now() - quiet > 3000 && (await h.$(`document.querySelectorAll('.rf-btn').length >= ${footers}`))) return;
          else if (Date.now() - quiet > 30000) return;
          await sleep(500);
        }
      };
      await settle(1);
      mark("first");
      await sleep(1500);
      await h.click(`document.querySelector('.ai-input')`);
      mark("reply");
      await h.type("Split that into three small tickets, with their dependencies.");
      await sleep(300);
      await h.key("Enter");
      await h.waitFor(running, "the reply to run", 30);
      await settle(2);
      mark("written");
      await sleep(3500);
      await h.click(`document.querySelector('use[href="#i-graph"]')?.closest('button')`).catch(() => mark("no-graph"));
      mark("graph");
      await sleep(4000);
    }
  },

  /** Short E: two GitHub issues land in the inbox triaged; one merges into a ticket, the other becomes one and gets a PR. */
  inbox: {
    theme: "sunrise",
    screen: true,
    prefix: "FL",
    async prepare({ ctx, project }) {
      await connectRepo(ctx, project);
    },
    async act({ h, mark }) {
      const q = (id) => `document.querySelector('[data-testid=${id}]')`;
      await sleep(1500);
      mark("open");
      await h.click(`document.querySelector('[data-module-door=inbox]')`);
      await h.waitFor(`!!document.querySelector('.sheet-inbox')`, "the inbox", 10);
      await sleep(1200);
      if (await h.$(`!!${q("inbox-enable-github")}`)) await h.click(q("inbox-enable-github"));
      await sleep(1200);
      mark("check");
      await h.click(byText("/^Check now/"));
      await h.waitFor(`document.querySelectorAll('.inbox-entry').length >= 2`, "the issues", 60);
      mark("entries");
      for (const round of [0, 1]) {
        await sleep(1500);
        await h.click(`document.querySelectorAll('.inbox-entry')[0]`);
        await h.waitFor(`!!${q("inbox-adopt")} && !${q("inbox-adopt")}.disabled`, "a suggestion", 120);
        mark(`suggested:${await h.$(`${q("inbox-suggestion")}.dataset.action`)}`);
        await sleep(2600);
        await h.click(q("inbox-adopt"));
        mark(`adopted:${round}`);
        await sleep(2000);
      }
      await h.key("Escape");
      await sleep(1500);
      mark("board");
      await sleep(3000);
    },
    async cleanup({ ctx, project }) {
      for (const s of ctx.codeLink.store.sessions(project.id, { live: true })) await ctx.codeLink.stopSession(project.id, s.id).catch(() => false);
    }
  },

  /** The board after a take, through FILM_WORK: along to the ticket that moved, and open on it. */
  look: {
    theme: "sunrise",
    screen: true,
    async act({ h, mark }) {
      const moved = `[...document.querySelectorAll('.card, [data-testid="card"]')].find((c) => ${process.env.FILM_LOOK ?? "/./"}.test(c.textContent))`;
      await sleep(1500);
      mark("board");
      await h.$(`(() => { const all = [...document.querySelectorAll('main *, [class*=board] *, [class*=board]')].filter((n) => n.scrollWidth > n.clientWidth + 120 && /auto|scroll/.test(getComputedStyle(n).overflowX)); all.sort((a, b) => b.clientWidth - a.clientWidth)[0]?.scrollBy({ left: 1400, behavior: 'smooth' }); })()`);
      await sleep(2500);
      mark("column");
      await h.click(moved);
      mark("ticket");
      await sleep(4500);
    }
  },

  /** Short E, its second half, picking up an `inbox` take through FILM_WORK: the new ticket is started and reaches a PR. */
  ship: {
    theme: "sunrise",
    screen: true,
    permission: "auto",
    async act({ h, mark, at, ctx, project }) {
      const fresh = ctx.items.listAll(project.id).filter((i) => /empty/i.test(i.title)).at(-1);
      if (!fresh) throw new Error("no ticket for the empty message");
      await sleep(1000);
      await h.click(`[...document.querySelectorAll('.card, [data-testid="card"]')].find((c) => /empty/i.test(c.textContent))`);
      await sleep(1800);
      mark("open");
      await h.click(byText("/^Start$/"));
      await sleep(1500);
      mark("dialog");
      await h.click(`[...document.querySelectorAll('[role=dialog] button')].find((b) => /^Start$/.test(b.textContent.trim()))`);
      mark("started");
      let was = fresh.status;
      for (;;) {
        const status = ctx.items.get(project.id, fresh.id)?.status;
        if (status !== was) mark(`status:${(was = status)}`);
        if (status === "verifying" || status === "done") break;
        if (at() > 300) { mark("out-of-time"); break; }
        for (const s of ctx.codeLink.store.sessions(project.id, { live: true })) if (s.state === "waiting") await ctx.codeLink.sessionTrust(project.id, s.id, "trust").catch(() => null);
        await sleep(1000);
      }
      await sleep(6000);
    },
    async cleanup({ ctx, project }) {
      for (const s of ctx.codeLink.store.sessions(project.id, { live: true })) await ctx.codeLink.stopSession(project.id, s.id).catch(() => false);
    }
  },

  /**
   * Short A: Claude Code started by hand in a terminal picks a ticket up itself, and the board follows. Filmed in the
   * Terminal window, with the board beside it to cut to. The shell keeps this person's prompt and Claude settings out of the picture.
   */
  claim: {
    theme: "sunrise",
    screen: true,
    prefix: "FK",
    async prepare({ ctx, project, mainWin }) {
      await connectRepo(ctx, project);
      const win = await openPanes(ctx, project);
      // Set up off camera: a shell's own prompt names the person and the machine, and their Claude settings name the account.
      const $ = (js) => win.webContents.executeJavaScript(js, true);
      await $(`${byText("/^New terminal$/")}.click()`);
      await sleep(2500);
      await $(`document.querySelector('.xterm-helper-textarea')?.focus()`);
      for (const ch of `export PROMPT='%1~ %# ' RPROMPT=''; claude() { command claude --model ${process.env.FILM_MODEL ?? "sonnet"} --effort low --setting-sources project,local --permission-mode auto "$@"; }; clear`) win.webContents.sendInputEvent({ type: "char", keyCode: ch });
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      await sleep(1500);
      return { win, beside: mainWin };
    },
    async act({ h, mark, at, ctx, project, keys }) {
      const key = keys.get("emoji");
      await sleep(1000);
      await h.$(`document.querySelector('.xterm-helper-textarea')?.focus()`);
      await sleep(300);
      mark("type");
      await h.type(`claude "Pick up ${key} from Tomrade and do it."`, 46);
      await sleep(500);
      await h.key("Enter");
      mark("sent");
      const item = ctx.items.listAll(project.id).find((i) => i.key === key);
      let was = item.status;
      for (;;) {
        const status = ctx.items.get(project.id, item.id)?.status;
        if (status !== was) mark(`status:${(was = status)}`);
        if (status === "verifying" || status === "done") break;
        if (at() > 300) { mark("out-of-time"); break; }
        await sleep(500);
      }
      await sleep(6000);
    },
    async cleanup({ ctx, project }) {
      for (const s of ctx.codeLink.store.sessions(project.id, { live: true })) await ctx.codeLink.stopSession(project.id, s.id).catch(() => false);
    }
  },

  /** Short G: an empty project over a repository with unfinished work; the scan drafts a backlog and the person ticks what is real. */
  takeover: {
    theme: "sunrise",
    screen: true,
    seed: false,
    async prepare({ ctx, project }) {
      await connectRepo(ctx, project);
    },
    async act({ h, mark }) {
      const q = (id) => `document.querySelector('[data-testid=${id}]')`;
      // The dialog names this machine's own folders, and a film shows no one's home directory.
      await h.$(`(() => {
        const plain = (node) => { if (/\\/Users\\//.test(node.textContent)) node.textContent = 'Tomrade would read Claude Code and Codex: the last 30 days of sessions that ran in these repositories, read only. Unticked, these files are not opened.'; };
        new MutationObserver(() => { const note = ${q("takeover-sessions-note")}; if (note) plain(note); }).observe(document.body, { childList: true, subtree: true, characterData: true });
      })()`);
      await h.waitFor(`!!${q("takeover-banner")}`, "the offer", 30);
      await sleep(2200);
      mark("banner");
      await h.click(q("takeover-open"));
      await h.waitFor(`!!${q("takeover-scan")} && !${q("takeover-scan")}.disabled`, "the scan to wake", 30);
      mark("dialog");
      await sleep(2000);
      if (await h.$(`!!${q("takeover-sessions")} && !${q("takeover-sessions")}.disabled && !${q("takeover-sessions")}.checked`)) await h.click(q("takeover-sessions"));
      mark("sessions");
      await sleep(1000);
      if (await h.$(`!!${q("takeover-model")} && !${q("takeover-model")}.checked`)) await h.click(q("takeover-model"));
      mark("model");
      await sleep(1200);
      await h.click(q("takeover-scan"));
      mark("scan");
      await h.waitFor(`!!${q("takeover-summary")}`, "the draft", 300);
      mark("draft");
      await sleep(3000);
      const ticks = await h.$(`document.querySelectorAll('[data-testid=takeover-tick]').length`);
      for (let i = 0; i < Math.min(3, ticks); i++) {
        await h.click(`document.querySelectorAll('[data-testid=takeover-tick]')[${i}]`);
        mark(`ticked:${i}`);
        await sleep(500);
      }
      await sleep(900);
      await h.click(q("takeover-apply"));
      await h.waitFor(`!${q("takeover-apply")}`, "the tickets", 60);
      mark("applied");
      await sleep(6000);
    }
  },

  /**
   * Short C' / main #4: two tickets start in the Terminal window, each with Claude Code in its own pane; whenever one
   * asks (the folder's trust, a permission, a question), the sidebar says so and the card answers it. Nothing is typed.
   */
  waiting: {
    theme: "sunrise",
    async prepare({ ctx, project, keys }) {
      await connectRepo(ctx, project);
      const items = ctx.items.listAll(project.id);
      const itemOf = (slug) => items.find((i) => i.key === keys.get(slug));
      const start = async (slug) => {
        // A cheap model: the work is a tiny form, takes are shot many times, and the pane's status line is on camera.
        const result = await ctx.codeLink.start(project.id, itemOf(slug).id, { mode: "terminal", engine: "claude-code", options: { model: process.env.FILM_MODEL ?? "sonnet", effort: process.env.FILM_EFFORT ?? "low" } });
        if (!result.ok) throw new Error(`${slug} did not start: ${result.gate} — ${result.message}`);
        console.log(`[film] ${keys.get(slug)} started in ${result.cwd} on ${result.branch}`);
        return result;
      };
      const win = await openPanes(ctx, project);
      return { win, start, keyOf: (slug) => keys.get(slug) };
    },
    async act({ h, mark, at, ctx, project, start, keyOf, win }) {
      const seconds = Number(process.env.FILM_SECONDS ?? 110);
      // The first button of the first card that asks: Trust and continue, Allow, or the agent's own first choice (its yes).
      const askButton = `document.querySelector('[data-testid=cs-row-actions] [data-testid=cs-trust], [data-testid=cs-row-actions] [data-testid=cs-allow], [data-testid=cs-row-actions] [data-testid=cs-choice]')`;
      const panes = `document.querySelectorAll('.xterm')`;
      let idleSince = at();
      let drift = 0;
      // On camera, one after another: the panes light up.
      const starting = (async () => {
        for (const slug of ["send-shortcut", "chars-left", "dark-system", "emoji", "leave-warning", "v2"]) {
          await start(slug);
          mark(`started:${keyOf(slug)}`);
          await sleep(1200);
        }
      })();
      let waiting = "";
      // Where each pane is in the film, for the edit: page pixels through the zoom, under the window's title bar.
      const zoom = win.webContents.getZoomFactor();
      const chrome = win.getBounds().height - win.getContentBounds().height;
      const cells = await h.$(`[...document.querySelectorAll('.cs-cell')].map((c) => { const r = c.getBoundingClientRect(); return { no: c.querySelector('.cs-cell-no')?.textContent, x: r.left, y: r.top, w: r.width, h: r.height }; })`);
      mark(`cells:${JSON.stringify(cells.map((c) => ({ no: c.no, x: c.x * zoom, y: c.y * zoom + chrome, w: c.w * zoom, h: c.h * zoom })))}`);
      const cellOfAsk = `(() => { let n = ${askButton}; while (n && !n.querySelector?.('.cs-where')) n = n.parentElement; return (n?.querySelector('.cs-where')?.textContent ?? '').replace(/\\D/g, ''); })()`;
      // A new worktree's trust (TOM-914: the Terminal window's card cannot answer it yet) is answered through the
      // panel itself, so the take gets on to the asks the card does answer; the edit cuts past it.
      const trusted = new Set();
      let lastTrust = 0;
      const trustWaiting = async () => {
        if (at() - lastTrust < 4) return;
        lastTrust = at();
        for (const s of ctx.codeLink.store.sessions(project.id, { live: true })) {
          if (s.state !== "waiting" || trusted.has(s.id)) continue;
          const answered = await ctx.codeLink.sessionTrust(project.id, s.id, "trust").catch(() => null);
          if (answered === "answered") { trusted.add(s.id); mark("trusted"); }
        }
      };
      while (at() < seconds) {
        await trustWaiting();
        const count = (await h.$(`document.querySelector('[data-testid=cs-waiting]')?.textContent ?? '0'`)).trim();
        if (count !== waiting) mark(`waiting:${(waiting = count)}`);
        const label = await h.$(`(() => { const b = ${askButton}; return b && !b.disabled ? b.textContent.trim() : null; })()`);
        if (label) {
          mark(`ask:${label}`);
          // Let the ask be read before it is answered: the sidebar's count, the card's words.
          await sleep(900);
          await h.hover(askButton);
          await sleep(300);
          // Answered in its pane meanwhile, or it moved on: the next ask is looked for afresh.
          const cell = await h.$(cellOfAsk);
          const pressed = await h.click(askButton).then(() => true, () => false);
          if (pressed) mark(`answered:${cell}`);
          idleSince = at();
          await sleep(800);
          continue;
        }
        // Between asks the cursor wanders to a pane now and then, as a person reading along would.
        if (at() - idleSince > 9) {
          await h.hover(`${panes}[${drift++ % 6}]`);
          idleSince = at();
        }
        await sleep(300);
      }
      await starting;
    },
    async cleanup({ ctx, project }) {
      for (const s of ctx.codeLink.store.sessions(project.id, { live: true })) await ctx.codeLink.stopSession(project.id, s.id).catch(() => false);
    }
  },

  /**
   * Short F / main #7–#12: an auto run from the graph to the morning report. The person picks the nodes, leaves one out,
   * starts it, adds that one back while it runs, and opens the report. Nothing about the run is scripted.
   */
  night: {
    theme: "daybreak",
    screen: true,
    prefix: "FN",
    seed: NIGHT_SEED,
    permission: "auto",
    capture: { mbps: 120 },
    async prepare({ ctx, project }) {
      await connectRepo(ctx, project);
      return { beside: await openPanes(ctx, project) };
    },
    async act({ h, mark, at, ctx, project, keys, beside }) {
      const seconds = Number(process.env.FILM_SECONDS ?? 1500);
      const q = (id) => `document.querySelector('[data-testid=${id}]')`;
      await sleep(1000);
      mark("door");
      await h.click(`document.querySelector('.titlebar-night-shift')`);
      await h.waitFor(`!!${q("plan-pick-suggested")} && !${q("plan-pick-suggested")}.disabled`, "the plan", 240);
      mark("planned");
      await sleep(1800);
      await h.click(q("plan-pick-suggested"));
      mark("suggested");
      await sleep(1500);
      // The chain, with its last ticket left out for Edit plan to bring in while the run goes.
      const take = ["draft-save", "draft-restore", "draft-note", "draft-clear"].map((slug) => keys.get(slug));
      const node = (key) => `document.querySelector('.plan-node[data-key="${key}"]')`;
      const allKeys = await h.$(`[...document.querySelectorAll('.plan-node')].map((n) => n.dataset.key)`);
      for (const key of allKeys) {
        const on = await h.$(`${node(key)}.classList.contains('is-chosen')`);
        if (on !== take.includes(key)) await h.click(node(key));
      }
      mark("left-out");
      await sleep(1200);
      await h.glide(`document.querySelector('[data-testid=night-shift-mode]')`);
      await h.click(`document.querySelector('[data-testid=night-shift-mode] [data-mode=terminal]')`);
      mark("where");
      await sleep(900);
      await h.glide(q("night-shift-auto-merge"));
      await h.hover(q("night-shift-auto-merge"));
      mark("merge");
      await sleep(1200);
      await h.click(q("night-shift-start"));
      await h.waitFor(`!!${q("night-shift-going")}`, "the run to start", 60);
      mark("going");
      // Terminal agents ask for a new worktree's trust (TOM-914) and now and then for something else: both are answered, off camera.
      const trusted = new Set();
      const unstick = async () => {
        for (const s of ctx.codeLink.store.sessions(project.id, { live: true })) {
          if (s.state !== "waiting" || trusted.has(s.id)) continue;
          if ((await ctx.codeLink.sessionTrust(project.id, s.id, "trust").catch(() => null)) === "answered") { trusted.add(s.id); mark("trusted"); }
        }
        await beside.webContents.executeJavaScript(`document.querySelector('[data-testid=cs-row-actions] [data-testid=cs-allow], [data-testid=cs-row-actions] [data-testid=cs-choice]')?.click()`, true);
      };
      let said = "";
      let steps = 0;
      let edited = false;
      for (;;) {
        await unstick();
        const facts = await h.$(`${q("night-shift-going")}?.textContent ?? null`);
        if (facts === null) break;
        if (facts !== said) mark(`facts:${(said = facts)}`);
        const count = await h.$(`document.querySelectorAll('[data-testid=plan-step]').length`);
        if (count !== steps) mark(`steps:${(steps = count)}`);
        if (!edited && (/[1-9] of \d+ delivered/.test(facts) || at() > 420)) {
          edited = true;
          await sleep(1500);
          mark("edit");
          await h.click(q("plan-edit"));
          await sleep(1400);
          const ghost = `document.querySelector('.plan-node[data-draft=ghost][data-key="${keys.get("draft-docs")}"]')`;
          if (await h.$(`!!${ghost}`)) {
            await h.click(ghost);
            await sleep(1300);
            mark("added");
            await h.click(q("plan-diff-apply"));
            mark("applied");
          } else await h.click(q("plan-diff-discard"));
        }
        if (at() > seconds) { mark("out-of-time"); break; }
        await sleep(1000);
      }
      mark("finished");
      // The report is written once the deliveries are judged.
      await h.waitFor(`!!${q("night-shift-brief")}`, "the report", 300).catch(() => mark("no-report"));
      await sleep(2500);
      if (await h.$(`!!${q("night-shift-brief")}`)) {
        await h.click(q("night-shift-brief"));
        mark("report");
        await sleep(6000);
      }
      await h.$(`location.hash = '#/p/${project.id}'`);
      mark("board");
      await sleep(5000);
    },
    async cleanup({ ctx, project }) {
      for (const s of ctx.codeLink.store.sessions(project.id, { live: true })) await ctx.codeLink.stopSession(project.id, s.id).catch(() => false);
    }
  }
};

async function run() {
  // As the app does before any extension loads: plugins share its SDK, cordis and zod.
  const { registerExtensionResolution } = await import("../dist/extension-resolve.js");
  registerExtensionResolution([path.resolve(dir, "../../.."), path.resolve(dir, "..")]);
  const { boot } = await import("../dist/boot.js");
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work, uiPages: base }, extensions: { root: path.join(work, "plugins"), trustedKeys: [], appVersion: null }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }, { id: "archify", config: { cacheDirectory: path.join(os.homedir(), ".cache", "tomrade", "archify") } }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  if (!process.env.FILM_WORK) for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const spec = typeof SCENES[scene] === "function" ? { act: SCENES[scene] } : SCENES[scene];
  // An earlier take's ticket branches stay on the remote until .demo/reset.sh: a scene with its own prefix starts clean of them.
  const project = process.env.FILM_WORK ? ctx.projects.list().find((p) => p.name === "Feedback form") : ctx.projects.create({ name: "Feedback form", keyPrefix: process.env.FILM_PREFIX ?? spec.prefix ?? "FB" });
  const keys = new Map();
  const seed = spec.seed === false || process.env.FILM_WORK ? [] : spec.seed ?? SEED;
  for (const item of seed) {
    const created = await ctx.tools.execute("create_item", { title: item.title, body: item.body, kind: item.kind ?? "ticket", status: item.status, priority: item.priority, ...(item.kind === "epic" ? {} : { workType: "coding" }), ...(item.parent ? { parentId: keys.get(item.parent) } : {}) }, { by: "human", projectId: project.id });
    keys.set(item.slug, created.key);
  }
  for (const item of seed) if (item.blocks) await ctx.tools.execute("update_item", { id: keys.get(item.slug), patch: { blocks: item.blocks.map((slug) => keys.get(slug)) } }, { by: "human", projectId: project.id });
  const settings = ctx.settings.get();
  // Claude Code in a terminal asks before it acts, and none of this person's own Claude settings reach the picture
  // (their status line names their account): the asks are what the Terminal window scenes show.
  const model = process.env.FILM_MODEL ?? "sonnet";
  process.env.ANTHROPIC_MODEL = model;
  const claudeCommand = `jq '. + {theme: "light"}' "{settings}" > "{settings}.film.json"; "{bin}" --model ${model} --effort ${process.env.FILM_EFFORT ?? "low"} {options} --setting-sources project,local --permission-mode ${spec.permission ?? "default"} --mcp-config "{mcpConfig}" --settings "{settings}.film.json" {resume} "$(cat "{prompt}")"`;
  ctx.settings.set({ ...settings, language: "en", theme: spec.theme ?? "dawn", unifiedSky: spec.theme === "sunrise" || spec.theme === "daybreak", pet: { ...settings.pet, enabled: false }, onboarding: { seen: ["*"] }, agent: { ...settings.agent, defaultEngine: "claude-code" }, codeLink: { ...settings.codeLink, claudeCommand } });

  // The app's own window, offscreen: filmed by the scenes that play in it, and for the others the one that gives a
  // plugin's window its theme and state.
  const zoom = spec.screen ? 2 : SCALE;
  const webPreferences = { preload: path.join(dir, "../preload.cjs"), contextIsolation: true, backgroundThrottling: false };
  const win = spec.screen
    ? new BrowserWindow({ ...SCREEN, x: 0, y: 40, show: false, title: FILM_TITLE, titleBarStyle: "hiddenInset", webPreferences })
    : new BrowserWindow({ width: Math.round(WIDTH * SCALE), height: Math.round(HEIGHT * SCALE), show: false, webPreferences: { ...webPreferences, offscreen: true } });
  if (spec.screen) {
    // The capture finds the window by a title that stays put; it sits behind whatever the person is doing.
    win.on("page-title-updated", (event) => event.preventDefault());
    win.setWindowButtonVisibility(false);
    win.showInactive();
  }
  win.webContents.on("dom-ready", () => win.webContents.setZoomFactor(zoom));
  await win.loadURL(`${base}#/p/${project.id}`);
  win.webContents.setZoomFactor(zoom);
  const events = [];
  let clock = null;
  const log = (kind) => { if (clock) events.push({ t: +clock.at().toFixed(3), kind }); };
  const main = hands(win, log, zoom);
  await main.waitFor(`!!document.querySelector('.ai-input') && (${spec.seed === false || !!process.env.FILM_WORK} || document.querySelectorAll('.card, [data-testid="card"]').length > 0)`, "the board and the assistant", 60);
  const prepared = spec.prepare ? await spec.prepare({ ctx, project, keys, h: main, mainWin: win }) : null;
  const filmed = prepared?.win ?? win;
  // Zoom goes by origin, so a window of the same app wears the main window's: input events take that window's own pixels.
  const h = prepared?.win ? hands(filmed, log, filmed.webContents.getZoomFactor()) : main;
  await h.cursor();
  await sleep(1500);

  const file = path.join(outDir, `${scene}-${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`);
  const camera = prepared?.win || spec.screen ? filmOneWindow(filmed.getTitle(), file, nativeSize(filmed), spec.capture) : film(filmed, file);
  await camera.ready;
  clock = camera;
  // A second window of the same take, for cutting to; its clock starts later, by `besideAt`.
  // The mirrored phone is another app's window: its size is asked of the system, in points, and filmed at twice that.
  const phoneSize = () => { const [w, h] = process.env.FILM_PHONE_SIZE ? process.env.FILM_PHONE_SIZE.split("x").map(Number) : execFileSync("osascript", ["-e", 'tell application "System Events" to tell process "iPhone Mirroring" to get size of window 1'], { encoding: "utf8" }).split(",").map((n) => Number(n.trim()) * 2); return { width: w, height: h }; };
  // FILM_PHONE_SIZE: the window's pixels, measured where the system lets a shell ask (this app may not be allowed to).
  const second = prepared?.beside ? filmOneWindow(prepared.beside.getTitle(), file.replace(/\.mp4$/, "-beside.mp4"), nativeSize(prepared.beside), { fps: 30, mbps: 60 })
    : spec.phone ? filmOneWindow(process.env.FILM_PHONE_TITLE ?? "iPhone Mirroring", file.replace(/\.mp4$/, "-phone.mp4"), phoneSize(), { fps: 60, mbps: 60 }) : null;
  await second?.ready;
  const besideAt = camera.at();
  const markers = [];
  const mark = (label) => { markers.push({ t: +camera.at().toFixed(2), label }); console.log(`[${camera.at().toFixed(1)}s] ${label}`); };
  await sleep(1500);
  mark("start");
  try {
    await spec.act({ h, mark, at: camera.at, ctx, project, keys, ...prepared });
  } finally {
    mark("end");
    await camera.stop();
    await second?.stop();
    fs.writeFileSync(file.replace(/\.mp4$/, ".markers.json"), JSON.stringify({ scene, markers, events, besideAt }, null, 2));
    console.log(`filmed ${file}`);
    if (spec.cleanup) await spec.cleanup({ ctx, project }).catch((error) => console.error(error));
  }
}

app.whenReady().then(run).then(() => app.exit(0)).catch((error) => { console.error(error); app.exit(1); });
