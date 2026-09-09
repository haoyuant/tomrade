/** Isolated end-to-end credential switch, with a fake GitHub remote and account. Requires the UI dev server. */
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";
import { seedDesignProject } from "./seed.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-credential-ui-"));
app.setPath("userData", work);
process.env.GIT_CONFIG_GLOBAL = path.join(work, "gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
const check = (name, condition) => {
  if (!condition) throw new Error(name);
  console.log(`PASS: ${name}`);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  const binary = path.join(work, "git-test");
  fs.writeFileSync(binary, `#!/bin/sh
if [ "$1" = "fetch" ]; then echo "fatal: repository 'https://github.com/acme/private-app/' not found" >&2; exit 128; fi
if [ "$1" = "ls-remote" ]; then
  printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill 2>/dev/null | grep -q 'password=ui-test-token' && exit 0
  echo 'Repository not found' >&2; exit 128
fi
exec git "$@"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(work, "settings.json"), JSON.stringify({ github: { token: "ui-test-token" } }));
  const { ctx } = await boot({
    configFile: path.join(here, "../tomrade.yml"), vars: { userData: work },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "code-link", config: { gitBinary: binary, scanMs: 0, sweepMs: 0 } }, { id: "repos", config: { gitBinary: binary } }]]
  });
  ctx.storage.get("github").connection.status = () => Promise.resolve({ connected: true, label: "@test-account" });
  ctx.hub.configure(path.join(work, "hub"));
  for (const p of ctx.projects.list()) ctx.projects.remove(p.id);
  const { project, repo } = seedDesignProject({ dbFor: id => ctx.db.for(id), items: ctx.items, projects: ctx.projects, boards: ctx.boards, views: ctx.views, fields: ctx.fields, gitRepos: ctx.repos });
  const remote = "https://github.com/acme/private-app";
  ctx.repos.update(project.id, repo.id, { remote });
  const checkout = path.join(work, "checkout");
  fs.mkdirSync(checkout);
  execFileSync("git", ["init", "-qb", "main", checkout]);
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: checkout });
  await ctx.repos.setCheckout(remote, checkout);
  await ctx.codeLink.scan(project.id);
  const win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { preload: path.join(here, "../preload.cjs"), contextIsolation: true } });
  const evaluate = js => win.webContents.executeJavaScript(js, true);
  const waitFor = async js => {
    for (let i = 0; i < 80; i++) {
      if (await evaluate(js)) return;
      await sleep(100);
    }
    fs.writeFileSync("/tmp/tomrade-credential-ui-failure.png", (await win.webContents.capturePage()).toPNG());
    console.log(await evaluate("document.querySelector('#psRepos')?.textContent"));
    throw new Error(`Timed out: ${js}`);
  };
  try {
    await win.loadURL(process.env.TOMRADE_DEV_URL || "http://127.0.0.1:5173/");
    await waitFor("!!document.querySelector('.proj')");
    await evaluate("document.querySelector('.proj').click()");
    await waitFor("!!document.querySelector('.side-project-settings')");
    await evaluate("document.querySelector('.side-project-settings').click()");
    check("the IPC context can resolve the connected account", await evaluate(`window.tomrade.invoke('codeLink.githubCredentialAccount', ${JSON.stringify(project.id)}, ${JSON.stringify(repo.id)})`) === "@test-account");
    await waitFor("!!document.querySelector('.repo-use-credential')");
    check("credential error offers the connected Tomrade account", (await evaluate("document.querySelector('.repo-use-credential').textContent")).includes("@test-account"));
    await evaluate("document.querySelector('#psRepos').scrollIntoView({block:'center'})");
    await sleep(200);
    check("repo rows use the design system's eight-pixel gap", await evaluate("getComputedStyle(document.querySelector('.repo-row')).gap === '8px'"));
    check("settings sections use a twenty-pixel gap", await evaluate("getComputedStyle(document.querySelector('.project-settings-body')).gap === '20px'"));
    check("remote title and detail do not overlap", await evaluate("document.querySelector('.repo-remote-copy .cfg-name').getBoundingClientRect().bottom <= document.querySelector('.repo-remote-detail').getBoundingClientRect().top"));
    check("repo content fits its card", await evaluate("document.querySelector('.repo-row').scrollWidth <= document.querySelector('.repo-row').clientWidth"));
    fs.writeFileSync("/tmp/tomrade-project-settings-before.png", (await win.webContents.capturePage()).toPNG());
    await evaluate("document.querySelector('.repo-use-credential').click()");
    await waitFor("document.querySelector('.repo-remote-state')?.textContent.includes('Origin reachable')");
    check("click updates remote reachability", ctx.codeLink.repoState(project.id, repo.id).remote === "ok");
    await waitFor("document.querySelector('.repo-identity')?.textContent.includes('@test-account')");
    check("successful switch removes the repair button", await evaluate("!document.querySelector('.repo-use-credential')"));
    fs.writeFileSync("/tmp/tomrade-project-settings-after.png", (await win.webContents.capturePage()).toPNG());
  } finally {
    win.destroy();
  }
}

app.whenReady().then(run).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
