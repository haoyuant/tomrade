/**
 * Roles regression: a project's roles are read and written in Project settings (two built in, the rest its own), and
 * the Start dialog works a ticket as one: the role's first agent that can start, and the most that agent may do within
 * the role's limit.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:roles
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-roles-"));
app.setPath("userData", work);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
  if (!cond && detail !== undefined) console.log(`  saw ${JSON.stringify(detail)}`);
};

const run = async () => {
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work },
    // No agent of this machine's: the two the check stands in are the only ones a role can name here.
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }, ...["engine-claude-code", "engine-codex", "engine-pi"].map((id) => ({ id, disabled: true }))]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const project = ctx.projects.create({ name: "Alpha", keyPrefix: "AL" });
  await ctx.storage.ready;
  const engine = (id, title, modes) => ({
    id, title, author: `ai:${id}`, capabilities: ["backlog", "code"],
    permissionModes: { default: modes.at(-1), choices: modes.map((value) => ({ value, label: value })) },
    available: async () => ({ ok: true }),
    turn: async () => ({ stop: "end" })
  });
  ctx.agent.engine(engine("alpha", "Alpha Agent", ["plan", "default", "acceptEdits", "bypassPermissions"]));
  ctx.agent.engine(engine("beta", "Beta Agent", ["read-only", "workspace", "full-access"]));
  ctx.settings.set({ ...ctx.settings.get(), language: "en", onboarding: { seen: ["*"] } });
  const board = ctx.boards.list(project.id)[0];
  const item = ctx.items.create({ projectId: project.id, boardId: board.id, title: "Round the totals", status: "todo", workType: "coding", by: "human" });

  const win = new BrowserWindow({ width: 1500, height: 940, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.setBackgroundThrottling(false);
  const base = process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/";
  await win.loadURL(`${base}#/p/${project.id}`);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const until = async (js, tries = 80) => {
    for (let i = 0; i < tries; i++) {
      if (await $(js).catch(() => false)) return true;
      await sleep(100);
    }
    return false;
  };
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const type = (selector, text) => $(`(() => { const i = document.querySelector('${selector}'); if (!i) return false; Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i), 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const pick = (selector, value) => $(`(() => { const s = document.querySelector('${selector}'); if (!s) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const rows = () => $(`[...document.querySelectorAll('[data-testid="role-row"]')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim())`);
  const row = (title) => `[...document.querySelectorAll('[data-testid="role-row"]')].find((r) => r.querySelector('.role-list__title')?.textContent === ${JSON.stringify(title)})`;
  await sleep(2500);

  // ── Project settings → Roles ──────────────────────────────────────────
  await press(`[...document.querySelectorAll('.side-name')].find((n) => n.textContent?.trim() === 'Project settings')?.closest('button,a')`);
  await until(`!!document.querySelector('.dlg-nav .side-row')`);
  await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find((b) => b.textContent?.trim() === 'Roles')`);
  check("Project settings has a Roles pane", await until(`!!document.querySelector('[data-testid="project-roles"]')`));
  check("with the two roles every project has, each saying what it is for", await until(`document.querySelectorAll('[data-testid="role-row"]').length === 2`) && JSON.stringify(await rows()) === JSON.stringify(["ImplementerWorks ticketsBuilt in", "ReviewerReviews changesBuilt in"]), await rows());

  await press(`document.querySelector('[data-testid="role-add"]')`);
  check("New role opens an editor", await until(`!!document.querySelector('[data-testid="role-editor"]') && document.querySelector('#roleName')?.value === 'New role'`));
  await type("#roleName", "Careful");
  await pick('[data-testid="role-engine-add"]', "beta");
  await until(`document.querySelectorAll('[data-testid="role-engines"] li').length === 1`);
  await pick('[data-testid="role-engine-add"]', "alpha");
  check("its agents are kept in the order they were added", await until(`[...document.querySelectorAll('[data-testid="role-engines"] .role-engines__name')].map((n) => n.textContent).join() === 'Beta Agent,Alpha Agent'`), await $(`document.querySelector('[data-testid="role-engines"]')?.textContent`));
  await pick('[data-testid="role-limit"]', "edits");
  await type("#roleInstructions", "Measure before and after.");
  await press(`document.querySelector('[data-testid="role-save"]')`);
  check("saving lists it under the built-in ones, with its agents and limit", await until(`${row("Careful")}?.textContent.includes('Beta Agent → Alpha Agent · Edit files, ask before commands')`), await rows());
  const made = ctx.roles.list(project.id).find((role) => role.title === "Careful");
  check("and keeps it with the project", made?.engines.join() === "beta,alpha" && made.permission === "edits" && made.instructions === "Measure before and after." && !made.builtin, made);
  if (process.env.TOMRADE_SHOT) fs.writeFileSync(process.env.TOMRADE_SHOT.replace(/\.png$/, "-roles.png"), (await win.webContents.capturePage()).toPNG());

  // a built-in role is changed and put back, never deleted
  await press(row("Reviewer"));
  check("the reviewer's limit is not offered: a review only reads", await until(`document.querySelector('#roleName')?.value === 'Reviewer'`) && (await $(`!document.querySelector('[data-testid="role-limit"]') && document.querySelector('#roleLimit')?.textContent === 'A review only reads: it never changes code.' && document.querySelector('#roleStage')?.disabled === true && !document.querySelector('[data-testid="role-remove"]')`)));
  await type("#roleInstructions", "Look for injection first.");
  await press(`document.querySelector('[data-testid="role-save"]')`);
  check("a changed built-in role can be put back", await until(`document.querySelector('[data-testid="role-remove"]')?.textContent.trim() === 'Restore default'`) && ctx.roles.get(project.id, "reviewer").instructions === "Look for injection first.");
  await press(`document.querySelector('[data-testid="role-remove"]')`);
  check("and is, on a click", await until(`!document.querySelector('[data-testid="role-editor"]')`) && ctx.roles.get(project.id, "reviewer").changed === false && ctx.roles.get(project.id, "reviewer").instructions === "");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));true`);
  await sleep(400);

  // ── the Start dialog works a ticket as a role ─────────────────────────
  await $(`location.hash = '#/p/${project.id}/i/${item.id}'; true`);
  await until(`!!document.querySelector('[data-testid="start-ticket"]')`);
  await $(`document.querySelector('[data-testid="start-ticket"]').click(); true`);
  check("Start offers the project's roles that work tickets, the implementer first", await until(`[...document.querySelectorAll('#stRole option')].map((o) => o.textContent).join() === 'Implementer,Careful' && document.querySelector('#stRole').value === 'implementer'`), await $(`[...document.querySelectorAll('#stRole option')].map((o) => o.textContent)`));
  check("as the implementer it starts as it always did", (await $(`document.querySelector('#stEngine')?.value`)) === "alpha" && !(await $(`!!document.querySelector('[data-testid="start-role-hint"]')`)) && (await $(`document.querySelector('#stRole')?.title`)) === "Roles are made and changed under Project settings → Roles.", await $(`document.querySelector('#stEngine')?.value`));
  // in the panel, where a run has a permission mode
  await press(`document.querySelector('[data-testid="start-mode"] [data-mode="run"]')`);
  await pick("#stRole", made.id);
  check("as Careful, the role's first agent is the one picked", await until(`document.querySelector('#stEngine')?.value === 'beta'`) && (await $(`document.querySelector('[data-testid="start-role-hint"]')?.textContent`)) === "Careful names its agents: Beta Agent → Alpha Agent.", await $(`document.querySelector('#stEngine')?.value`));
  check("and the run is held to the most that agent may do within the role's limit", await until(`document.querySelector('#stPermission')?.value === 'workspace'`) && (await $(`document.querySelector('[data-testid="start-role-limit"]')?.textContent`)).startsWith("Careful lets its agent go this far at most: Edit files, ask before commands."), await $(`document.querySelector('#stPermission')?.value`));
  await pick("#stEngine", "alpha");
  check("another agent the person picks is held to the same limit", await until(`document.querySelector('#stPermission')?.value === 'acceptEdits'`), await $(`document.querySelector('#stPermission')?.value`));
  await pick("#stPermission", "bypassPermissions");
  check("a mode the person picks sets the role's limit aside for this start, and says so no more", await until(`!document.querySelector('[data-testid="start-role-limit"]')`));
  await sleep(600);
  check("and stays picked", (await $(`document.querySelector('#stPermission')?.value`)) === "bypassPermissions" && !(await $(`!!document.querySelector('[data-testid="start-role-limit"]')`)), await $(`document.querySelector('#stPermission')?.value`));
  if (process.env.TOMRADE_SHOT) fs.writeFileSync(process.env.TOMRADE_SHOT.replace(/\.png$/, "-start.png"), (await win.webContents.capturePage()).toPNG());
  check("harness reached the end", true);
};

app
  .whenReady()
  .then(run)
  .catch((error) => {
    results.push({ name: `threw: ${error?.stack ?? error}`, pass: false });
    console.log(`FAIL: ${error?.stack ?? error}`);
  })
  .finally(() => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    fs.rmSync(work, { recursive: true, force: true });
    app.exit(failed.length ? 1 : 0);
  });
