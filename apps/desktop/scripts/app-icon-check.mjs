/** The app-icon plugin is on in a fresh and an upgraded profile, and stays off when the patch file says so.
 * pnpm build:backend, then pnpm --filter @tomrade/desktop test:app-icon
 */
import { app, BrowserWindow } from "electron";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";
import { clearSwitchOffOnce } from "../dist/loader.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, pass) => { results.push({ name, pass: !!pass }); console.log(`${pass ? "PASS" : "FAIL"}: ${name}`); };

// What each profile's tomrade.patch.yml holds before the start; null is a fresh profile with none.
const PROFILES = [
  { name: "a fresh profile", patch: null, on: true },
  { name: "a profile upgraded from before app-icon", patch: "plugins:\n  - id: code-sessions\n    disabled: false\n", on: true },
  // 0.19 and 0.20 failed to load app-icon, and flipping its failed row wrote this.
  { name: "a profile upgraded from 0.20 with app-icon switched off", patch: "plugins:\n  - id: app-icon\n    disabled: true\n", on: true },
  { name: "a profile that switched app-icon off since", patch: "plugins:\n  - id: app-icon\n    disabled: true\n", cleared: true, on: false }
];

/** One profile per process: a boot cannot be undone within one. */
async function runProfile(profile) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-app-icon-check-"));
  app.setPath("userData", work);
  const patchFile = path.join(work, "tomrade.patch.yml");
  if (profile.patch) fs.writeFileSync(patchFile, profile.patch);
  // As main.ts does before every start.
  const marker = path.join(work, "app-icon-switch-cleared");
  if (profile.cleared) fs.writeFileSync(marker, "0");
  clearSwitchOffOnce(patchFile, "app-icon", marker);
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    patchFiles: [patchFile],
    vars: { userData: work },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }]]
  });
  const view = ctx.plugins.list().find((p) => p.id === "app-icon");
  check(`${profile.name}: app-icon is ${profile.on ? "running" : "off"}`, view?.state === (profile.on ? "active" : "disabled"));
  // What Settings → Appearance asks before it offers the choice.
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(dir, "../preload.cjs"), contextIsolation: true } });
  await win.loadURL("data:text/html,<p></p>");
  const status = await win.webContents.executeJavaScript(`window.tomrade.invoke("appIcon.status").catch(() => null)`, true);
  check(`${profile.name}: Appearance ${profile.on ? "offers" : "does not offer"} the app icon`, profile.on ? status?.icon === "transparent" : status === null);
}

async function run() {
  const which = process.env.TOMRADE_APP_ICON_PROFILE;
  if (which !== undefined) return runProfile(PROFILES[Number(which)]);
  PROFILES.forEach((profile, i) => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, TOMRADE_APP_ICON_PROFILE: String(i) }, encoding: "utf8" });
    const before = results.length;
    for (const line of child.stdout.split("\n")) {
      const hit = /^(PASS|FAIL): (.*)$/.exec(line);
      if (hit) check(hit[2], hit[1] === "PASS");
    }
    if (child.status !== 0 && results.slice(before).every((r) => r.pass)) check(`${profile.name}: the start finished`, false);
  });
}

app.whenReady().then(run)
  .catch((error) => { console.error(error); results.push({ name: "run", pass: false }); })
  .finally(() => {
    const failed = results.filter((r) => !r.pass).length;
    if (process.env.TOMRADE_APP_ICON_PROFILE === undefined) console.log(`\n${results.length - failed}/${results.length} passed`);
    app.exit(failed ? 1 : 0);
  });
