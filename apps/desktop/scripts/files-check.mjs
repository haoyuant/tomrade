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
    apply: (c) => void c.files.register(createGitBackend({ id: "folder", title: "A folder", configSchema: z.object({ path: z.string() }), defaults: { path: "" }, describe: (cfg) => cfg.path, remote: (cfg) => ({ url: cfg.path, branch: "main" }) }))
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

  // ── the viewer ───────────────────────────────────────────────────────
  await click('.side-row.is-file[data-file="docs/brief.md"]');
  await wait(() => has('[data-testid="files-region"][data-path="docs/brief.md"]'), "file screen");
  check("opening a file takes the board's place and marks the row current", (await $(`document.querySelector('.side-row.is-file[data-file="docs/brief.md"]')?.getAttribute('aria-current')`)) === "true");
  check("no view row reads as current while a file is open", (await count('.side-row.is-view[aria-current="true"]')) === 0);
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
  check("html is shown in a frame with no script or origin", (await $(`document.querySelector('.html-view')?.getAttribute('sandbox')`)) === "" && (await $(`document.title`)) !== "x");
  await shot("files-02-html");
  await $(`location.hash = '#/p/${project.id}/f/docs/notes.txt'; true`);
  await wait(() => has(".text-view"), "text view");
  check("plain text is shown as text", (await text(".text-view")) === "plain notes\n");

  // ── folders and the root ─────────────────────────────────────────────
  await $(`location.hash = '#/p/${project.id}/f/'; true`);
  await wait(() => has('[data-testid="files-sharing"]'), "root");
  check("the root lists folders and says how the files are shared", (await count('[data-testid="file-table"] .file-row')) === 2 && (await text('[data-testid="files-sharing"] .tag')) === "This machine");
  await shot("files-03-root");

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
  check("the picker offers the project's files", (await count(".file-picker-list .menu-row")) === 3);
  await click('.file-picker-list .menu-row[data-file="docs/brief.md"]');
  await wait(() => has(".file-ref"), "resource link");
  const pinnedItem = ctx.items.get(project.id, ticket.id);
  check("picking a file pins its latest version to the ticket", pinnedItem.evidence.resources[0]?.file.versionId === second.versionId && pinnedItem.evidence.resources[0]?.file.fileId === brief.fileId);
  await shot("files-06-delivery");
  await ctx.files.write(project.id, "docs/brief.md", "# The brief\n\nThird draft.\n");
  await click(".file-ref");
  await wait(() => has('[data-testid="pinned-banner"]'), "pinned version");
  check("the artifact opens the version it pinned, not the head", (await $(`document.querySelector('.md-view')?.textContent ?? ''`)).includes("Second draft"));
  check("and offers the current file", (await has('[data-testid="pinned-banner"] .btn')) === true);
  await shot("files-07-pinned");

  other.close();
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
