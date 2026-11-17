/**
 * Worktree cleanup regression: under a repository in Project settings the worktrees Tomrade made on this machine are
 * listed with whose each is, what it takes on disk and why it is still there, and "Remove finished" takes the ones of
 * finished tickets that hold nothing — never one with uncommitted work, never an open ticket's. A folder git no longer
 * knows is listed and counted too, and goes only on its own row, after it is asked.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:worktree-cleanup
 */
import { app, BrowserWindow } from "electron";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(dir, "shots");
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-worktree-cleanup-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  await ctx.storage.ready;
  // A project that already knows its code: no agent of the machine's is started to read the repository.
  ctx.agent.store.setBrief(project.id, "App: a small web app.");
  // One commit per ticket, and what an install leaves: ignored by git, and most of what a worktree weighs.
  ctx.agent.engine({
    id: "fake-code", title: "Fake coder", author: "ai:fake-code", capabilities: ["code"], available: async () => ({ ok: true }),
    async turn(input) {
      if (input.cwd) {
        fs.writeFileSync(path.join(input.cwd, `${input.ticket?.key ?? "work"}.ts`), "export {};\n");
        fs.mkdirSync(path.join(input.cwd, "node_modules", "dep"), { recursive: true });
        fs.writeFileSync(path.join(input.cwd, "node_modules", "dep", "index.js"), "x".repeat(3 * 1024 * 1024));
        execSync(`git add -A && git -c user.email=dev@localhost -c user.name=Dev commit -q -m "${input.ticket?.key ?? "work"}: work"`, { cwd: input.cwd, stdio: "ignore" });
      }
      return { stop: "end" };
    }
  });
  ctx.settings.set({ ...ctx.settings.get(), language: "en", onboarding: { seen: ["*"] } });
  const board = ctx.boards.list(project.id)[0];

  const repoDir = path.join(work, "code", "app");
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "app", version: "0.0.0" }));
  fs.writeFileSync(path.join(repoDir, "CLAUDE.md"), "# App\n");
  fs.writeFileSync(path.join(repoDir, ".gitignore"), "node_modules/\n");
  execSync("git init -q -b main && git add -A && git -c user.email=dev@localhost -c user.name=Dev commit -q -m start", { cwd: repoDir, stdio: "ignore" });
  const repo = ctx.repos.create({ projectId: project.id, remote: repoDir });
  await ctx.repos.setCheckout(repoDir, repoDir);
  ctx.boards.update(project.id, board.id, { repoId: repo.id, repoPath: "" });

  // A second repository nothing was ever started in.
  const quietDir = path.join(work, "code", "quiet");
  fs.mkdirSync(quietDir, { recursive: true });
  fs.writeFileSync(path.join(quietDir, "package.json"), JSON.stringify({ name: "quiet", version: "0.0.0" }));
  execSync("git init -q -b main && git add -A && git -c user.email=dev@localhost -c user.name=Dev commit -q -m start", { cwd: quietDir, stdio: "ignore" });
  const quiet = ctx.repos.create({ projectId: project.id, remote: quietDir });
  await ctx.repos.setCheckout(quietDir, quietDir);

  const worked = async (title) => {
    const item = ctx.items.create({ projectId: project.id, boardId: board.id, title, workType: "coding", status: "todo", by: "human" });
    const started = await ctx.codeLink.start(project.id, item.id, { mode: "run", engine: "fake-code" });
    if (!started.ok) throw new Error(`start refused: ${started.message}`);
    for (let i = 0; i < 100 && ctx.agent.activeRuns().length; i++) await sleep(100);
    return { item, worktree: started.worktree };
  };
  const merged = await worked("Add login");
  const scratch = await worked("Add logout");
  const open = await worked("Fix typo");
  fs.writeFileSync(path.join(scratch.worktree, "notes.txt"), "half done\n");
  ctx.items.update(project.id, merged.item.id, { status: "done" }, "human");
  ctx.items.update(project.id, scratch.item.id, { status: "done" }, "human");
  check("each ticket got a worktree of its own", [merged, scratch, open].every((each) => fs.existsSync(each.worktree)));
  check("Settings has the cleanup, on and keeping a day", JSON.stringify(ctx.settings.value("worktrees")) === JSON.stringify({ enabled: true, keepDays: 1 }), ctx.settings.value("worktrees"));

  const win = new BrowserWindow({ width: 1500, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const shot = async (name) => fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const wait = async (cond, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      if (await cond()) return true;
      await sleep(150);
    }
    return false;
  };
  await sleep(2500);

  // ── Settings › Worktrees: every project's, added up ───────────────────
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));true`);
  await wait(() => $(`!!document.querySelector('.sheet-settings')`));
  await press(`[...document.querySelectorAll('.sheet-settings .dlg-nav .side-row')].find((b) => b.textContent?.trim() === 'Worktrees')`);
  const over = `document.querySelector('[data-testid="worktree-overview"]')`;
  const kpi = (id) => $(`${over}?.querySelector('[data-kpi="${id}"]')?.textContent ?? ''`);
  check("Settings has a Worktrees pane that counts them across repositories", await wait(async () => (await kpi("count")).includes("3") && (await kpi("count")).includes("Repositories: 1")), await kpi("count"));
  check("it says what they take, once each is measured, as a share of the disk", await wait(async () => /They take\d+(\.\d)? MB.*of this disk/.test(await kpi("taken")), 80), await kpi("taken"));
  check("how much of that can go now", await wait(async () => /Can be removed now\d+(\.\d)? MBWorktrees nothing holds: 1/.test(await kpi("free"))), await kpi("free"));
  check("and what the disk has left", /Free on this disk\d+(\.\d)? (GB|MB)of \d/.test(await kpi("disk")), await kpi("disk"));
  check("the space is split by whether each can go: one free, one held, one in use", (await $(`[...${over}.querySelectorAll('[data-bar="split"] .usage-share-seg')].map((seg) => seg.dataset.bucket).join()`)) === "free,held,open");
  check("each part is named with its count and size", await $(`[...${over}.querySelectorAll('.usage-engine-key[data-bucket]')].every((key) => /1 · [0-9.]+ MB/.test(key.textContent))`));
  check("the disk's own bar shows the worktrees in it", await $(`!!${over}.querySelector('[data-bar="disk"] .usage-share-seg')`));
  check("and the repository that holds them is listed", (await $(`${over}.querySelector('.worktree-repos [data-repo="${repo.id}"]')?.textContent ?? ''`)).includes("app"));
  await press(`${over}.querySelector('.worktree-repos [data-repo="${repo.id}"] .fold-chev')`);
  const repoTrees = () => $(`[...${over}.querySelectorAll('.worktree-repos [data-repo="${repo.id}"] .worktree-repo-trees .repo-worktree')].map((row) => ({ hold: row.dataset.hold, size: row.querySelector('.repo-worktree-size')?.textContent ?? '' }))`);
  check("a repository unfolds into its worktrees, what can go first, each with what it takes", await wait(async () => { const rows = await repoTrees(); return rows.length === 3 && rows[0].hold === "none" && rows.every((row) => /^[0-9.]+ MB$/.test(row.size)); }), await repoTrees());
  check("the one that can go is named, with its repository, and can be removed right there", (await $(`[...${over}.querySelectorAll('.worktree-free-list .repo-worktree')].map((row) => row.textContent).join('|')`)).includes(merged.item.key) && (await $(`${over}.querySelectorAll('.worktree-free-list .repo-worktree').length === 1 && !!${over}.querySelector('.worktree-free-list .repo-worktree-remove') && ${over}.querySelector('.worktree-free-list .repo-worktree-state').textContent.startsWith('app · Alpha · ')`)), await $(`${over}.querySelector('.worktree-free-list')?.textContent ?? null`));
  check("below it, when a finished ticket's is removed", await $(`[...document.querySelectorAll('.sheet-settings label, .sheet-settings .field-label, .sheet-settings *')].some((n) => n.childElementCount === 0 && n.textContent === "Remove a finished ticket's worktree")`));
  await shot("worktree-cleanup-00-settings");
  await $(`${over}.querySelector('.worktree-repos')?.scrollIntoView({ block: "start" });true`);
  await sleep(300);
  await shot("worktree-cleanup-00-settings-repositories");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  await wait(async () => !(await $(`!!document.querySelector('.sheet-settings')`)));

  await press(`[...document.querySelectorAll('.side-name')].find((n) => n.textContent?.trim() === 'Project settings')?.closest('button,a')`);
  await sleep(600);
  await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find((b) => b.textContent?.trim() === 'Repositories')`);
  const head = `document.querySelector('[data-repo="${repo.id}"] [data-testid="repo-worktrees"]')`;
  const headText = () => $(`${head}?.textContent ?? ''`);
  check("the repository says how many worktrees are on this computer", (await ctx.codeLink.worktreesOf(project.id)).length === 3 && (await wait(async () => (await headText()).includes("Worktrees on this computer: 3"))), await headText());
  check("and how many of them a finished ticket left", (await headText()).includes("1 can be removed"), await headText());

  const quietHead = `document.querySelector('[data-repo="${quiet.id}"] [data-testid="repo-worktrees"]')`;
  check("a repository with none says so, with nothing to unfold or remove", await wait(() => $(`${quietHead}?.querySelector('.cfg-name')?.textContent === 'No worktrees on this computer' && !${quietHead}.querySelector('.fold-chev') && !${quietHead}.querySelector('.repo-worktrees-clear')`)), await $(`${quietHead}?.textContent ?? null`));

  await press(`${head}.querySelector('.fold-chev')`);
  const rows = () => $(`[...document.querySelectorAll('[data-repo="${repo.id}"] .repo-worktree')].map((row) => ({ hold: row.dataset.hold, text: row.textContent, size: row.querySelector('.repo-worktree-size')?.textContent ?? '', removable: !!row.querySelector('.repo-worktree-remove') }))`);
  const row = async (key) => (await rows()).find((each) => each.text.includes(key));
  check("unfolded, each worktree is a row", await wait(async () => (await rows()).length === 3), await rows());
  check("a finished ticket's says when it goes by itself, and can go now", await wait(async () => { const r = await row(merged.item.key); return r?.hold === "none" && r.text.includes("Removed by itself after") && r.removable; }), await row(merged.item.key));
  check("one with files git does not have says so, and offers no Remove", await wait(async () => { const r = await row(scratch.item.key); return r?.hold === "dirty" && r.text.includes("Has uncommitted or untracked files") && !r.removable; }), await row(scratch.item.key));
  check("an open ticket's says so, and offers no Remove", await wait(async () => { const r = await row(open.item.key); return r?.hold === "open" && r.text.includes("Its ticket is still open") && !r.removable; }), await row(open.item.key));
  check("each says what it takes on disk, the install counted", await wait(async () => (await rows()).every((each) => /^\d+(\.\d)? MB$/.test(each.size)), 80), (await rows()).map((each) => each.size));
  check("and the repository adds them up", await wait(async () => /· \d+(\.\d)? MB/.test(await headText())), await headText());
  await $(`${head}?.scrollIntoView({ block: "start" });true`);
  await sleep(300);
  await shot("worktree-cleanup-01-listed");

  await press(`${head}.querySelector('.repo-worktrees-clear')`);
  check("Remove finished takes the finished ticket's worktree", await wait(() => !fs.existsSync(merged.worktree), 80));
  check("its branch stays in the checkout", execSync("git branch --list", { cwd: repoDir, encoding: "utf8" }).split("\n").filter((line) => line.trim()).length === 4);
  check("the one with uncommitted work and the open ticket's stay", fs.existsSync(scratch.worktree) && fs.existsSync(open.worktree));
  check("the list follows", await wait(async () => (await rows()).length === 2 && (await headText()).includes("Worktrees on this computer: 2")), await headText());
  check("with nothing finished left, the button rests", await wait(() => $(`${head}.querySelector('.repo-worktrees-clear')?.disabled === true`)));
  await shot("worktree-cleanup-02-removed");

  // What held it is gone: it is finished like the other, and one press takes it.
  fs.rmSync(path.join(scratch.worktree, "notes.txt"));
  ctx.codeLink.sweepWorktrees();
  await win.webContents.reload();
  await sleep(2500);
  await press(`[...document.querySelectorAll('.side-name')].find((n) => n.textContent?.trim() === 'Project settings')?.closest('button,a')`);
  await sleep(600);
  await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find((b) => b.textContent?.trim() === 'Repositories')`);
  await wait(async () => (await headText()).includes("1 can be removed"));
  await press(`${head}.querySelector('.fold-chev')`);
  await wait(async () => (await rows()).length === 2);
  await press(`[...document.querySelectorAll('[data-repo="${repo.id}"] .repo-worktree')].find((each) => each.textContent.includes(${JSON.stringify(scratch.item.key)}))?.querySelector('.repo-worktree-remove')`);
  check("a row's own Remove takes that one", await wait(() => !fs.existsSync(scratch.worktree), 80));
  check("the open ticket's worktree is still there", fs.existsSync(open.worktree));

  // ── A folder git no longer knows: its repository was moved or deleted ──
  const stray = path.join(path.dirname(open.worktree), "left-over");
  fs.mkdirSync(stray);
  fs.writeFileSync(path.join(stray, ".git"), `gitdir: ${path.join(work, "code", "moved-away", ".git", "worktrees", "left-over")}\n`);
  fs.writeFileSync(path.join(stray, "big.bin"), "x".repeat(2 * 1024 * 1024));
  await win.webContents.reload();
  await sleep(2500);
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true, bubbles: true }));true`);
  await wait(() => $(`!!document.querySelector('.sheet-settings')`));
  await press(`[...document.querySelectorAll('.sheet-settings .dlg-nav .side-row')].find((b) => b.textContent?.trim() === 'Worktrees')`);
  check("Settings counts the folder git no longer knows", await wait(async () => (await kpi("count")).includes("2")), await kpi("count"));
  check("as space of its own, not as something that can go", await wait(async () => (await $(`[...${over}.querySelectorAll('[data-bar="split"] .usage-share-seg')].map((seg) => seg.dataset.bucket).join()`)) === "open,stray" && /Left behind1 · [0-9.]+ MB/.test(await $(`${over}.querySelector('.usage-engine-key[data-bucket="stray"]')?.textContent ?? ''`)), 80), await $(`${over}.querySelector('[data-legend="split"]')?.textContent ?? null`));
  check("nothing is offered to remove in one press", (await kpi("free")).includes("Worktrees nothing holds: 0") && (await $(`${over}.querySelector('.worktree-overview-clear')?.disabled === true && !${over}.querySelector('.worktree-free-list')`)), await kpi("free"));
  await shot("worktree-cleanup-03-stray-settings");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  await wait(async () => !(await $(`!!document.querySelector('.sheet-settings')`)));

  await press(`[...document.querySelectorAll('.side-name')].find((n) => n.textContent?.trim() === 'Project settings')?.closest('button,a')`);
  await sleep(600);
  await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find((b) => b.textContent?.trim() === 'Repositories')`);
  check("the repository lists it with its worktrees, and none that can go", await wait(async () => (await headText()).includes("Worktrees on this computer: 2") && (await headText()).includes("0 can be removed")), await headText());
  await press(`${head}.querySelector('.fold-chev')`);
  const strayRow = `document.querySelector('[data-repo="${repo.id}"] .repo-worktree[data-stray]')`;
  const strayText = () => $(`${strayRow}?.textContent ?? ''`);
  check("its row says git no longer knows it, and that it goes only by hand", await wait(async () => (await strayText()).includes("Left behind: git no longer knows this folder · Removed only by hand")), await strayText());
  check("with what it takes on disk", await wait(async () => /^[0-9.]+ MB$/.test(await $(`${strayRow}?.querySelector('.repo-worktree-size')?.textContent ?? ''`)), 80), await strayText());
  check("Remove finished does not take it", await $(`${head}.querySelector('.repo-worktrees-clear')?.disabled === true`));
  await $(`${head}?.scrollIntoView({ block: "start" });true`);
  await sleep(300);
  await shot("worktree-cleanup-04-stray-listed");
  await press(`${strayRow}.querySelector('.repo-worktree-remove')`);
  const asked = () => $(`document.querySelector('[data-testid="confirm-body"]')?.textContent ?? ''`);
  check("its own Remove asks first, saying git cannot check it and naming the folder", (await wait(async () => (await asked()).includes("Git no longer knows this folder") && (await asked()).includes(stray))) && fs.existsSync(stray), await asked());
  await shot("worktree-cleanup-05-stray-asked");
  await press(`document.querySelector('[data-testid="confirm-yes"]')`);
  check("and on yes the folder is deleted", await wait(() => !fs.existsSync(stray), 80));
  check("the open ticket's worktree beside it stays", fs.existsSync(open.worktree) && (await wait(async () => (await headText()).includes("Worktrees on this computer: 1"))), await headText());

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
