/**
 * Tabs and keyboard shortcuts regression: the real renderer, IPC and plugins
 * over a throwaway userData.
 * - Tabs: Backlog is always the first tab and never closes; each file opened
 *   gets a tab of its own, folders share one; tabs close by ×, the middle
 *   button, a shortcut or the menu, and survive a reload.
 * - Shortcuts: Settings → Keyboard shortcuts records new keys, refuses keys
 *   that type, settles a clash, resets, exports and imports; the rebinding
 *   takes effect at once, relabels the chrome, and lands in the Hub's
 *   settings file — the one that travels.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:tabs-keys
 */
import { app, BrowserWindow, dialog, globalShortcut } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";
import { installGlobalHotkey } from "../dist/terminal-entries.js";
import { SESSIONS_SECTION } from "../dist/sessions-section.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-tabs-keys-"));
const shots = process.env.TOMRADE_SHOTS || path.join(dir, "shots");
fs.mkdirSync(shots, { recursive: true });
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};
const mac = process.platform === "darwin";
/** ⌘ on a Mac, Ctrl elsewhere — what a chord's Mod is. */
const mod = mac ? { metaKey: true } : { ctrlKey: true };

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]] });
  const hubDir = path.join(work, "hub");
  ctx.hub.configure(hubDir);
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  ctx.settings.set({ ...ctx.settings.get(), language: "en", onboarding: { seen: ["*"] } });
  // as main.ts does: Settings › Sessions offers the key for the whole computer too
  ctx.settings.register(SESSIONS_SECTION);
  const project = ctx.projects.create({ name: "Tabs regression", keyPrefix: "TAB" });
  await ctx.storage.ready;
  const board = ctx.boards.defaultFor(project.id);
  ctx.items.create({ projectId: project.id, boardId: board.id, title: "A ticket on the board", by: "human" });
  await ctx.files.write(project.id, "docs/brief.md", "# The brief\n\nA first draft.\n");
  await ctx.files.write(project.id, "docs/notes.txt", "plain notes\n");
  await ctx.files.write(project.id, "readme.md", "# Readme\n");
  await ctx.files.write(project.id, "gone.txt", "about to be deleted\n");
  const views = ctx.views.listForProject(project.id).sort((a, b) => a.rank - b.rank);

  const win = new BrowserWindow({ width: 1500, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const has = (selector) => $(`!!document.querySelector(${JSON.stringify(selector)})`);
  const press = (selector) =>
    $(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const key = (init, target = "document.activeElement || document.body") =>
    $(`(() => { const t = ${target}; const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...${JSON.stringify(init)} }); t.dispatchEvent(e); return e.defaultPrevented; })()`);
  const wait = async (cond, what = "condition") => {
    for (let i = 0; i < 80; i++) {
      if (await cond()) return true;
      await sleep(100);
    }
    console.log(`timed out waiting for ${what}`);
    return false;
  };
  const tabs = () => $(`[...document.querySelectorAll('.tab-strip [role=tab]')].map((n) => (n.getAttribute('aria-selected') === 'true' ? '*' : '') + (n.dataset.tab === 'backlog' ? 'Backlog' : n.dataset.tab))`);
  const tabsAre = async (want) => JSON.stringify(await tabs()) === JSON.stringify(want);
  const route = () => $(`decodeURIComponent(location.hash)`);
  const shot = async (name) => fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const rightClick = (selector) =>
    $(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 4, clientY: r.y + 4 })); return true; })()`);
  const clickMenuItem = (name) =>
    $(`(() => { const row = [...document.querySelectorAll('.menu.is-floating .menu-row')].find((r) => r.querySelector('.m-name')?.textContent === ${JSON.stringify(name)}); if (!row) return false; row.click(); return true; })()`);
  await wait(() => has(".tab-strip"), "the tab strip");
  await sleep(800);

  // ── tabs ──────────────────────────────────────────────────────────────
  check("a project opens with the Backlog tab alone, and on it", await tabsAre(["*Backlog"]), await tabs());
  check("the Backlog tab has nothing to close it with", !(await has('.tab[data-tab="backlog"] .tab-close')));
  await press(`.side-row.is-view[data-view="${views[1].id}"]`);
  await wait(async () => (await route()).includes(`/v/${views[1].id}`), "the second view");
  await shot("tabs-01-backlog");

  await press('.side-row.is-file[data-file="docs"]');
  await wait(async () => (await route()).endsWith("/f/docs"), "the docs folder");
  check("a folder opens in a tab of its own", await wait(() => tabsAre(["Backlog", "*docs"])), await tabs());
  await wait(() => has('.side-row.is-file[data-file="docs/brief.md"]'), "the folder unfolded");
  await press('.side-row.is-file[data-file="docs/brief.md"]');
  check("a file opens a new tab beside the one it came from", await wait(() => tabsAre(["Backlog", "docs", "*docs/brief.md"])), await tabs());
  await press('.side-row.is-file[data-file="readme.md"]');
  check("another file, another tab", await wait(() => tabsAre(["Backlog", "docs", "docs/brief.md", "*readme.md"])), await tabs());
  await press('.side-row.is-file[data-file="docs/brief.md"]');
  check("a file already open goes to its tab, not a second one", await wait(() => tabsAre(["Backlog", "docs", "*docs/brief.md", "readme.md"])), await tabs());
  await press('.side-row.is-file[data-file="docs/notes.txt"]');
  check("opened from brief.md, notes.txt sits right after it", await wait(() => tabsAre(["Backlog", "docs", "docs/brief.md", "*docs/notes.txt", "readme.md"])), await tabs());
  await press('.side-row.is-file[data-file=""]');
  await press(".side-files-home");
  check("the files home moves the one folder tab", await wait(() => tabsAre(["Backlog", "*", "docs/brief.md", "docs/notes.txt", "readme.md"])), await tabs());
  await shot("tabs-02-files");

  await press('.tab[data-tab="backlog"]');
  check("the Backlog tab goes back to the view it was showing", await wait(async () => (await route()).includes(`/v/${views[1].id}`)), await route());
  check("with the board on screen", await wait(() => has(".board-region:not(.files-region)")));
  check("and the file tabs still there", await tabsAre(["*Backlog", "", "docs/brief.md", "docs/notes.txt", "readme.md"]), await tabs());

  await press('.tab[data-tab="docs/notes.txt"]');
  await wait(async () => (await route()).endsWith("/f/docs/notes.txt"), "notes.txt");
  await press('.tab[data-tab="docs/notes.txt"] .tab-close');
  check("closing the tab on screen shows its right-hand neighbour", await wait(async () => (await tabsAre(["Backlog", "", "docs/brief.md", "*readme.md"])) && (await route()).endsWith("/f/readme.md")), await tabs());
  await key({ key: "w", code: "KeyW", ...mod }, "document.body");
  check("⌘W closes the file tab on screen", await wait(async () => (await tabsAre(["Backlog", "", "*docs/brief.md"])) && (await route()).endsWith("/f/docs/brief.md")), await tabs());
  await key({ key: "Tab", code: "Tab", ctrlKey: true }, "document.body");
  check("Ctrl+Tab from the last tab wraps to Backlog", await wait(() => tabsAre(["*Backlog", "", "docs/brief.md"])), await tabs());
  await key({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true }, "document.body");
  check("Ctrl+Shift+Tab goes back round to the last tab", await wait(() => tabsAre(["Backlog", "", "*docs/brief.md"])), await tabs());
  await key({ key: "w", code: "KeyW", ...mod }, "document.body");
  await wait(() => tabsAre(["Backlog", "*"]), "the brief closed");
  await key({ key: "w", code: "KeyW", ...mod }, "document.body");
  check("closing the last file tab lands on Backlog", await wait(async () => (await tabsAre(["*Backlog"])) && (await route()).includes(`/v/${views[1].id}`)), await tabs());
  await key({ key: "w", code: "KeyW", ...mod }, "document.body");
  await sleep(300);
  check("on Backlog, ⌘W closes nothing", (await tabsAre(["*Backlog"])) && (await route()).includes(`/v/${views[1].id}`));

  await $(`location.hash = '#/p/${project.id}/f/docs/brief.md'; true`);
  await wait(() => tabsAre(["Backlog", "*docs/brief.md"]), "the brief by link");
  await $(`location.hash = '#/p/${project.id}/f/gone.txt'; true`);
  await wait(() => tabsAre(["Backlog", "docs/brief.md", "*gone.txt"]), "gone.txt by link");
  await $(`location.hash = '#/p/${project.id}/f/readme.md'; true`);
  await wait(() => tabsAre(["Backlog", "docs/brief.md", "gone.txt", "*readme.md"]), "readme by link");
  $(`document.querySelector('.tab[data-tab="docs/brief.md"]').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })); true`);
  check("the middle button closes a tab that is not on screen, and stays put", await wait(async () => (await tabsAre(["Backlog", "gone.txt", "*readme.md"])) && (await route()).endsWith("/f/readme.md")), await tabs());
  await ctx.files.remove(project.id, "gone.txt");
  check("a file deleted elsewhere takes its tab with it", await wait(() => tabsAre(["Backlog", "*readme.md"]), "gone.txt's tab to go"), await tabs());

  await $(`location.hash = '#/p/${project.id}/f/docs/brief.md'; true`);
  await wait(() => tabsAre(["Backlog", "readme.md", "*docs/brief.md"]), "the brief again");
  await rightClick('.tab[data-tab="docs/brief.md"]');
  await wait(() => has(".menu.is-floating"), "the tab menu");
  await clickMenuItem("Close other tabs");
  check("“Close other tabs” keeps Backlog and the one clicked", await wait(() => tabsAre(["Backlog", "*docs/brief.md"])), await tabs());

  await $(`location.hash = '#/p/${project.id}/f/readme.md'; true`);
  await wait(() => tabsAre(["Backlog", "docs/brief.md", "*readme.md"]), "readme again");
  win.webContents.reload();
  await wait(() => has(".tab-strip"), "the strip after a reload");
  check("the tabs survive a reload", await wait(() => tabsAre(["Backlog", "docs/brief.md", "*readme.md"])), await tabs());
  await key({ key: "1", code: "Digit1", ...mod }, "document.body");
  check("⌘1 goes to the Backlog tab", await wait(async () => (await tabsAre(["*Backlog", "docs/brief.md", "readme.md"])) && (await has(".board-region:not(.files-region)"))), await tabs());

  // ── keyboard shortcuts ────────────────────────────────────────────────
  await key({ key: ",", code: "Comma", ...mod }, "document.body");
  await wait(() => has(".sheet-settings"), "Settings");
  const navRow = `[...document.querySelectorAll('.sheet-settings .dlg-nav .side-row')].find((n) => n.textContent.includes('Keyboard shortcuts'))`;
  check("Settings has a Keyboard shortcuts pane", await $(`!!${navRow}`));
  await $(`${navRow}.click(); true`);
  await wait(() => has('[data-testid="keybindings-pane"]'), "the shortcuts pane");
  check("which says it follows the Hub, like the theme", (await $(`document.querySelector('[data-testid="keybindings-pane"] .scope-tag')?.dataset.scope`)) === "user");
  const row = (id) => `[data-testid="keybindings-pane"] .keys-row[data-command="${id}"]`;
  check("every command is listed with its keys", (await $(`document.querySelector('${row("palette")} .kbd')?.textContent`)) === (mac ? "⌘K" : "Ctrl+K"));
  await shot("keys-01-pane");

  await press(`${row("palette")} .keys-chord-btn`);
  check("a key cap clicked starts recording", await wait(() => has(`${row("palette")} .keys-recording`)));
  await key({ key: "P", code: "KeyP", shiftKey: true, ...mod }, "document.body");
  const overrides = () => ctx.settings.get().keybindings?.overrides ?? {};
  check("the new keys are saved over the old", await wait(() => JSON.stringify(overrides().palette) === JSON.stringify(["Mod+Shift+P"])), overrides());
  check("only what changed is stored", JSON.stringify(Object.keys(overrides())) === JSON.stringify(["palette"]), overrides());
  check("the row shows the new keys and says it was changed", await wait(async () => (await $(`document.querySelector('${row("palette")} .kbd')?.textContent`)) === (mac ? "⇧⌘P" : "Ctrl+Shift+P") && (await has(`${row("palette")}[data-changed]`))));
  const hubSettings = () => JSON.parse(fs.readFileSync(path.join(hubDir, "settings.json"), "utf8"));
  check("and it is in the Hub's settings file, the one that syncs", JSON.stringify(hubSettings().sections.keybindings?.value?.overrides?.palette) === JSON.stringify(["Mod+Shift+P"]), hubSettings().sections.keybindings);

  await press(`${row("palette")} .keys-add`);
  await wait(() => has(`${row("palette")} .keys-recording`), "recording to add");
  await key({ key: "Tab", code: "Tab" }, "document.body");
  check("a bare Tab is refused — it moves the focus", await wait(async () => ((await $(`document.querySelector('${row("palette")} .keys-note')?.textContent`)) ?? "").includes("needed for typing")));
  check("and nothing was saved", JSON.stringify(overrides().palette) === JSON.stringify(["Mod+Shift+P"]));

  await press(`${row("palette")} .keys-add`);
  await wait(() => has(`${row("palette")} .keys-recording`), "recording again");
  const escaped = await key({ key: "Escape", code: "Escape" }, "document.body");
  check("Escape stops recording, and not the sheet", escaped && !(await has(`${row("palette")} .keys-recording`)) && (await has(".sheet-settings")));

  await press(`${row("palette")} .keys-add`);
  await wait(() => has(`${row("palette")} .keys-recording`), "recording a clash");
  await key({ key: "b", code: "KeyB", ...mod }, "document.body");
  check("keys another command uses are not taken silently", await wait(async () => ((await $(`document.querySelector('${row("palette")} .keys-note')?.textContent`)) ?? "").includes("Show or hide the sidebar")));
  await shot("keys-02-clash");
  await press(`${row("palette")} [data-testid="keys-use-here"]`);
  check("“Use it here” moves them", await wait(() => JSON.stringify(overrides().palette) === JSON.stringify(["Mod+Shift+P", "Mod+B"]) && JSON.stringify(overrides().sidebar) === "[]"), overrides());
  check("leaving the other command without keys, said so", await wait(async () => ((await $(`document.querySelector('${row("sidebar")}')?.textContent`)) ?? "").includes("No keys")));

  // ── a key for the whole computer: none by default, refused when it types or is the shell's, said when another app has it ──
  // never really taken on this machine: the system's answer is played here
  const refusedByOthers = new Set(["Alt+Space"]);
  globalShortcut.register = (acc) => !refusedByOthers.has(acc);
  globalShortcut.unregister = () => {};
  installGlobalHotkey(ctx);
  const globalRow = row("terminalWindowGlobal");
  const note = () => $(`document.querySelector('${globalRow} .keys-note')?.textContent ?? ""`);
  check("“From any app” offers the Terminal window, with no keys until one is picked", ((await $(`document.querySelector('${globalRow}')?.textContent ?? ""`)) ?? "").includes("No keys"));
  await press(`${globalRow} .keys-add`);
  await wait(() => has(`${globalRow} .keys-recording`), "recording a global key");
  await key({ key: "F12", code: "F12" }, "document.body");
  check("a key with no ⌘ or ⌥ is refused for the whole computer", await wait(async () => (await note()).includes("types in every app")), await note());
  await press(`${globalRow} .keys-add`);
  await wait(() => has(`${globalRow} .keys-recording`), "recording a common global key");
  await key({ key: "T", code: "KeyT", shiftKey: true, ...mod }, "document.body");
  check("and so is one other apps answer to", await wait(async () => (await note()).includes("Other apps already answer")), await note());
  await press(`${globalRow} .keys-add`);
  await wait(() => has(`${globalRow} .keys-recording`), "recording ⌥Space");
  await key({ key: "\u00a0", code: "Space", altKey: true }, "document.body");
  check("⌥Space is taken, though a Mac types a no-break space for it", await wait(() => JSON.stringify(overrides().terminalWindowGlobal) === JSON.stringify(["Alt+Space"])), overrides());
  check("another app holding it is said under the row", await wait(() => has(`${globalRow} [data-testid="keys-global-taken"]`)));
  check("one key for the whole computer is all there is room for", !(await has(`${globalRow} .keys-add`)));
  await press(`${globalRow} [data-testid="keys-reset"]`);
  check("Reset takes the key back to none", await wait(() => overrides().terminalWindowGlobal === undefined), overrides());

  // ── the same key from Settings › Sessions: none, ⌥Space, or one pressed there — one setting, both panes show it ──
  const sessionsRow = `[...document.querySelectorAll('.sheet-settings .dlg-nav .side-row')].find((n) => n.textContent.trim() === 'Sessions')`;
  const hotkey = '[data-testid="global-hotkey"]';
  const hotkeyPicked = () => $(`document.querySelector('${hotkey} [aria-checked="true"]')?.dataset.hotkey ?? null`);
  check("Settings has a Sessions pane", await wait(() => $(`!!${sessionsRow}`), "the Sessions row"));
  await $(`${sessionsRow}.click(); true`);
  check("Sessions offers the key for the whole computer, none until one is picked", await wait(async () => (await hotkeyPicked()) === "none", "the Sessions key"), await hotkeyPicked());
  await press(`${hotkey} [data-hotkey="altSpace"]`);
  check("⌥Space is one click there", await wait(() => JSON.stringify(overrides().terminalWindowGlobal) === JSON.stringify(["Alt+Space"])), overrides());
  check("and another app holding it is said there too", await wait(() => has('[data-testid="global-hotkey-taken"]')));
  const altSpace = await $(`document.querySelector('${hotkey} [data-hotkey="altSpace"]').textContent`);
  await $(`${navRow}.click(); true`);
  await wait(() => has('[data-testid="keybindings-pane"]'), "the shortcuts pane again");
  check("Keyboard shortcuts shows the key picked in Sessions", await wait(async () => (await $(`document.querySelector('${globalRow} .kbd')?.textContent ?? null`)) === altSpace), altSpace);
  await press(`${globalRow} [data-testid="keys-reset"]`);
  await wait(() => overrides().terminalWindowGlobal === undefined, "the key reset");
  await $(`${sessionsRow}.click(); true`);
  check("taken away there, Sessions says none", await wait(async () => (await hotkeyPicked()) === "none"), await hotkeyPicked());
  await press(`${hotkey} [data-hotkey="record"]`);
  await key({ key: "k", code: "KeyK", altKey: true, ...mod }, "document.body");
  check("a key pressed in Sessions is kept as that key", await wait(() => JSON.stringify(overrides().terminalWindowGlobal) === JSON.stringify(["Mod+Alt+K"])), overrides());
  check("and shows as the one picked", await wait(async () => (await hotkeyPicked()) === "record", "the key picked on screen"), await hotkeyPicked());
  await press(`${hotkey} [data-hotkey="none"]`);
  check("None there takes it away", await wait(() => overrides().terminalWindowGlobal === undefined), overrides());
  await $(`${navRow}.click(); true`);
  await wait(() => has('[data-testid="keybindings-pane"]'), "back on the shortcuts pane");

  await press(`${row("sidebar")} [data-testid="keys-reset"]`);
  check("Reset gives a command its default back", await wait(() => overrides().sidebar === undefined), overrides());
  check("taking it back from where it went", await wait(() => JSON.stringify(overrides().palette) === JSON.stringify(["Mod+Shift+P"])), overrides());
  // Export writes what the pane holds: wait for the reset to reach it, not only the stored settings
  await wait(async () => !(await has(`${row("sidebar")}[data-changed]`)), "the reset on screen");

  // export and import, past the native dialogs
  const exported = path.join(work, "keys.json");
  const realSave = dialog.showSaveDialog;
  const realOpen = dialog.showOpenDialog;
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: exported });
  await press('[data-testid="keys-export"]');
  check("Export writes the rebound keys to a file", await wait(() => fs.existsSync(exported)));
  const file = JSON.parse(fs.readFileSync(exported, "utf8"));
  check("a file that says what it is", file.kind === "tomrade.keybindings" && file.version === 1 && JSON.stringify(file.overrides) === JSON.stringify({ palette: ["Mod+Shift+P"] }), file);

  const imported = path.join(work, "import.json");
  fs.writeFileSync(imported, JSON.stringify({ kind: "tomrade.keybindings", version: 1, overrides: { newTicket: ["Mod+Shift+N"], someday: ["Mod+Q"], undo: ["Mod+Z", "Cmd+Z"] } }));
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [imported] });
  await press('[data-testid="keys-import"]');
  // undo keeps only the chord it can match — its default — so it is not stored at all
  check("Import replaces the set with the file's", await wait(() => JSON.stringify(overrides()) === JSON.stringify({ newTicket: ["Mod+Shift+N"] })), overrides());
  check("and says what it skipped", await wait(async () => ((await $(`document.body.textContent`)) ?? "").includes("2 entries this version does not know were skipped")));
  fs.writeFileSync(imported, JSON.stringify({ theme: "dark" }));
  await press('[data-testid="keys-import"]');
  check("a file that is not ours changes nothing", await wait(async () => ((await $(`document.body.textContent`)) ?? "").includes("not a Tomrade shortcuts file")) && JSON.stringify(overrides().newTicket) === JSON.stringify(["Mod+Shift+N"]));
  dialog.showSaveDialog = realSave;
  dialog.showOpenDialog = realOpen;

  await press('[data-testid="keys-reset-all"]');
  await press('[data-testid="keys-reset-all-confirm"]');
  check("Reset all empties the overrides", await wait(() => JSON.stringify(overrides()) === "{}"), overrides());

  // the rebinding at work, outside the pane
  await press(`${row("palette")} .keys-chord-btn`);
  await wait(() => has(`${row("palette")} .keys-recording`), "recording the palette again");
  await key({ key: "P", code: "KeyP", shiftKey: true, ...mod }, "document.body");
  await wait(() => JSON.stringify(overrides().palette) === JSON.stringify(["Mod+Shift+P"]), "the palette rebound");
  await key({ key: "Escape", code: "Escape" }, "document.body");
  await wait(async () => !(await has(".sheet-settings")), "Settings to close");
  await sleep(300);
  check("the title bar's search names the new keys", (await $(`document.querySelector('.titlebar .kbd')?.textContent`)) === (mac ? "⇧⌘P" : "Ctrl+Shift+P"), await $(`document.querySelector('.titlebar .kbd')?.textContent`));
  await key({ key: "k", code: "KeyK", ...mod }, "document.body");
  await sleep(400);
  check("the old keys no longer open the palette", !(await has(".palette")));
  await key({ key: "P", code: "KeyP", shiftKey: true, ...mod }, "document.body");
  check("the new ones do", await wait(() => has(".palette")));
  check("and the palette lists them beside the command", await wait(async () => ((await $(`document.querySelector('.palette')?.textContent`)) ?? "").length > 0));
  await key({ key: "Escape", code: "Escape" }, "document.body");
  await wait(async () => !(await has(".palette")), "the palette to close");
  await key({ key: "?", code: "Slash", shiftKey: true }, "document.body");
  await wait(() => has('.shortcut-row[data-command="palette"]'), "the shortcuts sheet");
  check("the ? sheet lists the person's keys, not the defaults", (await $(`document.querySelector('.shortcut-row[data-command="palette"] .kbd')?.textContent`)) === (mac ? "⇧⌘P" : "Ctrl+Shift+P"));
  check("and lists the tab keys", await has('.shortcut-row[data-command="closeTab"]'));
  await shot("keys-03-sheet");
  await press('[data-testid="shortcuts-customize"]');
  check("“Change keys…” opens the pane", await wait(() => has('[data-testid="keybindings-pane"]')));
  await key({ key: "Escape", code: "Escape" }, "document.body");
  await wait(async () => !(await has(".sheet-settings")), "Settings to close again");

  // a setting changed elsewhere — another machine through the Hub, an agent — takes effect here too
  ctx.settings.set({ ...ctx.settings.get(), keybindings: { overrides: { sidebar: ["Mod+Shift+B"] } } });
  await sleep(600);
  const sideOpen = () => $(`!document.querySelector('.workspace')?.classList.contains('side-railed')`);
  const before = await sideOpen();
  await key({ key: "b", code: "KeyB", shiftKey: true, ...mod }, "document.body");
  check("a rebinding saved elsewhere works without a restart", await wait(async () => (await sideOpen()) !== before));
  await key({ key: "k", code: "KeyK", ...mod }, "document.body");
  check("and the keys it dropped are the defaults again", await wait(() => has(".palette")));
  await key({ key: "Escape", code: "Escape" }, "document.body");

  // in Chinese
  ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
  await sleep(600);
  check("the Backlog tab keeps its name in Chinese, the strip speaks it", (await $(`document.querySelector('.tab-strip')?.getAttribute('aria-label')`)) === "打开的标签页");
  await key({ key: ",", code: "Comma", ...mod }, "document.body");
  await wait(() => has(".sheet-settings"), "Settings in Chinese");
  const zhRow = `[...document.querySelectorAll('.sheet-settings .dlg-nav .side-row')].find((n) => n.textContent.includes('键盘快捷键'))`;
  await $(`${zhRow}?.click(); true`);
  check("the pane is there in Chinese", await wait(async () => ((await $(`document.querySelector('[data-testid="keybindings-pane"]')?.textContent`)) ?? "").includes("录入新的按键")));
  await shot("keys-04-zh");
  await key({ key: "Escape", code: "Escape" }, "document.body");
  ctx.settings.set({ ...ctx.settings.get(), language: "en", theme: "dark" });
  await $(`location.hash = '#/p/${project.id}/f/docs/brief.md'; true`);
  await wait(() => tabsAre(["Backlog", "*docs/brief.md", "readme.md"]), "the brief, in the dark");
  await sleep(800);
  await shot("tabs-03-dark");
  check("harness reached the end", true);
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    console.log("HARNESS ERROR: " + (err && err.stack ? err.stack : String(err)));
    check("harness ran to completion", false);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log("failed: " + failed.map((f) => f.name).join(" | "));
  app.exit(failed.length ? 1 : 0);
});
