/**
 * Files regression: the real renderer, IPC and plugins over a throwaway
 * userData. Drives the sidebar tree, the viewer and its versions, a clash
 * between two machines, and pinning a file to a ticket.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop exec electron scripts/files-check.mjs
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boot } from "../dist/boot.js";
import { createGitBackend, GitFileStore } from "@tomrade/files";
import { gitRunner } from "@tomrade/storage";

// zod is the plugins' dependency, not the app's; borrow it from where the Files plugin resolves it.
const { z } = await import(pathToFileURL(createRequire(import.meta.resolve("@tomrade/files")).resolve("zod")).href);

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-files-ui-"));
const shots = process.env.TOMRADE_SHOTS || path.join(work, "shots");
fs.mkdirSync(shots, { recursive: true });
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
};

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Files regression", keyPrefix: "FIL" });
  await ctx.storage.ready;
  const board = ctx.boards.defaultFor(project.id);
  const ticket = ctx.items.create({ projectId: project.id, boardId: board.id, title: "Write the brief", workType: "general", by: "human" });

  // A remote any folder can be: what a GitHub repository is to the app.
  const remote = path.join(work, "remote.git");
  fs.mkdirSync(remote);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  ctx.plugin({
    name: "folder-backend",
    inject: ["files"],
    apply: (c) => void c.files.register(createGitBackend({ id: "folder", title: "A folder", configSchema: z.object({ path: z.string(), directory: z.string().default("") }), defaults: { path: "", directory: "" }, describe: (cfg) => cfg.path, remote: (cfg) => ({ url: cfg.path, branch: "main", directory: cfg.directory }) }))
  });
  await sleep(50);

  const brief = await ctx.files.write(project.id, "docs/brief.md", "# The brief\n\nA first draft with a [link](https://example.com).\n\n- one\n- two\n");
  await ctx.files.write(project.id, "docs/notes.txt", "plain notes\n");
  await ctx.files.write(project.id, "site/index.html", "<!doctype html><html><body><h1 id='hello'>Hello</h1><script>document.title='x'</script></body></html>");

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
  const wait = async (cond, what = "condition") => {
    for (let i = 0; i < 120; i++) {
      if (await cond()) return true;
      await sleep(100);
    }
    console.log(`timed out waiting for ${what}`);
    return false;
  };
  const shot = async (name) => fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const rightClick = (selector) =>
    $(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 4, clientY: r.y + 4 })); return true; })()`);
  const clickMenuItem = (name) =>
    $(`(() => { const row = [...document.querySelectorAll('.menu.is-floating .menu-row')].find((r) => r.querySelector('.m-name')?.textContent === ${JSON.stringify(name)}); if (!row) return false; row.click(); return true; })()`);
  const dragMove = (fromSelector, toSelector) =>
    $(`(() => {
      const from = document.querySelector(${JSON.stringify(fromSelector)});
      const to = document.querySelector(${JSON.stringify(toSelector)});
      if (!from || !to) return false;
      const dt = new DataTransfer();
      from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      from.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true;
    })()`);
  const menuItemNames = () => $(`[...document.querySelectorAll('.menu.is-floating .menu-row .m-name')].map((n) => n.textContent).join('|')`);
  // Toasts append to the end of the stack, so the newest one is the last ".toast" in the DOM; its body leaves out any Undo button.
  const lastToast = () => $(`[...document.querySelectorAll('.toast .toast-body')].at(-1)?.textContent ?? null`);

  // ── the tree in the sidebar ──────────────────────────────────────────
  await wait(() => has(".proj"), "projects home");
  await $(`location.hash = '#/p/${project.id}'; true`);
  await wait(() => has(".side-files"), "sidebar");
  check("the files tree sits above the views", await $(`(() => { const s = document.querySelector('.sidebar'); const groups = [...s.querySelectorAll('.side-group')]; return groups[0]?.classList.contains('side-files') && groups[1]?.classList.contains('side-views'); })()`));
  await wait(() => $(`document.querySelectorAll('.side-row.is-file').length >= 2`), "tree rows");
  check("top-level folders are listed, folded", (await $(`[...document.querySelectorAll('.side-row.is-file')].map(n => n.dataset.file).join()`)) === "docs,site");
  await click('.side-row.is-file[data-file="docs"] .chev');
  await wait(() => has('.side-row.is-file[data-file="docs/brief.md"]'), "unfolded folder");
  check("a folder unfolds to its files, indented", (await $(`document.querySelector('.side-row.is-file[data-file="docs/brief.md"]')?.dataset.depth`)) === "1");
  check("each file row carries its stable id", brief.fileId && (await ctx.files.tree(project.id)).find((e) => e.path === "docs/brief.md")?.fileId === brief.fileId);

  // ── a folder comes in whole ──────────────────────────────────────────
  const incoming = path.join(work, "incoming");
  fs.mkdirSync(path.join(incoming, "sub"), { recursive: true });
  fs.writeFileSync(path.join(incoming, "sub", "deep.txt"), "deep");
  fs.writeFileSync(path.join(incoming, "top.md"), "# top");
  await ctx.files.importFiles(project.id, "", [incoming]);
  await wait(() => has('.side-row.is-file[data-file="incoming"]'), "imported folder");
  await click('.side-row.is-file[data-file="incoming"] .chev');
  await wait(() => has('.side-row.is-file[data-file="incoming/sub"]'), "imported subfolder");
  check("a folder is imported whole, with its subfolders", (await has('.side-row.is-file[data-file="incoming/top.md"]')) && (await ctx.files.read(project.id, "incoming/sub/deep.txt"))?.body === "deep");
  await press(".side-files-add");
  await wait(() => $(`document.querySelectorAll('.menu.is-floating .menu-row').length === 2`), "add menu");
  check("the add button offers files and folders", (await $(`[...document.querySelectorAll('.menu.is-floating .menu-row .m-name')].map(n => n.textContent).join('|')`)) === "Add files…|Add folder…");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(300);

  // ── the viewer ───────────────────────────────────────────────────────
  await click('.side-row.is-file[data-file="docs/brief.md"]');
  await wait(() => has('[data-testid="files-region"][data-path="docs/brief.md"]'), "file screen");
  check("opening a file takes the board's place and marks the row current", (await $(`document.querySelector('.side-row.is-file[data-file="docs/brief.md"]')?.getAttribute('aria-current')`)) === "true");
  check("no view row reads as current while a file is open", (await count('.side-row.is-view[aria-current="true"]')) === 0);
  check("the current file row has the same highlight bounds as a view", await $(`(() => { const file = document.querySelector('.side-row.is-file[aria-current="true"]'); const view = document.querySelector('.side-row.is-view'); if (!file || !view) return false; const a = file.getBoundingClientRect(); const b = view.getBoundingClientRect(); return Math.abs(a.left - b.left) < 1 && Math.abs(a.right - b.right) < 1; })()`));
  check("the head is the path", (await $(`[...document.querySelectorAll('.files-crumbs .crumb')].map(n => n.textContent).join('/')`)) === "Files/docs/brief.md");
  await wait(() => has(".md-view h1"), "rendered markdown");
  check("markdown renders as prose", (await text(".md-view h1")) === "The brief" && (await count(".md-view li")) === 2);
  check("its links leave for the browser, not the app", (await $(`document.querySelector('.md-view a')?.getAttribute('href')`)) === "https://example.com");
  await wait(() => $(`document.querySelectorAll('.version-row').length === 1`), "versions");
  check("the version rail lists the save", (await count(".version-row")) === 1 && (await $(`document.querySelector('.version-row')?.dataset.version`)) === brief.versionId);
  await shot("files-01-markdown");
  await click('.file-view .seg button:nth-child(2)');
  await sleep(200);
  check("the source is one switch away", (await has(".file-view .text-view")) === true);

  const second = await ctx.files.write(project.id, "docs/brief.md", "# The brief\n\nSecond draft.\n");
  await wait(() => $(`document.querySelectorAll('.version-row').length === 2`), "second version");
  check("a save from the main process reaches the rail", (await count(".version-row")) === 2);
  await wait(() => has(`.version-row[data-version="${second.versionId}"][aria-current="true"]`), "newest version current");
  await click(`.version-row[data-version="${brief.versionId}"]`);
  await wait(() => has(".files-version-banner"), "older version banner");
  await click('.file-view .seg button:nth-child(1)');
  await sleep(200);
  check("an older version reads as it was saved", (await $(`document.querySelector('.md-view')?.textContent ?? ''`)).includes("A first draft"));
  await click(".files-version-banner .btn");
  await sleep(300);
  check("back to latest shows the newest save", (await $(`document.querySelector('.md-view')?.textContent ?? ''`)).includes("Second draft"));

  await $(`location.hash = '#/p/${project.id}/f/site/index.html'; true`);
  await wait(() => has(".html-view"), "html frame");
  check("html is shown in an origin-isolated frame with scripts allowed", (await $(`document.querySelector('.html-view')?.getAttribute('sandbox')`)) === "allow-scripts" && (await $(`document.title`)) !== "x");
  await shot("files-02-html");
  await $(`location.hash = '#/p/${project.id}/f/docs/notes.txt'; true`);
  await wait(() => has(".text-view"), "text view");
  check("plain text is shown as text", (await text(".text-view")) === "plain notes\n");

  // ── folders and the root ─────────────────────────────────────────────
  await $(`location.hash = '#/p/${project.id}/f/'; true`);
  await wait(() => has('[data-testid="files-sharing"]'), "root");
  check("the root lists folders and says how the files are shared", (await count('[data-testid="file-table"] .file-row')) === 3 && (await text('[data-testid="files-sharing"] .tag')) === "This machine");
  await shot("files-03-root");

  // ── multiselect, cut, copy, paste and bulk delete ────────────────────
  const checkbox = (p) => `[data-testid="file-table"] .file-row[data-file="${p}"] .file-select-col input`;
  await click(checkbox("docs"));
  await click(checkbox("site"));
  await wait(() => has('[data-testid="files-selection-bar"]'), "selection bar");
  check("checking two rows shows a selection bar with the count", (await text(".files-selection-bar .selection-count")) === "2 selected");
  await sleep(300);
  await shot("files-03a-selection");
  await click(".files-selection-bar .sel-copy");
  await click(".files-selection-bar .sel-clear");
  await wait(async () => !(await has(".files-selection-bar")), "selection cleared");
  check("clearing the selection drops the bar but keeps the clipboard", !(await has(".files-selection-bar")));

  await click('[data-testid="file-table"] .file-row[data-file="incoming"] .file-link');
  await wait(() => has('[data-testid="files-region"][data-path="incoming"]'), "incoming folder");
  await click(".files-paste");
  await wait(() => has('[data-testid="file-table"] .file-row[data-file="incoming/docs"]'), "pasted docs");
  await wait(() => has('[data-testid="file-table"] .file-row[data-file="incoming/site"]'), "pasted site");
  await wait(async () => (await lastToast()) === "Pasted 2 items", "paste toast");
  check("pasting a copy toasts the count", (await lastToast()) === "Pasted 2 items");
  const rootDocsId = (await ctx.files.read(project.id, "docs/brief.md"))?.fileId;
  const copiedDocsId = (await ctx.files.read(project.id, "incoming/docs/brief.md"))?.fileId;
  check("a paste from copy leaves the source alone and mints fresh ids for the copy", rootDocsId && copiedDocsId && rootDocsId !== copiedDocsId && (await ctx.files.read(project.id, "incoming/docs/brief.md"))?.body === (await ctx.files.read(project.id, "docs/brief.md"))?.body);

  const topId = (await ctx.files.read(project.id, "incoming/top.md"))?.fileId;
  await rightClick('[data-testid="file-table"] .file-row[data-file="incoming/top.md"]');
  await wait(() => has(".menu.is-floating"), "row context menu");
  check("a file row's menu offers cut, copy, keep local and delete but no paste", (await menuItemNames()) === "Cut|Copy|Keep local|Delete…");
  await sleep(300);
  await shot("files-03b-context-menu");
  await clickMenuItem("Cut");
  await $(`location.hash = '#/p/${project.id}/f/'; true`);
  await wait(() => has('[data-testid="files-sharing"]'), "back at root");
  await click(".files-paste");
  await wait(() => has('[data-testid="file-table"] .file-row[data-file="top.md"]'), "moved top.md");
  check("cut then paste moves the file and keeps its id", (await count('[data-testid="file-table"] .file-row')) === 4 && (await ctx.files.read(project.id, "top.md"))?.fileId === topId);
  check("the file is gone from where it was cut", (await ctx.files.read(project.id, "incoming/top.md")) === null);

  await click('[data-testid="file-table"] .file-row[data-file="incoming"] .file-link');
  await wait(() => has('[data-testid="files-region"][data-path="incoming"]'), "incoming folder again");
  await click(checkbox("incoming/docs"));
  await click(checkbox("incoming/site"));
  await wait(() => has('[data-testid="files-selection-bar"]'), "selection bar for delete");
  await click(".files-selection-bar .sel-delete");
  await wait(() => has(".files-delete"), "bulk delete confirm");
  check("deleting a selection asks about all of it by count", (await text(".files-delete p")) === "Delete 2 items? Their versions stay in the history.");
  await click(".files-delete .btn-danger");
  await wait(async () => !(await has('[data-testid="file-table"] .file-row[data-file="incoming/docs"]')), "bulk delete done");
  await wait(async () => (await lastToast()) === "Deleted 2 items", "delete toast");
  check("bulk delete removes every checked row and toasts the count", !(await has('[data-testid="file-table"] .file-row[data-file="incoming/site"]')) && (await lastToast()) === "Deleted 2 items");

  // ── dragging a row onto a folder moves it ────────────────────────────
  await $(`location.hash = '#/p/${project.id}/f/'; true`);
  await wait(() => has('[data-testid="files-sharing"]'), "root before dragging");
  const topIdAtRoot = (await ctx.files.read(project.id, "top.md"))?.fileId;
  await dragMove('[data-testid="file-table"] .file-row[data-file="top.md"]', '[data-testid="file-table"] .file-row[data-file="site"]');
  // top.md is nested under site once moved, so it never shows as a row at root — watch it vanish from here instead.
  await wait(async () => !(await has('[data-testid="file-table"] .file-row[data-file="top.md"]')), "top.md moved out of root");
  check("dragging a file onto a folder row moves it there and keeps its id", (await ctx.files.read(project.id, "site/top.md"))?.fileId === topIdAtRoot);
  await wait(async () => (await lastToast()) === "Moved top.md", "move toast");
  check("a drag move toasts as a move, not a paste", (await lastToast()) === "Moved top.md");

  await click('[data-testid="file-table"] .file-row[data-file="site"] .file-link');
  await wait(() => has('[data-testid="files-region"][data-path="site"]'), "site folder");
  // "incoming" itself is left behind, empty — the later sidebar section still needs it there to right-click.
  await dragMove('.side-file-row-container[data-file="incoming/sub"]', '.side-file-row-container[data-file="site"]');
  await wait(() => has('.side-row.is-file[data-file="site/sub"]'), "dragged a folder in the tree");
  check("dragging a folder in the sidebar tree moves the whole thing", (await ctx.files.read(project.id, "site/sub/deep.txt"))?.body === "deep");

  // ── the same three from the sidebar tree ─────────────────────────────
  await $(`location.hash = '#/p/${project.id}/f/'; true`);
  await wait(() => has('[data-testid="files-sharing"]'), "root again");
  await rightClick('.side-file-row-container[data-file="docs"]');
  await wait(() => has(".menu.is-floating"), "tree context menu");
  check("a tree folder's menu offers cut, copy, keep local and delete, and paste only once something is copied", (await menuItemNames()) === "Cut|Copy|Keep local|Delete…");
  await clickMenuItem("Copy");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(200);
  await rightClick('.side-file-row-container[data-file="incoming"]');
  await wait(() => has(".menu.is-floating"), "tree context menu with paste");
  check("once something is copied, a folder's menu offers to paste it", (await menuItemNames()) === "Cut|Copy|Paste|Keep local|Delete…");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(200);
  await wait(() => has(".side-files-paste"), "tree paste button appears");
  await click(".side-files-paste");
  await wait(() => has('.side-row.is-file[data-file="docs (copy)"]'), "pasted from the tree");
  check("copying from the tree and pasting from its toolbar makes a sibling copy", (await ctx.files.read(project.id, "docs (copy)/brief.md"))?.body === (await ctx.files.read(project.id, "docs/brief.md"))?.body);
  await sleep(300);
  await shot("files-03c-tree-paste");

  // ── a move that lands exactly where the file already is does nothing ─
  await $(`location.hash = '#/p/${project.id}/f/site'; true`);
  await wait(() => has('[data-testid="files-region"][data-path="site"]'), "site folder for the no-op check");
  const indexId = (await ctx.files.read(project.id, "site/index.html"))?.fileId;
  const countBeforeNoop = await count('[data-testid="file-table"] .file-row');
  const toastsBeforeNoop = JSON.stringify(await $(`[...document.querySelectorAll('.toast')].map(n=>n.textContent)`));
  await rightClick('[data-testid="file-table"] .file-row[data-file="site/index.html"]');
  await wait(() => has(".menu.is-floating"), "context menu for no-op cut");
  await clickMenuItem("Cut");
  await click(".files-paste");
  await sleep(500);
  check(
    "cutting a file and pasting it back where it already was is a no-op, not a rename",
    toastsBeforeNoop === JSON.stringify(await $(`[...document.querySelectorAll('.toast')].map(n=>n.textContent)`)) &&
      (await count('[data-testid="file-table"] .file-row')) === countBeforeNoop &&
      (await ctx.files.read(project.id, "site/index.html"))?.fileId === indexId
  );
  await $(`location.hash = '#/p/${project.id}/f/'; true`);
  await wait(() => has('[data-testid="files-sharing"]'), "root before the remote section");

  // ── a remote, and a clash with another machine ───────────────────────
  const bound = await ctx.files.bind(project.id, "folder", { path: remote });
  check("sharing pushes the files and reads as in step", bound.state === "synced" && bound.location === remote);
  const other = await new GitFileStore({ git: gitRunner("git"), gitBinary: "git", dir: path.join(work, "other"), remote: () => ({ url: remote, branch: "main" }), location: remote, warn: () => {}, onChange: () => {}, watch: false }).open();
  check("another machine clones what was shared", (await other.read("docs/brief.md"))?.body === "# The brief\n\nSecond draft.\n");
  await other.write("docs/notes.txt", Buffer.from("their notes\n"));
  await other.sync();
  await ctx.files.write(project.id, "docs/notes.txt", "my notes\n");
  const clashed = await ctx.files.sync(project.id);
  check("a file changed on both sides is a clash, not a loss", clashed.state === "conflicted" && clashed.conflicts === 1);
  await wait(() => has('[data-testid="conflict-list"]'), "conflict list");
  check("the root lists what needs a decision", (await text('[data-testid="conflict-list"] .m-name')) === "docs/notes.txt");
  check("the tree marks the file and the label row", (await has('.side-row.is-file[data-file="docs/notes.txt"] .side-mark.is-conflicted')) && (await $(`document.querySelector('.side-label-row .side-mark.is-state')?.dataset.state`)) === "conflicted");
  await shot("files-04-conflicts");
  await click('[data-testid="conflict-list"] .menu-row');
  await wait(() => has('[data-testid="conflict-panel"]'), "conflict panel");
  check("both sides are shown whole", (await $(`[...document.querySelectorAll('.conflict-side .text-view')].map(n => n.textContent).join('|')`)) === "my notes\n|their notes\n");
  await shot("files-05-conflict-panel");
  await click(".conflict-theirs");
  await wait(async () => (await ctx.files.status(project.id)).state === "synced", "resolution synced");
  check("keeping theirs settles the clash and syncs", (await ctx.files.read(project.id, "docs/notes.txt"))?.body === "their notes\n" && (await other.sync()).state === "synced");
  await wait(() => has(".text-view"), "resolved file");
  check("the screen shows the kept side", (await text(".text-view")) === "their notes\n");

  // ── a ticket pins a version ──────────────────────────────────────────
  await $(`location.hash = '#/p/${project.id}/i/${ticket.id}'; true`);
  await wait(() => has(".delivery-add-output"), "delivery panel");
  await press(".delivery-add-output");
  await wait(() => has('[data-testid="file-picker-filter"]'), "file picker");
  check("the picker offers the project's files", (await count(".file-picker-list .menu-row")) === 7);
  await click('.file-picker-list .menu-row[data-file="docs/brief.md"]');
  await click('.file-picker-list .menu-row[data-file="docs/notes.txt"]');
  check("the picker keeps more than one file selected", (await count('.file-picker-list .menu-row[aria-checked="true"]')) === 2);
  await click(".file-picker-add");
  await wait(() => count(".file-ref").then(n => n === 2), "resource links");
  const pinnedItem = ctx.items.get(project.id, ticket.id);
  check("picking files pins all latest versions to the ticket", pinnedItem.evidence.resources.length === 2 && pinnedItem.evidence.resources[0]?.file.versionId === second.versionId && pinnedItem.evidence.resources[0]?.file.fileId === brief.fileId);
  await shot("files-06-delivery");
  await ctx.files.write(project.id, "docs/brief.md", "# The brief\n\nThird draft.\n");
  await click(".file-ref");
  await wait(() => has('[data-testid="pinned-banner"]'), "pinned version");
  check("the artifact opens the version it pinned, not the head", (await $(`document.querySelector('.md-view')?.textContent ?? ''`)).includes("Second draft"));
  check("and offers the current file", (await has('[data-testid="pinned-banner"] .btn')) === true);
  await shot("files-07-pinned");

  // ── undo, redo and the history window ────────────────────────────────
  await $(`location.hash = '#/p/${project.id}/f/'; true`);
  await wait(() => has('[data-testid="files-sharing"]'), "root before the undo checks");
  const copyId = (await ctx.files.read(project.id, "docs (copy)/brief.md"))?.fileId;
  await rightClick('[data-testid="file-table"] .file-row[data-file="docs (copy)"]');
  await wait(() => has(".menu.is-floating"), "context menu for the undo checks");
  await clickMenuItem("Delete…");
  await wait(() => has(".files-delete"), "delete confirm for the undo checks");
  await click(".files-delete .btn-danger");
  await wait(async () => !(await has('[data-testid="file-table"] .file-row[data-file="docs (copy)"]')), "folder deleted");
  await wait(async () => (await lastToast())?.startsWith("Deleted docs (copy)"), "delete toast with undo");
  const toastUndo = () => $(`[...document.querySelectorAll('.toast')].at(-1)?.querySelector('.btn-ghost')?.textContent ?? ''`);
  check("deleting a file or folder toasts with an Undo", (await toastUndo()).includes("Undo"));
  await $(`[...document.querySelectorAll('.toast')].at(-1).querySelector('.btn-ghost').click(); true`);
  await wait(() => has('[data-testid="file-table"] .file-row[data-file="docs (copy)"]'), "folder restored by the toast");
  await wait(async () => (await lastToast()) === "Restored docs (copy)", "restore toast");
  check("the toast's Undo brings the folder back, its files keeping their ids", (await ctx.files.read(project.id, "docs (copy)/brief.md"))?.fileId === copyId && (await lastToast()) === "Restored docs (copy)");

  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',metaKey:true,shiftKey:true,bubbles:true}));true`);
  await wait(async () => !(await has('[data-testid="file-table"] .file-row[data-file="docs (copy)"]')), "redo deleted the folder again");
  await wait(async () => (await lastToast()) === "Deleted docs (copy) again", "redo toast");
  check("⇧⌘Z redoes the delete", !(await has('[data-testid="file-table"] .file-row[data-file="docs (copy)"]')) && (await lastToast()) === "Deleted docs (copy) again");

  check("the title bar offers History right beside Settings", (await $(`(() => { const h = document.querySelector('.titlebar .title-history'); return !!h && h.nextElementSibling?.querySelector('use')?.getAttribute('href') === '#i-gear'; })()`)) === true);
  await click(".titlebar .title-history");
  await wait(() => has('[data-testid="history-list"] .hist-row'), "history window");
  const histRows = () => $(`[...document.querySelectorAll('[data-testid="history-list"] .hist-row')].map((r) => r.dataset.ref.split(':')[0] + '|' + r.dataset.undone + '|' + r.querySelector('.hist-text').textContent)`);
  let rows = await histRows();
  check("the history lists file operations and backlog writes together, newest first, nothing undone", rows[0] === "files|false|deleted docs (copy)" && rows.some((r) => r.startsWith("oplog|")) && rows.every((r) => !r.includes("|true|")));
  check("the newest record reads as the latest and offers no rollback", (await $(`document.querySelector('[data-testid="history-list"] .hist-row[data-latest="true"] .hist-state')?.textContent`)) === "Latest" && !(await has('[data-testid="history-list"] .hist-row[data-latest="true"] .hist-act')));
  await shot("files-08-history");
  await $(`document.querySelectorAll('[data-testid="history-list"] .hist-row')[1].querySelector('.hist-act').click(); true`);
  await wait(() => has('[data-testid="history-list"] .hist-row[data-undone="true"]'), "rolled back one step");
  rows = await histRows();
  check("rolling back to the record below undoes the delete and greys it", rows[0] === "files|true|deleted docs (copy)" && (await ctx.files.read(project.id, "docs (copy)/brief.md"))?.fileId === copyId);
  await $(`document.querySelector('[data-testid="history-list"] .hist-row[data-undone="true"] .hist-act').click(); true`);
  await wait(async () => !(await has('[data-testid="history-list"] .hist-row[data-undone="true"]')), "redone from the window");
  check("redoing to the greyed record deletes it again", (await ctx.files.read(project.id, "docs (copy)/brief.md")) === null && (await $(`document.querySelectorAll('[data-testid="history-list"] .hist-row')[0]?.dataset.latest`)) === "true");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await wait(async () => !(await has('[data-testid="history-list"]')), "history closed");

  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',metaKey:true,bubbles:true}));true`);
  await wait(() => has('[data-testid="file-table"] .file-row[data-file="docs (copy)"]'), "⌘Z restored the folder");
  await wait(async () => (await lastToast()) === "Restored docs (copy)", "⌘Z toast");
  check("⌘Z undoes a file operation when it is the newest thing done", (await has('[data-testid="file-table"] .file-row[data-file="docs (copy)"]')) && (await lastToast()) === "Restored docs (copy)");

  other.close();

  // ── selective sharing: real UI controls, local history, scoped remote ─
  // A separate project keeps the existing picker counts and undo history intact.
  const selective = ctx.projects.create({ name: "Selective Files regression", keyPrefix: "SYN" });
  await ctx.storage.ready;
  const localFirst = await ctx.files.write(selective.id, "private/draft.txt", "local first draft\n");
  const localLatest = await ctx.files.write(selective.id, "private/draft.txt", "local second draft\n");
  await ctx.files.write(selective.id, "private/public.txt", "shared exception\n");
  await ctx.files.write(selective.id, "private/untouched.txt", "never selected\n");
  const region = '[data-testid="files-region"]';
  const row = (p) => `[data-testid="file-table"] .file-row[data-file=${JSON.stringify(p)}]`;
  const rowMark = (p) => `${row(p)} .sync-mark`;
  const titleOf = (selector) => $(`document.querySelector(${JSON.stringify(selector)})?.title ?? null`);
  const markOf = (selector) => $(`document.querySelector(${JSON.stringify(selector)})?.dataset.sync ?? null`);
  const navigateSync = async (p) => {
    await $(`location.hash = ${JSON.stringify(`#/p/${selective.id}/f/${p}`)}; true`);
    if (!(await wait(() => has(`${region}[data-path=${JSON.stringify(p)}]`), `sync folder ${p}`))) throw new Error(`Missing sync folder: ${p}`);
  };
  const choose = async (selector, mode) => {
    if (!(await wait(() => $(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); return !!n && !n.disabled; })()`), `enabled ${selector}`))) throw new Error(`Missing sync control: ${selector}`);
    await $(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); n.value = ${JSON.stringify(mode)}; n.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  };
  const entrySync = async (p) => (await ctx.files.tree(selective.id)).find((entry) => entry.path === p)?.sync;
  const expectSync = async (p, mode, source) => {
    check(`${p} is ${mode} (${source})`, await wait(async () => {
      const sync = await entrySync(p);
      return sync?.mode === mode && sync.source === source;
    }, `${p}: ${source} ${mode}`));
  };
  // A change that would take a shared file off the remote asks first; accept it and count the asks.
  const review = ".files-sync-review";
  let reviews = 0;
  const acceptReview = async () => {
    if (!(await wait(() => has(`${review} .btn-danger`), "sync review dialog"))) throw new Error("Missing sync review dialog");
    reviews++;
    await click(`${review} .btn-danger`);
    await wait(async () => !(await has(review)), "sync review closes");
  };
  try {
    // The project default lives in Sharing.
    await navigateSync("");
    await click(".files-open-sharing");
    await choose('.files-sync-settings select[aria-label="Default sync setting"]', "local");
    await acceptReview();
    check("the default setting is saved through Sharing", await wait(async () => (await ctx.files.syncPolicy(selective.id)).default === "local", "local project default"));
    await shot("files-09-sharing-default");
    await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
    await navigateSync("");
    await expectSync("private", "local", "default");
    check("the sharing card counts what stays here", await wait(async () => (await text('[data-testid="files-sharing"] .files-sync-summary'))?.includes("0 shared files · 3 local-only files"), "scope counts"));
    check("a local folder wears the monitor in the list and in the tree", await wait(async () => (await markOf(rowMark("private"))) === "local" && (await titleOf(rowMark("private"))) === "Keep local · Project default" && (await markOf('.side-file-row-container[data-file="private"] .sync-mark')) === "local", "local marks"));

    await navigateSync("private");
    await click(checkbox("private/draft.txt"));
    await click(checkbox("private/public.txt"));
    await choose(`.files-selection-bar select[aria-label="Sync setting for 2 selected"]`, "shared");
    await expectSync("private/draft.txt", "shared", "explicit");
    await expectSync("private/public.txt", "shared", "explicit");
    await expectSync("private/untouched.txt", "local", "default");
    check("bulk sharing creates rules only for the selected rows", JSON.stringify((await ctx.files.syncPolicy(selective.id)).rules.map((rule) => rule.path).sort()) === JSON.stringify(["private/draft.txt", "private/public.txt"]));
    check("a shared exception wears the cloud and says so", await wait(async () => (await markOf(rowMark("private/draft.txt"))) === "shared" && (await titleOf(rowMark("private/draft.txt"))) === "Shared · Explicit setting", "exception mark"));
    await click(".files-selection-bar .sel-clear");
    await rightClick(row("private/draft.txt"));
    await wait(() => has(".menu.is-floating"), "exception row menu");
    check("an exception's menu offers only what would change it", (await menuItemNames()) === "Cut|Copy|Keep local|Inherit from parent|Delete…");
    await clickMenuItem("Inherit from parent");
    await acceptReview();
    await expectSync("private/draft.txt", "local", "default");

    // A folder already local by default offers nothing to change in its menu; its own line can still pin the rule.
    await navigateSync("");
    await rightClick(row("private"));
    await wait(() => has(".menu.is-floating"), "sync folder context menu");
    check("a folder's menu offers only what would change it", (await menuItemNames()) === "Cut|Copy|Shared|Delete…");
    await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
    await navigateSync("private");
    // Nothing shared leaves the remote here, so nothing asks.
    await choose(`${region} .files-sync-line select`, "local");
    await expectSync("private", "local", "explicit");
    await expectSync("private/draft.txt", "local", "inherited");
    await expectSync("private/public.txt", "shared", "explicit");
    await navigateSync("");
    check("a local folder with a shared child wears the half cloud", await wait(async () => (await markOf(rowMark("private"))) === "mixed" && (await entrySync("private"))?.mixed && (await markOf('.side-file-row-container[data-file="private"] .sync-mark')) === "mixed", "mixed folder mark"));
    await navigateSync("private");
    check("the folder's own line says where it stands", await wait(async () => (await text(`${region} .files-sync-line .meta-txt`)) === "Keep local · Explicit setting · Mixed", "folder sync line"));
    check("a child's mark names the parent it inherits from", await wait(async () => (await titleOf(rowMark("private/draft.txt"))) === "Keep local · Inherited from private", "inherited mark"));
    check("only the changes that take something off the remote asked first", reviews === 2);
    await shot("files-10-sync-folder");

    // Publish into a subdirectory of the existing remote. Compare tree objects
    // outside it as well as scoped names, so unintended sibling edits fail.
    const remoteTree = () => execFileSync("git", ["--git-dir", remote, "ls-tree", "-r", "main"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const outsideBefore = remoteTree();
    const scoped = await ctx.files.bind(selective.id, "folder", { path: remote, directory: "selected-files" });
    check("selected sharing syncs into the configured remote directory", scoped.state === "synced");
    const published = remoteTree().map((line) => line.split("\t")[1]);
    const scopedFiles = published.filter((p) => p.startsWith("selected-files/") && !p.startsWith("selected-files/.tomrade-files/"));
    check("the scoped remote holds only the shared child exception", JSON.stringify(scopedFiles) === JSON.stringify(["selected-files/private/public.txt"]));
    const publicFile = await ctx.files.read(selective.id, "private/public.txt");
    check("the shared file's version travels as its own blob and a record", published.includes(`selected-files/.tomrade-files/versions/${publicFile.fileId}/${publicFile.versionId}`) && published.includes(`selected-files/.tomrade-files/versions/${publicFile.fileId}/${publicFile.versionId}.json`) && !published.some((p) => p.includes("draft.txt") || p.includes("untouched.txt")));
    check("scoped sharing preserves every remote sibling and its content", JSON.stringify(remoteTree().filter((line) => !line.split("\t")[1].startsWith("selected-files/"))) === JSON.stringify(outsideBefore));
    check("the shared exception publishes the selected content", execFileSync("git", ["--git-dir", remote, "show", "main:selected-files/private/public.txt"], { encoding: "utf8" }) === "shared exception\n");
    check("local-only content and identity survive scoped sync", (await ctx.files.read(selective.id, "private/draft.txt"))?.body === "local second draft\n" && (await ctx.files.read(selective.id, "private/draft.txt"))?.fileId === localFirst.fileId);

    await navigateSync("private/draft.txt");
    check("local-only files retain both versions in the viewer", await wait(async () => (await count(`${region} .version-row`)) === 2 && (await has(`${region} .version-row[data-version="${localFirst.versionId}"]`)) && (await has(`${region} .version-row[data-version="${localLatest.versionId}"]`)), "retained local versions"));
    await click(`${region} .version-row[data-version="${localFirst.versionId}"]`);
    check("a retained local-only version opens its original body", await wait(async () => (await text(`${region} .text-view`)) === "local first draft\n" && (await has(`${region} .files-version-banner`)), "local first version"));
    await click(`${region} .files-version-banner .btn`);
    check("returning to latest keeps the local-only second draft", await wait(async () => (await text(`${region} .text-view`)) === "local second draft\n", "local latest version"));
    await shot("files-11-local-versions");
  } finally {
    // A dialog left open by a failed step must not swallow the checks after it.
    await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  }
  return results;
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
