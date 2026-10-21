/**
 * Signing in to GitHub from a project's destination, against the real shell
 * and a stand-in for github.com: the sign-in is offered first, the code is
 * shown while GitHub waits on the person, the account lands by itself, the
 * App's missing repository access is called out, and a personal access token
 * stays one click away as the fallback.
 *
 *   pnpm --filter @tomrade/desktop test:github-signin      (needs the dev server up)
 */
import { app, BrowserWindow, shell } from "electron";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";
import { registerExtensionResolution } from "../dist/extension-resolve.js";
import { seedDesignProject } from "./seed.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.TOMRADE_DEV_URL || "http://127.0.0.1:5173/";
const SHOTS = path.join(__dirname, "shots");
const WORK = "/tmp/tomrade-github-signin-check";
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
app.setPath("userData", path.join(WORK, "userData"));
registerExtensionResolution([path.resolve(__dirname, "../../..")]);

const results = [];
const check = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond || !extra ? "" : ` — ${extra}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// No browser opens: the pages the panel sends the person to are only recorded.
const opened = [];
shell.openExternal = async (url) => void opened.push(url);

/** github.com and api.github.com: the device code, a person who approves on the third poll, the App installed nowhere. */
async function fakeGitHub() {
  const state = { polls: 0, approved: false };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const json = (status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (req.url === "/login/device/code") return json(200, { device_code: "dc", user_code: "WDJB-MJHT", verification_uri: `${origin}/login/device`, expires_in: 900, interval: 1 });
      if (req.url === "/login/oauth/access_token") {
        if (!state.approved) return json(200, { error: "authorization_pending" });
        return json(200, { access_token: "ghu_e2e", expires_in: 28_800, refresh_token: "ghr_e2e", refresh_token_expires_in: 15_897_600, token_type: "bearer" });
      }
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (token !== "ghu_e2e" && token !== "ghp_e2e") return json(401, { message: "Bad credentials" });
      if (req.url === "/user") return json(200, { login: "octo" });
      if (req.url?.startsWith("/user/installations")) return json(200, { total_count: 0, installations: [] });
      json(404, { message: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, state };
}

const run = async () => {
  const github = await fakeGitHub();
  const userData = path.join(WORK, "userData");
  const { ctx } = await boot({
    configFile: path.join(__dirname, "../tomrade.yml"),
    vars: { userData, pluginsRoot: path.join(WORK, "plugins"), pluginsDevRoot: path.join(WORK, "plugins-dev") },
    patches: [[
      { id: "mcp", config: { port: 0 } },
      { id: "hub-cloud", disabled: true },
      { id: "github", config: { userData, clientId: "Iv-e2e", appSlug: "tomrade", webUrl: github.origin, apiUrl: github.origin, pollUnitMs: 200 } }
    ]]
  });
  ctx.hub.configure(path.join(WORK, "hub"));
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  seedDesignProject({ dbFor: (id) => ctx.db.for(id), items: ctx.items, projects: ctx.projects, boards: ctx.boards, views: ctx.views, fields: ctx.fields, gitRepos: ctx.repos });
  await ctx.storage.ready;

  const win = new BrowserWindow({ width: 1400, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(__dirname, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") console.log(`[renderer] ${event.message}`);
  });
  await win.loadURL(DEV_URL);
  await sleep(3500);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (selector) =>
    $(`(() => {
      const n = ${selector};
      if (!n) return false;
      for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      return true;
    })()`);
  const pick = (nodeExpr, value) =>
    $(`(() => {
      const s = ${nodeExpr};
      if (!s) return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)});
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  const shot = async (name) => fs.writeFileSync(path.join(SHOTS, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const text = () => $(`document.querySelector('.dlg-body')?.textContent ?? ''`);
  const until = async (js, ms = 8000) => {
    for (let waited = 0; waited < ms; waited += 200) {
      if (await $(js)) return true;
      await sleep(200);
    }
    return false;
  };
  const gear = `[...document.querySelectorAll('.proj-cell')].find(c => c.querySelector('.proj-name')?.textContent === 'Tomrade')?.querySelector('.proj-gear')`;
  const openStorage = async () => {
    await press(gear);
    await sleep(900);
    await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find(r => /^(Storage|存储)$/.test(r.textContent.trim()))`);
    await sleep(700);
  };

  await openStorage();
  await pick(`document.querySelector('#stgProvider')`, "github");
  await sleep(800);
  check("signing in is offered first", (await $(`!!document.querySelector('[data-testid="connection-sign-in"]')`)) === true && (await text()).includes("Sign in with GitHub"));
  check("and the token field waits behind it", (await $(`!!document.querySelector('#stgSecret')`)) === false && (await $(`!!document.querySelector('[data-testid="connection-use-secret"]')`)) === true);
  await shot("40-github-sign-in");

  await press(`document.querySelector('[data-testid="connection-sign-in"]')`);
  check("the code is shown while GitHub waits on the person", await until(`document.querySelector('[data-testid="device-code"]')?.textContent === 'WDJB-MJHT'`));
  check("and GitHub's page is opened for them", opened.includes(`${github.origin}/login/device`), JSON.stringify(opened));
  check("the panel says it is waiting", (await text()).includes("Waiting for you to approve it on"));
  await shot("41-github-code");

  github.state.approved = true;
  check("the account lands by itself", await until(`(document.querySelector('.dlg-body')?.textContent ?? '').includes('Connected as @octo')`, 10_000), await text());
  check("an App with no repositories says so, with the way to fix it", (await $(`!!document.querySelector('[data-testid="connection-action"]')`)) === true && (await text()).includes("Give Tomrade access to your repositories"));
  await press(`document.querySelector('[data-testid="connection-action"] button')`);
  await sleep(300);
  check("which opens the App's installation page", opened.includes(`${github.origin}/apps/tomrade/installations/new`), JSON.stringify(opened));
  check("the destination's own fields open once connected", await until(`!!document.querySelector('#sf-stg-owner')`));
  check("the session is kept encrypted, not in settings", fs.existsSync(path.join(userData, "github-session.enc")) && !(fs.existsSync(path.join(userData, "settings.json")) && fs.readFileSync(path.join(userData, "settings.json"), "utf8").includes("ghu_e2e")));
  check("git's copy of the token is short-lived and private", (fs.statSync(path.join(userData, "github-token.json")).mode & 0o777) === 0o600);
  await shot("42-github-connected");

  await press(`[...document.querySelectorAll('.dlg-body .btn-ghost')].find(b => b.textContent === 'Disconnect')`);
  await sleep(900);
  check("disconnecting forgets the sign-in", (await $(`!!document.querySelector('[data-testid="connection-sign-in"]')`)) === true && !fs.existsSync(path.join(userData, "github-token.json")));
  await press(`document.querySelector('[data-testid="connection-use-secret"]')`);
  await sleep(400);
  check("a personal access token is still one click away", (await $(`!!document.querySelector('#stgSecret')`)) === true);
  await $(`(() => { const i = document.querySelector('#stgSecret'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'ghp_e2e'); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await press(`[...document.querySelectorAll('.dlg-body .btn-secondary')].find(b => b.textContent === 'Connect')`);
  check("and connects on its own", await until(`(document.querySelector('.dlg-body')?.textContent ?? '').includes('Connected as @octo')`), await text());
  await shot("43-github-token");

  // The same panel in Chinese.
  await press(`[...document.querySelectorAll('.dlg-body .btn-ghost')].find(b => b.textContent === 'Disconnect')`);
  await sleep(600);
  ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
  win.webContents.reload();
  await sleep(3500);
  await openStorage();
  await pick(`document.querySelector('#stgProvider')`, "github");
  await sleep(800);
  check("中文界面提供 GitHub 登录与令牌备用入口", (await text()).includes("使用 GitHub 登录") && (await text()).includes("改用个人访问令牌"), (await text()).slice(0, 300));
  await shot("44-github-sign-in-zh");
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
