/**
 * Restore regression: two computers. A child process plays the one the person
 * used before — it makes projects, backs some up to bare git remotes and
 * writes the Hub catalog. This process plays the new one: it boots with that
 * catalog and nothing else, and the real renderer has to show every project,
 * restore what has a backup without being asked, and say plainly why the rest
 * cannot come back yet.
 *
 *   pnpm build:backend && pnpm dev:ui   then
 *   pnpm --filter @tomrade/desktop test:restore
 */
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { boot } from "../dist/boot.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.join(dir, "../tomrade.yml");
const patches = [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]];
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bare = (where) => {
  fs.mkdirSync(where, { recursive: true });
  git(["init", "-q", "--bare", "-b", "main", "."], where);
  return where;
};

const seedIndex = process.argv.indexOf("--seed");
const work = fs.mkdtempSync(path.join(os.tmpdir(), seedIndex > 0 ? "tomrade-restore-old-" : "tomrade-restore-new-"));
app.setPath("userData", work);

/** The computer used before: four projects, three of them backed up. */
async function seed(outFile) {
  const { ctx } = await boot({ configFile, vars: { userData: work }, patches });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  for (const p of ctx.projects.list()) ctx.projects.remove(p.id);
  const make = async (name, keyPrefix, titles, remote) => {
    const project = ctx.projects.create({ name, keyPrefix });
    for (let i = 0; i < 50 && !ctx.hub.catalog.project(project.id)?.dir; i++) await sleep(50);
    const board = ctx.boards.defaultFor(project.id);
    for (const title of titles) ctx.items.create({ projectId: project.id, boardId: board.id, title, by: "human" });
    if (remote) await ctx.storage.bind(project.id, "git", { remote, branch: "main" });
    else await ctx.storage.publish(project.id);
    return { id: project.id, name, keyPrefix, titles, remote: remote ?? null, dir: ctx.hub.catalog.project(project.id).dir };
  };
  const out = {
    launch: await make("Launch plan", "LCH", ["Draft the announcement", "Book the venue"], bare(path.join(work, "remotes", "launch-plan.git"))),
    review: await make("Quarterly review", "QRV", ["Collect the numbers"], bare(path.join(work, "remotes", "quarterly-review.git"))),
    portal: await make("Client portal", "CLP", ["Reset password flow"], bare(path.join(work, "remotes", "client-portal.git"))),
    garden: await make("Garden notes", "GDN", ["Order seeds"], null),
    empty: bare(path.join(work, "remotes", "next-year.git"))
  };
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
}

const results = [];
const check = (name, cond) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
};
const same = (name, actual, expected) => {
  check(name, actual === expected);
  if (actual !== expected) console.log(`  expected ${JSON.stringify(expected)}\n  received ${JSON.stringify(actual)}`);
};

