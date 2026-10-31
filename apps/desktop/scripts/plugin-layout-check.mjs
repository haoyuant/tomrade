/**
 * A plugin's backlog layout against the real shell: two layout plugins loaded
 * from folders, one sandboxed and one native, offered in the switcher after
 * the built-ins; each shown in the backlog region, fed the view's tickets, and
 * heard back — a write through the window and the detail pane opened; the
 * native one named high risk in Plugins; and the view keeping its layout, with
 * a notice, when the plugin is switched off.
 *
 *   pnpm --filter @tomrade/desktop test:plugin-layout      (needs the dev server up and the frame built: pnpm --filter @tomradex/ui build:shell)
 */
import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, scaffold } from "@tomradex/plugin-cli";
import { boot } from "../dist/boot.js";
import { registerExtensionResolution } from "../dist/extension-resolve.js";
import { registerPluginFilesScheme, servePluginFiles } from "../dist/plugin-files.js";
import { seedDesignProject } from "./seed.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.TOMRADE_DEV_URL || "http://127.0.0.1:5173/";
const SHOTS = path.join(__dirname, "shots");
const WORK = "/tmp/tomrade-plugin-layout-check";
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
app.setPath("userData", path.join(WORK, "userData"));
registerExtensionResolution([path.resolve(__dirname, "../../..")]);
registerPluginFilesScheme();

const results = [];
const check = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond || !extra ? "" : ` — ${extra}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The same module for both modes: draws the tickets, then proves the way back with a write and a select. */
const LAYOUT_MODULE = `export default {
  mount(root, api) {
    const draw = (state) => {
      root.replaceChildren();
      const list = document.createElement("ul");
      list.dataset.count = String(state.items.length);
      list.dataset.selected = state.selectedId ?? "";
      for (const item of state.items) {
        const li = document.createElement("li");
        li.dataset.id = item.id;
        li.textContent = item.key + " " + item.title;
        list.append(li);
      }
      root.append(list);
    };
    draw(api.state);
    const stop = api.onChange(draw);
    const first = api.state.items[0];
    setTimeout(() => {
      if (first) api.update(first.id, { title: first.title + " · layout" }).then(() => api.select(first.id));
    }, 200);
    return { unmount: stop };
  }
};
`;

async function layoutPlugin(name, render, permissions = { network: [], fs: "none", exec: false }) {
  const dir = path.join(WORK, "src", name);
  scaffold(dir, { id: `someone/${name}`, title: name[0].toUpperCase() + name.slice(1), description: `The ${name} layout.` });
  fs.writeFileSync(
    path.join(dir, "src/index.ts"),
    `import { definePlugin } from "@tomradex/plugin-sdk";
