/**
 * Notes regression: the real renderer, IPC and plugins over a throwaway
 * userData. Writes in the editor and watches it save, follows and creates
 * links, takes a clash with an outside save, renames a note and checks the
 * links that followed it, searches, opens the day's journal.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:notes
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";
import { oneFocusRing } from "./focus-ring.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-notes-ui-"));
const shots = process.env.TOMRADE_SHOTS || path.join(work, "shots");
fs.mkdirSync(shots, { recursive: true });
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
};
const same = (name, actual, expected) => {
  check(name, actual === expected);
  if (actual !== expected) console.log(`  expected ${JSON.stringify(expected)}\n  received ${JSON.stringify(actual)}`);
};
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  // Hints and setup cards are taught once, in their own check; these checks are about everything else.
  ctx.settings.set({ ...ctx.settings.get(), onboarding: { seen: ["*"] } });
  const project = ctx.projects.create({ name: "Notes regression", keyPrefix: "NOT" });
  await ctx.storage.ready;
  const id = project.id;
  const read = async (p) => (await ctx.files.read(id, p))?.body ?? null;

  await ctx.files.write(id, "docs/plan.md", "# Launch plan\n\nShip after [[checklist]] and [[Pricing]]. #launch\n");
  await ctx.files.write(id, "docs/checklist.md", "# Checklist\n\n- QA on staging #launch\n");
  await ctx.files.write(id, "meetings/kickoff.md", "# Kickoff\n\nWe agreed the checklist stays short.\n");
  await ctx.files.write(id, "readme.txt", "plain text about the launch\n");
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  await ctx.files.write(id, "img/pixel.png", pixel);
  await ctx.files.write(id, "docs/pictures.md", "# Pictures\n\n![[pixel.png]]\n\n![a pixel](../img/pixel.png)\n");

  const win = new BrowserWindow({ width: 1560, height: 940, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  await win.loadURL(process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/");
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const has = (selector) => $(`!!document.querySelector(${JSON.stringify(selector)})`);
  const count = (selector) => $(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const text = (selector) => $(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const click = (selector) => $(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; n.click(); return true; })()`);
  const press = (selector) =>
    $(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const wait = async (cond, what = "condition", tries = 120) => {
    for (let i = 0; i < tries; i++) {
      if (await cond()) return true;
      await sleep(100);
    }
    console.log(`timed out waiting for ${what}`);
    return false;
  };
  const shot = async (name) => fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const clickMenuItem = (name) =>
    $(`(() => { const row = [...document.querySelectorAll('.menu.is-floating .menu-row')].find((r) => r.querySelector('.m-name')?.textContent === ${JSON.stringify(name)}); if (!row) return false; row.click(); return true; })()`);
  const lastToast = () => $(`[...document.querySelectorAll('.toast .toast-body')].at(-1)?.textContent ?? null`);
  const typeInto = (selector, value) =>
    $(`(() => {
      const i = document.querySelector(${JSON.stringify(selector)});
      if (!i) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)});
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  // Every line of a short note is in the viewport, so the lines are the document.
  const editorText = () => $(`(() => { const c = document.querySelector('[data-testid="note-editor"] .cm-content'); return c ? [...c.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\\n') : null; })()`);
  // Focus, then the editor's own "end of document" key: a DOM selection lands oddly on an empty last line.
  const focusEditorEnd = async () => {
    await $(`(() => { const c = document.querySelector('[data-testid="note-editor"] .cm-content'); if (!c) return false; c.focus(); return true; })()`);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Down", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Down", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
    await sleep(60);
  };
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await sleep(60);
  };
  const openFile = async (p) => {
    await $(`location.hash = '#/p/${id}/f/${p.split("/").map(encodeURIComponent).join("/")}'; true`);
    await wait(() => has(`[data-testid="files-region"][data-path="${p}"]`), `file ${p}`);
  };

  await wait(() => has(".proj"), "projects home");
  await $(`location.hash = '#/p/${id}'; true`);
  await wait(() => has(".side-files"), "sidebar");

  // ── reading: links and tags are the app's own ──────────────────────────
  await openFile("docs/plan.md");
  await wait(() => has(".md-view a.wikilink"), "rendered note");
  check("a note opens to read, with the Read/Edit switch above it", (await $(`document.querySelector('.files-mode')?.dataset.mode`)) === "read");
  check("wiki links render as links, a dangling one marked as such", (await count(".md-view a.wikilink")) === 2 && (await text(".md-view a.wikilink.is-unresolved")) === "Pricing");
  check("a tag renders as a chip", (await $(`document.querySelector('.md-view a.hashtag')?.dataset.tag`)) === "launch");
  await shot("notes-01-read");

  await openFile("docs/pictures.md");
  await wait(() => $(`[...document.querySelectorAll('.md-view img.note-image')].filter((i) => i.src.startsWith('data:image/png')).length === 2`), "pictures");
  check("a picture of the store shows in a note, embedded or linked relatively", (await $(`[...document.querySelectorAll('.md-view img.note-image')].filter((i) => i.src.startsWith('data:image/png')).length`)) === 2);
  await openFile("docs/plan.md");
  await wait(() => has(".md-view a.wikilink"), "plan again");
  await click('.md-view a.wikilink:not(.is-unresolved)');
  await wait(() => has('[data-testid="files-region"][data-path="docs/checklist.md"]'), "followed link");
  check("clicking a wiki link opens the note it names", await has('[data-testid="files-region"][data-path="docs/checklist.md"]'));

  // ── backlinks and unlinked mentions ────────────────────────────────────
  await wait(() => has('[data-testid="backlinks"] .mention-row[data-source="docs/plan.md"]'), "backlinks");
  check("a note lists the notes linking to it, with the line", (await text('[data-testid="backlinks"] .mention-row[data-source="docs/plan.md"] .mention-text')) === "Ship after [[checklist]] and [[Pricing]]. #launch");
  await click(".note-backlinks-head.is-toggle");
  await wait(() => has('.mention-list[data-kind="unlinked"] .mention-row[data-source="meetings/kickoff.md"]'), "unlinked mentions");
  check("unlinked mentions fold open and name the note that says it", await has('.mention-list[data-kind="unlinked"] .mention-row[data-source="meetings/kickoff.md"]'));
  await shot("notes-02-backlinks");
  await click('.mention-list[data-kind="unlinked"] .mention-row[data-source="meetings/kickoff.md"] .mention-link');
  await wait(async () => (await read("meetings/kickoff.md"))?.includes("[[checklist]]"), "linked mention");
  check("Link turns a mention into a link in that note", (await read("meetings/kickoff.md")) === "# Kickoff\n\nWe agreed the [[checklist]] stays short.\n");
  await wait(() => has('.mention-list[data-kind="linked"] .mention-row[data-source="meetings/kickoff.md"]'), "new backlink");
  check("the new link joins the linked mentions", (await count('.mention-list[data-kind="linked"] .mention-row')) === 2);

  // ── a dangling link starts the note ────────────────────────────────────
  await openFile("docs/plan.md");
  await wait(() => has(".md-view a.wikilink.is-unresolved"), "dangling link");
  await click(".md-view a.wikilink.is-unresolved");
  await wait(() => has('[data-testid="files-region"][data-path="docs/Pricing.md"]'), "new note from a link");
  check("following a dangling link creates the note beside the linking one", (await read("docs/Pricing.md")) === "");
  await wait(() => has('[data-testid="note-editor"] .cm-content'), "editor on the new note");
  check("…and opens it to be written in", (await $(`document.querySelector('.files-mode')?.dataset.mode`)) === "edit");

  // ── writing: a pause saves a version ───────────────────────────────────
  await focusEditorEnd();
  await win.webContents.insertText("# Pricing\n\nTiers follow the ");
  await wait(async () => (await read("docs/Pricing.md")) === "# Pricing\n\nTiers follow the ", "autosave", 60);
  check("a pause in typing saves the note", (await read("docs/Pricing.md")) === "# Pricing\n\nTiers follow the ");
  await wait(() => $(`document.querySelector('.files-save-state')?.dataset.state === 'saved'`), "saved state");
  check("the bar says it is saved", (await text(".files-save-state")) === "Saved");
  await wait(() => $(`document.querySelectorAll('.version-row').length === 2`), "versions");
  check("the save is a version in the rail", (await count(".version-row")) === 2);

  await win.webContents.insertText("[[chec");
  await wait(() => has(".cm-tooltip-autocomplete li"), "link completion");
  check("typing [[ offers the notes by name", (await $(`[...document.querySelectorAll('.cm-tooltip-autocomplete li .cm-completionLabel')].map(n => n.textContent).join('|')`)).includes("checklist"));
  await shot("notes-03-complete");
  // A completion takes Enter only after it has been on screen a moment (CodeMirror's interactionDelay).
  await sleep(250);
  await key("Enter");
  await wait(async () => (await editorText())?.includes("[[checklist]]"), "completed link");
  same("choosing one writes the link and closes it", await editorText(), "# Pricing\n\nTiers follow the [[checklist]]");
  await win.webContents.insertText(". #pricing");
  await key("s", ["meta"]);
  await wait(async () => (await read("docs/Pricing.md"))?.endsWith("#pricing"), "⌘S save");
  check("⌘S saves at once", (await read("docs/Pricing.md")) === "# Pricing\n\nTiers follow the [[checklist]]. #pricing");
  await shot("notes-04-edit");

  // the app's ⌘Z stays out of the editor: typing is undone there, no project write is
  await sleep(700);
  await focusEditorEnd();
  await win.webContents.insertText("!");
  await key("z", ["meta"]);
  await sleep(300);
  same(
    "⌘Z in the editor undoes typing, not the project's last write",
    `${await editorText()} · ${(await ctx.oplog.timeline(id, 50)).filter((r) => r.undoneAt).length}`,
    "# Pricing\n\nTiers follow the [[checklist]]. #pricing · 0"
  );
  await wait(() => $(`document.querySelector('.files-save-state')?.dataset.state === 'saved'`), "settled after undo");

  // ── a save from elsewhere ──────────────────────────────────────────────
  await ctx.files.write(id, "docs/Pricing.md", "# Pricing\n\nRewritten by an agent.\n");
  await wait(async () => (await editorText()) === "# Pricing\n\nRewritten by an agent.\n", "outside save shown");
  same("an outside save shows up at once while nothing is unsaved", await editorText(), "# Pricing\n\nRewritten by an agent.\n");
  await focusEditorEnd();
  await win.webContents.insertText("Mine.");
  await ctx.files.write(id, "docs/Pricing.md", "# Pricing\n\nTheirs.\n");
  await wait(() => has('[data-testid="edit-conflict"]'), "conflict banner", 80);
  check("an outside save during unsaved edits stops the save and asks", (await read("docs/Pricing.md")) === "# Pricing\n\nTheirs.\n" && (await has('[data-testid="edit-conflict"]')));
  await shot("notes-05-conflict");
  await click(".edit-keep-both");
  // The copy lands in the main process before the renderer hears back; wait for the editor itself.
  await wait(async () => (await read("docs/Pricing (mine).md")) !== null && (await editorText()) === "# Pricing\n\nTheirs.\n", "copy of mine, theirs shown");
  same("Keep both saves mine beside theirs and shows theirs", `${await read("docs/Pricing (mine).md")} | ${await editorText()}`, "# Pricing\n\nRewritten by an agent.\nMine. | # Pricing\n\nTheirs.\n");

  // ── a file deleted under unsaved edits keeps them ─────────────────────
  await focusEditorEnd();
  await win.webContents.insertText("Still typing.");
  await ctx.files.remove(id, "docs/Pricing.md");
  await wait(() => has('[data-testid="edit-conflict"]'), "gone banner", 80);
  same("a delete under unsaved edits keeps the editor and says so", await text('[data-testid="edit-conflict"] p'), "Pricing.md was moved or deleted while you were editing it.");
  await click(".edit-keep-mine");
  await wait(async () => (await read("docs/Pricing.md"))?.endsWith("Still typing."), "kept mine");
  same("Keep mine writes it back", await read("docs/Pricing.md"), "# Pricing\n\nTheirs.\nStill typing.");

  // Ctrl chords are the editor's on a Mac: Ctrl-K deletes to the line end, it does not open the palette
  if (process.platform === "darwin") {
    await focusEditorEnd();
    await key("k", ["control"]);
    await sleep(300);
    check("Ctrl-K in the editor stays in the editor", !(await has(".palette-input")));
  }

  // walking away from an unanswered clash keeps the unsaved text beside the file
  await focusEditorEnd();
  await win.webContents.insertText(" Unsaved.");
  await ctx.files.write(id, "docs/Pricing.md", "# Pricing\n\nTheirs again.\n");
  await wait(() => has('[data-testid="edit-conflict"]'), "second clash", 80);
  await openFile("docs/plan.md");
  await wait(async () => (await read("docs/Pricing (mine 2).md")) !== null, "copy on leaving", 80);
  same("leaving an unanswered clash keeps yours as a copy", await read("docs/Pricing (mine 2).md"), "# Pricing\n\nTheirs.\nStill typing. Unsaved.");
  same("…and leaves theirs as it is", await read("docs/Pricing.md"), "# Pricing\n\nTheirs again.\n");

  // ── a file with Windows line endings keeps them ───────────────────────
  await ctx.files.write(id, "docs/windows.txt", "one\r\ntwo\r\n");
  await openFile("docs/windows.txt");
  await wait(() => has(".files-mode"), "CRLF file");
  await click(".files-mode button:nth-child(2)");
  await wait(() => has('[data-testid="note-editor"] .cm-content'), "editor on a CRLF file");
  const crlfVersions = (await ctx.files.history(id, "docs/windows.txt")).length;
  same("a CRLF file opens clean", await $(`document.querySelector('.files-save-state')?.dataset.state`), "saved");
  await focusEditorEnd();
  await $(`document.activeElement?.blur(); true`);
  await sleep(500);
  check("opening and leaving it writes nothing", (await ctx.files.history(id, "docs/windows.txt")).length === crlfVersions);
  await focusEditorEnd();
  await win.webContents.insertText("three");
  await key("s", ["meta"]);
  await wait(async () => (await read("docs/windows.txt"))?.includes("three"), "CRLF save");
  same("an edit saves with its own line endings", await read("docs/windows.txt"), "one\r\ntwo\r\nthree");
  await click(".files-mode button:nth-child(1)");

  // ── renaming keeps the links ───────────────────────────────────────────
  await openFile("docs/checklist.md");
  await wait(() => has(".crumb-rename"), "rename button");
  await click(".crumb-rename");
  await wait(() => has(".crumb-edit"), "rename field");
  await typeInto(".crumb-edit", "QA checklist.md");
  await $(`document.querySelector('.crumb-edit').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
  await wait(async () => (await read("docs/plan.md"))?.includes("[[QA checklist]]"), "links updated");
  check("renaming a note rewrites the links to it", (await read("docs/plan.md")) === "# Launch plan\n\nShip after [[QA checklist]] and [[Pricing]]. #launch\n" && (await read("meetings/kickoff.md")).includes("[[QA checklist]]"));
  same("…as one version saying so", (await ctx.files.history(id, "docs/plan.md"))[0]?.message, "Updated 2 links to QA checklist");

  // ── search ─────────────────────────────────────────────────────────────
  await click(".side-files-search");
  await wait(() => has('[data-testid="notes-search"] .notes-search-input'), "search pane");
  check("the search pane takes the tree's place, tags to start from", await wait(() => has('.notes-tag-cloud .tag-chip[data-tag="launch"]'), "tag cloud"));
  await typeInto(".notes-search-input", "launch staging");
  await wait(() => has('.search-hit[data-file="docs/QA checklist.md"]'), "search hits");
  check("words in any order find the note, its line marked", (await count(".search-hit")) === 1 && (await text('.search-hit[data-file="docs/QA checklist.md"] mark')).toLowerCase() === "staging");
  await shot("notes-06-search");
  await click('.search-hit[data-file="docs/QA checklist.md"]');
  await wait(() => has('[data-testid="files-region"][data-path="docs/QA checklist.md"]'), "opened hit");
  check("a hit opens and the results stay", (await count(".search-hit")) === 1);
  await openFile("docs/plan.md");
  await wait(() => has(".md-view a.hashtag"), "tag in note");
  await click(".md-view a.hashtag");
  await wait(async () => (await $(`document.querySelector('.notes-search-input')?.value`)) === "#launch", "tag search");
  await wait(() => $(`document.querySelectorAll('.search-hit').length === 2`), "tag hits");
  check("clicking a tag searches for it", (await count(".search-hit")) === 2);
  await click(".notes-search-close");
  await wait(() => has(".side-files-list"), "tree back");
  await key("f", ["meta", "shift"]);
  check("⇧⌘F opens the search from anywhere", await wait(() => $(`document.activeElement?.classList.contains('notes-search-input')`), "focused search"));
  check("one focus ring, on the field — none on the input inside it", await oneFocusRing(win, ".notes-search-input", ".notes-search-field"));
  await click(".notes-search-close");

  // ── new notes and the journal ──────────────────────────────────────────
  await press(".side-files-add");
  await wait(() => has(".menu.is-floating .menu-row"), "add menu");
  await clickMenuItem("Today's note");
  const day = `Journal/${localDay()}.md`;
  await wait(() => has(`[data-testid="files-region"][data-path="${day}"]`), "journal");
  check("Today's note opens the day's journal, made from its date", (await read(day)) === `# ${localDay()}\n\n` && (await has('[data-testid="note-editor"]')));
  await press(".side-files-add");
  await wait(() => has(".menu.is-floating .menu-row"), "add menu");
  await clickMenuItem("New note");
  await wait(() => has('input[aria-label="New note name"]'), "note name row");
  await $(`(() => { const i = document.querySelector('input[aria-label="New note name"]'); i.value = 'Retro'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
  // the region names the file before its content has loaded; the editor follows
  await wait(() => has('[data-testid="files-region"][data-path="Journal/Retro.md"] [data-testid="note-editor"]'), "new note open to write");
  check("New note makes it in the open folder and opens it to write", (await read("Journal/Retro.md")) === "" && (await has('[data-testid="note-editor"]')));

  // ── the palette is a quick switcher ────────────────────────────────────
  await key("k", ["meta"]);
  await wait(() => has(".palette-input"), "palette");
  await $(`(() => { const i = document.querySelector('.palette-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'kickoff'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await wait(() => has('.palette-row[data-file="meetings/kickoff.md"]'), "palette file row");
  check("the palette finds a file by name", await has('.palette-row[data-file="meetings/kickoff.md"]'));
  await key("Enter");
  check("…and opens it", await wait(() => has('[data-testid="files-region"][data-path="meetings/kickoff.md"]'), "palette open"));
  await key("k", ["meta"]);
  await wait(() => has(".palette-input"), "palette again");
  await $(`(() => { const i = document.querySelector('.palette-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'agreed short'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await wait(() => has(".palette-search-notes"), "search offer");
  check("when nothing is called that, the palette offers to search the notes for it", (await text(".palette-search-notes")) === "Search notes for “agreed short”");
  await click(".palette-search-notes");
  check("…which opens the search with the words", await wait(async () => (await $(`document.querySelector('.notes-search-input')?.value`)) === "agreed short" && (await has('.search-hit[data-file="meetings/kickoff.md"]')), "palette search"));
  await click(".notes-search-close");

  // ⌘E flips between reading and writing, and the choice is kept for the next file
  await openFile("docs/Pricing.md");
  await wait(() => has(".md-view"), "Pricing to read");
  await key("e", ["meta"]);
  check("⌘E switches a note to editing", await wait(() => has('[data-testid="note-editor"] .cm-content'), "editing by ⌘E"));
  await openFile("docs/plan.md");
  check("…and the next note opens the same way", await wait(() => has('[data-testid="note-editor"] .cm-content'), "editing kept"));

  // ── split: the text and what it renders, side by side ─────────────────
  await openFile("docs/plan.md");
  await wait(() => has('[data-testid="note-editor"] .cm-content'), "plan to write");
  same("a note offers Read, Edit and Split", await $(`[...document.querySelectorAll('.files-mode button')].map((b) => b.textContent).join('|')`), "Read|Edit|Split");
  check("writing takes the whole width, no reading column", await $(`(() => { const c = document.querySelector('[data-testid="note-editor"] .cm-content'), e = document.querySelector('[data-testid="note-editor"]'); return Math.abs(c.getBoundingClientRect().width - e.getBoundingClientRect().width) < 2; })()`));
  await $(`document.querySelector('[data-testid="note-editor"] .cm-editor').__probe = 1; true`);
  await click(".files-mode button:nth-child(3)");
  await wait(() => has('[data-testid="note-preview"] .md-view'), "split view");
  same("Split shows the editor and the rendered note", await $(`[document.querySelector('.files-mode')?.dataset.mode, !!document.querySelector('[data-testid="note-preview"] .md-view h1'), document.querySelector('[data-testid="note-editor"] .cm-editor')?.__probe].join()`), "split,true,1");
  check(
    "the halves share the width equally and fill it",
    await $(`(() => {
      const [a, b] = [...document.querySelectorAll('.note-pane')].map((n) => n.getBoundingClientRect());
      const main = document.querySelector('.files-main'), cs = getComputedStyle(main);
      const inner = main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      return Math.abs(a.width - b.width) < 2 && Math.abs(a.width + b.width - inner) < 2 && b.left >= a.right - 1;
    })()`)
  );
  same("the backlinks move under the preview", await $(`[!!document.querySelector('.note-pane-preview .note-backlinks'), document.querySelectorAll('.note-backlinks').length].join()`), "true,1");
  await focusEditorEnd();
  await win.webContents.insertText("## Typed just now");
  check("the preview follows the typing before any save", await wait(() => $(`[...document.querySelectorAll('[data-testid="note-preview"] .md-view h2')].some((h) => h.textContent === 'Typed just now')`), "live preview", 40));
  await shot("notes-09-split");
  await click(".files-mode button:nth-child(2)");
  await wait(() => !has('[data-testid="note-preview"]'), "back to edit");
  same("leaving the preview keeps the same editor, not a fresh one", await $(`document.querySelector('[data-testid="note-editor"] .cm-editor')?.__probe ?? 0`), 1);
  await click(".files-mode button:nth-child(3)");
  await wait(() => has('[data-testid="note-preview"] .md-view'), "split again");
  await key("s", ["meta"]);
  await wait(async () => (await read("docs/plan.md"))?.includes("Typed just now"), "split save");

  // the two halves keep each other's place in a long note
  const long = Array.from({ length: 80 }, (_, i) => `## Section ${i + 1}\n\nBody of section ${i + 1}, long enough to wrap across the narrow half of the screen when it is drawn in the editor and in the preview alike.`).join("\n\n");
  await ctx.files.write(id, "docs/long.md", `# Long\n\n${long}\n`);
  await openFile("docs/long.md");
  await wait(() => $(`document.querySelectorAll('[data-testid="note-preview"] [data-line]').length > 100`), "long note in split");
  const topSection = (pane) =>
    $(`(() => {
      const pane = document.querySelector(${JSON.stringify(pane)}), top = pane.getBoundingClientRect().top + 4;
      const rows = pane.querySelectorAll(${JSON.stringify(pane === ".note-pane-edit" ? ".cm-line" : "[data-line]")});
      const row = [...rows].find((r) => r.getBoundingClientRect().bottom > top && /section \\d+/i.test(r.textContent));
      return Number(/section (\\d+)/i.exec(row?.textContent ?? '')?.[1] ?? 0);
    })()`);
  await $(`(() => { const p = document.querySelector('.note-pane-edit'); p.dispatchEvent(new WheelEvent('wheel', { bubbles: true })); p.scrollTop = p.scrollHeight * 0.5; return true; })()`);
  await sleep(400);
  const [editAt, previewAt] = [await topSection(".note-pane-edit"), await topSection(".note-pane-preview")];
  check(`scrolling the editor brings the preview to the same section (${editAt} ↔ ${previewAt})`, editAt > 20 && editAt === previewAt);
  await $(`(() => { const p = document.querySelector('.note-pane-preview'); p.dispatchEvent(new WheelEvent('wheel', { bubbles: true })); p.scrollTop = p.scrollHeight * 0.2; return true; })()`);
  await sleep(400);
  const [previewBack, editBack] = [await topSection(".note-pane-preview"), await topSection(".note-pane-edit")];
  check(`scrolling the preview brings the editor along (${previewBack} ↔ ${editBack})`, previewBack > 5 && previewBack < editAt && editBack === previewBack);
  await shot("notes-10-split-long");

  // any file that renders gets the three; plain text has nothing else to show
  await ctx.files.write(id, "site/page.html", "<h1>Hello</h1>\n");
  await openFile("site/page.html");
  await wait(() => has('[data-testid="note-preview"] iframe.html-view'), "html in split");
  check("an HTML page splits into its source and the page", (await count(".files-mode button")) === 3 && (await $(`document.querySelector('[data-testid="note-preview"] iframe')?.srcdoc.includes('<h1>Hello</h1>')`)));
  await focusEditorEnd();
  await win.webContents.insertText("<p>More</p>");
  check("…and the page redraws as it is written", await wait(() => $(`document.querySelector('[data-testid="note-preview"] iframe')?.srcdoc.includes('<p>More</p>')`), "html live", 40));
  await key("s", ["meta"]);
  await wait(async () => (await read("site/page.html"))?.includes("<p>More</p>"), "html saved");
  await openFile("readme.txt");
  await wait(() => has('[data-testid="note-editor"] .cm-content'), "plain text");
  same("plain text writes without a preview beside it", await $(`[document.querySelector('.files-mode')?.dataset.mode, document.querySelectorAll('.files-mode button').length, !!document.querySelector('[data-testid="note-preview"]')].join()`), "edit,2,false");
  await openFile("docs/plan.md");
  await wait(() => has('[data-testid="note-preview"]'), "plan split");
  await key("e", ["meta"]);
  await wait(() => has(".files-mode[data-mode=read]"), "read by ⌘E");
  await key("e", ["meta"]);
  check("⌘E goes back to the split it came from", await wait(() => has('[data-testid="note-preview"] .md-view'), "split by ⌘E"));

  // the same screens in the dark
  await $(`document.documentElement.classList.remove('dawn', 'matcha'); document.documentElement.classList.add('dark'); true`);
  await openFile("docs/Pricing.md");
  await wait(() => has('[data-testid="note-editor"]'), "editor in the dark");
  await sleep(300);
  await shot("notes-07-edit-dark");
  await click(".files-mode button:nth-child(1)");
  await wait(() => has(".md-view"), "reading in the dark");
  same("the switch reads as what is shown", await $(`[document.querySelector('.files-mode')?.dataset.mode, ...[...document.querySelectorAll('.files-mode button')].map((b) => b.getAttribute('aria-pressed'))].join()`), "read,true,false,false");
  await shot("notes-08-read-dark");
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
  console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots in ${shots}`);
  if (failed.length) console.log("failed: " + failed.map((f) => f.name).join(" | "));
  app.exit(failed.length ? 1 : 0);
});
