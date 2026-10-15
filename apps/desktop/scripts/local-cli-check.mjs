/**
 * Local agents, end to end: what the app finds of Claude Code and Codex, how
 * Settings shows it and lets a path be chosen (checked before it is saved, and
 * taken back with one click), how Start points an agent that is not ready to
 * its row, how the panel's engine picker greys out what is not set up and
 * leads to its row, what the guide says on Windows when the CLI is only in WSL,
 * and how the setup card asks for a model or a signed-in agent — either one.
 * Stand-in CLIs make the not-signed-in state deterministic; the ACP agents
 * are switched off, since this machine may well have one of them ready.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:local-cli
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-local-cli-"));
app.setPath("userData", work);
const shots = path.join(dir, "shots");
fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

/** A CLI that runs and answers its version, but says nobody is signed in. */
const fake = (name, signedOut) => {
  const file = path.join(work, "bin", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\ncase "$1" in\n  --version) echo "${name} 9.9.9";;\n  *) echo '${signedOut}';;\nesac\n`, { mode: 0o755 });
  return file;
};

const run = async () => {
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work, locale: "en-US" },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, ...["engine-hermes", "engine-dsh", "engine-workbuddy"].map((id) => ({ id, disabled: true }))]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  const project = ctx.projects.create({ name: "Local agents", keyPrefix: "LA" });
  const board = ctx.boards.list(project.id)[0];
  const item = ctx.items.create({ projectId: project.id, boardId: board.id, title: "Write the release notes", workType: "general", status: "todo", by: "human" });

  // ── what this machine has ─────────────────────────────────────────────
  const real = await ctx.agent.engineViews(true);
  for (const id of ["claude-code", "codex"]) {
    const view = real.find((e) => e.id === id);
    check(`${id} reports how its CLI was looked for`, !!view?.cli && Array.isArray(view.cli.attempts) && view.cli.searched.length > 0, view?.cli);
    if (view?.cli?.state === "ready") check(`${id}: a CLI that runs comes with its path and version`, !!view.cli.path && !!view.cli.version, view.cli);
  }
  const bogus = await ctx.agent.engines.get("codex").checkCli(path.join(work, "nope"));
  check("a path that is not there is refused with the reason", !bogus.ok && bogus.error === "file not found", bogus);

  // Both agents runnable but signed out: Start has no agent ready to offer.
  const codex = fake("codex", "Not logged in");
  const claude = fake("claude", '{"loggedIn": false}');
  const settings = ctx.settings.get();
  ctx.settings.set({
    ...settings,
    language: "en",
    onboarding: { seen: ["*"] },
    agent: { ...settings.agent, engines: { ...settings.agent?.engines, codex: { command: codex }, "claude-code": { command: claude } } }
  });
  const views = await ctx.agent.engineViews(true);
  const cc = views.find((e) => e.id === "claude-code");
  check("a chosen CLI that is signed out reads as such", cc && !cc.ok && cc.need === "sign-in" && cc.cli.source === "manual" && cc.cli.path === claude, cc);

  const win = new BrowserWindow({ width: 1440, height: 960, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(base);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const has = (selector) => $(`!!document.querySelector(${JSON.stringify(selector)})`);
  const text = (selector) => $(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`);
  const click = (selector) => $(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; n.click(); return true; })()`);
  const type = (selector, value) =>
    $(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(n, ${JSON.stringify(value)}); n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const wait = async (cond, what, tries = 150) => {
    for (let i = 0; i < tries; i++) {
      if (await cond()) return true;
      await sleep(100);
    }
    console.log(`timed out waiting for ${what}`);
    return false;
  };
  // A hidden window paints late: give the last change a moment to reach the capture.
  const shot = async (name) => {
    await sleep(600);
    fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const command = (id) => ctx.settings.get().agent?.engines?.[id]?.command;
  // Radix opens menus and picks rows on pointerdown, so a bare .click() never reaches them.
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const escape = () => $(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  const titleOf = async (id) => (await ctx.agent.engineViews()).find((e) => e.id === id)?.title;
  const engineRow = (title) => `[...document.querySelectorAll('.menu-row.is-radio')].find((r) => r.querySelector('.m-name')?.textContent === ${JSON.stringify(title)})`;
  const rowPart = (title, part) => $(`${engineRow(title)}?.querySelector(${JSON.stringify(part)})?.textContent.trim() ?? null`);
  const openEnginePicker = async () => {
    await press(`document.querySelector('.ai-knobs .chip-btn[title="Who conducts this thread"]')`);
    return wait(() => $(`document.querySelectorAll('.menu-row.is-radio').length > 0`), "engine picker");
  };

  // ── Start, with no agent ready ────────────────────────────────────────
  await $(`location.hash = '#/p/${project.id}/i/${item.id}';true`);
  check("the ticket offers Start", await wait(() => has('[data-testid="start-ticket"]'), "start button"));
  await click('[data-testid="start-ticket"]');
  check("the dialog opens", await wait(() => has('[data-testid="start-dialog"]'), "start dialog"));
  const options = await $(`[...document.querySelectorAll('#stEngine option')].map((o) => o.textContent)`);
  check("each agent says why in a few words, not the CLI's error", options.includes("Codex — Not signed in") && options.includes("Claude Code — Not signed in"), options);
  check("Tomrade comes first, waiting for a model", options[0] === "Tomrade — No model connected", options);
  await $(`(() => { const s = document.querySelector('#stEngine'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'claude-code'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  check("and the chosen one is explained under the list", (await text('[data-testid="start-engine-not-ready"]'))?.startsWith("Claude Code isn't ready: Not signed in."), await text('[data-testid="start-engine-not-ready"]'));
  await shot("local-cli-01-start-not-ready");
  await click('[data-testid="start-engine-configure"]');
  check("Set up opens Settings on that agent's row", await wait(() => has('[data-testid="cli-setup-claude-code"]'), "claude row unfolded"));
  check("the Start dialog is gone", !(await has('[data-testid="start-dialog"]')));
  check("the same pane says a run continues once its usage limit lifts", (await $(`document.querySelector('[data-testid="resume-after-limit"]')?.getAttribute('aria-checked')`)) === "true");
  await click('[data-testid="resume-after-limit"]');
  check("and switching it off is saved", await wait(() => ctx.settings.get().agent?.resumeAfterLimit === false, "resumeAfterLimit off"));
  await wait(async () => (await $(`document.querySelector('[data-testid="resume-after-limit"]')?.getAttribute('aria-checked')`)) === "false", "switch shows off");
  await click('[data-testid="resume-after-limit"]');
  check("and back on", await wait(() => ctx.settings.get().agent?.resumeAfterLimit === true, "resumeAfterLimit on"));
  const rowText = await text('[data-testid="cli-setup-claude-code"]');
  check("the row names the chosen file and that it was chosen", rowText.includes(claude) && rowText.includes("chosen by you"), rowText);
  check("and says how to sign in", rowText.includes("Sign in: run claude and follow the prompts"), rowText);
  check("the row's state is short and translated", (await text('[data-engine="claude-code"] .eng-state')) === "Not signed in");
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  check("and names the folder it reads its sign-in from", rowText.includes(`It reads its sign-in and settings from ${claudeHome}`), rowText);
  check("Try it waits until the agent is ready", (await $(`document.querySelector('[data-testid="engine-try-claude-code"] button')?.disabled`)) === true);
  await shot("local-cli-02-settings-sign-in");

  // ── choosing a path: checked before it is saved ───────────────────────
  const broken = path.join(work, "bin", "broken");
  fs.writeFileSync(broken, "#!/bin/sh\necho 'cannot start' >&2\nexit 7\n", { mode: 0o755 });
  await type("#cliPath-claude-code", broken);
  await sleep(100);
  await click('[data-testid="cli-setup-claude-code"] .cli-path-row .btn:last-child');
  check("a file that does not run is refused with its reason", await wait(async () => (await text('[data-testid="cli-check-result"]'))?.includes("exited with code 7: cannot start"), "check result"));
  check("and nothing is saved", command("claude-code") === claude, command("claude-code"));
  await shot("local-cli-03-check-failed");

  const reset = `[...document.querySelectorAll('[data-testid="cli-setup-claude-code"] .link-btn')].find((b) => b.textContent.trim() === 'Use automatic detection')`;
  await $(`${reset}.click();true`);
  check("automatic detection takes the chosen path back", await wait(async () => command("claude-code") === undefined, "command cleared"));
  const auto = (await ctx.agent.engineViews()).find((e) => e.id === "claude-code");
  if (auto.cli.state === "ready") {
    check("and the row follows what was found", await wait(async () => (await text('[data-testid="cli-setup-claude-code"]'))?.includes("found automatically"), "auto source"));
  }

  // ── Windows, with the CLI only in WSL ─────────────────────────────────
  const codexEngine = ctx.agent.engines.get("codex");
  const wsl = {
    name: "codex", state: "missing", wsl: "/home/me/.nvm/versions/node/v22.0.0/bin/codex", attempts: [],
    searched: ["C:\\Windows\\system32", "C:\\Users\\me\\AppData\\Roaming\\npm"], platform: "win32", arch: "x64", pathEnv: "C:\\Windows\\system32"
  };
  codexEngine.available = async () => ({ ok: false, need: "install", reason: "codex is installed only inside WSL", cli: wsl });
  await click('[data-testid="cli-recheck"]');
  check("Check again looks without waiting for the cache", await wait(async () => (await text('[data-engine="codex"] .eng-state')) === "Only installed in WSL", "wsl state"));
  await click('[data-engine="codex"] .eng-head');
  check("the Codex row unfolds", await wait(() => has('[data-testid="cli-setup-codex"]'), "codex row"));
  const guide = await text('[data-testid="cli-setup-codex"]');
  check("it says the WSL copy cannot be used", guide.includes("installed only inside WSL") && guide.includes("cannot be used by Tomrade on Windows"), guide);
  check("and walks through install, sign-in, a terminal check and where to look", ["npm install -g @openai/codex", "codex login", "codex --version", "where codex"].every((s) => guide.includes(s)), guide);
  check("Windows pickers take .exe, .cmd and .bat", guide.includes(".exe, .cmd and .bat"), guide);
  await $(`document.querySelector('[data-testid="cli-setup-codex"]').scrollIntoView({ block: "center" });true`);
  await shot("local-cli-04-windows-wsl-guide");

  await $(`navigator.clipboard.writeText = (t) => { window.__copied = t; return Promise.resolve(); };true`);
  await $(`[...document.querySelectorAll('[data-testid="cli-setup-codex"] .btn')].find((b) => b.textContent.includes('Copy diagnostics')).click();true`);
  const copied = await (async () => {
    await wait(() => $(`!!window.__copied`), "copied");
    return $(`window.__copied`);
  })();
  check("diagnostics name the platform, the folders searched and PATH", copied.includes("win32 x64") && copied.includes("C:\\Users\\me\\AppData\\Roaming\\npm") && copied.includes("PATH: C:\\Windows\\system32") && copied.includes("Found in WSL"), copied);

  // ── the panel's engine picker, with no model and no agent signed in ───
  // Automatic detection above may have found a real, signed-in claude: back to the stand-in.
  const signedOut = ctx.settings.get();
  ctx.settings.set({ ...signedOut, agent: { ...signedOut.agent, engines: { ...signedOut.agent?.engines, "claude-code": { command: claude } } } });
  await ctx.agent.engineViews(true);
  await escape();
  await $(`location.hash = '#/p/${project.id}';true`);
  const loopTitle = await titleOf("tomrade");
  check("the panel's engine chip opens its picker", await wait(() => has('.ai-knobs .chip-btn[title="Who conducts this thread"]'), "engine chip") && (await openEnginePicker()));
  check("an engine with no model is greyed and says so", await wait(async () => (await rowPart(loopTitle, ".m-sub")) === "Not set up yet · No model connected", "loop row"), await rowPart(loopTitle, ".m-sub"));
  check("a signed-out agent is greyed and says why", (await $(`${engineRow("Claude Code")}?.classList.contains('is-unready')`)) && (await rowPart("Claude Code", ".m-sub")) === "Not set up yet · Not signed in", await rowPart("Claude Code", ".m-sub"));
  check("each offers to set it up", (await rowPart("Claude Code", ".m-go")) === "Set up →", await rowPart("Claude Code", ".m-go"));
  await shot("local-cli-05-picker-not-set-up");
  const threadsBefore = ctx.agent.store.threads(project.id).length;
  await press(engineRow(loopTitle));
  check("picking the model-less engine opens the models, not a thread", await wait(() => has(".eng-list"), "assistant pane") && !(await has(".menu-row.is-radio")));
  check("and nothing was switched or created", ctx.agent.store.threads(project.id).length === threadsBefore);
  await escape();

  // ── the assistant: a model or a signed-in agent, either one is enough ──
  // Nothing ready: no model, Claude Code signed out, Codex only in WSL. "setup-card" is what the card's old Hide saved;
  // it no longer puts the card away. With no terminal app, a terminal step hands back its command instead.
  const before = ctx.settings.get();
  ctx.settings.set({
    ...before,
    onboarding: { seen: ["setup-card"] },
    codeLink: { ...before.codeLink, terminal: "none" },
    agent: { ...before.agent, engines: { ...before.agent?.engines, "claude-code": { command: claude } } },
    models: { profiles: [], roles: { worker: "" } }
  });
  await ctx.agent.engineViews(true);
  await escape();
  await $(`location.hash = '#/p/${project.id}';true`);
  check("with nothing set up, the assistant shows the setup card", await wait(() => has('[data-testid="setup-card"]'), "setup card"));
  const setup = await text('[data-testid="setup-card"]');
  check("it says either a model or a local agent will do", setup.includes("a model or a local agent, either one works"), setup);
  check("it offers to paste a key", await has('[data-testid="setup-card"] [data-testid="quick-model"]'));
  check("and says how to sign in to Claude Code, with the command", setup.includes("Claude Code · Not signed in") && setup.includes("claude") && setup.includes("Sign in in Terminal"), setup);
  check("and offers no way to put it away", await $(`!document.querySelector('[data-testid="setup-card"] .btn-icon')`));
  await shot("local-cli-06-setup-card-nothing-ready");
  await click('[data-testid="signin-claude-code"]');
  check("signing in runs the engine's own command in a terminal, or hands it over", await wait(async () => (await $(`[...document.querySelectorAll('.toast .toast-body')].map((n) => n.textContent)`)).some((t) => t.includes("Run this yourself: claude")), "terminal toast"));
  await $(`[...document.querySelectorAll('[data-testid="setup-card"] .link-btn')].find((b) => b.textContent.startsWith('Set up'))?.click();true`);
  check("an agent with another problem leads to its Settings row", await wait(() => has('[data-testid="cli-setup-codex"]'), "codex row from the card"));
  await escape();
  await sleep(300);

  // signed in in a terminal meanwhile: the card's own Check again sees it, past the probe cache
  fs.writeFileSync(claude, `#!/bin/sh\ncase "$1" in\n  --version) echo "claude 9.9.9";;\n  *) echo '{"loggedIn": true}';;\nesac\n`, { mode: 0o755 });
  check("the card offers to look again", await has('[data-testid="setup-recheck"]'));
  await click('[data-testid="setup-recheck"]');
  check("a signed-in Claude Code is enough: the card goes, with no model", await wait(async () => !(await has('[data-testid="setup-card"]')), "card gone"));
  const worker = await ctx.llm.worker();
  check("planning borrows Claude Code's model", worker.ok && worker.via === "lent" && worker.title === "Claude Code", worker);
  await openEnginePicker();
  check("the picker offers it now, with no hint", await wait(async () => (await $(`${engineRow("Claude Code")}?.classList.contains('is-unready')`)) === false, "claude choosable") && (await rowPart("Claude Code", ".m-sub")) === null);
  await escape();
  check("and the assistant already conducts with it, the one engine that can", await wait(async () => (await text('.ai-knobs .chip-btn[title="Who conducts this thread"]'))?.startsWith("Claude Code"), "claude chip"), await text('.ai-knobs .chip-btn[title="Who conducts this thread"]'));

  // ── a model alone is enough too: it also runs the built-in agent ──────
  fs.writeFileSync(claude, `#!/bin/sh\ncase "$1" in\n  --version) echo "claude 9.9.9";;\n  *) echo '{"loggedIn": false}';;\nesac\n`, { mode: 0o755 });
  const signedIn = ctx.settings.get();
  ctx.settings.set({ ...signedIn, models: { profiles: [{ id: "local", title: "Local model", provider: "openai-compatible", baseURL: "http://127.0.0.1:9/v1", model: "local", apiKey: "" }], roles: { worker: "" } } });
  await ctx.agent.engineViews(true);
  await $(`location.hash = '#/p/${project.id}/i/${item.id}';true`);
  await sleep(300);
  await $(`location.hash = '#/p/${project.id}';true`);
  await sleep(1200);
  check("with a model saved and no agent signed in, there is no card", !(await has('[data-testid="setup-card"]')));
  await openEnginePicker();
  check("the built-in engine can be picked", await wait(async () => (await $(`${engineRow(loopTitle)}?.classList.contains('is-unready')`)) === false, "loop ready"));
  if (fs.existsSync(path.join(dir, "../vendor/pi/dist/bundle/cli.js"))) {
    // Tomrade answers for the bundled pi: Start's work is open to it once pi itself is ready.
    const tomrade = (await ctx.agent.engineViews()).find((e) => e.id === "tomrade");
    check("and it takes Start's work too, with nothing installed", tomrade?.capabilities.includes("code") === true, tomrade);
  }
  check("an agent found only in WSL is greyed too", (await rowPart("Codex", ".m-sub")) === "Not set up yet · Only installed in WSL", await rowPart("Codex", ".m-sub"));
  const order = await $(`[...document.querySelectorAll('.menu-row.is-radio')].map((r) => r.classList.contains('is-unready'))`);
  check("what can run is listed first", order.includes(false) && order.includes(true) && order.lastIndexOf(false) < order.indexOf(true), order);
  await shot("local-cli-07-picker-model-ready");
  await press(engineRow("Claude Code"));
  check("picking a greyed agent opens Settings on its row", await wait(() => has('[data-testid="cli-setup-claude-code"]'), "claude row from the picker"));

  // ── Try it: one real turn on request ──────────────────────────────────
  // signed in, but this stand-in cannot hold a conversation: the try says so in its own words
  fs.writeFileSync(claude, `#!/bin/sh\ncase "$1" in\n  --version) echo "claude 9.9.9";;\n  *) echo '{"loggedIn": true}';;\nesac\n`, { mode: 0o755 });
  await click('[data-testid="cli-recheck"]');
  const tryButton = `document.querySelector('[data-testid="engine-try-claude-code"] button')`;
  check("Try it opens up once the agent reads ready", await wait(async () => (await $(`${tryButton}?.disabled`)) === false, "try enabled"));
  check("and says what it costs before anything runs", (await text('[data-testid="engine-try-claude-code"]'))?.includes("Uses a little of its quota"), await text('[data-testid="engine-try-claude-code"]'));
  const beforeTry = ctx.agent.store.threads(project.id, null).length;
  await $(`${tryButton}.click();true`);
  check("a try reports what came back", await wait(() => has('[data-testid="engine-try-claude-code"] [data-testid="engine-try-result"]'), "try result", 900), await text('[data-testid="engine-try-claude-code"]'));
  check("this stand-in gives no reply, and the row says so", (await text('[data-testid="engine-try-claude-code"] [data-testid="engine-try-result"]'))?.startsWith("No reply:"), await text('[data-testid="engine-try-claude-code"]'));
  check("and the try leaves no thread behind", ctx.agent.store.threads(project.id, null).length === beforeTry);
  check("the answer is kept for the row while its settings stay", (await ctx.agent.engineViews()).find((e) => e.id === "claude-code")?.tried?.ok === false);
  await $(`document.querySelector('[data-testid="engine-try-claude-code"]').scrollIntoView({ block: "center" });true`);
  await shot("local-cli-08-try-it");
  await escape();

  console.log(`screenshots in ${shots}`);
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.error(err);
    check("the check ran to the end", false);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (passed < results.length) console.log(`failed: ${results.filter((r) => !r.pass).map((r) => r.name).join(" | ")}`);
  app.exit(passed === results.length ? 0 : 1);
});
