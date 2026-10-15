/**
 * Repository setup regression: whatever stops a Start is fixed from where it
 * is said — a workstream with no repository is connected right in the Start
 * dialog (to a repository the project has, or to a folder chosen there), a
 * locked ticket is unlocked there — and a repository's workstreams are picked
 * under it in Project settings.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:repo-setup
 */
import { app, BrowserWindow, dialog } from "electron";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(dir, "shots");
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-repo-setup-"));
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
  ctx.agent.engine({ id: "fake-code", title: "Fake coder", author: "ai:fake-code", capabilities: ["code"], available: async () => ({ ok: true }), async turn() { return { stop: "end" }; } });
  const settings = ctx.settings.get();
  ctx.settings.set({ ...settings, language: "en", onboarding: { seen: ["*"] } });
  const board = ctx.boards.list(project.id)[0];
  const ticket = (title, extra = {}) => ctx.items.create({ projectId: project.id, boardId: board.id, title, workType: "coding", status: "todo", by: "human", ...extra });

  // a repository folder with no remote: it is its own checkout
  const repoDir = path.join(work, "code", "app");
  fs.mkdirSync(repoDir, { recursive: true });
  // something in it, so it is ready to work on rather than waiting for a bootstrap ticket
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "app", version: "0.0.0" }));
  fs.writeFileSync(path.join(repoDir, "CLAUDE.md"), "# App\n");
  execSync("git init -q -b main && git add -A && git -c user.email=dev@localhost -c user.name=Dev commit -q -m start", { cwd: repoDir, stdio: "ignore" });
  const showOpenDialog = dialog.showOpenDialog;
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repoDir] });

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
  const problem = () => $(`document.querySelector('[data-testid="start-error"]')?.textContent ?? ''`);
  const threadsOf = (item) => ctx.agent.store.threadsForItem(project.id, item.id);
  const startFor = async (item) => {
    await $(`location.hash = '#/p/${project.id}/i/${item.id}';true`);
    await wait(() => $(`!!document.querySelector('[data-testid="start-ticket"]')`));
    await press(`document.querySelector('[data-testid="start-ticket"]')`);
    await wait(() => $(`!!document.querySelector('[data-testid="start-dialog"]')`));
    await $(`(() => { const s = document.querySelector('#stEngine'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'fake-code'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(200);
    await press(`document.querySelector('[data-testid="start-confirm"]')`);
  };
  await sleep(2500);

  // ── no repository at all: one from a folder, chosen right in the dialog ──
  const first = ticket("Add login");
  await startFor(first);
  check("Start says the workstream has no repository, in plain words", await wait(async () => (await problem()).includes(`The workstream “${board.name}” is not connected to a code repository yet.`)), await problem());
  check("and offers to choose the repository's folder there", (await $(`!!document.querySelector('[data-testid="gate-add-folder"]')`)) === true);
  await shot("repo-setup-01-no-repository");
  await press(`document.querySelector('[data-testid="gate-add-folder"]')`);
  check("choosing it adds the repository, connects the workstream and starts", await wait(() => threadsOf(first).length > 0, 80), { board: ctx.boards.get(project.id, board.id), repos: ctx.repos.list(project.id) });
  const repo = ctx.repos.list(project.id)[0];
  check("the workstream now stands on it", ctx.boards.get(project.id, board.id).repoId === repo?.id);
  check("and the dialog is gone", await wait(async () => !(await $(`!!document.querySelector('[data-testid="start-dialog"]')`))));

  // ── a repository the project has, not connected: picked in the dialog ──
  ctx.boards.update(project.id, board.id, { repoId: null, repoPath: "" });
  const second = ticket("Add logout");
  await startFor(second);
  check("with a repository on hand, the dialog offers it", await wait(async () => (await $(`document.querySelector('[data-testid="gate-repo"]')?.value`)) === repo.id));
  await press(`document.querySelector('[data-testid="gate-connect"]')`);
  check("Connect and start does both", await wait(() => threadsOf(second).length > 0, 80) && ctx.boards.get(project.id, board.id).repoId === repo.id);

  // ── a locked ticket: unlocked there ───────────────────────────────────
  ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
  await sleep(400);
  const third = ctx.items.update(project.id, ticket("Fix typo").id, { humanLocked: true }, "human");
  await startFor(third);
  check("a locked ticket says so, in the person's language", await wait(async () => (await problem()).includes(`${third.key} 已锁定`)), await problem());
  await press(`document.querySelector('[data-testid="gate-unlock"]')`);
  check("Unlock and start does both", await wait(() => threadsOf(third).length > 0, 80) && ctx.items.get(project.id, third.id).humanLocked === false);
  ctx.settings.set({ ...ctx.settings.get(), language: "en" });
  await sleep(400);

  // ── under the repository in Project settings, its workstreams ─────────
  await $(`location.hash = '#/p/${project.id}';true`);
  await sleep(1200);
  await press(`[...document.querySelectorAll('.side-name')].find((n) => n.textContent?.trim() === 'Project settings')?.closest('button,a')`);
  await sleep(600);
  await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find((b) => b.textContent?.trim() === 'Repositories')`);
  await sleep(600);
  const chip = `document.querySelector('[data-repo="${repo.id}"] .repo-workstreams [data-board="${board.id}"]')`;
  check("the repository lists the workstreams, its own ones picked", (await $(`${chip}?.getAttribute('aria-pressed')`)) === "true");
  await shot("repo-setup-02-workstreams");
  await press(chip);
  check("one click disconnects a workstream", await wait(() => ctx.boards.get(project.id, board.id).repoId === null));
  check("and the repository says what to pick", await wait(async () => ((await $(`document.querySelector('[data-repo="${repo.id}"] .repo-used')?.textContent ?? ''`)) ?? "").includes("Pick the workstreams")));
  await press(chip);
  check("another connects it again", await wait(() => ctx.boards.get(project.id, board.id).repoId === repo.id));

  dialog.showOpenDialog = showOpenDialog;
  // Connect directly from this repository row; there is no selected ticket here.
  await wait(() => $(`!!document.querySelector('[data-repo="${repo.id}"] .repo-agent-connect')`));
  check("repository shows agent connection and target instance", await $(`document.querySelector('[data-repo="${repo.id}"] .repo-agent-connection')?.textContent.includes('development build')`));
  await press(`document.querySelector('[data-repo="${repo.id}"] .repo-agent-connect')`);
  check("connect reports how to finish a local repository", await wait(() => $(`document.querySelector('[data-repo="${repo.id}"] .repo-agent-result')?.textContent.includes('merge it into main locally')`), 100));
  check("connection waits for merge", await wait(() => $(`document.querySelector('[data-repo="${repo.id}"] .repo-agent-connection')?.dataset.state === 'pending'`)));
  execSync("git merge --ff-only tomrade/connect", { cwd: repoDir, stdio: "ignore" });
  check("merged configuration becomes connected", await wait(() => $(`document.querySelector('[data-repo="${repo.id}"] .repo-agent-connection')?.dataset.state === 'connected'`), 100));
  check("connected repository no longer asks to connect", !(await $(`!!document.querySelector('[data-repo="${repo.id}"] .repo-agent-connect')`)));
  await shot("repo-setup-03-agents-connected");

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
