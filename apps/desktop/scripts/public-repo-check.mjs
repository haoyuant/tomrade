/**
 * Conversation history and public repositories, against the real shell, a
 * stand-in for api.github.com, and local bare repositories git reaches in
 * place of github.com: the screen that connects a remote says conversations
 * travel and lets them be unticked there; a repository GitHub calls public
 * gets them unticked on its own, says why, and never receives them; a private
 * one gets them when they are ticked.
 *
 *   pnpm --filter @tomrade/desktop test:public-repo      (needs the dev server up)
 */
import { app, BrowserWindow, shell } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";
import { registerExtensionResolution } from "../dist/extension-resolve.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.TOMRADE_DEV_URL || "http://127.0.0.1:5173/";
const WORK = "/tmp/tomrade-public-convo-check";
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath("userData", path.join(WORK, "userData"));
registerExtensionResolution([path.resolve(__dirname, "../../..")]);

// git pushes to github.com land in local bare repositories instead.
const REMOTES = path.join(WORK, "remotes");
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
for (const repo of ["open-backlog", "closed-backlog"]) {
  const dir = path.join(REMOTES, "me", `${repo}.git`);
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q", "--bare", "-b", "main", "."], dir);
}
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = `url.${REMOTES}/.insteadOf`;
process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";
const tree = (repo) => {
  try {
    return git(["ls-tree", "-r", "--name-only", "main"], path.join(REMOTES, "me", `${repo}.git`)).split("\n");
  } catch {
    return [];
  }
};
const carriesTalk = (repo) => tree(repo).some((f) => f.startsWith(".tomrade/plugins/agent/"));

