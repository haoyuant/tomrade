/**
 * Checkout follows the remote: Project settings › Repositories has a switch per checkout, on by default, and while it
 * is on a scan's fetch fast-forwards the checkout's default branch; off, the checkout stays where the person left it.
 * A repository with no remote has nothing to follow, and no switch.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:pull-default
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
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pull-default-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};
const sh = (command, cwd) => execSync(command, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const AS = "-c user.email=dev@localhost -c user.name=Dev";

const run = async () => {
  const { ctx } = await boot({ configFile: path.join(dir, "../tomrade.yml"), vars: { userData: work }, patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]] });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  await ctx.storage.ready;
  // A project that already knows its code: no agent of the machine's is started to read the repository.
  ctx.agent.store.setBrief(project.id, "App: a small web app.");
  ctx.settings.set({ ...ctx.settings.get(), language: "en", onboarding: { seen: ["*"] } });
  const board = ctx.boards.list(project.id)[0];

  // A remote, the person's checkout of it, and a second clone that stands for everyone else.
  const remote = path.join(work, "code", "app.git");
  fs.mkdirSync(remote, { recursive: true });
  sh("git init -q --bare -b main .", remote);
  const other = path.join(work, "code", "other");
  sh(`git clone -q "${remote}" "${other}"`, work);
  fs.writeFileSync(path.join(other, "app.ts"), "export const v = 1;\n");
  fs.writeFileSync(path.join(other, "CLAUDE.md"), "# App\n");
  sh(`git add -A && git ${AS} commit -q -m start && git push -q origin HEAD:refs/heads/main`, other);
  const checkout = path.join(work, "code", "app");
  sh(`git clone -q "${remote}" "${checkout}"`, work);
  const land = (text) => {
    fs.writeFileSync(path.join(other, "app.ts"), text);
    return sh(`git ${AS} commit -q -am more && git push -q origin HEAD:refs/heads/main && git rev-parse HEAD`, other);
  };
  const head = () => sh("git rev-parse main", checkout);
  const repo = ctx.repos.create({ projectId: project.id, remote });
  await ctx.repos.setCheckout(remote, checkout);
  ctx.boards.update(project.id, board.id, { repoId: repo.id, repoPath: "" });

  // A repository with no remote: nothing to follow.
  const localDir = path.join(work, "code", "local");
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(path.join(localDir, "package.json"), JSON.stringify({ name: "local", version: "0.0.0" }));
  sh(`git init -q -b main && git add -A && git ${AS} commit -q -m start`, localDir);
  const local = ctx.repos.create({ projectId: project.id, remote: localDir });
  await ctx.repos.setCheckout(localDir, localDir);
  await ctx.codeLink.scan(project.id);

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

  await press(`[...document.querySelectorAll('.side-name')].find((n) => n.textContent?.trim() === 'Project settings')?.closest('button,a')`);
  await sleep(600);
  await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find((b) => b.textContent?.trim() === 'Repositories')`);
  const toggle = `document.querySelector('[data-repo="${repo.id}"] .repo-pull-default')`;
  const checked = () => $(`${toggle}?.getAttribute('aria-checked') ?? null`);
  check("a checkout with a remote has the switch, named for its default branch, on by default", (await wait(async () => (await checked()) === "true")) && (await $(`${toggle}.getAttribute('aria-label')`)) === "Keep main in my checkout up to date", await checked());
  check("with what it does, and when it leaves the checkout alone, in words under it", await $(`[...document.querySelectorAll('[data-repo="${repo.id}"] p')].some((p) => p.textContent.includes("is fast-forwarded to the remote's") && p.textContent.includes("no uncommitted changes"))`));
  check("a repository with no remote has no such switch", await wait(() => $(`!!document.querySelector('[data-repo="${local.id}"] .repo-run-in') && !document.querySelector('[data-repo="${local.id}"] .repo-pull-default')`)), await $(`document.querySelector('[data-repo="${local.id}"]')?.textContent ?? null`));
  await $(`${toggle}?.scrollIntoView({ block: "center" });true`);
  await sleep(300);
  await shot("pull-default-01-on");

  const first = land("export const v = 2;\n");
  await ctx.codeLink.scan(project.id);
  check("on: after a scan's fetch the checkout's main is at the remote's, files and all", head() === first && fs.readFileSync(path.join(checkout, "app.ts"), "utf8") === "export const v = 2;\n", head());

  await press(toggle);
  check("pressing it turns it off, on this machine", (await wait(async () => (await checked()) === "false")) && ctx.repos.checkout(remote).pullDefault === false, await checked());
  await shot("pull-default-02-off");
  const second = land("export const v = 3;\n");
  await ctx.codeLink.scan(project.id);
  check("off: the fetch still happens, and the checkout stays where it was", sh("git rev-parse origin/main", checkout) === second && head() === first && fs.readFileSync(path.join(checkout, "app.ts"), "utf8") === "export const v = 2;\n", head());

  await press(toggle);
  await wait(async () => (await checked()) === "true");
  await ctx.codeLink.scan(project.id);
  check("on again: the next scan brings it up to date", ctx.repos.checkout(remote).pullDefault === true && head() === second, head());

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