export default definePlugin({
  inject: ["contributions"],
  async apply(ctx) {
    await ctx.contributions.layout({ id: "${name}.timeline", title: { en: "${name} timeline", zh: "${name} 时间线" }, icon: "i-grid", module: "layout.js", render: "${render}" });
  }
});
`
  );
  fs.writeFileSync(path.join(dir, "layout.js"), LAYOUT_MODULE);
  const file = path.join(dir, "tomrade-plugin.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), inject: ["contributions"], permissions }, null, 2));
  const built = await build(dir);
  if (!built.ok) throw new Error(built.errors.join("\n"));
  return dir;
}

const run = async () => {
  const { ctx } = await boot({
    configFile: path.join(__dirname, "../tomrade.yml"),
    vars: { userData: path.join(WORK, "userData"), pluginsRoot: path.join(WORK, "plugins"), pluginsDevRoot: path.join(WORK, "plugins-dev") },
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }]],
    extensions: { root: path.join(WORK, "plugins"), trustedKeys: {} }
  });
  servePluginFiles(ctx, path.resolve(__dirname, "../../../packages/ui/dist/plugin-layout-shell.html"));
  ctx.hub.configure(path.join(WORK, "hub"));
  for (const seeded of ctx.projects.list()) ctx.projects.remove(seeded.id);
  const { project } = seedDesignProject({ dbFor: (id) => ctx.db.for(id), items: ctx.items, projects: ctx.projects, boards: ctx.boards, views: ctx.views, fields: ctx.fields, gitRepos: ctx.repos });

  await ctx.plugins.addFolder(await layoutPlugin("sandy", "sandbox"));
  await ctx.plugins.addFolder(await layoutPlugin("nativ", "native", { network: [], fs: "none", exec: false, renderer: true, why: { renderer: "Draws the timeline with the window's own popovers." } }));
  try {
    await ctx.plugins.addFolder(await layoutPlugin("bare", "native"));
  } catch {
    // a refused registration fails the plugin, which is the point
  }
  await sleep(500);
  const view = (id) => ctx.plugins.list().find((p) => p.id === id);
  check("a sandboxed and a native layout plugin load from folders", view("someone/sandy")?.state === "active" && view("someone/nativ")?.state === "active", JSON.stringify([view("someone/sandy")?.state, view("someone/nativ")?.state]));
  check("the service lists both with their mode", ctx.contributions.layouts().map((l) => `${l.id}:${l.render}`).sort().join() === "nativ.timeline:native,sandy.timeline:sandbox", JSON.stringify(ctx.contributions.layouts()));
  check("a native layout without permissions.renderer is refused", !ctx.contributions.layouts().some((l) => l.id === "bare.timeline") && /permissions\.renderer/.test(view("someone/bare")?.error ?? ""), JSON.stringify(view("someone/bare")));
  const tickets = () => ctx.items.listAll(project.id).filter((i) => i.kind !== "epic");
  const renamed = () => tickets().filter((i) => i.title.includes("· layout"));

  const win = new BrowserWindow({ width: 1400, height: 900, show: !!process.env.TOMRADE_SHOW, webPreferences: { preload: path.join(__dirname, "../preload.cjs"), contextIsolation: true } });
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

  check("the switcher offers the plugin layouts after the built-ins", (await $(`[...document.querySelectorAll('.layout-seg [data-layout]')].map((b) => b.dataset.layout).join()`)) === "board,table,graph,plugin:sandy.timeline,plugin:nativ.timeline", await $(`[...document.querySelectorAll('.layout-seg [data-layout]')].map((b) => b.dataset.layout).join()`));

  await press(`document.querySelector('.layout-seg [data-layout="plugin:sandy.timeline"]')`);
  await sleep(3000);
  const frame = await $(`(() => { const f = document.querySelector('.plugin-layout-region[data-render="sandbox"] iframe.plugin-layout-frame'); return f ? { sandbox: f.getAttribute('sandbox'), src: f.src, reachable: f.contentDocument !== null } : null; })()`);
  check("sandbox: the region holds a frame on the plugin's own origin, out of this window's reach", frame?.sandbox === "allow-scripts allow-same-origin" && frame.src === "tomrade-plugin://someone/sandy/__tomrade__/plugin-layout-shell.html" && frame.reachable === false, JSON.stringify(frame));
  check("sandbox: the layout's write came back through the window", renamed().length === 1, JSON.stringify(renamed().map((i) => i.title)));
  check("sandbox: and its select opened the detail pane", (await $(`!!document.querySelector('aside.detail')`)) === true);
  check("sandbox: no error notice", (await $(`!!document.querySelector('.plugin-layout-notice')`)) === false, await $(`document.querySelector('.plugin-layout-notice')?.textContent`));
  await shot("40-plugin-layout-sandbox");

  await press(`document.querySelector('.layout-seg [data-layout="plugin:nativ.timeline"]')`);
  await sleep(3000);
  const drawn = await $(`(() => { const ul = document.querySelector('.plugin-layout-region[data-render="native"] .plugin-layout-root ul'); return ul ? { count: ul.dataset.count, selected: ul.dataset.selected, rows: ul.children.length } : null; })()`);
  check("native: the module draws the view's tickets into the region itself", drawn && Number(drawn.count) > 0 && Number(drawn.count) === drawn.rows, JSON.stringify(drawn));
  check("native: the write came through and the select was fed back as state", renamed().some((i) => i.title.endsWith("· layout · layout")) && drawn?.selected === renamed()[0]?.id, JSON.stringify({ drawn, renamed: renamed().map((i) => [i.id, i.title]) }));
  check("native: no error notice", (await $(`!!document.querySelector('.plugin-layout-notice')`)) === false, await $(`document.querySelector('.plugin-layout-notice')?.textContent`));
  check("the view's draft now carries the plugin layout", (await $(`!!document.querySelector('.view-dirty')`)) === true);
  await shot("41-plugin-layout-native");

  // Switched off while shown: the view keeps its layout and says what is missing.
  await ctx.plugins.setEnabled("someone/nativ", false);
  await sleep(1500);
  check("switching the plugin off leaves a notice naming the layout, not a board", (await $(`document.querySelector('.plugin-layout-notice')?.textContent ?? ''`)).includes("nativ.timeline"), await $(`document.querySelector('.board-region')?.textContent?.slice(0, 200)`));
  check("and the switcher drops it while the rest stay", (await $(`[...document.querySelectorAll('.layout-seg [data-layout]')].map((b) => b.dataset.layout).join()`)) === "board,table,graph,plugin:sandy.timeline");
  await shot("42-plugin-layout-missing");
  await ctx.plugins.setEnabled("someone/nativ", true);
  await sleep(1500);
  check("switching it back on draws it again", (await $(`!!document.querySelector('.plugin-layout-region[data-render="native"] ul')`)) === true);

  // Plugins pane: the native one is named high risk and told in plain words.
  await $(`document.dispatchEvent(new KeyboardEvent('keydown',{key:',',metaKey:true,bubbles:true}));true`);
  await sleep(800);
  await press(`[...document.querySelectorAll('.dlg-nav .side-row')].find(r => /Manage plugins|管理插件/.test(r.textContent))`);
  await sleep(900);
  const ext = (id) => `document.querySelector('[data-testid="extensions"] .plug-ext[data-id="${id}"]')`;
  check("Plugins labels the native layout plugin high risk", (await $(`!!${ext("someone/nativ")}?.querySelector('.tag.risk-high')`)) === true);
  check("and says it runs inside Tomrade's window", (await $(`${ext("someone/nativ")}?.textContent.includes("inside Tomrade's window")`)) === true, await $(`${ext("someone/nativ")}?.textContent.slice(0, 300)`));
  check("while the sandboxed one is not", (await $(`!!${ext("someone/sandy")}?.querySelector('.tag.risk-high')`)) === false);
  await shot("43-plugin-layout-risk");
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
