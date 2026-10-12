/**
 * The Plugins screens against the real shell: a store package and a local one
 * installed, an agent's build waiting in Plugin Studio and loaded only once a
 * person confirms it in the dialog, and the four tabs, in both languages.
 *
 *   pnpm --filter @tomrade/desktop test:plugins-ui      (needs the dev server up)
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold } from "@tomradex/plugin-cli";
import { ATTESTATION_FILE, attest, generateSigningKey, packPlugin, packageDigest } from "@tomradex/plugin-kit";
import { build } from "@tomradex/plugin-cli";
import { boot } from "../dist/boot.js";
import { registerExtensionResolution } from "../dist/extension-resolve.js";
import { oneFocusRing } from "./focus-ring.mjs";
import { seedDesignProject } from "./seed.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.TOMRADE_DEV_URL || "http://127.0.0.1:5173/";
const SHOTS = path.join(__dirname, "shots");
const WORK = "/tmp/tomrade-plugins-ui-check";
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
const key = generateSigningKey();

async function extension(name, { official, permissions }) {
  const dir = path.join(WORK, "src", name);
  scaffold(dir, { id: `someone/${name}`, title: name[0].toUpperCase() + name.slice(1), description: `The ${name} plugin.` });
  const file = path.join(dir, "tomrade-plugin.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), permissions, inject: ["items", "tools", "contributions"] }, null, 2));
  const built = await build(dir);
  if (!built.ok) throw new Error(built.errors.join("\n"));
  if (official) {
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(path.join(dir, ATTESTATION_FILE), JSON.stringify(attest({ v: 1, id: m.id, version: m.version, digest: packageDigest(dir), tier: "official", risk: "elevated", issuedAt: Date.now() }, key.privateKey)));
  }
  return packPlugin(dir, path.join(WORK, `${name}.tomrade-plugin`));
}

const run = async () => {
  const { ctx } = await boot({
    configFile: path.join(__dirname, "../tomrade.yml"),
    vars: { userData: path.join(WORK, "userData"), pluginsRoot: path.join(WORK, "plugins"), pluginsDevRoot: path.join(WORK, "plugins-dev") },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]],
    extensions: { root: path.join(WORK, "plugins"), trustedKeys: { [key.keyId]: key.publicKey } }
  });
  ctx.hub.configure(path.join(WORK, "hub"));
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const { project } = seedDesignProject({ dbFor: (id) => ctx.db.for(id), items: ctx.items, projects: ctx.projects, boards: ctx.boards, views: ctx.views, fields: ctx.fields, gitRepos: ctx.repos });

  const counter = await extension("counter", { permissions: { network: ["api.example.com"], fs: "none", exec: false } });
  await ctx.plugins.installFile(counter.file, { source: "store", digest: counter.digest });
  const keeper = await extension("keeper", { official: true, permissions: { network: [], fs: "none", exec: false } });
  await ctx.plugins.installFile(keeper.file, { source: "store", digest: keeper.digest });
  await ctx.plugins.installFile((await extension("runner", { permissions: { network: [], fs: "none", exec: true } })).file);
  const view = (id) => ctx.plugins.list().find((p) => p.id === id);
  check("a store package installs as Community", view("someone/counter")?.extension?.tier === "community" && view("someone/counter")?.state === "active");
  check("one Tomrade signed installs as Official", view("someone/keeper")?.extension?.tier === "official");
  check("a file without an attestation installs as local", view("someone/runner")?.extension?.tier === "local");

  // The agent's side, through the same tools any engine calls.
  const tool = (name, args) => ctx.tools.execute(name, args, { by: "ai:assistant", projectId: project.id });
  await tool("plugin_create", { name: "notes", title: "Notes", description: "Counts open issues and shows the count." });
  const tried = await tool("plugin_try", { plugin: "notes" });
  check("the agent's build waits for a person, checked in the sandbox under Electron", tried.waiting === true, JSON.stringify(tried));
  check("and nothing of it runs yet", !ctx.tools.has("notes_count_open"));

  const win = new BrowserWindow({ width: 1560, height: 940, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(__dirname, "../preload.cjs"), contextIsolation: true } });
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") console.log(`[renderer] ${event.message}`);
  });
  await win.loadURL(`${DEV_URL}#/p/${project.id}`);
  await sleep(3500);
  const $ = (js) => win.webContents.executeJavaScript(js, true);
  const press = (selector) =>
    $(`(() => {
      const n = ${selector};
      if (!n) return false;
      for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) n.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      return true;
    })()`);
  const shot = async (name) => fs.writeFileSync(path.join(SHOTS, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const openPane = async () => {
    await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:',',metaKey:true,bubbles:true}));true`);
    await sleep(800);
    await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find(r => /Manage plugins|管理插件/.test(r.textContent))`);
    await sleep(700);
  };
  const tab = (id) => press(`document.querySelector('.plug-tabs [data-tab="${id}"]')`);

  await openPane();
  check("the pane opens on its tabs", (await $(`document.querySelectorAll('.plug-tabs [role="tab"]').length`)) === 4);
  const ext = (id) => `document.querySelector('[data-testid="extensions"] .plug-ext[data-id="${id}"]')`;
  check("each extension is listed with where it came from", (await $(`${ext("someone/counter")}?.textContent.includes('Community')`)) === true && (await $(`${ext("someone/keeper")}?.textContent.includes('Official')`)) === true);
  check("a hand-installed package is listed as Local", (await $(`${ext("someone/runner")}?.textContent.includes('Local')`)) === true);
  check("high risk is labelled on the row", (await $(`!!${ext("someone/runner")}?.querySelector('.tag.risk-high')`)) === true);
  check("and what it can reach is spelled out", (await $(`${ext("someone/runner")}?.textContent.includes('Starts other programs')`)) === true);
  check("the agent's build asks to be reviewed", (await $(`!!${ext("local/notes")}?.querySelector('[data-testid="review-build"]')`)) === true);
  await shot("30-plugins-installed");

  await press(`${ext("local/notes")}.querySelector('[data-testid="review-build"]')`);
  await sleep(1200);
  check("the review names the build and what it can reach", (await $(`document.querySelector('[data-testid="confirm-build"]')?.textContent.includes('local/notes')`)) === true);
  check("and says it is the first one asked for", (await $(`document.querySelector('[data-testid="confirm-build"]')?.textContent.includes('first build')`)) === true);
  await shot("31-plugins-confirm-build");
  await press(`document.querySelector('[data-testid="confirm-load"]')`);
  await sleep(2500);
  check("confirming loads exactly that build", view("local/notes")?.state === "active" && ctx.tools.has("notes_count_open"), JSON.stringify(view("local/notes")));
  check("and the dialog closes", (await $(`!!document.querySelector('[data-testid="confirm-build"]')`)) === false);

  // Rows sit under the contract they fill; a search narrows rows and extensions alike.
  const search = (text) =>
    $(`(() => {
      const input = document.querySelector('[data-testid="plugins-search"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  check("the search shows one focus ring, on the field — none on the input inside it", await oneFocusRing(win, '[data-testid="plugins-search"]', ".plug-search"));
  await $(`document.activeElement?.blur(); true`);
  const rowIds = (scope = ".dlg-body") => $(`[...document.querySelectorAll('${scope} .cfg-row[data-id]')].map(r => r.dataset.id).join()`);
  check("engines are grouped under their contract, the switched-off one too", (await rowIds('.plug-group[data-contract="engine"]')) === "engine-loop,engine-pi-builtin,engine-scripted,engine-claude-code,engine-codex,engine-pi,engine-terminal,engine-hermes,engine-dsh,engine-workbuddy");
  check("destinations under theirs", (await rowIds('.plug-group[data-contract="storage"]')) === "storage-git,storage-github");
  check("and every other row under one heading", (await rowIds('.plug-group[data-contract=""]')).split(",").includes("db"));
  await $(`document.querySelector('.plug-group[data-contract="engine"]').scrollIntoView({ block: 'start' });true`);
  await sleep(300);
  await shot("30-plugins-groups");
  await search("github");
  await sleep(300);
  check("a search narrows the list to the rows that match", (await rowIds()) === "storage-github,files-github,github", await rowIds());
  check("and leaves the module table out of the way", (await $(`!!document.querySelector('.dlg-body .tok-table')`)) === false);
  await search("counter");
  await sleep(300);
  check("it finds an extension by its title", (await $(`[...document.querySelectorAll('[data-testid="extensions"] .plug-ext[data-id]')].map(r => r.dataset.id).join()`)) === "someone/counter");
  await search("nothing-called-this");
  await sleep(300);
  check("and says so when nothing matches", /No plugin matches “nothing-called-this”/.test(await $(`document.querySelector('.dlg-body').textContent`)));

  // Assistant lists only the engines that are running, and says where the rest are.
  await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find(r => r.textContent.trim() === 'Assistant')`);
  await sleep(700);
  check("the Assistant pane names the engine that is switched off", (await $(`document.querySelector('[data-testid="more-engines"]')?.textContent ?? ''`)).includes("engine-scripted"));
  await $(`document.querySelector('[data-testid="more-engines"]').scrollIntoView({ block: 'center' });true`);
  await sleep(300);
  await shot("30-assistant-more-engines");
  await press(`document.querySelector('[data-testid="more-engines"] .link-btn')`);
  await sleep(700);
  check("its link opens Plugins already searching for engines", (await $(`document.querySelector('[data-testid="plugins-search"]')?.value`)) === "engine" && (await $(`document.querySelector('.dlg-nav .side-row[aria-current="true"]')?.textContent.trim()`)) === "Manage plugins");
  check("opened at the top, where the search box is", (await $(`document.querySelector('.dlg-body').scrollTop`)) === 0);
  check("which shows the engines and nothing else", (await rowIds()) === "engine-loop,engine-pi-builtin,engine-scripted,engine-claude-code,engine-codex,engine-pi,engine-terminal,engine-hermes,engine-dsh,engine-workbuddy", await rowIds());
  await shot("30-plugins-engines");
  await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find(r => r.textContent.trim() === 'Assistant')`);
  await sleep(400);
  await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find(r => r.textContent.trim() === 'Manage plugins')`);
  await sleep(500);
  check("coming back by the menu opens it unfiltered", (await $(`document.querySelector('[data-testid="plugins-search"]')?.value`)) === "");

  await tab("mine");
  await sleep(900);
  check("My plugins lists the studio workspace", (await $(`!!document.querySelector('[data-testid="workspaces"] [data-id="local/notes"]')`)) === true);
  check("with a way to start another with the agent", (await $(`!!document.querySelector('[data-testid="new-plugin"]:not([disabled])')`)) === true);
  await shot("32-plugins-mine");
  await press(`document.querySelector('[data-testid="new-plugin"]')`);
  await sleep(700);
  check("a new plugin starts from a description", (await $(`!!document.querySelector('[data-testid="new-plugin-dialog"] textarea')`)) === true);
  await shot("33-plugins-new");
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`);
  await sleep(500);

  await tab("browse");
  await sleep(1500);
  check("Browse says plainly when the store cannot be reached", /could not be reached/.test(await $(`document.querySelector('.dlg-body')?.textContent`)));
  await shot("34-plugins-browse");
  await tab("updates");
  await sleep(900);
  await shot("35-plugins-updates");

  // The same pane in Chinese.
  ctx.settings.set({ ...ctx.settings.get(), language: "zh" });
  win.webContents.reload();
  await sleep(3500);
  await openPane();
  const zh = await $(`document.querySelector('.dlg-body')?.textContent ?? ''`);
  check("在中文界面中显示信任标识与风险", zh.includes("社区") && zh.includes("官方") && zh.includes("高风险") && zh.includes("本地"), zh.slice(0, 200));
  await shot("36-plugins-installed-zh");
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