const results = [];
const check = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond || !extra ? "" : ` — ${typeof extra === "string" ? extra : JSON.stringify(extra)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
shell.openExternal = async () => {};

/** api.github.com for one account, "me": open-backlog is public, closed-backlog is private. */
async function fakeGitHub() {
  const repos = { "open-backlog": false, "closed-backlog": true };
  const server = http.createServer((req, res) => {
    const json = (status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    const signed = (req.headers.authorization ?? "") === "Bearer ghp_e2e";
    const url = new URL(req.url, "http://api");
    if (url.pathname === "/user") return signed ? json(200, { login: "me" }) : json(401, { message: "Requires authentication" });
    if (url.pathname === "/user/repos") return json(200, []);
    const repo = /^\/repos\/me\/([\w-]+)$/.exec(url.pathname)?.[1];
    if (repo && repo in repos && (signed || !repos[repo])) {
      return json(200, { full_name: `me/${repo}`, name: repo, owner: { login: "me" }, default_branch: "main", private: repos[repo], pushed_at: null });
    }
    json(404, { message: "Not Found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

const run = async () => {
  const api = await fakeGitHub();
  const userData = path.join(WORK, "userData");
  const { ctx } = await boot({
    configFile: path.join(__dirname, "../tomrade.yml"),
    vars: { userData, locale: "en-US", pluginsRoot: path.join(WORK, "plugins"), pluginsDevRoot: path.join(WORK, "plugins-dev") },
    patches: [[
      { id: "mcp", config: { port: 0 } },
      { id: "hub-cloud", disabled: true },
      { id: "github", config: { userData, clientId: "", apiUrl: api, webUrl: api } }
    ]]
  });
  ctx.hub.configure(path.join(WORK, "hub"));
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  ctx.settings.set({ ...ctx.settings.get(), language: "en", onboarding: { seen: ["*"] }, github: { token: "ghp_e2e" } });
  const open = ctx.projects.create({ name: "Open talk", keyPrefix: "OT" });
  const closed = ctx.projects.create({ name: "Closed talk", keyPrefix: "CT" });
  await ctx.storage.ready;
  const exportsOf = (id) => ctx.hub.catalog.project(id)?.exports ?? [];
  for (const p of [open, closed]) await ctx.storage.materialize(p.id);
  check("conversation history travels by default in a folder of Tomrade's own", exportsOf(open.id).includes("agent") && exportsOf(closed.id).includes("agent"), exportsOf(open.id));

  const win = new BrowserWindow({ width: 1400, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(__dirname, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || String(event.level) === "3") console.log(`[renderer] ${event.message}`);
  });
  await win.loadURL(DEV_URL);
  await sleep(3500);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (expr) =>
    $(`(() => { const n = ${expr}; if (!n) return false; for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 })); return true; })()`);
  const pick = (expr, value) =>
    $(`(() => { const s = ${expr}; if (!s) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)}); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const typeInto = (selector, text) =>
    $(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); if (!i) return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); i.dispatchEvent(new FocusEvent('blur')); i.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); return true; })()`);
  const until = async (js, ms = 10_000) => {
    for (let waited = 0; waited < ms; waited += 200) {
      if (await $(js)) return true;
      await sleep(200);
    }
    return false;
  };
  const text = () => $(`document.querySelector('.dlg-body')?.textContent ?? ''`);
  // TOMRADE_SHOTS=<dir> keeps a picture of each state, for a look by eye.
  const shot = async (name) => {
    if (!process.env.TOMRADE_SHOTS) return;
    fs.writeFileSync(path.join(process.env.TOMRADE_SHOTS, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const openStorage = async (name) => {
    await press(`[...document.querySelectorAll('.proj-cell')].find(c => c.querySelector('.proj-name')?.textContent === ${JSON.stringify(name)})?.querySelector('.proj-gear')`);
    await sleep(900);
    await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find(r => /^(Storage|存储)$/.test(r.textContent.trim()))`);
    await sleep(700);
  };
  const closeSheet = async () => {
    await $(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await sleep(600);
  };
  const include = `document.querySelector('.stg-include[data-namespace="agent"] input')`;
  const travelsBox = `document.querySelector('.stg-export[data-namespace="agent"] input')`;
  const connectTo = async (repo) => {
    await pick(`document.querySelector('#stgProvider')`, "github");
    await until(`!!document.querySelector('#sf-stg-owner')`);
    await typeInto("#sf-stg-owner", "me");
    await typeInto("#sf-stg-repo", repo);
    await sleep(300);
  };

  // ── a public repository ─────────────────────────────────────────────────
  await openStorage("Open talk");
  await connectTo("open-backlog");
  check("connecting a remote says conversation history goes with it", (await text()).includes("Include “Conversation history”") && (await text()).includes("anyone who can read the repository can read it"), (await text()).slice(0, 600));
  check("ticked, as it travels today", (await $(`${include}?.checked`)) === true);
  await shot("public-01-connect");
  await press(`document.querySelector('.stg-publish')`);
  check("the repository is published", await until(`!!document.querySelector('.stg-remote')`, 20_000), (await text()).slice(0, 400));
  check("GitHub calls it public, so the app says conversations stay here and why", await until(`(document.querySelector('.stg-public')?.textContent ?? '').includes("This repository is public, so “Conversation history” stays on this machine.")`), (await text()).slice(0, 800));
  check("and that what was pushed before is still in its history", (await $(`document.querySelector('.stg-public')?.textContent ?? ''`)).includes("still in the repository's history"));
  check("conversation history is unticked, and not a choice while the repository is public", (await $(`${travelsBox}?.checked === false && ${travelsBox}?.disabled === true`)) === true);
  check("the public repository never received it", tree("open-backlog").includes(".tomrade/project.json") && !carriesTalk("open-backlog"), tree("open-backlog"));
  check("and the project no longer exports it", !exportsOf(open.id).includes("agent"), exportsOf(open.id));
  await shot("public-02-unticked");
  await closeSheet();

  // ── a private repository ────────────────────────────────────────────────
  await openStorage("Closed talk");
  await connectTo("closed-backlog");
  await press(include);
  check("unticking it on the connect screen keeps it off before anything is pushed", await until(`${include}?.checked === false`) && !exportsOf(closed.id).includes("agent"), exportsOf(closed.id));
  await press(`document.querySelector('.stg-publish')`);
  check("the private repository is published without it", (await until(`!!document.querySelector('.stg-remote')`, 20_000)) && tree("closed-backlog").includes(".tomrade/project.json") && !carriesTalk("closed-backlog"), tree("closed-backlog"));
  check("a private repository raises no public notice", !(await $(`!!document.querySelector('.stg-public')`)));
  await press(travelsBox);
  check("ticked again, the app says who can read it", await until(`(document.querySelector('.stg-private-note')?.textContent ?? '').includes("travels with the project: anyone who can read the repository can read it")`), (await text()).slice(0, 800));
  await ctx.storage.sync(closed.id);
  check("and the private repository gets it", carriesTalk("closed-backlog"), tree("closed-backlog"));
  await shot("public-03-private");
  await closeSheet();

  // ── in Chinese ──────────────────────────────────────────────────────────
  ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
  win.webContents.reload();
  await sleep(3500);
  await openStorage("Open talk");
  check("中文：公开仓库的说明", await until(`(document.querySelector('.stg-public')?.textContent ?? '').includes('这个仓库是公开的，所以“对话历史”只留在这台电脑上。')`), (await text()).slice(0, 600));
  await shot("public-04-zh");
};

app.whenReady().then(async () => {
  try {
    await run();
  } catch (error) {
    console.error(error);
    results.push({ name: "run", pass: false });
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  app.exit(passed === results.length ? 0 : 1);
});