/** The new computer. */
async function run() {
  const shots = process.env.TOMRADE_SHOTS || path.join(work, "shots");
  fs.mkdirSync(shots, { recursive: true });
  const seedFile = path.join(work, "seed.json");
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--seed", seedFile], { stdio: ["ignore", "ignore", "inherit"] });
  const old = JSON.parse(fs.readFileSync(seedFile, "utf8"));

  // What the account's catalog hands this computer: identities and where each was backed up, nothing else.
  const hubDir = path.join(work, "hub");
  const record = (p, remote) => ({ id: p.id, name: p.name, keyPrefix: p.keyPrefix, remote, hint: null, updatedAt: 1 });
  const viaGit = (remote) => ({ provider: "git", config: { remote, branch: "main" } });
  const projects = [
    record(old.launch, viaGit(old.launch.remote)),
    record(old.review, { provider: "slow-git", config: { remote: old.review.remote, branch: "main" } }),
    record(old.portal, { provider: "vault", config: { name: "client-portal" } }),
    record(old.garden, null),
    { id: "field-trip", name: "Field trip", keyPrefix: "FLD", remote: viaGit("http://127.0.0.1:9/field-trip.git"), hint: null, updatedAt: 1 },
    { id: "next-year", name: "Next year", keyPrefix: "NXT", remote: viaGit(old.empty), hint: null, updatedAt: 1 },
    { id: "old-sketches", name: "Old sketches", keyPrefix: "OLD", remote: null, hint: null, updatedAt: 1 }
  ];
  fs.mkdirSync(hubDir, { recursive: true });
  fs.writeFileSync(path.join(hubDir, "hub.json"), JSON.stringify({ v: 1, projects, repos: [], removed: [] }, null, 2));

  const { ctx } = await boot({ configFile, vars: { userData: work }, patches });
  const placeholder = ctx.projects.list()[0];
  check("a first run still makes a Default Project to start in", placeholder?.name === "Default Project");

  // One destination answers slowly, so the restoring card can be seen; one needs an account first.
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  ctx.storage.register({ id: "slow-git", title: "Slow git", configSchema: z.object({ remote: z.string(), branch: z.string() }), defaults: { remote: "", branch: "main" }, toRemote: async (c) => (await gate, { url: c.remote, branch: c.branch }) });
  let token = "";
  ctx.storage.register({
    id: "vault",
    title: "Vault",
    configSchema: z.object({ name: z.string() }),
    defaults: { name: "" },
    toRemote: () => ({ url: token ? old.portal.remote : path.join(work, "locked.git"), branch: "main" }),
    connection: {
      prompt: { label: "Vault token", help: "Any non-empty token works in this check." },
      status: async () => (token ? { connected: true, label: "@tester" } : { connected: false }),
      connect: async (secret) => ((token = secret.trim()), { connected: true, label: "@tester" }),
      disconnect: async () => void (token = "")
    }
  });
  ctx.hub.configure(hubDir);

  const win = new BrowserWindow({ width: 1440, height: 1000, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  await win.loadURL(process.env.TOMRADE_DEV_URL ?? "http://127.0.0.1:5173/");
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const has = (selector) => $(`!!document.querySelector(${JSON.stringify(selector)})`);
  const text = (selector) => $(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const click = (selector) => $(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; n.click(); return true; })()`);
  const press = (js) =>
    $(`(() => { const n = ${js}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const typeInto = (selector, value) =>
    $(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); if (!i) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const wait = async (cond, what, tries = 150) => {
    for (let i = 0; i < tries; i++) {
      if (await cond()) return true;
      await sleep(100);
    }
    console.log(`timed out waiting for ${what}`);
    return false;
  };
  const shot = async (name) => fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const card = (id) => `.proj-restore[data-project="${id}"]`;
  const stateOf = (id) => $(`document.querySelector('${card(id)}')?.dataset.restore ?? null`);
  const projectCard = (name) => $(`[...document.querySelectorAll('.proj:not(.proj-restore) .proj-name')].some((n) => n.textContent.trim() === ${JSON.stringify(name)})`);
  const lastToast = () => $(`[...document.querySelectorAll('.toast .toast-body')].at(-1)?.textContent ?? null`);
  const settled = () => ctx.storage.restores().entries.every((e) => e.state !== "queued" && e.state !== "restoring");

  // ── every project in the account shows up at once ──
  check("the home screen draws", await wait(() => has(".proj-grid"), "the grid"));
  check("the slow destination's project is shown restoring", await wait(async () => (await stateOf(old.review.id)) === "restoring", "a restoring card"));
  check("saying which step it is on", /contacting/i.test((await text(`${card(old.review.id)} .eyebrow`)) ?? ""));
  check("with a running rule under it", await has(`${card(old.review.id)} .restore-progress`));
  same("the banner says projects are being restored", await $(`document.querySelector('.restore-banner')?.dataset.mode ?? null`), "active");
  check("and names the one under way", ((await text(".restore-banner-current")) ?? "").includes("Quarterly review"));
  await shot("restore-01-restoring");

  release();
  check("every restore settles", await wait(settled, "restores to settle", 300));
  await sleep(600);

  // ── what had a backup is here, with everything in it ──
  for (const p of [old.launch, old.review]) {
    check(`${p.name} is a project on this computer`, await wait(() => projectCard(p.name), `${p.name} card`));
    const items = ctx.items.list({ projectId: p.id }).map((i) => i.title).sort();
    same(`${p.name} came back with every issue`, JSON.stringify(items), JSON.stringify([...p.titles].sort()));
    same(`${p.name} keeps its backup destination`, ctx.hub.catalog.project(p.id)?.git, "dedicated");
  }
  check("the untouched Default Project made way", !ctx.projects.list().some((p) => p.id === placeholder.id) && !(await projectCard("Default Project")));
  check("no half-made folder is left behind", !fs.readdirSync(path.join(hubDir, "projects")).some((n) => n.startsWith(".")));

  // ── the rest say why ──
  same("a project never backed up says so", await stateOf(old.garden.id), "not-backed-up");
  check("and offers to locate its folder", await has(`${card(old.garden.id)} .restore-locate`));
  same("a project behind an account asks for it", await stateOf(old.portal.id), "needs-connection");
  check("with a button naming the account", /Vault/.test((await text(`${card(old.portal.id)} .restore-connect`)) ?? ""));
  same("an unreachable backup reads as offline", await stateOf("field-trip"), "offline");
  check("and says it tries again by itself", /tries again/.test((await text(`${card("field-trip")} .restore-body`)) ?? ""));
  same("an empty backup reads as not published yet", await stateOf("next-year"), "unpublished");
  same("the banner turns to what needs the person", await $(`document.querySelector('.restore-banner')?.dataset.mode ?? null`), "attention");
  await shot("restore-02-needs-you");

  // ── an old project nobody can find the folder of leaves the catalog, and nothing is deleted ──
  same("another project never backed up", await stateOf("old-sketches"), "not-backed-up");
  // The same gear every project card carries opens this project's sheet.
  await $(`document.querySelector('${card("old-sketches")}').parentElement.querySelector('.proj-gear').click(); true`);
  check("the card's gear opens its sheet", await wait(() => has(".restore-sheet .restore-sheet-remove"), "the restore sheet"));
  check("which says where the project stands", /never given a backup destination/.test((await text(".restore-sheet .dlg-body")) ?? ""));
  await shot("restore-03-sheet");
  await click(".restore-sheet .restore-sheet-remove");
  check("removing asks first", await wait(() => has(".restore-sheet .restore-remove-confirm"), "the remove face"));
  check("with Cancel holding the focus", await $(`document.activeElement?.textContent?.trim() === 'Cancel'`));
  check("and says nothing is deleted", /Nothing is deleted/.test((await text(".restore-sheet .dangerbar")) ?? ""));
  await shot("restore-04-remove");
  await $(`document.activeElement.click(); true`);
  check("Cancel goes back to the sheet, nothing removed", (await wait(() => has(".restore-sheet .restore-sheet-remove"), "the sheet again")) && ctx.storage.restores().entries.some((e) => e.projectId === "old-sketches"));
  await click(".restore-sheet .restore-sheet-remove");
  await wait(() => has(".restore-sheet .restore-remove-confirm"), "the remove face again");
  await click(".restore-remove-confirm");
  check("the card leaves the grid", await wait(async () => !(await has(card("old-sketches"))), "the removed card to go"));
  check("and the sheet closes with it", await wait(async () => !(await has(".restore-sheet")), "the sheet to close"));
  check("and the removal is announced", await wait(async () => /Old sketches/.test((await lastToast()) ?? ""), "the removal toast"));
  check("the catalog no longer names it", !ctx.storage.restores().entries.some((e) => e.projectId === "old-sketches"));
  await ctx.storage.writeHub();
  check("and remembers it was removed on purpose", JSON.parse(fs.readFileSync(path.join(hubDir, "hub.json"), "utf8")).removed.some((r) => r.id === "old-sketches"));

  // ── retry goes round again and lands where it was ──
  await click(`${card("next-year")} .restore-retry`);
  check("retry tries again and lands where it was", await wait(async () => (await stateOf("next-year")) === "unpublished" && settled(), "retry to settle"));

  // ── connecting the account resumes the restore by itself ──
  await click(`${card(old.portal.id)} .restore-connect`);
  check("connect opens the account sheet", await wait(() => has(".dlg-body #stgSecret"), "the connect sheet"));
  await typeInto(".dlg-body #stgSecret", "vault-token");
  await shot("restore-05-connect");
  await press(`[...document.querySelectorAll('.dlg-body .btn')].find((b) => /Connect/.test(b.textContent))`);
  check("and the project comes back without another click", await wait(() => projectCard(old.portal.name), "the portal project", 200));
  same("with its issues", JSON.stringify(ctx.items.list({ projectId: old.portal.id }).map((i) => i.title)), JSON.stringify(old.portal.titles));
  await press(`[...document.querySelectorAll('.dlg-foot .btn')].find((b) => /Done/.test(b.textContent))`);
  await sleep(400);

  // ── a folder the person points at (the native picker cannot be driven, so its answer is) ──
  await ctx.storage.locate(old.garden.id, old.garden.dir);
  check("a located folder becomes the project", await wait(() => projectCard(old.garden.name), "the garden project"));
  check("and the arrival is announced", await wait(async () => /Garden notes/.test((await lastToast()) ?? ""), "the arrival toast"));
  same("its card is gone", await has(card(old.garden.id)), false);

  // ── the Hub pane lists the same ──
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:',',metaKey:true,bubbles:true}));true`);
  await wait(() => has(".dlg-nav"), "settings");
  await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find(r => r.textContent.trim() === 'Hub')`);
  check("the Hub pane lists what is still missing", await wait(async () => (await $(`document.querySelectorAll('.hub-other').length`)) === ctx.storage.restores().entries.length, "hub rows"));
  same("one row per project", await $(`[...document.querySelectorAll('.hub-other')].map((r) => r.dataset.project).sort().join()`), ["field-trip", "next-year"].join());
  await shot("restore-06-hub-pane");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(400);

  // ── the same screen in the dark ──
  await $(`document.documentElement.classList.remove('dawn', 'matcha'); document.documentElement.classList.add('dark'); true`);
  await sleep(300);
  await shot("restore-07-dark");

  // The catalog this computer writes back names what it has, and never the placeholder.
  await ctx.storage.writeHub();
  const written = JSON.parse(fs.readFileSync(path.join(hubDir, "hub.json"), "utf8"));
  check("the catalog never learned of the placeholder", !written.projects.some((p) => p.id === placeholder.id));
  check("and still names what has not come back", ["field-trip", "next-year"].every((id) => written.projects.some((p) => p.id === id)));
  console.log(`screenshots in ${shots}`);
}

app.whenReady().then(async () => {
  if (seedIndex > 0) {
    try {
      await seed(process.argv[seedIndex + 1]);
      app.exit(0);
    } catch (err) {
      console.error(err);
      app.exit(1);
    }
    return;
  }
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
