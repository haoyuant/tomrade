/**
 * A read that fails is not a deletion: when a project's views or its issues
 * cannot be read, the screen says so and offers Try again, and stays where it
 * is — it never goes home saying the project was deleted. A domain refusal
 * still names its class across IPC, so the renderer can say it in words.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:load-error
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-load-error-"));
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
  ctx.settings.set({ ...ctx.settings.get(), language: "en", onboarding: { seen: ["*"] } });
  const item = ctx.items.create({ projectId: project.id, boardId: ctx.boards.list(project.id)[0].id, title: "Fix the login page", status: "todo", by: "human" });
  await ctx.storage.ready;
  const view = ctx.views.listForProject(project.id)[0];

  // The channels read through these at call time, so a failing disk can be switched on and off.
  const failing = { views: false, items: false };
  const listViews = ctx.views.listForProject.bind(ctx.views);
  ctx.views.listForProject = (...args) => {
    if (failing.views) throw new Error("SQLITE_IOERR: disk I/O error");
    return listViews(...args);
  };
  const listItems = ctx.items.list.bind(ctx.items);
  ctx.items.list = (...args) => {
    if (failing.items) throw new Error("SQLITE_IOERR: disk I/O error");
    return listItems(...args);
  };

  const win = new BrowserWindow({ width: 1400, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const waitFor = async (js, ms = 15000) => {
    for (let waited = 0; waited < ms; waited += 200) {
      if (await $(js)) return true;
      await sleep(200);
    }
    return false;
  };
  const shot = async (name) => fs.writeFileSync(path.join(process.env.TOMRADE_SHOTS ?? work, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const tryAgain = `[...document.querySelectorAll('[role="alert"] button')].find((b) => b.textContent.trim() === 'Try again')`;

  // ── the views cannot be read ──────────────────────────────────────────
  failing.views = true;
  const viewHash = `#/p/${project.id}/v/${view.id}`;
  await win.loadURL(`${base}${viewHash}`);
  check("a failed views read shows that it failed", await waitFor(`!!document.querySelector('[data-testid="workspace-read-failed"]')`), await $(`document.body.innerText.slice(0, 300)`));
  await shot("load-error-views");
  check("and stays on the view, never going home", (await $("location.hash")) === viewHash, await $("location.hash"));
  check("without saying the project was deleted", !(await $(`document.body.innerText.includes('That project has been deleted')`)), await $(`document.body.innerText.slice(0, 300)`));
  check("the error is said without the IPC wrapper", (await $(`document.querySelector('[data-testid="workspace-read-failed"] code')?.textContent`)) === "SQLITE_IOERR: disk I/O error", await $(`document.querySelector('[data-testid="workspace-read-failed"] code')?.textContent`));
  check("it offers Try again", !!(await $(`!!${tryAgain}`)));

  failing.views = false;
  await $(`${tryAgain}.click(); true`);
  check("Try again opens the view once the read works", await waitFor(`!!document.querySelector('.board-region')`), await $(`document.body.innerText.slice(0, 300)`));
  check("on the same place", (await $("location.hash")) === viewHash, await $("location.hash"));

  // ── the issues cannot be read ─────────────────────────────────────────
  failing.items = true;
  const issueHash = `#/p/${project.id}/i/${item.id}`;
  // A fresh page, so nothing read before is cached.
  await win.loadURL("about:blank");
  await win.loadURL(`${base}${issueHash}`);
  check("a failed issues read on a ticket's page shows that it failed", await waitFor(`!!document.querySelector('[data-testid="issue-read-failed"]')`), await $(`document.body.innerText.slice(0, 300)`));
  await shot("load-error-issue");
  check("not that the issue is not in the project", !(await $(`document.body.innerText.includes('not in this project')`)));
  failing.items = false;
  await $(`${tryAgain}.click(); true`);
  check("Try again shows the ticket once the read works", await waitFor(`document.body.innerText.includes('Fix the login page')`), await $(`document.body.innerText.slice(0, 300)`));

  // ── a domain refusal keeps its class name across IPC ──────────────────
  const refused = await $(`window.tomrade.invoke('items.update', ${JSON.stringify(project.id)}, ${JSON.stringify(item.id)}, { title: 'Stale' }, 0).then(() => null, (e) => e.message)`);
  check("a stale write arrives as a ConflictError the renderer can name", /^Error invoking remote method 'tomrade:items\.update': ConflictError: /.test(refused ?? ""), refused);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
};

app.whenReady().then(() => run().catch((error) => { console.error(error); app.exit(1); }));
