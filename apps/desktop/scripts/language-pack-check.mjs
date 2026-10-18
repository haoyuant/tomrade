/**
 * A language pack against the real shell: a data-only plugin loaded from a
 * folder adds Brazilian Portuguese to Settings → Language; choosing it speaks
 * the pack's words, English wherever it is silent; switching the plugin off
 * takes the language away again.
 *
 *   pnpm --filter @tomrade/desktop test:language-pack      (needs the dev server up)
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../dist/boot.js";
import { registerExtensionResolution } from "../dist/extension-resolve.js";
import { seedDesignProject } from "./seed.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.TOMRADE_DEV_URL || "http://127.0.0.1:5173/";
const SHOTS = path.join(__dirname, "shots");
const WORK = "/tmp/tomrade-language-pack-check";
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

/** A pack and nothing else: a manifest with no code, and one JSON file of words. */
function portuguese() {
  const dir = path.join(WORK, "src", "portugues");
  fs.mkdirSync(path.join(dir, "languages"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tomrade-plugin.json"),
    JSON.stringify({ id: "someone/portugues", version: "1.0.0", title: "Português (Brasil)", license: "MIT", engines: { sdk: "^0.2.8" }, main: null, languages: [{ tag: "pt-BR", name: "Português (Brasil)", file: "languages/pt-BR.json" }] }, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, "languages/pt-BR.json"),
    JSON.stringify({ ui: { settingsDialog: { dialogLabel: "Configurações", languageLabel: "Idioma", groupApp: "<b>Aplicativo</b>" }, common: { system: "Sistema" } } }, null, 2)
  );
  return dir;
}

const run = async () => {
  const { ctx } = await boot({
    configFile: path.join(__dirname, "../tomrade.yml"),
    vars: { userData: path.join(WORK, "userData"), pluginsRoot: path.join(WORK, "plugins"), pluginsDevRoot: path.join(WORK, "plugins-dev") },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]],
    extensions: { root: path.join(WORK, "plugins"), trustedKeys: {} }
  });
  ctx.hub.configure(path.join(WORK, "hub"));
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const { project } = seedDesignProject({ dbFor: (id) => ctx.db.for(id), items: ctx.items, projects: ctx.projects, boards: ctx.boards, views: ctx.views, fields: ctx.fields, gitRepos: ctx.repos });

  await ctx.plugins.addFolder(portuguese());
  const view = () => ctx.plugins.list().find((p) => p.id === "someone/portugues");
  check("a pack with no code loads from a folder", view()?.state === "active", JSON.stringify(view()));
  check("and its language is there", ctx.settings.languages().some((l) => l.tag === "pt-BR"), JSON.stringify(ctx.settings.languages()));

  const win = new BrowserWindow({ width: 1280, height: 860, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(__dirname, "../preload.cjs"), contextIsolation: true } });
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
  const navRow = (re) => `[...document.querySelectorAll('.dlg-nav .side-row')].find(r => ${re}.test(r.textContent.trim()))`;
  const options = () => $(`[...document.querySelectorAll('.dlg-body select.select option')].map(o => o.value + '=' + o.textContent).join('|')`);

  check("the window hands the main process its English, which a pack's coverage is measured against", ctx.settings.english().ui?.common?.cancel === "Cancel");

  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:',',metaKey:true,bubbles:true}));true`);
  await sleep(800);
  await press(navRow(/^Language$/));
  await sleep(600);
  check("Settings → Language lists the pack's language by its own name", (await options()).includes("pt-BR=Português (Brasil)"), await options());
  check("after the languages the app ships", (await options()).startsWith("system=System|en=English|zh=简体中文"), await options());
  await shot("40-language-pack-listed");

  await $(`(() => {
    const select = document.querySelector('.dlg-body select.select');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'pt-BR');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(1500);
  check("choosing it saves the language", ctx.settings.get().language === "pt-BR" && ctx.settings.locale() === "pt-BR", `${ctx.settings.get().language} / ${ctx.settings.locale()}`);
  check("the interface speaks the pack's words", !!(await $(`!!(${navRow(/^Idioma$/)})`)), await $(`[...document.querySelectorAll('.dlg-nav .side-row')].map(r => r.textContent.trim()).join(',')`));
  check("and English wherever it is silent", !!(await $(`!!(${navRow(/^Appearance$/)})`)));
  check("as plain text, markup and all", (await $(`document.querySelector('.dlg-nav')?.textContent ?? ''`)).includes("<b>Aplicativo</b>"));
  check("the page says which language it is in", (await $(`document.documentElement.lang`)) === "pt-BR");
  check("System follows the language too", (await options()).startsWith("system=Sistema"), await options());
  await shot("41-language-pack-chosen");

  await ctx.plugins.setEnabled("someone/portugues", false);
  await sleep(1500);
  check("switching the plugin off takes the language away", !ctx.settings.languages().length);
  check("the interface goes back to English", !!(await $(`!!(${navRow(/^Language$/)})`)));
  check("and the choice stays listed by its tag until the pack is back", (await options()).includes("pt-BR=pt-BR"), await options());
  await shot("42-language-pack-off");
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
