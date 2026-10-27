/**
 * The `tomrade` command end to end, on macOS and Linux: Tomrade puts it on PATH through a zsh file in a home of
 * this run's own, a real zsh finds it there, `tomrade term <folder>` opens a pane of the Terminal window in that
 * folder and says which, `--attach` lists the panes by the numbers the window shows and hands one to herdr's own
 * client in a terminal of this run (and back to its cell once let go), and turning the setting off leaves nothing on
 * PATH. herdr runs on a session of its own; the person's server, home and PATH are not touched.
 *
 *   pnpm build:backend && (cd packages/ui && ./node_modules/.bin/vite --port 5310 --strictPort)   then
 *   TOMRADE_DEV_URL=http://127.0.0.1:5310/ pnpm --filter @tomrade/desktop exec electron scripts/tomrade-command-check.mjs
 */
import { app, BrowserWindow } from "electron";
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-command-"));
// Inside a herdr pane HERDR_SOCKET_PATH names the person's server and wins over HERDR_SESSION: this run reaches only its own.
for (const key of ["HERDR_SOCKET_PATH", "HERDR_CLIENT_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_ENV"]) delete process.env[key];
const HERDR_SESSION = `tomrade-cmd-check-${process.pid}`;
process.env.HERDR_SESSION = HERDR_SESSION;
const ownSocket = path.join(os.homedir(), ".config/herdr/sessions", HERDR_SESSION, "herdr.sock");
app.setPath("userData", work);
app.commandLine.appendSwitch("disable-gpu");
app.on("window-all-closed", () => {});

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${ok || !extra ? "" : ` — ${typeof extra === "string" ? extra : JSON.stringify(extra)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(150);
  }
  return false;
};
const herdr = (...args) => execFileSync("herdr", args, { env: { ...process.env, HERDR_SESSION }, encoding: "utf8" });

const home = path.join(work, "home");
fs.mkdirSync(home);
// The shell a person's terminal runs: only what this home's files put on PATH, nothing of this machine's own.
const zsh = (line) =>
  new Promise((resolve) => {
    execFile("/bin/zsh", ["-f", "-c", `[ -f "$HOME/.zshrc" ] && . "$HOME/.zshrc"; ${line}`], { env: { HOME: home, PATH: "/usr/bin:/bin", HERDR_SESSION, LANG: "en_US.UTF-8" }, timeout: 60_000 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out: String(stdout).trim(), err: String(stderr).trim() })
    );
  });

/** `tomrade term --attach n` in a terminal of its own (a pty of 100 × 30): what it showed, typing a line into the pane, then herdr's detach key. */
const attachIn = (n, line) =>
  new Promise((resolve) => {
    const helper = path.join(work, "pty.py");
    fs.writeFileSync(
      helper,
      [
        "import os, pty, sys, time, select, struct, fcntl, termios",
        "pid, fd = pty.fork()",
        "if pid == 0:",
        "    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))",
        "    os.execvp('/bin/zsh', ['/bin/zsh', '-f', '-c', '. \"$HOME/.zshrc\"; tomrade term --attach ' + sys.argv[1]])",
        "out = b''",
        "def pump(t):",
        "    global out",
        "    end = time.time() + t",
        "    while time.time() < end:",
        "        r, _, _ = select.select([fd], [], [], 0.1)",
        "        if r:",
        "            try: d = os.read(fd, 65536)",
        "            except OSError: return",
        "            if not d: return",
        "            out += d",
        "pump(4)",
        "os.write(fd, sys.argv[2].encode() + b'\\r')",
        "pump(2)",
        "os.write(fd, b'\\x02q')",
        "pump(4)",
        "try: _, status = os.waitpid(pid, 0)",
        "except ChildProcessError: status = -1",
        "sys.stdout.write(str(os.waitstatus_to_exitcode(status) if status >= 0 else -1) + '\\n')",
        "sys.stdout.write(out.decode('utf8', 'replace'))"
      ].join("\n")
    );
    execFile("python3", ["-I", helper, String(n), line], { env: { HOME: home, PATH: "/usr/bin:/bin", HERDR_SESSION, TERM: "xterm-256color", LANG: "en_US.UTF-8" }, timeout: 60_000 }, (_error, stdout) => {
      const [code, ...rest] = String(stdout).split("\n");
      resolve({ code: Number(code), out: rest.join("\n") });
    });
  });

app.whenReady().then(async () => {
  let server;
  try {
    server = spawn("herdr", ["server"], { env: { ...process.env, HERDR_SESSION }, stdio: "ignore" });
    await until(() => {
      try {
        herdr("status");
        return true;
      } catch {
        return false;
      }
    }, 10000);
    const { boot } = await import("../dist/boot.js");
    const { keepCommandPlaced } = await import("../dist/tomrade-command.js");
    const { commandOnPath, SESSIONS_SECTION } = await import("../dist/sessions-section.js");
    const { nodeRuntime } = await import("../dist/node-runtime.js");
    const uiPages = process.env.TOMRADE_DEV_URL ?? pathToFileURL(path.join(dir, "../../../packages/ui/dist/")).href;
    const engines = ["engine-tomrade", "engine-loop", "engine-pi-builtin", "engine-claude-code", "engine-codex", "engine-pi"];
    const { ctx } = await boot({
      configFile: path.join(dir, "../tomrade.yml"),
      vars: { userData: work, uiPages },
      patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "code-sessions", disabled: false }, ...engines.map((id) => ({ id, disabled: true }))]]
    });
    ctx.hub.configure(path.join(work, "hub"));
    ctx.settings.register(SESSIONS_SECTION);
    ctx.settings.set({ ...ctx.settings.get(), language: "en", onboarding: { seen: ["*"] }, codeLink: { ...ctx.settings.get().codeLink, terminal: "herdr" } });
    for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
    const project = ctx.projects.create({ name: "Command check", keyPrefix: "CMD" });
    // A folder with a space in its name, as people's folders have.
    const folder = fs.mkdtempSync(path.join(work, "my repo-"));

    const cliDir = path.join(work, "cli");
    keepCommandPlaced(
      ctx,
      () => ({
        platform: process.platform,
        home,
        shell: "/bin/zsh",
        pathDirs: ["/usr/bin", "/bin"],
        dir: cliDir,
        runtime: nodeRuntime(),
        script: path.join(dir, "../dist/tomrade-cli.js"),
        config: { url: ctx.mcp.url.replace(/\/mcp$/, ""), open: "", locale: ctx.settings.locale() }
      }),
      () => commandOnPath(ctx),
      0
    );
    check("the setting is on by default, and Tomrade puts the command in its folder and on PATH through zsh's file", await until(() => fs.existsSync(path.join(cliDir, "tomrade")) && fs.readFileSync(path.join(home, ".zshrc"), "utf8").includes(cliDir), 10000));
    const found = await zsh("command -v tomrade");
    check("a zsh reading that file finds tomrade", found.out === path.join(cliDir, "tomrade"), found);
    const help = await zsh("tomrade --help");
    check("tomrade --help prints its usage", help.code === 0 && help.out.includes("tomrade term --attach <n>"), help);

    // ── tomrade term <folder> ────────────────────────────────────────────
    const opened = await zsh(`cd ${JSON.stringify(folder)} && tomrade term .`);
    check("tomrade term . opens a pane of the Terminal window in the folder and says which", opened.code === 0 && /^Opened pane \d+ in the Terminal window · /.test(opened.out) && opened.out.endsWith(folder), opened);
    const n = Number(/pane (\d+)/.exec(opened.out)?.[1]);
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().endsWith(" — Terminal"));
    check("the Terminal window opened for the project", !!win, BrowserWindow.getAllWindows().map((w) => w.getTitle()));
    win?.webContents.setBackgroundThrottling(false);
    const js = (code) => win.webContents.executeJavaScript(code, true);
    const cellText = () => js(`(() => { const cell = [...document.querySelectorAll('.cs-cell')].find((c) => c.querySelector('[data-testid=cs-cell-no]')?.textContent === ${JSON.stringify(String(n))}); return cell ? [...cell.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent).join('\\n') : null; })()`);
    check("the pane the command named shows that number and the new terminal", await until(async () => (await js(`[...document.querySelectorAll('[data-testid=cs-cell-no]')].map((e) => e.textContent).includes(${JSON.stringify(String(n))})`)) && (await cellText()) !== null), await js(`[...document.querySelectorAll('[data-testid=cs-cell-no]')].map((e) => e.textContent)`));
    const second = await zsh(`tomrade term ${JSON.stringify(folder)}`);
    await sleep(800);
    if (process.env.TOMRADE_CHECK_SHOTS) fs.writeFileSync(path.join(process.env.TOMRADE_CHECK_SHOTS, "tomrade-term-panes.png"), (await win.webContents.capturePage()).toPNG());
    const n2 = Number(/pane (\d+)/.exec(second.out)?.[1]);
    check("a second one lands in a pane of its own", second.code === 0 && n2 > 0 && n2 !== n, second);
    const missing = await zsh("tomrade term /no/such/folder");
    check("a folder that is not there is said, with no window asked", missing.code === 1 && missing.err === "There is no folder /no/such/folder", missing);

    // ── --attach ─────────────────────────────────────────────────────────
    const listed = await zsh("tomrade term --attach");
    check("tomrade term --attach lists the panes by their numbers", listed.code === 0 && listed.out.includes(`  ${n}  ${path.basename(folder)} · ${folder}`) && listed.out.includes(`  ${n2}  `), listed);
    await until(async () => (await cellText())?.includes("%") || (await cellText())?.includes("$"), 8000);
    const attached = await attachIn(n, "echo attached-$((40 + 2))");
    check("--attach hands the pane to herdr's own client in this terminal, which types into it", attached.out.includes(`Attaching pane ${n}`) && attached.out.includes("attached-42"), attached.out.slice(-800));
    check("herdr's detach key ends it cleanly", attached.code === 0, attached.code);
    check("let go, the pane streams in its cell again and shows what was typed there", await until(async () => (await cellText())?.includes("attached-42") && !(await js(`!!document.querySelector('.cs-term-closed')`)), 10000), await cellText());
    const nope = await zsh("tomrade term --attach 99");
    check("a pane that is not there is said, with the list", nope.code === 1 && nope.err.includes("has no pane 99") && nope.err.includes(`  ${n}  `), nope);
    const ticket = await zsh("tomrade term --agent codex CMD-404");
    check("a ticket that is not there is said by Tomrade", ticket.code === 1 && ticket.err.includes("No ticket CMD-404"), ticket);

    // ── off ──────────────────────────────────────────────────────────────
    ctx.settings.set({ ...ctx.settings.get(), sessions: { ...ctx.settings.get().sessions, commandOnPath: false } });
    check("turned off, its folder goes and zsh's file has nothing of it left", await until(() => !fs.existsSync(cliDir) && !(fs.existsSync(path.join(home, ".zshrc")) && fs.readFileSync(path.join(home, ".zshrc"), "utf8").includes("tomrade")), 10000), fs.readdirSync(home));
    const gone = await zsh("command -v tomrade");
    check("a zsh no longer finds tomrade", gone.code !== 0 && gone.out === "", gone);
    ctx.settings.set({ ...ctx.settings.get(), sessions: { ...ctx.settings.get().sessions, commandOnPath: true } });
    check("on again, it is back", await until(() => fs.existsSync(path.join(cliDir, "tomrade")), 10000));
    ctx.settings.set({ ...ctx.settings.get(), sessions: { ...ctx.settings.get().sessions, commandOnPath: false } });
    await until(() => !fs.existsSync(cliDir), 10000);
    win?.close();
  } catch (error) {
    console.error(error);
    results.push({ name: "run", ok: false });
  } finally {
    // Only this run's server, named by its own socket.
    try {
      if (herdr("status").includes(ownSocket)) herdr("server", "stop");
    } catch {
      // already gone
    }
    server?.kill();
    fs.rmSync(path.join(os.homedir(), ".config/herdr/sessions", HERDR_SESSION), { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed · work in ${work}`);
  app.exit(failed.length ? 1 : 0);
});
